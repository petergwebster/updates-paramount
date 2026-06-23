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
// ── Data shape notes (post-bugfix May 4, 2026) ───────────────────────────
//
// REVENUE comes from the `production` table, not financials_monthly.
//   - NJ revenue = nj_data.{fabric,grass,paper}.invoiceRev
//   - BNY revenue = bny_data.income{Replen,Mto,Hos,Memo,Contract}
//   - Invoiced yards live alongside as invoiceYds / invYds{Bucket}
//
// PRODUCTION JSON values are STRINGS (input type=number returns strings).
// Every read goes through num(...) which coerces to a finite number or 0.
//
// BNY YARDS PRODUCED are direct values on bny_data, not nested under
// `.actual`. e.g. bny_data.replen = '12000' (string). The earlier
// historicalSummaries.js read b.replen?.actual which always returned
// undefined — this brief reads the right shape.
//
// FINANCIALS_MONTHLY has no `revenue`, `opex`, `cogs_total`, or
// `gross_profit` columns. Those are computed from components:
//   - OpEx = salary + salary_ot + fringe + te + printing + distribution
//          + office_edp + consulting + building + utilities + rent
//   - COGS total = cogs_material + cogs_labor + cogs_wip + cogs_other
//   - Inventory purchases column is `inv_purchases`
// business_unit keys are lowercase: 'nj' | 'bny' | 'shared'.
//
// COGS RULE (per Peter, May 4, 2026): finance does not release COGS until
// after the 10th of the following month. Until then we surface as PENDING
// regardless of whatever is or isn't in the table — never invent numbers.
//
// Period keys for financials use derivePeriod() math: Math.ceil(d/7)
// capped at W5. April 2026 keys: 2026-04-W1, W2, W3, W4 (W1 may be empty).
//
// WIP snapshot is the most recent successful sched_snapshot's rows.
//
// ── Fiscal week alignment (bugfix June 23, 2026) ─────────────────────────
// production/people week_start values are SUNDAY-dated (e.g. 2026-05-31),
// but FISCAL_CALENDAR keys are MONDAY-dated (e.g. 2026-06-01) — one day
// later. A naive YYYY-MM-01 month-start query excluded a Sunday-dated first
// week, and getFiscalInfo() returned null for Sunday dates (forcing
// weeksInMonth to fall back to 4 even when the fiscal month has 5 weeks).
// fiscalMonthOf() normalizes by retrying the lookup at +1 day, and the
// production query window is widened + filtered by fiscal month.
// ============================================================================

import { supabase } from '../supabase'
import { format, parseISO, differenceInDays } from 'date-fns'
import { getFiscalInfo } from '../fiscalCalendar'
import { weeklyBudgetYards } from './budgets'

// ---------------------------------------------------------------------------
// Fiscal calendar normalization — Sunday-dated week_start → Monday key
// ---------------------------------------------------------------------------
// production/people week_start are Sundays; FISCAL_CALENDAR is keyed on the
// Monday one day later. Try the exact key first (handles any Monday-dated
// data), then retry at +1 day (handles Sunday-dated data).
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

// ---------------------------------------------------------------------------
// Defensive number coercion — JSONB values from production are strings
// ---------------------------------------------------------------------------

const num = v => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

// ---------------------------------------------------------------------------
// Budget helpers — defensive wrapper (weeklyBudgetYards signature varies
// across builds). Falls back to canonical FY26 weekly values from the
// May 2 push (12,000 BNY / 8,610 NJ).
// ---------------------------------------------------------------------------

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
// Production rollups — match the AdminPanel emptyNJ() / emptyBNY() shape
// ---------------------------------------------------------------------------

const NJ_CATEGORIES = ['fabric', 'grass', 'paper']
const BNY_BUCKETS = ['replen', 'mto', 'hos', 'memo', 'contract']

function rollupNj(nj) {
  if (!nj || typeof nj !== 'object') {
    return { yards: 0, colorYards: 0, waste: 0, invoicedYds: 0, revenue: 0,
             miscRevenue: 0, procurement: 0, byCategory: {} }
  }
  let yards = 0, colorYards = 0, waste = 0, invoicedYds = 0, revenue = 0
  const byCategory = {}
  for (const c of NJ_CATEGORIES) {
    const cell = nj[c] || {}
    const cy  = num(cell.yards)
    const ccy = num(cell.colorYards)
    const cw  = num(cell.waste)
    const ci  = num(cell.invoiceYds)
    const cr  = num(cell.invoiceRev)
    yards       += cy
    colorYards  += ccy
    waste       += cw
    invoicedYds += ci
    revenue     += cr
    if (cy || ccy || cw || ci || cr) {
      byCategory[c] = { yards: cy, colorYards: ccy, waste: cw, invoicedYds: ci, revenue: cr }
    }
  }
  // Misc fees and pass-through procurement live as direct fields on nj_data
  const miscRevenue = num(nj.miscFees)
  const procurement = num(nj.procurement)
  return { yards, colorYards, waste, invoicedYds, revenue, miscRevenue, procurement, byCategory }
}

function rollupBny(bny) {
  if (!bny || typeof bny !== 'object') {
    return { yards: 0, invoicedYds: 0, revenue: 0, miscRevenue: 0, procurement: 0, byBucket: {} }
  }
  let yards = 0, invoicedYds = 0, revenue = 0
  const byBucket = {}
  for (const b of BNY_BUCKETS) {
    // produced yards live as direct value: bny.replen / bny.mto / etc.
    const produced = num(bny[b])
    // invoiced yards: bny.invYdsReplen / invYdsMto / invYdsHos / invYdsMemo / invYdsContract
    const invKey = 'invYds' + b[0].toUpperCase() + b.slice(1)
    const invYd = num(bny[invKey])
    // revenue dollars: bny.incomeReplen / incomeMto / incomeHos / incomeMemo / incomeContract
    const incKey = 'income' + b[0].toUpperCase() + b.slice(1)
    const inc = num(bny[incKey])
    yards       += produced
    invoicedYds += invYd
    revenue     += inc
    if (produced || invYd || inc) {
      byBucket[b] = { yards: produced, invoicedYds: invYd, revenue: inc }
    }
  }
  const miscRevenue = num(bny.miscFees)
  const procurement = num(bny.procurement)
  return { yards, invoicedYds, revenue, miscRevenue, procurement, byBucket }
}

// ---------------------------------------------------------------------------
// Financials_monthly aggregation — compute opex/cogsTotal from components
// ---------------------------------------------------------------------------

const OPEX_FIELDS = [
  'salary', 'salary_ot', 'fringe', 'te', 'printing', 'distribution',
  'office_edp', 'consulting', 'building', 'utilities', 'rent',
]
const COGS_FIELDS = ['cogs_material', 'cogs_labor', 'cogs_wip', 'cogs_other']

function rowOpex(r) { return OPEX_FIELDS.reduce((s, k) => s + num(r[k]), 0) }
function rowCogs(r) { return COGS_FIELDS.reduce((s, k) => s + num(r[k]), 0) }

function aggregateFinancials(rows, { today, monthEnd }) {
  // COGS availability rule: present only after the 10th of the following month.
  const monthYear = monthEnd.getFullYear()
  const monthNum = monthEnd.getMonth() // 0-indexed
  const cogsAvailableDate = new Date(monthYear, monthNum + 1, 10)
  const cogsAvailable = today >= cogsAvailableDate

  const blank = () => ({
    opex: 0, cogsTotal: 0, invPurchases: 0,
    cogsMaterial: 0, cogsLabor: 0, cogsWip: 0, cogsOther: 0,
  })
  const byUnit = { nj: blank(), bny: blank(), shared: blank() }

  for (const r of rows) {
    const u = String(r.business_unit || '').trim().toLowerCase()
    if (!byUnit[u]) byUnit[u] = blank()
    byUnit[u].opex         += rowOpex(r)
    byUnit[u].cogsTotal    += rowCogs(r)
    byUnit[u].invPurchases += num(r.inv_purchases)
    byUnit[u].cogsMaterial += num(r.cogs_material)
    byUnit[u].cogsLabor    += num(r.cogs_labor)
    byUnit[u].cogsWip      += num(r.cogs_wip)
    byUnit[u].cogsOther    += num(r.cogs_other)
  }

  const keys = Object.keys(byUnit)
  const totalOpex         = keys.reduce((s, k) => s + byUnit[k].opex, 0)
  const totalCogs         = keys.reduce((s, k) => s + byUnit[k].cogsTotal, 0)
  const totalInvPurchases = keys.reduce((s, k) => s + byUnit[k].invPurchases, 0)
  const totalCogsMat      = keys.reduce((s, k) => s + byUnit[k].cogsMaterial, 0)
  const totalCogsLab      = keys.reduce((s, k) => s + byUnit[k].cogsLabor, 0)
  const totalCogsOther    = keys.reduce((s, k) => s + byUnit[k].cogsWip + byUnit[k].cogsOther, 0)

  // Public-facing shape for byUnit (nullify cogsTotal when not available)
  const shapedByUnit = {}
  for (const k of keys) {
    shapedByUnit[k] = {
      opex: byUnit[k].opex,
      invPurchases: byUnit[k].invPurchases,
      cogsTotal: cogsAvailable ? byUnit[k].cogsTotal : null,
    }
  }

  return {
    rowCount: rows.length,
    cogsAvailable,
    cogsPendingNote: cogsAvailable
      ? null
      : `COGS not yet released by finance. Available after the 10th of ${format(cogsAvailableDate, 'MMMM')}.`,
    opex: totalOpex,
    invPurchases: totalInvPurchases,
    cogsTotal:    cogsAvailable ? totalCogs       : null,
    cogsMaterial: cogsAvailable ? totalCogsMat    : null,
    cogsLabor:    cogsAvailable ? totalCogsLab    : null,
    cogsOther:    cogsAvailable ? totalCogsOther  : null,
    byUnit: shapedByUnit,
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
    acc.bnyHrs += num(r.bny_total_hrs)
    acc.njHrs  += num(r.nj_total_hrs)
    acc.bnyOt  += num(r.bny_ot_hrs)
    acc.njOt   += num(r.nj_ot_hrs)
    acc.bnyPto += num(r.bny_pto_hrs)
    acc.njPto  += num(r.nj_pto_hrs)
    acc.bnyPay += num(r.bny_total_pay)
    acc.njPay  += num(r.nj_total_pay)
    acc.bnyBonus += num(r.bny_bonus_total)
    acc.njBonus  += num(r.nj_bonus_total)
    return acc
  }, { bnyHrs: 0, njHrs: 0, bnyOt: 0, njOt: 0, bnyPto: 0, njPto: 0, bnyPay: 0, njPay: 0, bnyBonus: 0, njBonus: 0 })

  return {
    weekCount: rows.length,
    bny: {
      headcount: num(last.bny_headcount),
      hours: sum.bnyHrs, ot: sum.bnyOt, pto: sum.bnyPto, pay: sum.bnyPay, bonus: sum.bnyBonus,
      otPct: sum.bnyHrs > 0 ? (100 * sum.bnyOt / sum.bnyHrs) : null,
    },
    nj: {
      headcount: num(last.nj_headcount),
      hours: sum.njHrs, ot: sum.njOt, pto: sum.njPto, pay: sum.njPay, bonus: sum.njBonus,
      otPct: sum.njHrs > 0 ? (100 * sum.njOt / sum.njHrs) : null,
    },
    combined: {
      headcount: num(last.bny_headcount) + num(last.nj_headcount),
      hours: sum.bnyHrs + sum.njHrs,
      pay: sum.bnyPay + sum.njPay,
    },
    latestEmployees: Array.isArray(last.employees) ? last.employees.length : 0,
  }
}

// ---------------------------------------------------------------------------
// WIP snapshot — most recent sched_snapshot's rows
// ---------------------------------------------------------------------------

async function fetchCurrentWipSnapshot() {
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

  const closedStatuses = new Set(['Closed', 'Shipped', 'Invoiced', 'Complete'])
  const active = rows.filter(r => !closedStatuses.has(r.order_status))

  const today = new Date()
  const ageBuckets = { lt30: 0, b30_60: 0, b60_90: 0, gt90: 0 }
  let activeYards = 0
  let activeColorYards = 0

  for (const r of active) {
    activeYards      += num(r.yards_written)
    activeColorYards += num(r.color_yards)
    if (r.order_created) {
      const days = differenceInDays(today, new Date(r.order_created))
      if (days < 30) ageBuckets.lt30++
      else if (days < 60) ageBuckets.b30_60++
      else if (days < 90) ageBuckets.b60_90++
      else ageBuckets.gt90++
    }
  }

  const byProductType = {}
  for (const r of active) {
    const k = (r.product_type || 'unknown').toLowerCase()
    if (!byProductType[k]) byProductType[k] = { count: 0, yards: 0, colorYards: 0 }
    byProductType[k].count++
    byProductType[k].yards += num(r.yards_written)
    byProductType[k].colorYards += num(r.color_yards)
  }

  const bySite = {}
  for (const r of active) {
    const k = (r.site || 'unknown').toLowerCase()
    if (!bySite[k]) bySite[k] = { count: 0, yards: 0 }
    bySite[k].count++
    bySite[k].yards += num(r.yards_written)
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

  // ── Production: all weeks whose FISCAL month matches the selected month ───
  // week_start values are Sunday-dated (one day before the Monday fiscal key),
  // so a month's first week can start in the prior calendar month (e.g. fiscal
  // June's first week starts Sun 2026-05-31). Pull the query start back 2 days
  // to capture it, then filter precisely by fiscal month below.
  const queryStartDate = new Date(monthStart)
  queryStartDate.setDate(queryStartDate.getDate() - 2)
  const monthStartIso = format(queryStartDate, 'yyyy-MM-dd')
  const monthEndIso = format(monthEnd, 'yyyy-MM-dd')
  const targetMonthAbbr = format(monthStart, 'MMM')   // e.g. "Jun"

  const { data: weeksProd, error: prodErr } = await supabase
    .from('production')
    .select('week_start, nj_data, bny_data')
    .gte('week_start', monthStartIso)
    .lte('week_start', monthEndIso)
    .order('week_start', { ascending: true })

  if (prodErr) console.warn('monthlyBriefData: production fetch error', prodErr)

  const weekRows = (weeksProd || [])
    .filter(w => fiscalMonthOf(w.week_start)?.month === targetMonthAbbr)
    .map(w => {
      const bny = rollupBny(w.bny_data)
      const nj = rollupNj(w.nj_data)
      const fiscal = fiscalMonthOf(w.week_start)
      return {
        weekStart: w.week_start,
        weekLabel: fiscal ? `Wk ${fiscal.weekInMonth}/${fiscal.weeksInMonth}` : format(parseISO(w.week_start), 'MMM d'),
        bnyYards: bny.yards,
        bnyInvoicedYds: bny.invoicedYds,
        bnyRevenue: bny.revenue,
        bnyMiscRevenue: bny.miscRevenue,
        bnyProcurement: bny.procurement,
        bnyByBucket: bny.byBucket,
        njYards: nj.yards,
        njColorYards: nj.colorYards,
        njWaste: nj.waste,
        njInvoicedYds: nj.invoicedYds,
        njRevenue: nj.revenue,
        njMiscRevenue: nj.miscRevenue,
        njProcurement: nj.procurement,
        njByCategory: nj.byCategory,
      }
    })

  // Production MTD totals — revenue and invoiced yards now flow through here too
  const prod = weekRows.reduce((acc, r) => {
    acc.bnyYards        += r.bnyYards
    acc.bnyInvoicedYds  += r.bnyInvoicedYds
    acc.bnyRevenue      += r.bnyRevenue
    acc.bnyMiscRevenue  += r.bnyMiscRevenue
    acc.bnyProcurement  += r.bnyProcurement
    acc.njYards         += r.njYards
    acc.njColorYards    += r.njColorYards
    acc.njWaste         += r.njWaste
    acc.njInvoicedYds   += r.njInvoicedYds
    acc.njRevenue       += r.njRevenue
    acc.njMiscRevenue   += r.njMiscRevenue
    acc.njProcurement   += r.njProcurement
    return acc
  }, { bnyYards: 0, bnyInvoicedYds: 0, bnyRevenue: 0, bnyMiscRevenue: 0, bnyProcurement: 0,
       njYards: 0, njColorYards: 0, njWaste: 0, njInvoicedYds: 0, njRevenue: 0, njMiscRevenue: 0, njProcurement: 0 })

  prod.combinedYards       = prod.bnyYards + prod.njYards
  prod.combinedInvoicedYds = prod.bnyInvoicedYds + prod.njInvoicedYds
  prod.combinedRevenue     = prod.bnyRevenue + prod.njRevenue
  prod.combinedMiscRevenue = prod.bnyMiscRevenue + prod.njMiscRevenue
  prod.combinedProcurement = prod.bnyProcurement + prod.njProcurement
  prod.njWastePct = prod.njYards > 0 ? (100 * prod.njWaste / prod.njYards) : null

  // ── Revenue ladder for budget reconciliation ─────────────────────────
  // Operating revenue = invoice rev + misc fees (drives margin).
  // Procurement = pass-through to FSCO (NOT operating revenue, but counts
  // toward total cash in and reconciles to top-line budget).
  // Total inflows = operating + procurement (matches budget).
  prod.bnyOperatingRevenue  = prod.bnyRevenue + prod.bnyMiscRevenue
  prod.njOperatingRevenue   = prod.njRevenue  + prod.njMiscRevenue
  prod.combinedOperatingRevenue = prod.bnyOperatingRevenue + prod.njOperatingRevenue

  prod.bnyTotalInflows = prod.bnyOperatingRevenue + prod.bnyProcurement
  prod.njTotalInflows  = prod.njOperatingRevenue  + prod.njProcurement
  prod.combinedTotalInflows = prod.bnyTotalInflows + prod.njTotalInflows

  // Targets — weeks that exist in this month from fiscal calendar
  const weeksInMonth = weekRows[0] ? (fiscalMonthOf(weekRows[0].weekStart)?.weeksInMonth || 4) : 4
  const monthBnyTarget = safeWeeklyBudget('bny') * weeksInMonth
  const monthNjTarget  = safeWeeklyBudget('nj')  * weeksInMonth
  const monthCombinedTarget = monthBnyTarget + monthNjTarget

  // For mid-month, target is pro-rated to weeks of data we actually have
  const weeksElapsed = phase === 'end' ? weeksInMonth : Math.max(1, weekRows.length || Math.ceil(daysElapsed / 7))
  const proRataFactor = weeksElapsed / weeksInMonth
  const expectedBnyMtd = phase === 'end' ? monthBnyTarget : monthBnyTarget * proRataFactor
  const expectedNjMtd  = phase === 'end' ? monthNjTarget  : monthNjTarget  * proRataFactor
  const expectedCombMtd = expectedBnyMtd + expectedNjMtd

  prod.bnyVsTargetPct  = expectedBnyMtd  > 0 ? (100 * prod.bnyYards      / expectedBnyMtd)  : null
  prod.njVsTargetPct   = expectedNjMtd   > 0 ? (100 * prod.njYards       / expectedNjMtd)   : null
  prod.combVsTargetPct = expectedCombMtd > 0 ? (100 * prod.combinedYards / expectedCombMtd) : null

  // ── Financials: rows where period falls in this month ─────────────────
  const periodKeys = allPeriodKeysForMonth(monthKey)

  const { data: finRows } = await supabase
    .from('financials_monthly')
    .select('*')
    .in('period', periodKeys)

  const fin = aggregateFinancials(finRows || [], { today, monthEnd })

  // ── AP / AR / Cash — most recent period in the month ──────────────────
  const [{ data: apRows }, { data: arRows }, { data: cashRows }] = await Promise.all([
    supabase.from('financial_ap').select('*').in('period', periodKeys).order('period', { ascending: false }),
    supabase.from('financial_ar').select('*').in('period', periodKeys).order('period', { ascending: false }),
    supabase.from('financial_cash').select('*').in('period', periodKeys).order('period', { ascending: false }),
  ])

  const ap = (apRows && apRows[0]) ? {
    period: apRows[0].period,
    total: num(apRows[0].total),
    pastDue: num(apRows[0].past_due),
    current: num(apRows[0].current),
  } : null

  const ar = (arRows && arRows[0]) ? {
    period: arRows[0].period,
    totalOutstanding: num(arRows[0].total_outstanding),
    aging91Plus: num(arRows[0].aging_91plus),
  } : null

  const cash = (cashRows && cashRows[0]) ? cashRows[0] : null

  // ── People: rollup of people_weekly rows in the month ─────────────────
  // Same Sunday-dated week_start widening as production (monthStartIso is
  // already pulled back 2 days above), then filter to the fiscal month.
  const { data: peopleRowsRaw } = await supabase
    .from('people_weekly')
    .select('*')
    .gte('week_start', monthStartIso)
    .lte('week_start', monthEndIso)
    .order('week_start', { ascending: true })

  const peopleRows = (peopleRowsRaw || [])
    .filter(r => fiscalMonthOf(r.week_start)?.month === targetMonthAbbr)

  const people = aggregatePeople(peopleRows)

  // ── WIP: current snapshot's rows ──────────────────────────────────────
  const wip = await fetchCurrentWipSnapshot()

  // ── Pacing context for the prompt ─────────────────────────────────────
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
    fiscalQuarter: weekRows[0] ? fiscalMonthOf(weekRows[0].weekStart)?.quarter : null,
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

// ============================================================================
// Save / load — monthly_briefs table
// ============================================================================
// Each save creates a new row (history-preserving). Editing a saved brief
// and saving again creates yet another row. The list view shows all saved
// versions for a (month, phase) so you can pull up the April brief in
// November, click it, and see exactly what was sent.
// ============================================================================

/**
 * Save a brief draft to the monthly_briefs table.
 * Returns the new row, including its id and saved_at timestamp.
 */
export async function saveMonthlyBrief({ monthKey, phase, narrative, dataSnapshot, authUser, notes }) {
  const { data, error } = await supabase
    .from('monthly_briefs')
    .insert({
      month_key: monthKey,
      phase,
      narrative,
      data_snapshot: dataSnapshot,
      saved_by: authUser?.id || null,
      saved_by_email: authUser?.email || null,
      notes: notes || null,
    })
    .select()
    .single()

  if (error) {
    console.error('saveMonthlyBrief:', error)
    throw error
  }
  return data
}

/**
 * List saved briefs for a (month_key, phase), most recent first.
 * Returns light rows (no data_snapshot) for fast listing.
 */
export async function listSavedBriefs({ monthKey, phase }) {
  const { data, error } = await supabase
    .from('monthly_briefs')
    .select('id, month_key, phase, narrative, saved_at, saved_by, saved_by_email, notes')
    .eq('month_key', monthKey)
    .eq('phase', phase)
    .order('saved_at', { ascending: false })

  if (error) {
    console.error('listSavedBriefs:', error)
    return []
  }
  return data || []
}

/**
 * Load a single saved brief by id, including the full data_snapshot.
 */
export async function loadSavedBrief(id) {
  const { data, error } = await supabase
    .from('monthly_briefs')
    .select('*')
    .eq('id', id)
    .single()

  if (error) {
    console.error('loadSavedBrief:', error)
    throw error
  }
  return data
}
