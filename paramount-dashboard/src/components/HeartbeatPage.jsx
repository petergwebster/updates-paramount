import React, { useState, useEffect } from 'react'
import { format, startOfWeek } from 'date-fns'
import { supabase } from '../supabase'
import { getFiscalLabel } from '../fiscalCalendar'
import PlantRollup from './PlantRollup'
import PassaicSection from './PassaicSection'
import BNYSection from './BNYSection'
import ClaudeReadBlock from './ClaudeReadBlock'
import { buildHeartbeatNarrativePrompt } from '../prompts/heartbeatNarrative'
import styles from './HeartbeatPage.module.css'

/**
 * HeartbeatPage — the deep operational view.
 *
 * Composition (top to bottom):
 *   1. Page hero with pulsing dot ("Live · Plant Pulse")
 *   2. Plant Rollup (3 cards: Yards / Color-Yards / Complexity)
 *   3. Passaic section (NJ deep dive)
 *   4. BNY section (Brooklyn machines + mix)
 *   5. Claude's Read (heartbeat narrative)
 *
 * Data sourcing:
 *   - Production data: live from `production` table (current week)
 *   - WIP-by-status: live from `business_facts` (seeded by Phase B SQL,
 *     will be replaced by `wip_snapshots` when Push 2 wires upload UI)
 *   - Targets: inline constants matching DashboardPage's NJ_TARGETS / BNY_TARGETS
 *   - 17-table state and top jobs: illustrative for Push 1
 *     (will wire to scheduler in Push 3)
 *
 * Props:
 *   weekStart    — selected week (Date)
 *   currentUser  — full name for Claude attribution
 *   userId       — auth UUID for Claude attribution
 */

// ─── Targets (must match DashboardPage.jsx — kept inline for self-containment) ──
const NJ_TARGETS = {
  fabric: { yards: 810,  colorYards: 4522  },
  grass:  { yards: 3615, colorYards: 7570  },
  paper:  { yards: 4185, colorYards: 13405 },
}
const BNY_TARGETS = {
  total: 12000,
  glow:  3600,
  sasha: 3600,
  trish: 3600,
  per570: 600, // per machine
}
const NJ_TOTAL_YARDS_TGT      = NJ_TARGETS.fabric.yards      + NJ_TARGETS.grass.yards      + NJ_TARGETS.paper.yards
const NJ_TOTAL_COLORYARDS_TGT = NJ_TARGETS.fabric.colorYards + NJ_TARGETS.grass.colorYards + NJ_TARGETS.paper.colorYards
const PLANT_YARDS_TGT         = NJ_TOTAL_YARDS_TGT + BNY_TARGETS.total

// ──────────────────────────────────────────────────────────────────────────────
export default function HeartbeatPage({ weekStart, currentUser, userId }) {
  const [productionRow, setProductionRow] = useState(null)
  const [wipByStatus,   setWipByStatus]   = useState(null)
  const [loading,       setLoading]       = useState(true)

  const weekKey = format(startOfWeek(weekStart, { weekStartsOn: 1 }), 'yyyy-MM-dd')
  const fiscalLabel = getFiscalLabel(weekStart)

  // ── Load this week's production + the latest WIP-by-status ─────────
  // WIP comes from v_current_wip_rollup (the parsed file upload).
  // Fallback to business_facts seed if no upload yet exists.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      supabase.from('production').select('*').eq('week_start', weekKey).maybeSingle(),
      supabase.from('v_current_wip_rollup').select('yard_order_status, num_orders, yards_written'),
      supabase.from('business_facts').select('fact_number, fact').eq('category', 'wip-passaic').eq('active', true).order('fact_number'),
    ]).then(([prodRes, wipRollupRes, wipFactsRes]) => {
      if (cancelled) return
      setProductionRow(prodRes.data || null)

      // Prefer the live snapshot rollup; fall back to seeded facts
      const rollupRows = wipRollupRes.data || []
      if (rollupRows.length > 0) {
        setWipByStatus(parseWipRollupRows(rollupRows))
      } else {
        setWipByStatus(parseWipFacts(wipFactsRes.data || []))
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [weekKey])

  // ── Build the data shapes each subcomponent needs ───────────────────
  const njData  = extractNjData(productionRow)
  const bnyData = extractBnyData(productionRow)

  // Plant rollup numbers
  const plantYards = {
    budget: PLANT_YARDS_TGT,
    actual: (njData.totalYards || 0) + (bnyData.totalYards || 0),
  }
  const plantColorYards = {
    budget: NJ_TOTAL_COLORYARDS_TGT, // BNY doesn't track color-yards (digital is single-pass)
    actual: njData.totalColorYards || 0,
  }
  const plantComplexity = {
    budget: NJ_TOTAL_COLORYARDS_TGT / NJ_TOTAL_YARDS_TGT, // ~3.13
    actual: njData.totalYards > 0
      ? (njData.totalColorYards || 0) / njData.totalYards
      : NJ_TOTAL_COLORYARDS_TGT / NJ_TOTAL_YARDS_TGT,
  }

  // Per-category data for Passaic
  const categoryData = buildCategoryData(njData, wipByStatus)

  // 17-table state — illustrative for Push 1 (real wiring is Push 3)
  const tablesState = buildIllustrativeTablesState(njData)

  // Top complexity jobs — illustrative for Push 1
  const topJobs = ILLUSTRATIVE_TOP_JOBS

  // BNY machines + mix
  const machines = buildBnyMachines(bnyData)
  const { mix, totalYards: bnyMixTotal } = buildBnyMix(bnyData)

  // Claude prompt builder
  const buildPrompt = ({ contextString }) => buildHeartbeatNarrativePrompt({
    contextString,
    hasData: !!productionRow,
  })

  return (
    <div className={styles.page}>

      {/* ── Hero ── */}
      <div className={styles.pageHero}>
        <div>
          <div className={styles.heartbeatEyebrow}>
            <span className={styles.pulseDot} />
            Live · Plant Pulse
          </div>
          <h1 className={styles.pageTitle}>Paramount's Heartbeat</h1>
          <p className={styles.pageSub}>
            Where we are right now on the journey to plan. Plant rollup at top,
            then Passaic and Brooklyn — yards, color-yards, capacity, and what's blocking us.
          </p>
        </div>
        <div className={styles.pageMeta}>
          <div className={styles.pageMetaWeek}>Week of {format(weekStart, 'MMM d')}</div>
          {fiscalLabel && <div className={styles.pageMetaSub}>{fiscalLabel}</div>}
          <div className={styles.pageMetaUpdated}>Updated {format(new Date(), 'h:mma').toLowerCase()}</div>
        </div>
      </div>

      {/* ── Section: Plant Rollup ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>The Two-Measure Picture</div>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionTitleText}>
              <span className={`${styles.sitePill} ${styles.pillPlant}`}>PLANT</span>
              Plant Rollup
            </div>
            <div className={styles.sectionDesc}>
              Combined Passaic + Brooklyn · the headline read.
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading production data…</div>
        ) : (
          <PlantRollup
            yards={plantYards}
            colorYards={plantColorYards}
            complexity={plantComplexity}
          />
        )}
      </div>

      {/* ── Section: Passaic ── */}
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

      {/* ── Section: BNY ── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionEyebrow}>Site Detail</div>
          <div className={styles.sectionTitle}>
            <div className={styles.sectionTitleText}>
              <span className={`${styles.sitePill} ${styles.pillBny}`}>BNY</span>
              Brooklyn · Digital
            </div>
            <div className={styles.sectionDesc}>
              7 machines · 3 HP 3600s + 4 HP 570s · digital is volume, not complexity.
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

      {/* ── Section: Claude's Read ── */}
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
   Helpers — extract from production row, build component shapes
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Production row stores nj_data and bny_data as JSON. Extract NJ totals.
 * Defensive — production row may not exist for the week yet.
 */
function extractNjData(row) {
  const nj = row?.nj_data || {}
  return {
    totalYards:      Number(nj.totalYards      || nj.netYards || 0),
    totalColorYards: Number(nj.colorYards      || nj.totalColorYards || 0),
    fabricYards:     Number(nj.fabricYards     || nj.fabric    || 0),
    grassYards:      Number(nj.grassYards      || nj.grass     || 0),
    paperYards:      Number(nj.paperYards      || nj.paper     || 0),
    fabricColorYards: Number(nj.fabricColorYards || 0),
    grassColorYards:  Number(nj.grassColorYards  || 0),
    paperColorYards:  Number(nj.paperColorYards  || 0),
  }
}

function extractBnyData(row) {
  const bny = row?.bny_data || {}
  return {
    totalYards: Number(bny.totalYards || bny.total || 0),
    glow:       Number(bny.glow       || bny.glow_yards    || 0),
    sasha:      Number(bny.sasha      || bny.sasha_yards   || 0),
    trish:      Number(bny.trish      || bny.trish_yards   || 0),
    bianca:     Number(bny.bianca     || bny.bianca_yards  || 0),
    lash:       Number(bny.lash       || bny.lash_yards    || 0),
    chyna:      Number(bny.chyna      || bny.chyna_yards   || 0),
    rhonda:     Number(bny.rhonda     || bny.rhonda_yards  || 0),
    replen:     Number(bny.replen     || 0),
    custom:     Number(bny.custom     || 0),
    mto:        Number(bny.mto        || 0),
    hos:        Number(bny.hos        || 0),
    memo:       Number(bny.memo       || 0),
    threeP:     Number(bny.threeP     || bny['3p'] || 0),
    newGoods:   Number(bny.newGoods   || bny['new'] || 0),
  }
}

/**
 * Parse the seeded WIP-by-status facts into the shape WIPStatusBar wants.
 * Each fact looks like: "Passaic Screen Print WIP — Orders Unallocated: 7,024 yards (114 orders)"
 */
function parseWipFacts(facts) {
  if (!facts.length) return null
  const out = {
    unallocated:        { yards: 0, orders: 0 },
    waitingApproval:    { yards: 0, orders: 0 },
    waitingMaterial:    { yards: 0, orders: 0 },
    approvedToPrint:    { yards: 0, orders: 0 },
    readyToPrint:       { yards: 0, orders: 0 },
    inPacking:          { yards: 0, orders: 0 },
    inProgress:         { yards: 0, orders: 0 },
    strikeOff:          { yards: 0, orders: 0 },
    inMixingQueue:      { yards: 0, orders: 0 },
  }
  const labelMap = {
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
  facts.forEach(f => {
    // Match e.g. "— Orders Unallocated: 7,024 yards (114 orders)"
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

/**
 * Parse rows from v_current_wip_rollup into the shape WIPStatusBar wants.
 * Sums across all (division, third_party_vs_house) groupings — Heartbeat
 * shows total Passaic WIP by status regardless of customer.
 *
 * Each row has: yard_order_status, num_orders, yards_written
 */
function parseWipRollupRows(rows) {
  if (!rows || rows.length === 0) return null
  const out = {
    unallocated:        { yards: 0, orders: 0 },
    waitingApproval:    { yards: 0, orders: 0 },
    waitingMaterial:    { yards: 0, orders: 0 },
    approvedToPrint:    { yards: 0, orders: 0 },
    readyToPrint:       { yards: 0, orders: 0 },
    inPacking:          { yards: 0, orders: 0 },
    inProgress:         { yards: 0, orders: 0 },
    strikeOff:          { yards: 0, orders: 0 },
    inMixingQueue:      { yards: 0, orders: 0 },
  }
  const statusMap = {
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
  rows.forEach(r => {
    const key = statusMap[r.yard_order_status]
    if (!key) return
    out[key].yards  += Number(r.yards_written || 0)
    out[key].orders += Number(r.num_orders || 0)
  })
  return out
}

/**
 * Build the category data array for PassaicSection.
 * Mixes real-this-week production with stable bottleneck framing.
 */
function buildCategoryData(nj, wipByStatus) {
  const grassActiveTables  = nj.grassYards  > 0 ? 2 : 0
  const fabricActiveTables = nj.fabricYards > 0 ? estimateActiveTables(nj.fabricYards, 9) : 0
  const wpActiveTables     = nj.paperYards  > 0 ? estimateActiveTables(nj.paperYards,  6) : 0

  return [
    {
      id: 'grass',
      name: 'Grasscloth',
      tableRange: 'Tables 1–2',
      floor: '2nd floor',
      tableCount: 2,
      crews: 2,
      ratio: '1:1',
      utilPct: (grassActiveTables / 2) * 100,
      utilTone: grassActiveTables === 2 ? 'emerald' : grassActiveTables === 1 ? 'saffron' : 'crimson',
      utilDetail: `${grassActiveTables} of 2 active · ~1,430 yds/wk capacity`,
      yards: nj.grassYards,
      colorYds: nj.grassColorYards || Math.round(nj.grassYards * 1.8),
      avgColors: nj.grassYards > 0 ? (nj.grassColorYards / nj.grassYards) || 1.8 : 1.8,
      pacingNote: nj.grassYards > 0 ? 'on-pace for category' : 'no production yet this week',
      bottleneck: {
        tone: 'crimson',
        label: 'Material-blocked',
        text: 'Korean material lead time ~6 mo. Watch material-ETA gate; runnable queue scales when material unblocks.',
      },
    },
    {
      id: 'fabric',
      name: 'Fabric',
      tableRange: 'Tables 3–11',
      floor: '2nd floor',
      tableCount: 9,
      crews: 2,
      ratio: '4.5:1',
      utilPct: (fabricActiveTables / 9) * 100,
      utilTone: fabricActiveTables >= 4 ? 'emerald' : fabricActiveTables >= 2 ? 'saffron' : 'crimson',
      utilDetail: `${fabricActiveTables} of 9 active · ${9 - fabricActiveTables} idle`,
      yards: nj.fabricYards,
      colorYds: nj.fabricColorYards || Math.round(nj.fabricYards * 3.9),
      avgColors: nj.fabricYards > 0 ? (nj.fabricColorYards / nj.fabricYards) || 3.9 : 3.9,
      pacingNote: 'capacity-limited by supply',
      bottleneck: {
        tone: 'saffron',
        label: 'Supply-constrained',
        text: 'Mixing→Ready is the gate, not print speed. Watch the In Mixing Queue → Ready to Print transition.',
      },
    },
    {
      id: 'paper',
      name: 'Wallpaper',
      tableRange: 'Tables 12–17',
      floor: '3rd floor',
      tableCount: 6,
      crews: 3,
      ratio: '2:1',
      utilPct: (wpActiveTables / 6) * 100,
      utilTone: wpActiveTables >= 4 ? 'emerald' : wpActiveTables >= 2 ? 'saffron' : 'crimson',
      utilDetail: `${wpActiveTables} of 6 active · Table 17 dedicated to Citrus Garden`,
      yards: nj.paperYards,
      colorYds: nj.paperColorYards || Math.round(nj.paperYards * 5.2),
      avgColors: nj.paperYards > 0 ? (nj.paperColorYards / nj.paperYards) || 5.2 : 5.2,
      pacingNote: 'heavy complexity load',
      bottleneck: {
        tone: 'royal',
        label: 'Complexity-bound · Citrus Garden',
        text: '25% of WP color-yds = Citrus Garden alone. Output swings 4× weekly on stops setup.',
      },
    },
  ]
}

function estimateActiveTables(yards, totalTables) {
  // Rough heuristic: assume ~75 yards/wk per active fabric table
  // Cap at totalTables. This is illustrative until we have real schedule data.
  if (yards === 0) return 0
  const yardPerTable = 75
  return Math.min(Math.max(1, Math.round(yards / yardPerTable)), totalTables)
}

/**
 * Build illustrative 17-table state. Wire to scheduler in Push 3.
 */
function buildIllustrativeTablesState(nj) {
  // Active counts derived from production this week
  const grassActive = nj.grassYards > 0 ? 2 : 0
  const fabricActive = estimateActiveTables(nj.fabricYards, 9)
  const wpActive = estimateActiveTables(nj.paperYards, 6)

  const tables = []
  // Tables 1-2 = Grass
  for (let i = 1; i <= 2; i++) {
    tables.push({
      number: i, category: 'gc',
      label: i <= grassActive ? 'GC' : 'idle',
      status: i <= grassActive ? 'running' : 'idle',
    })
  }
  // Tables 3-11 = Fabric
  for (let i = 3; i <= 11; i++) {
    const offset = i - 2
    tables.push({
      number: i, category: 'fab',
      label: offset <= fabricActive ? 'FAB' : 'idle',
      status: offset <= fabricActive ? 'running' : 'idle',
    })
  }
  // Tables 12-17 = Wallpaper. Table 17 dedicated to Citrus.
  for (let i = 12; i <= 17; i++) {
    const offset = i - 11
    let status, label
    if (i === 17) {
      status = wpActive > 0 ? 'running' : 'idle'
      label = wpActive > 0 ? 'CITRUS' : 'idle'
    } else if (offset <= wpActive) {
      status = 'running'
      label = 'WP'
    } else {
      status = 'idle'
      label = 'idle'
    }
    tables.push({ number: i, category: 'wp', label, status })
  }
  return tables
}

/**
 * Top complexity jobs — illustrative for Push 1.
 * Wire to sched_assignments + PO color counts in Push 3.
 */
const ILLUSTRATIVE_TOP_JOBS = [
  {
    name: 'Citrus Garden — Panel A & B',
    meta: 'Wallpaper · 8 colors · Table 17 dedicated · in progress',
    badge: '25% of WP demand', tone: 'crimson',
    colorYds: 29664, yards: 3708, colors: 8.0,
  },
  {
    name: 'Les Indiennes',
    meta: 'Fabric · 10 colors · Table 7 · scheduled this week',
    badge: '10c · margin pressure', tone: 'crimson',
    colorYds: 2500, yards: 250, colors: 10.0,
  },
  {
    name: 'Louisa Floral (#1 + #2)',
    meta: 'Fabric · 8 colors · Table 3 · in progress',
    badge: '8c · watch', tone: 'saffron',
    colorYds: 1920, yards: 240, colors: 8.0,
  },
  {
    name: 'Birds & Butterflies (7c)',
    meta: 'Wallpaper · 7 colors · Table 13 · in progress',
    badge: '7c', tone: 'saffron',
    colorYds: 1260, yards: 180, colors: 7.0,
  },
  {
    name: 'Enchanted Garden',
    meta: 'Fabric · 8 colors · Table 7 · queued',
    badge: '8c · queued', tone: 'neutral',
    colorYds: 800, yards: 100, colors: 8.0,
  },
]

/**
 * Build BNY machine card data from production row.
 */
function buildBnyMachines(bny) {
  return [
    { name: 'Glow',    kind: '3600', actual: bny.glow   || 0, target: BNY_TARGETS.glow    },
    { name: 'Sasha',   kind: '3600', actual: bny.sasha  || 0, target: BNY_TARGETS.sasha   },
    { name: 'Trish',   kind: '3600', actual: bny.trish  || 0, target: BNY_TARGETS.trish   },
    { name: 'Bianca',  kind: '570',  actual: bny.bianca || 0, target: BNY_TARGETS.per570  },
    { name: 'LASH',    kind: '570',  actual: bny.lash   || 0, target: BNY_TARGETS.per570  },
    { name: 'Chyna',   kind: '570',  actual: bny.chyna  || 0, target: BNY_TARGETS.per570  },
    { name: 'Rhonda',  kind: '570',  actual: bny.rhonda || 0, target: BNY_TARGETS.per570  },
  ]
}

/**
 * Build the BNY mix bars from production row.
 */
function buildBnyMix(bny) {
  const buckets = [
    { label: 'Replen',    yards: bny.replen   || 0, tone: 'emerald' },
    { label: 'Custom',    yards: bny.custom   || 0, tone: 'royal'   },
    { label: 'MTO',       yards: bny.mto      || 0, tone: 'saffron' },
    { label: 'HOS',       yards: bny.hos      || 0, tone: 'emerald' },
    { label: 'Memo',      yards: bny.memo     || 0, tone: 'muted'   },
    { label: '3P',        yards: bny.threeP   || 0, tone: 'muted'   },
    { label: 'NEW Goods', yards: bny.newGoods || 0, tone: 'muted'   },
  ]
  const totalYards = buckets.reduce((s, b) => s + b.yards, 0)
  const mix = buckets.map(b => ({
    ...b,
    pct: totalYards > 0 ? (b.yards / totalYards) * 100 : 0,
  }))
  return { mix, totalYards }
}
