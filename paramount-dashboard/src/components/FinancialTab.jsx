import React, { useState, useEffect, useMemo } from 'react'
import { FISCAL_CALENDAR } from '../fiscalCalendar'
import { supabase } from '../supabase'
import styles from './FinancialTab.module.css'

// -- Fiscal resolution (Sunday-anchored, mirrors the purchases parser) --
const MONTH_NUM = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' }
const MONTH_LABEL = { '01':'January','02':'February','03':'March','04':'April','05':'May','06':'June','07':'July','08':'August','09':'September','10':'October','11':'November','12':'December' }
const _weeks = Object.entries(FISCAL_CALENDAR).map(([k,info]) => {
  const mon = new Date(k + 'T12:00:00')
  const sun = new Date(mon); sun.setDate(sun.getDate() - 1)
  const sat = new Date(mon); sat.setDate(sat.getDate() + 5)
  return { k, info, sun, sat }
}).sort((a,b) => a.sun - b.sun)
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
// Normalize ANY input (Date object, ISO string, or other date string) to YYYY-MM-DD.
// This is the fix for the "every week identical / stuck on Loading" bug: weekStart arrives
// as a Date object, and slicing String(Date) yielded "Sun Jun 14" which never parsed.
function toISODate(v) {
  if (!v) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : isoOf(v)
  const s = String(v)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : isoOf(d)
}
// Resolve a date to its fiscal month, year, week-in-month, and the Sun-Sat span.
function fiscalForDate(input) {
  const iso = toISODate(input)
  if (!iso) return null
  const t = new Date(iso + 'T12:00:00')
  for (const w of _weeks) if (t >= w.sun && t <= w.sat) {
    const yr = w.k.slice(0,4)
    return {
      fiscalMonth: `${yr}-${MONTH_NUM[w.info.month]}`,
      fiscalYear: yr,
      fiscalWeek: w.info.weekInMonth,
      weekSun: isoOf(w.sun),
      weekSat: isoOf(w.sat),
    }
  }
  return null
}
const monthLabel = m => { if (!m) return ''; const [y,mo] = m.split('-'); return `${MONTH_LABEL[mo]||mo} ${y}` }
const todayISO = () => isoOf(new Date())

// Stale = older than 7 days from today. Returns true/false/null (null when no data).
function isStale(dateStr) {
  if (!dateStr) return null
  const then = new Date(dateStr + 'T12:00:00')
  const now = new Date()
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24))
  return days > 7
}

// -- Formatters --
const fmtD = (v, opts={}) => {
  if (v === null || v === undefined || v === '') return '—'
  const n = parseFloat(v) || 0
  if (Math.abs(n) < 0.5) return '—'
  const abs = Math.abs(Math.round(n)).toLocaleString()
  return (n < 0 ? '-$' : (opts.plus && n > 0 ? '+$' : '$')) + abs
}
const COGS_CATS = ['material_inventory','ink','freight']
const OPEX_CATS = ['opex_temp','opex_te','opex_distribution','opex_edp','opex_supplies','opex_printing','opex_services','opex_utilities','opex_rent','opex_other']
const OPEX_LABEL = {
  opex_temp:'Temp / Contract', opex_te:'Travel & Entertainment', opex_distribution:'Distribution',
  opex_edp:'Office / EDP', opex_supplies:'Supplies', opex_printing:'Printing', opex_services:'Outside Services',
  opex_utilities:'Utilities', opex_rent:'Rent', opex_other:'Other OpEx',
}

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

export default function FinancialTab({ weekStart, section = 'all' }) {
  // section: 'all' (legacy) | 'spend' (Spend detail tab — everything BUT the
  // aging) | 'arap' (the AR / AP tab — ONLY the aging). One component, one
  // data load, two doors: the aging moved to its own first-class tab 8/2026
  // but shares every hook and view with the spend side, so the two tabs
  // cannot disagree.
  const showSpend = section !== 'arap'
  const showAging = section !== 'spend'
  const [scope, setScope]       = useState('MTD')
  const [selMonth, setSelMonth] = useState(null)
  const [months, setMonths]     = useState([])
  // Single data bundle TAGGED with the exact query params it was fetched for. The render
  // only trusts it when its key matches the currently-selected (month, week) -- so a stale
  // response from rapid week-scrolling is simply never displayed (race-proof by construction).
  const [data, setData]         = useState({ key: null, mtd: [], ytd: [], aging: [] })
  // Third-party vs FSCO intercompany split of AR receipts. NOT available from
  // finance_rollup, which aggregates by category and business unit only — so it
  // is fetched separately. This matters because most "cash in" is FSCO paying
  // itself: July 2026 was $1,085,556 intercompany against $95,450 of real
  // third-party money. A single "net cash flow" number hides that entirely.
  const [cashSplit, setCashSplit] = useState({ key: null, third: 0, inter: 0 })
  const [loading, setLoading]   = useState(false)
  const [narrative, setNarrative] = useState('')
  const [genBusy, setGenBusy]   = useState(false)
  const [userPickedMonth, setUserPickedMonth] = useState(false)
  // Freshness signals -- independent of week selection, fetched once on mount.
  // Per-source-appropriate: purchases uses upload date, aging uses as_of_date.
  // Red when > 7 days old, neutral otherwise.
  const [freshness, setFreshness] = useState({ purchases: null, aging: null })
  // Which aging bucket is expanded to party detail: { type:'ar'|'ap', key } | null
  const [expandedAging, setExpandedAging] = useState(null)

  // The top-nav week picker is the primary driver.
  // NOTE: no today-fallback here -- a fallback masks out-of-range (future) weeks and
  // defeats the future guard. derived may be null when weekStart is past the calendar.
  const derived = useMemo(() => fiscalForDate(weekStart), [weekStart])
  // The selected week's Sunday, normalized from whatever weekStart is (Date or string).
  const selSunday = toISODate(weekStart) || todayISO()

  // discover available months once (paginated -- the 1000-row cap could otherwise hide
  // older months even with the desc order)
  useEffect(() => { (async () => {
    let from = 0, all = []
    for (let g = 0; g < 50; g++) {
      const { data } = await supabase.from('financial_transactions').select('fiscal_month').order('id',{ascending:true}).range(from, from + 999)
      if (!data || data.length === 0) break
      all = all.concat(data)
      if (data.length < 1000) break
      from += 1000
    }
    const uniq = [...new Set(all.map(r => r.fiscal_month).filter(Boolean))].sort((a,b)=>b.localeCompare(a))
    if (uniq.length) setMonths(uniq)
  })() }, [])

  // Freshness fetch -- once on mount. Doesn't change with week selection.
  useEffect(() => { (async () => {
    const [pRes, aRes] = await Promise.all([
      supabase.from('financial_transactions').select('uploaded_at').order('uploaded_at',{ascending:false}).limit(1),
      supabase.from('financial_aging').select('as_of_date').order('as_of_date',{ascending:false}).limit(1),
    ])
    setFreshness({
      purchases: pRes.data?.[0]?.uploaded_at ? pRes.data[0].uploaded_at.slice(0,10) : null,
      aging: aRes.data?.[0]?.as_of_date || null,
    })
  })() }, [])

  // selMonth follows the week picker UNLESS the user explicitly chose a month from the dropdown.
  // Safety net: if the week can't be resolved, fall back to the newest loaded month so the
  // tab never hangs on "Loading…".
  useEffect(() => {
    if (userPickedMonth) return
    if (derived?.fiscalMonth) { setSelMonth(derived.fiscalMonth); return }
    if (!selMonth && months.length) setSelMonth(months[0])
  }, [derived?.fiscalMonth, userPickedMonth, months])

  // Are we viewing the same month the week picker points at? (vs. a month jumped-to via dropdown)
  const viewingDerivedMonth = selMonth && derived && selMonth === derived.fiscalMonth
  // Week cap: when on the picker's own month, cap at the selected fiscal week; when
  // browsing a different month via dropdown, show that month in full (99 = no cap).
  const weekCap = viewingDerivedMonth ? derived.fiscalWeek : 99

  // The query key that uniquely identifies what SHOULD be on screen right now.
  const currentKey = selMonth ? `${selMonth}:${weekCap}` : null

  // Refetch whenever the key changes. The fetched bundle is stamped with the key it was
  // fetched for; render only uses it when data.key === currentKey, so an out-of-order
  // (stale) response can never be displayed -- it just sits with a non-matching key.
  useEffect(() => { if (currentKey) loadAll(selMonth, weekCap, currentKey) }, [currentKey])

  async function loadAll(fm, wk, key) {
    setLoading(true); setNarrative('')
    // Server-side rollup sums in Postgres and returns ~30 pre-aggregated rows (scope=MTD|YTD,
    // per category x business_unit). No client pagination -> no truncation/page-skew.
    const [rollRes, agRes] = await Promise.all([
      supabase.rpc('finance_rollup', { p_month: fm, p_week: wk }),
      supabase.from('financial_aging').select('as_of_date,aging_type,business_unit,party_name,balance,past_due,buckets').order('as_of_date',{ascending:false}),
    ])
    const roll = rollRes.data || []
    setData({
      key,
      mtd: roll.filter(r => r.scope === 'MTD'),
      ytd: roll.filter(r => r.scope === 'YTD'),
      aging: agRes.data || [],
    })

    // AR receipts split by counterparty. Every FSCO entity is named
    // "F. SCHUMACHER & CO - <something>", so the match is reliable.
    try {
      const { data: rcv } = await supabase.from('financial_transactions')
        .select('master_name,net,fiscal_week')
        .eq('fiscal_month', fm).eq('source_tab', 'ar_received')
      let third = 0, inter = 0
      for (const r of (rcv || [])) {
        if (wk !== 99 && (r.fiscal_week || 0) > wk) continue
        const n = Math.abs(r.net || 0)
        if (/schumacher|fsco/i.test(r.master_name || '')) inter += n
        else third += n
      }
      setCashSplit({ key, third, inter })
    } catch { setCashSplit({ key, third: 0, inter: 0 }) }

    setLoading(false)
  }

  // Future guard -- independent of the calendar lookup: the selected week's Sunday is after
  // today. This catches both in-calendar future weeks (e.g. June wk5) AND weeks past the end
  // of the loaded calendar (e.g. July), which previously slipped through.
  const isFutureWeek = selSunday > todayISO()

  // Only trust the data bundle if it was fetched for the currently-selected key.
  const dataReady = data.key && data.key === currentKey
  const aging = dataReady ? data.aging : []

  // Rows arrive from finance_rollup already capped at the selected week (MTD = selected month
  // through wk; YTD = prior months full + selected month through wk), so no client-side
  // week filtering is needed -- just pick the scope.
  const rows = !dataReady ? [] : (scope === 'MTD' ? data.mtd : data.ytd)

  // -- Aging: latest snapshot + trend + per-party detail --
  const agingView = useMemo(() => {
    const byDate = {}
    for (const a of aging) {
      const k = `${a.as_of_date}|${a.aging_type}`
      if (!byDate[k]) byDate[k] = { as_of:a.as_of_date, type:a.aging_type, total:0, pastDue:0, buckets:{}, byBU:{}, parties:[] }
      const e = byDate[k]; e.total += (a.balance||0); e.pastDue += (a.past_due||0)
      for (const [bk,bv] of Object.entries(a.buckets||{})) e.buckets[bk] = (e.buckets[bk]||0) + (bv||0)
      const bu = a.business_unit || 'combined'; e.byBU[bu] = (e.byBU[bu]||0) + (a.balance||0)
      e.parties.push({ name: a.party_name || '(unnamed)', balance: a.balance || 0, buckets: a.buckets || {} })
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
        period: scope==='MTD' ? `${monthLabel(selMonth)} (through week ${weekCap})` : `FY${selMonth?.slice(0,4)} YTD through ${monthLabel(selMonth)} wk ${weekCap}`,
        est_cogs_material_basis: Math.round(cogs), opex: Math.round(opex), capex: Math.round(capex),
        ar_invoiced: Math.round(arInv), ar_received: Math.round(arRecv), ap_paid: Math.round(apPaid),
        ar_aging_total: Math.round(agingView.arNow?.total||0), ar_past_due: Math.round(agingView.arNow?.pastDue||0),
        ap_aging_total: Math.round(agingView.apNow?.total||0), ap_past_due: Math.round(agingView.apNow?.pastDue||0),
      }
      const resp = await fetch('/api/claude', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:600, messages:[{role:'user',
          content:`You are the President of Paramount Prints writing a brief, candid financial read for the C-suite (peer-to-peer BU leader voice, no fluff). Numbers below are spend/AR/AP for ${ctx.period}. Note COGS is an ESTIMATE on a material-spend basis (true posted COGS pending GP trial balance) -- say so once. 2-3 short paragraphs, plain text, no headers.\n\nDATA: ${JSON.stringify(ctx)}` }] })
      })
      const data = await resp.json()
      setNarrative((data.content||[]).map(b=>b.text||'').join('').trim())
    } catch(e) { setNarrative('Could not generate narrative: ' + e.message) }
    setGenBusy(false)
  }

  if (!selMonth) return <div className={styles.empty}>Loading financial data…</div>

  const cogsTotal = bu => sumWhere(rows, c=>COGS_CATS.includes(c), bu)
  const opexTotal = bu => sumWhere(rows, c=>OPEX_CATS.includes(c), bu)
  const capex = bu => sumWhere(rows, c=>c==='capex', bu)
  const arRecv = sumWhere(rows, c=>c==='ar_receipt')
  const apPaid = sumWhere(rows, c=>c==='ap_paid')
  const arInv  = sumWhere(rows, c=>c==='ar_trade'||c==='ar_adjustment')

  const hasData = rows.length > 0
  const weekHdr = isFutureWeek ? '—' : (viewingDerivedMonth ? `through wk ${derived.fiscalWeek}` : 'full month')

  // Freshness badge style -- red when stale (>7 days), neutral otherwise.
  const freshBadge = (label, dateStr) => {
    if (!dateStr) return null
    const stale = isStale(dateStr)
    return (
      <span style={{
        fontSize:11,
        padding:'3px 8px',
        borderRadius:4,
        border:`1px solid ${stale ? 'var(--red)' : 'var(--border)'}`,
        color: stale ? 'var(--red)' : 'var(--ink-60)',
        background: stale ? 'rgba(220,38,38,0.08)' : 'transparent',
        fontWeight: stale ? 600 : 500,
        whiteSpace:'nowrap',
      }}>
        {label}: {dateStr}
      </span>
    )
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.title}>{section === 'arap' ? 'AR / AP' : 'Financial Summary'}</h2>
          <p className={styles.sub}>{section === 'arap'
            ? <>Receivables &amp; payables aging · from the weekly finance file</>
            : <>{scope==='MTD' ? `Month-to-date ${weekHdr}` : `Fiscal year-to-date ${weekHdr}`} · spend &amp; cash flow · <span style={{color:'var(--ink-40)'}}>COGS estimated on material-spend basis</span></>}</p>
          <div style={{display:'flex',gap:8,marginTop:8,flexWrap:'wrap'}}>
            {section !== 'arap' && freshBadge('Purchases', freshness.purchases)}
            {freshBadge('AR/AP aging', freshness.aging)}
          </div>
        </div>
        {section !== 'arap' && (
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <div className={styles.periodPicker}>
            {['MTD','YTD'].map(sName => (
              <button key={sName} className={`${styles.periodBtn} ${scope===sName?styles.periodBtnActive:''}`} onClick={()=>setScope(sName)}>{sName}</button>
            ))}
          </div>
          {months.length > 0 && (
            <select value={selMonth||''} onChange={e=>{ setUserPickedMonth(true); setSelMonth(e.target.value) }}
              style={{fontSize:12,padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',background:'transparent',color:'var(--ink-60)',cursor:'pointer'}}>
              {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          )}
        </div>
        )}
      </div>

      {/* Future weeks need no data -- show the message regardless of load state. */}
      {isFutureWeek && (
        <div className={styles.empty}>No data for this week yet -- the week of {selSunday} hasn't started.</div>
      )}

      {/* Non-future: show Loading until the bundle matching the current selection arrives. */}
      {!isFutureWeek && (loading || !dataReady) && <div className={styles.empty}>Loading…</div>}

      {!isFutureWeek && !loading && dataReady && !hasData && (
        <div className={styles.empty}>No financial transactions for {monthLabel(selMonth)} {weekHdr} yet. Upload the GP Purchases workbook in Admin → Financial Data.</div>
      )}

      {!isFutureWeek && !loading && dataReady && hasData && (
        <>
          {showSpend && (<>
          {/* Summary cards */}
          <div className={styles.summaryCards}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>Est. COGS {scope}</div>
              <div className={styles.cardVal}>{fmtD(cogsTotal(null))}</div>
              <div className={styles.cardSplit}>Material {fmtD(sumWhere(rows,c=>c==='material_inventory'))} · Ink {fmtD(sumWhere(rows,c=>c==='ink'))} · Frt {fmtD(sumWhere(rows,c=>c==='freight'))}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>OpEx purchases {scope}</div>
              <div className={styles.cardVal}>{fmtD(opexTotal(null))}</div>
              <div className={styles.cardSplit}>NJ {fmtD(opexTotal('NJ'))} · BNY {fmtD(opexTotal('BNY'))} · Shared {fmtD(opexTotal('Shared'))}</div>
              <div style={{fontSize:10,color:'var(--amber)',marginTop:4}}>Purchased OpEx only — excludes payroll. See P&amp;L for full OpEx.</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>CapEx {scope}</div>
              <div className={styles.cardVal}>{fmtD(capex(null))}</div>
              <div className={styles.cardSplit}>NJ {fmtD(capex('NJ'))} · BNY {fmtD(capex('BNY'))}</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardLabel}>3rd-party receipts {scope}</div>
              <div className={styles.cardVal}>{fmtD(cashSplit.key === currentKey ? cashSplit.third : null)}</div>
              <div className={styles.cardSplit}>Intercompany {fmtD(cashSplit.key === currentKey ? cashSplit.inter : null)} · AP out {fmtD(apPaid)}</div>
              <div style={{fontSize:10,color:'var(--amber)',marginTop:4}}>Money from outside FSCO. Not net cash — payroll is not in this feed.</div>
            </div>
          </div>

          {/* Est. COGS table */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Estimated COGS -- Material Spend Basis</div>
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
            <div className={styles.sectionTitle}>Cash Flow -- AR In / AP Out <span style={{color:'var(--ink-40)',fontWeight:500,textTransform:'none',letterSpacing:0}}>· AR received includes FSCO intercompany</span></div>
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

          </>)}

          {/* AR / AP aging — grouped to the house scheme (Peter's spec,
              8/2026): AR Current = 0–30, past due = anything over 30. AP is
              grouped to the FILE's granularity (0–30 / 31–45 / 45+): FSCO AP
              terms are NET 60 and the source buckets stop at 45+, so exact
              over-60 past-due is NOT derivable — the 45+ cell irreducibly
              mixes 46–60 (within terms) with 61+ (past due). Chase-list item:
              Jen's AP tab re-bucketed to 31–60/61–90/91+ makes it exact.
              Every bucket clicks open to per-party detail — the table is
              party-level (135 AR / 59 AP parties), so who-owes-what is
              already in the data. */}
          {showAging && [
            { label:'Accounts Receivable', type:'ar', now:agingView.arNow, series:agingView.ar,
              groups:[
                { key:'g_cur',  label:'Current (0–30)', from:['current','d1_7','d8_30'], good:true },
                { key:'g_3160', label:'31–60', from:['d31_60'] },
                { key:'g_6190', label:'61–90', from:['d61_90'] },
                { key:'g_91',   label:'91+',   from:['d91plus'] },
              ],
              pdFrom:['d31_60','d61_90','d91plus'], pdLabel:'Past due (30+)', note:null },
            { label:'Accounts Payable', type:'ap', now:agingView.apNow, series:agingView.ap,
              groups:[
                { key:'g_cur',  label:'Current (0–30)', from:['current','d1_7','d8_14','d15_30'], good:true },
                { key:'g_3145', label:'31–45', from:['d31_45'] },
                { key:'g_45',   label:'45+',   from:['d45plus'] },
              ],
              pdFrom:['d45plus'], pdLabel:'Aged 45+',
              note:'FSCO AP terms are net 60 — the 45+ bucket includes 46–60 still within terms. Exact past-due needs 31–60 / 61–90 / 91+ buckets in the weekly file.' },
          ].map(sec => {
            if (!sec.now) return null
            const sumFrom = (buckets, from) => from.reduce((s, k) => s + (buckets?.[k] || 0), 0)
            const groupVals = sec.groups.map(g => ({ ...g, v: sumFrom(sec.now.buckets, g.from) }))
            const pdNow = sumFrom(sec.now.buckets, sec.pdFrom)
            const expKey = expandedAging && expandedAging.type === sec.type ? expandedAging.key : null
            const expGroup = expKey ? sec.groups.find(g => g.key === expKey) : null
            const partyRows = expGroup
              ? sec.now.parties
                  .map(p => ({ name: p.name, v: sumFrom(p.buckets, expGroup.from) }))
                  .filter(p => Math.abs(p.v) >= 0.5)
                  .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
              : []
            const shown = partyRows.slice(0, 18)
            const restN = partyRows.length - shown.length
            const restV = partyRows.slice(18).reduce((s, p) => s + p.v, 0)
            return (
            <div key={sec.type} className={styles.section}>
              <div className={styles.sectionTitle}>{sec.label} -- Aging <span style={{color:'var(--ink-40)',fontWeight:500,textTransform:'none',letterSpacing:0}}>as-of {sec.now.as_of} · click a bucket for who's in it</span></div>
              <div style={{display:'flex',flexWrap:'wrap'}}>
                {groupVals.map((g,i,arr)=>(
                  <div key={g.key}
                       onClick={()=>setExpandedAging(expKey===g.key?null:{type:sec.type,key:g.key})}
                       style={{flex:1,minWidth:110,padding:'12px 8px',textAlign:'center',cursor:'pointer',
                               borderRight:i<arr.length-1?'1px solid var(--border)':'none',
                               background: expKey===g.key ? 'var(--surface-2, rgba(255,255,255,0.04))' : 'transparent',
                               boxShadow: expKey===g.key ? 'inset 0 -2px 0 var(--ink-60)' : 'none'}}>
                    <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.05em',textTransform:'uppercase',color:'var(--ink-40)',marginBottom:4}}>{g.label}</div>
                    <div style={{fontSize:14,fontWeight:700,color:g.good?'var(--green)':'var(--ink)'}}>{fmtD(g.v)}</div>
                  </div>
                ))}
              </div>
              {expGroup && (
                <div style={{borderTop:'1px solid var(--border)',padding:'10px 16px',background:'var(--surface-2, rgba(255,255,255,0.02))'}}>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.05em',textTransform:'uppercase',color:'var(--ink-40)',marginBottom:8}}>
                    {expGroup.label} · {partyRows.length} {partyRows.length===1?'party':'parties'} · {fmtD(partyRows.reduce((s,p)=>s+p.v,0))}
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))',gap:'4px 24px'}}>
                    {shown.map(p=>(
                      <div key={p.name} style={{display:'flex',justifyContent:'space-between',fontSize:13,padding:'2px 0',borderBottom:'1px dotted var(--border)'}}>
                        <span style={{color:'var(--ink-60)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginRight:12}}>{p.name}</span>
                        <span style={{fontWeight:600,whiteSpace:'nowrap'}}>{fmtD(p.v)}</span>
                      </div>
                    ))}
                  </div>
                  {restN > 0 && (
                    <div style={{fontSize:12,color:'var(--ink-40)',marginTop:8}}>+ {restN} more · {fmtD(restV)}</div>
                  )}
                </div>
              )}
              <div style={{display:'flex',justifyContent:'space-between',padding:'10px 16px',borderTop:'1px solid var(--border)',fontSize:13}}>
                <span>Total <strong>{fmtD(sec.now.total)}</strong></span>
                <span style={{color:pdNow>0?'var(--red)':'var(--green)'}}>{sec.pdLabel} <strong>{fmtD(pdNow)}</strong></span>
              </div>
              {sec.note && (
                <div style={{padding:'6px 16px 10px',fontSize:11,color:'var(--ink-40)',borderTop:'1px dotted var(--border)'}}>{sec.note}</div>
              )}
              {sec.series.length > 1 && (
                <div style={{padding:'8px 16px',borderTop:'1px solid var(--border)'}}>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.05em',textTransform:'uppercase',color:'var(--ink-40)',marginBottom:6}}>{sec.pdLabel} trend</div>
                  <div style={{display:'flex',gap:8,alignItems:'flex-end',height:42}}>
                    {sec.series.map(pt=>{
                      const vals = sec.series.map(p=>sumFrom(p.buckets, sec.pdFrom))
                      const max = Math.max(...vals, 1)
                      const v = sumFrom(pt.buckets, sec.pdFrom)
                      return <div key={pt.as_of} title={`${pt.as_of}: ${fmtD(v)}`} style={{flex:1,display:'flex',flexDirection:'column',justifyContent:'flex-end',alignItems:'center',gap:3}}>
                        <div style={{width:'70%',height:`${Math.max(4,(v/max)*36)}px`,background:'var(--red)',opacity:0.7,borderRadius:2}}/>
                        <div style={{fontSize:9,color:'var(--ink-40)'}}>{pt.as_of.slice(5)}</div>
                      </div>
                    })}
                  </div>
                </div>
              )}
            </div>
            )
          })}

          {/* CEO narrative */}
          {showSpend && (
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
                : <div style={{fontSize:13,color:'var(--ink-40)'}}>Click "Draft with AI" for a brief exec read on the {scope} numbers.</div>}
            </div>
          </div>
          )}
        </>
      )}
    </div>
  )
}