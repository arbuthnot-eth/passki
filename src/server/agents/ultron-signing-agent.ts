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
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { IkaClient, getNetworkConfig } from '@ika.xyz/sdk';

// The .js bindings are pure ES module — they export `initSync(module)`
// + every cryptographic function. We skip the default export (`__wbg_init`)
// because that path expects a browser loader via `import.meta.url`. Workers
// go through `initSync` with a pre-compiled WebAssembly.Module instead.
import {
  initSync,
  generate_secp_cg_keypair_from_seed,
} from '@ika.xyz/ika-wasm/web';

// Ultron's ed25519 dWallet from the Registeel Lock-On DKG. The DWalletCap
// is 0x518b96da… owned by ultron, and this is the underlying dwallet
// object that holds public_output + encrypted_user_secret_key_shares.
const ULTRON_ED25519_DWALLET_ID = '0x1a5e6b22b81cd644e15314b451212d9cadb6cd1446c466754760cc5a65ac82a9';

// JSON-RPC endpoints for the Sui mainnet. Primary + two fallbacks; same
// pattern the shade-executor uses for tx submission. We don't use
// fullnode.mainnet.sui.io because it sunsets JSON-RPC in April 2026 —
// PublicNode / BlockVision / Ankr are the long-term providers.
const SUI_JSON_RPC_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
];

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

/**
 * Lazy init the IkaClient wrapping a SuiJsonRpcClient. Stays cached for
 * the DO's lifetime so subsequent signing calls reuse the same client
 * (avoids the ~200 ms handshake cost per request). The first endpoint
 * that responds successfully wins via Promise.any across SUI_JSON_RPC_URLS.
 */
async function getIkaClient(): Promise<IkaClient> {
  if (_ikaClient) return _ikaClient;
  const config = getNetworkConfig('mainnet');
  const clients = SUI_JSON_RPC_URLS.map((url) => new SuiJsonRpcClient({ url }));
  const candidates = clients.map(async (suiClient) => {
    const ika = new IkaClient({ config, suiClient: suiClient as never });
    await ika.initialize();
    return ika;
  });
  _ikaClient = await Promise.any(candidates);
  return _ikaClient;
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
      const result = await this._readUltronDWallet();
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
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
  private async _readUltronDWallet(): Promise<{
    ok: boolean;
    error?: string;
    dwalletId?: string;
    state?: string;
    publicOutputLength?: number;
    encryptedUserShareCount?: number;
    curve?: number;
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      const ika = await getIkaClient();
      // Use getDWallet (no polling) — getDWalletInParticularState relies
      // on the SDK's internal state-variant detection which has a parsing
      // quirk with JSON-RPC's move-enum serialization. The raw getObject
      // path gives us everything we need: the dwallet loaded successfully
      // and the state fields + curve + share count tell us whether it's
      // Active without needing the SDK to tag the variant.
      const dwallet = await ika.getDWallet(ULTRON_ED25519_DWALLET_ID);
      const dw = dwallet as unknown as Record<string, unknown> & {
        state?: Record<string, unknown>;
        encrypted_user_secret_key_shares?: { size?: number | string };
        curve?: number;
      };
      const stateKeys = dw.state ? Object.keys(dw.state) : [];
      // State.Active has exactly one field: public_output. Any other
      // variant has different or additional fields.
      const activeInner = (dw.state as { Active?: { public_output?: number[] } } | undefined)?.Active;
      const publicOutput = activeInner?.public_output
        ?? (dw.state as { public_output?: number[] } | undefined)?.public_output;
      const publicOutputLength = Array.isArray(publicOutput) ? publicOutput.length : 0;
      const sharesSize = dw.encrypted_user_secret_key_shares?.size;
      const encryptedUserShareCount = typeof sharesSize === 'string' ? Number(sharesSize) : (sharesSize ?? 0);
      const state = publicOutputLength > 0 ? 'Active' : (stateKeys[0] ?? 'Unknown');
      return {
        ok: true,
        dwalletId: ULTRON_ED25519_DWALLET_ID,
        state,
        publicOutputLength,
        encryptedUserShareCount,
        curve: dw.curve,
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
}
