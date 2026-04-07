import React, { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import { getFiscalInfo } from '../fiscalCalendar'
import AdminFinancials from './AdminFinancials'
import styles from './AdminPanel.module.css'

// ── KPI definitions ──────────────────────────────────────────────────────────
const KPIS = [
  { id: 'financial', name: 'Financial Contribution', desc: 'Cash contribution, margin discipline, revenue vs. target', target: 'Topline grow 10% in 2027' },
  { id: 'cost', name: 'Cost Efficiency', desc: 'Cost per yard, cost per color yard, improvement vs. prior period', target: 'Avg cost/yard reduced ~$1 across categories' },
  { id: 'inventory', name: 'Inventory Management', desc: 'Availability across grounds, slow-moving stock, obsolete inventory', target: 'Inventory stability across all grounds' },
  { id: 'quality', name: 'Quality & Waste', desc: 'Production waste %, reprints, write-offs, QA consistency', target: 'Waste <8%, continued QA improvement' },
  { id: 'delivery', name: 'Delivery Performance', desc: 'End-to-end lead times, WIP reduction, on-time shipment', target: 'WIP time below 10 weeks' },
  { id: 'collaboration', name: 'Cross-Group Collaboration', desc: 'Schumacher Design Studio, Patterson Flynn, other group brands', target: 'Proactive communication & problem-solving' },
  { id: 'grounds', name: 'Grounds Management', desc: 'Grounds mix performance, innovation, stewardship decisions', target: 'Strategic decisions on grounds mix & performance' },
  { id: 'vendors', name: 'Vendor Relationships', desc: 'P+W, Wallquest/Omni (primary) · Rotex, Greenland, Stead (developmental)', target: 'High-trust, high-performance partnerships' },
  { id: 'growth', name: 'Top-Line Growth', desc: 'Third-party revenue, Tillett custom business expansion', target: '$500k+ 3rd party · $1M+ Tillett custom' },
  { id: 'passaic', name: 'Passaic Asset Development', desc: 'Building development, construction, regulatory, tenant coordination', target: 'Long-term site planning & value creation' },
]

const KPI_STATUS_OPTIONS = [
  { value: 'green', label: 'On Track' },
  { value: 'amber', label: 'Watch' },
  { value: 'red', label: 'Concern' },
  { value: 'gray', label: 'Pending' },
]

const STATUS_LABELS = { green: 'On Track', amber: 'Watch', red: 'Concern', gray: 'Pending' }

// ── Production constants ──────────────────────────────────────────────────────
const NJ_TARGETS = {
  fabric: { yards: 810,  colorYards: 4522,  invoiceYds: 772,  invoiceRev: 14112.75 },
  grass:  { yards: 3615, colorYards: 7570,  invoiceYds: 3538, invoiceRev: 36646 },
  paper:  { yards: 4185, colorYards: 13405, invoiceYds: 3516, invoiceRev: 26330.25 },
  wasteTarget: 10,
  totalYards: 8610,
  totalInvoiceYds: 7826,
  weeklyRevenue: 128951.25,
}
const BNY_TARGETS = {
  replen: 7886, mto: 1280, hos: 1532, memo: 211, contract: 1091, total: 12000,
  incomeReplen: 90675.83, incomeMto: 14398.5, incomeHos: 10727.25, incomeMemo: 4010.5, incomeContract: 13087.5,
  totalIncomeInvoiced: 132899.58,
}
const WEEKLY_TARGETS = { schRevenue: 106645, schYards: 5886, tpRevenue: 31277, tpYards: 2564 }
const PROCUREMENT_WEEKLY_TARGET = 12500

const BNY_MACHINES_3600 = [
  { id: 'glow', name: 'Glow', target: 3600 },
  { id: 'sasha', name: 'Sasha', target: 3600 },
  { id: 'trish', name: 'Trish', target: 3600 },
]
const BNY_MACHINES_570_BNY = [
  { id: 'bianca', name: 'Bianca', target: 500 },
  { id: 'lash', name: 'LASH', target: 500 },
  { id: 'chyna', name: 'Chyna', target: 500 },
  { id: 'rhonda', name: 'Rhonda', target: 500 },
]
const BNY_MACHINES_570_NJ = [
  { id: 'dakota_ka', name: 'Dakota Ka', target: 500 },
  { id: 'dementia', name: 'Dementia', target: 500 },
  { id: 'ember', name: 'EMBER', target: 500 },
  { id: 'ivy_nile', name: 'Ivy Nile', target: 500 },
  { id: 'jacy_jayne', name: 'Jacy Jayne', target: 500 },
  { id: 'ruby', name: 'Ruby', target: 500 },
  { id: 'valhalla', name: 'Valhalla', target: 500 },
  { id: 'xia', name: 'XIA', target: 500 },
  { id: 'apollo', name: 'Apollo', target: 500 },
  { id: 'nemesis', name: 'Nemesis', target: 500 },
  { id: 'poseidon', name: 'Poseidon', target: 500 },
  { id: 'zoey', name: 'Zoey', target: 500 },
]

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const DAY_STATUS_OPTIONS = [
  { value: 'green', label: 'On Track' },
  { value: 'amber', label: 'Watch' },
  { value: 'red', label: 'Concern' },
  { value: 'gray', label: 'No Update' },
]

function n(v) { return parseFloat(v) || 0 }
function getProcurementMonthlyTarget(weeksInMonth) { return weeksInMonth === 5 ? 62500 : 50000 }

function emptyMachines() {
  return Object.fromEntries([...BNY_MACHINES_3600, ...BNY_MACHINES_570_BNY, ...BNY_MACHINES_570_NJ].map(m => [m.id, '']))
}
function emptyNJ() {
  return {
    fabric: { yards: '', colorYards: '', waste: '', postWaste: '', invoiceYds: '', invoiceRev: '' },
    grass:  { yards: '', colorYards: '', waste: '', postWaste: '', invoiceYds: '', invoiceRev: '' },
    paper:  { yards: '', colorYards: '', waste: '', postWaste: '', invoiceYds: '', invoiceRev: '' },
    schWritten: '', schProduced: '', schInvoiced: '',
    tpWritten: '', tpProduced: '', tpInvoiced: '',
    commentary: '', miscFees: '',
  }
}
function emptyBNY() {
  return {
    replen: '', mto: '', hos: '', memo: '', contract: '',
    // Invoiced yards by category
    invYdsReplen: '', invYdsMto: '', invYdsHos: '', invYdsMemo: '', invYdsContract: '',
    // Income invoiced $ by category
    incomeReplen: '', incomeMto: '', incomeHos: '', incomeMemo: '', incomeContract: '',
    schWritten: '', schProduced: '', schInvoiced: '',
    tpWritten: '', tpProduced: '', tpInvoiced: '',
    commentary: '', machines: emptyMachines(), procurement: '', miscFees: '',
  }
}
function getDefaultDays() {
  return Object.fromEntries(DAYS.map(d => [d, { text: '', status: 'gray' }]))
}

function NumberInput({ label, value, onChange, placeholder, readOnly }) {
  return (
    <div className={styles.inputGroup}>
      <label className={styles.inputLabel}>{label}</label>
      <input type="number" value={value} onChange={e => onChange?.(e.target.value)} placeholder={placeholder || '0'} style={{ textAlign: 'right' }} readOnly={readOnly} />
    </div>
  )
}

function SectionHeader({ title, badge, badgeClass }) {
  return (
    <div className={styles.sectionHeader}>
      <span className={`${styles.facilityBadge} ${badgeClass || ''}`}>{badge}</span>
      <h3 className={styles.sectionTitle}>{title}</h3>
    </div>
  )
}


// ── KPI File Attach Component ─────────────────────────────────────────────────
function KPIFileAttach({ kpiId, kpiName, fileData, onFileData }) {
  const [dragging, setDragging] = useState(false)
  const [showPaste, setShowPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const fileInputRef = React.useRef(null)

  async function processFile(file) {
    const name = file.name
    const ext = name.split('.').pop().toLowerCase()
    if (ext === 'csv' || ext === 'txt') {
      const text = await file.text()
      const lines = text.split('\n').filter(Boolean)
      const preview = lines.slice(0, 6).join('\n')
      onFileData(kpiId, { name, preview, text: text.slice(0, 3000) })
    } else if (ext === 'xlsx' || ext === 'xls') {
      try {
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs')
        const arrayBuffer = await file.arrayBuffer()
        const workbook = XLSX.read(arrayBuffer, { type: 'array' })
        const sheetName = workbook.SheetNames[0]
        const sheet = workbook.Sheets[sheetName]
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
        // Build a readable text table from the rows
        const textRows = rows.slice(0, 50).map(row =>
          row.map(cell => String(cell ?? '').trim()).join(' | ')
        ).filter(r => r.replace(/\|/g, '').trim())
        const preview = textRows.slice(0, 8).join('\n')
        const text = `[Excel: ${name} — Sheet: ${sheetName}]\n` + textRows.join('\n')
        onFileData(kpiId, { name, preview, text: text.slice(0, 4000) })
      } catch (err) {
        console.error('Excel parse error:', err)
        onFileData(kpiId, { name, preview: `Excel file: ${name}\n(Could not parse — try saving as CSV)`, text: `[Excel file: ${name}]` })
      }
    } else if (ext === 'pdf') {
      onFileData(kpiId, { name, preview: `PDF attached: ${name}`, text: `[PDF file attached: ${name}]` })
    } else {
      const text = await file.text()
      const preview = text.slice(0, 300)
      onFileData(kpiId, { name, preview, text: text.slice(0, 3000) })
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }

  function handleFileInput(e) {
    const file = e.target.files[0]
    if (file) processFile(file)
  }

  function handlePasteSubmit() {
    if (!pasteText.trim()) return
    onFileData(kpiId, { name: 'Pasted text', preview: pasteText.slice(0, 300), text: pasteText.slice(0, 3000) })
    setPasteText('')
    setShowPaste(false)
  }

  return (
    <div style={{ marginTop: 12 }}>
      {fileData ? (
        <div style={{ background: 'var(--ink-5)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)' }}>📎 {fileData.name}</span>
            <button style={{ fontSize: 11, color: 'var(--red)', border: 'none', background: 'none', cursor: 'pointer' }} onClick={() => onFileData(kpiId, null)}>Remove</button>
          </div>
          <pre style={{ fontSize: 11, color: 'var(--ink-60)', margin: 0, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden', fontFamily: 'monospace' }}>{fileData.preview}{fileData.text.length > 300 ? '\n…' : ''}</pre>
          <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 4 }}>✓ Will be included in AI draft for {kpiName}</div>
        </div>
      ) : (
        <div>
          {showPaste ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                placeholder={`Paste data for ${kpiName}…`}
                rows={4}
                style={{ width: '100%', fontSize: 12, fontFamily: 'monospace' }}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowPaste(false)}>Cancel</button>
                <button className="primary" onClick={handlePasteSubmit} disabled={!pasteText.trim()}>Attach</button>
              </div>
            </div>
          ) : (
            <div
              style={{
                border: `1px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)',
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: dragging ? 'var(--accent-light)' : 'transparent',
                transition: 'all 0.15s',
              }}
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.pdf,.txt" style={{ display: 'none' }} onChange={handleFileInput} />
              <span style={{ fontSize: 12, color: 'var(--ink-60)' }}>📎 Attach data for AI</span>
              <button style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => fileInputRef.current?.click()}>Browse</button>
              <button style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setShowPaste(true)}>Paste text</button>
              <span style={{ fontSize: 11, color: 'var(--ink-30)', marginLeft: 'auto' }}>CSV · Excel · PDF · Text</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main AdminPanel component ─────────────────────────────────────────────────
export default function AdminPanel({ weekStart, weekData, onSave, dbReady }) {
  const [activeSection, setActiveSection] = useState('production')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(null) // 'production' | 'kpis' | 'log'

  // Production state
  const [njData, setNjData] = useState(emptyNJ())
  const [bnyData, setBnyData] = useState(emptyBNY())

  // KPI state
  const [kpis, setKpis] = useState({})
  const [narrative, setNarrative] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState(null)
  const [expandedKpi, setExpandedKpi] = useState(null)
  const [kpiFiles, setKpiFiles] = useState({}) // { kpiId: { name, preview, text } }

  // Log state
  const [days, setDays] = useState(getDefaultDays())
  const [concerns, setConcerns] = useState('')
  const [activeDay, setActiveDay] = useState('Monday')

  const weekKey = format(weekStart, 'yyyy-MM-dd')
  const fiscalInfo = getFiscalInfo(weekStart)
  const weeksInMonth = fiscalInfo?.weeksInMonth || 4
  const procurementMonthlyTarget = getProcurementMonthlyTarget(weeksInMonth)

  // Load production data
  useEffect(() => {
    async function loadProduction() {
      const { data } = await supabase.from('production').select('*').eq('week_start', weekKey).single()
      if (data) {
        setNjData(data.nj_data || emptyNJ())
        setBnyData(data.bny_data || emptyBNY())
      } else {
        setNjData(emptyNJ())
        setBnyData(emptyBNY())
      }
    }
    loadProduction()
  }, [weekStart])

  // Load KPI + log data from weekData
  useEffect(() => {
    setKpis(weekData?.kpis || {})
    setNarrative(weekData?.narrative || '')
    setDays(weekData?.days || getDefaultDays())
    setConcerns(weekData?.concerns || '')
  }, [weekData])

  function updateNJ(path, value) {
    const parts = path.split('.')
    setNjData(prev => {
      const next = { ...prev }
      if (parts.length === 2) next[parts[0]] = { ...next[parts[0]], [parts[1]]: value }
      else next[parts[0]] = value
      return next
    })
  }
  function updateBNY(key, value) { setBnyData(prev => ({ ...prev, [key]: value })) }
  function updateKPI(id, field, value) {
    setKpis(prev => ({ ...prev, [id]: { ...(prev[id] || { status: 'gray', notes: '' }), [field]: value } }))
  }
  function updateDay(field, value) {
    setDays(prev => ({ ...prev, [activeDay]: { ...prev[activeDay], [field]: value } }))
  }
  function setKpiFileData(kpiId, data) {
    setKpiFiles(prev => ({ ...prev, [kpiId]: data }))
  }

  async function saveProduction() {
    setSaving(true)
    await supabase.from('production').upsert({ week_start: weekKey, nj_data: njData, bny_data: bnyData, updated_at: new Date().toISOString() }, { onConflict: 'week_start' })
    setSaving(false)
    setSaved('production')
    setTimeout(() => setSaved(null), 2500)
  }

  async function saveKPIs() {
    setSaving(true)
    await onSave({ kpis, narrative })
    setSaving(false)
    setSaved('kpis')
    setTimeout(() => setSaved(null), 2500)
  }

  async function saveLog() {
    setSaving(true)
    await onSave({ days, concerns })
    setSaving(false)
    setSaved('log')
    setTimeout(() => setSaved(null), 2500)
  }

  async function generateNarrative() {
    setGenerating(true)
    setGenError(null)
    const weekLabel = format(weekStart, 'MMMM d, yyyy')
    const kpiSummary = KPIS.map(k => {
      const d = kpis[k.id]
      if (!d || d.status === 'gray') return null
      const fileInfo = kpiFiles[k.id] ? `\n  [Attached data for ${k.name}]:\n  ${kpiFiles[k.id].text.slice(0, 500)}` : ''
      return `${k.name}: ${STATUS_LABELS[d.status]}${d.notes ? ' — ' + d.notes : ''}${fileInfo}`
    }).filter(Boolean).join('\n')
    const redItems = KPIS.filter(k => kpis[k.id]?.status === 'red').map(k => k.name)
    const amberItems = KPIS.filter(k => kpis[k.id]?.status === 'amber').map(k => k.name)
    const greenItems = KPIS.filter(k => kpis[k.id]?.status === 'green').map(k => k.name)
    const prompt = `You are helping Peter Webster, President of Paramount Prints (a specialty printing division of F. Schumacher & Co), draft a concise weekly executive summary for his CEO (Timur) and Chief of Staff (Emily).

Paramount Prints has two facilities: Passaic, NJ (screen printing — fabric, grass cloth, wallpaper) and Brooklyn (digital printing). The business does ~$10M/year in revenue.

Week of: ${weekLabel}

KPI Scorecard:
${kpiSummary || 'No KPI data entered yet.'}

Flags (Concern): ${redItems.length > 0 ? redItems.join(', ') : 'None'}
Watch items: ${amberItems.length > 0 ? amberItems.join(', ') : 'None'}
On track: ${greenItems.length > 0 ? greenItems.join(', ') : 'None'}

Write a 3-4 paragraph executive summary in Peter's voice — direct, factual, and candid. Structure:
1. Overall week assessment (1-2 sentences)
2. Key highlights and what is going well
3. Areas of concern or watch items with context
4. Forward look — what to watch next week

Keep it under 200 words. Write in first person as Peter. No bullet points. No headers. No title line. Start directly with the first sentence. Clean prose paragraphs only.`

    try {
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
      })
      const data = await response.json()
      const text = data.content?.find(c => c.type === 'text')?.text
      if (text) setNarrative(text.trim())
      else setGenError('Could not generate summary. Try again.')
    } catch (e) {
      setGenError('Generation failed. Check your connection.')
    }
    setGenerating(false)
  }

  const hasKPIData = KPIS.some(k => kpis[k.id]?.status && kpis[k.id].status !== 'gray')
  const activeDayData = days[activeDay] || { text: '', status: 'gray' }

  const SECTIONS = [
    { id: 'production', label: '📊 Production Data' },
    { id: 'kpis', label: '🎯 KPI Scorecard' },
    { id: 'log', label: '📋 Weekly Log' },
    { id: 'financials', label: '💰 Financial Data' },
  ]

  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.pageTitle}>Admin Panel</h2>
          <p className={styles.pageSub}>Week of {format(weekStart, 'MMMM d, yyyy')} · Data entry & management</p>
        </div>
      </div>

      {/* Section tabs */}
      <div className={styles.sectionTabs}>
        {SECTIONS.map(s => (
          <button key={s.id} className={`${styles.sectionTab} ${activeSection === s.id ? styles.sectionTabActive : ''}`} onClick={() => setActiveSection(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      {/* ── PRODUCTION DATA ── */}
      {activeSection === 'production' && (
        <div className={styles.panel}>
          <div className={styles.panelActions}>
            {saved === 'production' && <span className={styles.savedMsg}>✓ Saved</span>}
            <button className="primary" onClick={saveProduction} disabled={saving}>{saving ? 'Saving…' : 'Save Production Data'}</button>
          </div>

          <div className={styles.editGrid}>
            {/* NJ Section */}
            <div className={styles.editSection}>
              <SectionHeader title="Passaic — Screen Print" badge="NJ" />
              <div className={styles.editSubHeader}>Yards produced by category</div>
              <div className={styles.editRow}>
                {['fabric', 'grass', 'paper'].map(cat => (
                  <div key={cat} className={styles.editCatBlock}>
                    <div className={styles.editCatLabel}>{cat.charAt(0).toUpperCase() + cat.slice(1)} <span className={styles.editCatTarget}>(prod tgt: {NJ_TARGETS[cat].yards.toLocaleString()} · inv tgt: {NJ_TARGETS[cat].invoiceYds.toLocaleString()})</span></div>
                    <NumberInput label="Yards produced" value={njData[cat].yards} onChange={v => updateNJ(`${cat}.yards`, v)} />
                    <NumberInput label="Color yds" value={njData[cat].colorYards} onChange={v => updateNJ(`${cat}.colorYards`, v)} />
                    <NumberInput label="Waste yds" value={njData[cat].waste} onChange={v => updateNJ(`${cat}.waste`, v)} />
                    <NumberInput label="Net yds" value={n(njData[cat].yards) - n(njData[cat].waste) || ''} readOnly />
                    <NumberInput label="Post-prod waste" value={njData[cat].postWaste} onChange={v => updateNJ(`${cat}.postWaste`, v)} />
                    <NumberInput label={`Invoiced yds (tgt: ${NJ_TARGETS[cat].invoiceYds.toLocaleString()})`} value={njData[cat].invoiceYds} onChange={v => updateNJ(`${cat}.invoiceYds`, v)} />
                    <NumberInput label={`Income invoiced $ (tgt: $${NJ_TARGETS[cat].invoiceRev.toLocaleString()})`} value={njData[cat].invoiceRev} onChange={v => updateNJ(`${cat}.invoiceRev`, v)} />
                  </div>
                ))}
              </div>
              <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Miscellaneous Fees</div>
              <div style={{ maxWidth: 220 }}>
                <NumberInput
                  label="Misc fees charged this week $ (no target)"
                  value={njData.miscFees}
                  onChange={v => updateNJ('miscFees', v)}
                  placeholder="0"
                />
              </div>
              <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Schumacher vs 3rd Party</div>
              <div className={styles.editThreeCol}>
                {[['Written', 'Written'], ['Produced', 'Produced'], ['Invoiced', 'Invoiced']].map(([label, key]) => (
                  <div key={key}>
                    <NumberInput label={`SCH ${label}`} value={njData[`sch${key}`]} onChange={v => updateNJ(`sch${key}`, v)} />
                    <NumberInput label={`3P ${label}`} value={njData[`tp${key}`]} onChange={v => updateNJ(`tp${key}`, v)} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <label className={styles.inputLabel}>Commentary</label>
                <textarea value={njData.commentary} onChange={e => updateNJ('commentary', e.target.value)} placeholder="Fabric waiting on approvals, Grass working on Feather Bloom…" rows={3} style={{ marginTop: 6, width: '100%' }} />
              </div>
            </div>

            {/* BNY Section */}
            <div className={styles.editSection}>
              <SectionHeader title="Brooklyn — Digital" badge="BK" badgeClass={styles.facilityBadgeBNY} />
              <div className={styles.editSubHeader}>Yards produced by category</div>
              <div className={styles.editFiveCol}>
                {['replen', 'mto', 'hos', 'memo', 'contract'].map(cat => (
                  <NumberInput key={cat} label={`${cat.toUpperCase()} (tgt:${BNY_TARGETS[cat].toLocaleString()})`} value={bnyData[cat]} onChange={v => updateBNY(cat, v)} />
                ))}
              </div>
              <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Invoiced yards by category</div>
              <div className={styles.editFiveCol}>
                <NumberInput label={`Replen inv yds (tgt: ${BNY_TARGETS.replen.toLocaleString()})`} value={bnyData.invYdsReplen} onChange={v => updateBNY('invYdsReplen', v)} />
                <NumberInput label={`MTO inv yds (tgt: ${BNY_TARGETS.mto.toLocaleString()})`} value={bnyData.invYdsMto} onChange={v => updateBNY('invYdsMto', v)} />
                <NumberInput label={`HOS inv yds (tgt: ${BNY_TARGETS.hos.toLocaleString()})`} value={bnyData.invYdsHos} onChange={v => updateBNY('invYdsHos', v)} />
                <NumberInput label={`Memo inv yds (tgt: ${BNY_TARGETS.memo.toLocaleString()})`} value={bnyData.invYdsMemo} onChange={v => updateBNY('invYdsMemo', v)} />
                <NumberInput label={`Contract inv yds (tgt: ${BNY_TARGETS.contract.toLocaleString()})`} value={bnyData.invYdsContract} onChange={v => updateBNY('invYdsContract', v)} />
              </div>
              <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Income invoiced $ by category</div>
              <div className={styles.editFiveCol}>
                <NumberInput label={`Hub/Replen (tgt: $${Math.round(BNY_TARGETS.incomeReplen).toLocaleString()})`} value={bnyData.incomeReplen} onChange={v => updateBNY('incomeReplen', v)} />
                <NumberInput label={`MTO (tgt: $${Math.round(BNY_TARGETS.incomeMto).toLocaleString()})`} value={bnyData.incomeMto} onChange={v => updateBNY('incomeMto', v)} />
                <NumberInput label={`HOS (tgt: $${Math.round(BNY_TARGETS.incomeHos).toLocaleString()})`} value={bnyData.incomeHos} onChange={v => updateBNY('incomeHos', v)} />
                <NumberInput label={`Memos (tgt: $${Math.round(BNY_TARGETS.incomeMemo).toLocaleString()})`} value={bnyData.incomeMemo} onChange={v => updateBNY('incomeMemo', v)} />
                <NumberInput label={`Contract (tgt: $${Math.round(BNY_TARGETS.incomeContract).toLocaleString()})`} value={bnyData.incomeContract} onChange={v => updateBNY('incomeContract', v)} />
              </div>

              <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Output by machine (optional)</div>
              <div className={styles.machineEditGrid}>
                <div className={styles.machineEditGroup}>
                  <div className={styles.machineEditGroupLabel}>3600 machines — BNY (target: 3,600/wk each)</div>
                  {BNY_MACHINES_3600.map(m => (
                    <NumberInput key={m.id} label={m.name} value={bnyData.machines?.[m.id] || ''} onChange={v => updateBNY('machines', { ...bnyData.machines, [m.id]: v })} placeholder="3600" />
                  ))}
                </div>
                <div className={styles.machineEditGroup}>
                  <div className={styles.machineEditGroupLabel}>570 machines — BNY (target: 500/wk each)</div>
                  <div className={styles.machineEditCols}>
                    {BNY_MACHINES_570_BNY.map(m => (
                      <NumberInput key={m.id} label={m.name} value={bnyData.machines?.[m.id] || ''} onChange={v => updateBNY('machines', { ...bnyData.machines, [m.id]: v })} placeholder="500" />
                    ))}
                  </div>
                </div>
                <div className={styles.machineEditGroup}>
                  <div className={styles.machineEditGroupLabel}>570 machines — Passaic (target: 500/wk each)</div>
                  <div className={styles.machineEditCols}>
                    {BNY_MACHINES_570_NJ.map(m => (
                      <NumberInput key={m.id} label={m.name} value={bnyData.machines?.[m.id] || ''} onChange={v => updateBNY('machines', { ...bnyData.machines, [m.id]: v })} placeholder="500" />
                    ))}
                  </div>
                </div>
              </div>

              <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Miscellaneous Fees</div>
              <div style={{ maxWidth: 220 }}>
                <NumberInput
                  label="Misc fees charged this week $ (no target)"
                  value={bnyData.miscFees}
                  onChange={v => updateBNY('miscFees', v)}
                  placeholder="0"
                />
              </div>
              <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Schumacher vs 3rd Party</div>
              <div className={styles.editThreeCol}>
                {[['Written', 'Written'], ['Produced', 'Produced'], ['Invoiced', 'Invoiced']].map(([label, key]) => (
                  <div key={key}>
                    <NumberInput label={`SCH ${label}`} value={bnyData[`sch${key}`]} onChange={v => updateBNY(`sch${key}`, v)} />
                    <NumberInput label={`3P ${label}`} value={bnyData[`tp${key}`]} onChange={v => updateBNY(`tp${key}`, v)} />
                  </div>
                ))}
              </div>
              <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Procurement Revenue (pass-through)</div>
              <div style={{ maxWidth: 220 }}>
                <NumberInput
                  label={`This week $ · Monthly target: $${procurementMonthlyTarget.toLocaleString()} (${weeksInMonth}-wk month)`}
                  value={bnyData.procurement}
                  onChange={v => updateBNY('procurement', v)}
                  placeholder="12500"
                />
              </div>
              <div style={{ marginTop: 12 }}>
                <label className={styles.inputLabel}>Commentary</label>
                <textarea value={bnyData.commentary} onChange={e => updateBNY('commentary', e.target.value)} placeholder="Replen running ahead, MTO on track…" rows={3} style={{ marginTop: 6, width: '100%' }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── KPI SCORECARD ── */}
      {activeSection === 'kpis' && (
        <div className={styles.panel}>
          <div className={styles.panelActions}>
            {saved === 'kpis' && <span className={styles.savedMsg}>✓ Saved</span>}
            <button className="primary" onClick={saveKPIs} disabled={saving}>{saving ? 'Saving…' : 'Save Scorecard'}</button>
          </div>

          {/* AI Narrative */}
          <div className={styles.narrativeBlock}>
            <div className={styles.narrativeBlockHeader}>
              <div>
                <div className={styles.narrativeBlockTitle}>Executive Narrative</div>
                <div className={styles.narrativeBlockSub}>AI-drafted from your KPI notes — edit freely before saving</div>
              </div>
              <button
                className={`${styles.generateBtn} ${generating ? styles.generateBtnLoading : ''}`}
                onClick={generateNarrative}
                disabled={generating || !hasKPIData}
                title={!hasKPIData ? 'Fill in at least one KPI status below first' : ''}
              >
                {generating ? <>⏳ Drafting…</> : <>✦ Draft with AI</>}
              </button>
            </div>
            {genError && <p className={styles.genError}>{genError}</p>}
            <textarea
              className={styles.narrativeTextarea}
              value={narrative}
              onChange={e => setNarrative(e.target.value)}
              placeholder={hasKPIData ? 'Click "Draft with AI" to generate…' : 'Fill in KPI statuses below first, then click "Draft with AI"…'}
              rows={8}
            />
          </div>

          {/* KPI inputs */}
          <div className={styles.kpiInputList}>
            {KPIS.map(kpi => {
              const data = kpis[kpi.id] || { status: 'gray', notes: '' }
              const isExpanded = expandedKpi === kpi.id
              return (
                <div key={kpi.id} className={`${styles.kpiInputCard} ${styles[`kpiCard_${data.status}`]}`}>
                  <div className={styles.kpiInputTop} onClick={() => setExpandedKpi(isExpanded ? null : kpi.id)}>
                    <div className={styles.kpiInputLeft}>
                      <span className={`dot dot-${data.status}`} />
                      <span className={styles.kpiInputName}>{kpi.name}</span>
                    </div>
                    <div className={styles.kpiInputRight}>
                      <span className={`badge badge-${data.status}`}>{STATUS_LABELS[data.status]}</span>
                      <span className={styles.chevron}>{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className={styles.kpiInputExpanded}>
                      <p className={styles.kpiDesc}>{kpi.desc}</p>
                      <p className={styles.kpiTarget}><strong>2027 Target:</strong> {kpi.target}</p>
                      <div className={styles.statusPicker}>
                        {KPI_STATUS_OPTIONS.map(s => (
                          <button key={s.value} className={`${styles.statusBtn} ${data.status === s.value ? styles[`statusActive_${s.value}`] : ''}`} onClick={() => updateKPI(kpi.id, 'status', s.value)}>
                            <span className={`dot dot-${s.value}`} />{s.label}
                          </button>
                        ))}
                      </div>
                      <label className={styles.inputLabel} style={{ marginTop: 12, display: 'block' }}>Notes for this week</label>
                      <textarea value={data.notes || ''} onChange={e => updateKPI(kpi.id, 'notes', e.target.value)} placeholder={`What happened this week on ${kpi.name}?`} rows={3} style={{ marginTop: 6, width: '100%' }} />
                      <KPIFileAttach kpiId={kpi.id} kpiName={kpi.name} fileData={kpiFiles[kpi.id]} onFileData={setKpiFileData} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── FINANCIAL DATA ── */}
      {activeSection === 'financials' && (
        <div className={styles.panel}>
          <AdminFinancials weekStart={weekStart} />
        </div>
      )}

      {/* ── WEEKLY LOG ── */}
      {activeSection === 'log' && (
        <div className={styles.panel}>
          <div className={styles.panelActions}>
            {saved === 'log' && <span className={styles.savedMsg}>✓ Saved</span>}
            <button className="primary" onClick={saveLog} disabled={saving}>{saving ? 'Saving…' : 'Save Week'}</button>
          </div>

          <div className={styles.dayTabs}>
            {DAYS.map(day => {
              const d = days[day] || { text: '', status: 'gray' }
              return (
                <button key={day} className={`${styles.dayTab} ${activeDay === day ? styles.dayTabActive : ''}`} onClick={() => setActiveDay(day)}>
                  <span className={`dot dot-${d.status}`} style={{ marginRight: 6 }} />
                  {day.slice(0, 3)}
                  {d.text && <span className={styles.dayHasEntry} />}
                </button>
              )
            })}
          </div>

          <div className={styles.dayPanel}>
            <div className={styles.dayHeader}>
              <h3 className={styles.dayTitle}>{activeDay}</h3>
              <div className={styles.statusRow}>
                <span className={styles.inputLabel} style={{ marginBottom: 0, marginRight: 8 }}>Status</span>
                {DAY_STATUS_OPTIONS.map(s => (
                  <button key={s.value} className={`${styles.statusBtn} ${activeDayData.status === s.value ? styles[`statusActive_${s.value}`] : ''}`} onClick={() => updateDay('status', s.value)}>
                    <span className={`dot dot-${s.value}`} />{s.label}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              className={styles.dayTextarea}
              value={activeDayData.text}
              onChange={e => updateDay('text', e.target.value)}
              placeholder={`Log ${activeDay}'s activities, meetings, decisions, and follow-ups…`}
              rows={10}
            />
          </div>

          <div className={styles.concernsPanel}>
            <label className={styles.inputLabel}>Areas of Concern / Flags for Timur & Emily</label>
            <textarea value={concerns} onChange={e => setConcerns(e.target.value)} placeholder="Anything requiring executive attention, decisions, or awareness this week…" rows={4} style={{ marginTop: 6, width: '100%' }} />
          </div>
        </div>
      )}
    </div>
  )
}
