# Module Map

> Phase 1 deliverable of the architecture audit. Linked from `ARCHITECTURE.md` §2.
> Status: **DRAFT — awaiting sign-off.** Built from a fan-out read of every component, lib, and serverless function (May 2026).
> Line numbers and exact behaviors below are leads from a breadth-first read, not line-verified; week-keying specifics are confirmed in Phase 3.

## How to read this

The app is a React 18 + Vite SPA over Supabase, organized as a hand-rolled router (`App.jsx`) into three **destinations** (Performance / Operations / Heartbeat) plus an **Admin** area. Below, modules are grouped by where they live in that structure, then the shared `lib/` layer, then the serverless functions. Each entry lists: responsibility · data sources (Supabase tables R/W, `/api/*`, external APIs) · key relationships · **week anchor** (Sunday / Monday / none — the field that feeds Phase 3) · seams.

A consolidated **data-source matrix** and **week-anchor table** are at the end.

---

## 1. Shell & routing

### `src/main.jsx`
React 18 entry; mounts `<App/>` in StrictMode. Imports `index.css` + `styles/tokens.css`. No data, no week logic.

### `src/App.jsx`
**Responsibility:** Hand-rolled router + auth bootstrap. Single owner of `destination` (`landing|performance|operations|heartbeat`), `activeTab`, `currentWeek`, `weekData`. Maps destination+tab → rendered component; manages localStorage persistence and Slack-notify session tracking.
**Data:** R/W `profiles` (bootstrap), R/W `weeks` (load/save by `week_start`), R/W `section_comments` (Slack-notify flow); POST `/api/slack`; `supabase.auth.*`.
**Relationships:** imports nearly every page component; `lib/access` for gating; `fiscalCalendar.getFiscalLabel` for the week-nav label.
**Week anchor:** **Sunday** — `getCurrentWeekStart() = startOfWeek(new Date(), {weekStartsOn:0})`; `weekKey = format(d,'yyyy-MM-dd')`. Performance defaults to *prior* closed week; Operations/Heartbeat to *current* week. (Verified Sunday in source.)
**Seams:**
- **Dead imports** (line 16): `FacilityDetail, OperatorScorecard, useProductionData, generateLiveOpsPDF` from `ProductionTab` — imported, never referenced in the body. → finding F-002.
- Profile fetch retries once after 500 ms (JWT propagation race); double-failure surfaces as "no destinations" with only a console error.
- localStorage keys: `pp_destination`, `pp_active_tab`, `pp_commenter`, `pp_auth` (Supabase), legacy `pp_mode` (cleaned on signout).

### `src/components/LandingPage.jsx`
Destination chooser shown after every login. Tiles filtered by `destinationsFor(profile)`. **Pulse metrics on the tiles are hardcoded placeholders** (documented as future-wire). No data, no week logic.

### `src/components/DestinationNav.jsx`
Header pill-nav to switch destinations / return to Landing. Hides if user has ≤1 destination. Pure UI; `lib/access` only.

### `src/components/StubPage.jsx`
"Under construction" placeholder. Used by AdminLayout for unbuilt sections. Static.

---

## 2. Performance destination

### `src/components/ExecutiveDashboardPage.jsx`
**Responsibility:** Weekly recap for FSCO leadership — production summary + KPI scorecard + AI narrative.
**Data:** R `production` (queries **both** Monday and Sunday keys via `.in('week_start',[monday,sunday])` to straddle the migration); `weekData` (weeks) via prop.
**Relationships:** renders `KPIScorecard`, `ProductionDashboard`, `ClaudeReadBlock`; `weeklyRecapNarrative` prompt; `getFiscalLabel`.
**Week anchor:** **dual (Monday + Sunday)** — the only module that explicitly hedges the migration. → key Phase 3 evidence.
**Seams:** local `num()` JSONB-string coercion (duplicated pattern). Dual-key query is a migration band-aid.

### `src/components/DashboardPage.jsx`
**Responsibility:** Run-Rate dashboard (Today/Week/Month) — current-week-to-date pace, 6 KPI cards, AI read.
**Data:** R `production` (range query `gte(monthStart).lte(today)`); `refreshSummariesIfNeeded()`.
**Relationships:** `RunRateKPICards`, `ClaudeReadBlock`, `historicalSummaries`.
**Week anchor:** **Monday** — `startOfWeek(today,{weekStartsOn:1})`. Single-key; will miss Sunday-keyed current-week rows. → finding F-001.
**Seams:** `NJ_TARGETS`/`BNY_TARGETS` duplicated here despite `budgets.js` existing → F-005.

### `src/components/WeekPaceStrip.jsx`
Embedded "this week's pace" panel (compact DashboardPage). R `production` `.eq('week_start', weekKey).single()`. **Week anchor: Monday** (`weekStartsOn:1`) — same single-key risk as DashboardPage. Duplicated targets again.

### `src/components/RunRateKPICards.jsx`
Stateless presentational card grid (6 metrics, delta logic, waste = lower-is-better). No data, no week logic.

### `src/components/KPIScorecard.jsx`
**Responsibility:** 10-metric balanced scorecard; status/notes/emoji reactions; AI-drafted narrative; read-only memo mode for the recap.
**Data:** R/W `kpi_reactions`; saves KPIs via parent `onSave` (→ `weeks`); POST `/api/claude` (narrative).
**Relationships:** `CommentButton`, `getFiscalLabel`.
**Week anchor:** **Monday-assumed** — `format(weekStart,'yyyy-MM-dd')` for reaction key, no fallback.
**Seams:** AI call here is **not** logged to `ai_call_log` (ClaudeReadBlock logs; this doesn't) → F-010.

### `src/components/WeeklyLog.jsx`
Mon–Fri daily activity log + "Areas of Concern"; saves a structured object via parent `onSave` (→ `weeks`). `CommentButton` per day. Days hardcoded Mon–Fri. Week key from prop.

### `src/components/HistoryPanel.jsx`
Lists last 52 `weeks` rows (R `weeks`, order desc), click-to-open. Derives status from kpis. Week key = stored `week_start` string.

### `src/components/FinancialTab.jsx`
**Responsibility:** MTD COGS/OpEx/inventory/AP/AR/cash by business unit (609 BNY / 610 Passaic / 612 Shared).
**Data:** R `financials_monthly`, `financial_ap`, `financial_ar`, `financial_cash` (all keyed by `period`).
**Week anchor:** **calendar-month-week** — `derivePeriod(weekStart)` = `YYYY-MM-W{ceil(day/7)}`, capped W5. Orthogonal to fiscal weeks. **Must match `AdminFinancials.derivePeriod()` exactly** (read/write contract) → F-006.

### `src/components/PeopleTab.jsx`
Weekly headcount/hours/payroll + 4-week trailing charts (Chart.js CDN). R `people_weekly` `.eq('week_start', …)`. `CommentButton`. Week key passed through from caller (no normalization).

### `src/components/InventoryTab.jsx`
**Responsibility:** Months-of-Supply health across 3 buckets (Schumacher/Screen Print/Digital), 3-level drill, inline XLSX upload.
**Data:** R `v_current_mos_material_color`, `v_inventory_bucket_history`; W via `persistSnapshot()`.
**Relationships:** `parseMosMaterialColor`, `persistSnapshot`.
**Week anchor:** **none** — snapshot/month driven. `profile` prop currently unused.

### `src/components/MonthlyBriefs.jsx`
**Responsibility:** Generate/edit Mid- and End-of-Month briefs; AI narrative; PDF export. (Reached via Admin → Intelligence, rendered by AdminLayout.)
**Data:** via `gatherMonthlyBriefData()` (multi-table); R/W `monthly_briefs`; POST `/api/claude`; client PDF via `monthlyBriefPdf`.
**Relationships:** `monthlyBriefData`, `monthlyBriefNarrative`, `monthlyBriefPdf`.
**Week anchor:** **calendar month** (`yyyy-MM`). AI call here also not logged to `ai_call_log` → F-010.

### `src/components/Correspondence.jsx` — **ORPHANED**
**Responsibility:** File/organize week-anchored correspondence (emails, PDFs, Word docs, notes) with KPI tagging + contact tracking; drag-and-drop upload (`.pdf/.docx/.doc/.txt/.eml`).
**Data:** R/W `correspondence` table (insert/select + Realtime on `week_start=eq.<weekKey>`); `correspondence` **Storage bucket** (public; file upload/URL). No AI calls — pure CRUD.
**Week anchor:** **Sunday** — `format(weekStart,'yyyy-MM-dd')` (line 45); Realtime filter (line 56).
**Status:** Imported at `App.jsx:7` but **never mounted** — no `<Correspondence>` render exists anywhere in `src/` (grep-confirmed). A third orphan alongside `ProductionTab` (F-002) and `PlantRollup` (F-011). → **F-025** (reframed from a doc-gap to dead code). Because it's the table/bucket's only consumer, the `correspondence` table + bucket are effectively dead too (see `CONSOLIDATION.md §2`).
**Seams:** hardcoded `KPI_TAGS` (11), `CONTACT_TYPES` (5), `DIRECTIONS` (3) lists.

---

## 3. Operations destination

### `src/components/WIPTab.jsx`
**Responsibility:** Single source-of-truth WIP inventory across all statuses/sites, from LIFT upload.
**Data:** R `sched_snapshots`; R/W `sched_wip_rows`. No Monday.com.
**Relationships:** `liftParser.parseLiftWorkbook`, `scheduleUtils`.
**Week anchor:** **none** (snapshot-only).
**Seams:** hardcodes `SCHEDULABLE_STATUSES` + `NG_PREPROD` (duplicated in both schedulers) → F-004; recomputes age buckets despite parser writing `age_bucket`, with a *different* bucket-key naming than NewGoodsView → F-007; **header comment claims Monday.com + `wip_snapshots` are retired and LIFT is canonical** — contradicts the still-scheduled `lock-wip` function → **F-003 (recap/code contradiction).**

### `src/components/NewGoodsTab.jsx`
**Responsibility:** Monday.com pre-production pipeline (Passaic hand-screen + Brooklyn digital), snapshot-backed, AI observations modal.
**Data:** via `lib/newGoods` → R `mng_snapshots`, `v_current_mng_items`, `mng_observations`; POST `/api/monday-newgoods-refresh`, `/api/monday-newgoods-observations`.
**Week anchor:** **none** (pre-prod pipeline). Auto-refresh if snapshot >24 h stale. Two swapped "Status" columns resolved by value, not position (good).

### `src/components/NewGoodsView.jsx`
Detail line-item browse of New Goods POs for a site; per-status + per-age-bucket rollups; surfaces pre-classification orphans. Props-only (no Supabase). **Age-bucket keys (`0-30`…) differ from WIPTab's (`current`/`30`…)** → F-007.

### `src/components/SchedulerTab.jsx`
Orchestrator: site toggle (Passaic/BNY only — procurement excluded), loads snapshot + site WIP + assignments, delegates to the two schedulers. R `sched_snapshots`, `sched_wip_rows`, `sched_assignments`. **Week anchor: Sunday** (`defaultSchedulerWeek()` → Sunday; `isoDate(weekStart)`).

### `src/components/PassaicScheduler.jsx`
**Responsibility:** Passaic hand-screen weekly grid (17 tables across grass/fabric/wallpaper); assign yards→table/shift; crew modal; **Ask Claude** (streaming) scheduling proposals.
**Data:** R `sched_wip_rows`; R/W `sched_assignments`; R `sched_daily_ops` (via `dailyOps`); POST `/api/claude-stream`.
**Relationships:** `dailyOps`, `budgets`, `scheduleUtils`.
**Week anchor:** **Sunday** (`isoDate(weekStart)`). Computes `mixTotals` (yards/cy/revenue by category + Schumacher/3P mix) → **productionRollup duplication** F-008. Duplicated pool-status sets → F-004.

### `src/components/BNYScheduler.jsx`
**Responsibility:** BNY digital weekly grid (7 Brooklyn + 12 Passaic-physical machines), machine×day, operator per cell, 7 buckets.
**Data:** R `sched_wip_rows`; R/W `sched_assignments` (with `day_of_week` TEXT); R/W `sched_daily_ops` (operator dual-write); POST `/api/claude-stream`.
**Week anchor:** **Sunday**; `dowText()` normalizes legacy numeric `day_of_week` → text on read/write. Recent commits + a CHECK-constraint violation incident trace here → ties to F-001/Phase 3. `mixTotals` rollup → F-008.

### `src/components/LiveOpsTab.jsx`
**Responsibility:** End-of-shift actuals entry (yards/waste/operators) per site/day; pulls plan targets from assignments as background.
**Data:** R/W `sched_daily_ops`; R `sched_assignments`.
**Relationships:** `dailyOps`, `budgets`, `scheduleUtils`.
**Week anchor:** **Sunday** — `mondayOf()` (deprecated alias returning Sunday) + `dayOfWeekFiscal()`. Target precedence: daily override → cell assignment → weekly÷5 fallback.

### `src/components/ProductionTab.jsx` — **ORPHANED**
**Responsibility (legacy):** Google-Sheets-backed production tracker (2 sheets), parse + PDF export.
**Data:** Google Sheets API v4 via `VITE_GOOGLE_SHEETS_API_KEY`. **No Supabase.**
**Status:** Its exports are imported by `App.jsx` but **never mounted** (confirmed in /init). Self-contained Sheets mirror disconnected from the `sched_daily_ops` flow. → finding F-002 (cleanup candidate).

### `src/components/ProductionDashboard.jsx`
**Responsibility:** Weekly production summary entry/view (NJ categories + BNY buckets + machines), actual-vs-target, rolling-month/MTD/YTD.
**Data:** R/W `production` (`week_start`, `nj_data`/`bny_data` JSON).
**Relationships:** `budgets`, `fiscalCalendar`, `CommentButton`. Rendered inside ExecutiveDashboardPage and AdminPanel.
**Week anchor:** **MIXED / suspected bug** — receives a Sunday `weekStart` prop but internally computes `getWeekStart(d)=startOfWeek(d,{weekStartsOn:1})` (**Monday**) for rolling/MTD filters. → **F-001 (prime exhibit).**

---

## 4. Heartbeat destination

### `src/components/HeartbeatPage.jsx` (~1900 lines)
**Responsibility:** Live plant pulse — schedule vs actuals for a week across both sites; 9 sections; all aggregation done in-file.
**Data:** R `sched_assignments`, `sched_daily_ops`, `v_current_wip_rollup`, `business_facts` (legacy WIP seed), `sched_wip_rows`.
**Relationships:** renders `PassaicSection`, `BNYSection`, `ClaudeReadBlock` (must pass `contextScope='minimal'`); `heartbeatNarrative` prompt; `budgets`.
**Week anchor:** **Sunday** (`startOfWeek(weekStart,{weekStartsOn:0})`); passes the Sunday date to `getFiscalLabel` whose map is Monday-keyed → lookup-mismatch risk → F-009.
**Internal helpers (productionRollup family):** `aggregateBySite`, `buildCategoryData`, `build17TableState`, `buildBnyMachines`, `buildBnyBucketYards`, `buildOperatorScorecards`, `classifyBnyBucket` — bespoke, not shared → F-008. Color-yards interpolated from planned ratio per cell. BNY machine `location` ('brooklyn'|'passaic') routes Passaic-physical digitals into the Passaic scorecard (intentional cross-pool coupling). Several bucket/bottleneck mappings hardcoded.

### `src/components/PassaicSection.jsx`
Presentational Passaic detail (category rows, 17-table floor, watch cards, top jobs). Props-only. **WaterCooler/ComplexityCurve cards render hardcoded illustrative numbers** (placeholder). Uses `WIPStatusBar`.

### `src/components/BNYSection.jsx`
Presentational BNY detail (19 machines partitioned by physical location + bucket-mix bar). Props-only. Location split is visual, not scheduling.

### `src/components/WIPStatusBar.jsx`
Canonical 3-segment WIP bar (Ready/In Prep/Blocked) expanding to 9 LIFT statuses on hover. Props-only. **9 statuses + bucket mapping hardcoded** (breaks if ERP adds a status). Desktop-hover only.

### `src/components/PlantRollup.jsx` — **SUSPECTED UNUSED**
Three headline cards (Yards / Color-Yards / Complexity) with `statusFor()` thresholds. **Not imported by HeartbeatPage**, which inlines a richer `PlantPulse` instead. Possible dead code → F-011 (verify in Phase 4).

---

## 5. Admin area

### `src/components/AdminLayout.jsx`
Sidebar shell (DATA / INTELLIGENCE / ACCESS / SYSTEM groups) → routes to AdminPanel, StubPages, UserManagement, LIFTDataRefresh, MonthlyBriefs. Super-admin-only items gated by `isSuperAdmin`. Includes a read-only `SystemInfoPanel`. Passes `weekStart` through.

### `src/components/AdminPanel.jsx`
**Responsibility:** Weekly data-entry hub — 5 tabs (Production, KPI, People, Financials, Log) with a persistent week picker; AI KPI narrative.
**Data:** R/W `production`; R/W `weeks` (via `onSave`); POST `/api/claude`.
**Relationships:** `AdminPeople`, `AdminFinancials`, `fiscalCalendar`, embeds `ProductionDashboard`/`KPIScorecard`/`WeeklyLog`.
**Week anchor:** **Sunday** (`weekStartsOn:0`, explicit). Hardcoded NJ/BNY targets (dup of budgets.js) → F-005.

### `src/components/AdminPeople.jsx`
Payroll XLSX (SheetJS, client-parsed) + HR PPTX (JSZip text extract → `/api/claude` → structured JSON). W `people_weekly` (upsert by `week_start`). Splits employees by location string ("brooklyn"→BNY). AI call not logged → F-010.

### `src/components/AdminFinancials.jsx`
GP/AP/AR/Cash Excel uploads with multi-format detection. R/W `financials_monthly` (by `period`+`business_unit`), `financial_ap` (+`facility`), `financial_ar`, `financial_cash`. **Owns the write-side `derivePeriod()`** that FinancialTab must mirror → F-006. SheetJS via CDN.

### `src/components/UserManagement.jsx` (super-admin only)
R `profiles`; W `profiles` (role/active); W `role_change_log` (audit). Guardrails: can't change/deactivate self. Gated by `isSuperAdmin` (defense-in-depth with AdminLayout). No email column on `profiles` (lives in `auth.users`).

### `src/components/LIFTDataRefresh.jsx`
Three upload tiles (WIP / MOS / Inventory) → parser → `persistSnapshot`. `supabase.auth.getUser()` for attribution. ShareFile auto-refresh noted as planned (~end June 2026).

### `src/components/UploadTile.jsx`
Single upload slot: freshness chip (30 h/48 h thresholds), validation via `fileFingerprint`, current-snapshot summary + history. R `data_snapshots` via `persistSnapshot` helpers.

### `src/components/LoginScreen.jsx`
Email/password sign-in; fetches `profiles` row; calls `onLogin(user, profile)`. If profile fetch fails, still calls back with `null` → "no destinations" path.

---

## 6. Shared widgets

### `src/components/CommentButton.jsx`
Reusable comment thread keyed by `(week_start, section)`. R/W `section_comments` (+ replies via `parent_id`), delete-own. Exports hardcoded `TEAM` list for @-notify. Week key `format(weekStart,'yyyy-MM-dd')`. Integration point for collaboration; section-id uniqueness is caller's responsibility.

### `src/components/ClaudeReadBlock.jsx`
**Responsibility:** The shared AI-narrative widget — load/auto-generate/edit/save/regenerate.
**Data:** R/W `dashboard_narratives` (by `week_start`+`time_window`); POST `/api/claude`; `contextBuilder.buildDashboardContext` + `logAICall`; default prompt `dashboardNarrative`.
**Behavior:** respects human edits (won't auto-regen), regenerates if auto + stale (>2 h); parent can override `buildPrompt` (Heartbeat passes `heartbeatNarrative`) and `contextScope` (`minimal` vs `full`); injects page `currentData`. **Central node for the narrative-unification design (Phase 5).** Logs every call to `ai_call_log` — unlike the ad-hoc `/api/claude` callers (KPIScorecard, AdminPanel, AdminPeople, MonthlyBriefs) → F-010.

---

## 7. lib/ — business logic & utilities

### Date / week primitives
- **`src/lib/scheduleUtils.js`** — canonical week helpers + palette + rosters + SITES. `sundayOf()` (**Sunday**, post-migration); deprecated aliases `mondayOf=sundayOf`, `weekLabelFiscal=weekLabel`; `dayOfWeekFiscal`, `dateForDayOfWeek`, `isoDate`, `DAY_NAMES_*`, `DAY_INDEX`. `day_of_week` is TEXT post-migration B2. The intended single source of week truth — but several modules bypass it (Phase 3).
- **`src/fiscalCalendar.js`** — static FY2026 lookup, **keys are Monday dates** (e.g. `2026-01-05` = Monday; verified). `getFiscalInfo`/`getFiscalLabel`. **Monday-keyed**, while sched/production are Sunday-keyed → the core conflict. No FY2027 data.

### Budgets / targets
- **`src/lib/budgets.js`** — canonical weekly plan figures (Passaic categories, BNY buckets, per-machine targets, customer split); `weeklyBudgetYards/ColorYards/Revenue`, `monthlyBudget`, `bnyMachine*Target`. Self-checks at load. **Intended single source — but AdminPanel/DashboardPage/WeekPaceStrip still carry local target copies** → F-005.

### AI / narrative
- **`src/lib/contextBuilder.js`** — tiered Claude context (A: `business_facts`; B: `weeks`, `production`, `historical_summaries`, `section_comments`, `dashboard_narratives`; C: forward state) + `logAICall` → `ai_call_log`. `scope='full'` vs `'minimal'` (Heartbeat). **Week anchor: uses raw `date-fns startOfWeek` (Monday default) in places** → Phase 3 item.
- **`src/lib/historicalSummaries.js`** — rolls `production` → `historical_summaries` (weekly/monthly/quarterly), throttled daily via localStorage. **Week anchor: Monday** (`weekStartsOn:1`) → F-001 family.
- **Prompt templates:** `src/lib/prompts/dashboardNarrative.js` (run-rate, forward), `src/lib/prompts/weeklyRecapNarrative.js` (recap, backward, exec), `src/prompts/heartbeatNarrative.js` (live pulse, ops voice), `src/lib/monthlyBriefNarrative.js` (mid/end, COGS-pending + procurement-passthrough rules). Distinct audiences/voices — central input to Phase 5.

### File ingestion
- **`src/lib/persistSnapshot.js`** — universal write path: parent `data_snapshots` row → batched (500) child inserts via `CHILD_TABLE_MAP` (`wip_*`, `mos_*`, `inv_*`, `mos_material_color`) → finalize `is_current`/`status`. DB trigger clears prior `is_current`. `getCurrentSnapshot`/`getSnapshotHistory`.
- **`src/lib/fileFingerprint.js`** — validates sheet structure before parse; `guessFileKind` scoring; prevents wrong-slot uploads.
- **Parsers** (`src/lib/parsers/`): `parserHelpers.js` (header detect, forward-fill, safe coercion, raw_row fallback), `parseWipFile.js` (5 sheets), `parseMosFile.js` (6 sheets), `parseMosMaterialColor.js` (single-sheet, inlined helpers — will fold into parseMosFile), `parseInventoryFile.js` (4 sheets, 2–4 raw-only).
- **`src/liftParser.js`** — LIFT Production WIP pivot → classified PO rows (site, BNY 9-rule bucketing, shadow-row detection, strict header validation, age buckets). Feeds WIPTab/SchedulerTab.

### Monthly brief data/PDF
- **`src/lib/monthlyBriefData.js`** — gathers `production`, `financials_monthly`, `financial_ap/ar/cash`, `people_weekly`, `sched_snapshots`, `sched_wip_rows`; R/W `monthly_briefs`. COGS withheld until after the 10th. Calendar-month + `YYYY-MM-W*` finance keys.
- **`src/lib/monthlyBriefPdf.js`** — jsPDF (CDN) render to fixed reference layout.

### Data access / auth
- **`src/lib/dailyOps.js`** — `sched_daily_ops` R/W; `loadWeekDailyOps`, `upsertDailyOp` (unique key site+week_start+table_code+day_of_week+shift), `buildRecentActualsSummary` (AI context). **Week anchor: Sunday** via `isoDate`; `day_of_week` TEXT.
- **`src/lib/newGoods.js`** — read layer for Monday.com New Goods: `mng_snapshots`, `v_current_mng_items`, `mng_observations`; triggers edge functions; detects Netlify HTML error pages.
- **`src/lib/access.js`** — role→destination map + `isSuperAdmin` (hardcoded `pwebster@fsco.com`) + `DESTINATIONS` metadata. (Client-side gating only; RLS is permissive.)
- **`src/supabase.js`** — client init (`VITE_SUPABASE_URL`/`ANON_KEY`, `pp_auth`, realtime 10 eps).

---

## 8. Serverless functions (`netlify/`)

Routes via `netlify.toml` and/or per-file `export const config.path`.

| Route | File | Runtime | Purpose | Secrets | Tables / external |
|---|---|---|---|---|---|
| `/api/claude` | `edge-functions/claude.ts` | Deno edge | Non-streaming Claude proxy | `VITE_ANTHROPIC_API_KEY` only | Anthropic |
| `/api/claude` | `Functions/claude.mjs` | Node | Streaming+non-streaming proxy | `VITE_ANTHROPIC_API_KEY` only | Anthropic | 
| `/api/claude-stream` | `edge-functions/claude-stream.mjs` | Deno edge | Streaming proxy (Scheduler Ask-Claude, Opus) | `VITE_ANTHROPIC_API_KEY` only | Anthropic |
| `/api/monday-newgoods-refresh` | `edge-functions/…refresh.ts` | Deno edge | Pull 2 Monday boards → snapshot | `VITE_MONDAY_TOKEN`‖`MONDAY_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` | Monday GraphQL; W `mng_snapshots`,`mng_items` |
| `/api/monday-newgoods-observations` | `edge-functions/…observations.ts` | Deno edge | AI observations on pipeline | `VITE_ANTHROPIC_API_KEY`‖`ANTHROPIC_API_KEY`, service role | Anthropic (`claude-sonnet-4-6`); R `mng_items`, W `mng_observations` |
| `/api/slack` | `edge-functions/slack.ts` | Deno edge | Post dashboard comments to Slack | `SLACK_BOT_TOKEN`,`SLACK_CHANNEL_ID` | Slack |
| `/api/slack-sync` | `edge-functions/slack-sync.ts` | Deno edge | Sync Slack thread replies → comments | `SLACK_BOT_TOKEN`,`SLACK_CHANNEL_ID`, `VITE_SUPABASE_URL`,`VITE_SUPABASE_ANON_KEY` | Slack; R/W `section_comments` |
| `/api/slack-upload` | `edge-functions/slack-upload.ts` | Deno edge | Upload PDF to Slack | `SLACK_BOT_TOKEN` | Slack |
| `/api/slack-users` | `edge-functions/slack-users.ts` | Deno edge | Search workspace members | `SLACK_BOT_TOKEN` | Slack |
| `/api/slack-note-notify` | `edge-functions/slack-note-notify.ts` | Deno edge | Post production notes w/ @mention | `SLACK_BOT_TOKEN`,`SLACK_NOTES_CHANNEL_ID` | Slack |
| `/api/generate-pdf` | `Functions/generate-pdf.mjs` | Node | Branded PDF (pdfkit) | none | — |
| `/api/lock-wip` | `Functions/lock-wip.js` | Node, **scheduled** `0 5 * * 6` | Weekly Monday-board WIP snapshot | `VITE_MONDAY_TOKEN` only, `SUPABASE_SERVICE_ROLE_KEY` | Monday board `6053588909`; W `wip_snapshots` |

**Serverless seams:**
- **Two `/api/claude` impls** — netlify.toml routes the path to the *edge* function, so the Node `claude.mjs` (the streaming-capable one) is likely **unreachable/dead**; streaming actually runs through `/api/claude-stream`. → F-012.
- **netlify.toml lists `lock-wip` and `generate-pdf` under `[[edge_functions]]`**, but both are Node functions in `netlify/Functions/` (capital F). Possible runtime/dir-case mismatch on Netlify's Linux build → F-013 (verify).
- **`lock-wip` still hits Monday board `6053588909` and writes `wip_snapshots` weekly** — directly contradicts WIPTab's "Monday.com retired, wip_snapshots gone" comment → **F-003.**
- **Env-var `VITE_` prefix inconsistency** — Claude/lock-wip read `VITE_`-only; newgoods funcs accept unprefixed fallback → extends seeded finding F-014.
- `slack-sync` uses the **anon key server-side** (should be service role for writes). Three separate hardcoded Slack user-ID maps with name-format drift. `/api/claude-stream`, `/api/monday-newgoods-*` are not in netlify.toml (rely on in-file config).

---

## 9. Consolidated week-anchor table (feeds Phase 3)

| Module / file | Anchor | Mechanism | Risk |
|---|---|---|---|
| `fiscalCalendar.js` | **Monday** | keys are Monday dates (`2026-01-05`) | source of the conflict |
| `scheduleUtils.sundayOf` | Sunday | `getDay()` subtract | canonical (correct) |
| `App.jsx` | Sunday | `startOfWeek(…,{weekStartsOn:0})` | — |
| `AdminPanel.jsx` | Sunday | explicit `weekStartsOn:0` | — |
| `HeartbeatPage.jsx` | Sunday | `weekStartsOn:0` | passes Sunday to Monday-keyed `getFiscalLabel` (F-009) |
| Scheduler{Tab,Passaic,BNY}, `LiveOpsTab`, `dailyOps` | Sunday | `isoDate(weekStart)` / `mondayOf` alias | — |
| `ExecutiveDashboardPage.jsx` | **Both** | `.in('week_start',[mon,sun])` | migration band-aid |
| `DashboardPage.jsx` | **Monday** | `weekStartsOn:1` | F-001 (misses Sunday rows) |
| `WeekPaceStrip.jsx` | **Monday** | `weekStartsOn:1` | F-001 |
| `ProductionDashboard.jsx` | **Mixed** | Sunday prop in, `weekStartsOn:1` internal | F-001 (prime exhibit) |
| `historicalSummaries.js` | **Monday** | `weekStartsOn:1` | F-001 family |
| `contextBuilder.js` | **Monday (default)** | raw `date-fns startOfWeek` | F-001 family |
| `lock-wip.js` | **Monday** | manual Monday calc | F-001 + F-003 |
| `FinancialTab` / `AdminFinancials` | calendar-week | `YYYY-MM-W{ceil(day/7)}` | orthogonal; read/write contract F-006 |
| `MonthlyBriefs` / `monthlyBriefData` | calendar month | `yyyy-MM` | — |

> The split is not "old vs new code" cleanly — Sunday and Monday assumptions coexist *within the same destinations*. Phase 3 will line-verify each row and define the canonical fix.
