import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'
import { C, fmt, isoDate, weekLabel, addWeeks, defaultSchedulerWeek, DAY_INDEX } from '../lib/scheduleUtils'
import { loadWeekDailyOpLines, deriveColorYards } from '../lib/dailyOps'

// ═══════════════════════════════════════════════════════════════════════════
// StatusTab — "where does each PO stand this week?"
// ═══════════════════════════════════════════════════════════════════════════
// Two independent signals per PO, exactly per Peter's model:
//
//   1. NUMBERS (yards / color-yards). Scheduled vs recorded. Remaining =
//      scheduled − recorded. Recorded actuals ALWAYS burn down remaining —
//      whether or not the line is checked complete. Recording something (even
//      zero) moves the numbers; the checkbox does not.
//
//   2. STATUS PILL (In Progress / Complete). Driven ONLY by the per-line Done
//      checkboxes in Live Ops (sched_daily_ops_lines.is_complete), and ONLY on
//      the LAST day the PO actually ran. Sami ticks "done" on the day the PO
//      finishes — not retroactively on every earlier day it touched — so that
//      final tick is what flips the pill. Nothing ticked = In Progress, even at
//      100% of yards. (Ramon, 7/22: the old rule required every day to be
//      ticked, leaving finished POs stuck In Progress.)
//
// Color-yards is DERIVED, never stored on the PO: deriveColorYards(actual, asg)
// = actual × (planned_cy / planned_yards), per line, then summed. Same function
// and same (table, po, sku, color) match the Live Ops KPI strip uses, so the
// numbers here tie to Live Ops by construction. BNY is digital — no color-yards
// (deriveColorYards returns null) — so those columns show "—".
//
// TONIGHT: the By-PO view (below). The By-Material category scorecard is
// scaffolded as a second button but built next session, after a hand tie-out
// of color-yards-completed-by-category.
// ═══════════════════════════════════════════════════════════════════════════

export default function StatusTab() {
  const [site, setSite] = useState('passaic')
  const [weekStart, setWeekStart] = useState(() => defaultSchedulerWeek())
  const [view, setView] = useState('po')          // 'po' | 'material'
  const [assignments, setAssignments] = useState([])
  const [opLines, setOpLines] = useState([])
  const [loading, setLoading] = useState(false)

  const showCY = site === 'passaic'

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const { data: asn } = await supabase
          .from('sched_assignments')
          .select('*')
          .eq('site', site)
          .eq('week_start', isoDate(weekStart))
        const lines = await loadWeekDailyOpLines(site, weekStart)
        if (cancelled) return
        setAssignments(asn || [])
        setOpLines(lines || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [site, weekStart])

  // Per-PO rollup — the core of the By-PO view.
  const poRows = useMemo(() => {
    // Match an actual line to its plan row the SAME way the KPI strip does, so
    // derived color-yards ties out exactly: (table, po, sku, color).
    const matchAsg = (l) => assignments.find(a =>
      a.table_code === l.table_code &&
      (a.po_number || '') === (l.po_number || '') &&
      (a.item_sku || '') === (l.item_sku || '') &&
      (a.color || '') === (l.color || '')
    )

    // Universe = every PO that's either scheduled or recorded this week. Lines
    // with no po_number ("Other/unplanned") don't create a PO row — they're not
    // a schedulable PO — matching how they're treated everywhere else.
    const poKeys = new Set()
    for (const a of assignments) if (a.po_number) poKeys.add(a.po_number)
    for (const l of opLines) if (l.po_number) poKeys.add(l.po_number)

    const rows = []
    for (const po of poKeys) {
      const asgs = assignments.filter(a => a.po_number === po)
      const lines = opLines.filter(l => l.po_number === po)

      const schedYards = asgs.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
      const schedCY = showCY ? asgs.reduce((s, a) => s + Number(a.planned_cy || 0), 0) : null

      const recYards = lines.reduce((s, l) => s + Number(l.actual_yards || 0), 0)
      const wasteYards = lines.reduce((s, l) => s + Number(l.waste_yards || 0), 0)

      // Recorded color-yards — per line, derived, then summed. Never sum yards
      // and apply one ratio (a multi-SKU PO can carry different ratios per line).
      let recCY = null
      if (showCY) {
        recCY = 0
        for (const l of lines) {
          const yd = Number(l.actual_yards || 0)
          if (yd <= 0) continue
          const cy = deriveColorYards(yd, matchAsg(l))
          if (cy != null) recCY += cy
        }
      }

      // Remaining ALWAYS = scheduled − recorded (independent of checkboxes).
      const remYards = schedYards - recYards
      const remCY = showCY ? (schedCY - recCY) : null

      // Status pill — checkboxes only, and only the LAST day counts.
      //
      // "Last day" = the latest day (by DAY_INDEX) carrying a line with real
      // activity: recorded yards, recorded waste, or an explicit done tick.
      // Empty pre-filled lines are deliberately ignored — BNY seeds a line per
      // scheduled PO per day, so an untouched straggler day must not hold a
      // finished PO open. Every active line ON that last day must be ticked, so
      // a PO running on several tables the final day still needs them all in.
      const activeLines = lines.filter(l =>
        Number(l.actual_yards || 0) > 0 || Number(l.waste_yards || 0) > 0 || l.is_complete
      )
      let lastDayLines = []
      if (activeLines.length > 0) {
        const lastIdx = Math.max(...activeLines.map(l => DAY_INDEX[l.day_of_week] ?? -1))
        lastDayLines = activeLines.filter(l => (DAY_INDEX[l.day_of_week] ?? -1) === lastIdx)
      }
      const isComplete = lastDayLines.length > 0 && lastDayLines.every(l => l.is_complete)
      const lastDayLabel = lastDayLines[0]?.day_of_week || null
      const lastDayDone = lastDayLines.filter(l => l.is_complete).length
      const lastDayTotal = lastDayLines.length
      const doneCount = lines.filter(l => l.is_complete).length
      const totalLines = lines.length

      // Colours finished vs expected (Ramon) — how many screens are down on an
      // in-progress PO. MAX across the PO's lines, never a sum: colours are
      // cumulative progress on the same job ("5 of 6 screens down"), so
      // re-recording on a later day restates the same total rather than adding
      // to it. Expected comes from the SAME planned ratio deriveColorYards uses,
      // so colours-expected and colour-yards can never disagree.
      const colorVals = lines.map(l => l.colors_done).filter(v => v != null && v !== '').map(Number)
      const colorsDone = colorVals.length > 0 ? Math.max(...colorVals) : null
      const pcy = Number(asgs[0]?.planned_cy || 0)
      const pyd = Number(asgs[0]?.planned_yards || 0)
      const colorsExpected = (pcy > 0 && pyd > 0) ? Math.round(pcy / pyd) : null

      const desc = asgs[0]?.line_description || lines[0]?.line_description || po
      const productType = asgs[0]?.product_type || null
      const scheduled = asgs.length > 0

      rows.push({
        po, desc, productType, scheduled,
        schedYards, schedCY, recYards, recCY, wasteYards, remYards, remCY,
        doneCount, totalLines, isComplete, lastDayLabel, lastDayDone, lastDayTotal,
        colorsDone, colorsExpected,
        tables: [...new Set([...asgs.map(a => a.table_code), ...lines.map(l => l.table_code)])].filter(Boolean),
      })
    }

    // In-progress first (that's the work list), then biggest scheduled first.
    rows.sort((a, b) =>
      (a.isComplete ? 1 : 0) - (b.isComplete ? 1 : 0) ||
      b.schedYards - a.schedYards
    )
    return rows
  }, [assignments, opLines, showCY])

  const totals = useMemo(() => {
    const t = { schedYards: 0, recYards: 0, schedCY: 0, recCY: 0, complete: 0, count: poRows.length }
    for (const r of poRows) {
      t.schedYards += r.schedYards
      t.recYards += r.recYards
      if (showCY) { t.schedCY += r.schedCY || 0; t.recCY += r.recCY || 0 }
      if (r.isComplete) t.complete++
    }
    return t
  }, [poRows, showCY])

  return (
    <div style={{ padding: 20, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: C.ink, fontFamily: 'var(--font-display)', margin: 0, marginBottom: 4 }}>
          Status — Where Each PO Stands
        </h2>
        <div style={{ fontSize: 13, color: C.inkMid }}>
          Scheduled vs recorded for the week. Recorded yardage burns down the remaining the moment it's entered; the In&nbsp;Progress / Complete pill is driven by the per-line Done checkboxes in Live Ops.
        </div>
      </div>

      {/* Site toggle + week nav */}
      <div style={{ marginBottom: 16, padding: '12px 16px', background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <SiteChip active={site === 'passaic'} onClick={() => setSite('passaic')} color={C.navy}>Passaic · Screen Print</SiteChip>
          <SiteChip active={site === 'bny'} onClick={() => setSite('bny')} color={C.amber}>BNY · Digital</SiteChip>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setWeekStart(addWeeks(weekStart, -1))}
          style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>← Prev week</button>
        <div style={{ textAlign: 'center', minWidth: 150 }}>
          <div style={{ fontSize: 10, color: C.inkLight, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Week</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, fontFamily: 'var(--font-display)' }}>{weekLabel(weekStart)}</div>
        </div>
        <button onClick={() => setWeekStart(addWeeks(weekStart, 1))}
          style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>Next week →</button>
        <button onClick={() => setWeekStart(defaultSchedulerWeek())}
          style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>Default week</button>
      </div>

      {/* View switcher — By PO (built) / By Material (next session) */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <ViewChip active={view === 'po'} onClick={() => setView('po')}>By PO</ViewChip>
        <ViewChip active={view === 'material'} onClick={() => setView('material')}>By Material</ViewChip>
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: C.inkLight, fontSize: 13 }}>Loading…</div>}

      {!loading && view === 'po' && (
        <ByPoView rows={poRows} totals={totals} showCY={showCY} weekLabelText={weekLabel(weekStart)} />
      )}

      {!loading && view === 'material' && (
        <ByMaterialView assignments={assignments} opLines={opLines} site={site} weekLabelText={weekLabel(weekStart)} />
      )}
    </div>
  )
}

// ─── By-PO view ─────────────────────────────────────────────────────────────

function ByPoView({ rows, totals, showCY, weekLabelText }) {
  if (rows.length === 0) {
    return (
      <div style={{ background: C.parchment, border: `1px solid ${C.border}`, borderRadius: 10, padding: '20px 16px', fontSize: 13, color: C.inkMid }}>
        <strong style={{ color: C.ink }}>Nothing scheduled or recorded for {weekLabelText}.</strong> Once POs are scheduled and actuals start coming in from Live Ops, each PO's progress shows here.
      </div>
    )
  }

  // Grid: PO | Material | Scheduled | Recorded | Remaining | (Passaic: CY sched/rec) | Status
  const gridCols = showCY
    ? 'minmax(200px, 2fr) 110px 92px 92px 92px 110px 150px'
    : 'minmax(220px, 2fr) 120px 100px 100px 100px 150px'

  return (
    <div style={{ background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      {/* Summary strip */}
      <div style={{ padding: '12px 16px', background: C.parchment, borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <SummaryStat label="POs" value={`${totals.complete} / ${totals.count} complete`} />
        <SummaryStat label="Yards" value={`${fmt(totals.recYards)} / ${fmt(totals.schedYards)}`} sub="recorded / scheduled" />
        {showCY && <SummaryStat label="Color-yards" value={`${fmt(Math.round(totals.recCY))} / ${fmt(Math.round(totals.schedCY))}`} sub="recorded / scheduled" />}
      </div>

      {/* Column header */}
      <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 10, padding: '8px 16px', borderBottom: `1px solid ${C.border}`, fontSize: 9, fontWeight: 700, color: C.inkLight, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        <span>PO / job</span>
        <span>Material</span>
        <span style={{ textAlign: 'right' }}>Sched yd</span>
        <span style={{ textAlign: 'right' }}>Rec'd yd</span>
        <span style={{ textAlign: 'right' }}>Rem. yd</span>
        {showCY && <span style={{ textAlign: 'right' }}>CY r/s</span>}
        <span style={{ textAlign: 'center' }}>Status</span>
      </div>

      {rows.map((r, i) => (
        <PoRow key={r.po} r={r} showCY={showCY} gridCols={gridCols} zebra={i % 2 === 1} />
      ))}
    </div>
  )
}

function PoRow({ r, showCY, gridCols, zebra }) {
  const pct = r.schedYards > 0
    ? Math.min(100, Math.round((r.recYards / r.schedYards) * 100))
    : (r.recYards > 0 ? 100 : 0)
  const barColor = r.isComplete ? C.sage : pct > 0 ? C.gold : C.border
  const over = r.recYards > r.schedYards && r.schedYards > 0

  return (
    <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 10, padding: '10px 16px', borderBottom: `1px solid ${C.border}`, alignItems: 'center', background: zebra ? C.cream : 'var(--surface)' }}>
      {/* PO + description + progress bar */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.desc}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ fontSize: 9, fontFamily: 'monospace', color: C.inkLight }}>{r.po}</span>
          {r.tables.length > 0 && <span style={{ fontSize: 9, color: C.inkLight }}>· {r.tables.slice(0, 3).join(', ')}{r.tables.length > 3 ? '…' : ''}</span>}
          {!r.scheduled && <span style={{ fontSize: 8, padding: '0 4px', borderRadius: 2, background: C.amberBg, color: C.amber, fontWeight: 700 }}>UNSCHEDULED</span>}
        </div>
        <div style={{ height: 4, background: C.warm, borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
          <div style={{ width: pct + '%', height: '100%', background: barColor }} />
        </div>
      </div>

      {/* Material */}
      <div style={{ fontSize: 11, color: C.inkMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.productType || '—'}</div>

      {/* Scheduled yards */}
      <div style={{ textAlign: 'right', fontSize: 12, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.schedYards)}</div>

      {/* Recorded yards (+ waste under) */}
      <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: r.recYards > 0 ? C.ink : C.inkLight }}>{r.recYards > 0 ? fmt(r.recYards) : '—'}</div>
        {r.wasteYards > 0 && <div style={{ fontSize: 8, color: C.inkLight }}>{fmt(r.wasteYards)} waste</div>}
      </div>

      {/* Remaining yards */}
      <div style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: over ? C.gold : r.remYards <= 0 ? C.sage : C.inkMid, fontWeight: 600 }}>
        {over ? `+${fmt(r.recYards - r.schedYards)}` : fmt(Math.max(0, r.remYards))}
        {over && <div style={{ fontSize: 8, color: C.gold, fontWeight: 400 }}>over</div>}
      </div>

      {/* Color-yards recorded/scheduled (Passaic only) */}
      {showCY && (
        <div style={{ textAlign: 'right', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: C.inkMid }}>
          {(r.recCY != null || r.schedCY != null)
            ? <>{fmt(Math.round(r.recCY || 0))}<span style={{ color: C.inkLight }}> / {fmt(Math.round(r.schedCY || 0))}</span></>
            : '—'}
        </div>
      )}

      {/* Status pill + lines-done detail */}
      <div style={{ textAlign: 'center' }}>
        <span style={{
          display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 12, letterSpacing: '0.04em',
          background: r.isComplete ? C.sageBg : C.goldBg,
          color: r.isComplete ? C.sage : C.gold,
        }}>
          {r.isComplete ? '✓ Complete' : '○ In Progress'}
        </span>
        <div style={{ fontSize: 9, color: C.inkLight, marginTop: 3 }}>
          {r.lastDayLabel
            ? `${r.lastDayLabel}: ${r.lastDayDone} of ${r.lastDayTotal} done`
            : 'not started'}
        </div>
        {r.lastDayLabel && r.totalLines > r.lastDayTotal && (
          <div style={{ fontSize: 8, color: C.inkLight }}>{r.doneCount}/{r.totalLines} across all days</div>
        )}
        {/* Colours finished vs expected — productivity read on in-progress work.
            Hidden once complete (the pill says it) and when there's no planned
            colour count to compare against. */}
        {!r.isComplete && r.colorsExpected != null && (
          <div style={{ fontSize: 9, marginTop: 3, color: r.colorsDone != null ? C.inkMid : C.inkLight }}>
            <strong style={{ color: r.colorsDone != null ? C.ink : C.inkLight, fontWeight: 700 }}>
              {r.colorsDone != null ? r.colorsDone : '—'}
            </strong>
            {' / '}{r.colorsExpected} colors
          </div>
        )}
      </div>
    </div>
  )
}

// ─── By-Material view ─────────────────────────────────────────────────
// Ramon: "a chart per material (grasscloth, fabric, wallpaper) showing the
// week's trend, completed vs planned."
//
// Category comes from the TABLE CODE prefix — GC → Grasscloth, FAB → Fabric,
// WP → Wallpaper — the same mapping the weekly production summary uses, so the
// two can't disagree. BNY is a single Digital category.
//
// HONEST LIMITATION, surfaced in the UI rather than papered over: Passaic POs
// are usually assigned to a TABLE for the week, not pinned to a weekday. So the
// per-day PLANNED bars only reflect work that was actually day-assigned, and
// anything left unpinned is called out under the chart and counted in the week
// total. The alternative — silently spreading the weekly plan across five days —
// would invent a daily target nobody set. Once Passaic is scheduled by day, the
// planned bars fill in automatically with no code change.
//
// YARDS ONLY for now. The color-yards cut of this same view is deliberately
// held until color-yards-completed-by-category is tied out by hand — it's the
// labor number, and it's headed for Perdoo, so it has to be right before it's
// shown.

const MATERIAL_DEFS = {
  passaic: [
    { key: 'grass',     label: 'Grasscloth', color: C.sage  },
    { key: 'fabric',    label: 'Fabric',     color: C.amber },
    { key: 'wallpaper', label: 'Wallpaper',  color: C.navy  },
  ],
  bny: [
    { key: 'digital',   label: 'Digital',    color: C.navy  },
  ],
}

function materialOfTable(tableCode, site) {
  if (site !== 'passaic') return 'digital'
  const t = String(tableCode || '').toUpperCase()
  if (t.startsWith('GC'))  return 'grass'
  if (t.startsWith('FAB')) return 'fabric'
  if (t.startsWith('WP'))  return 'wallpaper'
  return 'other'
}

function ByMaterialView({ assignments, opLines, site, weekLabelText }) {
  const cats = useMemo(() => {
    const defs = MATERIAL_DEFS[site] || MATERIAL_DEFS.bny
    const blank = () => ({ plannedWeek: 0, plannedByDay: {}, actualByDay: {}, actualWeek: 0, wasteWeek: 0, pos: new Set() })
    const map = {}
    for (const d of defs) map[d.key] = blank()
    map.other = blank()

    for (const a of assignments) {
      const m = map[materialOfTable(a.table_code, site)] || map.other
      const yd = Number(a.planned_yards || 0)
      m.plannedWeek += yd
      if (a.day_of_week) m.plannedByDay[a.day_of_week] = (m.plannedByDay[a.day_of_week] || 0) + yd
      if (a.po_number) m.pos.add(a.po_number)
    }
    for (const l of opLines) {
      const m = map[materialOfTable(l.table_code, site)] || map.other
      const yd = Number(l.actual_yards || 0)
      m.actualWeek += yd
      m.wasteWeek  += Number(l.waste_yards || 0)
      if (l.day_of_week) m.actualByDay[l.day_of_week] = (m.actualByDay[l.day_of_week] || 0) + yd
      if (l.po_number) m.pos.add(l.po_number)
    }

    const out = defs.map(d => ({ ...d, ...map[d.key] }))
    // Surface anything that didn't map to a known table prefix — silently
    // dropping it would hide real production.
    if (map.other.plannedWeek > 0 || map.other.actualWeek > 0) {
      out.push({ key: 'other', label: 'Other / unmapped table', color: C.inkLight, ...map.other })
    }
    return out
  }, [assignments, opLines, site])

  // Weekdays always render; weekend days only when something happened on them.
  const days = useMemo(() => {
    const has = (d) => cats.some(c => (c.plannedByDay[d] || 0) > 0 || (c.actualByDay[d] || 0) > 0)
    const out = []
    if (has('Sun')) out.push('Sun')
    out.push('Mon', 'Tue', 'Wed', 'Thu', 'Fri')
    if (has('Sat')) out.push('Sat')
    return out.sort((a, b) => (DAY_INDEX[a] ?? 0) - (DAY_INDEX[b] ?? 0))
  }, [cats])

  const anything = cats.some(c => c.plannedWeek > 0 || c.actualWeek > 0)
  if (!anything) {
    return (
      <div style={{ background: C.parchment, border: `1px solid ${C.border}`, borderRadius: 10, padding: '20px 16px', fontSize: 13, color: C.inkMid }}>
        <strong style={{ color: C.ink }}>Nothing scheduled or recorded for {weekLabelText}.</strong> Once POs are scheduled and actuals come in from Live&nbsp;Ops, each material shows its week here.
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: cats.length > 1 ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: 12 }}>
        {cats.map(c => <MaterialCard key={c.key} c={c} days={days} />)}
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: C.inkLight, fontStyle: 'italic', lineHeight: 1.6 }}>
        Yards only for now. The color-yards cut of this view — the labor read — comes once color-yards-completed-by-category is tied out by hand, so the number is trustworthy before anyone leans on it.
      </div>
    </div>
  )
}

function MaterialCard({ c, days }) {
  const pct = c.plannedWeek > 0
    ? Math.round((c.actualWeek / c.plannedWeek) * 100)
    : (c.actualWeek > 0 ? 100 : 0)
  const pinnedPlan = Object.values(c.plannedByDay).reduce((s, v) => s + v, 0)
  const unpinned = Math.max(0, c.plannedWeek - pinnedPlan)
  const wastePct = (c.actualWeek + c.wasteWeek) > 0
    ? Math.round((c.wasteWeek / (c.actualWeek + c.wasteWeek)) * 1000) / 10
    : null

  // Scale bars within this material only — grasscloth and fabric run at very
  // different volumes, so a shared scale would flatten the smaller one.
  const max = Math.max(1, ...days.map(d => Math.max(c.plannedByDay[d] || 0, c.actualByDay[d] || 0)))
  const H = 74

  return (
    <div style={{ background: 'var(--surface)', border: `1px solid ${C.border}`, borderLeft: `3px solid ${c.color}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.ink, fontFamily: 'var(--font-display)' }}>{c.label}</span>
        <span style={{ fontSize: 10, color: C.inkLight }}>{c.pos.size} PO{c.pos.size !== 1 ? 's' : ''}</span>
      </div>

      {/* Week headline — completed vs planned */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)', color: c.actualWeek > 0 ? C.ink : C.inkLight, lineHeight: 1.1 }}>
          {c.actualWeek > 0 ? fmt(c.actualWeek) : '—'}
        </span>
        <span style={{ fontSize: 12, color: C.inkLight }}>/ {fmt(c.plannedWeek)} yd planned</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: pct >= 95 ? C.sage : pct >= 60 ? C.gold : C.inkMid }}>{pct}%</span>
      </div>
      <div style={{ height: 6, background: C.warm, borderRadius: 3, overflow: 'hidden', marginBottom: 4 }}>
        <div style={{ width: Math.min(100, pct) + '%', height: '100%', background: c.color }} />
      </div>
      <div style={{ fontSize: 10, color: C.inkLight, marginBottom: 10 }}>
        {c.wasteWeek > 0
          ? <>{fmt(c.wasteWeek)} yd waste{wastePct != null && <span style={{ color: C.amber, fontWeight: 600 }}> · {wastePct}%</span>}</>
          : 'No waste recorded'}
      </div>

      {/* Day-by-day: planned (pale) vs completed (solid) */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: H + 16 }}>
        {days.map(d => {
          const p = c.plannedByDay[d] || 0
          const a = c.actualByDay[d] || 0
          const hp = p > 0 ? Math.max(2, Math.round((p / max) * H)) : 0
          const ha = a > 0 ? Math.max(2, Math.round((a / max) * H)) : 0
          return (
            <div key={d} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: H }}>
                <div title={`${d} · ${fmt(p)} yd planned`}
                  style={{ width: 9, height: hp, background: C.warm, borderRadius: '2px 2px 0 0' }} />
                <div title={`${d} · ${fmt(a)} yd completed`}
                  style={{ width: 9, height: ha, background: c.color, borderRadius: '2px 2px 0 0' }} />
              </div>
              <span style={{ fontSize: 8, color: C.inkLight, fontWeight: 600 }}>{d}</span>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 8, color: C.inkLight }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 8, height: 8, background: C.warm, borderRadius: 2, display: 'inline-block' }} /> Planned
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 8, height: 8, background: c.color, borderRadius: 2, display: 'inline-block' }} /> Completed
        </span>
      </div>

      {unpinned > 0 && (
        <div style={{ fontSize: 9, color: C.inkLight, fontStyle: 'italic', marginTop: 6, lineHeight: 1.5 }}>
          {fmt(unpinned)} yd of the plan isn't assigned to a day — counted in the week total above, but it can't show in the daily bars.
        </div>
      )}
    </div>
  )
}

// ─── Small shared bits ──────────────────────────────────────────────────────

function SiteChip({ active, onClick, color, children }) {
  return (
    <button onClick={onClick}
      style={{ padding: '8px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: `1px solid ${active ? color : C.border}`, background: active ? color : 'transparent', color: active ? '#fff' : C.inkMid }}>
      {children}
    </button>
  )
}

function ViewChip({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      style={{ padding: '7px 16px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: `1px solid ${active ? C.ink : C.border}`, background: active ? C.ink : 'transparent', color: active ? '#fff' : C.inkMid }}>
      {children}
    </button>
  )
}

function SummaryStat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, fontFamily: 'var(--font-display)' }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: C.inkLight, fontStyle: 'italic' }}>{sub}</div>}
    </div>
  )
}
