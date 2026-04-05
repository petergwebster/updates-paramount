import React, { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { getFiscalInfo } from '../fiscalCalendar'
import { supabase } from '../supabase'
import styles from './FinancialTab.module.css'

const BU_NJ      = '610'
const BU_BNY     = '609'
const BU_SHARED  = '612'
const MONTH_NAMES = {
  '01':'January','02':'February','03':'March','04':'April','05':'May','06':'June',
  '07':'July','08':'August','09':'September','10':'October','11':'November','12':'December'
}

function fmtD(v, opts = {}) {
  if (v === null || v === undefined || v === '') return '—'
  const n = parseFloat(v) || 0
  if (Math.abs(n) < 0.005) return '—'
  const abs = Math.abs(Math.round(n)).toLocaleString()
  const sign = n < 0 ? '-$' : (opts.showPlus && n > 0 ? '+$' : '$')
  return sign + abs
}

function DeltaBadge({ v }) {
  if (!v && v !== 0) return null
  const n = parseFloat(v) || 0
  if (Math.abs(n) < 1) return null
  const cls = n > 0 ? styles.deltaPos : styles.deltaNeg
  return <span className={cls}>{n > 0 ? '+' : ''}{fmtD(Math.abs(n))}</span>
}

function SectionRow({ label, nj, bny, shared, bold, indent, isTotal }) {
  const combined = (parseFloat(nj)||0) + (parseFloat(bny)||0) + (parseFloat(shared)||0)
  return (
    <tr className={`${bold || isTotal ? styles.boldRow : ''} ${isTotal ? styles.totalRow : ''}`}>
      <td className={`${styles.rowLabel} ${indent ? styles.indent : ''}`}>{label}</td>
      <td className={styles.val}>{fmtD(nj)}</td>
      <td className={styles.val}>{fmtD(bny)}</td>
      <td className={styles.val}>{fmtD(shared)}</td>
      <td className={`${styles.val} ${styles.combined}`}>{fmtD(combined)}</td>
    </tr>
  )
}

export default function FinancialTab({ weekStart, currentPeriod: currentPeriodProp }) {
  const [periods, setPeriods]     = useState([])
  const [selected, setSelected]   = useState(null)
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(false)
  const [apData,  setApData]      = useState(null)   // { paramount, bny }
  const [arData,  setArData]      = useState(null)

  // Period key includes fiscal week: "2026-01-W2"
  const currentPeriod = React.useMemo(() => {
    if (currentPeriodProp && weekStart) {
      const fi = getFiscalInfo(weekStart)
      return fi ? `${currentPeriodProp}-W${fi.weekInMonth}` : currentPeriodProp
    }
    return currentPeriodProp || null
  }, [currentPeriodProp, weekStart])

  // Load on mount and whenever weekStart changes
  useEffect(() => {
    loadAll(currentPeriod)
  }, [currentPeriod])

  // When user picks a different month from history dropdown
  useEffect(() => {
    if (!selected || selected === currentPeriod) return
    loadForPeriod(selected)
  }, [selected])

  async function loadAll(period) {
    setLoading(true)
    setData(null)
    try {
      // Load period list — and current period's data if we have a period
      const queries = [
        supabase.from('financials_monthly').select('period, uploaded_at, upload_notes').order('period', { ascending: false }),
      ]
      if (period) queries.push(supabase.from('financials_monthly').select('*').eq('period', period))
      if (period) queries.push(supabase.from('financial_ap').select('*').eq('period', period))
      if (period) queries.push(supabase.from('financial_ar').select('*').eq('period', period).maybeSingle())
      const [periodsRes, dataRes, apRes, arRes] = await Promise.all(queries)
      // Update periods list
      const seen = new Set()
      const unique = (periodsRes.data || []).filter(r => {
        if (seen.has(r.period)) return false
        seen.add(r.period); return true
      })
      setPeriods(unique)
      setSelected(period || unique[0]?.period)
      // Update data if we queried for a specific period
      if (dataRes && dataRes.data && dataRes.data.length > 0) {
        setData({
          nj:     dataRes.data.find(r => r.business_unit === BU_NJ)     || null,
          bny:    dataRes.data.find(r => r.business_unit === BU_BNY)    || null,
          shared: dataRes.data.find(r => r.business_unit === BU_SHARED) || null,
        })
      }
    } catch(e) {
      console.error('Financial load error:', e)
    } finally {
      setLoading(false)
    }
  }

  async function loadForPeriod(period) {
    setLoading(true)
    setData(null)
    try {
      const [{ data: rows }, { data: apRows }, { data: arRow }] = await Promise.all([
        supabase.from('financials_monthly').select('*').eq('period', period),
        supabase.from('financial_ap').select('*').eq('period', period),
        supabase.from('financial_ar').select('*').eq('period', period).maybeSingle(),
      ])
      if (rows && rows.length > 0) {
        setData({
          nj:     rows.find(r => r.business_unit === BU_NJ)     || null,
          bny:    rows.find(r => r.business_unit === BU_BNY)    || null,
          shared: rows.find(r => r.business_unit === BU_SHARED) || null,
        })
      }
      if (apRows?.length) {
        setApData({
          paramount: apRows.find(r => r.facility === 'Paramount') || null,
          bny:       apRows.find(r => r.facility === 'BNY')       || null,
        })
      }
      if (arRow) setArData(arRow)
    } catch(e) {
      console.error('loadForPeriod error:', e)
    } finally {
      setLoading(false)
    }
  }

  const get = (bu, field) => {
    const row = bu === 'nj' ? data?.nj : bu === 'bny' ? data?.bny : data?.shared
    if (!row) return 0
    return parseFloat(row[field]) || 0
  }

  const sum3 = (field) => get('nj', field) + get('bny', field) + get('shared', field)

  const periodLabel = p => {
    if (!p) return ''
    const parts = p.split('-')
    const yr = parts[0], mo = parts[1], wk = parts[2]
    const month = MONTH_NAMES[mo] || mo
    return wk ? `${month} ${wk.replace('W', 'Week ')} ${yr}` : `${month} ${yr}`
  }

  if (loading) return <div className={styles.empty}>Loading…</div>

  // Show tables if data loaded OR period exists in DB (may be all zeros)
  const currentPeriodHasData = data !== null || periods.some(p => p.period === currentPeriod)

  const note = periods.find(p => p.period === selected)?.upload_notes

  // Computed totals
  const njCogsTotal  = get('nj','cogs_material') + get('nj','cogs_labor') + get('nj','cogs_wip') + get('nj','cogs_other')
  const bnyCogsTotal = get('bny','cogs_material') + get('bny','cogs_labor') + get('bny','cogs_wip') + get('bny','cogs_other')
  const shCogsTotal  = get('shared','cogs_material') + get('shared','cogs_labor') + get('shared','cogs_wip') + get('shared','cogs_other')

  const njOpexTotal  = ['salary','salary_ot','fringe','te','printing','distribution','office_edp','consulting','building','utilities','rent'].reduce((s,k) => s + get('nj',k), 0)
  const bnyOpexTotal = ['salary','salary_ot','fringe','te','printing','distribution','office_edp','consulting','building','utilities','rent'].reduce((s,k) => s + get('bny',k), 0)
  const shOpexTotal  = ['salary','salary_ot','fringe','te','printing','distribution','office_edp','consulting','building','utilities','rent'].reduce((s,k) => s + get('shared',k), 0)

  const njVendors  = data?.nj?.inv_vendors  || []
  const bnyVendors = data?.bny?.inv_vendors || []

  return (
    <div className={styles.wrap}>
      {/* Header */}
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.title}>Financial Summary</h2>
          <p className={styles.sub}>Month-to-date COGS, operating expenses &amp; inventory purchases</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Current month badge */}
          {currentPeriod && (
            <span className={styles.periodBtnActive} style={{ padding: '6px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, background: '#1C1C1E', color: '#fff' }}>
              {periodLabel(currentPeriod)}
            </span>
          )}
          {/* Browse history — only show if there are past months with data */}
          {periods.length > 0 && (
            <select
              value={selected || ''}
              onChange={e => setSelected(e.target.value)}
              style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', color: 'var(--ink-60)', background: 'transparent', cursor: 'pointer' }}
            >
              {currentPeriod && <option value={currentPeriod}>{periodLabel(currentPeriod)}{!currentPeriodHasData ? ' (no data)' : ''}</option>}
              {periods.filter(p => p.period !== currentPeriod).map(p => (
                <option key={p.period} value={p.period}>{periodLabel(p.period)}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {!currentPeriodHasData && (
        <div className={styles.emptyMonth}>
          <p>No financial data uploaded for <strong>{currentPeriod ? periodLabel(currentPeriod) : 'this month'}</strong> yet.</p>
          <p>Upload the GP purchase report for this month in Admin → Financial Data.</p>
        </div>
      )}
      {currentPeriodHasData && note && <div className={styles.noteBanner}>📌 {note}</div>}

      {data && currentPeriodHasData && (
        <>
          {/* Top summary cards */}
          <div className={styles.summaryCards}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Total COGS MTD</div>
              <div className={styles.cardVal}>{fmtD(njCogsTotal + bnyCogsTotal + shCogsTotal)}</div>
              <div className={styles.cardSplit}>NJ {fmtD(njCogsTotal)} · BNY {fmtD(bnyCogsTotal)} · Shared {fmtD(shCogsTotal)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Total OpEx MTD</div>
              <div className={styles.cardVal}>{fmtD(njOpexTotal + bnyOpexTotal + shOpexTotal)}</div>
              <div className={styles.cardSplit}>NJ {fmtD(njOpexTotal)} · BNY {fmtD(bnyOpexTotal)} · Shared {fmtD(shOpexTotal)}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>NJ Inventory Purchases</div>
              <div className={styles.cardVal}>{fmtD(get('nj','inv_purchases'))}</div>
              <div className={styles.cardSplit}>{njVendors.length} vendor{njVendors.length !== 1 ? 's' : ''} · see breakdown below</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>BNY Inventory Purchases</div>
              <div className={styles.cardVal}>{fmtD(get('bny','inv_purchases'))}</div>
              <div className={styles.cardSplit}>{bnyVendors.length} vendor{bnyVendors.length !== 1 ? 's' : ''} · see breakdown below</div>
            </div>
          </div>

          {/* COGS table */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Cost of Goods Sold (COGS)</div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.labelCol}></th>
                    <th><span className={styles.facilityBadge}>NJ</span> Passaic</th>
                    <th><span className={`${styles.facilityBadge} ${styles.badgeBNY}`}>BK</span> Brooklyn</th>
                    <th><span className={`${styles.facilityBadge} ${styles.badgeSH}`}>SH</span> Shared</th>
                    <th className={styles.combined}>Combined</th>
                  </tr>
                </thead>
                <tbody>
                  <SectionRow label="Material"  nj={get('nj','cogs_material')} bny={get('bny','cogs_material')} shared={get('shared','cogs_material')} indent />
                  <SectionRow label="Labor"     nj={get('nj','cogs_labor')}    bny={get('bny','cogs_labor')}    shared={get('shared','cogs_labor')} indent />
                  <SectionRow label="WIP"       nj={get('nj','cogs_wip')}      bny={get('bny','cogs_wip')}      shared={get('shared','cogs_wip')} indent />
                  <SectionRow label="Other"     nj={get('nj','cogs_other')}    bny={get('bny','cogs_other')}    shared={get('shared','cogs_other')} indent />
                  <SectionRow label="COGS Total" nj={njCogsTotal} bny={bnyCogsTotal} shared={shCogsTotal} isTotal />
                </tbody>
              </table>
            </div>
          </div>

          {/* OpEx table */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Operating Expenses</div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.labelCol}></th>
                    <th><span className={styles.facilityBadge}>NJ</span> Passaic</th>
                    <th><span className={`${styles.facilityBadge} ${styles.badgeBNY}`}>BK</span> Brooklyn</th>
                    <th><span className={`${styles.facilityBadge} ${styles.badgeSH}`}>SH</span> Shared</th>
                    <th className={styles.combined}>Combined</th>
                  </tr>
                </thead>
                <tbody>
                  <SectionRow label="Salaries"             nj={get('nj','salary')}       bny={get('bny','salary')}       shared={get('shared','salary')} indent />
                  <SectionRow label="Overtime / Temp"      nj={get('nj','salary_ot')}    bny={get('bny','salary_ot')}    shared={get('shared','salary_ot')} indent />
                  <SectionRow label="Fringe / Benefits"    nj={get('nj','fringe')}       bny={get('bny','fringe')}       shared={get('shared','fringe')} indent />
                  <SectionRow label="T&amp;E"              nj={get('nj','te')}            bny={get('bny','te')}           shared={get('shared','te')} indent />
                  <SectionRow label="Printing / Consumab." nj={get('nj','printing')}     bny={get('bny','printing')}     shared={get('shared','printing')} indent />
                  <SectionRow label="Distribution"         nj={get('nj','distribution')} bny={get('bny','distribution')} shared={get('shared','distribution')} indent />
                  <SectionRow label="Office / EDP"         nj={get('nj','office_edp')}   bny={get('bny','office_edp')}   shared={get('shared','office_edp')} indent />
                  <SectionRow label="Consulting"           nj={get('nj','consulting')}   bny={get('bny','consulting')}   shared={get('shared','consulting')} indent />
                  <SectionRow label="Building / Maint."    nj={get('nj','building')}     bny={get('bny','building')}     shared={get('shared','building')} indent />
                  <SectionRow label="Utilities"            nj={get('nj','utilities')}    bny={get('bny','utilities')}    shared={get('shared','utilities')} indent />
                  <SectionRow label="Rent"                 nj={get('nj','rent')}         bny={get('bny','rent')}         shared={get('shared','rent')} indent />
                  <SectionRow label="OpEx Total" nj={njOpexTotal} bny={bnyOpexTotal} shared={shOpexTotal} isTotal />
                  <tr className={styles.contraRow}>
                    <td className={`${styles.rowLabel} ${styles.indent}`}>Capitalization (contra)</td>
                    <td className={styles.val}>{fmtD(get('nj','capitalization'))}</td>
                    <td className={styles.val}>{fmtD(get('bny','capitalization'))}</td>
                    <td className={styles.val}>{fmtD(get('shared','capitalization'))}</td>
                    <td className={`${styles.val} ${styles.combined}`}>{fmtD(get('nj','capitalization') + get('bny','capitalization') + get('shared','capitalization'))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Inventory purchases */}
          {(get('nj','inv_purchases') > 0 || get('bny','inv_purchases') > 0) && (
            <div className={styles.twoCol}>
              {[{bu:'nj', label:'NJ Passaic', badge:'NJ', vendors:njVendors}, {bu:'bny', label:'BNY Brooklyn', badge:'BK', vendors:bnyVendors, bny:true}].map(f => (
                <div key={f.bu} className={styles.section}>
                  <div className={styles.sectionTitle}>
                    <span className={`${styles.facilityBadge} ${f.bny ? styles.badgeBNY : ''}`}>{f.badge}</span>
                    {f.label} — Inventory Purchases
                  </div>
                  <div className={styles.invTotal}>{fmtD(get(f.bu,'inv_purchases'))}</div>
                  {f.vendors.length > 0 && (
                    <table className={styles.vendorTable}>
                      <tbody>
                        {f.vendors.map((v,i) => (
                          <tr key={i}>
                            <td className={styles.vendorName}>
                              {v.name.replace(/ - FOR (PARAMOUNT|BNY)/i,'').replace(/,CO\.LTD\./i,'').trim()}
                            </td>
                            <td className={styles.vendorAmt}>{fmtD(v.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── AP Section ── */}
      {(apData?.paramount || apData?.bny) && (() => {
        const fmtAP = n => n ? '$'+Math.round(n).toLocaleString() : '—'
        const para = apData.paramount, bny = apData.bny
        const totalBalance = (para?.total||0)+(bny?.total||0)
        const totalPastDue = (para?.past_due||0)+(bny?.past_due||0)
        return (
          <div className={styles.section} style={{marginTop:32}}>
            <div className={styles.sectionTitle}>Accounts Payable</div>
            {/* Summary cards */}
            <div style={{display:'flex',gap:16,marginBottom:20,flexWrap:'wrap'}}>
              {[
                {label:'Total AP Balance',   val:fmtAP(totalBalance), sub:'Both facilities combined'},
                {label:'Total Past Due',     val:fmtAP(totalPastDue), sub:'All aging buckets', alert:totalPastDue>0},
                {label:'Paramount Balance',  val:fmtAP(para?.total),  sub:`Past due: ${fmtAP(para?.past_due)}`},
                {label:'BNY Balance',        val:fmtAP(bny?.total),   sub:`Past due: ${fmtAP(bny?.past_due)}`},
              ].map(c=>(
                <div key={c.label} className={styles.card} style={{flex:1,minWidth:160,border:c.alert?'1px solid #fecaca':undefined}}>
                  <div className={styles.cardLabel}>{c.label}</div>
                  <div className={styles.cardVal} style={{color:c.alert?'#b91c1c':undefined}}>{c.val}</div>
                  <div className={styles.cardSplit}>{c.sub}</div>
                </div>
              ))}
            </div>
            {/* Aging table */}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr>
                  <th className={styles.labelCol}>Facility</th>
                  <th>Total</th><th>Current</th><th>1–7d</th><th>8–14d</th><th>15–30d</th><th>31–45d</th><th>45d+</th>
                  <th className={styles.combined}>Past Due</th>
                </tr></thead>
                <tbody>
                  {[{label:'Paramount',d:para},{label:'BNY',d:bny}].filter(r=>r.d).map(({label,d})=>(
                    <tr key={label}>
                      <td className={styles.rowLabel} style={{fontWeight:600}}>{label}</td>
                      {[d.total,d.current,d.days1_7,d.days8_14,d.days15_30,d.days31_45,d.days45plus].map((v,i)=>(
                        <td key={i} className={styles.val}>{fmtAP(v)}</td>
                      ))}
                      <td className={`${styles.val} ${styles.combined}`} style={{color:d.past_due>0?'#b91c1c':'#15803d',fontWeight:600}}>{fmtAP(d.past_due)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Top vendors */}
            <div className={styles.twoCol} style={{marginTop:16}}>
              {[{label:'Paramount',d:para},{label:'BNY',d:bny}].filter(r=>r.d&&r.d.top_vendors?.length).map(({label,d})=>(
                <div key={label}>
                  <div style={{fontSize:11,fontWeight:700,color:'var(--ink-40)',letterSpacing:'0.05em',textTransform:'uppercase',marginBottom:8}}>{label} — Top Vendors</div>
                  <table className={styles.vendorTable}>
                    <tbody>
                      {d.top_vendors.slice(0,6).map((v,i)=>(
                        <tr key={i}>
                          <td className={styles.vendorName}>{v.name?.slice(0,30)}</td>
                          <td className={styles.vendorAmt}>{fmtAP(v.balance)}</td>
                          {v.pastDue>0&&<td style={{fontSize:11,color:'#b91c1c',paddingLeft:8}}>({fmtAP(v.pastDue)} overdue)</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* ── AR Section ── */}
      {arData && (() => {
        const fmtAR = n => n ? '$'+Math.round(n).toLocaleString() : '—'
        return (
          <div className={styles.section} style={{marginTop:32}}>
            <div className={styles.sectionTitle}>Accounts Receivable</div>
            {/* Summary cards */}
            <div style={{display:'flex',gap:16,marginBottom:20,flexWrap:'wrap'}}>
              {[
                {label:'Total Outstanding', val:fmtAR(arData.total_outstanding), sub:'All aging buckets'},
                {label:'Current',           val:fmtAR(arData.aging_current),      sub:'Not yet due'},
                {label:'Total Past Due',    val:fmtAR(arData.total_past_due),     sub:'1–30d through 91d+', alert:arData.total_past_due>0},
              ].map(c=>(
                <div key={c.label} className={styles.card} style={{flex:1,minWidth:160,border:c.alert?'1px solid #fecaca':undefined}}>
                  <div className={styles.cardLabel}>{c.label}</div>
                  <div className={styles.cardVal} style={{color:c.alert?'#b91c1c':undefined}}>{c.val}</div>
                  <div className={styles.cardSplit}>{c.sub}</div>
                </div>
              ))}
            </div>
            {/* Aging buckets */}
            <div style={{display:'flex',gap:0,border:'1px solid var(--border)',borderRadius:8,overflow:'hidden',marginBottom:20}}>
              {[['Current',arData.aging_current,false],['1–30d',arData.aging_1_30,true],['31–60d',arData.aging_31_60,true],['61–90d',arData.aging_61_90,true],['91d+',arData.aging_91plus,true]]
                .map(([label,val,isPast],i,arr)=>(
                <div key={label} style={{flex:1,padding:'12px 8px',textAlign:'center',borderRight:i<arr.length-1?'1px solid var(--border)':'none',background:'var(--cream)'}}>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--ink-40)',marginBottom:4}}>{label}</div>
                  <div style={{fontSize:16,fontWeight:700,color:!isPast?'#15803d':val>50000?'#b91c1c':'#b45309'}}>{fmtAR(val)}</div>
                </div>
              ))}
            </div>
            {/* Key accounts */}
            {arData.key_accounts?.length>0&&(
              <>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:'0.05em',textTransform:'uppercase',color:'var(--ink-40)',marginBottom:10}}>Key Accounts to Watch</div>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead><tr>
                      <th className={styles.labelCol}>Account</th>
                      <th>Unapplied</th><th>Current</th>
                      <th className={styles.combined}>Past Due</th>
                      <th style={{textAlign:'left',paddingLeft:12}}>Notes</th>
                    </tr></thead>
                    <tbody>
                      {arData.key_accounts.map((a,i)=>(
                        <tr key={i}>
                          <td className={styles.rowLabel} style={{fontWeight:500}}>{a.name}</td>
                          <td className={styles.val}>{fmtAR(a.unapplied)}</td>
                          <td className={styles.val}>{fmtAR(a.current)}</td>
                          <td className={`${styles.val} ${styles.combined}`} style={{color:a.pastDue>0?'#b91c1c':'#15803d',fontWeight:a.pastDue>0?600:400}}>{fmtAR(a.pastDue)}</td>
                          <td style={{padding:'6px 12px',fontSize:12,color:'var(--ink-60)'}}>{a.notes?.slice(0,80)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )
      })()}

      {/* ── Cash placeholder ── */}
      <div className={styles.section} style={{marginTop:32,opacity:0.5}}>
        <div className={styles.sectionTitle}>Cash Position</div>
        <div style={{background:'var(--cream)',border:'1px dashed var(--border)',borderRadius:8,padding:'24px',textAlign:'center',color:'var(--ink-40)',fontSize:13}}>
          Cash reporting coming soon — upload cash file in Admin → Financials when available.
        </div>
      </div>

    </div>
  )
}
