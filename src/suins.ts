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

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';

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
