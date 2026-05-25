# Week Anchoring

> Phase 3 deliverable of the architecture audit. **`ARCHITECTURE.md` §4 links here** as the canonical week-anchoring reference. Resolves F-001 (define canonical anchor + migration plan) and F-009 (confirm the Heartbeat fiscal-label bug).
> Built from a line-cited verification fan-out across the 16 week-aware modules, cross-checked against direct reads of the contested call sites (`App.jsx`, `ExecutiveDashboardPage.jsx`, `KPIScorecard.jsx`, `ProductionDashboard.jsx`) and the `getFiscalInfo` implementation.
> Status: **DRAFT — awaiting sign-off.** Scope is **analysis + migration plan only**; the code change is a separate post-audit implementation pass (audit Decision 1).

---

## §0 — How to use this document

**Audience.** Future Claude Code sessions and any engineer who touches week keying, fiscal labels, or a structural date fix. Pair it with `DATA_MODEL.md §4` (the data-layer week facts) and `FINDINGS_LOG.md` (F-001/F-009).

**It answers:** which anchor is canonical and *why*, exactly where the code violates it (line-cited), and the staged migration that fixes it without breaking callers mid-flight.

**The one-sentence summary.** The database, `scheduleUtils`, and most operational code are **Sunday-anchored**; `fiscalCalendar.js` is the lone **Monday-anchored** straggler, and the mismatch breaks two mirror-image classes of code. Canonical anchor = **Sunday**; fix `fiscalCalendar.js` and the Monday-querying callers, not the other way around.

---

## §1 — The decision: canonical anchor is SUNDAY

**`week_start` is the Sunday of the FSCO 4/4/5 fiscal week, stored as a `yyyy-MM-dd` string. All week keying — DB queries, fiscal-calendar lookups, labels — anchors to that Sunday.**

### Why Sunday, not Monday (read this before "fixing" it back)

This decision is **already 90% realized in the code**; reversing it would be the regression. Three independent reasons it must stay Sunday:

1. **The database is Sunday-keyed.** Post the May 2026 migration (Migration A), every `week_start`/`period_start` column — `production`, `weeks`, `kpi_reactions`, `section_comments`, `people_weekly`, `sched_assignments`, `sched_daily_ops`, `historical_summaries`, `dashboard_narratives` — stores the **Sunday** date (`DATA_MODEL.md §4`). The data is the immovable anchor; code must match it, and a Monday query against Sunday-keyed rows silently returns **zero rows**, not an error.
2. **`scheduleUtils` already canonicalized Sunday.** The Phase A rewrite (May 1 2026, `scheduleUtils.js:6–18`) made `sundayOf` the canonical helper and demoted `mondayOf` to a **deprecated alias that also returns Sunday** (a misnomer kept only so imports don't break). `weekLabelFiscal` is likewise an alias for `weekLabel`. The shared utility layer has already picked Sunday.
3. **Most operational code is already correct.** The entire Scheduler/Live-Ops stack (`PassaicScheduler`, `BNYScheduler`, `SchedulerTab`, `LiveOpsTab`, `dailyOps`), the Heartbeat *data* queries, `App.jsx`'s week defaults, `AdminPanel`'s week selector, `KPIScorecard`'s reaction queries, and all of `contextBuilder` already compute and query Sunday. Switching the canon to Monday would break the majority to "fix" the minority.

`fiscalCalendar.js` (Monday-keyed) and a handful of Performance/Operations components that compute Monday are the **laggards**, written before Migration A and never reconciled. The fix brings them to Sunday.

> **Anti-regression note.** The misleadingly-named `mondayOf` alias and the comment `getFiscalInfo` "normalizes" input are the two traps that make a future engineer think Monday is intended. Neither implies Monday is canonical. If you are about to re-key something to Monday, stop — you are reintroducing F-001.

---

## §2 — The two mirror-image bug classes

The Monday/Sunday split manifests as two opposite failures, both rooted in the same conflict.

### Class 1 — Monday anchor used against the Sunday-keyed DB (`mismatch-DB`)
A component computes its week with `startOfWeek(d, { weekStartsOn: 1 })` (Monday) and then filters a Sunday-keyed table by that Monday string. Postgres finds no matching `week_start` → the query returns **nothing**, surfacing as silent "no data" or a wrong/zero aggregation. Affected: the Performance recap (`DashboardPage`, `WeekPaceStrip`), the internal `ProductionDashboard`, and the `historicalSummaries` backfill loop.

### Class 2 — Sunday passed to the Monday-keyed fiscal calendar (`mismatch-fiscalCalendar`)
A component passes a **Sunday** `week_start` (the now-correct value) to `getFiscalInfo`/`getFiscalLabel`. The mechanism (`fiscalCalendar.js:56–82`):
- A `yyyy-MM-dd` **string** → **direct lookup** `FISCAL_CALENDAR[str]` with no normalization (lines 65–66).
- A `Date` → `d.toISOString().split('T')[0]` → still that date's `yyyy-MM-dd` (line 71).

Either path produces a **Sunday** key (e.g. `2026-05-24`), and the map is keyed exclusively by **Mondays** (`2026-05-25`, `2026-05-18`, …) → returns **`null`**. The "normalize via Date constructor" reading is a fallacy: converting a Sunday `Date` to ISO yields a Sunday key, never a Monday. **Net effect: the fiscal-week label silently disappears app-wide** (Performance header, Executive page, KPI scorecard, Heartbeat, Monthly Briefs, Admin) — F-009 is one instance of this whole class.

The only code that passes a **Monday** to the fiscal calendar is `ProductionDashboard:420` — which therefore *accidentally works*, because that component is itself Monday-anchored (and thus Class-1-broken on its DB queries). One file, both bugs.

---

## §3 — Verified anchor table (line-cited)

Verdicts: **C-Sun** = correct (Sunday→Sunday DB) · **MM-DB** = Class 1 (Monday→Sunday DB) · **MM-FC** = Class 2 (Sunday→Monday fiscal calendar) · **C-FC** = correct fiscal lookup (Monday→Monday) · **dual** = queries both keys · **N/A** = separate keying scheme.

| file:line | what it computes / passes | anchor | verdict |
|---|---|---|---|
| App.jsx:147 | `getCurrentWeekStart` = `startOfWeek(now,{weekStartsOn:0})` | Sun | C-Sun |
| App.jsx:312/321/345 | `weeks` / `section_comments` queries by `week_start` | Sun | C-Sun |
| **App.jsx:419** | `getFiscalLabel(currentWeek)` — currentWeek is Sunday | Sun | **MM-FC** |
| DashboardPage.jsx:95 | `startOfWeek(today,{weekStartsOn:1})` | Mon | **MM-DB** |
| DashboardPage.jsx:99/244–247 | `production` exact + month-range queries | Mon | **MM-DB** |
| WeekPaceStrip.jsx:90/95 | Monday week + `production` `.eq('week_start',…)` | Mon | **MM-DB** |
| ProductionDashboard.jsx:95 | `getWeekStart` = `startOfWeek(d,{weekStartsOn:1})` | Mon | **MM-DB** |
| ProductionDashboard.jsx:258 | `production` `.eq('week_start', weekKey(weekStart))` | Mon | **MM-DB** |
| ProductionDashboard.jsx:420 | `getFiscalInfo(weekStart)` — weekStart is Monday | Mon | C-FC *(lone accidental match)* |
| ProductionDashboard.jsx:372/930/1006 | `getFiscalLabel(<DB row.week_start>)` — Sunday string | Sun | **MM-FC** |
| ExecutiveDashboardPage.jsx:56 | `getFiscalLabel(weekStart)` — Sunday prop | Sun | **MM-FC** |
| ExecutiveDashboardPage.jsx:90 | `production` `.in('week_start',[monday,sunday])` | dual | dual *(defensive — OK)* |
| FinancialTab.jsx:18/66 | `derivePeriod(weekStart)` → `YYYY-MM-W#` | — | N/A *(period keying, F-006)* |
| KPIScorecard.jsx:58/67/85/90 | Sunday `weekKey` + `kpi_reactions` queries | Sun | C-Sun |
| **KPIScorecard.jsx:206** | `getFiscalLabel(weekStart)` — Sunday prop | Sun | **MM-FC** |
| HeartbeatPage.jsx:144/166/169 | Sunday `weekKey` + DB queries | Sun | C-Sun |
| **HeartbeatPage.jsx:145** | `getFiscalLabel(weekStart)` — Sunday | Sun | **MM-FC** *(F-009 canonical site)* |
| PassaicScheduler.jsx:227/254/256 | `isoDate(weekStart)` insert + queries | Sun | C-Sun |
| BNYScheduler.jsx:285/318 | `isoDate(weekStart)` insert + query | Sun | C-Sun |
| SchedulerTab.jsx:72/89 | `isoDate(weekStart)` queries | Sun | C-Sun |
| LiveOpsTab.jsx:83/114/118/130/135/248 | `mondayOf`(→Sunday alias)/`isoDate` + queries | Sun | C-Sun |
| dailyOps.js:23 | `.eq('week_start', isoDate(weekStart))` | Sun | C-Sun |
| AdminPanel.jsx:267/275/496/548/306 | `startOfWeek(…,{weekStartsOn:0})` + `production` query | Sun | C-Sun |
| **AdminPanel.jsx:299** | `getFiscalInfo(effectiveWeek)` — Sunday | Sun | **MM-FC** |
| historicalSummaries.js:255 | `startOfWeek(now,{weekStartsOn:1})` → backfill loop queries `production` | Mon | **MM-DB** |
| historicalSummaries.js:82–92 | `ensureWeeklySummary` `.eq('week_start',…)` (thread-through) | Sun* | C-Sun *(only if caller passes Sunday — see §6)* |
| contextBuilder.js:255 + fetch helpers | `startOfWeek(now)` **implicit** default-Sunday; all DB by `week_start`/`period_start` | Sun | C-Sun *(fragile — relies on date-fns default, see §6)* |
| **monthlyBriefData.js:46/383/443/515** | `getFiscalInfo(<DB Sunday week_start>)` | Sun | **MM-FC** |
| lock-wip.js:89–104 | `getWeekInfo` computes Monday → `wip_snapshots` | Mon | **MM-DB** *(dead — F-003/F-013, skip)* |

**Bold rows are the live defects.** Class 2 (MM-FC) dominates: the fiscal label is dead everywhere a Sunday reaches the calendar — App header, Exec page, KPI scorecard, Heartbeat, Monthly Briefs, Admin. Class 1 (MM-DB) hits the Performance recap and the internal ProductionDashboard.

> **Reconciliation note.** The Performance-cluster verification agent initially marked App:419 / Exec:56 / KPIScorecard:206 as "correct — getFiscalLabel normalizes the Date." That is **wrong** and was overridden by direct read: a Sunday `Date` → `toISOString` → Sunday key → `null`. The three rows are Class-2 defects, identical to the sites the other two agents flagged.

---

## §4 — F-009 in context

`HeartbeatPage.jsx:145` (`getFiscalLabel(weekStart)` on a Sunday computed at line 144) is **confirmed** as a real bug — the Heartbeat fiscal label renders nothing. But F-009 is **not Heartbeat-specific**: it is one of seven+ instances of Class 2 (§3). Treat the fix as repairing the *class* (re-key + normalize `fiscalCalendar.js`), which closes F-009 and every sibling in one change. Downgrade F-009 from "latent/Med" to "confirmed, subsumed by the F-001 fix."

---

## §5 — The fix: Option B, two-step migration

Re-key the fiscal calendar to Sunday **and** add transitional input normalization, then remove the tolerance once callers are clean. Two steps so nothing breaks mid-migration, and so the canonical anchor is actually *enforced* at the end rather than left permanently permissive.

### Step 1 — Initial fix (one commit): re-key + normalize  *(no caller breaks)*
1. **Re-key `FISCAL_CALENDAR` to Sunday.** Shift every one of the 52 keys back one day (Monday → the preceding Sunday); the value objects (`fiscalWeek`, `month`, `weekInMonth`, `weeksInMonth`, `quarter`) stay attached to the same fiscal week. Deterministic, scriptable. Examples:
   - `"2026-01-05"` (Mon, FW1) → `"2026-01-04"` (Sun, FW1)
   - `"2026-05-25"` (Mon, FW21) → `"2026-05-24"` (Sun, FW21)
   - `"2026-12-28"` (Mon, FW52) → `"2026-12-27"` (Sun, FW52)
2. **Normalize input in `getFiscalInfo`.** Before lookup, snap any input (string or `Date`) to the Sunday of its week via `sundayOf` and format to `yyyy-MM-dd`, then look up. This makes the function tolerant of **either** anchor during migration: a Sunday matches directly; a stray Monday is snapped back to its Sunday and still resolves. Removes the silent-`null` failure immediately for all Class-2 sites.
   - Note: `fiscalCalendar.js` is currently import-free; Step 1 adds a dependency on `sundayOf` from `scheduleUtils` (or inlines an equivalent 3-line helper to avoid a new import edge — implementer's call).

After Step 1: **all Class-2 sites work** (Sunday inputs resolve). Class-1 sites (`MM-DB`) are unaffected — they are DB-query bugs, not fiscal-calendar bugs — and are fixed in the caller cleanup below.

### Caller cleanup (the migration body — between the two steps)
- **Fix Class-1 DB-query sites to Sunday:** `DashboardPage:95`, `WeekPaceStrip:90`, `ProductionDashboard:95` (`getWeekStart`), `historicalSummaries:255` — change `{ weekStartsOn: 1 }` → `{ weekStartsOn: 0 }` (or use `sundayOf`). This is what actually unbreaks the Performance recap and ProductionDashboard data.
- **Make implicit Sunday explicit:** `contextBuilder.js:255` relies on the date-fns *default* (Sunday). Pin it to `{ weekStartsOn: 0 }` so a future date-fns/default change can't silently break it.
- **Retire the misnomer:** replace `mondayOf(...)` call sites (`LiveOpsTab`) with `sundayOf(...)`; once no callers remain, delete the alias.
- **Re-verify `ProductionDashboard`:** once `getWeekStart` returns Sunday, line 420's `getFiscalInfo(weekStart)` continues to work (Step 1 normalization), and lines 372/930/1006 (DB Sunday strings) now resolve. Confirm no Monday assumption remains.

### Step 2 — Enforce (separate later commit): drop normalization
Once every caller passes Sunday, **remove the input normalization** from `getFiscalInfo` so the map is strict Sunday-only (keep direct lookup; reject/`null` on non-Sunday). This prevents feature creep where future callers quietly write either anchor and "nothing fails" — defeating the point of having a canonical anchor. The re-keyed Sunday map remains.

---

## §6 — Verification & open items

**How to verify the fix (implementation pass):**
- **Calendar completeness:** assert `getFiscalLabel(sundayKey) !== null` for all 52 Sunday keys, and (Step 1 only) that a Monday input still resolves; after Step 2, that a Monday input returns `null`.
- **Query liveness:** in a `netlify dev` session, confirm the Performance recap (`DashboardPage`/`WeekPaceStrip`) and `ProductionDashboard` return non-empty `production` rows for the current week after the Class-1 caller fixes.
- **Label rendering:** confirm the fiscal label renders (non-empty) on the Performance header, Executive page, KPI scorecard, Heartbeat, and Monthly Briefs.

**Open items to resolve during implementation (not blockers to this plan):**
- **`historical_summaries` write/read keying (suspected mismatch).** The backfill loop (`historicalSummaries.js:255`) computes Monday and may persist `period_start` as Monday, while `contextBuilder` reads `period_start` with Sunday dates — a likely write(Mon)/read(Sun) mismatch that would make summary fetches return nothing. **Verify** the persisted `period_start` anchor and fix the writer alongside the Class-1 change. (Flagged, not yet confirmed.)
- **`lock-wip.js` (Monday) is dead** — not deployed (F-013) and its `wip_snapshots` target doesn't exist (F-003). Do **not** spend effort here; it's removed in the F-013 cleanup.
- **`FinancialTab` `derivePeriod`** uses the orthogonal `YYYY-MM-W#` period key, not `week_start` (F-006). Out of scope for this anchor fix.
- **`ProductionTab`** is orphaned (F-002) and excluded from the caller cleanup; it dies in the dead-code pass.

---

*Phase 3 deliverable. Pairs with `DATA_MODEL.md §4` (data-layer week facts) and `FINDINGS_LOG.md` (F-001 resolved-here, F-009 confirmed). The code migration is a separate post-audit implementation session (audit Decision 1).*
