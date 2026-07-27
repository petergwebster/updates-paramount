import React, { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'
import { C, fmt } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// InventoryTab — month-end substrate position, from `inventory_snapshot`.
//
// REPLACES the MOS workbook (API_Dashboard_MOS_3_0.xlsx), which was a manual
// upload and reached 84 days stale. Source is now the two ShareFile workbooks,
// ingested daily by sharefile-sync.
//
// WHAT CHANGED, and why it is not a like-for-like port: MOS carried per-SKU
// targets, lead times, buy recommendations and oversold flags. None of those
// exist in the new source. But the month-end DECK never used them either — it
// computes cover the simple way:
//
//     174,935 yards on hand ÷ 11,304 yards average weekly consumption
//                                          = 15.5 weeks run-out buffer
//
// So cover is derived from CONSUMPTION, not from a target table, and both
// inputs are in the data. Nothing essential was lost.
//
// AS-OF: the workbook carries no date of its own; we record ShareFile's
// modified date. Refreshes are ad-hoc during a month and final at close, so:
// a snapshot dated inside the CURRENT calendar month is PROVISIONAL, and the
// last snapshot of a completed month IS that month's close. Nobody has to flag
// anything — it resolves itself when the month rolls over.
//
// This is SUBSTRATE ONLY. The workbooks say "NO INK or Other" at the top, so
// this is not total inventory value and must not be presented as such.
// ═══════════════════════════════════════════════════════════════════════════

const SITES = [
  { id: 'passaic', label: 'Passaic',  color: C.siteNJ },
  { id: 'bny',     label: 'Brooklyn', color: C.siteBNY },
]
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }
const money = (v) => {
  const n = num(v), a = Math.abs(n), s = n < 0 ? '-' : ''
  if (a >= 1_000_000) return `${s}$${(a / 1_000_000).toFixed(2)}M`
  if (a >= 1_000)     return `${s}$${Math.round(a / 1000).toLocaleString()}K`
  return `${s}$${Math.round(a).toLocaleString()}`
}
const dateLabel = (d) => {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`
}

// WEEKS OF COVER — the deck's method. Sold-per-LIFT is a MONTH of consumption,
// so a week is that ÷ 4.33. Returns null rather than Infinity when nothing sold,
// because "infinite cover" is a division artefact, not a fact about the floor.
const weeksCover = (onHand, soldMonth) => {
  const weekly = num(soldMonth) / 4.33
  if (weekly <= 0) return null
  return onHand / weekly
}

export default function InventoryTab() {
  const [rows, setRows]   = useState([])
  const [asOf, setAsOf]   = useState(null)
  const [dates, setDates] = useState([])
  const [site, setSite]   = useState('all')
  const [sortShort, setSortShort] = useState(true)
  const [loading, setLoading] = useState(true)
  const [err, setErr]     = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const { data, error } = await supabase.from('inventory_snapshot')
        .select('as_of').order('as_of', { ascending: false })
      if (dead) return
      if (error) { setErr(error.message); setLoading(false); return }
      const uniq = [...new Set((data || []).map(r => r.as_of))]
      setDates(uniq)
      setAsOf(a => a || uniq[0] || null)
      if (!uniq.length) setLoading(false)
    })()
    return () => { dead = true }
  }, [])

  useEffect(() => {
    if (!asOf) return
    let dead = false
    setLoading(true)
    ;(async () => {
      const { data, error } = await supabase.from('inventory_snapshot')
        .select('*').eq('as_of', asOf).limit(2000)
      if (dead) return
      if (error) setErr(error.message)
      else { setRows(data || []); setErr(null) }
      setLoading(false)
    })()
    return () => { dead = true }
  }, [asOf])

  const view = useMemo(
    () => site === 'all' ? rows : rows.filter(r => r.site === site),
    [rows, site])

  const agg = (list) => {
    const onHand = list.reduce((s, r) => s + num(r.on_hand_curr), 0)
    const prev   = list.reduce((s, r) => s + num(r.on_hand_prev), 0)
    const value  = list.reduce((s, r) => s + num(r.on_hand_curr) * num(r.cost_per_yard), 0)
    const short  = list.reduce((s, r) => s + num(r.yards_short), 0)
    const shortC = list.reduce((s, r) => s + num(r.cost_short), 0)
    const recvd  = list.reduce((s, r) => s + num(r.recvd_yards), 0)
    const recvdC = list.reduce((s, r) => s + num(r.recvd_cost), 0)
    const sold   = list.reduce((s, r) => s + num(r.sold_lift), 0)
    return { onHand, prev, value, short, shortC, recvd, recvdC, sold,
             skus: list.length, cover: weeksCover(onHand, sold) }
  }

  const total = agg(view)

  // Provisional while the snapshot sits inside the current calendar month.
  const isProvisional = useMemo(() => {
    if (!asOf) return false
    const now = new Date()
    return String(asOf).slice(0, 7) === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }, [asOf])

  // Material-group roll-up, biggest first.
  const byGroup = useMemo(() => {
    const m = new Map()
    for (const r of view) {
      const k = r.category || r.material_group || 'Unclassified'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return [...m.entries()]
      .map(([k, list]) => ({ key: k, ...agg(list) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [view])

  const skuRows = useMemo(() => {
    const list = [...view]
    list.sort((a, b) => sortShort
      ? num(b.yards_short) - num(a.yards_short) || num(b.on_hand_curr) - num(a.on_hand_curr)
      : num(b.on_hand_curr) * num(b.cost_per_yard) - num(a.on_hand_curr) * num(a.cost_per_yard))
    return list.slice(0, 60)
  }, [view, sortShort])

  const S = {
    wrap:  { padding: '24px 28px', maxWidth: 1240, margin: '0 auto' },
    over:  { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
             textTransform: 'uppercase', color: C.inkLight, marginBottom: 4 },
    h:     { fontSize: 22, fontWeight: 600, margin: '0 0 6px' },
    card:  { background: C.parchment, border: `1px solid ${C.border}`,
             borderRadius: 12, padding: '16px 18px' },
    lab:   { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
             textTransform: 'uppercase', color: C.inkLight, marginBottom: 6 },
    big:   { fontSize: 26, fontWeight: 600, fontFamily: 'var(--font-display)',
             fontVariantNumeric: 'tabular-nums', lineHeight: 1 },
    sub:   { fontSize: 11, color: C.inkLight, marginTop: 6, lineHeight: 1.45 },
    th:    { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
             color: C.inkLight, padding: '9px 10px', textAlign: 'right', whiteSpace: 'nowrap',
             position: 'sticky', top: 0, background: C.parchment, zIndex: 2,
             boxShadow: `inset 0 -1px 0 ${C.border}` },
    td:    { padding: '6px 10px', textAlign: 'right', fontSize: 12,
             fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
             borderBottom: `1px solid ${C.warm}` },
    pill:  (on, col) => ({ padding: '6px 14px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
             border: `1px solid ${on ? col : C.border}`, fontFamily: 'inherit',
             background: on ? col : 'transparent', color: on ? '#fff' : C.inkMid }),
  }

  if (!loading && !dates.length) return (
    <div style={S.wrap}>
      <h2 style={S.h}>Inventory</h2>
      <p style={{ fontSize: 14, color: C.inkMid }}>
        No inventory snapshots loaded yet. The workbooks live on ShareFile under
        Inventory Reports and are picked up by the daily finance feed.
      </p>
    </div>
  )

  return (
    <div style={S.wrap}>
      <div style={S.over}>Substrate · month-end position</div>
      <h2 style={S.h}>Inventory</h2>

      {/* AS-OF, stated plainly. A stock figure without its date is a trap. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <span style={{ fontSize: 13, color: isProvisional ? C.amber : C.sage }}>
          Inventory data as of <strong>{dateLabel(asOf)}</strong>
          {isProvisional ? ' · provisional, refreshes until month end' : ' · month-end final'}
        </span>
        {dates.length > 1 && (
          <select value={asOf || ''} onChange={e => setAsOf(e.target.value)}
            style={{ padding: '5px 9px', fontSize: 12, borderRadius: 6,
                     border: `1px solid ${C.border}`, background: C.parchment, color: C.ink }}>
            {dates.map(d => <option key={d} value={d}>{dateLabel(d)}</option>)}
          </select>
        )}
        <span style={{ display: 'flex', gap: 6 }}>
          <button style={S.pill(site === 'all', C.inkLight)} onClick={() => setSite('all')}>Both sites</button>
          {SITES.map(s => (
            <button key={s.id} style={S.pill(site === s.id, s.color)} onClick={() => setSite(s.id)}>{s.label}</button>
          ))}
        </span>
      </div>

      {err && <div style={{ color: C.rose, fontSize: 13, marginBottom: 14 }}>{err}</div>}
      {loading ? <div style={{ fontSize: 13, color: C.inkLight }}>Loading…</div> : (
        <>
          {/* ── Headline: value, yards, cover, short ─────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
                        gap: 12, marginBottom: 14 }}>
            <div style={S.card}>
              <div style={S.lab}>Inventory value</div>
              <div style={{ ...S.big, color: C.revenue }}>{money(total.value)}</div>
              <div style={S.sub}>{total.skus} SKUs at cost · substrate only, excludes ink</div>
            </div>
            <div style={S.card}>
              <div style={S.lab}>On hand</div>
              <div style={S.big}>{fmt(Math.round(total.onHand))}<span style={{ fontSize: 12, color: C.inkLight, marginLeft: 5 }}>yds</span></div>
              <div style={S.sub}>
                {total.prev > 0
                  ? `${total.onHand >= total.prev ? '▲' : '▼'} ${fmt(Math.abs(Math.round(total.onHand - total.prev)))} vs prior month`
                  : 'No prior-month figure'}
              </div>
            </div>
            <div style={S.card}>
              <div style={S.lab}>Weeks of cover</div>
              <div style={{ ...S.big, color: total.cover == null ? C.inkLight
                             : total.cover < 6 ? C.rose : total.cover < 12 ? C.amber : C.sage }}>
                {total.cover == null ? '—' : total.cover.toFixed(1)}
              </div>
              <div style={S.sub}>
                {total.cover == null ? 'Nothing sold in the period'
                  : `at ${fmt(Math.round(total.sold / 4.33))} yds/week consumption`}
              </div>
            </div>
            <div style={S.card}>
              <div style={S.lab}>Short</div>
              <div style={{ ...S.big, color: total.short > 0 ? C.amber : C.sage }}>
                {fmt(Math.round(total.short))}<span style={{ fontSize: 12, color: C.inkLight, marginLeft: 5 }}>yds</span>
              </div>
              <div style={S.sub}>{money(total.shortC)} to cover · the buy signal</div>
            </div>
          </div>

          {/* ── Roll-forward: opening → received → sold → closing ────────── */}
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={S.lab}>Movement this period</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 4 }}>
              {[
                ['Opening',  total.prev,   C.inkMid],
                ['Received', total.recvd,  C.sage],
                ['Sold',     -total.sold,  C.waste],
                ['Closing',  total.onHand, C.yards],
              ].map(([lab, v, col], i) => (
                <React.Fragment key={lab}>
                  {i > 0 && <span style={{ color: C.inkLight, fontSize: 16, margin: '0 4px' }}>
                    {i === 3 ? '=' : (v >= 0 ? '+' : '−')}</span>}
                  <span style={{ flex: '1 1 130px', minWidth: 120 }}>
                    <span style={{ display: 'block', fontSize: 10, color: C.inkLight,
                                   textTransform: 'uppercase', letterSpacing: '0.08em' }}>{lab}</span>
                    <span style={{ fontSize: 17, fontWeight: 600, color: col,
                                   fontVariantNumeric: 'tabular-nums',
                                   fontFamily: 'var(--font-display)' }}>
                      {fmt(Math.abs(Math.round(v)))}
                    </span>
                  </span>
                </React.Fragment>
              ))}
            </div>
            <div style={{ ...S.sub, marginTop: 8 }}>
              Yards. Received {money(total.recvdC)} at cost. Opening plus received less sold will not
              tie exactly to closing — adjustments and waste are not in this workbook.
            </div>
          </div>

          {/* ── By material group ───────────────────────────────────────── */}
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={S.lab}>By material</div>
            {byGroup.map(g => {
              const share = total.value > 0 ? (g.value / total.value) * 100 : 0
              return (
                <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0' }}>
                  <span style={{ width: 150, fontSize: 12, color: C.ink, overflow: 'hidden',
                                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.key}</span>
                  <span style={{ flex: 1, height: 8, background: C.warm, borderRadius: 4, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${share}%`, background: C.yards }} />
                  </span>
                  <span style={{ width: 78, textAlign: 'right', fontSize: 12, color: C.inkMid,
                                 fontVariantNumeric: 'tabular-nums' }}>{fmt(Math.round(g.onHand))} yd</span>
                  <span style={{ width: 68, textAlign: 'right', fontSize: 12, color: C.ink,
                                 fontVariantNumeric: 'tabular-nums' }}>{money(g.value)}</span>
                </div>
              )
            })}
          </div>

          {/* ── SKU detail ──────────────────────────────────────────────── */}
          <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '14px 18px 10px' }}>
              <span style={S.lab}>SKU detail</span>
              <button onClick={() => setSortShort(v => !v)} style={S.pill(false, C.border)}>
                Sort by {sortShort ? 'value' : 'shortest'}
              </button>
            </div>
            <div style={{ maxHeight: 460, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, textAlign: 'left' }}>SKU</th>
                    <th style={{ ...S.th, textAlign: 'left' }}>Supplier</th>
                    <th style={S.th}>On hand</th>
                    <th style={S.th}>Short</th>
                    <th style={S.th}>Received</th>
                    <th style={S.th}>Sold</th>
                    <th style={S.th}>$/yd</th>
                    <th style={S.th}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {skuRows.map(r => {
                    const val = num(r.on_hand_curr) * num(r.cost_per_yard)
                    const short = num(r.yards_short)
                    return (
                      <tr key={`${r.site}-${r.lift_sku}`}>
                        <td style={{ ...S.td, textAlign: 'left' }}>
                          {r.lift_sku}
                          <span style={{ color: C.inkLight, marginLeft: 7, fontSize: 10 }}>
                            {r.site === 'bny' ? 'BK' : 'NJ'}
                          </span>
                        </td>
                        <td style={{ ...S.td, textAlign: 'left', color: C.inkLight,
                                     maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {r.supplier || '—'}
                        </td>
                        <td style={S.td}>{fmt(Math.round(num(r.on_hand_curr)))}</td>
                        <td style={{ ...S.td, color: short > 0 ? C.amber : C.inkLight }}>
                          {short > 0 ? fmt(Math.round(short)) : '—'}
                        </td>
                        <td style={S.td}>{num(r.recvd_yards) ? fmt(Math.round(num(r.recvd_yards))) : '—'}</td>
                        <td style={S.td}>{num(r.sold_lift) ? fmt(Math.round(num(r.sold_lift))) : '—'}</td>
                        <td style={{ ...S.td, color: C.inkLight }}>
                          {num(r.cost_per_yard) ? `$${num(r.cost_per_yard).toFixed(2)}` : '—'}
                        </td>
                        <td style={S.td}>{val ? money(val) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {view.length > 60 && (
              <div style={{ padding: '8px 18px', fontSize: 11, color: C.inkLight }}>
                Showing 60 of {view.length} SKUs.
              </div>
            )}
          </div>

          <div style={{ ...S.sub, marginTop: 16 }}>
            Source: ShareFile inventory workbooks, ingested by the daily finance feed.
            Substrate only — the workbooks exclude ink and other consumables, so this is
            not total inventory value. Weeks of cover uses the month-end deck's method:
            on-hand divided by average weekly consumption.
          </div>
        </>
      )}
    </div>
  )
}
