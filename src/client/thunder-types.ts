/** Thunder — encrypt signals between SuiNS identities. Types and constants. */

export const THUNDER_VERSION = 1;

/**
 * Thunder mainnet deployment (v3 — signal/quest/cloud).
 * Package: 0x5a60...::thunder (module)
 * Storm:   0xfaf8...::thunder::Storm (shared object — NOT the UpgradeCap)
 *
 * To verify: sui client object <STORM_ID> → type should be ...::thunder::Storm
 */
export const THUNDER_PACKAGE_ID = '0x1de29b4dfa0c4e434ddfc0826159cbe4d404ea7922243396fd0a9e78cafa3e25';
export const STORM_ID = '0x1b3fec208b3935e7964bffc78fe4755d5ec5c6318ab5dc4df97f5865cd3adfe6';

// Legacy storms — auto-strike pending signals from old deploys
export const LEGACY_THUNDER_PACKAGE_ID = '0x567e1e7e3b35d1bccc58faa8f2f72dda984828d6937bec6a6c13c30b85f5f38c';
export const LEGACY_STORM_ID = '0xf54cdf0a5587c123d4a54d70c88dbf0f86ae3a88230954f1c3f50437ae35e2f7';
export const LEGACY2_THUNDER_PACKAGE_ID = '0x7d2a68288a8687c54901d3e47511dc65c5a41c50d09378305c556a65cbe2f782';
export const LEGACY2_STORM_ID = '0x04928995bbb8e1ab9beff0ccb2747ea1ce404140be8dcc8929827c3985d836e6';

/** Thunder signal — the cleartext content. */
export interface ThunderPayload {
  v: typeof THUNDER_VERSION;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  suiami?: string;
}
