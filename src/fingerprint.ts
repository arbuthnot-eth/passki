/**
 * Device fingerprinting via FingerprintJS (open-source v5).
 *
 * Generates a stable `visitorId` from browser/device signals.
 * Combined with the wallet signature, this replaces cookies entirely
 * for device-wallet identity binding.
 */

import FingerprintJS from '@fingerprintjs/fingerprintjs';

let fpPromise: ReturnType<typeof FingerprintJS.load> | null = null;

/**
 * Get the device fingerprint. The FingerprintJS agent is loaded once
 * and reused across calls.
 */
export async function getDeviceId(): Promise<{
  visitorId: string;
  confidence: number;
}> {
  if (!fpPromise) fpPromise = FingerprintJS.load();
  const fp = await fpPromise;
  const result = await fp.get();
  return { visitorId: result.visitorId, confidence: result.confidence.score };
}

/**
 * Build a unique session key from the device fingerprint and wallet address.
 * This becomes the Durable Object instance name.
 */
export function buildSessionKey(visitorId: string, address: string): string {
  return `${visitorId}-${address.toLowerCase().replace(/^0x/, '')}`;
}
