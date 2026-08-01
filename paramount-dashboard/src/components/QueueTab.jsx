// QueueTab — the procurement window (Phase 2 of the Emily/Lydia build).
//
// WHY THIS EXISTS (Emily's email, 7/31 + Peter's direction, 8/1): procurement
// has no self-serve view of where orders sit in the production queue, so the
// answer to "where is my order" is an email, a text, or a working session
// reading 1,000 WIP lines aloud. This tab IS the answer: every open order at
// both sites, its live LIFT status, its age, and — the money column — the
// week and table/machine it is PLANNED for, or "unscheduled" in honest rose.
//
// Data spine: sched_wip_rows (latest snapshot, hourly LIFT feed) joined in
// the browser to sched_assignments (current week forward). No new plumbing.
// The FORWARD 30 DAYS band across the top is Emily's monthly-review ask as a
// live view: planned yards by mix group by week for the next four weeks.
//
// Phase 3 (Slack-a-row) and Phase 4 (shift ledger) will hang off the row
// detail — the layout leaves them a home.

import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'
import { C, fmt, fmtK, isoDate, addWeeks, defaultSchedulerWeek } from '../lib/scheduleUtils'
import LiftFreshnessBadge from './LiftFreshnessBadge'

// Same terminal blacklist as both schedulers — the Queue shows open work.
const TERMINAL = new Set([
  'Shipped', 'Invoiced', 'Cancelled', 'Canceled', 'Cancellation Fee', 'Closed', 'Complete', 'Completed',
])
const SCHEDULABLE = new Set(['Ready to Print', 'Print', 'Approved to Print'])
const WAITING_HINTS = ['Waiting', 'Mixing', 'Ink', 'Unallocated', 'Strike Off', 'Approval']

function statusFamily(s) {
  const st = s || ''
  if (SCHEDULABLE.has(st)) return 'schedulable'
  if (WAITING_HINTS.some(h => st.includes(h))) return 'waiting'
  return 'production'
}
const FAMILY_LABEL = { schedulable: 'Ready to schedule', waiting: 'Waiting / pre-production', production: 'In production' }
const FAMILY_COLOR = { schedulable: C.sage, waiting: C.amber, production: C.navy }

// Mix group in procurement's vocabulary: BNY rows carry their bucket
// (Replen / NEW GOODS / Custom / MTO / HOS / Memo / 3P); Passaic hand-screen
// rows are grouped Schumacher vs 3rd Party. "SPO" in Emily's email is
// believed to map to Custom — pending her confirmation.
function mixGroup(r) {
  if (r.bny_bucket) return r.bny_bucket
  if (r.site === 'procurement') return 'Procurement'
  return (r.customer_type || '').toLowerCase().includes('3rd') ? '3P (screen)' : 'SCH (screen)'
}

// Product category (Peter, 8/1): fabric / grasscloth / wallpaper chips "in
// case we need to get specific" — same mapping the Passaic scheduler uses.
function catGroup(r) {
  const t = (r.product_type || '').toLowerCase()
  if (t.includes('grass')) return 'grasscloth'
  if (t.includes('paper') || t.includes('panel')) return 'wallpaper'
  return 'fabric'
}

function lineKey(r) { return `${r.po_number}|${r.item_sku || ''}|${r.color || ''}` }

const WEEKLY_TARGET_YD = 23500  // Passaic 8,500 + BNY 15,000

// PHASE 5 — "are we running on schedule" as an HONEST PROXY. The LIFT feed
// carries no promise/due date (recon 8/1), so lateness = age vs a mix-group
// SLA. Clearly labeled as a proxy everywhere it appears; real dates are on
// the Paul/Vincent chase list and drop straight in when they exist.
const SLA_DAYS = {
  'MTO': 7, 'Custom': 30, 'NEW GOODS': 90, 'Replen': 60, 'HOS': 30, 'Memo': 30, '3P': 45,
  'SCH (screen)': 90, '3P (screen)': 90, 'Procurement': 90,
}
function lateness(r) {
  const sla = SLA_DAYS[mixGroup(r)] ?? 90
  const age = r.age_days || 0
  if (age > sla * 2) return { level: 'late', sla }
  if (age > sla) return { level: 'watch', sla }
  return { level: 'ok', sla }
}

const SHIFT_REASON_LABEL = {
  procurement_request: 'Procurement request', customer_expedite: 'Customer expedite',
  material_delay: 'Material delay', machine_down: 'Machine down',
  mix_rebalance: 'Mix rebalance', other: 'Other',
}

export default function QueueTab({ currentUser, defaultSite = 'all' }) {
  const [wipRows, setWipRows] = useState([])
  const [plans, setPlans] = useState([])          // sched_assignments, this Monday forward
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState(null)

  const [site, setSite] = useState(defaultSite)  // all | passaic | bny | procurement
  const [q, setQ] = useState('')
  const [family, setFamily] = useState('all')      // all | schedulable | waiting | production
  const [mix, setMix] = useState('all')
  const [cat, setCat] = useState('all')            // all | fabric | grasscloth | wallpaper
  const [plannedF, setPlannedF] = useState('all')  // all | scheduled | unscheduled
  const [sortBy, setSortBy] = useState('age')      // age | yards | rev | week
  const [openKey, setOpenKey] = useState(null)
  const [lateF, setLateF] = useState(false)        // Phase 5 proxy filter
  // PHASE 3 — Slack-a-row state, keyed by row.
  const [slackDraft, setSlackDraft] = useState({})
  const [slackState, setSlackState] = useState({}) // key -> 'busy' | 'sent' | error string
  // PHASE 4 — change history per PO, fetched lazily on expand.
  const [history, setHistory] = useState({})       // key -> rows | 'loading'

  const thisMonday = isoDate(defaultSchedulerWeek())

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setLoadErr(null)
      try {
        const { data: snaps, error: e1 } = await supabase
          .from('sched_snapshots').select('id, uploaded_at')
          .order('uploaded_at', { ascending: false }).limit(1)
        if (e1) throw e1
        const snapId = snaps?.[0]?.id
        if (!snapId) throw new Error('no LIFT snapshot found')
        // Default PostgREST page is 1,000 rows and the combined WIP runs
        // right at that line (641 + 375 today) — range() so nothing is
        // silently clipped as the plants grow.
        const { data: rows, error: e2 } = await supabase
          .from('sched_wip_rows').select('*')
          .eq('snapshot_id', snapId).range(0, 4999)
        if (e2) throw e2
        const { data: asn, error: e3 } = await supabase
          .from('sched_assignments').select('site, po_number, item_sku, color, table_code, week_start, day_of_week, planned_yards')
          .gte('week_start', thisMonday).range(0, 4999)
        if (e3) throw e3
        if (cancelled) return
        setWipRows((rows || []).filter(r => !TERMINAL.has(r.order_status || '')))
        setPlans(asn || [])
      } catch (err) {
        if (!cancelled) setLoadErr(String(err?.message || err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [thisMonday])

  // Plans indexed by line and by bare PO (legacy assignments carry no SKU).
  const plansByKey = useMemo(() => {
    const m = {}
    for (const p of plans) {
      const k = p.item_sku ? lineKey(p) : null
      const entry = { week: p.week_start, table: p.table_code, day: p.day_of_week, yards: Number(p.planned_yards || 0) }
      if (k) (m[k] = m[k] || []).push(entry)
      ;(m[`po:${p.po_number}`] = m[`po:${p.po_number}`] || []).push(entry)
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => (a.week < b.week ? -1 : 1))
    return m
  }, [plans])

  const rows = useMemo(() => wipRows.map(r => {
    const placements = plansByKey[lineKey(r)] || plansByKey[`po:${r.po_number}`] || []
    return { ...r, placements, planned: placements.length > 0, firstWeek: placements[0]?.week || null }
  }), [wipRows, plansByKey])

  const mixOptions = useMemo(() => {
    const s = new Set(rows.map(mixGroup)); return ['all', ...[...s].sort()]
  }, [rows])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let list = rows
    if (site !== 'all') list = list.filter(r => r.site === site)
    if (family !== 'all') list = list.filter(r => statusFamily(r.order_status) === family)
    if (mix !== 'all') list = list.filter(r => mixGroup(r) === mix)
    if (cat !== 'all') list = list.filter(r => catGroup(r) === cat)
    if (plannedF === 'scheduled') list = list.filter(r => r.planned)
    if (plannedF === 'unscheduled') list = list.filter(r => !r.planned)
    if (lateF) list = list.filter(r => lateness(r).level !== 'ok')
    if (needle) list = list.filter(r =>
      (r.po_number || '').toLowerCase().includes(needle)
      || (r.line_description || '').toLowerCase().includes(needle)
      || (r.customer_name_clean || '').toLowerCase().includes(needle)
      || (r.item_sku || '').toLowerCase().includes(needle))
    const by = {
      age:   (a, b) => (b.age_days || 0) - (a.age_days || 0),
      yards: (a, b) => (Number(b.yards_written) || 0) - (Number(a.yards_written) || 0),
      rev:   (a, b) => (Number(b.income_written) || 0) - (Number(a.income_written) || 0),
      week:  (a, b) => (a.firstWeek || '9999').localeCompare(b.firstWeek || '9999'),
    }
    return [...list].sort(by[sortBy] || by.age)
  }, [rows, site, q, family, mix, cat, plannedF, lateF, sortBy])

  // FORWARD 30 DAYS — planned yards by mix group for the next four Mondays.
  const forward = useMemo(() => {
    const weeks = [0, 1, 2, 3].map(n => isoDate(addWeeks(defaultSchedulerWeek(), n)))
    const wipByKey = {}
    for (const r of wipRows) { wipByKey[lineKey(r)] = r; if (!wipByKey[`po:${r.po_number}`]) wipByKey[`po:${r.po_number}`] = r }
    const cells = weeks.map(wk => ({ week: wk, total: 0, groups: {} }))
    for (const p of plans) {
      const i = weeks.indexOf(p.week_start)
      if (i < 0) continue
      const src = (p.item_sku && wipByKey[lineKey(p)]) || wipByKey[`po:${p.po_number}`]
      const g = src ? mixGroup(src) : 'Other'
      const yd = Number(p.planned_yards || 0)
      cells[i].total += yd
      cells[i].groups[g] = (cells[i].groups[g] || 0) + yd
    }
    return cells
  }, [plans, wipRows])

  async function openRow(r, k, open) {
    setOpenKey(open ? null : k)
    if (!open && history[k] === undefined) {
      setHistory(h => ({ ...h, [k]: 'loading' }))
      const { data } = await supabase.from('sched_shift_log')
        .select('change_kind, reason_category, requested_by, noted_by, note, detail, week_start, created_at')
        .eq('site', r.site).eq('po_number', r.po_number)
        .order('created_at', { ascending: false }).limit(20)
      setHistory(h => ({ ...h, [k]: data || [] }))
    }
  }

  async function sendSlack(r, k) {
    const comment = (slackDraft[k] || '').trim()
    // A guard without feedback is a bug: an empty click must SAY so, not
    // silently do nothing (Peter hit exactly this, 8/1).
    if (!comment) { setSlackState(s => ({ ...s, [k]: 'type a note first — then send' })); return }
    setSlackState(s => ({ ...s, [k]: 'busy' }))
    try {
      const res = await fetch('/.netlify/functions/slack-queue-notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          po: r.po_number, desc: r.line_description, sku: r.item_sku, colorway: r.color,
          site: r.site, status: r.order_status, age_days: r.age_days,
          yards: Math.round(Number(r.yards_written || 0)),
          planned: r.planned ? `wk ${r.firstWeek} · ${r.placements[0]?.table}` : null,
          comment, from: currentUser || 'the dashboard',
        }),
      })
      const j = await res.json()
      if (j.ok) { setSlackState(s => ({ ...s, [k]: 'sent' })); setSlackDraft(d => ({ ...d, [k]: '' })) }
      else setSlackState(s => ({ ...s, [k]: j.reason || 'failed' }))
    } catch (e) {
      setSlackState(s => ({ ...s, [k]: String(e) }))
    }
  }

  function exportCsv() {
    const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const header = ['Site', 'PO', 'Pattern', 'SKU', 'Colorway', 'Customer', 'Mix', 'LIFT Status', 'Age (days)', 'Yards', 'Revenue', 'Planned', 'Planned Week(s)', 'Table/Machine']
    const lines = filtered.map(r => [
      r.site, r.po_number, r.line_description, r.item_sku || '', r.color || '',
      r.customer_name_clean || '', mixGroup(r), r.order_status || '', r.age_days ?? '',
      Math.round(Number(r.yards_written || 0)), Math.round(Number(r.income_written || 0)),
      r.planned ? 'yes' : 'NO',
      [...new Set(r.placements.map(p => p.week))].join(' + '),
      [...new Set(r.placements.map(p => p.table))].join(' + '),
    ].map(esc).join(','))
    const csv = [header.join(','), ...lines].join('\r\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const el = document.createElement('a')
    el.href = url; el.download = `production-queue-${new Date().toISOString().slice(0, 10)}.csv`
    el.click(); URL.revokeObjectURL(url)
  }

  const chip = (active, color) => ({
    padding: '4px 11px', borderRadius: 14, fontSize: 11, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${active ? color : C.border}`,
    background: active ? color : 'transparent', color: active ? '#fff' : C.inkMid,
  })

  const unschedYd = filtered.filter(r => !r.planned).reduce((s, r) => s + Number(r.yards_written || 0), 0)

  if (loading) return <div style={{ padding: 40, color: C.inkLight }}>Loading the queue…</div>
  if (loadErr) return <div style={{ padding: 40, color: C.rose }}>Queue failed to load: {loadErr}</div>

  const shown = filtered.slice(0, 300)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 26, margin: 0 }}>Production Queue</h2>
        <span style={{ fontSize: 12, color: C.inkLight }}>every open order · live LIFT status · where it sits in the plan</span>
        <div style={{ flex: 1 }} />
        <LiftFreshnessBadge />
        <button onClick={exportCsv}
          style={{ padding: '7px 13px', background: 'transparent', color: C.navy, border: `1px solid ${C.navy}`, borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          ⤓ Export CSV
        </button>
      </div>

      {/* FORWARD 30 DAYS — Emily's monthly-review ask as a live view. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 10, margin: '14px 0 16px' }}>
        {forward.map((c, i) => {
          const pct = WEEKLY_TARGET_YD > 0 ? Math.round((c.total / WEEKLY_TARGET_YD) * 100) : 0
          const top = Object.entries(c.groups).sort((a, b) => b[1] - a[1]).slice(0, 4)
          return (
            <div key={c.week} style={{ background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {i === 0 ? 'This week' : `Week of ${c.week.slice(5).replace('-', '/')}`}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-display)', color: c.total > 0 ? C.ink : C.inkLight }}>
                {fmt(c.total)} <span style={{ fontSize: 11, fontWeight: 400 }}>yd planned</span>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: C.border, margin: '6px 0' }}>
                <div style={{ height: 5, borderRadius: 3, width: `${Math.min(100, pct)}%`, background: pct >= 85 ? C.sage : pct >= 50 ? C.amber : C.rose }} />
              </div>
              <div style={{ fontSize: 10, color: C.inkLight, marginBottom: 4 }}>{pct}% of {fmtK(WEEKLY_TARGET_YD)} yd combined target</div>
              {top.length === 0 && <div style={{ fontSize: 11, color: C.inkLight, fontStyle: 'italic' }}>nothing planned yet</div>}
              {top.map(([g, yd]) => (
                <div key={g} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: C.inkMid }}>{g}</span><span style={{ fontWeight: 600 }}>{fmt(yd)}</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search PO · pattern · customer · SKU"
          style={{ padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, minWidth: 240, background: 'var(--surface)', color: C.ink }} />
        {['all', 'passaic', 'bny', 'procurement'].map(s => (
          <button key={s} onClick={() => setSite(s)} style={chip(site === s, C.navy)}>
            {s === 'all' ? 'All' : s === 'passaic' ? 'Passaic (screen)' : s === 'bny' ? 'BNY (digital)' : 'Procurement'}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: C.border }} />
        {['all', 'fabric', 'grasscloth', 'wallpaper'].map(c2 => (
          <button key={c2} onClick={() => setCat(c2)} style={chip(cat === c2, C.gold)}>
            {c2 === 'all' ? 'All products' : c2 === 'grasscloth' ? 'Grasscloth' : c2 === 'wallpaper' ? 'Wallpaper' : 'Fabric'}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: C.border }} />
        {['all', 'schedulable', 'waiting', 'production'].map(f => (
          <button key={f} onClick={() => setFamily(f)} style={chip(family === f, FAMILY_COLOR[f] || C.navy)}>
            {f === 'all' ? 'All statuses' : FAMILY_LABEL[f]}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: C.border }} />
        {['all', 'scheduled', 'unscheduled'].map(f => (
          <button key={f} onClick={() => setPlannedF(f)} style={chip(plannedF === f, f === 'unscheduled' ? C.rose : C.sage)}>
            {f === 'all' ? 'Planned + not' : f}
          </button>
        ))}
        <button onClick={() => setLateF(v => !v)} style={chip(lateF, C.amber)} title="Age vs mix-group SLA — a proxy until LIFT gives us promise dates">
          ⚠ Late (proxy)
        </button>
        <select value={mix} onChange={e => setMix(e.target.value)}
          style={{ padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, background: 'var(--surface)', color: C.ink }}>
          {mixOptions.map(m => <option key={m} value={m}>{m === 'all' ? 'All mix groups' : m}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{ padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12, background: 'var(--surface)', color: C.ink }}>
          <option value="age">Oldest first</option>
          <option value="yards">Most yards</option>
          <option value="rev">Most revenue</option>
          <option value="week">Planned week</option>
        </select>
      </div>

      <div style={{ fontSize: 12, color: C.inkLight, marginBottom: 8 }}>
        {fmt(filtered.length)} orders · {fmt(filtered.reduce((s, r) => s + Number(r.yards_written || 0), 0))} yd open
        {unschedYd > 0 && <span style={{ color: C.rose, fontWeight: 600 }}> · {fmt(unschedYd)} yd not yet planned</span>}
        {filtered.length > 300 && <span> · showing first 300 — refine filters or export for the full set</span>}
      </div>

      {/* The queue */}
      <div style={{ display: 'grid', gap: 4 }}>
        {shown.map(r => {
          const k = lineKey(r) + r.site
          const fam = statusFamily(r.order_status)
          const open = openKey === k
          const late = lateness(r)
          return (
            <div key={k} onClick={() => openRow(r, k, open)}
              style={{ background: 'var(--surface)', border: `1px solid ${open ? C.navy : C.border}`, borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, background: r.site === 'passaic' ? C.navyLight : r.site === 'bny' ? C.goldBg : C.sageBg, color: r.site === 'passaic' ? C.navy : r.site === 'bny' ? C.gold : C.sage }}>
                  {r.site === 'passaic' ? 'PSC' : r.site === 'bny' ? 'BNY' : 'PRC'}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.inkMid }}>{r.po_number}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                  {r.line_description}
                </span>
                <span style={{ fontSize: 10, color: C.inkLight }}>{r.customer_name_clean || ''}</span>
                <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, border: `1px solid ${FAMILY_COLOR[fam]}`, color: FAMILY_COLOR[fam] }}>
                  {(r.order_status || 'unknown').toUpperCase()}
                </span>
                <span style={{ fontSize: 10, color: C.inkLight }}>{mixGroup(r)}</span>
                <div style={{ flex: 1 }} />
                {late.level !== 'ok' && (
                  <span title={`Proxy: ${r.age_days}d old vs ${late.sla}d SLA for ${mixGroup(r)} — real promise dates pending LIFT`}
                    style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, background: late.level === 'late' ? C.roseBg : C.amberBg, color: late.level === 'late' ? C.rose : C.amber }}>
                    ⚠ {late.level === 'late' ? 'LATE' : 'WATCH'}
                  </span>
                )}
                <span style={{ fontSize: 11, color: (r.age_days || 0) > 90 ? C.rose : C.inkLight, fontWeight: (r.age_days || 0) > 90 ? 700 : 400 }}>{r.age_days ?? '—'}d</span>
                <span style={{ fontSize: 11, color: C.inkMid }}>{fmt(Number(r.yards_written || 0))} yd</span>
                {r.planned ? (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: C.sageBg, color: C.sage }}>
                    wk {r.firstWeek?.slice(5).replace('-', '/')} · {r.placements[0]?.table}
                  </span>
                ) : (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: C.roseBg, color: C.rose }}>
                    unscheduled
                  </span>
                )}
              </div>
              {open && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${C.border}`, fontSize: 11, color: C.inkMid, display: 'grid', gap: 3 }}>
                  <div>
                    {r.item_sku || 'no SKU'}{r.color ? ` · ${r.color}` : ''} · {r.product_type || '—'} · {r.colors_count || 0} colors ·
                    {' '}{fmt(Number(r.color_yards || 0))} CY · ${fmt(Math.round(Number(r.income_written || 0)))} · ordered {r.order_created || '—'}
                  </div>
                  {r.placements.length === 0 && (
                    <div style={{ color: C.rose }}>Not on any week's board yet — it competes in the pool on age, mix and status.</div>
                  )}
                  {r.placements.map((p, i) => (
                    <div key={i} style={{ color: C.sage }}>
                      ✓ Planned · week of {p.week} · {p.table}{p.day ? ` · ${p.day}` : ''} · {fmt(p.yards)} yd
                    </div>
                  ))}
                  {late.level !== 'ok' && (
                    <div style={{ color: late.level === 'late' ? C.rose : C.amber }}>
                      ⚠ {late.level === 'late' ? 'Late' : 'Watch'} by proxy: {r.age_days}d old vs a {late.sla}d SLA for {mixGroup(r)}. (Age-based — LIFT has no promise date yet.)
                    </div>
                  )}
                  {/* PHASE 4 — change history from the shift ledger. */}
                  {history[k] === 'loading' && <div style={{ color: C.inkLight }}>loading change history…</div>}
                  {Array.isArray(history[k]) && history[k].length > 0 && (
                    <div style={{ display: 'grid', gap: 2, marginTop: 2 }}>
                      <div style={{ fontSize: 10, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Change history</div>
                      {history[k].map((h2, i) => (
                        <div key={i} style={{ color: C.inkMid }}>
                          {h2.change_kind === 'added' ? '+' : h2.change_kind === 'removed' ? '−' : 'Δ'} wk {h2.week_start} · <strong>{SHIFT_REASON_LABEL[h2.reason_category] || h2.reason_category}</strong>
                          {h2.requested_by ? ` · asked by ${h2.requested_by}` : ''}{h2.noted_by ? ` · noted by ${h2.noted_by}` : ''}
                          {h2.note ? ` — ${h2.note}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* PHASE 3 — Slack this order. */}
                  <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                    <input value={slackDraft[k] || ''} onChange={e => { setSlackDraft(d => ({ ...d, [k]: e.target.value })); setSlackState(s => { const n = { ...s }; delete n[k]; return n }) }}
                      placeholder="Slack this order to the team — question, priority call, heads-up…"
                      onKeyDown={e => { if (e.key === 'Enter') sendSlack(r, k) }}
                      style={{ flex: 1, padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, background: 'var(--surface)', color: C.ink }} />
                    <button onClick={() => sendSlack(r, k)} disabled={slackState[k] === 'busy'}
                      style={{ padding: '6px 12px', background: slackState[k] === 'busy' ? '#9ca3af' : (slackDraft[k] || '').trim() ? C.navy : C.inkLight, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      💬 Slack
                    </button>
                    {slackState[k] === 'sent' && <span style={{ color: C.sage, fontSize: 11, fontWeight: 700 }}>✓ sent</span>}
                    {slackState[k] && slackState[k] !== 'sent' && slackState[k] !== 'busy' && <span style={{ color: C.rose, fontSize: 11 }}>{slackState[k]}</span>}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
