/**
 * Sub-cent Phase 3b — client bundle builder dry run.
 *
 * Exercises `buildEmptyBundleTx` from `src/client/openclob-bundle.ts`
 * against mainnet so we can prove the shared client PTB pipeline
 * lands the same OrderBundle + OrderBundleCap pair as the hand-rolled
 * `scripts/bundle-dryrun.ts`. Does NOT walk the full
 * create→record→mark→settle lifecycle — `scripts/bundle-lifecycle.ts`
 * already covers that once Phase 3c wires the real DeepBook calls.
 *
 * Usage (manual, do NOT run in CI):
 *   bun run scripts/bundle-client-dryrun.ts
 *
 * The script loads the first Ed25519 key in ~/.sui/sui_config/sui.keystore
 * that matches `ACTIVE_ADDR`, builds an empty bundle with the active
 * address as creator + recipient, signs + submits via the
 * `sui-rpc.publicnode.com` fallback endpoint, and prints the created
 * bundle + cap object IDs on success.
 *
 * Refs:
 *   - docs/superpowers/specs/2026-04-11-openclob-bundle-tags.md
 *   - src/client/openclob-bundle.ts
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { readFileSync } from 'fs';

import { buildEmptyBundleTx } from '../src/client/openclob-bundle.js';

// Match `scripts/bundle-dryrun.ts` — the active local Sui address.
const ACTIVE_ADDR = '0x3db42086e9271787046859d60af7933fa7ea70148df37c9fd693195533eabb57';

function loadKeyFor(addr: string): Ed25519Keypair {
  const keystore = JSON.parse(
    readFileSync('/home/brandon/.sui/sui_config/sui.keystore', 'utf-8'),
  ) as string[];
  for (const b64 of keystore) {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes[0] !== 0) continue; // ed25519 only
    const candidate = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (candidate.toSuiAddress() === addr) return candidate;
  }
  throw new Error(`No matching ed25519 key for ${addr}`);
}

async function main() {
  const kp = loadKeyFor(ACTIVE_ADDR);
  const sender = kp.toSuiAddress();
  console.log('sender:', sender);

  const deadlineMs = Date.now() + 10 * 60 * 1000;
  const { txBytes, tag } = await buildEmptyBundleTx({
    creator: sender,
    settleDeadlineMs: deadlineMs,
    targetCount: 1,
  });
  console.log('tag:', tag);
  console.log('deadline:', new Date(deadlineMs).toISOString());

  const { signature } = await kp.signTransaction(txBytes);
  const b64 = Buffer.from(txBytes).toString('base64');

  const res = await fetch('https://sui-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sui_executeTransactionBlock',
      params: [
        b64,
        [signature],
        { showEffects: true, showObjectChanges: true },
        'WaitForLocalExecution',
      ],
    }),
  });

  const j = (await res.json()) as {
    error?: unknown;
    result?: {
      digest?: string;
      effects?: { status?: { status?: string; error?: string } };
      objectChanges?: Array<{ type?: string; objectType?: string; objectId?: string }>;
    };
  };

  if (j.error) {
    console.error('RPC error:', j.error);
    process.exit(1);
  }

  console.log('digest:', j.result?.digest);
  console.log('status:', j.result?.effects?.status);

  const created = (j.result?.objectChanges ?? []).filter((c) => c.type === 'created');
  let bundleId: string | undefined;
  let capId: string | undefined;
  for (const c of created) {
    const t = c.objectType ?? '';
    if (t.endsWith('::bundle::OrderBundle')) bundleId = c.objectId;
    if (t.endsWith('::bundle::OrderBundleCap')) capId = c.objectId;
    console.log('created:', t, c.objectId);
  }

  if (bundleId) console.log('OrderBundle:', bundleId);
  if (capId) console.log('OrderBundleCap:', capId);
}

main().catch((err) => {
  console.error('bundle-client-dryrun failed:', err);
  process.exit(1);
});
