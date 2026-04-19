import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'
import {
  C, fmt, fmtD, isoDate, mondayOf, addDays, addWeeks,
  weekLabel, weekLabelFiscal, defaultSchedulerWeek,
  DAY_NAMES_SHORT, DAY_NAMES_FULL, dayOfWeekFiscal, dateForDayOfWeek,
  PASSAIC_OPERATORS, BNY_OPERATORS_BROOKLYN, BNY_OPERATORS_PASSAIC_DIGITAL,
} from '../lib/scheduleUtils'
import { loadWeekDailyOps, upsertDailyOp } from '../lib/dailyOps'

// Passaic table list (mirrors PassaicScheduler — kept here to avoid circular import)
const PASSAIC_TABLES = [
  { code: 'GC-1',   category: 'grass',     label: 'Grasscloth 1' },
  { code: 'GC-2',   category: 'grass',     label: 'Grasscloth 2' },
  { code: 'FAB-3',  category: 'fabric',    label: 'Fabric 3' },
  { code: 'FAB-4',  category: 'fabric',    label: 'Fabric 4' },
  { code: 'FAB-5',  category: 'fabric',    label: 'Fabric 5' },
  { code: 'FAB-6',  category: 'fabric',    label: 'Fabric 6' },
  { code: 'FAB-7',  category: 'fabric',    label: 'Fabric 7' },
  { code: 'FAB-8',  category: 'fabric',    label: 'Fabric 8' },
  { code: 'FAB-9',  category: 'fabric',    label: 'Fabric 9' },
  { code: 'FAB-10', category: 'fabric',    label: 'Fabric 10' },
  { code: 'FAB-11', category: 'fabric',    label: 'Fabric 11' },
  { code: 'WP-12',  category: 'wallpaper', label: 'Wallpaper 12' },
  { code: 'WP-13',  category: 'wallpaper', label: 'Wallpaper 13' },
  { code: 'WP-14',  category: 'wallpaper', label: 'Wallpaper 14' },
  { code: 'WP-15',  category: 'wallpaper', label: 'Wallpaper 15' },
  { code: 'WP-16',  category: 'wallpaper', label: 'Wallpaper 16' },
  { code: 'WP-17',  category: 'wallpaper', label: 'Wallpaper 17' },
]

// BNY machine list (mirrors BNYScheduler)
const BNY_BROOKLYN = [
  { code: 'Glow',   model: '3600', capacity: 600 },
  { code: 'Sasha',  model: '3600', capacity: 600 },
  { code: 'Trish',  model: '3600', capacity: 600 },
  { code: 'Bianca', model: '570',  capacity: 500 },
  { code: 'LASH',   model: '570',  capacity: 500 },
  { code: 'Chyna',  model: '570',  capacity: 500 },
  { code: 'Rhonda', model: '570',  capacity: 500 },
]
const BNY_PASSAIC_DIGITAL = [
  { code: 'Dakota Ka', capacity: 500 }, { code: 'Dementia', capacity: 500 },
  { code: 'EMBER', capacity: 500 }, { code: 'Ivy Nile', capacity: 500 },
  { code: 'Jacy Jayne', capacity: 500 }, { code: 'Ruby', capacity: 500 },
  { code: 'Valhalla', capacity: 500 }, { code: 'XIA', capacity: 500 },
  { code: 'Apollo', capacity: 500 }, { code: 'Nemesis', capacity: 500 },
  { code: 'Poseidon', capacity: 500 }, { code: 'Zoey', capacity: 500 },
]

// ═══════════════════════════════════════════════════════════════════════════
// LiveOpsTab — daily actuals entry for Passaic (Sami) and BNY (Chandler)
// ═══════════════════════════════════════════════════════════════════════════
export default function LiveOpsTab() {
  const [site, setSite] = useState('passaic')
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date(); d.setHours(0,0,0,0); return d
  })
  const [dailyOps, setDailyOps] = useState([])
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(false)

  // Week that contains the selected date (Monday-anchored, per existing convention)
  const weekStart = useMemo(() => mondayOf(selectedDate), [selectedDate])
  const dayOfWeek = useMemo(() => dayOfWeekFiscal(weekStart, selectedDate), [weekStart, selectedDate])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const ops = await loadWeekDailyOps(site, weekStart)
        const { data: asn } = await supabase
          .from('sched_assignments')
          .select('*')
          .eq('site', site)
          .eq('week_start', isoDate(weekStart))
        if (cancelled) return
        setDailyOps(ops || [])
        setAssignments(asn || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [site, weekStart])

  const tables = site === 'passaic'
    ? PASSAIC_TABLES
    : [...BNY_BROOKLYN, ...BNY_PASSAIC_DIGITAL]

  // For each table, find the daily_ops row for the selected day (if any),
  // and summarize planned yards for that table (weekly for Passaic since
  // sched_assignments.day_of_week is null; daily for BNY).
  const rowsForTable = useMemo(() => {
    const m = {}
    for (const t of tables) {
      const op = dailyOps.find(r =>
        r.table_code === t.code && r.day_of_week === dayOfWeek
      ) || null

      let plannedYards = 0
      let plannedDetails = []
      if (site === 'passaic') {
        // Passaic: daily target comes from sched_daily_ops.planned_yards
        // (Wendy's per-day target set in the Daily Plan modal).
        plannedYards = Number(op?.planned_yards || 0)
        // Show the POs assigned to this table as context (weekly, since Passaic
        // doesn't commit POs to specific days — just overall pacing).
        const onTable = assignments.filter(a => a.table_code === t.code)
        plannedDetails = onTable.map(a => a.line_description || a.po_number)
      } else {
        // BNY: day-specific
        const onCell = assignments.filter(a =>
          a.table_code === t.code && a.day_of_week === dayOfWeek
        )
        plannedYards = onCell.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
        plannedDetails = onCell.map(a => a.line_description || a.po_number)
      }

      m[t.code] = { op, plannedYards, plannedDetails }
    }
    return m
  }, [tables, dailyOps, assignments, dayOfWeek, site])

  function navigateDay(deltaDays) {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + deltaDays)
    setSelectedDate(d)
  }

  async function saveRow(tableCode, patch) {
    const existing = rowsForTable[tableCode]?.op || {}
    const row = {
      site,
      week_start: isoDate(weekStart),
      table_code: tableCode,
      day_of_week: dayOfWeek,
      ...existing,
      ...patch,
    }
    // Strip non-column fields if existing was fetched
    delete row.id; delete row.created_at; delete row.updated_at
    try {
      await upsertDailyOp(row)
      // Optimistic local update
      setDailyOps(prev => {
        const idx = prev.findIndex(r =>
          r.table_code === tableCode && r.day_of_week === dayOfWeek
        )
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], ...patch }
          return next
        }
        return [...prev, { ...row }]
      })
    } catch (e) {
      alert('Save failed: ' + (e.message || e))
    }
  }

  const today = new Date(); today.setHours(0,0,0,0)
  const isToday = selectedDate.getTime() === today.getTime()
  const isFuture = selectedDate.getTime() > today.getTime()
  const dayLabel = dayOfWeek == null ? '—' : DAY_NAMES_FULL[dayOfWeek]
  const dateLabel = selectedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

  const categorize = (t) => {
    if (site !== 'passaic') return t.code.startsWith('Glow') || t.code.startsWith('Sasha') || t.code.startsWith('Trish') ? 'bny-brooklyn-3600' : null
    return t.category
  }

  return (
    <div style={{ padding: 20, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif', margin: 0, marginBottom: 4 }}>
          Live Ops — Daily Actuals
        </h2>
        <div style={{ fontSize: 13, color: C.inkMid }}>
          End-of-shift entry for what actually happened. Yards produced, waste, who was on the table, and any notes worth remembering.
        </div>
      </div>

      {/* Site toggle + date navigator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, padding: '12px 16px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <SiteChip active={site === 'passaic'} onClick={() => setSite('passaic')} color={C.navy}>
            Passaic · Screen Print
          </SiteChip>
          <SiteChip active={site === 'bny'} onClick={() => setSite('bny')} color={C.amber}>
            BNY · Digital
          </SiteChip>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => navigateDay(-1)}
          style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.inkMid }}>
          ← Prev day
        </button>
        <div style={{ textAlign: 'center', minWidth: 180 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>{dayLabel}</div>
          <div style={{ fontSize: 11, color: C.inkLight }}>
            {dateLabel}{isToday ? ' · today' : isFuture ? ' · future' : ''}
          </div>
        </div>
        <button onClick={() => setSelectedDate(today)}
          style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>
          Today
        </button>
        <button onClick={() => navigateDay(1)}
          style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.inkMid }}>
          Next day →
        </button>
      </div>

      {isFuture && (
        <div style={{ background: C.amberBg, border: `1px solid ${C.amber}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: C.amber, fontWeight: 600 }}>
          This date is in the future. You can still pre-fill crew staffing here if you want, but actual yards and waste can't be entered until the shift happens.
        </div>
      )}

      {loading && (
        <div style={{ padding: 40, textAlign: 'center', color: C.inkLight, fontSize: 13 }}>Loading…</div>
      )}

      {!loading && (
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {tables.map((t, i) => {
            const row = rowsForTable[t.code]
            const cat = categorize(t)
            const catLabel = cat === 'grass' ? 'Grasscloth' : cat === 'fabric' ? 'Fabric' : cat === 'wallpaper' ? 'Wallpaper' : null
            const showCategoryHeader = site === 'passaic' && (i === 0 || categorize(tables[i - 1]) !== cat)

            return (
              <div key={t.code}>
                {showCategoryHeader && (
                  <div style={{ padding: '8px 16px', background: C.parchment, borderBottom: `1px solid ${C.border}`, borderTop: i === 0 ? 'none' : `1px solid ${C.border}`, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight }}>
                    {catLabel}
                  </div>
                )}
                <OpsRow
                  table={t}
                  site={site}
                  plannedYards={row?.plannedYards || 0}
                  plannedDetails={row?.plannedDetails || []}
                  op={row?.op}
                  canEnterActuals={!isFuture}
                  onSave={(patch) => saveRow(t.code, patch)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SiteChip({ active, onClick, color, children }) {
  return (
    <button onClick={onClick}
      style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: `1px solid ${active ? color : C.border}`, background: active ? color : 'transparent', color: active ? '#fff' : C.inkMid }}>
      {children}
    </button>
  )
}

function OpsRow({ table, site, plannedYards, plannedDetails, op, canEnterActuals, onSave }) {
  const [yards, setYards]   = useState(op?.actual_yards ?? '')
  const [waste, setWaste]   = useState(op?.waste_yards ?? '')
  const [op1, setOp1]       = useState(op?.operator_1 ?? '')
  const [op2, setOp2]       = useState(op?.operator_2 ?? '')
  const [notes, setNotes]   = useState(op?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)

  // Reset fields when the underlying row changes (user navigates day/site)
  useEffect(() => {
    setYards(op?.actual_yards ?? '')
    setWaste(op?.waste_yards ?? '')
    setOp1(op?.operator_1 ?? '')
    setOp2(op?.operator_2 ?? '')
    setNotes(op?.notes ?? '')
    setSavedAt(null)
  }, [op?.id, op?.actual_yards, op?.waste_yards, op?.operator_1, op?.operator_2, op?.notes])

  async function handleSave() {
    setSaving(true)
    const patch = {
      operator_1: op1 || null,
      operator_2: op2 || null,
      actual_yards: yards === '' ? null : Number(yards),
      waste_yards: waste === '' ? null : Number(waste),
      notes: notes || null,
    }
    await onSave(patch)
    setSaving(false)
    setSavedAt(Date.now())
  }

  const operatorList = site === 'passaic'
    ? PASSAIC_OPERATORS
    : (BNY_BROOKLYN.some(m => m.code === table.code) ? BNY_OPERATORS_BROOKLYN : BNY_OPERATORS_PASSAIC_DIGITAL)

  const actual = yards === '' ? null : Number(yards)
  const variance = actual != null ? actual - plannedYards : null
  const varianceColor = variance == null ? C.inkLight
    : Math.abs(variance) < 50 ? C.sage
    : variance > 0 ? C.gold : C.rose
  const varianceLabel = variance == null ? '—'
    : variance === 0 ? 'on plan'
    : (variance > 0 ? '+' : '') + fmt(variance) + ' vs plan'

  return (
    <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '200px 1fr 130px 130px 1fr 1fr 2fr 100px', gap: 12, alignItems: 'start' }}>
      {/* Table label */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{table.label || table.code}</div>
        <div style={{ fontSize: 10, color: C.inkLight }}>
          {site === 'passaic' ? "day's target" : `${table.capacity} yd/day cap`}
        </div>
      </div>

      {/* Planned summary */}
      <div style={{ fontSize: 11, color: C.inkMid }}>
        <div style={{ fontWeight: 600, color: C.ink, marginBottom: 2 }}>
          {plannedYards > 0
            ? `${fmt(plannedYards)} yd target`
            : <span style={{ color: C.inkLight, fontStyle: 'italic' }}>no target set</span>}
        </div>
        {plannedDetails.length > 0 && (
          <div style={{ fontSize: 10, color: C.inkLight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {plannedDetails.slice(0, 3).join(', ')}{plannedDetails.length > 3 ? `, +${plannedDetails.length - 3}` : ''}
          </div>
        )}
      </div>

      {/* Actual yards */}
      <div>
        <label style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Actual yds</label>
        <input type="number" value={yards} onChange={e => setYards(e.target.value)} disabled={!canEnterActuals}
          placeholder="—"
          style={{ width: '100%', padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13, boxSizing: 'border-box', background: canEnterActuals ? '#fff' : C.warm }} />
        <div style={{ fontSize: 9, color: varianceColor, fontWeight: 600, marginTop: 3 }}>{varianceLabel}</div>
      </div>

      {/* Waste */}
      <div>
        <label style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Waste yds</label>
        <input type="number" value={waste} onChange={e => setWaste(e.target.value)} disabled={!canEnterActuals}
          placeholder="0"
          style={{ width: '100%', padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13, boxSizing: 'border-box', background: canEnterActuals ? '#fff' : C.warm }} />
      </div>

      {/* Operator 1 */}
      <div>
        <label style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Operator 1</label>
        <select value={op1} onChange={e => setOp1(e.target.value)}
          style={{ width: '100%', padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, background: '#fff', boxSizing: 'border-box' }}>
          <option value="">— pick —</option>
          {operatorList.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {/* Operator 2 */}
      <div>
        <label style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Operator 2</label>
        <select value={op2} onChange={e => setOp2(e.target.value)}
          style={{ width: '100%', padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, background: '#fff', boxSizing: 'border-box' }}>
          <option value="">— pick —</option>
          {operatorList.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {/* Notes */}
      <div>
        <label style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          placeholder="Registration issues, color mix problems, anything worth remembering…"
          style={{ width: '100%', padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
      </div>

      {/* Save */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
        <button onClick={handleSave} disabled={saving}
          style={{ padding: '8px 12px', background: saving ? C.warm : C.ink, color: saving ? C.inkLight : '#fff', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && (
          <div style={{ fontSize: 9, color: C.sage, textAlign: 'center', fontWeight: 600 }}>✓ saved</div>
        )}
      </div>
    </div>
  )
}
