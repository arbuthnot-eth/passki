/**
 * encrypt-demo.ts — minimal smoke-test UI for the pre-alpha Encrypt FHE client.
 *
 * Exercises the full browser → CF Worker proxy → gRPC stub round trip:
 *   1. GET  /api/encrypt/network_key
 *   2. POST /api/encrypt/create_input       (encryptBalance)
 *   3. POST /api/encrypt/create_input       (buildTransferInputs)
 *
 * PRE-ALPHA: nothing is actually encrypted. Do NOT use real funds.
 */

import {
  getEncryptClient,
  encryptBalance,
  buildTransferInputs,
} from './client/encrypt';

// ---------------------------------------------------------------------------
// Tiny DOM helpers (no framework)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v);
    else if (k in node) (node as any)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

function jsonBlock(value: unknown): HTMLElement {
  const pre = el('pre', { class: 'out' });
  pre.textContent = JSON.stringify(
    value,
    (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v),
    2,
  );
  return pre;
}

function errorBlock(err: unknown): HTMLElement {
  const pre = el('pre', { class: 'err' });
  pre.textContent =
    err instanceof Error
      ? `${err.name}: ${err.message}\n\n${err.stack ?? ''}`
      : String(err);
  return pre;
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

interface Step {
  id: string;
  label: string;
  run: () => Promise<unknown>;
}

function makeStep(step: Step): HTMLElement {
  const title = el('h2', { class: 'step-title' }, [`[${step.id}] ${step.label}`]);
  const btn = el('button', { class: 'btn', type: 'button' }, ['run']);
  const status = el('span', { class: 'status' }, ['idle']);
  const output = el('div', { class: 'output' });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'running…';
    status.className = 'status running';
    output.replaceChildren();
    const t0 = performance.now();
    try {
      const result = await step.run();
      const dt = (performance.now() - t0).toFixed(0);
      status.textContent = `ok (${dt}ms)`;
      status.className = 'status ok';
      output.append(jsonBlock(result));
    } catch (err) {
      const dt = (performance.now() - t0).toFixed(0);
      status.textContent = `error (${dt}ms)`;
      status.className = 'status err';
      output.append(errorBlock(err));
    } finally {
      btn.disabled = false;
    }
  });

  return el('section', { class: 'step' }, [
    el('div', { class: 'step-head' }, [title, btn, status]),
    output,
  ]);
}

// ---------------------------------------------------------------------------
// Render entry
// ---------------------------------------------------------------------------

export function renderEncryptDemo(container: HTMLElement): void {
  container.replaceChildren();

  const banner = el('div', { class: 'warn' }, [
    'PRE-ALPHA — NO REAL ENCRYPTION. All values are plaintext on-chain. Do NOT submit sensitive or real data.',
  ]);

  const header = el('header', { class: 'header' }, [
    el('h1', {}, ['.SKI // confidential iUSD demo']),
    el('p', { class: 'sub' }, [
      'Smoke test: browser → /api/encrypt/* CF Worker proxy → Encrypt gRPC stub',
    ]),
  ]);

  const client = getEncryptClient();

  const steps: Step[] = [
    {
      id: '1',
      label: 'getNetworkKey()',
      run: () => client.getNetworkKey(),
    },
    {
      id: '2',
      label: 'encryptBalance(100_000n)  // 100 USDC @ 6 decimals',
      run: async () => {
        const handle = await encryptBalance(100_000n);
        return {
          ciphertextId: handle.id,
          fheType: handle.type,
          plaintextDebug: handle._plaintextDebug,
        };
      },
    },
    {
      id: '3',
      label: "buildTransferInputs('alice', 'bob', 50_000n)",
      run: async () => {
        const r = await buildTransferInputs('alice', 'bob', 50_000n);
        return {
          amountCiphertextId: r.amountCiphertext.id,
          fheType: r.amountCiphertext.type,
          plaintextDebug: r.amountCiphertext._plaintextDebug,
          note: r.note,
        };
      },
    },
  ];

  const stepsWrap = el('div', { class: 'steps' }, steps.map(makeStep));

  const runAllBtn = el('button', { class: 'btn btn-primary', type: 'button' }, [
    'run all steps',
  ]);
  runAllBtn.addEventListener('click', () => {
    stepsWrap.querySelectorAll<HTMLButtonElement>('button.btn').forEach((b) => {
      if (b !== runAllBtn) b.click();
    });
  });

  const footer = el('footer', { class: 'footer' }, [
    el('span', {}, ['proxy: /api/encrypt']),
    el('span', {}, ['program: 4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8']),
  ]);

  container.append(banner, header, runAllBtn, stepsWrap, footer);
}

// Auto-mount if a #encrypt-demo container exists.
if (typeof document !== 'undefined') {
  const boot = () => {
    const root = document.getElementById('encrypt-demo');
    if (root) renderEncryptDemo(root);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
