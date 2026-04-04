import { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { getFiscalInfo } from '../fiscalCalendar'

const BNY_SHEET_ID = '1nVuGPNIxRCEHOLSr6v5OrwFZO7sWOZT2zeeB7CkX_Ys'
const NJ_SHEET_ID  = '1dT6mc8kKzcUJsUjHsFZdANMF_UpJ9LhEd0xQUj00I6k'
const API_KEY      = import.meta.env.VITE_GOOGLE_SHEETS_API_KEY

// Column mapping (0-indexed):
// A=0 name, B=1 budget/day
// C=2 SchedMon, D=3 ActMon, E=4 SchedTue, F=5 ActTue
// G=6 SchedWed, H=7 ActWed, I=8 SchedThu, J=9 ActThu
// K=10 SchedFri, L=11 ActFri
// M=12 WkSched, N=13 WkActual, O=14 %Done

const DAY_COLS = [
  { label: 'Mon', sched: 2,  actual: 3  },
  { label: 'Tue', sched: 4,  actual: 5  },
  { label: 'Wed', sched: 6,  actual: 7  },
  { label: 'Thu', sched: 8,  actual: 9  },
  { label: 'Fri', sched: 10, actual: 11 },
]

async function fetchSheetData(sheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Schedule!A:O')}?key=${API_KEY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`)
  const data = await res.json()
  return data.values || []
}

function parseWeekData(rows, weekNum) {
  const prefix = `WK${weekNum}`
  const headerIdx = rows.findIndex(r => r[0] && String(r[0]).trim().startsWith(prefix))
  if (headerIdx === -1) return { dayHeaders: [], sections: [] }

  // Extract day date labels from header row
  const hdr = rows[headerIdx]
  // hdr[2] = "S:04/06", hdr[3] = "A:04/06" etc
  const dayHeaders = DAY_COLS.map(d => {
    const raw = String(hdr[d.sched] || '')
    return raw.replace(/^[SA]:/, '')
  })

  const sections = []
  let currentSection = null
  let i = headerIdx + 1

  while (i < rows.length) {
    const row = rows[i]
    const col0 = String(row[0] || '').trim()

    if (col0.startsWith('WK') && !col0.startsWith(prefix)) break

    if (col0.startsWith('>> ')) {
      const label = col0.replace('>> ', '').replace(/\s*[—\-–].*$/, '').trim()
      if (label.toUpperCase().includes('SATURDAY') || label.toUpperCase().includes('SUNDAY')) {
        i++; continue
      }
      if (currentSection) sections.push(currentSection)
      currentSection = { label, machines: [] }
      i++; continue
    }

    if (col0.includes('TOTAL') || col0.startsWith('──') || col0 === '' ||
        col0 === 'Budget/Day' || col0 === 'Bgt/Day') {
      i++; continue
    }

    const budget = parseFloat(row[1]) || 0
    if (budget > 0 && currentSection) {
      // Skip weekend rows (col E empty = weekend)
      const isWeekend = !row[4] || row[4] === ''
      if (!isWeekend) {
        const days = DAY_COLS.map(d => ({
          sched:  parseFloat(row[d.sched])  || 0,
          actual: row[d.actual] !== '' && row[d.actual] !== undefined ? parseFloat(row[d.actual]) : null,
        }))
        const wkSched  = parseFloat(row[12]) || 0
        const wkActual = row[13] !== '' && row[13] !== undefined && row[13] !== null ? parseFloat(row[13]) : null
        currentSection.machines.push({ name: col0, budget, days, wkSched, wkActual })
      }
    }
    i++
  }
  if (currentSection) sections.push(currentSection)
  return { dayHeaders, sections }
}

function pct(actual, sched) {
  if (actual === null || !sched) return null
  return Math.round((actual / sched) * 100)
}

function fmtNum(n) {
  if (n === null || n === undefined || n === '') return null
  return Number(n).toLocaleString()
}

function PctBadge({ actual, sched }) {
  const p = pct(actual, sched)
  if (p === null) return <span style={{ color: '#C8BDB8', fontSize: 11 }}>—</span>
  const color = p >= 95 ? '#2E7D32' : p >= 70 ? '#E65100' : '#C62828'
  return <span style={{ color, fontWeight: 'bold', fontSize: 11 }}>{p}%</span>
}

function DayCell({ sched, actual, isToday }) {
  const p = pct(actual, sched)
  const hasActual = actual !== null && actual !== undefined
  const cellBg = isToday ? 'rgba(212,168,67,0.08)' : 'transparent'
  const borderLeft = isToday ? '2px solid #D4A843' : '1px solid #F2EDE4'
  return (
    <td style={{ padding: '6px 8px', borderBottom: '1px solid #F2EDE4', borderLeft, background: cellBg, textAlign: 'center', minWidth: 90 }}>
      <div style={{ fontSize: 12, color: '#9C8F87' }}>{fmtNum(sched) || '—'}</div>
      <div style={{ fontSize: 13, fontWeight: hasActual ? 'bold' : 'normal', color: hasActual ? '#2C2420' : '#C8BDB8' }}>
        {hasActual ? fmtNum(actual) : '·'}
      </div>
      {hasActual && sched > 0 && (
        <div style={{ fontSize: 10, color: p >= 95 ? '#2E7D32' : '#E65100' }}>{p}%</div>
      )}
    </td>
  )
}

function SectionTable({ section, dayHeaders, todayIdx }) {
  // Compute section day totals
  const dayTotals = DAY_COLS.map((_, di) => ({
    sched:  section.machines.reduce((s, m) => s + (m.days[di]?.sched || 0), 0),
    actual: section.machines.every(m => m.days[di]?.actual === null)
      ? null
      : section.machines.reduce((s, m) => s + (m.days[di]?.actual || 0), 0),
  }))
  const wkSchedTotal  = section.machines.reduce((s, m) => s + m.wkSched, 0)
  const wkActualTotal = section.machines.every(m => m.wkActual === null)
    ? null
    : section.machines.reduce((s, m) => s + (m.wkActual || 0), 0)

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ background: '#E8DDD0', padding: '6px 12px', fontWeight: 'bold', fontSize: 12, color: '#5C4F47', letterSpacing: '0.05em', textTransform: 'uppercase', borderRadius: '4px 4px 0 0' }}>
        ▸ {section.label}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, background: '#fff', border: '1px solid #E8DDD0' }}>
          <thead>
            <tr style={{ background: '#2C2420' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D4A843', fontSize: 11, fontWeight: 'bold', minWidth: 130, position: 'sticky', left: 0, background: '#2C2420' }}>Machine</th>
              <th style={{ padding: '8px 8px', textAlign: 'center', color: '#D4A843', fontSize: 11, fontWeight: 'bold', minWidth: 60 }}>Bgt/Day</th>
              {dayHeaders.map((d, i) => (
                <th key={i} style={{ padding: '8px 8px', textAlign: 'center', color: i === todayIdx ? '#FAD47C' : '#D4A843', fontSize: 11, fontWeight: 'bold', minWidth: 90, borderLeft: i === todayIdx ? '2px solid #D4A843' : '1px solid #3C3028', background: i === todayIdx ? '#3A2E1A' : '#2C2420' }}>
                  {DAY_COLS[i].label}<br/>
                  <span style={{ fontWeight: 'normal', fontSize: 10, color: '#9C8F87' }}>{d}</span><br/>
                  <span style={{ fontWeight: 'normal', fontSize: 9, color: '#6C6058' }}>Sched / Actual</span>
                </th>
              ))}
              <th style={{ padding: '8px 8px', textAlign: 'center', color: '#D4A843', fontSize: 11, fontWeight: 'bold', minWidth: 90, borderLeft: '2px solid #5C4F47' }}>Wk Total</th>
            </tr>
          </thead>
          <tbody>
            {section.machines.map((m, mi) => (
              <tr key={mi} style={{ background: mi % 2 === 0 ? '#fff' : '#FAF7F2' }}>
                <td style={{ padding: '7px 12px', borderBottom: '1px solid #F2EDE4', color: '#2C2420', fontWeight: 500, position: 'sticky', left: 0, background: mi % 2 === 0 ? '#fff' : '#FAF7F2' }}>{m.name}</td>
                <td style={{ padding: '7px 8px', borderBottom: '1px solid #F2EDE4', color: '#9C8F87', textAlign: 'center' }}>{m.budget}</td>
                {m.days.map((day, di) => (
                  <DayCell key={di} sched={day.sched} actual={day.actual} isToday={di === todayIdx} />
                ))}
                <td style={{ padding: '7px 8px', borderBottom: '1px solid #F2EDE4', textAlign: 'center', borderLeft: '2px solid #E8DDD0' }}>
                  <div style={{ fontSize: 12, color: '#9C8F87' }}>{fmtNum(m.wkSched)}</div>
                  <div style={{ fontSize: 13, fontWeight: m.wkActual !== null ? 'bold' : 'normal', color: m.wkActual !== null ? '#2C2420' : '#C8BDB8' }}>
                    {m.wkActual !== null ? fmtNum(m.wkActual) : '·'}
                  </div>
                  <PctBadge actual={m.wkActual} sched={m.wkSched} />
                </td>
              </tr>
            ))}
            {/* Section totals row */}
            <tr style={{ background: '#EDE5DC', fontWeight: 'bold' }}>
              <td style={{ padding: '7px 12px', color: '#5C4F47', fontStyle: 'italic', position: 'sticky', left: 0, background: '#EDE5DC' }}>{section.label} TOTAL</td>
              <td style={{ padding: '7px 8px', textAlign: 'center', color: '#9C8F87' }}>—</td>
              {dayTotals.map((dt, di) => (
                <td key={di} style={{ padding: '6px 8px', textAlign: 'center', borderLeft: di === todayIdx ? '2px solid #D4A843' : '1px solid #E8DDD0', background: di === todayIdx ? 'rgba(212,168,67,0.1)' : '#EDE5DC' }}>
                  <div style={{ fontSize: 12, color: '#9C8F87' }}>{fmtNum(dt.sched)}</div>
                  <div style={{ fontSize: 13, color: '#5C4F47' }}>{dt.actual !== null ? fmtNum(dt.actual) : '·'}</div>
                </td>
              ))}
              <td style={{ padding: '6px 8px', textAlign: 'center', borderLeft: '2px solid #C8BDB4' }}>
                <div style={{ fontSize: 12, color: '#9C8F87' }}>{fmtNum(wkSchedTotal)}</div>
                <div style={{ fontSize: 13, color: '#5C4F47' }}>{wkActualTotal !== null ? fmtNum(wkActualTotal) : '·'}</div>
                <PctBadge actual={wkActualTotal} sched={wkSchedTotal} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FacilityBlock({ title, dayHeaders, sections, todayIdx, budget }) {
  if (!sections || sections.length === 0) return null

  const grandWkSched  = sections.reduce((s, sec) => s + sec.machines.reduce((ss, m) => ss + m.wkSched, 0), 0)
  const allNull = sections.every(sec => sec.machines.every(m => m.wkActual === null))
  const grandWkActual = allNull ? null : sections.reduce((s, sec) => s + sec.machines.reduce((ss, m) => ss + (m.wkActual || 0), 0), 0)
  const p = pct(grandWkActual, grandWkSched)
  const vsBudget = grandWkActual !== null && budget ? pct(grandWkActual, budget) : null

  return (
    <div style={{ marginBottom: 40 }}>
      {/* Facility header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: '#2C2420', fontFamily: 'Georgia, serif' }}>{title}</div>
        <div style={{ fontSize: 13, color: '#9C8F87' }}>
          {fmtNum(grandWkActual) || '0'} / {fmtNum(grandWkSched)} yds
          {p !== null && <span style={{ marginLeft: 8, color: p >= 95 ? '#2E7D32' : '#E65100', fontWeight: 'bold' }}>{p}%</span>}
          {vsBudget !== null && <span style={{ marginLeft: 8, color: '#9C8F87' }}>· {vsBudget}% of budget</span>}
        </div>
      </div>
      {sections.map((sec, i) => (
        <SectionTable key={i} section={sec} dayHeaders={dayHeaders} todayIdx={todayIdx} />
      ))}
    </div>
  )
}

export default function ProductionTab({ weekStart }) {
  const [bnyData, setBnyData] = useState(null)
  const [njData,  setNjData]  = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [weekNum, setWeekNum] = useState(null)
  const [weekInfo, setWeekInfo] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  // Figure out which column is "today" (0=Mon ... 4=Fri, -1=weekend)
  const todayIdx = (() => {
    const d = new Date().getDay() // 0=Sun,1=Mon...5=Fri,6=Sat
    if (d >= 1 && d <= 5) return d - 1
    return -1
  })()

  async function loadData(ws) {
    setLoading(true)
    setError(null)
    try {
      const key = format(ws, 'yyyy-MM-dd')
      const info = getFiscalInfo(key)
      if (!info) {
        setError('No fiscal week found for this date. Sheets cover Weeks 14–28 (Apr 6 – Jul 18).')
        setLoading(false)
        return
      }
      setWeekNum(info.fiscalWeek)
      setWeekInfo(info)

      const [bnyRows, njRows] = await Promise.all([
        fetchSheetData(BNY_SHEET_ID),
        fetchSheetData(NJ_SHEET_ID),
      ])

      setBnyData(parseWeekData(bnyRows, info.fiscalWeek))
      setNjData(parseWeekData(njRows,   info.fiscalWeek))
      setLastRefresh(new Date())
    } catch(e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (weekStart) loadData(weekStart) }, [weekStart])

  const todayLabel = todayIdx >= 0 ? ['Mon','Tue','Wed','Thu','Fri'][todayIdx] : null

  return (
    <div style={{ padding: '24px', fontFamily: 'Georgia, serif', background: '#FAF7F2', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: '#2C2420' }}>Live Production</div>
          {weekNum && (
            <span style={{ display: 'inline-block', background: '#2C2420', color: '#D4A843', borderRadius: 4, padding: '2px 10px', fontSize: 12, fontWeight: 'bold' }}>
              FY WK {weekNum}
            </span>
          )}
          {weekInfo && (
            <span style={{ fontSize: 13, color: '#9C8F87' }}>{weekInfo.month} · {weekInfo.quarter}</span>
          )}
          {todayLabel && (
            <span style={{ fontSize: 12, background: 'rgba(212,168,67,0.15)', color: '#B8860B', borderRadius: 4, padding: '2px 8px', border: '1px solid rgba(212,168,67,0.3)' }}>
              Today: {todayLabel}
            </span>
          )}
        </div>
        <button onClick={() => loadData(weekStart)} style={{ background: 'none', border: '1px solid #E8DDD0', borderRadius: 4, padding: '4px 12px', fontSize: 12, color: '#9C8F87', cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>
      <div style={{ fontSize: 13, color: '#9C8F87', marginBottom: 24 }}>
        Source: Google Sheets (live){lastRefresh && ` · Last loaded ${lastRefresh.toLocaleTimeString()}`}
        <span style={{ marginLeft: 16, fontSize: 11, color: '#C8BDB8' }}>Each day cell: Sched (top) / Actual (bottom)</span>
      </div>

      {error && (
        <div style={{ background: '#FFF3E0', border: '1px solid #FFB74D', borderRadius: 8, padding: 16, color: '#E65100', marginBottom: 16 }}>
          ⚠ {error}
        </div>
      )}

      {loading && (
        <div style={{ color: '#9C8F87', padding: 40, textAlign: 'center', fontSize: 14 }}>
          Loading production data from Google Sheets...
        </div>
      )}

      {!loading && !error && bnyData && njData && (
        <>
          <FacilityBlock
            title="BNY — Digital Production"
            dayHeaders={bnyData.dayHeaders}
            sections={bnyData.sections}
            todayIdx={todayIdx}
            budget={12000}
          />
          <FacilityBlock
            title="NJ — Screen Print Production"
            dayHeaders={njData.dayHeaders}
            sections={njData.sections}
            todayIdx={todayIdx}
            budget={8610}
          />
        </>
      )}

      {!loading && !error && (!bnyData || bnyData.sections.length === 0) && (
        <div style={{ background: '#F2EDE4', border: '1px solid #E8DDD0', borderRadius: 8, padding: 16, color: '#9C8F87', fontSize: 13 }}>
          No production data found for FY Week {weekNum}. The sheets cover Weeks 14–28 (Apr 6 – Jul 18).
        </div>
      )}
    </div>
  )
}
