/**
 * Shared browser-side network detection.
 *
 * Single source of truth for `mainnet` vs `testnet` resolution — used by
 * `rpc.ts` to pick transport singletons, by `suins.ts` to pick SuiNS
 * package constants, and by `client/ika.ts` to pick IKA network config.
 *
 * Runtime-evaluated (not frozen at import) so unit tests and SSR can
 * override `globalThis.location` between calls.
 *
 *   dotski-devnet.*.workers.dev → testnet
 *   localhost / 127.0.0.1       → testnet
 *   everything else             → mainnet  (fail-closed)
 *
 * Voter 2 of the nursery wrap flagged this as the single biggest
 * technical-risk surface: a typo here mis-routes real mainnet users to
 * testnet and drops NS registration fees on the floor. Mirror every
 * change into `network-detection.test.ts` before committing.
 */
export function detectNetwork(): 'mainnet' | 'testnet' {
  try {
    const loc = (globalThis as { location?: { hostname?: string } }).location;
    const host = (loc?.hostname || '').toLowerCase();
    if (!host) return 'mainnet';
    if (host === 'localhost' || host === '127.0.0.1') return 'testnet';
    if (host.startsWith('dotski-devnet.') && host.endsWith('.workers.dev')) return 'testnet';
  } catch {}
  return 'mainnet';
}

/** True when the active network is mainnet. Use to gate mainnet-only custom packages. */
export function isMainnet(): boolean {
  return detectNetwork() === 'mainnet';
}
