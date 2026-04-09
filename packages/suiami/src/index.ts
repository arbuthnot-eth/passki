/**
 * SUIAMI — SUI-Authenticated Message Identity
 *
 * Cryptographic proof that a wallet owner controls a SuiNS name
 * with cross-chain address attestation via IKA dWallets.
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface SuiamiMessage {
  suiami: string;
  balance?: string;
  datetime: string;
  chains: string;
  ski: string;
  sui: string;
  btc?: string;
  sol?: string;
  eth?: string;
  nftId: string;
  timestamp: number;
  version: 2;
}

export interface SuiamiProof {
  token: string;
  message: SuiamiMessage;
  bytes: string;
  signature: string;
}

export interface CrossChainAddresses {
  btc?: string;
  sol?: string;
  eth?: string;
}

// ─── Build ─────────────────────────────────────────────────────────

/** Build a SUIAMI message ready for wallet signing. */
export function buildMessage(
  name: string,
  address: string,
  nftId: string,
  crossChain?: CrossChainAddresses,
  totalBalanceUsd?: number,
): SuiamiMessage {
  if (name !== 'nobody' && !nftId) throw new Error(`Cannot sign SUIAMI — you don't own ${name}.sui`);
  const now = Date.now();
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: 'numeric', month: 'numeric', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  const art = `${p('hour')}:${p('minute')} ${p('day')}/${parseInt(p('month'), 10)}/${p('year')}`;
  const trunc = (addr: string, pre = 6, suf = 4) => `${addr.slice(0, pre)}\u2026${addr.slice(-suf)}`;
  const chainLines: string[] = [`sui  ${trunc(address)}`];
  if (crossChain?.btc) chainLines.push(`btc  ${trunc(crossChain.btc, 8, 4)}`);
  if (crossChain?.sol) chainLines.push(`sol  ${trunc(crossChain.sol)}`);
  if (crossChain?.eth) chainLines.push(`eth  ${trunc(crossChain.eth)}`);

  return {
    suiami: `I am ${name}`,
    ...(totalBalanceUsd != null && totalBalanceUsd > 0 ? { balance: `$${totalBalanceUsd.toFixed(2)}` } : {}),
    datetime: art,
    chains: chainLines.join('\n'),
    ski: `${name}.sui.ski`,
    sui: address,
    ...(crossChain?.btc ? { btc: crossChain.btc } : {}),
    ...(crossChain?.sol ? { sol: crossChain.sol } : {}),
    ...(crossChain?.eth ? { eth: crossChain.eth } : {}),
    nftId,
    timestamp: now,
    version: 2,
  };
}

// ─── Token ─────────────────────────────────────────────────────────

function toBase64(str: string): string {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));
}

function fromBase64(b64: string): string {
  return decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}

/** Bundle a signed message into a shareable proof token. */
export function createProof(message: SuiamiMessage, bytes: string, signature: string): SuiamiProof {
  const msgB64 = toBase64(JSON.stringify(message));
  const token = `suiami:${msgB64}.${signature}`;
  return { token, message, bytes, signature };
}

/** Parse a proof token back into its components. */
export function parseProof(token: string): { message: SuiamiMessage; signature: string } | null {
  if (!token.startsWith('suiami:')) return null;
  const body = token.slice(7);
  const dotIdx = body.lastIndexOf('.');
  if (dotIdx < 0) return null;
  try {
    const msgB64 = body.slice(0, dotIdx);
    const signature = body.slice(dotIdx + 1);
    const message = JSON.parse(fromBase64(msgB64)) as SuiamiMessage;
    if (!message.suiami) return null;
    return { message, signature };
  } catch {
    return null;
  }
}

/** Extract the bare name from a SUIAMI message. */
export function extractName(message: SuiamiMessage): string {
  return message.suiami.replace(/^I am /, '');
}

// ─── Constants ─────────────────────────────────────────────────────

export const ROSTER_PACKAGE = '0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa';
export const ROSTER_OBJECT = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';
