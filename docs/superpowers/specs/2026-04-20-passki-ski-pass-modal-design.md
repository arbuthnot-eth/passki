# PASSKI Modal — Ski-Pass Redesign

**Status:** draft
**Date:** 2026-04-20
**Swarm vote:** 5/5 for option (a) Single-pass swipe deck

## Motivation

The current SKI modal is a dense dashboard: header + legend list + detail pane + gear strip + settings toggle. It treats wallet selection as a data problem (pick a row from a list). For the passki.xyz identity pitch ("once, everywhere" — suiami in with one tap), the modal should feel like a **physical ski lift pass** hanging from a lanyard: one card, one tap, you're on the lift.

Redesign goal: make the modal literally resemble a ski pass, and make the pass itself the sign-in surface — zero list, one gesture.

## Shape of the thing

```
╭─── ○ ───╮   ← lanyard hole + clip
│ PASSKI  │
│  ▲      │
│ [pfp]   │   ← photo / blue-square or profile
│ waap    │
│  .sui   │   ← big name (SuiNS)
│  ─ ─ ─  │
│ [QR]    │   ← scan zone (receive addr)
│ 0x2b…e28│
│ Splash◉ │   ← resort "season pass" marker (if splashed)
│ [X][○]  │   ← provider badge, dot status
╰─────────╯
      ↙ ↘  ← stubs of adjacent passes peek from edges
```

- Whole card is tap-to-LOCKIN (or stamp-to-fill for empty state).
- Swipe left/right on the pass flips wallets. Keyboard: ← → arrows.
- Scroll wheel on desktop = flip.
- Stubs of adjacent passes peek ~12px from each edge so users see the deck exists.

## Three pass variants

### 1. **Filled pass** (has signer ready)
- User has a wallet installed (WaaP or extension) with at least one address cached, OR is already connected.
- Tap anywhere on the pass → sign-in via that wallet (LOCKIN flow).
- Pass shows: pfp, `name.sui` or truncated addr, splash marker (if active), QR, provider icon.

### 2. **Blank pass** (stamp-to-fill — the empty state)
- Default when no wallet is connected and none is available.
- Shows a WaaP-branded blank template with four "stamp" zones: Google · X · Discord · Email.
- Tap a stamp → triggers WaaP single-provider flow directly (no intermediate modal).
- On success, pass seamlessly transitions to Filled state (no reload, no second screen).

### 3. **Install pass** (wallet detected but not installed)
- Only appears in deck if user has asked for an extension that isn't present (e.g. Slush, Phantom).
- Tap → opens store link in new tab. Not a core state; lowest priority.

## Deck rules

- **Order:** Filled passes (connected first, then cached) → Blank pass (always present as a terminal slot) → Install passes.
- **Empty first-visit:** just the Blank pass. No phantom stubs. Large "PASSKI — tap a stamp to sign in" label.
- **Multiple Filled:** connected wallet sits in front. Cached wallets sit behind, swipeable. Blank pass always lives at the back so you can always add another.
- **Active wallet:** indicated by a small "LIFT ON" chip on the filled pass (replaces the current SKI-lift SVG appearing in the header).

## Interactions

| gesture | effect |
|---|---|
| tap filled pass | LOCKIN / sign-in with that wallet |
| tap a stamp on blank pass | trigger that WaaP provider directly |
| swipe / drag horizontal | flip to adjacent pass |
| ← → arrow keys | flip |
| click on peeking stub | swap it to front |
| tap clip/lanyard hole | close modal |
| tap QR | copy receive address (existing behavior) |
| long-press pass | reveal secondary actions (disconnect, forget, splash toggle) |

## What gets removed

- The legend list (`.ski-splash-legend`, `ski-legend-targets`, `ski-legend-row`) — not rendered in the new modal at all.
- The `#ski-modal-detail` pane and its header — the pass replaces it.
- The `#ski-qr-split-slot` experiment and its CSS — folded into the pass itself.
- The Splash layout toggle at the bottom — Splash becomes a per-pass badge you tap on the pass itself. The gear icon stays.

## What stays

- Modal chrome (overlay, close behavior, `ski-modal-active` class on widget).
- PASSKI.XYZ / "once, everywhere" tagline above the deck.
- Gear settings strip below the deck (layout, language, etc — but the "Splash layout" toggle is gone since there's only one layout now).
- Idle overlay cycle behavior (`ski-idle-active` button state) — untouched.

## Components

### `PassCard` (presentational)
Renders one pass at a given deck index. Props: wallet metadata, suinsName, address, provider, splashState, variant (`filled` | `blank` | `install`), isActive (front of deck), peekOffset (for stubs).

### `PassDeck` (container)
Holds array of passes in the correct order, tracks `frontIdx`, responds to swipe/keyboard/click, emits `onLockin(walletName)` and `onStamp(provider)`.

### `blankPassStamps` (sub-view of PassCard)
Four big tap-targets for Google / X / Discord / Email. Each fires WaaP registration with the specific provider hint and no modal of its own.

## CSS primitives (new)

- `.ski-pass` — the card. Aspect ratio ~2:3 (portrait lift pass), rounded corners, plastic-sleeve background, subtle inner shadow, top lanyard hole (punched circle SVG).
- `.ski-pass--filled` / `.ski-pass--blank` / `.ski-pass--install` variants.
- `.ski-pass-deck` — the carousel. CSS scroll-snap on horizontal overflow for free mobile swipe; JS translates `frontIdx` to `scrollTo`.
- `.ski-pass-stub` — the cropped peek of adjacent passes. Faded, tilted 2°, clickable.
- `.ski-pass--active` — pulse glow matching the "LIFT ON" state.

All built on top of existing color tokens (no new palette).

## Accessibility

- Each pass is `role="button"` with a descriptive label (`"Sign in with waap.sui — WaaP, X provider"`).
- Stamp zones are individual `role="button"`s.
- Arrow keys + Home/End navigate the deck. Enter activates the front pass.
- Respect `prefers-reduced-motion`: no tilt, no stub peek animation, instant pass swap instead of slide.

## Open questions (resolve in follow-up)

1. **Card dimensions:** fixed portrait aspect, or adapt to modal width? → portrait, min 260×390px, scaled up proportionally on wider modals.
2. **Stamp provider order:** default Google/X/Discord/Email or detect region/pref? → fixed order for MVP.
3. **Multiple filled passes for same WaaP identity (WaaP brings many address buckets):** still one pass per wallet, or one per address? → one per wallet, with a subtle counter (`3 keys`) on the pass — tapping the counter expands a back-of-card view with the other addresses.
4. **Splash per-pass toggle placement:** drop-icon in the top-right of the pass (tappable). Long-press or single-tap? → single-tap icon, confirmed by the icon flipping to the "active" fill.

## Build sequence

1. **Scaffold PassCard + 3 variants** with placeholder data, wired to existing wallet state. Render one at a time first (no deck).
2. **Wire LOCKIN action** on filled pass tap — reuse existing sign-in pipeline.
3. **Wire stamp action** on blank pass — reuse `registerWaaP(providerHint)` path.
4. **Build PassDeck** carousel: horizontal scroll-snap, keyboard bindings, peek stubs.
5. **Replace modal body** with `<PassDeck>`. Delete legend/detail pane code paths.
6. **Polish:** splash drop per-pass, lanyard hole graphic, plastic sleeve background, active-pass glow, reduced-motion fallback.
7. **Migration sweep:** remove `ski-legend-*`, `ski-detail-*`, `ski-qr-split*`, `ski-modal-legend-col`, Splash layout toggle. Update `getModalLayout()` to always return the new pass mode.

Each step is independently deployable; the old modal survives until step 5.

## IKA + Cloudflare primitives (first-class, not bolt-ons)

The ski-pass isn't just a visual wrapper — it's the UI skin over the **Suilana Ikasystem** identity stack. Every pass variant must respect the IKA-native commandment and lean on CF edge infra where it earns its keep.

### IKA (first commandment: keyless IKA-native)

- **Stamp = Rumble.** Tapping a stamp on the Blank pass runs IKA DKG in-browser and provisions a fresh dWallet (`Rumble` ceremony). The stamp is the visible proxy for an all-chain DKG. No raw keypair is ever generated — the pass is literally stamped *by* an IKA dWallet.
- **Cross-chain fields on the pass back:** BTC / ETH / SOL / TRON addresses — all derived from the dWallet via DKG, never from re-encoded Sui pubkeys. Long-press to flip the pass and see them. Reads from SUIAMI roster (`reference_suiami_is_truth.md`).
- **Imported-key ed25519** (shipped): when a pass needs to import a legacy ed25519 identity into a dWallet, use `prepareImportedKeyDWalletVerification(Curve.ED25519)`. No more address migration gymnastics.
- **Per-guest fresh dWallets:** for shielded sends / Sneasel-arc flows, each send originates from a throwaway dWallet provisioned at send time. The pass UI must allow "one-shot pass" mode — a tear-off stub that mints a fresh dWallet, signs once, and is discarded. Great metaphor: single-day lift ticket vs season pass.
- **Agent sign-in = dWallet re-encryption.** When brando.sui stamps a pass and wants an agent to inherit it, the DKG share is re-encrypted to the agent in-browser; either brando or agent + IKA network = valid signature. The pass has a "season pass" badge when co-signed by an agent.

### Cloudflare edge capabilities (hook where it makes sense)

| capability | passki modal use |
|---|---|
| **Durable Objects** | `PasskiDeckDO` per-wallet: holds the ordered deck state (which pass is front, which are stubs, which are installed vs cached) so a returning user on any device sees the same deck. Mirrors `Chronicom` DO pattern. |
| **DO Alarms** | Expire Blank-pass stamp sessions after N minutes; retire one-shot dWallets from the deck. No polling from the client. |
| **D1** | SUIAMI-roster read cache — resolve `.sui` → cross-chain addr at the edge before the pass even reaches the client, so the QR and pfp render instantly. |
| **KV** | Per-pass Splash sponsor state (which wallet is splashed, expiry). Reads from KV → instant pass badge, no RPC round-trip. |
| **Hyperdrive / R2** | Blob storage for the ski-pass plastic-sleeve artwork (SVG, video textures). R2 for the animated LIFT ON pulse video if we go there. |
| **Workers Queues** | Batch DKG provisioning for blank-pass stamps — user taps Google stamp, Worker enqueues a DKG job, PasskiDeckDO picks it up under alarm, pass shows "stamping…" then flips to filled. Avoids blocking the UI on on-chain confirmation. |
| **Hono + x402** | Premium passes (limited-edition collab designs, resort sponsorships) paywalled with x402 at the edge. Pass card renders a "locked" variant until payment resolves. Zero cost for free passes. |
| **Service bindings** | Two workers already exist (`dotski` treasury/agents, `sui-ski` subnames/auth). The passki modal lives in `sui-ski` and calls `dotski` via service binding for agent-co-signed passes. No public API required. |
| **CF Edge identity (email routing, access)** | Optional "email-bound pass" variant that uses CF Email Routing to bind a pass to `<bareName>@passki.xyz`. User can receive a PASSKI via email QR link. |
| **Pages → Workers migration** | Modal assets stay on Workers Assets, not Pages. Consult `mcp__claude_ai_Cloudflare_Developer_Platform__migrate_pages_to_workers_guide` if any Pages remnant exists. |

### Endpoint choices baked in

- **No JSON-RPC submit from DOs.** `PasskiDeckDO` submits transactions via the multi-URL fallback chain (PublicNode → BlockVision → Ankr). The Mysten April-2026 sunset is accounted for.
- **gRPC in browser, GraphQL in DO.** Browser uses `SuiGrpcClient` when available (Brave desktop) and falls back to `SuiGraphQLClient` on mobile/restricted transports. DO-side uses GraphQL for reads + multi-RPC submit for writes.
- **Seal session** warmed at pass-stamp time so subsequent Thunder convos don't need a second signature.

### IKA-native empty state flow (concrete)

```
[Blank pass shown]
  ↓ tap "Google" stamp
[Browser] → trigger WaaP(Google) → get ski:waap-provider:<addr> = 'google'
[Browser] → enqueue DKG job to PasskiDeckDO via Worker
[PasskiDeckDO] → CF Queue → IKA network (secp256k1 + ed25519 curves)
[PasskiDeckDO] → writes to SUIAMI roster (BTC/ETH/SOL derived addrs)
[Browser] → DO alarm fires → pass animates from Blank → Filled
  • pfp, name.sui input (if not yet claimed → inline claim CTA)
  • QR with Sui receive addr
  • provider badge (Google)
  • season-pass ring if sponsored
```

All keys live in the IKA dWallet. Cloudflare never holds a private key. Ever.

## Risk flagged by swarm

Single risk noted unanimously: if the Blank pass isn't obviously tappable, first-time users see a "dead" card and bounce. Mitigation: the blank pass is bright, each stamp is ~60×60px with the provider's icon, and a subtle pulse on the stamps until one is chosen. Label reads **"tap a stamp to sign in"**.
