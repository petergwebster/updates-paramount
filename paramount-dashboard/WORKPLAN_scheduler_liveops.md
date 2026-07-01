# Operations Dashboard — Scheduler + Live Ops Work Plan (7/5 go-live)

> Owner: Peter Webster. Created 2026-06-29. Status: REQUIREMENTS + TRIAGE (not yet code-verified).
> Sources: Chandler O'Connor email chain (Scheduler issues) + Wendy Reger PowerPoint
> (`Paramount_Netlify_2.pptx`: Live Ops / New Goods / navigation).
>
> Context: this dashboard becomes the **source of truth for PP on all things scheduled and
> completed.** Fixes land THIS week → team review next week → **live for Peter / Emily / Timur /
> Antonella on 2026-07-05.** Hard rule communicated to team: full upcoming-week production schedule
> due + fully populated by **Saturday midnight** the prior week. New hire **Ramon Hernandez** (head
> of Production Planning, starts Mon) will own the schedule both sites; **year-end endgame = schedule
> fully automated + reported through LIFT step APIs.** => the current scheduler is a BRIDGE-PERIOD
> tool: make it reliable + usable, but don't over-invest in internals LIFT will eventually absorb.

## FIRST STEP NEXT SESSION — ground in the code before fixing
Read, in this order, then confirm/kill the root-cause hypothesis below:
1. `CLAUDE.md` + `RECAP.md` (project canon + current state; respect conventions / changelog).
2. `src/liftParser.js` and `src/components/SchedulerTab.jsx` (+ `BNYScheduler.jsx`, `PassaicScheduler.jsx`)
   — the Unscheduled Pool population/filter logic.
3. `src/components/LiveOpsTab.jsx` and `supabase-schema.sql` (Live Ops data model).
No code changes off this plan until the above is read — fixes go against reality, not the screenshot.

---

## ROOT-CAUSE HYPOTHESIS (the big lever)
Most of Chandler's scheduler issues are probably NOT separate bugs — they cluster around **how the
Unscheduled Pool is built**. Strong hypothesis (VERIFY in `liftParser.js` / `SchedulerTab.jsx`):
- (a) the pool filters LIFT orders on **status too aggressively** (drops already-printed / retroactive,
  and possibly whole categories), and
- (b) it's keyed at the **PO level instead of the PO-line / SKU level** (so scheduling one SKU marks
  the whole PO scheduled → siblings vanish; multi-SKU POs collapse).
If correct, fixing pool granularity + the status filter resolves FIVE issues at once (missing orders,
retroactive, multi-SKU, and contributes to strike-offs + overschedule). Same single-root-cause shape
as the 2026-06-23 Sunday/Monday fix. **Confirm before building.**

---

## TRIAGE BY AREA  (★ = must-have for 7/5 go-live; ▷ = can land in the review week)

### Scheduler  (Chandler) — likely `SchedulerTab.jsx` / `BNYScheduler.jsx` / `PassaicScheduler.jsx` / `liftParser.js`
- ★ **Unscheduled Pool: orders missing across categories** (the "biggest issue"). Root-cause cluster above.
- ★ **Retroactive scheduling** — orders already through the LIFT print step don't appear in the pool. (status filter)
- ★ **Multi-SKU PO** — scheduling one SKU hides the PO's other SKUs. (PO-level vs SKU-level granularity)
- ★ **Cannot overschedule** — needed for ALL MTOs, customs, Hosp orders. (capacity/validation guard)
- ★ **27" strike-offs not schedulable** — consumption <1 yard is being filtered out. (min-qty guard)
- ★ **"Dementia" mislabeled as a Passaic printer** — blocks scheduling Sara on Dementia. (printer→site config)
- ★ **"Dakota Kai" misspelled.** (data fix)
- ★ **Small-printer daily cap should be 200 yds** (typical max/day on small printers). (capacity config)
- ▷ **Search by LIFT order # or SKU.** (feature)
- ▷ **Schedule panels in EA (not just yards)** — Chandler flagged "maybe not necessary — DISCUSS w/ Peter."

### Live Ops  (Wendy) — likely `LiveOpsTab.jsx` (+ `supabase-schema.sql`, `ClaudeReadBlock.jsx`)
- ★ **Add production by PO per day** + **multiple rows per table** when several SKUs run on one table that day.
  (backbone — the other Live Ops items depend on per-PO/SKU rows existing)
- ▷ **Color-yards don't calculate** — Live Ops pulls product NAME but doesn't tie **SKU → yards**, and has
  **no color-count reference** per SKU. Needs a data-model addition (per-SKU color count) before the math
  works. Color-yards = yards × #colors. (schema + calc)
- ★ **Employee/printer dropdowns** missing new printers — sourcing issue. (also affects scheduler)
- ▷ **Notes → "a recap Claude can wrap" + daily consolidated export** from Sami's entries (produced-by-PO
  + commentary). INTEGRATION SEAM with the Triad/Claude layer — durable, worth doing well; see below.

### New Goods  (Wendy) — likely `NewGoodsTab.jsx` / `NewGoodsView.jsx`
- ▷ **Add a start date** per launch (track time-invested by SKU). (small; schema + UI)

### Navigation  (Wendy) — likely `SchedulerTab.jsx` default-week state
- ★ **Scheduler should open on the CURRENT week/day**, not jump to next week. Small fix, high daily annoyance,
  hits everyone — cheap win, do early.

---

## NOTES BEYOND THE LIST
- **Integration seam (durable):** the Live Ops "notes Claude can wrap → daily consolidated production report
  from Sami's actuals" is where this FSCO app touches the Triad/Claude layer. Unlike the scheduler internals
  (LIFT-bound long-term), this is worth building well. `ClaudeReadBlock.jsx` likely already a foothold.
- **Bridge-period caution:** don't over-engineer deep scheduler internals; LIFT step-APIs are the year-end
  destination (Ramon owns). Reliable + usable now > elegant + deep.
- **Cross-system consistency (watch):** fiscal-calendar logic lives in BOTH this app and Triad; the
  Sunday/Monday date-key rule is a known cross-system trap. If the two ever bucket a week differently, the
  exec team sees one number here and Triad computes another — guard against that as integration proceeds.

## OPEN QUESTIONS FOR PETER
1. Of the ★ items, which are the true blockers for 7/5 vs. "nice by 7/5"? (drives fix order)
2. EA-panel scheduling — keep or drop? (Chandler unsure)
3. Color-yards: is there an existing per-SKU color-count source (a LIFT field? a reference table?), or do we
   need to build/seed that reference?

---

## 2026-06-30 — BUILD LOG + LIFT AUTO-FEED (shipped, live)

Root-cause hypothesis above was HALF right. Multi-SKU WAS PO-vs-line granularity (fixed). But
"missing orders across categories" was NOT a pool-filter bug — it was the **manual Excel upload
silently under-counting** (kitted grounds inflating the count, and a scope filter dropping real
open orders). Fixed by feeding `sched_wip_rows` straight from LIFT, hourly.

### Shipped this session (all live on main / Netlify)
- Default week → current week (`scheduleUtils.defaultSchedulerWeek` = `sundayOf(today)`).
- Operator pool widened (`BNY_OPERATORS_ALL`); "Dakota Kai" spelling; Dementia = Passaic-located digital (correct).
- Pool status WHITELIST → terminal-status BLACKLIST (both schedulers). ⚠ OPEN ITEM #1 below.
- Multi-SKU line-keying: `sched_assignments` + `item_sku`,`color` (migration run); `schedLineKey` =
  `po|item_sku|color`; `assignedByLine` + `assignedByPOLegacy`; `wipByLine` enrichment. Manual assign
  path is line-keyed; AI "Ask" proposals stay PO-level (can't disambiguate SKU).
- Overschedule allowed (exceed WIP qty AND daily capacity; flagged, not blocked; actuals reconcile in Live Ops).
- Netlify functions-dir CASING FIX: `netlify.toml` `functions = "netlify/functions"` → `"netlify/Functions"`
  (committed folder is capital F; case-sensitive Linux build was bundling ZERO classic functions → 404s).
  ⚠ `lock-wip`'s Saturday cron was likely DEAD until this fix — verify `wip_snapshots` resumes updating.
  Also: Admin panel `/api/lock-wip` routes through a dead `[[edge_functions]]` entry (lock-wip is classic,
  not edge) — pre-existing, backlog.

### LIFT AUTO-FEED — `netlify/Functions/lift-wip-sync.js` (live, hourly)
Replaces the manual "Upload LIFT WIP." FSCO-owned, self-contained — **NO Triad comingling** (reads only
FSCO's LIFT API, writes only the updates-paramount Supabase).
- Source: LIFT ORDS reports (cloud/open, win1252 CSV). `orders` ⨝ `products` on `ITEM_SKU`. Base URL in
  Netlify env `LIFT_BASE_URL` (+ existing `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
- Writes `sched_snapshots` + `sched_wip_rows` in the SAME shape `WIPTab`'s manual upload writes
  (`source_filename = "LIFT API (auto feed)"`). Scheduler/WIP unchanged downstream.
- CSV parse: quoting OFF (mirrors `lift-bridge/lib/parse.js`) — LIFT writes bare inch-mark `"` in unquoted
  fields; RFC quote handling corrupts every affected row. CRITICAL, do not "fix" back to RFC.
- Derivations ported from `liftParser`: site from `order_type` (Digital→bny, Screen Print→passaic) + material
  prefix fallback; `bny_bucket`; `color_yards` = colors × yards (Passaic only); age.
- Reconciliation rules (verified against `Data_for_WIP.xlsx` “Production WIP” sheet):
  - EXCLUDE `product_type` Grounds / Ground / Packing Charge — kitted grounds are a separate LIFT line per
    print order (inflated Passaic ~2x); the manual export has ZERO ground rows. Matches DAX `[Type]="Yards"`.
  - ROUTE `product_type` SCHUMACHER PROC → `site=procurement` (`orders.order_type` doesn't carry Procurement;
    matches manual `Division=Procurement`, exact 224-row count).
  - Terminal statuses excluded (Shipped/Invoiced/Cancelled/Closed/Complete/Completed) = WIP scope.
- Reconciliation (2026-06-30, snapshot 38) vs manual upload (577 / 450 / 224): feed **618 / 464 / 224**.
  BNY + Procurement match; Passaic +41 = the `(none)` product-type residual (open item #3).
- Modes: scheduled (cron, hourly) writes; `POST {}` writes; `POST {"dryRun":true}` returns
  counts + diagnostics (by_site, distinct_pos, status/age/ptype histograms), NO write — use for reconciliation
  before trusting. Prunes to newest 12 snapshots.
- Cron: `netlify.toml` `[[scheduled_functions]]` `lift-wip-sync` `"0 * * * *"`. Manual upload = fallback (newest wins).

### OPEN ITEMS from the feed (priority order)
1. **Pool blacklist vs documented whitelist.** The blacklist change now surfaces past-printer statuses
   (Mixing / In Packing / Ready to Ship) that the WIP “source of truth” note says should NOT be in the pool.
   Reconcile: revert to documented whitelist, OR keep retroactive visibility (Chandler's ask) + update the
   note. UNRESOLVED — Peter's call.
2. **Site-classification disagreements** to verify with the floor: F0013106, F0014240 (feed Passaic / manual
   BNY); F0014106, F0015286 (manual unclassified). The one genuine routing bug — needs floor's “which plant.”
3. **`(none)` product-type residual** (~38–41 Passaic rows): SKUs not matched in the products master (likely a
   SKU-suffix format mismatch, e.g. orders `ENG5016020W-60` vs master base SKU). KEEP (don't drop real orders);
   improve join coverage. Also drives remaining color-yards gaps.
4. **Color-yards data coverage:** logic correct (colors × yards, Passaic); ~747 SKUs missing `NUMBER_OF_COLORS`
   in the product master → `color_yards` null → gauge reads ~68%. Fill the master. = Wendy's color-yards ask.
5. **Procurement line detail:** feed procurement = order-level only; `po_details` not folded in. Fold in if the
   WIP Procurement view needs line-level.
6. **New Goods:** `is_new_goods` is a WEAK proxy (NEW GOODS customer name). Real New Goods pre-prod lives in
   Monday.com, not LIFT — the feed correctly won't carry Monday-only pre-prod. Route via the Monday pipeline.
7. **Security:** LIFT ORDS endpoints are open (no auth). Paul/IT conversation someday. Non-blocking.

### Deliverable
`Paramount_WIP_LIFT_Feed_Verification.docx` (2026-06-30) — hand-off for Wendy/Chandler: the specific orders
to verify (which-plant, confirm-real, Tillett), the old Brooklyn records to close in LIFT, and the color-count
fill task.
