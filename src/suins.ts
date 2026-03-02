/**
 * SuiNS helpers — domain/cap ownership lookup and subname minting.
 *
 * Contract reference: arbuthnot-eth/suins-contracts feature/subname-cap branch
 *
 * Supports:
 *   - new_leaf / new         — parent holds SuinsRegistration NFT
 *   - new_leaf_with_cap / new_with_cap — parent holds SubnameCap
 */

import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { SuinsClient, SuinsTransaction, mainPackage } from '@mysten/suins';
import {
  DeepBookContract,
  DeepBookConfig,
  mainnetCoins as dbCoins,
  mainnetPools as dbPools,
  mainnetPackageIds as dbPkgIds,
} from '@mysten/deepbook-v3';

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';

const GRPC_URL   = 'https://fullnode.mainnet.sui.io:443';
const GQL_URL    = 'https://graphql.mainnet.sui.io/graphql';

// ─── Contract constants ────────────────────────────────────────────────

/** Original mainnet subdomains package (new_leaf / new). */
const SUBDOMAINS_PACKAGE =
  '0xe177697e191327901637f8d2c5ffbbde8b1aaac27ec1024c4b62d1ebd1cd7430';

/** subname-cap branch package (new_leaf_with_cap / new_with_cap / create_subname_cap). */
const SUBDOMAINS_CAP_PACKAGE =
  '0xd96a273f5f7ac23c7f4c2ce3d52138aae0e9a8f783cfb9f4c62fb4bfa2f9341c';

const SUINS_OBJECT_ID =
  '0x6e0ddefc0ad98889c04bab9639e512c21766c5e6366f89e696956d9be6952871';

const SUI_CLOCK_ID = '0x6';

/** One year in ms — default node subdomain duration. */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const SUINS_REG_TYPE =
  '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration';

const SUBNAME_CAP_TYPE =
  `${SUBDOMAINS_CAP_PACKAGE}::subdomains::SubnameCap`;

// ─── Types ────────────────────────────────────────────────────────────

export interface OwnedDomain {
  /** Full domain name, e.g. "atlas.sui" or "sub.atlas.sui" */
  name: string;
  /** Object ID of the SuinsRegistration NFT or SubnameCap */
  objectId: string;
  /** Whether this object is a parent NFT or a SubnameCap */
  kind: 'nft' | 'cap';
  /** Cap: allow_leaf_creation; NFT: always true */
  allowLeaf: boolean;
  /** Cap: allow_node_creation; NFT: always true */
  allowNode: boolean;
}

// ─── fetchOwnedDomains ────────────────────────────────────────────────

export async function fetchOwnedDomains(address: string): Promise<OwnedDomain[]> {
  const [nfts, caps] = await Promise.all([
    fetchNftDomains(address),
    fetchSubnameCaps(address),
  ]);
  return [...nfts, ...caps];
}

/** Fetch SuinsRegistration NFTs (top-level domains + node subdomains owned). */
async function fetchNftDomains(address: string): Promise<OwnedDomain[]> {
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `
          query($owner: SuiAddress!) {
            address(address: $owner) {
              objects(filter: { type: "${SUINS_REG_TYPE}" }) {
                nodes {
                  address
                  asMoveObject { contents { json } }
                }
              }
            }
          }
        `,
        variables: { owner: address },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { objects?: { nodes?: Array<{
        address: string;
        asMoveObject?: { contents?: { json?: Record<string, unknown> } };
      }> } } };
    };
    const nodes = json?.data?.address?.objects?.nodes ?? [];
    const now = Date.now();
    const domains: OwnedDomain[] = [];
    for (const node of nodes) {
      const data = node.asMoveObject?.contents?.json;
      if (!data) continue;
      const expiry = Number(data['expiration_timestamp_ms'] ?? 0);
      if (expiry > 0 && expiry < now) continue;
      const domainName = data['domain_name'] as string | undefined;
      if (!domainName) continue;
      domains.push({
        name: domainName.endsWith('.sui') ? domainName : `${domainName}.sui`,
        objectId: node.address,
        kind: 'nft',
        allowLeaf: true,
        allowNode: true,
      });
    }
    return domains;
  } catch { return []; }
}

/** Fetch SubnameCap objects owned by the address. */
async function fetchSubnameCaps(address: string): Promise<OwnedDomain[]> {
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `
          query($owner: SuiAddress!) {
            address(address: $owner) {
              objects(filter: { type: "${SUBNAME_CAP_TYPE}" }) {
                nodes {
                  address
                  asMoveObject { contents { json } }
                }
              }
            }
          }
        `,
        variables: { owner: address },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { objects?: { nodes?: Array<{
        address: string;
        asMoveObject?: { contents?: { json?: Record<string, unknown> } };
      }> } } };
    };
    const nodes = json?.data?.address?.objects?.nodes ?? [];
    const caps: OwnedDomain[] = [];
    for (const node of nodes) {
      const data = node.asMoveObject?.contents?.json;
      if (!data) continue;
      const allowLeaf = !!data['allow_leaf_creation'];
      const allowNode = !!data['allow_node_creation'];
      const name = extractDomainName(data['parent_domain']);
      if (!name) continue;
      caps.push({
        name,
        objectId: node.address,
        kind: 'cap',
        allowLeaf,
        allowNode,
      });
    }
    return caps;
  } catch { return []; }
}

/**
 * Extract a display name from a Move Domain value as serialized by GraphQL.
 * Domain.labels is a vector<String> stored as ["atlas", "sui"] → "atlas.sui".
 */
function extractDomainName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  // GraphQL may serialize labels as an array
  const labels = obj['labels'];
  if (Array.isArray(labels) && labels.length > 0) {
    const joined = (labels as string[]).join('.');
    return joined.endsWith('.sui') ? joined : `${joined}.sui`;
  }
  return null;
}

// ─── PTB builders ─────────────────────────────────────────────────────

/**
 * Build a PTB to mint a subname under a parent NFT or SubnameCap.
 *
 * @param parent         OwnedDomain with kind, objectId, and permissions
 * @param subdomainLabel The new label (e.g. "brando" → "brando.atlas.sui")
 * @param targetAddress  Sui address the leaf subname resolves to (leaf only)
 * @param type           "leaf" (no expiry, points to address) or "node" (owned NFT, can parent more)
 * @param nodeExpiryMs   Expiration for node subnames (default: 1 year from now)
 */
export function buildSubnameTx(
  parent: OwnedDomain,
  subdomainLabel: string,
  targetAddress: string,
  type: 'leaf' | 'node' = 'leaf',
  nodeExpiryMs?: number,
): Transaction {
  const tx = new Transaction();
  const parentName = parent.name.endsWith('.sui') ? parent.name : `${parent.name}.sui`;
  const fullName = `${subdomainLabel}.${parentName}`;
  const expiry = BigInt(nodeExpiryMs ?? Date.now() + ONE_YEAR_MS);

  if (parent.kind === 'cap') {
    if (type === 'leaf') {
      tx.moveCall({
        target: `${SUBDOMAINS_CAP_PACKAGE}::subdomains::new_leaf_with_cap`,
        arguments: [
          tx.object(SUINS_OBJECT_ID),
          tx.object(parent.objectId),
          tx.object(SUI_CLOCK_ID),
          tx.pure.string(fullName),
          tx.pure.address(targetAddress),
        ],
      });
    } else {
      const nft = tx.moveCall({
        target: `${SUBDOMAINS_CAP_PACKAGE}::subdomains::new_with_cap`,
        arguments: [
          tx.object(SUINS_OBJECT_ID),
          tx.object(parent.objectId),
          tx.object(SUI_CLOCK_ID),
          tx.pure.string(fullName),
          tx.pure.u64(expiry),
          tx.pure.bool(true),   // allow_creation
          tx.pure.bool(false),  // allow_time_extension
        ],
      });
      tx.transferObjects([nft], tx.pure.address(targetAddress));
    }
  } else {
    if (type === 'leaf') {
      tx.moveCall({
        target: `${SUBDOMAINS_PACKAGE}::subdomains::new_leaf`,
        arguments: [
          tx.object(SUINS_OBJECT_ID),
          tx.object(parent.objectId),
          tx.object(SUI_CLOCK_ID),
          tx.pure.string(fullName),
          tx.pure.address(targetAddress),
        ],
      });
    } else {
      const nft = tx.moveCall({
        target: `${SUBDOMAINS_PACKAGE}::subdomains::new`,
        arguments: [
          tx.object(SUINS_OBJECT_ID),
          tx.object(parent.objectId),
          tx.object(SUI_CLOCK_ID),
          tx.pure.string(fullName),
          tx.pure.u64(expiry),
          tx.pure.bool(true),   // allow_creation
          tx.pure.bool(false),  // allow_time_extension
        ],
      });
      tx.transferObjects([nft], tx.pure.address(targetAddress));
    }
  }

  return tx;
}

/** @deprecated Use buildSubnameTx instead. */
export function buildCreateLeafSubnameTx(
  parentNftId: string,
  subdomainLabel: string,
  targetAddress: string,
): Transaction {
  return buildSubnameTx(
    { name: '', objectId: parentNftId, kind: 'nft', allowLeaf: true, allowNode: true },
    subdomainLabel,
    targetAddress,
    'leaf',
  );
}

// ─── Register splash.sui via NS payment ──────────────────────────────
//
// Builds a PTB that:
//   1. Looks up NS coins owned by the wallet (gRPC → GraphQL fallback)
//   2. Adds Pyth price-oracle update for the NS/USD feed
//   3. Registers "splash.sui" for 1 year, paying with NS
//   4. Points the name at the wallet address
//   5. Sets splash.sui as the default reverse-lookup name
//   6. Transfers the SuinsRegistration NFT to the wallet
//
// Transport: tries SuiGrpcClient first; if that throws, retries the
// coin lookup on SuiGraphQLClient and uses that client for the rest
// of the PTB build so the two transports are never mixed mid-flow.

type AnyTransportClient = SuiGrpcClient | SuiGraphQLClient;

/** Fetch SUI/USD price by racing four exchanges — returns null only if all fail. */
async function fetchSuiUsdPrice(): Promise<number | null> {
  const valid = (v: unknown): number => {
    const n = typeof v === 'string' ? parseFloat(v) : Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error('invalid');
    return n;
  };
  try {
    return await Promise.any([
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT')
        .then(r => r.ok ? r.json() : Promise.reject())
        .then((d: { price: string }) => valid(d.price)),
      fetch('https://api.coinbase.com/v2/prices/SUI-USD/spot')
        .then(r => r.ok ? r.json() : Promise.reject())
        .then((d: { data?: { amount?: string } }) => valid(d.data?.amount)),
      fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=SUIUSDT')
        .then(r => r.ok ? r.json() : Promise.reject())
        .then((d: { result?: { list?: Array<{ lastPrice: string }> } }) => valid(d.result?.list?.[0]?.lastPrice)),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd')
        .then(r => r.ok ? r.json() : Promise.reject())
        .then((d: { sui?: { usd?: number } }) => valid(d.sui?.usd)),
    ]);
  } catch {
    return null;
  }
}

async function listCoinsOfType(
  client: AnyTransportClient,
  owner: string,
  coinType: string,
): Promise<{ objectId: string }[]> {
  const all: { objectId: string }[] = [];
  let cursor: string | null | undefined;
  do {
    const result = await client.listCoins({ owner, coinType, ...(cursor ? { cursor } : {}) });
    all.push(...result.objects);
    if (!result.hasNextPage) break;
    cursor = result.cursor;
  } while (cursor);
  return all;
}

function listNsCoins(client: AnyTransportClient, owner: string) {
  return listCoinsOfType(client, owner, mainPackage.mainnet.coins.NS.type);
}

// Create a zero-balance coin of any type without requiring user balance.
function zeroCoin(tx: Transaction, type: string) {
  return tx.moveCall({ target: '0x2::coin::zero', typeArguments: [type] });
}

function makeDeepBook(address: string): DeepBookContract {
  return new DeepBookContract(
    new DeepBookConfig({ network: 'mainnet', address, coins: dbCoins, pools: dbPools, packageIds: dbPkgIds }),
  );
}

/**
 * Check whether a .sui label is available, taken, or owned by the given wallet.
 * Returns 'available' | 'taken' | 'owned'.
 * Falls back to 'available' on network error so the UI stays usable.
 */
export type DomainStatusResult = {
  avail: 'available' | 'taken' | 'owned';
  targetAddress: string | null;
};

export async function checkDomainStatus(
  label: string,
  walletAddress?: string,
): Promise<DomainStatusResult> {
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  try {
    const record = await suinsClient.getNameRecord(`${label}.sui`);
    if (!record) return { avail: 'available', targetAddress: null };
    if (record.expirationTimestampMs && record.expirationTimestampMs < Date.now()) return { avail: 'available', targetAddress: null };
    const targetAddress = record.targetAddress ?? null;
    // Check ownership via the nftId on the record — one targeted query, no pagination issues
    if (walletAddress && record.nftId) {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: SuiAddress!) { object(address: $id) { owner { ... on AddressOwner { owner { address } } } } }`,
          variables: { id: record.nftId },
        }),
      });
      const json = await res.json() as {
        data?: { object?: { owner?: { owner?: { address?: string } } } };
      };
      const ownerAddr = json?.data?.object?.owner?.owner?.address;
      if (ownerAddr && ownerAddr.toLowerCase() === normalizeSuiAddress(walletAddress).toLowerCase()) {
        return { avail: 'owned', targetAddress };
      }
    }
    return { avail: 'taken', targetAddress };
  } catch {
    return { avail: 'available', targetAddress: null };
  }
}

/** Build a PTB that sets `domain` as the wallet's default reverse-lookup name. */
export async function buildSetDefaultNsTx(rawAddress: string, domain: string): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  const tx = new Transaction();
  tx.setSender(walletAddress);
  const suinsTx = new SuinsTransaction(suinsClient, tx);
  suinsTx.setDefault(domain);
  return tx.build({ client: transport as never });
}

/** Returns the NS-discounted registration price in USD for a `.sui` label (1 year). */
export async function fetchDomainPriceUsd(label: string): Promise<number> {
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  const [rawPrice, discountMap] = await Promise.all([
    suinsClient.calculatePrice({ name: `${label}.sui`, years: 1 }),
    suinsClient.getCoinTypeDiscount(),
  ]);
  // TypeName stores addresses without 0x prefix
  const nsKey = mainPackage.mainnet.coins.NS.type.replace(/^0x/, '');
  const discountPct = discountMap.get(nsKey) ?? 0;
  return (rawPrice * (1 - discountPct / 100)) / 1e6;
}

function isInsufficientBalance(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('insufficient balance') ||
    lower.includes('insufficientcoinbalance') ||
    lower.includes('insufficient coin balance') ||
    lower.includes('insufficient_coin_balance')
  );
}

export async function buildRegisterSplashNsTx(rawAddress: string, domain = 'splash.sui', suiPrice?: number, setAsDefault = false): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: GRPC_URL });
  let transport: AnyTransportClient = grpc;

  // ── 1. Fetch coins in parallel ────────────────────────────────────
  // NS coins are always contributed silently regardless of swap method.
  // USDC presence decides whether to try USDC path before falling back to SUI.
  let nsCoins: { objectId: string }[] = [];
  let usdcCoins: { objectId: string }[] = [];
  try {
    [nsCoins, usdcCoins] = await Promise.all([
      listNsCoins(grpc, walletAddress),
      listCoinsOfType(grpc, walletAddress, mainPackage.mainnet.coins.USDC.type),
    ]);
  } catch {
    transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    [nsCoins, usdcCoins] = await Promise.all([
      listNsCoins(transport, walletAddress),
      listCoinsOfType(transport, walletAddress, mainPackage.mainnet.coins.USDC.type),
    ]);
  }

  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });

  // ── 2. Pre-fetch price data shared across both swap paths ─────────
  const [rawPrice, discountMap, extraRecord, fetchedSuiPrice] = await Promise.all([
    suinsClient.calculatePrice({ name: domain, years: 1 }),
    suinsClient.getCoinTypeDiscount(),
    suinsClient.getNameRecord('extra.sui'),
    (suiPrice && suiPrice > 0) ? Promise.resolve(suiPrice) : fetchSuiUsdPrice(),
  ]);
  const resolvedSuiPrice = fetchedSuiPrice;
  if (!resolvedSuiPrice) throw new Error('Unable to fetch SUI/USD price from any source');
  const nsKey = mainPackage.mainnet.coins.NS.type.replace(/^0x/, '');
  const discountPct = discountMap.get(nsKey) ?? 0;
  const discountedUsd = (rawPrice * (1 - discountPct / 100)) / 1e6;
  const extraAddress = extraRecord?.targetAddress
    ? normalizeSuiAddress(extraRecord.targetAddress)
    : walletAddress;

  // ── 3. Swap PTB builder (USDC or SUI → NS) ───────────────────────
  //
  // Route: USDC first, SUI fallback.
  // Any existing NS coins are silently merged into the swap result so
  // they contribute to the payment without requiring an exact balance check.
  // Leftover NS after registration is swapped back to USDC and routed to extra.sui.
  const buildSwapTx = async (method: 'USDC' | 'SUI'): Promise<Uint8Array> => {
    const tx = new Transaction();
    tx.setSender(walletAddress);
    const suinsTx = new SuinsTransaction(suinsClient, tx);
    const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.NS.feed, tx.gas,
    );

    const poolKey = method === 'USDC' ? 'NS_USDC' : 'NS_SUI';
    // SUI amount needed = registration_price_usd / sui_usd_price  (NS price cancels out).
    // Add 5% buffer for DeepBook pool slippage and minor oracle price lag.
    // USDC path: flat 10¢ buffer (stablecoin, effectively no slippage).
    const suiUsd = resolvedSuiPrice;
    const swapAmount = method === 'SUI'
      ? Math.round((discountedUsd / suiUsd) * 1.05 * 1000) / 1000
      : discountedUsd + 0.10;

    const db = makeDeepBook(walletAddress);
    const zeroDEEP = zeroCoin(tx, dbCoins.DEEP.type);
    const [nsCoinResult, swapRemainder, deepRemainder] = db.swapExactQuoteForBase({
      poolKey,
      amount: swapAmount,
      deepAmount: 0,
      deepCoin: zeroDEEP,
      minOut: 0,
    })(tx);

    // Return swap remainders immediately — quote change and DEEP dust.
    tx.transferObjects([swapRemainder, deepRemainder], tx.pure.address(walletAddress));

    // Silently fold any existing NS coins into the swapped NS.
    // This reduces the net cost of future swaps without any extra logic.
    if (nsCoins.length > 0) {
      tx.mergeCoins(nsCoinResult, nsCoins.map((c) => tx.object(c.objectId)));
    }

    const nft = suinsTx.register({
      domain, years: 1,
      coinConfig: mainPackage.mainnet.coins.NS,
      coin: nsCoinResult,
      priceInfoObjectId,
    });
    suinsTx.setTargetAddress({ nft, address: walletAddress });
    if (setAsDefault) suinsTx.setDefault(domain);
    tx.transferObjects([nft], tx.pure.address(walletAddress));

    // Return any remaining NS directly to extra.sui — no reverse swap.
    // A reverse swap (NS→USDC) would require USDC in the wallet for DeepBook
    // pool accounting, causing spurious "insufficient USDC" failures.
    tx.transferObjects([nsCoinResult], tx.pure.address(extraAddress));

    return tx.build({ client: transport as never });
  };

  // ── 4. SUI first, USDC fallback ───────────────────────────────────
  try {
    return await buildSwapTx('SUI');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isInsufficientBalance(msg)) throw e;
    // SUI insufficient — fall back to USDC
  }

  return buildSwapTx('USDC');
}
