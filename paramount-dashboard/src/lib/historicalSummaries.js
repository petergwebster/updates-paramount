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
 */

import {
  format, subWeeks, subMonths, startOfWeek, startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter, startOfYear, endOfYear, getQuarter, getYear,
  differenceInDays,
} from 'date-fns'
import { supabase } from '../supabase'

// ─────────────────────────────────────────────────────────────────────────────
// Helper — sum a week's production into a flat structure
// ─────────────────────────────────────────────────────────────────────────────

function summarizeWeekProduction(productionRow) {
  const result = {
    bny_yards: 0,
    passaic_yards: 0,
    total_yards: 0,
    color_yards: 0,
    waste_yards: 0,
    net_yards: 0,
  }

  if (productionRow?.bny_data) {
    const b = productionRow.bny_data
    result.bny_yards =
      (b.replen?.actual || 0) + (b.mto?.actual || 0) +
      (b.hos?.actual || 0)    + (b.memo?.actual || 0) +
      (b.contract?.actual || 0)
  }

  if (productionRow?.nj_data) {
    const n = productionRow.nj_data
    result.passaic_yards =
      (n.fabric?.yards || 0) + (n.grass?.yards || 0) + (n.paper?.yards || 0)
    result.color_yards =
      (n.fabric?.colorYards || 0) + (n.grass?.colorYards || 0) + (n.paper?.colorYards || 0)
    result.waste_yards =
      (n.fabric?.waste || 0) + (n.grass?.waste || 0) + (n.paper?.waste || 0)
  }

  result.total_yards = result.bny_yards + result.passaic_yards
  result.net_yards = result.total_yards - result.waste_yards
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly summaries
// ─────────────────────────────────────────────────────────────────────────────

async function ensureWeeklySummary(weekStart) {
  const weekStartStr = format(weekStart, 'yyyy-MM-dd')
  const weekEndDate = new Date(weekStart)
  weekEndDate.setDate(weekEndDate.getDate() + 4)
  const weekEndStr = format(weekEndDate, 'yyyy-MM-dd')

  // Pull the production row for this week
  const { data: production } = await supabase
    .from('production')
    .select('bny_data, nj_data')
    .eq('week_start', weekStartStr)
    .single()

  if (!production) return  // Nothing to summarize

  const summary = summarizeWeekProduction(production)
  const wastePct = summary.total_yards > 0
    ? Number((100 * summary.waste_yards / summary.total_yards).toFixed(2))
    : null

  const periodLabel = `Week of ${format(weekStart, 'MMM d, yyyy')}`

  await supabase.from('historical_summaries').upsert({
    period_type:            'weekly',
    period_start:           weekStartStr,
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

// ─────────────────────────────────────────────────────────────────────────────
// Monthly summaries — aggregate weeks within a calendar month
// ─────────────────────────────────────────────────────────────────────────────

async function ensureMonthlySummary(monthStart) {
  const monthStartStr = format(startOfMonth(monthStart), 'yyyy-MM-dd')
  const monthEndStr   = format(endOfMonth(monthStart), 'yyyy-MM-dd')

  // Pull all weekly summaries in this month
  const { data: weeklies } = await supabase
    .from('historical_summaries')
    .select('*')
    .eq('period_type', 'weekly')
    .gte('period_start', monthStartStr)
    .lte('period_start', monthEndStr)

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

// ─────────────────────────────────────────────────────────────────────────────
// Quarterly summaries
// ─────────────────────────────────────────────────────────────────────────────

async function ensureQuarterlySummary(qStart) {
  const qStartStr = format(startOfQuarter(qStart), 'yyyy-MM-dd')
  const qEndStr   = format(endOfQuarter(qStart), 'yyyy-MM-dd')

  const { data: monthlies } = await supabase
    .from('historical_summaries')
    .select('*')
    .eq('period_type', 'monthly')
    .gte('period_start', qStartStr)
    .lte('period_start', qEndStr)

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

// ─────────────────────────────────────────────────────────────────────────────
// Public API — call this when the dashboard loads to ensure summaries exist
// ─────────────────────────────────────────────────────────────────────────────

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
