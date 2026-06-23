/**
 * historicalSummaries.js — Rolls up production data into tiered summaries.
 *
 * The dashboard's contextBuilder uses tiered freshness:
 *   - Last 4 weeks: raw data (queried directly from `weeks` + `production`)
 *   - Last 13 weeks: weekly summaries (this module generates them)
 *   - Last 12 months: monthly summaries
 *   - Last 3 years: quarterly summaries
 *
 * Each rollup is generated when the underlying period ages out of the
 * detail tier. Idempotent: re-running on a period that already exists
 * just refreshes its values.
 *
 * Phase 2a: this module exposes refreshSummariesIfNeeded() which the
 * Dashboard page calls on first load each day. It checks for missing
 * periods and generates them. Cheap if everything's up to date.
 *
 * Phase 4 (eventually) might add a scheduled function that runs nightly
 * instead of relying on user page-loads to trigger it.
 *
 * ── Fiscal week alignment (bugfix June 23, 2026) ─────────────────────────
 * production week_start values are SUNDAY-dated (e.g. 2026-05-31). Callers
 * here pass Monday anchors (subWeeks(thisMonday, i)). The old code looked up
 * production with .eq('week_start', <Monday>), which NEVER matched the
 * Sunday-dated rows — so weekly summaries were essentially never generated,
 * and the monthly/quarterly rollups built on top of nothing.
 *
 * Fix:
 *   - ensureWeeklySummary looks up production at the SUNDAY key (Monday − 1),
 *     with a Monday fallback, and stores period_start as that resolved key.
 *   - Monthly/quarterly rollups widen their query window and group children by
 *     fiscal month/quarter via fiscalMonthOf(), so a Sunday-dated first week
 *     (e.g. fiscal June's 2026-05-31) is no longer dropped at the boundary.
 */

import {
  format, subWeeks, subMonths, startOfWeek, startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter, startOfYear, endOfYear, getQuarter, getYear,
  differenceInDays,
} from 'date-fns'
import { supabase } from '../supabase'
import { getFiscalInfo } from '../fiscalCalendar'

// ────────────────────────────────────────────────────────────────────────
// Helper — coerce JSON values to finite numbers (production fields are strings)
// ────────────────────────────────────────────────────────────────────────

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

// ────────────────────────────────────────────────────────────────────────
// Helper — fiscal lookup normalized for Sunday-dated keys
// ────────────────────────────────────────────────────────────────────────
// production/summary period_start values are Sunday-dated; FISCAL_CALENDAR is
// keyed on the Monday one day later. Try the exact key, then retry at +1 day.
function fiscalMonthOf(dateStr) {
  if (!dateStr) return null
  let info = getFiscalInfo(dateStr)
  if (info) return info
  const iso = typeof dateStr === 'string' ? dateStr : format(dateStr, 'yyyy-MM-dd')
  const d = new Date(iso + 'T12:00:00')
  if (isNaN(d.getTime())) return null
  d.setDate(d.getDate() + 1)
  return getFiscalInfo(format(d, 'yyyy-MM-dd'))
}

// ────────────────────────────────────────────────────────────────────────
// Helper — sum a week's production into a flat structure
// ────────────────────────────────────────────────────────────────────────

function summarizeWeekProduction(productionRow) {
  const result = {
    bny_yards: 0,
    passaic_yards: 0,
    total_yards: 0,
    color_yards: 0,
    waste_yards: 0,
    net_yards: 0,
  }

  // BNY shape: bny_data.{replen,mto,hos,memo,contract} = string number directly.
  // (Earlier code read b.replen?.actual which was always undefined.)
  if (productionRow?.bny_data) {
    const b = productionRow.bny_data
    result.bny_yards =
      num(b.replen) + num(b.mto) + num(b.hos) + num(b.memo) + num(b.contract)
  }

  // NJ shape: nj_data.{fabric,grass,paper}.{yards,colorYards,waste}
  // Values are strings — must num()-coerce or else `0 + "9483"` becomes "09483"
  // and accumulates as a string for the entire month, blowing up on display.
  if (productionRow?.nj_data) {
    const n = productionRow.nj_data
    result.passaic_yards =
      num(n.fabric?.yards) + num(n.grass?.yards) + num(n.paper?.yards)
    result.color_yards =
      num(n.fabric?.colorYards) + num(n.grass?.colorYards) + num(n.paper?.colorYards)
    result.waste_yards =
      num(n.fabric?.waste) + num(n.grass?.waste) + num(n.paper?.waste)
  }

  result.total_yards = result.bny_yards + result.passaic_yards
  result.net_yards = result.total_yards - result.waste_yards
  return result
}

// ────────────────────────────────────────────────────────────────────────
// Weekly summaries
// ────────────────────────────────────────────────────────────────────────

async function ensureWeeklySummary(weekStart) {
  // Callers pass a Monday anchor, but production rows are Sunday-dated (the
  // Sunday BEFORE that Monday). Resolve the actual data key: try Sunday first,
  // then fall back to the Monday in case any rows are Monday-dated.
  const mondayStr = format(weekStart, 'yyyy-MM-dd')
  const sundayDate = new Date(weekStart)
  sundayDate.setDate(sundayDate.getDate() - 1)
  const sundayStr = format(sundayDate, 'yyyy-MM-dd')

  // Pull the production row for this week — match Sunday or Monday key
  const { data: prodRows } = await supabase
    .from('production')
    .select('week_start, bny_data, nj_data')
    .in('week_start', [sundayStr, mondayStr])
    .order('week_start', { ascending: true })

  const production = prodRows && prodRows[0]
  if (!production) return  // Nothing to summarize

  // Use the row's actual stored key as period_start, so monthly rollups can
  // resolve its fiscal month correctly via fiscalMonthOf().
  const resolvedKey = production.week_start
  const resolvedStart = new Date(resolvedKey + 'T12:00:00')
  const weekEndDate = new Date(resolvedStart)
  weekEndDate.setDate(weekEndDate.getDate() + 6)
  const weekEndStr = format(weekEndDate, 'yyyy-MM-dd')

  const summary = summarizeWeekProduction(production)
  const wastePct = summary.total_yards > 0
    ? Number((100 * summary.waste_yards / summary.total_yards).toFixed(2))
    : null

  const periodLabel = `Week of ${format(resolvedStart, 'MMM d, yyyy')}`

  await supabase.from('historical_summaries').upsert({
    period_type:            'weekly',
    period_start:           resolvedKey,
    period_end:             weekEndStr,
    period_label:           periodLabel,
    bny_yards_produced:     summary.bny_yards,
    passaic_yards_produced: summary.passaic_yards,
    total_yards_produced:   summary.total_yards,
    total_color_yards:      summary.color_yards,
    total_waste_yards:      summary.waste_yards,
    waste_pct:              wastePct,
    net_yards_produced:     summary.net_yards,
    generated_at:           new Date().toISOString(),
  }, {
    onConflict: 'period_type,period_start',
  })
}

// ────────────────────────────────────────────────────────────────────────
// Monthly summaries — aggregate weeks within a FISCAL month
// ────────────────────────────────────────────────────────────────────────

async function ensureMonthlySummary(monthStart) {
  // Calendar bounds for the upsert key/label...
  const monthStartStr = format(startOfMonth(monthStart), 'yyyy-MM-dd')
  const monthEndStr   = format(endOfMonth(monthStart), 'yyyy-MM-dd')
  const targetMonthAbbr = format(startOfMonth(monthStart), 'MMM')   // e.g. "Jun"

  // ...but pull weekly summaries with a widened window so Sunday-dated
  // period_start values just before the month boundary are included, then
  // filter to the correct fiscal month.
  const queryStart = new Date(startOfMonth(monthStart))
  queryStart.setDate(queryStart.getDate() - 3)
  const queryStartStr = format(queryStart, 'yyyy-MM-dd')
  const queryEnd = new Date(endOfMonth(monthStart))
  queryEnd.setDate(queryEnd.getDate() + 3)
  const queryEndStr = format(queryEnd, 'yyyy-MM-dd')

  const { data: weekliesRaw } = await supabase
    .from('historical_summaries')
    .select('*')
    .eq('period_type', 'weekly')
    .gte('period_start', queryStartStr)
    .lte('period_start', queryEndStr)

  const weeklies = (weekliesRaw || [])
    .filter(w => fiscalMonthOf(w.period_start)?.month === targetMonthAbbr)

  if (!weeklies || weeklies.length === 0) return

  const totals = weeklies.reduce((acc, w) => {
    acc.bny += w.bny_yards_produced || 0
    acc.passaic += w.passaic_yards_produced || 0
    acc.total += w.total_yards_produced || 0
    acc.color += w.total_color_yards || 0
    acc.waste += w.total_waste_yards || 0
    acc.net += w.net_yards_produced || 0
    return acc
  }, { bny: 0, passaic: 0, total: 0, color: 0, waste: 0, net: 0 })

  const wastePct = totals.total > 0
    ? Number((100 * totals.waste / totals.total).toFixed(2))
    : null

  const periodLabel = format(monthStart, 'MMMM yyyy')

  await supabase.from('historical_summaries').upsert({
    period_type:            'monthly',
    period_start:           monthStartStr,
    period_end:             monthEndStr,
    period_label:           periodLabel,
    bny_yards_produced:     totals.bny,
    passaic_yards_produced: totals.passaic,
    total_yards_produced:   totals.total,
    total_color_yards:      totals.color,
    total_waste_yards:      totals.waste,
    waste_pct:              wastePct,
    net_yards_produced:     totals.net,
    generated_at:           new Date().toISOString(),
  }, {
    onConflict: 'period_type,period_start',
  })
}

// ────────────────────────────────────────────────────────────────────────
// Quarterly summaries
// ────────────────────────────────────────────────────────────────────────

async function ensureQuarterlySummary(qStart) {
  const qStartStr = format(startOfQuarter(qStart), 'yyyy-MM-dd')
  const qEndStr   = format(endOfQuarter(qStart), 'yyyy-MM-dd')

  // Monthly summaries are keyed by calendar startOfMonth, so a straight
  // calendar-quarter range captures them correctly. Widen slightly for safety
  // against any month-boundary drift, then keep only months that start within
  // this calendar quarter.
  const queryStart = new Date(startOfQuarter(qStart))
  queryStart.setDate(queryStart.getDate() - 3)
  const queryStartStr = format(queryStart, 'yyyy-MM-dd')
  const queryEnd = new Date(endOfQuarter(qStart))
  queryEnd.setDate(queryEnd.getDate() + 3)
  const queryEndStr = format(queryEnd, 'yyyy-MM-dd')

  const { data: monthliesRaw } = await supabase
    .from('historical_summaries')
    .select('*')
    .eq('period_type', 'monthly')
    .gte('period_start', queryStartStr)
    .lte('period_start', queryEndStr)

  const qStartBound = startOfQuarter(qStart)
  const qEndBound = endOfQuarter(qStart)
  const monthlies = (monthliesRaw || []).filter(m => {
    const d = new Date(m.period_start + 'T12:00:00')
    return d >= qStartBound && d <= qEndBound
  })

  if (!monthlies || monthlies.length === 0) return

  const totals = monthlies.reduce((acc, m) => {
    acc.bny += m.bny_yards_produced || 0
    acc.passaic += m.passaic_yards_produced || 0
    acc.total += m.total_yards_produced || 0
    acc.color += m.total_color_yards || 0
    acc.waste += m.total_waste_yards || 0
    acc.net += m.net_yards_produced || 0
    return acc
  }, { bny: 0, passaic: 0, total: 0, color: 0, waste: 0, net: 0 })

  const wastePct = totals.total > 0
    ? Number((100 * totals.waste / totals.total).toFixed(2))
    : null

  const quarter = getQuarter(qStart)
  const year = getYear(qStart)
  const periodLabel = `Q${quarter} ${year}`

  await supabase.from('historical_summaries').upsert({
    period_type:            'quarterly',
    period_start:           qStartStr,
    period_end:             qEndStr,
    period_label:           periodLabel,
    bny_yards_produced:     totals.bny,
    passaic_yards_produced: totals.passaic,
    total_yards_produced:   totals.total,
    total_color_yards:      totals.color,
    total_waste_yards:      totals.waste,
    waste_pct:              wastePct,
    net_yards_produced:     totals.net,
    generated_at:           new Date().toISOString(),
  }, {
    onConflict: 'period_type,period_start',
  })
}

// ────────────────────────────────────────────────────────────────────────
// Public API — call this when the dashboard loads to ensure summaries exist
// ────────────────────────────────────────────────────────────────────────

/**
 * Refreshes any historical summaries that are missing or out of date.
 * Designed to be cheap-when-up-to-date so it can run on every dashboard
 * page load. The first time it runs after a week ages out, it does
 * meaningful work; subsequent runs are no-ops.
 *
 * Strategy:
 *   1. For the last 13 weeks ending 4 weeks ago, ensure weekly summaries exist
 *   2. For the last 12 months ending last month, ensure monthly summaries exist
 *   3. For the last 12 quarters ending last quarter, ensure quarterly summaries exist
 *
 * Each ensure-* is an upsert, so re-running on existing rows just refreshes them
 * (which is fine — no harm, and useful if production data was edited retroactively).
 *
 * Throttled via localStorage so it only actually runs once per day per user.
 */
export async function refreshSummariesIfNeeded() {
  // Throttle: only run once per calendar day
  const today = format(new Date(), 'yyyy-MM-dd')
  const lastRun = localStorage.getItem('pp_summaries_last_run')
  if (lastRun === today) return { skipped: true, reason: 'already-run-today' }

  try {
    const now = new Date()
    const thisMonday = startOfWeek(now, { weekStartsOn: 1 })

    // Weekly summaries — refresh the last 13 weeks
    // (we refresh recent ones too in case underlying production data was edited)
    const weeklyTasks = []
    for (let i = 1; i <= 13; i++) {
      weeklyTasks.push(ensureWeeklySummary(subWeeks(thisMonday, i)))
    }
    await Promise.all(weeklyTasks)

    // Monthly summaries — refresh the last 13 months
    const monthlyTasks = []
    for (let i = 1; i <= 13; i++) {
      monthlyTasks.push(ensureMonthlySummary(subMonths(now, i)))
    }
    await Promise.all(monthlyTasks)

    // Quarterly summaries — refresh the last 12 quarters
    const quarterlyTasks = []
    for (let i = 1; i <= 12; i++) {
      const q = new Date(now)
      q.setMonth(q.getMonth() - (3 * i))
      quarterlyTasks.push(ensureQuarterlySummary(q))
    }
    await Promise.all(quarterlyTasks)

    localStorage.setItem('pp_summaries_last_run', today)
    return { skipped: false, weekly: weeklyTasks.length, monthly: monthlyTasks.length, quarterly: quarterlyTasks.length }
  } catch (e) {
    console.warn('refreshSummariesIfNeeded: error', e)
    return { skipped: false, error: e.message }
  }
}

/**
 * Force-refresh a single weekly summary. Useful when admin saves
 * production data — call this to keep the rollup current.
 *
 * Phase 2b: AdminPanel saveProduction can optionally call this.
 * Phase 2a: just exposed for future use.
 */
export async function refreshWeeklySummary(weekStart) {
  return ensureWeeklySummary(weekStart)
}
