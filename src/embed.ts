/**
 * SKI Embed Loader — lightweight host-page script (~5KB).
 *
 * Responsibilities:
 * 1. Create a positioned iframe loading sui.ski
 * 2. Discover wallet extensions on the host's window (Wallet Standard)
 * 3. Bridge signing requests between iframe ↔ wallet extensions via postMessage
 * 4. Strict origin validation on all messages
 *
 * Usage: <script src="https://sui.ski/embed.js"></script>
 *    or: <script src="https://sui.ski/embed.js" data-position="bottom-right"></script>
 *
 * Security model:
 * - iframe is cross-origin (sui.ski) — host page cannot access iframe JS/DOM
 * - All postMessage validated against SKI_ORIGIN
 * - Wallet signing happens on the host's window (where extensions live)
 * - Only whitelisted message types are forwarded
 * - No eval, no innerHTML, no dynamic script injection
 */

const SKI_ORIGIN = 'https://sui.ski';
const ALLOWED_MESSAGES = new Set([
  'ski:discover-wallets',
  'ski:wallets-discovered',
  'ski:connect-wallet',
  'ski:wallet-connected',
  'ski:sign-transaction',
  'ski:transaction-signed',
  'ski:sign-personal-message',
  'ski:personal-message-signed',
  'ski:sign-and-execute',
  'ski:execution-result',
  'ski:disconnect',
  'ski:disconnected',
  'ski:toggle',
  'ski:ready',
  'ski:error',
]);

// ── Configuration ──

interface SkiEmbedConfig {
  position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  width: number;
  zIndex: number;
}

const script = document.currentScript as HTMLScriptElement | null;
const config: SkiEmbedConfig = {
  position: (script?.dataset.position as SkiEmbedConfig['position']) || 'top-right',
  width: parseInt(script?.dataset.width || '420', 10),
  zIndex: parseInt(script?.dataset.zIndex || '99999', 10),
};

// ── Iframe creation ──

const wrap = document.createElement('div');
wrap.id = 'ski-embed-wrap';
wrap.style.cssText = `position:fixed;${config.position.includes('top')?'top:0':'bottom:0'};${config.position.includes('right')?'right:0':'left:0'};width:${config.width}px;height:100vh;z-index:${config.zIndex};display:none;box-shadow:-4px 0 24px rgba(0,0,0,0.5);transition:transform 0.25s ease`;
wrap.style.transform = config.position.includes('right') ? 'translateX(100%)' : 'translateX(-100%)';

const iframe = document.createElement('iframe');
iframe.id = 'ski-embed-frame';
iframe.src = `${SKI_ORIGIN}/?embed=1`;
iframe.allow = 'clipboard-write';
iframe.loading = 'lazy';
iframe.style.cssText = 'width:100%;height:100%;border:none;background:#0a0a1a';
wrap.appendChild(iframe);

// ── Toggle button ──

const btn = document.createElement('button');
btn.id = 'ski-embed-toggle';
btn.title = 'SKI — once, everywhere';
btn.setAttribute('aria-label', 'Open SKI');
btn.style.cssText = `position:fixed;${config.position.includes('top')?'top:12px':'bottom:12px'};${config.position.includes('right')?'right:12px':'left:12px'};z-index:${config.zIndex + 1};width:44px;height:44px;border:1px solid rgba(77,162,255,0.3);border-radius:50%;background:rgba(10,14,28,0.9);backdrop-filter:blur(8px);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s;padding:0`;
btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#0a1a2e" stroke="#4da2ff" stroke-width="3"/><text x="50" y="62" text-anchor="middle" fill="#4da2ff" font-size="32" font-weight="bold" font-family="system-ui">SKI</text></svg>`;
btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'rgba(77,162,255,0.6)'; btn.style.boxShadow = '0 0 16px rgba(77,162,255,0.25)'; });
btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'rgba(77,162,255,0.3)'; btn.style.boxShadow = 'none'; });

let open = false;
btn.addEventListener('click', () => {
  open = !open;
  if (open) {
    wrap.style.display = 'block';
    requestAnimationFrame(() => { wrap.style.transform = 'translateX(0)'; });
    btn.style[config.position.includes('right') ? 'right' : 'left'] = `${config.width + 12}px`;
  } else {
    wrap.style.transform = config.position.includes('right') ? 'translateX(100%)' : 'translateX(-100%)';
    btn.style[config.position.includes('right') ? 'right' : 'left'] = '12px';
    setTimeout(() => { if (!open) wrap.style.display = 'none'; }, 300);
  }
});

document.body.appendChild(wrap);
document.body.appendChild(btn);

// ── Wallet bridge ──

type WalletInfo = { name: string; icon?: string; chains: string[] };

function getWallets(): WalletInfo[] {
  const wallets: WalletInfo[] = [];
  try {
    const registered = (window as any).__suiWallets?.get?.() ?? [];
    for (const w of registered) {
      wallets.push({ name: w.name, icon: w.icon, chains: [...(w.chains ?? [])] });
    }
  } catch {}
  // Wallet Standard API
  try {
    const std = (window as any).navigator?.wallets?.get?.() ?? [];
    for (const w of std) {
      if (!wallets.find(e => e.name === w.name)) {
        wallets.push({ name: w.name, icon: w.icon, chains: [...(w.chains ?? [])] });
      }
    }
  } catch {}
  return wallets;
}

// Active wallet connection state
let activeWallet: any = null;

async function connectWallet(name: string): Promise<{ address: string; walletName: string } | null> {
  try {
    const wallets = (window as any).__suiWallets?.get?.() ?? [];
    const wallet = wallets.find((w: any) => w.name === name);
    if (!wallet) return null;

    const connectFeature = wallet.features?.['standard:connect'];
    if (!connectFeature) return null;

    const result = await connectFeature.connect();
    const account = result.accounts?.[0];
    if (!account) return null;

    activeWallet = wallet;
    return { address: account.address, walletName: wallet.name };
  } catch {
    return null;
  }
}

async function signTransaction(txBytes: string): Promise<{ signature: string; bytes: string } | null> {
  if (!activeWallet) return null;
  try {
    const feature = activeWallet.features?.['sui:signTransaction'];
    if (!feature) return null;
    const bytes = Uint8Array.from(atob(txBytes), c => c.charCodeAt(0));
    const result = await feature.signTransaction({ transaction: bytes });
    return { signature: result.signature, bytes: btoa(String.fromCharCode(...result.bytes)) };
  } catch {
    return null;
  }
}

async function signPersonalMessage(msgBase64: string): Promise<{ signature: string } | null> {
  if (!activeWallet) return null;
  try {
    const feature = activeWallet.features?.['sui:signPersonalMessage'];
    if (!feature) return null;
    const bytes = Uint8Array.from(atob(msgBase64), c => c.charCodeAt(0));
    const result = await feature.signPersonalMessage({ message: bytes });
    return { signature: result.signature };
  } catch {
    return null;
  }
}

async function signAndExecute(txBytes: string): Promise<{ digest: string; effects?: any } | null> {
  if (!activeWallet) return null;
  try {
    const feature = activeWallet.features?.['sui:signAndExecuteTransaction'];
    if (!feature) return null;
    const bytes = Uint8Array.from(atob(txBytes), c => c.charCodeAt(0));
    const result = await feature.signAndExecuteTransaction({ transaction: bytes });
    return { digest: result.digest, effects: result.effects };
  } catch {
    return null;
  }
}

async function disconnectWallet(): Promise<void> {
  if (!activeWallet) return;
  try {
    const feature = activeWallet.features?.['standard:disconnect'];
    if (feature) await feature.disconnect();
  } catch {}
  activeWallet = null;
}

// ── postMessage handler (strict origin validation) ──

window.addEventListener('message', async (e) => {
  // SECURITY: only accept messages from the SKI iframe origin
  if (e.origin !== SKI_ORIGIN) return;
  if (!e.data?.type || !ALLOWED_MESSAGES.has(e.data.type)) return;

  const { type, id, payload } = e.data;
  const reply = (replyType: string, replyPayload: any) => {
    iframe.contentWindow?.postMessage(
      { type: replyType, id, payload: replyPayload },
      SKI_ORIGIN,
    );
  };

  switch (type) {
    case 'ski:discover-wallets':
      reply('ski:wallets-discovered', { wallets: getWallets() });
      break;

    case 'ski:connect-wallet':
      const conn = await connectWallet(payload?.name);
      reply('ski:wallet-connected', conn ?? { error: 'Connection failed' });
      break;

    case 'ski:sign-transaction':
      const sig = await signTransaction(payload?.txBytes);
      reply('ski:transaction-signed', sig ?? { error: 'Signing failed' });
      break;

    case 'ski:sign-personal-message':
      const pmSig = await signPersonalMessage(payload?.message);
      reply('ski:personal-message-signed', pmSig ?? { error: 'Signing failed' });
      break;

    case 'ski:sign-and-execute':
      const exec = await signAndExecute(payload?.txBytes);
      reply('ski:execution-result', exec ?? { error: 'Execution failed' });
      break;

    case 'ski:disconnect':
      await disconnectWallet();
      reply('ski:disconnected', {});
      break;

    case 'ski:toggle':
      btn.click();
      break;
  }
});

// Notify iframe when it's ready
iframe.addEventListener('load', () => {
  iframe.contentWindow?.postMessage(
    { type: 'ski:ready', payload: { host: window.location.origin } },
    SKI_ORIGIN,
  );
});

// ── Mobile responsive ──
const mq = window.matchMedia('(max-width: 600px)');
const applyMobile = (matches: boolean) => {
  wrap.style.width = matches ? '100vw' : `${config.width}px`;
};
mq.addEventListener('change', (e) => applyMobile(e.matches));
applyMobile(mq.matches);
