/**
 * WaaP (Wallet as a Protocol) provider registration.
 * Registers WaaP as a default Sui Wallet Standard provider so it
 * appears in the SKI modal without any extra wallet extension.
 *
 * Docs: https://docs.waap.xyz/guides-sui/start
 */

import { initWaaPSui } from '@human.tech/waap-sdk';
import { registerWallet } from '@wallet-standard/wallet';

let registered = false;

export function registerWaaP(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;
  try {
    const wallet = initWaaPSui({
      useStaging: false,
      config: {
        styles: { darkMode: true },
      },
    });
    registerWallet(wallet as unknown as Parameters<typeof registerWallet>[0]);
  } catch (err) {
    console.warn('[.SKI] WaaP registration failed:', err);
  }
}
