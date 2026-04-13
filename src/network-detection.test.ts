/**
 * Network detection unit tests.
 *
 * Voter 2 of the 5-wave wrap-up flagged this as the single biggest technical
 * risk: getSuinsNetwork() touches all 49 SuiNS call sites AND the #1 revenue
 * path (name registration). A typo in the regex would silently re-route real
 * mainnet users to testnet, dropping their NS fees on the floor. 5 static
 * reviews caught 12 bugs but none of them is a test — this file is that test.
 *
 * Run: `bun test src/network-detection.test.ts`
 *
 * We stub `globalThis.location` via a Proxy wrapper per-test so the real
 * browser `location` is untouched and tests can run under Node, Bun, or any
 * other runtime with globalThis.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// ---------------------------------------------------------------------------
// location mocker
// ---------------------------------------------------------------------------

const realLocation = (globalThis as { location?: Location }).location;

function setHost(hostname: string | undefined): void {
  if (hostname === undefined) {
    try {
      delete (globalThis as { location?: Location }).location;
    } catch {
      (globalThis as { location?: Location }).location = undefined;
    }
    return;
  }
  (globalThis as { location?: { hostname: string } }).location = { hostname };
}

function restoreHost(): void {
  if (realLocation) {
    (globalThis as { location?: Location }).location = realLocation;
  } else {
    try {
      delete (globalThis as { location?: Location }).location;
    } catch {
      (globalThis as { location?: Location }).location = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Matrix of hostnames and expected networks
// ---------------------------------------------------------------------------

type NetworkExpectation = 'mainnet' | 'testnet';

const MATRIX: Array<[string | undefined, NetworkExpectation, string]> = [
  // --- production hosts MUST resolve to mainnet ---
  ['sui.ski', 'mainnet', 'root domain — live production'],
  ['www.sui.ski', 'mainnet', 'www subdomain'],
  ['splash.sui.ski', 'mainnet', 'splash subdomain'],
  ['brando.sui.ski', 'mainnet', 'user subdomain'],
  ['dotski.imbibed.workers.dev', 'mainnet', 'mainnet CF worker URL'],
  ['some-preview.pages.dev', 'mainnet', 'CF Pages preview'],
  ['dotski.sui', 'mainnet', 'alt TLD (handled as mainnet)'],

  // --- explicit testnet/devnet hosts MUST resolve to testnet ---
  ['localhost', 'testnet', 'local wrangler dev'],
  ['127.0.0.1', 'testnet', 'local IPv4'],
  ['dotski-devnet.imbibed.workers.dev', 'testnet', 'the devnet worker we deploy to'],
  ['dotski-devnet.someaccount.workers.dev', 'testnet', 'devnet under a different CF account'],

  // --- ambiguous hosts MUST default to mainnet (fail-closed) ---
  ['', 'mainnet', 'empty hostname → default mainnet'],
  [undefined, 'mainnet', 'location undefined (SSR / CF Worker) → default mainnet'],
  ['dotski-devnet.sui.ski', 'mainnet', 'devnet prefix on prod TLD — NOT workers.dev'],
  ['devnet.sui.ski', 'mainnet', 'devnet subdomain on prod TLD — NOT workers.dev'],
  ['dotski-devnet-staging.imbibed.workers.dev', 'mainnet', 'different worker name (dotski-devnet-staging) — NOT a variant of dotski-devnet, fail-closed to mainnet'],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getSuinsNetwork', () => {
  afterEach(() => restoreHost());

  for (const [host, expected, description] of MATRIX) {
    test(`${String(host)} → ${expected}  (${description})`, async () => {
      setHost(host);
      // Dynamic import so each test sees its own module evaluation context.
      // getSuinsNetwork reads globalThis.location at CALL TIME, so a single
      // import is actually enough, but we re-import to guard against any
      // top-level caching added in the future.
      const { getSuinsNetwork } = await import('./suins.js');
      expect(getSuinsNetwork()).toBe(expected);
    });
  }
});

describe('getIkaNetwork', () => {
  afterEach(() => restoreHost());

  for (const [host, expected, description] of MATRIX) {
    test(`${String(host)} → ${expected}  (${description})`, async () => {
      setHost(host);
      const { getIkaNetwork } = await import('./client/ika.js');
      expect(getIkaNetwork()).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Consistency: getSuinsNetwork and getIkaNetwork must agree for every host
// ---------------------------------------------------------------------------

describe('network-detection consistency', () => {
  afterEach(() => restoreHost());

  test('getSuinsNetwork === getIkaNetwork for every host in the matrix', async () => {
    const { getSuinsNetwork } = await import('./suins.js');
    const { getIkaNetwork } = await import('./client/ika.js');

    const mismatches: Array<{ host: string | undefined; suins: string; ika: string }> = [];
    for (const [host] of MATRIX) {
      setHost(host);
      const suins = getSuinsNetwork();
      const ika = getIkaNetwork();
      if (suins !== ika) mismatches.push({ host, suins, ika });
    }

    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectNetwork() — shared implementation that feeds rpc.ts singletons.
// ---------------------------------------------------------------------------

describe('detectNetwork', () => {
  afterEach(() => restoreHost());

  for (const [host, expected, description] of MATRIX) {
    test(`${String(host)} → ${expected}  (${description})`, async () => {
      setHost(host);
      const { detectNetwork } = await import('./network.js');
      expect(detectNetwork()).toBe(expected);
    });
  }
});

describe('isMainnet', () => {
  afterEach(() => restoreHost());

  test('true on mainnet hosts, false on testnet hosts', async () => {
    const { isMainnet } = await import('./network.js');

    setHost('sui.ski');
    expect(isMainnet()).toBe(true);

    setHost('dotski-devnet.imbibed.workers.dev');
    expect(isMainnet()).toBe(false);

    setHost('localhost');
    expect(isMainnet()).toBe(false);

    // Fail-closed: undefined location → mainnet
    setHost(undefined);
    expect(isMainnet()).toBe(true);
  });
});
