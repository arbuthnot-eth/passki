/**
 * UltronSigningAgent — Durable Object that hosts the IKA WASM runtime
 * so ultron can eventually sign Solana/BTC/ETH txs autonomously using
 * its own dWallets, without any browser in the loop.
 *
 * This file is currently a SPIKE — the single purpose is to prove the
 * two feasibility claims from project_ultron_do_signing:
 *   1. The .wasm binary loads + initializes inside a Worker DO runtime
 *      (all host imports are Workers-safe).
 *   2. A pure-crypto exported function (`generate_secp_cg_keypair_from_seed`)
 *      can be invoked end-to-end with no browser-specific bindings.
 *
 * Once the spike runs green on mainnet, the real signing flow (read
 * dWallet → presign PTB → decrypt user share → centralized sign → submit)
 * can be layered on top using the same initSync path.
 */

import { Agent } from 'agents';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ultronKeypair } from '../ultron-key.js';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  IkaClient,
  IkaTransaction,
  UserShareEncryptionKeys,
  Curve,
  Hash,
  SignatureAlgorithm,
  getNetworkConfig,
  parseSignatureFromSignOutput,
} from '@ika.xyz/sdk';

// The .js bindings are pure ES module — they export `initSync(module)`
// + every cryptographic function. We skip the default export (`__wbg_init`)
// because that path expects a browser loader via `import.meta.url`. Workers
// go through `initSync` with a pre-compiled WebAssembly.Module instead.
import {
  initSync,
  generate_secp_cg_keypair_from_seed,
} from '@ika.xyz/ika-wasm/web';

// Ultron's dWallets from the Registeel Lock-On DKG ceremonies. Both curves
// are provisioned — ed25519 for SOL, secp256k1 for BTC/ETH. Hardcoded
// because the DWalletCaps are static; any change would require a fresh DKG.
//
// Lookup recipe for refreshing these after a re-DKG:
//   1. Query ultron's owned DWalletCap objects (type matches
//      <ikaDwallet2pcMpcOriginalPackage>::coordinator_inner::DWalletCap)
//   2. Each cap's `dwallet_id` field points at the dwallet object
//   3. The dwallet's `encrypted_user_secret_key_shares.id` table holds
//      a single dynamic field pointing at the encrypted share object
//   4. `previousTransaction` on the dwallet object is the DKG tx digest
//      that carries the DWalletDKGRequestEvent with user_public_output
interface DWalletSpec {
  dwalletId: string;
  encryptedShareId: string;
  dkgDigest: string;
}
const ULTRON_DWALLETS: Record<'ed25519' | 'secp256k1', DWalletSpec> = {
  ed25519: {
    dwalletId: '0x1a5e6b22b81cd644e15314b451212d9cadb6cd1446c466754760cc5a65ac82a9',
    encryptedShareId: '0x960914d549e3511d552d15930ac03c9d6c073bf61fb9291b1bc8b2e3d6231252',
    dkgDigest: '9dP8g9v3m7DG4XnGWcWEYyqqSNCAS2DnMWeEAz1Sdx5d',
  },
  secp256k1: {
    dwalletId: '0xbb8bce5447722a4c6f5f64618164d8420551dfdbc7605afe279a85de1ebb6acb',
    encryptedShareId: '0x9a6519576f74ca93b43000534249f00168b06e41bf8456fa46ce3fe52db6183d',
    dkgDigest: '38NwvhPrP911FBJgQsVMmCE6jhufWCCzpxubwY8CTaDy',
  },
};
// Legacy shims so existing call sites in this file keep working until
// we sweep them all to use ULTRON_DWALLETS[curve].
const ULTRON_ED25519_DWALLET_ID = ULTRON_DWALLETS.ed25519.dwalletId;
const ULTRON_ED25519_ENCRYPTED_SHARE_ID = ULTRON_DWALLETS.ed25519.encryptedShareId;
const ULTRON_ED25519_DKG_DIGEST = ULTRON_DWALLETS.ed25519.dkgDigest;

// Public salt suffixes for deterministic seed derivation. MUST match the
// values in src/server/index.ts /api/cache/rumble-ultron-seed exactly,
// otherwise the encryption keys we derive here won't decrypt the share
// that was encrypted with the browser-side seed.
const SEED_PREFIX_ED25519 = 'ultron-dkg:ed25519:';
const SEED_PREFIX_SECP256K1 = 'ultron-dkg:secp256k1:';

// Mysten's GraphQL endpoint — the First Commandment compliant transport.
// GraphQL supports reads (.core surface) AND tx submission (executeTransaction)
// AND tx lookup by digest, so it fully replaces the JSON-RPC path that
// Porygon Psybeam is retiring. gRPC would be the ideal transport but doesn't
// work in Cloudflare Workers (no HTTP/2 bidi streaming); GraphQL is the
// next-best fit and has no April-2026 sunset.
const SUI_GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// Wrangler treats .wasm imports inside the src/ tree as
// `WebAssembly.Module` at build time via the CompiledWasm rule in
// wrangler.jsonc. The binary is ~3.4 MB — well under the Worker
// size limit. It's copied into src/server/wasm/ from node_modules by
// the build script so wrangler's bundler can see it (node_modules
// imports don't flow through the rules).
import wasmModule from '../wasm/dwallet_mpc_wasm_bg.wasm';

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

interface UltronSigningState {
  // Empty for the spike — the real DO will cache protocolPP, decrypted
  // share material, and last-seen reconfig epoch here.
  lastSpikeAt?: number;
  lastSpikeOk?: boolean;
}

let _wasmInitialized = false;

/**
 * Lazy init — only pay the WebAssembly.Instance setup cost once per
 * DO activation, not on every invocation. `initSync` is idempotent at
 * the wasm-bindgen layer but we guard locally so the second caller
 * doesn't repeat the Module→Instance construction.
 */
function ensureWasmReady(): void {
  if (_wasmInitialized) return;
  initSync({ module: wasmModule as unknown as WebAssembly.Module });
  _wasmInitialized = true;
}

let _ikaClient: IkaClient | null = null;
let _suiGraphQL: SuiGraphQLClient | null = null;

/**
 * Lazy init the IkaClient wrapping a SuiGraphQLClient. Stays cached for
 * the DO's lifetime so subsequent signing calls reuse the same client
 * (avoids the ~200 ms handshake cost per request).
 *
 * IkaClient's SDK reaches for five methods on `client.core.*`: getObject,
 * getObjects, listOwnedObjects, listDynamicFields, simulateTransaction.
 * SuiGraphQLClient exposes all five via `GraphQLCoreClient` with identical
 * signatures to SuiJsonRpcClient's core, so the swap is a drop-in.
 */
async function getIkaClient(): Promise<{ ika: IkaClient; sui: SuiGraphQLClient }> {
  if (_ikaClient && _suiGraphQL) return { ika: _ikaClient, sui: _suiGraphQL };
  const config = getNetworkConfig('mainnet');
  const sui = new SuiGraphQLClient({ url: SUI_GRAPHQL_URL, network: 'mainnet' });
  const ika = new IkaClient({ config, suiClient: sui as never });
  await ika.initialize();
  _ikaClient = ika;
  _suiGraphQL = sui;
  return { ika, sui };
}

/**
 * Derive the deterministic 32-byte encryption seed for ultron's dWallet
 * of the given curve. MUST match /api/cache/rumble-ultron-seed exactly
 * — any divergence breaks decryption of the existing encrypted share.
 */
async function deriveUltronSeed(
  keeperPrivateKey: string,
  ultronAddress: string,
  curve: 'ed25519' | 'secp256k1',
): Promise<Uint8Array> {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const prefix = curve === 'ed25519' ? SEED_PREFIX_ED25519 : SEED_PREFIX_SECP256K1;
  const keeperBytes = new TextEncoder().encode(keeperPrivateKey);
  const saltBytes = new TextEncoder().encode(`${prefix}${ultronAddress}`);
  const seedInput = new Uint8Array(keeperBytes.length + saltBytes.length);
  seedInput.set(keeperBytes, 0);
  seedInput.set(saltBytes, keeperBytes.length);
  return sha256(seedInput);
}

export class UltronSigningAgent extends Agent<Env, UltronSigningState> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/wasm-spike') || url.searchParams.has('wasm-spike')) {
      const result = await this._wasmSmokeTest();
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/read-dwallet') || url.searchParams.has('read-dwallet')) {
      const curve = (url.searchParams.get('curve') ?? 'ed25519') as 'ed25519' | 'secp256k1';
      const result = await this._readUltronDWallet(curve);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/accept-share') || url.searchParams.has('accept-share')) {
      const curve = (url.searchParams.get('curve') ?? 'ed25519') as 'ed25519' | 'secp256k1';
      const result = await this._acceptUltronShare(curve);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // Increment C — request_presign on an Active dWallet
    if (url.pathname.endsWith('/request-presign') || url.searchParams.has('request-presign')) {
      const curve = (url.searchParams.get('curve') ?? 'secp256k1') as 'ed25519' | 'secp256k1';
      const result = await this._requestPresign(curve);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // Increment D — poll the Presign object until state.variant === Completed
    if (url.pathname.endsWith('/poll-presign') || url.searchParams.has('poll-presign')) {
      const presignId = url.searchParams.get('id') ?? '';
      const result = await this._pollPresignCompleted(presignId);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/poll-sign') || url.searchParams.has('poll-sign')) {
      const signId = url.searchParams.get('id') ?? '';
      const curve = (url.searchParams.get('curve') ?? 'secp256k1') as 'ed25519' | 'secp256k1';
      const result = await this._pollSignCompleted(signId, curve);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/request-sign') || url.searchParams.has('request-sign')) {
      try {
        const body = await request.json() as {
          curve?: 'ed25519' | 'secp256k1';
          presignObjectId?: string;
          presignCapId?: string;
          messageHex?: string;
          hashScheme?: string;
        };
        const curve = body.curve ?? 'secp256k1';
        const presignObjectId = body.presignObjectId ?? '';
        const presignCapId = body.presignCapId ?? '';
        const hashScheme = body.hashScheme ?? 'KECCAK256';
        const hex = (body.messageHex ?? '').replace(/^0x/, '');
        const message = new Uint8Array(hex.length / 2);
        for (let i = 0; i < message.length; i++) {
          message[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        const result = await this._requestSign({ curve, presignObjectId, presignCapId, message, hashScheme });
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return new Response(JSON.stringify({ ok: false, error }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'Unknown route' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Increment A of the signing flow: read ultron's ed25519 dWallet via
   * JSON-RPC + IkaClient. Proves the transport path works — if this
   * returns the dWallet in the Active state, every subsequent signing
   * step (presign, sign, poll) uses the same client surface.
   */
  private async _readUltronDWallet(curve: 'ed25519' | 'secp256k1' = 'ed25519'): Promise<{
    ok: boolean;
    error?: string;
    dwalletId?: string;
    state?: string;
    publicOutputLength?: number;
    encryptedUserShareCount?: number;
    curve?: number;
    requestedCurve?: string;
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      const { ika } = await getIkaClient();
      const spec = ULTRON_DWALLETS[curve];
      const dwallet = await ika.getDWallet(spec.dwalletId);
      const dw = dwallet as unknown as Record<string, unknown> & {
        state?: Record<string, unknown>;
        encrypted_user_secret_key_shares?: { size?: number | string };
        curve?: number;
      };
      const stateKeys = dw.state ? Object.keys(dw.state) : [];
      const activeInner = (dw.state as { Active?: { public_output?: number[] } } | undefined)?.Active;
      const publicOutput = activeInner?.public_output
        ?? (dw.state as { public_output?: number[] } | undefined)?.public_output;
      const publicOutputLength = Array.isArray(publicOutput) ? publicOutput.length : 0;
      const sharesSize = dw.encrypted_user_secret_key_shares?.size;
      const encryptedUserShareCount = typeof sharesSize === 'string' ? Number(sharesSize) : (sharesSize ?? 0);
      const state = publicOutputLength > 0 ? 'Active' : (stateKeys[0] ?? 'Unknown');
      return {
        ok: true,
        dwalletId: spec.dwalletId,
        state,
        publicOutputLength,
        encryptedUserShareCount,
        curve: dw.curve,
        requestedCurve: curve,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { ok: false, error, durationMs: Date.now() - t0 };
    }
  }

  /**
   * Smoke test: ensure the WASM loads, all host imports bind, and a
   * pure-crypto function runs to completion without throwing. Returns
   * shape + keys of the keypair so we can verify it's not a degenerate
   * empty object.
   *
   * Curve 0 = secp256k1 (per IKA's curve enum). The seed is a fixed
   * 32-byte test vector so repeated calls are deterministic and we
   * can diff output across deploys if something regresses.
   */
  private async _wasmSmokeTest(): Promise<{
    ok: boolean;
    error?: string;
    keypairShape?: string;
    keypairKeys?: string[];
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      ensureWasmReady();

      // Fixed 32-byte test vector: 0x01 0x02 0x03 … 0x20. Never used
      // for anything real — if someone sees this in a wallet they'll
      // know something is badly wrong.
      const seed = new Uint8Array(32);
      for (let i = 0; i < 32; i++) seed[i] = i + 1;

      const result = generate_secp_cg_keypair_from_seed(0, seed);
      const keys = result && typeof result === 'object' ? Object.keys(result) : [];

      const durationMs = Date.now() - t0;
      this.setState({
        ...this.state,
        lastSpikeAt: Date.now(),
        lastSpikeOk: true,
      });
      return {
        ok: true,
        keypairShape: typeof result,
        keypairKeys: keys,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.setState({
        ...this.state,
        lastSpikeAt: Date.now(),
        lastSpikeOk: false,
      });
      return { ok: false, error, durationMs };
    }
  }

  /**
   * Increment B: accept ultron's encrypted user share to transition the
   * dWallet from AwaitingKeyHolderSignature → Active.
   *
   * Uses the deterministic seed (same one /api/cache/rumble-ultron-seed
   * exposed to the browser during DKG) to reconstruct the
   * UserShareEncryptionKeys. Then builds a PTB via IkaTransaction
   * that calls acceptEncryptedUserShare, signs with ultron's Ed25519
   * keypair, and submits via JSON-RPC.
   *
   * After this lands, requestPresign + requestSign can chain normally
   * on the Active dWallet — the signing flow is just a PTB composition.
   */
  private async _acceptUltronShare(curve: 'ed25519' | 'secp256k1' = 'ed25519'): Promise<{
    ok: boolean;
    error?: string;
    digest?: string;
    stateBefore?: string;
    stateAfter?: string;
    curve?: string;
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
        return { ok: false, error: 'SHADE_KEEPER_PRIVATE_KEY not configured', durationMs: Date.now() - t0 };
      }

      ensureWasmReady();

      const spec = ULTRON_DWALLETS[curve];
      const ikaCurve = curve === 'ed25519' ? Curve.ED25519 : Curve.SECP256K1;

      // Ultron's Sui address — derived from the keeper keypair.
      const keypair = ultronKeypair(this.env);
      const ultronAddress = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

      // Reconstruct the same deterministic seed the browser used during DKG.
      // Critical: the seed prefix ("ultron-dkg:ed25519:" or "ultron-dkg:secp256k1:")
      // MUST match the browser path EXACTLY, otherwise the derived encryption
      // key won't decrypt the share that was encrypted during DKG.
      const seed = await deriveUltronSeed(
        this.env.SHADE_KEEPER_PRIVATE_KEY,
        ultronAddress,
        curve,
      );
      const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, ikaCurve);

      const { ika, sui } = await getIkaClient();

      // Read the dWallet as whatever-state. It's in AwaitingKeyHolderSignature
      // right now; the SDK's typed getters cast it as ZeroTrustDWallet so we
      // can feed it into acceptEncryptedUserShare directly.
      const dwallet = await ika.getDWallet(spec.dwalletId);
      const dwAny = dwallet as unknown as Record<string, unknown> & {
        state?: Record<string, unknown>;
      };
      const stateKeys = dwAny.state ? Object.keys(dwAny.state) : [];
      const stateBefore = stateKeys[0] ?? 'Unknown';

      // `acceptEncryptedUserShare` wants the *user's* public output from
      // the centralized DKG step. The user output was emitted in the DKG
      // tx's DWalletDKGRequestEvent as `event_data.user_public_output`
      // (232 bytes for ed25519, 238 bytes for secp256k1).
      //
      // CRITICAL: the SDK explicitly warns that `event.json` shape can
      // differ between JSON-RPC and GraphQL — fields that come through as
      // `number[]` on JSON-RPC might be a base64 STRING via GraphQL, or
      // sit at a different nesting level, or be re-encoded as BCS bytes.
      // Mega Punch (ed25519) worked when this path was JSON-RPC; Psybeam
      // swapped to GraphQL and the secp256k1 accept has been failing with
      // a WASM match error ever since. To be safe, fetch the event via
      // raw JSON-RPC (single URL is fine for this one call — it's a read
      // that's never in the hot signing path), bypassing whatever shape
      // drift GraphQL introduces.
      const rpcRes = await fetch('https://sui-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'sui_getTransactionBlock',
          params: [spec.dkgDigest, { showEvents: true }],
        }),
      });
      if (!rpcRes.ok) {
        return {
          ok: false,
          error: `DKG tx lookup HTTP ${rpcRes.status}`,
          stateBefore,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      type RawEvent = {
        type?: string;
        parsedJson?: { event_data?: { dwallet_id?: string; user_public_output?: number[] } };
      };
      const rpcJson = await rpcRes.json() as { result?: { events?: RawEvent[] } };
      const rawEvents = rpcJson.result?.events ?? [];
      const dkgEvent = rawEvents.find((e) => {
        const typeStr = e.type ?? '';
        if (!typeStr.includes('DWalletDKGRequestEvent')) return false;
        const ed = e.parsedJson?.event_data;
        return ed?.dwallet_id === spec.dwalletId;
      });
      if (!dkgEvent) {
        return {
          ok: false,
          error: `DWalletDKGRequestEvent not found in tx ${spec.dkgDigest} (JSON-RPC)`,
          stateBefore,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const userPublicOutputArr = dkgEvent.parsedJson?.event_data?.user_public_output;
      if (!userPublicOutputArr || !Array.isArray(userPublicOutputArr) || userPublicOutputArr.length === 0) {
        return {
          ok: false,
          error: `user_public_output not found in DKG event (JSON-RPC) for tx ${spec.dkgDigest}`,
          stateBefore,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const userPublicOutput = new Uint8Array(userPublicOutputArr);
      // Debug log — confirms exactly what we're feeding to the WASM match.
      // Remove once the secp flow is flipped to Active.
      console.log(`[accept-share:${curve}] userPublicOutput bytes=${userPublicOutput.length} first10=[${Array.from(userPublicOutput.slice(0, 10)).join(',')}]`);
      const networkOutput = (dwAny.state as { AwaitingKeyHolderSignature?: { public_output?: number[] } } | undefined)?.AwaitingKeyHolderSignature?.public_output;
      const networkOutputLen = Array.isArray(networkOutput) ? networkOutput.length : 0;
      console.log(`[accept-share:${curve}] networkOutput bytes=${networkOutputLen} first10=[${Array.isArray(networkOutput) ? networkOutput.slice(0, 10).join(',') : 'n/a'}]`);

      // Build the accept PTB via IkaTransaction.
      const tx = new Transaction();
      tx.setSender(ultronAddress);
      const ikaTx = new IkaTransaction({
        ikaClient: ika,
        transaction: tx,
        userShareEncryptionKeys,
      });
      await ikaTx.acceptEncryptedUserShare({
        dWallet: dwallet as never,
        userPublicOutput,
        encryptedUserSecretKeyShareId: spec.encryptedShareId,
      });

      // Build, sign with ultron's Ed25519 Sui keypair (the sender on Sui
      // is always ed25519 — curve here refers to the *dWallet*, not the
      // Sui tx signer), submit via GraphQL.
      const txBytes = await tx.build({ client: sui as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const execResult = await sui.core.executeTransaction({
        transaction: txBytes,
        signatures: [signature],
      });
      const execInner = execResult.$kind === 'Transaction'
        ? execResult.Transaction
        : execResult.FailedTransaction;
      const digest = execInner?.digest ?? '';

      // Re-read the dwallet to confirm state transition. Give the indexer
      // a moment to catch up — read-after-write can race with tx finality
      // on the read replica regardless of transport.
      await new Promise((r) => setTimeout(r, 2000));
      const after = await ika.getDWallet(spec.dwalletId) as unknown as {
        state?: Record<string, unknown>;
      };
      const stateAfterKeys = after.state ? Object.keys(after.state) : [];
      const stateAfter = stateAfterKeys[0] ?? 'Unknown';

      return {
        ok: true,
        digest,
        stateBefore,
        stateAfter,
        curve,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { ok: false, error, durationMs: Date.now() - t0 };
    }
  }

  /**
   * Increment C of the signing flow: request a presign on ultron's
   * Active dWallet. The IKA network performs the MPC presign rounds
   * asynchronously after this PTB lands; the resulting Presign object
   * starts in the Requested state and reaches Completed once the
   * network's MPC pipeline produces the presign material.
   *
   * This method only submits the REQUEST. Increment D will:
   *   1. Poll the Presign object until state === Completed
   *   2. Build the sign PTB referencing the verified presign cap
   *   3. Submit the sign tx
   *   4. Parse the signature out of the resulting Sign session
   *
   * Splitting C from D keeps each step independently observable for
   * debugging and lets us confirm presign cost / latency before
   * committing to the full sign flow.
   */
  private async _requestPresign(curve: 'ed25519' | 'secp256k1' = 'secp256k1'): Promise<{
    ok: boolean;
    error?: string;
    digest?: string;
    presignCapId?: string;
    presignObjectId?: string;
    state?: string;
    curve?: string;
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
        return { ok: false, error: 'SHADE_KEEPER_PRIVATE_KEY not configured', durationMs: Date.now() - t0 };
      }

      const spec = ULTRON_DWALLETS[curve];
      const ikaCurve = curve === 'ed25519' ? Curve.ED25519 : Curve.SECP256K1;

      const keypair = ultronKeypair(this.env);
      const ultronAddress = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

      // Reconstruct the same deterministic seed used for accept-share so
      // the presign references the same encrypted user share keys.
      const seed = await deriveUltronSeed(
        this.env.SHADE_KEEPER_PRIVATE_KEY,
        ultronAddress,
        curve,
      );
      const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, ikaCurve);

      const { ika, sui } = await getIkaClient();
      const dwallet = await ika.getDWallet(spec.dwalletId);
      const dwAny = dwallet as unknown as Record<string, unknown> & {
        state?: Record<string, unknown>;
      };
      const stateKeys = dwAny.state ? Object.keys(dwAny.state) : [];
      const stateBefore = stateKeys[0] ?? 'Unknown';
      if (stateBefore !== 'Active') {
        return {
          ok: false,
          error: `dWallet not Active (current: ${stateBefore}). Run accept-share first.`,
          state: stateBefore,
          curve,
          durationMs: Date.now() - t0,
        };
      }

      // Find ultron's IKA + SUI coins to pay for the presign request.
      // Both `paymentIka` and `paymentSui` are passed as Move object
      // arguments, so they need to be real on-chain coin objects rather
      // than splitCoins outputs (which the IKA coordinator's payment
      // helper rejects as "Unused result without the drop ability"
      // because it consumes them by value rather than by reference).
      const fetchCoins = async (coinType: string) => {
        const res = await fetch('https://sui-rpc.publicnode.com', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'suix_getCoins',
            params: [ultronAddress, coinType],
          }),
        });
        const j = await res.json() as { result?: { data?: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> } };
        return (j.result?.data ?? []).filter(c => BigInt(c.balance) > 0n)
          .sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
      };
      const ikaCoins = await fetchCoins('0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA');
      if (ikaCoins.length === 0) {
        return {
          ok: false,
          error: `ultron has no IKA coins to pay for presign (address ${ultronAddress})`,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const suiCoinsAll = await fetchCoins('0x2::sui::SUI');
      // Need at least 2 SUI coins: one for gas, one for the presign
      // payment arg. If ultron only has one we have to split — but that
      // brings back the "Unused result" error, so make sure the keeper
      // SUI is split to multiple coins beforehand. For now, refuse with
      // a clear error so the operator knows to send a small SUI coin
      // to ultron explicitly.
      if (suiCoinsAll.length < 2) {
        return {
          ok: false,
          error: `ultron needs at least 2 SUI coin objects (one for gas, one for presign payment); has ${suiCoinsAll.length}. Send a small standalone SUI coin to ${ultronAddress.slice(0, 10)}…`,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const ikaCoin = ikaCoins[0];
      // Use the SMALLEST SUI coin for the presign payment (avoid burning
      // ultron's main gas reserve), and let the builder pick a different
      // coin for gas automatically by NOT calling tx.setGasPayment.
      const suiPaymentCoin = [...suiCoinsAll].sort((a, b) => Number(BigInt(a.balance) - BigInt(b.balance)))[0];

      // Build the presign PTB: requestPresign returns an UnverifiedPresignCap
      // which we transfer to ultron so it persists past the tx for the
      // sign step.
      const tx = new Transaction();
      tx.setSender(ultronAddress);
      const ikaCoinArg = tx.objectRef({
        objectId: ikaCoin.coinObjectId,
        version: ikaCoin.version,
        digest: ikaCoin.digest,
      });
      const suiCoinArg = tx.objectRef({
        objectId: suiPaymentCoin.coinObjectId,
        version: suiPaymentCoin.version,
        digest: suiPaymentCoin.digest,
      });

      const ikaTx = new IkaTransaction({
        ikaClient: ika,
        transaction: tx,
        userShareEncryptionKeys,
      });
      // Cast dwallet as never — the SDK's strict union type insists on a
      // concrete variant tag we don't statically narrow here. Runtime check
      // (stateBefore === 'Active' above) is the actual guarantee.
      const unverifiedPresignCap = ikaTx.requestPresign({
        dWallet: dwallet as never,
        signatureAlgorithm: 'ECDSASecp256k1' as never,
        ikaCoin: ikaCoinArg,
        suiCoin: suiCoinArg,
      });
      // Persist the cap to ultron so Increment D can fetch it later.
      tx.transferObjects([unverifiedPresignCap], tx.pure.address(ultronAddress));

      const txBytes = await tx.build({ client: sui as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const execResult = await sui.core.executeTransaction({
        transaction: txBytes,
        signatures: [signature],
      });
      const execInner = execResult.$kind === 'Transaction'
        ? execResult.Transaction
        : execResult.FailedTransaction;
      const digest = execInner?.digest ?? '';
      console.log(`[request-presign:${curve}] tx submitted, digest=${digest}`);

      // Pull the tx via JSON-RPC to inspect objectChanges and find the
      // newly-created Presign + UnverifiedPresignCap object IDs. Same
      // event-shape concern as accept-share — JSON-RPC is reliable for
      // structured Move object data.
      await new Promise((r) => setTimeout(r, 2000));
      const txDetailRes = await fetch('https://sui-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'sui_getTransactionBlock',
          params: [digest, { showObjectChanges: true, showEffects: true }],
        }),
      });
      const txDetailJson = await txDetailRes.json() as {
        result?: {
          objectChanges?: Array<{ type: string; objectType?: string; objectId?: string; sender?: string; owner?: unknown }>;
          effects?: { status?: { status?: string; error?: string } };
        };
      };
      const status = txDetailJson.result?.effects?.status?.status;
      if (status !== 'success') {
        return {
          ok: false,
          error: `presign tx status: ${status} ${txDetailJson.result?.effects?.status?.error ?? ''}`,
          digest,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const changes = txDetailJson.result?.objectChanges ?? [];
      const presignChange = changes.find((c) => c.objectType?.includes('::coordinator_inner::Presign'));
      const capChange = changes.find((c) => c.objectType?.includes('::coordinator_inner::UnverifiedPresignCap')
        || c.objectType?.includes('::coordinator_inner::VerifiedPresignCap'));
      const presignObjectId = presignChange?.objectId;
      const presignCapId = capChange?.objectId;
      console.log(`[request-presign:${curve}] presign=${presignObjectId} cap=${presignCapId}`);

      return {
        ok: true,
        digest,
        presignCapId,
        presignObjectId,
        state: 'Requested',
        curve,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { ok: false, error, durationMs: Date.now() - t0 };
    }
  }

  /**
   * Increment D step 1: poll a Presign object until its state reaches
   * `Completed`. IKA's MPC network takes a few seconds to produce the
   * presign material after the request PTB lands; we can't progress to
   * the sign step until the presign is fully baked.
   *
   * We read via raw JSON-RPC `sui_getObject` (not GraphQL) — Mega Punch II
   * proved that GraphQL reshapes byte-array fields in ways that break the
   * downstream WASM pipeline. For byte-sensitive reads, JSON-RPC is the
   * reliable transport even post-sunset (PublicNode/BlockVision keep
   * serving JSON-RPC-compatible endpoints from their own nodes).
   *
   * Move enum variants come back from sui_getObject as `state.<VariantName>`
   * on the content.fields payload — we look for `Completed` and also
   * defensively handle a `{variant,fields}` shape in case the shape ever
   * migrates.
   */
  private async _pollPresignCompleted(presignId: string): Promise<{
    ok: boolean;
    error?: string;
    completed?: boolean;
    state?: string;
    durationMs: number;
  }> {
    const t0 = Date.now();
    if (!presignId) {
      return { ok: false, error: 'presignId required', durationMs: Date.now() - t0 };
    }
    const TIMEOUT_MS = 60_000;
    const INTERVAL_MS = 2_000;
    let lastState = 'Unknown';
    while (Date.now() - t0 < TIMEOUT_MS) {
      try {
        const res = await fetch('https://sui-rpc.publicnode.com', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'sui_getObject',
            params: [presignId, { showContent: true }],
          }),
        });
        if (res.ok) {
          const json = await res.json() as {
            result?: { data?: { content?: { fields?: { state?: unknown } } } };
          };
          const stateRaw = json.result?.data?.content?.fields?.state;
          if (stateRaw && typeof stateRaw === 'object') {
            const stateObj = stateRaw as Record<string, unknown> & { variant?: string };
            if (stateObj.variant) {
              lastState = stateObj.variant;
            } else {
              const keys = Object.keys(stateObj);
              const variantKey = keys.find((k) => k !== 'type' && k !== 'fields');
              if (variantKey) lastState = variantKey;
            }
            if (lastState === 'Completed') {
              return {
                ok: true,
                completed: true,
                state: lastState,
                durationMs: Date.now() - t0,
              };
            }
            if (lastState === 'NetworkRejected') {
              return {
                ok: false,
                error: 'presign NetworkRejected',
                completed: false,
                state: lastState,
                durationMs: Date.now() - t0,
              };
            }
          }
        }
      } catch (err) {
        console.log(`[poll-presign] fetch err: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
    return {
      ok: false,
      error: `presign did not reach Completed within ${TIMEOUT_MS}ms (last=${lastState})`,
      completed: false,
      state: lastState,
      durationMs: Date.now() - t0,
    };
  }

  /**
   * Increment D step 2: build + submit the sign PTB. Takes a completed
   * Presign object (caller is responsible for polling to Completed first),
   * the unverified/verified presign cap that was transferred to ultron
   * by the Increment C request_presign PTB, and a message to sign.
   *
   * The PTB layout:
   *   1. Read ultron's encrypted user share (for the zero-trust path)
   *   2. approveMessage(dWalletCap, curve, algo, hashScheme, message)
   *   3. verifyPresignCap(unverifiedPresignCap) → verifiedCap
   *   4. requestSign(dWallet, messageApproval, verifiedCap, presign,
   *      encryptedUserShare, message, algo, ikaCoin, suiCoin)
   *   5. sign with ultron's Ed25519 keypair, submit via core.executeTransaction
   *
   * Returns the digest + the SignSession object ID parsed out of
   * objectChanges so step 3 can poll it.
   */
  private async _requestSign(params: {
    curve: 'ed25519' | 'secp256k1';
    presignObjectId: string;
    presignCapId: string;
    message: Uint8Array;
    hashScheme: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    digest?: string;
    signSessionId?: string;
    curve?: string;
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
        return { ok: false, error: 'SHADE_KEEPER_PRIVATE_KEY not configured', durationMs: Date.now() - t0 };
      }
      const { curve, presignObjectId, presignCapId, message, hashScheme } = params;
      if (!presignObjectId || !presignCapId) {
        return { ok: false, error: 'presignObjectId and presignCapId required', durationMs: Date.now() - t0 };
      }
      if (!message || message.length === 0) {
        return { ok: false, error: 'empty message', durationMs: Date.now() - t0 };
      }

      const spec = ULTRON_DWALLETS[curve];
      const ikaCurve = curve === 'ed25519' ? Curve.ED25519 : Curve.SECP256K1;
      const signatureAlgorithm = curve === 'ed25519'
        ? SignatureAlgorithm.EdDSA
        : SignatureAlgorithm.ECDSASecp256k1;
      // Accept loose string inputs and cast to the Hash enum — the SDK's
      // runtime validator rejects invalid combos, which is the real
      // contract. We're not relying on TS to narrow.
      const hashEnum = (Hash as Record<string, string>)[hashScheme] ?? hashScheme;

      const keypair = ultronKeypair(this.env);
      const ultronAddress = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

      const seed = await deriveUltronSeed(
        this.env.SHADE_KEEPER_PRIVATE_KEY,
        ultronAddress,
        curve,
      );
      const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, ikaCurve);

      const { ika, sui } = await getIkaClient();

      // Fetch the dwallet + the completed presign + the encrypted user share
      // in parallel — all three are inputs the SDK needs to build the sign PTB.
      const [dwallet, presign, encryptedUserShare] = await Promise.all([
        ika.getDWallet(spec.dwalletId),
        ika.getPresign(presignObjectId),
        ika.getEncryptedUserSecretKeyShare(spec.encryptedShareId),
      ]);
      const dwAny = dwallet as unknown as { state?: Record<string, unknown>; dwallet_cap_id?: string };
      const stateKeys = dwAny.state ? Object.keys(dwAny.state) : [];
      if (stateKeys[0] !== 'Active') {
        return {
          ok: false,
          error: `dWallet not Active (current: ${stateKeys[0] ?? 'Unknown'})`,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const dWalletCapId = dwAny.dwallet_cap_id;
      if (!dWalletCapId) {
        return {
          ok: false,
          error: 'dwallet_cap_id not present on dwallet object',
          curve,
          durationMs: Date.now() - t0,
        };
      }

      // Find ultron's IKA coin for the sign fee. Same pattern as
      // _requestPresign (Increment C).
      const coinsRes = await fetch('https://sui-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'suix_getCoins',
          params: [ultronAddress, '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA'],
        }),
      });
      const coinsJson = await coinsRes.json() as {
        result?: { data?: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> };
      };
      const ikaCoins = coinsJson.result?.data ?? [];
      if (ikaCoins.length === 0) {
        return {
          ok: false,
          error: `ultron has no IKA coins to pay for sign (address ${ultronAddress})`,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const ikaCoin = ikaCoins.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))[0];

      // Build the sign PTB.
      const tx = new Transaction();
      tx.setSender(ultronAddress);
      const ikaCoinArg = tx.objectRef({
        objectId: ikaCoin.coinObjectId,
        version: ikaCoin.version,
        digest: ikaCoin.digest,
      });
      const suiCoinArg = tx.splitCoins(tx.gas, [tx.pure.u64(50_000_000)]); // 0.05 SUI

      const ikaTx = new IkaTransaction({
        ikaClient: ika,
        transaction: tx,
        userShareEncryptionKeys,
      });

      // approveMessage creates a MessageApproval object binding the
      // dwalletCap + the message bytes + hash scheme. Runtime validates
      // curve/algo/hash combo, we cast away the strict union.
      const messageApproval = ikaTx.approveMessage({
        dWalletCap: dWalletCapId,
        curve: ikaCurve as never,
        signatureAlgorithm: signatureAlgorithm as never,
        hashScheme: hashEnum as never,
        message,
      });

      // verifyPresignCap takes the unverified cap ID and returns the
      // verified cap (usable in requestSign). Must be in the same PTB.
      const verifiedPresignCap = ikaTx.verifyPresignCap({
        unverifiedPresignCap: presignCapId,
      });

      // requestSign closes the loop: it consumes the verified cap, the
      // completed presign, the encrypted user share, and the message,
      // and emits a SignSession object the network will fill with the
      // final signature bytes.
      await ikaTx.requestSign({
        dWallet: dwallet as never,
        messageApproval,
        hashScheme: hashEnum as never,
        verifiedPresignCap,
        presign: presign as never,
        encryptedUserSecretKeyShare: encryptedUserShare,
        message,
        signatureScheme: signatureAlgorithm as never,
        ikaCoin: ikaCoinArg,
        suiCoin: suiCoinArg[0],
      });

      const txBytes = await tx.build({ client: sui as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const execResult = await sui.core.executeTransaction({
        transaction: txBytes,
        signatures: [signature],
      });
      const execInner = execResult.$kind === 'Transaction'
        ? execResult.Transaction
        : execResult.FailedTransaction;
      const digest = execInner?.digest ?? '';
      console.log(`[request-sign:${curve}] tx submitted, digest=${digest}`);

      // Pull the tx to extract the SignSession object ID from
      // objectChanges. Give the indexer a beat.
      await new Promise((r) => setTimeout(r, 2000));
      const txDetailRes = await fetch('https://sui-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'sui_getTransactionBlock',
          params: [digest, { showObjectChanges: true, showEffects: true }],
        }),
      });
      const txDetailJson = await txDetailRes.json() as {
        result?: {
          objectChanges?: Array<{ type: string; objectType?: string; objectId?: string }>;
          effects?: { status?: { status?: string; error?: string } };
        };
      };
      const status = txDetailJson.result?.effects?.status?.status;
      if (status !== 'success') {
        return {
          ok: false,
          error: `sign tx status: ${status} ${txDetailJson.result?.effects?.status?.error ?? ''}`,
          digest,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const changes = txDetailJson.result?.objectChanges ?? [];
      const signChange = changes.find((c) => c.objectType?.includes('::coordinator_inner::SignSession'));
      const signSessionId = signChange?.objectId;
      console.log(`[request-sign:${curve}] signSession=${signSessionId}`);

      return {
        ok: true,
        digest,
        signSessionId,
        curve,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { ok: false, error, durationMs: Date.now() - t0 };
    }
  }

  /**
   * Increment D step 3: poll a SignSession object until state === Completed,
   * then parse the signature bytes out of the completed state payload via
   * the SDK's parseSignatureFromSignOutput helper.
   *
   * Same JSON-RPC transport + variant-shape handling as the presign poll.
   * When Completed, the state payload carries a `signature: number[]`
   * field that contains the raw MPC sign output — parseSignatureFromSignOutput
   * converts that into the canonical curve/algorithm-specific signature
   * bytes (DER-encoded for ECDSA, raw 64 bytes for Ed25519).
   */
  private async _pollSignCompleted(
    signSessionId: string,
    curve: 'ed25519' | 'secp256k1' = 'secp256k1',
  ): Promise<{
    ok: boolean;
    error?: string;
    completed?: boolean;
    signatureHex?: string;
    state?: string;
    durationMs: number;
  }> {
    const t0 = Date.now();
    if (!signSessionId) {
      return { ok: false, error: 'signSessionId required', durationMs: Date.now() - t0 };
    }
    const TIMEOUT_MS = 60_000;
    const INTERVAL_MS = 2_000;
    let lastState = 'Unknown';
    let rawSignatureOutput: number[] | null = null;
    while (Date.now() - t0 < TIMEOUT_MS) {
      try {
        const res = await fetch('https://sui-rpc.publicnode.com', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'sui_getObject',
            params: [signSessionId, { showContent: true }],
          }),
        });
        if (res.ok) {
          const json = await res.json() as {
            result?: { data?: { content?: { fields?: { state?: unknown } } } };
          };
          const stateRaw = json.result?.data?.content?.fields?.state;
          if (stateRaw && typeof stateRaw === 'object') {
            const stateObj = stateRaw as Record<string, unknown> & { variant?: string; fields?: unknown };
            let variantName = '';
            let variantFields: unknown = null;
            if (stateObj.variant) {
              variantName = stateObj.variant;
              variantFields = stateObj.fields;
            } else {
              const keys = Object.keys(stateObj).filter((k) => k !== 'type' && k !== 'fields');
              if (keys.length > 0) {
                variantName = keys[0];
                variantFields = (stateObj as Record<string, unknown>)[variantName];
              }
            }
            lastState = variantName || lastState;
            if (variantName === 'Completed') {
              // The signature payload is nested — variantFields may be
              // `{ signature: [...] }` or `{ fields: { signature: [...] } }`
              // depending on how sui_getObject serialized it.
              const payload = variantFields as Record<string, unknown> | null;
              const sigCandidate = payload && typeof payload === 'object'
                ? (payload as { signature?: unknown; fields?: { signature?: unknown } }).signature
                  ?? (payload as { fields?: { signature?: unknown } }).fields?.signature
                : null;
              if (Array.isArray(sigCandidate)) {
                rawSignatureOutput = sigCandidate as number[];
              }
              break;
            }
            if (variantName === 'NetworkRejected') {
              return {
                ok: false,
                error: 'sign NetworkRejected',
                completed: false,
                state: lastState,
                durationMs: Date.now() - t0,
              };
            }
          }
        }
      } catch (err) {
        console.log(`[poll-sign] fetch err: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }

    if (!rawSignatureOutput) {
      return {
        ok: false,
        error: `sign did not reach Completed within ${TIMEOUT_MS}ms (last=${lastState})`,
        completed: false,
        state: lastState,
        durationMs: Date.now() - t0,
      };
    }

    try {
      ensureWasmReady();
      const ikaCurve = curve === 'ed25519' ? Curve.ED25519 : Curve.SECP256K1;
      const algo = curve === 'ed25519' ? SignatureAlgorithm.EdDSA : SignatureAlgorithm.ECDSASecp256k1;
      const rawBytes = new Uint8Array(rawSignatureOutput);
      const parsed = await parseSignatureFromSignOutput(
        ikaCurve as never,
        algo as never,
        rawBytes,
      );
      const signatureHex = Array.from(parsed).map((b) => b.toString(16).padStart(2, '0')).join('');
      return {
        ok: true,
        completed: true,
        signatureHex,
        state: 'Completed',
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return {
        ok: false,
        error: `parseSignatureFromSignOutput failed: ${error}`,
        completed: true,
        state: 'Completed',
        durationMs: Date.now() - t0,
      };
    }
  }
}
