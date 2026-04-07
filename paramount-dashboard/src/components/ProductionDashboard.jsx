import React, { useState, useEffect } from 'react'
import { format, subWeeks, startOfWeek } from 'date-fns'
import { supabase } from '../supabase'
import { getFiscalLabel, getFiscalInfo } from '../fiscalCalendar'
import CommentButton from './CommentButton'
import styles from './ProductionDashboard.module.css'

const NJ_TARGETS = {
  fabric: { yards: 810,  colorYards: 4522,  invoiceYds: 772,  invoiceRev: 14112.75 },
  grass:  { yards: 3615, colorYards: 7570,  invoiceYds: 3538, invoiceRev: 36646 },
  paper:  { yards: 4185, colorYards: 13405, invoiceYds: 3516, invoiceRev: 26330.25 },
  wasteTarget: 10,
  weeklyInvoiceYds: 7826,
  weeklyRevenue: 128951.25,
}
const NJ_TOTAL_TARGET = NJ_TARGETS.fabric.yards + NJ_TARGETS.grass.yards + NJ_TARGETS.paper.yards

const BNY_TARGETS = {
  replen: 7886, mto: 1280, hos: 1532, memo: 211, contract: 1091, total: 12000,
  incomeReplen: 90675.83, incomeMto: 14398.5, incomeHos: 10727.25, incomeMemo: 4010.5, incomeContract: 13087.5,
  totalIncomeInvoiced: 132899.58,
}

// Weekly revenue and yard targets
const WEEKLY_TARGETS = {
  schRevenue: 106645,
  schYards: 5886,
  tpRevenue: 31277,
  tpYards: 2564,
  totalYards: 8610,
  totalColorYards: 25497,
}

// BNY Machine definitions
const BNY_MACHINES_3600 = [
  { id: 'glow', name: 'Glow', target: 3600 },
  { id: 'sasha', name: 'Sasha', target: 3600 },
  { id: 'trish', name: 'Trish', target: 3600 },
]
// 570 machines at BNY Brooklyn location
const BNY_MACHINES_570_BNY = [
  { id: 'bianca', name: 'Bianca', target: 500 },
  { id: 'lash', name: 'LASH', target: 500 },
  { id: 'chyna', name: 'Chyna', target: 500 },
  { id: 'rhonda', name: 'Rhonda', target: 500 },
]
// 570 machines at Passaic NJ location
const BNY_MACHINES_570_NJ = [
  { id: 'dakota_ka', name: 'Dakota Ka', target: 500 },
  { id: 'dementia', name: 'Dementia', target: 500 },
  { id: 'ember', name: 'EMBER', target: 500 },
  { id: 'ivy_nile', name: 'Ivy Nile', target: 500 },
  { id: 'jacy_jayne', name: 'Jacy Jayne', target: 500 },
  { id: 'ruby', name: 'Ruby', target: 500 },
  { id: 'valhalla', name: 'Valhalla', target: 500 },
  { id: 'xia', name: 'XIA', target: 500 },
  { id: 'apollo', name: 'Apollo', target: 500 },
  { id: 'nemesis', name: 'Nemesis', target: 500 },
  { id: 'poseidon', name: 'Poseidon', target: 500 },
  { id: 'zoey', name: 'Zoey', target: 500 },
]
const BNY_MACHINES_570 = [...BNY_MACHINES_570_BNY, ...BNY_MACHINES_570_NJ]
const ALL_BNY_MACHINES = [...BNY_MACHINES_3600, ...BNY_MACHINES_570]
const BNY_3600_TARGET = BNY_MACHINES_3600.reduce((s, m) => s + m.target, 0) // 10,800
const BNY_570_BNY_TARGET = BNY_MACHINES_570_BNY.reduce((s, m) => s + m.target, 0) // 2,000
const BNY_570_NJ_TARGET = BNY_MACHINES_570_NJ.reduce((s, m) => s + m.target, 0) // 6,000
const BNY_570_TARGET = BNY_MACHINES_570.reduce((s, m) => s + m.target, 0) // 8,000

function emptyMachines() {
  return Object.fromEntries(ALL_BNY_MACHINES.map(m => [m.id, '']))
}

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
  return { replen: '', mto: '', hos: '', memo: '', contract: '', schWritten: '', schProduced: '', schInvoiced: '', tpWritten: '', tpProduced: '', tpInvoiced: '', commentary: '', machines: emptyMachines(), procurement: '' }
}

const PROCUREMENT_WEEKLY_TARGET = 12500 // $12,500/week
function getProcurementMonthlyTarget(weeksInMonth) {
  return weeksInMonth === 5 ? 62500 : 50000
}

function fmtDollar(v) { return (v !== '' && v !== null && v !== undefined) ? '$' + Number(v).toLocaleString() : '—' }
function n(v) { return parseFloat(v) || 0 }
function fmt(v) { return (v !== '' && v !== null && v !== undefined) ? Number(v).toLocaleString() : '—' }
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
        const pctOfTarget = d.target ? Math.round((n(d.value) / n(d.target)) * 100) : null
        const tooltipText = d.value !== '' && d.value !== null
          ? `${d.label}: ${Number(d.value).toLocaleString()} yds${d.target ? ` · Target: ${Number(d.target).toLocaleString()} · ${pctOfTarget}% of target` : ''}`
          : `${d.label}: No data`
        return (
          <div key={i} className={`${styles.barGroup} ${styles.barGroupHoverable}`} title={tooltipText}>
            <div className={styles.barLabel}>{d.label}</div>
            <div className={styles.barTrack}>
              <div className={styles.barTarget} style={{ width: tgtPct + '%' }} />
              <div className={`${styles.barFill} ${styles['barFill_' + status]}`} style={{ width: valPct + '%' }} />
              <div className={styles.barTooltip}>
                <div className={styles.barTooltipLabel}>{d.label}</div>
                <div className={styles.barTooltipRow}>
                  <span>Actual</span>
                  <strong>{d.value !== '' && d.value !== null ? Number(d.value).toLocaleString() + ' yds' : '—'}</strong>
                </div>
                {d.target && <>
                  <div className={styles.barTooltipRow}>
                    <span>Target</span>
                    <strong>{Number(d.target).toLocaleString()} yds</strong>
                  </div>
                  <div className={styles.barTooltipRow}>
                    <span>vs Target</span>
                    <strong className={pctOfTarget >= 90 ? styles.tooltipGreen : pctOfTarget >= 70 ? styles.tooltipAmber : styles.tooltipRed}>
                      {pctOfTarget !== null ? pctOfTarget + '%' : '—'}
                    </strong>
                  </div>
                </>}
              </div>
            </div>
            <div className={styles.barValue}>{(d.value !== '' && d.value !== null && d.value !== undefined) ? Number(d.value).toLocaleString() : '—'}</div>
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

function MachineGroup({ title, machines, machineData, groupTarget }) {
  const [expanded, setExpanded] = useState(false)
  const total = machines.reduce((s, m) => s + n(machineData?.[m.id]), 0)
  const status = statusColor(total, groupTarget)
  const pctVal = pct(total, groupTarget)
  return (
    <div className={styles.machineGroup}>
      <div className={styles.machineGroupHeader} onClick={() => setExpanded(e => !e)}>
        <div className={styles.machineGroupLeft}>
          <Dot status={status} />
          <span className={styles.machineGroupTitle}>{title}</span>
          <span className={styles.machineGroupTotal}>{total ? total.toLocaleString() : '—'} yds</span>
          {pctVal !== null && <span className={`${styles.machineGroupPct} ${styles['machineGroupPct_' + status]}`}>{pctVal}%</span>}
        </div>
        <span className={styles.machineGroupToggle}>{expanded ? '▲' : '▼'} {machines.length} machines</span>
      </div>
      {expanded && (
        <div className={styles.machineList}>
          {machines.map(m => {
            const val = n(machineData?.[m.id])
            const ms = statusColor(val, m.target)
            return (
              <div key={m.id} className={styles.machineRow}>
                <Dot status={ms} />
                <span className={styles.machineName}>{m.name}</span>
                <span className={styles.machineYards}>{val ? val.toLocaleString() : '—'}</span>
                <span className={styles.machineTarget}>/ {m.target.toLocaleString()}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
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

export default function ProductionDashboard({ weekStart, dbReady, sendVersion, readOnly = false, currentUser, onCommentPosted }) {
  const [njData, setNjData] = useState(emptyNJ())
  const [bnyData, setBnyData] = useState(emptyBNY())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mode, setMode] = useState('view')
  const [history, setHistory] = useState([]) // last 5 weeks of data
  const isCurrentWeek = weekKey(weekStart) === weekKey(getWeekStart())
  const isPast = weekStart < getWeekStart()

  const [mtdData, setMtdData] = useState([])
  const [ytdData, setYtdData] = useState([])

  useEffect(() => { loadData(); loadHistory() }, [weekStart])

  async function loadData() {
    const { data } = await supabase.from('production').select('*').eq('week_start', weekKey(weekStart)).single()
    if (data) { setNjData(data.nj_data || emptyNJ()); setBnyData(data.bny_data || emptyBNY()) }
    else { setNjData(emptyNJ()); setBnyData(emptyBNY()) }
  }

  async function loadHistory() {
    const { FISCAL_CALENDAR } = await import('../fiscalCalendar')
    const currentKey = weekKey(weekStart)
    const currentInfo = FISCAL_CALENDAR[currentKey]

    // Rolling table — current month only (per Estephanie)
    let monthWeeksForRolling = []
    if (currentInfo) {
      monthWeeksForRolling = Object.entries(FISCAL_CALENDAR)
        .filter(([k, v]) => v.month === currentInfo.month && v.quarter === currentInfo.quarter && k <= currentKey)
        .map(([k]) => k)
        .sort()
    } else {
      monthWeeksForRolling = Array.from({ length: 5 }, (_, i) => weekKey(subWeeks(weekStart, 4 - i)))
    }
    const { data } = await supabase.from('production').select('*').in('week_start', monthWeeksForRolling).order('week_start', { ascending: true })
    setHistory(data || [])

    // MTD and YTD
    if (currentInfo) {
      const monthWeeks = Object.entries(FISCAL_CALENDAR)
        .filter(([k, v]) => v.month === currentInfo.month && v.quarter === currentInfo.quarter && k <= currentKey)
        .map(([k]) => k)
        .sort()
      const { data: mtd } = await supabase.from('production').select('*').in('week_start', monthWeeks).order('week_start', { ascending: true })
      setMtdData(mtd || [])

      const ytdWeeks = Object.entries(FISCAL_CALENDAR)
        .filter(([k]) => k <= currentKey)
        .map(([k]) => k)
        .sort()
      const { data: ytd } = await supabase.from('production').select('*').in('week_start', ytdWeeks).order('week_start', { ascending: true })
      setYtdData(ytd || [])
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

  const njTotalInvYds = ['fabric','grass','paper'].reduce((s,k) => s + n(njData[k]?.invoiceYds), 0)
  const njTotalInvRev  = ['fabric','grass','paper'].reduce((s,k) => s + n(njData[k]?.invoiceRev), 0)
  const njInvYdsTgt    = NJ_TARGETS.fabric.invoiceYds + NJ_TARGETS.grass.invoiceYds + NJ_TARGETS.paper.invoiceYds
  const njInvRevTgt    = NJ_TARGETS.fabric.invoiceRev + NJ_TARGETS.grass.invoiceRev + NJ_TARGETS.paper.invoiceRev

  const bnyTotalInvYds = ['invYdsReplen','invYdsMto','invYdsHos','invYdsMemo','invYdsContract'].reduce((s,k) => s + n(bnyData[k]), 0)
  const bnyTotalInvRev = ['incomeReplen','incomeMto','incomeHos','incomeMemo','incomeContract'].reduce((s,k) => s + n(bnyData[k]), 0)
  const bnyInvYdsTgt   = BNY_TARGETS.replen + BNY_TARGETS.mto + BNY_TARGETS.hos + BNY_TARGETS.memo + BNY_TARGETS.contract
  const bnyInvRevTgt   = BNY_TARGETS.totalIncomeInvoiced

  const njMiscFees  = n(njData.miscFees)
  const bnyMiscFees = n(bnyData.miscFees)

  // MTD misc fees
  const mtdNJMiscFees  = mtdData.reduce((s,h) => s + n(h.nj_data?.miscFees), 0)
  const mtdBNYMiscFees = mtdData.reduce((s,h) => s + n(h.bny_data?.miscFees), 0)

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

  // MTD computations — only count weeks that have actual production data entered
  const mtdWeeksWithData = mtdData.filter(h =>
    ['fabric','grass','paper'].some(k => n(h.nj_data?.[k]?.yards) > 0)
  ).length
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
  // Fiscal info — declared here so it's available for MTD target calculations below
  const fiscalInfo = getFiscalInfo(weekStart)
  const weeksInMonth = fiscalInfo?.weeksInMonth || 4
  const procurementMonthlyTarget = getProcurementMonthlyTarget(weeksInMonth)

  // Accumulating targets = fiscal weeks elapsed × weekly target (uses calendar position, not data count)
  const mtdFiscalWeeks = fiscalInfo?.weekInMonth || mtdWeeksWithData
  const mtdNJTarget = { fabric: NJ_TARGETS.fabric.yards * mtdFiscalWeeks, grass: NJ_TARGETS.grass.yards * mtdFiscalWeeks, paper: NJ_TARGETS.paper.yards * mtdFiscalWeeks, total: NJ_TOTAL_TARGET * mtdFiscalWeeks }
  const mtdBNYTarget = { total: BNY_TARGETS.total * mtdFiscalWeeks, replen: BNY_TARGETS.replen * mtdFiscalWeeks, mto: BNY_TARGETS.mto * mtdFiscalWeeks, hos: BNY_TARGETS.hos * mtdFiscalWeeks, memo: BNY_TARGETS.memo * mtdFiscalWeeks, contract: BNY_TARGETS.contract * mtdFiscalWeeks }
  const mtdNJNet = mtdNJ.total - mtdNJ.waste
  const mtdNJWastePct = mtdNJ.total > 0 ? ((mtdNJ.waste / mtdNJ.total) * 100).toFixed(1) : null

  // MTD Revenue
  const mtdNJSchInvoiced = mtdData.reduce((s,h) => s + n(h.nj_data?.schInvoiced), 0)
  const mtdNJTpInvoiced = mtdData.reduce((s,h) => s + n(h.nj_data?.tpInvoiced), 0)
  const mtdBNYSchInvoiced = mtdData.reduce((s,h) => s + n(h.bny_data?.schInvoiced), 0)
  const mtdBNYTpInvoiced = mtdData.reduce((s,h) => s + n(h.bny_data?.tpInvoiced), 0)
  const mtdNJSchRevTarget = WEEKLY_TARGETS.schRevenue * mtdFiscalWeeks
  const mtdNJTpRevTarget = WEEKLY_TARGETS.tpRevenue * mtdFiscalWeeks
  const mtdBNYSchRevTarget = WEEKLY_TARGETS.schRevenue * mtdFiscalWeeks
  const mtdBNYTpRevTarget = WEEKLY_TARGETS.tpRevenue * mtdFiscalWeeks

  // MTD — new invoiced yds by category (NJ)
  const mtdNJInvoiceYds = {
    fabric: mtdData.reduce((s,h) => s + n(h.nj_data?.fabric?.invoiceYds), 0),
    grass:  mtdData.reduce((s,h) => s + n(h.nj_data?.grass?.invoiceYds), 0),
    paper:  mtdData.reduce((s,h) => s + n(h.nj_data?.paper?.invoiceYds), 0),
  }
  const mtdNJInvoiceRev = {
    fabric: mtdData.reduce((s,h) => s + n(h.nj_data?.fabric?.invoiceRev), 0),
    grass:  mtdData.reduce((s,h) => s + n(h.nj_data?.grass?.invoiceRev), 0),
    paper:  mtdData.reduce((s,h) => s + n(h.nj_data?.paper?.invoiceRev), 0),
  }
  const mtdNJInvYdsTarget = {
    fabric: NJ_TARGETS.fabric.invoiceYds * mtdFiscalWeeks,
    grass:  NJ_TARGETS.grass.invoiceYds  * mtdFiscalWeeks,
    paper:  NJ_TARGETS.paper.invoiceYds  * mtdFiscalWeeks,
    total:  NJ_TARGETS.weeklyInvoiceYds  * mtdFiscalWeeks,
  }
  const mtdNJRevTarget = {
    fabric: NJ_TARGETS.fabric.invoiceRev * mtdFiscalWeeks,
    grass:  NJ_TARGETS.grass.invoiceRev  * mtdFiscalWeeks,
    paper:  NJ_TARGETS.paper.invoiceRev  * mtdFiscalWeeks,
    total:  NJ_TARGETS.weeklyRevenue     * mtdFiscalWeeks,
  }

  // MTD — invoiced yards by category (BNY)
  const mtdBNYInvYds = {
    replen:   mtdData.reduce((s,h) => s + n(h.bny_data?.invYdsReplen), 0),
    mto:      mtdData.reduce((s,h) => s + n(h.bny_data?.invYdsMto), 0),
    hos:      mtdData.reduce((s,h) => s + n(h.bny_data?.invYdsHos), 0),
    memo:     mtdData.reduce((s,h) => s + n(h.bny_data?.invYdsMemo), 0),
    contract: mtdData.reduce((s,h) => s + n(h.bny_data?.invYdsContract), 0),
  }
  // MTD — new income invoiced by category (BNY)
  const mtdBNYIncomeInvoiced = {
    replen:   mtdData.reduce((s,h) => s + n(h.bny_data?.incomeReplen), 0),
    mto:      mtdData.reduce((s,h) => s + n(h.bny_data?.incomeMto), 0),
    hos:      mtdData.reduce((s,h) => s + n(h.bny_data?.incomeHos), 0),
    memo:     mtdData.reduce((s,h) => s + n(h.bny_data?.incomeMemo), 0),
    contract: mtdData.reduce((s,h) => s + n(h.bny_data?.incomeContract), 0),
  }
  const mtdBNYIncomeTarget = {
    replen:   BNY_TARGETS.incomeReplen   * mtdFiscalWeeks,
    mto:      BNY_TARGETS.incomeMto      * mtdFiscalWeeks,
    hos:      BNY_TARGETS.incomeHos      * mtdFiscalWeeks,
    memo:     BNY_TARGETS.incomeMemo     * mtdFiscalWeeks,
    contract: BNY_TARGETS.incomeContract * mtdFiscalWeeks,
    total:    BNY_TARGETS.totalIncomeInvoiced * mtdFiscalWeeks,
  }

  // Procurement MTD
  const mtdProcurement = mtdData.reduce((s, h) => s + n(h.bny_data?.procurement), 0)
  const procurementMTDTarget = PROCUREMENT_WEEKLY_TARGET * mtdWeeksWithData

  // YTD computations
  const ytdWeeksWithData = ytdData.filter(h =>
    ['fabric','grass','paper'].some(k => n(h.nj_data?.[k]?.yards) > 0)
  ).length
  const ytdNJ = {
    fabric: ytdData.reduce((s,h) => s + n(h.nj_data?.fabric?.yards), 0),
    grass: ytdData.reduce((s,h) => s + n(h.nj_data?.grass?.yards), 0),
    paper: ytdData.reduce((s,h) => s + n(h.nj_data?.paper?.yards), 0),
    waste: ytdData.reduce((s,h) => s + ['fabric','grass','paper'].reduce((ss,k) => ss + n(h.nj_data?.[k]?.waste), 0), 0),
    total: ytdData.reduce((s,h) => s + ['fabric','grass','paper'].reduce((ss,k) => ss + n(h.nj_data?.[k]?.yards), 0), 0),
    schProduced: ytdData.reduce((s,h) => s + n(h.nj_data?.schProduced), 0),
    schInvoiced: ytdData.reduce((s,h) => s + n(h.nj_data?.schInvoiced), 0),
  }
  const ytdBNY = {
    total: ytdData.reduce((s,h) => s + ['replen','mto','hos','memo','contract'].reduce((ss,k) => ss + n(h.bny_data?.[k]), 0), 0),
    replen: ytdData.reduce((s,h) => s + n(h.bny_data?.replen), 0),
    mto: ytdData.reduce((s,h) => s + n(h.bny_data?.mto), 0),
    hos: ytdData.reduce((s,h) => s + n(h.bny_data?.hos), 0),
    memo: ytdData.reduce((s,h) => s + n(h.bny_data?.memo), 0),
    contract: ytdData.reduce((s,h) => s + n(h.bny_data?.contract), 0),
    schProduced: ytdData.reduce((s,h) => s + n(h.bny_data?.schProduced), 0),
    schInvoiced: ytdData.reduce((s,h) => s + n(h.bny_data?.schInvoiced), 0),
  }
  const ytdNJTarget = { fabric: NJ_TARGETS.fabric.yards * ytdWeeksWithData, grass: NJ_TARGETS.grass.yards * ytdWeeksWithData, paper: NJ_TARGETS.paper.yards * ytdWeeksWithData, total: NJ_TOTAL_TARGET * ytdWeeksWithData }
  const ytdBNYTarget = { total: BNY_TARGETS.total * ytdWeeksWithData, replen: BNY_TARGETS.replen * ytdWeeksWithData, mto: BNY_TARGETS.mto * ytdWeeksWithData, hos: BNY_TARGETS.hos * ytdWeeksWithData, memo: BNY_TARGETS.memo * ytdWeeksWithData, contract: BNY_TARGETS.contract * ytdWeeksWithData }
  const ytdNJNet = ytdNJ.total - ytdNJ.waste
  const ytdNJWastePct = ytdNJ.total > 0 ? ((ytdNJ.waste / ytdNJ.total) * 100).toFixed(1) : null
  const ytdProcurement = ytdData.reduce((s,h) => s + n(h.bny_data?.procurement), 0)

  // YTD Revenue
  const ytdNJSchInvoiced = ytdData.reduce((s,h) => s + n(h.nj_data?.schInvoiced), 0)
  const ytdNJTpInvoiced = ytdData.reduce((s,h) => s + n(h.nj_data?.tpInvoiced), 0)
  const ytdBNYSchInvoiced = ytdData.reduce((s,h) => s + n(h.bny_data?.schInvoiced), 0)
  const ytdBNYTpInvoiced = ytdData.reduce((s,h) => s + n(h.bny_data?.tpInvoiced), 0)
  const ytdNJSchRevTarget = WEEKLY_TARGETS.schRevenue * ytdWeeksWithData
  const ytdNJTpRevTarget = WEEKLY_TARGETS.tpRevenue * ytdWeeksWithData
  const ytdBNYSchRevTarget = WEEKLY_TARGETS.schRevenue * ytdWeeksWithData
  const ytdBNYTpRevTarget = WEEKLY_TARGETS.tpRevenue * ytdWeeksWithData
  const ytdProcurementTarget = PROCUREMENT_WEEKLY_TARGET * ytdWeeksWithData

  // YTD — invoiced yds and revenue by category (NJ)
  const ytdNJInvoiceYds = {
    fabric: ytdData.reduce((s,h) => s + n(h.nj_data?.fabric?.invoiceYds), 0),
    grass:  ytdData.reduce((s,h) => s + n(h.nj_data?.grass?.invoiceYds), 0),
    paper:  ytdData.reduce((s,h) => s + n(h.nj_data?.paper?.invoiceYds), 0),
  }
  const ytdNJInvoiceRev = {
    fabric: ytdData.reduce((s,h) => s + n(h.nj_data?.fabric?.invoiceRev), 0),
    grass:  ytdData.reduce((s,h) => s + n(h.nj_data?.grass?.invoiceRev), 0),
    paper:  ytdData.reduce((s,h) => s + n(h.nj_data?.paper?.invoiceRev), 0),
  }
  const ytdNJInvYdsTarget = {
    fabric: NJ_TARGETS.fabric.invoiceYds * ytdWeeksWithData,
    grass:  NJ_TARGETS.grass.invoiceYds  * ytdWeeksWithData,
    paper:  NJ_TARGETS.paper.invoiceYds  * ytdWeeksWithData,
    total:  NJ_TARGETS.weeklyInvoiceYds  * ytdWeeksWithData,
  }
  const ytdNJRevTarget = {
    fabric: NJ_TARGETS.fabric.invoiceRev * ytdWeeksWithData,
    grass:  NJ_TARGETS.grass.invoiceRev  * ytdWeeksWithData,
    paper:  NJ_TARGETS.paper.invoiceRev  * ytdWeeksWithData,
    total:  NJ_TARGETS.weeklyRevenue     * ytdWeeksWithData,
  }

  // YTD — income invoiced by category (BNY)
  const ytdBNYInvYds = {
    replen:   ytdData.reduce((s,h) => s + n(h.bny_data?.invYdsReplen), 0),
    mto:      ytdData.reduce((s,h) => s + n(h.bny_data?.invYdsMto), 0),
    hos:      ytdData.reduce((s,h) => s + n(h.bny_data?.invYdsHos), 0),
    memo:     ytdData.reduce((s,h) => s + n(h.bny_data?.invYdsMemo), 0),
    contract: ytdData.reduce((s,h) => s + n(h.bny_data?.invYdsContract), 0),
  }
  const ytdBNYIncomeInvoiced = {
    replen:   ytdData.reduce((s,h) => s + n(h.bny_data?.incomeReplen), 0),
    mto:      ytdData.reduce((s,h) => s + n(h.bny_data?.incomeMto), 0),
    hos:      ytdData.reduce((s,h) => s + n(h.bny_data?.incomeHos), 0),
    memo:     ytdData.reduce((s,h) => s + n(h.bny_data?.incomeMemo), 0),
    contract: ytdData.reduce((s,h) => s + n(h.bny_data?.incomeContract), 0),
  }
  const ytdBNYIncomeTarget = {
    replen:   BNY_TARGETS.incomeReplen   * ytdWeeksWithData,
    mto:      BNY_TARGETS.incomeMto      * ytdWeeksWithData,
    hos:      BNY_TARGETS.incomeHos      * ytdWeeksWithData,
    memo:     BNY_TARGETS.incomeMemo     * ytdWeeksWithData,
    contract: BNY_TARGETS.incomeContract * ytdWeeksWithData,
    total:    BNY_TARGETS.totalIncomeInvoiced * ytdWeeksWithData,
  }

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
          {mode === 'view' && !readOnly ? (
            <button onClick={() => setMode('edit')}>{isPast ? 'Edit Historical Data' : 'Enter This Week\'s Data'}</button>
          ) : mode === 'view' && readOnly ? null : (
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

          {/* NJ CARD */}
          <div className={`${styles.facilityCard} ${isPast ? styles.facilityCardHistorical : ''}`}>
            <div className={styles.facilityHeader}>
              <div className={styles.facilityTitle}><span className={styles.facilityBadge}>NJ</span>Passaic · Screen Print</div>
              <div className={styles.headerRight}>
                <Dot status={statusColor(njTotalYards, NJ_TOTAL_TARGET)} />
                <span className={styles.pctLabel}>{pct(njTotalYards, NJ_TOTAL_TARGET)}% of target</span>
                <CommentButton weekStart={weekStart} section="nj-summary" label="NJ Passaic Production" currentUser={currentUser} onCommentPosted={onCommentPosted} />
              </div>
            </div>
            {/* Invoiced KPI strip */}
            {(njTotalInvYds > 0 || njTotalInvRev > 0) && (() => {
              const njSchInv = n(njData.schInvoiced)
              const njTpInv  = n(njData.tpInvoiced)
              const cols = [
                { label:'Produced', val:njTotalYards, tgt:NJ_TOTAL_TARGET, unit:'yds' },
                { label:'Invoiced Yds', val:njTotalInvYds, tgt:njInvYdsTgt, unit:'yds',
                  sub: njSchInv||njTpInv ? `SCH ${njSchInv.toLocaleString()} · 3P ${njTpInv.toLocaleString()}` : null },
                { label:'Invoiced Rev', val:njTotalInvRev + njMiscFees, tgt:njInvRevTgt, unit:'$', isDollar:true,
                  sub2: njMiscFees>0 ? `incl. $${Math.round(njMiscFees).toLocaleString()} misc fees` : null },
              ]
              return (
                <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--border)', background:'var(--cream-dark,#F5F0EA)' }}>
                  {cols.map((k,i,arr) => {
                    const pctVal = k.tgt>0 ? Math.round(k.val/k.tgt*100) : null
                    const color  = pctVal===null?'var(--ink-40)':pctVal>=95?'#15803d':pctVal>=80?'#b45309':'#b91c1c'
                    const valStr = k.isDollar ? '$'+Math.round(k.val).toLocaleString() : k.val.toLocaleString()+' yds'
                    const tgtStr = k.isDollar ? '$'+Math.round(k.tgt).toLocaleString() : k.tgt.toLocaleString()+' yds'
                    return (
                      <div key={k.label} style={{ flex:1, padding:'8px 12px', borderRight:i<arr.length-1?'1px solid var(--border)':'none' }}>
                        <div style={{ fontSize:9, fontWeight:700, letterSpacing:'0.07em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:3 }}>{k.label}</div>
                        <div style={{ fontSize:14, fontWeight:700, color, fontFamily:'Georgia,serif' }}>{valStr}</div>
                        <div style={{ fontSize:10, color:'var(--ink-40)' }}>tgt {tgtStr}{pctVal!==null?' · '+pctVal+'%':''}</div>
                        {k.sub && <div style={{ fontSize:10, color:'var(--ink-40)', marginTop:2 }}>{k.sub}</div>}
                      {k.sub2 && <div style={{ fontSize:10, color:'var(--ink-40)', marginTop:1, fontStyle:'italic' }}>{k.sub2}</div>}
                      </div>
                    )
                  })}
                </div>
              )
            })()}

            {/* Band 1: Capacity headline numbers */}
            <div className={styles.band}>
              <div className={styles.bandTitle}>Capacity</div>
              <div className={styles.statsRow}>
                <div className={`${styles.statBlock} ${styles.statBlockHoverable}`}>
                  <div className={styles.statLabel}>Produced</div>
                  <div className={`${styles.statValue} ${styles['statValue_' + statusColor(njTotalYards, NJ_TOTAL_TARGET)]}`}>{fmt(njTotalYards)}<span className={styles.statUnit}>yds</span></div>
                  <div className={styles.statTarget}>Target: {NJ_TOTAL_TARGET.toLocaleString()}</div>
                  <div className={styles.statTooltip}>
                    {njTotalYards ? `${njTotalYards.toLocaleString()} of ${NJ_TOTAL_TARGET.toLocaleString()} yds · ${Math.round((njTotalYards/NJ_TOTAL_TARGET)*100)}% of target` : 'No data entered'}
                  </div>
                </div>
                <div className={`${styles.statBlock} ${styles.statBlockHoverable}`}>
                  <div className={styles.statLabel}>Net Yards</div>
                  <div className={`${styles.statValue} ${styles['statValue_' + statusColor(njNetYards, NJ_TOTAL_TARGET * 0.92)]}`}>{fmt(njNetYards)}<span className={styles.statUnit}>yds</span></div>
                  <div className={styles.statTarget}>Produced − Waste</div>
                  <div className={styles.statTooltip}>
                    {njTotalYards ? `${njTotalYards.toLocaleString()} produced − ${njTotalWaste.toLocaleString()} waste = ${njNetYards.toLocaleString()} net` : 'No data entered'}
                  </div>
                </div>
                <div className={`${styles.statBlock} ${styles.statBlockHoverable}`}>
                  <div className={styles.statLabel}>Waste</div>
                  <div className={`${styles.statValue} ${styles['statValue_' + statusColor(njWastePct, NJ_TARGETS.wasteTarget, true)]}`}>{njWastePct || '—'}<span className={styles.statUnit}>%</span></div>
                  <div className={styles.statTarget}>{njTotalWaste > 0 ? njTotalWaste.toLocaleString() + ' yds · ' : ''}Target: &lt;10%</div>
                  <div className={styles.statTooltip}>
                    {njTotalWaste > 0 ? `${njTotalWaste.toLocaleString()} waste yds · ${njWastePct}% · Target <10%` : 'No waste recorded'}
                  </div>
                </div>
                <div className={`${styles.statBlock} ${styles.statBlockHoverable}`}>
                  <div className={styles.statLabel}>Color Yds</div>
                  <div className={`${styles.statValue} ${styles['statValue_' + statusColor(njTotalColor, njTotalColorTarget)]}`}>{fmt(njTotalColor)}<span className={styles.statUnit}>yds</span></div>
                  <div className={styles.statTarget}>Target: {njTotalColorTarget.toLocaleString()}</div>
                  <div className={styles.statTooltip}>
                    {njTotalColor ? `${njTotalColor.toLocaleString()} of ${njTotalColorTarget.toLocaleString()} color yds · ${Math.round((njTotalColor/njTotalColorTarget)*100)}% of target` : 'No data entered'}
                  </div>
                </div>
              </div>
              <BarChart data={[
                { label: 'Fabric', value: njData.fabric.yards, target: NJ_TARGETS.fabric.yards },
                { label: 'Grass', value: njData.grass.yards, target: NJ_TARGETS.grass.yards },
                { label: 'Paper', value: njData.paper.yards, target: NJ_TARGETS.paper.yards },
              ]} />
            </div>

            {/* Band 2: Written / Produced / Invoiced - always show */}
            <div className={styles.band}>
              <div className={styles.bandTitle}>Written · Produced · Invoiced</div>
              <table className={styles.wpiTable}>
                <thead>
                  <tr><th></th><th>Written</th><th>Produced</th><th>Invoiced</th><th>Target</th><th>Gap</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={styles.wpiRowLabel}>Schumacher</td>
                    <td>{fmt(njData.schWritten)}</td>
                    <td>{fmt(njData.schProduced)}</td>
                    <td>{fmt(njData.schInvoiced)}</td>
                    <td className={styles.wpiMuted}>{WEEKLY_TARGETS.schYards.toLocaleString()}</td>
                    <td className={invoicedGap >= 0 ? styles.gapPositive : styles.gapNegative}>
                      {(njData.schProduced !== '' || njData.schInvoiced !== '') ? (invoicedGap >= 0 ? '+' : '') + fmt(invoicedGap) : '—'}
                    </td>
                  </tr>
                  <tr>
                    <td className={styles.wpiRowLabel}>3rd Party</td>
                    <td>{fmt(njData.tpWritten)}</td>
                    <td>{fmt(njData.tpProduced)}</td>
                    <td>{fmt(njData.tpInvoiced)}</td>
                    <td className={styles.wpiMuted}>{WEEKLY_TARGETS.tpYards.toLocaleString()}</td>
                    <td className={styles.wpiMuted}>—</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Band 3: Commentary */}
            {njData.commentary && (
              <div className={styles.band}>
                <div className={styles.commentary}>{njData.commentary}</div>
              </div>
            )}
          </div>

          {/* BNY CARD */}
          <div className={`${styles.facilityCard} ${isPast ? styles.facilityCardHistorical : ''}`}>
            <div className={styles.facilityHeader}>
              <div className={styles.facilityTitle}><span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span>Brooklyn · Digital</div>
              <div className={styles.headerRight}>
                <Dot status={statusColor(bnyTotal, BNY_TARGETS.total)} />
                <span className={styles.pctLabel}>{pct(bnyTotal, BNY_TARGETS.total)}% of target</span>
                <CommentButton weekStart={weekStart} section="bny-summary" label="BNY Brooklyn Production" currentUser={currentUser} onCommentPosted={onCommentPosted} />
              </div>
            </div>
            {/* Invoiced KPI strip */}
            {(bnyTotalInvYds > 0 || bnyTotalInvRev > 0) && (() => {
              const bnySchInv = n(bnyData.schInvoiced)
              const bnyTpInv  = n(bnyData.tpInvoiced)
              const cols = [
                { label:'Produced', val:bnyTotal, tgt:BNY_TARGETS.total, unit:'yds' },
                { label:'Invoiced Yds', val:bnyTotalInvYds, tgt:bnyInvYdsTgt, unit:'yds',
                  sub: bnySchInv||bnyTpInv ? `SCH ${bnySchInv.toLocaleString()} · 3P ${bnyTpInv.toLocaleString()}` : null },
                { label:'Invoiced Rev', val:bnyTotalInvRev + bnyMiscFees, tgt:bnyInvRevTgt, unit:'$', isDollar:true,
                  sub2: bnyMiscFees>0 ? `incl. $${Math.round(bnyMiscFees).toLocaleString()} misc fees` : null },
              ]
              return (
                <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--border)', background:'var(--cream-dark,#F5F0EA)' }}>
                  {cols.map((k,i,arr) => {
                    const pctVal = k.tgt>0 ? Math.round(k.val/k.tgt*100) : null
                    const color  = pctVal===null?'var(--ink-40)':pctVal>=95?'#15803d':pctVal>=80?'#b45309':'#b91c1c'
                    const valStr = k.isDollar ? '$'+Math.round(k.val).toLocaleString() : k.val.toLocaleString()+' yds'
                    const tgtStr = k.isDollar ? '$'+Math.round(k.tgt).toLocaleString() : k.tgt.toLocaleString()+' yds'
                    return (
                      <div key={k.label} style={{ flex:1, padding:'8px 12px', borderRight:i<arr.length-1?'1px solid var(--border)':'none' }}>
                        <div style={{ fontSize:9, fontWeight:700, letterSpacing:'0.07em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:3 }}>{k.label}</div>
                        <div style={{ fontSize:14, fontWeight:700, color, fontFamily:'Georgia,serif' }}>{valStr}</div>
                        <div style={{ fontSize:10, color:'var(--ink-40)' }}>tgt {tgtStr}{pctVal!==null?' · '+pctVal+'%':''}</div>
                        {k.sub && <div style={{ fontSize:10, color:'var(--ink-40)', marginTop:2 }}>{k.sub}</div>}
                      {k.sub2 && <div style={{ fontSize:10, color:'var(--ink-40)', marginTop:1, fontStyle:'italic' }}>{k.sub2}</div>}
                      </div>
                    )
                  })}
                </div>
              )
            })()}

            {/* Band 1: Capacity */}
            <div className={styles.band}>
              <div className={styles.bandTitle}>Capacity</div>
              <div className={styles.statsRow}>
                <div className={`${styles.statBlock} ${styles.statBlockHoverable}`}>
                  <div className={styles.statLabel}>Total yards</div>
                  <div className={`${styles.statValue} ${styles['statValue_' + statusColor(bnyTotal, BNY_TARGETS.total)]}`}>{fmt(bnyTotal)}<span className={styles.statUnit}>yds</span></div>
                  <div className={styles.statTarget}>Target: {BNY_TARGETS.total.toLocaleString()}</div>
                  <div className={styles.statTooltip}>
                    {bnyTotal ? `${bnyTotal.toLocaleString()} of ${BNY_TARGETS.total.toLocaleString()} yds · ${Math.round((bnyTotal/BNY_TARGETS.total)*100)}% of target` : 'No data entered'}
                  </div>
                </div>

              </div>
              <BarChart data={[
                { label: 'Replen', value: bnyData.replen, target: BNY_TARGETS.replen },
                { label: 'MTO', value: bnyData.mto, target: BNY_TARGETS.mto },
                { label: 'HOS', value: bnyData.hos, target: BNY_TARGETS.hos },
                { label: 'Memo', value: bnyData.memo, target: BNY_TARGETS.memo },
                { label: 'Contract', value: bnyData.contract, target: BNY_TARGETS.contract },
              ]} />
            </div>

            {/* Machine drilldown - always show */}
            <div className={styles.band}>
              <div className={styles.bandTitle}>Output by machine</div>
              <MachineGroup title="3600 machines (BNY)" machines={BNY_MACHINES_3600} machineData={bnyData.machines} groupTarget={BNY_3600_TARGET} />
              <MachineGroup title="570 machines — BNY" machines={BNY_MACHINES_570_BNY} machineData={bnyData.machines} groupTarget={BNY_570_BNY_TARGET} />
              <MachineGroup title="570 machines — Passaic" machines={BNY_MACHINES_570_NJ} machineData={bnyData.machines} groupTarget={BNY_570_NJ_TARGET} />
            </div>

            {/* Band 2: Written / Produced / Invoiced - always show */}
            <div className={styles.band}>
              <div className={styles.bandTitle}>Written · Produced · Invoiced</div>
              <table className={styles.wpiTable}>
                <thead>
                  <tr><th></th><th>Written</th><th>Produced</th><th>Invoiced</th><th>Target</th><th>Gap</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={styles.wpiRowLabel}>Schumacher</td>
                    <td>{fmt(bnyData.schWritten)}</td>
                    <td>{fmt(bnyData.schProduced)}</td>
                    <td>{fmt(bnyData.schInvoiced)}</td>
                    <td className={styles.wpiMuted}>{WEEKLY_TARGETS.schYards.toLocaleString()}</td>
                    <td className={n(bnyData.schProduced) - n(bnyData.schInvoiced) >= 0 ? styles.gapPositive : styles.gapNegative}>
                      {(bnyData.schProduced !== '' || bnyData.schInvoiced !== '') ? (n(bnyData.schProduced)-n(bnyData.schInvoiced) >= 0 ? '+' : '') + fmt(n(bnyData.schProduced)-n(bnyData.schInvoiced)) : '—'}
                    </td>
                  </tr>
                  <tr>
                    <td className={styles.wpiRowLabel}>3rd Party</td>
                    <td>{fmt(bnyData.tpWritten)}</td>
                    <td>{fmt(bnyData.tpProduced)}</td>
                    <td>{fmt(bnyData.tpInvoiced)}</td>
                    <td className={styles.wpiMuted}>{WEEKLY_TARGETS.tpYards.toLocaleString()}</td>
                    <td className={styles.wpiMuted}>—</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Band 3: Commentary */}
            {bnyData.commentary && (
              <div className={styles.band}>
                <div className={styles.commentary}>{bnyData.commentary}</div>
              </div>
            )}

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
          <div className={styles.historySectionTitle} style={{display:'flex',alignItems:'center',gap:8}}>
            NJ — Capacity (Current Month)
            <CommentButton weekStart={weekStart} section="dash-rolling-nj" label="NJ Rolling 5-Week" currentUser={currentUser} onCommentPosted={onCommentPosted} />
          </div>
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
                  <td>&lt;10%</td>
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
          <div className={styles.historySectionTitle} style={{display:'flex',alignItems:'center',gap:8}}>
            Month-to-Date Summary — {mtdWeeksWithData} week{mtdWeeksWithData !== 1 ? 's' : ''} in · Produced vs Invoiced vs Target
            <CommentButton weekStart={weekStart} section="dash-mtd" label="Month-to-Date Summary" currentUser={currentUser} onCommentPosted={onCommentPosted} />
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            {/* NJ MTD — expanded with invoiced yds, revenue, and gap columns */}
            <div className={styles.mtdCard}>
              <div className={styles.mtdCardTitle}><span className={styles.facilityBadge}>NJ</span> Passaic MTD</div>
              <div style={{overflowX:"auto"}}><table className={styles.mtdTable} style={{minWidth:680,fontSize:11}}>
                <thead>
                  <tr><th></th><th>Produced</th><th>Inv Yds</th><th>Revenue $</th><th>Prod Tgt</th><th>Inv Tgt</th><th>Rev Tgt</th><th>Prod +/−</th><th>Inv +/−</th><th>$ +/−</th></tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Fabric', produced: mtdNJ.fabric, invYds: mtdNJInvoiceYds.fabric, rev: mtdNJInvoiceRev.fabric, prodTgt: mtdNJTarget.fabric, invTgt: mtdNJInvYdsTarget.fabric, revTgt: mtdNJRevTarget.fabric },
                    { label: 'Grass',  produced: mtdNJ.grass,  invYds: mtdNJInvoiceYds.grass,  rev: mtdNJInvoiceRev.grass,  prodTgt: mtdNJTarget.grass,  invTgt: mtdNJInvYdsTarget.grass,  revTgt: mtdNJRevTarget.grass },
                    { label: 'Paper',  produced: mtdNJ.paper,  invYds: mtdNJInvoiceYds.paper,  rev: mtdNJInvoiceRev.paper,  prodTgt: mtdNJTarget.paper,  invTgt: mtdNJInvYdsTarget.paper,  revTgt: mtdNJRevTarget.paper },
                    { label: 'Total Yds', produced: mtdNJ.total, invYds: Object.values(mtdNJInvoiceYds).reduce((a,b)=>a+b,0), rev: Object.values(mtdNJInvoiceRev).reduce((a,b)=>a+b,0), prodTgt: mtdNJTarget.total, invTgt: mtdNJInvYdsTarget.total, revTgt: mtdNJRevTarget.total, bold: true },
                    { label: 'Net Yds', produced: mtdNJNet, invYds: null, rev: null, prodTgt: null, invTgt: null, revTgt: null },
                    { label: 'Waste', produced: mtdNJ.waste, invYds: null, rev: null, prodTgt: null, invTgt: null, revTgt: null, suffix: mtdNJWastePct ? ` (${mtdNJWastePct}%)` : '' },
                    { label: 'Schumacher', produced: mtdNJ.schProduced, invYds: mtdNJ.schInvoiced, rev: null, prodTgt: WEEKLY_TARGETS.schYards * mtdFiscalWeeks, invTgt: WEEKLY_TARGETS.schYards * mtdFiscalWeeks, revTgt: null, bold: true },
                    ...(mtdNJMiscFees>0 ? [{ label: 'Misc Fees', produced: null, invYds: null, rev: mtdNJMiscFees, prodTgt: null, invTgt: null, revTgt: null, isMisc: true }] : []),
                  ].map(row => {
                    const prodDiff = row.prodTgt ? row.produced - row.prodTgt : null
                    const invDiff  = row.invTgt && row.invYds !== null ? row.invYds - row.invTgt : null
                    const revDiff  = row.revTgt && row.rev !== null ? row.rev - row.revTgt : null
                    const prodSt   = row.prodTgt ? statusColor(row.produced, row.prodTgt) : 'gray'
                    const invSt    = row.invTgt && row.invYds !== null ? statusColor(row.invYds, row.invTgt) : 'gray'
                    return (
                      <tr key={row.label} className={row.bold ? styles.mtdBoldRow : ''}>
                        <td className={styles.mtdLabel}>{row.label}</td>
                        <td className={styles.mtdActual}><Dot status={prodSt} />{row.produced !== null && row.produced !== undefined ? row.produced.toLocaleString() : '—'}{row.suffix||''}</td>
                        <td className={styles.mtdActual}>{row.invYds !== null && row.invYds !== undefined ? <><Dot status={invSt} />{row.invYds.toLocaleString()}</> : <span style={{color:'var(--ink-30)'}}>—</span>}</td>
                        <td className={styles.mtdActual}>{row.rev !== null && row.rev !== undefined && row.rev > 0 ? fmtDollar(Math.round(row.rev)) : <span style={{color:'var(--ink-30)'}}>—</span>}</td>
                        <td className={styles.mtdTarget}>{row.prodTgt ? row.prodTgt.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.invTgt ? row.invTgt.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.revTgt ? fmtDollar(Math.round(row.revTgt)) : '—'}</td>
                        <td className={prodDiff !== null ? (prodDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{prodDiff !== null ? (prodDiff >= 0 ? '+' : '') + prodDiff.toLocaleString() : '—'}</td>
                        <td className={invDiff !== null ? (invDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{invDiff !== null ? (invDiff >= 0 ? '+' : '') + invDiff.toLocaleString() : '—'}</td>
                        <td className={revDiff !== null ? (revDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{revDiff !== null ? (revDiff >= 0 ? '+' : '') + fmtDollar(Math.round(Math.abs(revDiff))) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table></div>
            </div>

            {/* BNY MTD — expanded with income invoiced $ by category */}
            <div className={styles.mtdCard}>
              <div className={styles.mtdCardTitle}><span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span> Brooklyn MTD</div>
              <div style={{overflowX:"auto"}}><table className={styles.mtdTable} style={{minWidth:720,fontSize:11}}>
                <thead>
                  <tr><th></th><th>Produced</th><th>Inv Yds</th><th>Income Inv $</th><th>Prod Tgt</th><th>Inv Yds Tgt</th><th>Inc Inv Tgt</th><th>Prod +/−</th><th>Inv +/−</th><th>$ +/−</th></tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Replen',   produced: mtdBNY.replen,   invYds: mtdBNYInvYds.replen,   income: mtdBNYIncomeInvoiced.replen,   prodTgt: mtdBNYTarget.replen,   incTgt: mtdBNYIncomeTarget.replen },
                    { label: 'MTO',      produced: mtdBNY.mto,      invYds: mtdBNYInvYds.mto,      income: mtdBNYIncomeInvoiced.mto,      prodTgt: mtdBNYTarget.mto,      incTgt: mtdBNYIncomeTarget.mto },
                    { label: 'HOS',      produced: mtdBNY.hos,      invYds: mtdBNYInvYds.hos,      income: mtdBNYIncomeInvoiced.hos,      prodTgt: mtdBNYTarget.hos,      incTgt: mtdBNYIncomeTarget.hos },
                    { label: 'Memo',     produced: mtdBNY.memo,     invYds: mtdBNYInvYds.memo,     income: mtdBNYIncomeInvoiced.memo,     prodTgt: mtdBNYTarget.memo,     incTgt: mtdBNYIncomeTarget.memo },
                    { label: 'Contract', produced: mtdBNY.contract, invYds: mtdBNYInvYds.contract, income: mtdBNYIncomeInvoiced.contract, prodTgt: mtdBNYTarget.contract, incTgt: mtdBNYIncomeTarget.contract },
                    { label: 'Total Yds', produced: mtdBNY.total, invYds: Object.values(mtdBNYInvYds).reduce((a,b)=>a+b,0), income: Object.values(mtdBNYIncomeInvoiced).reduce((a,b)=>a+b,0), prodTgt: mtdBNYTarget.total, incTgt: mtdBNYIncomeTarget.total, bold: true },
                    { label: 'Schumacher', produced: mtdData.reduce((s,h) => s + n(h.bny_data?.schProduced), 0), invYds: mtdData.reduce((s,h) => s + n(h.bny_data?.schInvoiced), 0), income: null, prodTgt: WEEKLY_TARGETS.schYards * mtdFiscalWeeks, incTgt: null, bold: true },
                    ...(mtdBNYMiscFees>0 ? [{ label: 'Misc Fees', produced: null, invYds: null, income: mtdBNYMiscFees, prodTgt: null, incTgt: null, isMisc: true }] : []),
                  ].map(row => {
                    const invYds = row.invYds !== undefined ? row.invYds : null
                    const prodDiff = row.prodTgt ? row.produced - row.prodTgt : null
                    const invDiff  = invYds !== null && row.prodTgt ? invYds - row.prodTgt : null
                    const incDiff  = row.incTgt && row.income !== null && row.income !== undefined ? row.income - row.incTgt : null
                    const prodSt   = row.prodTgt ? statusColor(row.produced, row.prodTgt) : 'gray'
                    return (
                      <tr key={row.label} className={row.bold ? styles.mtdBoldRow : ''}>
                        <td className={styles.mtdLabel}>{row.label}</td>
                        <td className={styles.mtdActual}><Dot status={prodSt} />{row.produced ? row.produced.toLocaleString() : '—'}</td>
                        <td className={styles.mtdActual}>{invYds !== null ? invYds.toLocaleString() : <span style={{color:'var(--ink-30)'}}>—</span>}</td>
                        <td className={styles.mtdActual}>{row.income !== null && row.income !== undefined && row.income > 0 ? fmtDollar(Math.round(row.income)) : <span style={{color:'var(--ink-30)'}}>—</span>}</td>
                        <td className={styles.mtdTarget}>{row.prodTgt ? row.prodTgt.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.incTgt ? row.prodTgt?.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.incTgt ? fmtDollar(Math.round(row.incTgt)) : '—'}</td>
                        <td className={prodDiff !== null ? (prodDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{prodDiff !== null ? (prodDiff >= 0 ? '+' : '') + prodDiff.toLocaleString() : '—'}</td>
                        <td className={invDiff !== null ? (invDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{invDiff !== null ? (invDiff >= 0 ? '+' : '') + invDiff.toLocaleString() : '—'}</td>
                        <td className={incDiff !== null ? (incDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{incDiff !== null ? (incDiff >= 0 ? '+' : '') + fmtDollar(Math.round(Math.abs(incDiff))) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table></div>
            </div>
          </div>

          {/* MTD Revenue Section */}
          <div style={{marginTop:8}}>
            <div style={{fontSize:11,fontWeight:500,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--ink-40)',marginBottom:8}}>Revenue — Invoiced vs Target (yards × rate)</div>
            <div className={styles.mtdGrid}>
              <div className={styles.mtdCard}>
                <div className={styles.mtdCardTitle}><span className={styles.facilityBadge}>NJ</span> Passaic MTD Revenue</div>
                <table className={styles.mtdTable}>
                  <thead>
                    <tr><th></th><th>Invoiced $</th><th>Target $</th><th>+/−</th></tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Schumacher', invoiced: mtdNJSchInvoiced, target: mtdNJSchRevTarget },
                      { label: '3rd Party', invoiced: mtdNJTpInvoiced, target: mtdNJTpRevTarget },
                    ].map(row => {
                      const diff = row.invoiced - row.target
                      const status = statusColor(row.invoiced, row.target)
                      return (
                        <tr key={row.label}>
                          <td className={styles.mtdLabel}>{row.label}</td>
                          <td className={styles.mtdActual}><Dot status={status} />{fmtDollar(row.invoiced)}</td>
                          <td className={styles.mtdTarget}>{fmtDollar(row.target)}</td>
                          <td className={diff >= 0 ? styles.mtdOver : styles.mtdUnder}>{diff >= 0 ? '+' : ''}{fmtDollar(Math.abs(diff))}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className={styles.mtdCard}>
                <div className={styles.mtdCardTitle}><span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span> Brooklyn MTD Revenue</div>
                <table className={styles.mtdTable}>
                  <thead>
                    <tr><th></th><th>Invoiced $</th><th>Target $</th><th>+/−</th></tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Schumacher', invoiced: mtdBNYSchInvoiced, target: mtdBNYSchRevTarget },
                      { label: '3rd Party', invoiced: mtdBNYTpInvoiced, target: mtdBNYTpRevTarget },
                    ].map(row => {
                      const diff = row.invoiced - row.target
                      const status = statusColor(row.invoiced, row.target)
                      return (
                        <tr key={row.label}>
                          <td className={styles.mtdLabel}>{row.label}</td>
                          <td className={styles.mtdActual}><Dot status={status} />{fmtDollar(row.invoiced)}</td>
                          <td className={styles.mtdTarget}>{fmtDollar(row.target)}</td>
                          <td className={diff >= 0 ? styles.mtdOver : styles.mtdUnder}>{diff >= 0 ? '+' : ''}{fmtDollar(Math.abs(diff))}</td>
                        </tr>
                      )
                    })}
                    <tr className={styles.mtdProcurementRow}>
                      <td className={styles.mtdLabel} colSpan={4}>
                        Procurement: {fmtDollar(mtdProcurement)} collected · {fmtDollar(procurementMTDTarget)} target
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* YTD SUMMARY */}
      {ytdWeeksWithData > 0 && (
        <div className={styles.historySection}>
          <div className={styles.historySectionTitle} style={{display:'flex',alignItems:'center',gap:8}}>
            Year-to-Date Summary — {ytdWeeksWithData} week{ytdWeeksWithData !== 1 ? 's' : ''} · Fiscal 2026 · Produced vs Invoiced vs Target
            <CommentButton weekStart={weekStart} section="dash-ytd" label="Year-to-Date Summary" currentUser={currentUser} onCommentPosted={onCommentPosted} />
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            {/* NJ YTD — expanded */}
            <div className={styles.mtdCard}>
              <div className={styles.mtdCardTitle}><span className={styles.facilityBadge}>NJ</span> Passaic YTD</div>
              <div style={{overflowX:"auto"}}><table className={styles.mtdTable} style={{minWidth:680,fontSize:11}}>
                <thead>
                  <tr><th></th><th>Produced</th><th>Inv Yds</th><th>Revenue $</th><th>Prod Tgt</th><th>Inv Tgt</th><th>Rev Tgt</th><th>Prod +/−</th><th>Inv +/−</th><th>$ +/−</th></tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Fabric', produced: ytdNJ.fabric, invYds: ytdNJInvoiceYds.fabric, rev: ytdNJInvoiceRev.fabric, prodTgt: ytdNJTarget.fabric, invTgt: ytdNJInvYdsTarget.fabric, revTgt: ytdNJRevTarget.fabric },
                    { label: 'Grass',  produced: ytdNJ.grass,  invYds: ytdNJInvoiceYds.grass,  rev: ytdNJInvoiceRev.grass,  prodTgt: ytdNJTarget.grass,  invTgt: ytdNJInvYdsTarget.grass,  revTgt: ytdNJRevTarget.grass },
                    { label: 'Paper',  produced: ytdNJ.paper,  invYds: ytdNJInvoiceYds.paper,  rev: ytdNJInvoiceRev.paper,  prodTgt: ytdNJTarget.paper,  invTgt: ytdNJInvYdsTarget.paper,  revTgt: ytdNJRevTarget.paper },
                    { label: 'Total Yds', produced: ytdNJ.total, invYds: Object.values(ytdNJInvoiceYds).reduce((a,b)=>a+b,0), rev: Object.values(ytdNJInvoiceRev).reduce((a,b)=>a+b,0), prodTgt: ytdNJTarget.total, invTgt: ytdNJInvYdsTarget.total, revTgt: ytdNJRevTarget.total, bold: true },
                    { label: 'Net Yds', produced: ytdNJNet, invYds: null, rev: null, prodTgt: null, invTgt: null, revTgt: null },
                    { label: 'Waste', produced: ytdNJ.waste, invYds: null, rev: null, prodTgt: null, invTgt: null, revTgt: null, suffix: ytdNJWastePct ? ` (${ytdNJWastePct}%)` : '' },
                    { label: 'Schumacher', produced: ytdNJ.schProduced, invYds: ytdNJ.schInvoiced, rev: null, prodTgt: WEEKLY_TARGETS.schYards * ytdWeeksWithData, invTgt: WEEKLY_TARGETS.schYards * ytdWeeksWithData, revTgt: null, bold: true },
                    ...(ytdNJMiscFees>0 ? [{ label: 'Misc Fees', produced: null, invYds: null, rev: ytdNJMiscFees, prodTgt: null, invTgt: null, revTgt: null, isMisc: true }] : []),
                  ].map(row => {
                    const prodDiff = row.prodTgt ? row.produced - row.prodTgt : null
                    const invDiff  = row.invTgt && row.invYds !== null ? row.invYds - row.invTgt : null
                    const revDiff  = row.revTgt && row.rev !== null ? row.rev - row.revTgt : null
                    const prodSt   = row.prodTgt ? statusColor(row.produced, row.prodTgt) : 'gray'
                    const invSt    = row.invTgt && row.invYds !== null ? statusColor(row.invYds, row.invTgt) : 'gray'
                    return (
                      <tr key={row.label} className={row.bold ? styles.mtdBoldRow : ''}>
                        <td className={styles.mtdLabel}>{row.label}</td>
                        <td className={styles.mtdActual}><Dot status={prodSt} />{row.produced !== null && row.produced !== undefined ? row.produced.toLocaleString() : '—'}{row.suffix||''}</td>
                        <td className={styles.mtdActual}>{row.invYds !== null && row.invYds !== undefined ? <><Dot status={invSt} />{row.invYds.toLocaleString()}</> : <span style={{color:'var(--ink-30)'}}>—</span>}</td>
                        <td className={styles.mtdActual}>{row.rev !== null && row.rev !== undefined && row.rev > 0 ? fmtDollar(Math.round(row.rev)) : <span style={{color:'var(--ink-30)'}}>—</span>}</td>
                        <td className={styles.mtdTarget}>{row.prodTgt ? row.prodTgt.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.invTgt ? row.invTgt.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.revTgt ? fmtDollar(Math.round(row.revTgt)) : '—'}</td>
                        <td className={prodDiff !== null ? (prodDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{prodDiff !== null ? (prodDiff >= 0 ? '+' : '') + prodDiff.toLocaleString() : '—'}</td>
                        <td className={invDiff !== null ? (invDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{invDiff !== null ? (invDiff >= 0 ? '+' : '') + invDiff.toLocaleString() : '—'}</td>
                        <td className={revDiff !== null ? (revDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{revDiff !== null ? (revDiff >= 0 ? '+' : '') + fmtDollar(Math.round(Math.abs(revDiff))) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table></div>
            </div>

            {/* BNY YTD — expanded with income invoiced $ */}
            <div className={styles.mtdCard}>
              <div className={styles.mtdCardTitle}><span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span> Brooklyn YTD</div>
              <div style={{overflowX:"auto"}}><table className={styles.mtdTable} style={{minWidth:720,fontSize:11}}>
                <thead>
                  <tr><th></th><th>Produced</th><th>Inv Yds</th><th>Income Inv $</th><th>Prod Tgt</th><th>Inv Yds Tgt</th><th>Inc Inv Tgt</th><th>Prod +/−</th><th>Inv +/−</th><th>$ +/−</th></tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Replen',   produced: ytdBNY.replen,   invYds: ytdBNYInvYds.replen,   income: ytdBNYIncomeInvoiced.replen,   prodTgt: ytdBNYTarget.replen,   incTgt: ytdBNYIncomeTarget.replen },
                    { label: 'MTO',      produced: ytdBNY.mto,      invYds: ytdBNYInvYds.mto,      income: ytdBNYIncomeInvoiced.mto,      prodTgt: ytdBNYTarget.mto,      incTgt: ytdBNYIncomeTarget.mto },
                    { label: 'HOS',      produced: ytdBNY.hos,      invYds: ytdBNYInvYds.hos,      income: ytdBNYIncomeInvoiced.hos,      prodTgt: ytdBNYTarget.hos,      incTgt: ytdBNYIncomeTarget.hos },
                    { label: 'Memo',     produced: ytdBNY.memo,     invYds: ytdBNYInvYds.memo,     income: ytdBNYIncomeInvoiced.memo,     prodTgt: ytdBNYTarget.memo,     incTgt: ytdBNYIncomeTarget.memo },
                    { label: 'Contract', produced: ytdBNY.contract, invYds: ytdBNYInvYds.contract, income: ytdBNYIncomeInvoiced.contract, prodTgt: ytdBNYTarget.contract, incTgt: ytdBNYIncomeTarget.contract },
                    { label: 'Total Yds', produced: ytdBNY.total, invYds: Object.values(ytdBNYInvYds).reduce((a,b)=>a+b,0), income: Object.values(ytdBNYIncomeInvoiced).reduce((a,b)=>a+b,0), prodTgt: ytdBNYTarget.total, incTgt: ytdBNYIncomeTarget.total, bold: true },
                    { label: 'Schumacher', produced: ytdBNY.schProduced, invYds: ytdBNY.schInvoiced, income: null, prodTgt: WEEKLY_TARGETS.schYards * ytdWeeksWithData, incTgt: null, bold: true },
                    ...(ytdBNYMiscFees>0 ? [{ label: 'Misc Fees', produced: null, invYds: null, income: ytdBNYMiscFees, prodTgt: null, incTgt: null, isMisc: true }] : []),
                    { label: 'Procurement $', produced: ytdProcurement, income: null, prodTgt: null, incTgt: null, isDollar: true },
                  ].map(row => {
                    const invYds = row.invYds !== undefined ? row.invYds : null
                    const prodDiff = row.prodTgt ? row.produced - row.prodTgt : null
                    const incDiff  = row.incTgt && row.income !== null && row.income !== undefined ? row.income - row.incTgt : null
                    const prodSt   = row.prodTgt ? statusColor(row.produced, row.prodTgt) : 'gray'
                    return (
                      <tr key={row.label} className={row.bold ? styles.mtdBoldRow : ''}>
                        <td className={styles.mtdLabel}>{row.label}</td>
                        <td className={styles.mtdActual}><Dot status={prodSt} />{row.isDollar ? fmtDollar(row.produced) : row.produced !== undefined ? row.produced.toLocaleString() : '—'}</td>
                        <td className={styles.mtdActual}>{invYds !== null ? invYds.toLocaleString() : <span style={{color:'var(--ink-30)'}}>—</span>}</td>
                        <td className={styles.mtdActual}>{row.income !== null && row.income !== undefined && row.income > 0 ? fmtDollar(Math.round(row.income)) : <span style={{color:'var(--ink-30)'}}>—</span>}</td>
                        <td className={styles.mtdTarget}>{row.prodTgt ? row.prodTgt.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.incTgt ? row.prodTgt?.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>{row.incTgt ? fmtDollar(Math.round(row.incTgt)) : '—'}</td>
                        <td className={prodDiff !== null ? (prodDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{prodDiff !== null ? (prodDiff >= 0 ? '+' : '') + prodDiff.toLocaleString() : '—'}</td>
                        <td className={styles.mtdTarget}>—</td>
                        <td className={incDiff !== null ? (incDiff >= 0 ? styles.mtdOver : styles.mtdUnder) : styles.mtdTarget}>{incDiff !== null ? (incDiff >= 0 ? '+' : '') + fmtDollar(Math.round(Math.abs(incDiff))) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table></div>
            </div>
          </div>

          {/* YTD Revenue Section */}
          <div className={styles.mtdRevenueSection}>
            <div className={styles.mtdRevenueSectionTitle}>Revenue — Invoiced vs Target (yards × rate)</div>
            <div className={styles.mtdGrid}>
              <div className={styles.mtdCard}>
                <div className={styles.mtdCardTitle}><span className={styles.facilityBadge}>NJ</span> Passaic YTD Revenue</div>
                <table className={styles.mtdTable}>
                  <thead>
                    <tr><th></th><th>Invoiced $</th><th>Target $</th><th>+/−</th></tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Schumacher', invoiced: ytdNJSchInvoiced, target: ytdNJSchRevTarget },
                      { label: '3rd Party', invoiced: ytdNJTpInvoiced, target: ytdNJTpRevTarget },
                    ].map(row => {
                      const diff = row.invoiced - row.target
                      const status = statusColor(row.invoiced, row.target)
                      return (
                        <tr key={row.label}>
                          <td className={styles.mtdLabel}>{row.label}</td>
                          <td className={styles.mtdActual}><Dot status={status} />{fmtDollar(row.invoiced)}</td>
                          <td className={styles.mtdTarget}>{fmtDollar(row.target)}</td>
                          <td className={diff >= 0 ? styles.mtdOver : styles.mtdUnder}>{diff >= 0 ? '+' : ''}{fmtDollar(Math.abs(diff))}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className={styles.mtdCard}>
                <div className={styles.mtdCardTitle}><span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span> Brooklyn YTD Revenue</div>
                <table className={styles.mtdTable}>
                  <thead>
                    <tr><th></th><th>Invoiced $</th><th>Target $</th><th>+/−</th></tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Schumacher', invoiced: ytdBNYSchInvoiced, target: ytdBNYSchRevTarget },
                      { label: '3rd Party', invoiced: ytdBNYTpInvoiced, target: ytdBNYTpRevTarget },
                    ].map(row => {
                      const diff = row.invoiced - row.target
                      const status = statusColor(row.invoiced, row.target)
                      return (
                        <tr key={row.label}>
                          <td className={styles.mtdLabel}>{row.label}</td>
                          <td className={styles.mtdActual}><Dot status={status} />{fmtDollar(row.invoiced)}</td>
                          <td className={styles.mtdTarget}>{fmtDollar(row.target)}</td>
                          <td className={diff >= 0 ? styles.mtdOver : styles.mtdUnder}>{diff >= 0 ? '+' : ''}{fmtDollar(Math.abs(diff))}</td>
                        </tr>
                      )
                    })}
                    <tr className={styles.mtdProcurementRow}>
                      <td className={styles.mtdLabel} colSpan={4}>
                        Procurement: {fmtDollar(ytdProcurement)} collected · {fmtDollar(ytdProcurementTarget)} target
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MODE — only in admin */}
      {mode === 'edit' && !readOnly && (
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
            <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Output by machine (optional)</div>
            <div className={styles.machineEditGrid}>
              <div className={styles.machineEditGroup}>
                <div className={styles.machineEditGroupLabel}>3600 machines — BNY (target: 3,600/wk each)</div>
                {BNY_MACHINES_3600.map(m => (
                  <NumberInput key={m.id} label={m.name} value={bnyData.machines?.[m.id] || ''} onChange={v => updateBNY('machines', { ...bnyData.machines, [m.id]: v })} placeholder="3600" />
                ))}
              </div>
              <div className={styles.machineEditGroup}>
                <div className={styles.machineEditGroupLabel}>570 machines — BNY (target: 500/wk each)</div>
                <div className={styles.machineEditCols}>
                  {BNY_MACHINES_570_BNY.map(m => (
                    <NumberInput key={m.id} label={m.name} value={bnyData.machines?.[m.id] || ''} onChange={v => updateBNY('machines', { ...bnyData.machines, [m.id]: v })} placeholder="500" />
                  ))}
                </div>
              </div>
              <div className={styles.machineEditGroup}>
                <div className={styles.machineEditGroupLabel}>570 machines — Passaic (target: 500/wk each)</div>
                <div className={styles.machineEditCols}>
                  {BNY_MACHINES_570_NJ.map(m => (
                    <NumberInput key={m.id} label={m.name} value={bnyData.machines?.[m.id] || ''} onChange={v => updateBNY('machines', { ...bnyData.machines, [m.id]: v })} placeholder="500" />
                  ))}
                </div>
              </div>
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
            <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Procurement Revenue (pass-through)</div>
            <div style={{ maxWidth: 220 }}>
              <NumberInput
                label={`This week $ · Monthly target: ${fmtDollar(procurementMonthlyTarget)} (${weeksInMonth}-wk month)`}
                value={bnyData.procurement}
                onChange={v => updateBNY('procurement', v)}
                placeholder="12500"
              />
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
