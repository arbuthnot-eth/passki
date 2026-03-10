/**
 * elements.ts — Custom Element wrappers for SKI components.
 *
 * Thin shells around the existing mount functions in ui.ts.
 * The monolith does all the rendering — these just provide the
 * <ski-button>, <ski-dot>, <ski-balance> HTML tags.
 *
 * Usage (any page that loads sui.ski):
 *   <ski-button></ski-button>   — main SKI trigger (logo + balance)
 *   <ski-dot></ski-dot>         — status indicator dot
 *   <ski-balance></ski-balance> — balance cycler (SUI/USD toggle)
 *   <ski-profile></ski-profile> — wallet icon + name/address pill
 */

import { mountSkiButton, mountDotButton, mountBalanceCycler, mountProfile } from './ui.js';

class SkiButtonElement extends HTMLElement {
  private _unmount: (() => void) | null = null;
  connectedCallback() { this._unmount = mountSkiButton(this); }
  disconnectedCallback() { this._unmount?.(); this._unmount = null; }
}

class SkiDotElement extends HTMLElement {
  private _unmount: (() => void) | null = null;
  connectedCallback() { this._unmount = mountDotButton(this); }
  disconnectedCallback() { this._unmount?.(); this._unmount = null; }
}

class SkiBalanceElement extends HTMLElement {
  private _unmount: (() => void) | null = null;
  connectedCallback() { this._unmount = mountBalanceCycler(this); }
  disconnectedCallback() { this._unmount?.(); this._unmount = null; }
}

class SkiProfileElement extends HTMLElement {
  private _unmount: (() => void) | null = null;
  connectedCallback() { this._unmount = mountProfile(this); }
  disconnectedCallback() { this._unmount?.(); this._unmount = null; }
}

customElements.define('ski-button', SkiButtonElement);
customElements.define('ski-dot', SkiDotElement);
customElements.define('ski-balance', SkiBalanceElement);
customElements.define('ski-profile', SkiProfileElement);
