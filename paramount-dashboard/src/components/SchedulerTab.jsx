import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { parseLiftWorkbook } from '../liftParser'
import { C, SITES, isoDate, defaultSchedulerWeek } from '../lib/scheduleUtils'
import PassaicScheduler from './PassaicScheduler'
import BNYScheduler from './BNYScheduler'

// ═══════════════════════════════════════════════════════════════════════════
// SchedulerTab — schedule grid orchestrator
//
// Stripped-down responsibility (Push A, May 2026 restructure):
//   • Site pill (Passaic / BNY)
//   • LIFT WIP upload (snapshot management — moves to WIP tab in a later push)
//   • Routes to PassaicScheduler / BNYScheduler for the weekly schedule grid
//
// WIP-list and New-Goods views previously lived here. They now live in the
// WIP tab. Procurement was a WIP-list-only site here and has been dropped
// from the site pill — it's pass-through, not scheduled.
// ═══════════════════════════════════════════════════════════════════════════

// Filter scheduleUtils' SITES down to the two that actually get scheduled.
// Procurement is pass-through (no scheduling) and now lives in the WIP tab.
const SCHEDULER_SITES = SITES.filter(s => s.key === 'passaic' || s.key === 'bny')

export default function SchedulerTab() {
  const [site, setSite] = useState('passaic')
  const [snapshot, setSnapshot] = useState(null)
  const [wipRows, setWipRows] = useState([])
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

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {SCHEDULER_SITES.map(s => {
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

      {snapshot && !loading && site === 'passaic' && (
        <PassaicScheduler
          wipRows={wipRows}
          assignments={assignments}
          weekStart={weekStart}
          onWeekChange={setWeekStart}
          onAssignmentsChange={reloadAssignments}
        />
      )}

      {snapshot && !loading && site === 'bny' && (
        <BNYScheduler
          wipRows={wipRows}
          assignments={assignments}
          weekStart={weekStart}
          onWeekChange={setWeekStart}
          onAssignmentsChange={reloadAssignments}
        />
      )}
    </div>
  )
}
