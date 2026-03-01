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

async function listNsCoins(
  client: AnyTransportClient,
  owner: string,
): Promise<{ objectId: string }[]> {
  const { objects } = await client.listCoins({
    owner,
    coinType: mainPackage.mainnet.coins.NS.type,
  });
  return objects;
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

export async function buildRegisterSplashNsTx(rawAddress: string, domain = 'splash.sui'): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: GRPC_URL });

  // Try gRPC first; on any error fall back to GraphQL for the whole flow.
  let transport: AnyTransportClient = grpc;
  let coins: { objectId: string }[];

  try {
    coins = await listNsCoins(grpc, walletAddress);
  } catch {
    transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    coins = await listNsCoins(transport, walletAddress);
  }

  if (!coins.length) throw new Error('No NS tokens in wallet — acquire NS first');

  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  const tx = new Transaction();
  tx.setSender(walletAddress);
  const suinsTx = new SuinsTransaction(suinsClient, tx);

  // Add Pyth price-oracle calls to the tx and receive the price-info object IDs.
  // getPriceInfoObject returns string[] — the on-chain PriceInfo object IDs that
  // already exist on Sui (updated by the Pyth accumulator moves added above).
  // Pass tx.gas as feeCoin so Pyth splits its update fee from the gas coin via
  // splitCoins, avoiding the CoinWithBalance intent that WaaP cannot resolve.
  const priceInfoIds = await suinsClient.getPriceInfoObject(
    tx,
    mainPackage.mainnet.coins.NS.feed,
    tx.gas,
  );
  // priceInfoIds[0] is a string object ID; generateReceipt calls tx.object() on it.
  const priceInfoObjectId = priceInfoIds[0];

  // Register domain for 1 year, paying with the first NS coin.
  // maxAmount defaults to MAX_U64 inside handlePayment — no slippage guard needed
  // for a simple one-shot registration, but you may pass a bigint here if desired.
  const nft = suinsTx.register({
    domain,
    years: 1,
    coinConfig: mainPackage.mainnet.coins.NS,
    coin: coins[0].objectId,
    priceInfoObjectId,
  });

  // Set the name's target address to the connected wallet.
  suinsTx.setTargetAddress({ nft, address: walletAddress });

  // Set domain as the default reverse-lookup name for the wallet.
  suinsTx.setDefault(domain);

  // Deliver the SuinsRegistration NFT to the connected wallet.
  tx.transferObjects([nft], tx.pure.address(walletAddress));

  // Build to BCS bytes using our own transport client.
  //
  // WaaP's resolveTransactionBytes internally calls e.build({client}) where the
  // client it constructs comes from a bundled v1.x-compatible SuiClient whose
  // CoreClient.resolveTransactionPlugin() returns a v1 resolver (function j6)
  // that reads transactionData.gasConfig.price.  Our Transaction is @mysten/sui
  // v2.x which uses gasData, not gasConfig — so gasConfig is undefined and the
  // read of .price throws "Cannot read properties of undefined (reading 'price')".
  //
  // The fix: build to Uint8Array here with our own v2.x client.  WaaP's
  // resolveTransactionBytes treats a Uint8Array as an immediate pass-through
  // (its very first branch), so the broken build() path is never entered.
  return tx.build({ client: transport as never });
}
