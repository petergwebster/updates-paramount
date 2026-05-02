import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../supabase'
import { parseLiftWorkbook } from '../liftParser'
import { C, fmt, fmtD } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// WIPTab — single source of truth for WIP across the dashboard.
//
// Data model:
//   • Upload LIFT WIP → parses workbook → writes sched_snapshots + sched_wip_rows.
//   • Scheduler reads sched_wip_rows for the unscheduled pool (filtered by site,
//     with NEW Goods preproduction statuses excluded).
//   • This tab reads the SAME rows but shows the full universe — every status,
//     every site, no filtering — so Peter can see what's stuck and where.
//
// Anything that used to live on Monday.com (live boards, Load Data button,
// wip_snapshots table, classify-into-buckets logic) is gone. The LIFT upload
// is the canonical refresh path.
//
// Render structure:
//   1. Header — Upload LIFT WIP + Refresh, snapshot timestamp
//   2. Snapshot summary — total rows + breakdown by site
//   3. Customer filter pill — All / Schumacher / 3rd Party
//   4. Division pivots — one section per division (Screen Print / Digital /
//      Procurement / others), each a Yard Order Status × metrics matrix.
//      This reconstructs the LIFT STEPS pivot live from the data.
//
// Production WIP detailed browse (line-level, customer-grouped) is the next
// push. NEW Goods detailed live report is its own thing after that.
// ═══════════════════════════════════════════════════════════════════════════

// LIFT lifecycle order — used to sort status rows so the table reads
// pre-production → in-flight → ready → packing → shipped from top to bottom.
// Anything not in this list falls to the bottom alphabetically.
const STATUS_ORDER = [
  'Orders Unallocated',
  'Waiting for Approval',
  'Waiting for Sample',
  'Waiting for Screen',
  'Waiting for Material',
  'Strike Off',
  'In Mixing Queue',
  'Mixing',
  'Approved to Print',
  'Ready to Print',
  'In Progress',
  'In Packing',
  'Ready to Ship',
  'Shipped',
]

// ── Scheduler pool eligibility — mirrors PassaicScheduler / BNYScheduler ──
//
// Source of truth: PassaicScheduler.jsx pool memo + BNYScheduler.jsx pool
// memo (May 2026). Statuses ELIGIBLE for the Scheduler pool:
const SCHEDULABLE_STATUSES = new Set([
  'Approved to Print', 'Ready to Print',
  'In Mixing Queue',   'In Progress',
  'Waiting for Material', 'Waiting for Screen',
  'Waiting for Approval', 'Waiting for Sample',
  'Strike Off',
  'Orders Unallocated',
])
// New Goods preproduction is excluded — those POs live in the New Goods view
// until they reach Approved to Print.
const NG_PREPROD = new Set([
  'Waiting for Approval','Strike Off','Waiting for Sample',
  'Waiting for Screen','Waiting for Material',
])

// Returns true if this row is currently eligible for its site's Scheduler
// pool. Does NOT account for the per-week `remaining_yards > 0` filter
// (Scheduler additionally hides POs already fully assigned for the week);
// this gives an upper-bound "potentially schedulable" count.
function isSchedulable(r) {
  // Only Passaic and BNY have schedulers — Procurement is pass-through.
  if (r.site !== 'passaic' && r.site !== 'bny') return false
  const status = (r.order_status || '').trim()
  if (!SCHEDULABLE_STATUSES.has(status)) return false
  if (r.is_new_goods && NG_PREPROD.has(status)) return false
  // BNY-specific: must have a bny_bucket and have yards written.
  if (r.site === 'bny') {
    if (!r.bny_bucket) return false
    if (!(Number(r.yards_written) > 0)) return false
  }
  return true
}

// Map sched_wip_rows.site → Division label that mirrors the LIFT pivot.
// Falls back to division_raw for anything outside the canonical three (e.g.
// Design Services lands here as 'Design Services' rather than 'Other').
function divisionLabelFor(row) {
  if (row.site === 'passaic')     return 'Screen Print'
  if (row.site === 'bny')         return 'Digital'
  if (row.site === 'procurement') return 'Procurement'
  if (row.division_raw && row.division_raw.trim()) return row.division_raw.trim()
  return 'Unclassified'
}

// Customer filter normalization. customer_type is free text from LIFT;
// match the two buckets that matter and treat everything else as 'other'.
function customerKeyFor(row) {
  const ct = (row.customer_type || '').toLowerCase()
  if (ct.includes('schumacher')) return 'schumacher'
  if (ct.includes('3rd party') || ct.includes('third party')) return 'thirdparty'
  return 'other'
}

// Reduce wipRows to per-division aggregates:
//   {
//     [divisionLabel]: {
//       statuses: { [status]: { orders, yards, income, qtyInvoiced } },
//       totalPOs: <distinct POs across all statuses in this division>,
//       schedulablePOs: <distinct POs eligible for the Scheduler pool>,
//       hasScheduler: <true for Passaic/Digital, false for Procurement etc.>,
//     }
//   }
// "orders" matches the legacy LIFT pivot's "# of Orders Ordered" semantics —
// distinct POs per status. Falls back to order_number when po_number is
// missing so we don't silently undercount.
function buildDivisionPivots(rows, customerFilter) {
  const work = {}
  for (const r of rows) {
    if (customerFilter !== 'all' && customerKeyFor(r) !== customerFilter) continue
    const div = divisionLabelFor(r)
    const status = (r.order_status || '').trim() || '(no status)'
    if (!work[div]) work[div] = {
      statuses: {},
      totalPoSet: new Set(),
      schedPoSet: new Set(),
      hasScheduler: r.site === 'passaic' || r.site === 'bny',
    }
    if (!work[div].statuses[status]) work[div].statuses[status] = {
      poSet: new Set(),
      yards: 0, income: 0, qtyInvoiced: 0,
    }
    const s = work[div].statuses[status]
    const poKey = (r.po_number && String(r.po_number).trim())
                || (r.order_number && String(r.order_number).trim())
    if (poKey) {
      s.poSet.add(poKey)
      work[div].totalPoSet.add(poKey)
      if (isSchedulable(r)) work[div].schedPoSet.add(poKey)
    }
    s.yards       += Number(r.yards_written || 0)
    s.income      += Number(r.income_written || 0)
    s.qtyInvoiced += Number(r.qty_invoiced || 0)
    // hasScheduler holds across rows in the same division — first row sets it
    if (r.site === 'passaic' || r.site === 'bny') work[div].hasScheduler = true
  }
  // Resolve sets to counts
  const out = {}
  for (const div in work) {
    const statuses = {}
    for (const status in work[div].statuses) {
      const s = work[div].statuses[status]
      statuses[status] = {
        orders: s.poSet.size,
        yards: s.yards,
        income: s.income,
        qtyInvoiced: s.qtyInvoiced,
      }
    }
    out[div] = {
      statuses,
      totalPOs:       work[div].totalPoSet.size,
      schedulablePOs: work[div].schedPoSet.size,
      hasScheduler:   work[div].hasScheduler,
    }
  }
  return out
}

// Render division sections in a stable order; Screen Print and Digital
// always first since they're where the print volume lives.
function divisionRenderOrder(divisions) {
  const canonical = ['Screen Print', 'Digital', 'Procurement']
  const known = canonical.filter(d => divisions.includes(d))
  const rest = divisions.filter(d => !canonical.includes(d)).sort()
  return [...known, ...rest]
}

function statusRenderOrder(statuses) {
  const known = STATUS_ORDER.filter(s => statuses.includes(s))
  const rest  = statuses.filter(s => !STATUS_ORDER.includes(s)).sort()
  return [...known, ...rest]
}

export default function WIPTab() {
  const [snapshot, setSnapshot] = useState(null)
  const [wipRows, setWipRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState(null)
  const [error, setError] = useState(null)
  const [customerFilter, setCustomerFilter] = useState('all') // all | schumacher | thirdparty
  const fileInputRef = useRef(null)

  async function loadLatest() {
    setLoading(true); setError(null)
    try {
      const { data: snaps, error: se } = await supabase
        .from('sched_snapshots')
        .select('*')
        .order('uploaded_at', { ascending: false })
        .limit(1)
      if (se) throw se
      const snap = snaps?.[0] || null
      setSnapshot(snap)

      if (!snap) { setWipRows([]); return }

      // Pull every row for this snapshot — no site filter. This tab shows
      // the universe; Scheduler narrows it down per-site.
      const all = []
      const pageSize = 1000
      let from = 0
      while (true) {
        const { data, error: re } = await supabase
          .from('sched_wip_rows')
          .select('site, division_raw, customer_type, customer_name_clean, product_type, is_new_goods, bny_bucket, order_number, po_number, order_status, yards_written, qty_invoiced, income_written')
          .eq('snapshot_id', snap.id)
          .range(from, from + pageSize - 1)
        if (re) throw re
        if (!data || data.length === 0) break
        all.push(...data)
        if (data.length < pageSize) break
        from += pageSize
      }
      setWipRows(all)
    } catch (e) {
      console.error(e); setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadLatest() }, [])

  // Upload handler — identical write path to the old SchedulerTab uploader.
  // Same parser, same target tables (sched_snapshots + sched_wip_rows). Lives
  // here now because WIP is the data source-of-truth tab.
  async function handleFileChosen(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true); setError(null); setUploadStatus('Parsing workbook…')
    try {
      const parsed = await parseLiftWorkbook(file)
      setUploadStatus(`Parsed ${parsed.meta.total_rows} rows · saving…`)

      const { data: snapRow, error: ie } = await supabase
        .from('sched_snapshots')
        .insert({
          uploaded_by: null,
          source_filename: parsed.meta.source_filename,
          passaic_orders:  parsed.summary.passaic.orders,
          passaic_yards:   parsed.summary.passaic.yards,
          passaic_revenue: parsed.summary.passaic.revenue,
          bny_orders:      parsed.summary.bny.orders,
          bny_yards:       parsed.summary.bny.yards,
          bny_revenue:     parsed.summary.bny.revenue,
          procurement_orders:  parsed.summary.procurement.orders,
          procurement_revenue: parsed.summary.procurement.revenue,
          total_rows: parsed.meta.total_rows,
          unclassified_rows: parsed.unclassified.length,
          parse_notes: parsed.warnings.join(' | ') || null,
        })
        .select()
        .single()
      if (ie) throw ie

      const snapshotId = snapRow.id
      const batchSize = 500
      const rowsToInsert = parsed.rows.map(r => ({
        snapshot_id: snapshotId, site: r.site,
        division_raw: r.division_raw, customer_type: r.customer_type,
        category_customer_mto: r.category_customer_mto,
        customer_name_clean: r.customer_name_clean,
        bny_bucket: r.bny_bucket,
        product_type: r.product_type, is_new_goods: r.is_new_goods,
        order_number: r.order_number, po_number: r.po_number,
        line_description: r.line_description, item_sku: r.item_sku,
        color: r.color, material: r.material,
        order_status: r.order_status, colors_count: r.colors_count,
        color_yards: r.color_yards, order_created: r.order_created,
        yards_written: r.yards_written, qty_invoiced: r.qty_invoiced,
        income_written: r.income_written, age_days: r.age_days, age_bucket: r.age_bucket,
      }))

      for (let i = 0; i < rowsToInsert.length; i += batchSize) {
        const chunk = rowsToInsert.slice(i, i + batchSize)
        setUploadStatus(`Saving rows ${i + 1}–${i + chunk.length} of ${rowsToInsert.length}…`)
        const { error: be } = await supabase.from('sched_wip_rows').insert(chunk)
        if (be) throw be
      }

      setUploadStatus(`✓ Uploaded ${parsed.meta.total_rows} rows · Passaic ${parsed.summary.passaic.orders} · BNY ${parsed.summary.bny.orders} · Procurement ${parsed.summary.procurement.orders}`)
      await loadLatest()
    } catch (e) {
      console.error(e); setError(e.message || String(e)); setUploadStatus(null)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────

  const summary = useMemo(() => {
    const bySite = { passaic: 0, bny: 0, procurement: 0, unknown: 0, other: 0 }
    let total = 0
    for (const r of wipRows) {
      total++
      if (bySite[r.site] != null) bySite[r.site] += 1
      else                        bySite.other   += 1
    }
    return { total, ...bySite }
  }, [wipRows])

  const customerCounts = useMemo(() => {
    let sch = 0, tp = 0, other = 0
    for (const r of wipRows) {
      const k = customerKeyFor(r)
      if      (k === 'schumacher')  sch++
      else if (k === 'thirdparty')  tp++
      else                          other++
    }
    return { sch, tp, other, all: wipRows.length }
  }, [wipRows])

  const pivots = useMemo(() => buildDivisionPivots(wipRows, customerFilter), [wipRows, customerFilter])
  const divisionsToRender = divisionRenderOrder(Object.keys(pivots))

  return (
    <div style={{ background: C.cream, minHeight: '100vh', padding: '0 0 48px', fontFamily: 'system-ui,-apple-system,sans-serif' }}>

      {/* ── Header ───────────────────────────────────────────────────── */}
      <div style={{ padding: '20px 0 16px', marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: C.ink, fontFamily: 'Georgia,serif' }}>Production · WIP</h2>
            <p style={{ fontSize: 13, color: C.inkLight, margin: '4px 0 0' }}>
              LIFT WIP · {snapshot ? `Uploaded ${new Date(snapshot.uploaded_at).toLocaleString()}` : 'No data yet'}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileChosen} style={{ display: 'none' }} />
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
              style={{ padding: '9px 20px', background: uploading ? C.warm : C.ink, color: uploading ? C.inkLight : '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: uploading ? 'not-allowed' : 'pointer' }}>
              {uploading ? 'Uploading…' : '⬆ Upload LIFT WIP'}
            </button>
            <button onClick={loadLatest} disabled={loading || uploading}
              style={{ padding: '9px 16px', background: 'transparent', color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: (loading || uploading) ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>
        {uploadStatus && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.inkMid, background: C.goldBg, border: `1px solid ${C.warm}`, borderRadius: 6, padding: '8px 12px' }}>{uploadStatus}</div>
        )}
        {error && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.rose, background: C.roseBg, border: '1px solid #E8A0A0', borderRadius: 6, padding: '8px 12px' }}>{error}</div>
        )}
      </div>

      {/* ── No-data state ─────────────────────────────────────────────── */}
      {!snapshot && !loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.2 }}>⌘</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.inkMid, fontFamily: 'Georgia,serif', marginBottom: 8 }}>No WIP data yet</div>
          <div style={{ fontSize: 13, color: C.inkLight }}>Click "Upload LIFT WIP" to load the latest export.</div>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: C.inkLight, fontSize: 14 }}>Loading…</div>
      )}

      {snapshot && !loading && (
        <>
          {/* ── Snapshot summary card ─────────────────────────────────── */}
          <SnapshotSummary snapshot={snapshot} summary={summary} />

          {/* ── Connection note ───────────────────────────────────────── */}
          <ConnectionNote />

          {/* ── Customer filter ───────────────────────────────────────── */}
          <CustomerFilter
            value={customerFilter}
            counts={customerCounts}
            onChange={setCustomerFilter}
          />

          {/* ── Division pivots ───────────────────────────────────────── */}
          {divisionsToRender.length === 0 ? (
            <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.inkLight, fontSize: 13, fontStyle: 'italic' }}>
              No rows match the current filter.
            </div>
          ) : (
            divisionsToRender.map(div => (
              <DivisionPivot
                key={div}
                division={div}
                agg={pivots[div]}
              />
            ))
          )}
        </>
      )}
    </div>
  )
}

// ─── Snapshot summary card ─────────────────────────────────────────────────

function SnapshotSummary({ snapshot, summary }) {
  const cells = [
    { label: 'Total rows',  value: summary.total },
    { label: 'Passaic',     value: summary.passaic },
    { label: 'Brooklyn',    value: summary.bny },
    { label: 'Procurement', value: summary.procurement },
  ]
  // Surface unknown/other rows only when they exist — usually small parser tail.
  const tail = summary.unknown + summary.other
  if (tail > 0) cells.push({ label: 'Unclassified', value: tail, dim: true })

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', background: C.parchment, borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last upload</span>
        <span style={{ fontSize: 11, color: C.inkLight }}>
          {snapshot.source_filename || 'unknown source'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cells.length}, 1fr)`, gap: 0 }}>
        {cells.map((c, i) => (
          <div key={c.label} style={{
            padding: '14px 16px',
            borderRight: i < cells.length - 1 ? `1px solid ${C.border}` : 'none',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              {c.label}
            </div>
            <div style={{
              fontSize: 22, fontWeight: 700,
              color: c.dim ? C.inkLight : C.ink,
              fontFamily: 'Georgia,serif',
            }}>
              {fmt(c.value)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Connection note — explains the WIP↔Scheduler relationship ─────────────

function ConnectionNote() {
  return (
    <div style={{
      background: C.parchment, border: `1px solid ${C.border}`, borderRadius: 8,
      padding: '10px 14px', marginBottom: 20, fontSize: 12, color: C.inkMid,
      lineHeight: 1.55,
    }}>
      <strong style={{ color: C.ink }}>Source of truth.</strong>{' '}
      The Scheduler reads from this same data. Its unscheduled pool is a per-site, distinct-PO
      view of orders eligible to schedule — production-active statuses (Approved to Print,
      Ready to Print, In Mixing Queue, In Progress, Strike Off, Orders Unallocated, and Waiting
      for Approval / Material / Sample / Screen) with New Goods rows in pre-production routed
      to the New Goods view instead. Statuses past the printer (Mixing, In Packing, Ready to
      Ship, Shipped) are not in the pool. Procurement isn't scheduled — it's pass-through.
      Each section header below shows total POs and how many are in that site's Scheduler pool.
    </div>
  )
}

// ─── Customer filter pill ──────────────────────────────────────────────────

function CustomerFilter({ value, counts, onChange }) {
  const opts = [
    { v: 'all',         l: 'All',         n: counts.all },
    { v: 'schumacher',  l: 'Schumacher',  n: counts.sch },
    { v: 'thirdparty',  l: '3rd Party',   n: counts.tp  },
  ]
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginRight: 4 }}>
        Customer:
      </span>
      {opts.map(o => {
        const active = value === o.v
        return (
          <button key={o.v} onClick={() => onChange(o.v)}
            style={{
              padding: '6px 14px', fontSize: 12,
              fontWeight: active ? 700 : 500,
              borderRadius: 16,
              border: `1px solid ${active ? C.ink : C.border}`,
              background: active ? C.ink : 'transparent',
              color: active ? '#fff' : C.inkMid,
              cursor: 'pointer',
            }}>
            {o.l} <span style={{ opacity: 0.7, marginLeft: 4 }}>({fmt(o.n)})</span>
          </button>
        )
      })}
    </div>
  )
}

// ─── Division pivot — one section per division ─────────────────────────────

function DivisionPivot({ division, agg }) {
  const { statuses, totalPOs, schedulablePOs, hasScheduler } = agg
  const statusKeys = statusRenderOrder(Object.keys(statuses))

  // Roll up totals across all statuses for the section header
  const totals = statusKeys.reduce((acc, s) => {
    const v = statuses[s]
    acc.yards       += v.yards
    acc.income      += v.income
    acc.qtyInvoiced += v.qtyInvoiced
    return acc
  }, { yards: 0, income: 0, qtyInvoiced: 0 })

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      {/* Section header */}
      <div style={{ padding: '12px 16px', background: C.ink, color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, fontFamily: 'Georgia,serif' }}>
          {division}
        </h3>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.78)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span><strong style={{ color: '#fff' }}>{fmt(totalPOs)}</strong> POs</span>
          {hasScheduler ? (
            <span><strong style={{ color: '#fff' }}>{fmt(schedulablePOs)}</strong> in Scheduler pool</span>
          ) : (
            <span style={{ fontStyle: 'italic' }}>not scheduled</span>
          )}
          <span>{fmt(totals.yards)} yds written</span>
          <span>{fmtD(totals.income)}</span>
        </div>
      </div>

      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 80px 110px 110px 130px', padding: '8px 16px', background: C.parchment, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.inkLight, borderBottom: `1px solid ${C.border}` }}>
        <span>Yard Order Status</span>
        <span style={{ textAlign: 'right' }}>Orders</span>
        <span style={{ textAlign: 'right' }}>Yards Written</span>
        <span style={{ textAlign: 'right' }}>Qty Invoiced</span>
        <span style={{ textAlign: 'right' }}>Income Written</span>
      </div>

      {/* Status rows */}
      {statusKeys.map((status, i) => {
        const v = statuses[status]
        return (
          <div key={status} style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr 80px 110px 110px 130px',
            padding: '10px 16px',
            borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
            fontSize: 13,
            alignItems: 'center',
          }}>
            <span style={{ color: C.ink, fontWeight: 500 }}>{status}</span>
            <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(v.orders)}</span>
            <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(v.yards)}</span>
            <span style={{ textAlign: 'right', color: C.inkMid }}>{v.qtyInvoiced > 0 ? fmt(v.qtyInvoiced) : '—'}</span>
            <span style={{ textAlign: 'right', color: C.inkMid }}>{fmtD(v.income)}</span>
          </div>
        )
      })}

      {/* Section total row — sum of distinct POs across statuses (will exceed
          totalPOs if any PO has lines in multiple statuses; matches the
          legacy LIFT pivot behavior). */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.6fr 80px 110px 110px 130px',
        padding: '10px 16px',
        borderTop: `2px solid ${C.ink}`,
        background: C.parchment,
        fontSize: 13, fontWeight: 700, color: C.ink,
      }}>
        <span>Total</span>
        <span style={{ textAlign: 'right' }}>{fmt(statusKeys.reduce((a, s) => a + statuses[s].orders, 0))}</span>
        <span style={{ textAlign: 'right' }}>{fmt(totals.yards)}</span>
        <span style={{ textAlign: 'right' }}>{totals.qtyInvoiced > 0 ? fmt(totals.qtyInvoiced) : '—'}</span>
        <span style={{ textAlign: 'right' }}>{fmtD(totals.income)}</span>
      </div>
    </div>
  )
}
