import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { C, fmt, fmtD, fmtK, isoDate, weekLabel, addWeeks, defaultSchedulerWeek, PASSAIC_OPERATORS, DAY_NAMES_SHORT } from '../lib/scheduleUtils'
import { loadWeekDailyOps, upsertDailyOp, buildRecentActualsSummary } from '../lib/dailyOps'
import { weeklyBudgetYards, weeklyBudgetColorYards, PASSAIC_BUDGET } from '../lib/budgets'

// ─── Passaic-specific constants ────────────────────────────────────────────
// Targets are now sourced from src/lib/budgets.js (the canonical FY2026 plan
// matching what Recap and FSCO leadership see). The internal key for the
// printed-paper-substrate category is 'paper' (matches finance / GL); the
// user-visible label is 'Wallpaper'. Translate at the boundary via this map.
const CATEGORY_TO_BUDGET_KEY = { grass: 'grass', fabric: 'fabric', wallpaper: 'paper' }
function targetYards(cat)      { return weeklyBudgetYards('passaic', CATEGORY_TO_BUDGET_KEY[cat]) ?? 0 }
function targetColorYards(cat) { return weeklyBudgetColorYards(CATEGORY_TO_BUDGET_KEY[cat]) ?? 0 }

// Compatibility shim — keep PASSAIC_TARGETS shape for sites in this file that
// still read it directly (table capacity_cy calc, etc). Pulls live values
// from budgets.js so changes to finance plan flow through automatically.
const PASSAIC_TARGETS = {
  total:     { yards: PASSAIC_BUDGET.weekly.yards, cy: PASSAIC_BUDGET.weekly.colorYards, revenue: PASSAIC_BUDGET.weekly.invoiceRev },
  grass:     { yards: targetYards('grass'),     cy: targetColorYards('grass'),     tables: 2 },
  fabric:    { yards: targetYards('fabric'),    cy: targetColorYards('fabric'),    tables: 9 },
  wallpaper: { yards: targetYards('wallpaper'), cy: targetColorYards('wallpaper'), tables: 6 },
}

const MIX_TARGET_SCH = 0.60
const HIGH_COLOR_THRESHOLD = 6

const WASTE_HISTORY_PATTERNS = [
  'CLOUD TOILE', 'BANANA LEAF', 'ACANTHUS STRIPE',
  'PYNE HOLLYHOCK', 'BOTANICO METALLIC',
]
const hasWasteHistory = (lineDesc) => {
  if (!lineDesc) return false
  const up = lineDesc.toUpperCase()
  return WASTE_HISTORY_PATTERNS.some(p => up.includes(p))
}

const PASSAIC_TABLES = [
  ...['GC-1','GC-2'].map(code => ({
    code, category: 'grass', label: code,
    capacity_cy: Math.round(PASSAIC_TARGETS.grass.cy / PASSAIC_TARGETS.grass.tables),
  })),
  ...['FAB-3','FAB-4','FAB-5','FAB-6','FAB-7','FAB-8','FAB-9','FAB-10','FAB-11'].map(code => ({
    code, category: 'fabric', label: code,
    capacity_cy: Math.round(PASSAIC_TARGETS.fabric.cy / PASSAIC_TARGETS.fabric.tables),
  })),
  ...['WP-12','WP-13','WP-14','WP-15','WP-16','WP-17'].map(code => ({
    code, category: 'wallpaper', label: code,
    capacity_cy: Math.round(PASSAIC_TARGETS.wallpaper.cy / PASSAIC_TARGETS.wallpaper.tables),
  })),
]

// ═══════════════════════════════════════════════════════════════════════════
// PassaicScheduler — weekly schedule composer with Ask Claude conversational AI
// (Formerly ScheduleComposer inside SchedulerTab. Same logic, same props.)
// ═══════════════════════════════════════════════════════════════════════════
export default function PassaicScheduler({ wipRows, assignments, weekStart, onWeekChange, onAssignmentsChange }) {
  const [selectedPO, setSelectedPO] = useState(null)
  const [assigning, setAssigning] = useState(false)
  const [assignModal, setAssignModal] = useState(null)
  const [poolFilter, setPoolFilter] = useState('')
  const [filterSch, setFilterSch] = useState(null)
  const [filterHighColor, setFilterHighColor] = useState(false)
  const [filterWasteHist, setFilterWasteHist] = useState(false)
  const [filterHighValueLowColor, setFilterHighValueLowColor] = useState(false)
  const [filterCategory, setFilterCategory] = useState(null)  // null | 'grass' | 'fabric' | 'wallpaper'
  const [filterNewGoods, setFilterNewGoods] = useState(false)
  const [filterApprovedToPrint, setFilterApprovedToPrint] = useState(false)
  const [filterReadyToPrint, setFilterReadyToPrint] = useState(false)
  const [askClaudeOpen, setAskClaudeOpen] = useState(false)
  const [crewModalTable, setCrewModalTable] = useState(null)  // tableCode string or null
  const [weekDailyOps, setWeekDailyOps] = useState([])

  // Load this week's daily_ops (crew + actuals) so the table cards can show
  // a compact staffing strip. Refreshes when the week changes or after a save.
  async function reloadDailyOps() {
    const rows = await loadWeekDailyOps('passaic', weekStart)
    setWeekDailyOps(rows || [])
  }
  useEffect(() => { reloadDailyOps() }, [weekStart])

  const assignedByPO = useMemo(() => {
    const m = {}
    for (const a of assignments) {
      m[a.po_number] = (m[a.po_number] || 0) + Number(a.planned_yards || 0)
    }
    return m
  }, [assignments])

  const pool = useMemo(() => {
    const schedulableStatuses = new Set([
      'Approved to Print','Ready to Print','In Mixing Queue','In Progress',
      'Waiting for Material','Waiting for Screen','Waiting for Approval','Waiting for Sample',
      'Strike Off','Orders Unallocated',
    ])
    // Pre-production New Goods (in strike-off / approval / waiting-for-material
    // stages) live in the New Goods view only — they're tracked as a dev
    // pipeline, not as schedulable production. Once a New Goods PO reaches
    // "Approved to Print" or beyond, it returns to the pool automatically.
    const ngPreprodStatuses = new Set([
      'Waiting for Approval','Strike Off','Waiting for Sample',
      'Waiting for Screen','Waiting for Material',
    ])
    return wipRows
      .filter(r => schedulableStatuses.has(r.order_status || ''))
      .filter(r => !(r.is_new_goods && ngPreprodStatuses.has(r.order_status || '')))
      .map(r => {
        const already = assignedByPO[r.po_number] || 0
        const remaining = Math.max(0, Number(r.yards_written || 0) - already)
        return { ...r, assigned_already: already, remaining_yards: remaining }
      })
      .filter(r => r.remaining_yards > 0)
  }, [wipRows, assignedByPO])

  const filteredPool = useMemo(() => {
    let list = pool
    if (poolFilter) {
      const q = poolFilter.toLowerCase()
      list = list.filter(r => (r.po_number||'').toLowerCase().includes(q) || (r.line_description||'').toLowerCase().includes(q))
    }
    if (filterSch === 'sch') list = list.filter(r => (r.customer_type||'').toLowerCase() === 'schumacher')
    if (filterSch === '3p')  list = list.filter(r => (r.customer_type||'').toLowerCase().includes('3rd'))
    if (filterHighColor)     list = list.filter(r => (r.colors_count || 0) >= HIGH_COLOR_THRESHOLD)
    if (filterWasteHist)     list = list.filter(r => hasWasteHistory(r.line_description))
    if (filterHighValueLowColor) {
      list = list.filter(r => {
        const yd = Number(r.yards_written || 0)
        const rev = Number(r.income_written || 0)
        const perYd = yd > 0 ? rev / yd : 0
        const colors = r.colors_count || 0
        return colors <= 4 && perYd >= 15
      })
    }
    if (filterCategory) {
      list = list.filter(r => {
        const pt = (r.product_type || '').toLowerCase()
        if (filterCategory === 'grass')     return pt.includes('grass')
        if (filterCategory === 'fabric')    return pt.includes('fabric') || pt.includes('strike-off')
        if (filterCategory === 'wallpaper') return pt.includes('paper') || pt.includes('panel')
        return true
      })
    }
    if (filterNewGoods) list = list.filter(r => r.is_new_goods)
    // Status chips are multi-select OR — both off = no status filter,
    // one on = that status, both on = either status. Matches Wendy's
    // "scheduling what's available to print" framing.
    const activeStatusFilters = []
    if (filterApprovedToPrint) activeStatusFilters.push('Approved to Print')
    if (filterReadyToPrint)    activeStatusFilters.push('Ready to Print')
    if (activeStatusFilters.length > 0) {
      list = list.filter(r => activeStatusFilters.includes(r.order_status))
    }
    return list.sort((a,b) => (b.age_days || 0) - (a.age_days || 0))
  }, [pool, poolFilter, filterSch, filterHighColor, filterWasteHist, filterHighValueLowColor, filterCategory, filterNewGoods, filterApprovedToPrint, filterReadyToPrint])

  const wipByPO = useMemo(() => {
    const m = {}
    for (const r of wipRows) m[r.po_number] = r
    return m
  }, [wipRows])

  const enrichedAssignments = useMemo(() => {
    return assignments.map(a => {
      const src = wipByPO[a.po_number] || {}
      return {
        ...a,
        line_description: a.line_description || src.line_description || a.po_number,
        customer_type: src.customer_type || null,
        colors_count: src.colors_count || null,
        income_per_yard: src.income_written && src.yards_written ? (src.income_written / src.yards_written) : 0,
      }
    })
  }, [assignments, wipByPO])

  const mixTotals = useMemo(() => {
    const t = {
      yards: 0, cy: 0, revenue: 0,
      schumacher_revenue: 0, third_party_revenue: 0,
      grass:     { yards: 0, cy: 0, revenue: 0 },
      fabric:    { yards: 0, cy: 0, revenue: 0 },
      wallpaper: { yards: 0, cy: 0, revenue: 0 },
      avg_colors_weighted: 0, colors_yard_sum: 0, yards_with_colors: 0,
    }
    for (const a of enrichedAssignments) {
      const yd = Number(a.planned_yards || 0)
      const cy = Number(a.planned_cy || 0)
      const rev = yd * (a.income_per_yard || 0)
      t.yards += yd
      t.cy += cy
      t.revenue += rev
      if ((a.customer_type||'').toLowerCase() === 'schumacher') t.schumacher_revenue += rev
      else if ((a.customer_type||'').toLowerCase().includes('3rd')) t.third_party_revenue += rev

      const tbl = PASSAIC_TABLES.find(t => t.code === a.table_code)
      if (tbl) {
        t[tbl.category].yards += yd
        t[tbl.category].cy += cy
        t[tbl.category].revenue += rev
      }
      if (a.colors_count) {
        t.colors_yard_sum += a.colors_count * yd
        t.yards_with_colors += yd
      }
    }
    t.avg_colors_weighted = t.yards_with_colors > 0 ? (t.colors_yard_sum / t.yards_with_colors) : 0
    return t
  }, [enrichedAssignments])

  function handleTableClick(tableCode) {
    if (!selectedPO) return
    if (selectedPO.remaining_yards > 0) {
      setAssignModal({ po: selectedPO, tableCode, proposed_yards: selectedPO.remaining_yards })
    }
  }

  async function commitAssignment({ po, tableCode, yards }) {
    setAssigning(true)
    try {
      const colors = po.colors_count || null
      const cy = colors ? colors * yards : null
      const { error: ie } = await supabase.from('sched_assignments').insert({
        site: 'passaic', po_number: po.po_number,
        line_description: po.line_description, product_type: po.product_type,
        table_code: tableCode, week_start: isoDate(weekStart),
        day_of_week: null, planned_yards: yards, planned_cy: cy,
        assigned_by: null, notes: null, status: 'planned',
      })
      if (ie) throw ie
      await onAssignmentsChange()
      if (yards >= po.remaining_yards) setSelectedPO(null)
      else setSelectedPO({ ...po, remaining_yards: po.remaining_yards - yards, assigned_already: (po.assigned_already||0) + yards })
      setAssignModal(null)
    } catch (e) {
      console.error(e); alert('Assignment failed: ' + (e.message || e))
    } finally { setAssigning(false) }
  }

  async function removeAssignment(id) {
    if (!confirm('Remove this assignment?')) return
    const { error: de } = await supabase.from('sched_assignments').delete().eq('id', id)
    if (de) { alert('Delete failed: ' + de.message); return }
    await onAssignmentsChange()
  }

  async function clearAllAssignments() {
    const hasCrew = weekDailyOps.some(r => r.operator_1 || r.operator_2)
    const msg = hasCrew
      ? `Remove all ${enrichedAssignments.length} assignments AND clear crew staffing for this week?`
      : `Remove all ${enrichedAssignments.length} assignments for this week?`
    if (!confirm(msg)) return
    const { error: e1 } = await supabase.from('sched_assignments').delete().eq('site','passaic').eq('week_start', isoDate(weekStart))
    if (e1) { alert('Clear assignments failed: ' + e1.message); return }
    const { error: e2 } = await supabase.from('sched_daily_ops').delete().eq('site','passaic').eq('week_start', isoDate(weekStart))
    if (e2) { alert('Clear crew failed: ' + e2.message); return }
    await onAssignmentsChange()
    await reloadDailyOps()
  }

  return (
    <div>
      {/* Week navigator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 14px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <button onClick={() => onWeekChange(addWeeks(weekStart, -1))} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.inkMid }}>← Prev week</button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>Week of {weekLabel(weekStart)}</div>
          <div style={{ fontSize: 11, color: C.inkLight }}>{enrichedAssignments.length} assignment{enrichedAssignments.length !== 1 ? 's' : ''}</div>
        </div>
        <button onClick={() => onWeekChange(defaultSchedulerWeek())} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>Default week</button>
        <button onClick={() => onWeekChange(addWeeks(weekStart, 1))} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.inkMid }}>Next week →</button>
      </div>

      {/* Big Ask Claude button + admin actions row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button
          onClick={() => setAskClaudeOpen(true)}
          style={{
            padding: '12px 22px', background: C.navy, color: '#fff', border: 'none',
            borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            boxShadow: '0 2px 8px rgba(30,58,95,0.25)',
          }}>
          <span style={{ fontSize: 18 }}>✦</span> Ask Claude
        </button>
        <span style={{ fontSize: 12, color: C.inkLight, fontStyle: 'italic' }}>
          Let Claude propose a schedule for this week, or ask questions about what's in the pool.
        </span>
        <div style={{ flex: 1 }} />
        {enrichedAssignments.length > 0 && (
          <button onClick={clearAllAssignments}
            style={{ padding: '8px 14px', background: 'transparent', color: C.rose, border: `1px solid ${C.rose}`, borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Clear all
          </button>
        )}
      </div>

      <div style={{ position: 'sticky', top: 8, zIndex: 10, background: C.cream, paddingTop: 4, paddingBottom: 8, marginBottom: 4 }}>
        <MixGauges totals={mixTotals} />
        <CategoryStrip totals={mixTotals} />
      </div>

      {/* Main layout */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '340px 1fr',
        gap: 16, marginTop: 16,
      }}>
        {/* POOL */}
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', height: 'fit-content', position: 'sticky', top: 230 }}>
          <div style={{ padding: '12px 14px', background: C.parchment, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 6 }}>Unscheduled Pool</div>
            <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{filteredPool.length} POs to schedule</div>
          </div>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
            <input type="text" value={poolFilter} onChange={e => setPoolFilter(e.target.value)} placeholder="Search pattern or PO…"
              style={{ width: '100%', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, marginBottom: 8, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <FilterChip active={filterSch === 'sch'} onClick={() => setFilterSch(filterSch === 'sch' ? null : 'sch')} color={C.navy}>Schumacher</FilterChip>
              <FilterChip active={filterSch === '3p'} onClick={() => setFilterSch(filterSch === '3p' ? null : '3p')} color={C.gold}>3rd Party</FilterChip>
              <FilterChip active={filterCategory === 'grass'} onClick={() => setFilterCategory(filterCategory === 'grass' ? null : 'grass')} color={C.sage}>Grasscloth</FilterChip>
              <FilterChip active={filterCategory === 'fabric'} onClick={() => setFilterCategory(filterCategory === 'fabric' ? null : 'fabric')} color={C.sage}>Fabric</FilterChip>
              <FilterChip active={filterCategory === 'wallpaper'} onClick={() => setFilterCategory(filterCategory === 'wallpaper' ? null : 'wallpaper')} color={C.sage}>Wallpaper</FilterChip>
              <FilterChip active={filterNewGoods} onClick={() => setFilterNewGoods(!filterNewGoods)} color={C.gold}>New Goods</FilterChip>
              <FilterChip active={filterApprovedToPrint} onClick={() => setFilterApprovedToPrint(!filterApprovedToPrint)} color={C.sage}>Approved to Print</FilterChip>
              <FilterChip active={filterReadyToPrint} onClick={() => setFilterReadyToPrint(!filterReadyToPrint)} color={C.sage}>Ready to Print</FilterChip>
              <FilterChip active={filterHighColor} onClick={() => setFilterHighColor(!filterHighColor)} color={C.rose}>High-color 6+</FilterChip>
              <FilterChip active={filterWasteHist} onClick={() => setFilterWasteHist(!filterWasteHist)} color={C.amber}>Waste history</FilterChip>
              <FilterChip active={filterHighValueLowColor} onClick={() => setFilterHighValueLowColor(!filterHighValueLowColor)} color={C.sage}>$$ low-color</FilterChip>
            </div>
          </div>
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {filteredPool.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: C.inkLight, fontSize: 12 }}>No POs match these filters</div>
            )}
            {filteredPool.map(r => {
              const sel = selectedPO?.po_number === r.po_number
              const isSch = (r.customer_type||'').toLowerCase() === 'schumacher'
              const is3P = (r.customer_type||'').toLowerCase().includes('3rd')
              const highColor = (r.colors_count || 0) >= HIGH_COLOR_THRESHOLD
              const wasteP = hasWasteHistory(r.line_description)
              return (
                <div key={r.id} onClick={() => setSelectedPO(sel ? null : r)}
                  style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', background: sel ? C.goldBg : 'transparent' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: C.inkLight }}>{r.po_number}</span>
                    {r.order_number && r.order_number !== r.po_number && (
                      <span style={{ fontSize: 9, fontFamily: 'monospace', color: C.inkLight }}>· #{r.order_number}</span>
                    )}
                    {isSch && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.navyLight, color: C.navy, fontWeight: 700 }}>SCH</span>}
                    {is3P && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.goldBg, color: C.gold, fontWeight: 700 }}>3P</span>}
                    {r.is_new_goods && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.goldBg, color: C.gold, fontWeight: 700 }}>NEW</span>}
                    {highColor && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.roseBg, color: C.rose, fontWeight: 700 }}>{r.colors_count}c</span>}
                    {wasteP && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.amberBg, color: C.amber, fontWeight: 700 }}>⚠ WASTE</span>}
                  </div>
                  <div style={{ fontSize: 12, color: C.ink, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>{r.line_description}</div>
                  {(r.item_sku || r.color) && (
                    <div style={{ fontSize: 9, color: C.inkLight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>
                      {r.item_sku || ''}{r.item_sku && r.color ? ' · ' : ''}{r.color || ''}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: C.inkLight, display: 'flex', gap: 8 }}>
                    <span>{r.product_type}</span>
                    <span>·</span>
                    <span>{fmt(r.remaining_yards)} yd remaining{r.assigned_already > 0 ? ` (${fmt(r.assigned_already)} scheduled)` : ''}</span>
                    <span>·</span>
                    <span style={{ color: r.age_days > 90 ? C.rose : C.inkLight, fontWeight: r.age_days > 90 ? 700 : 400 }}>{r.age_days}d</span>
                  </div>
                </div>
              )
            })}
          </div>
          {selectedPO && (
            <div style={{ padding: '10px 14px', background: C.goldBg, borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.ink }}>
              <strong>Selected:</strong> {selectedPO.line_description}<br/>
              <span style={{ color: C.inkMid }}>Click a table to assign {fmt(selectedPO.remaining_yards)} yards (or split in the next step)</span>
            </div>
          )}
        </div>

        {/* TABLE GRID */}
        <div>
          <TableCategoryRow category="grass"     label="Grasscloth" tables={PASSAIC_TABLES.filter(t => t.category === 'grass')}     assignments={enrichedAssignments} dailyOps={weekDailyOps} selectedPO={selectedPO} onTableClick={handleTableClick} onRemove={removeAssignment} onOpenCrew={setCrewModalTable} />
          <TableCategoryRow category="fabric"    label="Fabric"     tables={PASSAIC_TABLES.filter(t => t.category === 'fabric')}    assignments={enrichedAssignments} dailyOps={weekDailyOps} selectedPO={selectedPO} onTableClick={handleTableClick} onRemove={removeAssignment} onOpenCrew={setCrewModalTable} />
          <TableCategoryRow category="wallpaper" label="Wallpaper"  tables={PASSAIC_TABLES.filter(t => t.category === 'wallpaper')} assignments={enrichedAssignments} dailyOps={weekDailyOps} selectedPO={selectedPO} onTableClick={handleTableClick} onRemove={removeAssignment} onOpenCrew={setCrewModalTable} />
        </div>
      </div>

      {/* ASK CLAUDE — modal overlay (full-screen) */}
      {askClaudeOpen && (
        <AskClaudePanel
          onClose={() => setAskClaudeOpen(false)}
          weekStart={weekStart}
          pool={pool}
          assignments={enrichedAssignments}
          mixTotals={mixTotals}
          onApplyAssignments={async (proposals) => {
            const rows = proposals.map(p => ({
              site: 'passaic',
              po_number: p.po_number,
              line_description: p.line_description || null,
              product_type: p.product_type || null,
              table_code: p.table_code,
              week_start: isoDate(weekStart),
              day_of_week: null,
              planned_yards: p.planned_yards,
              planned_cy: p.planned_cy || null,
              assigned_by: 'claude',
              notes: p.rationale || null,
              status: 'planned',
            }))
            const { error } = await supabase.from('sched_assignments').insert(rows)
            if (error) throw error
            await onAssignmentsChange()
          }}
        />
      )}

      {assignModal && (
        <AssignModal
          po={assignModal.po} tableCode={assignModal.tableCode} proposed={assignModal.proposed_yards}
          onCancel={() => setAssignModal(null)}
          onConfirm={yards => commitAssignment({ po: assignModal.po, tableCode: assignModal.tableCode, yards })}
          busy={assigning}
        />
      )}

      {crewModalTable && (
        <CrewModal
          tableCode={crewModalTable}
          weekStart={weekStart}
          weeklyYards={enrichedAssignments.filter(a => a.table_code === crewModalTable).reduce((s, a) => s + Number(a.planned_yards || 0), 0)}
          onClose={() => { setCrewModalTable(null); reloadDailyOps() }}
        />
      )}
    </div>
  )
}

// ─── Gauges / strip / tables / modal ───────────────────────────────────────

function MixGauges({ totals }) {
  const yPct = Math.round((totals.yards / PASSAIC_TARGETS.total.yards) * 100)
  const cyPct = Math.round((totals.cy / PASSAIC_TARGETS.total.cy) * 100)
  const rPct = Math.round((totals.revenue / PASSAIC_TARGETS.total.revenue) * 100)
  const mixSch = totals.revenue > 0 ? totals.schumacher_revenue / totals.revenue : 0
  const mix3p = totals.revenue > 0 ? totals.third_party_revenue / totals.revenue : 0
  const mixOnTarget = mixSch >= (MIX_TARGET_SCH - 0.10) && mixSch <= (MIX_TARGET_SCH + 0.10)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
      <Gauge label="Yards" value={totals.yards} target={PASSAIC_TARGETS.total.yards} pct={yPct} unit="yd" />
      <Gauge label="Color-yards" value={totals.cy} target={PASSAIC_TARGETS.total.cy} pct={cyPct} unit="CY" highlight />
      <Gauge label="Revenue" value={totals.revenue} target={PASSAIC_TARGETS.total.revenue} pct={rPct} unit="$" isMoney />
      <MixCard schPct={mixSch * 100} tpPct={mix3p * 100} onTarget={mixOnTarget} avgColors={totals.avg_colors_weighted} />
    </div>
  )
}

function Gauge({ label, value, target, pct, unit, isMoney, highlight }) {
  const col = pct >= 95 ? C.sage : pct >= 75 ? C.gold : pct >= 50 ? C.amber : C.rose
  const bg = highlight ? C.navy : '#fff'
  const fg = highlight ? '#fff' : C.ink
  const subFg = highlight ? 'rgba(255,255,255,0.65)' : C.inkLight
  return (
    <div style={{ background: bg, border: `1px solid ${highlight ? C.navy : C.border}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: subFg, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'Georgia,serif', color: fg }}>
          {isMoney ? fmtK(value) : fmt(value)}
        </span>
        <span style={{ fontSize: 11, color: subFg }}>/ {isMoney ? fmtK(target) : fmt(target)} {!isMoney && unit}</span>
      </div>
      <div style={{ height: 6, background: highlight ? 'rgba(255,255,255,0.15)' : C.warm, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: Math.min(100, pct) + '%', height: '100%', background: col, transition: 'width 0.2s' }} />
      </div>
      <div style={{ fontSize: 10, color: subFg, marginTop: 4 }}>{pct}% of target</div>
    </div>
  )
}

function MixCard({ schPct, tpPct, onTarget, avgColors }) {
  const deltaFromTarget = schPct - MIX_TARGET_SCH * 100
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 6 }}>Customer mix</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'Georgia,serif', color: C.navy }}>Sch {Math.round(schPct)}%</span>
        <span style={{ fontSize: 11, color: C.inkLight }}>·</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'Georgia,serif', color: C.gold }}>3P {Math.round(tpPct)}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: schPct + '%', background: C.navy }} />
        <div style={{ width: tpPct + '%', background: C.gold }} />
      </div>
      <div style={{ fontSize: 10, color: onTarget ? C.sage : C.rose, marginTop: 4, fontWeight: 600 }}>
        {onTarget ? '✓ At target' : `${deltaFromTarget > 0 ? '+' : ''}${Math.round(deltaFromTarget)}pp vs 60/40 target`}
        {avgColors > 0 && <span style={{ color: C.inkLight, fontWeight: 400, marginLeft: 6 }}>· avg {avgColors.toFixed(1)}c</span>}
      </div>
    </div>
  )
}

function CategoryStrip({ totals }) {
  const cats = [
    { key: 'grass',     label: 'Grass',     color: C.sage  },
    { key: 'fabric',    label: 'Fabric',    color: C.amber },
    { key: 'wallpaper', label: 'Wallpaper', color: C.navy  },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      {cats.map(c => {
        const t = totals[c.key]
        const tgt = PASSAIC_TARGETS[c.key]
        const cyPct = Math.round((t.cy / tgt.cy) * 100)
        return (
          <div key={c.key} style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: c.color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{c.label}</span>
              <span style={{ fontSize: 10, color: C.inkLight }}>{tgt.tables} table{tgt.tables !== 1 ? 's' : ''}</span>
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: C.inkMid }}>
              <div>
                <div style={{ fontSize: 9, color: C.inkLight, textTransform: 'uppercase' }}>Yd</div>
                <div style={{ fontWeight: 700, color: C.ink }}>{fmt(t.yards)} <span style={{ color: C.inkLight, fontWeight: 400 }}>/ {fmt(tgt.yards)}</span></div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: C.inkLight, textTransform: 'uppercase' }}>CY</div>
                <div style={{ fontWeight: 700, color: C.ink }}>{fmt(t.cy)} <span style={{ color: C.inkLight, fontWeight: 400 }}>/ {fmt(tgt.cy)} ({cyPct}%)</span></div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: C.inkLight, textTransform: 'uppercase' }}>Rev</div>
                <div style={{ fontWeight: 700, color: C.ink }}>{fmtK(t.revenue)}</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TableCategoryRow({ category, label, tables, assignments, dailyOps, selectedPO, onTableClick, onRemove, onOpenCrew, compact }) {
  const byTable = useMemo(() => {
    const m = {}
    for (const a of assignments) {
      if (!m[a.table_code]) m[a.table_code] = []
      m[a.table_code].push(a)
    }
    return m
  }, [assignments])

  const canAssign = selectedPO && categoryFitsPO(category, selectedPO)
  // Responsive card grid. Each card claims at least 360px (enough for the
  // CrewStrip CREW column to fully render two-operator names like
  // "Humberto G. / Jeremy D." without truncation), then fills the
  // remaining row width via 1fr. The browser packs as many cards into a
  // row as it can, then wraps. Per Peter 5/2/2026 — 280px was still too
  // tight; 360px gives the CREW column ~150px which fits two short-form
  // names cleanly.
  const cardMin = compact ? 260 : 360
  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fit, minmax(${cardMin}px, 1fr))`,
    gap: 8,
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.inkMid, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {label} <span style={{ color: C.inkLight, fontWeight: 400 }}>— {tables.length} table{tables.length !== 1 ? 's' : ''}</span>
      </div>
      <div style={gridStyle}>
        {tables.map(t => {
          const asgs = byTable[t.code] || []
          const cyUsed = asgs.reduce((s, a) => s + Number(a.planned_cy || 0), 0)
          const cyPct = Math.round((cyUsed / t.capacity_cy) * 100)
          const overCap = cyPct > 110
          const highlight = canAssign
          return (
            <div key={t.code}
              onClick={() => canAssign && onTableClick(t.code)}
              style={{
                background: '#fff',
                border: `${highlight ? 2 : 1}px ${highlight ? 'dashed' : 'solid'} ${highlight ? C.navy : overCap ? C.rose : C.border}`,
                borderRadius: 8, padding: 8, minHeight: 220,
                cursor: canAssign ? 'pointer' : 'default',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.ink }}>{t.code}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {onOpenCrew && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onOpenCrew(t.code) }}
                      title="Set daily yards targets and assign crew for each day"
                      style={{ padding: '1px 6px', fontSize: 9, fontWeight: 600, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 3, cursor: 'pointer', color: C.inkMid, letterSpacing: '0.04em' }}>
                      PLAN
                    </button>
                  )}
                  <span style={{ fontSize: 9, color: overCap ? C.rose : cyPct > 80 ? C.gold : C.inkLight, fontWeight: 600 }}>{cyPct}%</span>
                </div>
              </div>
              <div style={{ height: 4, background: C.warm, borderRadius: 2, marginBottom: 8, overflow: 'hidden' }}>
                <div style={{ width: Math.min(100, cyPct) + '%', height: '100%', background: overCap ? C.rose : cyPct > 80 ? C.gold : C.sage }} />
              </div>
              {asgs.map(a => <AssignmentCard key={a.id} a={a} onRemove={() => onRemove(a.id)} />)}
              {asgs.length === 0 && (
                <div style={{ fontSize: 10, color: C.inkLight, textAlign: 'center', padding: '12px 0', fontStyle: 'italic' }}>
                  {canAssign ? 'Click to assign' : 'Empty'}
                </div>
              )}
              <div style={{ fontSize: 9, color: C.inkLight, marginTop: 4, display: 'flex', gap: 10 }}>
                <span>Yards: <strong style={{ color: C.ink, fontWeight: 700 }}>{fmt(asgs.reduce((s, a) => s + Number(a.planned_yards || 0), 0))}</strong></span>
                <span>CY: <strong style={{ color: overCap ? C.rose : C.ink, fontWeight: 700 }}>{fmt(cyUsed)}</strong> / {fmt(t.capacity_cy)}</span>
              </div>
              <CrewStrip tableCode={t.code} dailyOps={dailyOps}
                weeklyYards={asgs.reduce((s, a) => s + Number(a.planned_yards || 0), 0)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Full daily plan/actual grid. Sits at the bottom of each Passaic table card
// and surfaces Sun-Sat performance at a glance — plan yards, actual yards,
// variance, and crew. As Sami enters actuals in Live Ops, they flow up here
// so the scheduler card doubles as a monitoring view for Wendy's 3pm check.
//
// Sun and Sat auto-hide when empty (most weeks), keeping the strip compact.
// They appear as soon as Wendy plans weekend work in CrewModal.
function CrewStrip({ tableCode, dailyOps, weeklyYards }) {
  const forTable = (dailyOps || []).filter(r => r.table_code === tableCode)
  // Index by (day, shift). Per Peter 5/2/2026, Passaic 1st and 2nd are
  // independent crews — strip needs to surface both. Earlier "winner-takes-
  // all" approach hid 2nd shift work entirely on tables where 1st had data.
  const byCell = {}
  for (const r of forTable) {
    const sh = r.shift === '2nd' ? '2nd' : '1st'
    byCell[`${r.day_of_week}|${sh}`] = r
  }

  const hasShiftData = (d, sh) => {
    const r = byCell[`${d}|${sh}`]
    return r && (r.operator_1 || r.operator_2 || (r.planned_yards != null && r.planned_yards !== 0) || r.actual_yards != null)
  }
  // For each day, decide which shift rows to render. 1st shift always
  // renders Mon-Fri; weekend (Sun/Sat) only when either shift has data;
  // 2nd shift renders any day that has data.
  const dayHasAny = (d) => hasShiftData(d, '1st') || hasShiftData(d, '2nd')
  const cells = []
  for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    const isWeekend = d === 'Sun' || d === 'Sat'
    if (isWeekend && !dayHasAny(d)) continue

    // 1st shift always renders for Mon-Fri (and weekends if any day data)
    cells.push({ day: d, shift: '1st' })
    // 2nd shift only renders when it has data — keeps the strip compact
    // on tables where 2nd shift isn't running.
    if (hasShiftData(d, '2nd')) {
      cells.push({ day: d, shift: '2nd' })
    }
  }

  const shortName = (n) => {
    if (!n) return null
    const parts = n.trim().split(/\s+/)
    if (parts.length === 1) return parts[0]
    return `${parts[0]} ${parts[parts.length - 1][0]}.`
  }
  const varianceColor = (delta, plan) => {
    if (delta == null || plan == null || plan === 0) return C.inkLight
    const pct = delta / plan
    if (Math.abs(pct) < 0.05) return C.sage
    if (pct > 0) return C.gold
    if (pct > -0.15) return C.gold
    return C.rose
  }
  // Column proportions: Day column slightly wider to accommodate the shift
  // pill. CREW gets the remaining flex (responsive width since cards are
  // now auto-fit).
  const cols = '54px 44px 44px 38px 1fr'

  // Track previous day so we can render a divider between days
  let prevDay = null

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 6, fontSize: 8, color: C.inkLight, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 3, paddingBottom: 3, borderBottom: `1px dashed ${C.border}` }}>
        <span>Day</span>
        <span style={{ textAlign: 'right' }}>Plan</span>
        <span style={{ textAlign: 'right' }}>Actual</span>
        <span style={{ textAlign: 'right' }}>Δ</span>
        <span>Crew</span>
      </div>
      {cells.map(({ day, shift }, idx) => {
        const row = byCell[`${day}|${shift}`]
        const op1 = shortName(row?.operator_1)
        const op2 = shortName(row?.operator_2)
        const crew = [op1, op2].filter(Boolean).join(' / ')
        const rawPlan = row?.planned_yards
        const plan = (rawPlan != null && rawPlan !== 0) ? rawPlan : null
        const actual = row?.actual_yards
        const delta = (plan != null && actual != null) ? actual - plan : null
        const deltaColor = varianceColor(delta, plan)

        // Visual separator between days — top-of-day rows get a faint line
        const isNewDay = day !== prevDay
        prevDay = day
        const isSecondShift = shift === '2nd'

        return (
          <div key={`${day}|${shift}`} style={{
            display: 'grid',
            gridTemplateColumns: cols,
            gap: 6,
            fontSize: 10,
            lineHeight: 1.4,
            marginBottom: 1,
            paddingTop: isNewDay && idx > 0 ? 2 : 0,
            borderTop: isNewDay && idx > 0 ? `1px dotted ${C.border}` : 'none',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: isNewDay ? C.inkLight : 'transparent', fontWeight: 600, minWidth: 26 }}>
                {isNewDay ? day : ''}
              </span>
              <span style={{
                fontSize: 7,
                fontWeight: 700,
                letterSpacing: '0.04em',
                color: isSecondShift ? C.gold : C.inkLight,
                background: isSecondShift ? '#FFF8EE' : 'transparent',
                padding: isSecondShift ? '1px 4px' : '0',
                borderRadius: 2,
              }}>
                {shift}
              </span>
            </span>
            <span style={{ textAlign: 'right', color: plan != null ? C.ink : C.inkLight, fontWeight: plan != null ? 600 : 400 }}>
              {plan != null ? fmt(plan) : '—'}
            </span>
            <span style={{ textAlign: 'right', color: actual != null ? C.ink : C.inkLight, fontWeight: actual != null ? 600 : 400 }}>
              {actual != null ? fmt(actual) : '—'}
            </span>
            <span style={{ textAlign: 'right', color: deltaColor, fontWeight: 600 }}>
              {delta != null ? (delta > 0 ? `+${fmt(delta)}` : fmt(delta)) : '—'}
            </span>
            <span style={{ color: crew ? C.inkMid : C.inkLight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: crew ? 'normal' : 'italic', fontSize: 10 }}>
              {crew || '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function categoryFitsPO(category, po) {
  const pt = (po.product_type || '').toLowerCase()
  if (category === 'grass')     return pt.includes('grass')
  if (category === 'fabric')    return pt.includes('fabric') || pt.includes('strike-off')
  if (category === 'wallpaper') return pt.includes('paper') || pt.includes('panel')
  return false
}

function AssignmentCard({ a, onRemove }) {
  const isSch = (a.customer_type||'').toLowerCase() === 'schumacher'
  const is3P = (a.customer_type||'').toLowerCase().includes('3rd')
  const highColor = (a.colors_count || 0) >= HIGH_COLOR_THRESHOLD
  return (
    <div style={{ background: C.parchment, borderRadius: 4, padding: '5px 7px', marginBottom: 4, fontSize: 10, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
        {isSch && <span style={{ fontSize: 7, padding: '0 3px', borderRadius: 2, background: C.navy, color: '#fff', fontWeight: 700 }}>SCH</span>}
        {is3P && <span style={{ fontSize: 7, padding: '0 3px', borderRadius: 2, background: C.gold, color: '#fff', fontWeight: 700 }}>3P</span>}
        {highColor && <span style={{ fontSize: 7, padding: '0 3px', borderRadius: 2, background: C.rose, color: '#fff', fontWeight: 700 }}>{a.colors_count}c</span>}
        {a.assigned_by === 'claude' && <span style={{ fontSize: 7, padding: '0 3px', borderRadius: 2, background: C.gold, color: '#fff', fontWeight: 700 }}>✦</span>}
        <span style={{ marginLeft: 'auto', cursor: 'pointer', color: C.inkLight, fontSize: 11 }} onClick={onRemove} title="Remove assignment">×</span>
      </div>
      <div style={{ color: C.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.line_description}</div>
      <div style={{ color: C.inkLight, fontSize: 9 }}>{fmt(a.planned_yards)}yd · {fmt(a.planned_cy || 0)} CY</div>
    </div>
  )
}

function FilterChip({ active, onClick, color, children }) {
  return (
    <button onClick={onClick}
      style={{ padding: '3px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer', border: `1px solid ${active ? color : C.border}`, background: active ? color : 'transparent', color: active ? '#fff' : C.inkMid, fontWeight: active ? 700 : 400 }}>
      {children}
    </button>
  )
}

function AssignModal({ po, tableCode, proposed, onCancel, onConfirm, busy }) {
  const [yards, setYards] = useState(proposed)
  const cy = po.colors_count ? po.colors_count * yards : 0
  const maxY = po.remaining_yards
  const invalid = yards < 1 || yards > maxY
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 4 }}>Assign to {tableCode}</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif', marginBottom: 12 }}>{po.line_description}</div>
        <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 16 }}>
          PO: {po.po_number} · {po.product_type} · {po.colors_count || '—'} colors · {fmt(po.remaining_yards)} yards remaining
        </div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginBottom: 4 }}>Yards for this table</label>
        <input type="number" value={yards} onChange={e => setYards(parseInt(e.target.value) || 0)} min={1} max={maxY}
          style={{ width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, boxSizing: 'border-box', marginBottom: 8 }} />
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button onClick={() => setYards(maxY)} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>All ({fmt(maxY)})</button>
          <button onClick={() => setYards(Math.round(maxY / 2))} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>Half ({fmt(Math.round(maxY/2))})</button>
          <button onClick={() => setYards(Math.round(maxY / 3))} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>Third ({fmt(Math.round(maxY/3))})</button>
        </div>
        <div style={{ padding: '10px 14px', background: C.goldBg, borderRadius: 6, marginBottom: 16, fontSize: 12, color: C.ink }}>
          This assignment: <strong>{fmt(yards)} yards × {po.colors_count || 0} colors = {fmt(cy)} CY</strong>
          {yards < maxY && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 4 }}>Remaining {fmt(maxY - yards)} yards will stay in the pool.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, cursor: 'pointer', color: C.inkMid }}>Cancel</button>
          <button onClick={() => onConfirm(yards)} disabled={invalid || busy}
            style={{ padding: '8px 16px', background: invalid || busy ? C.warm : C.ink, color: invalid || busy ? C.inkLight : '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: invalid || busy ? 'not-allowed' : 'pointer' }}>
            {busy ? 'Assigning…' : 'Confirm assignment'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// CrewModal — assign 2 operators per day for a given Passaic table
// ═══════════════════════════════════════════════════════════════════════════
function CrewModal({ tableCode, weekStart, weeklyYards, onClose }) {
  // Two independent state arrays — one per shift. Each shift maintains its
  // own per-day rows. Per Peter 5/2/2026, 1st and 2nd are independent crews,
  // and Passaic runs both daily. Schema migration B1 made day_of_week TEXT
  // ('Sun'..'Sat'); legacy code wrote numeric day indices which silently
  // failed on the CHECK constraint. This rewrite fixes both.
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const [activeShift, setActiveShift] = useState('1st')
  const [rows1st, setRows1st] = useState([])
  const [rows2nd, setRows2nd] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingDay, setSavingDay] = useState(null)  // `${day}|${shift}` while saving

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const data = await loadWeekDailyOps('passaic', weekStart)
      if (cancelled) return

      // Index existing rows by (day, shift). Treat shift=NULL as 1st-shift
      // (legacy data written before this fix had no shift value).
      const existing = {}
      for (const r of (data || [])) {
        if (r.table_code !== tableCode) continue
        const sh = r.shift === '2nd' ? '2nd' : '1st'
        existing[`${r.day_of_week}|${sh}`] = r
      }

      const seedFor = (shift) => DAYS.map(d => {
        const e = existing[`${d}|${shift}`]
        return {
          day_of_week: d,
          operator_1: e?.operator_1 || '',
          operator_2: e?.operator_2 || '',
          // || not ?? so a saved 0 (legacy clear-phantom-plan artifact) loads as
          // blank input, matching the "—" the dashboard shows for it.
          planned_yards: e?.planned_yards || '',
          _savedAt: null,
        }
      })

      setRows1st(seedFor('1st'))
      setRows2nd(seedFor('2nd'))
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [tableCode, weekStart])

  // Helpers — the active-shift state pointer keeps the JSX simple.
  const activeRows = activeShift === '1st' ? rows1st : rows2nd
  const setActiveRows = activeShift === '1st' ? setRows1st : setRows2nd

  function updateRow(d, patch) {
    setActiveRows(prev => prev.map(r =>
      r.day_of_week === d ? { ...r, ...patch, _savedAt: null } : r
    ))
  }

  function applyEvenSplit() {
    if (!weeklyYards || weeklyYards <= 0) return
    // Split across the days that have operators assigned for THIS shift; if
    // none, fall back to all 7 days. Avoids the previous behavior of always
    // dividing by 5 (which broke when Wendy planned weekend work).
    const populatedDays = activeRows.filter(r => r.operator_1 || r.operator_2)
    const denom = populatedDays.length > 0 ? populatedDays.length : 7
    const perDay = Math.round(weeklyYards / denom)
    setActiveRows(prev => prev.map(r => ({ ...r, planned_yards: perDay, _savedAt: null })))
  }

  async function saveRow(d, shift) {
    const rowSet = shift === '1st' ? rows1st : rows2nd
    const setRowSet = shift === '1st' ? setRows1st : setRows2nd
    const row = rowSet.find(r => r.day_of_week === d)
    if (!row) return
    const key = `${d}|${shift}`
    setSavingDay(key)
    try {
      await upsertDailyOp({
        site: 'passaic',
        week_start: isoDate(weekStart),
        table_code: tableCode,
        day_of_week: d,
        shift,                  // explicit; B1 migration made this required
        operator_1: row.operator_1 || null,
        operator_2: row.operator_2 || null,
        planned_yards: row.planned_yards === '' ? null : Number(row.planned_yards),
      })
      setRowSet(prev => prev.map(r => r.day_of_week === d ? { ...r, _savedAt: Date.now() } : r))
    } catch (e) {
      alert('Save failed: ' + (e.message || e))
    } finally {
      setSavingDay(null)
    }
  }

  async function saveAll() {
    // Walk both shifts. Save any row that has any data — operators or yards.
    for (const r of rows1st) {
      if (r.operator_1 || r.operator_2 || r.planned_yards !== '') await saveRow(r.day_of_week, '1st')
    }
    for (const r of rows2nd) {
      if (r.operator_1 || r.operator_2 || r.planned_yards !== '') await saveRow(r.day_of_week, '2nd')
    }
  }

  // Tab badges — small dot when shift has any populated rows so Wendy can
  // see at a glance which shifts she's already planned.
  const has1stData = rows1st.some(r => r.operator_1 || r.operator_2 || r.planned_yards !== '')
  const has2ndData = rows2nd.some(r => r.operator_1 || r.operator_2 || r.planned_yards !== '')

  // Allocation totals per shift
  const totalPlanned1st = rows1st.reduce((s, r) => s + (Number(r.planned_yards) || 0), 0)
  const totalPlanned2nd = rows2nd.reduce((s, r) => s + (Number(r.planned_yards) || 0), 0)
  const activeTotalPlanned = activeShift === '1st' ? totalPlanned1st : totalPlanned2nd
  const combinedPlanned = totalPlanned1st + totalPlanned2nd
  const allocationDelta = weeklyYards != null ? combinedPlanned - weeklyYards : null

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, width: 'min(760px, 94vw)', maxHeight: '92vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '14px 18px', background: C.navy, color: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'Georgia,serif' }}>Daily Plan · {tableCode}</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>Week of {weekLabel(weekStart)} · set target yards and crew per shift</div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', color: '#fff', border: 'none', fontSize: 22, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>

        {/* Shift tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, background: C.parchment }}>
          <ShiftTab
            label="1st Shift"
            sub="6:30a–3p"
            active={activeShift === '1st'}
            hasData={has1stData}
            onClick={() => setActiveShift('1st')}
          />
          <ShiftTab
            label="2nd Shift"
            sub="3p–11p"
            active={activeShift === '2nd'}
            hasData={has2ndData}
            onClick={() => setActiveShift('2nd')}
          />
        </div>

        <div style={{ padding: 18 }}>
          {/* Weekly context + even-split helper. The combined "allocated" line
              shows total across BOTH shifts vs the table's weekly assigned
              yards; the even-split button only affects the active tab. */}
          {!loading && weeklyYards != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, padding: '10px 12px', background: C.parchment, borderRadius: 6, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.inkMid, flex: 1 }}>
                <strong style={{ color: C.ink }}>{fmt(weeklyYards)} yd</strong> assigned this week ·{' '}
                <strong style={{ color: allocationDelta === 0 ? C.sage : Math.abs(allocationDelta || 0) < 100 ? C.inkMid : C.gold }}>
                  {fmt(combinedPlanned)} yd
                </strong> allocated across both shifts
                {allocationDelta !== 0 && weeklyYards > 0 && (
                  <span style={{ color: C.inkLight, fontStyle: 'italic' }}>
                    {' · '}{allocationDelta > 0 ? `+${fmt(allocationDelta)} over` : `${fmt(-allocationDelta)} under`}
                  </span>
                )}
                <div style={{ fontSize: 10, color: C.inkLight, marginTop: 2 }}>
                  This shift: <strong>{fmt(activeTotalPlanned)} yd</strong>
                  {activeShift === '1st' && totalPlanned2nd > 0 && <> · 2nd shift has {fmt(totalPlanned2nd)} yd</>}
                  {activeShift === '2nd' && totalPlanned1st > 0 && <> · 1st shift has {fmt(totalPlanned1st)} yd</>}
                </div>
              </div>
              <button onClick={applyEvenSplit} disabled={!weeklyYards}
                style={{ padding: '6px 12px', background: 'transparent', color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: weeklyYards ? 'pointer' : 'not-allowed' }}
                title="Splits weekly assigned yards across active days on this shift">
                Even split
              </button>
            </div>
          )}

          {loading && <div style={{ textAlign: 'center', padding: 40, color: C.inkLight, fontSize: 13 }}>Loading…</div>}
          {!loading && activeRows.map(r => {
            const isSaving = savingDay === `${r.day_of_week}|${activeShift}`
            return (
              <div key={r.day_of_week} style={{ display: 'grid', gridTemplateColumns: '60px 100px 1fr 1fr 90px', gap: 10, alignItems: 'center', marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>{r.day_of_week}</div>
                <input type="number" value={r.planned_yards} onChange={e => updateRow(r.day_of_week, { planned_yards: e.target.value })}
                  placeholder="yds"
                  style={{ padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 12, background: '#fff', boxSizing: 'border-box' }} />
                <select value={r.operator_1} onChange={e => updateRow(r.day_of_week, { operator_1: e.target.value })}
                  style={{ padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 12, background: '#fff' }}>
                  <option value="">— Operator 1 —</option>
                  {PASSAIC_OPERATORS.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <select value={r.operator_2} onChange={e => updateRow(r.day_of_week, { operator_2: e.target.value })}
                  style={{ padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 12, background: '#fff' }}>
                  <option value="">— Operator 2 —</option>
                  {PASSAIC_OPERATORS.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button onClick={() => saveRow(r.day_of_week, activeShift)} disabled={isSaving}
                  style={{ padding: '7px 10px', background: isSaving ? C.warm : C.ink, color: isSaving ? C.inkLight : '#fff', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: isSaving ? 'not-allowed' : 'pointer' }}>
                  {isSaving ? '…' : r._savedAt ? '✓' : 'Save'}
                </button>
              </div>
            )
          })}

          {!loading && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
              <div style={{ fontSize: 11, color: C.inkLight, fontStyle: 'italic' }}>
                Sami verifies actuals against these targets in Live Ops at end of each shift.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={saveAll}
                  style={{ padding: '8px 14px', background: C.navy, color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  Save all rows
                </button>
                <button onClick={onClose}
                  style={{ padding: '8px 14px', background: 'transparent', color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Tab button for the CrewModal shift switcher. Underline + bold for active.
 * Small dot badge when shift has populated rows.
 */
function ShiftTab({ label, sub, active, hasData, onClick }) {
  return (
    <button onClick={onClick}
      style={{
        flex: 1,
        padding: '12px 16px',
        background: active ? '#fff' : 'transparent',
        border: 'none',
        borderBottom: active ? `2px solid ${C.navy}` : '2px solid transparent',
        cursor: 'pointer',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: 13,
          fontWeight: active ? 700 : 600,
          color: active ? C.ink : C.inkMid,
          fontFamily: 'Georgia,serif',
        }}>
          {label}
        </div>
        <div style={{ fontSize: 10, color: C.inkLight, marginTop: 1 }}>{sub}</div>
      </div>
      {hasData && (
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: C.navy,
        }} title="Shift has assignments" />
      )}
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// ASK CLAUDE PANEL — conversational AI scheduler with streaming (Passaic)
// ═══════════════════════════════════════════════════════════════════════════
function AskClaudePanel({ onClose, weekStart, pool, assignments, mixTotals, onApplyAssignments }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [phase, setPhase] = useState('intro')
  const [error, setError] = useState(null)
  const [applying, setApplying] = useState(false)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (messages.length === 0) {
      generateOpening()
    }
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streaming])

  function buildContextSummary() {
    const poolSummary = {
      total: pool.length,
      by_customer: {
        schumacher: pool.filter(p => (p.customer_type||'').toLowerCase() === 'schumacher').length,
        third_party: pool.filter(p => (p.customer_type||'').toLowerCase().includes('3rd')).length,
      },
      by_category: {
        grass: pool.filter(p => (p.product_type||'').toLowerCase().includes('grass')).length,
        fabric: pool.filter(p => (p.product_type||'').toLowerCase().includes('fabric') || (p.product_type||'').toLowerCase().includes('strike-off')).length,
        wallpaper: pool.filter(p => (p.product_type||'').toLowerCase().includes('paper') || (p.product_type||'').toLowerCase().includes('panel')).length,
      },
      high_color: pool.filter(p => (p.colors_count || 0) >= HIGH_COLOR_THRESHOLD).length,
      aged_90plus: pool.filter(p => (p.age_days || 0) > 90).length,
      aged_180plus: pool.filter(p => (p.age_days || 0) > 180).length,
      waste_history: pool.filter(p => hasWasteHistory(p.line_description)).length,
      total_yards_available: pool.reduce((s, p) => s + Number(p.remaining_yards || 0), 0),
      total_revenue_available: pool.reduce((s, p) => s + Number(p.income_written || 0), 0),
    }
    return {
      week_of: isoDate(weekStart),
      targets: PASSAIC_TARGETS.total,
      mix_target: { schumacher_pct: 60, third_party_pct: 40 },
      current_assignments: assignments.length,
      current_totals: {
        yards: Math.round(mixTotals.yards),
        cy: Math.round(mixTotals.cy),
        revenue: Math.round(mixTotals.revenue),
        schumacher_pct: mixTotals.revenue > 0 ? Math.round((mixTotals.schumacher_revenue / mixTotals.revenue) * 100) : 0,
      },
      pool_summary: poolSummary,
    }
  }

  const SYSTEM_PROMPT = `You are Claude, acting as a production scheduling advisor for Peter Webster at Paramount Prints — the specialty screen-printing division of F. Schumacher & Co. You're working with Wendy, the production manager at the Passaic NJ plant.

PASSAIC PLANT STRUCTURE:
- 17 tables total: 2 Grasscloth (GC-1, GC-2), 9 Fabric (FAB-3 through FAB-11), 6 Wallpaper (WP-12 through WP-17)
- Weekly capacity targets: 8,500 yards, 33,797 color-yards, $116K revenue
- Category split: Grass 3,785yd/11,355CY, Fabric 834yd/3,337CY, Wallpaper 3,830yd/15,319CY

THE MIX IS THE SCHEDULE. This is the core thesis:
- Revenue must hit target — non-negotiable
- Yards must hit target — operational baseline  
- Color-yards measure labor utilization — are tables working hard enough
- Customer mix: 60% Schumacher / 40% 3rd Party is healthy. 3rd Party pays 10% more margin — it's the profit engine
- Peter's quote: "The mix is the schedule. The rest is people management."

SCHEDULING LOGIC:
- Aged POs (90+ days) should be prioritized FIFO to clear backlog
- Everything else optimizes for mix/revenue
- Angel's color complexity rule: each additional color adds ~20% production time (1.2^x). 6+ colors is "high-risk" — flag these
- Patterns with waste history: Cloud Toile, Banana Leaf, Acanthus Stripe, Pyne Hollyhock, Botanico Metallic. Either defer, or flag the risk when scheduling
- Leave headroom — don't fill tables past 95% CY capacity
- Category routing: Grass POs → GC tables; Fabric/Strike-off → FAB tables; Paper/Panel → WP tables

YOUR ROLE:
You are a thinking partner, not a commander. Wendy owns the decisions. Your job is to break her out of the blank-slate freeze by proposing a starting draft she can react to, and to keep advising as she adjusts.

Speak warmly, directly, with the tone of a colleague who's been in the plant. Use her name. Reference specific patterns, specific POs, specific tables when relevant — this isn't generic.`

  async function generateOpening() {
    setStreaming(true); setError(null)
    const context = buildContextSummary()
    const userMsg = `It's Monday morning. Wendy is opening the scheduler to plan the week of ${isoDate(weekStart)}. The board is currently ${context.current_assignments === 0 ? 'empty' : `partially filled with ${context.current_assignments} assignments`}.

CURRENT STATE:
${JSON.stringify(context, null, 2)}

Your task right now: write an opening message to Wendy (max ~180 words). Include:
1. A warm greeting by name
2. A quick read of the state — how much WIP is schedulable, how aged, where the concentration is
3. Your initial read on this week's strategy in 2-3 sentences (what you'd focus on if you were sitting next to her)
4. End by asking if there's anything you should know before you draft — rush orders, crew changes, patterns to avoid, Schumacher priorities, anything that's not in the data

Don't draft a schedule yet. Just open the conversation.

Tone: peer-to-peer, warm but direct, like a colleague not a chatbot. No headers, no bullet points — prose paragraph(s).`

    try {
      await streamClaude([{ role: 'user', content: userMsg }], () => {})
    } catch (e) {
      console.error(e); setError(e.message || String(e))
    } finally {
      setStreaming(false)
    }
  }

  async function sendMessage(userText) {
    if (!userText.trim() || streaming) return
    const newMessages = [...messages, { role: 'user', content: userText }]
    setMessages(newMessages); setInput(''); setStreaming(true); setError(null); setPhase('conversing')

    const context = buildContextSummary()
    const convo = newMessages.map(m => ({ role: m.role, content: m.content }))

    // Fetch this week's daily actuals so Opus can pivot based on Sami's entries
    const dailyOps = await loadWeekDailyOps('passaic', weekStart)
    const actualsBlock = buildRecentActualsSummary(dailyOps, weekStart, 3)

    const contextNote = `\n\n[CURRENT STATE — not from user, for your context:\n${JSON.stringify(context, null, 2)}\n${actualsBlock ? `\nRECENT DAILY ACTUALS (from Sami — use these to pivot the remaining week. If a table fell short, consider adding catch-up; if a table ran over or a PO finished, don't re-propose it. Watch for patterns in the notes — registration issues, color problems — worth flagging):\n${actualsBlock}\n` : ''}\nPOOL (top 100 POs sorted by age):\n${pool.slice(0,100).map(p => `  ${p.po_number} | ${p.line_description} | ${p.product_type} | ${p.customer_type||'?'} | ${p.colors_count||'?'}c | ${p.remaining_yards}yd | ${p.age_days}d | $${Math.round(p.income_written||0)}`).join('\n')}\n\nYou can draft a schedule by responding with a narrative explanation PLUS a JSON code block like:\n\`\`\`json\n{"proposals":[{"po_number":"PO12345","table_code":"WP-12","planned_yards":450,"planned_cy":2700,"rationale":"..."}]}\n\`\`\`\n\nIf you include a JSON code block, the frontend will apply those assignments to the board automatically. Only include it when you're ready to commit to a draft Wendy can accept/edit/reject.]`
    convo[convo.length - 1].content += contextNote

    try {
      // streamClaude pushes + finalizes the assistant message itself; no-op callback
      await streamClaude(convo, () => {})
    } catch (e) {
      console.error(e); setError(e.message || String(e))
    } finally {
      setStreaming(false)
    }
  }

  async function streamClaude(messages, onComplete) {
    const response = await fetch('/api/claude-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages,
        stream: true,
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let fullText = ''

    setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }])

    // Throttle narrative phase to ~12/sec; stop flushing entirely once JSON begins.
    // Without the cutoff, 60-90s of JSON streaming (which is invisible to the user
    // thanks to the display stripper) still slams React with updates and locks
    // the browser. One marker flush switches the bubble to a static indicator.
    const FLUSH_INTERVAL_MS = 80
    let lastFlush = 0
    let jsonPhase = false
    const flushIfDue = () => {
      if (jsonPhase) return
      if (fullText.includes('```json') || /\{\s*"proposals"\s*:/.test(fullText)) {
        jsonPhase = true
        setMessages(prev => {
          const copy = [...prev]
          copy[copy.length - 1] = { role: 'assistant', content: fullText, streaming: true, writingProposals: true }
          return copy
        })
        return
      }
      const now = Date.now()
      if (now - lastFlush < FLUSH_INTERVAL_MS) return
      lastFlush = now
      setMessages(prev => {
        const copy = [...prev]
        copy[copy.length - 1] = { role: 'assistant', content: fullText, streaming: true }
        return copy
      })
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const events = buf.split('\n\n')
      buf = events.pop() || ''
      for (const evt of events) {
        const lines = evt.split('\n').filter(Boolean)
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const obj = JSON.parse(payload)
            if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
              fullText += obj.delta.text
              flushIfDue()
            }
          } catch { /* partial JSON, ignore */ }
        }
      }
    }

    const proposals = extractProposals(fullText)

    setMessages(prev => {
      const copy = [...prev]
      copy[copy.length - 1] = { role: 'assistant', content: fullText, proposals, streaming: false, writingProposals: false }
      return copy
    })

    if (onComplete) onComplete(fullText, proposals)
  }

  function extractProposals(text) {
    const match = text.match(/```json\s*([\s\S]*?)\s*```/i)
    if (!match) return null
    try {
      const obj = JSON.parse(match[1])
      if (Array.isArray(obj.proposals) && obj.proposals.length > 0) {
        const valid = obj.proposals.filter(p => p.po_number && p.table_code && p.planned_yards)
        return valid.length > 0 ? valid : null
      }
    } catch { /* not parseable */ }
    return null
  }

  async function applyProposals(proposals) {
    if (!proposals || proposals.length === 0) return
    if (!confirm(`Apply Claude's ${proposals.length} proposed assignments to the board?`)) return
    setApplying(true)
    try {
      await onApplyAssignments(proposals)
      setMessages(prev => [...prev, {
        role: 'system',
        content: `✓ Applied ${proposals.length} assignment${proposals.length !== 1 ? 's' : ''} to the board. You can edit, remove, or ask Claude to adjust.`,
      }])
    } catch (e) {
      alert('Failed to apply: ' + (e.message || e))
    } finally {
      setApplying(false)
    }
  }

  const quickChips = [
    { label: 'Draft a full schedule', text: "Go ahead and draft a full schedule for this week. Nothing special to flag — work with what's in the pool." },
    { label: 'Rush orders', text: "We have a rush order I need to fit in this week:" },
    { label: 'Crew changes', text: "Heads up on crew this week:" },
    { label: 'Patterns to defer', text: "Let's defer these patterns this week:" },
  ]

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
      <div style={{
        background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12,
        width: 'min(1100px, 92vw)', height: 'min(820px, 92vh)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
      <div style={{ padding: '12px 16px', background: C.navy, color: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 18 }}>✦</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'Georgia,serif' }}>Ask Claude · Scheduling</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)' }}>Opus 4.7 · Week of {weekLabel(weekStart)}</div>
        </div>
        <button onClick={onClose} style={{ background: 'transparent', color: '#fff', border: 'none', fontSize: 20, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', background: C.cream }}>
        {messages.length === 0 && !streaming && (
          <div style={{ textAlign: 'center', color: C.inkLight, fontSize: 12, padding: 40 }}>Loading…</div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} onApplyProposals={applyProposals} applying={applying} />
        ))}
        {error && (
          <div style={{ background: C.roseBg, border: '1px solid #E8A0A0', borderRadius: 6, padding: '10px 12px', fontSize: 12, color: C.rose, marginTop: 8 }}>
            Error: {error}. Try again.
          </div>
        )}
      </div>

      {!streaming && messages.length > 0 && (
        <div style={{ padding: '8px 12px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 4, flexWrap: 'wrap', background: C.parchment }}>
          {quickChips.map(chip => (
            <button key={chip.label} onClick={() => setInput(chip.text)}
              style={{ padding: '4px 10px', fontSize: 10, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer', color: C.inkMid }}>
              {chip.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ padding: 12, borderTop: `1px solid ${C.border}`, background: '#fff' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) }
            }}
            placeholder={streaming ? 'Claude is thinking…' : 'Message Claude…'}
            disabled={streaming}
            rows={2}
            style={{
              flex: 1, padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 6,
              fontSize: 12, fontFamily: 'inherit', resize: 'none', background: streaming ? C.cream : '#fff',
              boxSizing: 'border-box',
            }}
          />
          <button onClick={() => sendMessage(input)} disabled={streaming || !input.trim()}
            style={{
              padding: '0 16px', background: (streaming || !input.trim()) ? C.warm : C.ink,
              color: (streaming || !input.trim()) ? C.inkLight : '#fff',
              border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600,
              cursor: (streaming || !input.trim()) ? 'not-allowed' : 'pointer',
            }}>
            {streaming ? '⏳' : 'Send'}
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}

function MessageBubble({ message, onApplyProposals, applying }) {
  if (message.role === 'system') {
    return (
      <div style={{ padding: '8px 12px', background: C.sageBg, border: `1px solid ${C.sage}`, borderRadius: 6, fontSize: 11, color: C.sage, marginBottom: 10, fontWeight: 600 }}>
        {message.content}
      </div>
    )
  }
  if (message.role === 'user') {
    return (
      <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ background: C.navy, color: '#fff', borderRadius: '10px 10px 2px 10px', padding: '8px 12px', maxWidth: '85%', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {message.content}
        </div>
      </div>
    )
  }
  const text = message.content || ''
  // Strip fenced and bare JSON from rendered text (mid-stream-safe).
  const displayText = text
    .replace(/```json\s*[\s\S]*?```/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\{\s*"proposals"\s*:[\s\S]*$/i, '')
    .trim()
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px 10px 10px 2px', padding: '10px 14px', fontSize: 12, lineHeight: 1.6, color: C.ink, whiteSpace: 'pre-wrap', fontFamily: 'Georgia,serif' }}>
        {displayText}
        {message.streaming && !message.writingProposals && <span style={{ display: 'inline-block', width: 6, height: 12, background: C.inkMid, marginLeft: 3, animation: 'blink 1s infinite' }} />}
        {message.writingProposals && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: C.goldBg, border: `1px solid ${C.gold}`, borderRadius: 6, fontSize: 11, color: C.inkMid, fontStyle: 'italic', fontFamily: 'system-ui, sans-serif' }}>
            ✦ Writing proposals… this typically takes 30–90 seconds for a full draft. The Apply button will appear when it's done.
          </div>
        )}
      </div>
      {message.proposals && message.proposals.length > 0 && !message.streaming && (
        <div style={{ marginTop: 8, padding: '10px 12px', background: C.goldBg, border: `1px solid ${C.gold}`, borderRadius: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.ink, marginBottom: 6 }}>
            ✦ Claude proposed {message.proposals.length} assignment{message.proposals.length !== 1 ? 's' : ''}
          </div>
          <div style={{ fontSize: 10, color: C.inkMid, marginBottom: 8, maxHeight: 100, overflowY: 'auto' }}>
            {message.proposals.slice(0, 8).map((p, i) => (
              <div key={i}>→ {p.table_code}: {p.po_number} · {fmt(p.planned_yards)}yd</div>
            ))}
            {message.proposals.length > 8 && <div>+ {message.proposals.length - 8} more</div>}
          </div>
          <button onClick={() => onApplyProposals(message.proposals)} disabled={applying}
            style={{ padding: '6px 14px', background: applying ? C.warm : C.ink, color: applying ? C.inkLight : '#fff', border: 'none', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: applying ? 'not-allowed' : 'pointer' }}>
            {applying ? 'Applying…' : 'Apply all to board'}
          </button>
        </div>
      )}
    </div>
  )
}
