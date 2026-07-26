import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, sundayOf, isoDate, fmt } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// OpsSectionGrid — one box per Operations tab, each carrying a headline number
// and its own small visual. Click a box to go there.
//
// THIS IS THE HUB. Pulse is where you land; these boxes are the doors. The tab
// strip stays at the top for moving around once you are inside — so the hub is
// a starting point, not a toll gate you pass through every time.
//
// Each box earns its space by showing something you cannot get from the tab
// name alone: WIP shows where the age sits, Scheduler shows how full the week
// is, Status shows how much has actually been recorded. A grid of titles and
// icons would just be a menu with extra steps.
//
// Visuals are hand-rolled segment bars — cheap, themed, no dependency.
// ═══════════════════════════════════════════════════════════════════════════

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }

// A horizontal stacked bar. segs = [{ v, color, label }]
function SegBar({ segs }) {
  const total = segs.reduce((s, x) => s + x.v, 0)
  if (total <= 0) return <div style={{ height: 6, borderRadius: 3, background: C.warm }} />
  return (
    <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: C.warm }}>
      {segs.map((s, i) => s.v > 0 && (
        <div key={i} title={`${s.label}: ${fmt(s.v)}`}
             style={{ width: `${(s.v / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  )
}

function Box({ title, value, unit, sub, children, onClick }) {
  return (
    <button onClick={onClick}
      style={{
        textAlign: 'left', background: C.parchment, border: `1px solid ${C.border}`,
        borderRadius: 10, padding: '14px 16px 15px', cursor: 'pointer',
        color: C.ink, fontFamily: 'inherit', display: 'flex', flexDirection: 'column',
        gap: 9, minHeight: 132, transition: 'border-color .15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = C.inkLight }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = C.border }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{title}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ fontSize: 23, fontWeight: 600, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span style={{ fontSize: 11, color: C.inkLight }}>{unit}</span>}
      </span>
      <div style={{ marginTop: 'auto' }}>{children}</div>
      {sub && <span style={{ fontSize: 11, color: C.inkLight, lineHeight: 1.4 }}>{sub}</span>}
    </button>
  )
}

export default function OpsSectionGrid({ onNavigate }) {
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
          ? supabase.from('sched_wip_rows')
              .select('age_days,is_new_goods,order_status').eq('snapshot_id', snap.data.id)
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

      const newGoods = wip.filter(r => r.is_new_goods)
      const ngLate = newGoods.filter(r => num(r.age_days) > 90).length

      const sched = asn.reduce((s, a) => s + num(a.planned_yards), 0)
      const actual = lines.reduce((s, l) => s + num(l.actual_yards), 0)
      const waste  = lines.reduce((s, l) => s + num(l.waste_yards), 0)
      const done   = lines.filter(l => l.is_complete).length

      const today = isoDate(new Date())
      const todayLines = lines.filter(l => l.work_date === today)
      const todayYards = todayLines.reduce((s, l) => s + num(l.actual_yards), 0)

      setD({
        wipTotal: wip.length, age,
        ngTotal: newGoods.length, ngLate,
        asnCount: asn.length, sched,
        actual, waste, done, lineCount: lines.length,
        todayYards, todayLines: todayLines.length,
      })
    })()
    return () => { dead = true }
  }, [])

  const grid = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
    gap: 10, marginBottom: 26,
  }

  if (!d) return (
    <div style={grid}>
      {[0,1,2,3,4].map(i => (
        <div key={i} style={{ minHeight: 132, borderRadius: 10, background: C.parchment,
                              border: `1px solid ${C.border}` }} />
      ))}
    </div>
  )

  const go = (t) => () => onNavigate && onNavigate(t)
  const attain = d.sched > 0 ? (d.actual / d.sched) * 100 : 0

  return (
    <div style={grid}>

      <Box title="WIP" value={fmt(d.wipTotal)} unit="rows"
           sub={`${fmt(d.age.d120)} past 120 days`} onClick={go('wip')}>
        <SegBar segs={[
          { v: d.age.cur,  color: C.sage,  label: 'Under 30d' },
          { v: d.age.d30,  color: C.yards, label: '30–59d' },
          { v: d.age.d60,  color: C.amber, label: '60–89d' },
          { v: d.age.d90,  color: C.scheduled, label: '90–119d' },
          { v: d.age.d120, color: C.rose,  label: '120d+' },
        ]} />
      </Box>

      <Box title="New goods" value={fmt(d.ngTotal)} unit="items"
           sub={d.ngLate > 0 ? `${d.ngLate} over 90 days` : 'Pre-production pipeline'}
           onClick={go('newgoods')}>
        <SegBar segs={[
          { v: d.ngTotal - d.ngLate, color: C.coloryards, label: 'On track' },
          { v: d.ngLate,             color: C.rose,       label: 'Aged' },
        ]} />
      </Box>

      <Box title="Scheduler" value={fmt(d.sched)} unit="yds"
           sub={`${d.asnCount} assignment${d.asnCount !== 1 ? 's' : ''} on the board`}
           onClick={go('scheduler')}>
        <SegBar segs={[{ v: d.sched, color: C.scheduled, label: 'Scheduled' }]} />
      </Box>

      <Box title="Live ops" value={d.todayLines ? fmt(d.todayYards) : '—'} unit={d.todayLines ? 'yds today' : ''}
           sub={d.todayLines ? `${d.todayLines} line${d.todayLines !== 1 ? 's' : ''} recorded today` : 'Nothing recorded today'}
           onClick={go('liveops')}>
        <SegBar segs={[
          { v: d.actual, color: C.yards, label: 'Produced' },
          { v: d.waste,  color: C.waste, label: 'Waste' },
        ]} />
      </Box>

      <Box title="Status" value={`${d.done}`} unit={`of ${d.lineCount} done`}
           sub={d.sched > 0 ? `${Math.round(attain)}% of scheduled produced` : 'Nothing scheduled yet'}
           onClick={go('status')}>
        <SegBar segs={[
          { v: d.actual,                        color: C.sage, label: 'Produced' },
          { v: Math.max(0, d.sched - d.actual), color: C.warm, label: 'Remaining' },
        ]} />
      </Box>

    </div>
  )
}
