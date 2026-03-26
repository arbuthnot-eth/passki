import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';
import { raceJsonRpc } from './rpc.js';
// ika-provision.ts is available for server-side DKG if needed in future,
// but DKG WASM must run client-side (browser) — Workers can't run it.

interface Env {
  ShadeExecutorAgent: DurableObjectNamespace;
  TRADEPORT_API_KEY: string;
  TRADEPORT_API_USER: string;
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Agents middleware handles WebSocket upgrades and RPC to /agents/*
app.use('/agents/*', agentsMiddleware());

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

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
      if (res.ok) {
        const json = await res.text();
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

// ── Gas sponsorship via Shade keeper ─────────────────────────────────

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/**
 * POST /api/sponsor-gas
 * Body: { txBytes: string, senderAddress?: string } (base64-encoded transaction bytes)
 * Returns: { sponsorSig: string, sponsorAddress: string }
 *
 * Signs the transaction as gas sponsor using the Shade keeper keypair.
 * The client must have built the tx with setGasOwner(sponsorAddress)
 * and setGasPayment pointing to the keeper's SUI coins.
 *
 * When senderAddress is provided, requires the sender to own a SuiNS
 * registration NFT (403 if not).
 */
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
 * Returns the keeper's address and gas coins so clients can build sponsored txs.
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

// ── IKA dWallet provisioning ─────────────────────────────────────────

/**
 * POST /api/ika/provision
 * Body: { address: string }
 * Returns: { success, keeperAddress, suiCoins, ikaCoins }
 *
 * SuiNS-gated. Returns keeper wallet info so the client can build
 * a DKG transaction with the keeper as gas sponsor. The DKG WASM
 * runs in the browser. Once built, the client sends the tx bytes
 * to /api/sponsor-gas for the keeper's gas signature (which also
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
    const keeperAddress = keypair.toSuiAddress();

    // Fetch keeper's gas coins + IKA coins via GraphQL
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
        variables: { a: keeperAddress, t: `0x2::coin::Coin<${coinType}>` },
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
      keeperAddress,
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

    if (!message.suiami || !message.address || !message.nftId) {
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
      ownershipVerified = norm(ownerAddr) === norm(message.address);

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
      address: message.address,
      nftId: message.nftId,
      timestamp: message.timestamp,
      signature,
    });
  } catch (err) {
    return c.json({ valid: false, error: 'Parse error' }, 400);
  }
});

export default app;

// Export Durable Object classes for Wrangler binding
export { SessionAgent } from './agents/session.js';
export { SponsorAgent } from './agents/sponsor.js';
export { SplashDeviceAgent } from './agents/splash.js';
export { ShadeExecutorAgent } from './agents/shade-executor.js';
