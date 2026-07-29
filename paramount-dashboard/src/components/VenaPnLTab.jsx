import React, { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'

// ═══════════════════════════════════════════════════════════════════════════
// VenaPnLTab — the authoritative monthly P&L, straight from `vena_monthly`.
//
// Vena (Abigail's close) is the financial source of truth. The dashboard
// INGESTS AND DISPLAYS these numbers; it never recomputes them. Verified by
// hand for June 2026 / 610: revenue 500,477.21, COGS 441,513.48,
// EBITDAP 58,963.73, OpEx pre-cap 294,677.87.
//
// CAPITALIZATION: account 6116 absorbs the entire operating spend at the
// production cost centres, to the dollar, so "Total Operating Expenses" prints
// as ZERO and gross margin becomes EBITDAP. Post-cap OpEx is therefore
// meaningless operationally — pre-cap is the only figure that means anything
// week to week. Hence the toggle, defaulting to PRE-CAP. 612 (Admin) carries no
// capitalization at all, so both views are identical there.
//
// READING ERGONOMICS (2026-07-26): the header row is STICKY, and detail lines
// FOLD under their subtotal. Everything below EBITDAP — D&A, tax,
// restructuring — is hidden behind one toggle, because it is balance-sheet
// detail nobody reads weekly and it was the reason this page needed scrolling.
// ═══════════════════════════════════════════════════════════════════════════

const CC_LABEL = { CONS: 'Consolidated', '609': '609 · Digital (BNY)', '610': '610 · Screen (Passaic)', '612': '612 · Admin' }
const CC_ORDER = ['CONS', '610', '609', '612']
const TF_LABEL = { month: 'Month', qtd: 'Quarter to date', ytd: 'Year to date', fy: 'Full year' }
const TF_ORDER = ['month', 'qtd', 'ytd', 'fy']

const CAP_ACCOUNT = '6116'

// Rows that summarise a block. Everything between one summary row and the next
// is that block's DETAIL and folds away. "Total ..." is unambiguous; Gross
// Margin and EBITDAP are the two summary lines that don't carry the word.
const SUMMARY = /^(total\b|gross margin|ebitdap|ebitda\b|net income)/i

const fmt = (v) => {
  if (v === null || v === undefined) return '—'
  const n = Number(v)
  if (!isFinite(n)) return '—'
  if (Math.abs(n) < 0.5) return '0'
  return (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toLocaleString()
}
const pct = (a, b) => (!b || !isFinite(a / b)) ? null : (a / b) * 100

export default function VenaPnLTab() {
  const [rows, setRows]       = useState([])
  const [periods, setPeriods] = useState([])
  const [period, setPeriod]   = useState(null)
  const [costCenter, setCC]   = useState('610')
  const [timeframe, setTf]    = useState('month')
  const [preCap, setPreCap]   = useState(true)
  const [openBlocks, setOpen] = useState({})
  const [showBelow, setBelow] = useState(false)
  const [view, setView]       = useState('month')   // 'month' = one period, all scenarios · 'trend' = all periods, actuals
  const [trendRows, setTrend] = useState([])
  const [ytdRows, setYtd]     = useState([])
  const [trendLoading, setTL] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const { data, error } = await supabase.from('vena_monthly')
        .select('period').order('period', { ascending: false })
      if (dead) return
      if (error) { setErr(error.message); setLoading(false); return }
      const uniq = [...new Set((data || []).map(r => r.period))]
      setPeriods(uniq)
      setPeriod(p => p || uniq[0] || null)
      if (!uniq.length) setLoading(false)
    })()
    return () => { dead = true }
  }, [])

  useEffect(() => {
    if (!period) return
    let dead = false
    setLoading(true)
    ;(async () => {
      const { data, error } = await supabase.from('vena_monthly')
        .select('*')
        .eq('period', period).eq('cost_center', costCenter).eq('timeframe', timeframe)
        .order('line_order', { ascending: true })
      if (dead) return
      if (error) setErr(error.message)
      else { setRows(data || []); setErr(null) }
      setLoading(false)
    })()
    return () => { dead = true }
  }, [period, costCenter, timeframe])

  // ── TREND DATA ── every loaded month's ACTUALS for one cost centre, plus
  // Vena's own YTD for the latest period. YTD is DISPLAYED from the ytd
  // timeframe, never summed from the months — same display-don't-recompute
  // rule as everything else on this page. Both queries are small (~60 lines
  // × 6 months), far under PostgREST's silent 1,000-row cap. Two independent
  // builder chains — supabase builders are mutable, so "reusing" one for two
  // queries silently ANDs all the filters into the same request.
  useEffect(() => {
    if (view !== 'trend' || !periods.length) return
    let dead = false
    setTL(true)
    ;(async () => {
      const [m, y] = await Promise.all([
        supabase.from('vena_monthly')
          .select('period,line_key,line_label,account_code,line_order,amount')
          .eq('cost_center', costCenter).eq('scenario', 'actual').eq('timeframe', 'month'),
        supabase.from('vena_monthly')
          .select('period,line_key,line_label,account_code,line_order,amount')
          .eq('cost_center', costCenter).eq('scenario', 'actual').eq('timeframe', 'ytd')
          .eq('period', periods[0]),
      ])
      if (dead) return
      if (m.error) setErr(m.error.message)
      else { setTrend(m.data || []); setYtd(y.error ? [] : (y.data || [])); setErr(null) }
      setTL(false)
    })()
    return () => { dead = true }
  }, [view, costCenter, periods])

  const trendPeriods = useMemo(() =>
    [...new Set(trendRows.map(r => r.period))].sort(), [trendRows])

  const trendLines = useMemo(() => {
    const byLine = new Map()
    const add = (r, slot) => {
      if (!byLine.has(r.line_key)) byLine.set(r.line_key, {
        key: r.line_key, label: r.line_label || r.line_key,
        account: r.account_code, order: r.line_order ?? 9999, byPeriod: {}, ytd: null,
      })
      const L = byLine.get(r.line_key)
      if (slot === 'ytd') L.ytd = Number(r.amount)
      else L.byPeriod[r.period] = Number(r.amount)
      if (r.line_order != null && r.line_order < L.order) L.order = r.line_order
    }
    trendRows.forEach(r => add(r, 'month'))
    ytdRows.forEach(r => add(r, 'ytd'))
    return [...byLine.values()].sort((a, b) => a.order - b.order)
  }, [trendRows, ytdRows])

  // Fold keys for the trend view, at component level so Expand all in the bar
  // can reach them. Trend keys carry a 't-' prefix, keeping the two views'
  // open-state independent.
  const trendFoldKeys = useMemo(() => {
    const keys = []
    let hasDetail = false
    for (const l of trendLines) {
      if (SUMMARY.test(l.label)) { if (hasDetail) keys.push('t-' + l.key); hasDetail = false }
      else hasDetail = true
    }
    return keys
  }, [trendLines])

  // Pivot long → one row per line, a column per scenario.
  const lines = useMemo(() => {
    const byLine = new Map()
    for (const r of rows) {
      if (!byLine.has(r.line_key)) {
        byLine.set(r.line_key, {
          key: r.line_key, label: r.line_label || r.line_key,
          account: r.account_code, order: r.line_order ?? 9999,
          actual: null, forecast: null, plan: null, py_actual: null, forecastLabel: null,
        })
      }
      const L = byLine.get(r.line_key)
      L[r.scenario] = Number(r.amount)
      if (r.scenario === 'forecast' && r.scenario_label) L.forecastLabel = r.scenario_label
      if (r.line_order != null && r.line_order < L.order) L.order = r.line_order
    }
    return [...byLine.values()].sort((a, b) => a.order - b.order)
  }, [rows])

  const capLine      = lines.find(l => l.account === CAP_ACCOUNT)
  const totalOpexLine= lines.find(l => /^total operating expenses/i.test(l.label))
  const revenueLine  = lines.find(l => /^(net sales|total revenue)/i.test(l.label))

  const preCapOpex = (scenario) => {
    if (!totalOpexLine) return null
    const total = totalOpexLine[scenario]
    const cap = capLine ? capLine[scenario] : 0
    if (total === null || total === undefined) return null
    return total - (cap || 0)
  }

  const forecastHeader = lines.find(l => l.forecastLabel)?.forecastLabel || 'Forecast'
  const hasCap = !!capLine && Math.abs(capLine.actual || 0) > 0.5
  const visible = preCap && hasCap ? lines.filter(l => l.account !== CAP_ACCOUNT) : lines

  // Fold the flat list into { detail[], summary } blocks.
  const blocks = useMemo(() => {
    const out = []
    let detail = []
    for (const l of visible) {
      if (SUMMARY.test(l.label)) { out.push({ detail, summary: l }); detail = [] }
      else detail.push(l)
    }
    if (detail.length) out.push({ detail, summary: null })
    return out
  }, [visible])

  const ebitdaIdx = blocks.findIndex(b => b.summary && /^ebitda/i.test(b.summary.label))
  const above = ebitdaIdx >= 0 ? blocks.slice(0, ebitdaIdx + 1) : blocks
  const below = ebitdaIdx >= 0 ? blocks.slice(ebitdaIdx + 1) : []

  const S = {
    wrap: { padding: '24px 28px', maxWidth: 1180, margin: '0 auto' },
    bar:  { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 22 },
    sel:  { padding: '7px 10px', fontSize: 13, border: '1px solid var(--border)',
            borderRadius: 7, background: 'var(--surface)', color: 'var(--ink)' },
    th:   { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: 'var(--ink-60)', padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap',
            position: 'sticky', top: 0, zIndex: 3, background: 'var(--surface)',
            boxShadow: 'inset 0 -1px 0 var(--border)' },
    thL:  { textAlign: 'left' },
    td:   { padding: '6px 12px', textAlign: 'right', fontSize: 13,
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            borderBottom: '1px solid var(--ink-10)' },
    tdL:  { textAlign: 'left', fontSize: 13 },
    note: { fontSize: 12, color: 'var(--ink-60)', marginTop: 18, lineHeight: 1.6 },
  }

  function lineCells(l, strong, isOpen, detailCount) {
    const swap   = preCap && hasCap && totalOpexLine && l.key === totalOpexLine.key
    const actual = swap ? preCapOpex('actual')    : l.actual
    const fc     = swap ? preCapOpex('forecast')  : l.forecast
    const pl     = swap ? preCapOpex('plan')      : l.plan
    const py     = swap ? preCapOpex('py_actual') : l.py_actual
    const label  = swap ? 'Total Operating Expenses (pre-capitalization)' : l.label
    const varFc  = (actual != null && fc != null) ? actual - fc : null
    const share  = revenueLine?.actual ? pct(actual, revenueLine.actual) : null
    return [
      <td key="l" style={{ ...S.td, ...S.tdL, fontWeight: strong ? 600 : 400,
                           paddingLeft: strong ? 12 : 30,
                           borderBottom: strong ? '1px solid var(--border)' : '1px solid var(--ink-10)' }}>
        {detailCount ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 15, height: 15, marginRight: 8, borderRadius: 3, flex: 'none',
            border: '1px solid var(--ink-40)', color: 'var(--ink)', fontSize: 12, lineHeight: 1 }}>
          {isOpen ? '−' : '+'}</span> : null}
        {label}
        {l.account && <span style={{ color: 'var(--ink-30)', marginLeft: 8, fontSize: 11 }}>{l.account}</span>}
        {detailCount && !isOpen ? <span style={{ color: 'var(--ink-30)', marginLeft: 8, fontSize: 10 }}>
          {detailCount} lines</span> : null}
      </td>,
      <td key="a" style={{ ...S.td, fontWeight: strong ? 600 : 400,
                           borderBottom: strong ? '1px solid var(--border)' : '1px solid var(--ink-10)' }}>{fmt(actual)}</td>,
      <td key="f" style={S.td}>{fmt(fc)}</td>,
      <td key="p" style={S.td}>{fmt(pl)}</td>,
      <td key="y" style={S.td}>{fmt(py)}</td>,
      <td key="v" style={{ ...S.td, color: varFc == null ? 'inherit'
                            : varFc < 0 ? 'var(--red)' : 'var(--green)' }}>
        {varFc == null ? '—' : fmt(varFc)}
      </td>,
      <td key="s" style={{ ...S.td, color: 'var(--ink-60)' }}>
        {share == null ? '—' : share.toFixed(1) + '%'}
      </td>,
    ]
  }

  function renderBlock(blk, bi) {
    const key = blk.summary ? blk.summary.key : `tail-${bi}`
    const isOpen = !!openBlocks[key]
    const out = []
    if (blk.summary && blk.detail.length) {
      out.push(
        <tr key={key + '-s'} style={{ cursor: 'pointer' }}
            onClick={() => setOpen(o => ({ ...o, [key]: !o[key] }))}>
          {lineCells(blk.summary, true, isOpen, blk.detail.length)}
        </tr>)
      if (isOpen) blk.detail.forEach(l => out.push(
        <tr key={l.key} style={{ background: 'var(--ink-3)' }}>
          {lineCells(l, false)}
        </tr>))
    } else if (blk.summary) {
      out.push(<tr key={key + '-s'}>{lineCells(blk.summary, true)}</tr>)
    } else {
      blk.detail.forEach(l => out.push(
        <tr key={l.key}>{lineCells(l, false)}</tr>))
    }
    return out
  }

  // ── TREND VIEW ── the same folding P&L, laid across every loaded month plus
  // Vena's own YTD. Label column is sticky-left so the line names survive the
  // horizontal scroll. Pre-cap swap applies per period. The one synthetic row
  // is EBITDAP margin — a ratio of two displayed Vena numbers, same rule as
  // the single-month "% of rev" column.
  function renderTrend() {
    if (trendLoading) return <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>Loading…</div>
    if (!trendLines.length) return (
      <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>
        No monthly actuals loaded for {CC_LABEL[costCenter]}.
      </div>)

    const tCap    = trendLines.find(l => l.account === CAP_ACCOUNT)
    const tOpex   = trendLines.find(l => /^total operating expenses/i.test(l.label))
    const tRev    = trendLines.find(l => /^(net sales|total revenue)/i.test(l.label))
    const tHasCap = !!tCap && Object.values(tCap.byPeriod).some(v => Math.abs(v || 0) > 0.5)
    const tVisible = preCap && tHasCap ? trendLines.filter(l => l.account !== CAP_ACCOUNT) : trendLines

    const val = (l, p) => {
      const swap = preCap && tHasCap && tOpex && l.key === tOpex.key
      if (!swap) return p === 'ytd' ? l.ytd : (l.byPeriod[p] ?? null)
      const total = p === 'ytd' ? tOpex.ytd : tOpex.byPeriod[p]
      const cap   = tCap ? (p === 'ytd' ? tCap.ytd : tCap.byPeriod[p]) : 0
      return total == null ? null : total - (cap || 0)
    }

    const tBlocks = []
    { let d = []
      for (const l of tVisible) {
        if (SUMMARY.test(l.label)) { tBlocks.push({ detail: d, summary: l }); d = [] }
        else d.push(l)
      }
      if (d.length) tBlocks.push({ detail: d, summary: null }) }
    const eIdx   = tBlocks.findIndex(b => b.summary && /^ebitda/i.test(b.summary.label))
    const tAbove = eIdx >= 0 ? tBlocks.slice(0, eIdx + 1) : tBlocks
    const tBelow = eIdx >= 0 ? tBlocks.slice(eIdx + 1) : []
    const ebLine = eIdx >= 0 ? tBlocks[eIdx].summary : null

    const mName = p => { const [yy, mm] = p.split('-'); return new Date(Date.UTC(+yy, +mm - 1, 15)).toLocaleString('en-US', { month: 'short' }) }
    const stickyL = { position: 'sticky', left: 0, zIndex: 2, background: 'var(--surface)' }

    const cells = (l, strong, isOpen, detailCount) => {
      const swap  = preCap && tHasCap && tOpex && l.key === tOpex.key
      const label = swap ? 'Total Operating Expenses (pre-capitalization)' : l.label
      return [
        <td key="l" style={{ ...S.td, ...S.tdL, ...stickyL, fontWeight: strong ? 600 : 400,
                             paddingLeft: strong ? 12 : 30,
                             borderBottom: strong ? '1px solid var(--border)' : '1px solid var(--ink-10)' }}>
          {detailCount ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 15, height: 15, marginRight: 8, borderRadius: 3, flex: 'none',
              border: '1px solid var(--ink-40)', color: 'var(--ink)', fontSize: 12, lineHeight: 1 }}>
            {isOpen ? '−' : '+'}</span> : null}
          {label}
          {l.account && <span style={{ color: 'var(--ink-30)', marginLeft: 8, fontSize: 11 }}>{l.account}</span>}
          {detailCount && !isOpen ? <span style={{ color: 'var(--ink-30)', marginLeft: 8, fontSize: 10 }}>
            {detailCount} lines</span> : null}
        </td>,
        ...trendPeriods.map(p =>
          <td key={p} style={{ ...S.td, fontWeight: strong ? 600 : 400,
                               borderBottom: strong ? '1px solid var(--border)' : '1px solid var(--ink-10)' }}>{fmt(val(l, p))}</td>),
        <td key="ytd" style={{ ...S.td, fontWeight: 600, borderLeft: '1px solid var(--border)',
                               borderBottom: strong ? '1px solid var(--border)' : '1px solid var(--ink-10)' }}>{fmt(val(l, 'ytd'))}</td>,
      ]
    }

    const rowsOut = (blks, off = 0) => blks.flatMap((blk, bi) => {
      const key = blk.summary ? 't-' + blk.summary.key : `t-tail-${off + bi}`
      const isOpen = !!openBlocks[key]
      const out = []
      if (blk.summary && blk.detail.length) {
        out.push(
          <tr key={key} style={{ cursor: 'pointer' }}
              onClick={() => setOpen(o => ({ ...o, [key]: !o[key] }))}>
            {cells(blk.summary, true, isOpen, blk.detail.length)}
          </tr>)
        if (isOpen) blk.detail.forEach(l => out.push(
          <tr key={'t-' + l.key} style={{ background: 'var(--ink-3)' }}>{cells(l, false)}</tr>))
      } else if (blk.summary) {
        out.push(<tr key={key}>{cells(blk.summary, true)}</tr>)
      } else {
        blk.detail.forEach(l => out.push(<tr key={'t-' + l.key}>{cells(l, false)}</tr>))
      }
      if (blk.summary && ebLine && blk.summary.key === ebLine.key && tRev) out.push(
        <tr key="t-margin">
          <td style={{ ...S.td, ...S.tdL, ...stickyL, color: 'var(--ink-60)', paddingLeft: 12 }}>EBITDAP margin</td>
          {trendPeriods.map(p => {
            const m = pct(val(ebLine, p), val(tRev, p))
            return <td key={p} style={{ ...S.td, color: m != null && m < 0 ? 'var(--red)' : 'var(--ink-60)' }}>
              {m == null ? '—' : m.toFixed(1) + '%'}</td>
          })}
          <td style={{ ...S.td, color: 'var(--ink-60)', borderLeft: '1px solid var(--border)' }}>
            {(() => { const m = pct(val(ebLine, 'ytd'), val(tRev, 'ytd')); return m == null ? '—' : m.toFixed(1) + '%' })()}
          </td>
        </tr>)
      return out
    })

    return (
      <>
        <div style={{ maxHeight: 'calc(100vh - 330px)', minHeight: 260, overflow: 'auto',
                      border: '1px solid var(--border-light)', borderRadius: 8 }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...S.th, ...S.thL, ...stickyL, zIndex: 4 }}>Line</th>
              {trendPeriods.map(p => <th key={p} style={S.th}>{mName(p)}</th>)}
              <th style={{ ...S.th, borderLeft: '1px solid var(--border)' }}>YTD thru {periods[0] ? mName(periods[0]) : ''}</th>
            </tr>
          </thead>
          <tbody>
            {rowsOut(tAbove)}
            {showBelow && rowsOut(tBelow, 1000)}
          </tbody>
        </table>
        </div>
        {tBelow.length > 0 && (
          <button onClick={() => setBelow(v => !v)}
            style={{ ...S.sel, cursor: 'pointer', marginTop: 14, fontSize: 12 }}>
            {showBelow ? '▾ Hide' : '▸ Show'} depreciation, tax and other below EBITDAP
          </button>)}
      </>
    )
  }

  if (!loading && !periods.length) return (
    <div style={S.wrap}>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Profit &amp; loss</h2>
      <p style={{ fontSize: 14, color: 'var(--ink-60)' }}>
        No Vena periods loaded yet. The monthly close lands on ShareFile as
        &ldquo;Paramount Results vs Forecast_&lt;Month&gt; &lt;Year&gt;.xlsx&rdquo; and is picked up by the
        daily finance feed.
      </p>
    </div>
  )

  return (
    <div style={S.wrap}>
      <div style={{ marginBottom: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                    textTransform: 'uppercase', color: 'var(--ink-60)' }}>Vena · monthly close</div>
      <h2 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 18px' }}>Profit &amp; loss</h2>

      <div style={S.bar}>
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
          {['month', 'trend'].map(v =>
            <button key={v} onClick={() => setView(v)}
              style={{ padding: '7px 12px', fontSize: 13, border: 'none', cursor: 'pointer',
                       background: view === v ? 'var(--surface-2)' : 'transparent',
                       color: view === v ? 'var(--ink)' : 'var(--ink-60)',
                       fontWeight: view === v ? 600 : 400 }}>
              {v === 'month' ? 'Single month' : 'Trend'}
            </button>)}
        </div>
        {view === 'month' && (
        <select style={S.sel} value={period || ''} onChange={e => setPeriod(e.target.value)}>
          {periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        )}
        <select style={S.sel} value={costCenter} onChange={e => setCC(e.target.value)}>
          {CC_ORDER.map(cc => <option key={cc} value={cc}>{CC_LABEL[cc]}</option>)}
        </select>
        {view === 'month' && (
        <select style={S.sel} value={timeframe} onChange={e => setTf(e.target.value)}>
          {TF_ORDER.map(t => <option key={t} value={t}>{TF_LABEL[t]}</option>)}
        </select>
        )}
        {hasCap && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={preCap} onChange={e => setPreCap(e.target.checked)} />
            OpEx pre-capitalization
          </label>
        )}
        <button onClick={() => {
          const anyOpen = Object.values(openBlocks).some(Boolean)
          if (anyOpen) { setOpen({}); return }
          const all = {}
          if (view === 'month') blocks.forEach(b => { if (b.summary && b.detail.length) all[b.summary.key] = true })
          else trendFoldKeys.forEach(k => { all[k] = true })
          setOpen(all)
        }} style={{ ...S.sel, cursor: 'pointer' }}>
          {Object.values(openBlocks).some(Boolean) ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 14 }}>{err}</div>}
      {view === 'trend' ? renderTrend() : loading ? (
        <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>Loading…</div>
      ) : !visible.length ? (
        <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>
          Nothing for {CC_LABEL[costCenter]} · {TF_LABEL[timeframe]} in {period}.
        </div>
      ) : (
        <>
          {/* The table gets its OWN scroll container. Sticky <th> positions against
              the nearest scrolling ancestor — if that is the page, the header slides
              underneath the app chrome (which is itself sticky at top:0) and simply
              vanishes. Scrolling here instead makes it self-contained and means we
              don't have to hardcode the chrome height.
              border-collapse must be `separate`; `collapse` silently kills sticky. */}
          <div style={{ maxHeight: 'calc(100vh - 330px)', minHeight: 260, overflowY: 'auto',
                        border: '1px solid var(--border-light)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr>
                <th style={{ ...S.th, ...S.thL }}>Line</th>
                <th style={S.th}>Actual</th>
                <th style={S.th}>{forecastHeader}</th>
                <th style={S.th}>Plan</th>
                <th style={S.th}>Prior year</th>
                <th style={S.th}>vs forecast</th>
                <th style={S.th}>% of rev</th>
              </tr>
            </thead>
            <tbody>
              {above.flatMap(renderBlock)}
              {showBelow && below.flatMap((b, i) => renderBlock(b, i + 1000))}
            </tbody>
          </table>
          </div>

          {below.length > 0 && (
            <button onClick={() => setBelow(v => !v)}
              style={{ ...S.sel, cursor: 'pointer', marginTop: 14, fontSize: 12 }}>
              {showBelow ? '▾ Hide' : '▸ Show'} depreciation, tax and other below EBITDAP
              <span style={{ color: 'var(--ink-30)', marginLeft: 8 }}>{below.length} sections</span>
            </button>
          )}
        </>
      )}

      <div style={S.note}>
        Source: Vena monthly close, ingested from ShareFile. These figures are displayed as
        closed — the dashboard does not recompute them.
        {hasCap && preCap && ' OpEx is shown pre-capitalization: account 6116 offsets the entire operating spend at the production cost centres, so the post-capitalization total is zero and carries no operational meaning.'}
        {hasCap && !preCap && ' Post-capitalization view — account 6116 offsets operating spend to arrive at the GAAP presentation.'}
      </div>
    </div>
  )
}
