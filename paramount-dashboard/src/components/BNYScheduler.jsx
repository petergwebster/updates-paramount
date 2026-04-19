import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { C, fmt, fmtD, fmtK, isoDate, weekLabel, weekLabelFiscal, addWeeks, defaultSchedulerWeek } from '../lib/scheduleUtils'

// ─── BNY-specific constants ────────────────────────────────────────────────
const BNY_TARGETS = {
  brooklyn_yards: 10000,
  passaic_yards:  5000,
  total_yards:   15000,
  buckets: {
    'Replen':    7885,
    'NEW GOODS': null,
    'MTO':       1280,
    'HOS':        210,
    'Memo':      1535,
    '3P':        1090,
  },
}

const BNY_BUCKETS = ['Replen', 'NEW GOODS', 'MTO', 'HOS', 'Memo', '3P']
const BUCKET_COLOR = {
  'Replen':    C.navy,
  'NEW GOODS': C.gold,
  'MTO':       C.sage,
  'HOS':       C.amber,
  'Memo':      C.slate,
  '3P':        C.rose,
}
const BUCKET_BG = {
  'Replen':    C.navyLight,
  'NEW GOODS': C.goldBg,
  'MTO':       C.sageBg,
  'HOS':       C.amberBg,
  'Memo':      C.slateBg,
  '3P':        C.roseBg,
}

const HIGH_COLOR_THRESHOLD = 6
const MIX_TARGET_SCH = 0.60

const BNY_MACHINES = {
  brooklyn: [
    { name: 'Glow',   model: '3600', capacity: 600 },
    { name: 'Sasha',  model: '3600', capacity: 600 },
    { name: 'Trish',  model: '3600', capacity: 600 },
    { name: 'Bianca', model: '570',  capacity: 500 },
    { name: 'LASH',   model: '570',  capacity: 500 },
    { name: 'Chyna',  model: '570',  capacity: 500 },
    { name: 'Rhonda', model: '570',  capacity: 500 },
  ],
  passaic: [
    { name: 'Dakota Ka',  capacity: 500 },
    { name: 'Dementia',   capacity: 500 },
    { name: 'EMBER',      capacity: 500 },
    { name: 'Ivy Nile',   capacity: 500 },
    { name: 'Jacy Jayne', capacity: 500 },
    { name: 'Ruby',       capacity: 500 },
    { name: 'Valhalla',   capacity: 500 },
    { name: 'XIA',        capacity: 500 },
    { name: 'Apollo',     capacity: 500 },
    { name: 'Nemesis',    capacity: 500 },
    { name: 'Poseidon',   capacity: 500 },
    { name: 'Zoey',       capacity: 500 },
  ],
}

const BNY_OPERATORS = {
  brooklyn: [
    'Shelby Adams', 'Ramon Bermudez', 'Blake Devine-Rosser',
    'Sara Howard', 'Susan Jean-Baptiste', 'Philip Keefer',
    'Brynn Lawlor', 'Adam McClellan', "John O'Connor",
    'Sydney Remson', 'Denzell Silvia', 'Xiachen Zhou',
  ],
  passaic: [
    'Joseph Horton', 'Luis Mendoza Capecchi', 'Jeanne Villeneuve',
  ],
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const NUM_DAYS = 7

// ═══════════════════════════════════════════════════════════════════════════
// BNYScheduler — weekly machine-day schedule composer for Brooklyn + Passaic
// ═══════════════════════════════════════════════════════════════════════════
export default function BNYScheduler({ wipRows, assignments, weekStart, onWeekChange, onAssignmentsChange }) {
  const [selectedPO, setSelectedPO] = useState(null)
  const [assigning, setAssigning] = useState(false)
  const [assignModal, setAssignModal] = useState(null)
  const [poolFilter, setPoolFilter] = useState('')
  const [filterBucket, setFilterBucket] = useState(null)
  const [filterHighColor, setFilterHighColor] = useState(false)
  const [filterAged90, setFilterAged90] = useState(false)
  const [askClaudeOpen, setAskClaudeOpen] = useState(false)

  const brooklynMachineNames = useMemo(() => new Set(BNY_MACHINES.brooklyn.map(m => m.name)), [])
  const passaicMachineNames  = useMemo(() => new Set(BNY_MACHINES.passaic.map(m => m.name)), [])

  const schedulableWip = useMemo(
    () => wipRows.filter(r => r.bny_bucket && r.yards_written > 0),
    [wipRows]
  )

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
    return schedulableWip
      .filter(r => schedulableStatuses.has(r.order_status || ''))
      .map(r => {
        const already = assignedByPO[r.po_number] || 0
        const remaining = Math.max(0, Number(r.yards_written || 0) - already)
        return { ...r, assigned_already: already, remaining_yards: remaining }
      })
      .filter(r => r.remaining_yards > 0)
  }, [schedulableWip, assignedByPO])

  const filteredPool = useMemo(() => {
    let list = pool
    if (poolFilter) {
      const q = poolFilter.toLowerCase()
      list = list.filter(r =>
        (r.po_number||'').toLowerCase().includes(q) ||
        (r.line_description||'').toLowerCase().includes(q)
      )
    }
    if (filterBucket)    list = list.filter(r => r.bny_bucket === filterBucket)
    if (filterHighColor) list = list.filter(r => (r.colors_count || 0) >= HIGH_COLOR_THRESHOLD)
    if (filterAged90)    list = list.filter(r => (r.age_days || 0) > 90)
    return list.sort((a, b) => (b.age_days || 0) - (a.age_days || 0))
  }, [pool, poolFilter, filterBucket, filterHighColor, filterAged90])

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
        bny_bucket: src.bny_bucket || null,
        customer_type: src.customer_type || null,
        colors_count: src.colors_count || null,
        income_per_yard: src.income_written && src.yards_written ? (src.income_written / src.yards_written) : 0,
      }
    })
  }, [assignments, wipByPO])

  const mixTotals = useMemo(() => {
    const t = {
      yards: 0, revenue: 0,
      brooklyn_yards: 0, passaic_yards: 0,
      schumacher_revenue: 0, third_party_revenue: 0,
      buckets: {}, buckets_revenue: {}, buckets_orders: {},
    }
    for (const b of BNY_BUCKETS) { t.buckets[b] = 0; t.buckets_revenue[b] = 0; t.buckets_orders[b] = 0 }
    for (const a of enrichedAssignments) {
      const yd = Number(a.planned_yards || 0)
      const rev = yd * (a.income_per_yard || 0)
      t.yards += yd
      t.revenue += rev
      if (brooklynMachineNames.has(a.table_code)) t.brooklyn_yards += yd
      else if (passaicMachineNames.has(a.table_code)) t.passaic_yards += yd
      if (a.bny_bucket && BNY_BUCKETS.includes(a.bny_bucket)) {
        t.buckets[a.bny_bucket] += yd
        t.buckets_revenue[a.bny_bucket] += rev
        t.buckets_orders[a.bny_bucket] += 1
      }
      if (a.bny_bucket === '3P') t.third_party_revenue += rev
      else if (a.bny_bucket) t.schumacher_revenue += rev
    }
    return t
  }, [enrichedAssignments, brooklynMachineNames, passaicMachineNames])

  const assignmentsByMachineDay = useMemo(() => {
    const m = {}
    for (const a of enrichedAssignments) {
      const key = `${a.table_code}|${a.day_of_week}`
      if (!m[key]) m[key] = []
      m[key].push(a)
    }
    return m
  }, [enrichedAssignments])

  function capacityFor(machineName, locationKey) {
    const list = BNY_MACHINES[locationKey] || []
    const m = list.find(x => x.name === machineName)
    return m?.capacity || 500
  }

  function handleMachineDayClick(machineName, dayOfWeek, locationKey) {
    if (!selectedPO) return
    if (selectedPO.remaining_yards <= 0) return
    setAssignModal({
      po: selectedPO,
      machine: machineName,
      day_of_week: dayOfWeek,
      location: locationKey,
      proposed_yards: Math.min(selectedPO.remaining_yards, capacityFor(machineName, locationKey)),
    })
  }

  async function commitAssignment({ po, machine, dayOfWeek, yards, operator }) {
    setAssigning(true)
    try {
      const { error: ie } = await supabase.from('sched_assignments').insert({
        site: 'bny',
        po_number: po.po_number,
        line_description: po.line_description,
        product_type: po.product_type,
        table_code: machine,
        week_start: isoDate(weekStart),
        day_of_week: dayOfWeek,
        planned_yards: yards,
        planned_cy: null,
        assigned_by: null,
        operator: operator || null,
        notes: null,
        status: 'planned',
      })
      if (ie) throw ie
      await onAssignmentsChange()
      if (yards >= po.remaining_yards) setSelectedPO(null)
      else setSelectedPO({
        ...po,
        remaining_yards: po.remaining_yards - yards,
        assigned_already: (po.assigned_already || 0) + yards,
      })
      setAssignModal(null)
    } catch (e) {
      console.error(e); alert('Assignment failed: ' + (e.message || e))
    } finally { setAssigning(false) }
  }

  async function removeAssignment(id) {
    if (!confirm('Remove this assignment?')) return
    const { error } = await supabase.from('sched_assignments').delete().eq('id', id)
    if (error) { alert('Delete failed: ' + error.message); return }
    await onAssignmentsChange()
  }

  async function clearAllAssignments() {
    if (!confirm(`Remove all ${enrichedAssignments.length} assignments for this week?`)) return
    const { error } = await supabase.from('sched_assignments').delete()
      .eq('site', 'bny').eq('week_start', isoDate(weekStart))
    if (error) { alert('Clear failed: ' + error.message); return }
    await onAssignmentsChange()
  }

  async function updateMachineDayOperator(machine, dayOfWeek, operator) {
    const cellAssignments = assignmentsByMachineDay[`${machine}|${dayOfWeek}`] || []
    if (cellAssignments.length === 0) return
    const ids = cellAssignments.map(a => a.id)
    const { error } = await supabase.from('sched_assignments')
      .update({ operator: operator || null })
      .in('id', ids)
    if (error) { alert('Operator update failed: ' + error.message); return }
    await onAssignmentsChange()
  }

  return (
    <div>
      {/* Week navigator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 14px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <button onClick={() => onWeekChange(addWeeks(weekStart, -1))} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.inkMid }}>← Prev week</button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>Week of {weekLabelFiscal(weekStart)}</div>
          <div style={{ fontSize: 11, color: C.inkLight }}>{enrichedAssignments.length} assignment{enrichedAssignments.length !== 1 ? 's' : ''}</div>
        </div>
        <button onClick={() => onWeekChange(defaultSchedulerWeek())} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>Default week</button>
        <button onClick={() => onWeekChange(addWeeks(weekStart, 1))} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.inkMid }}>Next week →</button>
      </div>

      {/* Ask Claude + admin */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button
          onClick={() => setAskClaudeOpen(true)}
          style={{
            padding: '12px 22px', background: C.amber, color: '#fff', border: 'none',
            borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            boxShadow: '0 2px 8px rgba(193,127,36,0.25)',
          }}>
          <span style={{ fontSize: 18 }}>✦</span> Ask Claude
        </button>
        <span style={{ fontSize: 12, color: C.inkLight, fontStyle: 'italic' }}>
          Let Claude draft a schedule for Chandler this week, or ask what's in the pool.
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
        <BNYTopGauges totals={mixTotals} />
        <BucketStrip totals={mixTotals} />
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '340px 1fr',
        gap: 16, marginTop: 16,
      }}>
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', height: 'fit-content', position: 'sticky', top: 230 }}>
          <div style={{ padding: '12px 14px', background: C.parchment, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 6 }}>Unscheduled Pool</div>
            <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{filteredPool.length} POs to schedule</div>
          </div>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
            <input type="text" value={poolFilter} onChange={e => setPoolFilter(e.target.value)} placeholder="Search pattern or PO…"
              style={{ width: '100%', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, marginBottom: 8, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {BNY_BUCKETS.map(b => (
                <FilterChip key={b} active={filterBucket === b}
                  onClick={() => setFilterBucket(filterBucket === b ? null : b)}
                  color={BUCKET_COLOR[b]}>
                  {b}
                </FilterChip>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <FilterChip active={filterHighColor} onClick={() => setFilterHighColor(!filterHighColor)} color={C.rose}>High-color 6+</FilterChip>
              <FilterChip active={filterAged90} onClick={() => setFilterAged90(!filterAged90)} color={C.amber}>Aged 90+</FilterChip>
            </div>
          </div>
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {filteredPool.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: C.inkLight, fontSize: 12 }}>No POs match these filters</div>
            )}
            {filteredPool.map(r => {
              const sel = selectedPO?.po_number === r.po_number
              const highColor = (r.colors_count || 0) >= HIGH_COLOR_THRESHOLD
              const aged = (r.age_days || 0) > 90
              return (
                <div key={r.id} onClick={() => setSelectedPO(sel ? null : r)}
                  style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', background: sel ? C.goldBg : 'transparent' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: C.inkLight }}>{r.po_number}</span>
                    {r.bny_bucket && (
                      <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: BUCKET_BG[r.bny_bucket], color: BUCKET_COLOR[r.bny_bucket], fontWeight: 700 }}>{r.bny_bucket}</span>
                    )}
                    {highColor && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.roseBg, color: C.rose, fontWeight: 700 }}>{r.colors_count}c</span>}
                    {aged && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.amberBg, color: C.amber, fontWeight: 700 }}>{r.age_days}d</span>}
                  </div>
                  <div style={{ fontSize: 12, color: C.ink, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>{r.line_description}</div>
                  <div style={{ fontSize: 10, color: C.inkLight, display: 'flex', gap: 8 }}>
                    <span>{fmt(r.remaining_yards)} yd remaining{r.assigned_already > 0 ? ` (${fmt(r.assigned_already)} scheduled)` : ''}</span>
                    <span>·</span>
                    <span>{fmtD(r.income_written)}</span>
                  </div>
                </div>
              )
            })}
          </div>
          {selectedPO && (
            <div style={{ padding: '10px 14px', background: C.goldBg, borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.ink }}>
              <strong>Selected:</strong> {selectedPO.line_description}<br/>
              <span style={{ color: C.inkMid }}>Click a machine-day cell to assign {fmt(selectedPO.remaining_yards)} yards (or split in the next step)</span>
            </div>
          )}
        </div>

        <div>
          <LocationSection
            locationKey="brooklyn"
            label="Brooklyn"
            sublabel="3× HP 3600 · 4× HP 570"
            machines={BNY_MACHINES.brooklyn}
            assignmentsByMachineDay={assignmentsByMachineDay}
            selectedPO={selectedPO}
            onCellClick={handleMachineDayClick}
            onRemoveAssignment={removeAssignment}
            onOperatorChange={updateMachineDayOperator}
          />
          <LocationSection
            locationKey="passaic"
            label="Passaic (BNY)"
            sublabel="12× small digitals, all budget to BNY"
            machines={BNY_MACHINES.passaic}
            assignmentsByMachineDay={assignmentsByMachineDay}
            selectedPO={selectedPO}
            onCellClick={handleMachineDayClick}
            onRemoveAssignment={removeAssignment}
            onOperatorChange={updateMachineDayOperator}
          />
        </div>
      </div>

      {/* ASK CLAUDE — modal overlay (full-screen) */}
      {askClaudeOpen && (
        <AskClaudeBNYPanel
          onClose={() => setAskClaudeOpen(false)}
          weekStart={weekStart}
          pool={pool}
          assignments={enrichedAssignments}
          mixTotals={mixTotals}
          onApplyAssignments={async (proposals) => {
            // Seed per-cell running totals with what's already on the board
            // so we don't push existing cells over capacity either.
            const cellTotals = {}
            for (const a of enrichedAssignments) {
              const key = `${a.table_code}|${a.day_of_week}`
              cellTotals[key] = (cellTotals[key] || 0) + Number(a.planned_yards || 0)
            }

            const accepted = []
            const skipped = []
            for (const p of proposals) {
              const key = `${p.machine}|${p.day_of_week}`
              const loc = brooklynMachineNames.has(p.machine)
                ? 'brooklyn'
                : passaicMachineNames.has(p.machine) ? 'passaic' : null
              if (!loc) {
                skipped.push({ p, reason: `unknown machine "${p.machine}"` })
                continue
              }
              const cap = capacityFor(p.machine, loc)
              const current = cellTotals[key] || 0
              const yd = Number(p.planned_yards || 0)
              if (current + yd > cap) {
                skipped.push({
                  p,
                  reason: `${p.machine} ${DAY_LABELS[p.day_of_week] || `d${p.day_of_week}`} would be ${current + yd}/${cap}`,
                })
                continue
              }
              accepted.push(p)
              cellTotals[key] = current + yd
            }

            if (accepted.length > 0) {
              const rows = accepted.map(p => ({
                site: 'bny',
                po_number: p.po_number,
                line_description: p.line_description || null,
                product_type: p.product_type || null,
                table_code: p.machine,
                week_start: isoDate(weekStart),
                day_of_week: p.day_of_week,
                planned_yards: p.planned_yards,
                planned_cy: null,
                operator: null,
                assigned_by: 'claude',
                notes: p.rationale || null,
                status: 'planned',
              }))
              const { error } = await supabase.from('sched_assignments').insert(rows)
              if (error) throw error
              await onAssignmentsChange()
            }

            return { accepted: accepted.length, skipped: skipped.length, skippedDetails: skipped }
          }}
        />
      )}

      {assignModal && (
        <AssignModalBNY
          po={assignModal.po}
          machine={assignModal.machine}
          dayOfWeek={assignModal.day_of_week}
          location={assignModal.location}
          proposed={assignModal.proposed_yards}
          dailyCapacity={capacityFor(assignModal.machine, assignModal.location)}
          existingOnCell={assignmentsByMachineDay[`${assignModal.machine}|${assignModal.day_of_week}`] || []}
          onCancel={() => setAssignModal(null)}
          onConfirm={(yards, operator) => commitAssignment({
            po: assignModal.po,
            machine: assignModal.machine,
            dayOfWeek: assignModal.day_of_week,
            yards,
            operator,
          })}
          busy={assigning}
        />
      )}
    </div>
  )
}

function BNYTopGauges({ totals }) {
  const yPct = Math.round((totals.yards / BNY_TARGETS.total_yards) * 100)
  const mixSch = totals.revenue > 0 ? totals.schumacher_revenue / totals.revenue : 0
  const mix3p  = totals.revenue > 0 ? totals.third_party_revenue / totals.revenue : 0
  const mixOnTarget = mixSch >= (MIX_TARGET_SCH - 0.10) && mixSch <= (MIX_TARGET_SCH + 0.10)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
      <YardsSplitGauge totals={totals} pct={yPct} />
      <Gauge label="Revenue" value={totals.revenue} target={null} pct={null} isMoney />
      <MixCard schPct={mixSch * 100} tpPct={mix3p * 100} onTarget={mixOnTarget} />
    </div>
  )
}

function YardsSplitGauge({ totals, pct }) {
  const col = pct >= 95 ? C.sage : pct >= 75 ? C.gold : pct >= 50 ? C.amber : C.rose
  const bklnPct = Math.round((totals.brooklyn_yards / BNY_TARGETS.brooklyn_yards) * 100)
  const pasPct  = Math.round((totals.passaic_yards / BNY_TARGETS.passaic_yards) * 100)
  return (
    <div style={{ background: C.navy, color: '#fff', border: `1px solid ${C.navy}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)', marginBottom: 6 }}>Yards · Total</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'Georgia,serif' }}>{fmt(totals.yards)}</span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>/ {fmt(BNY_TARGETS.total_yards)} yd</span>
      </div>
      <div style={{ height: 6, background: 'rgba(255,255,255,0.15)', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ width: Math.min(100, pct) + '%', height: '100%', background: col }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.85)' }}>
        <span>Brooklyn: <strong style={{ color: '#fff' }}>{fmt(totals.brooklyn_yards)}</strong> / {fmt(BNY_TARGETS.brooklyn_yards)} ({bklnPct}%)</span>
        <span>Passaic: <strong style={{ color: '#fff' }}>{fmt(totals.passaic_yards)}</strong> / {fmt(BNY_TARGETS.passaic_yards)} ({pasPct}%)</span>
      </div>
    </div>
  )
}

function Gauge({ label, value, target, pct, isMoney, highlight }) {
  const col = pct == null ? C.inkLight : pct >= 95 ? C.sage : pct >= 75 ? C.gold : pct >= 50 ? C.amber : C.rose
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
        {target != null && (
          <span style={{ fontSize: 11, color: subFg }}>/ {isMoney ? fmtK(target) : fmt(target)}</span>
        )}
      </div>
      {pct != null && (
        <>
          <div style={{ height: 6, background: highlight ? 'rgba(255,255,255,0.15)' : C.warm, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: Math.min(100, pct) + '%', height: '100%', background: col }} />
          </div>
          <div style={{ fontSize: 10, color: subFg, marginTop: 4 }}>{pct}% of target</div>
        </>
      )}
      {pct == null && target == null && (
        <div style={{ fontSize: 10, color: subFg, marginTop: 4, fontStyle: 'italic' }}>no target set</div>
      )}
    </div>
  )
}

function MixCard({ schPct, tpPct, onTarget }) {
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
      </div>
    </div>
  )
}

function BucketStrip({ totals }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
      {BNY_BUCKETS.map(b => (
        <BucketCard key={b} bucket={b} totals={totals} />
      ))}
    </div>
  )
}

function BucketCard({ bucket, totals }) {
  const curYd = totals.buckets[bucket] || 0
  const target = BNY_TARGETS.buckets[bucket]
  const pct = target ? Math.round((curYd / target) * 100) : null
  const col = BUCKET_COLOR[bucket]
  const orders = totals.buckets_orders[bucket] || 0
  const rev = totals.buckets_revenue[bucket] || 0
  const barColor = pct == null ? col : pct >= 95 ? C.sage : pct >= 75 ? C.gold : pct >= 50 ? C.amber : C.rose
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: col, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{bucket}</div>
      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'Georgia,serif', color: C.ink }}>
        {fmt(curYd)}
        {target != null && <span style={{ fontSize: 10, color: C.inkLight, fontWeight: 400 }}> / {fmt(target)}</span>}
      </div>
      <div style={{ height: 4, background: C.warm, borderRadius: 2, overflow: 'hidden', marginTop: 6, marginBottom: 4 }}>
        <div style={{ width: (pct == null ? 0 : Math.min(100, pct)) + '%', height: '100%', background: barColor }} />
      </div>
      <div style={{ fontSize: 9, color: C.inkLight, display: 'flex', justifyContent: 'space-between' }}>
        <span>{orders} order{orders !== 1 ? 's' : ''}</span>
        <span>{fmtK(rev)}</span>
      </div>
      {pct == null && target == null && (
        <div style={{ fontSize: 9, color: C.inkLight, fontStyle: 'italic', marginTop: 2 }}>no target</div>
      )}
    </div>
  )
}

function LocationSection({ locationKey, label, sublabel, machines, assignmentsByMachineDay, selectedPO, onCellClick, onRemoveAssignment, onOperatorChange, compact }) {
  return (
    <div style={{ marginTop: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: 0, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</h3>
        <span style={{ fontSize: 11, color: C.inkLight }}>— {machines.length} machines · {sublabel}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `110px 70px repeat(7, 1fr) 80px`, gap: 4, fontSize: 10, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 8px', marginBottom: 6 }}>
        <span>Machine</span>
        <span style={{ textAlign: 'right' }}>Budget/d</span>
        {DAY_LABELS.map(d => <span key={d} style={{ textAlign: 'center' }}>{d}</span>)}
        <span style={{ textAlign: 'right' }}>Week</span>
      </div>
      {machines.map(m => (
        <MachineRow
          key={m.name}
          machine={m}
          locationKey={locationKey}
          assignmentsByMachineDay={assignmentsByMachineDay}
          selectedPO={selectedPO}
          onCellClick={onCellClick}
          onRemoveAssignment={onRemoveAssignment}
          onOperatorChange={onOperatorChange}
          compact={compact}
        />
      ))}
    </div>
  )
}

function MachineRow({ machine, locationKey, assignmentsByMachineDay, selectedPO, onCellClick, onRemoveAssignment, onOperatorChange, compact }) {
  let weekTotal = 0
  for (let d = 0; d < NUM_DAYS; d++) {
    const cell = assignmentsByMachineDay[`${machine.name}|${d}`] || []
    weekTotal += cell.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
  }
  const weekCap = machine.capacity * NUM_DAYS
  const weekPct = Math.round((weekTotal / weekCap) * 100)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `110px 70px repeat(7, 1fr) 80px`, gap: 4, marginBottom: 4, alignItems: 'stretch' }}>
      <div style={{ background: C.parchment, borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{machine.name}</div>
        {machine.model && <div style={{ fontSize: 9, color: C.inkLight }}>HP {machine.model}</div>}
      </div>
      <div style={{ background: C.parchment, borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-end' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.inkMid }}>{machine.capacity}</div>
        <div style={{ fontSize: 9, color: C.inkLight }}>yd/day</div>
      </div>
      {DAY_LABELS.map((_, d) => (
        <MachineDayCell
          key={d}
          machine={machine}
          dayOfWeek={d}
          locationKey={locationKey}
          assignments={assignmentsByMachineDay[`${machine.name}|${d}`] || []}
          selectedPO={selectedPO}
          onClick={() => onCellClick(machine.name, d, locationKey)}
          onRemoveAssignment={onRemoveAssignment}
          onOperatorChange={onOperatorChange}
          compact={compact}
        />
      ))}
      <div style={{ background: weekPct > 100 ? C.roseBg : weekTotal > 0 ? C.goldBg : C.parchment, borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-end' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: weekPct > 100 ? C.rose : C.ink }}>{fmt(weekTotal)}</div>
        <div style={{ fontSize: 9, color: C.inkLight }}>{weekPct}% of {fmt(weekCap)}</div>
      </div>
    </div>
  )
}

function MachineDayCell({ machine, dayOfWeek, locationKey, assignments, selectedPO, onClick, onRemoveAssignment, onOperatorChange, compact }) {
  const cellYards = assignments.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
  const pct = Math.round((cellYards / machine.capacity) * 100)
  const over = pct > 110
  const canAssign = !!selectedPO
  const cellOperator = assignments[0]?.operator || ''
  const operatorList = BNY_OPERATORS[locationKey] || []

  return (
    <div
      onClick={(e) => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return
        if (e.target.dataset?.noclick) return
        if (canAssign) onClick()
      }}
      style={{
        background: '#fff',
        border: `${canAssign ? 2 : 1}px ${canAssign ? 'dashed' : 'solid'} ${canAssign ? C.amber : over ? C.rose : C.border}`,
        borderRadius: 6, padding: 6, minHeight: 110,
        cursor: canAssign ? 'pointer' : 'default',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
      <select
        value={cellOperator}
        onChange={(e) => onOperatorChange(machine.name, dayOfWeek, e.target.value)}
        disabled={assignments.length === 0}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', fontSize: 10, padding: '2px 3px', borderRadius: 3,
          border: `1px solid ${C.border}`, background: assignments.length === 0 ? C.warm : '#fff',
          color: cellOperator ? C.ink : C.inkLight, cursor: assignments.length === 0 ? 'not-allowed' : 'pointer',
        }}
      >
        <option value="">{assignments.length === 0 ? '—' : 'operator?'}</option>
        {operatorList.map(op => (
          <option key={op} value={op}>{op}</option>
        ))}
      </select>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 10 }}>
        <span style={{ fontWeight: 700, color: over ? C.rose : C.ink }}>{fmt(cellYards)}</span>
        <span style={{ color: over ? C.rose : C.inkLight }}>{pct}%</span>
      </div>
      <div style={{ height: 3, background: C.warm, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: Math.min(100, pct) + '%', height: '100%', background: over ? C.rose : pct > 80 ? C.gold : C.sage }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        {assignments.length === 0 && (
          <div style={{ fontSize: 9, color: C.inkLight, textAlign: 'center', padding: '4px 0', fontStyle: 'italic' }}>
            {canAssign ? 'Click' : 'Empty'}
          </div>
        )}
        {assignments.map(a => (
          <AssignmentChip key={a.id} a={a} onRemove={() => onRemoveAssignment(a.id)} />
        ))}
      </div>
    </div>
  )
}

function AssignmentChip({ a, onRemove }) {
  const col = a.bny_bucket ? BUCKET_COLOR[a.bny_bucket] : C.inkMid
  const bg = a.bny_bucket ? BUCKET_BG[a.bny_bucket] : C.parchment
  return (
    <div style={{ background: bg, borderLeft: `3px solid ${col}`, borderRadius: 3, padding: '3px 5px', fontSize: 9, position: 'relative', display: 'flex', alignItems: 'center', gap: 4 }}>
      {a.assigned_by === 'claude' && <span data-noclick="true" style={{ color: C.gold, fontWeight: 700 }}>✦</span>}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: C.ink }}>
        {a.line_description}
      </span>
      <span style={{ color: C.inkMid }}>{fmt(a.planned_yards)}y</span>
      <span data-noclick="true" onClick={(e) => { e.stopPropagation(); onRemove() }}
        style={{ cursor: 'pointer', color: C.inkLight, fontSize: 11, marginLeft: 2 }} title="Remove">×</span>
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

function AssignModalBNY({ po, machine, dayOfWeek, location, proposed, dailyCapacity, existingOnCell, onCancel, onConfirm, busy }) {
  const [yards, setYards] = useState(proposed)
  const [operator, setOperator] = useState(existingOnCell[0]?.operator || '')
  const alreadyOnCell = existingOnCell.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
  const remainingCap = Math.max(0, dailyCapacity - alreadyOnCell)
  const maxY = Math.min(po.remaining_yards, remainingCap)
  const overCap = yards > remainingCap
  const invalid = yards < 1 || yards > po.remaining_yards || overCap
  const operatorList = BNY_OPERATORS[location] || []

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 4 }}>
          Assign to {machine} · {DAY_LABELS[dayOfWeek]}
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif', marginBottom: 12 }}>{po.line_description}</div>
        <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 16 }}>
          PO {po.po_number} · {po.bny_bucket || po.product_type} · {po.colors_count || '—'} colors · {fmt(po.remaining_yards)} yards remaining
        </div>

        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginBottom: 4 }}>Yards for this machine-day</label>
        <input type="number" value={yards} onChange={e => setYards(parseInt(e.target.value) || 0)} min={1} max={po.remaining_yards}
          style={{ width: '100%', padding: '8px 12px', border: `1px solid ${overCap ? C.rose : C.border}`, borderRadius: 6, fontSize: 14, boxSizing: 'border-box', marginBottom: 8 }} />
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button onClick={() => setYards(maxY)} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>Fill cap ({fmt(maxY)})</button>
          <button onClick={() => setYards(Math.round(maxY / 2))} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>Half ({fmt(Math.round(maxY/2))})</button>
          <button onClick={() => setYards(po.remaining_yards)} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>All remaining ({fmt(po.remaining_yards)})</button>
        </div>

        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginBottom: 4 }}>Operator</label>
        <select value={operator} onChange={e => setOperator(e.target.value)}
          style={{ width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, boxSizing: 'border-box', marginBottom: 12, background: '#fff' }}>
          <option value="">— choose later —</option>
          {operatorList.map(op => <option key={op} value={op}>{op}</option>)}
        </select>

        <div style={{ padding: '10px 14px', background: overCap ? C.roseBg : C.goldBg, borderRadius: 6, marginBottom: 16, fontSize: 12, color: C.ink }}>
          Cell load after assign: <strong>{fmt(alreadyOnCell + yards)} / {fmt(dailyCapacity)} yd</strong>
          {overCap && <div style={{ fontSize: 11, color: C.rose, marginTop: 4, fontWeight: 600 }}>⚠ Over daily capacity — consider splitting across days or machines</div>}
          {yards < po.remaining_yards && !overCap && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 4 }}>Remaining {fmt(po.remaining_yards - yards)} yards stay in the pool.</div>}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, cursor: 'pointer', color: C.inkMid }}>Cancel</button>
          <button onClick={() => onConfirm(yards, operator)} disabled={invalid || busy}
            style={{ padding: '8px 16px', background: invalid || busy ? C.warm : C.ink, color: invalid || busy ? C.inkLight : '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: invalid || busy ? 'not-allowed' : 'pointer' }}>
            {busy ? 'Assigning…' : 'Confirm assignment'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// ASK CLAUDE PANEL — BNY streaming AI scheduler
// ═══════════════════════════════════════════════════════════════════════════
function AskClaudeBNYPanel({ onClose, weekStart, pool, assignments, mixTotals, onApplyAssignments }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState(null)
  const [applying, setApplying] = useState(false)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (messages.length === 0) generateOpening()
  }, [])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, streaming])

  function buildContextSummary() {
    const poolByBucket = {}
    for (const b of BNY_BUCKETS) poolByBucket[b] = pool.filter(p => p.bny_bucket === b).length
    return {
      week_of: isoDate(weekStart),
      targets: {
        brooklyn_yards: BNY_TARGETS.brooklyn_yards,
        passaic_yards: BNY_TARGETS.passaic_yards,
        total_yards: BNY_TARGETS.total_yards,
        buckets: BNY_TARGETS.buckets,
      },
      current_assignments: assignments.length,
      current_totals: {
        yards: Math.round(mixTotals.yards),
        brooklyn_yards: Math.round(mixTotals.brooklyn_yards),
        passaic_yards: Math.round(mixTotals.passaic_yards),
        revenue: Math.round(mixTotals.revenue),
        by_bucket: Object.fromEntries(BNY_BUCKETS.map(b => [b, Math.round(mixTotals.buckets[b] || 0)])),
      },
      pool_summary: {
        total: pool.length,
        by_bucket: poolByBucket,
        high_color: pool.filter(p => (p.colors_count || 0) >= HIGH_COLOR_THRESHOLD).length,
        aged_90plus: pool.filter(p => (p.age_days || 0) > 90).length,
        aged_180plus: pool.filter(p => (p.age_days || 0) > 180).length,
        total_yards_available: pool.reduce((s, p) => s + Number(p.remaining_yards || 0), 0),
        total_revenue_available: pool.reduce((s, p) => s + Number(p.income_written || 0), 0),
      },
    }
  }

  const SYSTEM_PROMPT = `You are Claude, acting as a production scheduling advisor for Peter Webster at Paramount Prints — the specialty printing division of F. Schumacher & Co. You're working with Chandler, the BNY production manager. BNY covers digital printing across two physical locations (Brooklyn NY plant + a bank of small digitals in Passaic NJ), all budgeting to one cost center.

BNY PLANT STRUCTURE:
- Brooklyn (7 machines):
  · 3× HP 3600: Glow, Sasha, Trish — 600 yd/day each
  · 4× HP 570: Bianca, LASH, Chyna, Rhonda — 500 yd/day each
  · Weekly Brooklyn target: 10,000 yards
- Passaic small digitals (12 machines, all budget to BNY):
  · Dakota Ka, Dementia, EMBER, Ivy Nile, Jacy Jayne, Ruby, Valhalla, XIA, Apollo, Nemesis, Poseidon, Zoey — 500 yd/day each
  · Weekly Passaic target: 5,000 yards
- GRAND TOTAL weekly yards target: 15,000

OPERATORS:
- Brooklyn: Shelby Adams, Ramon Bermudez, Blake Devine-Rosser, Sara Howard, Susan Jean-Baptiste, Philip Keefer, Brynn Lawlor, Adam McClellan, John O'Connor, Sydney Remson, Denzell Silvia, Xiachen Zhou.
- Passaic digital: Joseph Horton, Luis Mendoza Capecchi, Jeanne Villeneuve.

THE MIX IS THE SCHEDULE — BNY framework (different from Passaic's Schumacher/3P view):
- Replen (target 7,885 yd/wk): F. Schumacher HUB warehouse replenishment — the main production flow, biggest bucket.
- NEW GOODS (no target set yet, track it separately): F. Schumacher NEW GOODS customer — first-time production of new patterns.
- MTO (target 1,280 yd/wk): F. Schumacher custom Made-to-Order.
- HOS (target 210 yd/wk): Hospitality — F. SCHUMACHER & CO - HOSPITALITY customer.
- Memo (target 1,535 yd/wk): Small sample orders for Schumacher Memos.
- 3P (target 1,090 yd/wk): Third-party customers (Carleton V, E.W. Bredemeier, etc.). Higher margin — profit engine.

KEY DIFFERENCES FROM PASSAIC:
- Digital prints ALL colors in one pass — color-yards is NOT a metric here. Ignore Angel's color-complexity rule.
- No category routing — any PO can go on any machine within its location, subject to machine capacity.
- Assignments are per day (Mon=0 through Fri=4), not per week.
- Staffing: operators are assigned per machine-day.

SCHEDULING LOGIC (machine-by-machine defaults — follow these unless Chandler tells you otherwise):

Brooklyn 3600s — Glow, Sasha, Trish (600 yd/day):
These are the workhorses. Prioritize big aged Replen and NEW GOODS runs here. Large run sizes benefit from the 3600's speed. Do NOT load MTO on 3600s unless Passaic is already full.

Brooklyn 570s — Bianca, LASH, Chyna, Rhonda (500 yd/day):
Medium Replen, NEW GOODS, and HOS fit well. Also a good overflow lane if MTO/Memo exceeds Passaic capacity. Weekdays only — do NOT propose weekend work here.

Passaic digital fleet (12 machines, 500 yd/day each): THIS IS THE MTO LANE.
Strict bucket priority: MTO first → Memo second → Replen last. MTO orders are out of stock at the F. Schumacher HUB warehouse and need to ship within 48 hours. NEVER schedule Replen on Passaic while there is unfilled MTO in the pool. If MTO + Memo doesn't fill Passaic's 5,000 yd/week, THEN backfill with Replen. Weekdays only — do NOT propose weekend work on any Passaic machine.

Weekend shifts (day_of_week 0 = Sun, day_of_week 6 = Sat):
Brooklyn 3600s ONLY by default. Do not propose weekend assignments on 570s or on any Passaic digital. The UI allows manual weekend assignment on other machines, but that's Chandler's call — your draft uses 3600s only for Sat/Sun. Use weekend 3600 capacity for the biggest aged Replen/NEW GOODS runs.

Universal rules across all machines:
- FIFO: aged POs (90+ days, and especially 180+ days) go first within each bucket.
- Stay under 95% of daily capacity — leave headroom for setup and changeovers.
- Split POs across days when their yards exceed a single day's capacity.

YOUR ROLE:
Thinking partner for Chandler, not commander. Chandler owns decisions. Propose a starting draft he can react to. Speak warmly, directly, peer-to-peer. Use his name. Reference specific POs, machines, and days.

PROPOSAL FORMAT (critical — read carefully):
When ready to commit to a draft, include a narrative explanation AND a JSON code block. The JSON MUST be wrapped in triple-backtick json fences exactly like this:

\`\`\`json
{"proposals":[{"po_number":"PO12345","machine":"Glow","day_of_week":0,"planned_yards":600,"rationale":"FIFO 145d"}]}
\`\`\`

Field rules:
- day_of_week: integer 0-6 (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat). Must be a NUMBER, not a string. The fiscal week starts Sunday and ends Saturday — you can schedule any day.
- machine: exact name as listed above (case-sensitive).
- planned_yards: integer.
- rationale: OPTIONAL and MUST be 6 words or fewer (e.g. "FIFO 145d", "Memo 32d — Quansoo", "aged MTO"). Put detailed reasoning in your prose narrative ABOVE the JSON block, never inside the JSON itself. Long rationales waste output tokens and can truncate the draft mid-proposal.
- DO NOT include an "operator" field. Staffing is Chandler's decision, not yours.
- Top-level object must be {"proposals": [...]}. Do not emit bare objects or arrays.
- ALWAYS wrap the JSON in \`\`\`json fences. Without fences the frontend cannot extract your proposals — emit the fences even if your reply is long.

DAILY CAPACITY (hard rule — read carefully):
Daily capacity is a SUM across ALL proposals for a single (machine, day_of_week) pair, not a per-proposal limit.
- Glow / Sasha / Trish (HP 3600): 600 yd TOTAL per day.
- All other machines (HP 570s + every Passaic digital): 500 yd TOTAL per day.

Worked example — Glow is 600/day:
- You may propose ONE 600 yd assignment on Glow Mon. ✓
- You may propose two 300 yd assignments on Glow Mon (sum = 600). ✓
- You may propose 400 + 200 on Glow Mon (sum = 600). ✓
- You may NOT propose 400 + 300 on Glow Mon (sum = 700). ✗ Move the 300 to Glow Tue, or to another machine's Monday.
- You may NOT propose 600 + anything else on Glow Mon. ✗ That day is already full.

Before writing each proposal, mentally sum all previous proposals for the same (machine, day_of_week). If adding the new one would push the sum past 600 (3600s) or 500 (others), put it on another day or another machine instead.

Split POs whose yards exceed a single day's capacity across multiple machine-days. A 1,500 yd Replen on Glow takes three days: Mon 600 + Tue 600 + Wed 300.`

  async function generateOpening() {
    setStreaming(true); setError(null)
    const context = buildContextSummary()
    const userMsg = `It's Monday morning. Chandler is opening the BNY scheduler to plan the week of ${isoDate(weekStart)}. The board is currently ${context.current_assignments === 0 ? 'empty' : `partially filled with ${context.current_assignments} assignments`}.

CURRENT STATE:
${JSON.stringify(context, null, 2)}

Your task right now: write an opening message to Chandler (max ~180 words). Include:
1. A warm greeting by name
2. A quick read of the state — how much WIP is schedulable, how the buckets look, how aged
3. Your initial read on this week's strategy in 2-3 sentences
4. End by asking if there's anything you should know before drafting — rush orders, crew changes, machines down, HTI priorities

Don't draft a schedule yet. Just open the conversation.

Tone: peer-to-peer, warm but direct. No headers, no bullet points — prose paragraph(s).`

    try {
      await streamClaude([{ role: 'user', content: userMsg }], (finalText) => {
        setMessages([{ role: 'assistant', content: finalText }])
      })
    } catch (e) {
      console.error(e); setError(e.message || String(e))
    } finally {
      setStreaming(false)
    }
  }

  async function sendMessage(userText) {
    if (!userText.trim() || streaming) return
    const newMessages = [...messages, { role: 'user', content: userText }]
    setMessages(newMessages); setInput(''); setStreaming(true); setError(null)

    const context = buildContextSummary()
    const convo = newMessages.map(m => ({ role: m.role, content: m.content }))

    // Bucket-balanced pool sampling. Top N per bucket by age, then concatenated
    // in PRIORITY order (MTO first) so Opus sees urgent work before aged backlog.
    // Prevents MTO/Memo from being crowded out of the context when aged Replen dominates.
    const BUCKET_CAPS = { 'MTO': 60, 'Memo': 40, 'HOS': 20, '3P': 20, 'NEW GOODS': 40, 'Replen': 80 }
    const BUCKET_PRIORITY = ['MTO', 'Memo', 'HOS', '3P', 'NEW GOODS', 'Replen']
    const byBucket = Object.fromEntries(BNY_BUCKETS.map(b => [b, []]))
    for (const p of pool) {
      if (p.bny_bucket && byBucket[p.bny_bucket]) byBucket[p.bny_bucket].push(p)
    }
    for (const b of BNY_BUCKETS) {
      byBucket[b].sort((x, y) => (y.age_days || 0) - (x.age_days || 0))
    }
    const sampledPool = []
    for (const b of BUCKET_PRIORITY) {
      const cap = BUCKET_CAPS[b] || 30
      sampledPool.push(...byBucket[b].slice(0, cap))
    }
    const poolLines = sampledPool.map(p =>
      `  ${p.po_number} | ${p.line_description} | ${p.bny_bucket} | ${p.colors_count||'?'}c | ${p.remaining_yards}yd | ${p.age_days}d | $${Math.round(p.income_written||0)}`
    ).join('\n')
    const poolCountsLine = BUCKET_PRIORITY.map(b =>
      `${b}: ${byBucket[b].length} total${byBucket[b].length > (BUCKET_CAPS[b]||30) ? ` (showing top ${BUCKET_CAPS[b]||30} by age)` : ''}`
    ).join(' · ')

    const contextNote = `\n\n[CURRENT STATE — not from user, for your context:
${JSON.stringify(context, null, 2)}

POOL (ordered by bucket priority — MTO first, then Memo, HOS, 3P, NEW GOODS, Replen; within each bucket sorted by age descending)
Pool counts by bucket: ${poolCountsLine}
${poolLines}

CRITICAL REMINDERS when proposing assignments:
- Machine names must match EXACTLY: Glow / Sasha / Trish / Bianca / LASH / Chyna / Rhonda (Brooklyn); Dakota Ka / Dementia / EMBER / Ivy Nile / Jacy Jayne / Ruby / Valhalla / XIA / Apollo / Nemesis / Poseidon / Zoey (Passaic BNY).
- day_of_week MUST be a number 0-6 (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat). Not a string.
- DAILY CAPACITY IS A HARD SUM, NOT A PER-PROPOSAL LIMIT. Total yards across ALL proposals for a single (machine, day_of_week) cannot exceed 600 on 3600s (Glow/Sasha/Trish) or 500 on all other machines. If Glow Mon already has 400 proposed, you can add at most 200 more to Glow Mon — not another 400. Track this as you write each proposal.
- DO NOT include an operator field. Chandler staffs machines himself.

MACHINE-FAMILY PRIORITY (this is how Chandler actually runs BNY):
- Passaic digitals (Dakota Ka, Dementia, EMBER, Ivy Nile, Jacy Jayne, Ruby, Valhalla, XIA, Apollo, Nemesis, Poseidon, Zoey) = the MTO lane. Bucket order: MTO → Memo → Replen. NEVER load Replen onto a Passaic digital while MTO remains unscheduled in the pool (MTOs are out-of-stock at the HUB and need 48-hour turns). Backfill with Memo, then Replen only if MTO and Memo don't fill the 5,000 yd/week target.

MANDATORY CHECKLIST before writing ANY proposal for a Passaic machine:
1. Look at the Pool counts above. How many MTO POs are there?
2. If MTO count > 0: your Passaic proposal MUST be an MTO PO. Not Memo. Not Replen. MTO.
3. If MTO count = 0 (all MTO already scheduled this draft): then Memo is next.
4. If MTO = 0 and Memo = 0: then and only then, Replen.
5. Work through MTO POs in age-descending order (oldest first).
If you catch yourself proposing a Replen or NEW GOODS assignment on a Passaic machine while MTO is non-zero, stop, reconsider, and replace it with MTO.
- Brooklyn 3600s (Glow, Sasha, Trish) = workhorses for big aged Replen and NEW GOODS runs. Don't load MTO here unless Passaic is already full.
- Brooklyn 570s (Bianca, LASH, Chyna, Rhonda) = medium Replen, NEW GOODS, HOS. Also the overflow lane if MTO/Memo exceeds Passaic capacity.
- Weekends (day_of_week = 0 Sun or 6 Sat): Brooklyn 3600s ONLY by default. Do NOT propose Sat/Sun assignments on 570s or any Passaic digital. The UI allows manual weekend overrides, but your draft stays on the 3600s.

When you are ready to commit to a draft, wrap the JSON in TRIPLE-BACKTICK fences exactly like this:

\`\`\`json
{"proposals":[{"po_number":"PO12345","machine":"Glow","day_of_week":0,"planned_yards":600,"rationale":"..."}]}
\`\`\`

- The outer object must be {"proposals": [...]}. Do not emit a bare array or loose objects.
- If you don't include the fenced JSON block, the frontend cannot apply the proposals — Chandler will just see your narrative.
]`
    convo[convo.length - 1].content += contextNote

    try {
      await streamClaude(convo, (finalText, proposals) => {
        setMessages(prev => [...prev, { role: 'assistant', content: finalText, proposals }])
      })
    } catch (e) {
      console.error(e); setError(e.message || String(e))
    } finally {
      setStreaming(false)
    }
  }

  async function streamClaude(msgs, onComplete) {
    const response = await fetch('/api/claude-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: msgs,
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
              setMessages(prev => {
                const copy = [...prev]
                copy[copy.length - 1] = { role: 'assistant', content: fullText, streaming: true }
                return copy
              })
            }
          } catch { /* partial JSON, ignore */ }
        }
      }
    }

    const proposals = extractProposals(fullText)
    setMessages(prev => {
      const copy = [...prev]
      copy[copy.length - 1] = { role: 'assistant', content: fullText, proposals, streaming: false }
      return copy
    })
    if (onComplete) onComplete(fullText, proposals)
  }

  function extractProposals(text) {
    // Strategy 1: fenced ```json ... ``` block (preferred)
    // Strategy 2: fenced ``` ... ``` without "json" tag
    // Strategy 3: bare {"proposals": [...]} anywhere in the text
    const candidates = []
    const fencedJson = text.match(/```json\s*([\s\S]*?)\s*```/i)
    if (fencedJson) candidates.push(fencedJson[1])
    const fenced = text.match(/```\s*(\{[\s\S]*?\})\s*```/)
    if (fenced) candidates.push(fenced[1])
    const bareObj = text.match(/(\{\s*"proposals"\s*:\s*\[[\s\S]*?\]\s*\})/)
    if (bareObj) candidates.push(bareObj[1])

    for (const candidate of candidates) {
      try {
        const obj = JSON.parse(candidate)
        if (!Array.isArray(obj.proposals) || obj.proposals.length === 0) continue
        // Coerce then validate — Opus sometimes emits "0" (string) or 0.0 (float)
        const coerced = obj.proposals.map(p => ({
          ...p,
          day_of_week: Number(p.day_of_week),
          planned_yards: Number(p.planned_yards),
        }))
        const valid = coerced.filter(p =>
          p.po_number && p.machine &&
          Number.isInteger(p.day_of_week) && p.day_of_week >= 0 && p.day_of_week <= 6 &&
          Number.isFinite(p.planned_yards) && p.planned_yards > 0
        )
        if (valid.length > 0) return valid
      } catch { /* try next strategy */ }
    }
    return null
  }

  async function applyProposals(proposals) {
    if (!proposals || proposals.length === 0) return
    if (!confirm(`Apply Claude's ${proposals.length} proposed assignments to the board?`)) return
    setApplying(true)
    try {
      const result = await onApplyAssignments(proposals)
      const acc = result?.accepted ?? proposals.length
      const skp = result?.skipped ?? 0
      let msg = `✓ Applied ${acc} assignment${acc !== 1 ? 's' : ''} to the board.`
      if (skp > 0) {
        const firstFew = (result.skippedDetails || []).slice(0, 3)
          .map(s => `${s.p.po_number} → ${s.reason}`)
          .join('; ')
        msg += ` Skipped ${skp} that would exceed daily capacity${firstFew ? ` (${firstFew}${result.skippedDetails.length > 3 ? '…' : ''})` : ''}.`
      }
      setMessages(prev => [...prev, { role: 'system', content: msg }])
    } catch (e) {
      alert('Failed to apply: ' + (e.message || e))
    } finally {
      setApplying(false)
    }
  }

  const quickChips = [
    { label: 'Draft a full schedule', text: "Go ahead and draft a full schedule for this week at BNY. Nothing special to flag — work with what's in the pool." },
    { label: 'Rush orders', text: "We have a rush order I need to fit in this week:" },
    { label: 'Crew changes', text: "Heads up on crew this week:" },
    { label: 'Machine down', text: "Heads up — this machine is down this week:" },
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
      <div style={{ padding: '12px 16px', background: C.amber, color: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 18 }}>✦</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'Georgia,serif' }}>Ask Claude · BNY Scheduling</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>Opus 4.7 · Week of {weekLabelFiscal(weekStart)}</div>
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
        <div style={{ background: C.amber, color: '#fff', borderRadius: '10px 10px 2px 10px', padding: '8px 12px', maxWidth: '85%', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {message.content}
        </div>
      </div>
    )
  }
  const text = message.content || ''
  // Strip JSON from displayed text so it doesn't render into the message bubble.
  // We strip all three shapes Opus emits: fenced with json tag, fenced without,
  // and bare — even mid-stream (open but not yet closed).
  const displayText = text
    .replace(/```json\s*[\s\S]*?```/gi, '')   // fenced ```json ... ```
    .replace(/```[\s\S]*?```/g, '')            // any other fenced code block
    .replace(/\{\s*"proposals"\s*:[\s\S]*$/i, '')  // bare {"proposals":...} open to end
    .trim()
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px 10px 10px 2px', padding: '10px 14px', fontSize: 12, lineHeight: 1.6, color: C.ink, whiteSpace: 'pre-wrap', fontFamily: 'Georgia,serif' }}>
        {displayText}
        {message.streaming && <span style={{ display: 'inline-block', width: 6, height: 12, background: C.inkMid, marginLeft: 3, animation: 'blink 1s infinite' }} />}
      </div>
      {message.proposals && message.proposals.length > 0 && !message.streaming && (
        <div style={{ marginTop: 8, padding: '10px 12px', background: C.goldBg, border: `1px solid ${C.gold}`, borderRadius: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.ink, marginBottom: 6 }}>
            ✦ Claude proposed {message.proposals.length} assignment{message.proposals.length !== 1 ? 's' : ''}
          </div>
          <div style={{ fontSize: 10, color: C.inkMid, marginBottom: 8, maxHeight: 100, overflowY: 'auto' }}>
            {message.proposals.slice(0, 8).map((p, i) => (
              <div key={i}>→ {p.machine} {DAY_LABELS[p.day_of_week] || `d${p.day_of_week}`}: {p.po_number} · {fmt(p.planned_yards)}yd{p.operator ? ` · ${p.operator}` : ''}</div>
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
