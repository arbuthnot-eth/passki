/**
 * Darkrai Bad Dreams pt2.5 — refresh SKI balance + subname NFT card after a
 * SUIAMI proof is generated. The proof flow may write a SuiNS targetAddress,
 * staling cached balances keyed off the name. Listens for `suiami:signed`
 * and re-dispatches `ski:balance-updated` + `ski:ownership-changed` so the
 * existing handlers in src/ui.ts (lines 17714, 17722) re-fetch.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('suiami:signed', (event: Event) => {
    const detail = (event as CustomEvent<{ name?: string }>).detail;
    const name = detail?.name;
    if (typeof name !== 'string' || name.length === 0) return;
    window.dispatchEvent(new Event('ski:balance-updated'));
    window.dispatchEvent(new CustomEvent('ski:ownership-changed', { detail: { name } }));
  });
}
