import React, { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'

// ═══════════════════════════════════════════════════════════════════════════
// DeckKpiTrend — every production KPI from the month-end decks, as a trend.
//
// Source: deck_kpis, extracted from the KPI slides of each month's deck
// (located by slide TITLE, never page number — pages drift month to month)
// and verified before load: the HTI chain (prior month held == last month's
// held, 10/10 links Jan→Jun) plus hand-tied spot checks. The table stores the
// deck AS PUBLISHED — value is the parsed number, display is the exact cell
// text ("<8,500", "2,851 (11%)", "Red"), so thresholds and the early months'
// traffic-light words survive verbatim.
//
// TRAFFIC LIGHTS: where the deck printed a color word (609 every month,
// 610 Jan–Feb) we show the DECK'S OWN grade. From March the 610 slide went to
// numeric gaps, so we grade actual-vs-target with metric direction:
// waste / HTI are lower-is-better, produced / invoiced higher-is-better.
// The two regimes are visually identical on purpose.
//
// Metric order is the slide-4 yard identity, top to bottom — the same
// waterfall every role owns one term of. December's deck predates this
// format entirely and is deliberately absent (library-only).
// ═══════════════════════════════════════════════════════════════════════════

export const METRICS = [
  { key: 'prior_hti',        label: 'Prior month HTI',   dir: 'low'  },
  { key: 'gross_produced',   label: 'Gross produced',    dir: 'high' },
  { key: 'production_waste', label: 'Production waste',  dir: 'low'  },
  { key: 'postprod_waste',   label: 'Post-prod waste',   dir: 'low'  },
  { key: 'net_produced',     label: 'Net produced',      dir: 'high' },
  { key: 'hti',              label: 'Held-to-invoice',   dir: 'low'  },
  { key: 'invoiced',         label: 'Invoiced',          dir: 'high' },
]

const CUT_LABEL = {
  grasscloth: 'Grasscloth', fabric: 'Fabric', wallpaper: 'Wallpaper',
  replen: 'Replen', mto: 'MTO', hospitality: 'Hospitality', memos: 'Memos',
  third_party: '3rd party', brooklyn: 'Brooklyn', passaic: 'Passaic (digital)',
}
const cutLabel = (ck) => {
  if (ck.includes(':')) {
    const [site, job] = ck.split(':')
    return `${CUT_LABEL[site] || site} · ${CUT_LABEL[job] || job}`
  }
  return CUT_LABEL[ck] || ck
}

const GREEN = '#3DD68C', AMBER = '#F5B544', RED = '#F2555A'
const STATUS_COLOR = { green: GREEN, amber: AMBER, red: RED }

const fmt = (v) => v == null ? '—'
  : Math.round(v).toLocaleString('en-US')

const fmtD = (v, dp = 0) => v == null ? '—'
  : '$' + v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })

const monthLabel = (p) =>
  new Date(p + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })

// Grade a cell. Deck's own word wins; otherwise direction-aware vs target.
export function statusOf(metricDir, actual, target, gapDisplay) {
  const word = (gapDisplay || '').trim().toLowerCase()
  if (word === 'green') return 'green'
  if (word === 'yellow') return 'amber'
  if (word === 'red') return 'red'
  if (actual == null || target == null) return null
  if (metricDir === 'low') {
    if (actual <= target) return 'green'
    if (target !== 0 && actual <= target * 1.1) return 'amber'
    return 'red'
  }
  if (actual >= target) return 'green'
  if (actual >= target * 0.9) return 'amber'
  return 'red'
}

export default function DeckKpiTrend() {
  const [rows, setRows] = useState(null)
  const [fin, setFin] = useState(null)     // vena_monthly revenue + COGS per period/cc
  const [err, setErr] = useState(null)
  const [cc, setCc] = useState('610')
  const [open, setOpen] = useState({})   // metricKey -> bool (cut drill-down)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const { data, error } = await supabase.from('deck_kpis')
        .select('*').limit(2000)
      if (dead) return
      if (error) setErr(error.message)
      else setRows(data || [])
    })()
    return () => { dead = true }
  }, [])

  // ── DOLLARS: Vena revenue + total COGS join in on (period, cost centre). ──
  // Cost/yd = COGS ÷ invoiced yards — the deck's own definition, verified to
  // the cent against June ($13.38) and May ($14.02) before this shipped.
  // Waste cost prices waste yards at that month's blended COGS per invoiced
  // yard; HTI value prices held yards at that month's revenue per invoiced
  // yard. Both are approximations, but consistently defined ones.
  useEffect(() => {
    let dead = false
    ;(async () => {
      const { data, error } = await supabase.from('vena_monthly')
        .select('period,cost_center,line_key,amount')
        .eq('timeframe', 'month').eq('scenario', 'actual')
        .in('line_key', ['total_revenue', 'total_cost_of_goods_sold'])
        .in('cost_center', ['610', '609'])
      if (dead) return
      if (!error) {
        const m = {}
        for (const r of (data || [])) {
          const p = r.period + '-01'                 // vena keys 'YYYY-MM'
          const k = r.cost_center + '|' + p
          m[k] = m[k] || {}
          if (r.line_key === 'total_revenue') m[k].revenue = Number(r.amount)
          else m[k].cogs = Number(r.amount)
        }
        setFin(m)
      }
    })()
    return () => { dead = true }
  }, [])

  const months = useMemo(() => rows
    ? [...new Set(rows.map(r => r.period))].sort()
    : [], [rows])

  // index: cc|metric|unit|cutType|cutKey|scenario|period -> row
  const ix = useMemo(() => {
    const m = {}
    if (rows) for (const r of rows)
      m[[r.cost_center, r.metric_key, r.unit, r.cut_type, r.cut_key, r.scenario, r.period].join('|')] = r
    return m
  }, [rows])
  const cell = (mk, u, ct, ck, sc, p) => ix[[cc, mk, u, ct, ck, sc, p].join('|')]

  // which cut rows exist for a metric at this cc (actuals, any month)
  const cutsFor = (mk, u) => {
    if (!rows) return []
    const seen = new Map()
    for (const r of rows) {
      if (r.cost_center !== cc || r.metric_key !== mk || r.unit !== u) continue
      if (r.scenario !== 'actual' || r.cut_type === 'total') continue
      const order = r.cut_type === 'site' ? 1 : r.cut_type === 'site_job' ? 2 : 0
      if (!seen.has(r.cut_key)) seen.set(r.cut_key, { ct: r.cut_type, ck: r.cut_key, order })
    }
    return [...seen.values()].sort((a, b) =>
      a.order - b.order || a.ck.localeCompare(b.ck))
  }

  // metric rows to render: yards always; a CY sibling where CY data exists
  // Dollar series for the selected cc, keyed by period
  const dollars = useMemo(() => {
    if (!fin || !rows) return {}
    const out = {}
    for (const p of [...new Set(rows.map(r => r.period))]) {
      const f = fin[cc + '|' + p]
      const inv = ix[[cc, 'invoiced', 'yards', 'total', 'total', 'actual', p].join('|')]?.value
      const waste = ix[[cc, 'production_waste', 'yards', 'total', 'total', 'actual', p].join('|')]?.value
      const hti = ix[[cc, 'hti', 'yards', 'total', 'total', 'actual', p].join('|')]?.value
      if (!f || !inv) continue
      out[p] = {
        costPerYd: f.cogs != null ? f.cogs / inv : null,
        revPerYd:  f.revenue != null ? f.revenue / inv : null,
        wasteCost: (f.cogs != null && waste != null) ? waste * f.cogs / inv : null,
        htiValue:  (f.revenue != null && hti != null) ? hti * f.revenue / inv : null,
      }
    }
    return out
  }, [fin, rows, ix, cc])

  // ── FINDINGS: deterministic pattern detection over the table. No AI and no
  // judgement — red streaks, monotonic worsening runs, target volatility and
  // best-of-year, straight arithmetic on the same cells rendered above, so it
  // cannot say anything the table doesn't. prior_hti is excluded (it mirrors
  // last month's HTI) and postprod is excluded from run detection (tiny
  // numbers, all noise). ──
  const findings = useMemo(() => {
    if (!rows || months.length < 3) return []
    const out = []
    const val = (mk, p) => ix[[cc, mk, 'yards', 'total', 'total', 'actual', p].join('|')]?.value
    const tgt = (mk, p) => ix[[cc, mk, 'yards', 'total', 'total', 'target', p].join('|')]?.value
    const gp  = (mk, p) => ix[[cc, mk, 'yards', 'total', 'total', 'gap', p].join('|')]?.display
    const last = months[months.length - 1]
    const CHECK = METRICS.filter(m => !['prior_hti', 'postprod_waste'].includes(m.key))
    const volMetrics = []
    for (const m of CHECK) {
      const sts = months.map(p => statusOf(m.dir, val(m.key, p), tgt(m.key, p), gp(m.key, p)))
      const vs = months.map(p => val(m.key, p))
      // red streak ending at the latest month
      let streak = 0
      for (let i = sts.length - 1; i >= 0 && sts[i] === 'red'; i--) streak++
      if (streak >= 3) out.push({
        sev: 0, color: RED,
        text: `${m.label} has missed target ${streak === months.length ? `all ${streak}` : streak + ' straight'} months`,
      })
      // chronic miss without a live streak — one good month shouldn't hide five bad ones
      const reds = sts.filter(s => s === 'red').length
      if (streak < 3 && reds >= 4) out.push({
        sev: 1, color: RED,
        text: `${m.label} missed target ${reds} of ${months.length} months`,
      })
      // monotonic worsening run ending at the latest month
      let run = 0
      for (let i = vs.length - 1; i > 0; i--) {
        const a = vs[i], b = vs[i - 1]
        if (a == null || b == null) break
        if (m.dir === 'low' ? a > b : a < b) run++; else break
      }
      if (run >= 3) {
        const fromP = months[months.length - 1 - run]
        let extra = ''
        if (m.key === 'production_waste' && dollars[fromP]?.wasteCost != null && dollars[last]?.wasteCost != null)
          extra = ` · ${fmtD(dollars[fromP].wasteCost)} → ${fmtD(dollars[last].wasteCost)} at blended cost`
        out.push({
          sev: 2, color: AMBER,
          text: `${m.label} has ${m.dir === 'low' ? 'worsened' : 'fallen'} ${run + 1} months running, ${fmt(vs[vs.length - 1 - run])} → ${fmt(vs[vs.length - 1])}${extra}`,
        })
      }
      // best month of the year, on a metric that has struggled
      const good = vs.filter(v => v != null)
      if (good.length >= 4 && vs[vs.length - 1] != null && sts.includes('red')) {
        const best = m.dir === 'low' ? Math.min(...good) : Math.max(...good)
        if (vs[vs.length - 1] === best) out.push({
          sev: 5, color: GREEN,
          text: `${monthLabel(last)} ${m.label.toLowerCase()} is the best month of the year (${fmt(best)})`,
        })
      }
      // target volatility — collect, report once below
      const tset = new Set(months.map(p => tgt(m.key, p)).filter(v => v != null))
      if (tset.size >= 3) volMetrics.push({ label: m.label, n: tset.size })
    }
    if (volMetrics.length > 0) {
      const worst = volMetrics.reduce((a, b) => b.n > a.n ? b : a)
      out.push({
        sev: 4, color: AMBER,
        text: `Targets moved on ${volMetrics.length} metric${volMetrics.length > 1 ? 's' : ''} this year (${worst.label.toLowerCase()} ${worst.n} times) — the lights partly grade the bar, not the work`,
      })
    }
    return out.sort((a, b) => a.sev - b.sev).slice(0, 6)
  }, [rows, months, ix, dollars, cc])

  const metricRows = useMemo(() => {
    if (!rows) return []
    const hasCY = new Set(rows.filter(r =>
      r.cost_center === cc && r.unit === 'color_yards').map(r => r.metric_key))
    const out = []
    for (const m of METRICS) {
      const anyYd = rows.some(r => r.cost_center === cc && r.metric_key === m.key && r.unit === 'yards')
      if (!anyYd) continue
      out.push({ ...m, unit: 'yards' })
      if (hasCY.has(m.key)) out.push({ ...m, unit: 'color_yards', label: '· color yards', sub: true })
    }
    return out
  }, [rows, cc])

  const S = {
    wrap: { padding: '8px 28px 40px', maxWidth: 1180, margin: '0 auto' },
    bar:  { display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 14px' },
    seg:  (on) => ({
      padding: '6px 14px', fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
      background: on ? 'var(--surface-2, #262B31)' : 'transparent',
      color: on ? 'var(--ink, #F4F3EF)' : 'var(--ink-60, #A2A9B1)',
      border: `1px solid ${on ? 'var(--border, #2A3340)' : 'transparent'}`,
    }),
    note: { fontSize: 11, color: 'var(--ink-40, #737A82)', marginLeft: 'auto' },
    scroller: { overflowX: 'auto', border: '1px solid var(--border, #2A3340)', borderRadius: 10 },
    table: { borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 760 },
    th:   { position: 'sticky', top: 0, background: 'var(--paper-soft, #0A0E12)', zIndex: 2,
            padding: '8px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--ink-60, #A2A9B1)', textAlign: 'right',
            borderBottom: '1px solid var(--border, #2A3340)' },
    thL:  { textAlign: 'left', position: 'sticky', left: 0, zIndex: 3 },
    tdL:  (sub, isCut) => ({
      position: 'sticky', left: 0, zIndex: 1,
      background: 'var(--surface, #1D2126)',
      padding: sub || isCut ? '5px 10px 5px 26px' : '8px 10px',
      fontSize: sub || isCut ? 11 : 12.5, fontWeight: sub || isCut ? 400 : 600,
      color: sub || isCut ? 'var(--ink-60, #A2A9B1)' : 'var(--ink, #F4F3EF)',
      whiteSpace: 'nowrap', borderBottom: '1px solid var(--border, #2A3340)',
      cursor: !sub && !isCut ? 'pointer' : 'default',
    }),
    td:   { padding: '5px 10px', textAlign: 'right', verticalAlign: 'top',
            borderBottom: '1px solid var(--border, #2A3340)' },
    act:  (color) => ({
      fontFamily: 'var(--font-display, inherit)', fontSize: 13.5,
      color: color ? STATUS_COLOR[color] : 'var(--ink, #F4F3EF)',
    }),
    tgt:  { fontSize: 10, color: 'var(--ink-40, #737A82)', marginTop: 1 },
    cut:  { fontFamily: 'var(--font-display, inherit)', fontSize: 12,
            color: 'var(--ink-60, #A2A9B1)' },
    fold: { display: 'inline-block', width: 14, marginRight: 6, fontSize: 10,
            color: 'var(--ink-40, #737A82)' },
    legend: { display: 'flex', gap: 14, fontSize: 10.5, color: 'var(--ink-60, #A2A9B1)', marginTop: 10 },
    dot:  (c) => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                    background: c, marginRight: 5, verticalAlign: 'baseline' }),
  }

  const DOLLAR_ROWS = [
    { key: 'costPerYd', label: 'Cost per invoiced yd', dp: 2, color: 'var(--ink, #F4F3EF)' },
    { key: 'revPerYd',  label: 'Revenue per invoiced yd', dp: 2, color: 'var(--revenue, #3DD68C)' },
    { key: 'wasteCost', label: 'Production waste cost', dp: 0, color: 'var(--waste, #F2555A)' },
    { key: 'htiValue',  label: 'HTI at revenue value', dp: 0, color: 'var(--ink, #F4F3EF)' },
  ]

  // ── H1 TOTALS: Jan–Jun in one column. Flows SUM (gross, waste, net,
  // invoiced); stocks DON'T — HTI is a point-in-time balance, so H1 shows
  // where it ENDED (latest month). Grading happens only when every month
  // contributed both an actual and a target — a 4-month partial sum graded
  // against a 6-month target bar would grade the calendar, not the work
  // (610 net_produced only exists Mar–Jun; it shows the sum tagged "4 mo",
  // ungraded). Cut drill-down rows show no H1 — the cuts change shape across
  // deck generations, so their partial sums would mislead. ──
  const H1_LAST = months[months.length - 1]
  const h1For = (mk, u, dir) => {
    if (mk === 'prior_hti') return null            // mirrors last month's HTI — no total
    if (mk === 'hti') {
      const a = ix[[cc, mk, u, 'total', 'total', 'actual', H1_LAST].join('|')]
      const t = ix[[cc, mk, u, 'total', 'total', 'target', H1_LAST].join('|')]
      const g = ix[[cc, mk, u, 'total', 'total', 'gap', H1_LAST].join('|')]
      if (a?.value == null) return null
      return { v: a.value, sub: `at ${monthLabel(H1_LAST)} close`,
               st: statusOf(dir, a.value, t?.value, g?.display) }
    }
    let a = 0, na = 0, t = 0, nt = 0
    for (const p of months) {
      const av = ix[[cc, mk, u, 'total', 'total', 'actual', p].join('|')]?.value
      const tv = ix[[cc, mk, u, 'total', 'total', 'target', p].join('|')]?.value
      if (av != null) { a += Number(av); na++ }
      if (tv != null) { t += Number(tv); nt++ }
    }
    if (na === 0) return null
    const complete = na === months.length && nt === months.length
    return {
      v: a,
      sub: complete ? `Σ target ${fmt(t)}` : `${na} mo`,
      st: complete ? statusOf(dir, a, t, null) : null,
    }
  }

  // Dollar H1: cost/yd and rev/yd are TOTAL ÷ TOTAL across the half — never
  // an average of monthly averages. Waste cost sums (each month already priced
  // at its own blended rate). HTI value is the balance at the latest close.
  const h1Dollars = useMemo(() => {
    if (!fin || !rows || months.length === 0) return null
    let rev = 0, cogs = 0, inv = 0, waste = 0
    for (const p of months) {
      const f = fin[cc + '|' + p]
      const iv = ix[[cc, 'invoiced', 'yards', 'total', 'total', 'actual', p].join('|')]?.value
      const w  = ix[[cc, 'production_waste', 'yards', 'total', 'total', 'actual', p].join('|')]?.value
      if (!f || iv == null || !(Number(iv) > 0)) continue
      rev  += f.revenue || 0
      cogs += f.cogs || 0
      inv  += Number(iv)
      if (w != null && f.cogs != null) waste += Number(w) * f.cogs / Number(iv)
    }
    if (!(inv > 0)) return null
    return {
      costPerYd: cogs / inv,
      revPerYd:  rev / inv,
      wasteCost: waste,
      htiValue:  dollars[H1_LAST]?.htiValue ?? null,
    }
  }, [fin, rows, months, ix, cc, dollars, H1_LAST])

  // H1 column separation — a quiet left rule so totals read as a different
  // register from the months, not a seventh month.
  const h1Td = { borderLeft: '1px solid var(--border, #2A3340)' }

  if (err) return <div style={{ ...S.wrap, color: RED, fontSize: 13 }}>Couldn't load KPI data: {err}</div>
  if (!rows) return <div style={{ ...S.wrap, color: 'var(--ink-60)', fontSize: 13 }}>Loading KPI trend…</div>

  return (
    <div style={S.wrap}>
      <div style={{ padding: '16px 0 2px' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                      color: 'var(--ink-60, #A2A9B1)', marginBottom: 4 }}>
          Finance · managed to
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 10px' }}>Production KPIs</h2>
      </div>
      <div style={S.bar}>
        <button style={S.seg(cc === '610')} onClick={() => setCc('610')}>Screen 610</button>
        <button style={S.seg(cc === '609')} onClick={() => setCc('609')}>Digital 609</button>
        <div style={S.note}>
          From the month-end deck KPI slides, as published · click a metric for its breakdown
        </div>
      </div>

      <div style={S.scroller}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, ...S.thL }}>KPI · yards unless noted</th>
              {months.map(p => <th key={p} style={S.th}>{monthLabel(p)}</th>)}
              <th style={{ ...S.th, ...h1Td }}>H1</th>
            </tr>
          </thead>
          <tbody>
            {metricRows.map(m => {
              const isOpen = !m.sub && open[m.key]
              const cuts = isOpen ? cutsFor(m.key, m.unit) : []
              return (
                <React.Fragment key={m.key + m.unit}>
                  <tr>
                    <td
                      style={S.tdL(m.sub, false)}
                      onClick={() => { if (!m.sub) setOpen(o => ({ ...o, [m.key]: !o[m.key] })) }}
                    >
                      {!m.sub && <span style={S.fold}>{isOpen ? '−' : '+'}</span>}
                      {m.label}
                    </td>
                    {months.map(p => {
                      const a = cell(m.key, m.unit, 'total', 'total', 'actual', p)
                      const t = cell(m.key, m.unit, 'total', 'total', 'target', p)
                      const g = cell(m.key, m.unit, 'total', 'total', 'gap', p)
                      const st = statusOf(m.dir, a?.value, t?.value, g?.display)
                      return (
                        <td key={p} style={S.td}>
                          <div style={S.act(st)}>{a ? fmt(a.value) : '—'}</div>
                          {t && <div style={S.tgt}>{t.display}</div>}
                        </td>
                      )
                    })}
                    {(() => {
                      const h = h1For(m.key, m.unit, m.dir)
                      return (
                        <td style={{ ...S.td, ...h1Td }}>
                          <div style={S.act(h?.st ?? null)}>{h ? fmt(Math.round(h.v)) : '—'}</div>
                          {h?.sub && <div style={S.tgt}>{h.sub}</div>}
                        </td>
                      )
                    })()}
                  </tr>
                  {isOpen && cuts.map(c => (
                    <tr key={m.key + c.ck}>
                      <td style={S.tdL(false, true)}>
                        <span style={{ paddingLeft: c.ct === 'site_job' ? 14 : 0 }}>
                          {cutLabel(c.ck)}
                        </span>
                      </td>
                      {months.map(p => {
                        const a = cell(m.key, m.unit, c.ct, c.ck, 'actual', p)
                        return (
                          <td key={p} style={S.td}>
                            <div style={S.cut}>{a ? fmt(a.value) : '—'}</div>
                          </td>
                        )
                      })}
                      <td style={{ ...S.td, ...h1Td }}><div style={S.cut}>—</div></td>
                    </tr>
                  ))}
                </React.Fragment>
              )
            })}
            {Object.keys(dollars).length > 0 && (
              <>
                <tr>
                  <td style={{ ...S.tdL(false, false), cursor: 'default', paddingTop: 14,
                               fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                               textTransform: 'uppercase', color: 'var(--ink-60, #A2A9B1)' }}>
                    Dollar value · Vena joined
                  </td>
                  {months.map(p => <td key={p} style={{ ...S.td, paddingTop: 14 }} />)}
                  <td style={{ ...S.td, ...h1Td, paddingTop: 14 }} />
                </tr>
                {DOLLAR_ROWS.map(d => (
                  <tr key={d.key}>
                    <td style={S.tdL(false, false)} onClick={undefined}>
                      <span style={{ ...S.fold, visibility: 'hidden' }}>+</span>
                      {d.label}
                    </td>
                    {months.map(p => (
                      <td key={p} style={S.td}>
                        <div style={{ ...S.act(null), color: d.color }}>
                          {fmtD(dollars[p]?.[d.key], d.dp)}
                        </div>
                      </td>
                    ))}
                    <td style={{ ...S.td, ...h1Td }}>
                      <div style={{ ...S.act(null), color: d.color }}>
                        {fmtD(h1Dollars?.[d.key], d.dp)}
                      </div>
                      {d.key === 'htiValue' && h1Dollars?.htiValue != null && (
                        <div style={S.tgt}>at {monthLabel(H1_LAST)} close</div>
                      )}
                    </td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {findings.length > 0 && (
        <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 10,
                      background: 'var(--surface, #1D2126)',
                      border: '1px solid var(--border, #2A3340)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: 'var(--ink-40, #737A82)',
                        marginBottom: 8 }}>
            Patterns · computed from the table, not narrated
          </div>
          {findings.map((f, i) => (
            <div key={i} style={{ fontSize: 12.5, color: 'var(--ink-60, #A2A9B1)',
                                  padding: '3px 0', display: 'flex', gap: 8,
                                  alignItems: 'baseline' }}>
              <span style={S.dot(f.color)} />
              <span>{f.text}</span>
            </div>
          ))}
        </div>
      )}

      <div style={S.legend}>
        <span><span style={S.dot(GREEN)} />on target</span>
        <span><span style={S.dot(AMBER)} />close (within ~10%)</span>
        <span><span style={S.dot(RED)} />off target</span>
        <span style={{ marginLeft: 'auto' }}>
          609 grades are the deck's own words · 610 graded vs target from March (deck went numeric)
          · $ rows: Vena COGS &amp; revenue ÷ invoiced yards; waste at blended cost, HTI at revenue rate
          · H1 = Jan–Jun totals; HTI and its $ value shown at the latest close, $/yd = half-year totals divided
        </span>
      </div>
    </div>
  )
}
