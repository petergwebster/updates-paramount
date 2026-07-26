import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, sundayOf, isoDate, fmt, schedLineKey } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// OpsDailyChart — yards by day, week to date, split by site.
//
// WHY THIS FIRST: a week is currently a single number. You cannot see that
// Monday was strong and Wednesday collapsed, which is exactly the conversation
// a weekly review should start from. This is the chart that changes what gets
// discussed.
//
// COLOUR CARRIES MEANING, not decoration. Passaic and Brooklyn keep their site
// colours here and everywhere else; the scheduled line is amber because amber
// is always "the plan" across this dashboard. Learn the colours once, read
// shape thereafter.
//
// Hand-rolled SVG rather than a chart library: it is ~60 lines, adds no
// dependency, and matches the theme exactly instead of being styled into
// submission. Reach for recharts when we need axes, tooltips and zoom.
// ═══════════════════════════════════════════════════════════════════════════

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }

export default function OpsDailyChart() {
  const [d, setD] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const wk = isoDate(sundayOf(new Date()))
      const [lineRes, asnRes] = await Promise.all([
        supabase.from('sched_daily_ops_lines')
          .select('site,work_date,actual_yards,waste_yards').eq('week_start', wk),
        supabase.from('sched_assignments')
          .select('site,planned_yards').eq('week_start', wk),
      ])
      if (dead) return

      const lines = lineRes.data || []
      const asn   = asnRes.data || []

      // Bucket by day-of-week index off the Sunday-anchored week start.
      const start = sundayOf(new Date())
      const byDay = DAYS.map(() => ({ nj: 0, bny: 0, waste: 0 }))
      for (const l of lines) {
        if (!l.work_date) continue
        const dt = new Date(l.work_date + 'T00:00:00')
        const idx = Math.round((dt - start) / 86400000)
        if (idx < 0 || idx > 6) continue
        const b = byDay[idx]
        if (l.site === 'passaic') b.nj += num(l.actual_yards)
        else                      b.bny += num(l.actual_yards)
        b.waste += num(l.waste_yards)
      }

      // Daily scheduled target, spread across a 5-day working week. The floor
      // does not run Sat/Sun, so dividing by 7 would understate the bar every
      // weekday and flatter every weekend.
      const sched = asn.reduce((s, a) => s + num(a.planned_yards), 0)
      setD({ byDay, dailyTarget: sched / 5 })
    })()
    return () => { dead = true }
  }, [])

  if (!d) return <div style={{ height: 168, borderRadius: 10, background: C.parchment,
                               border: `1px solid ${C.border}`, marginBottom: 26 }} />

  const peak = Math.max(d.dailyTarget, ...d.byDay.map(b => b.nj + b.bny)) || 1
  const H = 104

  return (
    <div style={{ background: C.parchment, border: `1px solid ${C.border}`, borderRadius: 10,
                  padding: '14px 16px 12px', marginBottom: 26 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                    marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                       textTransform: 'uppercase', color: C.inkLight }}>Yards by day</span>
        <span style={{ display: 'flex', gap: 14, fontSize: 11, color: C.inkLight }}>
          <Key c={C.siteNJ}  label="Passaic" />
          <Key c={C.siteBNY} label="Brooklyn" />
          <Key c={C.scheduled} label="Daily target" dashed />
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: H }}>
        {d.byDay.map((b, i) => {
          const total = b.nj + b.bny
          const njH   = (b.nj  / peak) * H
          const bnyH  = (b.bny / peak) * H
          const tgtY  = H - (d.dailyTarget / peak) * H
          const weekend = i === 0 || i === 6
          return (
            <div key={i} style={{ flex: 1, position: 'relative', height: H,
                                  display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              {/* target line — a reference, so it stays quiet */}
              {!weekend && (
                <div style={{ position: 'absolute', left: -2, right: -2, top: tgtY,
                              borderTop: `1px dashed ${C.scheduled}`, opacity: 0.55 }} />
              )}
              {total > 0 && (
                <div style={{ position: 'absolute', top: H - njH - bnyH - 16, left: 0, right: 0,
                              textAlign: 'center', fontSize: 10, fontWeight: 600,
                              color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(total)}
                </div>
              )}
              <div style={{ height: bnyH, background: C.siteBNY, borderRadius: '3px 3px 0 0' }} />
              <div style={{ height: njH,  background: C.siteNJ,
                            borderRadius: bnyH > 0 ? 0 : '3px 3px 0 0' }} />
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        {DAYS.map((day, i) => (
          <div key={day} style={{ flex: 1, textAlign: 'center', fontSize: 10,
                                  color: (i === 0 || i === 6) ? C.inkLight : C.inkMid }}>
            {day}
          </div>
        ))}
      </div>
    </div>
  )
}

function Key({ c, label, dashed }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 10, height: dashed ? 0 : 10, borderRadius: dashed ? 0 : 2,
                     background: dashed ? 'transparent' : c,
                     borderTop: dashed ? `2px dashed ${c}` : 'none', display: 'inline-block' }} />
      {label}
    </span>
  )
}
