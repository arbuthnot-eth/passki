/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0x61715ae8feed7956695e3402eeb39271c3112da8f8c8cccfefbfac2b591c5b3c';

/** Storm shared object ID (mainnet). */
export const STORM_ID = '0x89cbbb0fadea8adf698e858a0062ea8a8cbda5cc7b66c93ee5bf745be57eb29f';

/** Thunder payload — the cleartext inside the encrypt blob. */
export interface ThunderPayload {
  v: typeof THUNDER_VERSION;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  suiami?: string;
}

/** On-chain ThunderPointer fields (mirrors Move struct). */
export interface ThunderPointerData {
  blobId: Uint8Array;
  sealedNamespace: Uint8Array;
  timestampMs: number;
}
