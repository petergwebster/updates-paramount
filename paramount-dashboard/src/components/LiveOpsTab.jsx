import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import {
  C, fmt, isoDate, mondayOf,
  weekLabel,
  DAY_NAMES_FULL, dayOfWeekFiscal,
  PASSAIC_OPERATORS, BNY_OPERATORS_ALL,

  STATUS_GOOD, STATUS_WARN,} from '../lib/scheduleUtils'
import { loadWeekDailyOps, upsertDailyOp, loadWeekDailyOpLines, insertDailyOpLine, updateDailyOpLine, deleteDailyOpLine, deriveColorYards, loadWeekDailyOpNotes, insertDailyOpNote, updateDailyOpNote, deleteDailyOpNote, NOTE_CATEGORIES } from '../lib/dailyOps'
import { weeklyBudgetYards, weeklyBudgetColorYards } from '../lib/budgets'

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
  { code: 'Dakota Kai', capacity: 500 }, { code: 'Dementia', capacity: 500 },
  { code: 'Ember', capacity: 500 }, { code: 'Ivy Nile', capacity: 500 },
  { code: 'Jacy Jayne', capacity: 500 }, { code: 'Ruby', capacity: 500 },
  { code: 'Valhalla', capacity: 500 }, { code: 'XIA', capacity: 500 },
  { code: 'Apollo', capacity: 500 }, { code: 'Nemesis', capacity: 500 },
  { code: 'Poseidon', capacity: 500 }, { code: 'Zoey', capacity: 500 },
]

// ═══════════════════════════════════════════════════════════════════════════
// LiveOpsTab — daily actuals entry for Passaic (Sami) and BNY (Chandler)
// ═══════════════════════════════════════════════════════════════════════════
export default function LiveOpsTab({ currentUser } = {}) {
  const [site, setSite] = useState('passaic')
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date(); d.setHours(0,0,0,0); return d
  })
  const [dailyOps, setDailyOps] = useState([])
  const [opLines, setOpLines] = useState([])
  const [opNotes, setOpNotes] = useState([])
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
      // Only jump BACK to the most recent PAST planned week (salvage case: today's
      // week has nothing scheduled yet). NEVER jump AHEAD of today — that landed
      // Live Ops on a barely-planned future week instead of the active current
      // week. Actuals default to today; pre-planning a future week is reached via
      // "Next week".
      if (mondayOf(latestWeekStart).getTime() < todayWeekStart.getTime()) {
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
        const opLineRows = await loadWeekDailyOpLines(site, weekStart)
        const opNoteRows = await loadWeekDailyOpNotes(site, weekStart)
        const { data: asn } = await supabase
          .from('sched_assignments')
          .select('*')
          .eq('site', site)
          .eq('week_start', isoDate(weekStart))
        if (cancelled) return
        setDailyOps(ops || [])
        setOpLines(opLineRows || [])
        setOpNotes(opNoteRows || [])
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
  // Target precedence (Passaic):
  //   1. explicit op.planned_yards (Sami's Live-Ops-side override)
  //   2. cell-level assignments — assignments matching (table, day, shift).
  //      Per Peter 5/2/2026: "once Wendy schedules, that becomes the target."
  //      This applies to 2nd shift and Sat/Sun cells too — anywhere Wendy
  //      explicitly placed work in CrewModal.
  //   3. weekly ÷ 5 fallback (1st shift Mon-Fri only) — used when there are
  //      table-level assignments but no day-of-week breakdown yet.
  //   4. none.
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
        let plannedSource = 'none'  // 'explicit' | 'scheduled' | 'derived' | 'none'
        let plannedDetails = []
        let cellAsg = []   // dropdown options for the per-PO lines
        let seedAsg = []   // day-specific placements → pre-seed one line each

        if (isPassaic) {
          // Passaic: prefer explicit daily target. If not set, prefer
          // cell-level assignments (Wendy's CrewModal placements). Only fall
          // back to weekly÷5 when neither is set.
          const onTable = assignments.filter(a => a.table_code === t.code)
          const onCellThisShift = assignments.filter(a =>
            a.table_code === t.code &&
            a.day_of_week === dayOfWeek &&
            ((a.shift || '1st') === shift)
          )
          // Plan details: prefer cell-specific PO list when we have one;
          // otherwise show all POs assigned to this table (1st-shift row only).
          if (onCellThisShift.length > 0) {
            plannedDetails = onCellThisShift.map(a => a.line_description || a.po_number)
          } else {
            plannedDetails = shift === '1st' ? onTable.map(a => a.line_description || a.po_number) : []
          }
          // Dropdown options: day-specific placements if any, else the table's
          // full PO list on 1st shift (Passaic POs are usually assigned table-
          // wide, not pinned to a weekday). Pre-seed only the day-specific ones
          // so a table with many weekly POs doesn't spawn a blank line each.
          cellAsg = onCellThisShift.length > 0 ? onCellThisShift : (shift === '1st' ? onTable : [])
          seedAsg = onCellThisShift

          if (op?.planned_yards != null) {
            plannedYards = Number(op.planned_yards)
            plannedSource = 'explicit'
          } else {
            const cellPlanned = onCellThisShift.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
            if (cellPlanned > 0) {
              plannedYards = cellPlanned
              plannedSource = 'scheduled'
            } else if (shift === '1st' && PRODUCTION_WEEKDAYS.includes(dayOfWeek)) {
              const weekly = onTable.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
              if (weekly > 0) {
                plannedYards = Math.round(weekly / 5)
                plannedSource = 'derived'
              }
            }
          }
        } else {
          // BNY: day-specific assignments, single shift
          const onCell = assignments.filter(a =>
            a.table_code === t.code && a.day_of_week === dayOfWeek
          )
          plannedYards = onCell.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
          plannedSource = plannedYards > 0 ? 'scheduled' : 'none'
          plannedDetails = onCell.map(a => a.line_description || a.po_number)
          cellAsg = onCell
          seedAsg = onCell
        }

        m[`${t.code}|${shift}`] = { op, plannedYards, plannedSource, plannedDetails, cellAssignments: cellAsg, seedAssignments: seedAsg }
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

  // Saved production lines for a cell — day-specific (lines are keyed by day).
  const cellLinesFor = (tableCode, shift) => opLines.filter(l =>
    l.table_code === tableCode && l.day_of_week === dayOfWeek && (l.shift || '1st') === shift)

  // Saved categorized notes for a cell — same day-specific keying.
  const cellNotesFor = (tableCode, shift) => opNotes.filter(n =>
    n.table_code === tableCode && n.day_of_week === dayOfWeek && (n.shift || '1st') === shift)

  return (
    <div style={{ padding: 20, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif', margin: 0, marginBottom: 4 }}>
          Live Ops — Daily Actuals
        </h2>
        <div style={{ fontSize: 13, color: C.inkMid }}>
          End-of-shift entry for what actually happened. Yards produced, waste, who was on the table, and any notes worth remembering. Weekly roll-ups, day-by-day grids, and the notes panel live on Heartbeat.
        </div>
      </div>

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

      {/* ───────── Budget / Scheduled / Actual KPI strip ─────────
          Three-layer comparison most prominent at top of page.
            BUDGET    = annual flat-line plan (canonical, from budgets.js)
            SCHEDULED = sum of Wendy/Chandler's plan for this week
            ACTUAL    = sum of Live Ops actuals for this week
          Shows yards always; color-yards on the Passaic site only (digital
          is single-pass — color-yards is meaningless for BNY).               */}
      {!loading && <KpiStrip site={site} weekStart={weekStart} dailyOps={dailyOps} opLines={opLines} assignments={assignments} />}

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
                  cellAssignments={firstCell?.cellAssignments || []}
                  seedAssignments={firstCell?.seedAssignments || []}
                  cellLines={cellLinesFor(t.code, '1st')}
                  cellNotes={cellNotesFor(t.code, '1st')}
                  weekStart={weekStart}
                  dayOfWeek={dayOfWeek}
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
                    cellAssignments={secondCell?.cellAssignments || []}
                    seedAssignments={secondCell?.seedAssignments || []}
                    cellLines={cellLinesFor(t.code, '2nd')}
                    cellNotes={cellNotesFor(t.code, '2nd')}
                    weekStart={weekStart}
                    dayOfWeek={dayOfWeek}
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

function OpsRow({ table, site, shift, plannedYards, plannedSource, plannedDetails, op, cellAssignments = [], seedAssignments = [], cellLines = [], cellNotes = [], weekStart, dayOfWeek, canEnterActuals, currentUser, onSave }) {
  // Cell-level fields — crew + notes stay per table/day/shift.
  const [op1, setOp1]       = useState(op?.operator_1 ?? '')
  const [op2, setOp2]       = useState(op?.operator_2 ?? '')
  // Categorized notes (child table). Each: { _key, id|null, category, note_text }.
  const [noteRows, setNoteRows] = useState([])
  const [deletedNoteIds, setDeletedNoteIds] = useState([])
  // Note delegation v1 (Wendy 4/2026): assign a note to one of four roles.
  const [assignedTo, setAssignedTo] = useState(op?.note_assigned_to ?? '')
  const [noteStatus, setNoteStatus] = useState(op?.note_status ?? null)
  const [notesScope, setNotesScope] = useState(null)  // null=closed | { key, label, po_number, item_sku, color, line_description }
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)

  // Production-by-PO lines. Each: { _key, id|null, po_number, item_sku, color,
  // line_description, actual_yards, waste_yards }. The header's actual_yards /
  // waste_yards are the ROLLED-UP sums of these, so every existing reader keeps
  // working. deletedIds tracks server rows removed this edit session.
  const [lines, setLines] = useState([])
  const [deletedIds, setDeletedIds] = useState([])
  const keyRef = useRef(0)
  const noteKeyRef = useRef(0)

  const isSecondShift = shift === '2nd'

  // Stable signatures so the seed effect re-runs only when the cell identity
  // or its server-side data changes — not on every parent render (which would
  // wipe in-progress typing).
  const linesSig = cellLines.map(l => l.id).join(',')
  const seedSig = seedAssignments.map(a => a.id).join(',')
  const notesSig = cellNotes.map(n => n.id).join(',')

  useEffect(() => {
    const mk = (o) => ({ _key: `l${keyRef.current++}`, ...o })
    let seed
    if (cellLines.length > 0) {
      seed = cellLines.map(l => mk({
        id: l.id,
        po_number: l.po_number, item_sku: l.item_sku, color: l.color,
        line_description: l.line_description,
        actual_yards: l.actual_yards ?? '', waste_yards: l.waste_yards ?? '',
      }))
    } else if (op?.actual_yards != null || op?.waste_yards != null) {
      // Legacy lump entry (header total, no lines) — surface as one editable
      // line so nothing is lost; migrates to a real line on next save.
      seed = [mk({
        id: null, po_number: null, item_sku: null, color: null,
        line_description: 'Recorded total',
        actual_yards: op.actual_yards ?? '', waste_yards: op.waste_yards ?? '',
      })]
    } else if (seedAssignments.length > 0) {
      // Day-specific placements — pre-seed one blank line per planned PO so the
      // operator just fills actuals. (Table-level-only POs seed a single blank
      // line instead; they're still pickable from the dropdown.)
      seed = seedAssignments.map(a => mk({
        id: null,
        po_number: a.po_number || null, item_sku: a.item_sku || null, color: a.color || null,
        line_description: a.line_description || a.po_number || null,
        actual_yards: '', waste_yards: '',
      }))
    } else {
      seed = [mk({ id: null, po_number: null, item_sku: null, color: null, line_description: null, actual_yards: '', waste_yards: '' })]
    }
    setLines(seed)
    setDeletedIds([])
    setOp1(op?.operator_1 ?? '')
    setOp2(op?.operator_2 ?? '')
    // Seed categorized notes from the child table for this cell; fall back to
    // the legacy header note as one 'Other' note so nothing's hidden.
    const nmk = (o) => ({ _key: `n${noteKeyRef.current++}`, ...o })
    if (cellNotes.length > 0) {
      setNoteRows(cellNotes.slice().sort((a, b) => (a.id || 0) - (b.id || 0))
        .map(n => nmk({ id: n.id, category: n.category || 'Other', note_text: n.note_text || '',
          po_number: n.po_number || null, item_sku: n.item_sku || null, color: n.color || null, line_description: n.line_description || null })))
    } else if (op?.notes && op.notes.trim()) {
      setNoteRows([nmk({ id: null, category: 'Other', note_text: op.notes.trim(), po_number: null, item_sku: null, color: null, line_description: null })])
    } else {
      setNoteRows([])
    }
    setDeletedNoteIds([])
    setAssignedTo(op?.note_assigned_to ?? '')
    setNoteStatus(op?.note_status ?? null)
    setNotesScope(null)
    setSavedAt(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op?.id, dayOfWeek, shift, table.code, linesSig, seedSig, notesSig])

  function updateLine(key, patch) {
    setLines(prev => prev.map(l => l._key === key ? { ...l, ...patch } : l))
  }
  function pickPO(key, poKey) {
    if (poKey === '__other') {
      updateLine(key, { po_number: null, item_sku: null, color: null, line_description: null })
      return
    }
    const a = cellAssignments.find(x => `${x.po_number}|${x.item_sku || ''}|${x.color || ''}` === poKey)
    if (a) updateLine(key, {
      po_number: a.po_number, item_sku: a.item_sku || null, color: a.color || null,
      line_description: a.line_description || a.po_number || null,
    })
  }
  function addLine() {
    setLines(prev => [...prev, { _key: `l${keyRef.current++}`, id: null, po_number: null, item_sku: null, color: null, line_description: null, actual_yards: '', waste_yards: '' }])
  }
  function removeLine(key) {
    setLines(prev => {
      const row = prev.find(l => l._key === key)
      if (row?.id) setDeletedIds(d => [...d, row.id])
      return prev.filter(l => l._key !== key)
    })
  }

  // A note is scoped to a PO line (po_number set) or is a table-general note
  // (po_number null). The key aligns with the line signature used elsewhere.
  const noteScopeKey = (n) => (n.po_number ? `${n.po_number}|${n.item_sku || ''}|${n.color || ''}` : '__general')
  const notesInScope = notesScope ? noteRows.filter(n => noteScopeKey(n) === notesScope.key) : []

  function addNote() {
    const s = notesScope || {}
    setNoteRows(prev => [...prev, {
      _key: `n${noteKeyRef.current++}`, id: null, category: 'Other', note_text: '',
      po_number: s.po_number || null, item_sku: s.item_sku || null, color: s.color || null, line_description: s.line_description || null,
    }])
  }
  function updateNote(key, patch) {
    setNoteRows(prev => prev.map(n => n._key === key ? { ...n, ...patch } : n))
  }
  function removeNote(key) {
    setNoteRows(prev => {
      const row = prev.find(n => n._key === key)
      if (row?.id) setDeletedNoteIds(d => [...d, row.id])
      return prev.filter(n => n._key !== key)
    })
  }
  // Denormalized header mirror: "[Category] text" per note, newline-joined, so
  // legacy readers (Heartbeat, AI recent-actuals) still show something useful.
  const notesText = noteRows
    .filter(n => (n.note_text || '').trim())
    .map(n => `${n.po_number ? `[${n.category} · ${n.po_number}]` : `[${n.category}]`} ${n.note_text.trim()}`)
    .join('\n')

  const num = (v) => (v === '' || v == null ? null : Number(v))
  const isBlankLine = (l) => num(l.actual_yards) == null && num(l.waste_yards) == null && !l.po_number && !l.line_description
  const rolledActual = lines.reduce((s, l) => s + (num(l.actual_yards) || 0), 0)
  const rolledWaste  = lines.reduce((s, l) => s + (num(l.waste_yards) || 0), 0)
  const anyActual    = lines.some(l => num(l.actual_yards) != null)
  const anyWaste     = lines.some(l => num(l.waste_yards) != null)

  async function handleSave() {
    setSaving(true)
    try {
      // 1) Persist production lines (insert new, update existing, delete
      //    removed). Skip fully-blank rows.
      const cellKey = { site, week_start: isoDate(weekStart), table_code: table.code, day_of_week: dayOfWeek, shift }
      const nextLines = [...lines]
      for (let i = 0; i < nextLines.length; i++) {
        const l = nextLines[i]
        if (isBlankLine(l)) continue
        const payload = {
          ...cellKey,
          po_number: l.po_number || null,
          item_sku: l.item_sku || null,
          color: l.color || null,
          line_description: l.line_description || null,
          actual_yards: num(l.actual_yards),
          waste_yards: num(l.waste_yards),
        }
        if (l.id) {
          await updateDailyOpLine(l.id, payload)
        } else {
          const saved = await insertDailyOpLine(payload)
          nextLines[i] = { ...l, id: saved.id }
        }
      }
      for (const id of deletedIds) await deleteDailyOpLine(id)
      setLines(nextLines)
      setDeletedIds([])

      // 1b) Persist categorized notes (insert new, update existing, delete
      //     removed). Skip rows with no text.
      const noteCellKey = { site, week_start: isoDate(weekStart), table_code: table.code, day_of_week: dayOfWeek, shift }
      const nextNotes = [...noteRows]
      for (let i = 0; i < nextNotes.length; i++) {
        const n = nextNotes[i]
        if (!(n.note_text || '').trim()) continue
        const payload = { ...noteCellKey, category: n.category || 'Other', note_text: n.note_text.trim(), recorded_by: currentUser || null,
          po_number: n.po_number || null, item_sku: n.item_sku || null, color: n.color || null, line_description: n.line_description || null }
        if (n.id) {
          await updateDailyOpNote(n.id, payload)
        } else {
          const saved = await insertDailyOpNote(payload)
          nextNotes[i] = { ...n, id: saved.id }
        }
      }
      for (const id of deletedNoteIds) await deleteDailyOpNote(id)
      setNoteRows(nextNotes)
      setDeletedNoteIds([])

      // 2) Roll lines up into the header + save crew/notes. Writing the header
      //    actual_yards / waste_yards here keeps Heartbeat, the KPI strip,
      //    scorecards, and Claude's reader correct.
      let nextStatus = noteStatus
      if (assignedTo && notesText) { if (nextStatus !== 'resolved') nextStatus = 'open' }
      else nextStatus = null
      const patch = {
        operator_1: op1 || null,
        operator_2: op2 || null,
        actual_yards: anyActual ? rolledActual : null,
        waste_yards: anyWaste ? rolledWaste : null,
        notes: notesText || null,
        note_assigned_to: assignedTo || null,
        note_status: nextStatus,
      }
      await onSave(patch)

      // 3) Slack ping — only on a new/changed OPEN note assignment.
      const wasAssignedToSomeone = !!op?.note_assigned_to
      const assigneeChanged = (op?.note_assigned_to || '') !== (assignedTo || '')
      if (assignedTo && nextStatus === 'open' && (assigneeChanged || !wasAssignedToSomeone)) {
        fetch('/api/slack-note-notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assignedTo,
            assignedBy: currentUser || 'Unknown user',
            site,
            tableLabel: table.label || table.code,
            dateLabel: op?.date_label || '',
            noteText: notesText,
          }),
        }).catch(() => {})
      }
      setNoteStatus(nextStatus)
      setSavedAt(Date.now())
    } catch (e) {
      alert('Save failed: ' + (e.message || e))
    } finally {
      setSaving(false)
    }
  }

  // Digital operators aren't machine-scoped — any digital operator can run any
  // digital machine at either site (Peter 6/30). Hand-screen stays Passaic-only.
  const operatorList = site === 'passaic' ? PASSAIC_OPERATORS : BNY_OPERATORS_ALL

  const actual = anyActual ? rolledActual : null
  const variance = actual != null ? actual - plannedYards : null
  const varianceColor = variance == null ? C.inkLight
    : Math.abs(variance) < 50 ? C.sage
    : variance > 0 ? C.gold : C.rose
  const varianceLabel = variance == null ? null
    : variance === 0 ? 'on plan'
    : (variance > 0 ? '+' : '') + fmt(variance) + ' vs plan'

  // PO dropdown options for a line: planned POs on this cell + "Other".
  const poOptions = cellAssignments.map(a => ({
    key: `${a.po_number}|${a.item_sku || ''}|${a.color || ''}`,
    label: (a.line_description || a.po_number || '—') + (a.po_number ? ` · ${a.po_number}` : ''),
  }))
  const lineKeyOf = (l) => (l.po_number ? `${l.po_number}|${l.item_sku || ''}|${l.color || ''}` : '__other')

  // Passaic lines get a read-only color-yards column (yards × the PO's planned
  // cy/yd ratio). BNY is digital — no color-yards — so its line grid stays 4-col.
  const lineGridCols = site === 'passaic'
    ? 'minmax(180px, 1fr) 78px 78px 58px 46px 28px'
    : 'minmax(200px, 1fr) 90px 90px 46px 28px'

  return (
    <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '150px minmax(120px, 1fr) 120px 130px 130px 110px 80px', gap: 12, alignItems: 'start' }}>
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

      {/* Actual (total) — read-only; sum of the PO lines below */}
      <div>
        <label style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Actual (total)</label>
        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'Georgia,serif', color: actual != null ? C.ink : C.inkLight, lineHeight: 1.4 }}>
          {actual != null ? fmt(actual) : '—'}
          {anyWaste && <span style={{ fontSize: 10, color: C.inkLight, fontWeight: 400, marginLeft: 6 }}>· {fmt(rolledWaste)} waste</span>}
        </div>
        {varianceLabel && (
          <div style={{ fontSize: 9, color: varianceColor, fontWeight: 600, marginTop: 2 }}>{varianceLabel}</div>
        )}
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

      {/* Table-general notes — non-PO stuff (crew change, table-wide setup).
          PO-specific notes live on each PO line below. */}
      <div>
        <label style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Table notes</label>
        {(() => {
          const generalNotes = noteRows.filter(n => !n.po_number && (n.note_text || '').trim())
          const openGeneral = () => setNotesScope({ key: '__general', label: 'Table / general', po_number: null, item_sku: null, color: null, line_description: null })
          return generalNotes.length > 0 ? (
            <button onClick={openGeneral} title={generalNotes.map(n => `[${n.category}] ${n.note_text}`).join('\n')}
              style={{ width: '100%', padding: '6px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, color: C.ink, background: C.warm, cursor: 'pointer', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'inherit', display: 'block' }}>
              ✏️ {`${generalNotes.length} note${generalNotes.length > 1 ? 's' : ''} · ${[...new Set(generalNotes.map(n => n.category))].slice(0, 2).join(', ')}`}
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
            <button onClick={openGeneral}
              style={{ width: '100%', padding: '6px 8px', border: `1px dashed ${C.border}`, borderRadius: 4, fontSize: 11, color: C.inkLight, background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', display: 'block' }}>
              + Table note
            </button>
          )
        })()}
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

      {/* Production-by-PO lines — one row per PO/SKU that ran on this table
          today; the header total above is their sum. Spans the full width. */}
      <div style={{ gridColumn: '1 / -1', marginTop: 10, paddingTop: 8, borderTop: `1px dashed ${C.border}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: lineGridCols, gap: 8, fontSize: 8, fontWeight: 700, color: C.inkLight, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
          <span>PO / job on this table today</span>
          <span style={{ textAlign: 'right' }}>Actual yds</span>
          <span style={{ textAlign: 'right' }}>Waste</span>
          {site === 'passaic' && <span style={{ textAlign: 'right' }}>Color-yds</span>}
          <span style={{ textAlign: 'center' }}>Note</span>
          <span />
        </div>
        {lines.map(l => {
          const matchedAsg = cellAssignments.find(a => `${a.po_number}|${a.item_sku || ''}|${a.color || ''}` === lineKeyOf(l))
          const lineCY = site === 'passaic' ? deriveColorYards(num(l.actual_yards), matchedAsg) : null
          return (
          <div key={l._key} style={{ display: 'grid', gridTemplateColumns: lineGridCols, gap: 8, alignItems: 'center', marginBottom: 5 }}>
            {poOptions.length > 0 ? (
              <select value={lineKeyOf(l)} onChange={e => pickPO(l._key, e.target.value)} disabled={!canEnterActuals}
                style={{ width: '100%', padding: '5px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, background: '#fff', boxSizing: 'border-box' }}>
                {/* Ramon's request: show the planned yards (and color-yards on
                    Passaic) right in the dropdown, so the floor can see what the
                    job was scheduled for while entering what actually ran. */}
                {poOptions.map(o => {
                  const a = cellAssignments.find(x => `${x.po_number}|${x.item_sku || ''}|${x.color || ''}` === o.key)
                  const pYd = a ? Number(a.planned_yards || 0) : 0
                  const pCy = a ? Number(a.planned_cy || 0) : 0
                  const qty = pYd > 0
                    ? ` — ${fmt(pYd)} yd${(site === 'passaic' && pCy > 0) ? ` / ${fmt(pCy)} cy` : ''}`
                    : ''
                  return <option key={o.key} value={o.key}>{o.label}{qty}</option>
                })}
                <option value="__other">Other / unplanned…</option>
              </select>
            ) : (
              <input type="text" value={l.line_description || ''} onChange={e => updateLine(l._key, { line_description: e.target.value })}
                placeholder="PO or description (optional)" disabled={!canEnterActuals}
                style={{ width: '100%', padding: '5px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, boxSizing: 'border-box' }} />
            )}
            <input type="number" value={l.actual_yards} onChange={e => updateLine(l._key, { actual_yards: e.target.value })}
              placeholder="—" min={0} step="any" disabled={!canEnterActuals}
              style={{ width: '100%', padding: '5px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, textAlign: 'right', boxSizing: 'border-box' }} />
            <input type="number" value={l.waste_yards} onChange={e => updateLine(l._key, { waste_yards: e.target.value })}
              placeholder="0" min={0} step="any" disabled={!canEnterActuals}
              style={{ width: '100%', padding: '5px 8px', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, textAlign: 'right', boxSizing: 'border-box' }} />
            {site === 'passaic' && (
              <div title={matchedAsg ? 'yards × planned colors' : 'no planned colors for this line'}
                style={{ fontSize: 12, textAlign: 'right', color: lineCY != null ? C.inkMid : C.inkLight, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {lineCY != null ? fmt(lineCY) : '—'}
              </div>
            )}
            {(() => {
              if (!l.po_number) return <span style={{ fontSize: 10, color: C.inkLight, textAlign: 'center' }}>—</span>
              const lk = lineKeyOf(l)
              const cnt = noteRows.filter(n => noteScopeKey(n) === lk && (n.note_text || '').trim()).length
              return (
                <button
                  onClick={() => setNotesScope({ key: lk, label: l.line_description || l.po_number, po_number: l.po_number, item_sku: l.item_sku || null, color: l.color || null, line_description: l.line_description || null })}
                  title={cnt ? `${cnt} note${cnt > 1 ? 's' : ''} on this PO` : 'Add a note for this PO'}
                  style={{ padding: '3px 4px', border: `1px ${cnt ? 'solid' : 'dashed'} ${C.border}`, borderRadius: 4, fontSize: 10, color: cnt ? C.ink : C.inkLight, background: cnt ? C.warm : 'transparent', cursor: 'pointer', lineHeight: 1, whiteSpace: 'nowrap' }}>
                  {cnt ? `📝 ${cnt}` : '📝 +'}
                </button>
              )
            })()}
            <button onClick={() => removeLine(l._key)} title="Remove line"
              style={{ background: 'transparent', border: 'none', color: C.inkLight, fontSize: 15, cursor: 'pointer', lineHeight: 1 }}>×</button>
          </div>
          )
        })}
        <button onClick={addLine} disabled={!canEnterActuals}
          style={{ marginTop: 2, padding: '3px 10px', fontSize: 10, fontWeight: 600, color: C.navy, background: 'transparent', border: `1px dashed ${C.border}`, borderRadius: 3, cursor: 'pointer', letterSpacing: '0.03em' }}>
          + Add PO / job line
        </button>
      </div>

      {/* Notes pop-out modal — backdrop click closes without saving (escape
          hatch). The "Save & close" button persists the entire row, then
          closes — which means the modal alone is sufficient to commit notes
          without needing the row's main Save button. */}
      {notesScope && (
        <div onClick={(e) => e.target === e.currentTarget && setNotesScope(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, width: 'min(640px, 94vw)', maxHeight: '92vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '14px 18px', background: C.navy, color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'Georgia,serif' }}>
                  Notes · {(table.label || table.code)}{notesScope.key !== '__general' ? ` — ${notesScope.label}` : ''}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>
                  {notesScope.key === '__general'
                    ? 'Table-wide notes — crew changes, setup, anything not tied to one PO.'
                    : `Notes for this PO${notesScope.po_number ? ` · ${notesScope.po_number}` : ''}.`}
                </div>
              </div>
              {assignedTo && noteStatus && (
                <span style={{ fontSize: 10, padding: '4px 10px', borderRadius: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', flexShrink: 0,
                  background: noteStatus === 'resolved' ? STATUS_GOOD : STATUS_WARN,
                  color: '#fff',
                }}>
                  {noteStatus === 'resolved' ? '✓ Resolved' : '○ Open'}
                </span>
              )}
            </div>
            <div style={{ padding: 18 }}>
              {/* Categorized notes — one row each: category + narrative. Add as
                  many as needed; the weekly rollup ranks by category. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {notesInScope.length === 0 && (
                  <div style={{ fontSize: 12, color: C.inkLight, fontStyle: 'italic' }}>No notes yet — add one below.</div>
                )}
                {notesInScope.map((n, idx) => (
                  <div key={n._key} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, background: C.warm }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <select value={n.category} onChange={e => updateNote(n._key, { category: e.target.value })}
                        style={{ padding: '5px 8px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontWeight: 600, background: '#fff', color: C.ink, cursor: 'pointer' }}>
                        {NOTE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <div style={{ flex: 1 }} />
                      <button onClick={() => removeNote(n._key)} title="Remove note"
                        style={{ background: 'transparent', border: 'none', color: C.inkLight, fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>×</button>
                    </div>
                    <textarea value={n.note_text} onChange={e => updateNote(n._key, { note_text: e.target.value })}
                      autoFocus={idx === notesInScope.length - 1}
                      rows={3} placeholder="What happened — waste cause, setup issue, interruption…"
                      style={{ width: '100%', padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', minHeight: 64, lineHeight: 1.5, background: '#fff' }} />
                  </div>
                ))}
                <button onClick={addNote}
                  style={{ alignSelf: 'flex-start', padding: '5px 12px', fontSize: 11, fontWeight: 600, color: C.navy, background: 'transparent', border: `1px dashed ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>
                  + Add note
                </button>
              </div>

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
                  <button onClick={() => setNotesScope(null)} disabled={saving}
                    style={{ padding: '8px 14px', background: 'transparent', color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
                    Cancel
                  </button>
                  <button onClick={async () => { await handleSave(); setNotesScope(null) }} disabled={saving}
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


/* ═════════════════════════════════════════════════════════════════════════
   KpiStrip — three-card row at the top of the entry view.

   Cards: Budget · Scheduled · Actual
     Budget    = canonical FY2026 weekly plan (from src/lib/budgets.js).
                 Same value every week — annual flat-line.
     Scheduled = sum of sched_assignments.planned_yards for this site/week.
                 What Wendy / Chandler committed to.
     Actual    = sum of sched_daily_ops.actual_yards for this site/week.
                 What came off the floor.

   Variance pills below the headline numbers:
     "vs Budget" on the Scheduled card  → ambition gap (is the plan enough?)
     "vs Scheduled" on the Actual card  → execution gap (are we hitting plan?)

   Color-yards row appears only on Passaic (digital is single-pass — color-
   yards is meaningless for BNY). All cards size equally.
   ═════════════════════════════════════════════════════════════════════════ */

function KpiStrip({ site, weekStart, dailyOps, opLines = [], assignments }) {
  const showCY = site === 'passaic'

  // Site-level totals from canonical budgets.js
  const budgetYards      = weeklyBudgetYards(site)
  const budgetColorYards = showCY ? weeklyBudgetColorYards() : null

  // Scheduled — sum of assignments. For Passaic also sum planned_cy.
  const scheduledYards = assignments
    .filter(a => a.site === site)
    .reduce((s, a) => s + Number(a.planned_yards || 0), 0)
  const scheduledColorYards = showCY
    ? assignments.filter(a => a.site === site).reduce((s, a) => s + Number(a.planned_cy || 0), 0)
    : null

  // Actual — sum of daily ops actual_yards. Color-yards is interpolated from
  // each cell's planned ratio (same approach as the operator scorecard).
  const actualYards = dailyOps
    .filter(o => o.site === site)
    .reduce((s, o) => s + Number(o.actual_yards || 0), 0)
  // Actual color-yards — sum the per-PO line color-yards (yards × the PO's
  // planned cy/yd ratio). Passaic POs are assigned table-wide (not day-pinned),
  // so we match each line to its table assignment by PO/SKU/color — the same
  // match the per-line Color-yds column uses, so the headline ties to the lines
  // exactly. Replaces the old header-vs-day-pinned derivation that fell back to
  // zero for Passaic (POs aren't pinned to a weekday).
  let actualColorYards = null
  if (showCY) {
    actualColorYards = 0
    for (const l of opLines) {
      if (l.site !== site) continue
      const yd = Number(l.actual_yards || 0)
      if (yd <= 0) continue
      const asg = assignments.find(a =>
        a.site === site &&
        a.table_code === l.table_code &&
        (a.po_number || '') === (l.po_number || '') &&
        (a.item_sku || '') === (l.item_sku || '') &&
        (a.color || '') === (l.color || '')
      )
      const cy = deriveColorYards(yd, asg)
      if (cy != null) actualColorYards += cy
    }
  }

  // Variance computations — keep nullable so the UI can render "—" cleanly
  const schedVsBudget = budgetYards > 0 ? scheduledYards - budgetYards : null
  const actualVsSched = scheduledYards > 0 ? actualYards   - scheduledYards : null
  const schedVsBudgetCY = (showCY && budgetColorYards > 0) ? scheduledColorYards - budgetColorYards : null
  const actualVsSchedCY = (showCY && scheduledColorYards > 0) ? actualColorYards - scheduledColorYards : null

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
      <KpiCard
        label="Budget"
        sublabel="Annual plan · weekly target"
        accent={C.inkLight}
        primary={budgetYards}
        primaryUnit="yds"
        secondary={showCY ? budgetColorYards : null}
        secondaryUnit="cyds"
        secondaryLabel={showCY ? 'Color-yards' : null}
      />
      <KpiCard
        label="Scheduled"
        sublabel="Wendy/Chandler's plan this week"
        accent={C.navy}
        primary={scheduledYards}
        primaryUnit="yds"
        primaryVariance={schedVsBudget}
        primaryVarianceLabel="vs Budget"
        secondary={showCY ? scheduledColorYards : null}
        secondaryUnit="cyds"
        secondaryLabel={showCY ? 'Color-yards' : null}
        secondaryVariance={schedVsBudgetCY}
      />
      <KpiCard
        label="Actual"
        sublabel="Off the floor this week"
        accent={C.amber}
        primary={actualYards}
        primaryUnit="yds"
        primaryVariance={actualVsSched}
        primaryVarianceLabel="vs Scheduled"
        secondary={showCY ? actualColorYards : null}
        secondaryUnit="cyds"
        secondaryLabel={showCY ? 'Color-yards' : null}
        secondaryVariance={actualVsSchedCY}
        emptyOK
      />
    </div>
  )
}

function KpiCard({
  label, sublabel, accent,
  primary, primaryUnit, primaryVariance, primaryVarianceLabel,
  secondary, secondaryUnit, secondaryLabel, secondaryVariance,
  emptyOK,
}) {
  const hasData = primary > 0 || emptyOK
  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${C.border}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 8,
      padding: '14px 16px',
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 10, color: C.inkLight, marginBottom: 10, fontStyle: 'italic' }}>
        {sublabel}
      </div>

      {/* Primary metric — yards */}
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'Georgia, serif', color: hasData ? C.ink : C.inkLight, lineHeight: 1.1 }}>
        {hasData ? fmt(primary) : '—'}
        <span style={{ fontSize: 12, fontWeight: 400, color: C.inkLight, marginLeft: 4 }}>{primaryUnit}</span>
      </div>
      {primaryVariance != null && (
        <VarianceChip delta={primaryVariance} label={primaryVarianceLabel} unit={primaryUnit} />
      )}

      {/* Secondary metric — color-yards (Passaic only) */}
      {secondary != null && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px dashed ${C.border}` }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 2 }}>
            {secondaryLabel}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, fontFamily: 'Georgia, serif', color: secondary > 0 ? C.ink : C.inkLight }}>
            {secondary > 0 ? fmt(Math.round(secondary)) : '—'}
            <span style={{ fontSize: 11, fontWeight: 400, color: C.inkLight, marginLeft: 4 }}>{secondaryUnit}</span>
          </div>
          {secondaryVariance != null && (
            <VarianceChip delta={secondaryVariance} unit={secondaryUnit} small />
          )}
        </div>
      )}
    </div>
  )
}

function VarianceChip({ delta, label, unit, small }) {
  const tone = Math.abs(delta) < 1 ? 'neutral'
            : delta < 0 ? 'behind'
            : 'ahead'
  const color = tone === 'behind' ? C.rose
              : tone === 'ahead'  ? C.sage
              : C.inkLight
  const sign = delta > 0 ? '+' : ''
  return (
    <div style={{
      marginTop: 4,
      fontSize: small ? 9 : 10,
      color,
      fontWeight: 600,
    }}>
      {sign}{fmt(Math.round(delta))} {unit}
      {label && <span style={{ color: C.inkLight, fontWeight: 400, marginLeft: 4 }}>{label}</span>}
    </div>
  )
}
