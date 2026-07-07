// ============================================================================
// weeklyProdSummaryData.js — gather + persistence for the weekly production
// summary (Admin > Intelligence). Mirrors monthlyBriefData.js.
// ============================================================================
// UNIT MODEL: the atom is the DAILY CELL on sched_daily_ops — one row per
// (site, table/machine, day) carrying planned_yards + actual_yards. The
// Scheduler's PLAN/ACTUAL/Δ grid is exactly this. Everything rolls up from cells.
//
// CANONICAL DEFINITIONS (so the summary agrees with the board + feeds Perdoo):
//   scheduled goal (the driver) = daily planned_yards on sched_daily_ops
//   actual                      = daily actual_yards on sched_daily_ops
//   attainment %                = actual ÷ planned × 100
//   weekly reconciliation       = Σ daily plans vs Σ assignment planned_yards
//                                 (daily should add up to the weekly goal)
//   NOT RECORDED (#3)           = a cell with planned_yards > 0 and NULL actual
//   product category (Passaic)  = table_code prefix (GC=Grasscloth,
//                                 FAB=Fabric, WP=Wallpaper). BNY = machines (Digital).
//   waste %                     = waste ÷ (produced + waste) × 100
//   color-yards (Passaic)       = Σ per-line yards × the PO's cy/yd ratio
//   note cause-categories       = sched_daily_ops_notes grouped by `category`
//   lost capacity (#4 proxy)    = planned − actual per unit + Workflow
//                                 Interruption notes (yards short, not hours —
//                                 Live Ops has no time field)
// ============================================================================

import { format } from 'date-fns'
import { supabase } from '../supabase'
import { deriveColorYards } from './dailyOps'

const isoDate = (d) => (d instanceof Date ? format(d, 'yyyy-MM-dd') : String(d).slice(0, 10))
const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n }

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const DAY_LABELS = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' }

// Product category from the Passaic table_code prefix; BNY units are machines.
function productOf(site, code) {
  if (site !== 'passaic') return 'Digital'
  const c = (code || '').toUpperCase()
  if (c.startsWith('GC')) return 'Grasscloth'
  if (c.startsWith('FAB')) return 'Fabric'
  if (c.startsWith('WP')) return 'Wallpaper'
  return 'Other'
}
// Hand-screen units are "tables" (Passaic GC/FAB/WP); everything else is a "machine".
function unitTypeOf(site, code) {
  if (site !== 'passaic') return 'machine'
  const c = (code || '').toUpperCase()
  return (c.startsWith('GC') || c.startsWith('FAB') || c.startsWith('WP')) ? 'table' : 'machine'
}

const asnKey  = (a) => `${a.site}|${a.table_code}|${a.po_number || ''}|${a.item_sku || ''}|${a.color || ''}`
const lineKey = (l) => `${l.site}|${l.table_code}|${l.po_number || ''}|${l.item_sku || ''}|${l.color || ''}`
const unitKey = (siteOrRow, code) =>
  (code === undefined ? `${siteOrRow.site}|${siteOrRow.table_code}` : `${siteOrRow}|${code}`)

// ── Gather ──────────────────────────────────────────────────────────────────
export async function gatherWeeklyProdData({ weekStart, throughDate = new Date() }) {
  const wk = isoDate(weekStart)

  // Only COMPLETED days count toward "not recorded" — never flag a table for a
  // day that hasn't happened yet. A day is elapsed if its date is before today.
  const weekStartDate = weekStart instanceof Date ? weekStart : new Date(wk + 'T00:00:00')
  const today0 = new Date(throughDate); today0.setHours(0, 0, 0, 0)
  const DAY_OFFSET = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 }
  const isElapsed = (day) => {
    const d = new Date(weekStartDate); d.setDate(d.getDate() + (DAY_OFFSET[day] || 0)); d.setHours(0, 0, 0, 0)
    return d < today0
  }

  const [{ data: asn }, { data: ops }, { data: lines }, { data: notes }] = await Promise.all([
    supabase.from('sched_assignments').select('*').eq('week_start', wk),
    supabase.from('sched_daily_ops').select('*').eq('week_start', wk),
    supabase.from('sched_daily_ops_lines').select('*').eq('week_start', wk),
    supabase.from('sched_daily_ops_notes').select('*').eq('week_start', wk),
  ])

  const assignments = asn || []
  const headers     = ops || []
  const opLines     = lines || []
  const opNotes     = notes || []

  const asnByKey = new Map()
  for (const a of assignments) { const k = asnKey(a); if (!asnByKey.has(k)) asnByKey.set(k, a) }

  // ── Per-line aggregation (waste + color-yards + attribution), keyed by unit ─
  const lineAgg = new Map()  // unitKey -> { wasteYards, colorYards, produced, producedAttributed }
  for (const l of opLines) {
    const uk = unitKey(l)
    if (!lineAgg.has(uk)) lineAgg.set(uk, { wasteYards: 0, colorYards: 0, produced: 0, producedAttributed: 0 })
    const g = lineAgg.get(uk)
    const y = num(l.actual_yards)
    g.wasteYards += num(l.waste_yards)
    g.produced += y
    const asnMatch = asnByKey.get(lineKey(l))
    if (asnMatch) g.producedAttributed += y
    const cy = deriveColorYards(y, asnMatch)
    if (cy != null) g.colorYards += cy
  }

  // ── Build units from the daily-ops cells ────────────────────────────────
  const units = new Map()  // unitKey -> unit
  for (const h of headers) {
    const uk = unitKey(h)
    if (!units.has(uk)) {
      units.set(uk, {
        site: h.site,
        unitCode: h.table_code,
        product: productOf(h.site, h.table_code),
        unitType: unitTypeOf(h.site, h.table_code),
        operatorsSet: new Set(),
        byDay: {},
        plannedYards: 0,
        actualYards: 0,
      })
    }
    const u = units.get(uk)
    const planned = h.planned_yards == null ? null : num(h.planned_yards)
    const actual  = h.actual_yards  == null ? null : num(h.actual_yards)
    u.byDay[h.day_of_week] = { planned, actual, recorded: actual != null }
    if (planned != null) u.plannedYards += planned
    if (actual != null)  u.actualYards += actual
    if (h.operator_1) u.operatorsSet.add(h.operator_1)
    if (h.operator_2) u.operatorsSet.add(h.operator_2)
  }

  // Finalize units
  const unitList = []
  for (const [uk, u] of units) {
    const la = lineAgg.get(uk) || { wasteYards: 0, colorYards: 0, produced: 0 }
    u.wasteYards = la.wasteYards
    u.colorYards = u.site === 'passaic' ? la.colorYards : null
    u.attainmentPct = u.plannedYards > 0 ? (u.actualYards / u.plannedYards) * 100 : null
    u.varianceYards = u.actualYards - u.plannedYards
    u.shortfallYards = u.plannedYards > 0 ? Math.max(0, u.plannedYards - u.actualYards) : 0
    u.missingDays = DAYS.filter(d => { const c = u.byDay[d]; return c && c.planned != null && c.planned > 0 && !c.recorded })
    u.recordedNoPlanDays = DAYS.filter(d => { const c = u.byDay[d]; return c && c.recorded && (c.planned == null || c.planned === 0) })
    u.operators = [...u.operatorsSet]
    u.days = DAYS.map(d => ({ day: d, ...(u.byDay[d] || { planned: null, actual: null, recorded: false }) }))
    delete u.operatorsSet
    delete u.byDay
    unitList.push(u)
  }
  unitList.sort((a, b) => a.site.localeCompare(b.site) || a.unitCode.localeCompare(b.unitCode))

  // ── Site + combined rollups (with daily-vs-weekly reconciliation) ────────
  const bySite = {}
  for (const site of ['passaic', 'bny']) {
    const us = unitList.filter(u => u.site === site)
    const plannedYards = us.reduce((s, u) => s + u.plannedYards, 0)
    const actualYards  = us.reduce((s, u) => s + u.actualYards, 0)
    const wasteYards   = us.reduce((s, u) => s + u.wasteYards, 0)
    const colorYards   = site === 'passaic' ? us.reduce((s, u) => s + (u.colorYards || 0), 0) : null

    const weeklyGoalYards = assignments.filter(a => a.site === site).reduce((s, a) => s + num(a.planned_yards), 0)
    const scheduledColorYards = site === 'passaic'
      ? assignments.filter(a => a.site === site).reduce((s, a) => s + num(a.planned_cy), 0) : null

    bySite[site] = {
      plannedYards,
      actualYards,
      varianceYards: actualYards - plannedYards,
      attainmentPct: plannedYards > 0 ? (actualYards / plannedYards) * 100 : null,
      wasteYards,
      wastePct: (actualYards + wasteYards) > 0 ? (wasteYards / (actualYards + wasteYards)) * 100 : null,
      colorYards,
      scheduledColorYards,
      colorAttainmentPct: (scheduledColorYards && scheduledColorYards > 0) ? (colorYards / scheduledColorYards) * 100 : null,
      // Reconciliation: daily plans should add up to the weekly goal.
      reconciliation: {
        dailyPlanSum: plannedYards,
        weeklyGoal: weeklyGoalYards,
        deltaYards: plannedYards - weeklyGoalYards,
        tiesOut: weeklyGoalYards > 0 && Math.abs(plannedYards - weeklyGoalYards) <= Math.max(1, weeklyGoalYards * 0.02),
      },
    }
  }
  const combined = {
    plannedYards: bySite.passaic.plannedYards + bySite.bny.plannedYards,
    actualYards:  bySite.passaic.actualYards  + bySite.bny.actualYards,
    wasteYards:   bySite.passaic.wasteYards   + bySite.bny.wasteYards,
  }
  combined.varianceYards = combined.actualYards - combined.plannedYards
  combined.attainmentPct = combined.plannedYards > 0 ? (combined.actualYards / combined.plannedYards) * 100 : null
  combined.wastePct = (combined.actualYards + combined.wasteYards) > 0
    ? (combined.wasteYards / (combined.actualYards + combined.wasteYards)) * 100 : null

  // ── By product category (Passaic substrates) ────────────────────────────
  const productAgg = new Map()
  for (const u of unitList.filter(x => x.site === 'passaic')) {
    if (!productAgg.has(u.product)) productAgg.set(u.product, { product: u.product, plannedYards: 0, actualYards: 0, wasteYards: 0 })
    const g = productAgg.get(u.product)
    g.plannedYards += u.plannedYards
    g.actualYards  += u.actualYards
    g.wasteYards   += u.wasteYards
  }
  const byProduct = [...productAgg.values()]
    .map(g => ({
      ...g,
      attainmentPct: g.plannedYards > 0 ? (g.actualYards / g.plannedYards) * 100 : null,
      wastePct: (g.actualYards + g.wasteYards) > 0 ? (g.wasteYards / (g.actualYards + g.wasteYards)) * 100 : null,
    }))
    .sort((a, b) => b.actualYards - a.actualYards)

  // ── Data integrity (#3) — planned-but-not-recorded is the morning list ──
  let plannedCells = 0, recordedCells = 0
  const notRecorded = []
  const recordedNoPlan = []
  for (const u of unitList) {
    for (const cell of u.days) {
      const elapsed = isElapsed(cell.day)
      if (elapsed && cell.planned != null && cell.planned > 0) {
        plannedCells++
        if (cell.recorded) recordedCells++
        else notRecorded.push({
          site: u.site, unitCode: u.unitCode, unitType: u.unitType, product: u.product,
          day: cell.day, dayLabel: DAY_LABELS[cell.day], planned: cell.planned, operators: u.operators,
        })
      }
      if (cell.recorded && (cell.planned == null || cell.planned === 0)) {
        recordedNoPlan.push({ site: u.site, unitCode: u.unitCode, day: cell.day, actual: cell.actual })
      }
    }
  }
  notRecorded.sort((a, b) => a.site.localeCompare(b.site) || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.unitCode.localeCompare(b.unitCode))
  const elapsedDays = DAYS.filter(isElapsed)
  const integrity = {
    asOf: isoDate(today0),
    elapsedDays,
    plannedCells,
    recordedCells,
    coveragePct: plannedCells > 0 ? (recordedCells / plannedCells) * 100 : null,
    notRecorded,
    recordedNoPlan,
  }

  // ── Waste (#2) — by product (where) ─────────────────────────────────────
  const wasteByProduct = byProduct
    .map(g => ({ product: g.product, wasteYards: g.wasteYards, producedYards: g.actualYards, wastePct: g.wastePct }))
    .filter(g => g.wasteYards > 0 || g.producedYards > 0)
    .sort((a, b) => b.wasteYards - a.wasteYards)

  // ── Note cause-categories (#2 — why) ────────────────────────────────────
  const noteBuckets = new Map()
  const interruptionsByUnit = new Map()
  for (const n of opNotes) {
    const cat = n.category || 'Other'
    if (!noteBuckets.has(cat)) noteBuckets.set(cat, { category: cat, count: 0, notes: [] })
    const b = noteBuckets.get(cat)
    b.count += 1
    if ((n.note_text || '').trim()) {
      b.notes.push({ site: n.site, unitCode: n.table_code, day: n.day_of_week, text: n.note_text.trim() })
      if (cat === 'Workflow Interruptions') {
        const uk = unitKey(n)
        if (!interruptionsByUnit.has(uk)) interruptionsByUnit.set(uk, [])
        interruptionsByUnit.get(uk).push({ day: n.day_of_week, text: n.note_text.trim() })
      }
    }
  }
  const notesByCategory = [...noteBuckets.values()].sort((a, b) => b.count - a.count)

  // ── Lost capacity (#4 proxy) — shortfall + interruption notes per unit ──
  const lostCapacity = unitList
    .filter(u => u.shortfallYards > 0)
    .map(u => ({
      site: u.site, unitCode: u.unitCode, unitType: u.unitType, product: u.product,
      plannedYards: u.plannedYards, actualYards: u.actualYards,
      shortfallYards: u.shortfallYards, attainmentPct: u.attainmentPct,
      interruptionNotes: interruptionsByUnit.get(unitKey(u.site, u.unitCode)) || [],
    }))
    .sort((a, b) => b.shortfallYards - a.shortfallYards)

  // ── Attribution coverage (PO-tagging discipline) ────────────────────────
  let producedAll = 0, producedAttributed = 0
  for (const l of opLines) {
    const y = num(l.actual_yards)
    producedAll += y
    if (asnByKey.get(lineKey(l))) producedAttributed += y
  }
  const attribution = {
    producedTotal: producedAll,
    producedAttributed,
    coveragePct: producedAll > 0 ? (producedAttributed / producedAll) * 100 : null,
  }

  return {
    weekStart: wk,
    generatedAt: new Date().toISOString(),
    units: unitList,
    bySite,
    combined,
    byProduct,
    integrity,
    wasteByProduct,
    notesByCategory,
    lostCapacity,
    attribution,
    totalNotes: opNotes.length,
    counts: { assignments: assignments.length, headers: headers.length, lines: opLines.length, notes: opNotes.length },
  }
}

// ── Persistence (mirrors monthlyBriefData: save / list / load) ──────────────
export async function saveWeeklyProdSummary({ weekStart, narrative, dataSnapshot, authUser, scope = 'combined' }) {
  const row = {
    week_start: isoDate(weekStart),
    scope,
    narrative,
    data_snapshot: dataSnapshot,
    saved_at: new Date().toISOString(),
    saved_by_email: authUser?.email || null,
  }
  const { data, error } = await supabase.from('weekly_prod_summaries').insert(row).select().single()
  if (error) { console.error('saveWeeklyProdSummary', error); throw error }
  return data
}

export async function listSavedWeeklySummaries({ weekStart, scope = 'combined' }) {
  const { data, error } = await supabase
    .from('weekly_prod_summaries')
    .select('id, week_start, scope, narrative, saved_at, saved_by_email')
    .eq('week_start', isoDate(weekStart))
    .eq('scope', scope)
    .order('saved_at', { ascending: false })
  if (error) { console.error('listSavedWeeklySummaries', error); return [] }
  return data || []
}

export async function loadSavedWeeklySummary(id) {
  const { data, error } = await supabase
    .from('weekly_prod_summaries')
    .select('*')
    .eq('id', id)
    .single()
  if (error) { console.error('loadSavedWeeklySummary', error); throw error }
  return data
}
