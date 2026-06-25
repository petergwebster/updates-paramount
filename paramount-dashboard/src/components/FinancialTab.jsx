import React, { useState, useEffect, useMemo } from 'react'
import { FISCAL_CALENDAR } from '../fiscalCalendar'
import { supabase } from '../supabase'
import styles from './FinancialTab.module.css'

// ── Fiscal resolution (Sunday-anchored, mirrors the purchases parser) ────────
const MONTH_NUM = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' }
const MONTH_LABEL = { '01':'January','02':'February','03':'March','04':'April','05':'May','06':'June','07':'July','08':'August','09':'September','10':'October','11':'November','12':'December' }
const _weeks = Object.entries(FISCAL_CALENDAR).map(([k,info]) => {
  const mon = new Date(k + 'T12:00:00')
  const sun = new Date(mon); sun.setDate(sun.getDate() - 1)
  const sat = new Date(mon); sat.setDate(sat.getDate() + 5)
  return { k, info, sun, sat }
}).sort((a,b) => a.sun - b.sun)
function fiscalForDate(iso) {
  if (!iso) return null
  const t = new Date(String(iso).slice(0,10) + 'T12:00:00')
  for (const w of _weeks) if (t >= w.sun && t <= w.sat) {
    const yr = w.k.slice(0,4)
    return { fiscalMonth: `${yr}-${MONTH_NUM[w.info.month]}`, fiscalYear: yr }
  }
  return null
}
const monthLabel = m => { if (!m) return ''; const [y,mo] = m.split('-'); return `${MONTH_LABEL[mo]||mo} ${y}` }

// ── Formatters ───────────────────────────────────────────────────────────────
const fmtD = (v, opts={}) => {
  if (v === null || v === undefined || v === '') return '—'
  const n = parseFloat(v) || 0
  if (Math.abs(n) < 0.5) return '—'
  const abs = Math.abs(Math.round(n)).toLocaleString()
  return (n < 0 ? '-$' : (opts.plus && n > 0 ? '+$' : '$')) + abs
}
const BU_KEYS = ['BNY','NJ','Shared']
const COGS_CATS = ['material_inventory','ink','freight']
const OPEX_CATS = ['opex_temp','opex_te','opex_distribution','opex_edp','opex_supplies','opex_printing','opex_services','opex_utilities','opex_rent','opex_other']
const OPEX_LABEL = {
  opex_temp:'Temp / Contract', opex_te:'Travel & Entertainment', opex_distribution:'Distribution',
  opex_edp:'Office / EDP', opex_supplies:'Supplies', opex_printing:'Printing', opex_services:'Outside Services',
  opex_utilities:'Utilities', opex_rent:'Rent', opex_other:'Other OpEx',
}

// sum helper over an array of {category,business_unit,net}
function sumWhere(rows, catPred, bu) {
  let s = 0
  for (const r of rows) if (catPred(r.category) && (!bu || r.business_unit === bu)) s += (r.net || 0)
  return s
}

function SectionRow({ label, bny, nj, shared, indent, isTotal, est }) {
  const combined = (bny||0)+(nj||0)+(shared||0)
  return (
    <tr className={`${isTotal ? styles.boldRow + ' ' + styles.totalRow : ''}`}>
      <td className={`${styles.rowLabel} ${indent ? styles.indent : ''}`}>{label}{est && <span style={{fontSize:10,color:'var(--ink-40)',marginLeft:6}}>est.</span>}</td>
      <td className={styles.val}>{fmtD(nj)}</td>
      <td className={styles.val}>{fmtD(bny)}</td>
      <td className={styles.val}>{fmtD(shared)}</td>
      <td className={`${styles.val} ${styles.combined}`}>{fmtD(combined)}</td>
    </tr>
  )
}

export default function FinancialTab({ weekStart }) {
  const [scope, setScope]       = useState('MTD')         // MTD | YTD
  const [selMonth, setSelMonth] = useState(null)
  const [months, setMonths]     = useState([])
  const [mtdRows, setMtdRows]   = useState([])
  const [ytdRows, setYtdRows]   = useState([])
  const [aging, setAging]       = useState([])
  const [loading, setLoading]   = useState(false)
  const [narrative, setNarrative] = useState('')
  const [genBusy, setGenBusy]   = useState(false)

  const derived = useMemo(() => fiscalForDate(weekStart) || fiscalForDate(new Date().toISOString()), [weekStart])

  // Supabase caps responses at ~1000 rows regardless of .limit(); page through to get all.
  async function fetchPaged(table, columns, applyFilters) {
    const PAGE = 1000; let from = 0, all = []
    for (;;) {
      let q = supabase.from(table).select(columns)
      if (applyFilters) q = applyFilters(q)
      q = q.order('id', { ascending: true }).range(from, from + PAGE - 1)
      const { data, error } = await q
      if (error) { console.error('fetchPaged', table, error); break }
      if (!data || !data.length) break
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    return all
  }

  // discover available months once
  useEffect(() => { (async () => {
    const data = await fetchPaged('financial_transactions', 'fiscal_month')
    if (data) {
      const uniq = [...new Set(data.map(r => r.fiscal_month).filter(Boolean))].sort((a,b)=>b.localeCompare(a))
      setMonths(uniq)
      setSelMonth(prev => prev || (uniq.includes(derived?.fiscalMonth) ? derived.fiscalMonth : uniq[0]) || derived?.fiscalMonth || null)
    } else setSelMonth(derived?.fiscalMonth || null)
  })() }, [derived?.fiscalMonth])

  useEffect(() => { if (selMonth) loadAll(selMonth) }, [selMonth])

  async function loadAll(fm) {
    setLoading(true); setNarrative('')
    const fy = fm.slice(0,4)
    const [mtd, ytd, ag] = await Promise.all([
      fetchPaged('financial_transactions', 'category,business_unit,net', q => q.eq('fiscal_month', fm)),
      fetchPaged('financial_transactions', 'category,business_unit,net,fiscal_month', q => q.eq('fiscal_year', fy).lte('fiscal_month', fm)),
      fetchPaged('financial_aging', 'as_of_date,aging_type,business_unit,party_name,balance,past_due,buckets'),
    ])
    setMtdRows(mtd || [])
    setYtdRows(ytd || [])
    setAging(ag || [])
    setLoading(false)
  }

  const rows = scope === 'MTD' ? mtdRows : ytdRows

  // ── Aging: latest snapshot + trend ──
  const agingView = useMemo(() => {
    const byDate = {}
    for (const a of aging) {
      const k = `${a.as_of_date}|${a.aging_type}`
      if (!byDate[k]) byDate[k] = { as_of:a.as_of_date, type:a.aging_type, total:0, pastDue:0, buckets:{}, byBU:{} }
      const e = byDate[k]; e.total += (a.balance||0); e.pastDue += (a.past_due||0)
      for (const [bk,bv] of Object.entries(a.buckets||{})) e.buckets[bk] = (e.buckets[bk]||0) + (bv||0)
      const bu = a.business_unit || 'combined'; e.byBU[bu] = (e.byBU[bu]||0) + (a.balance||0)
    }
    const all = Object.values(byDate)
    const dates = [...new Set(all.map(e=>e.as_of))].filter(Boolean).sort()
    const latest = dates[dates.length-1]
    const ar = all.filter(e=>e.type==='ar').sort((a,b)=>a.as_of.localeCompare(b.as_of))
    const ap = all.filter(e=>e.type==='ap').sort((a,b)=>a.as_of.localeCompare(b.as_of))
    return { latest, dates, ar, ap, arNow: ar.find(e=>e.as_of===latest), apNow: ap.find(e=>e.as_of===latest) }
  }, [aging])

  async function generateNarrative() {
    setGenBusy(true)
    try {
      const cogs = sumWhere(rows, c=>COGS_CATS.includes(c))
      const opex = sumWhere(rows, c=>OPEX_CATS.includes(c))
      const capex = sumWhere(rows, c=>c==='capex')
      const arRecv = sumWhere(rows, c=>c==='ar_receipt')
      const apPaid = sumWhere(rows, c=>c==='ap_paid')
      const arInv = sumWhere(rows, c=>c==='ar_trade'||c==='ar_adjustment')
      const ctx = {
        period: scope==='MTD' ? monthLabel(selMonth) : `FY${selMonth?.slice(0,4)} YTD through ${monthLabel(selMonth)}`,
        est_cogs_material_basis: Math.round(cogs), opex: Math.round(opex), capex: Math.round(capex),
        ar_invoiced: Math.round(arInv), ar_received: Math.round(arRecv), ap_paid: Math.round(apPaid),
        ar_aging_total: Math.round(agingView.arNow?.total||0), ar_past_due: Math.round(agingView.arNow?.pastDue||0),
        ap_aging_total: Math.round(agingView.apNow?.total||0), ap_past_due: Math.round(agingView.apNow?.pastDue||0),
      }
      const resp = await fetch('/api/claude', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:600, messages:[{role:'user',
          content:`You are the President of Paramount Prints writing a brief, candid financial read for the C-suite (peer-to-peer BU leader voice, no fluff). Numbers below are spend/AR/AP for ${ctx.period}. Note COGS is an ESTIMATE on a material-spend basis (true posted COGS pending GP trial balance) — say so once. 2-3 short paragraphs, plain text, no headers.\n\nDATA: ${JSON.stringify(ctx)}` }] })
      })
      const data = await resp.json()
      setNarrative((data.content||[]).map(b=>b.text||'').join('').trim())
    } catch(e) { setNarrative('Could not generate narrative: ' + e.message) }
    setGenBusy(false)
  }

  if (!selMonth) return <div className={styles.empty}>Loading financial data…</div>

  // ── P&L rollups for current scope ──
  const cogs = bu => COGS_CATS.map(c => sumWhere(rows, x=>x===c, bu))
  const cogsTotal = bu => sumWhere(rows, c=>COGS_CATS.includes(c), bu)
  const opexTotal = bu => sumWhere(rows, c=>OPEX_CATS.includes(c), bu)
  const capex = bu => sumWhere(rows, c=>c==='capex', bu)
  const arRecv = sumWhere(rows, c=>c==='ar_receipt')
  const apPaid = sumWhere(rows, c=>c==='ap_paid')
  const arInv  = sumWhere(rows, c=>c==='ar_trade'||c==='ar_adjustment')

  const hasData = rows.length > 0

  return (
    <div className={styles.wrap}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.title}>Financial Summary</h2>
          <p className={styles.sub}>{scope==='MTD' ? 'Month-to-date' : 'Fiscal year-to-date'} spend, AR/AP & cash flow · <span style={{color:'var(--ink-40)'}}>COGS estimated on material-spend basis</span></p>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <div className={styles.periodPicker}>
            {['MTD','YTD'].map(s => (
              <button key={s} className={`${styles.periodBtn} ${scope===s?styles.periodBtnActive:''}`} onClick={()=>setScope(s)}>{s}</button>
            ))}
          </div>
          {months.length > 0 && (
            <select value={selMonth||''} onChange={e=>setSelMonth(e.target.value)}
              style={{fontSize:12,padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',background:'transparent',color:'var(--ink-60)',cursor:'pointer'}}>
              {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          )}
        </div>
      </div>

      {loading && <div className={styles.empty}>Loading…</div>}

      {!loading && !hasData && (
        <div className={styles.empty}>No financial transactions for {monthLabel(selMonth)} yet. Upload the GP Purchases workbook in Admin → Financial Data.</div>
      )}

      {!loading && hasData && (
        <>
          {/* Summary cards */}
          <div className={styles.summaryCards}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Est. COGS {scope}</div>
              <div className={styles.cardVal}>{fmtD(cogsTotal(null))}</div>
              <div className={styles.cardSplit}>Material {fmtD(sumWhere(rows,c=>c==='material_inventory'))} · Ink {fmtD(sumWhere(rows,c=>c==='ink'))} · Frt {fmtD(sumWhere(rows,c=>c==='freight'))}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>OpEx {scope}</div>
              <div className={styles.cardVal}>{fmtD(opexTotal(null))}</div>
              <div className={styles.cardSplit}>NJ {fmtD(opexTotal('NJ'))} · BNY {fmtD(opexTotal('BNY'))} · Shared {fmtD(opexTotal('Shared'))}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>CapEx {scope}</div>
              <div className={styles.cardVal}>{fmtD(capex(null))}</div>
              <div className={styles.cardSplit}>NJ {fmtD(capex('NJ'))} · BNY {fmtD(capex('BNY'))}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Net Cash Flow {scope}</div>
              <div className={styles.cardVal}>{fmtD(Math.abs(arRecv) - apPaid)}</div>
              <div className={styles.cardSplit}>AR in {fmtD(Math.abs(arRecv))} · AP out {fmtD(apPaid)}</div>
            </div>
          </div>

          {/* Est. COGS table */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Estimated COGS — Material Spend Basis</div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr>
                  <th className={styles.labelCol}></th>
                  <th><span className={styles.facilityBadge}>NJ</span> Passaic</th>
                  <th><span className={`${styles.facilityBadge} ${styles.badgeBNY}`}>BK</span> Brooklyn</th>
                  <th><span className={`${styles.facilityBadge} ${styles.badgeSH}`}>SH</span> Shared</th>
                  <th className={styles.combined}>Combined</th>
                </tr></thead>
                <tbody>
                  <SectionRow label="Material / Inventory" indent est nj={sumWhere(rows,c=>c==='material_inventory','NJ')} bny={sumWhere(rows,c=>c==='material_inventory','BNY')} shared={sumWhere(rows,c=>c==='material_inventory','Shared')} />
                  <SectionRow label="Ink" indent est nj={sumWhere(rows,c=>c==='ink','NJ')} bny={sumWhere(rows,c=>c==='ink','BNY')} shared={sumWhere(rows,c=>c==='ink','Shared')} />
                  <SectionRow label="Freight" indent est nj={sumWhere(rows,c=>c==='freight','NJ')} bny={sumWhere(rows,c=>c==='freight','BNY')} shared={sumWhere(rows,c=>c==='freight','Shared')} />
                  <SectionRow label="Est. COGS Total" isTotal nj={cogsTotal('NJ')} bny={cogsTotal('BNY')} shared={cogsTotal('Shared')} />
                </tbody>
              </table>
            </div>
            <div className={styles.contraRow} style={{padding:'8px 16px',fontSize:12,color:'var(--ink-40)'}}>Estimate based on inventory/ink/freight purchases. True posted COGS (material consumed + labor) pending GP trial balance.</div>
          </div>

          {/* OpEx table */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Operating Expenses (posted)</div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr>
                  <th className={styles.labelCol}></th>
                  <th><span className={styles.facilityBadge}>NJ</span> Passaic</th>
                  <th><span className={`${styles.facilityBadge} ${styles.badgeBNY}`}>BK</span> Brooklyn</th>
                  <th><span className={`${styles.facilityBadge} ${styles.badgeSH}`}>SH</span> Shared</th>
                  <th className={styles.combined}>Combined</th>
                </tr></thead>
                <tbody>
                  {OPEX_CATS.map(c => {
                    const nj=sumWhere(rows,x=>x===c,'NJ'), bny=sumWhere(rows,x=>x===c,'BNY'), sh=sumWhere(rows,x=>x===c,'Shared')
                    if (Math.abs(nj)+Math.abs(bny)+Math.abs(sh) < 0.5) return null
                    return <SectionRow key={c} label={OPEX_LABEL[c]} indent nj={nj} bny={bny} shared={sh} />
                  })}
                  <SectionRow label="OpEx Total" isTotal nj={opexTotal('NJ')} bny={opexTotal('BNY')} shared={opexTotal('Shared')} />
                </tbody>
              </table>
            </div>
          </div>

          {/* Cash flow strip */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Cash Flow — AR In / AP Out</div>
            <div style={{display:'flex',flexWrap:'wrap'}}>
              {[
                ['AR Invoiced', arInv, false],
                ['AR Received', Math.abs(arRecv), true],
                ['AP Paid', apPaid, false],
                ['CapEx', capex(null), false],
              ].map(([lbl,val,good],i,arr)=>(
                <div key={lbl} style={{flex:1,minWidth:140,padding:'14px 12px',textAlign:'center',borderRight:i<arr.length-1?'1px solid var(--border)':'none'}}>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--ink-40)',marginBottom:4}}>{lbl}</div>
                  <div style={{fontSize:18,fontWeight:700,color:good?'var(--green)':'var(--ink)'}}>{fmtD(val)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* AR / AP aging with trend */}
          {[{label:'Accounts Receivable',type:'ar',now:agingView.arNow,series:agingView.ar},
            {label:'Accounts Payable',type:'ap',now:agingView.apNow,series:agingView.ap}].map(sec => sec.now && (
            <div key={sec.type} className={styles.section}>
              <div className={styles.sectionTitle}>{sec.label} — Aging <span style={{color:'var(--ink-40)',fontWeight:500,textTransform:'none',letterSpacing:0}}>as-of {sec.now.as_of}</span></div>
              <div style={{display:'flex',flexWrap:'wrap'}}>
                {Object.entries(sec.now.buckets).map(([k,v],i,arr)=>(
                  <div key={k} style={{flex:1,minWidth:90,padding:'12px 8px',textAlign:'center',borderRight:i<arr.length-1?'1px solid var(--border)':'none'}}>
                    <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.05em',textTransform:'uppercase',color:'var(--ink-40)',marginBottom:4}}>{k.replace('d','').replace('_','–').replace('plus','+').replace('current','Current')}</div>
                    <div style={{fontSize:14,fontWeight:700,color:k==='current'?'var(--green)':'var(--ink)'}}>{fmtD(v)}</div>
                  </div>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',padding:'10px 16px',borderTop:'1px solid var(--border)',fontSize:13}}>
                <span>Total <strong>{fmtD(sec.now.total)}</strong></span>
                <span style={{color:sec.now.pastDue>0?'var(--red)':'var(--green)'}}>Past due <strong>{fmtD(sec.now.pastDue)}</strong></span>
              </div>
              {sec.series.length > 1 && (
                <div style={{padding:'8px 16px',borderTop:'1px solid var(--border)'}}>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.05em',textTransform:'uppercase',color:'var(--ink-40)',marginBottom:6}}>Past-due trend</div>
                  <div style={{display:'flex',gap:8,alignItems:'flex-end',height:42}}>
                    {sec.series.map(pt=>{
                      const max=Math.max(...sec.series.map(p=>p.pastDue),1)
                      return <div key={pt.as_of} title={`${pt.as_of}: ${fmtD(pt.pastDue)}`} style={{flex:1,display:'flex',flexDirection:'column',justifyContent:'flex-end',alignItems:'center',gap:3}}>
                        <div style={{width:'70%',height:`${Math.max(4,(pt.pastDue/max)*36)}px`,background:'var(--red)',opacity:0.7,borderRadius:2}}/>
                        <div style={{fontSize:9,color:'var(--ink-40)'}}>{pt.as_of.slice(5)}</div>
                      </div>
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* CEO narrative */}
          <div className={styles.section}>
            <div className={styles.sectionTitle} style={{justifyContent:'space-between'}}>
              <span>Claude's Read</span>
              <button onClick={generateNarrative} disabled={genBusy}
                style={{fontSize:11,fontWeight:600,padding:'4px 12px',borderRadius:6,border:'none',background:genBusy?'#9ca3af':'var(--ink)',color:'#fff',cursor:genBusy?'default':'pointer',textTransform:'none',letterSpacing:0}}>
                {genBusy ? 'Drafting…' : narrative ? 'Regenerate' : 'Draft with AI'}
              </button>
            </div>
            <div style={{padding:'14px 16px'}}>
              {narrative
                ? <textarea value={narrative} onChange={e=>setNarrative(e.target.value)} style={{width:'100%',minHeight:140,border:'1px solid var(--border)',borderRadius:8,padding:12,fontSize:13,lineHeight:1.5,resize:'vertical',fontFamily:'inherit',color:'var(--ink)',background:'var(--surface)'}}/>
                : <div style={{fontSize:13,color:'var(--ink-40)'}}>Click “Draft with AI” for a brief exec read on the {scope} numbers.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
