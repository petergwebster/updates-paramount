import React from 'react'
import styles from './BNYSection.module.css'

/**
 * BNYSection — Brooklyn digital section.
 *
 * Two sub-blocks:
 *   1. 7 machine cards (Glow / Sasha / Trish + Bianca / LASH / Chyna / Rhonda)
 *   2. Bucket mix chart (Replen / Custom / MTO / HOS / Memo / 3P / NEW Goods)
 *
 * Simpler than Passaic because BNY is digital — no color-yards complexity,
 * no 17-table layout, no water cooler problem at the same magnitude.
 *
 * Props:
 *   machines: array of { name, kind, actual, target } where kind is '3600' or '570'
 *   mix: array of { label, yards, pct, tone } for the mix bars
 *   totalYards: total yards across all buckets (for header)
 */
export default function BNYSection({ machines, mix, totalYards }) {
  return (
    <>
      {/* ── Machine cards ── */}
      <div className={styles.machineGrid}>
        {machines.map(m => {
          const ratio = m.target > 0 ? m.actual / m.target : 0
          let tone = 'emerald'
          if (ratio < 0.85)      tone = 'crimson'
          else if (ratio < 0.92) tone = 'saffron'
          return (
            <div key={m.name} className={`${styles.machineCard} ${styles[`m_${m.kind}`]}`}>
              <div className={styles.machineHead}>
                <div className={styles.machineName}>{m.name}</div>
                <div className={styles.machineKind}>{m.kind}</div>
              </div>
              <div className={styles.machineActual}>
                {m.actual.toLocaleString()}<span className={styles.smallUnit}> yd</span>
              </div>
              <div className={styles.machineTarget}>
                target {m.target.toLocaleString()} · {Math.round(ratio * 100)}%
              </div>
              <div className={styles.machineBar}>
                <div
                  className={`${styles.machineBarFill} ${styles[`fill_${tone}`]}`}
                  style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Bucket mix chart ── */}
      <div className={styles.mixCard}>
        <div className={styles.mixTitle}>
          BNY Bucket Mix
          <span className={styles.mixTitleSmall}>
            {totalYards.toLocaleString()} yards across {mix.length} buckets
          </span>
        </div>
        <div className={styles.mixBars}>
          {mix.map((b, i) => (
            <div key={b.label} className={styles.mixBarRow}>
              <span className={styles.mixLabel}>{b.label}</span>
              <div className={styles.mixBg}>
                <div
                  className={`${styles.mixFill} ${styles[`mixFill_${b.tone || 'muted'}`]}`}
                  style={{ width: `${b.pct}%` }}
                />
              </div>
              <span className={styles.mixVal}>
                {b.yards.toLocaleString()}{' '}
                <span className={styles.mixSubtext}>{b.pct.toFixed(1)}%</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
