import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { parseLiftWorkbook } from '../liftParser'

// ─── Palette (matches WIPTab) ───────────────────────────────────────────────
const C = {
  cream:'#FAF7F2', parchment:'#F2EDE4', warm:'#E8DDD0', border:'#DDD4C8',
  ink:'#2C2420', inkMid:'#5C4F47', inkLight:'#9C8F87',
  gold:'#B8860B', goldLight:'#D4A843', goldBg:'#FDF8EC',
  navy:'#1E3A5F', navyLight:'#E8EEF5',
  amber:'#C17F24', amberBg:'#FEF3E2',
  sage:'#4A6741', sageBg:'#EEF3EC',
  rose:'#8B3A3A', roseBg:'#F9EDED',
  slate:'#4A5568', slateBg:'#EDF2F7',
}

const fmt  = n => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const fmtD = n => '$' + (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const fmtK = n => {
  const v = n || 0
  if (Math.abs(v) >= 1000) return '$' + (v/1000).toFixed(0) + 'K'
  return fmtD(v)
}

// ─── Site config ────────────────────────────────────────────────────────────
const SITES = [
  { key: 'passaic',     label: 'Passaic',     sub: 'Screen Print',  color: C.navy },
  { key: 'bny',         label: 'Brooklyn',    sub: 'Digital',       color: C.amber },
  { key: 'procurement', label: 'Procurement', sub: 'Pass-through',  color: C.slate },
]

// ─── Passaic weekly targets (from Feb results deck, slide 25) ──────────────
const PASSAIC_TARGETS = {
  total:     { yards: 8500,  cy: 33797, revenue: 116450 },
  grass:     { yards: 3785,  cy: 11355, tables: 2 },
  fabric:    { yards: 834,   cy: 3337,  tables: 9 },
  wallpaper: { yards: 3830,  cy: 15319, tables: 6 },
}

const MIX_TARGET_SCH = 0.60  // 60% Schumacher / 40% 3rd Party
const HIGH_COLOR_THRESHOLD = 6

// Patterns with a history of waste (from Feb deck slide 23)
const WASTE_HISTORY_PATTERNS = [
  'CLOUD TOILE', 'BANANA LEAF', 'ACANTHUS STRIPE',
  'PYNE HOLLYHOCK', 'BOTANICO METALLIC',
]
const hasWasteHistory = (lineDesc) => {
  if (!lineDesc) return false
  const up = lineDesc.toUpperCase()
  return WASTE_HISTORY_PATTERNS.some(p => up.includes(p))
}

// ─── Passaic table layout ──────────────────────────────────────────────────
const PASSAIC_TABLES = [
  ...['GC-1','GC-2'].map(code => ({
    code, category: 'grass', label: code,
    capacity_cy: Math.round(PASSAIC_TARGETS.grass.cy / PASSAIC_TARGETS.grass.tables),
  })),
  ...['FAB-3','FAB-4','FAB-5','FAB-6','FAB-7','FAB-8','FAB-9','FAB-10','FAB-11'].map(code => ({
    code, category: 'fabric', label: code,
    capacity_cy: Math.round(PASSAIC_TARGETS.fabric.cy / PASSAIC_TARGETS.fabric.tables),
  })),
  ...['WP-12','WP-13','WP-14','WP-15','WP-16','WP-17'].map(code => ({
    code, category: 'wallpaper', label: code,
    capacity_cy: Math.round(PASSAIC_TARGETS.wallpaper.cy / PASSAIC_TARGETS.wallpaper.tables),
  })),
]

// ─── Date helpers: Monday-start weeks ──────────────────────────────────────
function mondayOf(d) {
  const x = new Date(d)
  x.setHours(0,0,0,0)
  const day = x.getDay()
  const diff = day === 0 ? -6 : 1 - day
  x.setDate(x.getDate() + diff)
  return x
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x }
function addWeeks(d, n) { return addDays(d, n * 7) }
function isoDate(d) { return d.toISOString().slice(0,10) }
function weekLabel(d) {
  const end = addDays(d, 4)
  const m = { 0:'Jan',1:'Feb',2:'Mar',3:'Apr',4:'May',5:'Jun',6:'Jul',7:'Aug',8:'Sep',9:'Oct',10:'Nov',11:'Dec' }
  return `${m[d.getMonth()]} ${d.getDate()}–${end.getDate()}, ${d.getFullYear()}`
}

// ─── Main component ─────────────────────────────────────────────────────────
export default function SchedulerTab() {
  const [site, setSite] = useState('passaic')
  const [view, setView] = useState('wip')
  const [snapshot, setSnapshot] = useState(null)
  const [wipRows, setWipRows] = useState([])
  const [assignments, setAssignments] = useState([])
  const [weekStart, setWeekStart] = useState(mondayOf(new Date()))
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

      if (!snap) { setWipRows([]); setAssignments([]); return }

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
        snapshot_id: snapshotId,
        site: r.site,
        division_raw: r.division_raw,
        customer_type: r.customer_type,
        product_type: r.product_type,
        is_new_goods: r.is_new_goods,
        order_number: r.order_number,
        po_number: r.po_number,
        line_description: r.line_description,
        item_sku: r.item_sku,
        color: r.color,
        material: r.material,
        order_status: r.order_status,
        colors_count: r.colors_count,
        color_yards: r.color_yards,
        order_created: r.order_created,
        yards_written: r.yards_written,
        qty_invoiced: r.qty_invoiced,
        income_written: r.income_written,
        age_days: r.age_days,
        age_bucket: r.age_bucket,
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

  const totals = useMemo(() => {
    const t = { orders: 0, yards: 0, revenue: 0, color_yards: 0 }
    for (const r of wipRows) {
      t.orders += 1
      t.yards += Number(r.yards_written || 0)
      t.revenue += Number(r.income_written || 0)
      t.color_yards += Number(r.color_yards || 0)
    }
    return t
  }, [wipRows])

  const byAge = useMemo(() => {
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, 'no-date': 0 }
    const yardsByBucket = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, 'no-date': 0 }
    for (const r of wipRows) {
      const b = r.age_bucket || 'no-date'
      if (b in buckets) {
        buckets[b] += 1
        yardsByBucket[b] += Number(r.yards_written || 0)
      }
    }
    return { buckets, yards: yardsByBucket }
  }, [wipRows])

  const byCategory = useMemo(() => {
    const m = {}
    for (const r of wipRows) {
      const k = r.product_type || 'Other'
      if (!m[k]) m[k] = { orders: 0, yards: 0, revenue: 0, color_yards: 0 }
      m[k].orders += 1
      m[k].yards += Number(r.yards_written || 0)
      m[k].revenue += Number(r.income_written || 0)
      m[k].color_yards += Number(r.color_yards || 0)
    }
    return m
  }, [wipRows])

  const showCY = site === 'passaic'
  const showYards = site !== 'procurement'

  return (
    <div style={{ background: C.cream, minHeight: '100vh', padding: '0 0 48px', fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      {/* Page header */}
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

      {/* Site selector */}
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

      {/* View toggle — Passaic only */}
      {site === 'passaic' && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
          {[{ v:'wip', l:'WIP List' },{ v:'schedule', l:'Weekly Schedule' }].map(({ v, l }) => (
            <button key={v} onClick={() => setView(v)}
              style={{ padding: '8px 20px', fontSize: 13, fontWeight: view === v ? 700 : 400, borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${view === v ? C.ink : C.border}`, background: view === v ? C.ink : 'transparent', color: view === v ? '#fff' : C.inkMid }}>
              {l}
            </button>
          ))}
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

      {/* WIP LIST VIEW */}
      {snapshot && !loading && (view === 'wip' || site !== 'passaic') && (
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
          <RowList rows={wipRows} showCY={showCY} showYards={showYards} />
        </>
      )}

      {/* WEEKLY SCHEDULE VIEW (Phase 2 mix composer) */}
      {snapshot && !loading && view === 'schedule' && site === 'passaic' && (
        <ScheduleComposer
          wipRows={wipRows}
          assignments={assignments}
          weekStart={weekStart}
          onWeekChange={setWeekStart}
          onAssignmentsChange={async () => {
            const { data } = await supabase
              .from('sched_assignments')
              .select('*')
              .eq('site', 'passaic')
              .eq('week_start', isoDate(weekStart))
            setAssignments(data || [])
          }}
        />
      )}
    </div>
  )
}

// ─── Subcomponents: WIP list (Phase 1) ──────────────────────────────────────
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
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 80 }}>
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

  if (rows.length === 0) return null

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
        {shown.map(r => {
          const ageColor = (r.age_days || 0) > 90 ? C.rose : (r.age_days || 0) > 60 ? C.amber : C.inkMid
          return (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: `110px 1fr 120px 120px 60px ${showYards ? '70px' : ''} ${showCY ? '80px' : ''} 90px 60px`.trim(), gap: 0, padding: '8px 14px', borderTop: `1px solid ${C.border}`, fontSize: 12 }}>
              <span style={{ color: C.inkLight, fontFamily: 'monospace', fontSize: 11 }}>{r.po_number}</span>
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

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2: SCHEDULE COMPOSER
// ═══════════════════════════════════════════════════════════════════════════
function ScheduleComposer({ wipRows, assignments, weekStart, onWeekChange, onAssignmentsChange }) {
  const [selectedPO, setSelectedPO] = useState(null)
  const [assigning, setAssigning] = useState(false)
  const [assignModal, setAssignModal] = useState(null)
  const [poolFilter, setPoolFilter] = useState('')
  const [filterSch, setFilterSch] = useState(null)
  const [filterHighColor, setFilterHighColor] = useState(false)
  const [filterWasteHist, setFilterWasteHist] = useState(false)

  const assignedByPO = useMemo(() => {
    const m = {}
    for (const a of assignments) {
      m[a.po_number] = (m[a.po_number] || 0) + Number(a.planned_yards || 0)
    }
    return m
  }, [assignments])

  const pool = useMemo(() => {
    const schedulableStatuses = new Set([
      'Approved to Print','Ready to Print','In Mixing Queue','In Progress',
      'Waiting for Material','Waiting for Screen','Waiting for Approval','Waiting for Sample',
      'Strike Off','Orders Unallocated',
    ])
    return wipRows
      .filter(r => schedulableStatuses.has(r.order_status || ''))
      .map(r => {
        const already = assignedByPO[r.po_number] || 0
        const remaining = Math.max(0, Number(r.yards_written || 0) - already)
        return { ...r, assigned_already: already, remaining_yards: remaining }
      })
      .filter(r => r.remaining_yards > 0)
  }, [wipRows, assignedByPO])

  const filteredPool = useMemo(() => {
    let list = pool
    if (poolFilter) {
      const q = poolFilter.toLowerCase()
      list = list.filter(r => (r.po_number||'').toLowerCase().includes(q) || (r.line_description||'').toLowerCase().includes(q))
    }
    if (filterSch === 'sch') list = list.filter(r => (r.customer_type||'').toLowerCase() === 'schumacher')
    if (filterSch === '3p')  list = list.filter(r => (r.customer_type||'').toLowerCase().includes('3rd'))
    if (filterHighColor)     list = list.filter(r => (r.colors_count || 0) >= HIGH_COLOR_THRESHOLD)
    if (filterWasteHist)     list = list.filter(r => hasWasteHistory(r.line_description))
    return list.sort((a,b) => (b.age_days || 0) - (a.age_days || 0))
  }, [pool, poolFilter, filterSch, filterHighColor, filterWasteHist])

  const wipByPO = useMemo(() => {
    const m = {}
    for (const r of wipRows) m[r.po_number] = r
    return m
  }, [wipRows])

  const enrichedAssignments = useMemo(() => {
    return assignments.map(a => {
      const src = wipByPO[a.po_number] || {}
      return {
        ...a,
        line_description: a.line_description || src.line_description || a.po_number,
        customer_type: src.customer_type || null,
        colors_count: src.colors_count || null,
        income_per_yard: src.income_written && src.yards_written ? (src.income_written / src.yards_written) : 0,
      }
    })
  }, [assignments, wipByPO])

  const mixTotals = useMemo(() => {
    const t = {
      yards: 0, cy: 0, revenue: 0,
      schumacher_revenue: 0, third_party_revenue: 0,
      grass:     { yards: 0, cy: 0, revenue: 0 },
      fabric:    { yards: 0, cy: 0, revenue: 0 },
      wallpaper: { yards: 0, cy: 0, revenue: 0 },
      avg_colors_weighted: 0, colors_yard_sum: 0, yards_with_colors: 0,
    }
    for (const a of enrichedAssignments) {
      const yd = Number(a.planned_yards || 0)
      const cy = Number(a.planned_cy || 0)
      const rev = yd * (a.income_per_yard || 0)
      t.yards += yd
      t.cy += cy
      t.revenue += rev
      if ((a.customer_type||'').toLowerCase() === 'schumacher') t.schumacher_revenue += rev
      else if ((a.customer_type||'').toLowerCase().includes('3rd')) t.third_party_revenue += rev

      const tbl = PASSAIC_TABLES.find(t => t.code === a.table_code)
      if (tbl) {
        t[tbl.category].yards += yd
        t[tbl.category].cy += cy
        t[tbl.category].revenue += rev
      }
      if (a.colors_count) {
        t.colors_yard_sum += a.colors_count * yd
        t.yards_with_colors += yd
      }
    }
    t.avg_colors_weighted = t.yards_with_colors > 0 ? (t.colors_yard_sum / t.yards_with_colors) : 0
    return t
  }, [enrichedAssignments])

  function handleTableClick(tableCode) {
    if (!selectedPO) return
    if (selectedPO.remaining_yards > 0) {
      setAssignModal({ po: selectedPO, tableCode, proposed_yards: selectedPO.remaining_yards })
    }
  }

  async function commitAssignment({ po, tableCode, yards }) {
    setAssigning(true)
    try {
      const colors = po.colors_count || null
      const cy = colors ? colors * yards : null
      const { error: ie } = await supabase.from('sched_assignments').insert({
        site: 'passaic',
        po_number: po.po_number,
        line_description: po.line_description,
        product_type: po.product_type,
        table_code: tableCode,
        week_start: isoDate(weekStart),
        day_of_week: null,
        planned_yards: yards,
        planned_cy: cy,
        assigned_by: null,
        notes: null,
        status: 'planned',
      })
      if (ie) throw ie
      await onAssignmentsChange()
      if (yards >= po.remaining_yards) setSelectedPO(null)
      else setSelectedPO({ ...po, remaining_yards: po.remaining_yards - yards, assigned_already: (po.assigned_already||0) + yards })
      setAssignModal(null)
    } catch (e) {
      console.error(e)
      alert('Assignment failed: ' + (e.message || e))
    } finally {
      setAssigning(false)
    }
  }

  async function removeAssignment(id) {
    if (!confirm('Remove this assignment?')) return
    const { error: de } = await supabase.from('sched_assignments').delete().eq('id', id)
    if (de) { alert('Delete failed: ' + de.message); return }
    await onAssignmentsChange()
  }

  return (
    <div>
      {/* Week navigator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 14px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <button onClick={() => onWeekChange(addWeeks(weekStart, -1))} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.inkMid }}>← Prev week</button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>Week of {weekLabel(weekStart)}</div>
          <div style={{ fontSize: 11, color: C.inkLight }}>{enrichedAssignments.length} assignment{enrichedAssignments.length !== 1 ? 's' : ''}</div>
        </div>
        <button onClick={() => onWeekChange(mondayOf(new Date()))} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, color: C.inkMid }}>This week</button>
        <button onClick={() => onWeekChange(addWeeks(weekStart, 1))} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.inkMid }}>Next week →</button>
      </div>

      <MixGauges totals={mixTotals} />
      <CategoryStrip totals={mixTotals} />

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, marginTop: 16 }}>
        {/* POOL */}
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', height: 'fit-content', position: 'sticky', top: 16 }}>
          <div style={{ padding: '12px 14px', background: C.parchment, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 6 }}>Unscheduled Pool</div>
            <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{filteredPool.length} POs to schedule</div>
          </div>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
            <input type="text" value={poolFilter} onChange={e => setPoolFilter(e.target.value)} placeholder="Search pattern or PO…"
              style={{ width: '100%', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, marginBottom: 8, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <FilterChip active={filterSch === 'sch'} onClick={() => setFilterSch(filterSch === 'sch' ? null : 'sch')} color={C.navy}>Schumacher</FilterChip>
              <FilterChip active={filterSch === '3p'} onClick={() => setFilterSch(filterSch === '3p' ? null : '3p')} color={C.gold}>3rd Party</FilterChip>
              <FilterChip active={filterHighColor} onClick={() => setFilterHighColor(!filterHighColor)} color={C.rose}>High-color 6+</FilterChip>
              <FilterChip active={filterWasteHist} onClick={() => setFilterWasteHist(!filterWasteHist)} color={C.amber}>Waste history</FilterChip>
            </div>
          </div>
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {filteredPool.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: C.inkLight, fontSize: 12 }}>No POs match these filters</div>
            )}
            {filteredPool.map(r => {
              const sel = selectedPO?.po_number === r.po_number
              const isSch = (r.customer_type||'').toLowerCase() === 'schumacher'
              const is3P = (r.customer_type||'').toLowerCase().includes('3rd')
              const highColor = (r.colors_count || 0) >= HIGH_COLOR_THRESHOLD
              const wasteP = hasWasteHistory(r.line_description)
              return (
                <div key={r.id} onClick={() => setSelectedPO(sel ? null : r)}
                  style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', background: sel ? C.goldBg : 'transparent' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: C.inkLight }}>{r.po_number}</span>
                    {isSch && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.navyLight, color: C.navy, fontWeight: 700 }}>SCH</span>}
                    {is3P && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.goldBg, color: C.gold, fontWeight: 700 }}>3P</span>}
                    {highColor && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.roseBg, color: C.rose, fontWeight: 700 }}>{r.colors_count}c</span>}
                    {wasteP && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: C.amberBg, color: C.amber, fontWeight: 700 }}>⚠ WASTE</span>}
                  </div>
                  <div style={{ fontSize: 12, color: C.ink, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>{r.line_description}</div>
                  <div style={{ fontSize: 10, color: C.inkLight, display: 'flex', gap: 8 }}>
                    <span>{r.product_type}</span>
                    <span>·</span>
                    <span>{fmt(r.remaining_yards)} yd remaining{r.assigned_already > 0 ? ` (${fmt(r.assigned_already)} scheduled)` : ''}</span>
                    <span>·</span>
                    <span style={{ color: r.age_days > 90 ? C.rose : C.inkLight, fontWeight: r.age_days > 90 ? 700 : 400 }}>{r.age_days}d</span>
                  </div>
                </div>
              )
            })}
          </div>
          {selectedPO && (
            <div style={{ padding: '10px 14px', background: C.goldBg, borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.ink }}>
              <strong>Selected:</strong> {selectedPO.line_description}<br/>
              <span style={{ color: C.inkMid }}>Click a table to assign {fmt(selectedPO.remaining_yards)} yards (or split in the next step)</span>
            </div>
          )}
        </div>

        {/* TABLE GRID */}
        <div>
          <TableCategoryRow category="grass"     label="Grasscloth" tables={PASSAIC_TABLES.filter(t => t.category === 'grass')}     assignments={enrichedAssignments} selectedPO={selectedPO} onTableClick={handleTableClick} onRemove={removeAssignment} />
          <TableCategoryRow category="fabric"    label="Fabric"     tables={PASSAIC_TABLES.filter(t => t.category === 'fabric')}    assignments={enrichedAssignments} selectedPO={selectedPO} onTableClick={handleTableClick} onRemove={removeAssignment} />
          <TableCategoryRow category="wallpaper" label="Wallpaper"  tables={PASSAIC_TABLES.filter(t => t.category === 'wallpaper')} assignments={enrichedAssignments} selectedPO={selectedPO} onTableClick={handleTableClick} onRemove={removeAssignment} />
        </div>
      </div>

      {assignModal && (
        <AssignModal
          po={assignModal.po} tableCode={assignModal.tableCode} proposed={assignModal.proposed_yards}
          onCancel={() => setAssignModal(null)}
          onConfirm={yards => commitAssignment({ po: assignModal.po, tableCode: assignModal.tableCode, yards })}
          busy={assigning}
        />
      )}
    </div>
  )
}

function MixGauges({ totals }) {
  const yPct = Math.round((totals.yards / PASSAIC_TARGETS.total.yards) * 100)
  const cyPct = Math.round((totals.cy / PASSAIC_TARGETS.total.cy) * 100)
  const rPct = Math.round((totals.revenue / PASSAIC_TARGETS.total.revenue) * 100)
  const mixSch = totals.revenue > 0 ? totals.schumacher_revenue / totals.revenue : 0
  const mix3p = totals.revenue > 0 ? totals.third_party_revenue / totals.revenue : 0
  const mixOnTarget = mixSch >= (MIX_TARGET_SCH - 0.10) && mixSch <= (MIX_TARGET_SCH + 0.10)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
      <Gauge label="Yards" value={totals.yards} target={PASSAIC_TARGETS.total.yards} pct={yPct} unit="yd" />
      <Gauge label="Color-yards" value={totals.cy} target={PASSAIC_TARGETS.total.cy} pct={cyPct} unit="CY" highlight />
      <Gauge label="Revenue" value={totals.revenue} target={PASSAIC_TARGETS.total.revenue} pct={rPct} unit="$" isMoney />
      <MixCard schPct={mixSch * 100} tpPct={mix3p * 100} onTarget={mixOnTarget} avgColors={totals.avg_colors_weighted} />
    </div>
  )
}

function Gauge({ label, value, target, pct, unit, isMoney, highlight }) {
  const col = pct >= 95 ? C.sage : pct >= 75 ? C.gold : pct >= 50 ? C.amber : C.rose
  const bg = highlight ? C.navy : '#fff'
  const fg = highlight ? '#fff' : C.ink
  const subFg = highlight ? 'rgba(255,255,255,0.65)' : C.inkLight
  return (
    <div style={{ background: bg, border: `1px solid ${highlight ? C.navy : C.border}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: subFg, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'Georgia,serif', color: fg }}>
          {isMoney ? fmtK(value) : fmt(value)}
        </span>
        <span style={{ fontSize: 11, color: subFg }}>/ {isMoney ? fmtK(target) : fmt(target)} {!isMoney && unit}</span>
      </div>
      <div style={{ height: 6, background: highlight ? 'rgba(255,255,255,0.15)' : C.warm, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: Math.min(100, pct) + '%', height: '100%', background: col, transition: 'width 0.2s' }} />
      </div>
      <div style={{ fontSize: 10, color: subFg, marginTop: 4 }}>{pct}% of target</div>
    </div>
  )
}

function MixCard({ schPct, tpPct, onTarget, avgColors }) {
  const deltaFromTarget = schPct - MIX_TARGET_SCH * 100
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 6 }}>Customer mix</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'Georgia,serif', color: C.navy }}>Sch {Math.round(schPct)}%</span>
        <span style={{ fontSize: 11, color: C.inkLight }}>·</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'Georgia,serif', color: C.gold }}>3P {Math.round(tpPct)}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: schPct + '%', background: C.navy }} />
        <div style={{ width: tpPct + '%', background: C.gold }} />
      </div>
      <div style={{ fontSize: 10, color: onTarget ? C.sage : C.rose, marginTop: 4, fontWeight: 600 }}>
        {onTarget ? '✓ At target' : `${deltaFromTarget > 0 ? '+' : ''}${Math.round(deltaFromTarget)}pp vs 60/40 target`}
        {avgColors > 0 && <span style={{ color: C.inkLight, fontWeight: 400, marginLeft: 6 }}>· avg {avgColors.toFixed(1)}c</span>}
      </div>
    </div>
  )
}

function CategoryStrip({ totals }) {
  const cats = [
    { key: 'grass',     label: 'Grass',     color: C.sage  },
    { key: 'fabric',    label: 'Fabric',    color: C.amber },
    { key: 'wallpaper', label: 'Wallpaper', color: C.navy  },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      {cats.map(c => {
        const t = totals[c.key]
        const tgt = PASSAIC_TARGETS[c.key]
        const cyPct = Math.round((t.cy / tgt.cy) * 100)
        return (
          <div key={c.key} style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: c.color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{c.label}</span>
              <span style={{ fontSize: 10, color: C.inkLight }}>{tgt.tables} table{tgt.tables !== 1 ? 's' : ''}</span>
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: C.inkMid }}>
              <div>
                <div style={{ fontSize: 9, color: C.inkLight, textTransform: 'uppercase' }}>Yd</div>
                <div style={{ fontWeight: 700, color: C.ink }}>{fmt(t.yards)} <span style={{ color: C.inkLight, fontWeight: 400 }}>/ {fmt(tgt.yards)}</span></div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: C.inkLight, textTransform: 'uppercase' }}>CY</div>
                <div style={{ fontWeight: 700, color: C.ink }}>{fmt(t.cy)} <span style={{ color: C.inkLight, fontWeight: 400 }}>/ {fmt(tgt.cy)} ({cyPct}%)</span></div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: C.inkLight, textTransform: 'uppercase' }}>Rev</div>
                <div style={{ fontWeight: 700, color: C.ink }}>{fmtK(t.revenue)}</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TableCategoryRow({ category, label, tables, assignments, selectedPO, onTableClick, onRemove }) {
  const byTable = useMemo(() => {
    const m = {}
    for (const a of assignments) {
      if (!m[a.table_code]) m[a.table_code] = []
      m[a.table_code].push(a)
    }
    return m
  }, [assignments])

  const canAssign = selectedPO && categoryFitsPO(category, selectedPO)

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.inkMid, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {label} <span style={{ color: C.inkLight, fontWeight: 400 }}>— {tables.length} table{tables.length !== 1 ? 's' : ''}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(tables.length, 6)}, 1fr)`, gap: 8 }}>
        {tables.map(t => {
          const asgs = byTable[t.code] || []
          const cyUsed = asgs.reduce((s, a) => s + Number(a.planned_cy || 0), 0)
          const cyPct = Math.round((cyUsed / t.capacity_cy) * 100)
          const overCap = cyPct > 110
          const highlight = canAssign
          return (
            <div key={t.code}
              onClick={() => canAssign && onTableClick(t.code)}
              style={{
                background: '#fff',
                border: `${highlight ? 2 : 1}px ${highlight ? 'dashed' : 'solid'} ${highlight ? C.navy : overCap ? C.rose : C.border}`,
                borderRadius: 8, padding: 8, minHeight: 140,
                cursor: canAssign ? 'pointer' : 'default',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.ink }}>{t.code}</span>
                <span style={{ fontSize: 9, color: overCap ? C.rose : cyPct > 80 ? C.gold : C.inkLight, fontWeight: 600 }}>{cyPct}%</span>
              </div>
              <div style={{ height: 4, background: C.warm, borderRadius: 2, marginBottom: 8, overflow: 'hidden' }}>
                <div style={{ width: Math.min(100, cyPct) + '%', height: '100%', background: overCap ? C.rose : cyPct > 80 ? C.gold : C.sage }} />
              </div>
              {asgs.map(a => <AssignmentCard key={a.id} a={a} onRemove={() => onRemove(a.id)} />)}
              {asgs.length === 0 && (
                <div style={{ fontSize: 10, color: C.inkLight, textAlign: 'center', padding: '12px 0', fontStyle: 'italic' }}>
                  {canAssign ? 'Click to assign' : 'Empty'}
                </div>
              )}
              <div style={{ fontSize: 9, color: C.inkLight, marginTop: 4 }}>{fmt(cyUsed)} / {fmt(t.capacity_cy)} CY</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function categoryFitsPO(category, po) {
  const pt = (po.product_type || '').toLowerCase()
  if (category === 'grass')     return pt.includes('grass')
  if (category === 'fabric')    return pt.includes('fabric') || pt.includes('strike-off')
  if (category === 'wallpaper') return pt.includes('paper') || pt.includes('panel')
  return false
}

function AssignmentCard({ a, onRemove }) {
  const isSch = (a.customer_type||'').toLowerCase() === 'schumacher'
  const is3P = (a.customer_type||'').toLowerCase().includes('3rd')
  const highColor = (a.colors_count || 0) >= HIGH_COLOR_THRESHOLD
  return (
    <div style={{ background: C.parchment, borderRadius: 4, padding: '5px 7px', marginBottom: 4, fontSize: 10, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
        {isSch && <span style={{ fontSize: 7, padding: '0 3px', borderRadius: 2, background: C.navy, color: '#fff', fontWeight: 700 }}>SCH</span>}
        {is3P && <span style={{ fontSize: 7, padding: '0 3px', borderRadius: 2, background: C.gold, color: '#fff', fontWeight: 700 }}>3P</span>}
        {highColor && <span style={{ fontSize: 7, padding: '0 3px', borderRadius: 2, background: C.rose, color: '#fff', fontWeight: 700 }}>{a.colors_count}c</span>}
        <span style={{ marginLeft: 'auto', cursor: 'pointer', color: C.inkLight, fontSize: 11 }} onClick={onRemove} title="Remove assignment">×</span>
      </div>
      <div style={{ color: C.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.line_description}</div>
      <div style={{ color: C.inkLight, fontSize: 9 }}>{fmt(a.planned_yards)}yd · {fmt(a.planned_cy || 0)} CY</div>
    </div>
  )
}

function FilterChip({ active, onClick, color, children }) {
  return (
    <button onClick={onClick}
      style={{ padding: '3px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer', border: `1px solid ${active ? color : C.border}`, background: active ? color : 'transparent', color: active ? '#fff' : C.inkMid, fontWeight: active ? 700 : 400 }}>
      {children}
    </button>
  )
}

function AssignModal({ po, tableCode, proposed, onCancel, onConfirm, busy }) {
  const [yards, setYards] = useState(proposed)
  const cy = po.colors_count ? po.colors_count * yards : 0
  const maxY = po.remaining_yards
  const invalid = yards < 1 || yards > maxY
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 4 }}>Assign to {tableCode}</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif', marginBottom: 12 }}>{po.line_description}</div>
        <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 16 }}>
          PO: {po.po_number} · {po.product_type} · {po.colors_count || '—'} colors · {fmt(po.remaining_yards)} yards remaining
        </div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginBottom: 4 }}>Yards for this table</label>
        <input type="number" value={yards} onChange={e => setYards(parseInt(e.target.value) || 0)} min={1} max={maxY}
          style={{ width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, boxSizing: 'border-box', marginBottom: 8 }} />
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button onClick={() => setYards(maxY)} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>All ({fmt(maxY)})</button>
          <button onClick={() => setYards(Math.round(maxY / 2))} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>Half ({fmt(Math.round(maxY/2))})</button>
          <button onClick={() => setYards(Math.round(maxY / 3))} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer' }}>Third ({fmt(Math.round(maxY/3))})</button>
        </div>
        <div style={{ padding: '10px 14px', background: C.goldBg, borderRadius: 6, marginBottom: 16, fontSize: 12, color: C.ink }}>
          This assignment: <strong>{fmt(yards)} yards × {po.colors_count || 0} colors = {fmt(cy)} CY</strong>
          {yards < maxY && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 4 }}>Remaining {fmt(maxY - yards)} yards will stay in the pool.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, cursor: 'pointer', color: C.inkMid }}>Cancel</button>
          <button onClick={() => onConfirm(yards)} disabled={invalid || busy}
            style={{ padding: '8px 16px', background: invalid || busy ? C.warm : C.ink, color: invalid || busy ? C.inkLight : '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: invalid || busy ? 'not-allowed' : 'pointer' }}>
            {busy ? 'Assigning…' : 'Confirm assignment'}
          </button>
        </div>
      </div>
    </div>
  )
}
