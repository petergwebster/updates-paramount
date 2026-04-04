import { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { getFiscalInfo } from '../fiscalCalendar'

const BNY_SHEET_ID = '1nVuGPNIxRCEHOLSr6v5OrwFZO7sWOZT2zeeB7CkX_Ys'
const NJ_SHEET_ID  = '1dT6mc8kKzcUJsUjHsFZdANMF_UpJ9LhEd0xQUj00I6k'
const API_KEY      = import.meta.env.VITE_GOOGLE_SHEETS_API_KEY
const WASTE_TARGET = 0.10
const BNY_BUDGET   = 12000
const NJ_BUDGET    = 8610

const BNY_DAYS = [
  { label:'Mon', sched:2,  actual:3,  waste:4,  op:5  },
  { label:'Tue', sched:6,  actual:7,  waste:8,  op:9  },
  { label:'Wed', sched:10, actual:11, waste:12, op:13 },
  { label:'Thu', sched:14, actual:15, waste:16, op:17 },
  { label:'Fri', sched:18, actual:19, waste:20, op:21 },
]
const BNY_WK_SCHED=22, BNY_WK_ACTUAL=23, BNY_WK_WASTE=24

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

function num(v) {
  if (v===''||v===undefined||v===null) return null
  const n = parseFloat(String(v).replace(/,/g,''))
  return isNaN(n) ? null : n
}
function str(v) { return String(v||'').trim()||null }
const fmt  = n => n!==null&&n!==undefined ? Number(n).toLocaleString() : '—'
const pct  = (a,b) => a!==null&&b&&b>0 ? Math.round(a/b*100) : null

function parseWeek(rows, weekNum, dayCols, wkSched, wkActual, wkWaste, isNJ) {
  const prefix = `WK${weekNum}`
  const hi = rows.findIndex(r => r[0] && String(r[0]).trim().startsWith(prefix))
  if (hi===-1) return null
  const hdr = rows[hi]
  const dayDates = dayCols.map(d => String(hdr[d.sched]||'').replace(/^[SAW]:?/,''))
  const sections=[], ops={}
  let sec=null, i=hi+1
  while (i<rows.length) {
    const row=rows[i], c0=String(row[0]||'').trim()
    if (c0.startsWith('WK')&&!c0.startsWith(prefix)) break
    if (c0.startsWith('>> ')) {
      const label=c0.replace('>> ','').replace(/\s*[—\-–].*$/,'').trim()
      if (/saturday|sunday/i.test(label)) { i++; continue }
      if (sec) sections.push(sec)
      sec={label, machines:[]}; i++; continue
    }
    if (c0.includes('TOTAL')||c0.startsWith('──')||c0===''||c0==='Budget/Day'||c0==='Bgt/Day') { i++; continue }
    const budget=parseFloat(row[1])||0
    const isWeekday=budget>0&&sec&&row[dayCols[1].sched]!==''&&row[dayCols[1].sched]!==undefined
    if (isWeekday) {
      const days=dayCols.map(d => {
        const a=num(row[d.actual]), o=str(row[d.op]), o2=isNJ?str(row[d.op2]):null
        if (a!==null) {
          if (o) { if(!ops[o]) ops[o]={yds:0,days:0}; ops[o].yds+=a; ops[o].days++ }
          if (o2) { if(!ops[o2]) ops[o2]={yds:0,days:0}; ops[o2].yds+=a; ops[o2].days++ }
        }
        return { sched:num(row[d.sched])??0, actual:a, waste:num(row[d.waste]), op:o, op2:o2 }
      })
      sec.machines.push({ name:c0, budget, days, wkSched:num(row[wkSched])??0, wkActual:num(row[wkActual]), wkWaste:num(row[wkWaste]) })
    }
    i++
  }
  if (sec) sections.push(sec)
  return {dayDates, sections, ops}
}

function calcTotals(data, budget, daysIn) {
  if (!data||!data.sections.length) return null
  const all = data.sections.flatMap(s=>s.machines)
  const wkSched   = all.reduce((s,m)=>s+m.wkSched,0)
  const allNull   = all.every(m=>m.wkActual===null)
  const wkActual  = allNull ? null : all.reduce((s,m)=>s+(m.wkActual||0),0)
  const noWaste   = all.every(m=>!m.wkWaste)
  const wkWaste   = noWaste ? null : all.reduce((s,m)=>s+(m.wkWaste||0),0)
  const schedPct  = pct(wkActual, wkSched)
  const budgetPct = pct(wkActual, budget)
  const wastePct  = pct(wkWaste, wkActual)
  const exp       = daysIn>0 ? Math.round(wkSched/5*daysIn) : null
  const overUnder = wkActual!==null&&exp!==null ? wkActual-exp : null
  return { wkSched, wkActual, wkWaste, schedPct, budgetPct, wastePct, overUnder, wasteOver: wastePct!==null&&wastePct>WASTE_TARGET*100 }
}

function calcPrinterStats(bnyOps, njOps) {
  const all = {}
  Object.entries(bnyOps||{}).forEach(([name,d])=>{ all[name]={...(all[name]||{yds:0,days:0}),facility:'BNY'}; all[name].yds+=d.yds; all[name].days+=d.days })
  Object.entries(njOps||{}).forEach(([name,d])=>{ all[name]={...(all[name]||{yds:0,days:0}),facility:'NJ'}; all[name].yds+=d.yds; all[name].days+=d.days })
  const ranked = Object.entries(all).filter(([,d])=>d.yds>0).sort((a,b)=>b[1].yds-a[1].yds)
  if (!ranked.length) return null
  const totalYds = ranked.reduce((s,[,d])=>s+d.yds,0)
  const avgYds   = Math.round(totalYds / ranked.length)
  const top      = ranked[0]
  const topAvg   = top[1].days>0 ? Math.round(top[1].yds/top[1].days) : 0
  return { topName: top[0], topYds: top[1].yds, topAvg, count: ranked.length, avgYds, facility: top[1].facility }
}

// ── KPI Bar ───────────────────────────────────────────────────────────────────
const pctColor  = p => p===null ? 'rgba(250,247,242,0.5)' : p>=95 ? '#6FCF97' : p>=80 ? '#F2C94C' : '#EB5757'
const wasteColor= p => p===null ? 'rgba(250,247,242,0.5)' : p<=10  ? '#6FCF97' : '#EB5757'
const ouFmt     = ou => ou===null ? null : `${ou>=0?'+':''}${Number(ou).toLocaleString()}`

function Bubble({ label, value, sub, color }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', background:'rgba(255,255,255,0.06)', borderRadius:7, padding:'7px 12px', minWidth:88, gap:1 }}>
      <div style={{ fontSize:9, color:'rgba(212,168,67,0.65)', fontWeight:'bold', letterSpacing:'0.07em', textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</div>
      <div style={{ fontSize:15, fontWeight:'bold', color: color||'#FAF7F2', fontFamily:'Georgia, serif', whiteSpace:'nowrap', lineHeight:1.2 }}>{value}</div>
      {sub && <div style={{ fontSize:9, color:'rgba(250,247,242,0.45)', whiteSpace:'nowrap', marginTop:1 }}>{sub}</div>}
    </div>
  )
}

function Divider() {
  return <div style={{ width:1, alignSelf:'stretch', background:'rgba(212,168,67,0.18)', margin:'0 2px' }}/>
}

function GroupLabel({ text }) {
  return (
    <div style={{ fontSize:9, color:'rgba(212,168,67,0.55)', fontWeight:'bold', letterSpacing:'0.07em', writingMode:'vertical-lr', transform:'rotate(180deg)', userSelect:'none' }}>
      {text}
    </div>
  )
}

function KPIBar({ bnyT, njT, printerStats, weekNum, weekInfo, todayLabel, onRefresh, loading, lastRefresh }) {
  if (!bnyT && !njT) return null

  const combSched   = (bnyT?.wkSched||0)+(njT?.wkSched||0)
  const combActual  = bnyT?.wkActual!==null||njT?.wkActual!==null ? (bnyT?.wkActual||0)+(njT?.wkActual||0) : null
  const combWaste   = bnyT?.wkWaste!==null||njT?.wkWaste!==null   ? (bnyT?.wkWaste||0)+(njT?.wkWaste||0)   : null
  const combBudget  = BNY_BUDGET+NJ_BUDGET
  const combSchedP  = pct(combActual, combSched)
  const combBudgetP = pct(combActual, combBudget)
  const combWasteP  = pct(combWaste, combActual)

  // Row 1: identity + combined + BNY
  // Row 2: NJ + printers
  return (
    <div style={{ position:'sticky', top:0, zIndex:100, background:'#2C2420', borderBottom:'2px solid rgba(212,168,67,0.2)', boxShadow:'0 3px 16px rgba(0,0,0,0.35)', padding:'10px 20px' }}>

      {/* Row 1 */}
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
        {/* Identity */}
        <div style={{ marginRight:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ background:'#D4A843', color:'#2C2420', borderRadius:4, padding:'2px 8px', fontSize:11, fontWeight:'bold', whiteSpace:'nowrap' }}>FY WK {weekNum}</span>
            {weekInfo && <span style={{ fontSize:10, color:'rgba(212,168,67,0.6)' }}>{weekInfo.month} · {weekInfo.quarter}</span>}
            {todayLabel && <span style={{ fontSize:10, color:'rgba(212,168,67,0.45)' }}>Today: {todayLabel}</span>}
          </div>
          {lastRefresh && <div style={{ fontSize:9, color:'rgba(250,247,242,0.3)', marginTop:2 }}>{lastRefresh.toLocaleTimeString()}</div>}
        </div>

        <Divider/>
        <GroupLabel text="COMBINED"/>
        <Bubble label="Total Yds"   value={combActual!==null?fmt(combActual):'—'} sub={`of ${fmt(combSched)} sched`} color={pctColor(combSchedP)}/>
        <Bubble label="vs Schedule" value={combSchedP!==null?`${combSchedP}%`:'—'} sub={`${fmt(combBudget)} yd budget`} color={pctColor(combSchedP)}/>
        <Bubble label="vs Budget"   value={combBudgetP!==null?`${combBudgetP}%`:'—'} sub="wk target" color={pctColor(combBudgetP)}/>
        <Bubble label="Waste"       value={combWasteP!==null?`${combWasteP}%`:'—'} sub={`${fmt(combWaste)} yds · <10%`} color={wasteColor(combWasteP)}/>

        <Divider/>
        <GroupLabel text="BNY"/>
        <Bubble label="Actual"    value={bnyT?.wkActual!==null?fmt(bnyT.wkActual):'—'} sub={`sched ${fmt(bnyT?.wkSched)}`} color={pctColor(bnyT?.schedPct)}/>
        <Bubble label="% Sched"   value={bnyT?.schedPct!==null?`${bnyT.schedPct}%`:'—'} sub={ouFmt(bnyT?.overUnder)??'vs expected'} color={pctColor(bnyT?.schedPct)}/>
        <Bubble label="vs Budget" value={bnyT?.budgetPct!==null?`${bnyT.budgetPct}%`:'—'} sub={`${fmt(BNY_BUDGET)} yd tgt`} color={pctColor(bnyT?.budgetPct)}/>
        <Bubble label="Waste"     value={bnyT?.wastePct!==null?`${bnyT.wastePct}%`:'—'} sub={`${fmt(bnyT?.wkWaste)} yds`} color={wasteColor(bnyT?.wastePct)}/>

        <div style={{ flex:1 }}/>
        <button onClick={onRefresh} disabled={loading} style={{ background:'none', border:'1px solid rgba(212,168,67,0.25)', borderRadius:4, padding:'4px 12px', fontSize:11, color:'rgba(212,168,67,0.6)', cursor:'pointer', whiteSpace:'nowrap', alignSelf:'flex-start' }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* Row 2 */}
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <div style={{ marginRight:6, minWidth:120 }}/> {/* spacer to align with row 1 */}
        <Divider/>
        <GroupLabel text="NJ"/>
        <Bubble label="Actual"    value={njT?.wkActual!==null?fmt(njT.wkActual):'—'} sub={`sched ${fmt(njT?.wkSched)}`} color={pctColor(njT?.schedPct)}/>
        <Bubble label="% Sched"   value={njT?.schedPct!==null?`${njT.schedPct}%`:'—'} sub={ouFmt(njT?.overUnder)??'vs expected'} color={pctColor(njT?.schedPct)}/>
        <Bubble label="vs Budget" value={njT?.budgetPct!==null?`${njT.budgetPct}%`:'—'} sub={`${fmt(NJ_BUDGET)} yd tgt`} color={pctColor(njT?.budgetPct)}/>
        <Bubble label="Waste"     value={njT?.wastePct!==null?`${njT.wastePct}%`:'—'} sub={`${fmt(njT?.wkWaste)} yds`} color={wasteColor(njT?.wastePct)}/>

        <Divider/>
        <GroupLabel text="PRINTERS"/>
        {printerStats ? (
          <>
            <Bubble label="Top Performer" value={printerStats.topName} sub={`${fmt(printerStats.topYds)} yds · ${fmt(printerStats.topAvg)}/day`} color="#D4A843"/>
            <Bubble label="Active Ops"    value={printerStats.count}   sub="assigned this week" color="#FAF7F2"/>
            <Bubble label="Fleet Avg"     value={fmt(printerStats.avgYds)} sub="yds/operator/wk" color="#FAF7F2"/>
          </>
        ) : (
          <>
            <Bubble label="Top Performer" value="—" sub="assign operators Mon" color="rgba(250,247,242,0.35)"/>
            <Bubble label="Active Ops"    value="—" sub="assign operators Mon" color="rgba(250,247,242,0.35)"/>
            <Bubble label="Fleet Avg"     value="—" sub="yds/operator/wk"      color="rgba(250,247,242,0.35)"/>
          </>
        )}
      </div>
    </div>
  )
}

// ── Cell components ───────────────────────────────────────────────────────────
function WasteTag({waste, actual}) {
  if (!waste||waste===0) return null
  const p=pct(waste,actual), over=p!==null&&p>WASTE_TARGET*100
  return <div style={{fontSize:10,color:over?'#C62828':'#2E7D32',fontWeight:'bold'}}>{fmt(waste)}w{p!==null?` (${p}%)`:''}{over?' ↑':' ✓'}</div>
}

function DayCell({day, isToday}) {
  const has=day.actual!==null
  const ou=has?day.actual-day.sched:null
  const ouC=ou===null?'#9C8F87':ou>=0?'#2E7D32':'#C62828'
  return (
    <td style={{padding:'5px 6px',borderBottom:'1px solid #F2EDE4',borderLeft:isToday?'2px solid #D4A843':'1px solid #F2EDE4',background:isToday?'rgba(212,168,67,0.07)':'transparent',textAlign:'center',minWidth:85,verticalAlign:'top'}}>
      <div style={{fontSize:11,color:'#B0A89F'}}>{fmt(day.sched)}</div>
      <div style={{fontSize:13,fontWeight:has?'bold':'normal',color:has?'#2C2420':'#D0C8C0'}}>{has?fmt(day.actual):'·'}</div>
      {ou!==null&&<div style={{fontSize:10,color:ouC,fontWeight:'bold'}}>{ou>=0?'+':''}{fmt(ou)}</div>}
      <WasteTag waste={day.waste} actual={day.actual}/>
      {day.op&&<div style={{fontSize:10,color:'#5C8A5C',fontStyle:'italic',marginTop:2}}>{day.op}</div>}
      {day.op2&&<div style={{fontSize:10,color:'#5C8A5C',fontStyle:'italic'}}>{day.op2}</div>}
    </td>
  )
}

function WkCell({wkSched, wkActual, wkWaste, daysIn}) {
  const p=pct(wkActual,wkSched)
  const exp=daysIn>0?Math.round(wkSched/5*daysIn):null
  const ou=wkActual!==null&&exp!==null?wkActual-exp:null
  const wp=pct(wkWaste,wkActual)
  return (
    <td style={{padding:'5px 8px',borderBottom:'1px solid #F2EDE4',borderLeft:'2px solid #E8DDD0',textAlign:'center',minWidth:90,verticalAlign:'top'}}>
      <div style={{fontSize:11,color:'#B0A89F'}}>{fmt(wkSched)}</div>
      <div style={{fontSize:13,fontWeight:wkActual!==null?'bold':'normal',color:wkActual!==null?'#2C2420':'#D0C8C0'}}>{wkActual!==null?fmt(wkActual):'·'}</div>
      {p!==null&&<div style={{fontSize:10,color:p>=95?'#2E7D32':'#E65100',fontWeight:'bold'}}>{p}%</div>}
      {ou!==null&&<div style={{fontSize:10,color:ou>=0?'#2E7D32':'#C62828'}}>{ou>=0?'+':''}{fmt(ou)} vs exp</div>}
      {wkWaste!==null&&wkWaste>0&&<div style={{fontSize:10,color:wp>10?'#C62828':'#2E7D32'}}>{fmt(wkWaste)}w ({wp}%){wp>10?' ↑':' ✓'}</div>}
    </td>
  )
}

function SectionTable({sec, dayDates, dayCols, todayIdx, daysIn}) {
  const dayTotals=dayCols.map((_,di)=>({
    sched:  sec.machines.reduce((s,m)=>s+(m.days[di]?.sched||0),0),
    actual: sec.machines.every(m=>m.days[di]?.actual===null)?null:sec.machines.reduce((s,m)=>s+(m.days[di]?.actual||0),0),
    waste:  sec.machines.every(m=>!m.days[di]?.waste)?null:sec.machines.reduce((s,m)=>s+(m.days[di]?.waste||0),0),
  }))
  const secSched=sec.machines.reduce((s,m)=>s+m.wkSched,0)
  const secActual=sec.machines.every(m=>m.wkActual===null)?null:sec.machines.reduce((s,m)=>s+(m.wkActual||0),0)
  const secWaste=sec.machines.every(m=>!m.wkWaste)?null:sec.machines.reduce((s,m)=>s+(m.wkWaste||0),0)
  return (
    <div style={{marginBottom:20}}>
      <div style={{background:'#E8DDD0',padding:'6px 12px',fontWeight:'bold',fontSize:12,color:'#5C4F47',letterSpacing:'0.05em',textTransform:'uppercase',borderRadius:'4px 4px 0 0'}}>▸ {sec.label}</div>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,background:'#fff',border:'1px solid #E8DDD0'}}>
          <thead>
            <tr>
              <th style={{background:'#2C2420',color:'#D4A843',padding:'7px 12px',textAlign:'left',fontSize:11,fontWeight:'bold',minWidth:130,position:'sticky',left:0}}>Machine / Table</th>
              <th style={{background:'#2C2420',color:'#D4A843',padding:'7px 8px',textAlign:'center',fontSize:11,fontWeight:'bold',minWidth:55}}>Bgt/Day</th>
              {dayDates.map((date,di)=>(
                <th key={di} style={{background:di===todayIdx?'#3A2E1A':'#2C2420',color:di===todayIdx?'#FAD47C':'#D4A843',padding:'7px 8px',textAlign:'center',fontSize:11,fontWeight:'bold',minWidth:85,borderLeft:di===todayIdx?'2px solid #D4A843':'1px solid #3C3028'}}>
                  {dayCols[di].label} {date}<br/><span style={{fontWeight:'normal',fontSize:9,color:'#888'}}>Sched/Act/+−·Waste·Op</span>
                </th>
              ))}
              <th style={{background:'#2C2420',color:'#D4A843',padding:'7px 8px',textAlign:'center',fontSize:11,fontWeight:'bold',minWidth:90,borderLeft:'2px solid #5C4F47'}}>Week Total</th>
            </tr>
          </thead>
          <tbody>
            {sec.machines.map((m,mi)=>{
              const bg=mi%2===0?'#fff':'#FAF7F2'
              return (
                <tr key={mi} style={{background:bg}}>
                  <td style={{padding:'6px 12px',borderBottom:'1px solid #F2EDE4',color:'#2C2420',fontWeight:500,background:bg,position:'sticky',left:0}}>{m.name}</td>
                  <td style={{padding:'6px 8px',borderBottom:'1px solid #F2EDE4',color:'#9C8F87',textAlign:'center',background:bg}}>{m.budget}</td>
                  {m.days.map((day,di)=><DayCell key={di} day={day} isToday={di===todayIdx}/>)}
                  <WkCell wkSched={m.wkSched} wkActual={m.wkActual} wkWaste={m.wkWaste} daysIn={daysIn}/>
                </tr>
              )
            })}
            <tr>
              <td colSpan={2} style={{padding:'5px 12px',background:'#EDE5DC',color:'#5C4F47',fontWeight:'bold',fontStyle:'italic',fontSize:11,position:'sticky',left:0}}>{sec.label} TOTAL</td>
              {dayTotals.map((dt,di)=>{
                const ou=dt.actual!==null?dt.actual-dt.sched:null
                const wp=pct(dt.waste,dt.actual)
                return (
                  <td key={di} style={{padding:'5px 6px',background:di===todayIdx?'rgba(212,168,67,0.1)':'#EDE5DC',borderLeft:di===todayIdx?'2px solid #D4A843':'1px solid #E8DDD0',textAlign:'center',fontSize:11}}>
                    <div style={{color:'#9C8F87'}}>{fmt(dt.sched)}</div>
                    <div style={{fontWeight:'bold',color:'#5C4F47'}}>{dt.actual!==null?fmt(dt.actual):'·'}</div>
                    {ou!==null&&<div style={{fontSize:10,color:ou>=0?'#2E7D32':'#C62828'}}>{ou>=0?'+':''}{fmt(ou)}</div>}
                    {dt.waste!==null&&dt.waste>0&&<div style={{fontSize:10,color:wp>10?'#C62828':'#2E7D32'}}>{fmt(dt.waste)}w</div>}
                  </td>
                )
              })}
              <td style={{padding:'5px 8px',background:'#EDE5DC',borderLeft:'2px solid #C8BDB4',textAlign:'center',fontSize:11}}>
                <div style={{color:'#9C8F87'}}>{fmt(secSched)}</div>
                <div style={{fontWeight:'bold',color:'#5C4F47'}}>{secActual!==null?fmt(secActual):'·'}</div>
                {secActual!==null&&secSched>0&&<div style={{fontSize:10,color:pct(secActual,secSched)>=95?'#2E7D32':'#E65100'}}>{pct(secActual,secSched)}%</div>}
                {secWaste!==null&&secWaste>0&&<div style={{fontSize:10,color:pct(secWaste,secActual)>10?'#C62828':'#2E7D32'}}>{fmt(secWaste)}w ({pct(secWaste,secActual)}%)</div>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FacilityBlock({title, data, dayCols, todayIdx, budget}) {
  if (!data||!data.sections.length) return null
  const {dayDates,sections}=data
  const daysIn=todayIdx>=0?todayIdx+1:0
  const grandSched=sections.reduce((s,sec)=>s+sec.machines.reduce((ss,m)=>ss+m.wkSched,0),0)
  const allNull=sections.every(sec=>sec.machines.every(m=>m.wkActual===null))
  const grandActual=allNull?null:sections.reduce((s,sec)=>s+sec.machines.reduce((ss,m)=>ss+(m.wkActual||0),0),0)
  const noWaste=sections.every(sec=>sec.machines.every(m=>!m.wkWaste))
  const grandWaste=noWaste?null:sections.reduce((s,sec)=>s+sec.machines.reduce((ss,m)=>ss+(m.wkWaste||0),0),0)
  const grandPct=pct(grandActual,grandSched)
  const exp=daysIn>0?Math.round(grandSched/5*daysIn):null
  const grandOU=grandActual!==null&&exp!==null?grandActual-exp:null
  const wastePct=pct(grandWaste,grandActual)
  return (
    <div style={{marginBottom:40}}>
      <div style={{fontSize:16,fontWeight:'bold',color:'#2C2420',marginBottom:12,fontFamily:'Georgia, serif'}}>{title}</div>
      {sections.map((sec,si)=><SectionTable key={si} sec={sec} dayDates={dayDates} dayCols={dayCols} todayIdx={todayIdx} daysIn={daysIn}/>)}
      <div style={{background:'#DDD4C8',borderRadius:6,padding:'10px 16px',display:'flex',gap:20,alignItems:'center',flexWrap:'wrap'}}>
        <div style={{fontWeight:'bold',color:'#2C2420',fontSize:13}}>WEEK TOTAL</div>
        <div style={{fontSize:13}}><span style={{color:'#9C8F87',fontSize:11}}>Sched </span>{fmt(grandSched)}<span style={{margin:'0 8px',color:'#9C8F87'}}>·</span><span style={{color:'#9C8F87',fontSize:11}}>Actual </span><span style={{fontWeight:'bold'}}>{grandActual!==null?fmt(grandActual):'—'}</span></div>
        {grandPct!==null&&<div style={{fontWeight:'bold',color:grandPct>=95?'#2E7D32':'#E65100',fontSize:13}}>{grandPct}% of schedule</div>}
        {grandOU!==null&&<div style={{fontSize:12,color:grandOU>=0?'#2E7D32':'#C62828',fontWeight:'bold'}}>{grandOU>=0?'+':''}{fmt(grandOU)} vs exp thru {['Mon','Tue','Wed','Thu','Fri'][todayIdx]}</div>}
        {grandWaste!==null&&grandWaste>0&&<div style={{fontSize:12,color:wastePct>10?'#C62828':'#2E7D32',fontWeight:'bold'}}>Waste: {fmt(grandWaste)} yds ({wastePct}%) {wastePct>10?'↑ above 10%':'✓ on target'}</div>}
        {budget&&grandActual!==null&&<div style={{fontSize:12,color:'#9C8F87'}}>{pct(grandActual,budget)}% of {fmt(budget)} yd budget</div>}
      </div>
    </div>
  )
}

function OperatorScorecard({bnyOps, njOps}) {
  const all={}
  Object.entries(bnyOps||{}).forEach(([name,d])=>{ all[name]={...(all[name]||{yds:0,days:0}),facility:'BNY'}; all[name].yds+=d.yds; all[name].days+=d.days })
  Object.entries(njOps||{}).forEach(([name,d])=>{ all[name]={...(all[name]||{yds:0,days:0}),facility:'NJ'}; all[name].yds+=d.yds; all[name].days+=d.days })
  const ranked=Object.entries(all).filter(([,d])=>d.yds>0).sort((a,b)=>b[1].yds-a[1].yds)
  if (!ranked.length) return (
    <div style={{marginTop:40}}>
      <div style={{fontSize:16,fontWeight:'bold',color:'#2C2420',marginBottom:8,fontFamily:'Georgia, serif'}}>Operator Scorecard</div>
      <div style={{background:'#F2EDE4',borderRadius:8,padding:16,color:'#9C8F87',fontSize:13}}>No operator data yet — assign operators in the Google Sheets to see rankings here.</div>
    </div>
  )
  const maxYds=ranked[0][1].yds
  return (
    <div style={{marginTop:40}}>
      <div style={{fontSize:16,fontWeight:'bold',color:'#2C2420',marginBottom:4,fontFamily:'Georgia, serif'}}>Operator Scorecard</div>
      <div style={{fontSize:13,color:'#9C8F87',marginBottom:16}}>Ranked by yards produced this week</div>
      <div style={{background:'#fff',border:'1px solid #E8DDD0',borderRadius:8,overflow:'hidden'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead>
            <tr style={{background:'#2C2420'}}>
              <th style={{padding:'8px 12px',textAlign:'left',color:'#D4A843',fontSize:11,fontWeight:'bold',width:36}}>#</th>
              <th style={{padding:'8px 12px',textAlign:'left',color:'#D4A843',fontSize:11,fontWeight:'bold'}}>Operator</th>
              <th style={{padding:'8px 12px',textAlign:'center',color:'#D4A843',fontSize:11,fontWeight:'bold',width:60}}>Facility</th>
              <th style={{padding:'8px 12px',textAlign:'right',color:'#D4A843',fontSize:11,fontWeight:'bold',width:90}}>Yds This Wk</th>
              <th style={{padding:'8px 12px',textAlign:'right',color:'#D4A843',fontSize:11,fontWeight:'bold',width:60}}>Days</th>
              <th style={{padding:'8px 12px',textAlign:'right',color:'#D4A843',fontSize:11,fontWeight:'bold',width:80}}>Avg/Day</th>
              <th style={{padding:'8px 16px',textAlign:'left',color:'#D4A843',fontSize:11,fontWeight:'bold'}}>vs Top</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(([name,d],idx)=>{
              const avg=d.days>0?Math.round(d.yds/d.days):0
              const barPct=Math.round(d.yds/maxYds*100)
              const medal=idx===0?'🥇':idx===1?'🥈':idx===2?'🥉':null
              return (
                <tr key={name} style={{background:idx%2===0?'#fff':'#FAF7F2'}}>
                  <td style={{padding:'8px 12px',borderBottom:'1px solid #F2EDE4',color:'#9C8F87',textAlign:'center',fontWeight:'bold'}}>{medal||idx+1}</td>
                  <td style={{padding:'8px 12px',borderBottom:'1px solid #F2EDE4',color:'#2C2420',fontWeight:idx<3?'bold':'normal'}}>{name}</td>
                  <td style={{padding:'8px 12px',borderBottom:'1px solid #F2EDE4',textAlign:'center'}}>
                    <span style={{fontSize:10,background:d.facility==='BNY'?'#E8EEF5':'#E8DDD0',color:d.facility==='BNY'?'#2C5F8A':'#5C4F47',borderRadius:3,padding:'2px 6px',fontWeight:'bold'}}>{d.facility}</span>
                  </td>
                  <td style={{padding:'8px 12px',borderBottom:'1px solid #F2EDE4',textAlign:'right',fontWeight:'bold',color:'#2C2420'}}>{fmt(d.yds)}</td>
                  <td style={{padding:'8px 12px',borderBottom:'1px solid #F2EDE4',textAlign:'right',color:'#9C8F87'}}>{d.days}</td>
                  <td style={{padding:'8px 12px',borderBottom:'1px solid #F2EDE4',textAlign:'right',color:'#2C2420'}}>{fmt(avg)}</td>
                  <td style={{padding:'8px 16px',borderBottom:'1px solid #F2EDE4'}}>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <div style={{flex:1,height:6,background:'#F2EDE4',borderRadius:3,overflow:'hidden'}}>
                        <div style={{height:'100%',width:`${barPct}%`,background:idx===0?'#D4A843':idx<3?'#8A9B7A':'#B0A89F',borderRadius:3}}/>
                      </div>
                      <div style={{fontSize:11,color:'#9C8F87',minWidth:32,textAlign:'right'}}>{barPct}%</div>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function ProductionTab({weekStart}) {
  const [bny,  setBny]  = useState(null)
  const [nj,   setNj]   = useState(null)
  const [loading,setLoading]=useState(true)
  const [error,  setError]  =useState(null)
  const [weekNum,setWeekNum]=useState(null)
  const [weekInfo,setWeekInfo]=useState(null)
  const [lastRefresh,setLastRefresh]=useState(null)

  const todayIdx=(()=>{ const d=new Date().getDay(); return d>=1&&d<=5?d-1:-1 })()
  const todayLabel=todayIdx>=0?['Mon','Tue','Wed','Thu','Fri'][todayIdx]:null

  async function loadData(ws) {
    setLoading(true); setError(null)
    try {
      const key=format(ws,'yyyy-MM-dd')
      const info=getFiscalInfo(key)
      if (!info) { setError('No fiscal week found. Sheets cover Weeks 14–28 (Apr 6 – Jul 18).'); setLoading(false); return }
      setWeekNum(info.fiscalWeek); setWeekInfo(info)
      const [bnyRows,njRows]=await Promise.all([
        fetchSheet(BNY_SHEET_ID,'Schedule!A:W'),
        fetchSheet(NJ_SHEET_ID, 'Schedule!A:AE'),
      ])
      setBny(parseWeek(bnyRows,info.fiscalWeek,BNY_DAYS,BNY_WK_SCHED,BNY_WK_ACTUAL,BNY_WK_WASTE,false))
      setNj( parseWeek(njRows, info.fiscalWeek,NJ_DAYS, NJ_WK_SCHED, NJ_WK_ACTUAL, NJ_WK_WASTE, true))
      setLastRefresh(new Date())
    } catch(e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(()=>{ if(weekStart) loadData(weekStart) },[weekStart])

  const daysIn=todayIdx>=0?todayIdx+1:0
  const bnyT          = calcTotals(bny, BNY_BUDGET, daysIn)
  const njT           = calcTotals(nj,  NJ_BUDGET,  daysIn)
  const printerStats  = calcPrinterStats(bny?.ops, nj?.ops)

  return (
    <div style={{fontFamily:'Georgia, serif', background:'#FAF7F2', minHeight:'100vh'}}>
      <KPIBar
        bnyT={bnyT} njT={njT}
        printerStats={printerStats}
        weekNum={weekNum} weekInfo={weekInfo}
        todayLabel={todayLabel}
        onRefresh={()=>loadData(weekStart)}
        loading={loading} lastRefresh={lastRefresh}
      />
      <div style={{padding:'24px'}}>
        <div style={{fontSize:13,color:'#9C8F87',marginBottom:24}}>
          Source: Google Sheets (live)
          <span style={{marginLeft:16,fontSize:11,color:'#C8BDB8'}}>Each cell: Sched / Actual / +− · Waste · Operator · Waste target &lt;10%</span>
        </div>
        {error&&<div style={{background:'#FFF3E0',border:'1px solid #FFB74D',borderRadius:8,padding:16,color:'#E65100',marginBottom:16}}>⚠ {error}</div>}
        {loading&&<div style={{color:'#9C8F87',padding:40,textAlign:'center',fontSize:14}}>Loading production data from Google Sheets...</div>}
        {!loading&&!error&&(
          <>
            <FacilityBlock title="BNY — Digital Production"     data={bny} dayCols={BNY_DAYS} todayIdx={todayIdx} budget={BNY_BUDGET}/>
            <FacilityBlock title="NJ — Screen Print Production" data={nj}  dayCols={NJ_DAYS}  todayIdx={todayIdx} budget={NJ_BUDGET}/>
            {(!bny||!bny.sections.length)&&(!nj||!nj.sections.length)&&(
              <div style={{background:'#F2EDE4',border:'1px solid #E8DDD0',borderRadius:8,padding:16,color:'#9C8F87',fontSize:13}}>
                No production data found for FY Week {weekNum}.
              </div>
            )}
            <OperatorScorecard bnyOps={bny?.ops} njOps={nj?.ops}/>
          </>
        )}
      </div>
    </div>
  )
}
