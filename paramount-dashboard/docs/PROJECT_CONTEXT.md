# Paramount Dashboard — Project Context

> **What this is.** Originally the audit's input document (May 2026 consolidation), kept in the repo as durable project context. The architecture/code/schema sections are **historical** — superseded by the audit deliverables (`ARCHITECTURE.md` and the phase docs) — and remain here as the as-of-May-2026 snapshot. The **business reference data, known-issue items outside the audit's scope, key people, and superseded approaches are LIVE** and live nowhere else; treat those as the canonical record for domain knowledge the code doesn't capture.
>
> **How to read this doc.** Sections marked `[HISTORICAL]` are kept for context but the audit deliverables are authoritative for anything they cover. Sections marked `[LIVE]` are the current reference. Where this doc directly contradicts the audit (one such case in §5), the contradiction is called out inline with a pointer to the resolving finding.
>
> **Provenance.** Compiled May 2026 from an earlier handoff skeleton plus two summary documents covering ~13 development conversations. Pre-dates the architecture audit; the audit's findings, decisions, and migration plans live in `docs/`.
>
> *Owner:* Peter Webster, President — Paramount Prints / F. Schumacher & Co. · *Project context preserved:* June 2026

---

## §0 — Where to look for what

- **Architecture, code map, data model, week-anchoring, consolidation plan, narrative integration, ranked roadmap** → `ARCHITECTURE.md` and the phase docs (`docs/MODULE_MAP.md`, `docs/DATA_MODEL.md`, `docs/WEEK_ANCHORING.md`, `docs/CONSOLIDATION.md`, `docs/NARRATIVE_INTEGRATION.md`)
- **Findings F-001 through F-029, scored and ranked** → `docs/FINDINGS_LOG.md` + `ARCHITECTURE.md §7`
- **Business reference data** (production targets, machines, operating rules, fiscal calendar specifics) → §10 of this doc
- **Key people** → §12 of this doc
- **Superseded approaches not to waste time on** → Appendix of this doc

---

## 1. Project overview [HISTORICAL]

The Paramount Dashboard is a React web application that serves as the executive operations and production-management system for **Paramount Prints**, a specialty textile/wallcovering printing subsidiary of **F. Schumacher & Co. (FSCO)**. It replaces manual Excel/email reporting and unstructured scheduling with a single integrated tool.

- **Live URL:** https://updates-paramount.netlify.app
- **It is one application with two halves:** an executive *reporting* platform (production/financial/people/KPI reporting for leadership — Part A below) and an *operations/scheduling* module (the production scheduler and live-ops actuals — Part B below).

**Company context.** Paramount Prints runs two production facilities, plus a procurement/pass-through line. Business-unit (cost-center) codes recur throughout the data model:

| BU code | Facility | Process |
|---|---|---|
| **609** | Brooklyn Navy Yard (**BNY**) | Digital printing — machine-driven |
| **610** | Passaic, NJ (**NJ**) | Hand screen printing — people-driven (fabric, grass cloth, wallpaper) |
| **612** | Shared / Corporate | Overhead — no production |

A digital machine fleet is physically located in Passaic but reports to the **BNY (609)** budget — an important nuance the interface must keep clear.

---

## 2. Pre-audit state assessment [HISTORICAL]

> Kept verbatim from May 2026. The architecture audit is now done — see `ARCHITECTURE.md` and §7 of that doc for the current implementation roadmap.

The dashboard was built iteratively over roughly eight weeks (late March – early May 2026). Each module — Scheduler, Live Ops, the reporting tabs, the narrative system — was effectively written as its own "story" in separate sessions. The modules work in isolation, but **the seams between them are where the problems live.**

**The root issue Peter identified.** It is *not* the 4-4-5 fiscal calendar (that was given correctly from the start and `fiscalCalendar.js` is correct). The actual problem is that the codebase carries **two week-keying conventions that don't agree**: `FISCAL_CALENDAR` is Monday-keyed, while the `production` and `sched_*` tables are Sunday-keyed (after a May 2, 2026 migration). Every module makes its own local decision about which to use, so a fix in one place keeps breaking others. (This became audit finding F-001, ranked joint top-tier; see `WEEK_ANCHORING.md` for the resolution plan.)

**The original four go-forward initiatives:**

1. Fix the calendar / week-keying foundation
2. Eliminate duplicated logic — a shared-utility layer
3. Integrated, learning narrative system
4. API readiness — live API feeds replacing manual uploads

These map roughly onto the audit's wave structure (`ARCHITECTURE.md §7`): Initiative 1 → F-001 in Wave 1; Initiative 2 → F-008/F-005/F-006/F-007 in Waves 4-5; Initiative 3 → the entire narrative integration epic (`NARRATIVE_INTEGRATION.md`, 8-stage migration); Initiative 4 → deferred, not in the audit's prioritized backlog.

---

## 3. Technical stack [HISTORICAL]

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 5 |
| Styling | Mix of CSS Modules and inline styles (warm "luxury" palette; serif display headings) |
| Database | Supabase (PostgreSQL + Auth + Realtime) |
| Hosting / CI | Netlify — auto-deploys on git push to `main` |
| Serverless (streaming) | Netlify Edge Functions (Deno/TypeScript) — required for SSE |
| Serverless (non-streaming) | Netlify classic Functions (Node) — PDF generation, scheduled jobs |
| AI — exec narrative | Claude Sonnet 4 (`claude-sonnet-4-20250514`), non-streaming, via `/api/claude` |
| AI — scheduler advisor | Claude Opus 4.7 (`claude-opus-4-7`), streaming, via `/api/claude-stream` |
| Spreadsheet parsing | SheetJS (`xlsx`) |
| Charts | Chart.js 4.4.1 |
| Dates | `date-fns` + a custom `fiscalCalendar.js` |
| Source control | Git → GitHub (`petergwebster/updates-paramount`) → Netlify |

Two AI endpoints exist because they have different runtime needs: the short executive summary is fine on a classic function with Sonnet; the scheduler's "Ask Claude" is a long streaming conversation that classic functions cannot serve (they buffer the body and time out at 10–26s), so it runs on an Edge Function with Opus 4.7.

> **Note:** Model IDs in this section are pre-audit. The audit found model drift across endpoints (`claude-sonnet-4-20250514` in some places, `claude-sonnet-4-6` in others) — see F-029. Stage 0 of the narrative integration migration consolidates this.

---

## 4. Repository & deployment [HISTORICAL]

- **GitHub repo:** `petergwebster/updates-paramount` (branch `main`)
- **Local path (May 2026):** `C:\Users\pwebster\OneDrive - F. Schumacher & Co\Desktop\Supabase\paramount-dashboard`
- **Local path (current):** `C:\Dev\updates-paramount\paramount-dashboard` (moved out of OneDrive — see §11 known issue 3)
- **Hosting:** Netlify, auto-build (~1–2 min) on push to `main`; the cloud build runs `npm install`.

**Deploy workflow.** Peter is not a developer and cannot install Node/npm locally (IT restriction). The workflow is: Claude produces complete files → Peter saves them to the correct paths → Peter runs git commands manually → Netlify auto-deploys.

**`netlify.toml`** sets `command = "npm run build"`, `publish = "dist"`, `functions = "netlify/functions"`, and declares each `[[edge_functions]]` route explicitly.

### Working conventions (how to collaborate on this project)

- Deliver **complete file replacements**, never patches or diffs.
- Give the **single git command** in a code box; always remind Peter to `cd` to the repo first.
- `netlify` folder name must be **lowercase** — Netlify is case-sensitive, Windows git is not. (This became audit finding F-013 — the casing was inconsistent and is part of the Wave 2 cleanup.)
- Windows sometimes saves files as `filename (8).jsx` — remind Peter to rename/overwrite correctly.
- **Validate before shipping:** `@babel/parser` parse-check on every JS/JSX file; PostCSS for CSS.
- No README files — inline deployment info only.
- Inline prose for explanations, not bullet lists, unless lists genuinely help.
- Treat Peter as a technical peer who runs his own company — don't over-explain, don't grovel over mistakes; acknowledge briefly and fix.
- Honest pushback when something doesn't make sense is expected and wanted.

---

## 5. Environment variables [HISTORICAL with one important correction]

Set in the Netlify dashboard. Secret values live only in Netlify.

| Variable | Used by |
|---|---|
| `VITE_SUPABASE_URL` | Frontend — Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Frontend — Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server functions — elevated DB access |
| `ANTHROPIC_API_KEY` | Claude functions |
| `SLACK_BOT_TOKEN` | Slack edge functions |
| `SLACK_WEBHOOK_URL` | Slack channel notifications |
| `SLACK_CHANNEL_ID` | `#pp-leadership-updates` |

> ⚠️ **Audit correction (F-014).** This section's original draft referenced the Anthropic key inconsistently as `VITE_ANTHROPIC_API_KEY` and `ANTHROPIC_API_KEY`. The audit confirmed this: any `VITE_`-prefixed variable is bundled into the **client-side** code and visible in the browser. F-014 is now a Wave-1 prerequisite — the Anthropic-key rename is part of the narrative gateway Stage 0 (see `NARRATIVE_INTEGRATION.md §3.1`). The Monday token half rides with F-013's netlify cleanup.

> ⚠️ **Audit correction (F-016).** The May 2026 draft of this section stated that "RLS policies are the *real* access boundary and should be explicitly reviewed." **The audit contradicts this.** 25 tables have RLS disabled and are anon-exposed (including financials, payroll inputs, and AI logs); `people_weekly` is the only genuinely role-restrictive table. Security currently rests on URL obscurity + client-side role gating, not RLS. F-016 is ranked joint top-tier (alongside F-001) and remains its own security epic — the narrative gateway provides only a narrow two-table mitigation.

**Supabase project:** ID `twsfmzohaymobqmmeayd`, region `us-east-1`.

**Legacy variables likely removable:** `VITE_ADMIN_PASSWORD` (replaced by Supabase Auth), `VITE_GOOGLE_SHEETS_API_KEY` (Google Sheets approach dropped — see Appendix), `VITE_MONDAY_TOKEN` (Monday.com dropped as a scheduling source — see Appendix).

---

## 6. Navigation structure [HISTORICAL]

The app is organized into **three destinations plus an Admin panel**:

| Destination | Tabs | Audience |
|---|---|---|
| **Paramount Performance** | Recap, Financials, People, Inventory | Exec / Peter |
| **Operations** | WIP, Scheduler, Live Ops, New Goods | Wendy, Chandler, Sami |
| **Paramount's Heartbeat** | single page — plant rollup + Passaic + BNY + "Claude's read" | Peter, exec |
| **Admin** (gear icon ⚙) | Weekly Data, LIFT Refresh, Monthly Briefs, AI Monitoring, Daily Digest, User Management, System Info | Admin only |

Access is role-based via Supabase Auth. (Note: per F-016, this is UI gating, not a security boundary.)

---

## 7. Part A — Executive reporting platform [HISTORICAL]

The reporting half gives FSCO leadership a structured weekly briefing, replacing ad-hoc email summaries.

- **Recap / Performance** — landing view: AI executive narrative, KPI status strip, production summary (NJ + BNY), KPI scorecard detail, areas of concern.
- **Financials** — COGS, OpEx, inventory purchases, AP aging, AR aging, cash position, by business unit. (Substantially rebuilt in June 2026 — see git history.)
- **People** — weekly headcount, hours (regular/OT/PTO), payroll, bonuses, leaves, open roles.
- **Inventory** — inventory view (fed by the MOS workbook / `inv_*` pipeline tables).
- **Paramount's Heartbeat** — a single-page plant rollup combining Passaic + BNY with a Claude-written read.
- **Monthly Briefs** — AI-generated Mid-Month and Month-End one-pager reports with client-side PDF export (jsPDF). (Audit F-018: the `monthly_briefs` table referenced by save/load doesn't exist; feature is broken pending the table-creation fix in Wave 2.)

**Weekly data entry** happens in the Admin → Weekly Data panel: production figures per facility/category, KPI scorecard grading (10 KPIs, status + notes), the Mon–Fri weekly log, financial GL upload, and people/payroll upload.

**Financial pipeline (June 2026 update).** The GP purchases workbook is now the standing source-of-truth file. Parser is header-based (detects columns by label, never hardcoded indices, because the column layout shifts month to month) and maps GL account numbers to categories: `4104/4105` → Material, `4108/4109` → Labor, `4111–4114` → WIP/Other COGS, `6xxx` → OpEx categories, `1437` → Inventory Purchases. Business units `609/610/612` as above. AR/AP each arrive as aging snapshots in the same workbook.

**AI narrative (reporting side).** "Draft with AI" generates the executive summary from entered KPI/production data via Claude Sonnet through `/api/claude`; the draft is editable before publishing and stored on the week record. (The narrative integration epic in Wave 3 unifies this with all other AI surfaces — see `NARRATIVE_INTEGRATION.md`.)

**Slack integration.** Comments on dashboard sections post to `#pp-leadership-updates` (Slack app "Paramount Dashboard"). Multiple edge functions: `slack`, `slack-sync`, `slack-upload`, `slack-users`, `slack-note-notify`. Recipients resolve through a hardcoded role/name → Slack-ID map.

---

## 8. Part B — Production / scheduling module [HISTORICAL]

The Operations half is a custom production scheduler for the Passaic plant (with a separate engine for BNY), plus end-of-shift actuals capture.

**The problem it solves.** Passaic has been missing its operating plan (e.g., Feb 2026: revenue $327.2K vs. $465.8K plan, EBITDA −$104.5K vs. +$65.4K plan, waste ~12% vs. <8% target). It is a throughput/scheduling-quality problem, not a WIP-volume problem. The production manager faces a hard Monday task: compose a weekly mix hitting three competing targets (yards, color-yards, revenue) plus a customer-mix ratio, aging backlog, and color-complexity constraints, across 17 tables and 400+ open POs. The operating thesis: **"the mix is the schedule"** — and evaluating a proposed draft is far easier than generating one from a blank page. So the tool always presents a credible draft to react to.

**Data flow.** The authoritative input is the **LIFT WIP export** — an Excel workbook (`liftParser.js` parses the "Production WIP" sheet). The `Division` column is the definitive site router: `Screen Print → passaic`, `Digital → bny`, `Procurement → procurement`. The parser removes duplicate "shadow" rows, computes color-yards, classifies BNY customer-mix buckets, and writes a snapshot + PO-level rows to the `sched_*` tables. Monday.com is deliberately **not** used for scheduling (it drifts 20–28% from LIFT).

**Passaic scheduler** (Screen Print) — the mix composer: live plant-level gauges (yards, color-yards, revenue, customer mix), a category strip (Grass/Fabric/Wallpaper), a filterable unscheduled-PO pool, and a 17-table grid with click-to-assign and PO splitting. Color-yards is a primary metric here.

**BNY scheduler** (Digital) — a structurally different problem: ordered job queues per machine (not table assignments), capacity in yards/machine/day, no color-yards, and a customer-mix bucket model (Replen, MTO/Custom, HOS, Memo, NEW GOODS, 3P). Governs the Brooklyn machines *and* the Passaic-located digital fleet.

**Live Ops** — end-of-shift actuals entry per site/table/day (yards, waste, two operators, free-text notes) with a Summary view that rolls both sites up with planned-vs-actual variance and operator scorecards. Notes support a delegation workflow (assign to a role, open/resolved lifecycle).

**Ask Claude** — a streaming conversational scheduling advisor (Claude Opus 4.7). It reads the live WIP pool and recent actuals, proposes a narrative plus a structured assignment block, and reasons about competing rules. **Authority model:** the AI never writes to the database — it only returns text and a proposal; the front end writes to the DB only when the production manager clicks "Apply." AI-proposed assignments are tagged `assigned_by = 'claude'` and marked with a gold badge.

**New Goods** — a separate pre-production pipeline view (strike-off → approval); excluded from the regular scheduling pool until status reaches "Approved to Print." **Procurement** is pass-through (procure → receive → repack → ship), no table-based schedule; ship-direct ("SPO") orders are flagged.

---

## 9. Supabase schema (by domain) [HISTORICAL — see `DATA_MODEL.md` for current]

> The audit produced a verified live schema export at `db/schema.sql` and the full data model documentation in `docs/DATA_MODEL.md` (42 tables + 8 views with RLS posture and R/W cross-refs). Treat that as canonical. The summary below is the May 2026 snapshot.

**Auth:** `profiles` (`id` = `auth.users.id`, `full_name`, `role`, `active`). Email lives on `auth.users`, **not** on `profiles`.

**Performance domain:** `production` (week_start PK — **Sunday-keyed**; `nj_data` and `bny_data` JSONB blobs), `financials_monthly` (period `YYYY-MM-W#`, business_unit, COGS + OpEx components; revenue/totals are computed, not stored), `financial_ap`, `financial_ar`, `financial_cash`, `people_weekly`, `weeks` (KPI/log metadata).

> **June 2026 update:** The Finance module was rebuilt. `financials_monthly`, `financial_ap`, `financial_ar`, `financial_cash` were briefly dropped and recovered from backup. The active tables are now `financial_transactions` and `financial_aging`. `monthlyBriefData.js` still reads from the legacy four — that migration is open work (see audit F-018 closure path).

**Scheduler / Live Ops (`sched_*`):** `sched_snapshots` (LIFT upload audit trail), `sched_wip_rows` (PO-level WIP pool, ~1,500–1,700 rows/snapshot), `sched_assignments` (the schedule), `sched_daily_ops` (the actuals), `sched_current_wip` (view of the latest snapshot — audit found this is an orphan, see F-022).

**Data pipeline ("Phase B2", ~17 tables):** `data_snapshots`, `data_source_config`, five `wip_*`, six `mos_*`, four `inv_*` child tables, plus views `v_current_wip_rollup`, `v_current_monthly_pacing`, `v_current_mos_materials`, `v_latest_snapshots`.

**Narrative / context:** `dashboard_narratives` (cached Claude narratives), `historical_summaries` (rolled-up weekly/monthly production summaries), `business_facts` (slow-changing facts fed to Claude), `monthly_briefs` (doesn't exist per F-018), `section_comments`.

### Critical data-shape gotchas [STILL CURRENT]

- **`day_of_week` is TEXT** (`'Sun'`…`'Sat'`) with a CHECK constraint on `sched_assignments` and `sched_daily_ops`. The scheduler UIs use numeric indices internally — writing a number fails the constraint. A `dowText()` coercion is applied at all read/write paths; verify no component still writes a numeric value.
- **The `.actual` path bug.** `bny_data` category values (`replen`, `mto`, `hos`, `memo`, `contract`) are stored as **string numbers directly** (e.g. `"9483"`) — not as `{ actual: ... }` objects. Reading `b.replen?.actual` silently yields `undefined` → `0`.
- **String-concat bug.** `<input type="number">` returns strings, so production JSONB stores `"9483"` not `9483`; `0 + "9483"` concatenates. Always coerce with a `num()` helper before arithmetic.
- **Supabase silently drops unknown columns on upsert** — any new field needs an `ALTER TABLE ... ADD COLUMN` migration *before* the frontend writes it, or data is lost without error.

---

## 10. Business reference data [LIVE — this section is the canonical source]

### Production targets — ⚠️ unreconciled across sources

The two modules carry **different target sets**, and they do not agree. This must be reconciled — do not assume either is authoritative.

**Passaic weekly:**
- *Scheduler module* (from the Feb 2026 results deck): **8,500 yards · 33,797 color-yards · $116,450 revenue · 60% Schumacher / 40% 3rd-Party.** Category splits — Grasscloth 3,785 yd / 11,355 CY / 2 tables; Fabric 834 yd / 3,337 CY / 9 tables; Wallpaper 3,830 yd / 15,319 CY / 6 tables.
- *Reporting dashboard* (`NJ_TARGETS`, attributed to Brynn): **8,610 yards · $128,951.25 revenue.** Categories — Fabric 810 yd, Grass 3,615 yd, Paper 4,185 yd. (An earlier color-yard total of 25,497 also appears, vs. the scheduler's 33,797.)

**BNY weekly:** total **12,000 yards**, Replen ~7,885, Held-to-Invoice target < 12,000 yards. ⚠️ The HOS and Memo per-category targets are recorded **swapped** between sources — one set has HOS 1,532 / Memo 211, the other HOS 210 / Memo 1,535. MTO 1,280 (split this cycle into Custom ~430 / MTO ~850, provisional). 3rd-Party ~1,090. NEW GOODS has no target.

### Machines & tables

- **BNY digital machines:** HP 3600 class (high volume) — Glow, Sasha, Trish. HP 570/830 class (small format) — Bianca, LASH, Chyna, Rhonda.
- **Passaic-located digital fleet** (reports to BNY budget): Dakota Ka, Dementia, EMBER, Ivy Nile, Jacy Jayne, Ruby, Valhalla, XIA, Apollo, Nemesis, Poseidon, Zoey.
- ⚠️ Small-machine daily capacity is recorded inconsistently (125 yd/day in one spec, 500 yd/day in the BNY board) — reconcile.
- **Passaic screen-print tables:** 17 total — Grasscloth GC-1–GC-2 (2), Fabric FAB-3–FAB-11 (9), Wallpaper WP-12–WP-17 (6).

### Operating rules (used by the scheduler / AI prompt)

- **Color-yards** = colors × yards, computed for Screen Print only; NULL (not zero) for Digital and Procurement.
- **Color-complexity rule:** each additional screen color adds ~20% production time (a 1.2^x curve); 6+ colors flags a job high-risk.
- **Waste-history watch-list:** Cloud Toile, Banana Leaf, Acanthus Stripe, Pyne Hollyhock, Botanico Metallic — flagged automatically in the pool.
- **FIFO rule:** POs aged 90+ days take scheduling priority.

### Fiscal calendar

4-4-5 fiscal calendar, weeks run **Sunday → Saturday**, week totals divide by 7 for pace math. Q2 2026 starts ~April 6 (FY week 14). See audit F-001 — the Monday-keyed `FISCAL_CALENDAR` vs. Sunday-keyed data tables was the top structural finding.

---

## 11. Known issues & technical debt [PARTIALLY LIVE]

> Items 1-5 and 9 were absorbed into the audit (see findings cross-references). Items 6-8 remain outside the audit's scope and stay live here.

1. **Week-keying mismatch** (Monday vs. Sunday) — captured as audit F-001, joint top-tier, Wave 1.
2. **Duplicated logic across modules** — captured as audit F-004/F-005/F-006/F-007/F-008, Wave 4-5.
3. **OneDrive file corruption** — resolved; the repo was moved to `C:\Dev\updates-paramount\paramount-dashboard` (out of OneDrive).
4. **Slack note-notify blocked** — still outstanding; the delegated-note DM function returns `missing_scope`; needs an IT/Slack-admin scope change (`im:write`, possibly `chat:write`) and a reinstall. Jan (see §12) is the approver.
5. **Anthropic API key prefix** — captured as audit F-014 (Wave 1 prerequisite for narrative Stage 0).
6. **[LIVE] No planned-vs-actual operator distinction** — `sched_daily_ops` stores one operator pair per cell; scheduler and Live Ops overwrite each other ("current truth wins"). Not in the audit's prioritized backlog; worth tracking separately.
7. **[LIVE] `business_facts` hygiene** — may contain point-in-time WIP snapshots Claude could quote as if live; needs an audit. Flagged in `NARRATIVE_INTEGRATION.md §5` as a cross-reference, but the cleanup pass itself is unscheduled.
8. **[LIVE] Provisional figures** — the Custom/MTO target split is a proration, not confirmed. Brynn (see §12) is the source.
9. **Manual LIFT upload** — was expected to be replaced by a live LIFT API ~late May 2026. Status unverified.

---

## 12. Key people [LIVE]

| Person | Role | Relevance |
|---|---|---|
| Peter Webster | President, Paramount Prints | Project owner; dashboard admin |
| Timur Yumusaklar | CEO, FSCO | Primary exec audience |
| Emily Huber | Chief of Staff, FSCO | Exec audience |
| Antonella Pilo | CFO | Financials audience |
| Wendy Reger-Hare | Production Manager, Passaic | Primary Passaic scheduler user |
| Chandler | BNY day-to-day ops | BNY scheduler user |
| Sami | Passaic | Live Ops actuals entry |
| Estephanie Soto-Martinez | Operations / Data | Provides weekly production data and GL files |
| Brynn Lawlor | Operations / Finance | Provides production & revenue targets |
| Jen | Finance | Sends monthly FINAL results ~2nd Tuesday after month-end (per June 2026 finance work) |
| Jan | IT / Slack admin | Approves Slack OAuth scope changes |

---

## 13. Roadmap [HISTORICAL]

> See `ARCHITECTURE.md §7` for the current 5-wave implementation roadmap and the ranked master table of all 29 audit findings. The summary below is the May 2026 view pre-dating the audit.

The May 2026 roadmap was: Architecture Audit → `ARCHITECTURE.md` (now complete), then the four initiatives in order — week-keying foundation, shared rollup utilities, integrated learning narrative, API readiness.

Other tracked items at the time of consolidation: the five scheduler exports (Weekly Schedule, Daily Actuals, Operator Scorecard, Weekly Retrospective, WIP Snapshot); the Phase-4 retrospective "memory" layer (now part of the narrative integration epic); night-shift schema extension (~June); live LIFT API; nightly automated LIFT import; Slack note-notify go-live (still blocked, see §11.4); automated Slack weekly/daily summary posts; pricing-tier redesign against the color-complexity curve; an email digest (blocked on a Paramount-owned domain); and an exploratory plant-floor camera / computer-vision track to measure real throughput against schedule.

---

## Appendix — superseded approaches [LIVE — keep, don't waste time re-exploring]

Recorded so nothing is lost, but **not** part of the current system:

- **Vanilla-HTML prototype (≈March 25, 2026).** An earlier first attempt — repo `petergwebster/Paramount-Dashboards`, URL `paramountprints-dash.netlify.app`, plain HTML/CSS/JS with three separate dashboard pages and a direct LIFT ERP API integration. This was replaced within days by the current React + Vite + Supabase rebuild. None of its file structure, URL, or direct-API integration is current.
- **Google Sheets production layer.** An intermediate approach fed daily production from two Google Sheets via the Sheets API. **This has been dropped** — the production module now uses the LIFT-upload → `sched_*` pipeline described in Part B. Disregard any Google Sheets IDs, Apps Script, or `VITE_GOOGLE_SHEETS_API_KEY` references.
- **Monday.com as a scheduling/WIP source.** Used early on; dropped because it drifts 20–28% from LIFT. LIFT is the source of truth.

---

*This is the consolidated project context. Sections marked `[HISTORICAL]` are kept as the as-of-May-2026 snapshot; the audit deliverables (`ARCHITECTURE.md` and the phase docs) are authoritative for anything they cover. Sections marked `[LIVE]` are the canonical record for domain knowledge not covered by the audit.*
