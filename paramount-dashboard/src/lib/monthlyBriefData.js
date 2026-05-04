// ============================================================================
// monthlyBriefData.js — Aggregate everything needed for a Monthly Brief.
// ============================================================================
// One function: gatherMonthlyBriefData({ monthKey, phase }).
// Returns one object the prompt builder, the preview UI, and the PDF
// renderer all consume. No formatting in here — just numbers.
//
// monthKey is 'YYYY-MM' (e.g. '2026-04').
// phase is 'mid' | 'end'. We use it to compute "weeks elapsed" framing.
//
// Key decisions / context (don't lose these):
// - COGS comes from finance after the 10th of the following month.
//   For an End-of-Month brief generated before then, COGS is shown as
//   PENDING. We never invent it. (Per Peter, May 4, 2026.)
// - OpEx is available within the financials_monthly rows AND we have
//   weekly budget tokens in budgets.js. We compute OpEx vs budget pace.
// - Production MTD rolls up from the `production` table by week_start
//   falling within the calendar month. Same nj_data / bny_data JSON
//   shape that historicalSummaries.js already established.
// - Financials period keys use derivePeriod() math: Math.ceil(d/7)
//   capped at W5. April 2026 keys: 2026-04-W1, W2, W3, W4.
// - WIP snapshot is the most recent successful sched_snapshot's rows.
// ============================================================================

import { supabase } from '../supabase'
import { format, parseISO, differenceInDays } from 'date-fns'
import { getFiscalInfo } from '../fiscalCalendar'
import { weeklyBudgetYards } from './budgets'

// ---------------------------------------------------------------------------
// Budget helpers — defensive wrapper so we don't depend on exact arg
// signatures of weeklyBudgetYards. Tries known site-name strings,
// falls back to canonical FY26 weekly values from May 2 push.
// ---------------------------------------------------------------------------

const FALLBACK_WEEKLY_BNY = 12000
const FALLBACK_WEEKLY_NJ  = 8610

function safeWeeklyBudget(site) {
  // Try several known site-name strings since different parts of the app
  // use different conventions ('bny' vs 'BNY' vs 'brooklyn', etc.)
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

// ---------------------------------------------------------------------------
// Period-key helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-W[1..5] for a given Date, matching FinancialTab's derivePeriod(). */
function periodKeyForDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const w = Math.min(5, Math.ceil(d.getDate() / 7))
  return `${y}-${m}-W${w}`
}

/** All YYYY-MM-W* keys that fall in the given month's calendar weeks. */
function allPeriodKeysForMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  const keys = new Set()
  for (let day = 1; day <= last; day++) {
    keys.add(periodKeyForDate(new Date(y, m - 1, day)))
  }
  return Array.from(keys).sort()
}

// ---------------------------------------------------------------------------
// Production rollup (nj_data + bny_data JSON shape — same as historicalSummaries)
// ---------------------------------------------------------------------------

function rollupBny(bny) {
  if (!bny) return { yards: 0, byBucket: {} }
  const buckets = ['replen', 'mto', 'hos', 'memo', 'contract', 'newGoods', 'custom', 'threeP']
  let yards = 0
  const byBucket = {}
  for (const b of buckets) {
    const a = bny?.[b]?.actual || 0
    if (a) byBucket[b] = a
    yards += a
  }
  return { yards, byBucket }
}

function rollupNj(nj) {
  if (!nj) return { yards: 0, colorYards: 0, waste: 0, byCategory: {} }
  const cats = ['fabric', 'grass', 'paper']
  let yards = 0
  let colorYards = 0
  let waste = 0
  const byCategory = {}
  for (const c of cats) {
    const cy = nj?.[c]?.yards || 0
    const ccy = nj?.[c]?.colorYards || 0
    const cw = nj?.[c]?.waste || 0
    yards += cy
    colorYards += ccy
    waste += cw
    if (cy || ccy || cw) byCategory[c] = { yards: cy, colorYards: ccy, waste: cw }
  }
  return { yards, colorYards, waste, byCategory }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function gatherMonthlyBriefData({ monthKey, phase = 'end' }) {
  const [year, monthNum] = monthKey.split('-').map(Number)
  const monthStart = new Date(year, monthNum - 1, 1)
  const monthEnd = new Date(year, monthNum, 0)
  const today = new Date()
  const monthLabel = format(monthStart, 'MMMM yyyy')
  const isCurrentMonth = today >= monthStart && today <= monthEnd
  const daysInMonth = monthEnd.getDate()
  const daysElapsed = isCurrentMonth ? today.getDate() : daysInMonth

  // ── Production: all weeks where week_start falls inside the month ───
  const monthStartIso = format(monthStart, 'yyyy-MM-dd')
  const monthEndIso = format(monthEnd, 'yyyy-MM-dd')

  const { data: weeksProd, error: prodErr } = await supabase
    .from('production')
    .select('week_start, nj_data, bny_data')
    .gte('week_start', monthStartIso)
    .lte('week_start', monthEndIso)
    .order('week_start', { ascending: true })

  if (prodErr) console.warn('monthlyBriefData: production fetch error', prodErr)

  const weekRows = (weeksProd || []).map(w => {
    const bny = rollupBny(w.bny_data)
    const nj = rollupNj(w.nj_data)
    const fiscal = getFiscalInfo(w.week_start)
    return {
      weekStart: w.week_start,
      weekLabel: fiscal ? `Wk ${fiscal.weekInMonth}/${fiscal.weeksInMonth}` : format(parseISO(w.week_start), 'MMM d'),
      bnyYards: bny.yards,
      njYards: nj.yards,
      njColorYards: nj.colorYards,
      njWaste: nj.waste,
      bnyByBucket: bny.byBucket,
      njByCategory: nj.byCategory,
    }
  })

  // Production MTD totals
  const prod = weekRows.reduce((acc, r) => {
    acc.bnyYards += r.bnyYards
    acc.njYards += r.njYards
    acc.njColorYards += r.njColorYards
    acc.njWaste += r.njWaste
    return acc
  }, { bnyYards: 0, njYards: 0, njColorYards: 0, njWaste: 0 })
  prod.combinedYards = prod.bnyYards + prod.njYards
  prod.njWastePct = prod.njYards > 0 ? (100 * prod.njWaste / prod.njYards) : null

  // Targets — weeks that exist in this month from fiscal calendar
  const weeksInMonth = weekRows[0] ? (getFiscalInfo(weekRows[0].weekStart)?.weeksInMonth || 4) : 4
  const monthBnyTarget = safeWeeklyBudget('bny') * weeksInMonth
  const monthNjTarget  = safeWeeklyBudget('nj')  * weeksInMonth
  const monthCombinedTarget = monthBnyTarget + monthNjTarget

  // For mid-month, target is pro-rated to weeks elapsed
  const weeksElapsed = phase === 'end' ? weeksInMonth : Math.max(1, weekRows.length || Math.ceil(daysElapsed / 7))
  const proRataFactor = weeksElapsed / weeksInMonth
  const expectedBnyMtd = phase === 'end' ? monthBnyTarget : monthBnyTarget * proRataFactor
  const expectedNjMtd  = phase === 'end' ? monthNjTarget  : monthNjTarget  * proRataFactor
  const expectedCombMtd = expectedBnyMtd + expectedNjMtd

  prod.bnyVsTargetPct = expectedBnyMtd > 0 ? (100 * prod.bnyYards / expectedBnyMtd) : null
  prod.njVsTargetPct  = expectedNjMtd  > 0 ? (100 * prod.njYards  / expectedNjMtd)  : null
  prod.combVsTargetPct = expectedCombMtd > 0 ? (100 * prod.combinedYards / expectedCombMtd) : null

  // ── Financials: rows where period falls in this month ───────────────
  const periodKeys = allPeriodKeysForMonth(monthKey)

  const { data: finRows } = await supabase
    .from('financials_monthly')
    .select('*')
    .in('period', periodKeys)

  const fin = aggregateFinancials(finRows || [], { phase, isCurrentMonth, today, monthEnd })

  // ── AP / AR / Cash — most recent period in the month ─────────────────
  const lastKey = periodKeys[periodKeys.length - 1]

  const [{ data: apRows }, { data: arRows }, { data: cashRows }] = await Promise.all([
    supabase.from('financial_ap').select('*').in('period', periodKeys).order('period', { ascending: false }),
    supabase.from('financial_ar').select('*').in('period', periodKeys).order('period', { ascending: false }),
    supabase.from('financial_cash').select('*').in('period', periodKeys).order('period', { ascending: false }),
  ])

  const ap = (apRows && apRows[0]) ? {
    period: apRows[0].period,
    total: apRows[0].total || 0,
    pastDue: apRows[0].past_due || 0,
    current: apRows[0].current || 0,
  } : null

  const ar = (arRows && arRows[0]) ? {
    period: arRows[0].period,
    totalOutstanding: arRows[0].total_outstanding || 0,
    aging91Plus: arRows[0].aging_91plus || 0,
  } : null

  const cash = (cashRows && cashRows[0]) ? cashRows[0] : null

  // ── People: rollup of people_weekly rows in the month ────────────────
  const { data: peopleRows } = await supabase
    .from('people_weekly')
    .select('*')
    .gte('week_start', monthStartIso)
    .lte('week_start', monthEndIso)
    .order('week_start', { ascending: true })

  const people = aggregatePeople(peopleRows || [])

  // ── WIP: current snapshot's rows ─────────────────────────────────────
  const wip = await fetchCurrentWipSnapshot()

  // ── Pacing context for the prompt ────────────────────────────────────
  const pacing = {
    monthLabel,
    monthKey,
    phase,
    isCurrentMonth,
    daysInMonth,
    daysElapsed,
    weeksInMonth,
    weeksElapsed,
    pctMonthElapsed: Math.round(100 * daysElapsed / daysInMonth),
    fiscalQuarter: weekRows[0] ? getFiscalInfo(weekRows[0].weekStart)?.quarter : null,
    generatedAt: today.toISOString(),
  }

  return {
    pacing,
    targets: {
      monthBnyTarget,
      monthNjTarget,
      monthCombinedTarget,
      expectedBnyMtd,
      expectedNjMtd,
      expectedCombMtd,
    },
    production: {
      ...prod,
      weekRows,
    },
    financials: fin,
    ap, ar, cash,
    people,
    wip,
  }
}

// ---------------------------------------------------------------------------
// Financials aggregation — handles the COGS-pending case
// ---------------------------------------------------------------------------

function aggregateFinancials(rows, { phase, isCurrentMonth, today, monthEnd }) {
  // COGS availability rule: present only after the 10th of the following month.
  // Until then, label as PENDING regardless of what's in the table (which may be 0).
  const monthYear = monthEnd.getFullYear()
  const monthNum = monthEnd.getMonth() // 0-indexed
  const cogsAvailableDate = new Date(monthYear, monthNum + 1, 10) // 10th of following month
  const cogsAvailable = today >= cogsAvailableDate

  // Sum across all rows in the month (across business_units and weekly periods)
  const sum = rows.reduce((acc, r) => {
    acc.revenue       += Number(r.revenue || 0)
    acc.opex          += Number(r.opex || 0)
    acc.cogsMaterial  += Number(r.cogs_material || 0)
    acc.cogsLabor     += Number(r.cogs_labor || 0)
    acc.cogsWip       += Number(r.cogs_wip || 0)
    acc.cogsOther     += Number(r.cogs_other || 0)
    acc.cogsTotal     += Number(r.cogs_total || 0)
    acc.invPurchases  += Number(r.inventory_purchases || 0)
    acc.grossProfit   += Number(r.gross_profit || 0)
    return acc
  }, {
    revenue: 0, opex: 0,
    cogsMaterial: 0, cogsLabor: 0, cogsWip: 0, cogsOther: 0, cogsTotal: 0,
    invPurchases: 0, grossProfit: 0,
  })

  // Split by business unit (best effort — assumes 'BNY' and 'NJ' or 'Passaic')
  const byUnit = {}
  for (const r of rows) {
    const u = (r.business_unit || 'Unknown').trim()
    if (!byUnit[u]) byUnit[u] = { revenue: 0, opex: 0, cogsTotal: 0, invPurchases: 0 }
    byUnit[u].revenue      += Number(r.revenue || 0)
    byUnit[u].opex         += Number(r.opex || 0)
    byUnit[u].cogsTotal    += Number(r.cogs_total || 0)
    byUnit[u].invPurchases += Number(r.inventory_purchases || 0)
  }

  return {
    rowCount: rows.length,
    cogsAvailable,
    cogsPendingNote: cogsAvailable
      ? null
      : `COGS not yet released by finance. Available after the 10th of ${format(cogsAvailableDate, 'MMMM')}.`,
    revenue: sum.revenue,
    opex: sum.opex,
    cogsTotal: cogsAvailable ? sum.cogsTotal : null,
    cogsMaterial: cogsAvailable ? sum.cogsMaterial : null,
    cogsLabor: cogsAvailable ? sum.cogsLabor : null,
    cogsOther: cogsAvailable ? (sum.cogsWip + sum.cogsOther) : null,
    invPurchases: sum.invPurchases,
    grossProfit: cogsAvailable ? sum.grossProfit : null,
    byUnit,
  }
}

// ---------------------------------------------------------------------------
// People aggregation
// ---------------------------------------------------------------------------

function aggregatePeople(rows) {
  if (!rows.length) {
    return { weekRows: [], bny: null, nj: null, combined: null, latestEmployees: 0 }
  }
  const last = rows[rows.length - 1]
  const sum = rows.reduce((acc, r) => {
    acc.bnyHrs += Number(r.bny_total_hrs || 0)
    acc.njHrs  += Number(r.nj_total_hrs  || 0)
    acc.bnyOt  += Number(r.bny_ot_hrs    || 0)
    acc.njOt   += Number(r.nj_ot_hrs     || 0)
    acc.bnyPto += Number(r.bny_pto_hrs   || 0)
    acc.njPto  += Number(r.nj_pto_hrs    || 0)
    acc.bnyPay += Number(r.bny_total_pay || 0)
    acc.njPay  += Number(r.nj_total_pay  || 0)
    acc.bnyBonus += Number(r.bny_bonus_total || 0)
    acc.njBonus  += Number(r.nj_bonus_total  || 0)
    return acc
  }, { bnyHrs: 0, njHrs: 0, bnyOt: 0, njOt: 0, bnyPto: 0, njPto: 0, bnyPay: 0, njPay: 0, bnyBonus: 0, njBonus: 0 })

  return {
    weekCount: rows.length,
    bny: {
      headcount: Number(last.bny_headcount || 0),
      hours: sum.bnyHrs,
      ot: sum.bnyOt,
      pto: sum.bnyPto,
      pay: sum.bnyPay,
      bonus: sum.bnyBonus,
      otPct: sum.bnyHrs > 0 ? (100 * sum.bnyOt / sum.bnyHrs) : null,
    },
    nj: {
      headcount: Number(last.nj_headcount || 0),
      hours: sum.njHrs,
      ot: sum.njOt,
      pto: sum.njPto,
      pay: sum.njPay,
      bonus: sum.njBonus,
      otPct: sum.njHrs > 0 ? (100 * sum.njOt / sum.njHrs) : null,
    },
    combined: {
      headcount: Number(last.bny_headcount || 0) + Number(last.nj_headcount || 0),
      hours: sum.bnyHrs + sum.njHrs,
      pay: sum.bnyPay + sum.njPay,
    },
    latestEmployees: Array.isArray(last.employees) ? last.employees.length : 0,
  }
}

// ---------------------------------------------------------------------------
// WIP snapshot
// ---------------------------------------------------------------------------

async function fetchCurrentWipSnapshot() {
  // Find the most recent successful sched_snapshot
  const { data: snap } = await supabase
    .from('sched_snapshots')
    .select('id, uploaded_at')
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!snap) return { available: false }

  const { data: rows, error } = await supabase
    .from('sched_wip_rows')
    .select('site, product_type, customer_type, is_new_goods, color_yards, yards_written, order_status, order_created')
    .eq('snapshot_id', snap.id)

  if (error || !rows) return { available: false }

  // Active orders = anything not 'closed' / 'shipped' / 'invoiced'
  const closedStatuses = new Set(['Closed', 'Shipped', 'Invoiced', 'Complete'])
  const active = rows.filter(r => !closedStatuses.has(r.order_status))

  // Age buckets — based on order_created
  const today = new Date()
  const ageBuckets = { lt30: 0, b30_60: 0, b60_90: 0, gt90: 0 }
  let activeYards = 0
  let activeColorYards = 0

  for (const r of active) {
    activeYards += Number(r.yards_written || 0)
    activeColorYards += Number(r.color_yards || 0)
    if (r.order_created) {
      const days = differenceInDays(today, new Date(r.order_created))
      if (days < 30) ageBuckets.lt30++
      else if (days < 60) ageBuckets.b30_60++
      else if (days < 90) ageBuckets.b60_90++
      else ageBuckets.gt90++
    }
  }

  // By category (Passaic) and by site (BNY)
  const byProductType = {}
  for (const r of active) {
    const k = (r.product_type || 'unknown').toLowerCase()
    if (!byProductType[k]) byProductType[k] = { count: 0, yards: 0, colorYards: 0 }
    byProductType[k].count++
    byProductType[k].yards += Number(r.yards_written || 0)
    byProductType[k].colorYards += Number(r.color_yards || 0)
  }

  const bySite = {}
  for (const r of active) {
    const k = (r.site || 'unknown').toLowerCase()
    if (!bySite[k]) bySite[k] = { count: 0, yards: 0 }
    bySite[k].count++
    bySite[k].yards += Number(r.yards_written || 0)
  }

  return {
    available: true,
    snapshotAt: snap.uploaded_at,
    totalActive: active.length,
    activeYards,
    activeColorYards,
    ageBuckets,
    byProductType,
    bySite,
    newGoodsActive: active.filter(r => r.is_new_goods).length,
  }
}
