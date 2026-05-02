import React, { useState, useEffect, useRef } from 'react'
import { format, startOfWeek, addDays } from 'date-fns'
import { supabase } from '../supabase'
import { getFiscalLabel } from '../fiscalCalendar'
import PassaicSection from './PassaicSection'
import BNYSection from './BNYSection'
import ClaudeReadBlock from './ClaudeReadBlock'
import { buildHeartbeatNarrativePrompt } from '../prompts/heartbeatNarrative'
import styles from './HeartbeatPage.module.css'

/**
 * HeartbeatPage — schedule-vs-actuals live read.
 *
 * Data flow:
 *   Scheduler → writes sched_assignments (planned_yards, planned_cy per
 *               table-day, per PO line, per week)
 *   Live Ops  → reads sched_assignments as the daily target,
 *               writes sched_daily_ops (actual_yards, waste_yards per
 *               table-day as Sami/Wendy/Chandler enter end-of-shift)
 *   Heartbeat → joins those two on (site, week_start, table_code, day_of_week)
 *               and rolls up plant-wide / per-category / per-machine views.
 *
 * Architectural note (May 1, 2026):
 *   Color-yards is a HAND-SCREEN labor unit. BNY is digital — it prints all
 *   colors in one pass, so there is no per-color labor cost on that side.
 *   Color-yards therefore only applies to Passaic. Plant Rollup shows YARDS
 *   ONLY (the one metric that means the same thing on both floors).
 *   Color-yards and complexity live in the Passaic site card and
 *   per-category Passaic table where they belong.
 *
 *   Site Performance cards are intentionally asymmetric:
 *     - BNY: yards, active machines, kind-of-work bucket mix.
 *     - Passaic: yards, color-yards, complexity, active tables, shift split.
 *
 * NEW Goods bucket comes from sched_wip_rows where is_new_goods=true.
 * The other 6 BNY buckets come from joining assignments → wip_rows on
 * po_number to inherit customer_type classification.
 *
 * Weeks are Sunday-Saturday (weekStartsOn: 0) to match FSCO's 4/4/5
 * fiscal calendar. sched_assignments and sched_daily_ops store week_start
 * as the Sunday date.
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
const NJ_TOTAL_YARDS_TGT = NJ_TARGETS.fabric.yards + NJ_TARGETS.grass.yards + NJ_TARGETS.paper.yards
const PLANT_YARDS_TGT    = NJ_TOTAL_YARDS_TGT + BNY_TARGETS.total

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
  const [wipRows,        setWipRows]       = useState([])
  const [bnyBucketYards, setBnyBucketYards] = useState({})
  const [wipByStatus,    setWipByStatus]   = useState(null)
  const [loading,        setLoading]       = useState(true)
  const [error,          setError]         = useState(null)

  // Sunday-Saturday week (matches Scheduler convention)
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
        // 1. Schedule (planned) for the week — includes shift
        // 2. Actuals (sched_daily_ops) for the week — includes shift
        // 3. WIP rollup for status bar
        // 4. WIP rows for bucket classification (BNY) + Top Complexity enrichment
        //    (line_description = pattern, color = colorway)
        const [assignRes, opsRes, wipRollupRes, wipFactsRes, wipRowsRes] = await Promise.all([
          supabase
            .from('sched_assignments')
            .select('site, po_number, product_type, table_code, day_of_week, shift, planned_yards, planned_cy, status')
            .eq('week_start', weekKey),
          supabase
            .from('sched_daily_ops')
            .select('site, table_code, day_of_week, shift, actual_yards, waste_yards')
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
            .select('po_number, site, customer_type, product_type, is_new_goods, yards_written, line_description, color'),
        ])

        if (cancelled) return

        const assignRows = assignRes.data || []
        const opsRows    = opsRes.data || []
        const wipRowsData = wipRowsRes.data || []

        setAssignments(assignRows)
        setDailyOps(opsRows)
        setWipRows(wipRowsData)

        // Classify BNY bucket yards from assignments × wip_rows
        setBnyBucketYards(buildBnyBucketYards(assignRows, wipRowsData))

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
            wip_rows_count: wipRowsData.length,
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

  // Shift-aware splits for Site Performance card.
  // Passaic: real 1st/2nd split (hand-screen runs both).
  // BNY: 1st only — BNY machines and Passaic MTO digital don't run 2nd shift.
  const njShift1Agg = aggregateBySite(assignments, dailyOps, 'passaic', '1st')
  const njShift2Agg = aggregateBySite(assignments, dailyOps, 'passaic', '2nd')

  // Active-cells counts for the Site Performance KPI ("active tables/machines")
  const njActiveTables    = countActiveCells(assignments, 'passaic')
  const bnyActiveMachines = countActiveCells(assignments, 'bny')

  // Did anything get scheduled, anywhere?
  const hasSchedule = assignments.length > 0
  // Did any actuals get entered?
  const hasActuals  = dailyOps.some(r => Number(r.actual_yards) > 0)
  const hasRealData = hasSchedule

  // Plant Rollup — yards only. Color-yards is hand-screen-only and lives
  // in the Passaic site detail and per-category sections.
  const plantPlannedYards = njAgg.plannedYards + bnyAgg.plannedYards
  const plantActualYards  = njAgg.actualYards  + bnyAgg.actualYards
  const plantYards = {
    budget: hasSchedule ? plantPlannedYards : PLANT_YARDS_TGT,
    actual: plantActualYards,
  }

  // Per-category Passaic
  const categoryData = buildCategoryData(assignments, dailyOps, wipByStatus)

  // 17-table state — real, derived from today's assignments + actuals
  const tablesState = build17TableState(assignments, dailyOps)

  // Top complexity jobs — Passaic-only, sorted by planned_cy desc, top 5,
  // enriched with pattern (line_description) + color from wip_rows.
  const topJobs = buildTopJobs(assignments, wipRows)

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

      {/* Plant Rollup — yards only */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>The Plant Pulse</div>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionTitleText}>
              <span className={`${styles.sitePill} ${styles.pillPlant}`}>PLANT</span>
              Plant Rollup
            </div>
            <div className={styles.sectionDesc}>
              Yards · the one metric that means the same on both floors.
              Color-yards and complexity live downstairs at Passaic.
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
        ) : (
          <PlantPulse
            yards={plantYards}
            weekStart={weekStart}
            hasActuals={hasActuals}
          />
        )}
      </div>

      {/* Site Performance — middle-layer comparative read */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>Site Performance</div>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionTitleText}>
              <span className={`${styles.sitePill} ${styles.pillPlant}`}>SITES</span>
              Brooklyn vs Passaic
            </div>
            <div className={styles.sectionDesc}>
              Comparative read · cards are intentionally asymmetric — BNY tells a volume story, Passaic tells a labor-cost story.
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading…</div>
        ) : !hasSchedule ? (
          <div className={styles.loading}>
            Site comparison populates once the schedule is built.
          </div>
        ) : (
          <SitePerformance
            njAgg={njAgg}
            bnyAgg={bnyAgg}
            njShift1Agg={njShift1Agg}
            njShift2Agg={njShift2Agg}
            njActiveTables={njActiveTables}
            bnyActiveMachines={bnyActiveMachines}
            bnyMix={mix}
            bnyMixTotal={bnyMixTotal}
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
   PlantPulse — single wide Yards card with budget/actual/variance/pace.
   Inlined here (not in PlantRollup.jsx) so this file is self-contained.
   ═════════════════════════════════════════════════════════════════════════ */

const PP_COLORS = {
  ink:       '#101218',
  paper:     '#F9F8F4',
  linen:     '#E8E5DC',
  linenDark: '#D8D3C5',
  emerald:   '#0F7A4E',
  crimson:   '#C12B1A',
  saffron:   '#E89A1E',
  muted:     '#6b6b6b',
}

const PP_PILL_TONES = {
  on:      { background: '#E0F0E5', color: PP_COLORS.emerald },
  ahead:   { background: '#E0F0E5', color: PP_COLORS.emerald },
  behind:  { background: '#FAE2DE', color: PP_COLORS.crimson },
  pending: { background: PP_COLORS.linen, color: PP_COLORS.muted },
}

const PP_STYLES = {
  card: {
    background: '#fff',
    border: `1px solid ${PP_COLORS.linen}`,
    borderRadius: 6,
    padding: '1.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    color: PP_COLORS.muted,
    textTransform: 'uppercase',
    fontSize: '0.78rem',
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  pill: {
    fontSize: '0.72rem',
    padding: '0.2rem 0.55rem',
    borderRadius: 999,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  barBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.7rem',
  },
  barRow: {
    display: 'grid',
    gridTemplateColumns: '80px 1fr auto',
    alignItems: 'center',
    gap: '1rem',
  },
  barLabel: {
    color: PP_COLORS.muted,
    fontSize: '0.78rem',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  barTrack: {
    height: 10,
    background: PP_COLORS.linen,
    borderRadius: 5,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 5,
    transition: 'width 0.3s ease',
  },
  barValue: {
    fontFamily: 'Georgia, serif',
    fontSize: '1.5rem',
    fontWeight: 600,
    color: PP_COLORS.ink,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '120px',
    textAlign: 'right',
  },
  summaryRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '1rem',
    paddingTop: '0.75rem',
    borderTop: `1px solid ${PP_COLORS.linen}`,
  },
  summaryItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
  },
  summaryLabel: {
    color: PP_COLORS.muted,
    fontSize: '0.7rem',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  summaryValue: {
    color: PP_COLORS.ink,
    fontSize: '0.95rem',
    fontVariantNumeric: 'tabular-nums',
  },
}

function PlantPulse({ yards, weekStart, hasActuals }) {
  const budget = yards.budget
  const actual = yards.actual
  const variance     = budget > 0 ? ((actual - budget) / budget) * 100 : 0
  const trackingPct  = budget > 0 ? (actual / budget) * 100 : 0
  const actualBarPct = budget > 0 ? Math.min(100, (actual / budget) * 100) : 0

  // Day-of-week pace projection. Sunday-Saturday week.
  const today    = new Date()
  const ws       = startOfWeek(weekStart, { weekStartsOn: 0 })
  const msPerDay = 1000 * 60 * 60 * 24
  const rawDays  = Math.floor((today - ws) / msPerDay) + 1
  const daysElapsed = Math.min(7, Math.max(0, rawDays))
  const projected   = daysElapsed > 0 && hasActuals ? actual * (7 / daysElapsed) : 0

  // Status pill — "on/ahead/behind/pending"
  const tone = !hasActuals ? 'pending'
            : Math.abs(variance) < 5 ? 'on'
            : variance < 0 ? 'behind'
            : 'ahead'
  const pillLabel = !hasActuals ? 'Awaiting Actuals'
                  : tone === 'on' ? 'On Pace'
                  : tone === 'ahead' ? 'Ahead'
                  : 'Behind Pace'

  const fillColor = !hasActuals ? PP_COLORS.linenDark
                  : tone === 'behind' ? PP_COLORS.crimson
                  : tone === 'ahead' ? PP_COLORS.emerald
                  : PP_COLORS.emerald

  return (
    <div style={PP_STYLES.card}>
      <div style={PP_STYLES.headerRow}>
        <div style={PP_STYLES.label}>Yards</div>
        <span style={{...PP_STYLES.pill, ...PP_PILL_TONES[tone]}}>{pillLabel}</span>
      </div>

      <div style={PP_STYLES.barBlock}>
        <div style={PP_STYLES.barRow}>
          <span style={PP_STYLES.barLabel}>Budget</span>
          <div style={PP_STYLES.barTrack}>
            <div style={{...PP_STYLES.barFill, background: PP_COLORS.linenDark, width: '100%'}} />
          </div>
          <span style={PP_STYLES.barValue}>{fmt(budget)} yds</span>
        </div>
        <div style={PP_STYLES.barRow}>
          <span style={PP_STYLES.barLabel}>Actual</span>
          <div style={PP_STYLES.barTrack}>
            <div style={{...PP_STYLES.barFill, background: fillColor, width: `${actualBarPct}%`}} />
          </div>
          <span style={PP_STYLES.barValue}>{fmt(actual)} yds</span>
        </div>
      </div>

      <div style={PP_STYLES.summaryRow}>
        <div style={PP_STYLES.summaryItem}>
          <span style={PP_STYLES.summaryLabel}>Tracking</span>
          <span style={PP_STYLES.summaryValue}>
            {hasActuals ? `${trackingPct.toFixed(0)}% of budget` : '0% of budget'}
          </span>
        </div>
        <div style={PP_STYLES.summaryItem}>
          <span style={PP_STYLES.summaryLabel}>Variance</span>
          <span style={{
            ...PP_STYLES.summaryValue,
            color: !hasActuals ? PP_COLORS.muted
                 : variance < -5 ? PP_COLORS.crimson
                 : variance > 5  ? PP_COLORS.emerald
                 : PP_COLORS.ink,
            fontWeight: hasActuals ? 600 : 400,
          }}>
            {hasActuals ? `${variance >= 0 ? '+' : ''}${variance.toFixed(0)}%` : '—'}
          </span>
        </div>
        <div style={PP_STYLES.summaryItem}>
          <span style={PP_STYLES.summaryLabel}>Pace</span>
          <span style={PP_STYLES.summaryValue}>
            {!hasActuals
              ? <span style={{color: PP_COLORS.muted, fontStyle: 'italic'}}>schedule built · awaiting actuals</span>
              : daysElapsed === 0
                ? <span style={{color: PP_COLORS.muted, fontStyle: 'italic'}}>week not yet started</span>
                : `Day ${daysElapsed} of 7 · projected ${fmt(projected)} yds`
            }
          </span>
        </div>
      </div>
    </div>
  )
}

/* ═════════════════════════════════════════════════════════════════════════
   SitePerformance — middle-layer comparative read
   BNY card + Passaic card side-by-side. Cards are intentionally asymmetric:
     - BNY: yards, active machines, kind-of-work bucket mix.
     - Passaic: yards, color-yards, complexity, active tables, shift split.
   Color-yards is hand-screen-only; digital prints all colors in one pass.
   ═════════════════════════════════════════════════════════════════════════ */

const SP_COLORS = {
  ink:     '#101218',
  paper:   '#F9F8F4',
  linen:   '#E8E5DC',
  bny:     '#E89A1E',
  passaic: '#D33A28',
  emerald: '#0F7A4E',
  crimson: '#C12B1A',
  saffron: '#E89A1E',
  royal:   '#1E4FA8',
  muted:   '#6b6b6b',
}

const SP_STYLES = {
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1rem',
    marginTop: '0.5rem',
  },
  card: {
    background: '#fff',
    border: `1px solid ${SP_COLORS.linen}`,
    borderRadius: 6,
    padding: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    paddingBottom: '0.5rem',
    borderBottom: `1px solid ${SP_COLORS.linen}`,
  },
  title: {
    fontFamily: 'Georgia, serif',
    fontSize: '1.4rem',
    color: SP_COLORS.ink,
    fontWeight: 600,
    marginTop: '0.25rem',
  },
  meta: {
    fontSize: '0.78rem',
    color: SP_COLORS.muted,
    fontStyle: 'italic',
  },
  kpi: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    fontSize: '0.95rem',
  },
  kpiLabel: {
    color: SP_COLORS.muted,
    textTransform: 'uppercase',
    fontSize: '0.72rem',
    letterSpacing: '0.06em',
  },
  kpiValue: {
    color: SP_COLORS.ink,
    fontVariantNumeric: 'tabular-nums',
  },
  kpiActual: {
    fontWeight: 700,
    fontSize: '1.05rem',
  },
  kpiPlanned: {
    color: SP_COLORS.muted,
    fontSize: '0.85rem',
  },
  varBadge: {
    marginLeft: '0.5rem',
    fontSize: '0.78rem',
    padding: '0.1rem 0.4rem',
    borderRadius: 3,
    fontWeight: 600,
  },
  subBlock: {
    marginTop: '0.5rem',
    paddingTop: '0.75rem',
    borderTop: `1px dashed ${SP_COLORS.linen}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  },
  subBlockTitle: {
    fontSize: '0.7rem',
    color: SP_COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  subRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.85rem',
  },
  subLabel: {
    color: SP_COLORS.ink,
    fontWeight: 500,
  },
  subValue: {
    color: SP_COLORS.muted,
    fontVariantNumeric: 'tabular-nums',
  },
}

const SP_VAR_TONES = {
  on:      { background: '#E0F0E5', color: SP_COLORS.emerald },
  ahead:   { background: '#E0F0E5', color: SP_COLORS.emerald },
  behind:  { background: '#FAE2DE', color: SP_COLORS.crimson },
  pending: { background: SP_COLORS.linen, color: SP_COLORS.muted },
  neutral: { background: SP_COLORS.linen, color: SP_COLORS.muted },
}

function SitePerformance({
  njAgg, bnyAgg,
  njShift1Agg, njShift2Agg,
  njActiveTables, bnyActiveMachines,
  bnyMix, bnyMixTotal,
}) {
  const njComplexity = njAgg.actualYards > 0
    ? njAgg.actualColorYards / njAgg.actualYards
    : (njAgg.plannedYards > 0 ? njAgg.plannedColorYards / njAgg.plannedYards : 0)

  return (
    <div style={SP_STYLES.row}>
      {/* Brooklyn — yards, machines, kind-of-work */}
      <div style={SP_STYLES.card}>
        <div style={SP_STYLES.header}>
          <div>
            <span className={`${styles.sitePill} ${styles.pillBny}`}>BNY</span>
          </div>
          <div style={SP_STYLES.title}>Brooklyn · Digital</div>
          <div style={SP_STYLES.meta}>1st shift only · 19 machines · digital prints colors in a single pass</div>
        </div>

        <SitePerfKpi label="Yards" planned={bnyAgg.plannedYards} actual={bnyAgg.actualYards} unit="yds" />
        <SitePerfKpi label="Active machines" planned={bnyActiveMachines} actual={bnyActiveMachines} unit="" suffix=" of 19" plainCount />

        {bnyMixTotal > 0 && (
          <div style={SP_STYLES.subBlock}>
            <div style={SP_STYLES.subBlockTitle}>Kind of work</div>
            {bnyMix
              .filter(b => b.yards > 0)
              .map(b => (
                <div key={b.label} style={SP_STYLES.subRow}>
                  <span style={SP_STYLES.subLabel}>{b.label}</span>
                  <span style={SP_STYLES.subValue}>
                    {fmt(b.yards)} yds · {b.pct.toFixed(0)}%
                  </span>
                </div>
              ))
            }
          </div>
        )}
      </div>

      {/* Passaic — full hand-screen picture */}
      <div style={SP_STYLES.card}>
        <div style={SP_STYLES.header}>
          <div>
            <span className={`${styles.sitePill} ${styles.pillPassaic}`}>NJ</span>
          </div>
          <div style={SP_STYLES.title}>Passaic · Screen Print</div>
          <div style={SP_STYLES.meta}>1st + 2nd shift · 17 hand-screen + MTO digital fleet</div>
        </div>

        <SitePerfKpi label="Yards" planned={njAgg.plannedYards} actual={njAgg.actualYards} unit="yds" />
        <SitePerfKpi label="Color-Yards" planned={njAgg.plannedColorYards} actual={njAgg.actualColorYards} unit="cyds" />
        <SitePerfKpi
          label="Complexity"
          planned={njAgg.plannedYards > 0 ? njAgg.plannedColorYards / njAgg.plannedYards : 0}
          actual={njComplexity}
          unit=""
          decimals={2}
          suffix=" colors/yd"
        />
        <SitePerfKpi label="Active tables" planned={njActiveTables} actual={njActiveTables} unit="" suffix=" of 17 hand-screen" plainCount />

        {(njShift1Agg.plannedYards + njShift2Agg.plannedYards) > 0 && (
          <div style={SP_STYLES.subBlock}>
            <div style={SP_STYLES.subBlockTitle}>Shift split</div>
            <div style={SP_STYLES.subRow}>
              <span style={SP_STYLES.subLabel}>1st shift (6:30a–3p)</span>
              <span style={SP_STYLES.subValue}>
                {fmt(njShift1Agg.plannedYards)} yds planned · {fmt(njShift1Agg.actualYards)} yds actual
              </span>
            </div>
            <div style={SP_STYLES.subRow}>
              <span style={SP_STYLES.subLabel}>2nd shift (3p–11p)</span>
              <span style={SP_STYLES.subValue}>
                {njShift2Agg.plannedYards > 0
                  ? `${fmt(njShift2Agg.plannedYards)} yds planned · ${fmt(njShift2Agg.actualYards)} yds actual`
                  : 'no 2nd-shift schedule this week'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SitePerfKpi({ label, planned, actual, unit, decimals = 0, suffix = '', plainCount = false }) {
  const fmtNum = (n) => decimals > 0 ? n.toFixed(decimals) : Math.round(n).toLocaleString()
  const variance = planned > 0 ? ((actual - planned) / planned) * 100 : 0
  const tone = plainCount ? 'neutral'
            : actual === 0 && planned > 0 ? 'pending'
            : Math.abs(variance) < 5 ? 'on'
            : variance < 0 ? 'behind'
            : 'ahead'

  if (plainCount) {
    return (
      <div style={SP_STYLES.kpi}>
        <span style={SP_STYLES.kpiLabel}>{label}</span>
        <span style={SP_STYLES.kpiValue}>
          <span style={SP_STYLES.kpiActual}>{fmtNum(actual)}</span>
          <span style={SP_STYLES.kpiPlanned}>{suffix}</span>
        </span>
      </div>
    )
  }
  return (
    <div style={SP_STYLES.kpi}>
      <span style={SP_STYLES.kpiLabel}>{label}</span>
      <span style={SP_STYLES.kpiValue}>
        <span style={SP_STYLES.kpiActual}>{fmtNum(actual)}</span>
        <span style={SP_STYLES.kpiPlanned}>
          {' '}/ {fmtNum(planned)} {unit}{suffix}
        </span>
        {planned > 0 && (
          <span style={{...SP_STYLES.varBadge, ...SP_VAR_TONES[tone]}}>
            {variance >= 0 ? '+' : ''}{variance.toFixed(0)}%
          </span>
        )}
      </span>
    </div>
  )
}

function fmt(n) { return Math.round(n).toLocaleString() }

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
 *
 * Note: BNY assignments are expected to have planned_cy = 0 (digital prints all
 * colors in one pass; color-yards is a hand-screen labor unit). The math still
 * runs cleanly for BNY — it just produces 0 cyds, which is correct.
 *
 * @param {string|null} shiftFilter — when provided ('1st' | '2nd'), only rows
 *   matching that shift contribute. When omitted/null, both shifts roll up.
 */
function aggregateBySite(assignments, dailyOps, site, shiftFilter = null) {
  let plannedYards = 0
  let plannedColorYards = 0
  let actualYards = 0
  let actualColorYards = 0

  // Sum planned by cell (site, table_code, day_of_week, shift) and remember the
  // planned ratio so we can interpolate actual color-yards.
  const cellPlanned = new Map()
  assignments.forEach(a => {
    if (a.site !== site) return
    if (shiftFilter && a.shift !== shiftFilter) return
    const py = num(a.planned_yards)
    const pcy = num(a.planned_cy)
    plannedYards += py
    plannedColorYards += pcy
    const key = `${a.table_code}|${a.day_of_week}|${a.shift || '1st'}`
    const prev = cellPlanned.get(key) || { y: 0, cy: 0 }
    cellPlanned.set(key, { y: prev.y + py, cy: prev.cy + pcy })
  })

  dailyOps.forEach(o => {
    if (o.site !== site) return
    if (shiftFilter && o.shift !== shiftFilter) return
    const ay = num(o.actual_yards)
    actualYards += ay
    const key = `${o.table_code}|${o.day_of_week}|${o.shift || '1st'}`
    const planned = cellPlanned.get(key)
    if (planned && planned.y > 0) {
      actualColorYards += ay * (planned.cy / planned.y)
    }
  })

  return { plannedYards, plannedColorYards, actualYards, actualColorYards }
}

/**
 * Count distinct (table_code, shift) cells with at least one assignment.
 * Active = something is scheduled there this week.
 */
function countActiveCells(assignments, site) {
  const cells = new Set()
  assignments.forEach(a => {
    if (a.site !== site) return
    cells.add(`${a.table_code}|${a.shift || '1st'}`)
  })
  return cells.size
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
 *
 * Two changes vs. earlier version:
 *   1. Filtered to site === 'passaic' so BNY assignments (which have planned_cy = 0
 *      by design) can never accidentally surface. Defensive — they'd sort to
 *      the bottom anyway, but explicit is better.
 *   2. Joined to wip_rows by po_number for pattern + color enrichment.
 *      Headline becomes "Pattern · Color"; PO + spec moves to meta line.
 *      In-memory dedup by Map.set semantics — no SQL JOIN duplication concern.
 */
function buildTopJobs(assignments, wipRows) {
  // Index wip rows by po_number. Map.set with same key overwrites, so we get
  // one wip row per PO regardless of how many snapshots contain that PO.
  // This is the JS equivalent of SELECT DISTINCT ON (po_number).
  const wipByPo = new Map()
  wipRows.forEach(w => {
    if (!wipByPo.has(w.po_number)) wipByPo.set(w.po_number, w)
  })

  // Aggregate per po_number (a PO can have multiple table-day lines).
  const byPo = new Map()
  assignments.forEach(a => {
    if (a.site !== 'passaic') return
    const key = a.po_number
    const prev = byPo.get(key) || {
      po: a.po_number, product_type: a.product_type, table_code: a.table_code,
      yards: 0, colorYds: 0,
    }
    prev.yards    += num(a.planned_yards)
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

      const wip     = wipByPo.get(j.po)
      const pattern = wip?.line_description || ''
      const color   = wip?.color || ''

      // Headline: Pattern · Color when both present, fall back gracefully.
      const name = pattern && color ? `${pattern} · ${color}`
                 : pattern ? pattern
                 : color   ? color
                 : j.po
      // Meta: PO + product type + table + yard/color spec.
      const meta = [
        j.po,
        j.product_type,
        j.table_code,
        `${Math.round(j.yards)} yd · ${colors.toFixed(0)} colors`,
      ].filter(Boolean).join(' · ')

      return {
        name, meta, badge, tone,
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
  // Case/whitespace-tolerant matcher. Scheduler writes table_code = machine.name
  // (e.g. 'Glow', 'EMBER', 'Dakota Ka'). The constant here uses the lowercase
  // snake_case form from the Section 12 contract ('glow', 'ember', 'dakota_ka').
  // Both describe the same machine — normalize both sides so the comparison
  // succeeds. Without this, every per-machine card showed "0 / target 0"
  // even when the machine had assignments.
  //
  // Long-term debt: BNYScheduler should normalize before writing so the DB
  // values match the contract. Until then, this read-side normalization is
  // the safety net.
  const norm = (s) => (s || '').toLowerCase().replace(/[\s_-]/g, '')

  return BNY_MACHINES.map(m => {
    const key = norm(m.table_code)
    const plan = assignments
      .filter(a => a.site === 'bny' && norm(a.table_code) === key)
      .reduce((s, a) => s + num(a.planned_yards), 0)
    const actual = dailyOps
      .filter(o => o.site === 'bny' && norm(o.table_code) === key)
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
