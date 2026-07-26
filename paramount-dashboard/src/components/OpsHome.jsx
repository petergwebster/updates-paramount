import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, sundayOf, isoDate, fmt } from '../lib/scheduleUtils'
import OpsAttentionPanel from './OpsAttentionPanel'

// ─── Delta chip ────────────────────────────────────────────────
// A bare number tells you nothing. 17,897 yards is only meaningful against
// what last week did — that is the difference between a readout and a signal.
// `goodDown` inverts the colouring for metrics where less is better (waste,
// aged WIP), because a falling number is not automatically bad.
function Delta({ now, prev, goodDown, suffix = 'vs last week' }) {
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
function Ring({ pct, color, caption }) {
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
              style={{ fontSize: 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(p)}%
        </text>
      </svg>
      {caption && <span style={{ fontSize: 11, color: C.inkLight, lineHeight: 1.5 }}>{caption}</span>}
    </div>
  )
}

// ─── Columns: shape over a small number of categories ──────────────────────
function Columns({ bars, height = 62 }) {
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
function StackBar({ segs }) {
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

function Box({ title, value, unit, sub, subTone, delta, children, onClick }) {
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
        <span style={{ fontSize: 17, fontWeight: 600, color: C.ink }}>{title}</span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
          <span style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
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
          .select('actual_yards').eq('week_start', wk)
        const curProduced = (cur || []).reduce((s, l) => s + num(l.actual_yards), 0)
        if (!dead && curProduced === 0) {
          const { data: pv } = await supabase.from('sched_daily_ops_lines')
            .select('actual_yards').eq('week_start', prevWk)
          const prevProduced = (pv || []).reduce((s, l) => s + num(l.actual_yards), 0)
          if (!dead && prevProduced > 0) { useWk = prevWk; isPrior = true }
        }
      }
      if (dead) return

      const [wipRes, asnRes, lineRes] = await Promise.all([
        snap.data?.id
          ? supabase.from('sched_wip_rows').select('age_days,is_new_goods').eq('snapshot_id', snap.data.id)
          : Promise.resolve({ data: [] }),
        supabase.from('sched_assignments').select('planned_yards,product_type').eq('week_start', useWk),
        supabase.from('sched_daily_ops_lines')
          .select('actual_yards,waste_yards,is_complete,work_date').eq('week_start', useWk),
      ])
      if (dead) return

      const wip = wipRes.data || [], asn = asnRes.data || [], lines = lineRes.data || []

      const age = { cur: 0, d30: 0, d60: 0, d90: 0, d120: 0 }
      for (const r of wip) {
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
      const start = new Date(useWk + 'T00:00:00')
      const byDay = [0, 0, 0, 0, 0]              // Mon…Fri
      for (const l of lines) {
        if (!l.work_date) continue
        const idx = Math.round((new Date(l.work_date + 'T00:00:00') - start) / 86400000) - 1
        if (idx >= 0 && idx <= 4) byDay[idx] += num(l.actual_yards)
      }

      const sched  = asn.reduce((s, a) => s + num(a.planned_yards), 0)
      const actual = lines.reduce((s, l) => s + num(l.actual_yards), 0)
      const waste  = lines.reduce((s, l) => s + num(l.waste_yards), 0)
      const done   = lines.filter(l => l.is_complete).length

      // Comparison week — whatever sits one week before the week we're showing.
      const cmpSunday = new Date(useWk + 'T00:00:00')
      cmpSunday.setDate(cmpSunday.getDate() - 7)
      const cmpWk = isoDate(cmpSunday)
      const [cmpAsnRes, cmpLineRes] = await Promise.all([
        supabase.from('sched_assignments').select('planned_yards').eq('week_start', cmpWk),
        supabase.from('sched_daily_ops_lines').select('actual_yards,waste_yards').eq('week_start', cmpWk),
      ])
      if (dead) return
      const cmpAsn = cmpAsnRes.data || [], cmpLines = cmpLineRes.data || []
      const prevSched  = cmpAsn.reduce((s, a) => s + num(a.planned_yards), 0)
      const prevActual = cmpLines.reduce((s, l) => s + num(l.actual_yards), 0)
      const prevWaste  = cmpLines.reduce((s, l) => s + num(l.waste_yards), 0)
      const prevWastePct = (prevActual + prevWaste) > 0 ? (prevWaste / (prevActual + prevWaste)) * 100 : null

      setD({ wipTotal: wip.length, age, ngTotal: ng.length, ngLate,
             mat, byDay, sched, actual, waste, done,
             lineCount: lines.length, asnCount: asn.length, isPrior,
             prevSched, prevActual, prevWastePct })
    })()
    return () => { dead = true }
  }, [])

  const grid = {
    display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 16, paddingTop: 8,
  }

  if (!d) return (
    <div style={grid}>
      {[0,1,2,3,4,5].map(i => (
        <div key={i} style={{ minHeight: 232, borderRadius: 12, background: C.parchment,
                              border: `1px solid ${C.border}` }} />
      ))}
    </div>
  )

  const go = (t) => () => onOpen && onOpen(t)
  const attain   = d.sched > 0 ? (d.actual / d.sched) * 100 : 0
  const wastePct = (d.actual + d.waste) > 0 ? (d.waste / (d.actual + d.waste)) * 100 : 0
  const donePct  = d.lineCount > 0 ? (d.done / d.lineCount) * 100 : 0
  const ngOkPct  = d.ngTotal > 0 ? ((d.ngTotal - d.ngLate) / d.ngTotal) * 100 : 0
  const attainCol = attain >= 95 ? C.sage : attain >= 75 ? C.amber : C.rose

  return (
    <div>
      {d.isPrior && (
        <div style={{ fontSize: 11, color: C.amber, marginBottom: 10, display: 'flex',
                      alignItems: 'center', gap: 7 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.amber }} />
          This week has no entries yet — showing last week
        </div>
      )}
      <div style={grid}>

      <Box title="Pulse" value={fmt(d.actual)} unit="yds"
           sub={d.sched > 0 ? `against a ${fmt(d.sched)} yd plan` : 'Nothing scheduled yet'}
           subTone={d.sched === 0 ? undefined : attain >= 95 ? 'good' : attain >= 75 ? 'warn' : 'bad'}
           delta={<Delta now={d.actual} prev={d.prevActual} />}
           onClick={go('pulse')}>
        <Ring pct={attain} color={attainCol} caption={'of the week\u2019s plan produced so far'} />
      </Box>

      <Box title="WIP" value={fmt(d.wipTotal)} unit="rows"
           sub={`${fmt(d.age.d120)} past 120 days`}
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
        <Columns bars={[
          { v: d.mat.grass,  color: C.sage,      label: 'Grass' },
          { v: d.mat.fabric, color: C.coloryards, label: 'Fabric' },
          { v: d.mat.paper,  color: C.yards,     label: 'Wallpaper' },
        ]} />
      </Box>

      <Box title="Live ops" value={d.actual > 0 ? `${wastePct.toFixed(1)}%` : '—'}
           unit={d.actual > 0 ? 'waste' : 'no entry'}
           sub={d.actual > 0 ? `${fmt(d.waste)} yd of ${fmt(d.actual + d.waste)} run` : 'Nothing recorded this week'}
           subTone={d.actual > 0 ? (wastePct <= 3 ? 'good' : wastePct <= 6 ? 'warn' : 'bad') : undefined}
           delta={<Delta now={wastePct} prev={d.prevWastePct} goodDown />}
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
        <OpsAttentionPanel onNavigate={onOpen} />
      </div>
    </div>
  )
}
