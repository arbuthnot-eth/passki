#!/usr/bin/env node
// Prints the x-treasury-auth token for admin routes (/api/cache/* writes,
// /api/iusd/mint, ...). Mirrors internalAuthToken() in src/server/ultron-key.ts.
//
//   INTERNAL_AUTH_SECRET=... node scripts/admin-token.mjs
//   ULTRON_PRIVATE_KEY=suiprivkey1... node scripts/admin-token.mjs
//
//   curl -X POST https://passki.xyz/api/cache/sweep-fees \
//     -H "x-treasury-auth: $(ULTRON_PRIVATE_KEY=... node scripts/admin-token.mjs)"
//
// The secret is read from the environment only; it is never printed.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const secret = process.env.INTERNAL_AUTH_SECRET ?? process.env.ULTRON_PRIVATE_KEY ?? process.env.SHADE_KEEPER_PRIVATE_KEY;
if (!secret) {
  console.error('Set INTERNAL_AUTH_SECRET (if configured on the Worker) or ULTRON_PRIVATE_KEY.');
  process.exit(1);
}
process.stdout.write(bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes('passki-internal-auth:v1'))) + '\n');
