/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0x61b485ab25b64ca2b8cc8464b1d95bffbe2574e1f628a748bd3fea6d735c3310';

/** Thunder.in shared object ID (mainnet). */
export const THUNDER_IN_ID = '0x44b0044c1e540d42a95c1095e6029fcf03defa386012c583920dec367c05a777';

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
