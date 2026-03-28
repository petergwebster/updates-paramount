import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import CommentButton from './CommentButton'
import styles from './PeopleTab.module.css'

export default function PeopleTab({ weekStart, readOnly = true, currentUser, onCommentPosted }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [bnyOpen, setBnyOpen] = useState(false)
  const [njOpen, setNjOpen] = useState(false)

  useEffect(() => {
    if (!weekStart) return
    fetchData()
  }, [weekStart])

  async function fetchData() {
    setLoading(true)
    const { data: row, error } = await supabase
      .from('people_weekly')
      .select('*')
      .eq('week_start', weekStart)
      .maybeSingle()

    if (error) console.error('PeopleTab fetch error:', error)
    setData(row || null)
    setLoading(false)
  }

  if (loading) {
    return <div className={styles.empty}>Loading people data…</div>
  }

  if (!data) {
    return (
      <div className={styles.empty}>
        <p>No people data for this week yet.</p>
        {!readOnly && <p className={styles.emptyHint}>Upload payroll and HR files in the Admin panel to populate this tab.</p>}
      </div>
    )
  }

  const employees  = data.employees || []
  const bnyEmployees = employees.filter(e => e.location === 'BNY')
  const njEmployees  = employees.filter(e => e.location === 'NJ')
  const leaves       = data.leaves || []
  const openRoles    = data.open_roles || []

  const totalHeadcount = (data.bny_headcount || 0) + (data.nj_headcount || 0)
  const totalHrs       = (data.bny_total_hrs || 0) + (data.nj_total_hrs || 0)
  const totalReg       = (data.bny_reg_hrs || 0) + (data.nj_reg_hrs || 0)
  const totalOT        = (data.bny_ot_hrs || 0) + (data.nj_ot_hrs || 0)
  const totalPTO       = (data.bny_pto_hrs || 0) + (data.nj_pto_hrs || 0)
  const totalPay       = (data.bny_total_pay || 0) + (data.nj_total_pay || 0)
  const totalBonus     = (data.bny_bonus_total || 0) + (data.nj_bonus_total || 0)

  const fmt  = n => Number(n || 0).toFixed(1)
  const fmtN = n => Math.round(n || 0).toLocaleString()
  const fmtD = n => '$' + Math.round(n || 0).toLocaleString()

  const countFlags = (emps, flag) => emps.filter(e => (e.flags || []).includes(flag)).length

  function pillsForEmployee(emp) {
    const flags = emp.flags || []
    return (
      <span className={styles.pillGroup}>
        {flags.includes('OT')      && <span className={`${styles.pill} ${styles.pillOt}`}>OT</span>}
        {flags.includes('PTO')     && <span className={`${styles.pill} ${styles.pillPto}`}>PTO</span>}
        {flags.includes('bonus')   && <span className={`${styles.pill} ${styles.pillBon}`}>Bonus{emp.bonus_amt ? ` $${Math.round(emp.bonus_amt).toLocaleString()}` : ''}</span>}
        {flags.includes('under40') && <span className={`${styles.pill} ${styles.pillLow}`}>Under 40</span>}
        {flags.includes('leave')   && <span className={`${styles.pill} ${styles.pillLv}`}>On leave</span>}
        {flags.length === 0        && <span>—</span>}
      </span>
    )
  }

  return (
    <div className={styles.wrap}>

      <p className={styles.eyebrow}>
        Week of {new Date(weekStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        &nbsp;·&nbsp; {totalHeadcount} active employees
      </p>

      {/* Top metrics */}
      <div className={styles.metricRow}>
        <div className={styles.mc}>
          <p className={styles.mcLabel}>Total headcount</p>
          <p className={styles.mcVal}>{totalHeadcount}</p>
          <p className={styles.mcSub}>BNY {data.bny_headcount} · Passaic {data.nj_headcount}</p>
        </div>
        <div className={styles.mc}>
          <p className={styles.mcLabel}>Total hours</p>
          <p className={styles.mcVal}>{fmtN(totalHrs)}</p>
          <p className={styles.mcSub}>Reg {fmt(totalReg)} · OT {fmt(totalOT)} · PTO {fmt(totalPTO)}</p>
        </div>
        <div className={styles.mc}>
          <p className={styles.mcLabel}>Total gross payroll</p>
          <p className={styles.mcVal}>{fmtD(totalPay)}</p>
          <p className={styles.mcSub}>Incl. {fmtD(totalBonus)} in bonuses</p>
        </div>
        <div className={styles.mc}>
          <p className={styles.mcLabel}>On leave</p>
          <p className={styles.mcVal}>{leaves.length}</p>
          <p className={styles.mcSub}>{leaves.slice(0,3).map(l => l.name.split(',')[0]).join(', ')}{leaves.length > 3 ? '…' : ''}</p>
        </div>
      </div>

      {/* Location cards */}
      <div className={styles.twoCol}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            BNY – Brooklyn
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CommentButton weekStart={new Date(weekStart + 'T12:00:00')} section="people-bny" label="BNY – Brooklyn" currentUser={currentUser} onCommentPosted={onCommentPosted} />
              <span className={styles.badge}>{data.bny_headcount} employees</span>
            </div>
          </div>
          <div className={styles.statGrid}>
            <div className={styles.stat}><strong>{fmt(data.bny_total_hrs)}</strong>Total hours</div>
            <div className={styles.stat}><strong>{fmt((data.bny_total_hrs || 0) / (data.bny_headcount || 1))}</strong>Avg hrs / person</div>
            <div className={styles.stat}><strong>{fmt(data.bny_ot_hrs)}</strong>OT hours</div>
            <div className={styles.stat}><strong>{fmt(data.bny_pto_hrs)}</strong>PTO hours</div>
            <div className={styles.stat}><strong>{fmtD(data.bny_total_pay)}</strong>Gross payroll</div>
            <div className={styles.stat}><strong>{fmtD((data.bny_total_pay || 0) / (data.bny_headcount || 1))}</strong>Avg pay / person</div>
          </div>
          <div className={styles.pillRow}>
            {countFlags(bnyEmployees,'OT') > 0      && <span className={`${styles.pill} ${styles.pillOt}`}>{countFlags(bnyEmployees,'OT')} on OT</span>}
            {countFlags(bnyEmployees,'PTO') > 0     && <span className={`${styles.pill} ${styles.pillPto}`}>{countFlags(bnyEmployees,'PTO')} on PTO</span>}
            {countFlags(bnyEmployees,'bonus') > 0   && <span className={`${styles.pill} ${styles.pillBon}`}>{countFlags(bnyEmployees,'bonus')} bonus</span>}
            {countFlags(bnyEmployees,'under40') > 0 && <span className={`${styles.pill} ${styles.pillLow}`}>{countFlags(bnyEmployees,'under40')} under 40 hrs</span>}
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardTitle}>
            Passaic – NJ
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CommentButton weekStart={new Date(weekStart + 'T12:00:00')} section="people-nj" label="Passaic – NJ" currentUser={currentUser} onCommentPosted={onCommentPosted} />
              <span className={styles.badge}>{data.nj_headcount} employees</span>
            </div>
          </div>
          <div className={styles.statGrid}>
            <div className={styles.stat}><strong>{fmt(data.nj_total_hrs)}</strong>Total hours</div>
            <div className={styles.stat}><strong>{fmt((data.nj_total_hrs || 0) / (data.nj_headcount || 1))}</strong>Avg hrs / person</div>
            <div className={styles.stat}><strong>{fmt(data.nj_ot_hrs)}</strong>OT hours</div>
            <div className={styles.stat}><strong>{fmt(data.nj_pto_hrs)}</strong>PTO hours</div>
            <div className={styles.stat}><strong>{fmtD(data.nj_total_pay)}</strong>Gross payroll</div>
            <div className={styles.stat}><strong>{fmtD((data.nj_total_pay || 0) / (data.nj_headcount || 1))}</strong>Avg pay / person</div>
          </div>
          <div className={styles.pillRow}>
            {countFlags(njEmployees,'OT') > 0      && <span className={`${styles.pill} ${styles.pillOt}`}>{countFlags(njEmployees,'OT')} on OT</span>}
            {countFlags(njEmployees,'PTO') > 0     && <span className={`${styles.pill} ${styles.pillPto}`}>{countFlags(njEmployees,'PTO')} on PTO</span>}
            {countFlags(njEmployees,'bonus') > 0   && <span className={`${styles.pill} ${styles.pillBon}`}>{countFlags(njEmployees,'bonus')} prod. bonuses</span>}
            {countFlags(njEmployees,'under40') > 0 && <span className={`${styles.pill} ${styles.pillLow}`}>{countFlags(njEmployees,'under40')} under 40 hrs</span>}
          </div>
        </div>
      </div>

      {/* Leaves + Recruitment */}
      <div className={styles.twoCol}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            Leaves of absence
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CommentButton weekStart={new Date(weekStart + 'T12:00:00')} section="people-leaves" label="Leaves of absence" currentUser={currentUser} onCommentPosted={onCommentPosted} />
              <span className={styles.badge}>{leaves.length} active</span>
            </div>
          </div>
          {leaves.length === 0
            ? <p className={styles.emptyCard}>No active leaves this week</p>
            : leaves.map((l, i) => (
              <div key={i} className={styles.alertItem}>
                <span>{l.name}</span>
                <span className={`${styles.pill} ${styles.pillLv}`}>Since {l.since}</span>
              </div>
            ))
          }
        </div>

        <div className={styles.card}>
          <div className={styles.cardTitle}>
            Open recruitment
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CommentButton weekStart={new Date(weekStart + 'T12:00:00')} section="people-recruitment" label="Open recruitment" currentUser={currentUser} onCommentPosted={onCommentPosted} />
              <span className={styles.badge}>{openRoles.length} role{openRoles.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
          {openRoles.length === 0
            ? <p className={styles.emptyCard}>No open roles</p>
            : openRoles.map((r, i) => (
              <div key={i} className={styles.alertItem}>
                <span>{r.role}</span>
                <span className={`${styles.pill} ${styles.pillOk}`}>{r.status}</span>
              </div>
            ))
          }
          <div className={styles.bonusBlock}>
            <p className={styles.bonusLabel}>Monthly bonus targets – BNY</p>
            <div className={styles.alertItem}>
              <span>Chandler – invoiced yds ≥ 50K / 62.5K</span>
              <span className={`${styles.pill} ${styles.pillBon}`}>$1,500</span>
            </div>
            <div className={styles.alertItem}>
              <span>Adams – BNY produced yds ≥ same</span>
              <span className={`${styles.pill} ${styles.pillBon}`}>$750</span>
            </div>
          </div>
        </div>
      </div>

      {/* Trailing charts — uses window.Chart from CDN */}
      <TrailingCharts weekStart={weekStart} />

      {/* Employee detail — collapsible */}
      <p className={`${styles.eyebrow} ${styles.sectionDivider}`}>Employee detail</p>

      <RosterSection
        title="BNY – Brooklyn"
        count={data.bny_headcount}
        employees={bnyEmployees}
        isOpen={bnyOpen}
        onToggle={() => setBnyOpen(v => !v)}
        pillsForEmployee={pillsForEmployee}
        fmt={fmt}
        fmtD={fmtD}
      />

      <RosterSection
        title="Passaic – NJ"
        count={data.nj_headcount}
        employees={njEmployees}
        isOpen={njOpen}
        onToggle={() => setNjOpen(v => !v)}
        pillsForEmployee={pillsForEmployee}
        fmt={fmt}
        fmtD={fmtD}
      />

      {data.hr_notes && (
        <div className={`${styles.card} ${styles.notesCard}`}>
          <p className={styles.eyebrow} style={{ marginBottom: '8px' }}>HR notes this week</p>
          <p className={styles.hrNotes}>{data.hr_notes}</p>
        </div>
      )}

    </div>
  )
}

/* ── Collapsible roster section ── */
function RosterSection({ title, count, employees, isOpen, onToggle, pillsForEmployee, fmt, fmtD }) {
  const otCount    = employees.filter(e => (e.flags||[]).includes('OT')).length
  const ptoCount   = employees.filter(e => (e.flags||[]).includes('PTO')).length
  const leaveCount = employees.filter(e => (e.flags||[]).includes('leave')).length
  const lowCount   = employees.filter(e => (e.flags||[]).includes('under40')).length

  return (
    <div className={styles.rosterSection}>
      <button
        className={`${styles.rosterToggle} ${isOpen ? styles.rosterToggleOpen : ''}`}
        onClick={onToggle}
      >
        <span>
          {title}&nbsp;
          <span className={styles.toggleCount}>{count} employees</span>
        </span>
        <span className={styles.toggleRight}>
          {otCount > 0    && <span className={`${styles.pill} ${styles.pillOt}`}>{otCount} OT</span>}
          {ptoCount > 0   && <span className={`${styles.pill} ${styles.pillPto}`}>{ptoCount} PTO</span>}
          {leaveCount > 0 && <span className={`${styles.pill} ${styles.pillLv}`}>{leaveCount} on leave</span>}
          {lowCount > 0   && <span className={`${styles.pill} ${styles.pillLow}`}>{lowCount} under 40 hrs</span>}
          <span className={`${styles.toggleArrow} ${isOpen ? styles.toggleArrowOpen : ''}`}>▾</span>
        </span>
      </button>

      {isOpen && (
        <div className={styles.rosterBody}>
          <div className={styles.rosterHead}>
            <span>Name</span>
            <span>Title</span>
            <span>Total hrs</span>
            <span>OT hrs</span>
            <span>PTO hrs</span>
            <span>Gross pay</span>
            <span>Flags</span>
          </div>
          {employees.map((emp, i) => (
            <div key={i} className={styles.rosterRow}>
              <span>{emp.name}</span>
              <span className={styles.muted}>{emp.title}</span>
              <span>{fmt(emp.total_hrs)}</span>
              <span>{emp.ot_hrs > 0 ? fmt(emp.ot_hrs) : '—'}</span>
              <span>{emp.pto_hrs > 0 ? fmt(emp.pto_hrs) : '—'}</span>
              <span>{fmtD(emp.total_pay)}</span>
              <span>{pillsForEmployee(emp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Trailing 4-week bar charts — uses window.Chart loaded via CDN ── */
function TrailingCharts({ weekStart }) {
  const njRef    = useRef(null)
  const bnyRef   = useRef(null)
  const njChart  = useRef(null)
  const bnyChart = useRef(null)
  const [history, setHistory] = useState(null)

  useEffect(() => {
    if (!weekStart) return
    fetchHistory()
  }, [weekStart])

  async function fetchHistory() {
    const { data, error } = await supabase
      .from('people_weekly')
      .select('week_start, bny_reg_hrs, bny_ot_hrs, bny_pto_hrs, nj_reg_hrs, nj_ot_hrs, nj_pto_hrs')
      .lte('week_start', weekStart)
      .order('week_start', { ascending: false })
      .limit(4)

    if (error || !data) return
    setHistory(data.reverse())
  }

  useEffect(() => {
    if (!history || !njRef.current || !bnyRef.current) return
    if (typeof window.Chart === 'undefined') return

    const labels = history.map(r =>
      new Date(r.week_start + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    )

    const mkDatasets = (regData, otData, ptoData) => ([
      { label: 'Reg hours', data: regData, backgroundColor: '#378ADD', stack: 'a' },
      { label: 'PTO',       data: ptoData, backgroundColor: '#EF9F27', stack: 'a' },
      { label: 'OT',        data: otData,  backgroundColor: '#E24B4A', stack: 'a' },
    ])

    const chartOpts = {
      type: 'bar',
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} hrs` } }
        },
        scales: {
          x: { stacked: true, ticks: { font: { size: 11 }, color: '#888780' } },
          y: { stacked: true, ticks: { font: { size: 11 }, color: '#888780', callback: v => v.toLocaleString() }, grid: { color: 'rgba(128,128,128,0.1)' } }
        }
      }
    }

    if (njChart.current) njChart.current.destroy()
    njChart.current = new window.Chart(njRef.current, {
      ...chartOpts,
      data: { labels, datasets: mkDatasets(history.map(r => r.nj_reg_hrs || 0), history.map(r => r.nj_ot_hrs || 0), history.map(r => r.nj_pto_hrs || 0)) }
    })

    if (bnyChart.current) bnyChart.current.destroy()
    bnyChart.current = new window.Chart(bnyRef.current, {
      ...chartOpts,
      data: { labels, datasets: mkDatasets(history.map(r => r.bny_reg_hrs || 0), history.map(r => r.bny_ot_hrs || 0), history.map(r => r.bny_pto_hrs || 0)) }
    })

    return () => {
      if (njChart.current)  { njChart.current.destroy();  njChart.current = null }
      if (bnyChart.current) { bnyChart.current.destroy(); bnyChart.current = null }
    }
  }, [history])

  if (!history) return null

  return (
    <>
      <p className={`${styles.eyebrow} ${styles.sectionDivider}`}>4-week trailing hours – Passaic</p>
      <div className={styles.chartLegend}>
        <span><span className={styles.legendDot} style={{ background: '#378ADD' }} />Reg hours</span>
        <span><span className={styles.legendDot} style={{ background: '#EF9F27' }} />PTO</span>
        <span><span className={styles.legendDot} style={{ background: '#E24B4A' }} />OT</span>
      </div>
      <div className={styles.chartWrap}><canvas ref={njRef} /></div>

      <p className={`${styles.eyebrow} ${styles.sectionDivider}`}>4-week trailing hours – BNY</p>
      <div className={styles.chartLegend}>
        <span><span className={styles.legendDot} style={{ background: '#378ADD' }} />Reg hours</span>
        <span><span className={styles.legendDot} style={{ background: '#EF9F27' }} />PTO</span>
        <span><span className={styles.legendDot} style={{ background: '#E24B4A' }} />OT</span>
      </div>
      <div className={styles.chartWrap}><canvas ref={bnyRef} /></div>
    </>
  )
}
