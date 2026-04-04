import { useState, useEffect } from 'react'
import { getFiscalInfo } from '../fiscalCalendar'

const BNY_SHEET_ID = '1nVuGPNIxRCEHOLSr6v5OrwFZO7sWOZT2zeeB7CkX_Ys'
const NJ_SHEET_ID  = '1dT6mc8kKzcUJsUjHsFZdANMF_UpJ9LhEd0xQUj00I6k'
const API_KEY      = import.meta.env.VITE_GOOGLE_SHEETS_API_KEY

const STYLES = {
  container: { padding: '24px', fontFamily: 'Georgia, serif', background: '#FAF7F2', minHeight: '100vh' },
  header: { color: '#2C2420', fontSize: '22px', fontWeight: 'bold', marginBottom: '4px' },
  subheader: { color: '#9C8F87', fontSize: '13px', marginBottom: '24px' },
  summaryGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '28px' },
  summaryCard: { background: '#fff', border: '1px solid #E8DDD0', borderRadius: '8px', padding: '20px' },
  cardTitle: { fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.08em', color: '#9C8F87', textTransform: 'uppercase', marginBottom: '12px' },
  bigNum: { fontSize: '32px', fontWeight: 'bold', color: '#2C2420' },
  bigLabel: { fontSize: '12px', color: '#9C8F87', marginTop: '2px' },
  progressBar: { height: '6px', background: '#F2EDE4', borderRadius: '3px', marginTop: '12px', overflow: 'hidden' },
  progressFill: (pct, color) => ({ height: '100%', width: `${Math.min(pct, 100)}%`, background: color, borderRadius: '3px', transition: 'width 0.4s ease' }),
  sectionTitle: { fontSize: '13px', fontWeight: 'bold', color: '#2C2420', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '10px', marginTop: '24px', borderBottom: '1px solid #E8DDD0', paddingBottom: '6px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px', background: '#fff', border: '1px solid #E8DDD0', borderRadius: '8px', overflow: 'hidden' },
  th: { background: '#2C2420', color: '#D4A843', padding: '8px 12px', textAlign: 'left', fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.06em' },
  thRight: { background: '#2C2420', color: '#D4A843', padding: '8px 12px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.06em' },
  td: { padding: '7px 12px', borderBottom: '1px solid #F2EDE4', color: '#2C2420' },
  tdRight: { padding: '7px 12px', borderBottom: '1px solid #F2EDE4', color: '#2C2420', textAlign: 'right' },
  tdMuted: { padding: '7px 12px', borderBottom: '1px solid #F2EDE4', color: '#9C8F87', textAlign: 'right' },
  sectionRow: { background: '#E8DDD0', fontWeight: 'bold', color: '#5C4F47' },
  subtotalRow: { background: '#F2EDE4', fontStyle: 'italic', color: '#5C4F47' },
  totalRow: { background: '#DDD4C8', fontWeight: 'bold', color: '#2C2420' },
  pctGood: { color: '#2E7D32', fontWeight: 'bold' },
  pctWarn: { color: '#E65100', fontWeight: 'bold' },
  pctNone: { color: '#9C8F87' },
  error: { background: '#FFF3E0', border: '1px solid #FFB74D', borderRadius: '8px', padding: '16px', color: '#E65100', marginBottom: '16px' },
  info: { background: '#F2EDE4', border: '1px solid #E8DDD0', borderRadius: '8px', padding: '16px', color: '#9C8F87', marginBottom: '16px', fontSize: '13px' },
  loading: { color: '#9C8F87', padding: '40px', textAlign: 'center', fontSize: '14px' },
  weekBadge: { display: 'inline-block', background: '#2C2420', color: '#D4A843', borderRadius: '4px', padding: '2px 10px', fontSize: '12px', fontWeight: 'bold', marginLeft: '10px', verticalAlign: 'middle' },
  refreshBtn: { float: 'right', background: 'none', border: '1px solid #E8DDD0', borderRadius: '4px', padding: '4px 12px', fontSize: '12px', color: '#9C8F87', cursor: 'pointer' },
}

async function fetchSheetData(sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?key=${API_KEY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`)
  const data = await res.json()
  return data.values || []
}

function parseWeekData(rows, weekNum) {
  const prefix = `WK${weekNum}`
  const headerIdx = rows.findIndex(r => r[0] && String(r[0]).trim().startsWith(prefix))
  if (headerIdx === -1) return null

  const machines = []
  let i = headerIdx + 1
  let currentSection = null

  while (i < rows.length) {
    const row = rows[i]
    const col0 = String(row[0] || '').trim()

    // Stop at next week header
    if (col0.startsWith('WK') && !col0.startsWith(prefix)) break

    if (col0.startsWith('>> ')) {
      const sectionLabel = col0.replace('>> ', '').replace(/\s*[—\-–].*$/, '').trim()
      // Skip weekend section headers
      if (sectionLabel.toUpperCase().includes('SATURDAY') || sectionLabel.toUpperCase().includes('SUNDAY')) {
        i++
        continue
      }
      currentSection = sectionLabel
      i++
      continue
    }

    if (col0.includes('TOTAL') || col0.startsWith('──') || col0 === '' ||
        col0 === 'Budget/Day' || col0 === 'Bgt/Day' || col0.startsWith('WK')) {
      i++
      continue
    }

    const budget = parseFloat(row[1]) || 0
    if (budget > 0 && currentSection) {
      const sched  = parseFloat(row[12]) || 0
      const actual = parseFloat(row[13]) || 0
      // Detect weekend machine rows: col E (index 4) empty = weekend row
      const isWeekend = !row[4] || row[4] === ''
      const wkndSched  = isWeekend ? (parseFloat(row[2]) || 0) : 0
      const wkndActual = isWeekend ? (parseFloat(row[3]) || 0) : 0

      machines.push({
        name: col0,
        section: currentSection,
        budget,
        sched:  sched  + wkndSched,
        actual: actual + wkndActual,
      })
    }
    i++
  }

  return machines.length > 0 ? machines : null
}

function pctColor(pct) {
  if (pct === null || isNaN(pct)) return STYLES.pctNone
  if (pct >= 0.95) return STYLES.pctGood
  return STYLES.pctWarn
}

function fmtPct(actual, sched) {
  if (!sched || sched === 0) return '—'
  return `${Math.round((actual / sched) * 100)}%`
}

function fmtNum(n) {
  return n ? n.toLocaleString() : '—'
}

function SummaryCard({ title, sched, actual, budget, color }) {
  const pct = sched > 0 ? actual / sched : 0
  const vsBudget = budget > 0 ? actual / budget : 0
  return (
    <div style={STYLES.summaryCard}>
      <div style={STYLES.cardTitle}>{title}</div>
      <div style={STYLES.bigNum}>{fmtNum(actual)} <span style={{ fontSize: '14px', color: '#9C8F87', fontFamily: 'sans-serif' }}>yds</span></div>
      <div style={STYLES.bigLabel}>of {fmtNum(sched)} scheduled</div>
      <div style={STYLES.progressBar}>
        <div style={STYLES.progressFill(pct * 100, color)} />
      </div>
      <div style={{ marginTop: '8px', fontSize: '12px', color: '#9C8F87', fontFamily: 'sans-serif' }}>
        <span style={pctColor(pct)}>{fmtPct(actual, sched)}</span> of schedule
        {budget > 0 && <span style={{ marginLeft: '12px' }}><span style={pctColor(vsBudget)}>{fmtPct(actual, budget)}</span> of budget</span>}
      </div>
    </div>
  )
}

function MachineTable({ title, machines }) {
  if (!machines || machines.length === 0) return null

  const sections = {}
  machines.forEach(m => {
    if (!sections[m.section]) sections[m.section] = []
    sections[m.section].push(m)
  })

  const rows = []
  let grandSched = 0, grandActual = 0

  Object.entries(sections).forEach(([section, ms]) => {
    rows.push({ type: 'section', label: section })
    let secSched = 0, secActual = 0
    ms.forEach(m => {
      rows.push({ type: 'machine', ...m })
      secSched += m.sched
      secActual += m.actual
    })
    rows.push({ type: 'subtotal', label: `${section} TOTAL`, sched: secSched, actual: secActual })
    grandSched += secSched
    grandActual += secActual
  })

  rows.push({ type: 'total', label: 'WEEK TOTAL', sched: grandSched, actual: grandActual })

  return (
    <div>
      <div style={STYLES.sectionTitle}>{title}</div>
      <table style={STYLES.table}>
        <thead>
          <tr>
            <th style={STYLES.th}>Machine / Table</th>
            <th style={STYLES.thRight}>Bgt/Day</th>
            <th style={STYLES.thRight}>Wk Sched</th>
            <th style={STYLES.thRight}>Wk Actual</th>
            <th style={STYLES.thRight}>% Done</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            if (row.type === 'section') return (
              <tr key={i} style={STYLES.sectionRow}>
                <td colSpan={5} style={{ ...STYLES.td, ...STYLES.sectionRow }}>▸ {row.label}</td>
              </tr>
            )
            if (row.type === 'subtotal') return (
              <tr key={i} style={STYLES.subtotalRow}>
                <td style={{ ...STYLES.td, ...STYLES.subtotalRow }}>{row.label}</td>
                <td style={{ ...STYLES.tdRight, ...STYLES.subtotalRow }}>—</td>
                <td style={{ ...STYLES.tdRight, ...STYLES.subtotalRow }}>{fmtNum(row.sched)}</td>
                <td style={{ ...STYLES.tdRight, ...STYLES.subtotalRow }}>{fmtNum(row.actual)}</td>
                <td style={{ ...STYLES.tdRight, ...STYLES.subtotalRow, ...pctColor(row.sched > 0 ? row.actual / row.sched : null) }}>{fmtPct(row.actual, row.sched)}</td>
              </tr>
            )
            if (row.type === 'total') return (
              <tr key={i} style={STYLES.totalRow}>
                <td style={{ ...STYLES.td, ...STYLES.totalRow }}>{row.label}</td>
                <td style={{ ...STYLES.tdRight, ...STYLES.totalRow }}>—</td>
                <td style={{ ...STYLES.tdRight, ...STYLES.totalRow }}>{fmtNum(row.sched)}</td>
                <td style={{ ...STYLES.tdRight, ...STYLES.totalRow }}>{fmtNum(row.actual)}</td>
                <td style={{ ...STYLES.tdRight, ...STYLES.totalRow, ...pctColor(row.sched > 0 ? row.actual / row.sched : null) }}>{fmtPct(row.actual, row.sched)}</td>
              </tr>
            )
            const pct = row.sched > 0 ? row.actual / row.sched : null
            const rowBg = i % 2 === 0 ? '#fff' : '#FAF7F2'
            return (
              <tr key={i} style={{ background: rowBg }}>
                <td style={{ ...STYLES.td, background: rowBg }}>{row.name}</td>
                <td style={{ ...STYLES.tdMuted, background: rowBg }}>{row.budget}</td>
                <td style={{ ...STYLES.tdRight, background: rowBg }}>{fmtNum(row.sched)}</td>
                <td style={{ ...STYLES.tdRight, background: rowBg }}>{fmtNum(row.actual)}</td>
                <td style={{ ...STYLES.tdRight, background: rowBg, ...pctColor(pct) }}>{fmtPct(row.actual, row.sched)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// weekStart is a Date object passed from App.jsx
export default function ProductionTab({ weekStart }) {
  const [bnyMachines, setBnyMachines] = useState(null)
  const [njMachines, setNjMachines]   = useState(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [weekNum, setWeekNum]         = useState(null)

  async function loadData(ws) {
    setLoading(true)
    setError(null)
    setBnyMachines(null)
    setNjMachines(null)
    try {
      // Get fiscal week from the passed weekStart date
      const fiscalInfo = getFiscalInfo(ws)
      const fw = fiscalInfo ? fiscalInfo.fiscalWeek : null
      setWeekNum(fw)

      if (!fw) {
        setError(`No fiscal week found for this date. Sheets cover Weeks 14–28 (Apr 6 – Jul 18).`)
        return
      }

      const [bnyRows, njRows] = await Promise.all([
        fetchSheetData(BNY_SHEET_ID, 'Schedule!A:O'),
        fetchSheetData(NJ_SHEET_ID,  'Schedule!A:O'),
      ])

      setBnyMachines(parseWeekData(bnyRows, fw))
      setNjMachines(parseWeekData(njRows,  fw))
      setLastRefresh(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (weekStart) loadData(weekStart)
  }, [weekStart])

  const bnyTotals = bnyMachines ? {
    sched:  bnyMachines.reduce((s, m) => s + m.sched, 0),
    actual: bnyMachines.reduce((s, m) => s + m.actual, 0),
    budget: 12000,
  } : null

  const njTotals = njMachines ? {
    sched:  njMachines.reduce((s, m) => s + m.sched, 0),
    actual: njMachines.reduce((s, m) => s + m.actual, 0),
    budget: 8610,
  } : null

  return (
    <div style={STYLES.container}>
      <div style={STYLES.header}>
        Live Production
        {weekNum && <span style={STYLES.weekBadge}>FY WK {weekNum}</span>}
        <button style={STYLES.refreshBtn} onClick={() => loadData(weekStart)}>↻ Refresh</button>
      </div>
      <div style={STYLES.subheader}>
        Source: Google Sheets (live) {lastRefresh && `· Last loaded ${lastRefresh.toLocaleTimeString()}`}
      </div>

      {error && <div style={STYLES.error}>⚠ {error}</div>}
      {loading && <div style={STYLES.loading}>Loading production data from Google Sheets...</div>}

      {!loading && !error && !bnyMachines && !njMachines && (
        <div style={STYLES.info}>
          No production data found for FY Week {weekNum}. The sheets cover Weeks 14–28 (Apr 6 – Jul 18).
        </div>
      )}

      {!loading && !error && (bnyMachines || njMachines) && (
        <>
          <div style={STYLES.summaryGrid}>
            {bnyTotals && <SummaryCard title="BNY Digital" {...bnyTotals} color="#D4A843" />}
            {njTotals  && <SummaryCard title="NJ Screen Print" {...njTotals} color="#5C8A6E" />}
          </div>
          <MachineTable title="BNY — Digital Production" machines={bnyMachines} />
          <MachineTable title="NJ — Screen Print Production" machines={njMachines} />
        </>
      )}
    </div>
  )
}
