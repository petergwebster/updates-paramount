import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { parseLiftWorkbook } from '../liftParser'
import { C, fmt, fmtD, SITES, isoDate, defaultSchedulerWeek } from '../lib/scheduleUtils'
import PassaicScheduler from './PassaicScheduler'
import BNYScheduler from './BNYScheduler'
import NewGoodsView from './NewGoodsView'

// ─── Shared across sites: high-color threshold used in WIP list highlighting ─
const HIGH_COLOR_THRESHOLD = 6

// ═══════════════════════════════════════════════════════════════════════════
// SchedulerTab — orchestrator
// Owns: upload + snapshot management, site pill, WIP list view.
// Routes to PassaicScheduler / BNYScheduler when view === 'schedule'.
// ═══════════════════════════════════════════════════════════════════════════
export default function SchedulerTab() {
  const [site, setSite] = useState('passaic')
  const [view, setView] = useState('wip')
  const [procFilter, setProcFilter] = useState('all') // all | spo — only used when site='procurement'
  const [snapshot, setSnapshot] = useState(null)
  const [wipRows, setWipRows] = useState([])
  const [unknownWipRows, setUnknownWipRows] = useState([])
  const [assignments, setAssignments] = useState([])
  const [weekStart, setWeekStart] = useState(defaultSchedulerWeek())
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [uploadStatus, setUploadStatus] = useState(null)
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

      if (!snap) { setWipRows([]); setUnknownWipRows([]); setAssignments([]); return }

      const all = []
      const pageSize = 1000
      let from = 0
      while (true) {
        const { data, error: re } = await supabase
          .from('sched_wip_rows')
          .select('*')
          .eq('snapshot_id', snap.id)
          .eq('site', site)
          .range(from, from + pageSize - 1)
        if (re) throw re
        if (!data || data.length === 0) break
        all.push(...data)
        if (data.length < pageSize) break
        from += pageSize
      }
      setWipRows(all)

      // Also load any site='unknown' rows so the New Goods view can surface
      // orphan POs (no Division yet, no recognizable MATERIAL prefix) in its
      // pre-classification section. Small set in practice (~30 rows typical).
      const { data: unknownData, error: unknownErr } = await supabase
        .from('sched_wip_rows')
        .select('*')
        .eq('snapshot_id', snap.id)
        .eq('site', 'unknown')
      if (unknownErr) throw unknownErr
      setUnknownWipRows(unknownData || [])

      const { data: asg, error: ae } = await supabase
        .from('sched_assignments')
        .select('*')
        .eq('site', site)
        .eq('week_start', isoDate(weekStart))
      if (ae) throw ae
      setAssignments(asg || [])
    } catch (e) {
      console.error(e); setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadLatest() }, [site, weekStart])

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
          bny_orders:  parsed.summary.bny.orders,
          bny_yards:   parsed.summary.bny.yards,
          bny_revenue: parsed.summary.bny.revenue,
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

  // Option C — pre-production New Goods (Waiting for Approval, Strike Off,
  // Waiting for Sample/Screen/Material) excluded from the regular WIP view.
  // Their 6-month dev lead times distort aging metrics and aren't comparable
  // to ready-to-print stock. They remain in the New Goods view (full pipeline).
  // Once a New Goods PO graduates to "Approved to Print" or beyond, it
  // re-enters this regular WIP automatically — no special action needed.
  const displayWipRows = useMemo(() => {
    const ngPreprodStatuses = new Set([
      'Waiting for Approval','Strike Off','Waiting for Sample',
      'Waiting for Screen','Waiting for Material',
    ])
    return wipRows.filter(r => !(r.is_new_goods && ngPreprodStatuses.has(r.order_status || '')))
  }, [wipRows])

  const totals = useMemo(() => {
    const t = { orders: 0, yards: 0, revenue: 0, color_yards: 0 }
    for (const r of displayWipRows) {
      t.orders += 1
      t.yards += Number(r.yards_written || 0)
      t.revenue += Number(r.income_written || 0)
      t.color_yards += Number(r.color_yards || 0)
    }
    return t
  }, [displayWipRows])

  const byAge = useMemo(() => {
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, 'no-date': 0 }
    const yardsByBucket = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, 'no-date': 0 }
    for (const r of displayWipRows) {
      const b = r.age_bucket || 'no-date'
      if (b in buckets) {
        buckets[b] += 1
        yardsByBucket[b] += Number(r.yards_written || 0)
      }
    }
    return { buckets, yards: yardsByBucket }
  }, [displayWipRows])

  const byCategory = useMemo(() => {
    const m = {}
    for (const r of displayWipRows) {
      const k = r.product_type || 'Other'
      if (!m[k]) m[k] = { orders: 0, yards: 0, revenue: 0, color_yards: 0 }
      m[k].orders += 1
      m[k].yards += Number(r.yards_written || 0)
      m[k].revenue += Number(r.income_written || 0)
      m[k].color_yards += Number(r.color_yards || 0)
    }
    return m
  }, [displayWipRows])

  const showCY = site === 'passaic'
  const showYards = site !== 'procurement'

  async function reloadAssignments() {
    const { data } = await supabase
      .from('sched_assignments')
      .select('*')
      .eq('site', site)
      .eq('week_start', isoDate(weekStart))
    setAssignments(data || [])
  }

  return (
    <div style={{ background: C.cream, minHeight: '100vh', padding: '0 0 48px', fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      <div style={{ padding: '20px 0 16px', marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: C.ink, fontFamily: 'Georgia,serif' }}>Production · Scheduler</h2>
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

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {SITES.map(s => {
          const active = site === s.key
          return (
            <button key={s.key} onClick={() => setSite(s.key)}
              style={{ padding: '10px 18px', borderRadius: 8, border: `1.5px solid ${active ? s.color : C.border}`, background: active ? s.color : 'transparent', color: active ? '#fff' : C.inkMid, fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 130, gap: 2 }}>
              <span>{s.label}</span>
              <span style={{ fontSize: 10, opacity: 0.75, fontWeight: 400, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.sub}</span>
            </button>
          )
        })}
      </div>

      {(site === 'passaic' || site === 'bny') && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
          {[{ v:'wip', l:'WIP List' },{ v:'newgoods', l:'New Goods' },{ v:'schedule', l:'Weekly Schedule' }].map(({ v, l }) => (
            <button key={v} onClick={() => setView(v)}
              style={{ padding: '8px 20px', fontSize: 13, fontWeight: view === v ? 700 : 400, borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${view === v ? C.ink : C.border}`, background: view === v ? C.ink : 'transparent', color: view === v ? '#fff' : C.inkMid }}>
              {l}
            </button>
          ))}
        </div>
      )}

      {site === 'procurement' && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
          {[{ v:'wip', l:'WIP List' },{ v:'newgoods', l:'New Goods' }].map(({ v, l }) => {
            // Procurement doesn't get a Weekly Schedule view (pass-through, no scheduling)
            const procView = view === 'schedule' ? 'wip' : view
            return (
              <button key={v} onClick={() => setView(v)}
                style={{ padding: '8px 20px', fontSize: 13, fontWeight: procView === v ? 700 : 400, borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${procView === v ? C.ink : C.border}`, background: procView === v ? C.ink : 'transparent', color: procView === v ? '#fff' : C.inkMid }}>
                {l}
              </button>
            )
          })}
        </div>
      )}

      {!snapshot && !loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.2 }}>⌘</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.inkMid, fontFamily: 'Georgia,serif', marginBottom: 8 }}>No WIP data yet</div>
          <div style={{ fontSize: 13, color: C.inkLight }}>Click "Upload LIFT WIP" to get started.</div>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: C.inkLight, fontSize: 14 }}>Loading…</div>
      )}

      {snapshot && !loading && (view === 'wip' || (site === 'procurement' && view === 'schedule')) && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <SummaryCard label="Active orders" value={fmt(totals.orders)} />
            {showYards && <SummaryCard label="Yards" value={fmt(totals.yards)} />}
            {showCY && <SummaryCard label="Color-yards" value={fmt(totals.color_yards)} highlight />}
            <SummaryCard label="Revenue in WIP" value={fmtD(totals.revenue)} />
          </div>
          <AgingBar byAge={byAge} />
          <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: C.ink, margin: 0, textTransform: 'uppercase', letterSpacing: '0.06em' }}>By product type</h3>
            <span style={{ fontSize: 12, color: C.inkLight }}>— {Object.keys(byCategory).length} categor{Object.keys(byCategory).length === 1 ? 'y' : 'ies'}</span>
          </div>
          <CategoryTable byCategory={byCategory} showCY={showCY} showYards={showYards} />
          {site === 'procurement' && (
            <div style={{ marginTop: 16, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginRight: 4 }}>Filter:</span>
              <button onClick={() => setProcFilter('all')}
                style={{ padding: '5px 12px', fontSize: 11, fontWeight: procFilter === 'all' ? 700 : 500, borderRadius: 14, border: `1px solid ${procFilter === 'all' ? C.ink : C.border}`, background: procFilter === 'all' ? C.ink : 'transparent', color: procFilter === 'all' ? '#fff' : C.inkMid, cursor: 'pointer' }}>
                All ({displayWipRows.length})
              </button>
              <button onClick={() => setProcFilter('spo')}
                style={{ padding: '5px 12px', fontSize: 11, fontWeight: procFilter === 'spo' ? 700 : 500, borderRadius: 14, border: `1px solid ${procFilter === 'spo' ? '#C75D2F' : C.border}`, background: procFilter === 'spo' ? '#C75D2F' : 'transparent', color: procFilter === 'spo' ? '#fff' : C.inkMid, cursor: 'pointer' }}>
                SPO ship-direct ({displayWipRows.filter(r => (r.po_number || '').toUpperCase().startsWith('SOP')).length})
              </button>
            </div>
          )}
          <RowList
            rows={site === 'procurement' && procFilter === 'spo'
              ? displayWipRows.filter(r => (r.po_number || '').toUpperCase().startsWith('SOP'))
              : displayWipRows}
            showCY={showCY}
            showYards={showYards}
          />
        </>
      )}

      {snapshot && !loading && view === 'schedule' && site === 'passaic' && (
        <PassaicScheduler
          wipRows={wipRows}
          assignments={assignments}
          weekStart={weekStart}
          onWeekChange={setWeekStart}
          onAssignmentsChange={reloadAssignments}
        />
      )}

      {snapshot && !loading && view === 'schedule' && site === 'bny' && (
        <BNYScheduler
          wipRows={wipRows}
          assignments={assignments}
          weekStart={weekStart}
          onWeekChange={setWeekStart}
          onAssignmentsChange={reloadAssignments}
        />
      )}

      {snapshot && !loading && view === 'newgoods' && (site === 'passaic' || site === 'bny' || site === 'procurement') && (
        <NewGoodsView
          wipRows={wipRows}
          unknownRows={unknownWipRows}
          site={site}
          siteLabel={site === 'passaic' ? 'Passaic' : site === 'bny' ? 'Brooklyn' : 'Procurement'}
        />
      )}
    </div>
  )
}

// ─── WIP list view components (site-agnostic) ──────────────────────────────

function SummaryCard({ label, value, highlight }) {
  return (
    <div style={{ flex: 1, minWidth: 160, padding: '14px 18px', background: highlight ? C.navy : '#fff', color: highlight ? '#fff' : C.ink, border: `1px solid ${highlight ? C.navy : C.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: highlight ? 'rgba(255,255,255,0.7)' : C.inkLight, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'Georgia,serif' }}>{value}</div>
    </div>
  )
}

function AgingBar({ byAge }) {
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
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.inkLight, marginBottom: 12 }}>WIP Aging by Order Date</div>
      {/* Container height accommodates: value label (~14px) + bar (max 60px) +
          bucket label (~12px) + count (~12px) + 3 gaps (9px) = ~107px. Set
          to 110 to avoid overflow when the tallest bucket's label would
          otherwise push above the container into the title row. */}
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

function CategoryTable({ byCategory, showCY, showYards }) {
  const entries = Object.entries(byCategory).sort((a, b) => b[1].revenue - a[1].revenue)
  if (entries.length === 0) return null
  return (
    <div style={{ background: '#fff', borderRadius: 10, border: `1px solid ${C.border}`, marginBottom: 20, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `1.5fr 80px ${showYards ? '100px' : ''} ${showCY ? '110px' : ''} 120px`.trim(), gap: 0, padding: '10px 16px', background: C.parchment, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.inkLight }}>
        <span>Category</span>
        <span style={{ textAlign: 'right' }}>Orders</span>
        {showYards && <span style={{ textAlign: 'right' }}>Yards</span>}
        {showCY && <span style={{ textAlign: 'right' }}>CY</span>}
        <span style={{ textAlign: 'right' }}>Revenue</span>
      </div>
      {entries.map(([cat, v]) => (
        <div key={cat} style={{ display: 'grid', gridTemplateColumns: `1.5fr 80px ${showYards ? '100px' : ''} ${showCY ? '110px' : ''} 120px`.trim(), gap: 0, padding: '10px 16px', borderTop: `1px solid ${C.border}`, fontSize: 13 }}>
          <span style={{ color: C.ink, fontWeight: 500 }}>{cat}</span>
          <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(v.orders)}</span>
          {showYards && <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(v.yards)}</span>}
          {showCY && <span style={{ textAlign: 'right', color: C.inkMid, fontWeight: 600 }}>{fmt(v.color_yards)}</span>}
          <span style={{ textAlign: 'right', color: C.inkMid }}>{fmtD(v.revenue)}</span>
        </div>
      ))}
    </div>
  )
}

function RowList({ rows, showCY, showYards }) {
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState('')
  const [sortBy, setSortBy] = useState('age_days')
  const [sortDir, setSortDir] = useState('desc')

  function toggleSort(field) {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(field); setSortDir('desc') }
  }

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      let va = a[sortBy], vb = b[sortBy]
      if (va == null) va = sortDir === 'asc' ? Infinity : -Infinity
      if (vb == null) vb = sortDir === 'asc' ? Infinity : -Infinity
      if (typeof va === 'string') return va.localeCompare(String(vb)) * dir
      return (va - vb) * dir
    })
  }, [rows, sortBy, sortDir])

  const filtered = useMemo(() => {
    if (!filter) return sorted
    const q = filter.toLowerCase()
    return sorted.filter(r =>
      (r.po_number || '').toLowerCase().includes(q) ||
      (r.line_description || '').toLowerCase().includes(q) ||
      (r.product_type || '').toLowerCase().includes(q) ||
      (r.order_status || '').toLowerCase().includes(q)
    )
  }, [sorted, filter])

  const shown = expanded ? filtered : filtered.slice(0, 25)

  const SortHdr = ({ field, children, align = 'left' }) => (
    <span onClick={() => toggleSort(field)} style={{ cursor: 'pointer', textAlign: align, userSelect: 'none' }}>
      {children}
      {sortBy === field && <span style={{ marginLeft: 4, color: C.navy }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </span>
  )

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: C.ink, margin: 0, textTransform: 'uppercase', letterSpacing: '0.06em' }}>All orders</h3>
        <span style={{ fontSize: 12, color: C.inkLight }}>— {filtered.length} of {rows.length}</span>
        <input type="text" placeholder="Filter by PO, pattern, status…" value={filter} onChange={e => setFilter(e.target.value)}
          style={{ padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, minWidth: 260, background: '#fff', color: C.ink }} />
        <span style={{ fontSize: 11, color: C.inkLight, fontStyle: 'italic' }}>Click any column header to sort</span>
      </div>
      <div style={{ background: '#fff', borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `110px 1fr 120px 120px 60px ${showYards ? '70px' : ''} ${showCY ? '80px' : ''} 90px 60px`.trim(), gap: 0, padding: '10px 14px', background: C.parchment, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.inkLight }}>
          <SortHdr field="po_number">PO</SortHdr>
          <SortHdr field="line_description">Pattern</SortHdr>
          <SortHdr field="order_status">Status</SortHdr>
          <SortHdr field="product_type">Category</SortHdr>
          <SortHdr field="colors_count" align="right">Col</SortHdr>
          {showYards && <SortHdr field="yards_written" align="right">Yds</SortHdr>}
          {showCY && <SortHdr field="color_yards" align="right">CY</SortHdr>}
          <SortHdr field="income_written" align="right">Revenue</SortHdr>
          <SortHdr field="age_days" align="right">Age</SortHdr>
        </div>
        {shown.length === 0 && (
          <div style={{ padding: '32px 14px', textAlign: 'center', borderTop: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 13, color: C.inkMid, fontWeight: 500, marginBottom: 4 }}>
              {rows.length === 0 ? 'No orders to display' : 'No orders match the current filter'}
            </div>
            {rows.length === 0 && (
              <div style={{ fontSize: 11, color: C.inkLight, fontStyle: 'italic' }}>
                If you expected results here, try clearing the filter chips above or re-uploading the latest LIFT WIP.
              </div>
            )}
          </div>
        )}
        {shown.map(r => {
          const ageColor = (r.age_days || 0) > 90 ? C.rose : (r.age_days || 0) > 60 ? C.amber : C.inkMid
          // SPO ship-direct ground orders identified by PO prefix per Wendy 4/2026.
          // Visible badge so Wendy/Chandler can spot them at a glance — these
          // ship direct to Schumacher customers, not pass-through to HUB.
          const isSpo = (r.po_number || '').toUpperCase().startsWith('SOP')
          return (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: `110px 1fr 120px 120px 60px ${showYards ? '70px' : ''} ${showCY ? '80px' : ''} 90px 60px`.trim(), gap: 0, padding: '8px 14px', borderTop: `1px solid ${C.border}`, fontSize: 12 }}>
              <span style={{ color: C.inkLight, fontFamily: 'monospace', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.po_number}</span>
                {isSpo && <span title="Ship-direct (not HUB)" style={{ background: '#C75D2F', color: '#fff', fontSize: 8, padding: '1px 4px', borderRadius: 3, fontWeight: 700, letterSpacing: '0.04em', flexShrink: 0 }}>SPO</span>}
              </span>
              <span style={{ color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.line_description}</span>
              <span style={{ color: C.inkMid, fontSize: 11 }}>{r.order_status}</span>
              <span style={{ color: C.inkMid, fontSize: 11 }}>{r.product_type}</span>
              <span style={{ textAlign: 'right', color: r.colors_count >= HIGH_COLOR_THRESHOLD ? C.rose : C.inkMid, fontWeight: r.colors_count >= HIGH_COLOR_THRESHOLD ? 700 : 400 }}>{r.colors_count ?? '—'}</span>
              {showYards && <span style={{ textAlign: 'right', color: C.inkMid }}>{fmt(r.yards_written)}</span>}
              {showCY && <span style={{ textAlign: 'right', color: C.ink, fontWeight: 600 }}>{r.color_yards ? fmt(r.color_yards) : '—'}</span>}
              <span style={{ textAlign: 'right', color: C.inkMid }}>{fmtD(r.income_written)}</span>
              <span style={{ textAlign: 'right', color: ageColor, fontWeight: 600 }}>{r.age_days != null ? `${r.age_days}d` : '—'}</span>
            </div>
          )
        })}
        {filtered.length > 25 && (
          <div style={{ padding: '10px 14px', textAlign: 'center', background: C.parchment, borderTop: `1px solid ${C.border}` }}>
            <button onClick={() => setExpanded(!expanded)} style={{ background: 'transparent', border: 'none', color: C.navy, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {expanded ? '▲ Show less' : `▼ Show all ${filtered.length}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
