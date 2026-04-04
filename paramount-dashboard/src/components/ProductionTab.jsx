import { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { getFiscalInfo } from '../fiscalCalendar'

const BNY_SHEET_ID = '1nVuGPNIxRCEHOLSr6v5OrwFZO7sWOZT2zeeB7CkX_Ys'
const NJ_SHEET_ID  = '1dT6mc8kKzcUJsUjHsFZdANMF_UpJ9LhEd0xQUj00I6k'
const API_KEY      = import.meta.env.VITE_GOOGLE_SHEETS_API_KEY
const WASTE_TARGET = 0.10  // 10%

// BNY: 4 cols per day (sched, actual, waste, op) — cols C-V (indices 2-21)
const BNY_DAYS = [
  { label:'Mon', sched:2,  actual:3,  waste:4,  op:5  },
  { label:'Tue', sched:6,  actual:7,  waste:8,  op:9  },
  { label:'Wed', sched:10, actual:11, waste:12, op:13 },
  { label:'Thu', sched:14, actual:15, waste:16, op:17 },
  { label:'Fri', sched:18, actual:19, waste:20, op:21 },
]
const BNY_WK_SCHED=22, BNY_WK_ACTUAL=23, BNY_WK_WASTE=24

// NJ: 5 cols per day (sched, actual, waste, op1, op2) — cols C-AA (indices 2-26)
const NJ_DAYS = [
  { label:'Mon', sched:2,  actual:3,  waste:4,  op1:5,  op2:6  },
  { label:'Tue', sched:7,  actual:8,  waste:9,  op1:10, op2:11 },
  { label:'Wed', sched:12, actual:13, waste:14, op1:15, op2:16 },
  { label:'Thu', sched:17, actual:18, waste:19, op1:20, op2:21 },
  { label:'Fri', sched:22, actual:23, waste:24, op1:25, op2:26 },
]
const NJ_WK_SCHED=27, NJ_WK_ACTUAL=28, NJ_WK_WASTE=29

async function fetchSheet(sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?key=${API_KEY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`)
  return (await res.json()).values || []
}

function num(val) {
  if (val === '' || val === undefined || val === null) return null
  const n = parseFloat(String(val).replace(/,/g,''))
  return isNaN(n) ? null : n
}

function str(val) { return String(val || '').trim() || null }

function parseWeek(rows, weekNum, dayCols, wkSched, wkActual, wkWaste) {
  const prefix = `WK${weekNum}`
  const hi = rows.findIndex(r => r[0] && String(r[0]).trim().startsWith(prefix))
  if (hi === -1) return null

  const hdr = rows[hi]
  const dayDates = dayCols.map(d => String(hdr[d.sched] || '').replace(/^[SAW]:/, ''))

  const sections = []
  let sec = null, i = hi + 1
  const isNJ = dayCols === NJ_DAYS

  while (i < rows.length) {
    const row = rows[i]
    const c0 = String(row[0] || '').trim()
    if (c0.startsWith('WK') && !c0.startsWith(prefix)) break

    if (c0.startsWith('>> ')) {
      const label = c0.replace('>> ','').replace(/\s*[—\-–].*$/,'').trim()
      if (/saturday|sunday/i.test(label)) { i++; continue }
      if (sec) sections.push(sec)
      sec = { label, machines: [] }
      i++; continue
    }

    if (c0.includes('TOTAL') || c0.startsWith('──') || c0 === '' ||
        c0 === 'Budget/Day' || c0 === 'Bgt/Day') { i++; continue }

    const budget = parseFloat(row[1]) || 0
    // Weekday detection: second sched col has a value
    const isWeekday = budget > 0 && sec && row[dayCols[1].sched] !== '' && row[dayCols[1].sched] !== undefined

    if (isWeekday) {
      const days = dayCols.map(d => ({
        sched:  num(row[d.sched])  ?? 0,
        actual: num(row[d.actual]),
        waste:  num(row[d.waste]),
        op:     str(row[d.op]),
        op2:    isNJ ? str(row[d.op2]) : null,
      }))
      sec.machines.push({
        name: c0, budget, days,
        wkSched:  num(row[wkSched])  ?? 0,
        wkActual: num(row[wkActual]),
        wkWaste:  num(row[wkWaste]),
      })
    }
    i++
  }
  if (sec) sections.push(sec)
  return { dayDates, sections }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = n => n !== null && n !== undefined ? Number(n).toLocaleString() : '—'
const pct = (a, b) => a !== null && b && b > 0 ? Math.round(a/b*100) : null

function WasteTag({ waste, actual }) {
  if (waste === null || waste === 0) return null
  const p = pct(waste, actual)
  const over = p !== null && p > WASTE_TARGET * 100
  return (
    <div style={{ fontSize: 10, color: over ? '#C62828' : '#2E7D32', fontWeight: 'bold' }}>
      {fmt(waste)}w {p !== null ? `(${p}%)` : ''}
      {over ? ' ↑' : ' ✓'}
    </div>
  )
}

function DayCell({ day, isToday }) {
  const hasActual = day.actual !== null
  const ou = hasActual ? day.actual - day.sched : null
  const ouColor = ou === null ? '#9C8F87' : ou >= 0 ? '#2E7D32' : '#C62828'
  const bg = isToday ? 'rgba(212,168,67,0.07)' : 'transparent'
  const bl = isToday ? '2px solid #D4A843' : '1px solid #F2EDE4'
  return (
    <td style={{ padding:'5px 6px', borderBottom:'1px solid #F2EDE4', borderLeft:bl, background:bg, textAlign:'center', minWidth:85, verticalAlign:'top' }}>
      <div style={{ fontSize:11, color:'#B0A89F' }}>{fmt(day.sched)}</div>
      <div style={{ fontSize:13, fontWeight:hasActual?'bold':'normal', color:hasActual?'#2C2420':'#D0C8C0' }}>
        {hasActual ? fmt(day.actual) : '·'}
      </div>
      {ou !== null && <div style={{ fontSize:10, color:ouColor, fontWeight:'bold' }}>{ou>=0?'+':''}{fmt(ou)}</div>}
      <WasteTag waste={day.waste} actual={day.actual} />
      {day.op  && <div style={{ fontSize:10, color:'#5C8A5C', fontStyle:'italic', marginTop:2 }}>{day.op}</div>}
      {day.op2 && <div style={{ fontSize:10, color:'#5C8A5C', fontStyle:'italic' }}>{day.op2}</div>}
    </td>
  )
}

function WkCell({ wkSched, wkActual, wkWaste, daysIn }) {
  const p = pct(wkActual, wkSched)
  const expSched = daysIn > 0 ? Math.round(wkSched / 5 * daysIn) : null
  const ou = wkActual !== null && expSched !== null ? wkActual - expSched : null
  const ouColor = ou === null ? '#9C8F87' : ou >= 0 ? '#2E7D32' : '#C62828'
  const wastePct = pct(wkWaste, wkActual)
  const wasteOver = wastePct !== null && wastePct > WASTE_TARGET * 100
  return (
    <td style={{ padding:'5px 8px', borderBottom:'1px solid #F2EDE4', borderLeft:'2px solid #E8DDD0', textAlign:'center', minWidth:90, verticalAlign:'top' }}>
      <div style={{ fontSize:11, color:'#B0A89F' }}>{fmt(wkSched)}</div>
      <div style={{ fontSize:13, fontWeight:wkActual!==null?'bold':'normal', color:wkActual!==null?'#2C2420':'#D0C8C0' }}>
        {wkActual !== null ? fmt(wkActual) : '·'}
      </div>
      {p !== null && <div style={{ fontSize:10, color:p>=95?'#2E7D32':'#E65100', fontWeight:'bold' }}>{p}%</div>}
      {ou !== null && <div style={{ fontSize:10, color:ouColor }}>{ou>=0?'+':''}{fmt(ou)} vs exp</div>}
      {wkWaste !== null && wkWaste > 0 && (
        <div style={{ fontSize:10, color:wasteOver?'#C62828':'#2E7D32', marginTop:2 }}>
          {fmt(wkWaste)}w{wastePct!==null?` (${wastePct}%)`:''}{wasteOver?' ↑':' ✓'}
        </div>
      )}
    </td>
  )
}

function SectionTable({ sec, dayDates, dayCols, todayIdx, daysIn }) {
  const dayTotals = dayCols.map((_, di) => ({
    sched:  sec.machines.reduce((s,m)=>s+(m.days[di]?.sched||0),0),
    actual: sec.machines.every(m=>m.days[di]?.actual===null) ? null : sec.machines.reduce((s,m)=>s+(m.days[di]?.actual||0),0),
    waste:  sec.machines.every(m=>!m.days[di]?.waste) ? null : sec.machines.reduce((s,m)=>s+(m.days[di]?.waste||0),0),
  }))
  const secSched  = sec.machines.reduce((s,m)=>s+m.wkSched,0)
  const secActual = sec.machines.every(m=>m.wkActual===null) ? null : sec.machines.reduce((s,m)=>s+(m.wkActual||0),0)
  const secWaste  = sec.machines.every(m=>!m.wkWaste) ? null : sec.machines.reduce((s,m)=>s+(m.wkWaste||0),0)

  return (
    <div style={{ marginBottom:20 }}>
      <div style={{ background:'#E8DDD0', padding:'6px 12px', fontWeight:'bold', fontSize:12, color:'#5C4F47', letterSpacing:'0.05em', textTransform:'uppercase', borderRadius:'4px 4px 0 0' }}>
        ▸ {sec.label}
      </div>
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12, background:'#fff', border:'1px solid #E8DDD0' }}>
          <thead>
            <tr>
              <th style={{ background:'#2C2420', color:'#D4A843', padding:'7px 12px', textAlign:'left', fontSize:11, fontWeight:'bold', minWidth:130, position:'sticky', left:0 }}>Machine / Table</th>
              <th style={{ background:'#2C2420', color:'#D4A843', padding:'7px 8px', textAlign:'center', fontSize:11, fontWeight:'bold', minWidth:55 }}>Bgt/Day</th>
              {dayDates.map((date, di) => (
                <th key={di} style={{ background: di===todayIdx?'#3A2E1A':'#2C2420', color: di===todayIdx?'#FAD47C':'#D4A843', padding:'7px 8px', textAlign:'center', fontSize:11, fontWeight:'bold', minWidth:85, borderLeft: di===todayIdx?'2px solid #D4A843':'1px solid #3C3028' }}>
                  {dayCols[di].label} {date}<br/>
                  <span style={{ fontWeight:'normal', fontSize:9, color:'#888' }}>Sched/Act/+− · Waste · Op</span>
                </th>
              ))}
              <th style={{ background:'#2C2420', color:'#D4A843', padding:'7px 8px', textAlign:'center', fontSize:11, fontWeight:'bold', minWidth:90, borderLeft:'2px solid #5C4F47' }}>Week Total</th>
            </tr>
          </thead>
          <tbody>
            {sec.machines.map((m, mi) => {
              const bg = mi%2===0?'#fff':'#FAF7F2'
              return (
                <tr key={mi} style={{ background:bg }}>
                  <td style={{ padding:'6px 12px', borderBottom:'1px solid #F2EDE4', color:'#2C2420', fontWeight:500, background:bg, position:'sticky', left:0 }}>{m.name}</td>
                  <td style={{ padding:'6px 8px', borderBottom:'1px solid #F2EDE4', color:'#9C8F87', textAlign:'center', background:bg }}>{m.budget}</td>
                  {m.days.map((day, di) => <DayCell key={di} day={day} isToday={di===todayIdx} />)}
                  <WkCell wkSched={m.wkSched} wkActual={m.wkActual} wkWaste={m.wkWaste} daysIn={daysIn} />
                </tr>
              )
            })}
            <tr>
              <td colSpan={2} style={{ padding:'5px 12px', background:'#EDE5DC', color:'#5C4F47', fontWeight:'bold', fontStyle:'italic', fontSize:11, position:'sticky', left:0 }}>{sec.label} TOTAL</td>
              {dayTotals.map((dt, di) => {
                const ou = dt.actual !== null ? dt.actual - dt.sched : null
                const wp = pct(dt.waste, dt.actual)
                return (
                  <td key={di} style={{ padding:'5px 6px', background: di===todayIdx?'rgba(212,168,67,0.1)':'#EDE5DC', borderLeft: di===todayIdx?'2px solid #D4A843':'1px solid #E8DDD0', textAlign:'center', fontSize:11 }}>
                    <div style={{ color:'#9C8F87' }}>{fmt(dt.sched)}</div>
                    <div style={{ fontWeight:'bold', color:'#5C4F47' }}>{dt.actual!==null?fmt(dt.actual):'·'}</div>
                    {ou!==null && <div style={{ fontSize:10, color:ou>=0?'#2E7D32':'#C62828' }}>{ou>=0?'+':''}{fmt(ou)}</div>}
                    {dt.waste!==null && dt.waste>0 && <div style={{ fontSize:10, color:wp&&wp>10?'#C62828':'#2E7D32' }}>{fmt(dt.waste)}w</div>}
                  </td>
                )
              })}
              <td style={{ padding:'5px 8px', background:'#EDE5DC', borderLeft:'2px solid #C8BDB4', textAlign:'center', fontSize:11 }}>
                <div style={{ color:'#9C8F87' }}>{fmt(secSched)}</div>
                <div style={{ fontWeight:'bold', color:'#5C4F47' }}>{secActual!==null?fmt(secActual):'·'}</div>
                {secActual!==null && secSched>0 && <div style={{ fontSize:10, color:Math.round(secActual/secSched*100)>=95?'#2E7D32':'#E65100' }}>{Math.round(secActual/secSched*100)}%</div>}
                {secWaste!==null && secWaste>0 && <div style={{ fontSize:10, color:pct(secWaste,secActual)>10?'#C62828':'#2E7D32' }}>{fmt(secWaste)}w ({pct(secWaste,secActual)}%)</div>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FacilityBlock({ title, data, dayCols, wkSched, wkActual, wkWaste, todayIdx, budget }) {
  if (!data || !data.sections.length) return null
  const { dayDates, sections } = data
  const daysIn = todayIdx >= 0 ? todayIdx + 1 : 0

  const grandSched  = sections.reduce((s,sec)=>s+sec.machines.reduce((ss,m)=>ss+m.wkSched,0),0)
  const allNull     = sections.every(sec=>sec.machines.every(m=>m.wkActual===null))
  const grandActual = allNull ? null : sections.reduce((s,sec)=>s+sec.machines.reduce((ss,m)=>ss+(m.wkActual||0),0),0)
  const noWaste     = sections.every(sec=>sec.machines.every(m=>!m.wkWaste))
  const grandWaste  = noWaste ? null : sections.reduce((s,sec)=>s+sec.machines.reduce((ss,m)=>ss+(m.wkWaste||0),0),0)

  const grandPct   = pct(grandActual, grandSched)
  const expSched   = daysIn > 0 ? Math.round(grandSched / 5 * daysIn) : null
  const grandOU    = grandActual !== null && expSched !== null ? grandActual - expSched : null
  const wastePct   = pct(grandWaste, grandActual)
  const wasteOver  = wastePct !== null && wastePct > WASTE_TARGET * 100
  const budgetPct  = pct(grandActual, budget)

  return (
    <div style={{ marginBottom:40 }}>
      <div style={{ fontSize:16, fontWeight:'bold', color:'#2C2420', marginBottom:12, fontFamily:'Georgia, serif' }}>{title}</div>
      {sections.map((sec, si) => (
        <SectionTable key={si} sec={sec} dayDates={dayDates} dayCols={dayCols} todayIdx={todayIdx} daysIn={daysIn} />
      ))}
      <div style={{ background:'#DDD4C8', borderRadius:6, padding:'10px 16px', display:'flex', gap:24, alignItems:'center', flexWrap:'wrap' }}>
        <div style={{ fontWeight:'bold', color:'#2C2420', fontSize:13 }}>WEEK TOTAL</div>
        <div style={{ fontSize:13 }}>
          <span style={{ color:'#9C8F87', fontSize:11 }}>Sched </span>{fmt(grandSched)}
          <span style={{ margin:'0 10px', color:'#9C8F87' }}>·</span>
          <span style={{ color:'#9C8F87', fontSize:11 }}>Actual </span>
          <span style={{ fontWeight:'bold' }}>{grandActual !== null ? fmt(grandActual) : '—'}</span>
        </div>
        {grandPct !== null && (
          <div style={{ fontWeight:'bold', color:grandPct>=95?'#2E7D32':'#E65100', fontSize:13 }}>{grandPct}% of schedule</div>
        )}
        {grandOU !== null && (
          <div style={{ fontSize:12, color:grandOU>=0?'#2E7D32':'#C62828', fontWeight:'bold' }}>
            {grandOU>=0?'+':''}{fmt(grandOU)} vs expected thru {['Mon','Tue','Wed','Thu','Fri'][todayIdx]}
          </div>
        )}
        {grandWaste !== null && grandWaste > 0 && (
          <div style={{ fontSize:12, color:wasteOver?'#C62828':'#2E7D32', fontWeight:'bold' }}>
            Waste: {fmt(grandWaste)} yds ({wastePct}%) {wasteOver ? '↑ above 10% target' : '✓ within target'}
          </div>
        )}
        {budget && grandActual !== null && (
          <div style={{ fontSize:12, color:'#9C8F87' }}>{budgetPct}% of {fmt(budget)} yd budget</div>
        )}
      </div>
    </div>
  )
}

export default function ProductionTab({ weekStart }) {
  const [bny,  setBny]  = useState(null)
  const [nj,   setNj]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [weekNum, setWeekNum] = useState(null)
  const [weekInfo, setWeekInfo] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const todayIdx = (() => { const d = new Date().getDay(); return d>=1&&d<=5 ? d-1 : -1 })()

  async function loadData(ws) {
    setLoading(true); setError(null)
    try {
      const key = format(ws, 'yyyy-MM-dd')
      const info = getFiscalInfo(key)
      if (!info) { setError('No fiscal week found. Sheets cover Weeks 14–28 (Apr 6 – Jul 18).'); setLoading(false); return }
      setWeekNum(info.fiscalWeek); setWeekInfo(info)

      const [bnyRows, njRows] = await Promise.all([
        fetchSheet(BNY_SHEET_ID, 'Schedule!A:W'),
        fetchSheet(NJ_SHEET_ID,  'Schedule!A:AB'),
      ])

      setBny(parseWeek(bnyRows, info.fiscalWeek, BNY_DAYS, BNY_WK_SCHED, BNY_WK_ACTUAL, BNY_WK_WASTE))
      setNj(parseWeek(njRows,   info.fiscalWeek, NJ_DAYS,  NJ_WK_SCHED,  NJ_WK_ACTUAL,  NJ_WK_WASTE))
      setLastRefresh(new Date())
    } catch(e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { if (weekStart) loadData(weekStart) }, [weekStart])

  const todayLabel = todayIdx >= 0 ? ['Mon','Tue','Wed','Thu','Fri'][todayIdx] : null

  return (
    <div style={{ padding:24, fontFamily:'Georgia, serif', background:'#FAF7F2', minHeight:'100vh' }}>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:4 }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:12 }}>
          <div style={{ fontSize:22, fontWeight:'bold', color:'#2C2420' }}>Live Production</div>
          {weekNum && <span style={{ background:'#2C2420', color:'#D4A843', borderRadius:4, padding:'2px 10px', fontSize:12, fontWeight:'bold' }}>FY WK {weekNum}</span>}
          {weekInfo && <span style={{ fontSize:13, color:'#9C8F87' }}>{weekInfo.month} · {weekInfo.quarter}</span>}
          {todayLabel && <span style={{ fontSize:12, background:'rgba(212,168,67,0.15)', color:'#B8860B', borderRadius:4, padding:'2px 8px', border:'1px solid rgba(212,168,67,0.3)' }}>Today: {todayLabel}</span>}
        </div>
        <button onClick={() => loadData(weekStart)} style={{ background:'none', border:'1px solid #E8DDD0', borderRadius:4, padding:'4px 12px', fontSize:12, color:'#9C8F87', cursor:'pointer' }}>↻ Refresh</button>
      </div>
      <div style={{ fontSize:13, color:'#9C8F87', marginBottom:24 }}>
        Source: Google Sheets (live){lastRefresh && ` · Last loaded ${lastRefresh.toLocaleTimeString()}`}
        <span style={{ marginLeft:16, fontSize:11, color:'#C8BDB8' }}>Each cell: Sched / Actual / +− · Waste yds (%) · Operator · Waste target &lt;10%</span>
      </div>

      {error   && <div style={{ background:'#FFF3E0', border:'1px solid #FFB74D', borderRadius:8, padding:16, color:'#E65100', marginBottom:16 }}>⚠ {error}</div>}
      {loading && <div style={{ color:'#9C8F87', padding:40, textAlign:'center', fontSize:14 }}>Loading production data from Google Sheets...</div>}

      {!loading && !error && (
        <>
          <FacilityBlock title="BNY — Digital Production"      data={bny} dayCols={BNY_DAYS} wkSched={BNY_WK_SCHED} wkActual={BNY_WK_ACTUAL} wkWaste={BNY_WK_WASTE} todayIdx={todayIdx} budget={12000} />
          <FacilityBlock title="NJ — Screen Print Production"  data={nj}  dayCols={NJ_DAYS}  wkSched={NJ_WK_SCHED}  wkActual={NJ_WK_ACTUAL}  wkWaste={NJ_WK_WASTE}  todayIdx={todayIdx} budget={8610}  />
          {(!bny||!bny.sections.length) && (!nj||!nj.sections.length) && (
            <div style={{ background:'#F2EDE4', border:'1px solid #E8DDD0', borderRadius:8, padding:16, color:'#9C8F87', fontSize:13 }}>
              No production data found for FY Week {weekNum}. Sheets cover Weeks 14–28 (Apr 6 – Jul 18).
            </div>
          )}
        </>
      )}
    </div>
  )
}
