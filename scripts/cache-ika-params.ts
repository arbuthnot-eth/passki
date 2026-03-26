#!/usr/bin/env bun
/**
 * One-time script: fetch and cache IKA protocol public parameters.
 * Takes 2-5 minutes due to 250+ sequential object fetches.
 * Run: bun scripts/cache-ika-params.ts
 * Output: public/ika-params-secp256k1.json
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { IkaClient, getNetworkConfig, Curve } from '@ika.xyz/sdk';

const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });
const client = new IkaClient({ config: getNetworkConfig('mainnet'), suiClient: grpc as any });

console.log('Fetching IKA protocol public parameters for SECP256K1...');
console.log('This may take 2-5 minutes (250+ objects to fetch).');
const start = Date.now();

try {
  const params = await client.getProtocolPublicParameters(undefined, Curve.SECP256K1);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s — ${params.length} bytes`);

  const fs = await import('fs');
  const outPath = 'public/ika-params-secp256k1.json';
  fs.writeFileSync(outPath, JSON.stringify(Array.from(params)));
  console.log(`Saved to ${outPath}`);
  console.log('Deploy with: bun run build && npx wrangler deploy');
} catch (e: any) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
