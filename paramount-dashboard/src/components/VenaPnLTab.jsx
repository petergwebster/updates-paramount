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
            position: 'sticky', top: 0, zIndex: 2, background: 'var(--paper)',
            borderBottom: '1px solid var(--border)' },
    thL:  { textAlign: 'left' },
    td:   { padding: '6px 12px', textAlign: 'right', fontSize: 13,
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
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
                           paddingLeft: strong ? 12 : 30 }}>
        {detailCount ? <span style={{ color: 'var(--ink-40)', marginRight: 7, fontSize: 10 }}>
          {isOpen ? '▾' : '▸'}</span> : null}
        {label}
        {l.account && <span style={{ color: 'var(--ink-30)', marginLeft: 8, fontSize: 11 }}>{l.account}</span>}
        {detailCount && !isOpen ? <span style={{ color: 'var(--ink-30)', marginLeft: 8, fontSize: 10 }}>
          {detailCount} lines</span> : null}
      </td>,
      <td key="a" style={{ ...S.td, fontWeight: strong ? 600 : 400 }}>{fmt(actual)}</td>,
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
        <tr key={key + '-s'} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
            onClick={() => setOpen(o => ({ ...o, [key]: !o[key] }))}>
          {lineCells(blk.summary, true, isOpen, blk.detail.length)}
        </tr>)
      if (isOpen) blk.detail.forEach(l => out.push(
        <tr key={l.key} style={{ borderBottom: '1px solid var(--ink-10)', background: 'var(--ink-3)' }}>
          {lineCells(l, false)}
        </tr>))
    } else if (blk.summary) {
      out.push(<tr key={key + '-s'} style={{ borderBottom: '1px solid var(--border)' }}>
        {lineCells(blk.summary, true)}</tr>)
    } else {
      blk.detail.forEach(l => out.push(
        <tr key={l.key} style={{ borderBottom: '1px solid var(--ink-10)' }}>{lineCells(l, false)}</tr>))
    }
    return out
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
        <select style={S.sel} value={period || ''} onChange={e => setPeriod(e.target.value)}>
          {periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select style={S.sel} value={costCenter} onChange={e => setCC(e.target.value)}>
          {CC_ORDER.map(cc => <option key={cc} value={cc}>{CC_LABEL[cc]}</option>)}
        </select>
        <select style={S.sel} value={timeframe} onChange={e => setTf(e.target.value)}>
          {TF_ORDER.map(t => <option key={t} value={t}>{TF_LABEL[t]}</option>)}
        </select>
        {hasCap && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={preCap} onChange={e => setPreCap(e.target.checked)} />
            OpEx pre-capitalization
          </label>
        )}
        <button onClick={() => {
          const all = {}
          const anyOpen = Object.values(openBlocks).some(Boolean)
          if (!anyOpen) blocks.forEach(b => { if (b.summary && b.detail.length) all[b.summary.key] = true })
          setOpen(all)
        }} style={{ ...S.sel, cursor: 'pointer' }}>
          {Object.values(openBlocks).some(Boolean) ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 14 }}>{err}</div>}
      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>Loading…</div>
      ) : !visible.length ? (
        <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>
          Nothing for {CC_LABEL[costCenter]} · {TF_LABEL[timeframe]} in {period}.
        </div>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
