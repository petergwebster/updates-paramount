import { useState, useRef } from 'react'
import { supabase } from '../supabase'
import styles from './AdminPeople.module.css'

// Requires in index.html:
// <script src="https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js"></script>
// <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>

export default function AdminPeople({ weekStart, currentUser, onSaved }) {
  const [payrollFile, setPayrollFile]   = useState(null)
  const [hrFile, setHrFile]             = useState(null)
  const [parsed, setParsed]             = useState(null)
  const [hrSummary, setHrSummary]       = useState(null)
  const [status, setStatus]             = useState('')
  const [saving, setSaving]             = useState(false)
  const [parsingPayroll, setParsingPayroll] = useState(false)
  const [parsingHR, setParsingHR]       = useState(false)

  const payrollRef = useRef(null)
  const hrRef      = useRef(null)

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
      const buf  = await file.arrayBuffer()
      const wb   = window.XLSX.read(buf, { type: 'array' })
      const ws   = wb.Sheets[wb.SheetNames[0]]
      const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
      const result = parsePayrollRows(rows)
      setParsed(result)
      setStatus('Payroll parsed successfully.')
    } catch (err) {
      console.error(err)
      setStatus('Error parsing payroll file: ' + err.message)
    }
    setParsingPayroll(false)
  }

  /* ── Extract text from PPTX using JSZip, then send to Claude ── */
  async function handleHrFile(file) {
    if (!file) return
    setHrFile(file)
    setParsingHR(true)
    setStatus('Reading HR deck…')

    try {
      // Step 1: unzip the PPTX and pull text from each slide XML
      const pptxText = await extractPptxText(file)
      if (!pptxText) throw new Error('Could not extract text from PPTX')

      setStatus('Sending to AI for summary…')

      // Step 2: send extracted text to Claude
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

      const data = await resp.json()
      const text = (data.content || []).map(b => b.text || '').join('')
      const clean = text.replace(/```json|```/g, '').trim()
      const hrData = JSON.parse(clean)
      setHrSummary(hrData)
      setStatus('HR deck parsed successfully.')
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
      week_start: weekStart,
      updated_at: new Date().toISOString(),
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
      onSaved && onSaved()
    }
    setSaving(false)
  }

  const canSave = (parsed || hrSummary) && !saving

  return (
    <div className={styles.wrap}>
      <h3 className={styles.heading}>People at Paramount – Upload</h3>

      <div className={styles.uploadRow}>

        {/* Payroll xlsx */}
        <div className={styles.uploadCard}>
          <p className={styles.uploadLabel}>Weekly payroll (.xlsx)</p>
          <div
            className={styles.dropZone}
            onClick={() => payrollRef.current.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handlePayrollFile(e.dataTransfer.files[0]) }}
          >
            {payrollFile
              ? <span className={styles.fileName}>{payrollFile.name}</span>
              : <span>Drop file here or click to browse</span>
            }
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
        </div>

        {/* HR deck pptx */}
        <div className={styles.uploadCard}>
          <p className={styles.uploadLabel}>HR people update (.pptx)</p>
          <div
            className={styles.dropZone}
            onClick={() => hrRef.current.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleHrFile(e.dataTransfer.files[0]) }}
          >
            {hrFile
              ? <span className={styles.fileName}>{hrFile.name}</span>
              : <span>Drop file here or click to browse</span>
            }
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
        </div>
      </div>

      {status && (
        <p className={`${styles.statusText} ${status.startsWith('Error') ? styles.statusError : ''}`}>
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

/* ──────────────────────────────────────────────────────────
   Extract text from PPTX by unzipping and parsing slide XML.
   PPTX files are zip archives — each slide is an XML file
   at ppt/slides/slide1.xml, slide2.xml, etc.
   We use JSZip (loaded via CDN) to unzip in the browser.
────────────────────────────────────────────────────────── */
async function extractPptxText(file) {
  if (typeof window.JSZip === 'undefined') {
    throw new Error('JSZip not loaded — add the JSZip script tag to index.html')
  }

  const buf  = await file.arrayBuffer()
  const zip  = await window.JSZip.loadAsync(buf)
  const slideFiles = Object.keys(zip.files)
    .filter(name => name.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)[0])
      const nb = parseInt(b.match(/\d+/)[0])
      return na - nb
    })

  const slideTexts = []
  for (const name of slideFiles) {
    const xml  = await zip.files[name].async('string')
    // Strip XML tags and extract text content
    const text = xml
      .replace(/<a:t>/g, ' ')         // mark text node opens
      .replace(/<\/a:t>/g, '\n')      // newline after each text run
      .replace(/<[^>]+>/g, '')        // strip all remaining tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#xD;/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .join('\n')

    const slideNum = name.match(/\d+/)[0]
    slideTexts.push(`--- Slide ${slideNum} ---\n${text}`)
  }

  return slideTexts.join('\n\n')
}

/* ──────────────────────────────────────────────────────────
   Payroll parser — Earnings Pay Detail xlsx format
────────────────────────────────────────────────────────── */
function parsePayrollRows(rows) {
  const employees = []
  let currentLocation = null

  for (const row of rows) {
    if (!row || row.every(v => v == null)) continue

    if (row[1] && typeof row[1] === 'string' && row[1].trim() && row[2] !== 'Total') {
      currentLocation = row[1].trim()
    }

    const name = row[2]
    if (!name || name === 'Total' || typeof name !== 'string') continue

    const num = v => (v == null || v === '' ? 0 : parseFloat(v) || 0)

    const otHrs    = num(row[16])
    const ptoHrs   = num(row[18])
    const bonusAmt = num(row[9])
    const totalHrs = num(row[22])
    const totalPay = num(row[21])

    const flags = []
    if (otHrs > 0)                     flags.push('OT')
    if (ptoHrs > 0)                    flags.push('PTO')
    if (bonusAmt > 0)                  flags.push('bonus')
    if (totalHrs < 40 && ptoHrs === 0) flags.push('under40')

    const isBny = currentLocation && (currentLocation.trim() === 'BNY' || currentLocation.trim() === 'BNY   ')

    employees.push({
      name:        name.trim(),
      title:       row[3] ? String(row[3]).trim() : '',
      location:    isBny ? 'BNY' : 'NJ',
      salary:      num(row[5]),
      is_salaried: totalHrs === 80,
      bonus_amt:   bonusAmt,
      ot_amt:      num(row[15]),
      ot_hrs:      otHrs,
      pto_amt:     num(row[17]),
      pto_hrs:     ptoHrs,
      reg_amt:     num(row[19]),
      reg_hrs:     num(row[20]),
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
