/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0xda24db9d7ac4bd18c57641c01dc6312bb4bf04db25baf19e3b6273310b72d254';

/** Storm shared object ID (mainnet). */
export const STORM_ID = '0xeaf9a43f3b919fcb1fad61428b472661abb990a22a99518e0dd62112bad8f495';

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
