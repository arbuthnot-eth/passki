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

// The .js bindings are pure ES module — they export `initSync(module)`
// + every cryptographic function. We skip the default export (`__wbg_init`)
// because that path expects a browser loader via `import.meta.url`. Workers
// go through `initSync` with a pre-compiled WebAssembly.Module instead.
import {
  initSync,
  generate_secp_cg_keypair_from_seed,
} from '@ika.xyz/ika-wasm/web';

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

export class UltronSigningAgent extends Agent<Env, UltronSigningState> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/wasm-spike') || url.searchParams.has('wasm-spike')) {
      const result = await this._wasmSmokeTest();
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
