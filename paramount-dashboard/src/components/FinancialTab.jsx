import React, { useState, useEffect } from 'react'
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

export default function FinancialTab({ weekStart }) {
  const [periods, setPeriods]     = useState([])
  const [selected, setSelected]   = useState(null)
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(false)

  // Derive calendar month from weekStart — period is always "YYYY-MM"
  const currentPeriod = weekStart
    ? `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}`
    : null

  // Single effect: whenever currentPeriod changes, load everything fresh
  useEffect(() => {
    if (!currentPeriod) return
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
      // Load period list and current period's data in parallel
      const [periodsRes, dataRes] = await Promise.all([
        supabase.from('financials_monthly').select('period, uploaded_at, upload_notes').order('period', { ascending: false }),
        supabase.from('financials_monthly').select('*').eq('period', period)
      ])
      // Update periods list
      if (periodsRes.data && periodsRes.data.length > 0) {
        const seen = new Set()
        const unique = periodsRes.data.filter(r => {
          if (seen.has(r.period)) return false
          seen.add(r.period); return true
        })
        setPeriods(unique)
      } else {
        setPeriods([])
      }
      setSelected(period)
      // Update data
      if (dataRes.data && dataRes.data.length > 0) {
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
      const { data: rows } = await supabase.from('financials_monthly').select('*').eq('period', period)
      if (rows && rows.length > 0) {
        setData({
          nj:     rows.find(r => r.business_unit === BU_NJ)     || null,
          bny:    rows.find(r => r.business_unit === BU_BNY)    || null,
          shared: rows.find(r => r.business_unit === BU_SHARED) || null,
        })
      }
    } catch(e) {
      console.error('loadForPeriod error:', e)
    } finally {
      setLoading(false)
    }
  }

  const get = (bu, field) => {
    const row = bu === 'nj' ? data?.nj : bu === 'bny' ? data?.bny : data?.shared
    return row ? parseFloat(row[field]) || 0 : 0
  }

  const sum3 = (field) => get('nj', field) + get('bny', field) + get('shared', field)

  const periodLabel = p => {
    if (!p) return ''
    const [yr, mo] = p.split('-')
    return `${MONTH_NAMES[mo]} ${yr}`
  }

  if (loading) return <div className={styles.empty}>Loading…</div>

  // Show message when current month has no data
  const currentPeriodHasData = periods.some(p => p.period === selected)

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
          <p>No financial data uploaded for <strong>{periodLabel(currentPeriod)}</strong> yet.</p>
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
    </div>
  )
}
