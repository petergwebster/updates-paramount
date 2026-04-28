import React, { useState, useEffect, useMemo } from 'react'
import { format, startOfWeek, startOfMonth } from 'date-fns'
import { supabase } from '../supabase'
import RunRateKPICards from './RunRateKPICards'
import styles from './WeekPaceStrip.module.css'

/**
 * WeekPaceStrip — a compact embedded "this week's pace" panel for the
 * Executive Dashboard. Shows the same 6 Run Rate KPI cards but in a
 * smaller-feeling section with a header explaining what it is.
 *
 * Reuses the RunRateKPICards component and the same metric calculation
 * logic from DashboardPage. Defaults to showing the WEEK view (current
 * week-to-date) since that's the most useful at-a-glance metric for execs.
 *
 * Why this exists: when execs land on the Executive Dashboard, they get
 * the weekly recap (last week, finalized). But many also want to know
 * "how is THIS week building" without toggling to Operations mode. This
 * strip gives them that signal inline.
 *
 * Props:
 *   weekStart  Date — Monday of the current week (passed from App.jsx)
 */

// Mirror the targets from DashboardPage. Yes, this is duplication —
// extracting to src/lib/targets.js is on the cleanup list.
const NJ_TARGETS = {
  fabric: { yards: 810,  colorYards: 4522,  invoiceYds: 772,  invoiceRev: 14112.75 },
  grass:  { yards: 3615, colorYards: 7570,  invoiceYds: 3538, invoiceRev: 36646 },
  paper:  { yards: 4185, colorYards: 13405, invoiceYds: 3516, invoiceRev: 26330.25 },
  wasteTarget: 10,
  totalYards: 8610,
  weeklyRevenue: 128951.25,
}
const BNY_TARGETS = {
  total: 12000,
  totalIncomeInvoiced: 132899.58,
}
const WEEKLY_TARGETS = {
  schYards: 5886,
  tpYards: 2564,
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

function sumProductionRow(row) {
  const result = { written: 0, produced: 0, colorYards: 0, waste: 0, netYards: 0, revenue: 0 }
  if (!row) return result

  const b = row.bny_data || {}
  const bnyProduced =
    toNum(b.replen) + toNum(b.mto) + toNum(b.hos) + toNum(b.memo) + toNum(b.contract)
  const bnyRevenue =
    toNum(b.incomeReplen) + toNum(b.incomeMto) + toNum(b.incomeHos) +
    toNum(b.incomeMemo) + toNum(b.incomeContract)
  const bnyWritten = toNum(b.schWritten) + toNum(b.tpWritten)

  const n = row.nj_data || {}
  const njProduced =
    toNum(n.fabric?.yards) + toNum(n.grass?.yards) + toNum(n.paper?.yards)
  const njColorYards =
    toNum(n.fabric?.colorYards) + toNum(n.grass?.colorYards) + toNum(n.paper?.colorYards)
  const njWaste =
    toNum(n.fabric?.waste) + toNum(n.grass?.waste) + toNum(n.paper?.waste)
  const njRevenue =
    toNum(n.fabric?.invoiceRev) + toNum(n.grass?.invoiceRev) + toNum(n.paper?.invoiceRev)
  const njWritten = toNum(n.schWritten) + toNum(n.tpWritten)

  result.produced = bnyProduced + njProduced
  result.colorYards = njColorYards
  result.waste = njWaste
  result.netYards = result.produced - result.waste
  result.revenue = bnyRevenue + njRevenue
  result.written = bnyWritten + njWritten
  return result
}

export default function WeekPaceStrip() {
  const today = useMemo(() => new Date(), [])
  const [productionRow, setProductionRow] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const currentWeekStart = startOfWeek(today, { weekStartsOn: 1 })
      const weekKey = format(currentWeekStart, 'yyyy-MM-dd')
      const { data } = await supabase
        .from('production')
        .select('week_start, nj_data, bny_data')
        .eq('week_start', weekKey)
        .single()
      if (!cancelled) {
        setProductionRow(data || null)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format(today, 'yyyy-MM-dd')])

  const cardData = useMemo(() => {
    const actuals = productionRow ? sumProductionRow(productionRow)
      : { written: 0, produced: 0, colorYards: 0, waste: 0, netYards: 0, revenue: 0 }
    const expected = {
      written:    WEEKLY_TARGETS.schYards + WEEKLY_TARGETS.tpYards,
      produced:   NJ_TARGETS.totalYards + BNY_TARGETS.total,
      colorYards: NJ_TARGETS.fabric.colorYards + NJ_TARGETS.grass.colorYards + NJ_TARGETS.paper.colorYards,
      waste:      (NJ_TARGETS.totalYards + BNY_TARGETS.total) * (NJ_TARGETS.wasteTarget / 100),
      netYards:   (NJ_TARGETS.totalYards + BNY_TARGETS.total) * (1 - NJ_TARGETS.wasteTarget / 100),
      revenue:    NJ_TARGETS.weeklyRevenue + BNY_TARGETS.totalIncomeInvoiced,
    }
    return {
      written:    { actual: actuals.written,    expected: expected.written },
      produced:   { actual: actuals.produced,   expected: expected.produced },
      colorYards: { actual: actuals.colorYards, expected: expected.colorYards },
      waste:      { actual: actuals.waste,      expected: expected.waste },
      netYards:   { actual: actuals.netYards,   expected: expected.netYards },
      revenue:    { actual: actuals.revenue,    expected: expected.revenue },
    }
  }, [productionRow])

  const currentWeekStart = startOfWeek(today, { weekStartsOn: 1 })

  return (
    <div className={styles.strip}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>This week's pace</div>
          <div className={styles.title}>
            Week of {format(currentWeekStart, 'MMM d')} · how we're tracking right now
          </div>
        </div>
        <div className={styles.hint}>
          For full Run Rate detail with Today / Week / Month and Claude's read,
          toggle to <strong>Operations</strong> mode → Dashboard.
        </div>
      </div>
      {loading ? (
        <div className={styles.loadingState}>Loading current week pace…</div>
      ) : (
        <RunRateKPICards data={cardData} timeWindow="week" />
      )}
    </div>
  )
}
