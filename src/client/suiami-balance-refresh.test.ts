/**
 * Repro for Darkrai Bad Dreams — SUIAMI proof balance-refresh bug.
 *
 * After a `suiami:signed` event fires, the SKI top-line balance and the
 * subname's NFT card balance should both refresh: a SUIAMI proof writes
 * an on-chain attestation (and may resolve a subname's targetAddress to
 * the connected wallet), so any cached balance keyed off that name is
 * stale until the UI re-fetches.
 *
 * Currently the inline `suiami:signed` listener in src/ui.ts:17686 updates
 * the squids panel + SUIAMI buttons, but never dispatches the
 * `ski:balance-updated` or `ski:ownership-changed` events that drive the
 * balance refresh path (src/ui.ts:17714, 17722).
 *
 * The fix lives in src/client/suiami-balance-refresh.ts — a small module
 * that listens for `suiami:signed` and re-dispatches the refresh signals
 * the existing balance-card and SKI-balance handlers already react to.
 */

import { describe, expect, test, beforeEach } from 'bun:test';

// Minimal browser-event surface using Node's built-in EventTarget.
function makeStubWindow() {
  const target = new EventTarget();
  const win = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    CustomEvent: globalThis.CustomEvent,
  };
  return win as unknown as Window;
}

describe('SUIAMI balance refresh after proof generation', () => {
  let win: Window;
  let dispatched: string[];

  beforeEach(async () => {
    win = makeStubWindow();
    dispatched = [];
    (globalThis as { window?: Window }).window = win;

    win.addEventListener('ski:balance-updated', () => dispatched.push('ski:balance-updated'));
    win.addEventListener('ski:ownership-changed', () => dispatched.push('ski:ownership-changed'));

    // Force a fresh import each test so the module re-registers against the new window.
    delete require.cache[require.resolve('./suiami-balance-refresh.ts')];
    await import('./suiami-balance-refresh.ts');
  });

  test('dispatches ski:balance-updated when suiami:signed fires', () => {
    win.dispatchEvent(
      new CustomEvent('suiami:signed', {
        detail: { proof: 'mock-token', name: 'saints', address: '0x' + 'ab'.repeat(32) },
      }),
    );
    expect(dispatched).toContain('ski:balance-updated');
  });

  test('dispatches ski:ownership-changed when suiami:signed fires', () => {
    win.dispatchEvent(
      new CustomEvent('suiami:signed', {
        detail: { proof: 'mock-token', name: 'saints', address: '0x' + 'ab'.repeat(32) },
      }),
    );
    expect(dispatched).toContain('ski:ownership-changed');
  });

  test('does NOT fire refresh when suiami:signed has no name (no targetAddress affected)', () => {
    win.dispatchEvent(
      new CustomEvent('suiami:signed', {
        detail: { proof: 'mock-token', address: '0x' + 'cd'.repeat(32) },
      }),
    );
    expect(dispatched).not.toContain('ski:balance-updated');
    expect(dispatched).not.toContain('ski:ownership-changed');
  });

  test('survives multiple SUIAMI proofs in sequence', () => {
    for (const name of ['saints', 'thunder', 'shade']) {
      win.dispatchEvent(
        new CustomEvent('suiami:signed', {
          detail: { proof: `tok-${name}`, name, address: '0x' + 'ef'.repeat(32) },
        }),
      );
    }
    expect(dispatched.filter((e) => e === 'ski:balance-updated').length).toBe(3);
    expect(dispatched.filter((e) => e === 'ski:ownership-changed').length).toBe(3);
  });
});
