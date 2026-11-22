/**
 * SponsorAgent — Durable Object that coordinates gas sponsorship.
 *
 * One DO instance per sponsor address (keyed by the sponsor's Sui address).
 *
 * Flow:
 *   1. Sponsor registers with a signed authorization message + pushes gas coins.
 *   2. User requests sponsorship: sends fully-built sponsored tx bytes.
 *   3. State update pushes the request to the sponsor's WebSocket client.
 *   4. Sponsor signs → submits sig.  User signs → submits sig.
 *   5. When both sigs are present, the requesting client submits via gRPC.
 */

import { Agent, callable } from 'agents';
// Namespace import: resolved at call time (keeps test stubs of 'agents' linkable).
import * as agentsSdk from 'agents';
import { verifyPersonalMessageSignature, verifyTransactionSignature } from '@mysten/sui/verify';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { normalizeSuiAddress, fromBase64 } from '@mysten/sui/utils';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { rejectClientStateWrites } from './state-guard.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ultronKeypair } from '../ultron-key.js';
import { evaluateSponsorTx } from '../sponsor-policy.js';
import { reserveSponsorBudget } from './sponsor-quota.js';

export interface GasCoin {
  objectId: string;
  version: string;
  digest: string;
}

export interface SponsorRequest {
  id: string;
  senderAddress: string;
  /** base64-encoded fully-built sponsored transaction bytes */
  txBytes: string;
  userSig?: string;
  sponsorSig?: string;
  status: 'awaiting_sigs' | 'user_signed' | 'sponsor_signed' | 'ready' | 'submitted' | 'failed';
  createdAt: number;
  digest?: string;
  error?: string;
}

export interface SponsorState {
  sponsorAddress: string;
  authSignature: string;
  authMessage: string;
  registeredAt: number;
  expiresAt: number;
  active: boolean;
  gasCoins: GasCoin[];
  gasCoinsRefreshedAt: number;
  pendingRequests: SponsorRequest[];
  totalSponsored: number;
  /** Resolved Sui addresses allowed to request sponsorship. Empty = open (any sender). */
  approvedList: string[];
  /** When true, the server-side ultron keypair auto-signs sponsor gas instead of the browser wallet. */
  ultronMode: boolean;
  /** Derived Sui address of the ultron keypair (set when ultronMode is enabled). */
  ultronAddress: string;
}

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string; // ultron.sui signing key
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — mirrors .SKI session TTL
const MAX_PENDING = 20;                   // cap queue length

export class SponsorAgent extends Agent<Env, SponsorState> {
  initialState: SponsorState = {
    sponsorAddress: '',
    authSignature: '',
    authMessage: '',
    registeredAt: 0,
    expiresAt: 0,
    active: false,
    gasCoins: [],
    gasCoinsRefreshedAt: 0,
    pendingRequests: [],
    totalSponsored: 0,
    approvedList: [],
    ultronMode: false,
    ultronAddress: '',
  };

  // ─── State hygiene ───────────────────────────────────────────────────

  /** Clients may only change state through the callables below. */
  validateStateChange(_next: SponsorState, source: unknown): void {
    rejectClientStateWrites(source);
  }

  /**
   * Agent state is broadcast to every connected client, so it must never hold
   * the sponsor's auth signature: anyone who saw it could replay `register`
   * and act as the sponsor. Older instances stored it; scrub it on wake.
   */
  async onStart(): Promise<void> {
    if (this.state.authSignature || this.state.authMessage) {
      this.setState({ ...this.state, authSignature: '', authMessage: '' });
    }
  }

  // ─── Sponsor Registration ────────────────────────────────────────────

  @callable()
  async register(params: {
    sponsorAddress: string;
    authSignature: string;
    authMessage: string;
  }): Promise<{ success: boolean; expiresAt?: number; error?: string }> {
    const { authSignature, authMessage } = params;
    let sponsorAddress: string;
    try { sponsorAddress = normalizeSuiAddress(params.sponsorAddress); }
    catch { return { success: false, error: 'Invalid address' }; }

    // One DO per sponsor: you can only register as the address this instance is named after.
    if (normalizeSuiAddress(this.name) !== sponsorAddress) {
      return { success: false, error: 'Sponsor address does not match this agent' };
    }

    if (typeof authMessage !== 'string' || !/^\.SKI .*Splash/.test(authMessage)) {
      return { success: false, error: 'Invalid sponsor authorization message' };
    }

    try {
      const messageBytes = new TextEncoder().encode(authMessage);
      await verifyPersonalMessageSignature(messageBytes, authSignature, { address: sponsorAddress, client: verifierClient() });
    } catch {
      return { success: false, error: 'Invalid signature' };
    }

    // Honour the expiry the wallet owner actually signed, capped at TTL.
    const now = Date.now();
    const signedExpiry = parseSignedExpiry(authMessage);
    if (signedExpiry !== null && signedExpiry <= now) {
      return { success: false, error: 'Sponsor authorization expired' };
    }
    const expiresAt = Math.min(signedExpiry ?? Infinity, now + TTL_MS);

    // Bind sponsor rights to *this* WebSocket. Later mutations are authorized
    // by the connection that proved key ownership, not by a claimed address.
    this.currentConnection()?.setState({ sponsor: sponsorAddress, until: expiresAt });

    this.setState({
      ...this.state,
      sponsorAddress,
      authSignature: '',
      authMessage: '',
      registeredAt: now,
      expiresAt,
      active: true,
    });

    return { success: true, expiresAt };
  }

  /** The WebSocket the current callable arrived on, if any. */
  protected currentConnection(): { state: unknown; setState(s: unknown): unknown } | undefined {
    return agentsSdk.getCurrentAgent().connection as any;
  }

  /**
   * Guard: only a connection that completed `register` for the current
   * sponsor may mutate sponsor settings. The caller-supplied address is
   * ignored (addresses are public, so it proves nothing).
   */
  private requireSponsor(_callerAddress?: string): boolean {
    if (!this.state.active || Date.now() > this.state.expiresAt) return false;
    const auth = this.currentConnection()?.state as { sponsor?: string; until?: number } | null | undefined;
    return !!auth && auth.sponsor === this.state.sponsorAddress && (auth.until ?? 0) > Date.now();
  }

  @callable()
  async deactivate(params: { callerAddress: string }): Promise<{ success: boolean }> {
    if (!this.requireSponsor(params.callerAddress)) return { success: false };
    this.setState({ ...this.state, active: false });
    return { success: true };
  }

  @callable()
  async addEntry(params: { address: string; callerAddress: string }): Promise<{ success: boolean }> {
    if (!this.requireSponsor(params.callerAddress)) return { success: false };
    const list = this.state.approvedList ?? [];
    if (list.includes(params.address)) return { success: true };
    this.setState({ ...this.state, approvedList: [...list, params.address] });
    return { success: true };
  }

  @callable()
  async removeEntry(params: { address: string; callerAddress: string }): Promise<{ success: boolean }> {
    if (!this.requireSponsor(params.callerAddress)) return { success: false };
    this.setState({
      ...this.state,
      approvedList: (this.state.approvedList ?? []).filter((a) => a !== params.address),
    });
    return { success: true };
  }

  // ─── Ultron Mode ────────────────────────────────────────────────────

  @callable()
  async enableUltronMode(params: { callerAddress: string }): Promise<{ success: boolean; ultronAddress?: string; error?: string }> {
    if (!this.requireSponsor(params.callerAddress)) return { success: false, error: 'Unauthorized' };
    if (!this.state.active) return { success: false, error: 'Sponsor not active' };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { success: false, error: 'No ultron private key configured (set SHADE_KEEPER_PRIVATE_KEY secret)' };
    }

    const keypair = ultronKeypair(this.env);
    const ultronAddress = keypair.toSuiAddress();

    // Fetch ultron gas coins via GraphQL so getGasCoins() returns them
    const coins = await this.fetchUltronGasCoins(ultronAddress);

    this.setState({
      ...this.state,
      ultronMode: true,
      ultronAddress,
      gasCoins: coins,
      gasCoinsRefreshedAt: Date.now(),
    });

    return { success: true, ultronAddress };
  }

  @callable()
  async disableUltronMode(params: { callerAddress: string }): Promise<{ success: boolean }> {
    if (!this.requireSponsor(params.callerAddress)) return { success: false };
    this.setState({
      ...this.state,
      ultronMode: false,
      ultronAddress: '',
    });
    return { success: true };
  }

  private async fetchUltronGasCoins(ultronAddress: string): Promise<GasCoin[]> {
    const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            coins(type:"0x2::sui::SUI",first:3){
              nodes{ address version digest }
            }
          }
        }`,
        variables: { a: ultronAddress },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { coins?: { nodes?: Array<{ address: string; version: number; digest: string }> } } };
    };
    const nodes = json?.data?.address?.coins?.nodes ?? [];
    return nodes.map((c) => ({
      objectId: c.address,
      version: String(c.version),
      digest: c.digest,
    }));
  }

  private async signWithUltron(requestId: string): Promise<void> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return;

    const idx = this.state.pendingRequests.findIndex(r => r.id === requestId);
    if (idx === -1) return;

    const req = this.state.pendingRequests[idx];
    if (req.sponsorSig) return;

    try {
      const keypair = ultronKeypair(this.env);
      const txBytes = Uint8Array.from(atob(req.txBytes), c => c.charCodeAt(0));
      const decision = evaluateSponsorTx(txBytes, keypair.toSuiAddress(), req.senderAddress);
      if (!decision.ok) {
        console.warn('[SponsorAgent] refused to sign:', decision.reason);
        const requests = [...this.state.pendingRequests];
        requests[idx] = { ...req, status: 'failed' };
        this.setState({ ...this.state, pendingRequests: requests });
        return;
      }
      const quota = await reserveSponsorBudget(this.env as any, decision.sender, decision.budgetMist);
      if (!quota.ok) {
        console.warn('[SponsorAgent] quota refused:', quota.reason);
        const requests = [...this.state.pendingRequests];
        requests[idx] = { ...req, status: 'failed' };
        this.setState({ ...this.state, pendingRequests: requests });
        return;
      }
      const { signature: sponsorSig } = await keypair.signTransaction(txBytes);

      const updated: SponsorRequest = {
        ...req,
        sponsorSig,
        status: req.userSig ? 'ready' : 'sponsor_signed',
      };
      const requests = [...this.state.pendingRequests];
      requests[idx] = updated;
      this.setState({ ...this.state, pendingRequests: requests });
    } catch (err) {
      console.error('[SponsorAgent] Ultron signing failed:', err);
    }
  }

  // ─── Gas Coin Management ─────────────────────────────────────────────

  @callable()
  async refreshGasCoins(params: { coins: GasCoin[] }): Promise<{ success: boolean }> {
    if (!this.requireSponsor()) return { success: false };
    if (!Array.isArray(params.coins) || params.coins.length > 50) return { success: false };
    this.setState({
      ...this.state,
      gasCoins: params.coins,
      gasCoinsRefreshedAt: Date.now(),
    });
    return { success: true };
  }

  @callable()
  async getGasCoins(): Promise<{ coins: GasCoin[]; refreshedAt: number } | null> {
    if (!this.state.active) return null;
    if (Date.now() > this.state.expiresAt) {
      this.setState({ ...this.state, active: false });
      return null;
    }

    // In ultron mode, auto-refresh coins if stale (>30s)
    if (this.state.ultronMode && this.state.ultronAddress) {
      const staleMs = 30_000;
      if (Date.now() - this.state.gasCoinsRefreshedAt > staleMs) {
        const coins = await this.fetchUltronGasCoins(this.state.ultronAddress);
        this.setState({
          ...this.state,
          gasCoins: coins,
          gasCoinsRefreshedAt: Date.now(),
        });
        return { coins, refreshedAt: Date.now() };
      }
    }

    return { coins: this.state.gasCoins, refreshedAt: this.state.gasCoinsRefreshedAt };
  }

  // ─── Sponsorship Requests ────────────────────────────────────────────

  @callable()
  async requestSponsorship(params: {
    senderAddress: string;
    /** base64 of fully-built sponsored transaction bytes (built client-side) */
    txBytes: string;
  }): Promise<{ requestId: string } | { error: string }> {
    if (!this.state.active) return { error: 'Sponsor not active' };
    if (Date.now() > this.state.expiresAt) {
      this.setState({ ...this.state, active: false });
      return { error: 'Sponsor authorization expired' };
    }

    const approvedList = this.state.approvedList ?? [];
    if (approvedList.length > 0 && !approvedList.includes(params.senderAddress)) {
      return { error: 'Not on sponsor list' };
    }

    const openRequests = this.state.pendingRequests.filter(
      r => r.status !== 'submitted' && r.status !== 'failed',
    );
    if (openRequests.length >= MAX_PENDING) {
      return { error: 'Sponsor queue full — try again later' };
    }

    const requestId = crypto.randomUUID();
    const request: SponsorRequest = {
      id: requestId,
      senderAddress: params.senderAddress,
      txBytes: params.txBytes,
      status: 'awaiting_sigs',
      createdAt: Date.now(),
    };

    this.setState({
      ...this.state,
      pendingRequests: [...this.state.pendingRequests, request],
    });

    // In ultron mode, auto-sign the sponsor's gas signature immediately
    if (this.state.ultronMode) {
      await this.signWithUltron(requestId);
    }

    return { requestId };
  }

  @callable()
  async submitUserSignature(params: {
    requestId: string;
    userSig: string;
  }): Promise<{ success: boolean; error?: string }> {
    const idx = this.state.pendingRequests.findIndex(r => r.id === params.requestId);
    if (idx === -1) return { success: false, error: 'Request not found' };

    const req = this.state.pendingRequests[idx];
    if (req.userSig) return { success: false, error: 'User sig already submitted' };
    // Verify, so nobody else can squat the slot with a junk signature.
    if (!(await signs(req.txBytes, params.userSig, req.senderAddress))) {
      return { success: false, error: 'Invalid user signature' };
    }

    const updated: SponsorRequest = {
      ...req,
      userSig: params.userSig,
      status: req.sponsorSig ? 'ready' : 'user_signed',
    };
    const requests = [...this.state.pendingRequests];
    requests[idx] = updated;
    this.setState({ ...this.state, pendingRequests: requests });
    return { success: true };
  }

  @callable()
  async submitSponsorSignature(params: {
    requestId: string;
    sponsorSig: string;
  }): Promise<{ success: boolean; error?: string }> {
    const idx = this.state.pendingRequests.findIndex(r => r.id === params.requestId);
    if (idx === -1) return { success: false, error: 'Request not found' };

    const req = this.state.pendingRequests[idx];
    if (req.sponsorSig) return { success: false, error: 'Sponsor sig already submitted' };
    if (!(await signs(req.txBytes, params.sponsorSig, this.state.sponsorAddress))) {
      return { success: false, error: 'Invalid sponsor signature' };
    }

    const updated: SponsorRequest = {
      ...req,
      sponsorSig: params.sponsorSig,
      status: req.userSig ? 'ready' : 'sponsor_signed',
    };
    const requests = [...this.state.pendingRequests];
    requests[idx] = updated;
    this.setState({ ...this.state, pendingRequests: requests });
    return { success: true };
  }

  @callable()
  async markSubmitted(params: { requestId: string; digest: string }): Promise<{ success: boolean }> {
    const idx = this.state.pendingRequests.findIndex(r => r.id === params.requestId);
    if (idx === -1) return { success: false };
    const req = this.state.pendingRequests[idx];
    if (req.status !== 'ready') return { success: false };
    // The digest is a hash of the tx bytes, so a wrong one is provably wrong.
    try {
      if (TransactionDataBuilder.getDigestFromBytes(fromBase64(req.txBytes)) !== params.digest) return { success: false };
    } catch { return { success: false }; }

    const requests = [...this.state.pendingRequests];
    requests[idx] = { ...req, status: 'submitted', digest: params.digest };
    this.setState({
      ...this.state,
      pendingRequests: requests,
      totalSponsored: this.state.totalSponsored + 1,
    });
    return { success: true };
  }

  @callable()
  async getSponsorState(): Promise<Omit<SponsorState, 'authSignature' | 'authMessage'>> {
    // Never broadcast auth credentials — strip signature and raw message
    const { authSignature: _s, authMessage: _m, ...safe } = this.state;
    // Sanitize pending requests: strip raw txBytes from non-ready requests
    const sanitizedRequests = safe.pendingRequests.map(r => ({
      ...r,
      txBytes: r.status === 'ready' ? r.txBytes : '[redacted]',
    }));
    return { ...safe, pendingRequests: sanitizedRequests };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parse the `Expires At: <ISO date>` line the wallet owner signed, if any. */
export function parseSignedExpiry(message: string): number | null {
  const m = /^Expires At: (.+)$/m.exec(message);
  if (!m) return null;
  const t = Date.parse(m[1].trim());
  return Number.isFinite(t) ? t : null;
}

let _verifier: SuiGraphQLClient | null = null;
const verifierClient = () => (_verifier ??= new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' }));

/** True if `signature` is a valid signature by `address` over the base64 tx bytes. */
async function signs(txBytesB64: string, signature: string, address: string): Promise<boolean> {
  try {
    // The client is only consulted for zkLogin signatures.
    await verifyTransactionSignature(fromBase64(txBytesB64), signature, { address, client: verifierClient() });
    return true;
  } catch {
    return false;
  }
}
