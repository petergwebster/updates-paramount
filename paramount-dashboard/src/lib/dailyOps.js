// ============================================================================
// dailyOps.js — data access for sched_daily_ops
// ============================================================================
// Small, focused helpers around the daily ground-truth layer. Both the
// PassaicScheduler / BNYScheduler and the Live Ops tab use these; keeping
// them centralized means one query surface for Claude context wiring and
// one place to evolve the schema from.
// ============================================================================

import { supabase } from '../supabase'
import { isoDate, addDays, dayOfWeekFiscal, DAY_NAMES_SHORT } from './scheduleUtils'

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

// Upsert one daily_ops row. Uses the unique (site, week, table, day) key.
// Pass only the fields you want to change — others are preserved.
export async function upsertDailyOp(row) {
  const payload = { ...row, updated_at: new Date().toISOString() }
  const { error } = await supabase
    .from('sched_daily_ops')
    .upsert(payload, { onConflict: 'site,week_start,table_code,day_of_week' })
  if (error) { console.error('upsertDailyOp', error); throw error }
}

// Build a compact string summary of recent actuals for the AI context note.
// Returns something like:
//   "Mon:\n  GC-1: 150 planned / 120 actual (-30) · 5 waste · Angel Acevedo + Armando Acevedo · banding on grounds\n  ..."
// If no recent actuals exist, returns null (caller can omit the block).
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

  const byDay = {}
  for (const r of withActuals) {
    const d = r.day_of_week
    if (!byDay[d]) byDay[d] = []
    byDay[d].push(r)
  }
  const daysWithData = Object.keys(byDay).map(Number).sort((a, b) => b - a)
  const daysToShow = daysWithData.slice(0, maxDaysBack)
  if (daysToShow.length === 0) return null

  const lines = []
  for (const d of daysToShow) {
    const dayLabel = DAY_NAMES_SHORT[d] || `d${d}`
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
      lines.push(`  ${r.table_code}: ${parts.join(' · ') || '(no data)'}`)
    }
  }
  return lines.join('\n')
}
