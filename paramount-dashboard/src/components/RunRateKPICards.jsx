import React from 'react'
import styles from './RunRateKPICards.module.css'

/**
 * RunRateKPICards — 6 metric cards showing actual vs expected for the
 * current time window.
 *
 * Metrics: written · produced · color yards · waste · net yards · revenue
 *
 * Each card shows:
 *   - The metric label (small, uppercase)
 *   - The actual value (large, prominent)
 *   - The expected value (smaller, "vs 12,500 expected")
 *   - A delta with color (green / amber / red based on direction + magnitude)
 *
 * Phase 2b: takes pre-computed data from parent. Phase 2b's DashboardPage
 * computes the data; this component just renders it.
 *
 * Props:
 *   data: {
 *     written:    { actual, expected },
 *     produced:   { actual, expected },
 *     colorYards: { actual, expected },
 *     waste:      { actual, expected },     // for waste, lower is better
 *     netYards:   { actual, expected },
 *     revenue:    { actual, expected },     // dollars
 *   }
 *   timeWindow: 'today' | 'week' | 'month'
 */

const METRICS = [
  { id: 'written',    label: 'Yards Written',    formatter: numberFmt, lowerIsBetter: false, unit: 'yd' },
  { id: 'produced',   label: 'Yards Produced',   formatter: numberFmt, lowerIsBetter: false, unit: 'yd' },
  { id: 'colorYards', label: 'Color Yards',      formatter: numberFmt, lowerIsBetter: false, unit: 'cyd' },
  { id: 'waste',      label: 'Waste',            formatter: numberFmt, lowerIsBetter: true,  unit: 'yd' },
  { id: 'netYards',   label: 'Net Yards',        formatter: numberFmt, lowerIsBetter: false, unit: 'yd' },
  { id: 'revenue',    label: 'Revenue',          formatter: dollarFmt, lowerIsBetter: false, unit: '' },
]

export default function RunRateKPICards({ data, timeWindow }) {
  return (
    <div className={styles.grid}>
      {METRICS.map(metric => {
        const m = data?.[metric.id] || { actual: null, expected: null }
        return <Card key={metric.id} metric={metric} actual={m.actual} expected={m.expected} timeWindow={timeWindow} />
      })}
    </div>
  )
}

function Card({ metric, actual, expected, timeWindow }) {
  const hasActual = actual !== null && actual !== undefined && !Number.isNaN(actual)
  const hasExpected = expected !== null && expected !== undefined && !Number.isNaN(expected) && expected !== 0

  let delta = null
  let deltaPct = null
  let status = 'neutral'
  let deltaLabel = null

  if (hasActual && hasExpected) {
    delta = actual - expected
    deltaPct = (delta / expected) * 100

    // Status logic
    // For "lower is better" metrics like waste, sign is flipped
    const effective = metric.lowerIsBetter ? -delta : delta
    const effectivePct = metric.lowerIsBetter ? -deltaPct : deltaPct

    if (effective >= 0) {
      // Above expected (good direction)
      status = 'green'
    } else if (effectivePct >= -5) {
      // Within 5% under expected — close enough, amber
      status = 'amber'
    } else {
      // More than 5% under expected
      status = 'red'
    }

    const sign = delta > 0 ? '+' : ''
    deltaLabel = `${sign}${metric.formatter(delta)} (${sign}${deltaPct.toFixed(1)}%) vs expected`
  } else if (hasActual) {
    deltaLabel = 'No expected value set'
  } else {
    deltaLabel = 'No data yet'
  }

  return (
    <div className={`${styles.card} ${styles['card_' + status]}`}>
      <div className={styles.label}>{metric.label}</div>
      <div className={styles.actual}>
        {hasActual ? metric.formatter(actual) : '—'}
        {metric.unit && hasActual && <span className={styles.unit}>{metric.unit}</span>}
      </div>
      {hasExpected && (
        <div className={styles.expected}>
          {metric.formatter(expected)}{metric.unit ? ` ${metric.unit}` : ''} expected
        </div>
      )}
      <div className={`${styles.delta} ${styles['delta_' + status]}`}>
        {deltaLabel}
      </div>
    </div>
  )
}

// ─── formatters ─────────────────────────────────────────────────────────
function numberFmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return Math.round(n).toLocaleString()
}

function dollarFmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  if (Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(1)}k`
  }
  return `$${Math.round(n).toLocaleString()}`
}
