---
pokemon: Rhydon
current_level: 35
type: [Ground, Rock]
evolves_from: Rhyhorn
evolves_to: Rhyperior (unlocked at 10+ successful sweep-cycles)
captured_by: claude-opus-4.6
captured_issue: "#74"
capture_date: 2026-04-11
total_commits: 0
total_loc_delta: 0
merges: []
status: in-progress
---

## Capture story (initial observation)

Rhydon represents the **IOU-expiry sweeper integration into TreasuryAgents' alarm tick** — a ground-type Pokemon because it deals with on-chain earth (object pruning), and rock because it carries the keeper-pattern's weight. Rhyhorn (the parent) was the original `iou-sweeper.ts` standalone module, hand-wired to the Cloudflare cron. Rhydon is the evolution where the sweeper becomes a heartbeat-driven routine inside the main treasury agent, giving us two redundant execution paths: the 10-minute cron tick AND the TreasuryAgents internal alarm.

## Research notes

- `src/server/iou-sweeper.ts` (177 lines) exports `sweepExpiredIous(env)`. Already handles both legacy `thunder_iou::Iou` and shielded `thunder_iou_shielded::ShieldedVault` via `fetchLiveIous` → `recallOne` dispatch. Self-contained, idempotent, failures logged + swallowed. No state mutation.
- Currently invoked from two places in `src/server/index.ts`:
  - `POST /api/iou/sweep` (line 1831) for manual testing.
  - `scheduled()` handler (line 1851) via the `*/10 * * * *` cron in wrangler.jsonc.
- `src/server/agents/treasury-agents.ts` has `_tick` (line ~1277) that runs every few seconds via the Agent framework's alarm. Existing pattern: `await this._scanArb(); await this._runT2000Missions(); await this._retryOpenQuests(); …`
- ShadeExecutorAgent (the pattern the issue references) uses a DO Alarm scheduled at the exact expiry time. We don't need that precision for IOU sweeping — the 10-min cadence is plenty. We just need a second heartbeat so that a single missed cron tick doesn't strand funds for 20 minutes.

## Capture plan

Small and scoped. No rewriting iou-sweeper.ts — consume it as-is.

1. Add `last_iou_sweep_ms?: number` to `TreasuryAgentsState` so we can throttle.
2. Add `_sweepExpiredIous()` method to `TreasuryAgents` that:
   - Checks `now - last_iou_sweep_ms > 5 * 60 * 1000` (5-minute throttle, twice as fast as cron).
   - On pass, dynamic-imports `sweepExpiredIous` from `../iou-sweeper.js` and runs it with `this.env`.
   - Logs the result via `console.log('[treasury] iou-sweep: …')` matching existing tick conventions.
   - Updates `last_iou_sweep_ms` on any call (success or fail), so failures don't spin-retry.
3. Wire `await this._sweepExpiredIous();` into `_tick` right after `_watchSuiUsdcDeposits` (the Phase 1c watcher we just shipped), since both deal with the same intent / escrow lifecycle surface.
4. No Pokedex update to existing `TreasuryAgentsState` shape that breaks state migration — adding an optional field is forward-compatible.
5. Test: deploy, watch `wrangler tail` for `[treasury] iou-sweep: …` log lines within ~10 minutes of a live expired IOU.

## Test plan

- [ ] Sub-cent Phase 1 didn't regress (sweeper runs every 5 min from TreasuryAgents, cron still runs every 10 min — both call the same idempotent function).
- [ ] `_sweepExpiredIous` doesn't run more than once per 5 min even if `_tick` fires every 30 s.
- [ ] No new TypeScript errors from the change (pre-existing `env` type issues in TreasuryAgents predate this capture).
- [ ] Manual trigger via `POST /api/iou/sweep` still works.
- [ ] `wrangler deploy` lands cleanly.

## Evolution gate

Rhydon → **Rhyperior** fires when this sweeper has executed 10 successful alarm-tick sweeps on mainnet (counted by log grep on `wrangler tail`). At that point the redundancy is proven and the module has earned its evolved form.
