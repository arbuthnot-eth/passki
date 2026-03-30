/** Thunder — encrypt signals between SuiNS identities. Types and constants. */

export const THUNDER_VERSION = 1;

/**
 * Thunder mainnet deployment (v3 — signal/quest/cloud).
 * Package: 0x5a60...::thunder (module)
 * Storm:   0xfaf8...::thunder::Storm (shared object — NOT the UpgradeCap)
 *
 * To verify: sui client object <STORM_ID> → type should be ...::thunder::Storm
 */
export const THUNDER_PACKAGE_ID = '0xecd7cec9058d82b6c7fbae3cbc0a0c2cf58fe4be2e87679ff9667ee7a0309e0f';
export const STORM_ID = '0xd67490b2047490e81f7467eedb25c726e573a311f9139157d746e4559282844f';

// Legacy storms — auto-strike pending signals from old deploys
export const LEGACY_STORMS: Array<[string, string]> = [
  ['0xbe5c6df7fc1340f8e3b5fa880e5fbeee3844114778e65f442815ba8922e80bd6', '0xf32adacbdb83c7ad5d75b68e1c5d2cd3e696ac8a2b13c0cc06ecdd9c110bd383'],
  ['0xc6255a592244024da44551f52d44236e35d290db016c4fe59239ec02e269148b', '0xba0c4ec86ab44f20812bfd24f00f1d3f2e9eae8bcaaae42d9f6a4d0c317ae193'],
  ['0x1de29b4dfa0c4e434ddfc0826159cbe4d404ea7922243396fd0a9e78cafa3e25', '0x1b3fec208b3935e7964bffc78fe4755d5ec5c6318ab5dc4df97f5865cd3adfe6'],
  ['0x567e1e7e3b35d1bccc58faa8f2f72dda984828d6937bec6a6c13c30b85f5f38c', '0xf54cdf0a5587c123d4a54d70c88dbf0f86ae3a88230954f1c3f50437ae35e2f7'],
  ['0x7d2a68288a8687c54901d3e47511dc65c5a41c50d09378305c556a65cbe2f782', '0x04928995bbb8e1ab9beff0ccb2747ea1ce404140be8dcc8929827c3985d836e6'],
];

/** Thunder signal — the cleartext content. */
export interface ThunderPayload {
  v: typeof THUNDER_VERSION;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  suiami?: string;
  /** Recipient's counter-signature — proves they received and read the message. Private (local only). */
  receipt?: string;
}
