/** Thunder — encrypt signals between SuiNS identities. Types and constants. */

export const THUNDER_VERSION = 1;

/**
 * Thunder mainnet deployment (v3 — signal/quest/cloud).
 * Package: 0x5a60...::thunder (module)
 * Storm:   0xfaf8...::thunder::Storm (shared object — NOT the UpgradeCap)
 *
 * To verify: sui client object <STORM_ID> → type should be ...::thunder::Storm
 */
export const THUNDER_PACKAGE_ID = '0xb16f344c9f778be79d81ad3b3bd799476681d339a099ff9acaf2b7ea9e5d9581';
export const STORM_ID = '0x56a811bd698022fe1d5a00dd34fd0d5d101fd14c03f1cd54409357dc28e594ef';

/** Thunder signal — the cleartext content. */
export interface ThunderPayload {
  v: typeof THUNDER_VERSION;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  suiami?: string;
}
