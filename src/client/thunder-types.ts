/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0x9c60285c03504612b7f0b6ac7613519b822b02f72cf7625b452dfbebbd9c2803';

/** Thunder shared object ID (mainnet). */
export const THUNDER_OBJECT_ID = '0x70d618272558778578f953145892ad8e7ec07d22dc590bd28d027eba8dcc53cd';

/** Seal key server configs (Overclock, NodeInfra, Studio Mirai). */
export const SEAL_SERVER_CONFIGS = [
  { objectId: '0x7bb1bc0e3a6c2fb52494c3a2a21ed0c1f15e9a1d7b48e07eb201b5d8e3530768', weight: 1 },
  { objectId: '0x21a5cf690c839f2e588e78cea1ed50fd23b6399dcab5c1147c8f1c9076e8378f', weight: 1 },
  { objectId: '0x1863de05bff5c170ea7fd89c01304e52258990273a9e7e5d1e3edde91ab5c781', weight: 1 },
];

/** Seal threshold — 2 of 3 key servers must agree. */
export const SEAL_THRESHOLD = 2;

/** Thunder payload — the cleartext inside the Seal-encrypt blob. */
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
