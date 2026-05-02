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

// Statuses Scheduler EXCLUDES from its unscheduled pool (NEW Goods preprod).
// We surface a small badge on these rows here so users can see at a glance
// "this is in WIP but won't show up in the Scheduler pool yet."
const NOT_IN_SCHEDULER_POOL = new Set([
  'Waiting for Approval',
  'Strike Off',
  'Waiting for Sample',
  'Waiting for Screen',
  'Waiting for Material',
])

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

// Reduce wipRows to { divisionLabel: { statusLabel: { orders, yards, income, qtyInvoiced } } }.
function buildDivisionPivots(rows, customerFilter) {
  const out = {}
  for (const r of rows) {
    if (customerFilter !== 'all' && customerKeyFor(r) !== customerFilter) continue
    const div = divisionLabelFor(r)
    const status = (r.order_status || '').trim() || '(no status)'
    if (!out[div]) out[div] = {}
    if (!out[div][status]) out[div][status] = { orders: 0, yards: 0, income: 0, qtyInvoiced: 0 }
    const s = out[div][status]
    s.orders      += 1
    s.yards       += Number(r.yards_written || 0)
    s.income      += Number(r.income_written || 0)
    s.qtyInvoiced += Number(r.qty_invoiced || 0)
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
          .select('site, division_raw, customer_type, customer_name_clean, product_type, is_new_goods, order_status, yards_written, qty_invoiced, income_written')
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
                statuses={pivots[div]}
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
      lineHeight: 1.5,
    }}>
      <strong style={{ color: C.ink }}>Source of truth.</strong>{' '}
      This is the universe of orders Paramount has on the books. The Scheduler reads from
      the same data — its unscheduled pool is a filtered slice of what you see here, by site,
      excluding the New Goods preproduction statuses (Waiting for Approval / Material / Sample
      / Screen, Strike Off). Upload here, schedule there.
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

function DivisionPivot({ division, statuses }) {
  const statusKeys = statusRenderOrder(Object.keys(statuses))

  // Roll up totals across all statuses for the section header
  const totals = statusKeys.reduce((acc, s) => {
    const v = statuses[s]
    acc.orders      += v.orders
    acc.yards       += v.yards
    acc.income      += v.income
    acc.qtyInvoiced += v.qtyInvoiced
    return acc
  }, { orders: 0, yards: 0, income: 0, qtyInvoiced: 0 })

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      {/* Section header */}
      <div style={{ padding: '12px 16px', background: C.ink, color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, fontFamily: 'Georgia,serif' }}>
          {division}
        </h3>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)' }}>
          {fmt(totals.orders)} orders · {fmt(totals.yards)} yds written · {fmtD(totals.income)}
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
        const isPreprod = NOT_IN_SCHEDULER_POOL.has(status)
        return (
          <div key={status} style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr 80px 110px 110px 130px',
            padding: '10px 16px',
            borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
            fontSize: 13,
            alignItems: 'center',
          }}>
            <span style={{ color: C.ink, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {status}
              {isPreprod && (
                <span title="Pre-production — excluded from Scheduler's unscheduled pool"
                  style={{
                    fontSize: 9, fontWeight: 700, padding: '2px 6px',
                    background: C.amberBg, color: C.amber,
                    border: `1px solid ${C.amber}`, borderRadius: 3,
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                  }}>
                  preprod
                </span>
              )}
            </span>
            <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(v.orders)}</span>
            <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(v.yards)}</span>
            <span style={{ textAlign: 'right', color: C.inkMid }}>{v.qtyInvoiced > 0 ? fmt(v.qtyInvoiced) : '—'}</span>
            <span style={{ textAlign: 'right', color: C.inkMid }}>{fmtD(v.income)}</span>
          </div>
        )
      })}

      {/* Section total row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.6fr 80px 110px 110px 130px',
        padding: '10px 16px',
        borderTop: `2px solid ${C.ink}`,
        background: C.parchment,
        fontSize: 13, fontWeight: 700, color: C.ink,
      }}>
        <span>Total</span>
        <span style={{ textAlign: 'right' }}>{fmt(totals.orders)}</span>
        <span style={{ textAlign: 'right' }}>{fmt(totals.yards)}</span>
        <span style={{ textAlign: 'right' }}>{totals.qtyInvoiced > 0 ? fmt(totals.qtyInvoiced) : '—'}</span>
        <span style={{ textAlign: 'right' }}>{fmtD(totals.income)}</span>
      </div>
    </div>
  )
}
