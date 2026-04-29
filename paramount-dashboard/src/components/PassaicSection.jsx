import React from 'react'
import WIPStatusBar from './WIPStatusBar'
import styles from './PassaicSection.module.css'

/**
 * PassaicSection — the main detail block for Heartbeat.
 *
 * Sub-sections:
 *   1. Per-category table (GC, Fabric, WP) — utilization, yards/color-yds, WIP-by-status, bottleneck
 *   2. The 17-table floor view — visual of which tables are running this week
 *   3. Watch list — water cooler card + complexity-margin curve
 *   4. Top complexity jobs — sortable list
 *
 * Data sourcing for Push 1:
 *   - Per-category yards/color-yds — props (parent reads from production table)
 *   - WIP-by-status — passed in via wipData prop (from business_facts seed for now)
 *   - 17-table state — props (illustrative for Push 1; Push 3 wires real)
 *   - Top jobs — props (illustrative for Push 1; Push 3 wires from sched_assignments)
 */
export default function PassaicSection({
  categoryData,
  wipData,
  tablesState,
  topJobs,
}) {
  return (
    <>
      {/* ── Per-category table ── */}
      <div className={styles.catTable}>
        <div className={`${styles.catRow} ${styles.headerRow}`}>
          <div className={styles.catCell}>Category</div>
          <div className={styles.catCell}>Tables · Utilization</div>
          <div className={styles.catCell}>Yards / Color-Yds</div>
          <div className={styles.catCell}>WIP by Status</div>
          <div className={styles.catCell}>Bottleneck</div>
        </div>

        {categoryData.map(cat => (
          <CategoryRow key={cat.id} cat={cat} wipData={wipData?.[cat.id]} />
        ))}
      </div>

      {/* ── 17-Table Floor View ── */}
      <div className={styles.floorPlan}>
        <h3 className={styles.floorTitle}>The 17 Tables · This Week</h3>
        <p className={styles.floorSub}>
          2nd floor: Tables 1–11 (Grasscloth + Fabric). 3rd floor: Tables 12–17 (Wallpaper).
        </p>

        <div className={styles.floorSection}>
          <div className={styles.floorSectionLabel}>
            2nd Floor <span className={styles.floorMeta}>11 tables · GC + Fabric</span>
          </div>
          <div className={styles.tablesGrid}>
            {tablesState.slice(0, 11).map(t => (
              <TableCell key={t.number} table={t} />
            ))}
          </div>
        </div>

        <div className={styles.floorSection}>
          <div className={styles.floorSectionLabel}>
            3rd Floor <span className={styles.floorMeta}>6 tables · Wallpaper</span>
          </div>
          <div className={`${styles.tablesGrid} ${styles.gridWp}`}>
            {tablesState.slice(11, 17).map(t => (
              <TableCell key={t.number} table={t} />
            ))}
          </div>
        </div>

        <div className={styles.floorLegend}>
          <span><span className={styles.legendBar} style={{ background: 'var(--royal, #1E4FA8)' }} />Grasscloth</span>
          <span><span className={styles.legendBar} style={{ background: 'var(--saffron, #E89A1E)' }} />Fabric</span>
          <span><span className={styles.legendBar} style={{ background: 'var(--blood-orange, #D33A28)' }} />Wallpaper</span>
          <span style={{ marginLeft: 16 }}><span className={`${styles.dot} ${styles.dotRunning}`} />Running</span>
          <span><span className={`${styles.dot} ${styles.dotIdle}`} />Idle</span>
          <span><span className={`${styles.dot} ${styles.dotAttention}`} />Attention needed</span>
        </div>
      </div>

      {/* ── Watch list: water cooler + complexity curve ── */}
      <div className={styles.watchGrid}>
        <WaterCoolerCard />
        <ComplexityCurveCard />
      </div>

      {/* ── Top complexity jobs ── */}
      <div className={styles.jobsList}>
        <div className={styles.jobsTitle}>
          Top Complexity Jobs This Week
          <span className={styles.jobsTitleSmall}>where the labor goes — sorted by color-yards</span>
        </div>
        {topJobs.map((j, i) => (
          <div key={i} className={styles.jobItem}>
            <div>
              <span className={styles.jobName}>{j.name}</span>
              <span className={styles.jobMeta}>{j.meta}</span>
            </div>
            <span className={`${styles.jobBadge} ${styles[`jobBadge_${j.tone || 'neutral'}`]}`}>
              {j.badge}
            </span>
            <div><span className={styles.jobNum}>{j.colorYds.toLocaleString()}</span><br/><span className={styles.jobNumLabel}>color-yd</span></div>
            <div><span className={styles.jobNum}>{j.yards.toLocaleString()}</span><br/><span className={styles.jobNumLabel}>yards</span></div>
            <div><span className={styles.jobNum}>{j.colors.toFixed(1)}</span><br/><span className={styles.jobNumLabel}>avg colors</span></div>
          </div>
        ))}
      </div>
    </>
  )
}

/* ─── Category row ─── */
function CategoryRow({ cat, wipData }) {
  return (
    <div className={styles.catRow}>
      <div className={styles.catCell}>
        <div className={styles.catName}>{cat.name}</div>
        <div className={styles.catSubtext}>{cat.tableRange} · {cat.floor}</div>
        <div className={styles.catTablesCount}>{cat.tableCount} tables · {cat.crews} crews · {cat.ratio}</div>
      </div>
      <div className={styles.catCell}>
        <div className={styles.utilLabel}>Tables running this week</div>
        <div className={styles.utilBar}>
          <div className={`${styles.utilFill} ${styles[`util_${cat.utilTone}`]}`} style={{ width: `${cat.utilPct}%` }} />
        </div>
        <div className={styles.utilDetail}>{cat.utilDetail}</div>
      </div>
      <div className={styles.catCell}>
        <div className={styles.yardsBig}>{cat.yards.toLocaleString()} yd</div>
        <div className={styles.colorYdsLine}>
          {cat.colorYds.toLocaleString()} color-yds · avg {cat.avgColors.toFixed(1)} colors
        </div>
        <div className={styles.pacingNote}>{cat.pacingNote}</div>
      </div>
      <div className={styles.catCell}>
        {wipData ? <WIPStatusBar data={wipData} compact /> : <span className={styles.wipMissing}>—</span>}
      </div>
      <div className={styles.catCell}>
        <div className={`${styles.bottleneck} ${styles[`bottleneck_${cat.bottleneck.tone}`]}`}>
          <strong>{cat.bottleneck.label}</strong>
          {cat.bottleneck.text}
        </div>
      </div>
    </div>
  )
}

/* ─── Floor table cell ─── */
function TableCell({ table }) {
  const isIdle = table.status === 'idle'
  return (
    <div
      className={`${styles.tCell} ${styles[`t_${table.category}`]} ${isIdle ? styles.idle : ''}`}
      title={table.tooltip || `Table ${table.number}`}
    >
      <div>
        <div className={styles.tNumber}>{table.number}</div>
        <div className={styles.tStatus}>{table.label}</div>
      </div>
      <div className={`${styles.tDot} ${styles[`tDot_${table.status}`]}`} />
    </div>
  )
}

/* ─── Watch cards (static reference data for Push 1) ─── */

function WaterCoolerCard() {
  return (
    <div className={styles.watchCard}>
      <div className={styles.watchLabel}>
        Water Cooler Time
        <span className={styles.watchBadge}>% of shift not printing</span>
      </div>
      <div className={styles.watchHeadline}>26%</div>
      <div className={styles.watchSub}>plant 14-week baseline</div>

      <div className={styles.watchBars}>
        <WatchBarRow label="Fabric"    pct={18} tone="low" />
        <WatchBarRow label="Grass"     pct={20} tone="low" />
        <WatchBarRow label="Wallpaper" pct={55} tone="high" />
      </div>

      <div className={styles.watchBox}>
        ~73% of water cooler is mid-shift operational idle (mixing, screen prep, post-lunch restart) — not break-creep. Source: Angel's 15-job timing study, June 2025.
      </div>
    </div>
  )
}

function WatchBarRow({ label, pct, tone }) {
  return (
    <div className={styles.watchBarRow}>
      <span className={styles.watchBarLabel}>{label}</span>
      <div className={styles.watchBarBg}>
        <div className={`${styles.watchBarFill} ${styles[`watchBar_${tone}`]}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={styles.watchPctVal}>{pct}%</span>
    </div>
  )
}

function ComplexityCurveCard() {
  // Margin compression curve from Combined Review deck
  const heights = [100, 92, 84, 76, 68, 60, 52, 44, 36, 28, 20]
  const nowIndex = 3 // ~4 colors as illustrative current
  return (
    <div className={styles.watchCard}>
      <div className={styles.watchLabel}>
        Complexity-Margin Curve
        <span className={styles.watchBadge}>avg colors this week</span>
      </div>
      <div className={styles.watchHeadline}>
        4.0 <span className={styles.watchHeadlineSmall}>avg colors</span>
      </div>
      <div className={styles.watchSub}>per yard scheduled · margin compresses with each color</div>

      <div className={styles.complexCurve}>
        {heights.map((h, i) => (
          <div
            key={i}
            className={`${styles.curveBar} ${i === nowIndex ? styles.curveBarNow : ''}`}
            style={{ height: `${h}%` }}
          >
            <span className={styles.curveLabel}>{i + 1}</span>
          </div>
        ))}
      </div>

      <div className={styles.curveAxis}>
        <span>1c: <strong>40% loaded margin</strong></span>
        <span>11c: <strong>12% — at plan, no cushion</strong></span>
      </div>
    </div>
  )
}
