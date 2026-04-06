import { Agent, callable } from 'agents';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

export interface SessionState {
  authenticated: boolean;
  walletAddress: string;
  visitorId: string;
  confidence: number;
  signature: string;
  message: string;
  suinsName: string;
  ikaWalletId: string;
  createdAt: number;
  lastSeenAt: number;
}

interface Env {
  // Durable Object bindings added by wrangler
}

export class SessionAgent extends Agent<Env, SessionState> {
  initialState: SessionState = {
    authenticated: false,
    walletAddress: '',
    visitorId: '',
    confidence: 0,
    signature: '',
    message: '',
    suinsName: '',
    ikaWalletId: '',
    createdAt: 0,
    lastSeenAt: 0,
  };

  @callable()
  async authenticate(params: {
    walletAddress: string;
    visitorId: string;
    confidence: number;
    signature: string;
    message: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { walletAddress, visitorId, confidence, signature, message } = params;

    // Verify the personal message signature
    try {
      const messageBytes = new TextEncoder().encode(message);
      await verifyPersonalMessageSignature(messageBytes, signature, {
        address: walletAddress,
      });
    } catch {
      return { success: false, error: 'Invalid signature' };
    }

    // Verify message structure
    if (!message.includes('.SKI')) {
      return { success: false, error: 'Invalid session message format' };
    }

    // Validate expiry from signed message (prevents replay with expired tokens)
    const expiryMatch = message.match(/Expires At:\s*(\S+)/);
    if (expiryMatch) {
      const expiresAt = new Date(expiryMatch[1]).getTime();
      if (isNaN(expiresAt) || expiresAt < Date.now()) {
        return { success: false, error: 'Session message expired' };
      }
    }

    const now = Date.now();
    this.setState({
      ...this.state,
      authenticated: true,
      walletAddress,
      visitorId,
      confidence,
      signature,
      message,
      createdAt: this.state.createdAt || now,
      lastSeenAt: now,
    });

    return { success: true };
  }

  @callable()
  async getSession(): Promise<Omit<SessionState, 'signature' | 'message'> & { signature?: undefined; message?: undefined }> {
    if (this.state.authenticated) {
      this.setState({ ...this.state, lastSeenAt: Date.now() });
    }
    // Never broadcast raw signature or signed message to callers
    const { signature: _s, message: _m, ...safe } = this.state;
    return safe as any;
  }

  @callable()
  async forgetDevice(params: { walletAddress: string }): Promise<{ success: boolean }> {
    if (!this.state.authenticated || params.walletAddress !== this.state.walletAddress) {
      return { success: false };
    }
    this.setState(this.initialState);
    return { success: true };
  }

  @callable()
  async updateSuinsName(params: { name: string; walletAddress: string }): Promise<void> {
    if (!this.state.authenticated || params.walletAddress !== this.state.walletAddress) return;
    this.setState({ ...this.state, suinsName: params.name });
  }

  @callable()
  async updateIkaWalletId(params: { walletId: string; walletAddress: string }): Promise<void> {
    if (!this.state.authenticated || params.walletAddress !== this.state.walletAddress) return;
    this.setState({ ...this.state, ikaWalletId: params.walletId });
  }
}
