/**
 * Compile contracts/offchain-resolver/OffchainResolver.sol with solc-js
 * and write the deploy artifacts to dist/offchain-resolver-deploy.json.
 *
 * Output: bytecode (creation init code), ABI, source hash. Used by the
 * deploy helper to construct the deploy tx.
 */
import solc from 'solc';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sourcePath = resolve(repoRoot, 'contracts/offchain-resolver/OffchainResolver.sol');
const outDir = resolve(repoRoot, 'contracts/offchain-resolver/dist');
const outPath = resolve(outDir, 'OffchainResolver.json');

const source = readFileSync(sourcePath, 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');

const input = {
  language: 'Solidity',
  sources: {
    'OffchainResolver.sol': { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai', // safe across mainnet + L2s
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
      },
    },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length > 0) {
  console.error('Solidity errors:');
  for (const e of errs) console.error(`  ${e.formattedMessage || e.message}`);
  process.exit(1);
}
const warnings = (out.errors || []).filter((e) => e.severity === 'warning');
if (warnings.length > 0) {
  console.error('Solidity warnings:');
  for (const w of warnings) console.error(`  ${w.formattedMessage || w.message}`);
}

const c = out.contracts['OffchainResolver.sol']?.OffchainResolver;
if (!c) {
  console.error('OffchainResolver contract not found in output');
  console.error(JSON.stringify(Object.keys(out.contracts), null, 2));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const artifact = {
  contractName: 'OffchainResolver',
  source_hash_sha256: sourceHash,
  compiler: {
    version: solc.version(),
    settings: input.settings,
  },
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
  deployedBytecode: '0x' + c.evm.deployedBytecode.object,
};
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

console.log(`✓ compiled OffchainResolver`);
console.log(`  source sha256: ${sourceHash}`);
console.log(`  solc:          ${solc.version()}`);
console.log(`  bytecode:      ${(artifact.bytecode.length - 2) / 2} bytes`);
console.log(`  written to:    ${outPath}`);
