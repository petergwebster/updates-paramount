import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import styles from './AdminFinancials.module.css'

// ── GL Account Object → category mapping ─────────────────────────────────────
const COGS_MATERIAL  = new Set(['4104','4105'])
const COGS_LABOR     = new Set(['4108','4109'])
const COGS_WIP       = new Set(['4111','4112'])
const COGS_OTHER     = new Set(['4113','4114'])
const SALARY         = new Set(['6115'])
const SALARY_OT      = new Set(['6120','6125'])
const CAPITALIZATION = new Set(['6116'])
const FRINGE         = new Set(['6130','6135','6195'])
const TE             = new Set(['6205','6220','6221','6255','6260','6270','6271'])
const PRINTING       = new Set(['6312'])
const DISTRIBUTION   = new Set(['6405','6410','6415','6430','6435'])
const OFFICE_EDP     = new Set(['6505','6515','6520','6525','6530','6540','6550','6640'])
const CONSULTING     = new Set(['6630'])
const BUILDING       = new Set(['6710'])
const UTILITIES      = new Set(['6715'])
const RENT           = new Set(['6740','6745'])
const INV_PURCHASES  = new Set(['1437'])

function parseGL(rows) {
  // rows: array of arrays (from SheetJS), first row is headers
  // Returns { period, byBU: { '609': {...}, '610': {...}, '612': {...} } }
  const result = { '609': {}, '610': {}, '612': {} }
  const vendors = { '609': {}, '610': {}, '612': {} }
  let period = null

  // Init all fields
  const initBU = () => ({
    cogs_material: 0, cogs_labor: 0, cogs_wip: 0, cogs_other: 0,
    salary: 0, salary_ot: 0, fringe: 0, te: 0, printing: 0,
    distribution: 0, office_edp: 0, consulting: 0, building: 0,
    utilities: 0, rent: 0, capitalization: 0, inv_purchases: 0,
  })
  result['609'] = initBU()
  result['610'] = initBU()
  result['612'] = initBU()

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || !row.some(v => v !== null && v !== undefined && v !== '')) continue

    const obj    = String(row[0] || '').trim()
    const debit  = parseFloat(row[6]) || 0
    const net    = parseFloat(row[8]) || 0
    const bu     = String(row[23] || '').trim()
    const vendor = String(row[14] || '').trim()
    const trxVal = row[2]  // TRX Date

    // Detect period from transaction date
    if (!period && trxVal) {
      let d = null
      if (typeof trxVal === 'number') {
        // Excel serial date
        const date = new Date(Math.round((trxVal - 25569) * 86400 * 1000))
        d = date
      } else if (trxVal instanceof Date) {
        d = trxVal
      } else if (typeof trxVal === 'string' && trxVal.includes('DATE')) {
        // =DATE(2026,2,28) formula — extract year/month
        const m = trxVal.match(/DATE\((\d+),(\d+)/)
        if (m) period = `${m[1]}-${String(m[2]).padStart(2,'0')}`
      }
      if (d && !period) {
        period = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
      }
    }

    if (!['609','610','612'].includes(bu)) continue

    const r = result[bu]
    if      (COGS_MATERIAL.has(obj))  r.cogs_material  += net
    else if (COGS_LABOR.has(obj))     r.cogs_labor     += net
    else if (COGS_WIP.has(obj))       r.cogs_wip       += net
    else if (COGS_OTHER.has(obj))     r.cogs_other     += net
    else if (SALARY.has(obj))         r.salary         += net
    else if (SALARY_OT.has(obj))      r.salary_ot      += net
    else if (CAPITALIZATION.has(obj)) r.capitalization += net
    else if (FRINGE.has(obj))         r.fringe         += net
    else if (TE.has(obj))             r.te             += net
    else if (PRINTING.has(obj))       r.printing       += net
    else if (DISTRIBUTION.has(obj))   r.distribution   += net
    else if (OFFICE_EDP.has(obj))     r.office_edp     += net
    else if (CONSULTING.has(obj))     r.consulting     += net
    else if (BUILDING.has(obj))       r.building       += net
    else if (UTILITIES.has(obj))      r.utilities      += net
    else if (RENT.has(obj))           r.rent           += net
    else if (INV_PURCHASES.has(obj)) {
      r.inv_purchases += debit
      if (vendor) vendors[bu][vendor] = (vendors[bu][vendor] || 0) + debit
    }
  }

  // Round all values and build vendor arrays
  const byBU = {}
  for (const bu of ['609','610','612']) {
    const r = result[bu]
    Object.keys(r).forEach(k => { r[k] = Math.round(r[k] * 100) / 100 })
    byBU[bu] = {
      ...r,
      inv_vendors: Object.entries(vendors[bu])
        .sort((a,b) => b[1]-a[1])
        .slice(0, 10)
        .map(([name, amount]) => ({ name, amount: Math.round(amount) }))
    }
  }

  return { period, byBU }
}

function fmtD(v) {
  if (!v && v !== 0) return '—'
  const abs = Math.abs(Math.round(v))
  return (v < 0 ? '-$' : '$') + abs.toLocaleString()
}

export default function AdminFinancials() {
  const [status, setStatus]           = useState(null) // 'parsing' | 'preview' | 'saving' | 'saved' | 'error'
  const [parseResult, setParseResult] = useState(null) // { period, byBU }
  const [existing, setExisting]       = useState(null) // prior DB rows for this period
  const [notes, setNotes]             = useState('')
  const [dragging, setDragging]       = useState(false)
  const [history, setHistory]         = useState([])
  const fileRef = useRef(null)

  useEffect(() => { loadHistory() }, [])

  async function loadHistory() {
    const { data } = await supabase
      .from('financials_monthly')
      .select('period, business_unit, uploaded_at, cogs_total, opex_total, inv_purchases')
      .order('period', { ascending: false })
      .order('business_unit')
      .limit(30)
    setHistory(data || [])
  }

  async function processFile(file) {
    setStatus('parsing')
    setParseResult(null)
    setExisting(null)
    try {
      const XLSX = window.XLSX
      if (!XLSX) throw new Error('SheetJS not loaded — check index.html CDN script')
      const ab = await file.arrayBuffer()
      const wb = XLSX.read(ab, { type: 'array' })
      const sheetName = wb.SheetNames[0]
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null })
      const parsed = parseGL(rows)
      if (!parsed.period) throw new Error('Could not detect period from file dates')
      setParseResult(parsed)

      // Check if we already have data for this month
      const { data: prior } = await supabase
        .from('financials_monthly')
        .select('*')
        .eq('period', parsed.period)
      setExisting(prior || [])
      setStatus('preview')
    } catch (e) {
      console.error(e)
      setStatus('error')
    }
  }

  async function handleSave() {
    if (!parseResult) return
    setStatus('saving')
    const { period, byBU } = parseResult
    const now = new Date().toISOString()
    const upserts = ['609','610','612'].map(bu => ({
      period,
      business_unit: bu,
      ...byBU[bu],
      upload_notes: notes || null,
      uploaded_at: now,
    }))
    const { error } = await supabase
      .from('financials_monthly')
      .upsert(upserts, { onConflict: 'period,business_unit' })
    if (error) { console.error(error); setStatus('error'); return }
    setStatus('saved')
    setParseResult(null)
    setNotes('')
    loadHistory()
    setTimeout(() => setStatus(null), 3000)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }

  const priorByBU = bu => existing?.find(r => r.business_unit === bu)

  const BU_LABELS = { '609': 'BNY Brooklyn', '610': 'Passaic NJ', '612': 'Shared' }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Financial Data Upload</h3>
          <p className={styles.sub}>Upload the weekly GP purchase report — cumulative MTD. Each upload replaces the current month's data.</p>
        </div>
      </div>

      {/* Drop zone */}
      {!parseResult && status !== 'saved' && (
        <div
          className={`${styles.dropZone} ${dragging ? styles.dropZoneDragging : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
        >
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => e.target.files[0] && processFile(e.target.files[0])} />
          {status === 'parsing'
            ? <span className={styles.dropMsg}>Parsing GL file…</span>
            : status === 'error'
            ? <span className={styles.dropMsgError}>Parse failed — check file format. Click to retry.</span>
            : <><span className={styles.dropIcon}>📊</span><span className={styles.dropMsg}>Drop GP purchase report here or click to browse</span><span className={styles.dropHint}>.xlsx · .xls · .csv</span></>
          }
        </div>
      )}

      {/* Preview */}
      {status === 'preview' && parseResult && (
        <div className={styles.preview}>
          <div className={styles.previewHeader}>
            <div>
              <span className={styles.periodBadge}>{parseResult.period}</span>
              {existing && existing.length > 0 && (
                <span className={styles.replaceBadge}>Replaces existing upload — will show delta vs prior</span>
              )}
            </div>
            <div className={styles.previewActions}>
              <button onClick={() => { setParseResult(null); setStatus(null) }}>Cancel</button>
              <button className="primary" onClick={handleSave} disabled={status === 'saving'}>
                {status === 'saving' ? 'Saving…' : 'Save to Dashboard'}
              </button>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label className={styles.notesLabel}>Upload notes (optional)</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Week 3 of 4 — through 3/22" className={styles.notesInput} />
          </div>

          <div className={styles.previewGrid}>
            {['609','610','612'].map(bu => {
              const d = parseResult.byBU[bu]
              const prior = priorByBU(bu)
              const cogsTotal = d.cogs_material + d.cogs_labor + d.cogs_wip + d.cogs_other
              const opexTotal = d.salary + d.salary_ot + d.fringe + d.te + d.printing +
                d.distribution + d.office_edp + d.consulting + d.building + d.utilities + d.rent
              const priorCogs  = prior ? parseFloat(prior.cogs_total || 0) : null
              const priorOpex  = prior ? parseFloat(prior.opex_total || 0) : null
              const cogsWkDelta = priorCogs !== null ? cogsTotal - priorCogs : null
              const opexWkDelta = priorOpex !== null ? opexTotal - priorOpex : null

              return (
                <div key={bu} className={styles.previewCard}>
                  <div className={styles.previewCardTitle}>{BU_LABELS[bu]}</div>

                  <div className={styles.previewSection}>COGS</div>
                  <div className={styles.previewRow}><span>Material</span><strong>{fmtD(d.cogs_material)}</strong></div>
                  <div className={styles.previewRow}><span>Labor</span><strong>{fmtD(d.cogs_labor)}</strong></div>
                  <div className={styles.previewRow}><span>WIP</span><strong>{fmtD(d.cogs_wip)}</strong></div>
                  <div className={styles.previewRow}><span>Other</span><strong>{fmtD(d.cogs_other)}</strong></div>
                  <div className={`${styles.previewRow} ${styles.previewTotal}`}>
                    <span>COGS Total</span>
                    <strong>{fmtD(cogsTotal)}</strong>
                    {cogsWkDelta !== null && <span className={styles.delta}>+{fmtD(cogsWkDelta)} this wk</span>}
                  </div>

                  <div className={styles.previewSection} style={{ marginTop: 8 }}>Operating Expenses</div>
                  <div className={styles.previewRow}><span>Salaries</span><strong>{fmtD(d.salary)}</strong></div>
                  <div className={styles.previewRow}><span>OT / Temp</span><strong>{fmtD(d.salary_ot)}</strong></div>
                  <div className={styles.previewRow}><span>Fringe / Benefits</span><strong>{fmtD(d.fringe)}</strong></div>
                  <div className={styles.previewRow}><span>T&amp;E</span><strong>{fmtD(d.te)}</strong></div>
                  {d.printing > 0 && <div className={styles.previewRow}><span>Printing / Consumables</span><strong>{fmtD(d.printing)}</strong></div>}
                  <div className={styles.previewRow}><span>Distribution</span><strong>{fmtD(d.distribution)}</strong></div>
                  <div className={styles.previewRow}><span>Office / EDP</span><strong>{fmtD(d.office_edp)}</strong></div>
                  {d.consulting > 0 && <div className={styles.previewRow}><span>Consulting</span><strong>{fmtD(d.consulting)}</strong></div>}
                  <div className={styles.previewRow}><span>Utilities</span><strong>{fmtD(d.utilities)}</strong></div>
                  <div className={styles.previewRow}><span>Rent</span><strong>{fmtD(d.rent)}</strong></div>
                  <div className={`${styles.previewRow} ${styles.previewTotal}`}>
                    <span>OpEx Total</span>
                    <strong>{fmtD(opexTotal)}</strong>
                    {opexWkDelta !== null && <span className={styles.delta}>+{fmtD(opexWkDelta)} this wk</span>}
                  </div>
                  <div className={styles.previewRow} style={{ color: 'var(--ink-60)', fontSize: 11 }}>
                    <span>Capitalization (contra)</span><strong>{fmtD(d.capitalization)}</strong>
                  </div>

                  {d.inv_purchases > 0 && (<>
                    <div className={styles.previewSection} style={{ marginTop: 8 }}>Inventory Purchases</div>
                    <div className={`${styles.previewRow} ${styles.previewTotal}`}>
                      <span>Total</span><strong>{fmtD(d.inv_purchases)}</strong>
                    </div>
                    {d.inv_vendors.slice(0,4).map((v,i) => (
                      <div key={i} className={styles.previewRow} style={{ fontSize: 11 }}>
                        <span className={styles.vendorName}>{v.name.replace(/ - FOR (PARAMOUNT|BNY)/i,'')}</span>
                        <strong>{fmtD(v.amount)}</strong>
                      </div>
                    ))}
                  </>)}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {status === 'saved' && (
        <div className={styles.savedMsg}>✓ Financial data saved to dashboard</div>
      )}

      {/* Upload history */}
      {history.length > 0 && (
        <div className={styles.history}>
          <div className={styles.historyTitle}>Previous uploads</div>
          <table className={styles.histTable}>
            <thead>
              <tr><th>Period</th><th>BU</th><th>COGS</th><th>OpEx</th><th>Inv Purchases</th><th>Uploaded</th></tr>
            </thead>
            <tbody>
              {history.map((r, i) => (
                <tr key={i}>
                  <td>{r.period}</td>
                  <td>{BU_LABELS[r.business_unit] || r.business_unit}</td>
                  <td>{fmtD(r.cogs_total)}</td>
                  <td>{fmtD(r.opex_total)}</td>
                  <td>{fmtD(r.inv_purchases)}</td>
                  <td style={{ fontSize: 11, color: 'var(--ink-60)' }}>
                    {new Date(r.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
