// ============================================================================
// monthlyBriefData.js — Aggregate everything needed for a Monthly Brief.
// ============================================================================
// REPOINTED TO CANONICAL FEEDS (9/2026) — the v1 of this file was the LAST
// surface on the dash reading the retired hand-keyed layer (`production`
// form JSON, `financials_monthly` from the retired Financial Data tab), and
// the August 2026 close proved the cost: the Sep-1 brief reported BNY
// invoiced 40,380 yds while the ledger said 56,827 — and the ledger matched
// the back office to 0.2%. The brief was measuring form completeness, not
// the month. Sources now:
//
//   Invoiced rev + yards → order_ledger by invoice_date within the FISCAL
//     month (Sunday 4-4-5). site='procurement' is isolated as a PASS-THROUGH
//     memo (no margin) — the back-office scorecard basis EXCLUDES it (Naomy
//     9/3: Aug Schumacher $591,575 + procurement $79,835 = $671,410), and
//     the PARA plan carries its own $50K procurement revenue line.
//   GP CROSS-CHECK → financial_transactions (sales AR invoiced by unit);
//     when ledger and GP disagree beyond threshold the brief FLAGS it
//     loudly instead of printing silently wrong numbers (the 9/1 LIFT
//     platform upgrade corrupted ledger invoicing for two days — failures
//     must announce themselves).
//   Produced → sched_daily_ops actuals per fiscal week. (Phase 4 switches
//     to LIFT QTY_PRINTED × Yield once Sami's reverse-flow entry is
//     verified live.)
//   Waste → sched_daily_ops if the column exists (guarded — a PostgREST
//     unknown column rejects the whole select). Color-yards deliberately
//     null: August's manual figure ran ≈2× the dash derivation; until the
//     method is reconciled we print nothing rather than something wrong.
//   OpEx + purchases → financial_transactions (Jen's weekly GP file,
//     pre-capitalization by construction; carries no payroll, no COGS).
//   COGS → vena_monthly (Abigail's close). Vena's presence for the period
//     IS the release signal; absent rows render as PENDING, never $0.
//   Payroll → people_weekly by fiscal week; MISSING weeks are NAMED with
//     their expected pay date (covered week = pay date − 1 wk), never
//     silently summed short.
//   Targets → budgets.js MONTHLY_PLAN (2026 3+9 plan, with the procurement
//     line split out) + weeklyBudgetYards for yards.
//   AP/AR/cash → unchanged (aging feed owns those tables).
//
// The returned shape is a superset of v1's — everything the preview UI,
// prompt builder and PDF renderer consumed is still there, plus
// `dataQuality` (coverage notes + the GP cross-check) and richer targets.
// ============================================================================

import { supabase } from '../supabase'
import { format, parseISO, differenceInDays } from 'date-fns'
import { getFiscalInfo } from '../fiscalCalendar'
import { weeklyBudgetYards, monthlyPlanFor } from './budgets'

// ---------------------------------------------------------------------------
// Fiscal helpers — Sunday-dated weeks vs Monday-keyed FISCAL_CALENDAR
// ---------------------------------------------------------------------------
function fiscalMonthOf(weekStart) {
  if (!weekStart) return null
  let info = getFiscalInfo(weekStart)
  if (info) return info
  const iso = typeof weekStart === 'string' ? weekStart : format(weekStart, 'yyyy-MM-dd')
  const d = new Date(iso + 'T12:00:00')
  if (isNaN(d.getTime())) return null
  d.setDate(d.getDate() + 1)
  return getFiscalInfo(format(d, 'yyyy-MM-dd'))
}

const iso = d => format(d, 'yyyy-MM-dd')

/** The Sunday week_starts whose fiscal month is the target. */
function fiscalWeeksForMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  const targetAbbr = format(new Date(y, m - 1, 1), 'MMM')
  // First Sunday on/before (calendar month start − 7d), scan ~7 Sundays.
  const start = new Date(y, m - 1, 1, 12)
  start.setDate(start.getDate() - 7 - start.getDay())
  const weeks = []
  for (let i = 0; i < 8; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i * 7)
    if (fiscalMonthOf(iso(d))?.month === targetAbbr) weeks.push(iso(d))
  }
  return weeks
}

const sundayOf = dateIso => {
  const d = new Date(dateIso + 'T12:00:00')
  d.setDate(d.getDate() - d.getDay())
  return iso(d)
}

const num = v => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

// PostgREST silently caps any single request at 1,000 rows REGARDLESS of the
// requested range — the documented trap, and it bit this exact file on first
// deploy (August OpEx read $2,354 instead of $92,363 because the GP query got
// a 1,000-row slice). Page by exactly 1,000, always.
async function fetchAllPages(build, maxPages = 25) {
  const out = []
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await build().range(page * 1000, page * 1000 + 999)
    if (error) return { rows: out, error }
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return { rows: out, error: null }
}

const FALLBACK_WEEKLY_BNY = 12000
const FALLBACK_WEEKLY_NJ  = 8610
function safeWeeklyBudget(site) {
  const candidates = site === 'bny'
    ? ['bny', 'BNY', 'brooklyn', 'Brooklyn', 'digital']
    : ['passaic', 'Passaic', 'nj', 'NJ', 'hand_screen', 'handscreen']
  for (const name of candidates) {
    try {
      const v = weeklyBudgetYards(name, 'all')
      if (typeof v === 'number' && v > 0) return v
    } catch { /* keep trying */ }
  }
  return site === 'bny' ? FALLBACK_WEEKLY_BNY : FALLBACK_WEEKLY_NJ
}

/** YYYY-MM-W[1..5] period keys (aging tables still use these). */
function periodKeyForDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const w = Math.min(5, Math.ceil(d.getDate() / 7))
  return `${y}-${m}-W${w}`
}
function allPeriodKeysForMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  const keys = new Set()
  for (let day = 1; day <= last; day++) keys.add(periodKeyForDate(new Date(y, m - 1, day)))
  return Array.from(keys).sort()
}

// ---------------------------------------------------------------------------
// People aggregation (+ named missing weeks — never silently short)
// ---------------------------------------------------------------------------
function aggregatePeople(rows, fiscalWeeks) {
  const loaded = new Set(rows.map(r => r.week_start))
  const missingWeeks = fiscalWeeks.filter(w => !loaded.has(w)).map(w => {
    const end = new Date(w + 'T12:00:00'); end.setDate(end.getDate() + 6)
    const pay = new Date(w + 'T12:00:00'); pay.setDate(pay.getDate() + 12)
    return { weekStart: w, weekEnding: iso(end), expectedPayDate: iso(pay) }
  })
  const base = { weekCount: rows.length, expectedWeeks: fiscalWeeks.length, missingWeeks,
    missingNote: missingWeeks.length
      ? `Payroll: ${rows.length} of ${fiscalWeeks.length} fiscal weeks loaded. Missing: `
        + missingWeeks.map(m => `week ending ${m.weekEnding} (pay date ${m.expectedPayDate})`).join(', ')
        + ' — save those UKG files to the ShareFile Payroll folder.'
      : null }
  if (!rows.length) return { ...base, bny: null, nj: null, combined: null, latestEmployees: 0 }
  const last = rows[rows.length - 1]
  const sum = rows.reduce((acc, r) => {
    acc.bnyHrs += num(r.bny_total_hrs); acc.njHrs += num(r.nj_total_hrs)
    acc.bnyOt  += num(r.bny_ot_hrs);    acc.njOt  += num(r.nj_ot_hrs)
    acc.bnyPto += num(r.bny_pto_hrs);   acc.njPto += num(r.nj_pto_hrs)
    acc.bnyPay += num(r.bny_total_pay); acc.njPay += num(r.nj_total_pay)
    acc.bnyBonus += num(r.bny_bonus_total); acc.njBonus += num(r.nj_bonus_total)
    return acc
  }, { bnyHrs: 0, njHrs: 0, bnyOt: 0, njOt: 0, bnyPto: 0, njPto: 0, bnyPay: 0, njPay: 0, bnyBonus: 0, njBonus: 0 })
  return {
    ...base,
    bny: { headcount: num(last.bny_headcount), hours: sum.bnyHrs, ot: sum.bnyOt, pto: sum.bnyPto,
           pay: sum.bnyPay, bonus: sum.bnyBonus, otPct: sum.bnyHrs > 0 ? (100 * sum.bnyOt / sum.bnyHrs) : null },
    nj:  { headcount: num(last.nj_headcount), hours: sum.njHrs, ot: sum.njOt, pto: sum.njPto,
           pay: sum.njPay, bonus: sum.njBonus, otPct: sum.njHrs > 0 ? (100 * sum.njOt / sum.njHrs) : null },
    combined: { headcount: num(last.bny_headcount) + num(last.nj_headcount),
                hours: sum.bnyHrs + sum.njHrs, pay: sum.bnyPay + sum.njPay },
    latestEmployees: Array.isArray(last.employees) ? last.employees.length : 0,
  }
}

// ---------------------------------------------------------------------------
// WIP snapshot — unchanged (already canonical)
// ---------------------------------------------------------------------------
async function fetchCurrentWipSnapshot() {
  const { data: snap } = await supabase.from('sched_snapshots')
    .select('id, uploaded_at').order('uploaded_at', { ascending: false }).limit(1).maybeSingle()
  if (!snap) return { available: false }
  const { data: rows, error } = await supabase.from('sched_wip_rows')
    .select('site, product_type, customer_type, is_new_goods, color_yards, yards_written, order_status, order_created')
    .eq('snapshot_id', snap.id)
  if (error || !rows) return { available: false }
  const closedStatuses = new Set(['Closed', 'Shipped', 'Invoiced', 'Complete'])
  const active = rows.filter(r => !closedStatuses.has(r.order_status))
  const today = new Date()
  const ageBuckets = { lt30: 0, b30_60: 0, b60_90: 0, gt90: 0 }
  let activeYards = 0, activeColorYards = 0
  for (const r of active) {
    activeYards += num(r.yards_written); activeColorYards += num(r.color_yards)
    if (r.order_created) {
      const days = differenceInDays(today, new Date(r.order_created))
      if (days < 30) ageBuckets.lt30++
      else if (days < 60) ageBuckets.b30_60++
      else if (days < 90) ageBuckets.b60_90++
      else ageBuckets.gt90++
    }
  }
  const byProductType = {}, bySite = {}
  for (const r of active) {
    const p = (r.product_type || 'unknown').toLowerCase()
    ;(byProductType[p] = byProductType[p] || { count: 0, yards: 0, colorYards: 0 })
    byProductType[p].count++; byProductType[p].yards += num(r.yards_written); byProductType[p].colorYards += num(r.color_yards)
    const s = (r.site || 'unknown').toLowerCase()
    ;(bySite[s] = bySite[s] || { count: 0, yards: 0 })
    bySite[s].count++; bySite[s].yards += num(r.yards_written)
  }
  return { available: true, snapshotAt: snap.uploaded_at, totalActive: active.length,
           activeYards, activeColorYards, ageBuckets, byProductType, bySite,
           newGoodsActive: active.filter(r => r.is_new_goods).length }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function gatherMonthlyBriefData({ monthKey, phase = 'end', includeFinancials = true }) {
  const [year, monthNum] = monthKey.split('-').map(Number)
  const monthStart = new Date(year, monthNum - 1, 1)
  const monthEnd = new Date(year, monthNum, 0)
  const today = new Date()
  const monthLabel = format(monthStart, 'MMMM yyyy')
  const isCurrentMonth = today >= monthStart && today <= monthEnd
  const daysInMonth = monthEnd.getDate()
  const daysElapsed = isCurrentMonth ? today.getDate() : daysInMonth

  const coverage = []            // plain-language data-quality notes
  const plan = monthlyPlanFor(monthKey)

  // ── The fiscal window ────────────────────────────────────────────────
  const fiscalWeeks = fiscalWeeksForMonth(monthKey)
  const weeksInMonth = fiscalWeeks.length || 4
  const windowStart = fiscalWeeks[0] || iso(monthStart)
  const windowEndD = new Date((fiscalWeeks[weeksInMonth - 1] || iso(monthEnd)) + 'T12:00:00')
  windowEndD.setDate(windowEndD.getDate() + 6)
  const windowEnd = iso(windowEndD)

  // ── PRODUCED — sched_daily_ops actuals (waste column guarded) ────────
  let opsRows = [], wasteAvailable = true
  {
    const lastWeek = fiscalWeeks[weeksInMonth - 1] || windowEnd
    let res = await fetchAllPages(() => supabase.from('sched_daily_ops')
      .select('site, week_start, actual_yards, waste_yards')
      .gte('week_start', windowStart).lte('week_start', lastWeek))
    if (res.error) {
      wasteAvailable = false
      res = await fetchAllPages(() => supabase.from('sched_daily_ops')
        .select('site, week_start, actual_yards')
        .gte('week_start', windowStart).lte('week_start', lastWeek))
    }
    opsRows = res.rows || []
  }
  if (!wasteAvailable) coverage.push('Floor waste column unavailable from Live Ops — waste omitted rather than guessed.')

  const prodByWeek = {}   // week -> { njYards, bnyYards, njWaste }
  for (const r of opsRows) {
    const w = (prodByWeek[r.week_start] = prodByWeek[r.week_start] || { njYards: 0, bnyYards: 0, njWaste: 0 })
    if (r.site === 'passaic') { w.njYards += num(r.actual_yards); w.njWaste += num(r.waste_yards) }
    else if (r.site === 'bny') { w.bnyYards += num(r.actual_yards) }
  }

  // ── INVOICED — order_ledger by invoice_date in the fiscal window ─────
  const { rows: ledRows, error: ledErr } = await fetchAllPages(() => supabase.from('order_ledger')
    .select('site, product_type, yards_invoiced, invoiced_revenue, invoice_date')
    .gte('invoice_date', windowStart).lte('invoice_date', windowEnd))
  if (ledErr) coverage.push('Order ledger read failed — invoiced figures unavailable: ' + ledErr.message)

  const invByWeek = {}    // week -> per-site invoiced
  const njByCategory = {}
  const led = { nj: { yds: 0, rev: 0 }, bny: { yds: 0, rev: 0 }, proc: { yds: 0, rev: 0, orders: 0 } }
  for (const r of (ledRows || [])) {
    const wk = sundayOf(r.invoice_date)
    const w = (invByWeek[wk] = invByWeek[wk] || { njInvoicedYds: 0, njRevenue: 0, bnyInvoicedYds: 0, bnyRevenue: 0, njProcurement: 0 })
    const yds = num(r.yards_invoiced), rev = num(r.invoiced_revenue)
    if (r.site === 'procurement') {
      led.proc.yds += yds; led.proc.rev += rev; led.proc.orders++
      w.njProcurement += rev            // pass-through rides the NJ/hub side, memo only
    } else if (r.site === 'passaic') {
      led.nj.yds += yds; led.nj.rev += rev
      w.njInvoicedYds += yds; w.njRevenue += rev
      const cat = (r.product_type || 'other').toLowerCase()
      ;(njByCategory[cat] = njByCategory[cat] || { yards: 0, colorYards: 0, waste: 0, invoicedYds: 0, revenue: 0 })
      njByCategory[cat].invoicedYds += yds; njByCategory[cat].revenue += rev
    } else if (r.site === 'bny') {
      led.bny.yds += yds; led.bny.rev += rev
      w.bnyInvoicedYds += yds; w.bnyRevenue += rev
    }
  }

  // ── GP cross-check + OpEx + purchases — financial_transactions ───────
  let gp = { njInvoiced: 0, bnyInvoiced: 0, opex: { nj: 0, bny: 0, shared: 0 }, purch: { nj: 0, bny: 0, shared: 0 }, rows: 0 }
  {
    const { rows: txns, error } = await fetchAllPages(() => supabase.from('financial_transactions')
      .select('trx_date, net, business_unit, category, source_tab')
      .gte('trx_date', windowStart).lte('trx_date', windowEnd))
    if (error) coverage.push('GP transactions read failed: ' + error.message)
    for (const t of (txns || [])) {
      gp.rows++
      const u = String(t.business_unit || 'shared').toLowerCase()
      const unit = (u === 'nj' || u === 'bny') ? u : 'shared'
      const cat = String(t.category || '').toLowerCase()
      const tab = String(t.source_tab || '').toUpperCase()
      const n = num(t.net)
      if (cat === 'ar_trade' || cat === 'sales_ar_invoiced' || /SALES.*AR.*INVOICED/.test(tab)) {
        if (unit === 'nj') gp.njInvoiced += n
        else if (unit === 'bny') gp.bnyInvoiced += n
      } else if (cat.startsWith('opex')) {
        gp.opex[unit] += n
      } else if (/INVENTORY.*INK.*FREIGHT/.test(tab) || ['ink', 'freight', 'material_inventory'].includes(cat)) {
        gp.purch[unit] += n
      }
    }
  }

  // The GUARD: GP's NJ invoicing INCLUDES procurement (GP books it to 610),
  // so compare like-for-like. Threshold 7% — beyond that the brief carries a
  // loud flag (the LIFT-upgrade class: corrupted/re-dated ledger invoicing).
  const ledNjTotal = led.nj.rev + led.proc.rev
  const vPct = (a, b) => b > 0 ? Math.round(1000 * (a - b) / b) / 10 : null
  const revenueCrossCheck = {
    ledger: { njInclProc: Math.round(ledNjTotal), bny: Math.round(led.bny.rev) },
    gp:     { nj: Math.round(gp.njInvoiced), bny: Math.round(gp.bnyInvoiced) },
    njVariancePct:  vPct(ledNjTotal, gp.njInvoiced),
    bnyVariancePct: vPct(led.bny.rev, gp.bnyInvoiced),
    flagged: false, note: null,
  }
  const worst = Math.max(Math.abs(revenueCrossCheck.njVariancePct ?? 0), Math.abs(revenueCrossCheck.bnyVariancePct ?? 0))
  if (worst > 7) {
    revenueCrossCheck.flagged = true
    revenueCrossCheck.note =
      `⚠ Ledger vs GP invoicing disagree by up to ${worst}% this month (NJ ${revenueCrossCheck.njVariancePct}%, ` +
      `BNY ${revenueCrossCheck.bnyVariancePct}%). Timing differences are normal at the edges; a large gap means ` +
      `re-dated or corrupted LIFT invoicing (as in the Sep 2026 platform upgrade) — reconcile before publishing.`
    coverage.push(revenueCrossCheck.note)
  }

  // ── weekRows — one row per fiscal week, feed-sourced ─────────────────
  const weekRows = fiscalWeeks.map(wk => {
    const p = prodByWeek[wk] || { njYards: 0, bnyYards: 0, njWaste: 0 }
    const v = invByWeek[wk] || { njInvoicedYds: 0, njRevenue: 0, bnyInvoicedYds: 0, bnyRevenue: 0, njProcurement: 0 }
    const fiscal = fiscalMonthOf(wk)
    return {
      weekStart: wk,
      weekLabel: fiscal ? `Wk ${fiscal.weekInMonth}/${fiscal.weeksInMonth}` : format(parseISO(wk), 'MMM d'),
      bnyYards: p.bnyYards, bnyInvoicedYds: v.bnyInvoicedYds, bnyRevenue: v.bnyRevenue,
      bnyMiscRevenue: 0, bnyProcurement: 0, bnyByBucket: {},
      njYards: p.njYards, njColorYards: null, njWaste: wasteAvailable ? p.njWaste : null,
      njInvoicedYds: v.njInvoicedYds, njRevenue: v.njRevenue,
      njMiscRevenue: 0, njProcurement: v.njProcurement, njByCategory: {},
    }
  })

  // ── MTD totals (same keys the UI/prompt/PDF consume) ─────────────────
  const prod = {
    bnyYards: 0, bnyInvoicedYds: 0, bnyRevenue: 0, bnyMiscRevenue: 0, bnyProcurement: 0,
    njYards: 0, njColorYards: null, njWaste: 0, njInvoicedYds: 0, njRevenue: 0, njMiscRevenue: 0, njProcurement: 0,
  }
  for (const r of weekRows) {
    prod.bnyYards += r.bnyYards; prod.bnyInvoicedYds += r.bnyInvoicedYds; prod.bnyRevenue += r.bnyRevenue
    prod.njYards += r.njYards; prod.njWaste += (r.njWaste || 0)
    prod.njInvoicedYds += r.njInvoicedYds; prod.njRevenue += r.njRevenue
    prod.njProcurement += r.njProcurement
  }
  if (!wasteAvailable) prod.njWaste = null
  prod.njByCategory = njByCategory        // invoiced-basis categories from the ledger
  prod.bnyByBucket = {}                   // bucket split awaits Custom→MTO mapping on the ledger
  prod.combinedYards       = prod.bnyYards + prod.njYards
  prod.combinedInvoicedYds = prod.bnyInvoicedYds + prod.njInvoicedYds
  prod.combinedRevenue     = prod.bnyRevenue + prod.njRevenue
  prod.combinedMiscRevenue = 0
  prod.combinedProcurement = prod.njProcurement
  prod.njWastePct = (wasteAvailable && prod.njYards > 0) ? (100 * prod.njWaste / prod.njYards) : null
  prod.procurementOrders = led.proc.orders
  prod.procurementYds = led.proc.yds

  // Revenue ladder — operating (drives margin) vs pass-through (no margin)
  prod.bnyOperatingRevenue = prod.bnyRevenue
  prod.njOperatingRevenue  = prod.njRevenue
  prod.combinedOperatingRevenue = prod.bnyOperatingRevenue + prod.njOperatingRevenue
  prod.bnyTotalInflows = prod.bnyOperatingRevenue
  prod.njTotalInflows  = prod.njOperatingRevenue + prod.njProcurement
  prod.combinedTotalInflows = prod.bnyTotalInflows + prod.njTotalInflows

  // ── Targets — yards from weekly budget, revenue from MONTHLY_PLAN ────
  const monthBnyTarget = safeWeeklyBudget('bny') * weeksInMonth
  const monthNjTarget  = safeWeeklyBudget('nj')  * weeksInMonth
  const monthCombinedTarget = monthBnyTarget + monthNjTarget
  const weeksElapsed = phase === 'end' ? weeksInMonth : Math.ceil(weeksInMonth / 2)
  const proRataFactor = weeksElapsed / weeksInMonth
  const expectedBnyMtd = phase === 'end' ? monthBnyTarget : monthBnyTarget * proRataFactor
  const expectedNjMtd  = phase === 'end' ? monthNjTarget  : monthNjTarget  * proRataFactor
  const expectedCombMtd = expectedBnyMtd + expectedNjMtd
  prod.bnyVsTargetPct  = expectedBnyMtd  > 0 ? (100 * prod.bnyYards      / expectedBnyMtd)  : null
  prod.njVsTargetPct   = expectedNjMtd   > 0 ? (100 * prod.njYards       / expectedNjMtd)   : null
  prod.combVsTargetPct = expectedCombMtd > 0 ? (100 * prod.combinedYards / expectedCombMtd) : null

  const revTargets = plan ? {
    bnyRevenueTarget: plan.bnyRevenue * (phase === 'end' ? 1 : proRataFactor),
    njOperatingRevenueTarget: plan.passaicOperating * (phase === 'end' ? 1 : proRataFactor),
    procurementTarget: plan.passaicProcurement * (phase === 'end' ? 1 : proRataFactor),
    combinedOperatingTarget: (plan.bnyRevenue + plan.passaicOperating) * (phase === 'end' ? 1 : proRataFactor),
    payrollPlan: plan.payrollPlan * (phase === 'end' ? 1 : proRataFactor),
    planSource: '2026 3+9 plan (Paramount_Planned_PL 39); Passaic operating = plan total minus its $' +
      Math.round(plan.passaicProcurement / 1000) + 'K procurement revenue line',
  } : null
  if (!plan) coverage.push(`No monthly plan constants for ${monthKey} in budgets.js MONTHLY_PLAN — revenue graded against yard-budget only.`)

  // ── Financials — GP for OpEx/purchases, Vena for COGS ────────────────
  let fin, ap = null, ar = null, cash = null
  if (includeFinancials) {
    // COGS from Vena: presence of the period's actuals IS the release signal.
    let cogsByUnit = null
    // line_key 'cost_of_goods_sold_2' is the TRUE total (verified vs the June
    // close: 610 = $441,513 to the dollar; the un-suffixed key is a $0 header
    // row and the 41xx leaves sum to the _2 total).
    const { data: venaRows } = await supabase.from('vena_monthly')
      .select('cost_center, amount')
      .eq('period', monthKey).eq('timeframe', 'month').eq('scenario', 'actual')
      .eq('line_key', 'cost_of_goods_sold_2')
    if (venaRows && venaRows.length > 0) {
      cogsByUnit = { nj: 0, bny: 0, shared: 0 }
      for (const r of venaRows) {
        const cc = String(r.cost_center)
        if (cc === '610') cogsByUnit.nj += num(r.amount)
        else if (cc === '609') cogsByUnit.bny += num(r.amount)
        else if (cc === '612') cogsByUnit.shared += num(r.amount)
      }
    }
    const cogsAvailable = !!cogsByUnit
    const cogsAvailDate = new Date(year, monthNum, 10)
    fin = {
      rowCount: gp.rows,
      cogsAvailable,
      cogsPendingNote: cogsAvailable ? null
        : `COGS not yet released by finance (Vena ${monthLabel} close pending — typically after ${format(cogsAvailDate, 'MMMM d')}).`,
      opex: gp.opex.nj + gp.opex.bny + gp.opex.shared,
      invPurchases: gp.purch.nj + gp.purch.bny + gp.purch.shared,
      cogsTotal: cogsAvailable ? cogsByUnit.nj + cogsByUnit.bny : null,
      cogsMaterial: null, cogsLabor: null, cogsOther: null,
      byUnit: {
        nj:     { opex: gp.opex.nj,     invPurchases: gp.purch.nj,     cogsTotal: cogsAvailable ? cogsByUnit.nj  : null },
        bny:    { opex: gp.opex.bny,    invPurchases: gp.purch.bny,    cogsTotal: cogsAvailable ? cogsByUnit.bny : null },
        shared: { opex: gp.opex.shared, invPurchases: gp.purch.shared, cogsTotal: null },
      },
      opexNote: 'Non-payroll operating spend from the weekly GP file (pre-capitalization by construction; payroll reported separately).',
    }

    const periodKeys = allPeriodKeysForMonth(monthKey)
    const [{ data: apRows }, { data: arRows }, { data: cashRows }] = await Promise.all([
      supabase.from('financial_ap').select('*').in('period', periodKeys).order('period', { ascending: false }),
      supabase.from('financial_ar').select('*').in('period', periodKeys).order('period', { ascending: false }),
      supabase.from('financial_cash').select('*').in('period', periodKeys).order('period', { ascending: false }),
    ])
    ap = (apRows && apRows[0]) ? { period: apRows[0].period, total: num(apRows[0].total),
      pastDue: num(apRows[0].past_due), current: num(apRows[0].current) } : null
    ar = (arRows && arRows[0]) ? { period: arRows[0].period,
      totalOutstanding: num(arRows[0].total_outstanding), aging91Plus: num(arRows[0].aging_91plus) } : null
    cash = (cashRows && cashRows[0]) ? cashRows[0] : null
  } else {
    fin = { suppressed: true, rowCount: 0, cogsAvailable: false, cogsPendingNote: null,
            opex: null, invPurchases: null, cogsTotal: null, cogsMaterial: null,
            cogsLabor: null, cogsOther: null, byUnit: {} }
  }

  // ── People — fiscal weeks, gaps named ────────────────────────────────
  const { data: peopleRowsRaw } = await supabase.from('people_weekly')
    .select('*').in('week_start', fiscalWeeks).order('week_start', { ascending: true })
  const people = aggregatePeople(peopleRowsRaw || [], fiscalWeeks)
  if (people.missingNote) coverage.push(people.missingNote)

  coverage.push('Passaic color-yards intentionally omitted: manual and derived figures disagree ~2× — method reconciliation pending.')
  coverage.push('Produced basis: floor-reported Live Ops actuals. Switches to LIFT printed quantities once QA reverse-flow entry is verified live.')

  const wip = await fetchCurrentWipSnapshot()

  const pacing = {
    monthLabel, monthKey, phase, isCurrentMonth, daysInMonth, daysElapsed,
    weeksInMonth, weeksElapsed,
    pctMonthElapsed: Math.round(100 * daysElapsed / daysInMonth),
    fiscalQuarter: fiscalWeeks[0] ? fiscalMonthOf(fiscalWeeks[0])?.quarter : null,
    fiscalWindow: { start: windowStart, end: windowEnd },
    generatedAt: today.toISOString(),
  }

  return {
    pacing,
    includeFinancials,
    targets: {
      monthBnyTarget, monthNjTarget, monthCombinedTarget,
      expectedBnyMtd, expectedNjMtd, expectedCombMtd,
      ...(revTargets || {}),
    },
    production: { ...prod, weekRows },
    financials: fin,
    ap, ar, cash,
    people,
    wip,
    dataQuality: {
      basis: 'canonical feeds (order ledger · GP transactions · Live Ops · payroll feed · Vena)',
      revenueCrossCheck,
      coverage,
    },
  }
}

// ============================================================================
// Save / load — monthly_briefs table (unchanged)
// ============================================================================
export async function saveMonthlyBrief({ monthKey, phase, narrative, dataSnapshot, authUser, notes }) {
  const { data, error } = await supabase.from('monthly_briefs')
    .insert({ month_key: monthKey, phase, narrative, data_snapshot: dataSnapshot,
              saved_by: authUser?.id || null, saved_by_email: authUser?.email || null,
              notes: notes || null })
    .select().single()
  if (error) { console.error('saveMonthlyBrief:', error); throw error }
  return data
}

export async function listSavedBriefs({ monthKey, phase }) {
  const { data, error } = await supabase.from('monthly_briefs')
    .select('id, month_key, phase, narrative, saved_at, saved_by, saved_by_email, notes')
    .eq('month_key', monthKey).eq('phase', phase)
    .order('saved_at', { ascending: false })
  if (error) { console.error('listSavedBriefs:', error); return [] }
  return data || []
}

export async function loadSavedBrief(id) {
  const { data, error } = await supabase.from('monthly_briefs')
    .select('*').eq('id', id).single()
  if (error) { console.error('loadSavedBrief:', error); throw error }
  return data
}
