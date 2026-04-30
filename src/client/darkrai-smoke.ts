/**
 * Darkrai smoke test — Bad Dreams move 1.
 *
 * Confirms `darkrai-wasm` (batch threshold encryption from partial fractions,
 * ePrint 2026/674) loads and runs in SKI's actual browser environment under
 * `bun build` + Cloudflare static asset serving.
 *
 * Architecture goal: Seal stays the trust layer (committee holding the
 * Storm's master `sk`); Darkrai becomes the efficiency layer (one batch
 * decrypt per epoch instead of N per-message Seal decrypts).
 *
 * Usage from browser devtools after deploy:
 *   await window.__darkraiSmoke()
 *
 * Wasm bundle: ~289 KB raw, ~95 KB gzipped.
 * Source: https://github.com/arbuthnot-eth/batch-enc-partial-fractions/tree/passki
 */

export interface DarkraiBenchResult {
  ell: number;
  setup_ms: number;
  encrypt_total_ms: number;
  encrypt_per_ms: number;
  pre_decrypt_ms: number;
  decrypt_ms: number;
  ct_bytes: number;
  sbk_bytes: number;
  dk_bytes: number;
  ek_bytes: number;
}

interface DarkraiModule {
  default: (path?: string) => Promise<unknown>;
  version: () => string;
  bench_batch: (ell: number) => string;
}

let cached: DarkraiModule | null = null;

async function loadDarkrai(): Promise<DarkraiModule> {
  if (cached) return cached;
  // String concat keeps bun/Vite from trying to resolve the path at build time.
  const url = '/wasm/darkrai/' + 'darkrai_wasm.js';
  const mod = (await import(/* @vite-ignore */ url)) as DarkraiModule;
  await mod.default();
  cached = mod;
  return cached;
}

export async function darkraiSmoke(): Promise<{
  version: string;
  results: DarkraiBenchResult[];
}> {
  const mod = await loadDarkrai();
  const sizes = [4, 8, 16];
  const results: DarkraiBenchResult[] = [];
  for (const ell of sizes) {
    const json = mod.bench_batch(ell);
    results.push(JSON.parse(json));
  }
  const version = mod.version();
  console.table(
    results.map((r) => ({
      'ℓ': r.ell,
      'setup (ms)': r.setup_ms.toFixed(1),
      'encrypt /msg (ms)': r.encrypt_per_ms.toFixed(2),
      'pre-dec (ms)': r.pre_decrypt_ms.toFixed(1),
      'decrypt (ms)': r.decrypt_ms.toFixed(1),
      'CT (B)': r.ct_bytes,
      'sbk (B)': r.sbk_bytes,
    })),
  );
  console.info(`[darkrai] ${version}`);
  return { version, results };
}

// Exposed on window for smoke testing. Remove once Bad Dreams ships beyond
// the smoke gate.
declare global {
  interface Window {
    __darkraiSmoke?: typeof darkraiSmoke;
  }
}
if (typeof window !== 'undefined') {
  window.__darkraiSmoke = darkraiSmoke;
}
