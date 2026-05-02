import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import {
  C, fmt, fmtD, isoDate, mondayOf, addDays, addWeeks,
  weekLabel, weekLabelFiscal, defaultSchedulerWeek,
  DAY_NAMES_SHORT, DAY_NAMES_FULL, DAY_INDEX, dayOfWeekFiscal, dateForDayOfWeek,
  PASSAIC_OPERATORS, BNY_OPERATORS_BROOKLYN, BNY_OPERATORS_PASSAIC_DIGITAL,
} from '../lib/scheduleUtils'
import { loadWeekDailyOps, upsertDailyOp } from '../lib/dailyOps'

// Note assignees per Wendy 4/2026. Roles rather than names so the list stays
// stable when people change positions. Edit this list when org changes.
// "Peter Webster" stays as a name since PW is uniquely you in this context.
const NOTE_ASSIGNEES = [
  'QA Lead',
  'Production Manager',
  'Operations Manager',
  'Peter Webster',
]

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
export default function LiveOpsTab({ currentUser } = {}) {
  const [viewMode, setViewMode] = useState('entry')  // 'entry' | 'summary'
  const [site, setSite] = useState('passaic')
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date(); d.setHours(0,0,0,0); return d
  })
  const [dailyOps, setDailyOps] = useState([])
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(false)
  // Tracks which Passaic tables the user has clicked "+ add 2nd shift" on
  // for the currently-selected day, but hasn't saved any data for yet.
  // Cleared when the day changes (each day starts fresh; persisted 2nd-shift
  // rows surface from sched_daily_ops automatically). Keyed by table code.
  const [expandedSecondShifts, setExpandedSecondShifts] = useState(() => new Set())

  // Week that contains the selected date. mondayOf is now an alias for
  // sundayOf post Phase A — returns the Sunday week_start, matching the
  // fiscal calendar. Function name kept for compatibility.
  const weekStart = useMemo(() => mondayOf(selectedDate), [selectedDate])
  const dayOfWeek = useMemo(() => dayOfWeekFiscal(weekStart, selectedDate), [weekStart, selectedDate])

  // Reset 2nd-shift expansions when the user navigates to a different day.
  // Days are isolated for the purposes of "did the user expand here yet" —
  // stale expansions from yesterday shouldn't bleed into today.
  useEffect(() => {
    setExpandedSecondShifts(new Set())
  }, [dayOfWeek, site])

  // Auto-jump to the most recent week that has PO assignments for this site on
  // mount or when the site toggles. Using sched_assignments (not daily_ops) as
  // the signal — assignment-to-table is what "I'm planning this week" means;
  // Wendy may or may not have opened PLAN to set explicit daily targets.
  const initializedFor = useRef(null)
  useEffect(() => {
    if (initializedFor.current === site) return
    let cancelled = false
    async function autoJump() {
      const { data } = await supabase
        .from('sched_assignments')
        .select('week_start')
        .eq('site', site)
        .order('week_start', { ascending: false })
        .limit(1)
      if (cancelled) return
      initializedFor.current = site
      if (!data || data.length === 0) return  // no assignments anywhere — stay on today
      const latestWeekStr = data[0].week_start
      const latestWeekStart = new Date(latestWeekStr + 'T00:00:00')
      const today = new Date(); today.setHours(0,0,0,0)
      const todayWeekStart = mondayOf(today)
      // If today is already in the latest-planned week, stay on today. Otherwise
      // jump to Monday of that week so Wendy/Sami sees her planning immediately.
      if (mondayOf(latestWeekStart).getTime() !== todayWeekStart.getTime()) {
        setSelectedDate(mondayOf(latestWeekStart))
      }
    }
    autoJump()
    return () => { cancelled = true }
  }, [site])

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

  // Per-cell rows keyed by `${tableCode}|${shift}`. For Passaic hand-screen
  // tables, both '1st' and '2nd' shift entries exist (2nd shift is rendered
  // only when it has data or the user has expanded — see render block).
  // For BNY, only '1st' shift exists; BNY machines don't run 2nd shift.
  //
  // Note: derived plan ("weekly ÷ 5") only applies to Passaic 1st shift on
  // production weekdays Mon-Fri. 2nd shift requires explicit planning via
  // CrewModal in the Scheduler. Sat/Sun cells have no auto-derived plan.
  const PRODUCTION_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
  const rowsByCell = useMemo(() => {
    const m = {}
    for (const t of tables) {
      const isPassaic = site === 'passaic'
      const shifts = isPassaic ? ['1st', '2nd'] : ['1st']
      for (const shift of shifts) {
        const op = dailyOps.find(r =>
          r.table_code === t.code &&
          r.day_of_week === dayOfWeek &&
          ((r.shift || '1st') === shift)
        ) || null

        let plannedYards = 0
        let plannedSource = 'none'  // 'explicit' | 'derived' | 'none'
        let plannedDetails = []

        if (isPassaic) {
          // Passaic: prefer explicit daily target (sched_daily_ops.planned_yards).
          // If not set, derive from weekly PO total ÷ 5 so Live Ops has a target
          // to verify against — but only on 1st shift, only on Mon-Fri.
          const onTable = assignments.filter(a => a.table_code === t.code)
          // Plan details (PO list) only useful on 1st-shift row; suppress on 2nd
          // to keep the second row visually lighter.
          plannedDetails = shift === '1st' ? onTable.map(a => a.line_description || a.po_number) : []
          if (op?.planned_yards != null) {
            plannedYards = Number(op.planned_yards)
            plannedSource = 'explicit'
          } else if (shift === '1st' && PRODUCTION_WEEKDAYS.includes(dayOfWeek)) {
            const weekly = onTable.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
            if (weekly > 0) {
              plannedYards = Math.round(weekly / 5)
              plannedSource = 'derived'
            }
          }
        } else {
          // BNY: day-specific assignments, single shift
          const onCell = assignments.filter(a =>
            a.table_code === t.code && a.day_of_week === dayOfWeek
          )
          plannedYards = onCell.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
          plannedDetails = onCell.map(a => a.line_description || a.po_number)
        }

        m[`${t.code}|${shift}`] = { op, plannedYards, plannedSource, plannedDetails }
      }
    }
    return m
  }, [tables, dailyOps, assignments, dayOfWeek, site])

  function navigateDay(deltaDays) {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + deltaDays)
    setSelectedDate(d)
  }

  function navigateWeek(deltaWeeks) {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + deltaWeeks * 7)
    setSelectedDate(d)
  }

  async function saveRow(tableCode, shift, patch) {
    const existing = rowsByCell[`${tableCode}|${shift}`]?.op || {}
    const row = {
      site,
      week_start: isoDate(weekStart),
      table_code: tableCode,
      day_of_week: dayOfWeek,
      shift,
      ...existing,
      ...patch,
    }
    // Strip non-column fields if existing was fetched
    delete row.id; delete row.created_at; delete row.updated_at
    try {
      await upsertDailyOp(row)
      // Optimistic local update — match by (table, day, shift)
      setDailyOps(prev => {
        const idx = prev.findIndex(r =>
          r.table_code === tableCode &&
          r.day_of_week === dayOfWeek &&
          ((r.shift || '1st') === shift)
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
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif', margin: 0, marginBottom: 4 }}>
            Live Ops — {viewMode === 'summary' ? 'Weekly Summary' : 'Daily Actuals'}
          </h2>
          <div style={{ fontSize: 13, color: C.inkMid }}>
            {viewMode === 'summary'
              ? 'Weekly roll-up across both sites. Schedule, day-by-day tracking, and operator scorecards.'
              : 'End-of-shift entry for what actually happened. Yards produced, waste, who was on the table, and any notes worth remembering.'}
          </div>
        </div>
        {/* View mode toggle */}
        <div style={{ display: 'flex', gap: 0, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
          <button onClick={() => setViewMode('entry')}
            style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700, border: 'none', background: viewMode === 'entry' ? C.ink : 'transparent', color: viewMode === 'entry' ? '#fff' : C.inkMid, cursor: 'pointer' }}>
            Entry
          </button>
          <button onClick={() => setViewMode('summary')}
            style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700, border: 'none', background: viewMode === 'summary' ? C.ink : 'transparent', color: viewMode === 'summary' ? '#fff' : C.inkMid, cursor: 'pointer' }}>
            Summary
          </button>
        </div>
      </div>

      {viewMode === 'summary' ? (
        <SummaryView weekStart={weekStart} setSelectedDate={setSelectedDate} />
      ) : (<></>)}

      {viewMode === 'entry' && (<></>)}

      {viewMode === 'entry' && (<>

      {/* Site toggle + week + day navigators */}
      <div style={{ marginBottom: 20, padding: '12px 16px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10 }}>
        {/* Row 1: site toggle + Today */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <SiteChip active={site === 'passaic'} onClick={() => setSite('passaic')} color={C.navy}>
              Passaic · Screen Print
            </SiteChip>
            <SiteChip active={site === 'bny'} onClick={() => setSite('bny')} color={C.amber}>
              BNY · Digital
            </SiteChip>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={() => setSelectedDate(today)}
            style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, color: C.inkMid, fontWeight: 600 }}>
            Jump to today
          </button>
        </div>

        {/* Row 2: week navigator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: `1px dashed ${C.border}` }}>
          <button onClick={() => navigateWeek(-1)}
            style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>
            ← Prev week
          </button>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: C.inkLight, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Week</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>{weekLabel(weekStart)}</div>
          </div>
          <button onClick={() => navigateWeek(1)}
            style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>
            Next week →
          </button>
        </div>

        {/* Row 3: day navigator (within the week above) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => navigateDay(-1)}
            style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>
            ← Prev day
          </button>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: C.inkLight, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Day</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>
              {dayLabel} <span style={{ fontWeight: 400, color: C.inkMid }}>· {dateLabel}</span>
              {isToday && <span style={{ fontSize: 10, color: C.sage, fontWeight: 600, marginLeft: 6 }}>TODAY</span>}
              {isFuture && <span style={{ fontSize: 10, color: C.gold, fontWeight: 600, marginLeft: 6 }}>FUTURE</span>}
            </div>
          </div>
          <button onClick={() => navigateDay(1)}
            style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>
            Next day →
          </button>
        </div>
      </div>

      {/* No-plan-data warning — only if neither explicit targets nor PO assignments exist */}
      {!loading && !dailyOps.some(r => r.planned_yards != null) && assignments.length === 0 && (
        <div style={{ background: C.parchment, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: C.inkMid }}>
          <strong style={{ color: C.ink }}>No plan or assignments for this week.</strong> Nothing's been scheduled yet for week of {weekLabel(weekStart)}. You can still enter actuals, but there'll be no target to verify against. If you expected data here, check the Scheduler tab for a different week.
        </div>
      )}

      {isFuture && (
        <div style={{ background: C.amberBg, border: `1px solid ${C.amber}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: C.amber, fontWeight: 600 }}>
          This date is in the future. Fields are enterable (backfill or pre-planning), but most actuals entry happens same-day at end of shift.
        </div>
      )}

      {loading && (
        <div style={{ padding: 40, textAlign: 'center', color: C.inkLight, fontSize: 13 }}>Loading…</div>
      )}

      {!loading && (
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {tables.map((t, i) => {
            const isPassaic = site === 'passaic'
            const firstCell  = rowsByCell[`${t.code}|1st`]
            const secondCell = rowsByCell[`${t.code}|2nd`]
            // Show 2nd-shift row if saved data exists OR user has expanded.
            const has2ndData = secondCell?.op != null
            const showSecondShift = isPassaic && (has2ndData || expandedSecondShifts.has(t.code))

            const cat = categorize(t)
            const catLabel = cat === 'grass' ? 'Grasscloth' : cat === 'fabric' ? 'Fabric' : cat === 'wallpaper' ? 'Wallpaper' : null
            const showCategoryHeader = isPassaic && (i === 0 || categorize(tables[i - 1]) !== cat)

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
                  shift="1st"
                  plannedYards={firstCell?.plannedYards || 0}
                  plannedSource={firstCell?.plannedSource || 'none'}
                  plannedDetails={firstCell?.plannedDetails || []}
                  op={firstCell?.op}
                  canEnterActuals={true}
                  currentUser={currentUser}
                  onSave={(patch) => saveRow(t.code, '1st', patch)}
                />
                {showSecondShift && (
                  <OpsRow
                    table={t}
                    site={site}
                    shift="2nd"
                    plannedYards={secondCell?.plannedYards || 0}
                    plannedSource={secondCell?.plannedSource || 'none'}
                    plannedDetails={secondCell?.plannedDetails || []}
                    op={secondCell?.op}
                    canEnterActuals={true}
                    currentUser={currentUser}
                    onSave={(patch) => saveRow(t.code, '2nd', patch)}
                  />
                )}
                {isPassaic && !showSecondShift && (
                  // marginTop: -1 + bg #fff overlaps the 1st-shift OpsRow's
                  // borderBottom, hiding it. The wrapper provides the only
                  // separator between this row group and the next, so the
                  // button visually belongs to the row above (not floating
                  // between two row groups).
                  <div style={{
                    marginTop: -1,
                    padding: '0 16px 8px 16px',
                    background: '#fff',
                    borderBottom: `1px solid ${C.border}`,
                    position: 'relative',
                  }}>
                    <button
                      onClick={() => setExpandedSecondShifts(prev => {
                        const next = new Set(prev); next.add(t.code); return next
                      })}
                      style={{ marginLeft: 16, padding: '3px 10px', fontSize: 10, fontWeight: 600, color: C.inkLight, background: 'transparent', border: `1px dashed ${C.border}`, borderRadius: 3, cursor: 'pointer', letterSpacing: '0.04em' }}>
                      ↳ Add 2nd shift entry
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      </>)}
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

function OpsRow({ table, site, shift, plannedYards, plannedSource, plannedDetails, op, canEnterActuals, currentUser, onSave }) {
  const [yards, setYards]   = useState(op?.actual_yards ?? '')
  const [waste, setWaste]   = useState(op?.waste_yards ?? '')
  const [op1, setOp1]       = useState(op?.operator_1 ?? '')
  const [op2, setOp2]       = useState(op?.operator_2 ?? '')
  const [notes, setNotes]   = useState(op?.notes ?? '')
  // Note delegation v1 (Wendy 4/2026): assign a note to one of four roles.
  // Status auto-flips to 'open' when assigned and a note exists; stays null
  // for unassigned notes; flips to 'resolved' via the Mark Resolved button.
  const [assignedTo, setAssignedTo] = useState(op?.note_assigned_to ?? '')
  const [noteStatus, setNoteStatus] = useState(op?.note_status ?? null)
  const [notesModalOpen, setNotesModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)

  const isSecondShift = shift === '2nd'

  // Reset fields when the underlying row changes (user navigates day/site).
  // Also close the notes modal so it doesn't hover with stale state.
  useEffect(() => {
    setYards(op?.actual_yards ?? '')
    setWaste(op?.waste_yards ?? '')
    setOp1(op?.operator_1 ?? '')
    setOp2(op?.operator_2 ?? '')
    setNotes(op?.notes ?? '')
    setAssignedTo(op?.note_assigned_to ?? '')
    setNoteStatus(op?.note_status ?? null)
    setNotesModalOpen(false)
    setSavedAt(null)
  }, [op?.id, op?.actual_yards, op?.waste_yards, op?.operator_1, op?.operator_2, op?.notes, op?.note_assigned_to, op?.note_status])

  async function handleSave() {
    setSaving(true)
    // Status logic: assignment + note text → 'open' (unless already 'resolved')
    // No assignment → null. Resolved status sticks until user clears assignment.
    let nextStatus = noteStatus
    if (assignedTo && notes) {
      if (nextStatus !== 'resolved') nextStatus = 'open'
    } else {
      nextStatus = null
    }
    const patch = {
      operator_1: op1 || null,
      operator_2: op2 || null,
      actual_yards: yards === '' ? null : Number(yards),
      waste_yards: waste === '' ? null : Number(waste),
      notes: notes || null,
      note_assigned_to: assignedTo || null,
      note_status: nextStatus,
    }
    await onSave(patch)
    // Fire Slack notification only when the assignment is NEW or CHANGED, and
    // status is 'open'. Silent on every other save (yards updates, edits to
    // note text without reassignment, marking resolved, etc.) to avoid spam.
    const wasAssignedToSomeone = !!op?.note_assigned_to
    const assigneeChanged = (op?.note_assigned_to || '') !== (assignedTo || '')
    const becomingOpen = nextStatus === 'open'
    if (assignedTo && becomingOpen && (assigneeChanged || !wasAssignedToSomeone)) {
      // Best-effort — failures don't block the save flow.
      fetch('/api/slack-note-notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedTo,
          assignedBy: currentUser || 'Unknown user',
          site,
          tableLabel: table.label || table.code,
          dateLabel: op?.date_label || '',
          noteText: notes,
        }),
      }).catch(() => {})
    }
    setNoteStatus(nextStatus)
    setSaving(false)
    setSavedAt(Date.now())
  }

  const operatorList = site === 'passaic'
    ? PASSAIC_OPERATORS
    : (BNY_BROOKLYN.some(m => m.code === table.code) ? BNY_OPERATORS_BROOKLYN : BNY_OPERATORS_PASSAIC_DIGITAL)

  const actual = yards === '' ? null : Number(yards)
  const variance = actual != null ? actual - plannedYards : null
  // Hide the variance line entirely when no actual is entered. A bare "—"
  // sitting under the input read as an errant dash without context. Only
  // show the line once there's a real number to compare against.
  const varianceColor = variance == null ? C.inkLight
    : Math.abs(variance) < 50 ? C.sage
    : variance > 0 ? C.gold : C.rose
  const varianceLabel = variance == null ? null
    : variance === 0 ? 'on plan'
    : (variance > 0 ? '+' : '') + fmt(variance) + ' vs plan'

  return (
    <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '140px minmax(140px, 1fr) 80px 80px 130px 130px 100px 80px', gap: 12, alignItems: 'start' }}>
      {/* Table label */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>
          {table.label || table.code}
          {isSecondShift && <span style={{ color: C.amber, fontWeight: 600 }}> · 2nd</span>}
        </div>
        <div style={{ fontSize: 10, color: C.inkLight }}>
          {isSecondShift ? '2nd shift (3p–11p)'
            : site === 'passaic' ? "1st shift · day's target"
            : `${table.capacity} yd/day cap`}
        </div>
      </div>

      {/* Planned summary */}
      <div style={{ fontSize: 11, color: C.inkMid, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: C.ink, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {plannedYards > 0 ? (
            <>
              {fmt(plannedYards)} yd target
              {plannedSource === 'derived' && (
                <span style={{ fontSize: 9, color: C.inkLight, fontWeight: 400, marginLeft: 4, fontStyle: 'italic' }}>
                  · auto (weekly ÷ 5)
                </span>
              )}
            </>
          ) : (
            <span style={{ color: C.inkLight, fontStyle: 'italic' }}>no target set</span>
          )}
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
        {varianceLabel && (
          <div style={{ fontSize: 9, color: varianceColor, fontWeight: 600, marginTop: 3 }}>{varianceLabel}</div>
        )}
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

      {/* Notes — pop-out editor. The button shows a preview when populated;
          clicking opens a full-size modal. The note is staged on this row's
          local state and saves with the row's main Save button (consistent
          with how operators / yards already work — one save path). */}
      <div>
        <label style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Notes</label>
        {notes ? (
          <button onClick={() => setNotesModalOpen(true)} title={notes}
            style={{ width: '100%', padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, color: C.ink, background: C.warm, cursor: 'pointer', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'inherit', display: 'block' }}>
            ✏️ {notes.split('\n')[0]}
            {assignedTo && (
              <span style={{ marginLeft: 6, fontSize: 9, padding: '0 4px', borderRadius: 2, fontWeight: 700, letterSpacing: '0.04em',
                background: noteStatus === 'resolved' ? C.sageBg : C.goldBg,
                color: noteStatus === 'resolved' ? C.sage : C.gold,
              }}>
                {noteStatus === 'resolved' ? '✓' : '→'} {assignedTo.split(' ').map(w => w[0]).join('')}
              </span>
            )}
          </button>
        ) : (
          <button onClick={() => setNotesModalOpen(true)}
            style={{ width: '100%', padding: '6px 8px', border: `1px dashed ${C.border}`, borderRadius: 4, fontSize: 11, color: C.inkLight, background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', display: 'block' }}>
            + Add note
          </button>
        )}
      </div>

      {/* Save */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
        <button onClick={handleSave} disabled={saving}
          style={{ padding: '8px 10px', background: saving ? C.warm : C.ink, color: saving ? C.inkLight : '#fff', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', boxShadow: saving ? 'none' : '0 1px 3px rgba(0,0,0,0.2)' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && (
          <div style={{ fontSize: 9, color: C.sage, textAlign: 'center', fontWeight: 600 }}>✓ saved</div>
        )}
      </div>

      {/* Notes pop-out modal — backdrop click closes without saving (escape
          hatch). The "Save & close" button persists the entire row, then
          closes — which means the modal alone is sufficient to commit notes
          without needing the row's main Save button. */}
      {notesModalOpen && (
        <div onClick={(e) => e.target === e.currentTarget && setNotesModalOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, width: 'min(640px, 94vw)', maxHeight: '92vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '14px 18px', background: C.navy, color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'Georgia,serif' }}>Notes · {table.label || table.code}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>
                  Registration issues, color mix problems, crew changes — anything worth remembering.
                </div>
              </div>
              {assignedTo && noteStatus && (
                <span style={{ fontSize: 10, padding: '4px 10px', borderRadius: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', flexShrink: 0,
                  background: noteStatus === 'resolved' ? '#2D5A3D' : '#8B6914',
                  color: '#fff',
                }}>
                  {noteStatus === 'resolved' ? '✓ Resolved' : '○ Open'}
                </span>
              )}
            </div>
            <div style={{ padding: 18 }}>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} autoFocus
                rows={9} placeholder="Type here…"
                style={{ width: '100%', padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', minHeight: 180, lineHeight: 1.5 }} />

              {/* Assignee + status row */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 10, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>
                    Assign to (optional)
                  </label>
                  <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit', background: '#fff', color: C.ink, cursor: 'pointer' }}>
                    <option value="">— No assignment —</option>
                    {NOTE_ASSIGNEES.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>
                {assignedTo && noteStatus === 'open' && (
                  <button onClick={() => setNoteStatus('resolved')}
                    style={{ padding: '8px 14px', background: C.sage, color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    ✓ Mark resolved
                  </button>
                )}
                {assignedTo && noteStatus === 'resolved' && (
                  <button onClick={() => setNoteStatus('open')}
                    style={{ padding: '8px 14px', background: 'transparent', color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    Reopen
                  </button>
                )}
              </div>
              {assignedTo && (
                <div style={{ fontSize: 11, color: C.inkLight, marginTop: 8, fontStyle: 'italic' }}>
                  {op?.note_assigned_to !== assignedTo
                    ? `${assignedTo} will be notified in Slack when you save.`
                    : `${assignedTo} was already notified. Saving again won't ping them.`}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, gap: 12 }}>
                <span style={{ fontSize: 11, color: C.inkLight, fontStyle: 'italic' }}>
                  {saving ? 'Saving…' : 'Save & close commits this row to the database.'}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setNotesModalOpen(false)} disabled={saving}
                    style={{ padding: '8px 14px', background: 'transparent', color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
                    Cancel
                  </button>
                  <button onClick={async () => { await handleSave(); setNotesModalOpen(false) }} disabled={saving}
                    style={{ padding: '8px 18px', background: saving ? C.warm : C.ink, color: saving ? C.inkLight : '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
                    {saving ? 'Saving…' : 'Save & close'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// SummaryView — weekly management roll-up across both sites
// ═══════════════════════════════════════════════════════════════════════════
// Three sections:
// 1. Weekly totals (both sites side-by-side with planned/actual/variance/waste)
// 2. Day-by-day grid per site (table/machine × Mon-Fri with plan/actual cells)
// 3. Operator scorecards (medal-ranked yards per operator, split by site)
//
// Pulls sched_daily_ops (actuals + operators + planned_yards) and
// sched_assignments (POs) for both sites in parallel.
// ═══════════════════════════════════════════════════════════════════════════
function SummaryView({ weekStart, setSelectedDate }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [pOps, bOps, pAsn, bAsn] = await Promise.all([
        loadWeekDailyOps('passaic', weekStart),
        loadWeekDailyOps('bny', weekStart),
        supabase.from('sched_assignments').select('*').eq('site', 'passaic').eq('week_start', isoDate(weekStart)),
        supabase.from('sched_assignments').select('*').eq('site', 'bny').eq('week_start', isoDate(weekStart)),
      ])
      if (cancelled) return
      setData({
        passaicOps: pOps || [],
        bnyOps: bOps || [],
        passaicAsn: pAsn.data || [],
        bnyAsn: bAsn.data || [],
      })
    }
    setData(null)
    load()
    return () => { cancelled = true }
  }, [weekStart])

  function navigateWeek(deltaWeeks) {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + deltaWeeks * 7)
    setSelectedDate(d)
  }

  return (
    <div>
      {/* Week nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 14px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <button onClick={() => navigateWeek(-1)}
          style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>
          ← Prev week
        </button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: C.inkLight, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Summary for week</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>{weekLabel(weekStart)}</div>
        </div>
        <button onClick={() => navigateWeek(1)}
          style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>
          Next week →
        </button>
      </div>

      {!data && <div style={{ padding: 40, textAlign: 'center', color: C.inkLight, fontSize: 13 }}>Loading…</div>}

      {data && (
        <>
          {/* Section 1: Weekly totals per site */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <SiteTotals label="Passaic · Screen Print" color={C.navy}
              ops={data.passaicOps} assignments={data.passaicAsn}
              tables={SUMMARY_PASSAIC_TABLES} site="passaic" />
            <SiteTotals label="BNY · Digital" color={C.amber}
              ops={data.bnyOps} assignments={data.bnyAsn}
              tables={SUMMARY_BNY_MACHINES} site="bny" />
          </div>

          {/* Section 1b: Notes from this week — surfaces operator commentary
              to the exec view so it doesn't stay buried in per-cell notes. */}
          <WeeklyNotesPanel
            passaicOps={data.passaicOps}
            bnyOps={data.bnyOps} />

          {/* Section 2: Day-by-day grid per site */}
          <DayGrid label="Passaic — Day-by-Day" tables={SUMMARY_PASSAIC_TABLES}
            ops={data.passaicOps} assignments={data.passaicAsn} site="passaic" />
          <DayGrid label="BNY — Day-by-Day" tables={SUMMARY_BNY_MACHINES}
            ops={data.bnyOps} assignments={data.bnyAsn} site="bny" />

          {/* Section 3: Operator scorecards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 24 }}>
            <OperatorScorecard label="Screen Print Operators · Passaic"
              color={C.navy} ops={data.passaicOps} site="passaic" />
            <OperatorScorecard label="Digital Operators · BNY"
              color={C.amber} ops={data.bnyOps} site="bny" />
          </div>
        </>
      )}
    </div>
  )
}

// Single source of truth for "what's the planned yards for table T on day D?".
// Used by both SiteTotals (the cards) and DayGrid (the grid below). Before
// this existed, the card summed only sched_daily_ops.planned_yards while the
// grid additionally fell back to Math.round(weekly / 5) for empty cells —
// resulting in a card that said 50 while the grid showed 70 for the same
// week. Now both call this helper and agree.
//
// For Passaic, plan comes ONLY from sched_daily_ops. No "weekly / 5" fallback,
// matching the Phase 2 PassaicScheduler fix that killed phantom derived
// values. For BNY, plan can also come from sched_assignments because BNY
// stores assignments with day_of_week (this is reading actual scheduled
// data, not deriving). Returns null for cells with no plan; null contributes
// nothing to totals and renders as "—" in the grid.
//
// Shift filter (optional, post Migration B1):
//   - shift === null: sums planned across BOTH shifts (totals views).
//   - shift === '1st' / '2nd': isolates that shift (per-shift grid rows).
//   BNY is 1st-shift-only by design; passing shift='2nd' for BNY returns null.
function plannedForCell(site, tableCode, d, ops, assignments, shift = null) {
  const matching = ops.filter(r =>
    r.table_code === tableCode &&
    r.day_of_week === d &&
    (shift == null ? true : (r.shift || '1st') === shift)
  )
  const hasExplicit = matching.some(r => r.planned_yards != null)
  if (hasExplicit) {
    return matching.reduce((s, r) => r.planned_yards != null ? s + Number(r.planned_yards) : s, 0)
  }
  if (site === 'bny' && shift !== '2nd') {
    // BNY: derive from sched_assignments (1st-shift only by convention)
    const daily = assignments
      .filter(a => a.table_code === tableCode && a.day_of_week === d)
      .reduce((s, a) => s + Number(a.planned_yards || 0), 0)
    return daily > 0 ? daily : null
  }
  return null
}

// Site totals card: planned, actual, variance, waste for selected week.
// Iterates the full Sun-Sat week for both sites (post Phase B). Sums across
// shifts implicitly — actuals from a 2nd-shift Passaic row count toward the
// site total just like 1st shift does.
function SiteTotals({ label, color, ops, assignments, tables, site }) {
  const days = DAY_NAMES_SHORT  // ['Sun', 'Mon', ..., 'Sat']

  // Planned: sum across every (table, day) cell using the shared helper.
  // Helper sums shifts when no shift filter is passed, so 2nd-shift plan
  // contributes here automatically.
  let totalPlanned = 0
  for (const t of tables) {
    for (const d of days) {
      const p = plannedForCell(site, t.code, d, ops, assignments)
      if (p != null) totalPlanned += p
    }
  }

  // Actuals: only sum rows that have explicit entries. If nothing has been
  // entered yet, show "—" rather than a phantom 0 / negative variance —
  // otherwise a future week reads as "we underran by 50 yards" when nothing
  // has happened yet.
  const opsWithActuals = ops.filter(r => r.actual_yards != null)
  const hasAnyActuals = opsWithActuals.length > 0
  const totalActual = opsWithActuals.reduce((s, r) => s + Number(r.actual_yards || 0), 0)
  const totalWaste = ops
    .filter(r => r.waste_yards != null)
    .reduce((s, r) => s + Number(r.waste_yards || 0), 0)

  const variance = hasAnyActuals ? totalActual - totalPlanned : null
  const varianceColor = !hasAnyActuals || totalPlanned === 0 ? C.inkLight
    : Math.abs(variance) / totalPlanned < 0.05 ? C.sage
    : variance > 0 ? C.gold
    : Math.abs(variance) / totalPlanned < 0.15 ? C.gold : C.rose
  const wastePct = hasAnyActuals && totalActual > 0 ? (totalWaste / totalActual * 100) : null

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: color, color: '#fff', fontSize: 13, fontWeight: 700, fontFamily: 'Georgia,serif' }}>
        {label}
      </div>
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
        <Stat label="Planned" value={fmt(totalPlanned)} unit="yd" />
        <Stat label="Actual"
          value={hasAnyActuals ? fmt(totalActual) : '—'}
          unit={hasAnyActuals ? 'yd' : 'no entries yet'} />
        <Stat label="Variance"
          value={hasAnyActuals ? (variance >= 0 ? `+${fmt(variance)}` : fmt(variance)) : '—'}
          unit="yd"
          color={hasAnyActuals ? varianceColor : C.inkLight} />
        <Stat label="Waste"
          value={hasAnyActuals ? fmt(totalWaste) : '—'}
          unit="yd"
          sub={wastePct != null ? `${wastePct.toFixed(1)}%` : null}
          color={wastePct != null && wastePct > 10 ? C.rose : wastePct != null && wastePct > 4 ? C.gold : C.inkMid} />
      </div>
    </div>
  )
}

function Stat({ label, value, unit, color, sub }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || C.ink, fontFamily: 'Georgia,serif', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10, color: C.inkLight }}>{sub || unit}</div>
    </div>
  )
}

// Weekly notes roll-up — pulls every non-empty note from the week's daily-ops
// rows on both sites and lists them chronologically. High-signal panel for
// the exec view: scan the week's operational events without paging through
// each table-day cell.
function WeeklyNotesPanel({ passaicOps, bnyOps }) {
  const collect = (ops, site) => ops
    .filter(r => r.notes && r.notes.trim().length > 0)
    .map(r => ({
      site,
      day: r.day_of_week,
      shift: r.shift || '1st',
      table: r.table_code,
      operators: [r.operator_1, r.operator_2].filter(Boolean).join(' & ') || 'unattributed',
      text: r.notes.trim(),
    }))
  // day_of_week is TEXT post Migration B2; use DAY_INDEX for chronological order.
  // Unknown labels sort to the end.
  const all = [...collect(passaicOps, 'passaic'), ...collect(bnyOps, 'bny')]
    .sort((a, b) => {
      const ia = DAY_INDEX[a.day] ?? 99
      const ib = DAY_INDEX[b.day] ?? 99
      if (ia !== ib) return ia - ib
      return a.table.localeCompare(b.table)
    })

  if (all.length === 0) return null

  const siteColor = { passaic: C.navy, bny: C.amber }
  const siteShort = { passaic: 'Passaic', bny: 'BNY' }

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
      <div style={{ padding: '10px 14px', background: C.parchment, borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Notes from this week</span>
        <span style={{ fontSize: 10, color: C.inkLight, fontWeight: 600, fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {all.length} {all.length === 1 ? 'note' : 'notes'}
        </span>
      </div>
      {all.map((n, i) => (
        <div key={i} style={{ padding: '10px 14px', borderTop: i > 0 ? `1px solid ${C.border}` : 'none' }}>
          <div style={{ fontSize: 10, color: C.inkLight, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', padding: '1px 6px', background: siteColor[n.site], color: '#fff', borderRadius: 3, fontSize: 9, fontWeight: 700, letterSpacing: '0.05em' }}>{siteShort[n.site]}</span>
            <span style={{ fontWeight: 600, color: C.inkMid }}>{n.day || '—'}</span>
            <span>·</span>
            <span style={{ fontWeight: 600, color: C.ink }}>{n.table}</span>
            {n.shift === '2nd' && (
              <span style={{ fontSize: 9, color: C.amber, fontWeight: 700 }}>· 2nd shift</span>
            )}
            <span>·</span>
            <span>{n.operators}</span>
          </div>
          <div style={{ fontSize: 12, color: C.ink, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{n.text}</div>
        </div>
      ))}
    </div>
  )
}

// Day-by-day grid: rows = tables/machines, columns = Sun-Sat + Week total.
// Both sites now render the full 7-day week (post Phase B).
//
// Passaic per-shift split: a hand-screen table that has any 2nd-shift data
// anywhere in the week renders TWO rows — "FAB-3" (1st shift) and "FAB-3 · 2nd"
// (2nd shift). Tables that only run 1st shift this week show only the 1st row,
// keeping the grid quiet when 2nd shift isn't in use. BNY is always one row
// per machine — BNY doesn't run 2nd shift.
function DayGrid({ label, tables, ops, assignments, site }) {
  const days = DAY_NAMES_SHORT  // ['Sun', 'Mon', ..., 'Sat']
  const colCount = days.length

  // Build the row list. For Passaic, expand to (table, shift) rows where
  // 2nd shift is included only if there's any plan or actual data this week.
  const rows = []
  for (const t of tables) {
    const isPassaic = site === 'passaic'
    if (!isPassaic) {
      rows.push({ table: t, shift: '1st', label: t.label || t.code })
      continue
    }
    // 1st shift row always renders for Passaic.
    rows.push({ table: t, shift: '1st', label: t.label || t.code })
    // 2nd shift row only if any cell has plan or actual data this week.
    let any2nd = false
    for (const d of days) {
      const op = ops.find(r =>
        r.table_code === t.code && r.day_of_week === d && (r.shift || '1st') === '2nd'
      )
      const plan = plannedForCell(site, t.code, d, ops, assignments, '2nd')
      if (op?.actual_yards != null || plan != null) { any2nd = true; break }
    }
    if (any2nd) {
      rows.push({ table: t, shift: '2nd', label: `${t.label || t.code} · 2nd` })
    }
  }

  // Plan + actual for a (table, day, shift). Plan computation uses the shared
  // plannedForCell helper so this grid agrees with the SiteTotals card above.
  function cellData(tableCode, d, shift) {
    const op = ops.find(r =>
      r.table_code === tableCode && r.day_of_week === d && (r.shift || '1st') === shift
    )
    const plan = plannedForCell(site, tableCode, d, ops, assignments, shift)
    const actual = op?.actual_yards
    return { plan, actual }
  }

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ padding: '10px 14px', background: C.parchment, borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>
        {label}
      </div>
      {/* Header */}
      <div style={{ display: 'grid', gridTemplateColumns: `130px repeat(${colCount}, 1fr) 90px`, gap: 1, background: C.border, padding: 1 }}>
        <div style={{ background: C.parchment, padding: '6px 8px', fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Table</div>
        {days.map(d => (
          <div key={d} style={{ background: C.parchment, padding: '6px 8px', fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', textAlign: 'center', letterSpacing: '0.06em' }}>{d}</div>
        ))}
        <div style={{ background: C.parchment, padding: '6px 8px', fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', textAlign: 'right', letterSpacing: '0.06em' }}>Week</div>
      </div>
      {/* Rows */}
      {rows.map((r, i) => {
        let weekPlan = 0, weekActual = 0
        const cells = days.map(d => {
          const c = cellData(r.table.code, d, r.shift)
          if (c.plan != null) weekPlan += c.plan
          if (c.actual != null) weekActual += c.actual
          return c
        })
        const weekDelta = weekPlan > 0 ? weekActual - weekPlan : null
        const weekColor = weekDelta == null ? C.inkLight
          : Math.abs(weekDelta) / weekPlan < 0.05 ? C.sage
          : Math.abs(weekDelta) / weekPlan < 0.15 ? C.gold : C.rose
        const isSecond = r.shift === '2nd'
        return (
          <div key={`${r.table.code}|${r.shift}`} style={{ display: 'grid', gridTemplateColumns: `130px repeat(${colCount}, 1fr) 90px`, gap: 1, background: C.border, padding: '0 1px', borderTop: i === 0 ? 'none' : undefined }}>
            <div style={{ background: '#fff', padding: '6px 8px', fontSize: 11, fontWeight: 600, color: C.ink }}>
              {r.table.label || r.table.code}
              {isSecond && <span style={{ color: C.amber, fontWeight: 700 }}> · 2nd</span>}
            </div>
            {cells.map((c, idx) => {
              const delta = (c.plan != null && c.actual != null) ? c.actual - c.plan : null
              const color = delta == null ? C.inkLight
                : c.plan > 0 && Math.abs(delta) / c.plan < 0.05 ? C.sage
                : c.plan > 0 && Math.abs(delta) / c.plan < 0.15 ? C.gold
                : delta < 0 ? C.rose : C.gold
              return (
                <div key={idx} style={{ background: '#fff', padding: '6px 8px', fontSize: 10, textAlign: 'center' }}>
                  <div style={{ color: C.inkMid }}>
                    {c.plan != null ? fmt(c.plan) : '—'}
                    <span style={{ color: C.inkLight }}> / </span>
                    <span style={{ color: c.actual != null ? C.ink : C.inkLight, fontWeight: c.actual != null ? 700 : 400 }}>
                      {c.actual != null ? fmt(c.actual) : '—'}
                    </span>
                  </div>
                  {delta != null && (
                    <div style={{ fontSize: 9, color, fontWeight: 600 }}>
                      {delta >= 0 ? `+${fmt(delta)}` : fmt(delta)}
                    </div>
                  )}
                </div>
              )
            })}
            <div style={{ background: '#fff', padding: '6px 8px', fontSize: 10, textAlign: 'right' }}>
              <div style={{ color: C.inkMid }}>
                {fmt(weekPlan)} <span style={{ color: C.inkLight }}>/</span> <span style={{ color: C.ink, fontWeight: 700 }}>{fmt(weekActual)}</span>
              </div>
              {weekDelta != null && (
                <div style={{ fontSize: 9, color: weekColor, fontWeight: 600 }}>
                  {weekDelta >= 0 ? `+${fmt(weekDelta)}` : fmt(weekDelta)}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Operator scorecard: ranked list by yards produced this week
function OperatorScorecard({ label, color, ops, site }) {
  // Aggregate: for each op row with actuals, credit operators (split if 2)
  const byOp = {}
  for (const r of ops) {
    const actual = Number(r.actual_yards || 0)
    if (actual <= 0) continue
    const operators = [r.operator_1, r.operator_2].filter(Boolean)
    if (operators.length === 0) continue
    const share = actual / operators.length
    for (const name of operators) {
      if (!byOp[name]) byOp[name] = { yards: 0, days: new Set(), waste: 0 }
      byOp[name].yards += share
      byOp[name].days.add(r.day_of_week)
      byOp[name].waste += Number(r.waste_yards || 0) / operators.length
    }
  }
  const ranked = Object.entries(byOp)
    .map(([name, d]) => ({ name, yards: Math.round(d.yards), days: d.days.size, avg: d.days.size > 0 ? Math.round(d.yards / d.days.size) : 0 }))
    .sort((a, b) => b.yards - a.yards)

  const topYards = ranked[0]?.yards || 0

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: color, color: '#fff', fontSize: 13, fontWeight: 700, fontFamily: 'Georgia,serif' }}>
        {label}
      </div>
      {ranked.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: C.inkLight, fontSize: 12, fontStyle: 'italic' }}>
          No actuals entered yet for this week.
        </div>
      ) : (
        <div>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr 70px 50px 70px 80px', gap: 8, padding: '6px 14px', background: C.parchment, fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <span>#</span>
            <span>Operator</span>
            <span style={{ textAlign: 'right' }}>Yds</span>
            <span style={{ textAlign: 'right' }}>Days</span>
            <span style={{ textAlign: 'right' }}>Avg/Day</span>
            <span style={{ textAlign: 'right' }}>vs Top</span>
          </div>
          {ranked.map((op, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null
            const pct = topYards > 0 ? (op.yards / topYards * 100) : 0
            return (
              <div key={op.name} style={{ display: 'grid', gridTemplateColumns: '32px 1fr 70px 50px 70px 80px', gap: 8, padding: '8px 14px', fontSize: 12, borderTop: `1px solid ${C.border}`, alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: C.inkMid }}>{medal || (i + 1)}</span>
                <span style={{ fontWeight: i < 3 ? 700 : 500, color: C.ink }}>{op.name}</span>
                <span style={{ textAlign: 'right', fontWeight: 700, color: C.ink }}>{fmt(op.yards)}</span>
                <span style={{ textAlign: 'right', color: C.inkMid }}>{op.days}</span>
                <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(op.avg)}</span>
                <span style={{ textAlign: 'right', color: C.inkLight, fontSize: 11 }}>{Math.round(pct)}%</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Table list compatible with DayGrid (subset of info)
const SUMMARY_PASSAIC_TABLES = [
  { code: 'GC-1', label: 'GC-1', category: 'grass' },
  { code: 'GC-2', label: 'GC-2', category: 'grass' },
  { code: 'FAB-3', label: 'FAB-3', category: 'fabric' },
  { code: 'FAB-4', label: 'FAB-4', category: 'fabric' },
  { code: 'FAB-5', label: 'FAB-5', category: 'fabric' },
  { code: 'FAB-6', label: 'FAB-6', category: 'fabric' },
  { code: 'FAB-7', label: 'FAB-7', category: 'fabric' },
  { code: 'FAB-8', label: 'FAB-8', category: 'fabric' },
  { code: 'FAB-9', label: 'FAB-9', category: 'fabric' },
  { code: 'FAB-10', label: 'FAB-10', category: 'fabric' },
  { code: 'FAB-11', label: 'FAB-11', category: 'fabric' },
  { code: 'WP-12', label: 'WP-12', category: 'wallpaper' },
  { code: 'WP-13', label: 'WP-13', category: 'wallpaper' },
  { code: 'WP-14', label: 'WP-14', category: 'wallpaper' },
  { code: 'WP-15', label: 'WP-15', category: 'wallpaper' },
  { code: 'WP-16', label: 'WP-16', category: 'wallpaper' },
  { code: 'WP-17', label: 'WP-17', category: 'wallpaper' },
]
const SUMMARY_BNY_MACHINES = [
  { code: 'Glow', label: 'Glow (3600)' },
  { code: 'Sasha', label: 'Sasha (3600)' },
  { code: 'Trish', label: 'Trish (3600)' },
  { code: 'Bianca', label: 'Bianca (570)' },
  { code: 'LASH', label: 'LASH (570)' },
  { code: 'Chyna', label: 'Chyna (570)' },
  { code: 'Rhonda', label: 'Rhonda (570)' },
  { code: 'Dakota Ka', label: 'Dakota Ka' },
  { code: 'Dementia', label: 'Dementia' },
  { code: 'EMBER', label: 'EMBER' },
  { code: 'Ivy Nile', label: 'Ivy Nile' },
  { code: 'Jacy Jayne', label: 'Jacy Jayne' },
  { code: 'Ruby', label: 'Ruby' },
  { code: 'Valhalla', label: 'Valhalla' },
  { code: 'XIA', label: 'XIA' },
  { code: 'Apollo', label: 'Apollo' },
  { code: 'Nemesis', label: 'Nemesis' },
  { code: 'Poseidon', label: 'Poseidon' },
  { code: 'Zoey', label: 'Zoey' },
]
