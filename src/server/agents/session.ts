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
  async getSession(): Promise<SessionState> {
    if (this.state.authenticated) {
      this.setState({ ...this.state, lastSeenAt: Date.now() });
    }
    return this.state;
  }

  @callable()
  async forgetDevice(): Promise<{ success: boolean }> {
    this.setState(this.initialState);
    return { success: true };
  }

  @callable()
  async updateSuinsName(name: string): Promise<void> {
    this.setState({ ...this.state, suinsName: name });
  }

  @callable()
  async updateIkaWalletId(walletId: string): Promise<void> {
    this.setState({ ...this.state, ikaWalletId: walletId });
  }
}
