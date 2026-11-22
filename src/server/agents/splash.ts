import { Agent, callable } from 'agents';
import { rejectClientStateWrites } from './state-guard.js';

export interface SplashDeviceState {
  isSplashSponsor: boolean;
  activatedAt: number;
  address: string;
}

interface Env {}

export class SplashDeviceAgent extends Agent<Env, SplashDeviceState> {
  /** Public agent: clients change state only via callables. */
  validateStateChange(_next: SplashDeviceState, source: unknown): void {
    rejectClientStateWrites(source);
  }

  initialState: SplashDeviceState = {
    isSplashSponsor: false,
    activatedAt: 0,
    address: '',
  };

  @callable()
  async activate(params: { address: string }): Promise<{ success: boolean }> {
    const { address } = params;
    if (!address) return { success: false };
    this.setState({
      isSplashSponsor: true,
      activatedAt: Date.now(),
      address,
    });
    return { success: true };
  }

  @callable()
  async check(): Promise<{ isSplashSponsor: boolean }> {
    return { isSplashSponsor: this.state.isSplashSponsor };
  }

  @callable()
  async deactivate(): Promise<{ success: boolean }> {
    this.setState({ ...this.state, isSplashSponsor: false });
    return { success: true };
  }
}
