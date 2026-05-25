# Findings Log

> Running capture of surprises, recap/code contradictions, and latent bugs found during the audit.
> Feeds the prioritized backlog (ARCHITECTURE.md §5). **Not yet ranked** — that happens in Phase 6.
> Confidence: **High** = line-verified or self-evident · **Med** = strong lead from breadth read, needs confirm · **Low** = speculative.
> "Resolve in" = the phase that will confirm/scope it.

| ID | Title | Type | Confidence | Resolve in |
|----|-------|------|-----------|-----------|
| F-001 | Week-keying conflict: Sunday vs Monday anchors coexist | structural | High | Phase 3 |
| F-002 | `ProductionTab.jsx` orphaned (dead imports in App.jsx) | dead code | High | Phase 4 |
| F-003 | `lock-wip` still uses Monday.com + `wip_snapshots` despite "retired" claim | contradiction | Med | Phase 2 |
| F-004 | `SCHEDULABLE_STATUSES`/`NG_PREPROD` duplicated across 3 files | duplication | High | Phase 4 |
| F-005 | NJ/BNY targets duplicated despite `budgets.js` | duplication | High | Phase 4 |
| F-006 | `derivePeriod()` read/write contract split across 2 files | duplication/risk | Med | Phase 4 |
| F-007 | Age-bucket logic + key naming inconsistent across modules | duplication | Med | Phase 4 |
| F-008 | productionRollup logic reimplemented in ~5 places | duplication | High | Phase 4 |
| F-009 | Heartbeat passes Sunday date to Monday-keyed `getFiscalLabel` | latent bug | Med | Phase 3 |
| F-010 | AI calls inconsistently logged to `ai_call_log` | observability | High | Phase 5 |
| F-011 | `PlantRollup.jsx` suspected unused | dead code | Med | Phase 4 |
| F-012 | Two `/api/claude` impls; Node one likely unreachable | dead code/config | Med | Phase 2/4 |
| F-013 | netlify.toml routes Node functions under `[[edge_functions]]` | config/deploy | Med | Phase 2 |
| F-014 | `VITE_`-prefixed server secrets (latent client exposure) | security | High | (seeded) |
| F-015 | `supabase-schema.sql` stale vs live DB | doc/data | High | Phase 2 |
| F-016 | `slack-sync` uses anon key server-side for writes | security | Med | Phase 2 |

---

## Details

### F-001 — Week-keying conflict (TOP PRIORITY) · structural · High
Sunday-anchored and Monday-anchored week logic coexist, sometimes within one destination. `fiscalCalendar.js` keys are **Monday** dates (verified: `2026-01-05` is a Monday); `sched_*`/`production` are **Sunday**-keyed post the May 2026 migration. Monday-anchored offenders: `DashboardPage`, `WeekPaceStrip`, `ProductionDashboard` (internal), `historicalSummaries`, `contextBuilder` (date-fns default), `lock-wip`. Sunday: `App`, `AdminPanel`, `HeartbeatPage`, scheduler stack, `dailyOps`. `ExecutiveDashboardPage` hedges by querying both keys.
**Why it matters:** single-key Monday queries miss Sunday-keyed rows → silent "no data"/wrong-week aggregation. The recap names this the #1 structural fix; corroborated.
**Resolve in Phase 3** — line-verify every row of the week-anchor table, define canonical anchor + migration/codemod plan.

### F-002 — ProductionTab orphaned · dead code · High
`App.jsx:16` imports `FacilityDetail, OperatorScorecard, useProductionData, generateLiveOpsPDF` from `ProductionTab` but never mounts them. `ProductionTab` is a Google-Sheets mirror (uses `VITE_GOOGLE_SHEETS_API_KEY`) disconnected from the Supabase `sched_daily_ops` flow. Cleanup candidate (seeded from /init).

### F-003 — lock-wip vs "Monday.com retired" · contradiction · Med ⚑ recap/code
`WIPTab.jsx` header comment states Monday.com boards, the Load-Data button, and the `wip_snapshots` table are gone and LIFT upload is canonical. But `Functions/lock-wip.js` is a **scheduled** function (`0 5 * * 6`) that still fetches Monday board `6053588909` and upserts `wip_snapshots` weekly. Either a zombie cron (cost + stale data) or the "retired" claim is aspirational.
**Evidence (repo-wide grep):** the only references to `wip_snapshots` are the writer (`lock-wip.js:108`) and the "it's gone" comment (`WIPTab.jsx:21`). **No read path exists** — no `.from('wip_snapshots')`, no REST GET, no view. So the cron writes weekly to a table the product never reads → strong zombie signal.
**Resolve as an early Phase 2 sub-investigation** (gates §5 prioritization — whether `lock-wip` is load-bearing changes the backlog). Remaining facts: (a) does `wip_snapshots` still exist in the live schema [answered by `db/schema.sql`]; (b) is board `6053588909` / its token still live; (c) is the cron actually firing or erroring [overlaps F-013 deploy-log check]. If all three say "dead," F-003 becomes a delete-the-cron backlog item rather than a fix.

### F-004 — Pool-status sets duplicated · duplication · High
`SCHEDULABLE_STATUSES` + `NG_PREPROD` hardcoded in `WIPTab`, `PassaicScheduler`, `BNYScheduler`. A change to "what's schedulable" needs 3 edits. → extract to `scheduleUtils`/shared module.

### F-005 — Targets duplicated despite budgets.js · duplication · High
`budgets.js` is the intended canonical source, yet `AdminPanel`, `DashboardPage`, `WeekPaceStrip` carry local `NJ_TARGETS`/`BNY_TARGETS` copies. Drift risk.

### F-006 — derivePeriod read/write contract · duplication/risk · Med
`FinancialTab.derivePeriod()` (read) must exactly match `AdminFinancials.derivePeriod()` (write); divergence makes financial data silently vanish. Extract + test the round-trip.

### F-007 — Age-bucket inconsistency · duplication · Med
WIPTab uses keys `current/30/60/90/90plus`; NewGoodsView uses `0-30/31-60/61-90/90+/no-date`. Both recompute from `age_days` though the parser already writes `age_bucket`. Standardize on one scheme/source.

### F-008 — productionRollup reimplemented · duplication · High (the recap's named example)
Yards/color-yards/waste/revenue aggregation appears bespoke in `HeartbeatPage` (multiple helpers), `ProductionDashboard`, `PassaicScheduler.mixTotals`, `BNYScheduler.mixTotals`, `WIPTab` pivots, and `ProductionTab`. Differing groupings → no automatic cross-check between pool/scheduled/produced. Prime extraction target for Phase 4.

### F-009 — Heartbeat fiscal-label anchor mismatch · latent bug · Med
`HeartbeatPage` computes a Sunday `weekKey` but calls `getFiscalLabel(weekStart)` whose `FISCAL_CALENDAR` is Monday-keyed. May mislabel/return null on some weeks. Confirm in Phase 3 alongside F-001.

### F-010 — Inconsistent AI-call logging · observability · High
`ClaudeReadBlock` logs every call to `ai_call_log` via `contextBuilder.logAICall`; the ad-hoc `/api/claude` callers (`KPIScorecard`, `AdminPanel`, `AdminPeople`, `MonthlyBriefs`) do not. Gaps in cost/usage visibility. Relevant to Phase 5 narrative-unification (centralizing AI access).

### F-011 — PlantRollup unused · dead code · Med
`PlantRollup.jsx` is fully built but not imported by `HeartbeatPage` (which inlines a richer `PlantPulse`). Confirm no other importer; delete if dead.

### F-012 — Duplicate /api/claude · dead code/config · Med
Edge `claude.ts` and Node `claude.mjs` both claim `/api/claude`; netlify.toml routes the path to the edge function, so the Node (streaming-capable) one is likely dead. Streaming actually goes through `/api/claude-stream`. Decide which to keep.

### F-013 — netlify.toml edge/node routing mismatch · config/deploy · Med
Two stacked mismatches: (1) `netlify.toml` declares `/api/lock-wip` and `/api/generate-pdf` under `[[edge_functions]]`, but both are **Node** functions, and edge functions are sourced from `netlify/edge-functions/` where they do **not** exist. (2) The Node `functions` dir is configured as `netlify/functions` (lowercase) while the actual dir is `netlify/Functions` (capital F) — on Netlify's case-sensitive Linux build this may not resolve, so `lock-wip`, `generate-pdf`, and `claude.mjs` could fail to register at all. The `[[scheduled_functions]]` block for `lock-wip` also depends on the same dir resolution.
**Status: UNVERIFIED — needs deploy/runtime logs.** Netlify CLI is not installed locally (`netlify: command not found`), so this can't be confirmed from the repo. User to check via `netlify functions:list` / dashboard Functions tab. If `lock-wip` is not registered, that *also* closes F-003 (the cron never runs).

### F-014 — VITE_-prefixed server secrets · security · High (seeded /init)
`VITE_ANTHROPIC_API_KEY`, `VITE_MONDAY_TOKEN` are server-only today but the prefix means any future frontend reference bundles them into public JS. Rename to unprefixed; update `claude.ts`, `claude-stream.mjs`, `Functions/claude.mjs`, `lock-wip.js` (newgoods funcs already accept fallback).

### F-015 — Stale schema file · doc/data · High (seeded /init)
`supabase-schema.sql` documents only the original 3 tables; live DB has ~30+ tables/views via uncommitted migrations. Live export needed for Phase 2 (`db/schema.sql`).

### F-016 — slack-sync uses anon key server-side · security · Med
`slack-sync.ts` performs writes to `section_comments` using `VITE_SUPABASE_ANON_KEY` rather than the service role. Works only because RLS is permissive; should use service role for server writes.

---

## Cross-agent reconciliations (caught during synthesis)
- **fiscalCalendar anchor:** one explore agent labeled the keys "Sunday"; arithmetic shows `2026-01-05` is a **Monday**. Keys are Monday-anchored. The agent's "no conflict" conclusion was wrong; conflict is real (F-001).
- **Streaming Claude path:** Node `claude.mjs` advertised as the streaming endpoint, but routing + actual usage point to `/api/claude-stream`. Treated as F-012.
