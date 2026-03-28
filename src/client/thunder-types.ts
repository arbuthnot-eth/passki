/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0xbe63cc5a29f9cd4e6184eac15a38841ed27063f798796c0fe56433d3e2cec8b7';

/** Thunder.in shared object ID (mainnet). */
export const THUNDER_IN_ID = '0x00acc8be52a265ec821a25dc88442178f133f6ea7bc24783c435315dd5deecaa';

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
