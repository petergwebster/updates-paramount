# Data Model

> Phase 2 deliverable of the architecture audit. **`ARCHITECTURE.md` §1 links here** as the canonical data-model reference.
> Built from the live Supabase schema export (`db/schema.sql`, captured May 2026, project `twsfmzohaymobqmmeayd`) cross-referenced against the Phase 1 module map (`docs/MODULE_MAP.md`) and verified against the live DB via SQL where the export was lossy.
> Status: **DRAFT — awaiting sign-off.**

---

## §0 — How to use this document

**Audience.** Future Claude Code sessions and any engineer onboarding to the data layer or working a structural fix. This is the "what's actually in the database, who touches it, and where it lies" reference. Pair it with `MODULE_MAP.md` (what each component does) and `FINDINGS_LOG.md` (open issues).

**It answers:** which tables/views exist, their columns/keys/constraints, their RLS posture, which modules read/write each, how the snapshot-versioning works, and where the schema contradicts the code or the docs.

**Provenance & the completeness caveat (read before trusting the constraint columns).**
The source `db/schema.sql` is a **Supabase dashboard export that reconstructs `CREATE TABLE` statements**. That method is **reliable for inline constraints** — primary keys, column-level `UNIQUE`, inline `CHECK`, inline `FOREIGN KEY` — but **silently drops standalone / `ALTER TABLE ADD CONSTRAINT` objects**: composite unique constraints, extra indexes, and possibly `ALTER`-added FKs/CHECKs. This is **proven**, not theoretical:

- `financials_monthly` shows only its `id` PK in the export, yet the live DB has `financials_monthly_period_business_unit_key UNIQUE (period, business_unit)` (confirmed via `pg_constraint`). The `AdminFinancials` upsert `onConflict:"period,business_unit"` depends on it and works.
- `sched_daily_ops` shows only its `id` PK, yet `dailyOps.upsertDailyOp` upserts on `(site, week_start, table_code, day_of_week, shift)` — implying a composite unique the export likewise didn't render. **(F-024 — 2nd instance of this pattern; inferred from the upsert, not yet `pg_constraint`-verified.)**

**Therefore:** treat every "UNIQUE/constraint" note below as **inline-captured and authoritative only for inline constraints**; composite/standalone constraints are **best-effort and must be verified against the live DB** (`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.<table>'::regclass;`) before relying on them for a migration or upsert.

**Scope counts.** 42 tables, 8 views (working set; corroborated by the export's own RLS census of 17 with-policy + 25 without = 42). The live `count(*)` was not separately confirmed; query A confirmed the two code-referenced "missing" tables (`monthly_briefs`, `role_change_log`) genuinely do not exist rather than being dropped from the list, so the table *set* is trustworthy even though *constraints* are not exhaustive.

---

## §1 — Domain overview

The 42 tables + 8 views group into nine domains. "Anchor" = how the table is keyed in time.

| Domain | Tables / views | Anchor |
|---|---|---|
| **Performance / Weekly** | `production`, `weeks`, `kpi_reactions`, `section_comments`, `historical_summaries` | `week_start` (Sunday) / `period_start` |
| **Financial** | `financials_monthly`, `financial_ap`, `financial_ar`, `financial_cash` | `period` (`YYYY-MM-W#`) |
| **People** | `people_weekly` | `week_start` |
| **Scheduler / Live-Ops** | `sched_snapshots`, `sched_wip_rows`, `sched_assignments`, `sched_daily_ops`, view `sched_current_wip` | `week_start` (Sunday) + `day_of_week` TEXT; snapshot |
| **Ingestion pipeline** | `data_snapshots`, `data_source_config`, 5×`wip_*`, 7×`mos_*`, 4×`inv_*`; views `v_current_monthly_pacing`, `v_current_wip_rollup`, `v_current_mos_materials`, `v_current_mos_material_color`, `v_inventory_bucket_history`, `v_latest_snapshots` | snapshot (`is_current`) |
| **New Goods (Monday.com)** | `mng_snapshots`, `mng_items`, `mng_observations`; view `v_current_mng_items` | snapshot (`is_current`) |
| **AI / Narrative** | `dashboard_narratives`, `ai_call_log`, `business_facts` | `week_start`+`time_window` / none |
| **Auth / Access** | `profiles` | none (FK `auth.users`) |
| **Legacy / orphan** | `comments`, `correspondence`, `monthly_reports` | `week_start` / `month` |

---

## §2 — Per-table reference

Notation: **PK** primary key · **FK** foreign key · **U** unique · **CK** check · RLS column shows policy posture (see §5). "R/W by" cross-refs `MODULE_MAP.md`.

### Performance / Weekly

**`production`** — weekly production figures, one row per week.
- Cols: `week_start date NOT NULL **U**` (Sunday post-migration), `nj_data jsonb`, `bny_data jsonb`, timestamps.
- Constraints: PK `id`; `week_start` U.
- RLS: **public** insert/read/update (wide open).
- R/W by: `ProductionDashboard` (R/W), `AdminPanel` (R/W), `ExecutiveDashboardPage` (R, dual Mon+Sun key — F-001), `DashboardPage`/`WeekPaceStrip` (R, Monday-key — F-001), `historicalSummaries` (R), `monthlyBriefData` (R).
- Gotcha: JSONB values stored as **string-numbers**; BNY buckets stored as bare strings not `{actual}` objects (RECAP §9 — see §7).

**`weeks`** — KPI scorecard, daily log, concerns, narratives per week.
- Cols: `week_start date NOT NULL **U**`, `days jsonb`, `kpis jsonb`, `concerns text`, `narrative text`, `executive_narrative text`.
- RLS: **public** insert/read/update.
- R/W by: `App.jsx` (load/save by `week_start`), `HistoryPanel` (R, last 52), `KPIScorecard`/`WeeklyLog`/`AdminPanel` (write via `onSave`).

**`kpi_reactions`** — emoji reactions on KPIs.
- Cols: `week_start`, `kpi_id text`, `author`, `emoji`. RLS: **public** insert/read/delete. R/W by: `KPIScorecard`.

**`section_comments`** — threaded comments (the live comment system; supersedes `comments`).
- Cols: `week_start`, `section`, `section_label`, `author`, `text`, `notify_names text[]`, `status`, `parent_id` (self-**FK** → `section_comments`), `slack_ts`, `slack_message_ts`.
- RLS: **public** insert/read/update/delete (wide open — this is why F-016's anon-key `slack-sync` writes succeed).
- R/W by: `CommentButton`, `App.jsx` (Slack notify), `slack-sync.ts`.

**`historical_summaries`** — rolled-up weekly/monthly/quarterly production.
- Cols: `period_type text` **CK** `weekly|monthly|quarterly|yearly`, `period_start`, `period_end`, `period_label`, yards/color-yards/waste/revenue metrics.
- RLS: **none** (no policy). R/W by: `historicalSummaries.js` (throttled daily).

### Financial

**`financials_monthly`** — COGS/OpEx/inventory by business unit.
- Cols: `id bigint IDENTITY` PK, `period text NOT NULL`, `business_unit text NOT NULL`, COGS components (+ computed `cogs_total` default), OpEx components (+ computed `opex_total` default), `inv_purchases`, `inv_vendors jsonb`.
- Constraints: PK `id`; **live composite `U (period, business_unit)`** (`financials_monthly_period_business_unit_key`, *not in export* — see §0). 
- RLS: **`Anon write financials` cmd=ALL public** + public read — anon can write financials.
- R/W by: `AdminFinancials` (upsert `onConflict:"period,business_unit"`), `FinancialTab` (R), `monthlyBriefData` (R). Revenue/totals are computed, not stored (RECAP §9).

**`financial_ap`** — AP aging by facility.
- Cols: `period NOT NULL`, `facility NOT NULL`, aging buckets, `past_due`, `top_vendors jsonb`. PK `id`. **No** U on `period` (contrast `financial_ar`). RLS: **none**. R/W by: `AdminFinancials` (W), `FinancialTab`/`monthlyBriefData` (R).

**`financial_ar`** — AR aging.
- Cols: `period text **U**`, aging buckets, `total_outstanding`, `total_past_due`, `key_accounts jsonb`. RLS: **none**. R/W by: `AdminFinancials` (W), `FinancialTab` (R, `.maybeSingle()` on period).

**`financial_cash`** — cash position.
- Cols: `period text` **PK**, `passaic_cash`, `bny_cash`, **`uploaded_at text`** ⚠ (TEXT, not timestamptz — type anomaly vs every other `uploaded_at`). RLS: **none**. R/W by: `AdminFinancials` (W), `FinancialTab` (R).

### People

**`people_weekly`** — headcount/hours/payroll + HR detail.
- Cols: `week_start date **U**`, BNY/NJ headcount/hours/pay/bonus, `employees jsonb`, hires/exits, `leaves jsonb`, `open_roles jsonb`, `hr_notes`.
- RLS: **the only genuinely role-restrictive table** — authenticated read; **admin-only** insert/update (via `profiles.role='admin'` subquery).
- R/W by: `AdminPeople` (upsert by `week_start`), `PeopleTab`/`monthlyBriefData` (R).

### Scheduler / Live-Ops  *(all Sunday-anchored; `day_of_week` is TEXT)*

**`sched_snapshots`** — LIFT upload audit + per-site rollup totals.
- Cols: `id bigint`, `uploaded_at`, site order/yard/revenue counts, `total_rows`, `unclassified_rows`. **No `is_current`** — "current" = latest `uploaded_at` (see §3). RLS: **none**. R/W by: `WIPTab`, `SchedulerTab`, `LIFTDataRefresh`, `monthlyBriefData`.

**`sched_wip_rows`** — PO-level WIP pool (~1,500–1,700 rows/snapshot).
- Cols: `snapshot_id bigint` **FK** → `sched_snapshots`, `site` **CK** `passaic|bny|procurement|unknown`, classification fields, `colors_count`, `color_yards`, `age_days`, `age_bucket`, `bny_bucket`, `category_customer_mto`, `customer_name_clean`, `is_new_goods`.
- RLS: **authenticated** ALL. R/W by: `WIPTab`, `SchedulerTab`, `PassaicScheduler`, `BNYScheduler`, `HeartbeatPage`, `monthlyBriefData`.

**`sched_assignments`** — the schedule (cell assignments).
- Cols: `id bigint`, `site` **CK** `passaic|bny|procurement`, `po_number`, `table_code`, `week_start`, **`day_of_week text` CK `Sun..Sat` (nullable)**, `planned_yards`, `planned_cy`, `assigned_by` (`'claude'` tags AI proposals), `status` **CK** `planned|in_progress|completed|slipped|cancelled`, `operator`, `shift` **CK** `1st|2nd`.
- Trigger: `trg_sched_assignments_updated` (BEFORE UPDATE → `updated_at`). RLS: **authenticated** ALL.
- R/W by: `SchedulerTab`, `PassaicScheduler`, `BNYScheduler`, `LiveOpsTab`.

**`sched_daily_ops`** — end-of-shift actuals.
- Cols: `id bigint`, `site` **CK** `passaic|bny`, `week_start`, `table_code NOT NULL`, **`day_of_week text` CK `Sun..Sat` NOT NULL**, `operator_1/2`, `actual_yards`, `waste_yards`, `planned_yards`, `note_assigned_to`, `note_status`, `shift` **CK** `1st|2nd` NOT NULL.
- Constraints: PK `id`; **live composite U on `(site, week_start, table_code, day_of_week, shift)`** implied by `upsertDailyOp` (*not in export* — see §0; **F-024**, 2nd instance of the F-021 export-lossiness pattern). RLS: **authenticated** ALL.
- R/W by: `LiveOpsTab`, `PassaicScheduler`/`BNYScheduler` (operator dual-write), `dailyOps.js`.

### Ingestion pipeline  *(snapshot-versioned via `data_snapshots.is_current`)*

**`data_snapshots`** — parent versioning row for LIFT/MOS/inventory uploads.
- Cols: `is_current bool`, `file_kind text` **CK** `wip|mos|inventory|mos_material_color`, `source` **CK** `manual_upload|sharefile_auto|api`, `status` **CK** `pending|parsing|success|partial|failed`, `sheets_parsed jsonb`, `errors jsonb`.
- Trigger: `trg_data_snapshots_single_current` (AFTER INSERT/UPDATE → `enforce_single_current_snapshot()`, one `is_current` per `file_kind`). RLS: **none**. R/W by: `persistSnapshot.js`, `UploadTile`, `LIFTDataRefresh`.

**`data_source_config`** — ShareFile auto-fetch config (planned).
- Cols: `file_kind text **U**` **CK** `wip|mos|inventory` ⚠ (excludes `mos_material_color`, which `data_snapshots` allows), `auto_fetch_enabled`, sharefile fields, freshness fields. RLS: **none**. Used by freshness UI.

**`wip_*` (5)** — `wip_color_yards`, `wip_monthly_pacing`, `wip_production_lines`, `wip_rollup_lines`, `wip_written_invoiced`. All **FK** → `data_snapshots`; written by `persistSnapshot` (`parseWipFile`, 5 sheets); RLS **none**. Read via views `v_current_monthly_pacing` / `v_current_wip_rollup`. `wip_written_invoiced` uniquely carries a `week_start`.

**`mos_*` (7)** — `mos_ground_est_ship`, `mos_inv_reconciliation`, `mos_material_color`, `mos_materials`, `mos_monthly_velocity`, `mos_open_pos`, `mos_received`. All **FK** → `data_snapshots`; written by `persistSnapshot` (`parseMosFile` 6 sheets + `parseMosMaterialColor`). `mos_material_color` (`id bigint`) has its **own RLS** (authenticated ALL) and a sequence; the rest RLS **none**. The Months-of-Supply health view reads `mos_material_color` (`v_current_mos_material_color`, `v_inventory_bucket_history`) and `mos_materials` (`v_current_mos_materials`).

**`inv_*` (4)** — `inv_cogs_summary` (some structure), `inv_ground_sold`/`inv_pos_shipped`/`inv_schu_on_hand` (raw_row-only). All **FK** → `data_snapshots`; written by `persistSnapshot` (`parseInventoryFile`, 4 sheets, mostly raw). RLS **none**. **Distinct from the `mos_*` family** — this is the `inventory` file_kind, *not* the Inventory tab's MOS-health source (resolves RECAP §7's `inv_*`-vs-`mos_*` conflation — see §6).

### New Goods (Monday.com)  *(snapshot-versioned via `mng_snapshots.is_current`)*

**`mng_snapshots`** — Monday board refresh audit. `trigger text` **CK** `manual|auto|scheduled`, `is_current bool`, item counts. Trigger `mng_snapshot_set_current_trg` (AFTER INSERT). RLS: **authenticated** read. W by `monday-newgoods-refresh.ts` (service role).

**`mng_items`** — Monday pre-production line items. **FK** → `mng_snapshots`, `monday_id`/`board_id bigint`, `site` **CK** `passaic|bny`, pipeline/timeline/approval fields, `raw_columns jsonb`. RLS: **authenticated** read. R via `v_current_mng_items`.

**`mng_observations`** — AI observations per snapshot/site. **FK** → `mng_snapshots`, `site` **CK** `passaic|bny`, `observations_md`, `model_used`, `group_summary jsonb`. RLS: **authenticated** read. W by `monday-newgoods-observations.ts`; R by `newGoods.js`.

### AI / Narrative

**`dashboard_narratives`** — cached Claude narratives. `week_start` + `time_window` **CK** `today|week|month|recap|heartbeat`, `edited_by`/`edited_at` (human-edit tracking). RLS: **authenticated** ALL. R/W by `ClaudeReadBlock`.

**`ai_call_log`** — AI call telemetry (the F-010 target). `prompt_type`, `context jsonb`, tokens, `duration_ms`, `error`, `model` (default `claude-sonnet-4-20250514`). RLS: **none**. W by `contextBuilder.logAICall` (only `ClaudeReadBlock` calls it — F-010).

**`business_facts`** — slow-changing facts for Claude. `fact_number int **U**`, `category`, `fact`, `active`. RLS: **none**. R by `contextBuilder` (Bucket A) + `HeartbeatPage` (legacy WIP seed — RECAP §11.7 hygiene risk).

### Auth / Access

**`profiles`** — role/active per user. `id` **PK** + **FK** → `auth.users`, `full_name`, `role text` **CK** `admin|manager|qa|exec` **DEFAULT `'viewer'` ⚠ (invalid — F-020)**, `active`.
- RLS: **public** read; update gated to own row (`auth.uid() = id`).
- R/W by: `App.jsx` (bootstrap R), `LoginScreen` (R), `UserManagement` (W role/active — *update only, no insert found*), `access.js` (role→destination). No email column (lives in `auth.users`). Creation mechanism not in this export (likely an `auth.users` trigger) — see F-020.

### Legacy / orphan

**`comments`** — original bootstrap comment table. RLS: public insert/read. **No `from('comments')` caller** — superseded by `section_comments`. Dead table (F-023).
**`correspondence`** — `subject`/`contact`/`direction`/`kpi_tag`/`body`/`file_url`. RLS: public delete/insert/read. **Live** via `Correspondence.jsx` (+ `correspondence` storage bucket) — a component MODULE_MAP never mapped (F-025).
**`monthly_reports`** — `month`/`type`/`report_title`/`narrative`. RLS: **none**. **Orphan** — no code references it; code targets the non-existent `monthly_briefs` instead (F-018).

---

## §3 — Snapshot & "current" model

The app has **three independent snapshot mechanisms** — an inconsistency worth consolidating (F-022):

| System | Tables | "Current" resolution | Trigger |
|---|---|---|---|
| Pipeline | `data_snapshots` → `wip_*`/`mos_*`/`inv_*` | `is_current=true` (one per `file_kind`) | `enforce_single_current_snapshot()` |
| New Goods | `mng_snapshots` → `mng_items`/`mng_observations` | `is_current=true` | `mng_snapshot_set_current()` |
| Scheduler | `sched_snapshots` → `sched_wip_rows` | **latest `uploaded_at`** (no `is_current` column) | none |

The `v_current_*` views resolve the pipeline/New-Goods "current" by joining on `is_current=true` (some also filter `file_kind`). The scheduler's `sched_current_wip` view resolves via `ORDER BY uploaded_at DESC LIMIT 1` — but **no code reads it** (orphan view, F-022); the scheduler components pick the latest snapshot themselves.

---

## §4 — Week-anchoring at the data layer

Feeds Phase 3 (which owns the canonical fix); documented here only as the data-layer facts:

- **`week_start` is a `date` column** on `production` (U), `weeks` (U), `people_weekly` (U), `kpi_reactions`, `section_comments`, `sched_assignments`, `sched_daily_ops`, `wip_written_invoiced`. Post-migration these store the **Sunday** date. The Monday-keyed `fiscalCalendar.js` is the conflict source (F-001) — not visible in the schema, but the schema confirms single-row-per-week uniqueness on the core tables, so a wrong-anchor query silently returns the wrong/zero rows.
- **`day_of_week` is TEXT** with a `Sun..Sat` CHECK on `sched_assignments` (nullable) and `sched_daily_ops` (NOT NULL). Writing a numeric index violates the CHECK — hence the `dowText()` coercion at every write path (recent migration commits).
- **`period`** (`financials_monthly`, `financial_*`) is the calendar `YYYY-MM-W#` key — orthogonal to fiscal weeks (the `derivePeriod` read/write contract, F-006).

---

## §5 — RLS & security posture

**Posture: RLS is not a meaningful access boundary** (corroborates CLAUDE.md and contradicts RECAP §5's "RLS is the real access boundary" — see §6). Of 42 tables:

- **25 have NO policy** (export notes "likely RLS disabled → anon full access"): `ai_call_log`, `business_facts`, `data_snapshots`, `data_source_config`, all `financial_ap/ar/cash`, `historical_summaries`, all 4 `inv_*`, `monthly_reports`, 6 of 7 `mos_*` (all but `mos_material_color`), all 5 `wip_*`, `sched_snapshots`. **Includes all AP/AR/cash and the entire ingestion pipeline.**
- **17 have policies**, but mostly permissive:
  - **Wide-open `public` (qual=true):** `comments`, `correspondence`, `kpi_reactions`, `production`, `section_comments`, `weeks`, `profiles` (read; own-row update), and **`financials_monthly` has an explicit `Anon write financials` cmd=ALL** + public read.
  - **`authenticated`-scoped (most locked-down surface):** `dashboard_narratives`, `mos_material_color`, `sched_assignments`, `sched_daily_ops`, `sched_wip_rows` (ALL); `mng_items`, `mng_observations`, `mng_snapshots` (read-only — writes happen via **service role** in edge functions).
  - **Genuinely role-restrictive (the only one):** `people_weekly` — authenticated read, **admin-only** writes.

> Net: secrets-grade data (financials, payroll inputs, AI logs) is reachable with the anon key. The real boundary is URL obscurity + client-side role gating, exactly as CLAUDE.md states. This is the foundation for the F-016 widening (a security finding broader than just `slack-sync`).

**Caveat:** "no policy → RLS disabled → anon access" is the export's stated assumption. If RLS is *enabled with no policy* on those 25, anon is denied and reads would route through the (definer-rights) `v_current_*` views instead. Confirm per-table with `SELECT relrowsecurity FROM pg_class WHERE relname='<t>'` before treating any of the 25 as either open or closed.

---

## §6 — Schema ↔ code / doc contradictions

| ID | Contradiction | Status |
|---|---|---|
| **F-003** | `wip_snapshots` (lock-wip's write target) **does not exist** | Closed — lock-wip triply dead (not deployed + no table + no reader) |
| **F-018** | Code writes `monthly_briefs` (`monthlyBriefData.js`); **table doesn't exist** (`monthly_reports` orphan present) | **Confirmed broken** — MonthlyBriefs save/load non-functional. Likely incomplete rename migration; small fix |
| **F-019** | Code writes `role_change_log` (`UserManagement.jsx`); **table doesn't exist** | **Confirmed broken** — role-change audit silently fails (error swallowed) |
| **F-020** | `profiles.role` DEFAULT `'viewer'` not in its CHECK set (`admin|manager|qa|exec`) | Confirmed schema defect; runtime impact depends on profile-creation path (unexported) |
| **F-021** | Export shows no composite unique on `financials_monthly` | **Reframed → export gap** (live `UNIQUE(period,business_unit)` exists; upsert works). Establishes the §0 lossiness caveat |
| **F-022** | `sched_current_wip` orphan view; 3 divergent snapshot mechanisms | Confirmed |
| **F-023** | `comments` dead table | Confirmed |
| **F-024** | `sched_daily_ops` composite unique not in export (2nd instance of F-021) | Confirmed export gap — live composite inferred from `upsertDailyOp`, not yet `pg_constraint`-verified |
| **F-025** | `correspondence`/`Correspondence.jsx` live but unmapped in MODULE_MAP | Confirmed — MODULE_MAP gap (backfill = Phase 4) |
| RECAP §7 | "Inventory fed by `inv_*` tables" | Wrong — Inventory MOS-health reads the `mos_material_color` views; `inv_*` is a separate raw ingestion |
| RECAP §5 | "RLS is the real access boundary" | Wrong — see §5 (25 tables no policy; mostly public) |
| meta | Table count "32" (handoff) / "~30+" (CLAUDE.md) | Actual **42** tables + 8 views |
| meta | `financial_cash.uploaded_at` TEXT; `data_source_config` CK omits `mos_material_color`; `financial_ap.period` not unique | Minor type/constraint inconsistencies |

---

## §7 — Data-shape gotchas

Cross-referenced from RECAP §9 to the tables they bite:

- **JSONB string-numbers** (`production.nj_data`/`bny_data`, `weeks.kpis`): `<input type="number">` writes strings, so JSONB stores `"9483"` not `9483`; `0 + "9483"` concatenates. Always coerce via a `num()` helper before arithmetic.
- **`.actual` path bug** (`production.bny_data`): bucket values (`replen`, `mto`, `hos`, `memo`, `contract`) are stored as **bare string numbers**, not `{ actual: … }` objects. Reading `b.replen?.actual` yields `undefined → 0`.
- **Silent column drop on upsert**: Supabase silently ignores unknown columns on write — a new field needs `ALTER TABLE … ADD COLUMN` *before* the frontend writes it, or data is lost without error. (Contrast a missing *table*, e.g. F-018/F-019, which errors loudly rather than silently.)
- **`day_of_week` numeric→TEXT**: writing an integer violates the CHECK; coerce with `dowText()` (see §4).
- **`business_facts` hygiene**: may contain point-in-time WIP snapshots Claude could quote as if live (RECAP §11.7).

---

*Phase 2 deliverable. Pairs with `MODULE_MAP.md` (components) and `FINDINGS_LOG.md` (open issues). New findings F-018–F-025 + the F-016 widening are recorded in `FINDINGS_LOG.md`.*
