import React, { useState, useEffect, useMemo } from 'react'
import { format, startOfWeek, startOfMonth } from 'date-fns'
import { supabase } from '../supabase'
import { refreshSummariesIfNeeded } from '../lib/historicalSummaries'
import RunRateKPICards from './RunRateKPICards'
import ClaudeReadBlock from './ClaudeReadBlock'
import styles from './DashboardPage.module.css'

/**
 * DashboardPage — the new Run Rate dashboard.
 *
 * Replaces the old ConsolidatedPage / ExecutiveDashboardPage in App.jsx.
 *
 * Top-level structure:
 *   - Page header (title + date)
 *   - Run Rate toggle: Today / Week / Month
 *   - 6 KPI cards (written, produced, color yards, waste, net yards, revenue)
 *     showing actual vs expected for the selected window
 *   - Claude's read — auto-generated, editable, regen-able narrative
 *   - "Last week same time" comparison block (week + month windows only)
 *
 * Time windows defined as:
 *   today  → today's date specifically
 *   week   → current Monday through today (week-to-date)
 *   month  → current month start through today (month-to-date)
 *
 * Data flow:
 *   1. On mount, kick off refreshSummariesIfNeeded() in background
 *   2. Compute actuals from production rows for the selected window
 *   3. Compute expected from constants (NJ_TARGETS, BNY_TARGETS, WEEKLY_TARGETS)
 *      scaled to the time window (e.g., today's expected = weekly target / 5)
 *   4. Pass to KPI cards + ClaudeReadBlock
 *
 * Props:
 *   currentUser  string (full name)
 *   userId       string (auth user UUID)
 *   weekStart    Date (Monday of current week — passed from App.jsx)
 */

// These targets mirror those in AdminPanel.jsx — single source of truth would
// be nice, but extracting now is a refactor we'll do later.
const NJ_TARGETS = {
  fabric: { yards: 810,  colorYards: 4522,  invoiceYds: 772,  invoiceRev: 14112.75 },
  grass:  { yards: 3615, colorYards: 7570,  invoiceYds: 3538, invoiceRev: 36646 },
  paper:  { yards: 4185, colorYards: 13405, invoiceYds: 3516, invoiceRev: 26330.25 },
  wasteTarget: 10,  // 10% waste target
  totalYards: 8610,
  totalInvoiceYds: 7826,
  weeklyRevenue: 128951.25,
}

const BNY_TARGETS = {
  replen: 7886, mto: 1280, hos: 1532, memo: 211, contract: 1091,
  total: 12000,
  incomeReplen: 90675.83, incomeMto: 14398.5, incomeHos: 10727.25,
  incomeMemo: 4010.5, incomeContract: 13087.5,
  totalIncomeInvoiced: 132899.58,
}

const WEEKLY_TARGETS = {
  schRevenue: 106645,
  schYards: 5886,
  tpRevenue: 31277,
  tpYards: 2564,
}

// Production days per week — used to scale targets
const PROD_DAYS_PER_WEEK = 5
const PROD_WEEKS_PER_MONTH = 4.33

// ─────────────────────────────────────────────────────────────────────────────
// Compute actuals + expected for a time window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the metric data object for a given time window.
 * Uses production data already fetched by useDashboardData.
 */
function buildMetrics({ timeWindow, productionRows, today }) {
  // Identify which rows fall in the selected window
  // Each row in productionRows is a week (week_start in the row).
  // Within each week, nj_data and bny_data hold totals for that whole week —
  // we don't have per-day production data in 2b, so for "today" we approximate.

  // For today: take the current week's production, scaled to days elapsed
  // (best approximation without per-day data)
  // For week: current week's totals to date (sum of current week's row)
  // For month: sum all production rows in current month

  let actuals = { written: 0, produced: 0, colorYards: 0, waste: 0, netYards: 0, revenue: 0 }
  let expected = { written: 0, produced: 0, colorYards: 0, waste: 0, netYards: 0, revenue: 0 }
  let scopeLabel = ''

  // Build current-week production from current-week row (if present)
  const currentWeekStart = startOfWeek(today, { weekStartsOn: 1 })
  const currentWeekKey = format(currentWeekStart, 'yyyy-MM-dd')
  const currentMonthStart = startOfMonth(today)

  const currentWeekRow = productionRows.find(r => r.week_start === currentWeekKey)

  if (timeWindow === 'today') {
    scopeLabel = format(today, 'EEEE, MMMM d')
    // Approximate today's production as 1/5 of current week's totals
    if (currentWeekRow) {
      const wk = sumProductionRow(currentWeekRow)
      const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay() // Mon=1..Sun=7
      const daysElapsed = Math.min(dayOfWeek, 5) // cap at 5 weekdays
      // Rough split: actual today = total_so_far_this_week / days_elapsed
      // (since we don't track per-day actuals). This gives an "average pace" view.
      actuals.produced = Math.round(wk.produced / daysElapsed) || 0
      actuals.colorYards = Math.round(wk.colorYards / daysElapsed) || 0
      actuals.waste = Math.round(wk.waste / daysElapsed) || 0
      actuals.netYards = actuals.produced - actuals.waste
      actuals.written = Math.round(wk.written / daysElapsed) || 0
      actuals.revenue = Math.round(wk.revenue / daysElapsed) || 0
    }
    // Expected per day = weekly / 5
    expected.written  = (WEEKLY_TARGETS.schYards + WEEKLY_TARGETS.tpYards) / PROD_DAYS_PER_WEEK
    expected.produced = (NJ_TARGETS.totalYards + BNY_TARGETS.total) / PROD_DAYS_PER_WEEK
    expected.colorYards = (NJ_TARGETS.fabric.colorYards + NJ_TARGETS.grass.colorYards + NJ_TARGETS.paper.colorYards) / PROD_DAYS_PER_WEEK
    expected.waste = expected.produced * (NJ_TARGETS.wasteTarget / 100)
    expected.netYards = expected.produced - expected.waste
    expected.revenue = (NJ_TARGETS.weeklyRevenue + BNY_TARGETS.totalIncomeInvoiced) / PROD_DAYS_PER_WEEK
  }
  else if (timeWindow === 'week') {
    scopeLabel = `Week of ${format(currentWeekStart, 'MMM d')}`
    if (currentWeekRow) {
      const wk = sumProductionRow(currentWeekRow)
      actuals = wk
    }
    expected.written  = WEEKLY_TARGETS.schYards + WEEKLY_TARGETS.tpYards
    expected.produced = NJ_TARGETS.totalYards + BNY_TARGETS.total
    expected.colorYards = NJ_TARGETS.fabric.colorYards + NJ_TARGETS.grass.colorYards + NJ_TARGETS.paper.colorYards
    expected.waste = expected.produced * (NJ_TARGETS.wasteTarget / 100)
    expected.netYards = expected.produced - expected.waste
    expected.revenue = NJ_TARGETS.weeklyRevenue + BNY_TARGETS.totalIncomeInvoiced
  }
  else if (timeWindow === 'month') {
    scopeLabel = format(currentMonthStart, 'MMMM yyyy')
    // Sum production rows whose week_start is in current month
    const monthRows = productionRows.filter(r => {
      const rowDate = new Date(r.week_start + 'T00:00:00')
      return rowDate >= currentMonthStart && rowDate <= today
    })
    actuals = monthRows.reduce((acc, r) => {
      const wk = sumProductionRow(r)
      return {
        written: acc.written + wk.written,
        produced: acc.produced + wk.produced,
        colorYards: acc.colorYards + wk.colorYards,
        waste: acc.waste + wk.waste,
        netYards: acc.netYards + wk.netYards,
        revenue: acc.revenue + wk.revenue,
      }
    }, { written: 0, produced: 0, colorYards: 0, waste: 0, netYards: 0, revenue: 0 })

    // Expected = weekly * weeks elapsed in month
    const weeksElapsed = monthRows.length || 1
    expected.written  = (WEEKLY_TARGETS.schYards + WEEKLY_TARGETS.tpYards) * weeksElapsed
    expected.produced = (NJ_TARGETS.totalYards + BNY_TARGETS.total) * weeksElapsed
    expected.colorYards = (NJ_TARGETS.fabric.colorYards + NJ_TARGETS.grass.colorYards + NJ_TARGETS.paper.colorYards) * weeksElapsed
    expected.waste = expected.produced * (NJ_TARGETS.wasteTarget / 100)
    expected.netYards = expected.produced - expected.waste
    expected.revenue = (NJ_TARGETS.weeklyRevenue + BNY_TARGETS.totalIncomeInvoiced) * weeksElapsed
  }

  return {
    actuals,
    expected,
    scopeLabel,
    cardData: {
      written:    { actual: actuals.written,    expected: expected.written },
      produced:   { actual: actuals.produced,   expected: expected.produced },
      colorYards: { actual: actuals.colorYards, expected: expected.colorYards },
      waste:      { actual: actuals.waste,      expected: expected.waste },
      netYards:   { actual: actuals.netYards,   expected: expected.netYards },
      revenue:    { actual: actuals.revenue,    expected: expected.revenue },
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sum a single production row into flat metrics
// ─────────────────────────────────────────────────────────────────────────────
function sumProductionRow(row) {
  const result = { written: 0, produced: 0, colorYards: 0, waste: 0, netYards: 0, revenue: 0 }
  if (!row) return result

  // BNY side
  const b = row.bny_data || {}
  const bnyProduced =
    toNum(b.replen) + toNum(b.mto) + toNum(b.hos) + toNum(b.memo) + toNum(b.contract)
  const bnyRevenue =
    toNum(b.incomeReplen) + toNum(b.incomeMto) + toNum(b.incomeHos) +
    toNum(b.incomeMemo) + toNum(b.incomeContract)
  const bnyWritten = toNum(b.schWritten) + toNum(b.tpWritten)

  // Passaic side
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
  result.colorYards = njColorYards  // BNY doesn't track color yards
  result.waste = njWaste             // primary waste tracking is NJ side
  result.netYards = result.produced - result.waste
  result.revenue = bnyRevenue + njRevenue
  result.written = bnyWritten + njWritten

  return result
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: load production data for current week + month
// ─────────────────────────────────────────────────────────────────────────────
function useDashboardData(today) {
  const [productionRows, setProductionRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      // Fetch all production rows from current month start through today.
      // We need the full month for the "month" window calculation.
      const monthStartKey = format(startOfMonth(today), 'yyyy-MM-dd')
      const todayKey = format(today, 'yyyy-MM-dd')

      const { data } = await supabase
        .from('production')
        .select('week_start, nj_data, bny_data')
        .gte('week_start', monthStartKey)
        .lte('week_start', todayKey)
        .order('week_start', { ascending: true })

      if (!cancelled) {
        setProductionRows(data || [])
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [format(today, 'yyyy-MM-dd')])

  return { productionRows, loading }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function DashboardPage({ currentUser, userId, weekStart }) {
  const [timeWindow, setTimeWindow] = useState('week')
  const today = useMemo(() => new Date(), [])

  const { productionRows, loading } = useDashboardData(today)

  // Trigger background summary refresh once per day
  useEffect(() => {
    refreshSummariesIfNeeded()
  }, [])

  const metrics = useMemo(() => {
    return buildMetrics({ timeWindow, productionRows, today })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeWindow, productionRows, format(today, 'yyyy-MM-dd')])

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.eyebrow}>Operations</div>
        <h1 className={styles.title}>Run Rate</h1>
        <div className={styles.subtitle}>
          {metrics.scopeLabel} · actuals against scheduler/budget expectations
        </div>
      </div>

      <div className={styles.toggleRow}>
        <div className={styles.toggle}>
          {[
            { id: 'today', label: 'Today' },
            { id: 'week',  label: 'Week' },
            { id: 'month', label: 'Month' },
          ].map(opt => (
            <button
              key={opt.id}
              className={`${styles.toggleBtn} ${timeWindow === opt.id ? styles.toggleBtnActive : ''}`}
              onClick={() => setTimeWindow(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {timeWindow === 'today' && (
        <div className={styles.todayNote}>
          <strong>Note:</strong> Per-day actuals are not yet tracked separately.
          "Today" shows an average pace based on this week's totals divided by days elapsed.
          Once daily entry is wired up, this will reflect today's actual numbers.
        </div>
      )}

      {loading ? (
        <div className={styles.loadingState}>Loading dashboard data…</div>
      ) : (
        <>
          <RunRateKPICards data={metrics.cardData} timeWindow={timeWindow} />

          <ClaudeReadBlock
            weekStart={weekStart}
            timeWindow={timeWindow}
            currentData={{
              actuals: metrics.actuals,
              expected: metrics.expected,
              gaps: gapAnalysis(metrics.actuals, metrics.expected),
            }}
            currentUser={currentUser}
            userId={userId}
          />
        </>
      )}
    </div>
  )
}

function gapAnalysis(actuals, expected) {
  const gaps = {}
  Object.keys(actuals).forEach(k => {
    const a = actuals[k] || 0
    const e = expected[k] || 0
    if (e === 0) return
    const delta = a - e
    const pct = (delta / e) * 100
    gaps[k] = `${delta >= 0 ? '+' : ''}${Math.round(delta).toLocaleString()} (${delta >= 0 ? '+' : ''}${pct.toFixed(1)}%)`
  })
  return gaps
}
