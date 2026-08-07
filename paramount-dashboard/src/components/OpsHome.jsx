import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, sundayOf, isoDate, fmt } from '../lib/scheduleUtils'
import OpsAttentionPanel from './OpsAttentionPanel'

// ─── The three views ───────────────────────────────────────────────
// Hand Screen and Digital, not Passaic and Brooklyn. The twelve Passaic
// small-digital machines budget to BNY, so the real split is by PROCESS, not
// by building — and process is how the floor, the budget and the month-end
// deck all talk about it.
//
// COMBINED MEANS COMBINED PRODUCTION, NOT EVERYTHING IN THE TABLE. This is the
// load-bearing part. sched_wip_rows also carries 'procurement' (the Korean
// wallcovering supply line — 219 rows and 84,243 yards on 27 July, a third of
// what the WIP tile was reporting) and a stray 'unknown'. Those are not
// production and must never appear on an operations screen: they were
// inflating open WIP by 30% and putting 83 procurement POs into an alert that
// reads "worth a pass with Ramon".
//
// Because every view here is an explicit site list, procurement is excluded by
// construction rather than by a filter someone has to remember to add.
export const OPS_VIEWS = {
  combined:   { label: 'Combined',    sites: ['passaic', 'bny'] },
  handscreen: { label: 'Hand Screen', sites: ['passaic'] },
  digital:    { label: 'Digital',     sites: ['bny'] },
}

// ─── Paginated fetch ───────────────────────────────────────────
// PostgREST caps a response at 1,000 rows on the SERVER. A client-side
// `.limit(5000)` does NOT defeat that — it looks like a fix, returns exactly
// 1,000 rows, and every total silently reads short. Proven on this screen
// 27 July: the WIP tile reported 1,000 lines / 228,572 yards against a real
// 1,261 / 280,340, and its 120-day bucket said 212 while the alert panel
// directly beneath it said 258, because the panel uses an exact count and the
// tile was reading truncated rows.
//
// Anything on a home screen that fetches ROWS rather than a count has to
// paginate. `build(from, to)` returns a ready-to-await query.
async function fetchAll(build, page = 1000) {
  const all = []
  let from = 0
  for (;;) {
    const { data, error } = await build(from, from + page - 1)
    if (error) { console.error('[OpsHome] fetchAll', error); break }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < page) break
    from += page
  }
  return all
}

// ─── Delta chip ────────────────────────────────────────────────
// A bare number tells you nothing. 17,897 yards is only meaningful against
// what last week did — that is the difference between a readout and a signal.
// `goodDown` inverts the colouring for metrics where less is better (waste,
// aged WIP), because a falling number is not automatically bad.
export function Delta({ now, prev, goodDown, suffix = 'vs last week' }) {
  if (prev == null || prev === 0 || now == null) return null
  const pct = ((now - prev) / Math.abs(prev)) * 100
  if (!isFinite(pct)) return null
  const up = pct >= 0
  const good = goodDown ? !up : up
  const col = Math.abs(pct) < 1 ? C.inkLight : good ? C.sage : C.rose
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: col }}>
      <span style={{ fontSize: 9 }}>{up ? '\u25B2' : '\u25BC'}</span>
      {Math.abs(pct) < 1 ? 'flat' : `${Math.abs(pct).toFixed(0)}%`}
      <span style={{ color: C.inkLight }}>{suffix}</span>
    </span>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// OpsHome — the Operations home screen. Six boxes, one per section.
//
// THE MODEL: you land here, no tab strip. Click a box and you enter that
// section — that is where the tabs appear, so you move around from there
// without coming back. Home is a starting point, not a gate.
//
// EVERY BOX GETS A DIFFERENT VISUAL. Six identical bars is a menu wearing a
// chart costume; the eye learns nothing and the page reads flat. Each visual
// is chosen for what the section is actually about:
//   Pulse      ring     — one number that matters: are we hitting the plan
//   WIP        age bar  — where the backlog sits across five bands
//   New goods  ring     — how much of the pipeline has gone stale
//   Scheduler  columns  — the week split by material, which is how Passaic runs
//   Live ops   columns  — output day by day, the shape of the week
//   Status     bars     — recorded against scheduled, line by line
//
// Fixed three-across so the grid is even — five across leaves an orphan.
// ═══════════════════════════════════════════════════════════════════════════

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }

// ─── Ring: a single percentage, read at a glance ───────────────────────────
export function Ring({ pct, color, caption }) {
  const p = Math.max(0, Math.min(100, pct || 0))
  const R = 30, CIRC = 2 * Math.PI * R
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <svg width="76" height="76" viewBox="0 0 76 76" style={{ flexShrink: 0 }}>
        <circle cx="38" cy="38" r={R} fill="none" stroke={C.warm} strokeWidth="8" />
        <circle cx="38" cy="38" r={R} fill="none" stroke={color} strokeWidth="8"
                strokeDasharray={`${(p / 100) * CIRC} ${CIRC}`} strokeLinecap="round"
                transform="rotate(-90 38 38)" />
        <text x="38" y="42" textAnchor="middle" fill={C.ink}
              style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                       fontFamily: 'var(--font-display)' }}>
          {Math.round(p)}%
        </text>
      </svg>
      {caption && <span style={{ fontSize: 11, color: C.inkLight, lineHeight: 1.5 }}>{caption}</span>}
    </div>
  )
}

// ─── Columns: shape over a small number of categories ──────────────────────
export function Columns({ bars, height = 62 }) {
  const peak = Math.max(1, ...bars.map(b => b.v))
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height }}>
        {bars.map((b, i) => (
          <div key={i} title={`${b.label}: ${fmt(b.v)}`}
               style={{ flex: 1, height: `${Math.max(2, (b.v / peak) * 100)}%`,
                        background: b.color, borderRadius: '3px 3px 0 0' }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
        {bars.map((b, i) => (
          <span key={i} style={{ flex: 1, textAlign: 'center', fontSize: 9,
                                 color: C.inkLight, letterSpacing: '0.02em' }}>{b.label}</span>
        ))}
      </div>
    </div>
  )
}

// ─── Stacked horizontal bar with a small legend ────────────────────────────
export function StackBar({ segs }) {
  const total = segs.reduce((s, x) => s + x.v, 0)
  return (
    <div>
      <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden',
                    background: C.warm, marginBottom: 9 }}>
        {total > 0 && segs.map((s, i) => s.v > 0 && (
          <div key={i} title={`${s.label}: ${fmt(s.v)}`}
               style={{ width: `${(s.v / total) * 100}%`, background: s.color }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
        {segs.filter(s => s.v > 0).map((s, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                                 fontSize: 10, color: C.inkLight }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: s.color }} />
            {s.label} <span style={{ color: C.inkMid }}>{fmt(s.v)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export function Box({ title, value, unit, sub, subTone, delta, children, onClick }) {
  const tone = { good: C.sage, warn: C.amber, bad: C.rose }
  return (
    <button onClick={onClick}
      style={{
        textAlign: 'left', background: C.parchment, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: '20px 22px 22px', cursor: 'pointer',
        color: C.ink, fontFamily: 'inherit', display: 'flex', flexDirection: 'column',
        gap: 14, minHeight: 232, transition: 'border-color .15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = C.inkLight }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = C.border }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 500, color: C.ink, letterSpacing: '0.06em',
                       fontFamily: 'var(--font-display)', textTransform: 'uppercase' }}>{title}</span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
          <span style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
                         fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}>{value}</span>
          {unit && <span style={{ fontSize: 11, color: C.inkLight }}>{unit}</span>}
        </span>
      </div>
      <div style={{ height: 104, display: 'flex', alignItems: 'center' }}>{children}</div>
      {delta}
      {sub && (
        <span style={{ fontSize: 12, color: tone[subTone] || C.inkLight, lineHeight: 1.45 }}>{sub}</span>
      )}
    </button>
  )
}

export default function OpsHome({ onOpen }) {
  const [view, setView] = useState('combined')
  const sites = OPS_VIEWS[view].sites

  const [d, setD] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const wk = isoDate(sundayOf(new Date()))
      const prevSunday = new Date(sundayOf(new Date()))
      prevSunday.setDate(prevSunday.getDate() - 7)
      const prevWk = isoDate(prevSunday)

      const snap = await supabase.from('sched_snapshots')
        .select('id').order('uploaded_at', { ascending: false }).limit(1).maybeSingle()
      if (dead) return

      // WEEK FALLBACK: on a Sunday or an early Monday the current week is
      // legitimately empty, and a home screen full of blank cards reads as
      // broken rather than as "not started". So if nothing has been PRODUCED
      // yet, show last week and say so.
      //
      // Test on PRODUCTION, not on row count. The scheduler pre-creates a line
      // per PO, so a week can carry hundreds of rows and zero actual yards —
      // counting rows picks that week and then reports 0 against a full plan,
      // which is worse than showing nothing.
      let useWk = wk, isPrior = false
      {
        const { data: cur } = await supabase.from('sched_daily_ops_lines')
          .select('actual_yards').eq('week_start', wk).in('site', sites)
        const curProduced = (cur || []).reduce((s, l) => s + num(l.actual_yards), 0)
        if (!dead && curProduced === 0) {
          const { data: pv } = await supabase.from('sched_daily_ops_lines')
            .select('actual_yards').eq('week_start', prevWk).in('site', sites)
          const prevProduced = (pv || []).reduce((s, l) => s + num(l.actual_yards), 0)
          if (!dead && prevProduced > 0) { useWk = prevWk; isPrior = true }
        }
      }
      if (dead) return

      const [wipRes, asnRes, lineRes] = await Promise.all([
        snap.data?.id
          ? fetchAll((a, b) => supabase.from('sched_wip_rows').select('age_days,is_new_goods,yards_written')
            .eq('snapshot_id', snap.data.id).in('site', sites).range(a, b)).then(data => ({ data }))
          : Promise.resolve({ data: [] }),
        supabase.from('sched_assignments').select('site,planned_yards,product_type,table_code')
          .eq('week_start', useWk).in('site', sites),
        // day_of_week, NOT work_date. There is no work_date column on
        // sched_daily_ops_lines — the day is stored as text ('Mon'..'Sat').
        // Selecting a column that does not exist makes PostgREST reject the
        // WHOLE select, so `data` came back null, `lines` became [], and Pulse,
        // Live Ops and Status all read zero on a week with 1,568 recorded
        // yards. Nothing warned, because the fallback check above only asks for
        // actual_yards — a real column — so it correctly saw production and
        // suppressed the amber "showing last week" banner. Blank with no banner.
        supabase.from('sched_daily_ops_lines')
          .select('actual_yards,waste_yards,is_complete,day_of_week,site,table_code')
          .eq('week_start', useWk).in('site', sites),
      ])
      if (dead) return

      const wip = wipRes.data || [], asn = asnRes.data || [], lines = lineRes.data || []

      const age = { cur: 0, d30: 0, d60: 0, d90: 0, d120: 0 }
      let wipYards = 0
      for (const r of wip) {
        wipYards += num(r.yards_written)
        const a = num(r.age_days)
        if (a < 30) age.cur++; else if (a < 60) age.d30++
        else if (a < 90) age.d60++; else if (a < 120) age.d90++; else age.d120++
      }

      const ng = wip.filter(r => r.is_new_goods)
      const ngLate = ng.filter(r => num(r.age_days) > 90).length

      // Scheduler by material — how Passaic is actually managed.
      const mat = { grass: 0, fabric: 0, paper: 0 }
      for (const a of asn) {
        const pt = (a.product_type || '').toLowerCase()
        const y = num(a.planned_yards)
        if (pt.includes('grass')) mat.grass += y
        else if (pt.includes('paper') || pt.includes('panel')) mat.paper += y
        else mat.fabric += y
      }

      // Live ops — output by weekday, anchored on whichever week we're showing.
      // Keyed off day_of_week directly; there is no date on these rows to
      // subtract from the week start.
      const DAY_IDX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 }
      const byDay = [0, 0, 0, 0, 0]              // Mon…Fri
      for (const l of lines) {
        const idx = DAY_IDX[l.day_of_week]
        if (idx != null) byDay[idx] += num(l.actual_yards)
      }

      // ── Scheduler cut ────────────────────────────────────────────
      // THE TWO SITES DO NOT SHARE A DIMENSION. The month-end deck cuts Hand
      // Screen by MATERIAL and Digital by JOB TYPE, and that is not a
      // presentation preference — it is how each business is managed.
      //
      // The old code ran one material bucket over both sites: grass -> Grass,
      // paper|panel -> Wallpaper, EVERYTHING ELSE -> Fabric. Digital's Regular,
      // Hospitality, Custom and Memo all fell through to Fabric. Measured on
      // 27 July that made the Fabric bar 10,419 yards of which only 1,007 was
      // actually Passaic fabric — 90% of Ramon's largest-looking material
      // category was Brooklyn digital work. His real fabric load was the
      // smallest of the three.
      const matOf = (pt) => {
        const s = (pt || '').toLowerCase()
        if (s.includes('grass')) return 'Grass'
        if (s.includes('paper') || s.includes('panel')) return 'Wallpaper'
        return 'Fabric'
      }
      let bars = []
      if (view === 'handscreen') {
        const m = { Grass: 0, Fabric: 0, Wallpaper: 0 }
        for (const a of asn) m[matOf(a.product_type)] += num(a.planned_yards)
        bars = [
          { label: 'Grass',     v: m.Grass,     color: C.sage },
          { label: 'Fabric',    v: m.Fabric,    color: C.coloryards },
          { label: 'Wallpaper', v: m.Wallpaper, color: C.yards },
        ]
      } else if (view === 'digital') {
        // Digital's own job types, straight off the assignment. Top four by
        // yards so the chart stays readable; the rest fold into Other.
        const m = {}
        for (const a of asn) {
          const k = a.product_type || 'Other'
          m[k] = (m[k] || 0) + num(a.planned_yards)
        }
        const ranked = Object.entries(m).sort((x, y) => y[1] - x[1])
        const top = ranked.slice(0, 4)
        const rest = ranked.slice(4).reduce((s, [, v]) => s + v, 0)
        const cols = [C.yards, C.coloryards, C.sage, C.amber, C.inkLight]
        bars = top.map(([k, v], i) => ({ label: k, v, color: cols[i] }))
        if (rest > 0) bars.push({ label: 'Other', v: rest, color: cols[4] })
      } else {
        // Combined: the two processes side by side. No blended material cut,
        // because a shared category here would be a category neither site uses.
        const bySite = { passaic: 0, bny: 0 }
        for (const a of asn) bySite[a.site] = (bySite[a.site] || 0) + num(a.planned_yards)
        bars = [
          { label: 'Hand screen', v: bySite.passaic, color: C.siteNJ },
          { label: 'Digital',     v: bySite.bny,     color: C.siteBNY },
        ]
      }

      // ── Live Ops coverage ───────────────────────────────────────
      // The question this tile should answer at a glance is "is the floor data
      // actually in?", not "how much waste". Waste headlined a number nobody
      // can act on at 8am AND painted a data gap green: with goodDown set, a
      // week where nobody entered any waste rendered as ▼100% in the good
      // colour. A screen must never congratulate you for missing data.
      const tablesScheduled = new Set(asn.map(a => a.table_code).filter(Boolean)).size
      const DAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      let lastDay = null, lastDayRank = -1
      for (const l of lines) {
        const r = DAY_ORDER.indexOf(l.day_of_week)
        if (r > lastDayRank) { lastDayRank = r; lastDay = l.day_of_week }
      }
      const tablesRecorded = lastDay
        ? new Set(lines.filter(l => l.day_of_week === lastDay).map(l => l.table_code).filter(Boolean)).size
        : 0
      // "Today" ONLY WHEN IT IS TODAY. Saying "as of today" over a figure that
      // is actually Sunday's would be friendlier and wrong — on 27 July the
      // Digital view's most recent entries were dated Sunday, so that label
      // would have claimed 2 machines were recorded today when nothing was.
      // When the last recorded day is not today, name the day: the staleness
      // is the signal, and hiding it behind a comfortable word is the exact
      // failure this screen keeps producing.
      const lastDayIsToday = lastDay === DAY_ORDER[new Date().getDay()]

      const sched  = asn.reduce((s, a) => s + num(a.planned_yards), 0)
      const actual = lines.reduce((s, l) => s + num(l.actual_yards), 0)
      const waste  = lines.reduce((s, l) => s + num(l.waste_yards), 0)
      const done   = lines.filter(l => l.is_complete).length

      // Comparison week — whatever sits one week before the week we're showing.
      const cmpSunday = new Date(useWk + 'T00:00:00')
      cmpSunday.setDate(cmpSunday.getDate() - 7)
      const cmpWk = isoDate(cmpSunday)
      const [cmpAsnRes, cmpLineRes] = await Promise.all([
        supabase.from('sched_assignments').select('planned_yards').eq('week_start', cmpWk).in('site', sites),
        supabase.from('sched_daily_ops_lines').select('actual_yards,waste_yards').eq('week_start', cmpWk).in('site', sites),
      ])
      if (dead) return
      const cmpAsn = cmpAsnRes.data || [], cmpLines = cmpLineRes.data || []
      const prevSched  = cmpAsn.reduce((s, a) => s + num(a.planned_yards), 0)
      const prevActual = cmpLines.reduce((s, l) => s + num(l.actual_yards), 0)
      const prevWaste  = cmpLines.reduce((s, l) => s + num(l.waste_yards), 0)
      const prevWastePct = (prevActual + prevWaste) > 0 ? (prevWaste / (prevActual + prevWaste)) * 100 : null

      setD({ wipTotal: wip.length, wipYards, age, ngTotal: ng.length, ngLate,
             mat, byDay, bars, sched, actual, waste, done,
             tablesScheduled, tablesRecorded, lastDay, lastDayIsToday,
             lineCount: lines.length, asnCount: asn.length, isPrior,
             prevSched, prevActual, prevWastePct })
    })()
    return () => { dead = true }
  }, [view])

  const grid = {
    display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 16, paddingTop: 8,
  }

  // The view switch. Deliberately large and deliberately outlined in the brand
  // clay rather than tucked into a dropdown: which process you are looking at
  // changes every number on the screen, so it must never be ambiguous which
  // one is active.
  const ViewSwitch = () => (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginBottom: 14 }}>
      {Object.entries(OPS_VIEWS).map(([key, cfg]) => {
        const on = key === view
        return (
          <button key={key} onClick={() => setView(key)}
            style={{
              padding: '9px 20px', borderRadius: 8, cursor: 'pointer',
              fontFamily: 'var(--font-display)', fontSize: 12, letterSpacing: '0.06em',
              textTransform: 'uppercase', fontWeight: 600,
              background: on ? 'rgba(217,119,87,0.14)' : 'transparent',
              color: on ? '#D97757' : C.inkMid,
              border: `1.5px solid ${on ? '#D97757' : C.border}`,
              transition: 'all .15s',
            }}>
            {cfg.label}
          </button>
        )
      })}
    </div>
  )

  if (!d) return (
    <div>
      <ViewSwitch />
      <div style={grid}>
        {[0,1,2,3,4,5].map(i => (
          <div key={i} style={{ minHeight: 232, borderRadius: 12, background: C.parchment,
                                border: `1px solid ${C.border}` }} />
        ))}
      </div>
    </div>
  )

  const go = (t) => () => onOpen && onOpen(t)
  const attain   = d.sched > 0 ? (d.actual / d.sched) * 100 : 0
  const wastePct = (d.actual + d.waste) > 0 ? (d.waste / (d.actual + d.waste)) * 100 : 0
  const coveragePct = d.tablesScheduled > 0 ? (d.tablesRecorded / d.tablesScheduled) * 100 : 0
  const donePct  = d.lineCount > 0 ? (d.done / d.lineCount) * 100 : 0
  const ngOkPct  = d.ngTotal > 0 ? ((d.ngTotal - d.ngLate) / d.ngTotal) * 100 : 0
  const attainCol = attain >= 95 ? C.sage : attain >= 75 ? C.amber : C.rose

  return (
    <div>
      <ViewSwitch />
      {d.isPrior && (
        <div style={{ fontSize: 11, color: C.amber, marginBottom: 10, display: 'flex',
                      alignItems: 'center', gap: 7 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.amber }} />
          This week has no entries yet — showing last week
        </div>
      )}
      <div style={grid}>

      {/* Since 8/5 the home IS the pulse — the old destination tab is
          retired; chart + heartbeat live further down this very page. But a
          box that does NOTHING on click reads as broken (Peter, 8/7 — first
          click after the sweep was on Pulse). So the click scrolls to the
          pulse detail below instead of navigating. */}
      <Box title="Pulse" value={fmt(d.actual)} unit="yds"
           sub={d.sched > 0 ? `against a ${fmt(d.sched)} yd plan` : 'Nothing scheduled yet'}
           subTone={d.sched === 0 ? undefined : attain >= 95 ? 'good' : attain >= 75 ? 'warn' : 'bad'}
           delta={<Delta now={d.actual} prev={d.prevActual} />}
           onClick={() => document.getElementById('ops-pulse-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        <Ring pct={attain} color={attainCol} caption={'of the week\u2019s plan produced so far'} />
      </Box>

      {/* Open YARDS is the headline, not row count — a row is a PO-line, which
          means nothing to anyone. Yards is what Ramon schedules against. */}
      <Box title="WIP" value={fmt(d.wipYards)} unit="yds open"
           sub={`${fmt(d.wipTotal)} lines · ${fmt(d.age.d120)} past 120 days`}
           subTone={d.age.d120 > 80 ? 'bad' : d.age.d120 > 0 ? 'warn' : undefined}
           onClick={go('wip')}>
        <StackBar segs={[
          { v: d.age.cur,  color: C.sage,      label: '<30d' },
          { v: d.age.d30,  color: C.yards,     label: '30–59' },
          { v: d.age.d60,  color: C.amber,     label: '60–89' },
          { v: d.age.d90,  color: C.scheduled, label: '90–119' },
          { v: d.age.d120, color: C.rose,      label: '120+' },
        ]} />
      </Box>

      <Box title="New goods" value={fmt(d.ngTotal)} unit="items"
           sub={d.ngLate > 0 ? `${d.ngLate} over 90 days` : 'Pipeline running clean'}
           subTone={d.ngLate > 0 ? 'warn' : 'good'}
           onClick={go('newgoods')}>
        <Ring pct={ngOkPct} color={C.coloryards} caption="of the pipeline still inside 90 days" />
      </Box>

      <Box title="Scheduler" value={fmt(d.sched)} unit="yds"
           sub={`${d.asnCount} assignment${d.asnCount !== 1 ? 's' : ''} on the board`}
           delta={<Delta now={d.sched} prev={d.prevSched} />}
           onClick={go('scheduler')}>
        <Columns bars={d.bars} />
      </Box>

      {/* Queue: the flagship order-line view — both production sites plus
          procurement pass-through, live LIFT status, planned week. Label
          fixed 8/5: these are order LINES (one PO can carry several), and
          the same figure must wear the same name everywhere it appears. */}
      <Box title="Queue" value={fmt(d.wipTotal)} unit="open order lines"
           sub="Every open order line, its LIFT status, and the week it's planned for — both sites + procurement"
           onClick={go('queue')}>
        <StackBar segs={[
          { v: d.age.cur,  color: C.sage,      label: '<30d' },
          { v: d.age.d30,  color: C.yards,     label: '30–59' },
          { v: d.age.d60,  color: C.amber,     label: '60–89' },
          { v: d.age.d90,  color: C.scheduled, label: '90–119' },
          { v: d.age.d120, color: C.rose,      label: '120+' },
        ]} />
      </Box>

      <Box title="Live ops"
           value={d.tablesScheduled > 0 ? `${d.tablesRecorded}/${d.tablesScheduled}` : (d.actual > 0 ? fmt(d.actual) : '—')}
           unit={d.tablesScheduled > 0
                  ? `tables · ${d.lastDay ? (d.lastDayIsToday ? 'today' : d.lastDay) : '—'}`
                  : 'no plan'}
           sub={d.actual > 0
                 ? `${fmt(d.actual)} yd recorded this week`
                 : 'Nothing recorded this week'}
           subTone={d.tablesScheduled === 0 ? undefined
                    : coveragePct >= 90 ? 'good' : coveragePct >= 60 ? 'warn' : 'bad'}
           delta={<Delta now={d.actual} prev={d.prevActual} />}
           onClick={go('liveops')}>
        <Columns bars={[
          { v: d.byDay[0], color: C.yards, label: 'Mon' },
          { v: d.byDay[1], color: C.yards, label: 'Tue' },
          { v: d.byDay[2], color: C.yards, label: 'Wed' },
          { v: d.byDay[3], color: C.yards, label: 'Thu' },
          { v: d.byDay[4], color: C.yards, label: 'Fri' },
        ]} />
      </Box>

      <Box title="Status" value={`${d.done}/${d.lineCount}`} unit="lines"
           sub={d.lineCount > 0 ? `${Math.round(donePct)}% of recorded lines closed` : 'No lines recorded this week'}
           onClick={go('status')}>
        <StackBar segs={[
          { v: d.done,                            color: C.sage, label: 'Complete' },
          { v: Math.max(0, d.lineCount - d.done), color: C.warm, label: 'Open' },
        ]} />
      </Box>

      </div>

      {/* The alerts list — the one thing here that is judgement rather than a
          number, so it belongs on the home screen, not buried inside a tab. */}
      <div style={{ marginTop: 16 }}>
        <OpsAttentionPanel onNavigate={onOpen} sites={sites} />
      </div>
    </div>
  )
}
