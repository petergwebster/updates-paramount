import React, { useState, useEffect } from 'react'
import { format, subWeeks, startOfWeek } from 'date-fns'
import { supabase } from '../supabase'
import { getFiscalLabel } from '../fiscalCalendar'
import CommentButton from './CommentButton'
import styles from './ProductionDashboard.module.css'

const NJ_TARGETS = {
  fabric: { yards: 834, colorYards: 4522 },
  grass: { yards: 3785, colorYards: 7570 },
  paper: { yards: 3830, colorYards: 13405 },
  wasteTarget: 8,
}
const NJ_TOTAL_TARGET = NJ_TARGETS.fabric.yards + NJ_TARGETS.grass.yards + NJ_TARGETS.paper.yards

const BNY_TARGETS = { replen: 7886, mto: 1280, hos: 1532, memo: 211, contract: 1091, total: 12000 }

function weekKey(date) { return format(date, 'yyyy-MM-dd') }
function getWeekStart(d = new Date()) { return startOfWeek(d, { weekStartsOn: 1 }) }

function emptyNJ() {
  return {
    fabric: { yards: '', colorYards: '', waste: '', postWaste: '' },
    grass: { yards: '', colorYards: '', waste: '', postWaste: '' },
    paper: { yards: '', colorYards: '', waste: '', postWaste: '' },
    schWritten: '', schProduced: '', schInvoiced: '',
    tpWritten: '', tpProduced: '', tpInvoiced: '',
    commentary: '',
  }
}
function emptyBNY() {
  return { replen: '', mto: '', hos: '', memo: '', contract: '', schWritten: '', schProduced: '', schInvoiced: '', tpWritten: '', tpProduced: '', tpInvoiced: '', commentary: '' }
}

function n(v) { return parseFloat(v) || 0 }
function fmt(v) { return v ? Number(v).toLocaleString() : '—' }
function pct(val, target) { const v = n(val), t = n(target); return (v && t) ? Math.round((v/t)*100) : null }

function statusColor(val, target, inverse = false) {
  const p = pct(val, target)
  if (p === null) return 'gray'
  if (inverse) return p <= 8 ? 'green' : p <= 14 ? 'amber' : 'red'
  return p >= 90 ? 'green' : p >= 70 ? 'amber' : 'red'
}

function Dot({ status }) {
  return <span className={`${styles.dot} ${styles['dot_' + status]}`} />
}

function BarChart({ data }) {
  // data: [{label, value, target, color}]
  const maxVal = Math.max(...data.map(d => Math.max(n(d.value), n(d.target))), 1)
  return (
    <div className={styles.barChart}>
      {data.map((d, i) => {
        const valPct = Math.min((n(d.value) / maxVal) * 100, 100)
        const tgtPct = Math.min((n(d.target) / maxVal) * 100, 100)
        const status = statusColor(d.value, d.target)
        return (
          <div key={i} className={styles.barGroup}>
            <div className={styles.barLabel}>{d.label}</div>
            <div className={styles.barTrack}>
              <div className={styles.barTarget} style={{ width: tgtPct + '%' }} />
              <div className={`${styles.barFill} ${styles['barFill_' + status]}`} style={{ width: valPct + '%' }} />
            </div>
            <div className={styles.barValue}>{d.value ? Number(d.value).toLocaleString() : '—'}</div>
          </div>
        )
      })}
    </div>
  )
}

function Sparkline({ values, target }) {
  if (!values || values.filter(Boolean).length < 2) return null
  const max = Math.max(...values.map(n), target * 1.5, 1)
  const w = 80, h = 28, pts = values.length
  const points = values.map((v, i) => {
    const x = (i / (pts - 1)) * w
    const y = h - (n(v) / max) * h
    return `${x},${y}`
  }).join(' ')
  const tgtY = h - (n(target) / max) * h
  return (
    <svg width={w} height={h} className={styles.sparkline}>
      <line x1="0" y1={tgtY} x2={w} y2={tgtY} stroke="var(--ink-30)" strokeWidth="0.5" strokeDasharray="2,2" />
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function NumberInput({ label, value, onChange, placeholder, readOnly }) {
  return (
    <div className={styles.inputGroup}>
      <label className="label">{label}</label>
      <input type="number" value={value} onChange={e => onChange?.(e.target.value)} placeholder={placeholder || '0'} style={{ textAlign: 'right' }} readOnly={readOnly} />
    </div>
  )
}

export default function ProductionDashboard({ weekStart, dbReady }) {
  const [njData, setNjData] = useState(emptyNJ())
  const [bnyData, setBnyData] = useState(emptyBNY())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mode, setMode] = useState('view')
  const [history, setHistory] = useState([]) // last 5 weeks of data
  const isCurrentWeek = weekKey(weekStart) === weekKey(getWeekStart())
  const isPast = weekStart < getWeekStart()

  const [mtdData, setMtdData] = useState([]) // all weeks this fiscal month

  useEffect(() => { loadData(); loadHistory() }, [weekStart])

  async function loadData() {
    const { data } = await supabase.from('production').select('*').eq('week_start', weekKey(weekStart)).single()
    if (data) { setNjData(data.nj_data || emptyNJ()); setBnyData(data.bny_data || emptyBNY()) }
    else { setNjData(emptyNJ()); setBnyData(emptyBNY()) }
  }

  async function loadHistory() {
    // Load last 5 weeks for rolling table
    const weeks = Array.from({ length: 5 }, (_, i) => weekKey(subWeeks(weekStart, 4 - i)))
    const { data } = await supabase.from('production').select('*').in('week_start', weeks).order('week_start', { ascending: true })
    setHistory(data || [])

    // Load all weeks in current fiscal month for MTD
    // Find which fiscal month we're in and get all its week keys
    const { FISCAL_CALENDAR } = await import('../fiscalCalendar')
    const currentKey = weekKey(weekStart)
    const currentInfo = FISCAL_CALENDAR[currentKey]
    if (currentInfo) {
      const monthWeeks = Object.entries(FISCAL_CALENDAR)
        .filter(([, v]) => v.month === currentInfo.month && v.quarter === currentInfo.quarter)
        .map(([k]) => k)
        .sort()
      const { data: mtd } = await supabase.from('production').select('*').in('week_start', monthWeeks).order('week_start', { ascending: true })
      setMtdData(mtd || [])
    }
  }

  async function handleSave() {
    setSaving(true)
    await supabase.from('production').upsert({
      week_start: weekKey(weekStart), nj_data: njData, bny_data: bnyData, updated_at: new Date().toISOString(),
    }, { onConflict: 'week_start' })
    setSaving(false); setSaved(true); setMode('view')
    setTimeout(() => setSaved(false), 2500)
    loadHistory()
  }

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

  // Computed NJ totals
  const njTotalYards = ['fabric','grass','paper'].reduce((s,k) => s + n(njData[k]?.yards), 0)
  const njTotalColor = ['fabric','grass','paper'].reduce((s,k) => s + n(njData[k]?.colorYards), 0)
  const njTotalWaste = ['fabric','grass','paper'].reduce((s,k) => s + n(njData[k]?.waste), 0)
  const njNetYards = njTotalYards - njTotalWaste
  const njWastePct = njTotalYards > 0 ? ((njTotalWaste / njTotalYards) * 100).toFixed(1) : null
  const njTotalColorTarget = NJ_TARGETS.fabric.colorYards + NJ_TARGETS.grass.colorYards + NJ_TARGETS.paper.colorYards
  const invoicedGap = n(njData.schProduced) - n(njData.schInvoiced)

  // Computed BNY totals
  const bnyTotal = ['replen','mto','hos','memo','contract'].reduce((s,k) => s + n(bnyData[k]), 0)

  const hasData = njTotalYards > 0 || bnyTotal > 0

  // History data for charts/table
  const historyNJ = history.map(h => ({
    week: h.week_start,
    fiscal: getFiscalLabel(h.week_start),
    total: ['fabric','grass','paper'].reduce((s,k) => s + n(h.nj_data?.[k]?.yards), 0),
    waste: ['fabric','grass','paper'].reduce((s,k) => s + n(h.nj_data?.[k]?.waste), 0),
    fabric: n(h.nj_data?.fabric?.yards), grass: n(h.nj_data?.grass?.yards), paper: n(h.nj_data?.paper?.yards),
  }))
  const historyBNY = history.map(h => ({
    week: h.week_start,
    total: ['replen','mto','hos','memo','contract'].reduce((s,k) => s + n(h.bny_data?.[k]), 0),
  }))

  const wasteTrend = historyNJ.map(h => h.total > 0 ? ((h.waste / h.total) * 100).toFixed(1) : null)

  // MTD computations
  const mtdWeeksWithData = mtdData.length
  const mtdNJ = {
    fabric: mtdData.reduce((s,h) => s + n(h.nj_data?.fabric?.yards), 0),
    grass: mtdData.reduce((s,h) => s + n(h.nj_data?.grass?.yards), 0),
    paper: mtdData.reduce((s,h) => s + n(h.nj_data?.paper?.yards), 0),
    waste: mtdData.reduce((s,h) => s + ['fabric','grass','paper'].reduce((ss,k) => ss + n(h.nj_data?.[k]?.waste), 0), 0),
    total: mtdData.reduce((s,h) => s + ['fabric','grass','paper'].reduce((ss,k) => ss + n(h.nj_data?.[k]?.yards), 0), 0),
    schProduced: mtdData.reduce((s,h) => s + n(h.nj_data?.schProduced), 0),
    schInvoiced: mtdData.reduce((s,h) => s + n(h.nj_data?.schInvoiced), 0),
  }
  const mtdBNY = {
    total: mtdData.reduce((s,h) => s + ['replen','mto','hos','memo','contract'].reduce((ss,k) => ss + n(h.bny_data?.[k]), 0), 0),
    replen: mtdData.reduce((s,h) => s + n(h.bny_data?.replen), 0),
    mto: mtdData.reduce((s,h) => s + n(h.bny_data?.mto), 0),
    hos: mtdData.reduce((s,h) => s + n(h.bny_data?.hos), 0),
    memo: mtdData.reduce((s,h) => s + n(h.bny_data?.memo), 0),
    contract: mtdData.reduce((s,h) => s + n(h.bny_data?.contract), 0),
  }
  // Accumulating targets = weeks with data × weekly target
  const mtdNJTarget = { fabric: NJ_TARGETS.fabric.yards * mtdWeeksWithData, grass: NJ_TARGETS.grass.yards * mtdWeeksWithData, paper: NJ_TARGETS.paper.yards * mtdWeeksWithData, total: NJ_TOTAL_TARGET * mtdWeeksWithData }
  const mtdBNYTarget = { total: BNY_TARGETS.total * mtdWeeksWithData, replen: BNY_TARGETS.replen * mtdWeeksWithData, mto: BNY_TARGETS.mto * mtdWeeksWithData, hos: BNY_TARGETS.hos * mtdWeeksWithData, memo: BNY_TARGETS.memo * mtdWeeksWithData, contract: BNY_TARGETS.contract * mtdWeeksWithData }
  const mtdNJNet = mtdNJ.total - mtdNJ.waste
  const mtdNJWastePct = mtdNJ.total > 0 ? ((mtdNJ.waste / mtdNJ.total) * 100).toFixed(1) : null

  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.sectionTitle}>Production Dashboard</h2>
          <p className={styles.sectionSub}>
            Weekly capacity & KPI summary — Passaic NJ + Brooklyn
            {isPast && <span className={styles.historicalBadge}>Historical</span>}
          </p>
        </div>
        <div className={styles.actions}>
          {saved && <span className={styles.savedMsg}>Saved</span>}
          {mode === 'view' ? (
            <button onClick={() => setMode('edit')}>{isPast ? 'Edit Historical Data' : 'Enter This Week\'s Data'}</button>
          ) : (
            <>
              <button onClick={() => { setMode('view'); loadData() }}>Cancel</button>
              <button className="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save & View'}</button>
            </>
          )}
        </div>
      </div>

      {/* SUMMARY VIEW */}
      {mode === 'view' && hasData && (
        <div className={styles.summaryGrid}>
          {/* NJ */}
          <div className={`${styles.facilityCard} ${isPast ? styles.facilityCardHistorical : ''}`}>
            <div className={styles.facilityHeader}>
              <div className={styles.facilityTitle}><span className={styles.facilityBadge}>NJ</span>Passaic · Screen Print</div>
              <div className={styles.headerRight}>
                <Dot status={statusColor(njTotalYards, NJ_TOTAL_TARGET)} />
                <span className={styles.pctLabel}>{pct(njTotalYards, NJ_TOTAL_TARGET)}% of target</span>
                <CommentButton weekStart={weekStart} section="nj-summary" label="NJ Passaic Production" />
              </div>
            </div>

            <div className={styles.statsRow}>
              <div className={styles.statBlock}>
                <div className={styles.statLabel}>Produced</div>
                <div className={`${styles.statValue} ${styles['statValue_' + statusColor(njTotalYards, NJ_TOTAL_TARGET)]}`}>{fmt(njTotalYards)}<span className={styles.statUnit}>yds</span></div>
                <div className={styles.statTarget}>Target: {NJ_TOTAL_TARGET.toLocaleString()}</div>
              </div>
              <div className={styles.statBlock}>
                <div className={styles.statLabel}>Net Yards</div>
                <div className={`${styles.statValue} ${styles['statValue_' + statusColor(njNetYards, NJ_TOTAL_TARGET * 0.92)]}`}>{fmt(njNetYards)}<span className={styles.statUnit}>yds</span></div>
                <div className={styles.statTarget}>Produced − Waste</div>
              </div>
              <div className={styles.statBlock}>
                <div className={styles.statLabel}>Waste</div>
                <div className={`${styles.statValue} ${styles['statValue_' + statusColor(njWastePct, NJ_TARGETS.wasteTarget, true)]}`}>{njWastePct || '—'}<span className={styles.statUnit}>%</span></div>
                <div className={styles.statTarget}>{njTotalWaste > 0 ? njTotalWaste.toLocaleString() + ' yds · ' : ''}Target: &lt;8%</div>
              </div>
              <div className={styles.statBlock}>
                <div className={styles.statLabel}>Color Yards</div>
                <div className={`${styles.statValue} ${styles['statValue_' + statusColor(njTotalColor, njTotalColorTarget)]}`}>{fmt(njTotalColor)}<span className={styles.statUnit}>yds</span></div>
                <div className={styles.statTarget}>Target: {njTotalColorTarget.toLocaleString()}</div>
              </div>
            </div>

            <BarChart data={[
              { label: 'Fabric', value: njData.fabric.yards, target: NJ_TARGETS.fabric.yards },
              { label: 'Grass', value: njData.grass.yards, target: NJ_TARGETS.grass.yards },
              { label: 'Paper', value: njData.paper.yards, target: NJ_TARGETS.paper.yards },
            ]} />

            {(njData.schProduced || njData.tpProduced) && (
              <div className={styles.splitRow}>
                <div className={styles.splitItem}><span className={styles.splitLabel}>SCH produced</span><span className={styles.splitValue}>{fmt(njData.schProduced)} yds</span></div>
                <div className={styles.splitItem}><span className={styles.splitLabel}>3P produced</span><span className={styles.splitValue}>{fmt(njData.tpProduced)} yds</span></div>
                {njData.schInvoiced && <div className={styles.splitItem}>
                  <span className={styles.splitLabel}>Invoiced gap</span>
                  <span className={`${styles.splitValue} ${invoicedGap > 0 ? styles.gapPositive : styles.gapNegative}`}>{invoicedGap > 0 ? '+' : ''}{fmt(invoicedGap)} yds</span>
                </div>}
              </div>
            )}

            {njData.commentary && <div className={styles.commentary}>{njData.commentary}</div>}
          </div>

          {/* BNY */}
          <div className={`${styles.facilityCard} ${isPast ? styles.facilityCardHistorical : ''}`}>
            <div className={styles.facilityHeader}>
              <div className={styles.facilityTitle}><span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span>Brooklyn · Digital</div>
              <div className={styles.headerRight}>
                <Dot status={statusColor(bnyTotal, BNY_TARGETS.total)} />
                <span className={styles.pctLabel}>{pct(bnyTotal, BNY_TARGETS.total)}% of target</span>
                <CommentButton weekStart={weekStart} section="bny-summary" label="BNY Brooklyn Production" />
              </div>
            </div>

            <div className={styles.statsRow}>
              <div className={styles.statBlock}>
                <div className={styles.statLabel}>Total yards</div>
                <div className={`${styles.statValue} ${styles['statValue_' + statusColor(bnyTotal, BNY_TARGETS.total)]}`}>{fmt(bnyTotal)}<span className={styles.statUnit}>yds</span></div>
                <div className={styles.statTarget}>Target: {BNY_TARGETS.total.toLocaleString()}</div>
              </div>
              <div className={styles.statBlock}>
                <div className={styles.statLabel}>SCH invoiced</div>
                <div className={styles.statValue} style={{ color: 'var(--ink)' }}>{fmt(bnyData.schInvoiced)}<span className={styles.statUnit}>yds</span></div>
              </div>
            </div>

            <BarChart data={[
              { label: 'Replen', value: bnyData.replen, target: BNY_TARGETS.replen },
              { label: 'MTO', value: bnyData.mto, target: BNY_TARGETS.mto },
              { label: 'HOS', value: bnyData.hos, target: BNY_TARGETS.hos },
              { label: 'Memo', value: bnyData.memo, target: BNY_TARGETS.memo },
              { label: 'Contract', value: bnyData.contract, target: BNY_TARGETS.contract },
            ]} />

            {(bnyData.schProduced || bnyData.tpProduced) && (
              <div className={styles.splitRow}>
                <div className={styles.splitItem}><span className={styles.splitLabel}>SCH produced</span><span className={styles.splitValue}>{fmt(bnyData.schProduced)} yds</span></div>
                <div className={styles.splitItem}><span className={styles.splitLabel}>3P produced</span><span className={styles.splitValue}>{fmt(bnyData.tpProduced)} yds</span></div>
              </div>
            )}

            {bnyData.commentary && <div className={styles.commentary}>{bnyData.commentary}</div>}
          </div>
        </div>
      )}

      {mode === 'view' && !hasData && (
        <div className={styles.emptyState}>
          <p>{isPast ? 'No production data was entered for this week.' : 'No data entered yet for this week.'}</p>
          <button className="primary" style={{ marginTop: 12 }} onClick={() => setMode('edit')}>
            {isPast ? 'Add Historical Data' : 'Enter This Week\'s Data'}
          </button>
        </div>
      )}

      {/* ROLLING HISTORY TABLE */}
      {history.length > 0 && (
        <div className={styles.historySection}>
          <div className={styles.historySectionTitle}>NJ — Rolling 5-Week Capacity</div>
          <div className={styles.tableWrap}>
            <table className={styles.histTable}>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Fabric</th>
                  <th>Grass</th>
                  <th>Paper</th>
                  <th>Total</th>
                  <th>Waste</th>
                  <th>Net Yds</th>
                </tr>
                <tr className={styles.targetRow}>
                  <td>Target</td>
                  <td>{NJ_TARGETS.fabric.yards.toLocaleString()}</td>
                  <td>{NJ_TARGETS.grass.yards.toLocaleString()}</td>
                  <td>{NJ_TARGETS.paper.yards.toLocaleString()}</td>
                  <td>{NJ_TOTAL_TARGET.toLocaleString()}</td>
                  <td>&lt;8%</td>
                  <td>—</td>
                </tr>
              </thead>
              <tbody>
                {historyNJ.map((row, i) => {
                  const isCurrent = row.week === weekKey(weekStart)
                  const wastePct = row.total > 0 ? ((row.waste / row.total) * 100).toFixed(1) : null
                  const netYds = row.total - row.waste
                  const fiscalInfo = getFiscalLabel(row.week + 'T12:00:00')
                  const shortLabel = fiscalInfo ? fiscalInfo.split('·')[0].trim() : row.week
                  return (
                    <tr key={row.week} className={`${styles.dataRow} ${isCurrent ? styles.currentRow : styles.historicalRow}`}>
                      <td className={styles.weekCell}>
                        {shortLabel}
                        {isCurrent && <span className={styles.currBadge}>Current</span>}
                      </td>
                      <td><Dot status={statusColor(row.fabric, NJ_TARGETS.fabric.yards)} /> {row.fabric ? row.fabric.toLocaleString() : '—'}</td>
                      <td><Dot status={statusColor(row.grass, NJ_TARGETS.grass.yards)} /> {row.grass ? row.grass.toLocaleString() : '—'}</td>
                      <td><Dot status={statusColor(row.paper, NJ_TARGETS.paper.yards)} /> {row.paper ? row.paper.toLocaleString() : '—'}</td>
                      <td className={styles.totalCell}><Dot status={statusColor(row.total, NJ_TOTAL_TARGET)} /> {row.total ? row.total.toLocaleString() : '—'}</td>
                      <td><Dot status={statusColor(wastePct, NJ_TARGETS.wasteTarget, true)} /> {wastePct ? wastePct + '%' : '—'}</td>
                      <td className={styles.netCell}>{netYds > 0 ? netYds.toLocaleString() : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {wasteTrend.filter(Boolean).length >= 2 && (
            <div className={styles.trendRow}>
              <span className={styles.trendLabel}>Waste % trend</span>
              <Sparkline values={wasteTrend} target={8} />
              <span className={styles.trendNote}>{wasteTrend[wasteTrend.length-1]}% this week vs {wasteTrend[0]}% 4 weeks ago</span>
            </div>
          )}
        </div>
      )}

      {/* MTD SUMMARY */}
      {mtdData.length > 0 && (
        <div className={styles.historySection}>
          <div className={styles.historySectionTitle}>Month-to-Date Summary — {mtdWeeksWithData} week{mtdWeeksWithData !== 1 ? 's' : ''} in</div>
          <div className={styles.mtdGrid}>
            {/* NJ MTD */}
            <div className={styles.mtdCard}>
              <div className={styles.mtdCardTitle}><span className={styles.facilityBadge}>NJ</span> Passaic MTD</div>
              <table className={styles.mtdTable}>
                <thead>
                  <tr><th></th><th>Actual</th><th>Target</th><th>+/−</th></tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Fabric', actual: mtdNJ.fabric, target: mtdNJTarget.fabric },
                    { label: 'Grass', actual: mtdNJ.grass, target: mtdNJTarget.grass },
                    { label: 'Paper', actual: mtdNJ.paper, target: mtdNJTarget.paper },
                    { label: 'Total Yds', actual: mtdNJ.total, target: mtdNJTarget.total, bold: true },
                    { label: 'Net Yds', actual: mtdNJNet, target: null },
                    { label: 'Waste', actual: mtdNJ.waste, target: null, suffix: mtdNJWastePct ? ` (${mtdNJWastePct}%)` : '' },
                    { label: 'SCH Produced', actual: mtdNJ.schProduced, target: null },
                    { label: 'SCH Invoiced', actual: mtdNJ.schInvoiced, target: null },
                  ].map(row => {
                    const diff = row.target ? row.actual - row.target : null
                    const status = row.target ? statusColor(row.actual, row.target) : 'gray'
                    return (
                      <tr key={row.label} className={row.bold ? styles.mtdBoldRow : ''}>
                        <td className={styles.mtdLabel}>{row.label}</td>
                        <td className={styles.mtdActual}>
                          <Dot status={status} />
                          {row.actual ? row.actual.toLocaleString() : '—'}{row.suffix || ''}
                        </td>
                        <td className={styles.mtdTarget}>{row.target ? row.target.toLocaleString() : '—'}</td>
                        <td className={diff !== null ? (diff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>
                          {diff !== null ? (diff >= 0 ? '+' : '') + diff.toLocaleString() : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* BNY MTD */}
            <div className={styles.mtdCard}>
              <div className={styles.mtdCardTitle}><span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span> Brooklyn MTD</div>
              <table className={styles.mtdTable}>
                <thead>
                  <tr><th></th><th>Actual</th><th>Target</th><th>+/−</th></tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Replen', actual: mtdBNY.replen, target: mtdBNYTarget.replen },
                    { label: 'MTO', actual: mtdBNY.mto, target: mtdBNYTarget.mto },
                    { label: 'HOS', actual: mtdBNY.hos, target: mtdBNYTarget.hos },
                    { label: 'Memo', actual: mtdBNY.memo, target: mtdBNYTarget.memo },
                    { label: 'Contract', actual: mtdBNY.contract, target: mtdBNYTarget.contract },
                    { label: 'Total Yds', actual: mtdBNY.total, target: mtdBNYTarget.total, bold: true },
                  ].map(row => {
                    const diff = row.target ? row.actual - row.target : null
                    const status = row.target ? statusColor(row.actual, row.target) : 'gray'
                    return (
                      <tr key={row.label} className={row.bold ? styles.mtdBoldRow : ''}>
                        <td className={styles.mtdLabel}>{row.label}</td>
                        <td className={styles.mtdActual}><Dot status={status} />{row.actual ? row.actual.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.target ? row.target.toLocaleString() : '—'}</td>
                        <td className={diff !== null ? (diff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>
                          {diff !== null ? (diff >= 0 ? '+' : '') + diff.toLocaleString() : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MODE */}
      {mode === 'edit' && (
        <div className={styles.editGrid}>
          <div className={styles.editSection}>
            <div className={styles.editSectionHeader}><span className={styles.facilityBadge}>NJ</span><h3>Passaic — Screen Print</h3></div>
            <div className={styles.editSubHeader}>Yards produced by category</div>
            <div className={styles.editRow}>
              {['fabric','grass','paper'].map(cat => (
                <div key={cat} className={styles.editCatBlock}>
                  <div className={styles.editCatLabel}>{cat.charAt(0).toUpperCase()+cat.slice(1)} <span className={styles.editCatTarget}>(tgt: {NJ_TARGETS[cat].yards.toLocaleString()})</span></div>
                  <NumberInput label="Yards" value={njData[cat].yards} onChange={v => updateNJ(`${cat}.yards`, v)} />
                  <NumberInput label="Color yds" value={njData[cat].colorYards} onChange={v => updateNJ(`${cat}.colorYards`, v)} />
                  <NumberInput label="Waste yds" value={njData[cat].waste} onChange={v => updateNJ(`${cat}.waste`, v)} />
                  <NumberInput label="Net yds" value={n(njData[cat].yards) - n(njData[cat].waste) || ''} readOnly />
                  <NumberInput label="Post-prod waste" value={njData[cat].postWaste} onChange={v => updateNJ(`${cat}.postWaste`, v)} />
                </div>
              ))}
            </div>
            <div className={styles.editSubHeader}>Schumacher vs 3rd Party</div>
            <div className={styles.editThreeCol}>
              {[['Written','Written'],['Produced','Produced'],['Invoiced','Invoiced']].map(([label,key]) => (
                <div key={key}>
                  <NumberInput label={`SCH ${label}`} value={njData[`sch${key}`]} onChange={v => updateNJ(`sch${key}`, v)} />
                  <NumberInput label={`3P ${label}`} value={njData[`tp${key}`]} onChange={v => updateNJ(`tp${key}`, v)} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <label className="label">Commentary</label>
              <textarea value={njData.commentary} onChange={e => updateNJ('commentary', e.target.value)} placeholder="Fabric waiting on approvals, Grass working on Feather Bloom…" rows={3} style={{ marginTop: 6 }} />
            </div>
          </div>

          <div className={styles.editSection}>
            <div className={styles.editSectionHeader}><span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span><h3>Brooklyn — Digital</h3></div>
            <div className={styles.editSubHeader}>Capacity by category</div>
            <div className={styles.editFiveCol}>
              {['replen','mto','hos','memo','contract'].map(cat => (
                <NumberInput key={cat} label={`${cat.toUpperCase()} (tgt:${BNY_TARGETS[cat].toLocaleString()})`} value={bnyData[cat]} onChange={v => updateBNY(cat, v)} />
              ))}
            </div>
            <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Schumacher vs 3rd Party</div>
            <div className={styles.editThreeCol}>
              {[['Written','Written'],['Produced','Produced'],['Invoiced','Invoiced']].map(([label,key]) => (
                <div key={key}>
                  <NumberInput label={`SCH ${label}`} value={bnyData[`sch${key}`]} onChange={v => updateBNY(`sch${key}`, v)} />
                  <NumberInput label={`3P ${label}`} value={bnyData[`tp${key}`]} onChange={v => updateBNY(`tp${key}`, v)} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <label className="label">Commentary</label>
              <textarea value={bnyData.commentary} onChange={e => updateBNY('commentary', e.target.value)} placeholder="Replen running ahead, MTO on track…" rows={3} style={{ marginTop: 6 }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
