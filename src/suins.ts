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

const GQL_URL    = 'https://graphql.mainnet.sui.io/graphql';
const GRPC_URL   = 'https://fullnode.mainnet.sui.io:443';

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
      const res = await fetch(GQL_URL, {
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
    const res = await fetch(GQL_URL, {
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
    const capRes = await fetch(GQL_URL, {
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
      const dfRes = await fetch(GQL_URL, {
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
  /** Seller's kiosk object ID (when NFT is listed in a marketplace kiosk). */
  kioskId?: string;
  /** NFT object ID inside the kiosk. */
  kioskNftId?: string;
  /** Listing price in MIST as string (serialized bigint). */
  kioskListingPriceMist?: string;
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
          query: `query($id: SuiAddress!) {
            object(address: $id) {
              owner {
                ... on AddressOwner { owner { address } }
                ... on Parent {
                  parent {
                    address
                    asMoveObject { contents { type { repr } } }
                    owner {
                      ... on Parent { parent { address } }
                      ... on AddressOwner { owner { address } }
                    }
                  }
                }
              }
            }
          }`,
          variables: { id: record.nftId },
        }),
      });
      type OwnerResult = {
        data?: { object?: { owner?: {
          owner?: { address?: string };
          parent?: {
            address?: string;
            asMoveObject?: { contents?: { type?: { repr?: string } } };
            owner?: {
              parent?: { address?: string };
              owner?: { address?: string };
            };
          };
        } } };
      };
      const json = await res.json() as OwnerResult;
      const ownerData = json?.data?.object?.owner;
      const ownerAddr = ownerData?.owner?.address;
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
      // Parent owner → NFT is inside a kiosk (dynamic field wrapper)
      const parentData = ownerData?.parent;
      if (parentData) {
        const parentType = parentData.asMoveObject?.contents?.type?.repr ?? '';
        if (parentType.includes('dynamic_field') || parentType.includes('kiosk')) {
          // Grandparent is the kiosk ID
          const kioskId = parentData.owner?.parent?.address ?? parentData.address;
          if (kioskId && record.nftId) {
            const listingPrice = await _fetchKioskListingPrice(kioskId, record.nftId);
            if (listingPrice) {
              return { avail: 'taken', targetAddress, kioskId, kioskNftId: record.nftId, kioskListingPriceMist: listingPrice };
            }
          }
        }
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

/** Resolve a SuiNS name to its target address. Returns null if not found or no target set. */
export async function resolveSuiNSName(name: string): Promise<string | null> {
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  const fullName = name.endsWith('.sui') ? name : `${name}.sui`;
  try {
    const record = await suinsClient.getNameRecord(fullName);
    return record?.targetAddress ?? null;
  } catch {
    return null;
  }
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

// ─── Kiosk marketplace helpers ───────────────────────────────────────

/** Fetch the listing price (in MIST) for an NFT inside a kiosk, or null if not listed. */
async function _fetchKioskListingPrice(kioskId: string, nftId: string): Promise<string | null> {
  try {
    const { kiosk } = await import('@mysten/kiosk');
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const client = transport.$extend(kiosk());
    const data = await client.kiosk.getKiosk({ id: kioskId, options: { withListingPrices: true } });
    const item = data.items?.find(i => i.objectId === nftId && i.listing);
    return item?.listing?.price ?? null;
  } catch { return null; }
}

/**
 * Build a PTB to purchase a SuiNS NFT from a seller's kiosk.
 *
 * Uses KioskTransaction.purchaseAndResolve() which auto-resolves transfer
 * policy rules (royalties, lock rules, etc). After purchase, the NFT is taken
 * out of the buyer's kiosk and transferred directly to the wallet so SuiNS
 * name resolution works. Returns Uint8Array for WaaP compatibility.
 */
export async function buildKioskPurchaseTx(
  rawAddress: string,
  sellerKioskId: string,
  nftId: string,
  priceMist: string,
): Promise<Uint8Array> {
  const { kiosk, KioskTransaction } = await import('@mysten/kiosk');
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const kioskClient = transport.$extend(kiosk()).kiosk;

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Check if buyer already has a kiosk — purchaseAndResolve requires one
  const ownedKiosks = await kioskClient.getOwnedKiosks({ address: walletAddress });
  const buyerCap = ownedKiosks.kioskOwnerCaps[0];

  const kioskTx = new KioskTransaction({
    transaction: tx,
    kioskClient,
    ...(buyerCap ? { cap: buyerCap } : {}),
  });

  // If buyer has no kiosk, create one (purchaseAndResolve requires a buyer kiosk)
  if (!buyerCap) kioskTx.create();

  // Purchase and resolve transfer policies (royalties, etc.)
  // Item gets placed in buyer's kiosk by purchaseAndResolve
  await kioskTx.purchaseAndResolve({
    itemType: SUINS_REG_TYPE,
    itemId: nftId,
    price: priceMist,
    sellerKiosk: sellerKioskId,
  });

  // Take NFT out of buyer's kiosk → transfer directly to wallet address
  // (SuiNS resolution requires AddressOwner, not kiosk parent)
  const nft = kioskTx.take({ itemType: SUINS_REG_TYPE, itemId: nftId });
  tx.transferObjects([nft], tx.pure.address(walletAddress));

  // Share newly created kiosk + transfer cap (must be before finalize)
  if (!buyerCap) kioskTx.shareAndTransferCap(walletAddress);

  kioskTx.finalize();

  return tx.build({ client: transport as never });
}

// ─── Shade — privacy-preserving grace-period escrow ──────────────────
//
// Uses a commitment-reveal pattern + Seal encryption so that on-chain
// observers cannot see which domain is being targeted or when execution
// will occur. Only the order owner can decrypt the sealed payload.
//
// On-chain, a ShadeOrder stores:
//   - owner, deposit (Balance<SUI>), commitment (keccak256 hash), sealed_payload
// Hidden until execution: domain, execute_after_ms, target_address, salt

/** Shade package on mainnet (published by plankton.sui). */
const SHADE_PACKAGE = '0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203';


export interface ShadeOrderInfo {
  objectId: string;
  domain: string;
  owner: string;
  depositMist: bigint;
  executeAfterMs: number;
  targetAddress: string;
  salt: string; // hex-encoded
}

// ─── Commitment helpers ──────────────────────────────────────────────

/** Generate a random 32-byte salt as hex string. */
function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Hex string → Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}


/** BCS-encode a u64 as 8 little-endian bytes (matches Move's bcs::to_bytes). */
function bcsU64(value: number | bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(value), true); // little-endian
  return new Uint8Array(buf);
}

/** BCS-encode a Sui address as 32 bytes (matches Move's bcs::to_bytes for address). */
function bcsAddress(addr: string): Uint8Array {
  return hexToBytes(normalizeSuiAddress(addr));
}

/**
 * Build the commitment preimage matching the Move contract:
 *   keccak256(domain_bytes || bcs(execute_after_ms) || bcs(target_address) || salt_bytes)
 */
async function buildCommitment(
  domain: string,
  executeAfterMs: number,
  targetAddress: string,
  saltHex: string,
): Promise<Uint8Array> {
  const domainBytes = new TextEncoder().encode(domain);
  const msBytes = bcsU64(executeAfterMs);
  const addrBytes = bcsAddress(targetAddress);
  const saltBytes = hexToBytes(saltHex);

  // Concatenate: domain || execute_after_ms || target_address || salt
  const preimage = new Uint8Array(domainBytes.length + msBytes.length + addrBytes.length + saltBytes.length);
  let offset = 0;
  preimage.set(domainBytes, offset); offset += domainBytes.length;
  preimage.set(msBytes, offset); offset += msBytes.length;
  preimage.set(addrBytes, offset); offset += addrBytes.length;
  preimage.set(saltBytes, offset);

  // keccak256 — use SubtleCrypto SHA-256 as a standin until we wire keccak.
  // The Move contract uses sui::hash::keccak256, so we need to match.
  // We import keccak from @noble/hashes which @mysten/sui bundles.
  const { keccak_256 } = await import('@noble/hashes/sha3');
  return keccak_256(preimage);
}

// ─── Seal encrypt/decrypt — REMOVED ──────────────────────────────────
// Seal encryption was dropped: on-chain seal_approve uses uid_to_bytes(order.id)
// as namespace but encryption used the commitment hash → mismatch → decrypt
// always fails. Domain info lives in localStorage only.

// ─── PTB builders ────────────────────────────────────────────────────

/**
 * Build a PTB to create a new Shade order.
 *
 * 1. Calculates deposit: basePriceUsd / suiPrice * 1.20 * 1e9 MIST (20% buffer)
 * 2. Builds commitment hash from (domain, graceEndMs, targetAddress, salt)
 * 3. Encrypts payload via Seal
 * 4. Calls shade::create(coin, commitment, sealed_payload)
 *
 * Returns { txBytes, orderInfo } — txBytes for signing, orderInfo for localStorage.
 */
export async function buildCreateShadeOrderTx(
  rawAddress: string,
  domain: string,
  graceEndMs: number,
  suiPrice: number,
): Promise<{ txBytes: Uint8Array; orderInfo: Omit<ShadeOrderInfo, 'objectId'> }> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });

  // Calculate deposit: NS-discounted price / SUI price * 1.10 buffer
  // Executor does SUI→USDC→NS two-hop swap via DeepBook for 25% NS discount.
  // Buffer covers two-hop slippage + gas.
  const [rawPrice, discountMap] = await Promise.all([
    suinsClient.calculatePrice({ name: `${domain}.sui`, years: 1 }),
    suinsClient.getCoinTypeDiscount(),
  ]);
  const nsKey = mainPackage.mainnet.coins.NS.type.replace(/^0x/, '');
  const discountPct = discountMap.get(nsKey) ?? 0;
  const discountedUsd = (rawPrice * (1 - discountPct / 100)) / 1e6;
  const depositMist = BigInt(Math.ceil(discountedUsd / suiPrice * 1.10 * 1e9));

  // Generate salt and build commitment
  const salt = generateSalt();
  const commitment = await buildCommitment(domain, graceEndMs, walletAddress, salt);

  // Seal encryption removed — domain info lives in localStorage only.
  // On-chain sealed_payload is empty (Seal's seal_approve namespace mismatch
  // made decrypt impossible anyway).
  const sealedPayload = new Uint8Array(0);

  // Build PTB
  const tx = new Transaction();
  tx.setSender(walletAddress);
  const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(depositMist)]);
  tx.moveCall({
    target: `${SHADE_PACKAGE}::shade::create`,
    arguments: [
      depositCoin,
      tx.pure.vector('u8', Array.from(commitment)),
      tx.pure.vector('u8', Array.from(sealedPayload)),
    ],
  });

  const txBytes = await tx.build({ client: transport as never });

  const orderInfo: Omit<ShadeOrderInfo, 'objectId'> = {
    domain,
    owner: walletAddress,
    depositMist,
    executeAfterMs: graceEndMs,
    targetAddress: walletAddress,
    salt,
  };

  return { txBytes, orderInfo };
}

/**
 * Build a PTB to execute a Shade order (reveal + register).
 *
 * PTB composition:
 *   shade::execute(order, domain, execute_after_ms, target, salt, clock) → Coin<SUI>
 *   → suins::register(coin=releasedCoin) → nft
 *   → setTargetAddress + setDefault + transferObjects
 *   → transferObjects(releasedCoin change → owner)
 */
export async function buildExecuteShadeOrderTx(
  rawAddress: string,
  order: ShadeOrderInfo,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Step 1: Execute shade order → returns released Coin<SUI>
  const domainBytes = Array.from(new TextEncoder().encode(order.domain));
  const saltBytes = Array.from(hexToBytes(order.salt));
  const [releasedCoin] = tx.moveCall({
    target: `${SHADE_PACKAGE}::shade::execute`,
    arguments: [
      tx.object(order.objectId),
      tx.pure.vector('u8', domainBytes),
      tx.pure.u64(order.executeAfterMs),
      tx.pure.address(normalizeSuiAddress(order.targetAddress)),
      tx.pure.vector('u8', saltBytes),
      tx.object.clock(),
    ],
  });

  // Step 2: Get Pyth SUI/USD price info for SuiNS registration
  const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
    tx, mainPackage.mainnet.coins.SUI.feed, tx.gas,
  );

  // Step 3: Register the domain with released SUI
  const fullDomain = `${order.domain}.sui`;
  const suinsTx = new SuinsTransaction(suinsClient, tx);
  const nft = suinsTx.register({
    domain: fullDomain,
    years: 1,
    coinConfig: mainPackage.mainnet.coins.SUI,
    coin: releasedCoin,
    priceInfoObjectId,
  });

  // Step 4: Point name at target + set default + transfer NFT
  suinsTx.setTargetAddress({ nft, address: normalizeSuiAddress(order.targetAddress) });
  suinsTx.setDefault(fullDomain);
  tx.transferObjects([nft], tx.pure.address(normalizeSuiAddress(order.targetAddress)));

  // Step 5: Merge remaining SUI back into gas (matches existing SUI registration pattern)
  tx.mergeCoins(tx.gas, [releasedCoin]);

  return tx.build({ client: transport as never });
}

/**
 * Build a PTB to cancel a Shade order (owner-only refund).
 */
export async function buildCancelShadeOrderTx(
  rawAddress: string,
  orderObjectId: string,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const tx = new Transaction();
  tx.setSender(walletAddress);
  tx.moveCall({
    target: `${SHADE_PACKAGE}::shade::cancel`,
    arguments: [tx.object(orderObjectId)],
  });
  return tx.build({ client: transport as never });
}

/**
 * Build a PTB to refund a Shade order using &mut shared access (WaaP-safe path).
 * Object deletion is handled separately by shade::reap_cancelled.
 */
export async function buildCancelRefundShadeOrderTx(
  rawAddress: string,
  orderObjectId: string,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const tx = new Transaction();
  tx.setSender(walletAddress);
  tx.moveCall({
    target: `${SHADE_PACKAGE}::shade::cancel_refund`,
    arguments: [tx.object(orderObjectId)],
  });
  return tx.build({ client: transport as never });
}

/**
 * Build a PTB to delete a cancelled (already refunded) Shade order.
 * Intended for keeper/server execution.
 */
export async function buildReapCancelledShadeOrderTx(
  rawAddress: string,
  orderObjectId: string,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const tx = new Transaction();
  tx.setSender(walletAddress);
  tx.moveCall({
    target: `${SHADE_PACKAGE}::shade::reap_cancelled`,
    arguments: [tx.object(orderObjectId)],
  });
  return tx.build({ client: transport as never });
}

/**
 * Extract ShadeOrder object ID from transaction effects (instant — no indexer lag).
 * Effects shape varies by wallet/transport, so we check multiple known layouts.
 */
export function extractShadeOrderIdFromEffects(effects: unknown): string | null {
  if (!effects || typeof effects !== 'object') return null;
  const eff = effects as Record<string, unknown>;
  // Sui effects v1 JSON: { created: [{ owner: { Shared: ... }, reference: { objectId } }] }
  const created = (eff.created ?? eff.createdObjects) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(created)) {
    for (const obj of created) {
      const owner = obj.owner as Record<string, unknown> | undefined;
      if (owner && ('Shared' in owner || 'shared' in owner)) {
        const ref = (obj.reference ?? obj) as Record<string, unknown>;
        const id = ref.objectId ?? ref.object_id;
        if (typeof id === 'string') return id;
      }
    }
  }
  // gRPC V2 effects: { changedObjects: [{ objectId, outputState: { objectWrite: { owner: { shared } } } }] }
  const changed = eff.changedObjects as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(changed)) {
    for (const ch of changed) {
      const out = (ch.outputState ?? ch.output_state) as Record<string, unknown> | undefined;
      const write = (out?.objectWrite ?? out?.object_write) as Record<string, unknown> | undefined;
      const owner = write?.owner as Record<string, unknown> | undefined;
      if (owner && ('shared' in owner || 'Shared' in owner)) {
        const id = ch.objectId ?? ch.object_id;
        if (typeof id === 'string') return id;
      }
    }
  }
  return null;
}

/**
 * Query a transaction digest to find the created ShadeOrder object ID.
 * Fallback when effects parsing didn't yield a result (indexer may lag).
 */
export async function findCreatedShadeOrderId(digest: string): Promise<string | null> {
  const query = `query($digest: String!) {
    transactionBlock(digest: $digest) {
      effects {
        objectChanges {
          nodes {
            outputState { ... on MoveObject { address contents { type { repr } } } }
          }
        }
      }
    }
  }`;
  // Retry up to 4 times with increasing delays — indexer may lag behind execution
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { digest } }),
      });
      const json = await res.json() as {
        data?: { transactionBlock?: { effects?: { objectChanges?: { nodes?: Array<{
          outputState?: { address?: string; contents?: { type?: { repr?: string } } };
        }> } } } };
      };
      const nodes = json?.data?.transactionBlock?.effects?.objectChanges?.nodes ?? [];
      for (const node of nodes) {
        const typeRepr = node.outputState?.contents?.type?.repr ?? '';
        if (typeRepr.includes('shade::ShadeOrder')) {
          return node.outputState?.address ?? null;
        }
      }
      // If tx block was found but no ShadeOrder in it, don't retry — it won't appear
      if (json?.data?.transactionBlock) return null;
    } catch { /* retry */ }
  }
  return null;
}

// ─── Shade order localStorage tracking ───────────────────────────────

const SHADE_STORAGE_PREFIX = 'ski:shade-orders:';

export function getShadeOrders(address: string): ShadeOrderInfo[] {
  try {
    const raw = localStorage.getItem(`${SHADE_STORAGE_PREFIX}${address}`);
    if (!raw) return [];
    // depositMist is stored as string (BigInt can't be JSON-serialized) — restore to bigint
    return (JSON.parse(raw) as Array<Record<string, unknown>>).map(o => ({
      ...o,
      depositMist: BigInt(o.depositMist as string | number ?? 0),
    })) as ShadeOrderInfo[];
  } catch { return []; }
}

/** Serialize a ShadeOrderInfo for JSON storage (BigInt → string). */
function shadeOrderToJson(order: ShadeOrderInfo): Record<string, unknown> {
  return { ...order, depositMist: String(order.depositMist) };
}

export function addShadeOrder(address: string, order: ShadeOrderInfo): void {
  const orders = getShadeOrders(address);
  // Avoid duplicates by objectId
  if (orders.some(o => o.objectId === order.objectId)) return;
  orders.push(order);
  try { localStorage.setItem(`${SHADE_STORAGE_PREFIX}${address}`, JSON.stringify(orders.map(shadeOrderToJson))); } catch {}
}

export function removeShadeOrder(address: string, objectId: string): void {
  const orders = getShadeOrders(address).filter(o => o.objectId !== objectId);
  try { localStorage.setItem(`${SHADE_STORAGE_PREFIX}${address}`, JSON.stringify(orders.map(shadeOrderToJson))); } catch {}
}

export function removeShadeOrderByDomain(address: string, domain: string): void {
  const orders = getShadeOrders(address).filter(o => o.domain !== domain);
  try { localStorage.setItem(`${SHADE_STORAGE_PREFIX}${address}`, JSON.stringify(orders.map(shadeOrderToJson))); } catch {}
}

/** Find a shade order for a specific domain owned by this address. */
export function findShadeOrder(address: string, domain: string): ShadeOrderInfo | null {
  return getShadeOrders(address).find(o => o.domain === domain) ?? null;
}

/**
 * Query on-chain ShadeOrders owned by an address.
 * Returns minimal info (objectId + depositMist) for orders not tracked in localStorage.
 * This is the fallback when findCreatedShadeOrderId failed to extract the ID after creation.
 */
export async function fetchOnChainShadeOrders(rawAddress: string): Promise<Array<{ objectId: string; depositMist: string; sealedPayload?: string; commitment?: string }>> {
  const address = normalizeSuiAddress(rawAddress);
  try {
    // ShadeOrders are shared objects — query by type, filter by owner field in contents
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($type: String!) {
          objects(filter: { type: $type }) {
            nodes { address asMoveObject { contents { json } } }
          }
        }`,
        variables: {
          type: `${SHADE_PACKAGE}::shade::ShadeOrder`,
        },
      }),
    });
    const json = await res.json() as {
      data?: { objects?: { nodes?: Array<{
        address: string;
        asMoveObject?: { contents?: { json?: { owner?: string; deposit?: string; sealed_payload?: string; commitment?: string } } };
      }> } };
    };
    // Filter to only orders owned by this address
    return (json?.data?.objects?.nodes ?? [])
      .filter(n => normalizeSuiAddress(n.asMoveObject?.contents?.json?.owner ?? '') === address)
      .map(n => ({
        objectId: n.address,
        depositMist: n.asMoveObject?.contents?.json?.deposit ?? '0',
        sealedPayload: n.asMoveObject?.contents?.json?.sealed_payload,
        commitment: n.asMoveObject?.contents?.json?.commitment,
      }));
  } catch { return []; }
}

/**
 * Validate shade orders against on-chain state — remove consumed/cancelled ones.
 * Called lazily when the menu opens.
 */
export async function pruneShadeOrders(address: string): Promise<void> {
  const orders = getShadeOrders(address);
  if (orders.length === 0) return;

  const validOrders: ShadeOrderInfo[] = [];
  for (const order of orders) {
    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: SuiAddress!) { object(address: $id) { address } }`,
          variables: { id: order.objectId },
        }),
      });
      const json = await res.json() as { data?: { object?: { address?: string } } };
      if (json?.data?.object?.address) validOrders.push(order);
    } catch {
      validOrders.push(order); // keep on network error — prune next time
    }
  }
  try { localStorage.setItem(`${SHADE_STORAGE_PREFIX}${address}`, JSON.stringify(validOrders)); } catch {}
}
