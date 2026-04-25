import { useState, useMemo } from 'react'
import { C, fmt, fmtD } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// NewGoodsView — site-scoped list of in-development New Goods POs
//
// New Goods orders ride a 6-month strike-off + approval cycle before they
// flow into regular production. Surfacing them in the regular WIP/scheduler
// distorts the production view (their lead times aren't comparable to ready-
// to-print stock). This view sits alongside WIP and Schedule and shows just
// the development pipeline for a chosen site.
//
// Data scope:
//   - rows for the selected site where is_new_goods = true
//   - PLUS unknown-site New Goods in a "Pre-classification" section, so
//     orphan POs (no Division yet, no usable MATERIAL prefix) don't go
//     invisible — Wendy can chase upstream classification.
// ═══════════════════════════════════════════════════════════════════════════

// Workflow order for status — earliest stage first, so the strike-off-
// and-approval pipeline reads top-to-bottom in lifecycle order.
const STATUS_ORDER = [
  'Waiting for Approval',
  'Strike Off',
  'Waiting for Sample',
  'Waiting for Screen',
  'Waiting for Material',
  'Approved to Print',
  'Ready to Print',
  'In Mixing Queue',
  'In Progress',
  'Orders Unallocated',
]
const statusRank = (s) => {
  const idx = STATUS_ORDER.indexOf(s || '')
  return idx === -1 ? 99 : idx
}

const STATUS_COLOR = {
  'Waiting for Approval': C.amber,
  'Strike Off':           C.amber,
  'Waiting for Sample':   C.amber,
  'Waiting for Screen':   C.amber,
  'Waiting for Material': C.gold,
  'Approved to Print':    C.sage,
  'Ready to Print':       C.sage,
  'In Mixing Queue':      C.navy,
  'In Progress':          C.navy,
  'Orders Unallocated':   C.inkLight,
}
const STATUS_BG = {
  'Waiting for Approval': C.amberBg,
  'Strike Off':           C.amberBg,
  'Waiting for Sample':   C.amberBg,
  'Waiting for Screen':   C.amberBg,
  'Waiting for Material': C.goldBg,
  'Approved to Print':    C.sageBg,
  'Ready to Print':       C.sageBg,
  'In Mixing Queue':      C.navyLight,
  'In Progress':          C.navyLight,
  'Orders Unallocated':   C.warm,
}

export default function NewGoodsView({ wipRows, unknownRows, site, siteLabel }) {
  const [filter, setFilter] = useState('')
  const [showPreClass, setShowPreClass] = useState(false)
  const [sortBy, setSortBy] = useState('status')
  const [sortDir, setSortDir] = useState('asc')

  const newGoods = useMemo(
    () => (wipRows || []).filter(r => r.is_new_goods),
    [wipRows]
  )

  const preClass = useMemo(
    () => (unknownRows || []).filter(r => r.is_new_goods),
    [unknownRows]
  )

  const filtered = useMemo(() => {
    if (!filter) return newGoods
    const q = filter.toLowerCase()
    return newGoods.filter(r =>
      (r.po_number || '').toLowerCase().includes(q) ||
      (r.order_number || '').toLowerCase().includes(q) ||
      (r.line_description || '').toLowerCase().includes(q) ||
      (r.item_sku || '').toLowerCase().includes(q) ||
      (r.color || '').toLowerCase().includes(q) ||
      (r.material || '').toLowerCase().includes(q)
    )
  }, [newGoods, filter])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      let cmp = 0
      if (sortBy === 'status') cmp = statusRank(a.order_status) - statusRank(b.order_status)
      else if (sortBy === 'age')        cmp = (a.age_days || 0) - (b.age_days || 0)
      else if (sortBy === 'po')         cmp = String(a.po_number || '').localeCompare(String(b.po_number || ''))
      else if (sortBy === 'pattern')    cmp = String(a.line_description || '').localeCompare(String(b.line_description || ''))
      else if (sortBy === 'yards')      cmp = (a.yards_written || 0) - (b.yards_written || 0)
      else if (sortBy === 'customer')   cmp = String(a.customer_name_clean || '').localeCompare(String(b.customer_name_clean || ''))
      // Tiebreak on age desc so older items rise within a status bucket
      if (cmp === 0) cmp = -((a.age_days || 0) - (b.age_days || 0))
      return cmp * dir
    })
  }, [filtered, sortBy, sortDir])

  // Status totals for the summary chips
  const byStatus = useMemo(() => {
    const m = {}
    for (const r of newGoods) {
      const s = r.order_status || 'Unknown'
      if (!m[s]) m[s] = { count: 0, yards: 0, revenue: 0 }
      m[s].count += 1
      m[s].yards += Number(r.yards_written || 0)
      m[s].revenue += Number(r.income_written || 0)
    }
    return m
  }, [newGoods])

  // Age distribution — same buckets as the regular WIP aging chart so Wendy
  // can read both views consistently. For New Goods, "old" usually means
  // stuck in dev (a 90+ day Strike Off is a problem worth chasing).
  const byAge = useMemo(() => {
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, 'no-date': 0 }
    const yardsByBucket = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, 'no-date': 0 }
    for (const r of newGoods) {
      const b = r.age_bucket || 'no-date'
      if (b in buckets) {
        buckets[b] += 1
        yardsByBucket[b] += Number(r.yards_written || 0)
      }
    }
    return { buckets, yards: yardsByBucket }
  }, [newGoods])

  function toggleSort(field) {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(field); setSortDir(field === 'age' || field === 'yards' ? 'desc' : 'asc') }
  }

  const SortHdr = ({ field, children, align = 'left' }) => (
    <span onClick={() => toggleSort(field)}
      style={{ cursor: 'pointer', textAlign: align, userSelect: 'none', display: 'block' }}>
      {children}
      {sortBy === field && <span style={{ marginLeft: 4, color: C.navy }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </span>
  )

  const totalYards = useMemo(() => newGoods.reduce((s, r) => s + Number(r.yards_written || 0), 0), [newGoods])
  const totalRevenue = useMemo(() => newGoods.reduce((s, r) => s + Number(r.income_written || 0), 0), [newGoods])

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: C.ink, margin: 0, fontFamily: 'Georgia,serif' }}>
          {siteLabel} · New Goods
        </h3>
        <p style={{ fontSize: 12, color: C.inkLight, margin: '4px 0 0' }}>
          Pre-production POs in the strike-off and approval pipeline. Separate from the regular WIP view because
          their 6-month lead times aren't comparable to ready-to-print stock.
        </p>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <SummaryCard label="New Goods POs" value={fmt(newGoods.length)} />
        <SummaryCard label="Yards committed" value={fmt(totalYards)} />
        <SummaryCard label="Revenue value" value={fmtD(totalRevenue)} />
      </div>

      {/* Aging chart — mirrors the regular WIP aging visual so the two reads
          consistently. For New Goods, an aged bucket usually means a PO
          stuck in strike-off or approval — worth chasing. */}
      {newGoods.length > 0 && <NewGoodsAgingBar byAge={byAge} />}

      {/* Status breakdown chips */}
      {newGoods.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
          {STATUS_ORDER.map(s => {
            const v = byStatus[s]
            if (!v) return null
            const color = STATUS_COLOR[s] || C.inkMid
            const bg = STATUS_BG[s] || C.warm
            return (
              <div key={s}
                style={{ padding: '6px 10px', background: bg, color, fontSize: 11, fontWeight: 600, borderRadius: 5, border: `1px solid ${C.border}` }}>
                {s}: <span style={{ fontWeight: 700 }}>{v.count}</span>
                {v.yards > 0 && <span style={{ color: C.inkMid, fontWeight: 400, marginLeft: 4 }}>· {fmt(v.yards)}yd</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* Pre-classification banner */}
      {preClass.length > 0 && (
        <div style={{ background: C.goldBg, border: `1px solid ${C.gold}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ fontSize: 12, color: C.ink }}>
              <strong>{preClass.length} New Goods PO{preClass.length === 1 ? '' : 's'}</strong> need
              {' '}LIFT-side classification (no Division and no recognizable MATERIAL prefix).
              {' '}They show on both Passaic and Brooklyn New Goods until routed.
            </div>
            <button onClick={() => setShowPreClass(s => !s)}
              style={{ padding: '5px 10px', background: 'transparent', color: C.inkMid, border: `1px solid ${C.gold}`, borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
              {showPreClass ? 'Hide' : `Show ${preClass.length}`}
            </button>
          </div>
          {showPreClass && (
            <div style={{ marginTop: 10, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '110px 110px 1fr 130px 130px 100px', gap: 0, padding: '8px 12px', background: C.parchment, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.inkLight }}>
                <span>PO</span><span>Order #</span><span>Pattern</span><span>Material</span><span>Status</span><span style={{ textAlign: 'right' }}>Yards</span>
              </div>
              {preClass.map(r => (
                <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '110px 110px 1fr 130px 130px 100px', gap: 0, padding: '6px 12px', borderTop: `1px solid ${C.border}`, fontSize: 11 }}>
                  <span style={{ fontFamily: 'monospace', color: C.inkLight }}>{r.po_number}</span>
                  <span style={{ fontFamily: 'monospace', color: C.inkLight }}>{r.order_number}</span>
                  <span style={{ color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.line_description}</span>
                  <span style={{ color: C.inkLight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.material}</span>
                  <span style={{ color: C.inkMid }}>{r.order_status}</span>
                  <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(r.yards_written)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Filter input */}
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <input type="text" placeholder="Filter by PO, pattern, SKU, color, material…"
          value={filter} onChange={e => setFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, minWidth: 320, background: '#fff', color: C.ink, flex: 1, maxWidth: 480 }} />
        <span style={{ fontSize: 12, color: C.inkLight }}>{sorted.length} of {newGoods.length}</span>
        <span style={{ fontSize: 11, color: C.inkLight, fontStyle: 'italic' }}>Click any column header to sort</span>
      </div>

      {/* Main list */}
      {newGoods.length === 0 && (
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, padding: 40, textAlign: 'center', color: C.inkLight, fontSize: 13 }}>
          No New Goods POs for {siteLabel}.
        </div>
      )}

      {newGoods.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '110px 100px 1fr 110px 100px 1.2fr 140px 70px 60px', gap: 0, padding: '10px 14px', background: C.parchment, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.inkLight }}>
            <SortHdr field="po">PO</SortHdr>
            <SortHdr field="po">Order #</SortHdr>
            <SortHdr field="pattern">Pattern</SortHdr>
            <span>SKU</span>
            <span>Color</span>
            <SortHdr field="customer">Customer / Material</SortHdr>
            <SortHdr field="status">Status</SortHdr>
            <SortHdr field="yards" align="right">Yards</SortHdr>
            <SortHdr field="age" align="right">Age</SortHdr>
          </div>
          {sorted.map(r => {
            const ageColor = (r.age_days || 0) > 90 ? C.rose : (r.age_days || 0) > 60 ? C.amber : C.inkMid
            const statusColor = STATUS_COLOR[r.order_status] || C.inkMid
            const statusBg = STATUS_BG[r.order_status] || C.warm
            return (
              <div key={r.id}
                style={{ display: 'grid', gridTemplateColumns: '110px 100px 1fr 110px 100px 1.2fr 140px 70px 60px', gap: 0, padding: '8px 14px', borderTop: `1px solid ${C.border}`, fontSize: 12, alignItems: 'center' }}>
                <span style={{ color: C.inkLight, fontFamily: 'monospace', fontSize: 11 }}>{r.po_number}</span>
                <span style={{ color: C.inkLight, fontFamily: 'monospace', fontSize: 11 }}>{r.order_number}</span>
                <span style={{ color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }} title={r.line_description}>{r.line_description}</span>
                <span style={{ color: C.inkMid, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.item_sku}>{r.item_sku || '—'}</span>
                <span style={{ color: C.inkMid, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.color}>{r.color || '—'}</span>
                <span style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <span style={{ color: C.inkMid, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.customer_name_clean}>{r.customer_name_clean || '—'}</span>
                  <span style={{ color: C.inkLight, fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.material}>{r.material}</span>
                </span>
                <span style={{ display: 'inline-block', padding: '3px 7px', borderRadius: 4, background: statusBg, color: statusColor, fontSize: 10, fontWeight: 700, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.order_status}</span>
                <span style={{ textAlign: 'right', color: C.inkMid, fontWeight: 600 }}>{fmt(r.yards_written)}</span>
                <span style={{ textAlign: 'right', color: ageColor, fontWeight: 600 }}>{r.age_days != null ? `${r.age_days}d` : '—'}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value }) {
  return (
    <div style={{ flex: 1, minWidth: 160, padding: '14px 18px', background: '#fff', color: C.ink, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'Georgia,serif' }}>{value}</div>
    </div>
  )
}

function NewGoodsAgingBar({ byAge }) {
  const order = ['0-30','31-60','61-90','90+','no-date']
  const colors = {
    '0-30':    { bg: C.sageBg,  text: C.sage },
    '31-60':   { bg: C.goldBg,  text: C.gold },
    '61-90':   { bg: C.amberBg, text: C.amber },
    '90+':     { bg: C.roseBg,  text: C.rose },
    'no-date': { bg: C.warm,    text: C.inkLight },
  }
  const labels = { '0-30':'0–30 days','31-60':'31–60 days','61-90':'61–90 days','90+':'90+ days','no-date':'No date' }
  const max = Math.max(1, ...order.map(b => byAge.yards[b] || 0))
  const total = order.reduce((s, b) => s + (byAge.buckets[b] || 0), 0)
  if (total === 0) return null

  return (
    <div style={{ background: '#fff', borderRadius: 10, border: `1px solid ${C.border}`, padding: '14px 18px', marginBottom: 20 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.inkLight, marginBottom: 12 }}>New Goods aging by order date</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 110 }}>
        {order.filter(b => (byAge.buckets[b] || 0) > 0).map(b => {
          const c = colors[b]
          const y = byAge.yards[b] || 0
          const pct = Math.max((y / max) * 100, 4)
          return (
            <div key={b} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: c.text }}>{fmt(y)}</span>
              <div style={{ width: '100%', height: pct * 0.6 + 'px', background: c.text, borderRadius: '3px 3px 0 0', opacity: 0.85 }} />
              <span style={{ fontSize: 9, color: C.inkLight, textAlign: 'center' }}>{labels[b]}</span>
              <span style={{ fontSize: 9, fontWeight: 600, color: c.text }}>{byAge.buckets[b]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
