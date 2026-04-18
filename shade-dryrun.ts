import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuinsClient, SuinsTransaction, mainPackage } from '@mysten/suins';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const SHADE_PACKAGE = '0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203';

const ORDER_OBJ = '0xc22c26d80bca2792ec4b34041e53614e551a3ab2178e1ac8ff083e7521739940';
const DOMAIN = 'ignite';
const EXECUTE_AFTER_MS = 1772683540687;
const TARGET = '0x2b3524ebf158c4b01f482c6d687d8ba0d922deaec04c3b495926d73cb0a7ee28';
const SALT = 'bc80cdd55a6cfa505c39729ed333baaefce214f8b73b3dba9f856f29f7f07407';
const KEEPER_KEY = (process.env.ULTRON_PRIVATE_KEY || process.env.SHADE_KEEPER_PRIVATE_KEY)!;
if (!KEEPER_KEY) {
  console.error('Set ULTRON_PRIVATE_KEY (or legacy SHADE_KEEPER_PRIVATE_KEY)');
  process.exit(1);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function main() {
  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  const keypair = Ed25519Keypair.fromSecretKey(KEEPER_KEY);
  const keeperAddress = keypair.toSuiAddress();
  console.log('Keeper:', keeperAddress);

  const tx = new Transaction();
  tx.setSender(keeperAddress);

  // 1. shade::execute
  const domainBytes = Array.from(new TextEncoder().encode(DOMAIN));
  const saltBytes = Array.from(hexToBytes(SALT));
  const [releasedCoin] = tx.moveCall({
    target: `${SHADE_PACKAGE}::shade::execute`,
    arguments: [
      tx.object(ORDER_OBJ),
      tx.pure.vector('u8', domainBytes),
      tx.pure.u64(EXECUTE_AFTER_MS),
      tx.pure.address(TARGET),
      tx.pure.vector('u8', saltBytes),
      tx.object.clock(),
    ],
  });

  // 2. Pyth update for SUI price
  const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
    tx, mainPackage.mainnet.coins.SUI.feed, tx.gas,
  );
  console.log('PriceInfoObjectId:', priceInfoObjectId);

  // 3. Register with SUI
  const fullDomain = `${DOMAIN}.sui`;
  const suinsTx = new SuinsTransaction(suinsClient, tx);
  const nft = suinsTx.register({
    domain: fullDomain,
    years: 1,
    coinConfig: mainPackage.mainnet.coins.SUI,
    coin: releasedCoin,
    priceInfoObjectId,
  });
  suinsTx.setTargetAddress({ nft, address: TARGET });
  suinsTx.setDefault(fullDomain);
  tx.transferObjects([nft], tx.pure.address(TARGET));
  tx.transferObjects([releasedCoin], tx.pure.address(TARGET));

  console.log('Building transaction...');
  try {
    const bytes = await tx.build({ client: transport as never });
    console.log('SUCCESS! Built', bytes.length, 'bytes');
  } catch (err) {
    console.error('BUILD FAILED:', err);
  }
}

main().catch(console.error);
