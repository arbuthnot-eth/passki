/**
 * Mint registration — Gholdengo Recover.
 *
 * Server-side SuiNS register helper signed by ultron's keypair. Pays NS
 * coin from ultron's pool (25% discount applied), sets the buyer as the
 * target address, and transfers the SuinsRegistration NFT to the buyer
 * so they own it.
 *
 * Settlement (pulling USDC on Base) is handled by the `Facilitator`
 * interface (see `./facilitator.ts`). DO NOT call `registerFromUltronPool`
 * directly from the x402 paywall — the right shape is:
 *
 *   1. Power Gem verifies X-PAYMENT signature locally
 *   2. Facilitator settles the EIP-3009 transferWithAuthorization on Base
 *      → USDC lands at ultron's IKA address
 *   3. ONLY then call `registerFromUltronPool`
 *
 * Until the facilitator integration is live, this helper is callable from
 * an admin-gated route for testing + manual execution.
 */

import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { SuinsClient, SuinsTransaction } from '@mysten/suins';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { ultronKeypair } from '../ultron-key.js';
import { suinsCfg, getSuinsNetwork } from '../../suins.js';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

interface UltronEnv {
  ULTRON_PRIVATE_KEY?: string;
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

export interface RegisterFromUltronPoolArgs {
  env: UltronEnv;
  bareName: string;
  years: number;
  /** Buyer's Sui address — becomes the SuiNS target + receives the NFT. */
  target: string;
}

export interface RegisterFromUltronPoolResult {
  ok: true;
  digest: string;
  /** SuinsRegistration NFT object id. */
  nft_id: string | null;
  domain: string;
  target: string;
  years: number;
}

interface NsCoin {
  objectId: string;
  version: string;
  digest: string;
  balance: bigint;
}

async function fetchUltronNsCoins(transport: SuiGraphQLClient, ultronAddress: string): Promise<NsCoin[]> {
  const nsType = suinsCfg().coins.NS.type;
  const query = `
    query($a: SuiAddress!, $t: String!) {
      address(address: $a) {
        coins(type: $t, first: 50) {
          nodes {
            address
            version
            digest
            contents { ...on MoveValue { json } }
          }
        }
      }
    }
  `;
  const res = (await transport.query({
    query,
    variables: { a: ultronAddress, t: nsType },
  })) as { data?: { address?: { coins?: { nodes?: Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }> } } } };
  const nodes = res.data?.address?.coins?.nodes || [];
  return nodes.map((n) => ({
    objectId: n.address,
    version: n.version,
    digest: n.digest,
    balance: BigInt(n.contents?.json?.balance ?? '0'),
  }));
}

/**
 * Build, sign (with ultron keypair), and execute a SuiNS register PTB
 * that pays NS from ultron's pool and assigns the buyer as the target.
 *
 * Throws if:
 *   - ultron has no NS coins (pool empty)
 *   - target is not a valid Sui address
 *   - bareName is invalid
 *   - SuiNS register tx fails on-chain
 */
export async function registerFromUltronPool(
  args: RegisterFromUltronPoolArgs,
): Promise<RegisterFromUltronPoolResult> {
  const { env, bareName, years, target } = args;
  if (!bareName || /[^a-z0-9-]/i.test(bareName)) {
    throw new Error(`invalid bareName "${bareName}"`);
  }
  if (!Number.isInteger(years) || years < 1 || years > 5) {
    throw new Error('years must be integer 1..5');
  }
  const buyerAddress = normalizeSuiAddress(target);

  const keypair = ultronKeypair(env);
  const ultronAddress = keypair.toSuiAddress();
  const domain = `${bareName.toLowerCase()}.sui`;

  const transport = new SuiGraphQLClient({ url: GQL_URL, network: getSuinsNetwork() });
  const suinsClient = new SuinsClient({ client: transport as never, network: getSuinsNetwork() });

  const nsCoins = await fetchUltronNsCoins(transport, ultronAddress);
  const totalNs = nsCoins.reduce((sum, c) => sum + c.balance, 0n);
  if (totalNs === 0n) {
    throw new Error(
      `ultron NS pool empty at ${ultronAddress}. Seed before registering.`,
    );
  }

  const tx = new Transaction();
  tx.setSender(ultronAddress);

  const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
    tx,
    suinsCfg().coins.NS.feed,
    tx.gas,
  );

  // Merge NS coins into one — SuiNS register pulls what it needs via Pyth oracle
  const nsCoin = tx.objectRef(nsCoins[0]);
  if (nsCoins.length > 1) {
    tx.mergeCoins(nsCoin, nsCoins.slice(1).map((c) => tx.objectRef(c)));
  }

  const suinsTx = new SuinsTransaction(suinsClient, tx);
  const nft = suinsTx.register({
    domain,
    years,
    coinConfig: suinsCfg().coins.NS,
    coin: nsCoin,
    priceInfoObjectId,
  });
  // Resolve to buyer
  suinsTx.setTargetAddress({ nft, address: buyerAddress });
  // Transfer NFT to buyer
  tx.transferObjects([nft], tx.pure.address(buyerAddress));
  // Send any NS remainder back to ultron
  tx.transferObjects([nsCoin], tx.pure.address(ultronAddress));

  const built = await tx.build({ client: transport as never });
  const sigResult = await keypair.signTransaction(built);
  const result = await (transport as never as {
    core: {
      executeTransaction: (
        b: Uint8Array,
        s: string[],
      ) => Promise<{
        digest: string;
        effects?: { status?: string; created?: Array<{ reference: { objectId: string }; owner: unknown; objectType?: string }> };
      }>;
    };
  }).core.executeTransaction(built, [sigResult.signature]);

  if (result.effects?.status && result.effects.status !== 'success') {
    throw new Error(`register tx failed on-chain: status=${result.effects.status}, digest=${result.digest}`);
  }

  // Find the SuinsRegistration NFT id from created objects (best-effort)
  const created = result.effects?.created ?? [];
  const nftEntry = created.find((c) =>
    typeof c.objectType === 'string' && c.objectType.includes('::suins_registration::SuinsRegistration'),
  );
  const nftId = nftEntry?.reference?.objectId ?? null;

  return {
    ok: true,
    digest: result.digest,
    nft_id: nftId,
    domain,
    target: buyerAddress,
    years,
  };
}
