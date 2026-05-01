import React, { useState, useEffect, useRef } from 'react'
import { format, startOfWeek, addDays } from 'date-fns'
import { supabase } from '../supabase'
import { getFiscalLabel } from '../fiscalCalendar'
import PlantRollup from './PlantRollup'
import PassaicSection from './PassaicSection'
import BNYSection from './BNYSection'
import ClaudeReadBlock from './ClaudeReadBlock'
import { buildHeartbeatNarrativePrompt } from '../prompts/heartbeatNarrative'
import styles from './HeartbeatPage.module.css'

/**
 * HeartbeatPage — schedule-vs-actuals live read.
 *
 * Data flow (the actual one, finally):
 *   Scheduler → writes sched_assignments (planned_yards, planned_cy per
 *               table-day, per PO line, per week)
 *   Live Ops  → reads sched_assignments as the daily target,
 *               writes sched_daily_ops (actual_yards, waste_yards per
 *               table-day as Sami/Wendy/Chandler enter end-of-shift)
 *   Heartbeat → joins those two on (site, week_start, table_code, day_of_week)
 *               and rolls up plant-wide / per-category / per-machine views
 *
 * NEW Goods bucket comes from sched_wip_rows where is_new_goods=true (the
 * LIFT-uploaded WIP pool). The other 6 BNY buckets (Replen / Custom / MTO /
 * HOS / Memo / 3P) come from joining sched_assignments → sched_wip_rows on
 * po_number to inherit the bucket classification.
 *
 * Weeks are Sunday-Saturday (weekStartsOn: 0).
 *
 * No production-table fallback. If there's no schedule yet, the page says
 * so. If there's a schedule but no actuals, it shows the plan and waits.
 *
 * Props:
 *   weekStart   — Sunday of the week being analyzed (Date)
 *   currentUser — full name for Claude attribution
 *   userId      — auth UUID for Claude attribution
 */

// ─── Targets (must match DashboardPage.jsx) ────────────────────────────────
const NJ_TARGETS = {
  fabric: { yards: 810,  colorYards: 4522  },
  grass:  { yards: 3615, colorYards: 7570  },
  paper:  { yards: 4185, colorYards: 13405 },
}
const BNY_TARGETS = {
  total: 12000,
  hp3600_per_machine: 600 * 6, // per machine per week, 6 days
  hp570_per_machine:  500 * 6,
}
const NJ_TOTAL_YARDS_TGT      = NJ_TARGETS.fabric.yards      + NJ_TARGETS.grass.yards      + NJ_TARGETS.paper.yards
const NJ_TOTAL_COLORYARDS_TGT = NJ_TARGETS.fabric.colorYards + NJ_TARGETS.grass.colorYards + NJ_TARGETS.paper.colorYards
const PLANT_YARDS_TGT         = NJ_TOTAL_YARDS_TGT + BNY_TARGETS.total
const TARGET_COMPLEXITY       = NJ_TOTAL_COLORYARDS_TGT / NJ_TOTAL_YARDS_TGT // ~3.13

// ─── 17 Passaic tables (canonical numbering) ───────────────────────────────
const PASSAIC_TABLES = [
  // Tables 1–2: Grasscloth (2nd floor)
  { number: 1,  category: 'gc',  table_code: 'GC-1'  },
  { number: 2,  category: 'gc',  table_code: 'GC-2'  },
  // Tables 3–11: Fabric (2nd floor)
  ...Array.from({ length: 9 }, (_, i) => ({
    number: i + 3, category: 'fab', table_code: `FAB-${i + 3}`,
  })),
  // Tables 12–17: Wallpaper (3rd floor). 17 dedicated to Citrus Garden.
  ...Array.from({ length: 6 }, (_, i) => ({
    number: i + 12, category: 'wp', table_code: `WP-${i + 12}`,
  })),
]

// ─── 19 BNY machines (canonical fleet) ─────────────────────────────────────
const BNY_MACHINES = [
  // 3 HP 3600s (high-volume workhorses)
  { name: 'Glow',      kind: '3600', table_code: 'glow'      },
  { name: 'Sasha',     kind: '3600', table_code: 'sasha'     },
  { name: 'Trish',     kind: '3600', table_code: 'trish'     },
  // HP 570s and other
  { name: 'Bianca',    kind: '570',  table_code: 'bianca'    },
  { name: 'LASH',      kind: '570',  table_code: 'lash'      },
  { name: 'Chyna',     kind: '570',  table_code: 'chyna'     },
  { name: 'Rhonda',    kind: '570',  table_code: 'rhonda'    },
  { name: 'Dakota Ka', kind: '570',  table_code: 'dakota_ka' },
  { name: 'Dementia',  kind: '570',  table_code: 'dementia'  },
  { name: 'Ember',     kind: '570',  table_code: 'ember'     },
  { name: 'Ivy Nile',  kind: '570',  table_code: 'ivy_nile'  },
  { name: 'Jacy Jayne',kind: '570',  table_code: 'jacy_jayne'},
  { name: 'Apollo',    kind: '570',  table_code: 'apollo'    },
  { name: 'Valhalla',  kind: '570',  table_code: 'valhalla'  },
  { name: 'XIA',       kind: '570',  table_code: 'xia'       },
  { name: 'Ruby',      kind: '570',  table_code: 'ruby'      },
  { name: 'Nemesis',   kind: '570',  table_code: 'nemesis'   },
  { name: 'Poseidon',  kind: '570',  table_code: 'poseidon'  },
  { name: 'Zoey',      kind: '570',  table_code: 'zoey'      },
]

// ─── BNY bucket order (matches Scheduler filter chips) ─────────────────────
const BNY_BUCKETS = ['Replen', 'NEW Goods', 'Custom', 'MTO', 'HOS', 'Memo', '3P']

// ──────────────────────────────────────────────────────────────────────────────
export default function HeartbeatPage({ weekStart, currentUser, userId }) {
  const [assignments,    setAssignments]   = useState([])
  const [dailyOps,       setDailyOps]      = useState([])
  const [bnyBucketYards, setBnyBucketYards] = useState({})
  const [wipByStatus,    setWipByStatus]   = useState(null)
  const [loading,        setLoading]       = useState(true)
  const [error,          setError]         = useState(null)

  // Sunday-Saturday week
  const weekKey = format(startOfWeek(weekStart, { weekStartsOn: 0 }), 'yyyy-MM-dd')
  const fiscalLabel = getFiscalLabel(weekStart)

  // Diagnostic — one log per week change
  const loggedKeyRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    async function load() {
      try {
        // 1. Schedule (planned) for the week
        // 2. Actuals (sched_daily_ops) for the week
        // 3. WIP rollup for status bar
        // 4. WIP rows for bucket classification (BNY) + NEW Goods yards
        const [assignRes, opsRes, wipRollupRes, wipFactsRes, wipRowsRes] = await Promise.all([
          supabase
            .from('sched_assignments')
            .select('site, po_number, product_type, table_code, day_of_week, planned_yards, planned_cy, status')
            .eq('week_start', weekKey),
          supabase
            .from('sched_daily_ops')
            .select('site, table_code, day_of_week, actual_yards, waste_yards')
            .eq('week_start', weekKey),
          supabase
            .from('v_current_wip_rollup')
            .select('yard_order_status, num_orders, yards_written'),
          supabase
            .from('business_facts')
            .select('fact_number, fact')
            .eq('category', 'wip-passaic').eq('active', true)
            .order('fact_number'),
          supabase
            .from('sched_wip_rows')
            .select('po_number, site, customer_type, product_type, is_new_goods, yards_written'),
        ])

        if (cancelled) return

        const assignRows = assignRes.data || []
        const opsRows    = opsRes.data || []
        const wipRows    = wipRowsRes.data || []

        setAssignments(assignRows)
        setDailyOps(opsRows)

        // Classify BNY bucket yards from assignments × wip_rows
        setBnyBucketYards(buildBnyBucketYards(assignRows, wipRows))

        // WIP-by-status (independent of week)
        const rollupRows = wipRollupRes.data || []
        if (rollupRows.length > 0) {
          setWipByStatus(parseWipRollupRows(rollupRows))
        } else {
          setWipByStatus(parseWipFacts(wipFactsRes.data || []))
        }

        // Diagnostic
        if (loggedKeyRef.current !== weekKey) {
          loggedKeyRef.current = weekKey
          // eslint-disable-next-line no-console
          console.log('[Heartbeat]', {
            week_start: weekKey,
            assignments_count: assignRows.length,
            daily_ops_count: opsRows.length,
            wip_rows_count: wipRows.length,
            sample_assignment: assignRows[0] || null,
            sample_ops: opsRows[0] || null,
          })
        }

        setLoading(false)
      } catch (e) {
        if (cancelled) return
        // eslint-disable-next-line no-console
        console.error('[Heartbeat] load failed', e)
        setError('Heartbeat failed to load. Try refreshing.')
        setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [weekKey])

  // ── Aggregations from raw rows ─────────────────────────────────────────
  const njAgg  = aggregateBySite(assignments, dailyOps, 'passaic')
  const bnyAgg = aggregateBySite(assignments, dailyOps, 'bny')

  // Did anything get scheduled, anywhere?
  const hasSchedule = assignments.length > 0
  // Did any actuals get entered?
  const hasActuals  = dailyOps.some(r => Number(r.actual_yards) > 0)
  const hasRealData = hasSchedule

  // Plant Rollup
  const plantPlannedYards = njAgg.plannedYards + bnyAgg.plannedYards
  const plantActualYards  = njAgg.actualYards  + bnyAgg.actualYards

  const plantYards = {
    budget: hasSchedule ? plantPlannedYards : PLANT_YARDS_TGT,
    actual: plantActualYards,
  }
  // Color-yards = Passaic only (digital is single-pass).
  const plantColorYards = {
    budget: hasSchedule ? njAgg.plannedColorYards : NJ_TOTAL_COLORYARDS_TGT,
    actual: njAgg.actualColorYards,
  }
  const plantComplexity = {
    budget: TARGET_COMPLEXITY,
    actual: njAgg.actualYards > 0
      ? njAgg.actualColorYards / njAgg.actualYards
      : (njAgg.plannedYards > 0
          ? njAgg.plannedColorYards / njAgg.plannedYards
          : TARGET_COMPLEXITY),
  }

  // Per-category Passaic
  const categoryData = buildCategoryData(assignments, dailyOps, wipByStatus)

  // 17-table state — real, derived from today's assignments + actuals
  const tablesState = build17TableState(assignments, dailyOps)

  // Top complexity jobs — by planned_cy desc
  const topJobs = buildTopJobs(assignments)

  // BNY machines — all 19, planned vs actual
  const machines = buildBnyMachines(assignments, dailyOps)

  // BNY bucket mix — 7 buckets in canonical order
  const { mix, totalYards: bnyMixTotal } = buildBnyMix(bnyBucketYards)

  // Narrative gates on schedule existence + data quality
  const buildPrompt = ({ contextString }) => buildHeartbeatNarrativePrompt({
    contextString,
    hasData: hasRealData,
  })

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>

      {/* Hero */}
      <div className={styles.pageHero}>
        <div>
          <div className={styles.heartbeatEyebrow}>
            <span className={styles.pulseDot} />
            Live · Plant Pulse
          </div>
          <h1 className={styles.pageTitle}>Paramount's Heartbeat</h1>
          <p className={styles.pageSub}>
            Schedule vs. actuals for the week. What Wendy and Chandler
            committed to vs. what's coming off the floor.
          </p>
        </div>
        <div className={styles.pageMeta}>
          <div className={styles.pageMetaWeek}>
            Week of {format(startOfWeek(weekStart, { weekStartsOn: 0 }), 'MMM d')}
            {' – '}
            {format(addDays(startOfWeek(weekStart, { weekStartsOn: 0 }), 6), 'MMM d')}
          </div>
          {fiscalLabel && <div className={styles.pageMetaSub}>{fiscalLabel}</div>}
          <div className={styles.pageMetaUpdated}>
            Updated {format(new Date(), 'h:mma').toLowerCase()}
          </div>
        </div>
      </div>

      {error && (
        <div className={styles.section}>
          <div className={styles.loading} style={{ color: '#a16207' }}>{error}</div>
        </div>
      )}

      {/* Plant Rollup */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>The Two-Measure Picture</div>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionTitleText}>
              <span className={`${styles.sitePill} ${styles.pillPlant}`}>PLANT</span>
              Plant Rollup
            </div>
            <div className={styles.sectionDesc}>
              Scheduled vs. actual · Passaic + Brooklyn combined.
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading schedule and actuals…</div>
        ) : !hasSchedule ? (
          <div className={styles.loading}>
            No schedule built yet for the week of{' '}
            {format(startOfWeek(weekStart, { weekStartsOn: 0 }), 'MMM d')}.
            Heartbeat will populate as Wendy and Chandler assign POs in Scheduler.
          </div>
        ) : !hasActuals ? (
          <>
            <PlantRollup
              yards={plantYards}
              colorYards={plantColorYards}
              complexity={plantComplexity}
            />
            <div className={styles.loading} style={{ marginTop: '0.75rem', fontStyle: 'italic' }}>
              Schedule built. Actuals will appear here as Sami and Wendy enter
              end-of-shift in Live Ops.
            </div>
          </>
        ) : (
          <PlantRollup
            yards={plantYards}
            colorYards={plantColorYards}
            complexity={plantComplexity}
          />
        )}
      </div>

      {/* Passaic */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>Site Detail</div>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionTitleText}>
              <span className={`${styles.sitePill} ${styles.pillPassaic}`}>NJ</span>
              Passaic · Screen Print
            </div>
            <div className={styles.sectionDesc}>
              17 tables across 2 floors · 7 crews · the labor-cost story lives here.
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading…</div>
        ) : (
          <PassaicSection
            categoryData={categoryData}
            wipData={{ grass: wipByStatus, fabric: wipByStatus, paper: wipByStatus }}
            tablesState={tablesState}
            topJobs={topJobs}
          />
        )}
      </div>

      {/* BNY */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>Site Detail</div>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionTitleText}>
              <span className={`${styles.sitePill} ${styles.pillBny}`}>BNY</span>
              Brooklyn · Digital
            </div>
            <div className={styles.sectionDesc}>
              19 machines · 3 HP 3600s + 16 HP 570s · digital is volume, not complexity.
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading…</div>
        ) : (
          <BNYSection
            machines={machines}
            mix={mix}
            totalYards={bnyMixTotal}
          />
        )}
      </div>

      {/* Claude's Read */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>Analysis</div>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionTitleText}>
              <span className={`${styles.sitePill} ${styles.pillRead}`}>READ</span>
              Combined Read
            </div>
            <div className={styles.sectionDesc}>
              Claude interprets the picture · what to watch this week.
            </div>
          </div>
        </div>

        <ClaudeReadBlock
          weekStart={weekStart}
          timeWindow="heartbeat"
          buildPrompt={buildPrompt}
          currentUser={currentUser}
          userId={userId}
        />
      </div>
    </div>
  )
}

/* ═════════════════════════════════════════════════════════════════════════
   Aggregation helpers — pure functions over raw rows
   ═════════════════════════════════════════════════════════════════════════ */

function num(v) {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/**
 * Roll up planned + actual yards/color-yards for one site across the whole week.
 * Color-yards on the actual side is interpolated: actualYards × (cellPlannedCy / cellPlannedYards).
 */
function aggregateBySite(assignments, dailyOps, site) {
  let plannedYards = 0
  let plannedColorYards = 0
  let actualYards = 0
  let actualColorYards = 0

  // Sum planned by cell (site, table_code, day_of_week) and remember the
  // planned ratio so we can interpolate actual color-yards.
  const cellPlanned = new Map()
  assignments.forEach(a => {
    if (a.site !== site) return
    const py = num(a.planned_yards)
    const pcy = num(a.planned_cy)
    plannedYards += py
    plannedColorYards += pcy
    const key = `${a.table_code}|${a.day_of_week}`
    const prev = cellPlanned.get(key) || { y: 0, cy: 0 }
    cellPlanned.set(key, { y: prev.y + py, cy: prev.cy + pcy })
  })

  dailyOps.forEach(o => {
    if (o.site !== site) return
    const ay = num(o.actual_yards)
    actualYards += ay
    const key = `${o.table_code}|${o.day_of_week}`
    const planned = cellPlanned.get(key)
    if (planned && planned.y > 0) {
      actualColorYards += ay * (planned.cy / planned.y)
    }
  })

  return { plannedYards, plannedColorYards, actualYards, actualColorYards }
}

/**
 * Build per-category Passaic data (Grass / Fabric / Wallpaper).
 * Active table count = distinct table_codes with any assignment this week.
 */
function buildCategoryData(assignments, dailyOps, wipByStatus) {
  const categories = [
    { id: 'grass',  name: 'Grasscloth', tableRange: 'Tables 1–2',   floor: '2nd floor', tableCount: 2, crews: 2, ratio: '1:1',
      pTypes: ['Grasscloth', 'Grass', 'GC'],
      bottleneck: { tone: 'crimson', label: 'Material-blocked',
        text: 'Korean material lead time ~6 mo. Watch material-ETA gate; runnable queue scales when material unblocks.' } },
    { id: 'fabric', name: 'Fabric',     tableRange: 'Tables 3–11',  floor: '2nd floor', tableCount: 9, crews: 2, ratio: '4.5:1',
      pTypes: ['Fabric'],
      bottleneck: { tone: 'saffron', label: 'Supply-constrained',
        text: 'Mixing→Ready is the gate, not print speed. Watch the In Mixing Queue → Ready to Print transition.' } },
    { id: 'paper',  name: 'Wallpaper',  tableRange: 'Tables 12–17', floor: '3rd floor', tableCount: 6, crews: 3, ratio: '2:1',
      pTypes: ['Wallpaper', 'Paper', 'WP'],
      bottleneck: { tone: 'royal',   label: 'Complexity-bound · Citrus Garden',
        text: '25% of WP color-yds = Citrus Garden alone. Output swings 4× weekly on stops setup.' } },
  ]

  return categories.map(cat => {
    let plannedYards = 0
    let plannedColorYards = 0
    let actualYards = 0
    const activeTables = new Set()
    const cellPlanned = new Map()

    assignments.forEach(a => {
      if (a.site !== 'passaic') return
      if (!cat.pTypes.includes(a.product_type)) return
      const py = num(a.planned_yards)
      const pcy = num(a.planned_cy)
      plannedYards += py
      plannedColorYards += pcy
      activeTables.add(a.table_code)
      const key = `${a.table_code}|${a.day_of_week}`
      const prev = cellPlanned.get(key) || { y: 0, cy: 0 }
      cellPlanned.set(key, { y: prev.y + py, cy: prev.cy + pcy })
    })

    dailyOps.forEach(o => {
      if (o.site !== 'passaic') return
      if (!cellPlanned.has(`${o.table_code}|${o.day_of_week}`)) return
      actualYards += num(o.actual_yards)
    })

    const activeCount = activeTables.size
    const utilPct = (activeCount / cat.tableCount) * 100
    const utilTone = activeCount >= cat.tableCount * 0.66 ? 'emerald'
                  : activeCount >= cat.tableCount * 0.33 ? 'saffron'
                  : 'crimson'

    return {
      id: cat.id,
      name: cat.name,
      tableRange: cat.tableRange,
      floor: cat.floor,
      tableCount: cat.tableCount,
      crews: cat.crews,
      ratio: cat.ratio,
      utilPct,
      utilTone,
      utilDetail: `${activeCount} of ${cat.tableCount} active`,
      yards: actualYards || plannedYards,
      colorYds: plannedColorYards,
      avgColors: plannedYards > 0 ? plannedColorYards / plannedYards : 0,
      pacingNote: actualYards > 0
        ? `${Math.round((actualYards / plannedYards) * 100)}% of plan delivered`
        : plannedYards > 0
          ? 'scheduled — awaiting actuals'
          : 'no schedule yet for this week',
      bottleneck: cat.bottleneck,
    }
  })
}

/**
 * Build the 17-table-state visualization. State is per-table for the *week*:
 *   running   — has any actuals row with yards > 0
 *   scheduled — has assignments but no actuals yet
 *   attention — has actuals but variance > 25% behind plan
 *   idle      — no assignments
 */
function build17TableState(assignments, dailyOps) {
  return PASSAIC_TABLES.map(t => {
    const tableAssigns = assignments.filter(a => a.site === 'passaic' && a.table_code === t.table_code)
    const tableOps = dailyOps.filter(o => o.site === 'passaic' && o.table_code === t.table_code)

    const planned = tableAssigns.reduce((s, a) => s + num(a.planned_yards), 0)
    const actual  = tableOps.reduce((s, o) => s + num(o.actual_yards), 0)

    let status, label
    if (planned === 0 && actual === 0) {
      status = 'idle';  label = 'idle'
    } else if (actual > 0 && planned > 0 && actual / planned < 0.75) {
      status = 'attention'; label = labelForCategory(t.category, true)
    } else if (actual > 0) {
      status = 'running'; label = labelForCategory(t.category, false)
    } else {
      status = 'scheduled'; label = labelForCategory(t.category, false)
    }

    return { number: t.number, category: t.category, label, status }
  })
}

function labelForCategory(cat, attention) {
  if (cat === 'gc') return 'GC'
  if (cat === 'fab') return 'FAB'
  if (cat === 'wp') return 'WP'
  return attention ? '!' : '•'
}

/**
 * Top complexity jobs — assignments sorted by planned_cy desc, top 5.
 * Real PO numbers and product types pulled from the assignment row.
 */
function buildTopJobs(assignments) {
  // Aggregate per po_number (a PO can have multiple table-day lines)
  const byPo = new Map()
  assignments.forEach(a => {
    const key = a.po_number
    const prev = byPo.get(key) || {
      po: a.po_number, product_type: a.product_type, table_code: a.table_code,
      yards: 0, colorYds: 0,
    }
    prev.yards += num(a.planned_yards)
    prev.colorYds += num(a.planned_cy)
    byPo.set(key, prev)
  })

  return Array.from(byPo.values())
    .sort((a, b) => b.colorYds - a.colorYds)
    .slice(0, 5)
    .map(j => {
      const colors = j.yards > 0 ? j.colorYds / j.yards : 0
      const tone = colors >= 8 ? 'crimson' : colors >= 6 ? 'saffron' : 'neutral'
      const badge = colors >= 8 ? `${colors.toFixed(0)}c · margin pressure`
                  : colors >= 6 ? `${colors.toFixed(0)}c · watch`
                  : `${colors.toFixed(0)}c`
      return {
        name: j.po,
        meta: `${j.product_type || ''} · ${colors.toFixed(0)} colors · ${j.table_code}`,
        badge, tone,
        colorYds: j.colorYds,
        yards: j.yards,
        colors: colors,
      }
    })
}

/**
 * Build BNY machine cards — all 19 machines, planned + actual yards each.
 */
function buildBnyMachines(assignments, dailyOps) {
  return BNY_MACHINES.map(m => {
    const plan = assignments
      .filter(a => a.site === 'bny' && a.table_code === m.table_code)
      .reduce((s, a) => s + num(a.planned_yards), 0)
    const actual = dailyOps
      .filter(o => o.site === 'bny' && o.table_code === m.table_code)
      .reduce((s, o) => s + num(o.actual_yards), 0)
    return {
      name: m.name,
      kind: m.kind,
      actual,
      target: plan, // "target" is whatever was scheduled this week, per machine
    }
  })
}

/**
 * Classify a wip row into a BNY bucket. Mirrors Scheduler's filter chips.
 */
function classifyBnyBucket(wipRow) {
  if (wipRow.is_new_goods === true) return 'NEW Goods'
  const ct = (wipRow.customer_type || '').toLowerCase()
  // Customer type is the primary discriminator. Refine here as we learn the
  // actual values used in sched_wip_rows.customer_type.
  if (ct.includes('replen'))   return 'Replen'
  if (ct.includes('custom'))   return 'Custom'
  if (ct.includes('mto'))      return 'MTO'
  if (ct.includes('hos'))      return 'HOS'
  if (ct.includes('memo'))     return 'Memo'
  if (ct.includes('3p') || ct.includes('third')) return '3P'
  // Fallback — Schumacher branded but no other signal
  return 'Replen'
}

/**
 * Sum BNY yards by bucket, joining sched_assignments → sched_wip_rows on po_number.
 * NEW Goods comes from wip_rows directly (sum of yards_written where is_new_goods).
 */
function buildBnyBucketYards(assignments, wipRows) {
  // Index wip rows by po_number for fast lookup
  const wipByPo = new Map()
  wipRows.forEach(w => {
    if (w.site !== 'bny') return
    if (!wipByPo.has(w.po_number)) wipByPo.set(w.po_number, w)
  })

  const buckets = {}
  BNY_BUCKETS.forEach(b => { buckets[b] = 0 })

  assignments.forEach(a => {
    if (a.site !== 'bny') return
    const wip = wipByPo.get(a.po_number)
    const bucket = wip ? classifyBnyBucket(wip) : 'Replen'
    buckets[bucket] = (buckets[bucket] || 0) + num(a.planned_yards)
  })

  return buckets
}

/**
 * Build BNY mix bars in canonical order from the bucket aggregation.
 */
function buildBnyMix(bucketYards) {
  const toneFor = {
    'Replen':   'emerald',
    'NEW Goods':'royal',
    'Custom':   'royal',
    'MTO':      'saffron',
    'HOS':      'emerald',
    'Memo':     'muted',
    '3P':       'muted',
  }
  const buckets = BNY_BUCKETS.map(label => ({
    label,
    yards: bucketYards[label] || 0,
    tone: toneFor[label] || 'muted',
  }))
  const totalYards = buckets.reduce((s, b) => s + b.yards, 0)
  const mix = buckets.map(b => ({
    ...b,
    pct: totalYards > 0 ? (b.yards / totalYards) * 100 : 0,
  }))
  return { mix, totalYards }
}

/* ═════════════════════════════════════════════════════════════════════════
   WIP-by-status parsers (unchanged from prior version)
   ═════════════════════════════════════════════════════════════════════════ */

function parseWipFacts(facts) {
  if (!facts.length) return null
  const out = makeEmptyWipBuckets()
  const labelMap = wipLabelMap()
  facts.forEach(f => {
    const match = f.fact.match(/—\s+(.+?):\s+([\d,]+)\s+yards?\s+\(([\d,]+)\s+orders?\)/i)
    if (!match) return
    const [, label, yardsStr, ordersStr] = match
    const key = labelMap[label.trim()]
    if (!key) return
    out[key] = {
      yards:  parseInt(yardsStr.replace(/,/g, ''), 10),
      orders: parseInt(ordersStr.replace(/,/g, ''), 10),
    }
  })
  return out
}

function parseWipRollupRows(rows) {
  if (!rows || rows.length === 0) return null
  const out = makeEmptyWipBuckets()
  const statusMap = wipLabelMap()
  rows.forEach(r => {
    const key = statusMap[r.yard_order_status]
    if (!key) return
    out[key].yards  += Number(r.yards_written || 0)
    out[key].orders += Number(r.num_orders || 0)
  })
  return out
}

function makeEmptyWipBuckets() {
  return {
    unallocated:     { yards: 0, orders: 0 },
    waitingApproval: { yards: 0, orders: 0 },
    waitingMaterial: { yards: 0, orders: 0 },
    approvedToPrint: { yards: 0, orders: 0 },
    readyToPrint:    { yards: 0, orders: 0 },
    inPacking:       { yards: 0, orders: 0 },
    inProgress:      { yards: 0, orders: 0 },
    strikeOff:       { yards: 0, orders: 0 },
    inMixingQueue:   { yards: 0, orders: 0 },
  }
}

function wipLabelMap() {
  return {
    'Orders Unallocated':   'unallocated',
    'Waiting for Approval': 'waitingApproval',
    'Waiting for Material': 'waitingMaterial',
    'Approved to Print':    'approvedToPrint',
    'Ready to Print':       'readyToPrint',
    'In Packing':           'inPacking',
    'In Progress':          'inProgress',
    'Strike Off':           'strikeOff',
    'In Mixing Queue':      'inMixingQueue',
  }
}
