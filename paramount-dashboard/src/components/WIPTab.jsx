import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../supabase'
import { parseLiftWorkbook } from '../liftParser'
import { C, fmt, fmtD,
  STATUS_GOOD, STATUS_GOOD_BG, STATUS_GOOD_BORDER,
  STATUS_WARN, STATUS_WARN_BG, STATUS_WARN_BORDER,
  STATUS_BAD,  STATUS_BAD_BG,  STATUS_BAD_BORDER,
} from '../lib/scheduleUtils'

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

// ─── Per-site product categories ──────────────────────────────────────────
//
// Passaic categorizes by product_type substring (matches the existing
// PassaicScheduler classifier — grass, fabric, wallpaper). BNY categorizes
// by bny_bucket (one of seven canonical buckets the parser populates).
// Procurement isn't categorized — it's pass-through.

const PASSAIC_CATEGORIES = [
  { id: 'grass',     label: 'Grasscloth', match: pt => pt.includes('grass') },
  { id: 'fabric',    label: 'Fabric',     match: pt => pt.includes('fabric') || pt.includes('strike-off') },
  { id: 'wallpaper', label: 'Wallpaper',  match: pt => pt.includes('paper') || pt.includes('panel') },
]

// BNY canonical 7 buckets, Scheduler-chip order
const BNY_CATEGORIES = [
  { id: 'Replen',    label: 'Replen' },
  { id: 'NEW GOODS', label: 'NEW Goods' },
  { id: 'Custom',    label: 'Custom' },
  { id: 'MTO',       label: 'MTO' },
  { id: 'HOS',       label: 'HOS' },
  { id: 'Memo',      label: 'Memo' },
  { id: '3P',        label: '3P' },
]

function categoryMatchPassaic(row, catId) {
  const cat = PASSAIC_CATEGORIES.find(c => c.id === catId)
  if (!cat) return false
  return cat.match((row.product_type || '').toLowerCase())
}
function categoryMatchBny(row, catId) {
  // BNY rows have bny_bucket set by parser; match by exact equality.
  return (row.bny_bucket || '') === catId
}

// ─── Age buckets ──────────────────────────────────────────────────────────
//
// Five buckets: Current (< 30 days), 30, 60, 90, 90+. age_days is computed
// at parse time from order_created. The parser also writes age_bucket as
// a string ('Current', '30', '60', '90', '90+') but we recompute defensively
// here in case parser logic ever drifts.

const AGE_BUCKETS = [
  { id: 'current', label: 'Current', sub: '< 30d',  test: d => d < 30 },
  { id: '30',      label: '30 days', sub: '30–59d', test: d => d >= 30 && d < 60 },
  { id: '60',      label: '60 days', sub: '60–89d', test: d => d >= 60 && d < 90 },
  { id: '90',      label: '90 days', sub: '90–119d',test: d => d >= 90 && d < 120 },
  { id: '90plus',  label: '90+ days',sub: '120d+',  test: d => d >= 120 },
]

function ageBucketFor(row) {
  const d = Number(row.age_days || 0)
  if (d < 30) return 'current'
  if (d < 60) return '30'
  if (d < 90) return '60'
  if (d < 120) return '90'
  return '90plus'
}


export default function WIPTab() {
  const [snapshot, setSnapshot] = useState(null)
  const [wipRows, setWipRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState(null)
  const [error, setError] = useState(null)
  // Site toggle — mirrors the NEW Goods pattern. Each site gets its own
  // scoped view: filters, aging cards, division pivot all reflect this.
  const [site, setSite] = useState('passaic')  // 'passaic' | 'bny' | 'procurement'
  // Filter state — these apply to the active site's view.
  const [customerFilter, setCustomerFilter] = useState('all')   // all | schumacher | thirdparty
  const [excludeNewGoods, setExcludeNewGoods] = useState(false) // Passaic/BNY only
  const [categoryFilters, setCategoryFilters] = useState(new Set()) // multi-select OR
  const [ageBucketFilters, setAgeBucketFilters] = useState(new Set()) // multi-select OR — clickable aging cards
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
          .select('site, division_raw, customer_type, customer_name_clean, product_type, is_new_goods, bny_bucket, order_number, po_number, line_description, order_status, yards_written, qty_invoiced, income_written, age_days, age_bucket')
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

  // ── Site-scoped row pipeline ────────────────────────────────────────
  // 1. Filter to active site
  // 2. Apply customer filter
  // 3. Apply NG-exclude toggle (only for passaic/bny — Procurement skips)
  // 4. Apply category filter (multi-select OR — only for passaic/bny)
  // 5. Apply age bucket filter (multi-select OR — only for passaic/bny)
  // The result feeds BOTH the aging cards AND the division pivot below.

  const siteRows = useMemo(() => {
    return wipRows.filter(r => r.site === site)
  }, [wipRows, site])

  // Customer counts on the unfiltered site rows — drives the customer pill counts
  const customerCountsForSite = useMemo(() => {
    let sch = 0, tp = 0, other = 0
    for (const r of siteRows) {
      const k = customerKeyFor(r)
      if      (k === 'schumacher')  sch++
      else if (k === 'thirdparty')  tp++
      else                          other++
    }
    return { sch, tp, other, all: siteRows.length }
  }, [siteRows])

  // Apply all OTHER filters (everything except the age-bucket filter) to get
  // the row set for the aging visualization. The aging cards show counts
  // that would result if you weren't already filtering by age — clicking
  // a card narrows the rest of the page, but the cards themselves should
  // reflect the broader picture so you can see why you're filtering.
  const rowsBeforeAge = useMemo(() => {
    let out = siteRows
    if (customerFilter !== 'all') out = out.filter(r => customerKeyFor(r) === customerFilter)
    if (excludeNewGoods && site !== 'procurement') out = out.filter(r => !r.is_new_goods)
    if (categoryFilters.size > 0 && site !== 'procurement') {
      const matchFn = site === 'passaic' ? categoryMatchPassaic : categoryMatchBny
      out = out.filter(r => {
        for (const cat of categoryFilters) {
          if (matchFn(r, cat)) return true
        }
        return false
      })
    }
    return out
  }, [siteRows, customerFilter, excludeNewGoods, categoryFilters, site])

  // Final filtered rows — apply age bucket filter on top of rowsBeforeAge.
  // This is what feeds the Division pivot below.
  const filteredRows = useMemo(() => {
    if (ageBucketFilters.size === 0) return rowsBeforeAge
    return rowsBeforeAge.filter(r => ageBucketFilters.has(ageBucketFor(r)))
  }, [rowsBeforeAge, ageBucketFilters])

  // Aging breakdown — count POs distinct, yards, income per bucket.
  // Built from rowsBeforeAge (NOT filteredRows) so the cards always show the
  // full age picture for the current customer/category/NG filter set.
  const agingByBucket = useMemo(() => {
    const out = {}
    for (const b of AGE_BUCKETS) {
      out[b.id] = { poSet: new Set(), yards: 0, income: 0 }
    }
    for (const r of rowsBeforeAge) {
      const bucket = ageBucketFor(r)
      const poKey = (r.po_number && String(r.po_number).trim())
                  || (r.order_number && String(r.order_number).trim())
      if (poKey) out[bucket].poSet.add(poKey)
      out[bucket].yards  += Number(r.yards_written || 0)
      out[bucket].income += Number(r.income_written || 0)
    }
    // Resolve sets to counts
    const resolved = {}
    for (const b of AGE_BUCKETS) {
      resolved[b.id] = {
        orders: out[b.id].poSet.size,
        yards:  out[b.id].yards,
        income: out[b.id].income,
      }
    }
    return resolved
  }, [rowsBeforeAge])

  // Division pivot for active site only — built from filteredRows.
  // We pass an array containing just one site's rows so buildDivisionPivots
  // emits one division entry. Customer filter is already applied so we pass 'all'.
  const sitePivots = useMemo(() => buildDivisionPivots(filteredRows, 'all'), [filteredRows])
  const divisionsToRender = divisionRenderOrder(Object.keys(sitePivots))

  // Helpers to toggle pill filters
  function toggleCategory(catId) {
    setCategoryFilters(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }
  function toggleAgeBucket(bucketId) {
    setAgeBucketFilters(prev => {
      const next = new Set(prev)
      if (next.has(bucketId)) next.delete(bucketId)
      else next.add(bucketId)
      return next
    })
  }
  function clearAllFilters() {
    setCustomerFilter('all')
    setExcludeNewGoods(false)
    setCategoryFilters(new Set())
    setAgeBucketFilters(new Set())
  }
  // When site changes, reset filters that don't apply (categories, NG exclude
  // are site-specific and would carry over confusingly).
  useEffect(() => {
    setCategoryFilters(new Set())
    setAgeBucketFilters(new Set())
  }, [site])

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
          <div style={{ marginTop: 12, fontSize: 12, color: C.rose, background: C.roseBg, border: `1px solid ${STATUS_BAD_BORDER}`, borderRadius: 6, padding: '8px 12px' }}>{error}</div>
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

          {/* ── Site toggle ───────────────────────────────────────────── */}
          <SiteToggle site={site} onChange={setSite} summary={summary} />

          {/* ── Scoped filter row ─────────────────────────────────────── */}
          <FilterRow
            site={site}
            customerFilter={customerFilter}
            customerCounts={customerCountsForSite}
            onCustomerChange={setCustomerFilter}
            excludeNewGoods={excludeNewGoods}
            onExcludeNewGoodsChange={setExcludeNewGoods}
            categoryFilters={categoryFilters}
            onToggleCategory={toggleCategory}
            ageBucketFilters={ageBucketFilters}
            hasActiveFilters={
              customerFilter !== 'all' ||
              excludeNewGoods ||
              categoryFilters.size > 0 ||
              ageBucketFilters.size > 0
            }
            onClearAll={clearAllFilters}
            visibleCount={filteredRows.length}
            totalCount={siteRows.length}
          />

          {/* ── Aging cards (Passaic/BNY only — Procurement is pass-through) ── */}
          {site !== 'procurement' && (
            <AgingCards
              buckets={agingByBucket}
              activeFilters={ageBucketFilters}
              onToggle={toggleAgeBucket}
            />
          )}

          {/* ── Division pivot for active site ────────────────────────── */}
          {divisionsToRender.length === 0 ? (
            <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.inkLight, fontSize: 13, fontStyle: 'italic' }}>
              No rows match the current filter.
            </div>
          ) : (
            divisionsToRender.map(div => (
              <DivisionPivot
                key={div}
                division={div}
                agg={sitePivots[div]}
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

// ─── Site toggle ──────────────────────────────────────────────────────────
//
// Three-button row: Passaic / Brooklyn / Procurement. Mirrors the NEW Goods
// pattern — active site renders highlighted, count shown for active site.
// Procurement gets a lighter view (no aging, no category filter).

const SITE_TOGGLE_OPTS = [
  { id: 'passaic',     label: 'Passaic',     sub: 'Screen Print' },
  { id: 'bny',         label: 'Brooklyn',    sub: 'Digital'      },
  { id: 'procurement', label: 'Procurement', sub: 'Pass-Through' },
]

function SiteToggle({ site, onChange, summary }) {
  const counts = {
    passaic:     summary?.passaic     ?? 0,
    bny:         summary?.bny         ?? 0,
    procurement: summary?.procurement ?? 0,
  }
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
      {SITE_TOGGLE_OPTS.map(s => {
        const active = site === s.id
        const sub = active ? `${fmt(counts[s.id])} items` : s.sub
        return (
          <button key={s.id} onClick={() => onChange(s.id)}
            style={{
              padding: '12px 20px',
              background: active ? C.ink : '#fff',
              color: active ? '#fff' : C.inkMid,
              border: `1px solid ${active ? C.ink : C.border}`,
              borderRadius: 8,
              fontSize: 13,
              fontWeight: active ? 700 : 500,
              cursor: 'pointer',
              textAlign: 'left',
              minWidth: 140,
            }}>
            <div style={{ fontFamily: 'Georgia,serif', fontSize: 15 }}>{s.label}</div>
            <div style={{ fontSize: 10, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{sub}</div>
          </button>
        )
      })}
    </div>
  )
}

// ─── Unified filter row ───────────────────────────────────────────────────
//
// Customer pills (always shown) + Exclude NEW Goods checkbox (Passaic/BNY
// only) + Category pills (Passaic/BNY only, site-specific). Plus a clear-all
// shortcut when any filter is active. Procurement gets only Customer.

function FilterRow({
  site, customerFilter, customerCounts, onCustomerChange,
  excludeNewGoods, onExcludeNewGoodsChange,
  categoryFilters, onToggleCategory,
  ageBucketFilters,
  hasActiveFilters, onClearAll,
  visibleCount, totalCount,
}) {
  const customerOpts = [
    { v: 'all',         l: 'All',         n: customerCounts.all },
    { v: 'schumacher',  l: 'FSCO',        n: customerCounts.sch },
    { v: 'thirdparty',  l: '3rd Party',   n: customerCounts.tp  },
  ]
  const categories = site === 'passaic' ? PASSAIC_CATEGORIES
                   : site === 'bny'     ? BNY_CATEGORIES
                   : []

  return (
    <div style={{
      background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10,
      padding: '12px 16px', marginBottom: 16,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      {/* Top row: customer + NG exclude + count + clear */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight }}>
          Customer:
        </span>
        {customerOpts.map(o => {
          const active = customerFilter === o.v
          return (
            <button key={o.v} onClick={() => onCustomerChange(o.v)}
              style={{
                padding: '5px 12px', fontSize: 11,
                fontWeight: active ? 700 : 500,
                borderRadius: 14,
                border: `1px solid ${active ? C.ink : C.border}`,
                background: active ? C.ink : 'transparent',
                color: active ? '#fff' : C.inkMid,
                cursor: 'pointer',
              }}>
              {o.l} <span style={{ opacity: 0.7, marginLeft: 4 }}>({fmt(o.n)})</span>
            </button>
          )
        })}
        {site !== 'procurement' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.inkMid, cursor: 'pointer', marginLeft: 8 }}>
            <input type="checkbox" checked={excludeNewGoods} onChange={e => onExcludeNewGoodsChange(e.target.checked)} />
            Exclude NEW Goods
          </label>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: C.inkLight }}>
          {fmt(visibleCount)} of {fmt(totalCount)} rows
        </span>
        {hasActiveFilters && (
          <button onClick={onClearAll}
            style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 500,
              background: 'transparent', color: C.inkLight,
              border: 'none', cursor: 'pointer', textDecoration: 'underline',
            }}>
            clear all
          </button>
        )}
      </div>

      {/* Category pills (site-specific) — only shown when site has categories */}
      {categories.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginRight: 4 }}>
            Category:
          </span>
          {categories.map(cat => {
            const active = categoryFilters.has(cat.id)
            return (
              <button key={cat.id} onClick={() => onToggleCategory(cat.id)}
                style={{
                  padding: '5px 12px', fontSize: 11,
                  fontWeight: active ? 700 : 500,
                  borderRadius: 14,
                  border: `1px solid ${active ? C.ink : C.border}`,
                  background: active ? C.ink : 'transparent',
                  color: active ? '#fff' : C.inkMid,
                  cursor: 'pointer',
                }}>
                {cat.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Aging cards ──────────────────────────────────────────────────────────
//
// Five horizontal cards: Current / 30 / 60 / 90 / 90+. Each shows distinct
// PO count + yards + income. Click a card to toggle that bucket as a
// filter — multi-select OR. Active cards visually highlight; inactive
// cards stay quiet. Color severity grows from neutral (current) → red (90+).

// Aging cards stay LOUD — Path A directive: operational signals (aging,
// status, misses) preserve green/amber/red even though the rest of the
// palette goes Cosmic. The severity gradient runs neutral (Current) →
// neutral (30) → amber (60) → red (90) → fully red (90+).
const AGE_BUCKET_TONES = {
  current: { bg: C.parchment,    fg: C.inkMid,    border: C.border,           accent: STATUS_GOOD_BORDER },
  '30':    { bg: C.parchment,    fg: C.inkMid,    border: C.border,           accent: STATUS_WARN_BORDER },
  '60':    { bg: STATUS_WARN_BG, fg: STATUS_WARN, border: STATUS_WARN_BORDER, accent: STATUS_WARN        },
  '90':    { bg: STATUS_BAD_BG,  fg: STATUS_BAD,  border: STATUS_BAD_BORDER,  accent: STATUS_BAD         },
  '90plus':{ bg: STATUS_BAD_BG,  fg: STATUS_BAD,  border: STATUS_BAD,         accent: STATUS_BAD         },
}

function AgingCards({ buckets, activeFilters, onToggle }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginBottom: 8 }}>
        Aging · click a card to filter
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(140px, 1fr))`, gap: 8 }}>
        {AGE_BUCKETS.map(b => {
          const data = buckets[b.id] || { orders: 0, yards: 0, income: 0 }
          const active = activeFilters.has(b.id)
          const tone = AGE_BUCKET_TONES[b.id]
          return (
            <button key={b.id} onClick={() => onToggle(b.id)}
              style={{
                padding: '14px 16px',
                background: active ? tone.bg : '#fff',
                border: `1px solid ${active ? tone.accent : C.border}`,
                borderLeft: `4px solid ${tone.accent}`,
                borderRadius: 8,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.15s',
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: active ? tone.fg : C.inkMid }}>
                  {b.label}
                </span>
                <span style={{ fontSize: 9, color: C.inkLight }}>{b.sub}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: active ? tone.fg : C.ink, fontFamily: 'Georgia,serif', lineHeight: 1.1 }}>
                {fmt(data.orders)}
              </div>
              <div style={{ fontSize: 10, color: C.inkLight, marginTop: 4 }}>
                {fmt(data.yards)} yds · {fmtD(data.income)}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
