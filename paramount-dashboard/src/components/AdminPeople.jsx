import { useState, useRef, useEffect } from 'react'
import { supabase } from '../supabase'
import styles from './AdminPeople.module.css'

export default function AdminPeople({ weekStart, currentUser, onSaved }) {
  const [payrollFile, setPayrollFile]       = useState(null)
  const [hrFile, setHrFile]                 = useState(null)
  const [parsed, setParsed]                 = useState(null)
  const [hrSummary, setHrSummary]           = useState(null)
  const [existing, setExisting]             = useState(null)  // current saved data for this week
  const [status, setStatus]                 = useState('')
  const [saving, setSaving]                 = useState(false)
  const [parsingPayroll, setParsingPayroll] = useState(false)
  const [parsingHR, setParsingHR]           = useState(false)

  const payrollRef = useRef(null)
  const hrRef      = useRef(null)

  /* ── Load existing saved data for this week on mount / week change ── */
  useEffect(() => {
    if (!weekStart) return
    loadExisting()
  }, [weekStart])

  async function loadExisting() {
    const { data } = await supabase
      .from('people_weekly')
      .select('*')
      .eq('week_start', weekStart)
      .maybeSingle()
    setExisting(data || null)
  }

  /* ── Parse payroll xlsx via SheetJS ── */
  async function handlePayrollFile(file) {
    if (!file) return
    setPayrollFile(file)

    if (typeof window.XLSX === 'undefined') {
      setStatus('SheetJS not loaded — make sure the SheetJS script tag is in index.html.')
      return
    }

    setParsingPayroll(true)
    setStatus('Parsing payroll file…')
    try {
      const buf    = await file.arrayBuffer()
      const wb     = window.XLSX.read(buf, { type: 'array' })
      const ws     = wb.Sheets[wb.SheetNames[0]]
      const rows   = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
      const result = parsePayrollRows(rows)
      setParsed(result)
      setStatus('Payroll parsed — review below then save.')
    } catch (err) {
      console.error(err)
      setStatus('Error parsing payroll file: ' + err.message)
    }
    setParsingPayroll(false)
  }

  /* ── Extract PPTX text via JSZip, send to Claude ── */
  async function handleHrFile(file) {
    if (!file) return
    setHrFile(file)
    setParsingHR(true)
    setStatus('Reading HR deck…')

    try {
      const pptxText = await extractPptxText(file)
      if (!pptxText) throw new Error('Could not extract text from PPTX')

      setStatus('Sending to AI for summary…')

      const resp = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `You are extracting structured HR data from a PowerPoint slide deck for Paramount Prints.

Here is the text extracted from the slides:

${pptxText}

Return ONLY valid JSON with no preamble, explanation, or markdown code fences. Use exactly this structure:
{
  "new_hires_bny": 0,
  "new_hires_nj": 0,
  "exits_bny": 0,
  "exits_nj": 0,
  "leaves": [
    { "name": "Last, First", "since": "Mon DD" }
  ],
  "open_roles": [
    { "role": "Role title", "status": "Screening", "notes": "optional notes" }
  ],
  "hr_notes": "Any other notable updates as a single plain text paragraph including events or announcements."
}`
          }]
        })
      })

      const data  = await resp.json()
      const text  = (data.content || []).map(b => b.text || '').join('')
      const clean = text.replace(/```json|```/g, '').trim()
      const hrData = JSON.parse(clean)
      setHrSummary(hrData)
      setStatus('HR deck parsed — review below then save.')
    } catch (err) {
      console.error(err)
      setStatus('Error parsing HR deck: ' + err.message)
    }
    setParsingHR(false)
  }

  /* ── Save to Supabase ── */
  async function handleSave() {
    if (!parsed && !hrSummary) {
      setStatus('Upload at least one file before saving.')
      return
    }
    setSaving(true)
    setStatus('Saving…')

    const payload = {
      week_start:  weekStart,
      updated_at:  new Date().toISOString(),
      ...(parsed && {
        bny_headcount:   parsed.bny.headcount,
        bny_total_hrs:   parsed.bny.total_hrs,
        bny_reg_hrs:     parsed.bny.reg_hrs,
        bny_ot_hrs:      parsed.bny.ot_hrs,
        bny_pto_hrs:     parsed.bny.pto_hrs,
        bny_total_pay:   parsed.bny.total_pay,
        bny_bonus_total: parsed.bny.bonus_total,
        nj_headcount:    parsed.nj.headcount,
        nj_total_hrs:    parsed.nj.total_hrs,
        nj_reg_hrs:      parsed.nj.reg_hrs,
        nj_ot_hrs:       parsed.nj.ot_hrs,
        nj_pto_hrs:      parsed.nj.pto_hrs,
        nj_total_pay:    parsed.nj.total_pay,
        nj_bonus_total:  parsed.nj.bonus_total,
        employees:       parsed.employees,
      }),
      ...(hrSummary && {
        new_hires_bny: hrSummary.new_hires_bny,
        new_hires_nj:  hrSummary.new_hires_nj,
        exits_bny:     hrSummary.exits_bny,
        exits_nj:      hrSummary.exits_nj,
        leaves:        hrSummary.leaves,
        open_roles:    hrSummary.open_roles,
        hr_notes:      hrSummary.hr_notes,
      })
    }

    const { error } = await supabase
      .from('people_weekly')
      .upsert(payload, { onConflict: 'week_start' })

    if (error) {
      console.error(error)
      setStatus('Error saving: ' + error.message)
    } else {
      setStatus('Saved successfully.')
      await loadExisting()
      onSaved && onSaved()
    }
    setSaving(false)
  }

  const canSave = (parsed || hrSummary) && !saving
  const fmt = n => Number(n || 0).toFixed(1)
  const fmtD = n => '$' + Math.round(n || 0).toLocaleString()

  return (
    <div className={styles.wrap}>
      <h3 className={styles.heading}>People at Paramount – Upload</h3>

      {/* ── Existing saved data summary ── */}
      {existing && (
        <div className={styles.existingBanner}>
          <div className={styles.existingLabel}>
            Currently saved for week of {new Date(weekStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
          <div className={styles.existingStats}>
            {existing.bny_headcount != null && (
              <>
                <span className={styles.existingStat}>
                  <strong>BNY</strong> {existing.bny_headcount} emp · {fmt(existing.bny_total_hrs)} hrs · {fmtD(existing.bny_total_pay)}
                </span>
                <span className={styles.existingDivider}>·</span>
                <span className={styles.existingStat}>
                  <strong>Passaic</strong> {existing.nj_headcount} emp · {fmt(existing.nj_total_hrs)} hrs · {fmtD(existing.nj_total_pay)}
                </span>
              </>
            )}
            {existing.leaves != null && (
              <>
                <span className={styles.existingDivider}>·</span>
                <span className={styles.existingStat}>
                  {existing.leaves?.length || 0} leaves · {existing.open_roles?.length || 0} open roles
                </span>
              </>
            )}
          </div>
          <p className={styles.existingHint}>Drop new files below to update this week's data.</p>
        </div>
      )}

      <div className={styles.uploadRow}>

        {/* Payroll xlsx */}
        <div className={styles.uploadCard}>
          <p className={styles.uploadLabel}>Weekly payroll (.xlsx)</p>
          <div
            className={`${styles.dropZone} ${payrollFile ? styles.dropZoneLoaded : ''}`}
            onClick={() => payrollRef.current.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handlePayrollFile(e.dataTransfer.files[0]) }}
          >
            {payrollFile ? (
              <div className={styles.fileConfirm}>
                <span className={styles.fileIcon}>✓</span>
                <span className={styles.fileName}>{payrollFile.name}</span>
              </div>
            ) : (
              <span>Drop file here or click to browse</span>
            )}
          </div>
          <input
            ref={payrollRef}
            type="file"
            accept=".xlsx"
            style={{ display: 'none' }}
            onChange={e => handlePayrollFile(e.target.files[0])}
          />
          {parsingPayroll && <p className={styles.statusText}>Parsing…</p>}
          {parsed && !parsingPayroll && (
            <div className={styles.parsedSummary}>
              <span className={styles.parsedBadge}>BNY {parsed.bny.headcount} emp · {parsed.bny.total_hrs.toFixed(1)} hrs</span>
              <span className={styles.parsedBadge}>NJ {parsed.nj.headcount} emp · {parsed.nj.total_hrs.toFixed(1)} hrs</span>
            </div>
          )}
          {/* Show existing payroll snapshot if no new file uploaded yet */}
          {!parsed && !parsingPayroll && existing?.bny_headcount != null && (
            <div className={styles.parsedSummary}>
              <span className={styles.parsedBadgeExisting}>Saved: BNY {existing.bny_headcount} emp</span>
              <span className={styles.parsedBadgeExisting}>NJ {existing.nj_headcount} emp</span>
            </div>
          )}
        </div>

        {/* HR deck pptx */}
        <div className={styles.uploadCard}>
          <p className={styles.uploadLabel}>HR people update (.pptx)</p>
          <div
            className={`${styles.dropZone} ${hrFile ? styles.dropZoneLoaded : ''}`}
            onClick={() => hrRef.current.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleHrFile(e.dataTransfer.files[0]) }}
          >
            {hrFile ? (
              <div className={styles.fileConfirm}>
                <span className={styles.fileIcon}>✓</span>
                <span className={styles.fileName}>{hrFile.name}</span>
              </div>
            ) : (
              <span>Drop file here or click to browse</span>
            )}
          </div>
          <input
            ref={hrRef}
            type="file"
            accept=".pptx"
            style={{ display: 'none' }}
            onChange={e => handleHrFile(e.target.files[0])}
          />
          {parsingHR && <p className={styles.statusText}>AI summarizing…</p>}
          {hrSummary && !parsingHR && (
            <div className={styles.parsedSummary}>
              <span className={styles.parsedBadge}>{hrSummary.leaves?.length || 0} leaves</span>
              <span className={styles.parsedBadge}>{hrSummary.open_roles?.length || 0} open roles</span>
              <span className={styles.parsedBadge}>{(hrSummary.new_hires_bny || 0) + (hrSummary.new_hires_nj || 0)} new hires</span>
            </div>
          )}
          {/* Show existing HR snapshot if no new file uploaded yet */}
          {!hrSummary && !parsingHR && existing?.leaves != null && (
            <div className={styles.parsedSummary}>
              <span className={styles.parsedBadgeExisting}>Saved: {existing.leaves?.length || 0} leaves</span>
              <span className={styles.parsedBadgeExisting}>{existing.open_roles?.length || 0} open roles</span>
            </div>
          )}
        </div>
      </div>

      {status && (
        <p className={`${styles.statusText} ${status.startsWith('Error') ? styles.statusError : status.startsWith('Saved') ? styles.statusSuccess : ''}`}>
          {status}
        </p>
      )}

      <button
        className={styles.saveBtn}
        onClick={handleSave}
        disabled={!canSave}
      >
        {saving ? 'Saving…' : 'Save to dashboard'}
      </button>
    </div>
  )
}

/* ── Extract text from PPTX via JSZip ── */
async function extractPptxText(file) {
  if (typeof window.JSZip === 'undefined') {
    throw new Error('JSZip not loaded — add the JSZip script tag to index.html')
  }
  const buf  = await file.arrayBuffer()
  const zip  = await window.JSZip.loadAsync(buf)
  const slideFiles = Object.keys(zip.files)
    .filter(name => name.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))

  const slideTexts = []
  for (const name of slideFiles) {
    const xml  = await zip.files[name].async('string')
    const text = xml
      .replace(/<a:t>/g, ' ')
      .replace(/<\/a:t>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#xD;/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n')
    slideTexts.push(`--- Slide ${name.match(/\d+/)[0]} ---\n${text}`)
  }
  return slideTexts.join('\n\n')
}

/* ── Payroll parser ── */
/* New format (April 2026+): single sheet, location split via column F "Org Level 2"
 *   idx 0: Company            idx 1: Employee Name
 *   idx 2: Period Control Date idx 3: Employee Number
 *   idx 4: Org Level 1        idx 5: Org Level 2  ← "Paramount" | "Brooklyn Navy Yards" | "Paramount Prints - HQ"
 *   idx 6: GTL Amt   idx 7: GTL Hrs    idx 8: MEDL Amt   idx 9: MEDL Hrs
 *   idx 10: OT Amt   idx 11: OT Hrs    idx 12: PTO Amt   idx 13: PTO Hrs
 *   idx 14: REG Amt  idx 15: REG Hrs   idx 16: Total Amt  idx 17: Total Hrs
 */
function parsePayrollRows(rows) {
  const employees = []

  for (const row of rows) {
    if (!row || row.every(v => v == null)) continue

    const name = row[1]
    if (!name || typeof name !== 'string') continue
    const trimName = name.trim()
    if (!trimName || trimName === 'Total' || trimName === 'Employee Name') continue

    const orgLevel2 = row[5] ? String(row[5]).trim().toLowerCase() : ''
    // Skip header rows and total rows
    if (orgLevel2 === 'org level 2' || orgLevel2 === '') continue

    const isBny = orgLevel2.includes('brooklyn') || orgLevel2.includes('bny')
    // "Paramount Prints - HQ" goes to NJ bucket (admin/HQ staff)
    // "Paramount" goes to NJ bucket

    const num = v => (v == null || v === '' ? 0 : parseFloat(v) || 0)
    const otAmt    = num(row[10])
    const otHrs    = num(row[11])
    const ptoAmt   = num(row[12])
    const ptoHrs   = num(row[13])
    const regAmt   = num(row[14])
    const regHrs   = num(row[15])
    const totalPay = num(row[16])
    const totalHrs = num(row[17])
    const gtlAmt   = num(row[6])

    const flags = []
    if (otHrs > 0)                     flags.push('OT')
    if (ptoHrs > 0)                    flags.push('PTO')
    if (totalHrs < 40 && ptoHrs === 0) flags.push('under40')

    employees.push({
      name:        trimName,
      title:       '',
      location:    isBny ? 'BNY' : 'NJ',
      salary:      0,
      is_salaried: totalHrs === 80,
      bonus_amt:   0,
      ot_amt:      otAmt,
      ot_hrs:      otHrs,
      pto_amt:     ptoAmt,
      pto_hrs:     ptoHrs,
      reg_amt:     regAmt,
      reg_hrs:     regHrs,
      total_hrs:   totalHrs,
      total_pay:   totalPay,
      flags,
    })
  }

  const bnyEmps = employees.filter(e => e.location === 'BNY')
  const njEmps  = employees.filter(e => e.location === 'NJ')
  const sum = (arr, key) => arr.reduce((acc, e) => acc + (e[key] || 0), 0)

  return {
    employees,
    bny: {
      headcount:   bnyEmps.length,
      total_hrs:   sum(bnyEmps, 'total_hrs'),
      reg_hrs:     sum(bnyEmps, 'reg_hrs'),
      ot_hrs:      sum(bnyEmps, 'ot_hrs'),
      pto_hrs:     sum(bnyEmps, 'pto_hrs'),
      total_pay:   sum(bnyEmps, 'total_pay'),
      bonus_total: sum(bnyEmps, 'bonus_amt'),
    },
    nj: {
      headcount:   njEmps.length,
      total_hrs:   sum(njEmps, 'total_hrs'),
      reg_hrs:     sum(njEmps, 'reg_hrs'),
      ot_hrs:      sum(njEmps, 'ot_hrs'),
      pto_hrs:     sum(njEmps, 'pto_hrs'),
      total_pay:   sum(njEmps, 'total_pay'),
      bonus_total: sum(njEmps, 'bonus_amt'),
    }
  }
}
