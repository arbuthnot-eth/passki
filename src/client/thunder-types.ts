/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0x4b78288ad91534ba4f95bf2559295dc6c04d03a510c2e9ad649fcb8147bc6fb3';

/** Thunder.in shared object ID (mainnet). */
export const THUNDER_IN_ID = '0x60a458d81192ee2afd91d99e8f2ba7c0b2bb9ca225830158071e2c70eb84c805';

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
