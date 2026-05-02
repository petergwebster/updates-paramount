import React from 'react'
import styles from './BNYSection.module.css'

/**
 * BNYSection — Brooklyn digital section.
 *
 * Renders the 19-machine grid as TWO visually-separated blocks by physical
 * location: 7 Brooklyn-physical machines first, then the 12 small digitals
 * that physically sit at Passaic but budget to BNY (scheduled by Chandler).
 * The location split is purely visual — both blocks remain part of BNY's
 * scheduling and budget per the architecture decision.
 *
 * Below the location blocks, the bucket mix chart shows BNY-wide bucket
 * distribution (Replen / NEW Goods / Custom / MTO / HOS / Memo / 3P).
 *
 * Props:
 *   machines: array of { name, kind, location, actual, target } where
 *             location is 'brooklyn' | 'passaic' (added by buildBnyMachines)
 *   mix: array of { label, yards, pct, tone } for the mix bars
 *   totalYards: total yards across all buckets (for header)
 */
export default function BNYSection({ machines, mix, totalYards }) {
  // Partition by physical location. Falls back to brooklyn for any legacy
  // record without an explicit location field so we never silently drop
  // a machine.
  const brooklyn = machines.filter(m => (m.location || 'brooklyn') === 'brooklyn')
  const passaic  = machines.filter(m => m.location === 'passaic')

  return (
    <>
      <MachineLocationBlock
        label="Brooklyn"
        sublabel="7 machines · 3 HP 3600s + 4 HP 570s"
        machines={brooklyn}
      />
      <MachineLocationBlock
        label="Passaic"
        sublabel="12 small digitals · BNY budget · scheduled by Chandler"
        machines={passaic}
      />

      {/* ── Bucket mix chart ── */}
      <div className={styles.mixCard}>
        <div className={styles.mixTitle}>
          BNY Bucket Mix
          <span className={styles.mixTitleSmall}>
            {totalYards.toLocaleString()} yards across {mix.length} buckets
          </span>
        </div>
        <div className={styles.mixBars}>
          {mix.map((b) => (
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

/**
 * One labeled grid block. Empty list -> renders nothing (graceful when
 * the partition doesn't yield any machines for a location).
 */
function MachineLocationBlock({ label, sublabel, machines }) {
  if (machines.length === 0) return null
  return (
    <div style={{ marginBottom: 28 }}>
      {/* Location header — Georgia title + italic sublabel + thin divider */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 14,
        paddingBottom: 10,
        marginBottom: 14,
        borderBottom: '1px solid #DBDCDE',
      }}>
        <div style={{
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 18,
          fontWeight: 700,
          color: '#101218',
          letterSpacing: '-0.01em',
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 11,
          color: '#4A4D57',
          fontStyle: 'italic',
          fontFamily: 'Georgia, serif',
        }}>
          {sublabel}
        </div>
      </div>

      <div className={styles.machineGrid}>
        {machines.map(m => <MachineCard key={m.name} m={m} />)}
      </div>
    </div>
  )
}

/**
 * Single machine card — extracted so the two location blocks share rendering.
 * Tone gradient based on actual/target ratio:
 *   < 85% behind plan → crimson
 *   85–92%            → saffron (close to on-plan)
 *   ≥ 92%             → emerald (on plan)
 */
function MachineCard({ m }) {
  const ratio = m.target > 0 ? m.actual / m.target : 0
  let tone = 'emerald'
  if (ratio < 0.85)      tone = 'crimson'
  else if (ratio < 0.92) tone = 'saffron'
  return (
    <div className={`${styles.machineCard} ${styles[`m_${m.kind}`]}`}>
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
}
