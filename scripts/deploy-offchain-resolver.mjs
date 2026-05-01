/**
 * Deploys OffchainResolver.sol to Ethereum mainnet using whelm.eth's wallet
 * private key supplied via WHELM_DEPLOY_PRIVATE_KEY env var (NEVER commit
 * this; the key is only used here, never on Cloudflare Workers).
 *
 * Then calls ENS.setResolver(namehash('whelm.eth'), <deployedAddr>).
 *
 * Output: prints the deployed resolver address + both tx hashes.
 *
 * Usage (from a machine you trust, NOT the Worker):
 *
 *   WHELM_DEPLOY_PRIVATE_KEY=0x... \
 *   ETH_RPC_URL=https://ethereum-rpc.publicnode.com \
 *   bun scripts/deploy-offchain-resolver.mjs
 *
 * Constructor args computed from project memory:
 *   _url     = "https://passki.xyz/ens-resolver/{sender}/{data}.json"
 *   _signers = [
 *     "0xe7AC32BfF3B1A0af5F3E9a0c9E44A1E0B4e3De0a11",  // worker hot signer
 *     "0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d",   // ultron's IKA EVM addr
 *   ]
 */
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  http,
  namehash,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const artifactPath = resolve(repoRoot, 'contracts/offchain-resolver/dist/OffchainResolver.json');

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ENS_NAMEWRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
const WHELM_NODE = namehash('whelm.eth');

// Constructor args
const GATEWAY_URL = 'https://passki.xyz/ens-resolver/{sender}/{data}.json';
const SIGNER_HOT = '0xe7AC32BfF3B1A0af5F3E9a0c9E44A1E0B4e3De0a11'; // worker signer
const SIGNER_ULTRON = '0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d'; // ultron IKA EVM addr

const ENS_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'setResolver',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
    ],
    outputs: [],
  },
];

const NAMEWRAPPER_ABI = [
  {
    type: 'function',
    name: 'setResolver',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
];

async function main() {
  const privKey = process.env.WHELM_DEPLOY_PRIVATE_KEY;
  if (!privKey || !privKey.startsWith('0x') || privKey.length !== 66) {
    console.error('WHELM_DEPLOY_PRIVATE_KEY env var missing or malformed (expect 0x + 32 bytes hex)');
    process.exit(1);
  }
  const rpcUrl = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com';

  const account = privateKeyToAccount(privKey);
  console.log(`Deployer wallet: ${account.address}`);

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  const wallet = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  // Sanity: deployer must own whelm.eth via the NameWrapper.
  const owner = await publicClient.readContract({
    address: ENS_NAMEWRAPPER as Address,
    abi: NAMEWRAPPER_ABI,
    functionName: 'ownerOf',
    args: [BigInt(WHELM_NODE)],
  }) as Address;
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`whelm.eth owner is ${owner}, but deployer is ${account.address}.`);
    console.error('Send ETH to the actual whelm.eth owner, then run from that wallet.');
    process.exit(1);
  }
  console.log(`✓ confirmed deployer owns whelm.eth via NameWrapper`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`balance: ${Number(balance) / 1e18} ETH`);
  if (balance < parseEther('0.005')) {
    console.error(`balance below 0.005 ETH — deploy may fail. Top up first.`);
    process.exit(1);
  }

  // ---- 1. Deploy
  console.log(`\n[1/2] deploying OffchainResolver to mainnet...`);
  console.log(`  url:     ${GATEWAY_URL}`);
  console.log(`  signers: [${SIGNER_HOT}, ${SIGNER_ULTRON}]`);

  const deployData = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args: [GATEWAY_URL, [SIGNER_HOT, SIGNER_ULTRON]],
  });

  const deployTxHash = await wallet.sendTransaction({ data: deployData });
  console.log(`  tx: ${deployTxHash}`);
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (deployReceipt.status !== 'success' || !deployReceipt.contractAddress) {
    console.error(`deploy failed: ${JSON.stringify(deployReceipt)}`);
    process.exit(1);
  }
  const resolverAddress = deployReceipt.contractAddress;
  console.log(`✓ deployed at ${resolverAddress}`);

  // ---- 2. setResolver via NameWrapper (whelm.eth is wrapped)
  console.log(`\n[2/2] binding whelm.eth → ${resolverAddress} via NameWrapper.setResolver...`);
  const bindTxHash = await wallet.writeContract({
    address: ENS_NAMEWRAPPER as Address,
    abi: NAMEWRAPPER_ABI,
    functionName: 'setResolver',
    args: [WHELM_NODE, resolverAddress],
  });
  console.log(`  tx: ${bindTxHash}`);
  const bindReceipt = await publicClient.waitForTransactionReceipt({ hash: bindTxHash });
  if (bindReceipt.status !== 'success') {
    console.error(`bind failed: ${JSON.stringify(bindReceipt)}`);
    process.exit(1);
  }
  console.log(`✓ whelm.eth resolver is now ${resolverAddress}`);

  console.log(`\n=== DONE ===`);
  console.log(`OffchainResolver:  ${resolverAddress}`);
  console.log(`Deploy tx:         ${deployTxHash}`);
  console.log(`Bind tx:           ${bindTxHash}`);
  console.log(`\nVerify:`);
  console.log(`  curl -s https://passki.xyz/api/ens-signer-address  # should match ${SIGNER_HOT.toLowerCase()}`);
  console.log(`  Open MetaMask, paste 'ultron.whelm.eth' as recipient — should resolve to 0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
