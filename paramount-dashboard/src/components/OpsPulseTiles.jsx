import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, sundayOf, isoDate, fmt } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// OpsPulseTiles — the at-a-glance grid at the top of Operations · Pulse.
//
// WHY TILES RATHER THAN A HUB PAGE: a grid of icons and titles is just a
// prettier menu with an extra click. Tiles only beat tabs when they CARRY
// DATA — so every tile here shows a live number and doubles as the way in to
// the section behind it. Nobody loses a click, because Pulse is already the
// landing view for Operations.
//
// All figures are the CURRENT fiscal week (Sunday-anchored, matching
// week_start on sched_assignments / sched_daily_ops_lines).
//
// Definitions are deliberately the same ones the weekly summary uses, so the
// glance and the report can never disagree:
//   scheduled   = Σ sched_assignments.planned_yards
//   actual      = Σ sched_daily_ops_lines.actual_yards
//   waste %     = waste ÷ (actual + waste)
//   color-yards = Passaic only — BNY carries no planned_cy, by design
// ═══════════════════════════════════════════════════════════════════════════

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }

function Tile({ label, value, unit, sub, subTone, barPct, barTone, onClick }) {
  const tone = { good: C.sage, warn: C.amber, bad: C.rose, mute: C.inkLight }
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', padding: '14px 16px 15px', borderRadius: 10,
        background: C.parchment, border: `1px solid ${C.border}`,
        cursor: onClick ? 'pointer' : 'default', color: C.ink,
        display: 'flex', flexDirection: 'column', gap: 6, minHeight: 104,
        fontFamily: 'inherit', transition: 'border-color .15s',
      }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = C.inkLight }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = C.border }}
    >
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                     textTransform: 'uppercase', color: C.inkLight }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ fontSize: 25, fontWeight: 600, lineHeight: 1.05,
                       fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span style={{ fontSize: 12, color: C.inkLight }}>{unit}</span>}
      </span>
      {barPct != null && (
        <span style={{ display: 'block', height: 3, borderRadius: 2, background: C.warm, marginTop: 1 }}>
          <span style={{
            display: 'block', height: '100%', borderRadius: 2,
            width: `${Math.max(0, Math.min(100, barPct))}%`,
            background: tone[barTone] || C.navy,
          }} />
        </span>
      )}
      {sub && (
        <span style={{ fontSize: 11, color: tone[subTone] || C.inkLight, lineHeight: 1.4 }}>{sub}</span>
      )}
    </button>
  )
}

export default function OpsPulseTiles({ onNavigate }) {
  const [d, setD] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const wk = isoDate(sundayOf(new Date()))

      const [asnRes, lineRes, snapRes] = await Promise.all([
        supabase.from('sched_assignments').select('site,planned_yards,planned_cy').eq('week_start', wk),
        supabase.from('sched_daily_ops_lines')
          .select('site,actual_yards,waste_yards,is_complete').eq('week_start', wk),
        supabase.from('sched_snapshots').select('id').order('uploaded_at', { ascending: false }).limit(1).maybeSingle(),
      ])
      if (dead) return

      const asn   = asnRes.data || []
      const lines = lineRes.data || []

      let wipCount = null
      if (snapRes.data?.id) {
        const { count } = await supabase.from('sched_wip_rows')
          .select('*', { count: 'exact', head: true }).eq('snapshot_id', snapRes.data.id)
        if (!dead) wipCount = count ?? null
      }
      if (dead) return

      const sched   = asn.reduce((s, a) => s + num(a.planned_yards), 0)
      const schedNJ = asn.filter(a => a.site === 'passaic').reduce((s, a) => s + num(a.planned_yards), 0)
      const plannedCy = asn.filter(a => a.site === 'passaic').reduce((s, a) => s + num(a.planned_cy), 0)

      const actual   = lines.reduce((s, l) => s + num(l.actual_yards), 0)
      const actualNJ = lines.filter(l => l.site === 'passaic').reduce((s, l) => s + num(l.actual_yards), 0)
      const waste    = lines.reduce((s, l) => s + num(l.waste_yards), 0)
      const done     = lines.filter(l => l.is_complete).length

      // Passaic colour-yards = actual yards x the week's planned cy/yd ratio.
      // Same derivation as deriveColorYards(); BNY has no planned_cy so it is
      // excluded rather than counted as zero.
      const ratio  = schedNJ > 0 ? plannedCy / schedNJ : 0
      const actCy  = Math.round(actualNJ * ratio)

      setD({
        sched, actual, waste, done, lines: lines.length,
        plannedCy, actCy, wipCount,
        attain:  sched  > 0 ? (actual / sched) * 100 : null,
        wastePct: (actual + waste) > 0 ? (waste / (actual + waste)) * 100 : null,
        cyPct:   plannedCy > 0 ? (actCy / plannedCy) * 100 : null,
      })
    })()
    return () => { dead = true }
  }, [])

  const go = (tab) => () => onNavigate && onNavigate(tab)

  const grid = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))',
    gap: 10, marginBottom: 26,
  }

  if (!d) return (
    <div style={grid}>
      {[0,1,2,3,4,5].map(i => (
        <div key={i} style={{ minHeight: 104, borderRadius: 10, background: C.parchment,
                              border: `1px solid ${C.border}` }} />
      ))}
    </div>
  )

  const attainTone = d.attain == null ? 'mute' : d.attain >= 95 ? 'good' : d.attain >= 75 ? 'warn' : 'bad'
  const wasteTone  = d.wastePct == null ? 'mute' : d.wastePct <= 3 ? 'good' : d.wastePct <= 6 ? 'warn' : 'bad'

  return (
    <div style={grid}>
      <Tile
        label="Scheduled" value={fmt(d.sched)} unit="yds"
        sub="Committed for the week" onClick={go('scheduler')}
      />
      <Tile
        label="Actual" value={fmt(d.actual)} unit="yds"
        barPct={d.attain} barTone={attainTone}
        sub={d.attain == null ? 'Nothing scheduled' : `${Math.round(d.attain)}% of scheduled`}
        subTone={attainTone}
        onClick={go('liveops')}
      />
      <Tile
        label="Waste" value={fmt(d.waste)} unit="yds"
        sub={d.wastePct == null ? 'No production yet' : `${d.wastePct.toFixed(1)}% of produced`}
        subTone={wasteTone}
        onClick={go('liveops')}
      />
      <Tile
        label="Color-yards" value={fmt(d.actCy)} unit="cyds"
        barPct={d.cyPct} barTone="mute"
        sub={d.plannedCy > 0 ? `of ${fmt(d.plannedCy)} planned · Passaic` : 'Passaic only'}
        onClick={go('liveops')}
      />
      <Tile
        label="Open WIP" value={d.wipCount == null ? '—' : fmt(d.wipCount)} unit="rows"
        sub="Everything eligible to schedule" onClick={go('wip')}
      />
      <Tile
        label="Lines done" value={`${d.done}`} unit={`/ ${d.lines}`}
        barPct={d.lines > 0 ? (d.done / d.lines) * 100 : 0} barTone="mute"
        sub="Marked complete in Live Ops" onClick={go('status')}
      />
    </div>
  )
}
