# Consolidation & Cleanup Plan

> Phase 4 deliverable of the architecture audit. **`ARCHITECTURE.md` §5 links here.** Covers the shared-utility gap analysis (F-004, F-006, F-007, F-008), the dead-code deletion plan (F-002, F-011, F-017, F-022, F-023, F-025), and the target consolidation to `budgets.js` (F-005).
> Built from a line-cited verification fan-out, with the three findings that contradicted prior docs **re-verified by direct read** before being written here (see §0).
> Status: **DRAFT — awaiting sign-off.** Scope is **analysis + plan only**; the code/migration changes are a separate post-audit implementation pass (audit Decision 1).

---

## §0 — How to use this document

**Audience.** Future Claude Code sessions and any engineer doing the cleanup/extraction implementation pass. Pair it with `MODULE_MAP.md` (what each component does), `DATA_MODEL.md` (the data layer), and `FINDINGS_LOG.md` (the finding IDs referenced throughout).

**It answers:** what should be shared but isn't (and where the extraction should live), what is dead and safe to delete (and in what order), and how to consolidate production targets onto `budgets.js`.

**Provenance — why three findings were re-verified before landing here.** The Phase 3 lesson holds: **verification sub-agents make systematic errors**, so any agent conclusion that *contradicts a committed doc or an existing finding* was checked by direct read before being written. This pass caught three:
- **F-004** — an agent's full breakdown was correct that the duplicated constants live **only** in `WIPTab` (not the 3-file duplication the finding claimed) → grep-confirmed, finding corrected.
- **F-005** — an agent concluded "`budgets.js` already holds canonical values"; **direct read proved the opposite** — `budgets.js` itself diverges from the settled deck (wrong totals + a HOS/Memo swap). Had this gone in unverified, the consolidation would have deleted the (less-wrong) local copies and enshrined the wrong `budgets.js`.
- **F-025** — an agent flagged `Correspondence.jsx` as orphaned, contradicting `DATA_MODEL.md`'s "Live" claim; **grep-confirmed orphaned** → finding reframed and `DATA_MODEL §2` corrected in the same commit.

This mirrors the provenance caveats in `DATA_MODEL.md §0` (export lossiness) and `WEEK_ANCHORING.md §3` (the agent reconciliation note). Treat "an agent said X" as a lead, not a fact, whenever X overturns an existing record.

---

## §1 — Shared-utility gap analysis

What should live in one place but doesn't. Each finding lists the verified current sites, the divergence (if any), the **concrete extraction home**, and a contract sketch. Homes follow the existing flat `src/lib/*.js` noun-named convention (`budgets.js`, `dailyOps.js`, `scheduleUtils.js`, `newGoods.js`).

### F-004 — pool-status sets · duplication → **single-source today** · Med *(downgraded from High)*
**Corrected.** `SCHEDULABLE_STATUSES` and `NG_PREPROD` are defined **only** in `WIPTab.jsx:60` and `:70` (used at `:83–84`). They are **not** duplicated in `PassaicScheduler`/`BNYScheduler` (grep-confirmed absent); the schedulers build their pools inline (`PassaicScheduler.jsx:178`, `BNYScheduler.jsx:216`). So the original "hardcoded in 3 files, a change needs 3 edits" framing is **wrong** — there is one definition.
- **Residual concern (the real, smaller issue):** the schedulers re-encode schedulability *inline* rather than importing WIPTab's sets, so the knowledge isn't shared and a future scheduler could drift.
- **Extraction home:** `scheduleUtils.js` (the existing canonical cross-site constants module). Move `SCHEDULABLE_STATUSES` + `NG_PREPROD` there; have `WIPTab` import them, and have the schedulers' inline pool logic reference them. **Preventive, not corrective** — a pure move plus a light refactor of the inline filters. *(Verify at implementation time whether the inline scheduler filters truly re-encode the same status knowledge.)*

### F-006 — `derivePeriod` read/write contract · duplication/risk · Med
**Verified IDENTICAL today.** `FinancialTab.jsx:18–23` (read) and `AdminFinancials.jsx:17–22` (write) both compute `` `${yr}-${mo}-W${Math.min(Math.ceil(d.getDate()/7),5)}` `` — same formula, W5-capped. No current data loss; the risk is **future divergence** (if one side is edited, financial rows silently mismatch on `period`).
- **Extraction home:** **`src/lib/period.js`**, exporting `derivePeriod(date)` (and any period parse/format helpers). Both `FinancialTab` and `AdminFinancials` import it.
- **Contract:** `derivePeriod(date: Date|string) → 'YYYY-MM-W{1..5}'`. Add a **round-trip test** (write-side key === read-side key for a sweep of dates) so the two can never drift again — this is what closes the F-006 *risk*, not just the duplication.

### F-007 — age-bucket logic + key naming · duplication · Med
**Verified DIVERGED.** The parser already writes the canonical bucket: `liftParser.js:144–150` (`ageBucketOf`) emits `age_bucket ∈ {'0-30','31-60','61-90','90+','no-date'}` (written at `:357`).
- `NewGoodsView.jsx:126/129` **reads `age_bucket` directly** (correct — uses the parser scheme).
- `WIPTab.jsx:234–249` **recomputes from `age_days`** with a *different* key scheme (`current`/`30`/`60`/`90`/`90plus`). Same rows → two different bucketings.
- **Standardize on the parser scheme.** **Extraction home:** **`src/lib/aging.js`**, exporting `AGE_BUCKETS` (ordered keys), `AGE_BUCKET_LABELS` (display), and `ageBucketOf(days)` (moved out of `liftParser`). The parser, `WIPTab`, and `NewGoodsView` all import it; `WIPTab` stops recomputing and reads `age_bucket`.

### F-008 — productionRollup reimplemented · duplication · High *(the recap's named example)*
**Verified — bespoke aggregation in 6 places.** Sites (line-cited):

| Site | Function(s) | Groups by | Outputs |
|---|---|---|---|
| `HeartbeatPage.jsx` | `aggregateBySite` (1289–1323) | site [+shift+cell] | planned/actual yards + color-yards |
| `HeartbeatPage.jsx` | `buildCategoryData` (1342–1455), `build17TableState` (1458–1495), `buildBnyMachines` (1577–1606), `buildBnyBucketYards` (1781–1800), `buildOperatorScorecards` (1623–1750+), `classifyBnyBucket` (1762–1775) | category / table / machine / bucket / (location,shift,operator) | per-dimension planned/actual, util %, status, interpolated CY |
| `ProductionDashboard.jsx` | category builders (97–336) + MTD inline reduces (289–499) | week + category | yards/CY/waste; MTD per-category |
| `PassaicScheduler.jsx` | `mixTotals` (178–210) | site+category+customer_type | yards/CY/revenue, grass·fabric·wallpaper, Schumacher/3P split |
| `BNYScheduler.jsx` | `mixTotals` (216–240) | site+bucket+machine_location | yards, brooklyn/passaic split, per-bucket yards/rev/orders |
| `WIPTab.jsx` | `buildDivisionPivots` (125–176) | division+status+customer_type | PO counts, yards, invoiced |
| `ProductionTab.jsx` | — | — | none (dead — F-002) |

- **Extraction home:** **`src/lib/productionRollup.js`**, exposing a core aggregator plus the shared classifiers:
  - `aggregateProduction(assignments, actuals=null, { groupBy, sumMetrics }) → keyed aggregate` (e.g. `{ 'passaic|1st|grass': { yards, cy, revenue, actualYards, … } }`)
  - `classifyCategory(productType)` (Passaic → grass|fabric|wallpaper), `classifyBnyBucket(wipRow)`, `interpolateColorYards(cellRatios, yards)`.
- **Tiered adoption (be realistic — not all 6 collapse to one call):**
  - **Clean adopters:** `HeartbeatPage.aggregateBySite`, `PassaicScheduler.mixTotals`, `BNYScheduler.mixTotals` → migrate to `aggregateProduction(...)`.
  - **Partial (extract the classifiers + cell-ratio helper, keep final grouping local):** `HeartbeatPage.buildCategoryData` / `build17TableState` / `buildOperatorScorecards`.
  - **Leave local (incompatible semantics):** `WIPTab.buildDivisionPivots` (order-status flow, not production metrics) and `ProductionDashboard` MTD (week-level snapshot history). `ProductionTab` dies (F-002).
- **Highest-value extraction in the audit** — once `aggregateProduction` exists, pool/scheduled/produced numbers can finally cross-check instead of being computed three different ways.

---

## §2 — Dead-code deletion plan

Six dead items, in **three layers**, with the within-layer dependency called out. Each item lists the **safety check** (the grep/read that proves it dead) and the **action**.

### Layer 1 — front-end deletions
**Hard dependency: remove the `App.jsx` import line *before* deleting the file, or the build breaks mid-delete.**

| Item | Finding | Safety check (verified) | Action |
|---|---|---|---|
| `ProductionTab.jsx` | F-002 | `App.jsx:16` imports 4 names (`FacilityDetail`, `OperatorScorecard`, `useProductionData`, `generateLiveOpsPDF`); **zero external uses** in `src/` (`generateLiveOpsPDF` appears only in a *comment* at `monthlyBriefPdf.js:85`) | 1) remove `App.jsx:16` import → 2) delete `ProductionTab.jsx` (+ its module.css) → 3) retire `VITE_GOOGLE_SHEETS_API_KEY` (its only reader) |
| `Correspondence.jsx` | F-025 | `App.jsx:7` imports it; **no `<Correspondence` mount anywhere** in `src/` (grep-confirmed) — a third orphan | 1) remove `App.jsx:7` import → 2) delete `Correspondence.jsx` + `Correspondence.module.css` (consider whether the `correspondence` table/bucket should also be retired — see §2 note) |
| `PlantRollup.jsx` | F-011 | **zero importers** (only a comment at `HeartbeatPage.jsx:731`); no `App.jsx` import to remove | delete `PlantRollup.jsx` directly (no import-removal step needed — confirm the importer grep once more at implementation time) |

> **Correspondence cascade:** because `Correspondence.jsx` is the *only* consumer of the `correspondence` table + Storage bucket, deleting it makes both effectively dead. Decide at implementation time whether to also drop the table/bucket (a Layer-3 migration) or keep them for a future re-mount. This plan deletes the *code* and flags the data as orphaned.

### Layer 2 — netlify-function deletions
| Item | Finding | Safety check (verified) | Action |
|---|---|---|---|
| `generate-pdf.mjs` | F-017 | **no `src/` caller** of `/api/generate-pdf`; only `netlify.toml:15–16` (mis-declared as edge) + self-reference | delete the function + its `[[edge_functions]]` route block |

**Bundle with the Phase-2-scoped netlify cleanup (referenced for ordering coherence, *not re-opened here*):** `generate-pdf.mjs` lives in the same mis-cased `netlify/Functions/` dir as `lock-wip.js` (F-003, dead) and `claude.mjs` (F-012, dead/unreachable). The F-013 dir-casing fix (`Functions/`→`functions/`) and the removal of the bogus `lock-wip`/`generate-pdf` `[[edge_functions]]` entries should all land in **one** netlify-config commit so the three dead Node functions and the casing fix don't fight each other.

### Layer 3 — DB migrations *(different shapes — keep them as separate statements)*
| Item | Finding | Safety check (verified) | Migration |
|---|---|---|---|
| `sched_current_wip` view | F-022 | **no reader** in `src/` (defined `db/schema.sql:726`); scheduler components read `sched_snapshots` directly | `DROP VIEW IF EXISTS sched_current_wip;` |
| `comments` table | F-023 | **no `from('comments')` caller** anywhere (live system is `section_comments`) | `DROP TABLE IF EXISTS comments;` |

**Ordering & safety for Layer 3:** these are independent of the code deletions and of each other; run after confirming no *external* SQL/BI consumer outside the repo. A `DROP VIEW` is trivially reversible (re-create from `db/schema.sql`); a `DROP TABLE` is not — snapshot the (empty/legacy) `comments` rows first if there's any doubt.

### Cross-layer order
1. **Layer 1** (front-end) — import-removal-then-delete; unblocks nothing else but clears the orphans.
2. **Layer 2** (netlify) — independent; bundle with F-013.
3. **Layer 3** (DB) — independent; last, after external-consumer check. (If the Correspondence cascade is taken, the `correspondence` table/bucket drop joins Layer 3.)

---

## §3 — Target consolidation to `budgets.js` (F-005)

**Critical ordering: rewrite `budgets.js` to the deck values FIRST, *then* delete the local copies.** The three local copies (`AdminPanel.jsx:33–46`, `DashboardPage.jsx:42–58`, `WeekPaceStrip.jsx:27–38`) currently **match `budgets.js`** — but `budgets.js` itself is a stale "prior set" that diverges from the settled **March 2026 deck** (the authoritative source per F-005). Deleting the copies first would simply route every consumer to the *wrong* numbers via `budgets.js`.

### Verified deltas — `budgets.js` (now) → deck (target)
| Field | `budgets.js` now | Deck (target) | Note |
|---|---|---|---|
| Passaic weekly yards | **8,610** | **8,500** | `budgets.js:40` |
| Passaic weekly color-yards | **25,497** | **25,500** | `budgets.js:41` (25,497 is one of the conflicting values F-005 flagged) |
| Passaic category — grass | 3,615 yd / 7,570 CY | **3,785 yd / 11,355 CY** | splits diverge materially, not just totals |
| Passaic category — fabric | 810 yd / 4,522 CY | **834 yd / 2,502 CY** | |
| Passaic category — paper/wallpaper | `paper` 4,185 yd / 13,405 CY | **`wallpaper` 3,881 yd / 11,643 CY** | **also a key rename** `paper`→`wallpaper` |
| BNY weekly yards | **12,000** (formal) | **12,500** (operational) | the +500 uplift |
| BNY bucket — HOS | **1,532** | **210** | **swapped** ⚠ |
| BNY bucket — Memo | **211** | **1,535** | **swapped** ⚠ — `budgets.js` has the larger number on the wrong bucket |
| BNY bucket — Replen / 3P | 7,886 / 1,091 | 7,885 / 1,090 | off-by-one; deck authoritative |

### Plan
1. **Rewrite `budgets.js`** to the deck values above: fix the Passaic totals + per-category splits, rename the `paper` key to `wallpaper`, fix the **HOS/Memo swap**, and set the BNY weekly total to **12,500**.
2. **Update the load-time `assertBudgetIntegrity` self-check** (`budgets.js:222–232`) to the new sums (8,500 = 3,785+834+3,881 ✓; 25,500 = 11,355+2,502+11,643 ✓) so the guard matches the deck.
3. **Fix the stale `budgets.js` header comment** (`:5–8`) — it names `PassaicScheduler`/`BNYScheduler`/`ProductionDashboard` as where the copies "used to live," but the live copies are actually in `AdminPanel`/`DashboardPage`/`WeekPaceStrip`.
4. **Delete the three local copies** and import the `budgets.js` helpers instead.

### Open / non-blocking
- **BNY +500 per-bucket allocation = TBD (pending per-team input).** The 12,000→12,500 operational uplift has **no confirmed per-bucket home** (candidate: Replen→8,385, *unconfirmed*). **Phase 4 ✓ except the per-bucket allocation** — set the BNY weekly *total* to 12,500 now; leave the per-bucket vector provisional with a `// TODO(+500 allocation)` marker. Do not block the rest of the consolidation on it.
- **Revenue / invoice fields** (`invoiceYds`, `invoiceRev`, the Schumacher/3P split) are **not** in the F-005 deck excerpt; reconcile those separately rather than inventing values.

---

## §4 — F-025 MODULE_MAP backfill

The `Correspondence.jsx` entry has been added to `MODULE_MAP.md §2` (Performance), flagged **ORPHANED** in the same style as `ProductionTab` (F-002) and `PlantRollup` (F-011). `DATA_MODEL.md §2`'s `correspondence` line — which incorrectly described the component as **Live** — is corrected to **orphaned** in the same commit (audit Decision (i): a one-line doc-consistency fix, same shape as the MODULE_MAP backfill). The finding itself is reframed from a *documentation gap* to a *dead-code orphan* in `FINDINGS_LOG.md`.

---

## §5 — Sequencing & risk

**Extraction order (§1):** independent of each other, but do **F-008 (`productionRollup.js`) first** — it's the largest surface and the one that unlocks cross-checking; the others (`scheduleUtils` move, `period.js`, `aging.js`) are small and can follow in any order. F-006's value is the **round-trip test**, not the move — don't skip it.

**Deletion vs extraction interaction:** `ProductionTab` (F-002) appears in both the F-008 site list and the §2 deletion list — it has no rollup logic worth salvaging, so it is purely a deletion; do not try to migrate it into `productionRollup.js`.

**Verify-at-implementation:**
- F-004: confirm the schedulers' inline pool filters actually re-encode schedulability before refactoring them onto the shared sets.
- F-006: the round-trip test is the deliverable, not just the file move.
- F-005: the BNY per-bucket +500 vector must be confirmed per-team before the bucket numbers (not the total) are trusted.
- §2 Layer 3: external-SQL-consumer check before `DROP TABLE comments`; decide the Correspondence table/bucket cascade.

---

*Phase 4 deliverable. Pairs with `MODULE_MAP.md` (components, incl. the new Correspondence entry), `DATA_MODEL.md` (data layer), and `FINDINGS_LOG.md` (F-004 downgraded, F-005 reframed-ordering, F-025 reframed to dead-code). Code/migration changes deferred to a post-audit implementation pass (audit Decision 1).*
