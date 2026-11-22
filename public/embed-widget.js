// passki embed widget (/embed). Runs inside third-party iframes, so it is
// deliberately read-only: it resolves a SuiNS name to its SUIAMI roster
// entry and shows the verified cross-chain addresses. Anything that needs a
// signature opens passki in its own top-level window, where it can't be
// overlaid or clickjacked by the host page.
(() => {
  'use strict';

  const ROSTER = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';
  const $ = (id) => document.getElementById(id);
  const result = $('result');

  async function rpc(method, params) {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429) throw new Error('Too many lookups. Try again in a minute.');
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || 'Lookup failed');
    return json.result;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function message(text, bad) {
    result.replaceChildren(el('div', bad ? 'msg bad' : 'msg', text));
  }

  function addressRow(chain, addr) {
    const row = el('div', 'row');
    row.append(el('div', 'chain', chain), el('div', 'addr', addr));
    const copy = el('button', 'copy', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', `Copy ${chain} address`);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(addr); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Select'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    row.append(copy);
    return row;
  }

  function normalizeName(raw) {
    const n = raw.trim().toLowerCase().replace(/^@/, '').replace(/\.sui$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(n) ? `${n}.sui` : null;
  }

  async function lookup(raw) {
    const name = normalizeName(raw);
    if (!name) return message('Enter a valid .sui name.', true);
    $('go').disabled = true;
    message(`Looking up ${name}…`);
    try {
      const address = await rpc('suix_resolveNameServiceAddress', [name]);
      if (!address) return message(`${name} isn’t registered.`, true);

      const field = await rpc('suix_getDynamicFieldObject', [ROSTER, { type: 'address', value: address }]);
      const rec = field && field.data && field.data.content && field.data.content.fields.value
        ? field.data.content.fields.value.fields : null;

      const head = el('div', 'name', name);
      head.append(rec && rec.verified
        ? el('span', 'badge ok', 'SUIAMI verified')
        : el('span', 'badge no', rec ? 'unverified' : 'no SUIAMI record'));
      const rows = [head, addressRow('sui', address)];

      const entries = rec && rec.chains && rec.chains.fields ? rec.chains.fields.contents : [];
      for (const e of entries) {
        const k = e.fields.key, v = e.fields.value;
        if (k !== 'sui' && v) rows.push(addressRow(k, v));
      }
      result.replaceChildren(...rows);
    } catch (err) {
      message(err && err.message ? err.message : 'Lookup failed.', true);
    } finally {
      $('go').disabled = false;
    }
  }

  $('lookup').addEventListener('submit', (e) => { e.preventDefault(); lookup($('name').value); });

  // Real actions happen in a top-level passki window (visible address bar,
  // can't be framed). noopener keeps the host page from scripting it.
  $('open').addEventListener('click', () => {
    window.open(`${location.origin}/`, '_blank', 'noopener,popup,width=440,height=780');
  });

  // Ask the host's embed.js to close the panel. Carries no data.
  $('close').addEventListener('click', () => {
    if (window.parent !== window) window.parent.postMessage({ type: 'ski:toggle' }, '*');
  });

  const preset = new URLSearchParams(location.search).get('name');
  if (preset) { $('name').value = preset.replace(/\.sui$/i, ''); lookup(preset); }
})();
