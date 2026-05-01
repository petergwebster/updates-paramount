// ============================================================================
// dailyOps.js — data access for sched_daily_ops
// ============================================================================
// Small, focused helpers around the daily ground-truth layer. Both the
// PassaicScheduler / BNYScheduler and the Live Ops tab use these; keeping
// them centralized means one query surface for Claude context wiring and
// one place to evolve the schema from.
//
// Phase A rewrite (May 1, 2026): day_of_week is now TEXT ('Sun'..'Sat')
// per Migration B2. The summary builder sorts by DAY_INDEX rather than
// numeric value, and labels days using their stored text directly.
// ============================================================================

import { supabase } from '../supabase'
import { isoDate, DAY_INDEX, DAY_NAMES_FULL } from './scheduleUtils'

// Fetch all daily_ops rows for a given (site, week_start). Returns [] if none.
export async function loadWeekDailyOps(site, weekStart) {
  const { data, error } = await supabase
    .from('sched_daily_ops')
    .select('*')
    .eq('site', site)
    .eq('week_start', isoDate(weekStart))
  if (error) { console.error('loadWeekDailyOps', error); return [] }
  return data || []
}

// Upsert one daily_ops row. Uses the unique (site, week, table, day, shift)
// key established by Migration B1. Pass only the fields you want to change —
// others are preserved.
export async function upsertDailyOp(row) {
  const payload = { ...row, updated_at: new Date().toISOString() }
  const { error } = await supabase
    .from('sched_daily_ops')
    .upsert(payload, { onConflict: 'site,week_start,table_code,day_of_week,shift' })
  if (error) { console.error('upsertDailyOp', error); throw error }
}

// Build a compact string summary of recent actuals for the AI context note.
// Returns something like:
//   "Friday:
//     GC-1: 150 planned / 120 actual (-30) · 5 waste · Angel Acevedo + Armando Acevedo · banding on grounds
//     ..."
// If no recent actuals exist, returns null (caller can omit the block).
//
// "Recent" means: of the days that have actuals in this week, take the
// latest `maxDaysBack` of them (Fri before Thu before Wed, etc.).
export function buildRecentActualsSummary(dailyOps, weekStart, maxDaysBack = 3) {
  if (!dailyOps || dailyOps.length === 0) return null

  // Only consider rows that have at least one meaningful data point
  const withData = dailyOps.filter(r =>
    r.actual_yards != null || r.waste_yards != null || r.planned_yards != null || (r.notes && r.notes.trim())
  )
  // For the AI, only rows where actuals were recorded are useful for variance
  const withActuals = withData.filter(r =>
    r.actual_yards != null || r.waste_yards != null || (r.notes && r.notes.trim())
  )
  if (withActuals.length === 0) return null

  // Group by day_of_week (text: 'Sun'..'Sat')
  const byDay = {}
  for (const r of withActuals) {
    const d = r.day_of_week
    if (!byDay[d]) byDay[d] = []
    byDay[d].push(r)
  }

  // Sort days by DAY_INDEX descending — latest day in the week first.
  // Unknown labels (defensive) sort to the end.
  const daysWithData = Object.keys(byDay).sort((a, b) => {
    const ia = DAY_INDEX[a] ?? -1
    const ib = DAY_INDEX[b] ?? -1
    return ib - ia
  })
  const daysToShow = daysWithData.slice(0, maxDaysBack)
  if (daysToShow.length === 0) return null

  const lines = []
  for (const d of daysToShow) {
    // Use the full name for readability ('Friday' vs 'Fri'). Fall back to
    // the raw label if it's somehow not in our map.
    const dayLabel = DAY_NAMES_FULL[d] || d
    lines.push(`${dayLabel}:`)
    for (const r of byDay[d]) {
      const parts = []
      if (r.planned_yards != null && r.actual_yards != null) {
        const delta = r.actual_yards - r.planned_yards
        const sign = delta > 0 ? '+' : ''
        parts.push(`${r.planned_yards} planned / ${r.actual_yards} actual (${sign}${delta})`)
      } else if (r.planned_yards != null) {
        parts.push(`${r.planned_yards} planned / — actual`)
      } else if (r.actual_yards != null) {
        parts.push(`${r.actual_yards} actual (no target set)`)
      }
      if (r.waste_yards != null && r.waste_yards > 0) parts.push(`${r.waste_yards} waste`)
      if (r.operator_1 || r.operator_2) {
        const ops = [r.operator_1, r.operator_2].filter(Boolean).join(' + ')
        parts.push(ops)
      }
      if (r.notes && r.notes.trim()) parts.push(`note: ${r.notes.trim()}`)
      // If shift is present and is 2nd, surface it — 1st is the implicit default.
      if (r.shift === '2nd') parts.push('2nd shift')
      lines.push(`  ${r.table_code}: ${parts.join(' · ') || '(no data)'}`)
    }
  }
  return lines.join('\n')
}
