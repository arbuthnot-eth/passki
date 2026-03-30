/**
 * SuiAMI — SUI-Authenticated Message Identity
 *
 * Cryptographic proof that a wallet owner controls a SuiNS name.
 * The proof is a signed personal message bundled into a shareable token.
 */

export interface SuiamiMessage {
  suiami: string;
  balance?: string;
  datetime: string;
  /** Truncated addresses — quick glance at the top of the signing popup */
  chains: string;
  ski: string;
  /** Full addresses — verifiable at the bottom */
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

/** Build a SuiAMI message ready for signing. Includes all cross-chain addresses. */
export function buildSuiamiMessage(name: string, address: string, nftId: string, crossChain?: { btc?: string; sol?: string; eth?: string }, totalBalanceUsd?: number): SuiamiMessage {
  const now = Date.now();
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: 'numeric', month: 'numeric', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  const art = `${p('hour')}:${p('minute')} ${p('day')}/${parseInt(p('month'), 10)}/${p('year')}`;
  // Build truncated chain list — each on its own line in the signing popup
  const trunc = (addr: string, pre = 6, suf = 4) => `${addr.slice(0, pre)}…${addr.slice(-suf)}`;
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

/** Unicode-safe base64 encode. */
function toBase64(str: string): string {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));
}

/** Unicode-safe base64 decode. */
function fromBase64(b64: string): string {
  return decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}

/** Bundle a signed message into a shareable proof token. */
export function createSuiamiProof(message: SuiamiMessage, bytes: string, signature: string): SuiamiProof {
  const msgB64 = toBase64(JSON.stringify(message));
  const token = `suiami:${msgB64}.${signature}`;
  return { token, message, bytes, signature };
}

/** Parse a proof token back into its components. */
export function parseSuiamiProof(token: string): { message: SuiamiMessage; signature: string } | null {
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
