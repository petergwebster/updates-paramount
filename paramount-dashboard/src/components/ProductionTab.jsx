import { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { getFiscalInfo } from '../fiscalCalendar'

const BNY_SHEET_ID = '1nVuGPNIxRCEHOLSr6v5OrwFZO7sWOZT2zeeB7CkX_Ys'
const NJ_SHEET_ID  = '1dT6mc8kKzcUJsUjHsFZdANMF_UpJ9LhEd0xQUj00I6k'
const API_KEY      = import.meta.env.VITE_GOOGLE_SHEETS_API_KEY

// BNY: 3 cols per day (sched, actual, operator), cols C-Q = indices 2-16
const BNY_DAY_COLS = [
  { label: 'Mon', sched: 2,  actual: 3,  op: 4  },
  { label: 'Tue', sched: 5,  actual: 6,  op: 7  },
  { label: 'Wed', sched: 8,  actual: 9,  op: 10 },
  { label: 'Thu', sched: 11, actual: 12, op: 13 },
  { label: 'Fri', sched: 14, actual: 15, op: 16 },
]
const BNY_WK_SCHED  = 17  // R
const BNY_WK_ACTUAL = 18  // S

// NJ: 4 cols per day (sched, actual, op1, op2), cols C-V = indices 2-21
const NJ_DAY_COLS = [
  { label: 'Mon', sched: 2,  actual: 3,  op1: 4,  op2: 5  },
  { label: 'Tue', sched: 6,  actual: 7,  op1: 8,  op2: 9  },
  { label: 'Wed', sched: 10, actual: 11, op1: 12, op2: 13 },
  { label: 'Thu', sched: 14, actual: 15, op1: 16, op2: 17 },
  { label: 'Fri', sched: 18, actual: 19, op1: 20, op2: 21 },
]
const NJ_WK_SCHED  = 22  // W
const NJ_WK_ACTUAL = 23  // X

async function fetchSheetData(sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?key=${API_KEY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`)
  const data = await res.json()
  return data.values || []
}

function parseNum(val) {
  if (val === '' || val === undefined || val === null) return null
  const n = parseFloat(val)
  return isNaN(n) ? null : n
}

function parseBNYWeek(rows, weekNum) {
  const prefix = `WK${weekNum}`
  const headerIdx = rows.findIndex(r => r[0] && String(r[0]).trim().startsWith(prefix))
  if (headerIdx === -1) return null

  const hdr = rows[headerIdx]
  const dayDates = BNY_DAY_COLS.map(d => String(hdr[d.sched] || '').replace(/^[SA]:/, ''))

  const sections = []
  let currentSection = null
  let i = headerIdx + 1

  while (i < rows.length) {
    const row = rows[i]
    const col0 = String(row[0] || '').trim()
    if (col0.startsWith('WK') && !col0.startsWith(prefix)) break

    if (col0.startsWith('>> ')) {
      const label = col0.replace('>> ', '').replace(/\s*[—\-–].*$/, '').trim()
      if (label.toUpperCase().includes('SATURDAY') || label.toUpperCase().includes('SUNDAY')) { i++; continue }
      if (currentSection) sections.push(currentSection)
      currentSection = { label, machines: [] }
      i++; continue
    }

    if (col0.includes('TOTAL') || col0.startsWith('──') || col0 === '' ||
        col0 === 'Budget/Day' || col0 === 'Bgt/Day') { i++; continue }

    const budget = parseFloat(row[1]) || 0
    // Weekday rows have data in col index 5 (Sched Tue); weekend rows don't
    const isWeekday = budget > 0 && currentSection && row[5] !== '' && row[5] !== undefined
    if (isWeekday) {
      const days = BNY_DAY_COLS.map(d => ({
        sched:  parseNum(row[d.sched])  ?? 0,
        actual: parseNum(row[d.actual]),
        op:     String(row[d.op] || '').trim() || null,
      }))
      const wkSched  = parseNum(row[BNY_WK_SCHED])  ?? 0
      const wkActual = parseNum(row[BNY_WK_ACTUAL])
      currentSection.machines.push({ name: col0, budget, days, wkSched, wkActual })
    }
    i++
  }
  if (currentSection) sections.push(currentSection)
  return { dayDates, sections, dayCols: BNY_DAY_COLS }
}

function parseNJWeek(rows, weekNum) {
  const prefix = `WK${weekNum}`
  const headerIdx = rows.findIndex(r => r[0] && String(r[0]).trim().startsWith(prefix))
  if (headerIdx === -1) return null

  const hdr = rows[headerIdx]
  const dayDates = NJ_DAY_COLS.map(d => String(hdr[d.sched] || '').replace(/^[SA]:/, ''))

  const sections = []
  let currentSection = null
  let i = headerIdx + 1

  while (i < rows.length) {
    const row = rows[i]
    const col0 = String(row[0] || '').trim()
    if (col0.startsWith('WK') && !col0.startsWith(prefix)) break

    if (col0.startsWith('>> ')) {
      const label = col0.replace('>> ', '').replace(/\s*[—\-–].*$/, '').trim()
      if (label.toUpperCase().includes('SATURDAY')) { i++; continue }
      if (currentSection) sections.push(currentSection)
      currentSection = { label, machines: [] }
      i++; continue
    }

    if (col0.includes('TOTAL') || col0.startsWith('──') || col0 === '' ||
        col0 === 'Budget/Day' || col0 === 'Bgt/Day') { i++; continue }

    const budget = parseFloat(row[1]) || 0
    const isWeekday = budget > 0 && currentSection && row[6] !== '' && row[6] !== undefined
    if (isWeekday) {
      const days = NJ_DAY_COLS.map(d => ({
        sched:  parseNum(row[d.sched])  ?? 0,
        actual: parseNum(row[d.actual]),
        op1:    String(row[d.op1] || '').trim() || null,
        op2:    String(row[d.op2] || '').trim() || null,
      }))
      const wkSched  = parseNum(row[NJ_WK_SCHED])  ?? 0
      const wkActual = parseNum(row[NJ_WK_ACTUAL])
      currentSection.machines.push({ name: col0, budget, days, wkSched, wkActual })
    }
    i++
  }
  if (currentSection) sections.push(currentSection)
  return { dayDates, sections, dayCols: NJ_DAY_COLS }
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  container:   { padding: '24px', fontFamily: 'Georgia, serif', background: '#FAF7F2', minHeight: '100vh' },
  header:      { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 },
  title:       { fontSize: 22, fontWeight: 'bold', color: '#2C2420' },
  badge:       { display: 'inline-block', background: '#2C2420', color: '#D4A843', borderRadius: 4, padding: '2px 10px', fontSize: 12, fontWeight: 'bold', marginLeft: 10 },
  subheader:   { fontSize: 13, color: '#9C8F87', marginBottom: 24 },
  refreshBtn:  { background: 'none', border: '1px solid #E8DDD0', borderRadius: 4, padding: '4px 12px', fontSize: 12, color: '#9C8F87', cursor: 'pointer' },
  facilityHdr: { display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 12, marginTop: 32 },
  facilityTitle: { fontSize: 16, fontWeight: 'bold', color: '#2C2420' },
  facilitySub: { fontSize: 13, color: '#9C8F87' },
  sectionHdr:  { background: '#E8DDD0', padding: '6px 12px', fontWeight: 'bold', fontSize: 12, color: '#5C4F47', letterSpacing: '0.05em', textTransform: 'uppercase', borderRadius: '4px 4px 0 0' },
  tableWrap:   { overflowX: 'auto', marginBottom: 28 },
  table:       { width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#fff', border: '1px solid #E8DDD0' },
  thDark:      { background: '#2C2420', color: '#D4A843', padding: '7px 8px', fontWeight: 'bold', fontSize: 11, textAlign: 'center', whiteSpace: 'nowrap' },
  thDarkLeft:  { background: '#2C2420', color: '#D4A843', padding: '7px 12px', fontWeight: 'bold', fontSize: 11, textAlign: 'left', whiteSpace: 'nowrap' },
  thDay:       (isToday) => ({ background: isToday ? '#3A2E1A' : '#2C2420', color: isToday ? '#FAD47C' : '#D4A843', padding: '7px 8px', fontWeight: 'bold', fontSize: 11, textAlign: 'center', borderLeft: isToday ? '2px solid #D4A843' : '1px solid #3C3028', whiteSpace: 'nowrap' }),
  td:          { padding: '6px 12px', borderBottom: '1px solid #F2EDE4', color: '#2C2420', fontWeight: 500 },
  tdCenter:    { padding: '6px 8px', borderBottom: '1px solid #F2EDE4', textAlign: 'center' },
  tdMuted:     { padding: '6px 8px', borderBottom: '1px solid #F2EDE4', color: '#9C8F87', textAlign: 'center', fontSize: 11 },
  subtotalTd:  { padding: '5px 12px', background: '#EDE5DC', color: '#5C4F47', fontWeight: 'bold', fontStyle: 'italic', fontSize: 11 },
  subtotalNum: { padding: '5px 8px', background: '#EDE5DC', color: '#5C4F47', fontWeight: 'bold', textAlign: 'center', fontSize: 11 },
  totalTd:     { padding: '6px 12px', background: '#DDD4C8', color: '#2C2420', fontWeight: 'bold' },
  totalNum:    { padding: '6px 8px', background: '#DDD4C8', color: '#2C2420', fontWeight: 'bold', textAlign: 'center' },
  error:       { background: '#FFF3E0', border: '1px solid #FFB74D', borderRadius: 8, padding: 16, color: '#E65100', marginBottom: 16 },
  info:        { background: '#F2EDE4', border: '1px solid #E8DDD0', borderRadius: 8, padding: 16, color: '#9C8F87', fontSize: 13 },
  loading:     { color: '#9C8F87', padding: 40, textAlign: 'center', fontSize: 14 },
  todayBorder: '2px solid #D4A843',
  op:          { fontSize: 10, color: '#5C8A5C', fontStyle: 'italic', marginTop: 1 },
}

function fmtNum(n) { return n !== null && n !== undefined ? Number(n).toLocaleString() : '—' }

function overUnder(actual, sched) {
  if (actual === null || !sched) return null
  return actual - sched
}

function DayCell({ sched, actual, op, op2, isToday, isNJ }) {
  const ou = overUnder(actual, sched)
  const hasActual = actual !== null
  const pct = hasActual && sched > 0 ? Math.round((actual / sched) * 100) : null
  const ouColor = ou === null ? '#9C8F87' : ou >= 0 ? '#2E7D32' : '#C62828'
  const cellBg = isToday ? 'rgba(212,168,67,0.07)' : 'transparent'
  const borderLeft = isToday ? S.todayBorder : '1px solid #F2EDE4'

  return (
    <td style={{ padding: '5px 6px', borderBottom: '1px solid #F2EDE4', borderLeft, background: cellBg, textAlign: 'center', minWidth: 80 }}>
      <div style={{ fontSize: 11, color: '#B0A89F' }}>{fmtNum(sched)}</div>
      <div style={{ fontSize: 13, fontWeight: hasActual ? 'bold' : 'normal', color: hasActual ? '#2C2420' : '#D0C8C0' }}>
        {hasActual ? fmtNum(actual) : '·'}
      </div>
      {ou !== null && (
        <div style={{ fontSize: 10, color: ouColor, fontWeight: 'bold' }}>
          {ou >= 0 ? '+' : ''}{fmtNum(ou)}
        </div>
      )}
      {op && <div style={S.op}>{op}</div>}
      {op2 && <div style={S.op}>{op2}</div>}
    </td>
  )
}

function WkTotalCell({ wkSched, wkActual, daysWithActuals }) {
  const ou = overUnder(wkActual, daysWithActuals > 0 ? (wkSched / 5) * daysWithActuals : null)
  const pct = wkActual !== null && wkSched > 0 ? Math.round((wkActual / wkSched) * 100) : null
  const ouColor = ou === null ? '#9C8F87' : ou >= 0 ? '#2E7D32' : '#C62828'

  return (
    <td style={{ padding: '5px 8px', borderBottom: '1px solid #F2EDE4', borderLeft: '2px solid #E8DDD0', textAlign: 'center', minWidth: 85 }}>
      <div style={{ fontSize: 11, color: '#B0A89F' }}>{fmtNum(wkSched)}</div>
      <div style={{ fontSize: 13, fontWeight: wkActual !== null ? 'bold' : 'normal', color: wkActual !== null ? '#2C2420' : '#D0C8C0' }}>
        {wkActual !== null ? fmtNum(wkActual) : '·'}
      </div>
      {pct !== null && (
        <div style={{ fontSize: 10, color: pct >= 95 ? '#2E7D32' : '#E65100', fontWeight: 'bold' }}>{pct}%</div>
      )}
      {ou !== null && (
        <div style={{ fontSize: 10, color: ouColor }}>{ou >= 0 ? '+' : ''}{fmtNum(ou)} vs exp</div>
      )}
    </td>
  )
}

function FacilityTable({ facilityData, todayIdx, isNJ, budget }) {
  if (!facilityData || !facilityData.sections.length) return null
  const { dayDates, sections } = facilityData

  // Figure out how many days have actuals (for over/under expected calc)
  const daysWithActuals = todayIdx >= 0 ? todayIdx + 1 : 0

  // Grand totals
  const grandWkSched  = sections.reduce((s, sec) => s + sec.machines.reduce((ss, m) => ss + m.wkSched, 0), 0)
  const allNull = sections.every(sec => sec.machines.every(m => m.wkActual === null))
  const grandWkActual = allNull ? null : sections.reduce((s, sec) => s + sec.machines.reduce((ss, m) => ss + (m.wkActual || 0), 0), 0)
  const grandPct = grandWkActual !== null && grandWkSched > 0 ? Math.round((grandWkActual / grandWkSched) * 100) : null
  const grandOU = grandWkActual !== null && daysWithActuals > 0
    ? grandWkActual - Math.round((grandWkSched / 5) * daysWithActuals)
    : null

  return (
    <div>
      {sections.map((sec, si) => {
        const secWkSched  = sec.machines.reduce((s, m) => s + m.wkSched, 0)
        const secAllNull  = sec.machines.every(m => m.wkActual === null)
        const secWkActual = secAllNull ? null : sec.machines.reduce((s, m) => s + (m.wkActual || 0), 0)

        // Day totals for section
        const secDayTotals = (isNJ ? NJ_DAY_COLS : BNY_DAY_COLS).map((_, di) => ({
          sched:  sec.machines.reduce((s, m) => s + (m.days[di]?.sched || 0), 0),
          actual: sec.machines.every(m => m.days[di]?.actual === null)
            ? null
            : sec.machines.reduce((s, m) => s + (m.days[di]?.actual || 0), 0),
        }))

        return (
          <div key={si} style={{ marginBottom: 24 }}>
            <div style={S.sectionHdr}>▸ {sec.label}</div>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={{ ...S.thDarkLeft, minWidth: 130, position: 'sticky', left: 0 }}>Machine / Table</th>
                    <th style={{ ...S.thDark, minWidth: 55 }}>Bgt/Day</th>
                    {dayDates.map((date, di) => (
                      <th key={di} style={{ ...S.thDay(di === todayIdx), minWidth: 80 }}>
                        {(isNJ ? NJ_DAY_COLS : BNY_DAY_COLS)[di].label}<br/>
                        <span style={{ fontWeight: 'normal', fontSize: 10 }}>{date}</span><br/>
                        <span style={{ fontWeight: 'normal', fontSize: 9, color: '#888' }}>Sched/Act/+−</span>
                      </th>
                    ))}
                    <th style={{ ...S.thDark, minWidth: 85, borderLeft: '2px solid #5C4F47' }}>Week Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sec.machines.map((m, mi) => {
                    const rowBg = mi % 2 === 0 ? '#fff' : '#FAF7F2'
                    return (
                      <tr key={mi} style={{ background: rowBg }}>
                        <td style={{ ...S.td, background: rowBg, position: 'sticky', left: 0 }}>{m.name}</td>
                        <td style={{ ...S.tdMuted, background: rowBg }}>{m.budget}</td>
                        {m.days.map((day, di) => (
                          <DayCell
                            key={di}
                            sched={day.sched}
                            actual={day.actual}
                            op={day.op || day.op1}
                            op2={day.op2}
                            isToday={di === todayIdx}
                            isNJ={isNJ}
                          />
                        ))}
                        <WkTotalCell wkSched={m.wkSched} wkActual={m.wkActual} daysWithActuals={daysWithActuals} />
                      </tr>
                    )
                  })}
                  {/* Section subtotal */}
                  <tr>
                    <td style={{ ...S.subtotalTd, position: 'sticky', left: 0 }}>{sec.label} TOTAL</td>
                    <td style={S.subtotalNum}>—</td>
                    {secDayTotals.map((dt, di) => {
                      const ou = overUnder(dt.actual, dt.sched)
                      return (
                        <td key={di} style={{ ...S.subtotalNum, borderLeft: di === todayIdx ? S.todayBorder : '1px solid #E8DDD0', background: di === todayIdx ? 'rgba(212,168,67,0.08)' : '#EDE5DC' }}>
                          <div style={{ fontSize: 11 }}>{fmtNum(dt.sched)}</div>
                          <div>{dt.actual !== null ? fmtNum(dt.actual) : '·'}</div>
                          {ou !== null && <div style={{ fontSize: 10, color: ou >= 0 ? '#2E7D32' : '#C62828' }}>{ou >= 0 ? '+' : ''}{fmtNum(ou)}</div>}
                        </td>
                      )
                    })}
                    <td style={{ ...S.subtotalNum, borderLeft: '2px solid #C8BDB4' }}>
                      <div style={{ fontSize: 11 }}>{fmtNum(secWkSched)}</div>
                      <div>{secWkActual !== null ? fmtNum(secWkActual) : '·'}</div>
                      {secWkActual !== null && secWkSched > 0 && (
                        <div style={{ fontSize: 10, color: Math.round(secWkActual/secWkSched*100) >= 95 ? '#2E7D32' : '#E65100' }}>
                          {Math.round(secWkActual/secWkSched*100)}%
                        </div>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {/* Facility grand total bar */}
      <div style={{ background: '#DDD4C8', borderRadius: 6, padding: '10px 16px', display: 'flex', gap: 32, alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 'bold', color: '#2C2420', fontSize: 13 }}>WEEK TOTAL</div>
        <div style={{ fontSize: 13, color: '#2C2420' }}>
          <span style={{ color: '#9C8F87', fontSize: 11 }}>Sched </span>{fmtNum(grandWkSched)}
          <span style={{ margin: '0 12px', color: '#9C8F87' }}>·</span>
          <span style={{ color: '#9C8F87', fontSize: 11 }}>Actual </span>
          <span style={{ fontWeight: 'bold' }}>{grandWkActual !== null ? fmtNum(grandWkActual) : '—'}</span>
        </div>
        {grandPct !== null && (
          <div style={{ fontWeight: 'bold', color: grandPct >= 95 ? '#2E7D32' : '#E65100', fontSize: 13 }}>{grandPct}% of schedule</div>
        )}
        {grandOU !== null && (
          <div style={{ fontSize: 12, color: grandOU >= 0 ? '#2E7D32' : '#C62828', fontWeight: 'bold' }}>
            {grandOU >= 0 ? '+' : ''}{fmtNum(grandOU)} vs expected through {['Mon','Tue','Wed','Thu','Fri'][todayIdx]}
          </div>
        )}
        {budget && grandWkActual !== null && (
          <div style={{ fontSize: 12, color: '#9C8F87' }}>
            {Math.round(grandWkActual/budget*100)}% of {fmtNum(budget)} yd budget
          </div>
        )}
      </div>
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

  const todayIdx = (() => {
    const d = new Date().getDay()
    return d >= 1 && d <= 5 ? d - 1 : -1
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
        fetchSheetData(BNY_SHEET_ID, 'Schedule!A:T'),
        fetchSheetData(NJ_SHEET_ID,  'Schedule!A:Y'),
      ])

      setBnyData(parseBNYWeek(bnyRows, info.fiscalWeek))
      setNjData(parseNJWeek(njRows,    info.fiscalWeek))
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
    <div style={S.container}>
      <div style={S.header}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <div style={S.title}>Live Production</div>
          {weekNum && <span style={S.badge}>FY WK {weekNum}</span>}
          {weekInfo && <span style={{ fontSize: 13, color: '#9C8F87' }}>{weekInfo.month} · {weekInfo.quarter}</span>}
          {todayLabel && (
            <span style={{ fontSize: 12, background: 'rgba(212,168,67,0.15)', color: '#B8860B', borderRadius: 4, padding: '2px 8px', border: '1px solid rgba(212,168,67,0.3)' }}>
              Today: {todayLabel}
            </span>
          )}
        </div>
        <button onClick={() => loadData(weekStart)} style={S.refreshBtn}>↻ Refresh</button>
      </div>
      <div style={S.subheader}>
        Source: Google Sheets (live){lastRefresh && ` · Last loaded ${lastRefresh.toLocaleTimeString()}`}
        <span style={{ marginLeft: 16, fontSize: 11, color: '#C8BDB8' }}>Each cell: Sched / Actual / Over-Under · Operator shown in green</span>
      </div>

      {error && <div style={S.error}>⚠ {error}</div>}
      {loading && <div style={S.loading}>Loading production data from Google Sheets...</div>}

      {!loading && !error && (
        <>
          {bnyData && bnyData.sections.length > 0 && (
            <div>
              <div style={S.facilityHdr}>
                <div style={S.facilityTitle}>BNY — Digital Production</div>
              </div>
              <FacilityTable facilityData={bnyData} todayIdx={todayIdx} isNJ={false} budget={12000} />
            </div>
          )}

          {njData && njData.sections.length > 0 && (
            <div>
              <div style={S.facilityHdr}>
                <div style={S.facilityTitle}>NJ — Screen Print Production</div>
              </div>
              <FacilityTable facilityData={njData} todayIdx={todayIdx} isNJ={true} budget={8610} />
            </div>
          )}

          {(!bnyData || !bnyData.sections.length) && (!njData || !njData.sections.length) && (
            <div style={S.info}>
              No production data found for FY Week {weekNum}. The sheets cover Weeks 14–28 (Apr 6 – Jul 18).
            </div>
          )}
        </>
      )}
    </div>
  )
}
