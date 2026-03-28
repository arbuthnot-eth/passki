/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0xc164180c5aca24b42c5b865c6fcf9160deeed8eafee37635135ac54ab6632a1a';

/** Storm shared object ID (mainnet). */
export const STORM_ID = '0x00dffb7759cbf71c5f205b431c2484c0f7f40ff2fae900bc265fdae98454f4cb';

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
