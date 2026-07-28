import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, sundayOf, isoDate, fmt } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// OpsAttentionPanel — the only thing on Pulse that isn't a number.
//
// Tiles tell you WHAT the week is doing. This tells you what's WRONG with it.
// Every item is a condition worth acting on, phrased as the thing itself
// rather than a metric — "104 POs past 120 days", not "aged WIP: 104".
//
// RULES IT FOLLOWS:
//   · Silence is a valid state. If nothing qualifies, it says so and stops.
//     A panel that always finds three problems trains people to ignore it.
//   · Severity is earned, not decorative. Red means someone should do
//     something today; amber means this week; nothing else gets a dot.
//   · Every item is clickable through to the place it can be fixed.
//
// Thresholds are deliberately conservative — better to under-report than to
// cry wolf on a Monday morning.
// ═══════════════════════════════════════════════════════════════════════════

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }

export default function OpsAttentionPanel({ onNavigate, sites = ['passaic', 'bny'] }) {
  const [items, setItems] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const wk = isoDate(sundayOf(new Date()))
      const out = []

      const [snapRes, asnRes, lineRes] = await Promise.all([
        supabase.from('sched_snapshots').select('id,uploaded_at')
          .order('uploaded_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('sched_assignments').select('site,planned_yards').eq('week_start', wk).in('site', sites),
        supabase.from('sched_daily_ops_lines').select('site,actual_yards,waste_yards').eq('week_start', wk).in('site', sites),
      ])
      if (dead) return

      const asn   = asnRes.data || []
      const lines = lineRes.data || []

      // ── Aged WIP ─────────────────────────────────────────────────────────
      // MUST carry the same site filter as the WIP tile above it. Without it
      // this counted procurement rows too — 83 of the 258 reported on 27 July
      // were the Korean supply line, in an alert whose subtitle reads "worth a
      // pass with Ramon". A third of what it put in front of him was not his,
      // and not production.
      if (snapRes.data?.id) {
        const { count } = await supabase.from('sched_wip_rows')
          .select('*', { count: 'exact', head: true })
          .eq('snapshot_id', snapRes.data.id).in('site', sites).gte('age_days', 120)
        if (!dead && count > 0) {
          out.push({
            tone: count > 80 ? 'bad' : 'warn',
            text: `${fmt(count)} PO${count !== 1 ? 's' : ''} past 120 days`,
            sub: 'Oldest work in the pool — worth a pass with Ramon',
            tab: 'wip',
          })
        }
      }
      if (dead) return

      // ── Nothing scheduled ────────────────────────────────────────────────
      const sched = asn.reduce((s, a) => s + num(a.planned_yards), 0)
      if (sched === 0) {
        out.push({
          tone: 'bad',
          text: 'No work scheduled this week',
          sub: 'The board is empty — nothing for the floor to run',
          tab: 'scheduler',
        })
      }

      // ── Actuals not being recorded ───────────────────────────────────────
      // Only meaningful once the week is actually under way. Sunday morning
      // with nothing recorded is correct, not a problem.
      const dow = new Date().getDay()          // 0 Sun … 6 Sat
      const actual = lines.reduce((s, l) => s + num(l.actual_yards), 0)
      if (dow >= 2 && dow <= 6 && sched > 0 && actual === 0) {
        out.push({
          tone: 'bad',
          text: 'No actuals recorded yet this week',
          sub: 'The schedule is live but nothing has come off the floor',
          tab: 'liveops',
        })
      }

      // ── Waste running hot ────────────────────────────────────────────────
      const waste = lines.reduce((s, l) => s + num(l.waste_yards), 0)
      const wastePct = (actual + waste) > 0 ? (waste / (actual + waste)) * 100 : 0
      if (actual > 0 && wastePct > 6) {
        out.push({
          tone: wastePct > 10 ? 'bad' : 'warn',
          text: `Waste at ${wastePct.toFixed(1)}% of produced`,
          sub: 'Above the 6% line — check the notes for cause',
          tab: 'liveops',
        })
      }

      // ── A site with a plan but no output ─────────────────────────────────
      for (const [key, label] of [['passaic', 'Passaic'], ['bny', 'Brooklyn']]) {
        const s = asn.filter(a => (key === 'passaic' ? a.site === 'passaic' : a.site !== 'passaic'))
                     .reduce((t, a) => t + num(a.planned_yards), 0)
        const a = lines.filter(l => (key === 'passaic' ? l.site === 'passaic' : l.site !== 'passaic'))
                       .reduce((t, l) => t + num(l.actual_yards), 0)
        if (dow >= 3 && s > 0 && a / s < 0.35) {
          out.push({
            tone: 'warn',
            text: `${label} at ${Math.round((a / s) * 100)}% of plan`,
            sub: `${fmt(s - a)} yd behind with the week part-run`,
            tab: 'status',
          })
        }
      }

      setItems(out)
    })()
    return () => { dead = true }
  }, [sites.join(',')])

  const tone = { bad: C.rose, warn: C.amber }

  const shell = {
    background: C.parchment, border: `1px solid ${C.border}`,
    borderRadius: 10, padding: '14px 16px', marginBottom: 26,
  }
  const head = {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
    textTransform: 'uppercase', color: C.inkLight, marginBottom: 12,
  }

  if (!items) return <div style={{ ...shell, height: 96 }} />

  if (items.length === 0) return (
    <div style={shell}>
      <div style={head}>Needs attention</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: C.sage }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.sage, display: 'inline-block' }} />
        Nothing flagged — the week is running to plan.
      </div>
    </div>
  )

  return (
    <div style={shell}>
      <div style={head}>Needs attention</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((it, i) => (
          <button key={i} onClick={() => onNavigate && onNavigate(it.tab)}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left',
              background: 'transparent', border: 'none', padding: 0,
              cursor: onNavigate ? 'pointer' : 'default', fontFamily: 'inherit',
            }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 6,
              background: tone[it.tone] || C.inkLight, display: 'inline-block',
            }} />
            <span>
              <span style={{ display: 'block', fontSize: 13, color: C.ink, lineHeight: 1.35 }}>{it.text}</span>
              <span style={{ display: 'block', fontSize: 11, color: C.inkLight, lineHeight: 1.45, marginTop: 1 }}>{it.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
