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
import { grpcClient, GQL_URL, gqlClient } from './rpc.js';

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
/** 1 SUI — the crown coin Duke Shelby flips (5 shillings, 1928). */
const SUBNAME_FEE_MIST = 1_000_000_000n;

export function buildSubnameTx(
  parent: OwnedDomain,
  subdomainLabel: string,
  targetAddress: string,
  type: 'leaf' | 'node' = 'leaf',
  nodeExpiryMs?: number,
  /** Address that receives the 1 SUI subname fee. Omit to skip fee (e.g. self-minting). */
  feeRecipient?: string,
): Transaction {
  const tx = new Transaction();
  const parentName = parent.name.endsWith('.sui') ? parent.name : `${parent.name}.sui`;
  const fullName = `${subdomainLabel}.${parentName}`;
  const expiry = BigInt(nodeExpiryMs ?? Date.now() + ONE_YEAR_MS);

  // Crown fee — split 1 SUI from gas and send to the parent domain owner
  if (feeRecipient) {
    const [crown] = tx.splitCoins(tx.gas, [tx.pure.u64(SUBNAME_FEE_MIST)]);
    tx.transferObjects([crown], tx.pure.address(feeRecipient));
  }

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
  const transport = gqlClient;
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
                __typename
                ... on AddressOwner { address { address } }
                ... on ObjectOwner {
                  address {
                    address
                    asObject {
                      asMoveObject { contents { type { repr } } }
                      owner {
                        ... on ObjectOwner { address { address } }
                        ... on AddressOwner { address { address } }
                      }
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
          __typename?: string;
          address?: {
            address?: string;
            asObject?: {
              asMoveObject?: { contents?: { type?: { repr?: string } } };
              owner?: { address?: { address?: string } };
            };
          };
        } } };
      };
      const json = await res.json() as OwnerResult;
      const ownerData = json?.data?.object?.owner;
      // AddressOwner — NFT owned directly by an address
      if (ownerData?.__typename === 'AddressOwner') {
        const ownerAddr = ownerData.address?.address;
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
      // ObjectOwner — NFT is inside a kiosk (dynamic field wrapper)
      if (ownerData?.__typename === 'ObjectOwner') {
        const parentObj = ownerData.address?.asObject;
        const parentType = parentObj?.asMoveObject?.contents?.type?.repr ?? '';
        if (parentType.includes('dynamic_field') || parentType.includes('kiosk')) {
          const kioskId = parentObj?.owner?.address?.address ?? ownerData.address?.address;
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
    const transport = gqlClient;
    const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
    const fullDomain = domain.endsWith('.sui') ? domain : `${domain}.sui`;
    const record = await suinsClient.getNameRecord(fullDomain);
    if (!record?.nftId) return null;
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($id: SuiAddress!) { object(address: $id) { owner { ... on AddressOwner { address { address } } ... on ObjectOwner { address { address asObject { owner { ... on AddressOwner { address { address } } } } } } } } }`,
        variables: { id: record.nftId },
      }),
    });
    const json = await res.json() as {
      data?: { object?: { owner?: { address?: { address?: string; asObject?: { owner?: { address?: { address?: string } } } } } } };
    };
    // For ObjectOwner (kiosk), walk up to find the human owner
    const addr = json?.data?.object?.owner?.address;
    return addr?.asObject?.owner?.address?.address ?? addr?.address ?? null;
  } catch {
    return null;
  }
}

/** Build a PTB that sets `domain` as the wallet's default reverse-lookup name.
 *  Returns the Transaction object (not pre-built bytes) so WaaP can resolve
 *  gas/objects using its own bundled SDK version, avoiding serialization mismatches. */
export async function buildSetDefaultNsTx(rawAddress: string, domain: string): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const fullDomain = domain.endsWith('.sui') ? domain : `${domain}.sui`;
  const tx = new Transaction();
  tx.setSender(walletAddress);
  tx.moveCall({
    target: '0x71af035413ed499710980ed8adb010bbf2cc5cacf4ab37c7710a4bb87eb58ba5::controller::set_reverse_lookup',
    arguments: [
      tx.object(SUINS_OBJECT_ID),
      tx.pure.string(fullDomain),
    ],
  });
  try {
    return await tx.build({ client: grpcClient as never });
  } catch {
    return tx.build({ client: gqlClient as never });
  }
}

/** Execute a pre-signed transaction via our own gRPC transport (bypasses WaaP execution bugs). */
export async function executeSignedTx(bytesB64: string, signature: string): Promise<string> {
  const txBytes = Uint8Array.from(atob(bytesB64), c => c.charCodeAt(0));
  const result = await grpcClient.executeTransaction({ transaction: txBytes, signatures: [signature] });
  return (result as { digest?: string }).digest ?? '';
}

/** Resolve a SuiNS name to its target address. Returns null if not found or no target set. */
export async function resolveSuiNSName(name: string): Promise<string | null> {
  const transport = gqlClient;
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
  const transport = gqlClient;
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
  feeRecipient?: string,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = gqlClient;
  const tx = buildSubnameTx(parent, subLabel, normalizeSuiAddress(targetAddress), type, undefined, feeRecipient);
  tx.setSender(walletAddress);
  return tx.build({ client: transport as never });
}

/** Returns the NS-discounted registration price in USD for a `.sui` label (1 year). */
export async function fetchDomainPriceUsd(label: string): Promise<number> {
  const transport = gqlClient;
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
const DB_SUI_USDC_POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
const DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION = 389750322;
const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
// DeepBook v3 WAL/USDC pool (different package deployment than NS pools)
const DB2_PACKAGE = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809';
const DB_WAL_USDC_POOL = '0x56a1c985c1f1123181d6b881714793689321ba24301b3585eec427436eb1c76d';
const DB_WAL_USDC_POOL_INITIAL_SHARED_VERSION = 414947427;

// ─── Bluefin CLMM mainnet constants ──────────────────────────────────
// Note: 0x3492... is the original package (defines types), 0xd075... is the latest upgrade (has executable code)
const BF_PACKAGE = '0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c';
const BF_GLOBAL_CONFIG = '0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352';
const BF_WAL_USDC_POOL = '0xa8479545ff8a71659a7a3b5a2149cab68c5468a67aab8b18f62e4b42623e341e';
const WAL_TYPE = '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL';

export interface SponsoredTxResult {
  txBytes: Uint8Array;
  /** If set, gas is sponsored — client must fetch sponsor sig from /api/sponsor-gas */
  sponsorAddress?: string;
}

/** Fetch sponsor info (keeper address + gas coins) from the Worker. */
async function fetchSponsorInfo(): Promise<{ sponsorAddress: string; gasCoins: { objectId: string; version: string; digest: string }[] } | null> {
  try {
    const res = await fetch('/api/sponsor-info');
    if (!res.ok) return null;
    const data = await res.json() as { sponsorAddress?: string; gasCoins?: { objectId: string; version: string; digest: string }[] };
    if (!data.sponsorAddress || !data.gasCoins?.length) return null;
    return { sponsorAddress: data.sponsorAddress, gasCoins: data.gasCoins };
  } catch { return null; }
}

export async function buildRegisterSplashNsTx(rawAddress: string, domain = 'splash.sui', suiPrice?: number, setAsDefault = false, preferredCoin?: string): Promise<SponsoredTxResult> {
  const walletAddress = normalizeSuiAddress(rawAddress);

  // Use GraphQL directly — skip gRPC trial which adds a full extra round-trip on failure.
  const transport = gqlClient;
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });

  const [usdcCoins, nsCoins, rawPrice, discountMap, sponsorInfo] = await Promise.all([
    listCoinsOfType(transport, walletAddress, mainPackage.mainnet.coins.USDC.type),
    listCoinsOfType(transport, walletAddress, mainPackage.mainnet.coins.NS.type),
    suinsClient.calculatePrice({ name: domain, years: 1 }),
    suinsClient.getCoinTypeDiscount(),
    fetchSponsorInfo(),
  ]);

  const nsKey = mainPackage.mainnet.coins.NS.type.replace(/^0x/, '');
  const discountPct = discountMap.get(nsKey) ?? 0;
  const discountedUsd = (rawPrice * (1 - discountPct / 100)) / 1e6;
  const basePriceUsd = rawPrice / 1e6;
  // 1.5% buffer + round up to nearest cent (covers DeepBook slippage)
  const usdcNeeded = BigInt(Math.ceil(discountedUsd * 1.015 * 100) * 10000);

  // Calculate total balances
  const totalUsdc = usdcCoins.reduce((sum, c) => sum + c.balance, 0n);
  const totalNs = nsCoins.reduce((sum, c) => sum + c.balance, 0n);

  const pref = preferredCoin?.toUpperCase();
  const sponsored = !!sponsorInfo;

  // Configure gas sponsorship on a transaction
  const setupGas = (tx: Transaction) => {
    if (sponsorInfo) {
      tx.setGasOwner(sponsorInfo.sponsorAddress);
      tx.setGasPayment(sponsorInfo.gasCoins.map(c => ({
        objectId: c.objectId,
        version: c.version,
        digest: c.digest,
      })));
    }
  };

  // ── Path builders ──

  const buildNsDirect = async (): Promise<Uint8Array | null> => {
    if (nsCoins.length === 0 || totalNs === 0n) return null;
    const tx = new Transaction();
    tx.setSender(walletAddress);
    setupGas(tx);

    // Pyth price feed for NS/USD — pay oracle update fee from gas
    const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.NS.feed, tx.gas,
    );

    // Merge all NS coins into one, then pass to register — contract takes what it needs via Pyth
    const nsCoin = tx.objectRef(nsCoins[0]);
    if (nsCoins.length > 1) {
      tx.mergeCoins(nsCoin, nsCoins.slice(1).map((c) => tx.objectRef(c)));
    }

    const suinsTx = new SuinsTransaction(suinsClient, tx);
    const nft = suinsTx.register({ domain, years: 1, coinConfig: mainPackage.mainnet.coins.NS, coin: nsCoin, priceInfoObjectId });
    suinsTx.setTargetAddress({ nft, address: walletAddress });
    if (setAsDefault) suinsTx.setDefault(domain);
    tx.transferObjects([nft], tx.pure.address(walletAddress));

    // Return NS remainder to wallet
    tx.transferObjects([nsCoin], tx.pure.address(walletAddress));

    return tx.build({ client: transport as never });
  };

  const buildUsdcSwap = async (): Promise<Uint8Array | null> => {
    if (usdcCoins.length === 0 || totalUsdc < usdcNeeded) return null;
    const tx = new Transaction();
    tx.setSender(walletAddress);
    setupGas(tx);

    // Pyth price feed for NS/USD — pay oracle update fee from gas
    const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.NS.feed, tx.gas,
    );
    const dbPool = tx.sharedObjectRef({
      objectId: DB_NS_USDC_POOL,
      initialSharedVersion: DB_NS_USDC_POOL_INITIAL_SHARED_VERSION,
      mutable: true,
    });

    const usdcCoin = tx.objectRef(usdcCoins[0]);
    if (usdcCoins.length > 1) {
      tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map((c) => tx.objectRef(c)));
    }
    const [usdcForSwap] = tx.splitCoins(usdcCoin, [tx.pure.u64(usdcNeeded)]);

    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [nsCoin, usdcSwapChange, deepChange] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
      typeArguments: [mainPackage.mainnet.coins.NS.type, mainPackage.mainnet.coins.USDC.type],
      arguments: [dbPool, usdcForSwap, zeroDEEP, tx.pure.u64(0), tx.object.clock()],
    });

    const suinsTx = new SuinsTransaction(suinsClient, tx);
    const nft = suinsTx.register({ domain, years: 1, coinConfig: mainPackage.mainnet.coins.NS, coin: nsCoin, priceInfoObjectId });
    suinsTx.setTargetAddress({ nft, address: walletAddress });
    if (setAsDefault) suinsTx.setDefault(domain);
    tx.transferObjects([nft], tx.pure.address(walletAddress));

    tx.transferObjects([nsCoin], tx.pure.address('0x0'));
    tx.transferObjects([usdcSwapChange, usdcCoin, deepChange], tx.pure.address(walletAddress));

    return tx.build({ client: transport as never });
  };

  const buildSuiDirect = async (): Promise<Uint8Array | null> => {
    if (!suiPrice || suiPrice <= 0) return null;
    const tx = new Transaction();
    tx.setSender(walletAddress);
    // Note: SUI path splits from tx.gas for payment — no gas sponsorship here
    // since tx.gas belongs to whoever pays gas

    const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.SUI.feed, tx.gas,
    );

    const suiMist = BigInt(Math.ceil(basePriceUsd / suiPrice * 1.10 * 1e9));
    const [suiPayment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiMist)]);

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

    tx.mergeCoins(tx.gas, [suiPayment]);

    return tx.build({ client: transport as never });
  };

  // ── Try paths in preferred order ──
  // Default priority: NS direct (cheapest, 25% discount) → USDC swap → SUI direct
  // NS and USDC paths support gas sponsorship; SUI direct does not (uses gas coin for payment)
  type PathEntry = { fn: () => Promise<Uint8Array | null>; canSponsor: boolean };
  let paths: PathEntry[];
  const nsPath: PathEntry = { fn: buildNsDirect, canSponsor: true };
  const usdcPath: PathEntry = { fn: buildUsdcSwap, canSponsor: true };
  const suiPath: PathEntry = { fn: buildSuiDirect, canSponsor: false };

  if (pref === 'NS') {
    paths = [nsPath, usdcPath, suiPath];
  } else if (pref === 'USDC' || pref === 'USD') {
    paths = [usdcPath, nsPath, suiPath];
  } else if (pref === 'SUI') {
    paths = [suiPath, nsPath, usdcPath];
  } else {
    paths = [nsPath, usdcPath, suiPath];
  }

  for (const { fn, canSponsor } of paths) {
    const result = await fn();
    if (result) {
      return {
        txBytes: result,
        sponsorAddress: canSponsor && sponsored ? sponsorInfo!.sponsorAddress : undefined,
      };
    }
  }

  // ── No path viable ──
  throw new Error(
    `Insufficient balance for registration (~$${basePriceUsd.toFixed(2)}). ` +
    `Need enough SUI, USDC, or NS tokens to cover the domain cost.`,
  );
}

// ─── Tradeport marketplace API ───────────────────────────────────────

export type TradeportListing = {
  listingId: string;
  priceMist: string;
  seller: string;
  nftTokenId: string;
  marketName: string;
};

/** Query Tradeport for an active listing of a SuiNS domain via server proxy. Returns null if not listed. */
export async function fetchTradeportListing(label: string): Promise<TradeportListing | null> {
  try {
    const res = await fetch(`/api/tradeport/listing/${encodeURIComponent(label)}`);
    const json = await res.json() as { listing: TradeportListing | null };
    return json.listing;
  } catch { return null; }
}

// ─── Kiosk marketplace helpers ───────────────────────────────────────

/** Resolve the kiosk ID for an NFT by its object ID (e.g. from Tradeport nftTokenId). */
export async function resolveKioskIdForNft(nftId: string): Promise<string | null> {
  try {
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($id: SuiAddress!) {
          object(address: $id) {
            owner {
              ... on ObjectOwner {
                address {
                  address
                  asObject {
                    owner {
                      ... on ObjectOwner { address { address } }
                      ... on AddressOwner { address { address } }
                    }
                  }
                }
              }
            }
          }
        }`,
        variables: { id: nftId },
      }),
    });
    type R = { data?: { object?: { owner?: { address?: { address?: string; asObject?: { owner?: { address?: { address?: string } } } } } } } };
    const json = await res.json() as R;
    const parent = json?.data?.object?.owner?.address;
    // Grandparent is the kiosk ID (NFT → dynamic_field wrapper → kiosk)
    return parent?.asObject?.owner?.address?.address ?? parent?.address ?? null;
  } catch { return null; }
}

/** Fetch the listing price (in MIST) for an NFT inside a kiosk, or null if not listed. */
async function _fetchKioskListingPrice(kioskId: string, nftId: string): Promise<string | null> {
  try {
    const { kiosk } = await import('@mysten/kiosk');
    const transport = gqlClient;
    const client = transport.$extend(kiosk());
    const data = await client.kiosk.getKiosk({ id: kioskId, options: { withListingPrices: true } });
    const item = data.items?.find(i => i.objectId === nftId && i.listing);
    return item?.listing?.price ?? null;
  } catch { return null; }
}

/**
 * Build a PTB to purchase a SuiNS NFT from a seller's kiosk.
 *
 * Uses raw Move calls: kiosk::purchase → transfer_policy::confirm_request.
 * SuinsRegistration has a shared TransferPolicy with zero rules, so we call
 * confirm_request directly (no rule resolution needed). The NFT is transferred
 * to the buyer's wallet so SuiNS name resolution works.
 */
const SUINS_TRANSFER_POLICY = '0x38c967a9974ba7d6f94e66320a1bd04c90592e916ee8271b9ab943f8e4592723';

export async function buildKioskPurchaseTx(
  rawAddress: string,
  sellerKioskId: string,
  nftId: string,
  priceMist: string,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = gqlClient;

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Split exact payment from gas
  const payment = tx.splitCoins(tx.gas, [tx.pure.u64(priceMist)]);

  // kiosk::purchase<SuinsRegistration> → returns (NFT, TransferRequest)
  const [nft, transferRequest] = tx.moveCall({
    target: '0x2::kiosk::purchase',
    typeArguments: [SUINS_REG_TYPE],
    arguments: [
      tx.object(sellerKioskId),
      tx.pure.id(nftId),
      payment,
    ],
  });

  // Confirm the (empty-rules) transfer request against the shared policy
  tx.moveCall({
    target: '0x2::transfer_policy::confirm_request',
    typeArguments: [SUINS_REG_TYPE],
    arguments: [
      tx.object(SUINS_TRANSFER_POLICY),
      transferRequest,
    ],
  });

  // Transfer NFT directly to buyer (SuiNS needs AddressOwner, not kiosk)
  tx.transferObjects([nft], tx.pure.address(walletAddress));

  return tx.build({ client: transport as never });
}

/**
 * Build a PTB to purchase a SuiNS NFT listed on Tradeport (SimpleListing).
 *
 * Tradeport uses its own listing contract, not kiosks. Calls
 * tradeport_listings::buy_listing_without_transfer_policy which transfers
 * the NFT directly to the buyer.
 */
const TRADEPORT_PKG = '0xff2251ea99230ed1cbe3a347a209352711c6723fcdcd9286e16636e65bb55cab';
const TRADEPORT_STORE = '0xf96f9363ac5a64c058bf7140723226804d74c0dab2dd27516fb441a180cd763b';

/**
 * Resolve the on-chain SimpleListing object ID from the NFT token ID.
 * Chain: NFT → dynamic_field wrapper → SimpleListing
 */
export async function resolveTradeportListingId(nftTokenId: string): Promise<string | null> {
  try {
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ object(address: "${nftTokenId}") { owner { ... on ObjectOwner { address { address asObject { owner { ... on ObjectOwner { address { address } } } } } } } } }`,
      }),
    });
    type R = { data?: { object?: { owner?: { address?: { address?: string; asObject?: { owner?: { address?: { address?: string } } } } } } } };
    const json = await res.json() as R;
    // grandparent = SimpleListing object ID
    return json?.data?.object?.owner?.address?.asObject?.owner?.address?.address ?? null;
  } catch { return null; }
}

export async function buildTradeportPurchaseTx(
  rawAddress: string,
  nftTokenId: string,
  priceMist: string,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = gqlClient;

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Add 3% marketplace fee (fee_bps = 300)
  const price = BigInt(priceMist);
  const fee = price * 300n / 10000n;
  const payment = tx.splitCoins(tx.gas, [tx.pure.u64((price + fee).toString())]);

  // Store keys listings by NFT ID, not SimpleListing object ID
  tx.moveCall({
    target: `${TRADEPORT_PKG}::tradeport_listings::buy_listing_without_transfer_policy`,
    typeArguments: [SUINS_REG_TYPE],
    arguments: [
      tx.object(TRADEPORT_STORE),
      tx.pure.id(nftTokenId),
      payment,
    ],
  });

  // Return leftover coin (function borrows &mut Coin, doesn't consume it)
  tx.transferObjects([payment], tx.pure.address(walletAddress));

  return tx.build({ client: transport as never });
}

/**
 * Build a single-PTB transaction that swaps tokens → SUI and purchases a kiosk/Tradeport listing.
 * Composes: (optional) swap selected token → SUI + (optional) swap output token → SUI + purchase.
 * All in one atomic transaction — one signature.
 */
export async function buildSwapAndPurchaseTx(
  rawAddress: string,
  purchase: { type: 'kiosk'; kioskId: string; nftId: string; priceMist: string }
    | { type: 'tradeport'; nftTokenId: string; priceMist: string },
  selectedCoinType: string | null,  // coin type of selected balance (null = SUI)
  selectedBalance: number,          // USD value of selected coin (hint for estimates)
  outputCoinType: string | null,    // coin type of output selector (null = SUI)
  suiPrice: number,                 // current SUI price in USD
  selectedTokenPrice?: number,      // price per token of selected coin (e.g. XAUM price)
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = gqlClient;
  const tx = new Transaction();
  tx.setSender(walletAddress);

  const SLIPPAGE_BPS = 200n; // 2% slippage tolerance
  const priceMist = BigInt(purchase.priceMist);
  const feeMist = purchase.type === 'tradeport' ? priceMist * 300n / 10000n : 0n;
  const totalSuiNeeded = priceMist + feeMist;

  // Helper: calculate min output with slippage protection
  // expectedOut in MIST, returns min acceptable output (98% of expected)
  const withSlippage = (expected: bigint) => expected * (10000n - SLIPPAGE_BPS) / 10000n;

  // Check how much SUI we already have (from gas coins)
  const suiCoins = await listCoinsOfType(transport, walletAddress, SUI_TYPE);
  const suiBal = suiCoins.reduce((sum, c) => sum + c.balance, 0n);
  const gasBuf = 100_000_000n; // 0.1 SUI gas buffer
  let suiAccumulated = suiBal > gasBuf ? suiBal - gasBuf : 0n;

  // Step 1: Swap ALL of selected token → SUI (if selected ≠ SUI)
  // Always check on-chain balance — don't trust UI cache
  if (selectedCoinType && selectedCoinType !== SUI_TYPE) {
    const selCoins = await listCoinsOfType(transport, walletAddress, selectedCoinType);
    const onChainBal = selCoins.reduce((sum, c) => sum + c.balance, 0n);
    if (selCoins.length > 0 && onChainBal > 0n) {
      const isUsdc = selectedCoinType.includes('::usdc::');
      const isXaum = selectedCoinType === XAUM_TYPE;
      // Use on-chain balance for USD estimate
      const selDecimals = isUsdc ? 6 : 9;
      const actualBalance = Number(onChainBal) / (10 ** selDecimals);

      if (isUsdc) {
        // USDC → SUI via DeepBook
        const expectedSui = BigInt(Math.floor(actualBalance / suiPrice * 1e9));
        const minSuiOut = withSlippage(expectedSui);
        const usdcCoin = tx.objectRef(selCoins[0]);
        if (selCoins.length > 1) tx.mergeCoins(usdcCoin, selCoins.slice(1).map(c => tx.objectRef(c)));
        const [usdcForSwap] = tx.splitCoins(usdcCoin, [tx.pure.u64(onChainBal)]);
        const [zeroDEEP1] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
        const dbResult1 = tx.moveCall({
          target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
          typeArguments: [SUI_TYPE, mainPackage.mainnet.coins.USDC.type],
          arguments: [
            tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
            usdcForSwap, zeroDEEP1, tx.pure.u64(minSuiOut), tx.object.clock(),
          ],
        });
        tx.mergeCoins(tx.gas, [dbResult1[0]]);
        tx.transferObjects([dbResult1[1], dbResult1[2], usdcCoin], tx.pure.address(walletAddress));
        suiAccumulated += withSlippage(expectedSui);
      } else if (isXaum) {
        // XAUM → USDC (Bluefin) → SUI (DeepBook) — two-hop in same PTB
        // Get XAUM price for slippage calc
        const xaumCoin = tx.objectRef(selCoins[0]);
        if (selCoins.length > 1) tx.mergeCoins(xaumCoin, selCoins.slice(1).map(c => tx.objectRef(c)));

        // Bluefin XAUM→USDC: min_out from token price with 2% slippage
        const xaumUsdValue = selectedTokenPrice && selectedTokenPrice > 0
          ? actualBalance * selectedTokenPrice
          : selectedBalance; // fallback to UI's USD hint
        const expectedUsdc = BigInt(Math.floor(Math.max(xaumUsdValue, 0) * 1e6));
        const minUsdcOut = withSlippage(expectedUsdc);

        // Bluefin: XAUM → USDC (balance-based)
        const [xaumBal] = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [XAUM_TYPE], arguments: [xaumCoin] });
        const [xaumBalVal] = tx.moveCall({ target: '0x2::balance::value', typeArguments: [XAUM_TYPE], arguments: [xaumBal] });
        const [zeroUsdcBal] = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [mainPackage.mainnet.coins.USDC.type] });
        const [xaumDust, usdcBalOut] = tx.moveCall({
          target: `${BF_PACKAGE}::pool::swap`,
          typeArguments: [XAUM_TYPE, mainPackage.mainnet.coins.USDC.type],
          arguments: [
            tx.object('0x6'), tx.object(BF_GLOBAL_CONFIG), tx.object(BF_XAUM_USDC_POOL),
            xaumBal, zeroUsdcBal,
            tx.pure.bool(true), tx.pure.bool(true), xaumBalVal, tx.pure.u64(minUsdcOut),
            tx.pure.u128(BF_MIN_SQRT_PRICE),
          ],
        });
        const [xaumDustCoin] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [XAUM_TYPE], arguments: [xaumDust] });
        const [usdcFromXaum] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [mainPackage.mainnet.coins.USDC.type], arguments: [usdcBalOut] });

        // DeepBook: USDC → SUI — use expected USDC value to set min SUI out
        const expectedSuiFromXaum = suiPrice > 0
          ? BigInt(Math.floor(Number(withSlippage(expectedUsdc)) / 1e6 / suiPrice * 1e9))
          : 0n;
        const minSuiFromXaum = withSlippage(expectedSuiFromXaum);
        const [zeroDEEP2] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
        const dbResult2 = tx.moveCall({
          target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
          typeArguments: [SUI_TYPE, mainPackage.mainnet.coins.USDC.type],
          arguments: [
            tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
            usdcFromXaum, zeroDEEP2, tx.pure.u64(minSuiFromXaum), tx.object.clock(),
          ],
        });
        tx.mergeCoins(tx.gas, [dbResult2[0]]);
        tx.transferObjects([dbResult2[1], dbResult2[2], xaumDustCoin], tx.pure.address(walletAddress));
        suiAccumulated += minSuiFromXaum;
      }
    }
  }

  // Step 2: If still short, swap from output token (USDC) → SUI
  // Over-estimate input by slippage% to ensure enough SUI output
  if (suiAccumulated < totalSuiNeeded && outputCoinType && outputCoinType !== SUI_TYPE) {
    const shortfall = totalSuiNeeded - suiAccumulated;
    // Add slippage buffer to input amount (swap more USDC to guarantee enough SUI)
    const shortfallWithBuffer = shortfall + (shortfall * SLIPPAGE_BPS / 10000n);
    const shortfallUsd = (Number(shortfallWithBuffer) / 1e9) * suiPrice;
    const minSuiFromBackup = withSlippage(shortfall);
    const isOutUsdc = outputCoinType.includes('::usdc::');

    if (isOutUsdc) {
      const usdcCoins = await listCoinsOfType(transport, walletAddress, outputCoinType);
      if (usdcCoins.length > 0) {
        const usdcCoin = tx.objectRef(usdcCoins[0]);
        if (usdcCoins.length > 1) tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map(c => tx.objectRef(c)));
        const usdcAmount = BigInt(Math.ceil(shortfallUsd * 1e6));
        const [usdcForSwap] = tx.splitCoins(usdcCoin, [tx.pure.u64(usdcAmount)]);
        const [zeroDEEP3] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
        const dbResult3 = tx.moveCall({
          target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
          typeArguments: [SUI_TYPE, mainPackage.mainnet.coins.USDC.type],
          arguments: [
            tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
            usdcForSwap, zeroDEEP3, tx.pure.u64(minSuiFromBackup), tx.object.clock(),
          ],
        });
        tx.mergeCoins(tx.gas, [dbResult3[0]]);
        tx.transferObjects([dbResult3[1], dbResult3[2], usdcCoin], tx.pure.address(walletAddress));
      }
    }
  }

  // Step 3: Purchase — split exact price from gas (now includes merged swap SUI)
  if (purchase.type === 'kiosk') {
    const payment = tx.splitCoins(tx.gas, [tx.pure.u64(priceMist.toString())]);
    const [nft, transferRequest] = tx.moveCall({
      target: '0x2::kiosk::purchase',
      typeArguments: [SUINS_REG_TYPE],
      arguments: [tx.object(purchase.kioskId), tx.pure.id(purchase.nftId), payment],
    });
    tx.moveCall({
      target: '0x2::transfer_policy::confirm_request',
      typeArguments: [SUINS_REG_TYPE],
      arguments: [tx.object(SUINS_TRANSFER_POLICY), transferRequest],
    });
    tx.transferObjects([nft], tx.pure.address(walletAddress));
  } else {
    const price = BigInt(purchase.priceMist);
    const fee = price * 300n / 10000n;
    const payment = tx.splitCoins(tx.gas, [tx.pure.u64((price + fee).toString())]);
    tx.moveCall({
      target: `${TRADEPORT_PKG}::tradeport_listings::buy_listing_without_transfer_policy`,
      typeArguments: [SUINS_REG_TYPE],
      arguments: [tx.object(TRADEPORT_STORE), tx.pure.id(purchase.nftTokenId), payment],
    });
    tx.transferObjects([payment], tx.pure.address(walletAddress));
  }

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
  const { keccak_256 } = await import('@noble/hashes/sha3.js');
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
  const transport = gqlClient;
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
  const transport = gqlClient;
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
  const transport = gqlClient;
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
  const transport = gqlClient;
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
  const transport = gqlClient;
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

// ─── Consolidate alt tokens → USDC via DeepBook v3 ──────────────────
//
// Builds a single PTB that swaps all non-stable, non-SUI tokens into USDC.
// Currently supported routes:
//   NS  → USDC  (DeepBook NS/USDC pool, NS is base)
//   WAL → USDC  (Bluefin CLMM WAL/USDC pool)
//   SUI → USDC  (DeepBook SUI/USDC pool) — optional, only excess SUI
//
// All non-SUI, non-stable tokens with a known route are consolidated.

export interface ConsolidateResult {
  txBytes: Uint8Array;
  /** Tokens being swapped */
  swaps: Array<{ symbol: string; amount: number }>;
  sponsorAddress?: string;
}

export interface SelfSwapResult {
  txBytes: Uint8Array;
  fromSymbol: 'SUI' | 'USDC';
  toSymbol: 'SUI' | 'USDC';
}

export async function buildConsolidateToUsdcTx(
  rawAddress: string,
  /** Which tokens to consolidate. If empty, consolidates all eligible. */
  tokens?: string[],
  /** If true, also swap excess SUI (keeping 0.5 SUI for gas). */
  includeSui = false,
): Promise<ConsolidateResult> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = gqlClient;
  const USDC_TYPE = mainPackage.mainnet.coins.USDC.type;

  // Fetch all swappable coins + sponsor info in parallel
  const [nsCoins, walCoins, suiCoins, xaumCoins, sponsorInfo] = await Promise.all([
    listCoinsOfType(transport, walletAddress, mainPackage.mainnet.coins.NS.type),
    listCoinsOfType(transport, walletAddress, WAL_TYPE),
    includeSui ? listCoinsOfType(transport, walletAddress, SUI_TYPE) : Promise.resolve([]),
    listCoinsOfType(transport, walletAddress, XAUM_TYPE),
    fetchSponsorInfo(),
  ]);

  const totalNs = nsCoins.reduce((sum, c) => sum + c.balance, 0n);
  const totalWal = walCoins.reduce((sum, c) => sum + c.balance, 0n);
  const totalSui = suiCoins.reduce((sum, c) => sum + c.balance, 0n);
  const totalXaum = xaumCoins.reduce((sum, c) => sum + c.balance, 0n);
  const want = (s: string) => !tokens?.length || tokens.includes(s);
  // Minimum swap thresholds — skip dust amounts that would fail or cost more in fees than value
  const shouldSwapNs = totalNs > 1_000_000n && want('NS');     // > 1 NS (~$0.02)
  const shouldSwapWal = totalWal > 100_000_000n && want('WAL'); // > 0.1 WAL
  const shouldSwapSui = includeSui && totalSui > 500_000_000n && want('SUI');
  const shouldSwapXaum = totalXaum > 0n && want('XAUM');

  if (!shouldSwapNs && !shouldSwapWal && !shouldSwapSui && !shouldSwapXaum) {
    throw new Error('No eligible tokens to consolidate into USDC.');
  }

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Gas sponsorship
  if (sponsorInfo) {
    tx.setGasOwner(sponsorInfo.sponsorAddress);
    tx.setGasPayment(sponsorInfo.gasCoins.map(c => ({
      objectId: c.objectId, version: c.version, digest: c.digest,
    })));
  }

  const swaps: Array<{ symbol: string; amount: number }> = [];

  // ── NS → USDC (DeepBook: NS is base) ──
  // swap_exact_base_for_quote returns [Coin<Quote>, Coin<Base>, Coin<DEEP>]
  // (the normalized API incorrectly reports 0 returns)
  if (shouldSwapNs) {
    const nsCoin = tx.objectRef(nsCoins[0]);
    if (nsCoins.length > 1) {
      tx.mergeCoins(nsCoin, nsCoins.slice(1).map(c => tx.objectRef(c)));
    }

    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const nsSwapResult = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [mainPackage.mainnet.coins.NS.type, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_NS_USDC_POOL, initialSharedVersion: DB_NS_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        nsCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    // Transfer all 3 returned coins to wallet (USDC out, NS change, DEEP change)
    tx.transferObjects([nsSwapResult[0], nsSwapResult[1], nsSwapResult[2]], tx.pure.address(walletAddress));
    swaps.push({ symbol: 'NS', amount: Number(totalNs) / 1e6 });
  }

  // ── WAL → USDC (DeepBook v3 — same pattern) ──
  if (shouldSwapWal) {
    const walCoin = tx.objectRef(walCoins[0]);
    if (walCoins.length > 1) {
      tx.mergeCoins(walCoin, walCoins.slice(1).map(c => tx.objectRef(c)));
    }

    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const walSwapResult = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [WAL_TYPE, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_WAL_USDC_POOL, initialSharedVersion: DB_WAL_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        walCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    tx.transferObjects([walSwapResult[0], walSwapResult[1], walSwapResult[2]], tx.pure.address(walletAddress));
    swaps.push({ symbol: 'WAL', amount: Number(totalWal) / 1e9 });
  }

  // ── SUI → USDC (DeepBook: SUI is base) — optional ──
  if (shouldSwapSui) {
    const swapAmount = totalSui - 500_000_000n;
    const [suiPayment] = tx.splitCoins(tx.gas, [tx.pure.u64(swapAmount)]);

    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const suiSwapResult = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [SUI_TYPE, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        suiPayment, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    tx.transferObjects([suiSwapResult[0], suiSwapResult[1], suiSwapResult[2]], tx.pure.address(walletAddress));
    swaps.push({ symbol: 'SUI', amount: Number(swapAmount) / 1e9 });
  }

  // ── XAUM → USDC (Bluefin CLMM: XAUM is X, USDC is Y → swapXtoY=true) ──
  if (shouldSwapXaum) {
    const xaumCoin = tx.objectRef(xaumCoins[0]);
    if (xaumCoins.length > 1) {
      tx.mergeCoins(xaumCoin, xaumCoins.slice(1).map(c => tx.objectRef(c)));
    }
    const [xaumBal] = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [XAUM_TYPE], arguments: [xaumCoin] });
    const [xaumBalValue] = tx.moveCall({ target: '0x2::balance::value', typeArguments: [XAUM_TYPE], arguments: [xaumBal] });
    const [zeroUsdcBal] = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [USDC_TYPE] });
    const [balOutX, balOutY] = tx.moveCall({
      target: `${BF_PACKAGE}::pool::swap`,
      typeArguments: [XAUM_TYPE, USDC_TYPE],
      arguments: [
        tx.object('0x6'), // clock
        tx.object(BF_GLOBAL_CONFIG),
        tx.object(BF_XAUM_USDC_POOL),
        xaumBal,        // coinX balance in (XAUM)
        zeroUsdcBal,    // coinY balance in (zero USDC)
        tx.pure.bool(true),  // swapXtoY = true (XAUM→USDC)
        tx.pure.bool(true),  // by_amount_in
        xaumBalValue,
        tx.pure.u64(0), // min out
        tx.pure.u128(BF_MIN_SQRT_PRICE), // sqrt price limit for X→Y
      ],
    });
    const [xaumDust] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [XAUM_TYPE], arguments: [balOutX] });
    const [usdcOut] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [USDC_TYPE], arguments: [balOutY] });
    tx.transferObjects([usdcOut, xaumDust], tx.pure.address(walletAddress));
    swaps.push({ symbol: 'XAUM', amount: Number(totalXaum) / 1e9 });
  }

  const txBytes = await tx.build({ client: transport as never });
  return {
    txBytes,
    swaps,
    sponsorAddress: sponsorInfo?.sponsorAddress,
  };
}

export async function buildSelfSwapTx(
  rawAddress: string,
  coinType: string,
  amount: bigint,
): Promise<SelfSwapResult> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = gqlClient;
  const USDC_TYPE = mainPackage.mainnet.coins.USDC.type;
  const tx = new Transaction();
  tx.setSender(walletAddress);

  if (coinType === SUI_TYPE) {
    const [suiPayment] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const suiSwapResult = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [SUI_TYPE, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        suiPayment, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    tx.transferObjects([suiSwapResult[0], suiSwapResult[1], suiSwapResult[2]], tx.pure.address(walletAddress));
    return {
      txBytes: await tx.build({ client: transport as never }),
      fromSymbol: 'SUI',
      toSymbol: 'USDC',
    };
  }

  if (coinType === USDC_TYPE) {
    const usdcCoins = await listCoinsOfType(transport, walletAddress, USDC_TYPE);
    if (!usdcCoins.length) throw new Error('No USDC found');
    const totalUsdc = usdcCoins.reduce((sum, c) => sum + c.balance, 0n);
    if (totalUsdc < amount) throw new Error('Insufficient USDC balance');

    const usdcCoin = tx.objectRef(usdcCoins[0]);
    if (usdcCoins.length > 1) {
      tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map(c => tx.objectRef(c)));
    }
    const [usdcForSwap] = tx.splitCoins(usdcCoin, [tx.pure.u64(amount)]);
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [suiOut, usdcSwapChange, deepChange] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
      typeArguments: [SUI_TYPE, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        usdcForSwap, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    tx.transferObjects([suiOut, usdcSwapChange, usdcCoin, deepChange], tx.pure.address(walletAddress));
    return {
      txBytes: await tx.build({ client: transport as never }),
      fromSymbol: 'USDC',
      toSymbol: 'SUI',
    };
  }

  throw new Error('Self-swap only supports SUI and USDC');
}

// ─── Bluefin CLMM swap (USDC ↔ XAUM) ──────────────────────────────
const BF_XAUM_USDC_POOL = '0x458fc3722cc88babd7cbe78273aa5e4ecbdff75c76a2ad14cd1f75418b569649';
const XAUM_TYPE = '0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM';
// Bluefin CLMM sqrt price limits — use the absolute bounds (tick math min/max)
const BF_MIN_SQRT_PRICE = 4295048017n;   // MIN + 1
const BF_MAX_SQRT_PRICE = 79226673515401279992447579054n; // MAX - 1

export interface SwapResult {
  txBytes: Uint8Array;
  fromSymbol: string;
  toSymbol: string;
}

/**
 * Build a swap PTB: input coinType → output coinType.
 * Supports SUI→USDC, USDC→SUI (DeepBook), and SUI/USDC→XAUM (DeepBook+Bluefin).
 */
export async function buildSwapTx(
  rawAddress: string,
  inputCoinType: string,
  outputCoinType: string,
  amount: bigint,
): Promise<SwapResult> {
  // Same token — no swap needed
  if (inputCoinType === outputCoinType) throw new Error('Input and output are the same token');

  const USDC_TYPE = mainPackage.mainnet.coins.USDC.type;

  // SUI↔USDC: delegate to existing buildSelfSwapTx
  if ((inputCoinType === SUI_TYPE && outputCoinType === USDC_TYPE) ||
      (inputCoinType === USDC_TYPE && outputCoinType === SUI_TYPE)) {
    return buildSelfSwapTx(rawAddress, inputCoinType, amount);
  }

  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = gqlClient;
  const tx = new Transaction();
  tx.setSender(walletAddress);

  // NS → USDC (DeepBook: NS is base, USDC is quote)
  if (inputCoinType === mainPackage.mainnet.coins.NS.type && outputCoinType === USDC_TYPE) {
    const nsCoins = await listCoinsOfType(transport, walletAddress, inputCoinType);
    if (!nsCoins.length) throw new Error('No NS found');
    const nsCoin = tx.objectRef(nsCoins[0]);
    if (nsCoins.length > 1) tx.mergeCoins(nsCoin, nsCoins.slice(1).map(c => tx.objectRef(c)));
    const [nsForSwap] = tx.splitCoins(nsCoin, [tx.pure.u64(amount)]);
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const dbResult = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [inputCoinType, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_NS_USDC_POOL, initialSharedVersion: DB_NS_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        nsForSwap, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    tx.transferObjects([dbResult[0], dbResult[1], dbResult[2], nsCoin], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'NS', toSymbol: 'USDC' };
  }

  // WAL → USDC (DeepBook: WAL is base, USDC is quote)
  if (inputCoinType === WAL_TYPE && outputCoinType === USDC_TYPE) {
    const walCoins = await listCoinsOfType(transport, walletAddress, inputCoinType);
    if (!walCoins.length) throw new Error('No WAL found');
    const walCoin = tx.objectRef(walCoins[0]);
    if (walCoins.length > 1) tx.mergeCoins(walCoin, walCoins.slice(1).map(c => tx.objectRef(c)));
    const [walForSwap] = tx.splitCoins(walCoin, [tx.pure.u64(amount)]);
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const dbResult = tx.moveCall({
      target: `${DB2_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [WAL_TYPE, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_WAL_USDC_POOL, initialSharedVersion: DB_WAL_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        walForSwap, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    tx.transferObjects([dbResult[0], dbResult[1], dbResult[2], walCoin], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'WAL', toSymbol: 'USDC' };
  }

  // USDC → XAUM (single Bluefin hop)
  if (inputCoinType === USDC_TYPE && outputCoinType === XAUM_TYPE) {
    const usdcCoins = await listCoinsOfType(transport, walletAddress, USDC_TYPE);
    if (!usdcCoins.length) throw new Error('No USDC found');
    const usdcCoin = tx.objectRef(usdcCoins[0]);
    if (usdcCoins.length > 1) tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map(c => tx.objectRef(c)));
    const [usdcForSwap] = tx.splitCoins(usdcCoin, [tx.pure.u64(amount)]);

    // Pool tokens: X=XAUM, Y=USDC. Swapping USDC→XAUM = Y→X = swapXtoY=false
    const [usdcBal] = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [USDC_TYPE], arguments: [usdcForSwap] });
    const [zeroBal] = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [XAUM_TYPE] });
    const [balOutX, balOutY] = tx.moveCall({
      target: `${BF_PACKAGE}::pool::swap`,
      typeArguments: [XAUM_TYPE, USDC_TYPE],
      arguments: [
        tx.object('0x6'), // clock
        tx.object(BF_GLOBAL_CONFIG),
        tx.object(BF_XAUM_USDC_POOL),
        zeroBal,   // coinX balance in (zero — we're not providing XAUM)
        usdcBal,   // coinY balance in (USDC)
        tx.pure.bool(false), // swapXtoY = false (Y→X)
        tx.pure.bool(true),  // by_amount_in
        tx.pure.u64(amount),
        tx.pure.u64(0), // min out
        tx.pure.u128(BF_MAX_SQRT_PRICE), // sqrt price limit for Y→X
      ],
    });
    const [xaumCoin] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [XAUM_TYPE], arguments: [balOutX] });
    const [usdcDust] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [USDC_TYPE], arguments: [balOutY] });
    tx.transferObjects([xaumCoin, usdcDust, usdcCoin], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'USDC', toSymbol: 'XAUM' };
  }

  // SUI → XAUM (DeepBook SUI→USDC, then Bluefin USDC→XAUM)
  if (inputCoinType === SUI_TYPE && outputCoinType === XAUM_TYPE) {
    // Step 1: SUI → USDC via DeepBook
    const [suiPayment] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const dbResult = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [SUI_TYPE, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        suiPayment, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    const suiChange = dbResult[0];  // Coin<Base=SUI> change
    const usdcFromDb = dbResult[1]; // Coin<Quote=USDC> out
    const deepChange = dbResult[2]; // Coin<DEEP>

    // Get USDC amount for Bluefin swap (use all of it)
    const [usdcBal] = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [USDC_TYPE], arguments: [usdcFromDb] });
    const [usdcBalValue] = tx.moveCall({ target: '0x2::balance::value', typeArguments: [USDC_TYPE], arguments: [usdcBal] });
    const [zeroBal] = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [XAUM_TYPE] });

    // Step 2: USDC → XAUM via Bluefin CLMM
    const [balOutX, balOutY] = tx.moveCall({
      target: `${BF_PACKAGE}::pool::swap`,
      typeArguments: [XAUM_TYPE, USDC_TYPE],
      arguments: [
        tx.object('0x6'),
        tx.object(BF_GLOBAL_CONFIG),
        tx.object(BF_XAUM_USDC_POOL),
        zeroBal,
        usdcBal,
        tx.pure.bool(false),
        tx.pure.bool(true),
        usdcBalValue,
        tx.pure.u64(0),
        tx.pure.u128(BF_MAX_SQRT_PRICE),
      ],
    });
    const [xaumCoin] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [XAUM_TYPE], arguments: [balOutX] });
    const [usdcDust] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [USDC_TYPE], arguments: [balOutY] });
    tx.transferObjects([xaumCoin, usdcDust, suiChange, deepChange], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'SUI', toSymbol: 'XAUM' };
  }

  // XAUM → USDC (single Bluefin hop, X→Y)
  if (inputCoinType === XAUM_TYPE && outputCoinType === USDC_TYPE) {
    const xaumCoins = await listCoinsOfType(transport, walletAddress, XAUM_TYPE);
    if (!xaumCoins.length) throw new Error('No XAUM found');
    const xaumCoin = tx.objectRef(xaumCoins[0]);
    if (xaumCoins.length > 1) tx.mergeCoins(xaumCoin, xaumCoins.slice(1).map(c => tx.objectRef(c)));
    const [xaumForSwap] = tx.splitCoins(xaumCoin, [tx.pure.u64(amount)]);

    const [xaumBal] = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [XAUM_TYPE], arguments: [xaumForSwap] });
    const [zeroUsdcBal] = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [USDC_TYPE] });
    const [balOutX, balOutY] = tx.moveCall({
      target: `${BF_PACKAGE}::pool::swap`,
      typeArguments: [XAUM_TYPE, USDC_TYPE],
      arguments: [
        tx.object('0x6'),
        tx.object(BF_GLOBAL_CONFIG),
        tx.object(BF_XAUM_USDC_POOL),
        xaumBal, zeroUsdcBal,
        tx.pure.bool(true), tx.pure.bool(true),
        tx.pure.u64(amount), tx.pure.u64(0),
        tx.pure.u128(BF_MIN_SQRT_PRICE),
      ],
    });
    const [xaumDust] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [XAUM_TYPE], arguments: [balOutX] });
    const [usdcOut] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [USDC_TYPE], arguments: [balOutY] });
    tx.transferObjects([usdcOut, xaumDust, xaumCoin], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'XAUM', toSymbol: 'USDC' };
  }

  // XAUM → SUI (Bluefin XAUM→USDC, then DeepBook USDC→SUI)
  if (inputCoinType === XAUM_TYPE && outputCoinType === SUI_TYPE) {
    const xaumCoins = await listCoinsOfType(transport, walletAddress, XAUM_TYPE);
    if (!xaumCoins.length) throw new Error('No XAUM found');
    const xaumCoin = tx.objectRef(xaumCoins[0]);
    if (xaumCoins.length > 1) tx.mergeCoins(xaumCoin, xaumCoins.slice(1).map(c => tx.objectRef(c)));
    const [xaumForSwap] = tx.splitCoins(xaumCoin, [tx.pure.u64(amount)]);

    // Step 1: XAUM → USDC via Bluefin
    const [xaumBal] = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [XAUM_TYPE], arguments: [xaumForSwap] });
    const [zeroUsdcBal] = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [USDC_TYPE] });
    const [balOutX, balOutY] = tx.moveCall({
      target: `${BF_PACKAGE}::pool::swap`,
      typeArguments: [XAUM_TYPE, USDC_TYPE],
      arguments: [
        tx.object('0x6'),
        tx.object(BF_GLOBAL_CONFIG),
        tx.object(BF_XAUM_USDC_POOL),
        xaumBal, zeroUsdcBal,
        tx.pure.bool(true), tx.pure.bool(true),
        tx.pure.u64(amount), tx.pure.u64(0),
        tx.pure.u128(BF_MIN_SQRT_PRICE),
      ],
    });
    const [xaumDust] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [XAUM_TYPE], arguments: [balOutX] });
    const [usdcCoin] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [USDC_TYPE], arguments: [balOutY] });

    // Step 2: USDC → SUI via DeepBook
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const dbResult = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
      typeArguments: [SUI_TYPE, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        usdcCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    tx.transferObjects([dbResult[0], dbResult[1], dbResult[2], xaumDust, xaumCoin], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'XAUM', toSymbol: 'SUI' };
  }

  // IKA ↔ SUI via Cetus CLMM (IKA/SUI pool — SUI is coinX, IKA is coinY)
  const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
  const CETUS_ROUTER = '0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d';
  const CETUS_GLOBAL_CONFIG = '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
  const CETUS_IKA_SUI_POOL = '0xc23e7e8a74f0b18af4dfb7c3280e2a56916ec4d41e14416f85184a8aab6b7789';
  const CETUS_MIN_SQRT = '4295048016';
  const CETUS_MAX_SQRT = '79226673515401279992447579055';

  // Pool is Pool<IKA, SUI> — IKA is coinA, SUI is coinB
  // IKA→SUI = a_to_b (selling IKA for SUI)
  // SUI→IKA = !a_to_b (buying IKA with SUI)

  if (inputCoinType === IKA_TYPE && outputCoinType === SUI_TYPE) {
    // IKA → SUI: a_to_b = true
    const ikaCoins = await listCoinsOfType(transport, walletAddress, IKA_TYPE);
    if (!ikaCoins.length) throw new Error('No IKA found');
    const ikaCoin = tx.objectRef(ikaCoins[0]);
    if (ikaCoins.length > 1) tx.mergeCoins(ikaCoin, ikaCoins.slice(1).map(c => tx.objectRef(c)));
    const [ikaForSwap] = tx.splitCoins(ikaCoin, [tx.pure.u64(amount)]);
    const [zeroSui] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [SUI_TYPE] });
    const [ikaValue] = tx.moveCall({ target: '0x2::coin::value', typeArguments: [IKA_TYPE], arguments: [ikaForSwap] });
    const [receiveA, receiveB] = tx.moveCall({
      target: `${CETUS_ROUTER}::router::swap`,
      typeArguments: [IKA_TYPE, SUI_TYPE],
      arguments: [
        tx.object(CETUS_GLOBAL_CONFIG), tx.object(CETUS_IKA_SUI_POOL),
        ikaForSwap, zeroSui,
        tx.pure.bool(true), tx.pure.bool(true), ikaValue,
        tx.pure.u128(CETUS_MIN_SQRT), tx.pure.bool(false), tx.object('0x6'),
      ],
    });
    // receiveA = IKA dust, receiveB = SUI out
    tx.transferObjects([receiveA, receiveB, ikaCoin], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'IKA', toSymbol: 'SUI' };
  }

  if (inputCoinType === SUI_TYPE && outputCoinType === IKA_TYPE) {
    // SUI → IKA: a_to_b = false (buying IKA with SUI)
    const [suiForSwap] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    const [zeroIka] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [IKA_TYPE] });
    const [suiValue] = tx.moveCall({ target: '0x2::coin::value', typeArguments: [SUI_TYPE], arguments: [suiForSwap] });
    const [receiveA, receiveB] = tx.moveCall({
      target: `${CETUS_ROUTER}::router::swap`,
      typeArguments: [IKA_TYPE, SUI_TYPE],
      arguments: [
        tx.object(CETUS_GLOBAL_CONFIG), tx.object(CETUS_IKA_SUI_POOL),
        zeroIka, suiForSwap,
        tx.pure.bool(false), tx.pure.bool(true), suiValue,
        tx.pure.u128(CETUS_MAX_SQRT), tx.pure.bool(false), tx.object('0x6'),
      ],
    });
    // receiveA = IKA out, receiveB = SUI dust
    tx.transferObjects([receiveA, receiveB], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'SUI', toSymbol: 'IKA' };
  }

  if (inputCoinType === IKA_TYPE && outputCoinType === USDC_TYPE) {
    // IKA → USDC: two hops — IKA→SUI via Cetus, then SUI→USDC via DeepBook
    const ikaCoins = await listCoinsOfType(transport, walletAddress, IKA_TYPE);
    if (!ikaCoins.length) throw new Error('No IKA found');
    const ikaCoin = tx.objectRef(ikaCoins[0]);
    if (ikaCoins.length > 1) tx.mergeCoins(ikaCoin, ikaCoins.slice(1).map(c => tx.objectRef(c)));
    const [ikaForSwap] = tx.splitCoins(ikaCoin, [tx.pure.u64(amount)]);
    // Step 1: IKA → SUI via Cetus (a_to_b = true)
    const [zeroSui] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [SUI_TYPE] });
    const [ikaValue] = tx.moveCall({ target: '0x2::coin::value', typeArguments: [IKA_TYPE], arguments: [ikaForSwap] });
    const [ikaDust, suiFromCetus] = tx.moveCall({
      target: `${CETUS_ROUTER}::router::swap`,
      typeArguments: [IKA_TYPE, SUI_TYPE],
      arguments: [
        tx.object(CETUS_GLOBAL_CONFIG), tx.object(CETUS_IKA_SUI_POOL),
        ikaForSwap, zeroSui,
        tx.pure.bool(true), tx.pure.bool(true), ikaValue,
        tx.pure.u128(CETUS_MIN_SQRT), tx.pure.bool(false), tx.object('0x6'),
      ],
    });
    // Step 2: SUI → USDC via DeepBook
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const dbResult = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [SUI_TYPE, USDC_TYPE],
      arguments: [
        tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
        suiFromCetus, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
      ],
    });
    tx.transferObjects([dbResult[0], dbResult[1], dbResult[2], ikaDust, ikaCoin], tx.pure.address(walletAddress));
    return { txBytes: await tx.build({ client: transport as never }), fromSymbol: 'IKA', toSymbol: 'USDC' };
  }

  // Generic fallback: discover route via Bluefin aggregator, build PTB for single-hop swaps
  const AGG_URL = 'https://aggregator.api.sui-prod.bluefin.io';
  const AGG_SOURCES = 'deepbook_v3,bluefin,cetus,aftermath,flowx,flowx_v3,kriya,kriya_v3,turbos';

  // DEX configs for building PTBs from aggregator routes
  const DEX_CONFIGS: Record<string, { package: string; globalConfig: string; fn: string; coinArgs: 'coin' | 'balance' }> = {
    cetus:   { package: '0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d', globalConfig: '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f', fn: 'router::swap', coinArgs: 'coin' },
    bluefin: { package: BF_PACKAGE, globalConfig: BF_GLOBAL_CONFIG, fn: 'pool::swap', coinArgs: 'balance' },
  };

  try {
    const params = new URLSearchParams({ amount: String(amount), from: inputCoinType, to: outputCoinType, sources: AGG_SOURCES });
    const quoteRes = await fetch(`${AGG_URL}/v2/quote?${params}`);
    if (!quoteRes.ok) throw new Error('No route found');
    const quote = await quoteRes.json() as { routes?: Array<{ hops: Array<{ poolId: string; pool: { type: string; allTokens: Array<{ address: string }> }; tokenIn: string; tokenOut: string }> }> };

    // Use the first single-hop route if available
    const singleHop = quote.routes?.find(r => r.hops.length === 1);
    if (singleHop) {
      const hop = singleHop.hops[0];
      const dexType = hop.pool.type;
      const dex = DEX_CONFIGS[dexType];
      const [coinX, coinY] = hop.pool.allTokens.map(t => t.address);
      const swapXtoY = hop.tokenIn === coinX;

      if (dex) {
        const coins = await listCoinsOfType(transport, walletAddress, inputCoinType);
        if (!coins.length) throw new Error(`No ${inputCoinType.split('::').pop()} found`);
        const coinObj = tx.objectRef(coins[0]);
        if (coins.length > 1) tx.mergeCoins(coinObj, coins.slice(1).map(c => tx.objectRef(c)));
        const [coinForSwap] = tx.splitCoins(coinObj, [tx.pure.u64(amount)]);

        if (dex.coinArgs === 'coin') {
          // Cetus-style: takes Coin objects directly
          const [zeroCoin] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [outputCoinType] });
          const [coinValue] = tx.moveCall({ target: '0x2::coin::value', typeArguments: [inputCoinType], arguments: [coinForSwap] });
          const [receiveA, receiveB] = tx.moveCall({
            target: `${dex.package}::${dex.fn}`,
            typeArguments: [coinX, coinY],
            arguments: [
              tx.object(dex.globalConfig), tx.object(hop.poolId),
              swapXtoY ? coinForSwap : zeroCoin, swapXtoY ? zeroCoin : coinForSwap,
              tx.pure.bool(swapXtoY), tx.pure.bool(true), coinValue,
              tx.pure.u128(swapXtoY ? BF_MIN_SQRT_PRICE : BF_MAX_SQRT_PRICE),
              tx.pure.bool(false), tx.object('0x6'),
            ],
          });
          tx.transferObjects([receiveA, receiveB, coinObj], tx.pure.address(walletAddress));
        } else {
          // Bluefin-style: takes Balance objects
          const [inBal] = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [inputCoinType], arguments: [coinForSwap] });
          const [zeroBal] = tx.moveCall({ target: '0x2::balance::zero', typeArguments: [outputCoinType] });
          const [balOutX, balOutY] = tx.moveCall({
            target: `${dex.package}::${dex.fn}`,
            typeArguments: [coinX, coinY],
            arguments: [
              tx.object('0x6'), tx.object(dex.globalConfig), tx.object(hop.poolId),
              swapXtoY ? inBal : zeroBal, swapXtoY ? zeroBal : inBal,
              tx.pure.bool(swapXtoY), tx.pure.bool(true), tx.pure.u64(amount), tx.pure.u64(0),
              tx.pure.u128(swapXtoY ? BF_MIN_SQRT_PRICE : BF_MAX_SQRT_PRICE),
            ],
          });
          const [coinOutX] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [coinX], arguments: [balOutX] });
          const [coinOutY] = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [coinY], arguments: [balOutY] });
          tx.transferObjects([coinOutX, coinOutY, coinObj], tx.pure.address(walletAddress));
        }
        return { txBytes: await tx.build({ client: transport as never }), fromSymbol: inputCoinType.split('::').pop()!, toSymbol: outputCoinType.split('::').pop()! };
      }
    }
  } catch (e) {
    // Route discovery failed — fall through to error
    if (e instanceof Error && e.message !== 'No route found') throw e;
  }

  throw new Error(`Swap from ${inputCoinType.split('::').pop()} to ${outputCoinType.split('::').pop()} is not supported`);
}

// ─── Send tokens to an address ──────────────────────────────────────

export async function buildSendTx(
  senderAddress: string,
  recipientAddress: string,
  coinType: string,
  amount: bigint,
): Promise<Uint8Array> {
  const sender = normalizeSuiAddress(senderAddress);
  const recipient = normalizeSuiAddress(recipientAddress);
  if (sender === recipient) throw new Error('Recipient matches sender');
  const transport = gqlClient;
  const tx = new Transaction();
  tx.setSender(sender);

  if (coinType === SUI_TYPE) {
    // SUI: split from gas coin
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    tx.transferObjects([coin], tx.pure.address(recipient));
  } else {
    // Other tokens: fetch coins, merge, split, transfer
    const coins = await listCoinsOfType(transport, sender, coinType);
    if (!coins.length) throw new Error('No coins found for this token');
    const totalBalance = coins.reduce((s, c) => s + c.balance, 0n);
    if (totalBalance < amount) throw new Error('Insufficient token balance');

    const primaryCoin = tx.objectRef(coins[0]);
    if (coins.length > 1) {
      tx.mergeCoins(primaryCoin, coins.slice(1).map(c => tx.objectRef(c)));
    }
    const [sendCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amount)]);
    tx.transferObjects([sendCoin], tx.pure.address(recipient));
    tx.transferObjects([primaryCoin], tx.pure.address(sender)); // return remainder
  }

  return tx.build({ client: transport as never });
}
