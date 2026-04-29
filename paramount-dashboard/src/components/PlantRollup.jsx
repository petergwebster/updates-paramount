import React from 'react'
import styles from './PlantRollup.module.css'

/**
 * PlantRollup — three headline cards at the top of Heartbeat.
 *
 * Cards:
 *   1. Yards — the revenue unit (what gets invoiced)
 *   2. Color-Yards — the labor unit (what it costs)
 *   3. Complexity Ratio — color-yards ÷ yards = the cost-revenue gap
 *
 * Each card shows two layers (Budget vs Actual). The third layer (Scheduled)
 * is deferred to a future push when scheduler integration lands. Two layers
 * is honest about what we know today.
 *
 * Props:
 *   yards:      { budget, actual }
 *   colorYards: { budget, actual }
 *   complexity: { budget, actual }   computed by parent: actual ÷ ratio
 */
export default function PlantRollup({ yards, colorYards, complexity }) {
  const yardStatus       = statusFor(yards.actual,       yards.budget,       'higher-is-better')
  const colorYardStatus  = statusFor(colorYards.actual,  colorYards.budget,  'closer-is-better-from-below')
  const complexityStatus = statusFor(complexity.actual,  complexity.budget,  'lower-is-better')

  return (
    <div className={styles.wrap}>
      <RollCard
        label="Yards"
        chip={yardStatusChip(yardStatus)}
        chipClass={yardStatus.tone}
        budget={yards.budget}
        actual={yards.actual}
        actualTone={yardStatus.barTone}
        unit="yds"
        footnote={
          <>Tracking <strong>{pct(yards.actual, yards.budget)}</strong> of budget · <em>revenue unit</em></>
        }
      />
      <RollCard
        label="Color-Yards"
        chip={colorYardChip(colorYards, yards)}
        chipClass={colorYardStatus.tone}
        budget={colorYards.budget}
        actual={colorYards.actual}
        actualTone={colorYardStatus.barTone}
        unit="cyds"
        footnote={
          <>Doing <strong>{pct(colorYards.actual, colorYards.budget)}</strong> of planned labor · <em>labor unit</em></>
        }
      />
      <RollCard
        label="Complexity Ratio"
        chip={complexityChip(complexity)}
        chipClass={complexityStatus.tone}
        budget={complexity.budget}
        actual={complexity.actual}
        actualTone={complexityStatus.barTone}
        unit=""
        footnote={
          complexity.actual > complexity.budget
            ? <>Color-yds ÷ yards · <strong>+{Math.round((complexity.actual / complexity.budget - 1) * 100)}%</strong> over plan complexity · <em>margin compression</em></>
            : <>Color-yds ÷ yards · within plan complexity · <em>healthy</em></>
        }
        decimals={2}
      />
    </div>
  )
}

/* ─── Card subcomponent ─── */

function RollCard({ label, chip, chipClass, budget, actual, actualTone, unit, footnote, decimals = 0 }) {
  // Bar widths: budget always = 100%, actual scaled relative to budget (cap at 110%)
  const actualPct = budget > 0 ? Math.min((actual / budget) * 100, 110) : 0
  return (
    <div className={`${styles.card} ${styles[chipClass]}`}>
      <div className={styles.label}>
        {label}
        {chip && <span className={`${styles.chip} ${styles[`chip_${chipClass}`]}`}>{chip}</span>}
      </div>

      <LayerRow tone="budget" labelText="Budget" pct={100} value={budget} unit={unit} decimals={decimals} />
      <LayerRow tone={actualTone} labelText="Actual" pct={actualPct} value={actual} unit={unit} decimals={decimals} />

      <div className={styles.footnote}>{footnote}</div>
    </div>
  )
}

function LayerRow({ tone, labelText, pct, value, unit, decimals }) {
  return (
    <div className={`${styles.layerRow} ${styles[`layer_${tone}`]}`}>
      <span className={styles.layerLabel}>{labelText}</span>
      <div className={styles.layerBar}>
        <div className={styles.layerBarFill} style={{ width: `${pct}%` }} />
      </div>
      <span className={styles.layerVal}>
        {fmt(value, decimals)}{unit ? ` ${unit}` : ''}
      </span>
    </div>
  )
}

/* ─── Logic helpers ─── */

function pct(num, denom) {
  if (!denom) return '—'
  return `${Math.round((num / denom) * 100)}%`
}

function fmt(n, decimals = 0) {
  if (n == null) return '—'
  if (decimals > 0) return n.toFixed(decimals)
  return Math.round(n).toLocaleString()
}

/**
 * Map an actual-vs-budget comparison to a status descriptor.
 * Returns { tone: 'emerald'|'saffron'|'crimson', barTone: same }.
 *
 * Modes:
 *   higher-is-better       — yards: more is good
 *   lower-is-better        — complexity: less is good (color-yds per yard should be at or below plan)
 *   closer-is-better-from-below — color-yds: tracking with budget is the goal; too low = under-utilized, too high = labor blowout
 */
function statusFor(actual, budget, mode) {
  if (!budget || !actual) return { tone: 'neutral', barTone: 'budget' }
  const ratio = actual / budget
  if (mode === 'higher-is-better') {
    if (ratio >= 0.95) return { tone: 'emerald', barTone: 'actualOk' }
    if (ratio >= 0.85) return { tone: 'saffron', barTone: 'actualWarn' }
    return { tone: 'crimson', barTone: 'actualMiss' }
  }
  if (mode === 'lower-is-better') {
    if (ratio <= 1.05) return { tone: 'emerald', barTone: 'actualOk' }
    if (ratio <= 1.20) return { tone: 'saffron', barTone: 'actualWarn' }
    return { tone: 'crimson', barTone: 'actualMiss' }
  }
  // closer-is-better-from-below: 90-105% is good, otherwise watch
  if (ratio >= 0.90 && ratio <= 1.05) return { tone: 'emerald', barTone: 'actualOk' }
  if (ratio >= 0.80 && ratio <= 1.15) return { tone: 'saffron', barTone: 'actualWarn' }
  return { tone: 'crimson', barTone: 'actualMiss' }
}

/* ─── Chip text ─── */

function yardStatusChip(status) {
  if (status.tone === 'emerald') return 'On pace'
  if (status.tone === 'saffron') return 'Behind'
  if (status.tone === 'crimson') return 'Below pace'
  return null
}

function colorYardChip(colorYards, yards) {
  // If color-yards are tracking but yards are not, that's the margin-pressure signal
  if (!colorYards.budget || !yards.budget) return null
  const cyRatio = colorYards.actual / colorYards.budget
  const yRatio  = yards.actual / yards.budget
  const gap = cyRatio - yRatio
  if (gap > 0.10) return 'Margin pressure'
  if (gap > 0.05) return 'Watch'
  return 'On plan'
}

function complexityChip(c) {
  if (!c.budget) return null
  const r = c.actual / c.budget
  if (r > 1.20) return `${r.toFixed(1)}× plan`
  if (r > 1.05) return 'Heavy mix'
  if (r > 0.95) return 'On plan'
  return 'Light mix'
}
