import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, sundayOf, isoDate, fmt } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// OpsHome — the Operations home screen. Six boxes, one per section.
//
// THE MODEL: you land here. No tab strip, because you have not chosen a
// section yet. Click a box and you enter that section — and THAT is where the
// tab strip appears, so you can move between sections without coming back.
// Home is a starting point, not a gate you pass through every time.
//
// Every box carries a live number and its own visual. A grid of titles would
// be a menu; the point of a home screen is that you can read the state of the
// plant before you decide where to go.
//
// Visuals are hand-rolled segment bars — themed, no dependency, and each one
// encodes something the section is actually about:
//   Pulse      how the week is tracking against plan
//   WIP        where the age sits
//   New goods  how much of the pipeline has gone stale
//   Scheduler  how full the week is against budget
//   Live ops   produced against waste
//   Status     recorded against scheduled
// ═══════════════════════════════════════════════════════════════════════════

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }

function SegBar({ segs, height = 6 }) {
  const total = segs.reduce((s, x) => s + x.v, 0)
  if (total <= 0) return <div style={{ height, borderRadius: height / 2, background: C.warm }} />
  return (
    <div style={{ display: 'flex', height, borderRadius: height / 2, overflow: 'hidden', background: C.warm }}>
      {segs.map((s, i) => s.v > 0 && (
        <div key={i} title={`${s.label}: ${fmt(s.v)}`}
             style={{ width: `${(s.v / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  )
}

function Box({ title, value, unit, sub, subTone, children, onClick }) {
  const tone = { good: C.sage, warn: C.amber, bad: C.rose }
  return (
    <button onClick={onClick}
      style={{
        textAlign: 'left', background: C.parchment, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: '18px 20px 20px', cursor: 'pointer',
        color: C.ink, fontFamily: 'inherit', display: 'flex', flexDirection: 'column',
        minHeight: 176, transition: 'border-color .15s, transform .15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = C.inkLight; e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.transform = 'none' }}>
      <span style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 12 }}>{title}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 16 }}>
        <span style={{ fontSize: 30, fontWeight: 600, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span style={{ fontSize: 12, color: C.inkLight }}>{unit}</span>}
      </span>
      <div style={{ marginTop: 'auto' }}>{children}</div>
      {sub && (
        <span style={{ fontSize: 12, color: tone[subTone] || C.inkLight, lineHeight: 1.45, marginTop: 10 }}>
          {sub}
        </span>
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
      const snap = await supabase.from('sched_snapshots')
        .select('id').order('uploaded_at', { ascending: false }).limit(1).maybeSingle()
      if (dead) return

      const [wipRes, asnRes, lineRes] = await Promise.all([
        snap.data?.id
          ? supabase.from('sched_wip_rows').select('age_days,is_new_goods').eq('snapshot_id', snap.data.id)
          : Promise.resolve({ data: [] }),
        supabase.from('sched_assignments').select('planned_yards').eq('week_start', wk),
        supabase.from('sched_daily_ops_lines')
          .select('actual_yards,waste_yards,is_complete,work_date').eq('week_start', wk),
      ])
      if (dead) return

      const wip   = wipRes.data || []
      const asn   = asnRes.data || []
      const lines = lineRes.data || []

      const age = { cur: 0, d30: 0, d60: 0, d90: 0, d120: 0 }
      for (const r of wip) {
        const a = num(r.age_days)
        if (a < 30) age.cur++
        else if (a < 60) age.d30++
        else if (a < 90) age.d60++
        else if (a < 120) age.d90++
        else age.d120++
      }

      const ng     = wip.filter(r => r.is_new_goods)
      const ngLate = ng.filter(r => num(r.age_days) > 90).length

      const sched  = asn.reduce((s, a) => s + num(a.planned_yards), 0)
      const actual = lines.reduce((s, l) => s + num(l.actual_yards), 0)
      const waste  = lines.reduce((s, l) => s + num(l.waste_yards), 0)
      const done   = lines.filter(l => l.is_complete).length

      const today = isoDate(new Date())
      const todayLines = lines.filter(l => l.work_date === today)

      setD({
        wipTotal: wip.length, age,
        ngTotal: ng.length, ngLate,
        asnCount: asn.length, sched, actual, waste, done,
        lineCount: lines.length,
        todayYards: todayLines.reduce((s, l) => s + num(l.actual_yards), 0),
        todayLines: todayLines.length,
      })
    })()
    return () => { dead = true }
  }, [])

  const grid = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 12, paddingTop: 6,
  }

  if (!d) return (
    <div style={grid}>
      {[0,1,2,3,4,5].map(i => (
        <div key={i} style={{ minHeight: 176, borderRadius: 12, background: C.parchment,
                              border: `1px solid ${C.border}` }} />
      ))}
    </div>
  )

  const go = (t) => () => onOpen && onOpen(t)
  const attain   = d.sched > 0 ? (d.actual / d.sched) * 100 : 0
  const wastePct = (d.actual + d.waste) > 0 ? (d.waste / (d.actual + d.waste)) * 100 : 0
  const attainTone = d.sched === 0 ? undefined : attain >= 95 ? 'good' : attain >= 75 ? 'warn' : 'bad'

  return (
    <div style={grid}>

      <Box title="Pulse" value={fmt(d.actual)} unit="yds this week"
           sub={d.sched > 0 ? `${Math.round(attain)}% of the ${fmt(d.sched)} yd plan` : 'Nothing scheduled yet'}
           subTone={attainTone}
           onClick={go('pulse')}>
        <SegBar height={8} segs={[
          { v: d.actual,                        color: C.yards, label: 'Produced' },
          { v: Math.max(0, d.sched - d.actual), color: C.warm,  label: 'Still to run' },
        ]} />
      </Box>

      <Box title="WIP" value={fmt(d.wipTotal)} unit="rows"
           sub={`${fmt(d.age.d120)} past 120 days`}
           subTone={d.age.d120 > 80 ? 'bad' : d.age.d120 > 0 ? 'warn' : undefined}
           onClick={go('wip')}>
        <SegBar height={8} segs={[
          { v: d.age.cur,  color: C.sage,      label: 'Under 30d' },
          { v: d.age.d30,  color: C.yards,     label: '30–59d' },
          { v: d.age.d60,  color: C.amber,     label: '60–89d' },
          { v: d.age.d90,  color: C.scheduled, label: '90–119d' },
          { v: d.age.d120, color: C.rose,      label: '120d+' },
        ]} />
      </Box>

      <Box title="New goods" value={fmt(d.ngTotal)} unit="items"
           sub={d.ngLate > 0 ? `${d.ngLate} over 90 days` : 'Pipeline running clean'}
           subTone={d.ngLate > 0 ? 'warn' : 'good'}
           onClick={go('newgoods')}>
        <SegBar height={8} segs={[
          { v: d.ngTotal - d.ngLate, color: C.coloryards, label: 'On track' },
          { v: d.ngLate,             color: C.rose,       label: 'Aged' },
        ]} />
      </Box>

      <Box title="Scheduler" value={fmt(d.sched)} unit="yds planned"
           sub={`${d.asnCount} assignment${d.asnCount !== 1 ? 's' : ''} on the board`}
           onClick={go('scheduler')}>
        <SegBar height={8} segs={[{ v: Math.max(d.sched, 1), color: C.scheduled, label: 'Scheduled' }]} />
      </Box>

      <Box title="Live ops" value={d.todayLines ? fmt(d.todayYards) : '—'}
           unit={d.todayLines ? 'yds today' : 'nothing today'}
           sub={d.actual > 0 ? `${wastePct.toFixed(1)}% waste week to date` : 'No entry recorded yet'}
           subTone={d.actual > 0 ? (wastePct <= 3 ? 'good' : wastePct <= 6 ? 'warn' : 'bad') : undefined}
           onClick={go('liveops')}>
        <SegBar height={8} segs={[
          { v: d.actual, color: C.yards, label: 'Produced' },
          { v: d.waste,  color: C.waste, label: 'Waste' },
        ]} />
      </Box>

      <Box title="Status" value={`${d.done}`} unit={`of ${d.lineCount} lines done`}
           sub={d.lineCount > 0 ? 'Marked complete in Live Ops' : 'No lines recorded this week'}
           onClick={go('status')}>
        <SegBar height={8} segs={[
          { v: d.done,                                color: C.sage, label: 'Done' },
          { v: Math.max(0, d.lineCount - d.done),     color: C.warm, label: 'Open' },
        ]} />
      </Box>

    </div>
  )
}
