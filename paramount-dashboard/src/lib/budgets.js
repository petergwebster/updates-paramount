/**
 * budgets.js — canonical weekly Plan/Budget figures for Paramount Prints.
 *
 * Source of truth for production targets across the entire dashboard.
 * Replaces the duplicated PASSAIC_TARGETS / BNY_TARGETS / WEEKLY_TARGETS
 * constants that used to live in PassaicScheduler.jsx, BNYScheduler.jsx,
 * and ProductionDashboard.jsx (which had drifted apart — different files
 * had different numbers for the same business question).
 *
 * Numbers are the canonical "Plan" figures from the FY2026 budget. They
 * match what FSCO leadership sees in the monthly Recap deck and what gets
 * pulled from the finance system (Adaptive). Annual flat-line — every week
 * has the same weekly target. Monthly variation comes ONLY from the 4/4/5
 * fiscal calendar (some months have 5 weeks, others 4).
 *
 * To change a budget figure: edit this file, push, deploy. There is no
 * database row for these. They version with code.
 *
 * Pattern: every consumer should call the helper functions, never reach
 * into the raw objects. The objects are exported for cases that need full
 * structural access (e.g., ProductionDashboard's category-by-category
 * input fields), but in normal use prefer the helpers.
 */

// ─── Passaic / Hand-Screen Printing (610) ──────────────────────────────────
// Per-category weekly targets. yards = total yardage. colorYards = labor unit
// (yards × color count). invoiceYds = expected weekly invoiced yards (lower
// than produced because of HTI). invoiceRev = expected weekly revenue from
// that category.
const PASSAIC_BUDGET = {
  // Per-category weekly targets — used by Scheduler card headers, Heartbeat
  // per-category panel, and ProductionDashboard's category breakdown.
  categories: {
    grass:  { yards: 3615, colorYards: 7570,  invoiceYds: 3538, invoiceRev: 36646 },
    fabric: { yards: 810,  colorYards: 4522,  invoiceYds: 772,  invoiceRev: 14112.75 },
    paper:  { yards: 4185, colorYards: 13405, invoiceYds: 3516, invoiceRev: 26330.25 },
  },
  // Roll-up totals (must equal sum of categories — guarded by tests below).
  weekly: {
    yards:        8610,    // = 3615 + 810 + 4185
    colorYards:   25497,   // = 7570 + 4522 + 13405
    invoiceYds:   7826,
    invoiceRev:   128951.25,
  },
  // Schumacher vs 3rd Party split. Useful for the Recap detail table.
  schumacher: { yards: 5886, revenue: 106645 },
  thirdParty: { yards: 2564, revenue:  31277 },
  // Operational thresholds (not budgets but live alongside).
  wasteCeilingPct: 10,  // waste over 10% triggers warning
}

// ─── BNY / Digital Printing (609) ──────────────────────────────────────────
// BNY is digital — no color-yards complexity, single-pass printing. Targets
// are by bucket (Replen / MTO / HOS / Memo / Contract / 3P) and by machine.
//
// "MTO" here is the legacy single-bucket figure (1,280/wk). Wendy in 4/2026
// split this into Custom (Schumacher Custom Team, BNY-physical machines) +
// MTO (regular MTO, Passaic-physical 570s). Holding the legacy total for
// now until the per-lane numbers are confirmed.
const BNY_BUDGET = {
  weekly: {
    yards:    12000,
    revenue:  132899.58,
  },
  buckets: {
    'Replen':   { yards: 7886, revenue: 90675.83 },
    'NEW GOODS': { yards: null, revenue: null },  // variable demand, no budget
    'Custom':    { yards: 430,  revenue: null },  // ~34% of legacy MTO 1,280
    'MTO':       { yards: 850,  revenue: null },  // ~66% of legacy MTO 1,280
    // Combined Custom+MTO totals: yards 1,280 / revenue 14,398.50
    'HOS':       { yards: 1532, revenue: 10727.25 },
    'Memo':      { yards: 211,  revenue: 4010.50 },
    '3P':        { yards: 1091, revenue: 13087.50 },
  },
  // Per-machine daily targets. Used by Scheduler capacity bars.
  // Note 12 of these machines physically sit at Passaic (BNY-budget,
  // Chandler-scheduled). See HeartbeatPage BNY_MACHINES.location field.
  machines: {
    // 3 HP 3600s (Brooklyn) — 3,600 yd/day each = 18,000/day fleet
    glow: 3600, sasha: 3600, trish: 3600,
    // 4 HP 570s (Brooklyn) — 500 yd/day each
    bianca: 500, lash: 500, chyna: 500, rhonda: 500,
    // 12 small digitals (Passaic) — 500 yd/day each
    dakota_ka: 500, dementia: 500, ember: 500, ivy_nile: 500,
    jacy_jayne: 500, ruby: 500, valhalla: 500, xia: 500,
    apollo: 500, nemesis: 500, poseidon: 500, zoey: 500,
  },
}

// ─── Procurement (612 — pass-through revenue, no production budget) ────────
const PROCUREMENT_BUDGET = {
  weekly: { revenue: 12500 },
  monthly: {
    fourWeek: 50000,   // 50k in 4-week fiscal months
    fiveWeek: 62500,   // 62.5k in 5-week fiscal months
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// Public helper API. Prefer these over reaching into the raw objects.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Weekly yards budget for a site, optionally a specific category.
 * Returns null when there's no budget defined (e.g., NEW GOODS bucket).
 *
 * @param {'passaic'|'bny'} site
 * @param {string} [category] — for passaic: 'grass'|'fabric'|'paper'.
 *                              for bny: bucket name like 'Replen'.
 *                              omit for site total.
 */
export function weeklyBudgetYards(site, category) {
  if (site === 'passaic') {
    if (!category) return PASSAIC_BUDGET.weekly.yards
    return PASSAIC_BUDGET.categories[category]?.yards ?? null
  }
  if (site === 'bny') {
    if (!category) return BNY_BUDGET.weekly.yards
    return BNY_BUDGET.buckets[category]?.yards ?? null
  }
  return null
}

/**
 * Weekly color-yards budget. Passaic only (BNY is digital, single-pass —
 * color-yards is meaningless there).
 */
export function weeklyBudgetColorYards(category) {
  if (!category) return PASSAIC_BUDGET.weekly.colorYards
  return PASSAIC_BUDGET.categories[category]?.colorYards ?? null
}

/**
 * Weekly revenue budget. Site-level or per-category/bucket.
 */
export function weeklyBudgetRevenue(site, categoryOrBucket) {
  if (site === 'passaic') {
    if (!categoryOrBucket) return PASSAIC_BUDGET.weekly.invoiceRev
    return PASSAIC_BUDGET.categories[categoryOrBucket]?.invoiceRev ?? null
  }
  if (site === 'bny') {
    if (!categoryOrBucket) return BNY_BUDGET.weekly.revenue
    return BNY_BUDGET.buckets[categoryOrBucket]?.revenue ?? null
  }
  if (site === 'procurement') {
    return PROCUREMENT_BUDGET.weekly.revenue
  }
  return null
}

/**
 * Monthly budget for a fiscal month under the 4/4/5 calendar.
 * Multiplies the weekly budget by the number of weeks in the fiscal month.
 *
 * Standard 4/4/5: months 1,2,4,5,7,8,10,11 = 4 weeks; months 3,6,9,12 = 5.
 * Pass weeksInMonth explicitly to avoid encoding the calendar here — let the
 * caller derive it from src/fiscalCalendar.js (which knows the actual map).
 *
 * @param {'passaic'|'bny'|'procurement'} site
 * @param {number} weeksInMonth — typically 4 or 5
 * @param {'yards'|'colorYards'|'revenue'} metric
 * @param {string} [categoryOrBucket]
 */
export function monthlyBudget(site, weeksInMonth, metric, categoryOrBucket) {
  let perWeek = null
  if (metric === 'yards')      perWeek = weeklyBudgetYards(site, categoryOrBucket)
  if (metric === 'colorYards') perWeek = weeklyBudgetColorYards(categoryOrBucket)
  if (metric === 'revenue')    perWeek = weeklyBudgetRevenue(site, categoryOrBucket)
  if (perWeek == null) return null
  return perWeek * weeksInMonth
}

/**
 * Per-machine daily target for a BNY machine.
 * Lookup is case/whitespace-tolerant so 'Glow' and 'glow' and 'GLOW' all
 * resolve to the same value — same normalizer as HeartbeatPage's BNY card
 * matching, post-Phase A migration.
 */
export function bnyMachineDailyTarget(machineName) {
  const norm = (s) => (s || '').toLowerCase().replace(/[\s_-]/g, '')
  const key = norm(machineName)
  for (const [k, v] of Object.entries(BNY_BUDGET.machines)) {
    if (norm(k) === key) return v
  }
  return null
}

/**
 * Per-machine WEEKLY target — daily × 7 by convention. Useful for the
 * Scheduler's "0% of 4,200" weekly-cap progress bars.
 */
export function bnyMachineWeeklyTarget(machineName) {
  const daily = bnyMachineDailyTarget(machineName)
  return daily == null ? null : daily * 7
}

/**
 * Schumacher vs 3rd Party weekly split. Used by Recap detail table.
 */
export function passaicCustomerSplit() {
  return {
    schumacher: PASSAIC_BUDGET.schumacher,
    thirdParty: PASSAIC_BUDGET.thirdParty,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Raw exports for callers that need structural access (e.g., the
// ProductionDashboard category input form iterates categories.* keys).
// New code should prefer the helpers above.
// ═══════════════════════════════════════════════════════════════════════════
export {
  PASSAIC_BUDGET,
  BNY_BUDGET,
  PROCUREMENT_BUDGET,
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal consistency checks. These run once at module load. Throw early
// rather than letting bad numbers reach the dashboard.
// ═══════════════════════════════════════════════════════════════════════════
;(function assertBudgetIntegrity() {
  const cats = PASSAIC_BUDGET.categories
  const sumYards = cats.grass.yards + cats.fabric.yards + cats.paper.yards
  const sumCY    = cats.grass.colorYards + cats.fabric.colorYards + cats.paper.colorYards
  if (sumYards !== PASSAIC_BUDGET.weekly.yards) {
    console.warn(`[budgets.js] Passaic category yards (${sumYards}) ≠ weekly total (${PASSAIC_BUDGET.weekly.yards})`)
  }
  if (sumCY !== PASSAIC_BUDGET.weekly.colorYards) {
    console.warn(`[budgets.js] Passaic category CY (${sumCY}) ≠ weekly total (${PASSAIC_BUDGET.weekly.colorYards})`)
  }
})()
