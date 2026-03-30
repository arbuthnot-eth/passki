import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';
import { raceJsonRpc } from './rpc.js';
// ika-provision.ts is available for server-side DKG if needed in future,
// but DKG WASM must run client-side (browser) — Workers can't run it.

interface Env {
  ShadeExecutorAgent: DurableObjectNamespace;
  TreasuryAgents: DurableObjectNamespace;
  TRADEPORT_API_KEY: string;
  TRADEPORT_API_USER: string;
  SHADE_KEEPER_PRIVATE_KEY?: string; // ultron.sui signing key
}

const app = new Hono<{ Bindings: Env }>();

// Pass through hb.sui.ski to Hayabusa Worker
app.use('*', async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (host === 'hb.sui.ski') return c.text('', 404);
  return next();
});

// Agents middleware handles WebSocket upgrades and RPC to /agents/*
app.use('/agents/*', agentsMiddleware());

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

// ── Superteam demo video player ──
const WALRUS_VIDEO_URL = 'https://aggregator.walrus-testnet.walrus.space/v1/blobs/w-YsMSmoAgV-RQt_SinhQuEoM107nqC52WPUEi11ofI';
const POSTER_URL = 'https://sui.ski/assets/superteam-poster.jpg';
app.get('/superteam', (c) => c.html(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>.SKI — Native Bitcoin &amp; Solana via IKA dWallets</title>
<meta name="description" content="Real Bitcoin, Ethereum, and Solana addresses controlled by your Sui account — no bridges, no wrapping. Powered by IKA 2PC-MPC threshold signatures.">
<meta property="og:title" content=".SKI — Native Bitcoin &amp; Solana via IKA dWallets">
<meta property="og:description" content="Two DKGs. Two dWallets. Seven chains. One Sui account. Powered by IKA 2PC-MPC + Walrus decentralized storage.">
<meta property="og:type" content="video.other">
<meta property="og:video" content="${WALRUS_VIDEO_URL}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1920">
<meta property="og:video:height" content="1080">
<meta property="og:image" content="${POSTER_URL}">
<meta property="og:url" content="https://sui.ski/superteam">
<meta property="og:site_name" content="sui.ski">
<meta name="twitter:card" content="player">
<meta name="twitter:site" content="@ArbuthnotEth">
<meta name="twitter:title" content=".SKI — Native Bitcoin &amp; Solana via IKA dWallets">
<meta name="twitter:description" content="Two DKGs. Two dWallets. Seven chains. One Sui account.">
<meta name="twitter:player" content="https://sui.ski/superteam/embed">
<meta name="twitter:player:width" content="480">
<meta name="twitter:player:height" content="270">
<meta name="twitter:player:stream" content="${WALRUS_VIDEO_URL}">
<meta name="twitter:player:stream:content_type" content="video/mp4">
<meta name="twitter:image" content="${POSTER_URL}">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif}
.wrap{max-width:960px;width:100%;padding:16px}video{width:100%;border-radius:12px;box-shadow:0 0 40px rgba(0,200,255,.15)}
p{color:#888;text-align:center;margin-top:12px;font-size:13px}a{color:#4da2ff}</style>
</head><body><div class="wrap">
<video src="${WALRUS_VIDEO_URL}" controls autoplay muted playsinline poster="${POSTER_URL}"></video>
<p>Hosted on <a href="https://walrus.xyz">Walrus</a> — Sui's decentralized storage. <a href="https://sui.ski">sui.ski</a></p>
</div></body></html>`));

// Twitter/X player embed (iframe src for twitter:player card)
// Must: HTTPS, no X-Frame-Options deny, allow autoplay
app.get('/superteam/embed', (c) => {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}body{background:#000;overflow:hidden}video{width:100%;height:100vh;object-fit:contain}</style>
</head>
<body><video src="${WALRUS_VIDEO_URL}" controls autoplay muted playsinline poster="${POSTER_URL}"></video></body></html>`;
  return c.html(html, 200, {
    'X-Frame-Options': 'ALLOWALL',
    'Content-Security-Policy': "frame-ancestors *",
  });
});

// ── Superteam iframe with green dollar QR popup ──
const SUPERTEAM_PAGE = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Superteam — sui.ski</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{overflow:hidden}
iframe{width:100%;height:100vh;border:none}
#ski-st-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:pointer}
#ski-st-card{background:#0a0c14;border-radius:16px;padding:24px;text-align:center;max-width:340px;cursor:default}
</style>
</head><body>
<iframe src="https://superteam.fun" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" loading="eager"></iframe>
<div id="ski-st-overlay" onclick="this.style.display='none'">
<div id="ski-st-card" onclick="event.stopPropagation()">
<div style="font-size:20px;font-weight:700;color:#fff;margin-bottom:12px">Superteam</div>
<div id="ski-st-nets" style="display:flex;gap:4px;justify-content:center;margin-bottom:12px">
<button data-net="btc" style="all:unset;cursor:pointer;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:9px;border:1.5px solid rgba(247,147,26,0.6)"><img src="https://sui.ski/assets/btc-icon.svg" width="28" height="28"></button>
<button data-net="sol" style="all:unset;cursor:pointer;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:9px;border:1.5px solid transparent;opacity:0.4"><img src="https://sui.ski/assets/sol-icon.svg" width="28" height="28"></button>
<button data-net="sui" style="all:unset;cursor:pointer;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:10px;border:1.5px solid transparent;opacity:0.4"><img src="https://sui.ski/assets/sui-icon.svg" width="28" height="28"></button>
</div>
<canvas id="ski-st-qr" width="200" height="200" style="border-radius:10px;background:#fff"></canvas>
<div id="ski-st-addr" style="font-family:monospace;font-size:11px;color:#F7931A;margin-top:8px;cursor:pointer;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,0.04)" title="bc1qtxapc28p93g54gpv5jjllh2tk7axr9lrm7hw23">bc1qtx...7hw23</div>
<div style="font-size:10px;color:#666;margin-top:8px">Powered by <a href="https://sui.ski" style="color:#4da2ff;text-decoration:none">sui.ski</a></div>
</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<script>
(function(){
var addrs={btc:{full:'bc1qtxapc28p93g54gpv5jjllh2tk7axr9lrm7hw23',color:'#F7931A'},sol:{full:'FtdgskzfMMZ87cZR1Qv5mxFSJJVgNp9kh7v59bp6L9dh',color:'#9945FF'},sui:{full:'0x3ca0da71d19d9a1837ad3da155f03aab776aa33963864064eb81569f10e5222b',color:'#4da2ff'}};
var canvas=document.getElementById('ski-st-qr'),addrEl=document.getElementById('ski-st-addr');
function draw(net){var a=addrs[net],s=200,ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,s,s);
var qr=qrcode(0,'L');qr.addData(a.full);qr.make();var m=qr.getModuleCount(),p=8,c=(s-p*2)/m;
ctx.fillStyle='#22c55e';
for(var r=0;r<m;r++)for(var cc=0;cc<m;cc++)if(qr.isDark(r,cc))ctx.fillRect(p+cc*c,p+r*c,c+.5,c+.5);
addrEl.textContent=a.full.slice(0,6)+'...'+a.full.slice(-5);addrEl.title=a.full;addrEl.style.color=a.color;
document.querySelectorAll('#ski-st-nets button').forEach(function(b){b.style.opacity=b.dataset.net===net?'1':'0.4';b.style.borderColor=b.dataset.net===net?a.color:'transparent';});}
document.querySelectorAll('#ski-st-nets button').forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();draw(b.dataset.net);});});
addrEl.addEventListener('click',function(e){e.stopPropagation();navigator.clipboard.writeText(addrEl.title).then(function(){var o=addrEl.textContent;addrEl.textContent='\\u2713 Copied';setTimeout(function(){addrEl.textContent=o;},1000);});});
draw('btc');
})();
</script>
</body></html>`;
app.get('/ar.superteam', (c) => c.html(SUPERTEAM_PAGE));
app.get('/ar.superteam/*', (c) => c.html(SUPERTEAM_PAGE));

// ── JSON-RPC proxy (same-origin, avoids CORS for browser-side IKA SDK) ──
// Forwards to multiple Sui fullnodes with fallback.
const SUI_RPC_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://fullnode.mainnet.sui.io:443',
];
app.post('/api/rpc', async (c) => {
  const body = await c.req.text();
  for (const url of SUI_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      // Accept any response that has JSON content (even non-200)
      const json = await res.text();
      if (json && json.startsWith('{')) {
        return c.text(json, 200, { 'content-type': 'application/json' });
      }
    } catch {}
  }
  return c.json({ error: 'All RPC endpoints failed' }, 502);
});

// ── Shade monitoring & manual poke ──────────────────────────────────

app.get('/api/shade/poke/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const id = c.env.ShadeExecutorAgent.idFromName(address);
    const stub = c.env.ShadeExecutorAgent.get(id);
    const res = await stub.fetch(new Request('https://shade-do/?poke=1', {
      headers: { 'x-partykit-room': address },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.get('/api/shade/status/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const id = c.env.ShadeExecutorAgent.idFromName(address);
    const stub = c.env.ShadeExecutorAgent.get(id);
    const res = await stub.fetch(new Request('https://shade-do/?status=1', {
      headers: { 'x-partykit-room': address },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Schedule a shade order for auto-execution via HTTP POST
app.post('/api/shade/schedule/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const params = await c.req.json();
    const id = c.env.ShadeExecutorAgent.idFromName(address);
    const stub = c.env.ShadeExecutorAgent.get(id);
    const res = await stub.fetch(new Request('https://shade-do/?schedule=1', {
      method: 'POST',
      headers: {
        'x-partykit-room': address,
        'content-type': 'application/json',
      },
      body: JSON.stringify(params),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── SuiNS ownership gate ────────────────────────────────────────────

const SUINS_REGISTRATION_TYPE = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration';
const SUINS_GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/** Check if an address owns at least one SuiNS registration NFT. */
async function hasSuinsNft(address: string): Promise<boolean> {
  try {
    const res = await fetch(SUINS_GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($owner:SuiAddress!,$type:String!){
          address(address:$owner){
            objects(filter:{type:$type},first:1){
              nodes{ address }
            }
          }
        }`,
        variables: { owner: address, type: SUINS_REGISTRATION_TYPE },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { objects?: { nodes?: unknown[] } } };
    };
    return (json?.data?.address?.objects?.nodes?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

// ── Gas sponsorship via ultron ─────────────────────────────────

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/**
 * POST /api/sponsor-gas
 * Body: { txBytes: string, senderAddress?: string } (base64-encoded transaction bytes)
 * Returns: { sponsorSig: string, sponsorAddress: string }
 *
 * Signs the transaction as gas sponsor using the ultron keypair.
 * The client must have built the tx with setGasOwner(sponsorAddress)
 * and setGasPayment pointing to ultron's SUI coins.
 *
 * When senderAddress is provided, requires the sender to own a SuiNS
 * registration NFT (403 if not).
 */
// Proxy JSON-RPC to PublicNode (avoids CORS from browser)
app.post('/api/sui-rpc', async (c) => {
  const body = await c.req.text();
  const res = await fetch('https://sui-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/sponsor-gas', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Gas sponsorship not configured' }, 503);

  try {
    const { txBytes, senderAddress } = await c.req.json<{ txBytes: string; senderAddress?: string }>();
    if (!txBytes) return c.json({ error: 'Missing txBytes' }, 400);

    // SuiNS gate: require sender to own a SuiNS registration NFT
    if (senderAddress) {
      const hasNft = await hasSuinsNft(senderAddress);
      if (!hasNft) return c.json({ error: 'SuiNS name required for gas sponsorship' }, 403);
    }

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const bytes = Uint8Array.from(atob(txBytes), ch => ch.charCodeAt(0));
    const { signature } = await keypair.signTransaction(bytes);

    return c.json({ sponsorSig: signature, sponsorAddress: keypair.toSuiAddress() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

/**
 * GET /api/sponsor-info
 * Returns ultron's address and gas coins so clients can build sponsored txs.
 */
app.get('/api/sponsor-info', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Gas sponsorship not configured' }, 503);

  try {
    const keypair = Ed25519Keypair.fromSecretKey(key);
    const sponsorAddress = keypair.toSuiAddress();

    // Fetch gas coins via GraphQL
    const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            coins(type:"0x2::sui::SUI",first:5){
              nodes{ address version digest contents { json } }
            }
          }
        }`,
        variables: { a: sponsorAddress },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { coins?: { nodes?: Array<{ address: string; version: number; digest: string }> } } };
    };
    const nodes = json?.data?.address?.coins?.nodes ?? [];
    const gasCoins = nodes.map((n) => ({
      objectId: n.address,
      version: String(n.version),
      digest: n.digest,
    }));

    return c.json({ sponsorAddress, gasCoins });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── IKA token funding (ultron → user) ────────────────────────────────

import { Transaction } from '@mysten/sui/transactions';

const IKA_COIN_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
const IKA_FUND_AMOUNT = 5_000_000_000n; // 5 IKA (9 decimals)

/**
 * POST /api/ika/fund
 * Body: { address: string }
 *
 * Transfers a small amount of IKA from ultron to the user.
 * SuiNS-gated. Called before DKG so the user has IKA for the DKG fee.
 * Ultron signs and submits directly (no user signature needed).
 */
app.post('/api/ika/fund', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address) return c.json({ error: 'Missing address' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const ultronAddress = keypair.toSuiAddress();

    // Find ultron's IKA coin
    const coinRes = await fetch(SUINS_GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!,$t:String!){
          address(address:$a){
            objects(filter:{type:$t},first:1){
              nodes{ address version digest contents { json } }
            }
          }
        }`,
        variables: { a: ultronAddress, t: `0x2::coin::Coin<${IKA_COIN_TYPE}>` },
      }),
    });
    const coinJson = await coinRes.json() as any;
    const ikaCoinObj = coinJson?.data?.address?.objects?.nodes?.[0];
    if (!ikaCoinObj) return c.json({ error: 'Ultron has no IKA' }, 503);

    // Build tx: split IKA and transfer to user
    const tx = new Transaction();
    tx.setSender(ultronAddress);
    const ikaSplit = tx.splitCoins(tx.object(ikaCoinObj.address), [tx.pure.u64(IKA_FUND_AMOUNT.toString())]);
    tx.transferObjects([ikaSplit], tx.pure.address(address));

    // Sign and submit via RPC
    const txBytes = await tx.build({ client: { url: SUI_RPC_URLS[0] } as any });

    // Use JSON-RPC for submission since we're server-side
    const { signature } = await keypair.signTransaction(txBytes);
    const b64 = btoa(String.fromCharCode(...txBytes));

    const submitRes = await fetch(SUI_RPC_URLS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_executeTransactionBlock',
        params: [b64, [signature], { showEffects: true }, 'WaitForLocalExecution'],
      }),
    });
    const submitJson = await submitRes.json() as any;
    const digest = submitJson?.result?.digest;

    if (!digest) return c.json({ error: 'Fund tx failed', detail: submitJson?.error }, 500);
    return c.json({ success: true, digest });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── IKA dWallet creation (ultron-submitted, for WaaP) ────────────────

/**
 * POST /api/ika/create
 * Body: { address, authSignature, authBytes, dkgData }
 *
 * WaaP path: user can't sign transactions, so ultron submits the DKG tx.
 * The user proves intent via signPersonalMessage (authSignature).
 * Browser runs WASM prepareDKGAsync and sends the results as dkgData.
 * Ultron builds + signs + submits the tx, transfers DWalletCap to user.
 *
 * Uses requestDWalletDKGWithPublicUserShare (shared dWallet).
 */
app.post('/api/ika/create', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address, authSignature, dkgData } = await c.req.json<{
      address: string;
      authSignature: string;
      dkgData: {
        userDKGMessage: number[];
        userSecretKeyShare: number[];
        userPublicOutput: number[];
        sessionIdentifier: number[];
        encryptionKeyBytes: number[];
        signingPublicKeyBytes: number[];
        encryptionKeySignature: number[];
        curve: number;
      };
    }>();
    if (!address || !authSignature || !dkgData) return c.json({ error: 'Missing params' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    // TODO: verify authSignature matches address (cryptographic proof of intent)

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const ultronAddress = keypair.toSuiAddress();

    // Fetch ultron's coins
    const GQL = 'https://graphql.mainnet.sui.io/graphql';
    const IKA_COIN_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';

    const coinQuery = (coinType: string, limit: number) => fetch(GQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!,$t:String!){ address(address:$a){ objects(filter:{type:$t},first:${limit}){ nodes{ address version digest } } } }`,
        variables: { a: ultronAddress, t: `0x2::coin::Coin<${coinType}>` },
      }),
    }).then(r => r.json()) as Promise<any>;

    const [suiRes, ikaRes] = await Promise.all([
      coinQuery('0x2::sui::SUI', 5),
      coinQuery(IKA_COIN_TYPE, 3),
    ]);
    const mapCoins = (res: any) => (res?.data?.address?.objects?.nodes ?? []).map((n: any) => ({
      objectId: n.address, version: String(n.version), digest: n.digest,
    }));
    const suiCoins = mapCoins(suiRes);
    const ikaCoins = mapCoins(ikaRes);

    if (!suiCoins.length) return c.json({ error: 'Ultron has no SUI' }, 503);
    if (!ikaCoins.length) return c.json({ error: 'Ultron has no IKA' }, 503);

    // Build the DKG transaction — ultron is sender
    const tx = new Transaction();
    tx.setSender(ultronAddress);
    tx.setGasPayment(suiCoins.slice(0, 3));

    const ikaCoin = tx.object(ikaCoins[0].objectId);
    const suiCoin = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000)]);

    // IKA package constants
    const IKA_CONFIG = {
      packages: {
        ikaDwallet2pcMpcPackage: '0x23b5bd96051923f800c3a2150aacdcdd8d39e1df2dce4dac69a00d2d8c7f7e77',
      },
    };
    const COORDINATOR_ID = '0x5ea59bce034008a006425df777da925633ef384ce25761657ea89e2a08ec75f3';

    const { bcs } = await import('@mysten/sui/bcs');
    const coordRef = tx.sharedObjectRef({ objectId: COORDINATOR_ID, initialSharedVersion: 595876492, mutable: true });

    // Register encryption key
    tx.moveCall({
      target: `${IKA_CONFIG.packages.ikaDwallet2pcMpcPackage}::coordinator::register_encryption_key`,
      arguments: [
        coordRef,
        tx.pure.u32(dkgData.curve),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.encryptionKeyBytes))),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.encryptionKeySignature))),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.signingPublicKeyBytes))),
      ],
    });

    // Register session identifier
    const [sessionId] = tx.moveCall({
      target: `${IKA_CONFIG.packages.ikaDwallet2pcMpcPackage}::coordinator::register_session_identifier`,
      arguments: [
        coordRef,
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.sessionIdentifier))),
      ],
    });

    // Fetch latest encryption key ID from coordinator
    const encKeyRes = await fetch(SUI_RPC_URLS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'suix_getDynamicFields',
        params: [COORDINATOR_ID, null, 1],
      }),
    });
    const encKeyJson = await encKeyRes.json() as any;
    const encKeyObjId = encKeyJson?.result?.data?.[0]?.objectId;
    if (!encKeyObjId) return c.json({ error: 'Could not find encryption key on coordinator' }, 500);

    // Build Option::none for signDuringDKGRequest
    const [noneOpt] = tx.moveCall({
      target: '0x1::option::none',
      typeArguments: [`${IKA_CONFIG.packages.ikaDwallet2pcMpcPackage}::coordinator_inner::SignDuringDKGRequest`],
    });

    // Request shared dWallet DKG (public user secret key share)
    const [dWalletCap] = tx.moveCall({
      target: `${IKA_CONFIG.packages.ikaDwallet2pcMpcPackage}::coordinator::request_dwallet_dkg_with_public_user_secret_key_share`,
      arguments: [
        coordRef,
        tx.pure.id(encKeyObjId),
        tx.pure.u32(dkgData.curve),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.userDKGMessage))),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.userSecretKeyShare))),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.userPublicOutput))),
        sessionId,
        noneOpt,
        ikaCoin,
        suiCoin,
      ],
    });

    // Transfer DWalletCap to the user + return leftover coins to ultron
    tx.transferObjects([dWalletCap], tx.pure.address(address));
    tx.transferObjects([suiCoin], tx.pure.address(ultronAddress));

    // Build with a real JSON-RPC client (Workers can't use gRPC)
    const { SuiJsonRpcClient: BuildClient } = await import('@mysten/sui/jsonRpc');
    const buildClient = new BuildClient({ url: SUI_RPC_URLS[0], network: 'mainnet' });
    const txBytes = await tx.build({ client: buildClient as any });
    const { signature } = await keypair.signTransaction(txBytes);
    const b64 = btoa(String.fromCharCode(...txBytes));

    const submitRes = await fetch(SUI_RPC_URLS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_executeTransactionBlock',
        params: [b64, [signature], { showEffects: true }, 'WaitForLocalExecution'],
      }),
    });
    const submitJson = await submitRes.json() as any;
    const digest = submitJson?.result?.digest;

    if (!digest) return c.json({ error: 'DKG tx failed', detail: submitJson?.error }, 500);
    return c.json({ success: true, digest });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── IKA dWallet provisioning ─────────────────────────────────────────

/**
 * POST /api/ika/provision
 * Body: { address: string }
 * Returns: { success, ultronAddress, suiCoins, ikaCoins }
 *
 * SuiNS-gated. Returns ultron wallet info so the client can build
 * a DKG transaction with ultron as gas sponsor. The DKG WASM
 * runs in the browser. Once built, the client sends the tx bytes
 * to /api/sponsor-gas for ultron's gas signature (which also
 * has the SuiNS gate), then co-signs and submits.
 */
app.post('/api/ika/provision', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address) return c.json({ error: 'Missing address' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const ultronAddress = keypair.toSuiAddress();

    // Fetch ultron's gas coins + IKA coins via GraphQL
    const GQL = 'https://graphql.mainnet.sui.io/graphql';
    const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';

    const coinQuery = (coinType: string, limit: number) => fetch(GQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!,$t:String!){
          address(address:$a){
            objects(filter:{type:$t},first:${limit}){
              nodes{ address version digest }
            }
          }
        }`,
        variables: { a: ultronAddress, t: `0x2::coin::Coin<${coinType}>` },
      }),
    }).then(r => r.json()) as Promise<any>;

    const [suiRes, ikaRes] = await Promise.all([
      coinQuery('0x2::sui::SUI', 5),
      coinQuery(IKA_TYPE, 3),
    ]);

    const mapCoins = (res: any) => (res?.data?.address?.objects?.nodes ?? []).map((n: any) => ({
      objectId: n.address, version: String(n.version), digest: n.digest,
    }));
    const suiCoins = mapCoins(suiRes);
    const ikaCoins = mapCoins(ikaRes);

    return c.json({
      success: true,
      ultronAddress,
      suiCoins,
      ikaCoins,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Tradeport listing proxy ──────────────────────────────────────────

const TRADEPORT_GQL = 'https://graphql.tradeport.gg';
const SUINS_COLLECTION_ID = '060fe4fb-9a3e-4170-a494-a25e62aba689';

app.get('/api/tradeport/listing/:label', async (c) => {
  const label = c.req.param('label').toLowerCase().replace(/\.sui$/, '');
  if (label.length < 3) return c.json({ listing: null });
  const name = `${label}.sui`;
  try {
    const res = await fetch(TRADEPORT_GQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-user': c.env.TRADEPORT_API_USER,
        'x-api-key': c.env.TRADEPORT_API_KEY,
      },
      body: JSON.stringify({
        query: `{ sui { nfts(where: { collection_id: { _eq: "${SUINS_COLLECTION_ID}" }, name: { _eq: "${name}" }, listed: { _eq: true } }, limit: 1) { token_id listings(where: { listed: { _eq: true } }) { id price seller market_name } } } }`,
      }),
    });
    type TpResult = { data?: { sui?: { nfts?: { token_id: string; listings: { id: string; price: number; seller: string; market_name: string }[] }[] } } };
    const json = await res.json() as TpResult;
    const nft = json?.data?.sui?.nfts?.[0];
    const listing = nft?.listings?.[0];
    if (!nft || !listing) return c.json({ listing: null });
    return c.json({
      listing: {
        listingId: listing.id,
        priceMist: String(listing.price),
        seller: listing.seller,
        nftTokenId: nft.token_id,
        marketName: listing.market_name,
      },
    });
  } catch {
    return c.json({ listing: null });
  }
});

// ── SuiAMI identity proof verification ────────────────────────────
app.post('/api/suiami/verify', async (c) => {
  try {
    const { token } = await c.req.json<{ token: string }>();
    if (!token?.startsWith('suiami:')) return c.json({ valid: false, error: 'Invalid token format' }, 400);

    const body = token.slice(7);
    const dotIdx = body.lastIndexOf('.');
    if (dotIdx < 0) return c.json({ valid: false, error: 'Malformed token' }, 400);

    const msgB64 = body.slice(0, dotIdx);
    const signature = body.slice(dotIdx + 1);
    const message = JSON.parse(atob(msgB64));

    if (!message.suiami || !(message.sui || message.address) || !message.nftId) {
      return c.json({ valid: false, error: 'Missing required fields' }, 400);
    }

    // Check timestamp freshness (within 5 minutes)
    const age = Date.now() - (message.timestamp ?? 0);
    if (age > 5 * 60 * 1000 || age < -30_000) {
      return c.json({ valid: false, error: 'Token expired or future-dated' }, 400);
    }

    // On-chain verification: confirm the signer owns the NFT and it resolves to the claimed name
    let ownershipVerified = false;
    let nameVerified = false;
    let onChainError: string | undefined;

    try {
      // 1. Check NFT owner matches claimed address
      const objData = await raceJsonRpc<{
        data?: {
          owner?: { AddressOwner?: string; ObjectOwner?: string };
          content?: { fields?: { name?: string } };
          type?: string;
        };
      }>('sui_getObject', [message.nftId, { showOwner: true, showContent: true, showType: true }]);
      const owner = objData?.data?.owner;
      const ownerAddr = owner?.AddressOwner ?? '';
      // Normalize both addresses for comparison (strip 0x, lowercase, pad to 64)
      const norm = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      ownershipVerified = norm(ownerAddr) === norm(message.sui || message.address);

      // 2. Check the NFT's domain_name field matches the claimed name
      const fields = objData?.data?.content?.fields as Record<string, unknown> | undefined;
      const nftName = ((fields?.domain_name ?? fields?.name ?? '') as string).replace(/\.sui$/, '');
      const claimedName = (message.suiami as string).replace(/^I am /, '');
      nameVerified = nftName === claimedName;

      // Also verify it's actually a SuinsRegistration type
      const objType = objData?.data?.type ?? (objData?.data?.content as Record<string, unknown>)?.type as string ?? '';
      if (!objType.includes('suins_registration::SuinsRegistration') && !objType.includes('SubDomainRegistration')) {
        onChainError = 'Object is not a SuiNS registration NFT';
        ownershipVerified = false;
      }
    } catch {
      onChainError = 'On-chain verification failed (RPC error)';
    }

    return c.json({
      valid: ownershipVerified && nameVerified,
      ownershipVerified,
      nameVerified,
      onChainError,
      suiami: message.suiami,
      ski: message.ski,
      address: message.sui || message.address,
      nftId: message.nftId,
      timestamp: message.timestamp,
      signature,
    });
  } catch (err) {
    return c.json({ valid: false, error: 'Parse error' }, 400);
  }
});

// ── Thunder strike relay (ultron submits, user authorizes via signPersonalMessage) ──
app.post('/api/thunder/strike-relay', async (c) => {
  try {
    const body = await c.req.json() as {
      nameHash: string; nftId: string; authMsg: string; authSig: string; senderAddress: string; count: number;
    };
    if (!body.nameHash || !body.nftId || !body.authMsg || !body.authSig || !body.senderAddress) {
      return c.json({ error: 'Missing params' }, 400);
    }
    const id = c.env.TreasuryAgents.idFromName('treasury');
    const stub = c.env.TreasuryAgents.get(id);
    const res = await stub.fetch(new Request('https://treasury-do/?strike-relay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text || 'Unknown DO error' }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── iUSD attest collateral (ultron signs, oracle-gated) ───────────
app.post('/api/iusd/attest', async (c) => {
  try {
    const body = await c.req.json() as { collateralValueMist: string };
    if (!body.collateralValueMist) return c.json({ error: 'Missing collateralValueMist' }, 400);
    const id = c.env.TreasuryAgents.idFromName('treasury');
    const stub = c.env.TreasuryAgents.get(id);
    const res = await stub.fetch(new Request('https://treasury-do/?attest-collateral', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text || 'Unknown DO error' }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── iUSD mint (routed to TreasuryAgents DO) ───────────────────────
app.post('/api/iusd/mint', async (c) => {
  try {
    const body = await c.req.json() as { recipient: string; collateralValueMist: string; mintAmount: string };
    if (!body.recipient || !body.collateralValueMist || !body.mintAmount) {
      return c.json({ error: 'Missing params' }, 400);
    }
    const id = c.env.TreasuryAgents.idFromName('treasury');
    const stub = c.env.TreasuryAgents.get(id);
    const res = await stub.fetch(new Request('https://treasury-do/?mint-iusd', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try {
      const result = JSON.parse(text);
      return c.json(result, res.status as any);
    } catch {
      return c.json({ error: text || 'Unknown DO error' }, 500);
    }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Thunder admin (set fee via TreasuryAgents ultron) ──────────────
app.post('/api/thunder/set-fee', async (c) => {
  try {
    const body = await c.req.json() as { feeMist: number };
    const id = c.env.TreasuryAgents.idFromName('treasury');
    const stub = c.env.TreasuryAgents.get(id);
    const res = await stub.fetch(new Request('https://treasury-do/?set-thunder-fee', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Swap SUI→DEEP (acquire DEEP for pool creation) ──────────────
app.post('/api/treasury/swap-sui-for-deep', async (c) => {
  try {
    const body = await c.req.json() as { amountMist?: string };
    const id = c.env.TreasuryAgents.idFromName('treasury');
    const stub = c.env.TreasuryAgents.get(id);
    const res = await stub.fetch(new Request('https://treasury-do/?swap-sui-for-deep', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Rumble — server-side IKA dWallet check/provision for ultron.sui ──
app.post('/api/treasury/rumble', async (c) => {
  try {
    const id = c.env.TreasuryAgents.idFromName('treasury');
    const stub = c.env.TreasuryAgents.get(id);
    const res = await stub.fetch(new Request('https://treasury-do/?rumble-ultron', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({}),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Create iUSD/USDC DeepBook pool ──────────────────────────────
app.post('/api/treasury/create-iusd-pool', async (c) => {
  try {
    const id = c.env.TreasuryAgents.idFromName('treasury');
    const stub = c.env.TreasuryAgents.get(id);
    const res = await stub.fetch(new Request('https://treasury-do/?create-iusd-pool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({}),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Acquire NS for user (iUSD route via TreasuryAgents) ───────────
app.post('/api/treasury/acquire-ns', async (c) => {
  try {
    const body = await c.req.json() as any;
    const id = c.env.TreasuryAgents.idFromName('treasury');
    const stub = c.env.TreasuryAgents.get(id);
    const res = await stub.fetch(new Request('https://treasury-do/?acquire-ns', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default app;

// Export Durable Object classes for Wrangler binding
export { SessionAgent } from './agents/session.js';
export { SponsorAgent } from './agents/sponsor.js';
export { SplashDeviceAgent } from './agents/splash.js';
export { ShadeExecutorAgent } from './agents/shade-executor.js';
export { TreasuryAgents } from './agents/treasury-agents.js';
