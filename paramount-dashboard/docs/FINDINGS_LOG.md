# Findings Log

> Running capture of surprises, recap/code contradictions, and latent bugs found during the audit.
> Feeds the prioritized backlog (ARCHITECTURE.md §5). **Not yet ranked** — that happens in Phase 6.
> Confidence: **High** = line-verified or self-evident · **Med** = strong lead from breadth read, needs confirm · **Low** = speculative.
> "Resolve in" = the phase that will confirm/scope it.

| ID | Title | Type | Confidence | Resolve in |
|----|-------|------|-----------|-----------|
| F-001 | Week-keying conflict: Sunday vs Monday anchors coexist | structural | High | Phase 3 |
| F-002 | `ProductionTab.jsx` orphaned (dead imports in App.jsx) | dead code | High | Phase 4 |
| F-003 | Monday.com footprint: New Goods live/load-bearing, `lock-wip`→`wip_snapshots` inert | contradiction/scope | High | Phase 2 |
| F-004 | `SCHEDULABLE_STATUSES`/`NG_PREPROD` duplicated across 3 files | duplication | High | Phase 4 |
| F-005 | NJ/BNY targets duplicated despite `budgets.js` (source-of-truth settled: Mar 2026 deck) | duplication | High | Phase 4 |
| F-006 | `derivePeriod()` read/write contract split across 2 files | duplication/risk | Med | Phase 4 |
| F-007 | Age-bucket logic + key naming inconsistent across modules | duplication | Med | Phase 4 |
| F-008 | productionRollup logic reimplemented in ~5 places | duplication | High | Phase 4 |
| F-009 | Heartbeat passes Sunday date to Monday-keyed `getFiscalLabel` | latent bug | Med | Phase 3 |
| F-010 | AI calls inconsistently logged to `ai_call_log` | observability | High | Phase 5 |
| F-011 | `PlantRollup.jsx` suspected unused | dead code | Med | Phase 4 |
| F-012 | Two `/api/claude` impls; Node `claude.mjs` confirmed unreachable | dead code/config | High | Phase 2/4 |
| F-013 | Node functions not deployed: dir-casing + missing edge files (CONFIRMED) | config/deploy | High | Phase 2 |
| F-014 | `VITE_`-prefixed server secrets (latent client exposure) | security | High | (seeded) |
| F-015 | `supabase-schema.sql` stale vs live DB | doc/data | High | Phase 2 |
| F-016 | RLS is not an access boundary: 25 tables anon-exposed (RLS disabled), incl. financials/payroll-inputs/AI logs | security | High | Phase 2 |
| F-017 | `generate-pdf.mjs` not deployed + likely unused dead code | dead code | Med | Phase 4 |
| F-018 | `monthly_briefs` absent → MonthlyBriefs save/load broken; `monthly_reports` orphan = incomplete rename | bug/data | High | Phase 2 |
| F-019 | `role_change_log` absent → UserManagement role audit silently fails | bug/data | High | Phase 2 |
| F-020 | `profiles.role` DEFAULT `'viewer'` violates CHECK (`admin\|manager\|qa\|exec`) | schema defect | High | Phase 2 |
| F-021 | Export-lossiness: composite uniques dropped (live `financials_monthly UNIQUE(period,business_unit)`) | doc/data | High | Phase 2 |
| F-022 | `sched_current_wip` orphan view + 3 divergent snapshot mechanisms | structural/dead | High | Phase 4 |
| F-023 | `comments` dead table | dead code | High | Phase 4 |
| F-024 | `sched_daily_ops` composite-unique export gap (2nd instance of F-021) | doc/data | Med | Phase 2 |
| F-025 | MODULE_MAP gap: `Correspondence.jsx` unmapped (live component) | doc gap | High | Phase 4 |

---

## Details

### F-001 — Week-keying conflict (TOP PRIORITY) · structural · High
Sunday-anchored and Monday-anchored week logic coexist, sometimes within one destination. `fiscalCalendar.js` keys are **Monday** dates (verified: `2026-01-05` is a Monday); `sched_*`/`production` are **Sunday**-keyed post the May 2026 migration. Monday-anchored offenders: `DashboardPage`, `WeekPaceStrip`, `ProductionDashboard` (internal), `historicalSummaries`, `contextBuilder` (date-fns default), `lock-wip`. Sunday: `App`, `AdminPanel`, `HeartbeatPage`, scheduler stack, `dailyOps`. `ExecutiveDashboardPage` hedges by querying both keys.
**Why it matters:** single-key Monday queries miss Sunday-keyed rows → silent "no data"/wrong-week aggregation. The recap names this the #1 structural fix; corroborated.
**Resolve in Phase 3** — line-verify every row of the week-anchor table, define canonical anchor + migration/codemod plan.

### F-002 — ProductionTab orphaned · dead code · High
`App.jsx:16` imports `FacilityDetail, OperatorScorecard, useProductionData, generateLiveOpsPDF` from `ProductionTab` but never mounts them. `ProductionTab` is a Google-Sheets mirror (uses `VITE_GOOGLE_SHEETS_API_KEY`) disconnected from the Supabase `sched_daily_ops` flow. Cleanup candidate (seeded from /init).

### F-003 — Monday.com footprint: scope widened · contradiction/scope · High ⚑ recap/code
**Rescoped** from "is `lock-wip` a zombie?" to **"what is the full Monday.com footprint, and which parts are load-bearing vs. dead?"** The "Monday.com retired" claim (`WIPTab.jsx` header + RECAP §8/Appendix) is true only for the *scheduling/WIP-source* use; Monday persists in two places:
- **New Goods — LOAD-BEARING / live.** `monday-newgoods-refresh` + `monday-newgoods-observations` edge functions pull Monday GraphQL into `mng_snapshots`/`mng_items`, backing the user-facing `NewGoodsTab`. Not deprecated. The blanket "Monday is gone" framing in RECAP/`WIPTab` is wrong and undercounts the footprint.
- **`lock-wip` → `wip_snapshots` — INERT.** `Functions/lock-wip.js` is wired as a scheduled function (`0 5 * * 6`) that fetches Monday board `6053588909` and upserts `wip_snapshots`, but it **never runs in production** — not deployed (dir-casing bug, F-013), so the cron never fires (`netlify functions:list --json` → `lock-wip` `isDeployed:false`; `netlify logs --function lock-wip --since 7d` → no logs). Dead code, not a running zombie. No read path for `wip_snapshots` exists anywhere either (only the writer + the "it's gone" comment at `WIPTab.jsx:21`).
**Remaining open (lower stakes now):** (a) ~~does `wip_snapshots` still exist in the live schema~~ **CONFIRMED ABSENT** — `wip_snapshots` does not exist in the live schema (`db/schema.sql`, May 2026; `DATA_MODEL §6`), so `lock-wip` is now **triply dead**: not deployed (F-013) + no write target + no reader; (b) board `6053588909` / token validity. Verdict on `lock-wip`: **delete the cron + function**, not fix — bundle with the F-013 cleanup.

### F-004 — Pool-status sets duplicated · duplication · High
`SCHEDULABLE_STATUSES` + `NG_PREPROD` hardcoded in `WIPTab`, `PassaicScheduler`, `BNYScheduler`. A change to "what's schedulable" needs 3 edits. → extract to `scheduleUtils`/shared module.

### F-005 — Targets duplicated despite budgets.js · duplication · High — source-of-truth SETTLED
`budgets.js` is the intended canonical source, yet `AdminPanel`, `DashboardPage`, `WeekPaceStrip` carry local `NJ_TARGETS`/`BNY_TARGETS` copies — and the copies already diverged (RECAP §10: Passaic CY as both 33,797 and 25,497; BNY HOS/Memo swapped; small-machine capacity 125 vs 500 yd/day).
**Source-of-truth settled (owner, May 2026): the Paramount Prints March 2026 Results deck is authoritative for all production targets.** Canonical values below supersede every prior set. Phase 4 narrows to a pure consolidation: make `budgets.js` match the deck and delete the local copies. **One open input remains (see BNY +500).**

**Passaic (610):**
- *Weekly:* 8,500 yd / 25,500 CY — Grasscloth 3,785 yd / 11,355 CY · Fabric 834 yd / 2,502 CY · Wallpaper 3,881 yd / 11,643 CY. (Sums verified; resolves the 33,797-vs-25,497 CY conflict → **25,500**.)
- *Monthly (5-wk):* Net Produced 42,500 yd / 127,500 CY · Net Invoiced 39,125 yd / 117,375 CY (~92.06% of produced) · Held-to-Invoice <8,500.
- *Waste:* <8% (3,099 yd) — blended weighted target from per-ground per-line allowances (Paper 6 yd/line ≈20%, Grass 1 yd/line ≈4%, Fabric 2 yd/line ≈8%), not a flat rate. Deck-stated (Slide 11); no derivation.

**BNY (609) — carries TWO totals:**
- *Formal budget (financial plan): 12,000 yd/wk* — Replen 7,885 · MTO 1,280 · Memo 1,535 · HOS 210 · 3rd Party 1,090 (= 12,000 ✓). **HOS/Memo swap settled: Memo 1,535 (larger) / HOS 210 (smaller)** — RECAP had these inverted.
- *Operational target (dashboard, 4-4-5 basis): **12,500 yd/wk*** — the team shoots higher to absorb product-mix variance. Monthly: 4-wk = 50,000 · 5-wk = 62,500 (= 12,500 × 5 ✓). **`budgets.js` BNY weekly total = 12,500, not 12,000.**
- ⚠️ **OPEN — Phase 4 input required:** the +500 operational uplift (12,000 → 12,500) has **no confirmed per-bucket home.** Candidate is Replen → 8,385 (largest/most variable bucket), but do **not** assume — the per-bucket vector summing to 12,500 needs explicit per-team confirmation before extraction. `budgets.js` may hold the 12,500 *total* now; the bucket split stays provisional.
- *Monthly:* Net Produced = Net Invoiced = 62,500 (no produced→invoiced gap, unlike Passaic) · Waste <5% (3,074 yd, blended) · Held-to-Invoice prior-month <12,000, current <10,000.

**Machine capacity (Slide 25) — resolves the 125-vs-500 conflict → 125 yd/day:**
- *3600-class (high-volume, BNY): Trish, Sasha, Glow* — 600 yd/day · 15,000 yd/mo each · 45,000 yd/mo class total (3 machines).
- *Small (570/800/830-class): 125 yd/day · 3,125 yd/mo each · 50,000 yd/mo class total (16 machines)* — BNY: Lash, Bianca, Rhonda (trial), Chyna (trial); Passaic-located (609 budget): Dakota, Ruby, Xia, Ember, Dementia, Valhalla, Ivy, Jacy, Zoey, Apollo, Nemesis, Poseidon.
- *Fleet: 19 machines (7 BNY + 12 Passaic-physical), 95,000 yd/mo* vs. 62,500 operational target (~66% utilization). Roster matches `BNYScheduler`.

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

### F-012 — Duplicate /api/claude · dead code/config · High — CONFIRMED unreachable
Edge `claude.ts` and Node `Functions/claude.mjs` both claim `/api/claude`; `netlify.toml:7–8` routes the path to the **edge** function (`claude.ts` exists in `netlify/edge-functions/`), so the Node one never serves the route. On top of that, `claude.mjs` lives in the mis-cased `netlify/Functions/` dir and isn't deployed at all (`isDeployed:false`, F-013) — dead two ways over. Streaming goes through `/api/claude-stream`. Action: delete `Functions/claude.mjs`.

### F-013 — Node functions not deployed · config/deploy · High — CONFIRMED
**Verified via Netlify CLI against the live `updates-paramount` deploy (May 2026).** Two stacked mismatches, both confirmed:
1. **Dir casing.** Git tracks the Node functions at `netlify/Functions/` (capital F — `claude.mjs`, `generate-pdf.mjs`, `lock-wip.js`), but `netlify.toml:4` sets `functions = "netlify/functions"` (lowercase). On Netlify's case-sensitive Linux build the configured path doesn't exist, so **zero Node functions bundle** — `netlify functions:list --json` reports `isDeployed:false` for all three. The `[[scheduled_functions]]` block (`lock-wip`) sources from the same missing dir → the cron never registers/fires. (Invisible locally because Windows is case-insensitive.)
2. **Missing edge files.** `netlify.toml:10–16` declares `/api/lock-wip` and `/api/generate-pdf` under `[[edge_functions]]`, but no such files exist in `netlify/edge-functions/` (only `claude.ts`, `claude-stream.mjs`, `monday-newgoods-*`, `slack*`). Those two routes point at edge functions that don't exist.
**Fix:** rename the dir to lowercase `netlify/functions` (git mv with a real case change) and remove `lock-wip`/`generate-pdf` from the `[[edge_functions]]` blocks (they're Node, not edge). Closes the last open F-003 fact (cron never fires) and the deploy limb of F-012.

### F-014 — VITE_-prefixed server secrets · security · High (seeded /init)
`VITE_ANTHROPIC_API_KEY`, `VITE_MONDAY_TOKEN` are server-only today but the prefix means any future frontend reference bundles them into public JS. Rename to unprefixed; update `claude.ts`, `claude-stream.mjs`, `Functions/claude.mjs`, `lock-wip.js` (newgoods funcs already accept fallback).

### F-015 — Stale schema file · doc/data · High (seeded /init)
`supabase-schema.sql` documents only the original 3 tables; live DB has 42 tables + 8 views via uncommitted migrations. **Resolved — live export captured** (`db/schema.sql`, May 2026, project `twsfmzohaymobqmmeayd`) and feeds `DATA_MODEL.md`. **Annotation:** the export is **constraint-lossy** — it reconstructs `CREATE TABLE` from inline constraints only and silently drops standalone/`ALTER`-added objects (composite uniques, extra indexes). See `DATA_MODEL §0` and F-021/F-024; verify composite constraints against the live DB before relying on them.

### F-016 — RLS is not an access boundary (TOP-PRIORITY security) · security · High ⚑ recap/code
**Widened** from the original "slack-sync uses anon key server-side" (now just one instance, below) to the **full RLS posture**, corroborated by the live schema export's RLS census (`DATA_MODEL.md §5`, the canonical enumeration). RLS is **not a meaningful access boundary**: secrets-grade data (financials, payroll-adjacent inputs, AI logs, the entire ingestion pipeline) is reachable with the public anon key. The real boundary is URL obscurity + client-side role gating — exactly as `CLAUDE.md` states, and **contradicting RECAP §5's "RLS is the real access boundary."** Of 42 tables:
- **25 have NO policy** (export: "likely RLS disabled → anon full access"): `ai_call_log`, `business_facts`, `data_snapshots`, `data_source_config`, `financial_ap`/`financial_ar`/`financial_cash`, `historical_summaries`, all 4 `inv_*`, `monthly_reports`, 6 of 7 `mos_*` (all but `mos_material_color`), all 5 `wip_*`, `sched_snapshots`. **Includes all AP/AR/cash and the whole LIFT/MOS/inventory pipeline.**
- **Wide-open `public` (qual=true):** `comments`, `correspondence`, `kpi_reactions`, `production`, `section_comments`, `weeks`, `profiles` (read; own-row update). And **`financials_monthly` carries an explicit `Anon write financials` cmd=ALL** policy — anon can *write* financials.
- **`people_weekly` is the ONLY genuinely role-restrictive table** (authenticated read, **admin-only** writes via a `profiles.role='admin'` subquery). The `authenticated`-scoped tables (`dashboard_narratives`, `sched_*`, `mng_*`, `mos_material_color`) are the next-most-locked but still not role-gated.
- **Original instance (folded in):** `slack-sync.ts` writes `section_comments` with `VITE_SUPABASE_ANON_KEY` rather than the service role — it succeeds *only* because `section_comments` is wide-open public. Server-side writes should use the service role regardless of posture.
**Severity High — to be ranked in Phase 6 alongside F-001 as top-priority candidates** (Phase 6 owns the ranking). Related: F-014 (the other High security item).
**Caveat (see `DATA_MODEL.md §5`):** "no policy → RLS disabled → anon access" is the export's stated assumption. If RLS is *enabled with no policy* on the 25, anon is denied and reads route through the definer-rights `v_current_*` views instead. Confirm per-table with `SELECT relrowsecurity FROM pg_class WHERE relname='<t>'` before treating any as open.

### F-017 — generate-pdf.mjs not deployed + likely unused · dead code · Med
`Functions/generate-pdf.mjs` (pdfkit, branded PDF) is one of the three Node functions caught by F-013's dir-casing bug — `isDeployed:false`, so `/api/generate-pdf` 404s in production. It may be dead regardless: a repo-wide grep finds **no `src/` caller** of `/api/generate-pdf` (the only `generate-pdf` references are `netlify.toml`, this file, and the function itself), and MODULE_MAP notes the live PDF path (`MonthlyBriefs`) uses **client-side jsPDF** (`monthlyBriefPdf.js`), not this function. **Verify in Phase 4 (dead-code pass):** if nothing needs it, delete alongside the `lock-wip` cleanup; if some surface needs server-side pdfkit, the F-013 dir fix unbreaks it.

### F-018 — `monthly_briefs` table absent → MonthlyBriefs broken · bug/data · High
`monthlyBriefData.js` reads/writes a `monthly_briefs` table that **does not exist** in the live schema (confirmed via query A against the live DB; `DATA_MODEL §6`). MonthlyBriefs save/load is therefore non-functional. An orphan `monthly_reports` table (`month`/`type`/`report_title`/`narrative`, no code references it) is present — strongly suggesting an **incomplete rename migration** (`monthly_reports` → `monthly_briefs` never finished, or finished only in code). **Small fix:** create `monthly_briefs` (or repoint code at `monthly_reports` after reconciling columns).

### F-019 — `role_change_log` table absent → audit silently fails · bug/data · High
`UserManagement.jsx` writes a `role_change_log` row on every role/active change; the table **does not exist** (query A; `DATA_MODEL §6`). The insert error is **swallowed**, so role changes still apply but leave **no audit trail** — a silent compliance gap. Fix: create the table (or remove the dead audit call if not wanted).

### F-020 — `profiles.role` DEFAULT violates its own CHECK · schema defect · High
`profiles.role` is `text` with CHECK `admin|manager|qa|exec` but **DEFAULT `'viewer'`** — a value the CHECK rejects. Any insert that omits `role` would violate the constraint. Confirmed in the export; **runtime impact depends on the profile-creation path** (an `auth.users` trigger not present in the export). Either the trigger always supplies a valid role (masking the defect) or new-profile creation errors. Fix: change the default to a valid member (e.g. `'exec'`) or widen the CHECK, after confirming the creation path.

### F-021 — Export-lossiness: composite uniques dropped · doc/data · High
The Supabase dashboard export reconstructs `CREATE TABLE` from inline constraints and **silently drops standalone / `ALTER TABLE ADD CONSTRAINT` objects** (composite uniques, extra indexes, possibly `ALTER`-added FKs/CHECKs). **Proven:** `financials_monthly` shows only its `id` PK in the export, yet the live DB has `financials_monthly_period_business_unit_key UNIQUE (period, business_unit)` (confirmed via `pg_constraint`) — `AdminFinancials`' `onConflict:"period,business_unit"` upsert depends on it and works. This establishes the `DATA_MODEL §0` lossiness caveat: treat every "UNIQUE/constraint" note as authoritative only for *inline* constraints; verify composites against the live DB before relying on them. Second instance: F-024.

### F-022 — `sched_current_wip` orphan view + 3 snapshot mechanisms · structural/dead · High
The app has **three independent snapshot mechanisms** (`DATA_MODEL §3`): pipeline (`data_snapshots`, `is_current`), New Goods (`mng_snapshots`, `is_current`), and scheduler (`sched_snapshots`, **no `is_current` — "current" = latest `uploaded_at`**). The scheduler's `sched_current_wip` view resolves current via `ORDER BY uploaded_at DESC LIMIT 1`, but **no code reads it** — the scheduler components pick the latest snapshot themselves, so the view is an orphan. Consolidation target: unify on one "current" convention and either adopt or drop the view.

### F-023 — `comments` dead table · dead code · High
`comments` is the original bootstrap comment table (public insert/read RLS). **No `from('comments')` caller exists** anywhere — the live comment system is `section_comments`, which supersedes it. Dead table; drop after confirming no external/SQL consumer. (Split from the prior combined finding; the MODULE_MAP-mapping gap for `Correspondence.jsx` is now F-025.)

### F-024 — `sched_daily_ops` composite-unique export gap · doc/data · Med
Second instance of the F-021 export-lossiness pattern. `sched_daily_ops` shows only its `id` PK in the export, yet `dailyOps.upsertDailyOp` upserts on `(site, week_start, table_code, day_of_week, shift)` — implying a composite unique the export didn't render. **Med (not High):** unlike `financials_monthly`, this composite is *inferred from the upsert*, **not yet confirmed via `pg_constraint`**. Verify before relying on it (`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.sched_daily_ops'::regclass;`).

### F-025 — MODULE_MAP gap: `Correspondence.jsx` unmapped · doc gap · High
`Correspondence.jsx` is a **live** component (reads/writes the `correspondence` table + the `correspondence` storage bucket) but `MODULE_MAP.md` never maps it. Documentation gap, not dead code. **Backfill is Phase 4 work — not done in this pass;** this finding captures the gap. (Split from F-023.)

---

## Cross-agent reconciliations (caught during synthesis)
- **fiscalCalendar anchor:** one explore agent labeled the keys "Sunday"; arithmetic shows `2026-01-05` is a **Monday**. Keys are Monday-anchored. The agent's "no conflict" conclusion was wrong; conflict is real (F-001).
- **Streaming Claude path:** Node `claude.mjs` advertised as the streaming endpoint, but routing + actual usage point to `/api/claude-stream`. Treated as F-012.
