/**
 * Recoverable root seed for a user's IKA share-encryption keys.
 *
 * The user's dWallet secret share is stored on-chain, encrypted to keys
 * derived from a 32-byte root seed (`UserShareEncryptionKeys.fromRootSeedKey`).
 * If that seed is lost, the share can never be decrypted and the dWallet
 * can never sign. So the seed must be re-derivable, without storing it.
 *
 * We derive it from a wallet signature over a fixed, address-bound message:
 *
 *     seed = sha256("passki-ika-user-share-seed:v1" ‖ signatureBytes)
 *
 * This only works if the wallet signs deterministically (Ed25519, or
 * RFC-6979 ECDSA). The first derivation in a session signs twice and
 * refuses to continue if the two signatures differ, before any DKG runs,
 * so a non-deterministic wallet can never produce an unrecoverable dWallet.
 *
 * Exposure: anyone who obtains this exact signature can decrypt the user
 * share. That alone cannot sign: IKA 2PC-MPC also needs the network's
 * share, and the network only signs messages approved via the
 * DWalletCap, which stays in the user's wallet.
 *
 * The seed is cached in memory only (never localStorage).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase64 } from '@mysten/sui/utils';

const SEED_DOMAIN = 'passki-ika-user-share-seed:v1';

export type SignPersonalMessage = (message: Uint8Array) => Promise<{ signature: string }>;

const cache = new Map<string, Uint8Array>();

export function userSeedMessage(address: string): Uint8Array {
  return new TextEncoder().encode(
    `passki.xyz — unlock your cross-chain wallet\n\n` +
    `Signing this re-creates the key that decrypts your IKA dWallet share. ` +
    `It does not move funds or approve a transaction. Only sign this on passki.xyz.\n\n` +
    `${SEED_DOMAIN}\naddress: ${address.toLowerCase()}`,
  );
}

function seedFromSignature(signatureB64: string): Uint8Array {
  const sig = fromBase64(signatureB64);
  const domain = new TextEncoder().encode(SEED_DOMAIN);
  const input = new Uint8Array(domain.length + sig.length);
  input.set(domain, 0);
  input.set(sig, domain.length);
  return sha256(input);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class NonDeterministicWalletError extends Error {
  constructor(walletHint = 'This wallet') {
    super(
      `${walletHint} produced two different signatures for the same message, ` +
      `so passki can't re-create your dWallet key later. Cross-chain wallets ` +
      `need a wallet that signs deterministically.`,
    );
    this.name = 'NonDeterministicWalletError';
  }
}

/**
 * Derive (or return the cached) root seed for `address`.
 *
 * @param verify  Sign twice and require identical signatures. Must be true
 *                before creating a new dWallet. Can be false when re-deriving
 *                for an existing dWallet (a wrong seed just fails to decrypt).
 */
export async function deriveUserEncryptionSeed(
  address: string,
  signPersonalMessage: SignPersonalMessage,
  opts: { verify: boolean },
): Promise<Uint8Array> {
  const key = address.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const message = userSeedMessage(address);
  const first = seedFromSignature((await signPersonalMessage(message)).signature);
  if (opts.verify) {
    const second = seedFromSignature((await signPersonalMessage(message)).signature);
    if (!equalBytes(first, second)) throw new NonDeterministicWalletError();
  }
  cache.set(key, first);
  return first;
}

/** Drop the cached seed (call on disconnect / account switch). */
export function clearUserEncryptionSeed(address?: string): void {
  if (address) cache.delete(address.toLowerCase());
  else cache.clear();
}
