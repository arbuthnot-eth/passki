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
  /** Expiration timestamp in ms (undefined = no expiry, e.g. caps) */
  expirationMs?: number;
  /** True if the NFT is held inside a user-owned kiosk (marketplace listing) */
  inKiosk?: boolean;
}

// ─── fetchOwnedDomains ────────────────────────────────────────────────

export async function fetchOwnedDomains(address: string): Promise<OwnedDomain[]> {
  const [nfts, caps, kioskDomains] = await Promise.all([
    fetchNftDomains(address),
    fetchSubnameCaps(address),
    fetchKioskDomains(address),
  ]);
  // Deduplicate: if an objectId appears in both nfts and kiosk results, keep kiosk version
  const kioskIds = new Set(kioskDomains.map(d => d.objectId));
  const dedupedNfts = nfts.filter(d => !kioskIds.has(d.objectId));
  return [...dedupedNfts, ...caps, ...kioskDomains];
}

/** Fetch SuinsRegistration NFTs (top-level domains + node subdomains owned). */
async function fetchNftDomains(address: string): Promise<OwnedDomain[]> {
  try {
    const domains: OwnedDomain[] = [];
    const now = Date.now();
    let cursor: string | null = null;
    do {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `
            query($owner: SuiAddress!, $after: String) {
              address(address: $owner) {
                objects(filter: { type: "${SUINS_REG_TYPE}" }, first: 50, after: $after) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    address
                    contents { json }
                  }
                }
              }
            }
          `,
          variables: { owner: address, after: cursor },
        }),
      });
      const json = await res.json() as {
        data?: { address?: { objects?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            address: string;
            contents?: { json?: Record<string, unknown> };
          }>;
        } } };
      };
      const objects = json?.data?.address?.objects;
      const nodes = objects?.nodes ?? [];
      for (const node of nodes) {
        const data = node.contents?.json;
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
          expirationMs: expiry > 0 ? expiry : undefined,
        });
      }
      cursor = objects?.pageInfo?.hasNextPage ? (objects.pageInfo.endCursor ?? null) : null;
    } while (cursor);
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
                  contents { json }
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
        contents?: { json?: Record<string, unknown> };
      }> } } };
    };
    const nodes = json?.data?.address?.objects?.nodes ?? [];
    const caps: OwnedDomain[] = [];
    for (const node of nodes) {
      const data = node.contents?.json;
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

/** Fetch SuiNS NFTs held inside user-owned kiosks (marketplace listings). */
async function fetchKioskDomains(address: string): Promise<OwnedDomain[]> {
  try {
    // Step 1: find KioskOwnerCap objects → extract kiosk IDs
    const capRes = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `
          query($owner: SuiAddress!) {
            address(address: $owner) {
              objects(filter: { type: "0x2::kiosk::KioskOwnerCap" }) {
                nodes { contents { json } }
              }
            }
          }
        `,
        variables: { owner: address },
      }),
    });
    const capJson = await capRes.json() as {
      data?: { address?: { objects?: { nodes?: Array<{ contents?: { json?: Record<string, unknown> } }> } } };
    };
    const capNodes = capJson?.data?.address?.objects?.nodes ?? [];
    if (capNodes.length === 0) return [];

    const kioskIds: string[] = [];
    for (const n of capNodes) {
      const forId = n.contents?.json?.['for'] as string | undefined;
      if (forId) kioskIds.push(forId);
    }
    if (kioskIds.length === 0) return [];

    // Step 2: for each kiosk, query dynamic fields for SuinsRegistration items
    const domains: OwnedDomain[] = [];
    for (const kioskId of kioskIds) {
      const dfRes = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `
            query($id: SuiAddress!) {
              object(address: $id) {
                dynamicFields {
                  nodes {
                    value {
                      ... on MoveObject {
                        address
                        contents { type { repr } json }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: { id: kioskId },
        }),
      });
      const dfJson = await dfRes.json() as {
        data?: { object?: { dynamicFields?: { nodes?: Array<{
          value?: { address?: string; contents?: { type?: { repr?: string }; json?: Record<string, unknown> } };
        }> } } };
      };
      const dfNodes = dfJson?.data?.object?.dynamicFields?.nodes ?? [];
      const now = Date.now();
      for (const df of dfNodes) {
        const typeRepr = df.value?.contents?.type?.repr ?? '';
        if (!typeRepr.includes('suins_registration::SuinsRegistration')) continue;
        const data = df.value?.contents?.json;
        if (!data) continue;
        const expiry = Number(data['expiration_timestamp_ms'] ?? 0);
        if (expiry > 0 && expiry < now) continue;
        const domainName = data['domain_name'] as string | undefined;
        if (!domainName) continue;
        domains.push({
          name: domainName.endsWith('.sui') ? domainName : `${domainName}.sui`,
          objectId: df.value?.address ?? '',
          kind: 'nft',
          allowLeaf: false,
          allowNode: false,
          expirationMs: expiry > 0 ? expiry : undefined,
          inKiosk: true,
        });
      }
    }
    return domains;
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


type CoinRef = { objectId: string; version: string; digest: string; balance: bigint };

async function listCoinsOfType(
  client: AnyTransportClient,
  owner: string,
  coinType: string,
): Promise<CoinRef[]> {
  const all: CoinRef[] = [];
  let cursor: string | null | undefined;
  do {
    const result = await client.listCoins({ owner, coinType, ...(cursor ? { cursor } : {}) });
    all.push(...result.objects.map((c) => ({
      objectId: c.objectId, version: c.version, digest: c.digest,
      balance: BigInt((c as Record<string, unknown>).balance ?? '0'),
    })));
    if (!result.hasNextPage) break;
    cursor = result.cursor;
  } while (cursor);
  return all;
}


/**
 * Check whether a .sui label is available, taken, or owned by the given wallet.
 * Returns 'available' | 'taken' | 'owned'.
 * Falls back to 'available' on network error so the UI stays usable.
 */
export type DomainStatusResult = {
  avail: 'available' | 'taken' | 'owned' | 'grace';
  targetAddress: string | null;
  graceEndMs?: number;
  /** On-chain owner address of the NFT (may differ from wallet address for WaaP wallets). */
  nftOwner?: string;
};

export async function checkDomainStatus(
  label: string,
  walletAddress?: string,
  /** Extra addresses to treat as "owned" (e.g. discovered on-chain owner for WaaP wallets). */
  additionalOwnerAddresses?: string[],
): Promise<DomainStatusResult> {
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  try {
    const record = await suinsClient.getNameRecord(`${label}.sui`);
    if (!record) return { avail: 'available', targetAddress: null };
    const now = Date.now();
    if (record.expirationTimestampMs && record.expirationTimestampMs < now) {
      // Expired — check 30-day grace period (during which only the previous owner can renew)
      const GRACE_MS = 30 * 24 * 60 * 60 * 1000;
      const graceEnd = record.expirationTimestampMs + GRACE_MS;
      if (now < graceEnd) {
        return { avail: 'grace', targetAddress: record.targetAddress ?? null, graceEndMs: graceEnd };
      }
      return { avail: 'available', targetAddress: null };
    }
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
      if (ownerAddr) {
        const normalizedOwner = ownerAddr.toLowerCase();
        const candidates = [normalizeSuiAddress(walletAddress).toLowerCase()];
        if (additionalOwnerAddresses) {
          for (const a of additionalOwnerAddresses) candidates.push(normalizeSuiAddress(a).toLowerCase());
        }
        if (candidates.includes(normalizedOwner)) {
          return { avail: 'owned', targetAddress, nftOwner: ownerAddr };
        }
        return { avail: 'taken', targetAddress, nftOwner: ownerAddr };
      }
    }
    return { avail: 'taken', targetAddress };
  } catch {
    return { avail: 'available', targetAddress: null };
  }
}

/** Look up the on-chain owner address for a SuiNS domain's NFT. */
export async function lookupNftOwner(domain: string): Promise<string | null> {
  try {
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
    const fullDomain = domain.endsWith('.sui') ? domain : `${domain}.sui`;
    const record = await suinsClient.getNameRecord(fullDomain);
    if (!record?.nftId) return null;
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
    return json?.data?.object?.owner?.owner?.address ?? null;
  } catch {
    return null;
  }
}

/** Build a PTB that sets `domain` as the wallet's default reverse-lookup name. */
export async function buildSetDefaultNsTx(rawAddress: string, domain: string): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const fullDomain = domain.endsWith('.sui') ? domain : `${domain}.sui`;
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const tx = new Transaction();
  tx.setSender(walletAddress);
  tx.moveCall({
    target: '0x71af035413ed499710980ed8adb010bbf2cc5cacf4ab37c7710a4bb87eb58ba5::controller::set_reverse_lookup',
    arguments: [
      tx.object(SUINS_OBJECT_ID),
      tx.pure.string(fullDomain),
    ],
  });
  return tx.build({ client: transport as never });
}

/** Execute a pre-signed transaction via our own gRPC transport (bypasses WaaP execution bugs). */
export async function executeSignedTx(bytesB64: string, signature: string): Promise<string> {
  const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: GRPC_URL });
  const txBytes = Uint8Array.from(atob(bytesB64), c => c.charCodeAt(0));
  const result = await grpc.executeTransaction({ transaction: txBytes, signatures: [signature] });
  return (result as { digest?: string }).digest ?? '';
}

/** Build a PTB that changes the target address a domain resolves to. */
export async function buildSetTargetAddressTx(
  rawAddress: string,
  domain: string,
  newTargetAddress: string,
  /** Real on-chain owner address (for WaaP wallets where wallet addr ≠ object owner). */
  ownerAddress?: string,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const target = normalizeSuiAddress(newTargetAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  const fetchAddr = ownerAddress ? normalizeSuiAddress(ownerAddress) : walletAddress;
  const owned = await fetchOwnedDomains(fetchAddr);
  const domainFull = domain.endsWith('.sui') ? domain : `${domain}.sui`;
  const nftDomain = owned.find(d => d.name === domainFull && d.kind === 'nft');
  if (!nftDomain) throw new Error(`No NFT found for ${domainFull}`);
  const tx = new Transaction();
  tx.setSender(walletAddress);
  const suinsTx = new SuinsTransaction(suinsClient, tx);
  suinsTx.setTargetAddress({ nft: tx.object(nftDomain.objectId), address: target });
  return tx.build({ client: transport as never });
}

/** Build a subname PTB and return bytes ready for WaaP signing. */
export async function buildSubnameTxBytes(
  rawAddress: string,
  parent: OwnedDomain,
  subLabel: string,
  targetAddress: string,
  type: 'leaf' | 'node' = 'leaf',
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const tx = buildSubnameTx(parent, subLabel, normalizeSuiAddress(targetAddress), type);
  tx.setSender(walletAddress);
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
  const nsKey = mainPackage.mainnet.coins.NS.type.replace(/^0x/, '');
  const discountPct = discountMap.get(nsKey) ?? 0;
  return (rawPrice * (1 - discountPct / 100)) / 1e6;
}

// ─── Hardcoded shared object refs (initialSharedVersion verified on-chain) ──────
// Pyth NS/USD PriceInfoObject — updated in-place by Pyth every ~400ms
const NS_PYTH_PRICE_INFO_OBJECT = '0xc6352e1ea55d7b5acc3ed690cc3cdf8007978071d7bfd6a189445018cfb366e0';
const NS_PYTH_PRICE_INFO_INITIAL_SHARED_VERSION = 417086474;

// ─── DeepBook v3 mainnet constants ────────────────────────────────────
const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
const DB_NS_USDC_POOL = '0x0c0fdd4008740d81a8a7d4281322aee71a1b62c449eb5b142656753d89ebc060';
const DB_NS_USDC_POOL_INITIAL_SHARED_VERSION = 414947421;
const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';

export async function buildRegisterSplashNsTx(rawAddress: string, domain = 'splash.sui', suiPrice?: number, setAsDefault = false): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);

  // Use GraphQL directly — skip gRPC trial which adds a full extra round-trip on failure.
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });

  const [usdcCoins, rawPrice, discountMap] = await Promise.all([
    listCoinsOfType(transport, walletAddress, mainPackage.mainnet.coins.USDC.type),
    suinsClient.calculatePrice({ name: domain, years: 1 }),
    suinsClient.getCoinTypeDiscount(),
  ]);

  const nsKey = mainPackage.mainnet.coins.NS.type.replace(/^0x/, '');
  const discountPct = discountMap.get(nsKey) ?? 0;
  const discountedUsd = (rawPrice * (1 - discountPct / 100)) / 1e6;
  // 1.5% buffer + round up to nearest cent (covers DeepBook slippage)
  const usdcNeeded = BigInt(Math.ceil(discountedUsd * 1.015 * 100) * 10000);

  // Calculate total USDC balance
  const totalUsdc = usdcCoins.reduce((sum, c) => sum + c.balance, 0n);

  // ── Path 1: USDC → DeepBook → NS → Register (cheapest, NS discount) ──
  if (usdcCoins.length > 0 && totalUsdc >= usdcNeeded) {
    const tx = new Transaction();
    tx.setSender(walletAddress);

    // All shared objects hardcoded — tx.build() won't need to resolve them via RPC.
    const priceInfoObjectId = tx.sharedObjectRef({
      objectId: NS_PYTH_PRICE_INFO_OBJECT,
      initialSharedVersion: NS_PYTH_PRICE_INFO_INITIAL_SHARED_VERSION,
      mutable: false,
    });
    const dbPool = tx.sharedObjectRef({
      objectId: DB_NS_USDC_POOL,
      initialSharedVersion: DB_NS_USDC_POOL_INITIAL_SHARED_VERSION,
      mutable: true,
    });

    // Use objectRef (id+version+digest) for user coins — skips per-coin RPC lookup in tx.build().
    const usdcCoin = tx.objectRef(usdcCoins[0]);
    if (usdcCoins.length > 1) {
      tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map((c) => tx.objectRef(c)));
    }
    const [usdcForSwap] = tx.splitCoins(usdcCoin, [tx.pure.u64(usdcNeeded)]);

    // Swap USDC → NS via DeepBook
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [nsCoin, usdcSwapChange, deepChange] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
      typeArguments: [mainPackage.mainnet.coins.NS.type, mainPackage.mainnet.coins.USDC.type],
      arguments: [dbPool, usdcForSwap, zeroDEEP, tx.pure.u64(0), tx.object.clock()],
    });

    // Register domain with NS discount
    const suinsTx = new SuinsTransaction(suinsClient, tx);
    const nft = suinsTx.register({ domain, years: 1, coinConfig: mainPackage.mainnet.coins.NS, coin: nsCoin, priceInfoObjectId });
    suinsTx.setTargetAddress({ nft, address: walletAddress });
    if (setAsDefault) suinsTx.setDefault(domain);
    tx.transferObjects([nft], tx.pure.address(walletAddress));

    // Burn NS dust — prevents "+NS" in wallet confirmation
    tx.transferObjects([nsCoin], tx.pure.address('0x0'));

    // Return USDC change
    tx.transferObjects([usdcSwapChange, usdcCoin, deepChange], tx.pure.address(walletAddress));

    return tx.build({ client: transport as never });
  }

  // ── Path 2: SUI → Register directly (no NS discount, no DeepBook) ──
  if (suiPrice && suiPrice > 0) {
    const basePriceUsd = rawPrice / 1e6;
    const tx = new Transaction();
    tx.setSender(walletAddress);

    // Get Pyth SUI/USD price info — pay oracle fee from gas
    const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.SUI.feed, tx.gas,
    );

    // Split SUI from gas with 10% buffer — contract calculates exact amount on-chain via Pyth
    const suiMist = BigInt(Math.ceil(basePriceUsd / suiPrice * 1.10 * 1e9));
    const [suiPayment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiMist)]);

    // Register with SUI payment
    const suinsTx = new SuinsTransaction(suinsClient, tx);
    const nft = suinsTx.register({
      domain, years: 1,
      coinConfig: mainPackage.mainnet.coins.SUI,
      coin: suiPayment,
      priceInfoObjectId,
    });
    suinsTx.setTargetAddress({ nft, address: walletAddress });
    if (setAsDefault) suinsTx.setDefault(domain);
    tx.transferObjects([nft], tx.pure.address(walletAddress));

    // Merge SUI remainder back to gas
    tx.mergeCoins(tx.gas, [suiPayment]);

    return tx.build({ client: transport as never });
  }

  // ── Neither path viable ──
  const usdcHave = (Number(totalUsdc) / 1e6).toFixed(2);
  const usdcNeed = (Number(usdcNeeded) / 1e6).toFixed(2);
  throw new Error(
    `Not enough USDC ($${usdcHave} / $${usdcNeed} needed) and no SUI price available. ` +
    `Add USDC or SUI to your wallet to register.`,
  );
}
