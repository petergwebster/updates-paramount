import React, { useState, useEffect, useRef } from 'react'
import { format, startOfWeek, addWeeks, subWeeks, addDays } from 'date-fns'
import { supabase } from './supabase'
import { getFiscalLabel } from './fiscalCalendar'
import WeeklyLog from './components/WeeklyLog'
import KPIScorecard from './components/KPIScorecard'
import Correspondence from './components/Correspondence'
import HistoryPanel from './components/HistoryPanel'
import ProductionDashboard from './components/ProductionDashboard'
import AdminPanel from './components/AdminPanel'
import LoginScreen from './components/LoginScreen'
import PeopleTab from './components/PeopleTab'
import FinancialTab from './components/FinancialTab'
import AdminPeople from './components/AdminPeople'
import { FacilityDetail, OperatorScorecard, useProductionData, generateLiveOpsPDF } from './components/ProductionTab'
import WIPTab from './components/WIPTab'
import styles from './App.module.css'

// ── Day col definitions (needed by LiveOpsPage) ──────────────────────────────
const BNY_DAYS = [
  { label:'Mon', sched:2,  actual:3,  waste:4,  op:5  },
  { label:'Tue', sched:6,  actual:7,  waste:8,  op:9  },
  { label:'Wed', sched:10, actual:11, waste:12, op:13 },
  { label:'Thu', sched:14, actual:15, waste:16, op:17 },
  { label:'Fri', sched:18, actual:19, waste:20, op:21 },
]
const NJ_DAYS = [
  { label:'Mon', sched:2,  actual:3,  waste:4,  op1:5,  op2:6  },
  { label:'Tue', sched:7,  actual:8,  waste:9,  op1:10, op2:11 },
  { label:'Wed', sched:12, actual:13, waste:14, op1:15, op2:16 },
  { label:'Thu', sched:17, actual:18, waste:19, op1:20, op2:21 },
  { label:'Fri', sched:22, actual:23, waste:24, op1:25, op2:26 },
]

// ── Nav: Consolidated | Financials | People | (Live Ops — admin only) | ⚙ ────
const PUBLIC_TABS = [
  { id: 'consolidated', label: 'Consolidated' },
  { id: 'financials',   label: 'Financials'   },
  { id: 'people',       label: 'People'        },
  { id: 'wip',          label: 'WIP'           },
]
const ADMIN_TABS = [
  { id: 'liveops', label: '📊 Live Ops' },
]

function SlackIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 54 54" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" fillRule="evenodd">
        <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" fill="#36C5F0"/>
        <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" fill="#2EB67D"/>
        <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" fill="#ECB22E"/>
        <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.249m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.249a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387" fill="#E01E5A"/>
      </g>
    </svg>
  )
}

function getDefaultWeek() {
  // Always land on the most recently completed Mon-Sun week
  const thisWeekMonday = startOfWeek(new Date(), { weekStartsOn: 1 })
  return subWeeks(thisWeekMonday, 1)
}
function weekKey(date) { return format(date, 'yyyy-MM-dd') }

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase',
      color:'var(--ink-40)', marginBottom:16, paddingBottom:8, borderBottom:'1px solid var(--ink-10)' }}>
      {children}
    </div>
  )
}

// ── Consolidated tab ──────────────────────────────────────────────────────────
function ConsolidatedPage({ weekStart, weekData, dbReady, commentProps }) {
  const fiscalLabel = getFiscalLabel(weekStart)
  const narrative   = weekData?.executive_narrative || null
  const kpis        = weekData?.kpis || {}
  const flags       = weekData?.flags || null
  const kpiList     = Object.values(kpis)
  const onTrack     = kpiList.filter(k=>k?.status==='green').length
  const watch       = kpiList.filter(k=>k?.status==='amber').length
  const concern     = kpiList.filter(k=>k?.status==='red').length
  const hasKPIs     = kpiList.length > 0
  const weekEnd     = addDays(weekStart, 4)
  const dateRange   = `${format(weekStart,'MMM d')}–${format(weekEnd,'d, yyyy')}`

  return (
    <div style={{ maxWidth:980, margin:'0 auto', padding:'36px 24px 80px', fontFamily:'Georgia, serif' }}>

      {/* Report header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:8 }}>
        <div>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8 }}>
            Weekly Operations Report · Results
          </div>
          <h1 style={{ margin:0, fontSize:30, fontWeight:700, color:'var(--ink)', lineHeight:1.15 }}>{dateRange}</h1>
          {fiscalLabel && <div style={{ marginTop:6, fontSize:13, color:'var(--ink-40)' }}>{fiscalLabel}</div>}
        </div>
        <div style={{ textAlign:'right', paddingTop:4 }}>
          <div style={{ fontSize:11, color:'var(--ink-40)', marginBottom:3 }}>Prepared by</div>
          <div style={{ fontSize:14, fontWeight:600, color:'var(--ink)' }}>Peter Webster</div>
          <div style={{ fontSize:12, color:'var(--ink-40)' }}>President, Paramount Prints</div>
        </div>
      </div>

      {/* KPI status strip */}
      {hasKPIs && (
        <div style={{ display:'flex', gap:20, margin:'20px 0 32px', padding:'12px 16px', background:'var(--cream-dark,#F5F0EA)', borderRadius:8, flexWrap:'wrap' }}>
          {[{color:'#22c55e',count:onTrack,label:'On Track'},{color:'#f59e0b',count:watch,label:'Watch'},{color:'#ef4444',count:concern,label:'Concern'}].map(({color,count,label})=>(
            <div key={label} style={{ display:'flex', alignItems:'center', gap:7, fontSize:13 }}>
              <span style={{ width:9, height:9, borderRadius:'50%', background:color, display:'inline-block', flexShrink:0 }}/>
              <span style={{ color:'var(--ink)' }}><strong>{count}</strong> {label}</span>
            </div>
          ))}
          <div style={{ flex:1 }}/>
          <div style={{ fontSize:11, color:'var(--ink-40)', alignSelf:'center' }}>KPI Scorecard · {kpiList.length} metrics</div>
        </div>
      )}

      {!hasKPIs && <div style={{ height:32 }}/>}

      {/* 1. Executive Summary */}
      <div style={{ marginBottom:48 }}>
        <SectionLabel>Executive Summary</SectionLabel>
        {narrative ? (
          <div style={{ fontSize:15, lineHeight:1.85, color:'var(--ink)', whiteSpace:'pre-wrap',
            background:'var(--cream-dark,#F5F0EA)', borderRadius:8, padding:'20px 24px', borderLeft:'3px solid var(--ink-20)' }}>
            {narrative}
          </div>
        ) : (
          <div style={{ background:'#FAFAF8', border:'1px dashed var(--ink-20)', borderRadius:8, padding:'28px 24px', textAlign:'center' }}>
            <div style={{ fontSize:14, color:'var(--ink-40)', marginBottom:6 }}>No executive summary drafted yet.</div>
            <div style={{ fontSize:12, color:'var(--ink-30)' }}>Go to ⚙ Admin → Weekly Data → fill in KPIs &amp; notes → Draft with AI</div>
          </div>
        )}
      </div>

      {/* 2. Areas of Concern */}
      {flags && (
        <div style={{ marginBottom:48 }}>
          <SectionLabel>Areas of Concern</SectionLabel>
          <div style={{ background:'#FFF8F0', border:'1px solid #FFE4C0', borderRadius:8, padding:'16px 20px', fontSize:14, lineHeight:1.7, color:'var(--ink)' }}>
            {flags}
          </div>
        </div>
      )}

      {/* 3. Production — from Supabase (works for all historical weeks) */}
      <div style={{ marginBottom:48 }}>
        <SectionLabel>Production — NJ &amp; Brooklyn</SectionLabel>
        <ProductionDashboard weekStart={weekStart} dbReady={dbReady} readOnly {...commentProps} />
      </div>

      {/* 4. KPI Scorecard detail */}
      {hasKPIs && (
        <div style={{ marginBottom:48 }}>
          <SectionLabel>KPI Scorecard Detail</SectionLabel>
          <KPIScorecard weekData={weekData} weekStart={weekStart} onSave={null} dbReady={dbReady} readOnly {...commentProps}/>
        </div>
      )}

      {/* Nav hints for C-suite */}
      <div style={{ borderTop:'1px solid var(--ink-10)', paddingTop:24, display:'flex', gap:16, flexWrap:'wrap' }}>
        <div style={{ fontSize:12, color:'var(--ink-30)' }}>
          See also:
        </div>
        {[
          { label:'Financials →', hint:'OpEx, COGS, inventory purchases' },
          { label:'People →',     hint:'Headcount, payroll summary'       },
        ].map(({label, hint}) => (
          <div key={label} style={{ fontSize:12, color:'var(--ink-40)' }}>
            <span style={{ fontWeight:600, color:'var(--ink-30)' }}>{label}</span> {hint}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Admin page ────────────────────────────────────────────────────────────────
function AdminPage({ weekStart, weekData, onSave, onRefresh, dbReady, userProfile, commentProps }) {
  const [section, setSection] = useState('production')
  const [generating,     setGenerating]     = useState(false)
  const [genError,       setGenError]       = useState(null)
  const [genSuccess,     setGenSuccess]     = useState(false)
  const [draftNarrative, setDraftNarrative] = useState('')
  const [publishing,     setPublishing]     = useState(false)

  // Load saved reports for current month on weekStart change
  useEffect(() => {
    async function loadSavedReports() {
      const monthKey = format(weekStart, 'yyyy-MM')
      const { data } = await supabase
        .from('monthly_reports')
        .select('type, report_title, generated_at, narrative')
        .eq('month', monthKey)
      if (data) {
        const map = {}
        data.forEach(r => { map[r.type] = r })
        setSavedReports(map)
      } else {
        setSavedReports({})
      }
    }
    loadSavedReports()
  }, [weekStart])

  // One-pager state
  const [onePagerType,    setOnePagerType]    = useState(null)
  const [onePagerDraft,   setOnePagerDraft]   = useState('')
  const [onePagerLoading, setOnePagerLoading] = useState(false)
  const [onePagerError,   setOnePagerError]   = useState(null)
  const [onePagerCopied,  setOnePagerCopied]  = useState(false)
  const [onePagerPayload, setOnePagerPayload] = useState(null)
  const [pdfGenerating,   setPdfGenerating]   = useState(false)
  const [onePagerSaved,   setOnePagerSaved]   = useState(false)
  const [isSavedReport,   setIsSavedReport]   = useState(false)
  const [savedReports,    setSavedReports]    = useState({}) // { mid: {...}, end: {...} }

  // Live saved-state checks — query existing tables, no schema changes needed
  const [hasProd,    setHasProd]    = useState(false)
  const [hasFinance, setHasFinance] = useState(false)
  const [hasPeople,  setHasPeople]  = useState(false)

  const wk = format(weekStart, 'yyyy-MM-dd')

  useEffect(() => {
    async function checkSavedState() {
      const [{ data: prod }, { data: fin }, { data: ppl }] = await Promise.all([
        supabase.from('production').select('week_start').eq('week_start', wk).maybeSingle(),
        supabase.from('financials_monthly').select('period').ilike('period', wk.slice(0,7)+'%').limit(1),
        supabase.from('people_weekly').select('week_start').eq('week_start', wk).maybeSingle(),
      ])
      setHasProd(!!prod)
      setHasFinance(!!(fin && fin.length > 0))
      setHasPeople(!!ppl)
    }
    checkSavedState()
  }, [wk, section]) // re-check when tab changes so chips update after saving

  const tabs = [
    { id:'production', label:'🏭 Production'   },
    { id:'kpis',       label:'🎯 KPI Scorecard' },
    { id:'log',        label:'📝 Daily Log'     },
    { id:'financials', label:'💰 Financials'    },
    { id:'people',     label:'👥 People'        },
    { id:'files',      label:'📁 Files'         },
    { id:'history',    label:'🕘 History'       },
  ]

  // Status chip logic — production/financials/people from DB, KPIs/log from weekData
  const kpis   = weekData?.kpis || {}
  const days   = weekData?.days || {}
  const hasKPIs = Object.values(kpis).some(k => k?.status && k.status !== 'gray')
  const hasLog  = Object.values(days).some(d => d?.text?.trim())

  const chips = [
    { label:'Production', done: hasProd    },
    { label:'KPIs',       done: hasKPIs    },
    { label:'Daily Log',  done: hasLog     },
    { label:'Financials', done: hasFinance },
    { label:'People',     done: hasPeople  },
  ]
  const allDone = chips.every(c => c.done)

  async function handleGenerateSummary() {
    setGenerating(true); setGenError(null); setGenSuccess(false)
    try {
      const wk = format(weekStart, 'yyyy-MM-dd')
      const [{ data: allWeeks }, { data: prodHistory }, { data: finHistory }] = await Promise.all([
        supabase.from('weeks').select('week_start,kpis,days,concerns').order('week_start',{ascending:false}).limit(13),
        supabase.from('production').select('week_start,nj_data,bny_data').order('week_start',{ascending:false}).limit(13),
        supabase.from('financial_uploads').select('period,bu,cogs,opex,inv_purchases').order('period',{ascending:false}).limit(8),
      ])

      const thisProd = prodHistory?.find(p => p.week_start === wk)
      const njD = thisProd?.nj_data || {}, bnyD = thisProd?.bny_data || {}

      // Produced yds
      const njYds  = ['fabric','grass','paper'].reduce((s,c)=>s+(parseFloat(njD[c]?.yards)||0),0)
      const bnyYds = ['replen','mto','hos','memo','contract'].reduce((s,c)=>s+(parseFloat(bnyD[c])||0),0)
      const totalYds = njYds + bnyYds
      const njPct  = Math.round(njYds/8610*100)
      const bnyPct = Math.round(bnyYds/12000*100)
      const totalPct = Math.round(totalYds/20610*100)

      // Invoiced yds
      const njInvYds  = ['fabric','grass','paper'].reduce((s,c)=>s+(parseFloat(njD[c]?.invoiceYds)||0),0)
      const njInvRev  = ['fabric','grass','paper'].reduce((s,c)=>s+(parseFloat(njD[c]?.invoiceRev)||0),0)
      const bnyInvYds = ['invYdsReplen','invYdsMto','invYdsHos','invYdsMemo','invYdsContract'].reduce((s,c)=>s+(parseFloat(bnyD[c])||0),0)
      const bnyInvRev = ['incomeReplen','incomeMto','incomeHos','incomeMemo','incomeContract'].reduce((s,c)=>s+(parseFloat(bnyD[c])||0),0)

      // MTD
      const SL = {green:'On Track',amber:'Watch',red:'Concern',gray:'Pending'}
      const monthKey = wk.slice(0,7)
      const mtdWeeks = prodHistory?.filter(p=>p.week_start?.startsWith(monthKey))||[]
      const mtdTotal = mtdWeeks.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+(parseFloat(p.nj_data?.[c]?.yards)||0),0)+['replen','mto','hos','memo','contract'].reduce((ss,c)=>ss+(parseFloat(p.bny_data?.[c])||0),0),0)
      const mtdPct = mtdWeeks.length>0 ? Math.round(mtdTotal/(20610*mtdWeeks.length)*100) : 0

      // Detect if this is the last week of the month (week 4 or 5)
      const fiscalInfo = weekData ? null : null
      const isMonthEnd = mtdWeeks.length >= 4

      const kpiLines = Object.entries(kpis).filter(([,v])=>v?.status&&v.status!=='gray').map(([id,v])=>`  ${id}: ${SL[v.status]}${v.notes?' — '+v.notes:''}`).join('\n')
      const logLines = Object.entries(days).filter(([,v])=>v?.text?.trim()).map(([day,v])=>`  ${day}: ${v.text.slice(0,200)}`).join('\n')
      const finLines = finHistory?.slice(0,4).map(f=>`  ${f.period} ${f.bu}: COGS $${(f.cogs||0).toLocaleString()} · OpEx $${(f.opex||0).toLocaleString()} · Inv $${(f.inv_purchases||0).toLocaleString()}`).join('\n')||'  No financial data'

      const monthRecapInstruction = isMonthEnd ? `
IMPORTANT: This is Week ${mtdWeeks.length} of the month — the final weekly report before month close. Paragraph 1 should be a MONTHLY RECAP covering the full month's performance, not just this week. Reference MTD totals prominently and assess whether we hit the monthly budget. The tone should be conclusive — how did the month go overall?` : ''

      const prompt = `You are helping Peter Webster, President of Paramount Prints (specialty printing division of F. Schumacher & Co), write a weekly executive summary for CEO Timur and Chief of Staff Emily.

Two facilities: Brooklyn BNY (digital printing) and Passaic NJ (screen print: fabric, grass cloth, wallpaper). ~$10M/year revenue.
${monthRecapInstruction}
WEEK OF: ${format(weekStart,'MMMM d, yyyy')} (Week ${mtdWeeks.length} of month)

PRODUCTION THIS WEEK:
  BNY Brooklyn: ${bnyYds.toLocaleString()} yds produced of 12,000 target (${bnyPct}%)${bnyInvYds>0?' · '+bnyInvYds.toLocaleString()+' yds invoiced'+(bnyInvRev>0?' · $'+Math.round(bnyInvRev).toLocaleString()+' revenue':''):''}
  NJ Passaic: ${njYds.toLocaleString()} yds produced of 8,610 target (${njPct}%)${njInvYds>0?' · '+njInvYds.toLocaleString()+' yds invoiced'+(njInvRev>0?' · $'+Math.round(njInvRev).toLocaleString()+' revenue':''):''}
  Combined: ${totalYds.toLocaleString()} yds produced of 20,610 target (${totalPct}%)

MTD PRODUCTION (${mtdWeeks.length} weeks this month): ${mtdTotal.toLocaleString()} yds · ${mtdPct}% of budget

KPI SCORECARD:
${kpiLines||'  No KPI data entered this week'}

DAILY LOG:
${logLines||'  No log entries'}

RECENT FINANCIALS:
${finLines}

${weekData?.concerns?'AREAS OF CONCERN:\n  '+weekData.concerns:''}

Write exactly 4 paragraphs in Peter's voice — direct, factual, candid. Follow this structure:

Paragraph 1 — ${isMonthEnd?'MONTHLY RECAP: Assess the full month vs budget. How did we finish? Key themes.':'OVERALL: Combined week result vs target and MTD tracking in 1-2 sentences.'}

Paragraph 2 — BNY BROOKLYN: Performance vs 12,000 yd target. Reference produced vs invoiced if available. Key KPI highlights for BNY. What's working and what to watch.

Paragraph 3 — PASSAIC NJ: Performance vs 8,610 yd target. Reference produced vs invoiced if available. Key KPI highlights for Passaic. What's working and what to watch.

Paragraph 4 — NEXT WEEK / ACTION PLAN: Specific actions Peter is taking. What Timur and Emily should watch for next week. Concrete and forward-looking.

Under 260 words. First person as Peter. No bullets. No headers. No title. Start directly with the first sentence.`

      // Set draft for review — don't save yet
      setDraftNarrative(prompt ? await generateText(prompt) : '')
    } catch(e) { setGenError('Generation failed. Check connection.') }
    setGenerating(false)
  }

  async function generateText(prompt) {
    const resp = await fetch('/api/claude',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1200,messages:[{role:'user',content:prompt}]})})
    const data = await resp.json()
    return data.content?.find(c=>c.type==='text')?.text?.trim() || ''
  }

  async function generatePDFClientSide(data) {
    // Load jsPDF dynamically from CDN
    if (!window.jspdf) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
        script.onload = resolve
        script.onerror = reject
        document.head.appendChild(script)
      })
    }

    const { jsPDF } = window.jspdf
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const PW = 612 - 86, L = 43, MID = L + PW / 2
    const PAGE_H = 792, BOTTOM_MARGIN = 50
    const checkPage = (currentY, needed = 60) => {
      if (currentY + needed > PAGE_H - BOTTOM_MARGIN) {
        doc.addPage()
        return 50
      }
      return currentY
    }

    const INK = '#2C2420', GOLD = '#D4A843', BORDER = '#DDD4C8'
    const INK_LIGHT = '#9C8F87', CREAM_DK = '#F2EDE4'
    const GREEN = '#15803d', AMBER = '#b45309', RED = '#b91c1c'

    const pctColor = p => p == null ? INK_LIGHT : p >= 95 ? GREEN : p >= 80 ? AMBER : RED

    const setFont = (size, color, bold = false) => {
      doc.setFontSize(size)
      doc.setTextColor(color)
      doc.setFont('helvetica', bold ? 'bold' : 'normal')
    }

    const hline = (y, color, w = 0.5) => {
      doc.setDrawColor(color)
      doc.setLineWidth(w)
      doc.line(L, y, L + PW, y)
    }

    // ── HEADER ──────────────────────────────────────────────────────────────
    // Split title into month label + report type
    const titleParts = data.report_title.split(' — ')
    const titleMonth = titleParts[0] || data.report_title
    const titleType  = titleParts[1] || ''

    setFont(7, INK_LIGHT); doc.setCharSpace(1.5)
    doc.text('PARAMOUNT PRINTS', L, 44); doc.setCharSpace(0)
    setFont(11, INK_LIGHT, false); doc.text(titleMonth.toUpperCase(), L, 56)
    setFont(20, INK, true); doc.text(titleType || titleMonth, L, 72)
    setFont(9, INK_LIGHT)
    doc.text(data.period_label, L, 84)
    doc.text(data.date_generated, L + PW, 84, { align: 'right' })
    doc.setDrawColor(GOLD); doc.setLineWidth(2); doc.line(L, 92, L + PW, 92)

    // ── NARRATIVE ────────────────────────────────────────────────────────────
    let y = 100
    setFont(7, INK_LIGHT); doc.setCharSpace(1.5)
    doc.text('EXECUTIVE SUMMARY', L, y); doc.setCharSpace(0)
    y += 10

    const paras = data.narrative.split('\n\n').filter(p => p.trim())
    paras.forEach(para => {
      setFont(9, INK)
      const lines = doc.splitTextToSize(para.trim(), PW)
      doc.text(lines, L, y)
      y += lines.length * 12 + 3
    })

    y += 4
    hline(y, BORDER); y += 7

    // ── PRODUCTION ───────────────────────────────────────────────────────────
    const bny = data.bny, nj = data.nj
    const colW = PW / 2 - 16
    const INK_DARK = '#3D3530'
    const ROW_H = 44

    setFont(7, INK_LIGHT); doc.setCharSpace(1.5)
    doc.text('PRODUCTION — MONTH-TO-DATE', L, y); doc.setCharSpace(0)
    y += 12

    setFont(9, INK, true)
    doc.text('BNY — BROOKLYN DIGITAL', L, y)
    doc.text('NJ — PASSAIC SCREEN PRINT', MID + 8, y)
    y += 14

    const metricRows = [
      { bny: { label:'PRODUCED',     val:bny.prod_yds, sub:`${bny.prod_pct != null ? bny.prod_pct+'%' : '—'} of ${bny.prod_tgt} target`, subColor:pctColor(bny.prod_pct) },
        nj:  { label:'PRODUCED',     val:nj.prod_yds,  sub:`${nj.prod_pct  != null ? nj.prod_pct+'%'  : '—'} of ${nj.prod_tgt} target`,  subColor:pctColor(nj.prod_pct)  } },
      { bny: { label:'INVOICED YDS', val:bny.inv_yds,  sub:`Revenue: ${bny.inv_rev||'—'}`, subColor:INK_LIGHT },
        nj:  { label:'INVOICED YDS', val:nj.inv_yds,   sub:`Revenue: ${nj.inv_rev||'—'}${nj.misc_fees?' · Misc: '+nj.misc_fees:''}`, subColor:INK_LIGHT } },
      { bny: { label:'OPEX MTD',     val:bny.opex,     sub:`Inv Purchases: ${bny.inv_purch||'—'}`, subColor:INK_LIGHT },
        nj:  { label:'OPEX MTD',     val:nj.opex,      sub:`Waste: ${nj.waste_pct||'—'} · Inv: ${nj.inv_purch||'—'}`, subColor:INK_LIGHT } },
    ]

    const ROW_PAD = 8  // top padding inside each row before the label
    metricRows.forEach((row, i) => {
      const rowY = y + ROW_PAD
      ;[{d:row.bny, x:L}, {d:row.nj, x:MID+8}].forEach(({d, x}) => {
        setFont(6.5, INK_LIGHT); doc.setCharSpace(0.8); doc.text(d.label, x, rowY); doc.setCharSpace(0)
        setFont(12, INK_DARK, false); doc.text(d.val||'—', x, rowY+13)
        setFont(7.5, d.subColor||INK_LIGHT)
        doc.text(doc.splitTextToSize(d.sub, colW), x, rowY+25)
      })
      doc.setDrawColor(BORDER); doc.setLineWidth(0.4)
      doc.line(MID, y, MID, y+ROW_H)
      if (i < metricRows.length - 1) {
        doc.setDrawColor(CREAM_DK); doc.setLineWidth(0.3)
        doc.line(L, y+ROW_H, L+PW, y+ROW_H)
      }
      y += ROW_H
    })

    // ── PRODUCTION SUMMARY TABLE ─────────────────────────────────────────────
    y += 4
    hline(y, BORDER); y += 8
    setFont(7, INK_LIGHT); doc.setCharSpace(1.5)
    doc.text('PRODUCTION SUMMARY — MTD TRACKING', L, y); doc.setCharSpace(0)
    y += 11

    const fin = data.financials
    const cw = PW / 4
    const FIN_ROW_H = 16

    const pctColorStr = p => p == null ? INK_LIGHT : p >= 95 ? GREEN : p >= 80 ? AMBER : RED

    const summaryHeaders = ['METRIC', 'PARAMOUNT NJ', 'BNY BROOKLYN', 'COMBINED']
    const summaryRows = [
      { cells: ['Produced MTD',  nj.prod_yds,  bny.prod_yds,  fin.combined_prod_yds] },
      { cells: ['vs Target',
          `${nj.prod_pct}% of ${nj.prod_tgt}`,
          `${bny.prod_pct}% of ${bny.prod_tgt}`,
          `${fin.combined_prod_pct}% of ${fin.combined_prod_tgt}`],
        pcts: [nj.prod_pct, bny.prod_pct, fin.combined_prod_pct] },
      { cells: ['Invoiced YDS',  nj.inv_yds,   bny.inv_yds,   fin.combined_inv_yds] },
      { cells: ['Revenue MTD',   fin.rev_nj,   fin.rev_bny,   fin.rev_combined], bold: true },
      { cells: ['OpEx MTD',      nj.opex,      bny.opex,      fin.opex_combined] },
      { cells: ['NJ Waste %',    nj.waste_pct, '—',           '—'] },
    ]

    doc.setFillColor(INK); doc.rect(L, y, PW, FIN_ROW_H, 'F')
    setFont(7, '#ffffff', true)
    summaryHeaders.forEach((h, i) => doc.text(h, L + i*cw + 6, y + 11))
    y += FIN_ROW_H

    summaryRows.forEach((row, ri) => {
      if (ri%2===1) { doc.setFillColor(CREAM_DK); doc.rect(L, y, PW, FIN_ROW_H, 'F') }
      row.cells.forEach((cell, ci) => {
        let color = ci === 0 ? INK_LIGHT : INK
        if (row.pcts && ci > 0) color = pctColorStr(row.pcts[ci-1])
        setFont(7.5, color, ci === 3 || row.bold)
        doc.text(cell||'—', L + ci*cw + 6, y + 11)
      })
      hline(y + FIN_ROW_H, BORDER, 0.3)
      y += FIN_ROW_H
    })

    // ── PEOPLE + WIP ─────────────────────────────────────────────────────────
    y += 6
    hline(y, BORDER); y += 7
    const ppl = data.people, wip = data.wip
    setFont(7, INK_LIGHT); doc.setCharSpace(1.5)
    doc.text('PEOPLE', L, y)
    doc.text('WIP SNAPSHOT', MID+6, y); doc.setCharSpace(0)
    y += 10

    setFont(8, INK)
    doc.text(`Headcount: ${ppl.headcount||'—'}`, L, y)

    doc.setDrawColor(BORDER); doc.setLineWidth(0.5); doc.line(MID, y-8, MID, y+26)

    setFont(8, INK)
    doc.text(`Active: ${wip.orders||'—'} orders · ${wip.yards||'—'} yds`, MID+6, y)
    setFont(7.5, INK_LIGHT)
    doc.text(`Age: 0-30d ${wip.age_0_30||'—'} · 31-60d ${wip.age_31_60||'—'} · 61-90d ${wip.age_61_90||'—'} · 90d+ ${wip.age_90plus||'—'}`, MID+6, y+12)
    doc.text(`Wallpaper ${wip.wallpaper||'—'} · Grasscloth ${wip.grasscloth||'—'} · Fabric ${wip.fabric||'—'}`, MID+6, y+22)

    // ── FOOTER ───────────────────────────────────────────────────────────────
    const footerY = PAGE_H - 28
    hline(footerY, BORDER, 0.5)
    setFont(7.5, INK_LIGHT)
    doc.text(`Paramount Prints · F. Schumacher & Co. · ${data.report_title} · Confidential`, L + PW/2, footerY + 10, { align: 'center' })

    doc.save(data.filename || 'paramount-report.pdf')
  }

  async function saveOnePager() {
    if (!onePagerDraft || !onePagerType) return
    try {
      const monthKey = format(weekStart, 'yyyy-MM')
      await supabase.from('monthly_reports').upsert({
        month: monthKey,
        type: onePagerType,
        report_title: onePagerPayload?.report_title || `${format(weekStart,'MMMM yyyy')} — ${onePagerType==='mid'?'Mid-Month Brief':'Month-End Report'}`,
        narrative: onePagerDraft,
        generated_at: new Date().toISOString(),
        generated_by: 'peter',
      }, { onConflict: 'month,type' })
      setOnePagerSaved(true)
      setTimeout(() => setOnePagerSaved(false), 3000)
      // Refresh saved reports indicator
      setSavedReports(prev => ({ ...prev, [onePagerType]: { type: onePagerType, generated_at: new Date().toISOString(), narrative: onePagerDraft } }))
    } catch(e) { setOnePagerError('Save failed: '+e.message) }
  }

  async function downloadPDF() {
    if (!onePagerDraft) return
    setPdfGenerating(true)
    try {
      // Build payload — use stored one or create minimal version from current state
      const monthLabel = format(weekStart, 'MMMM yyyy')
      const isMid = onePagerType === 'mid'
      const basePayload = onePagerPayload || {
        report_title: `${monthLabel} — ${isMid?'Mid-Month Brief':'Month-End Report'}`,
        period_label: `${monthLabel} · Fiscal Q${Math.ceil(parseInt(format(weekStart,'MM'))/3)}`,
        date_generated: format(new Date(), 'MMMM d, yyyy'),
        filename: `Paramount_${monthLabel.replace(' ','_')}_${isMid?'MidMonth':'MonthEnd'}.pdf`,
        bny: { prod_yds:'—', prod_tgt:'—', prod_pct:null, inv_yds:'—', inv_rev:'—', opex:'—', inv_purch:'—', prod_yds_raw:0, prod_tgt_raw:0 },
        nj:  { prod_yds:'—', prod_tgt:'—', prod_pct:null, inv_yds:'—', inv_rev:'—', opex:'—', inv_purch:'—', waste_pct:'—', prod_yds_raw:0, prod_tgt_raw:0 },
        financials: { opex_combined:'—', inv_combined:'—', rev_nj:'—', rev_bny:'—', rev_combined:'—', combined_prod_yds:'—', combined_prod_tgt:'—', combined_prod_pct:null, combined_inv_yds:'—' },
        people: { headcount:'—', payroll:'—', ot:'—', hr_notes:'' },
        wip: { orders:'—', yards:'—', age_0_30:'—', age_31_60:'—', age_61_90:'—', age_90plus:'—', wallpaper:'—', grasscloth:'—', fabric:'—' },
      }
      const payload = { ...basePayload, narrative: onePagerDraft }
      await generatePDFClientSide(payload)
      // Save to Supabase
      await supabase.from('monthly_reports').upsert({
        month: format(weekStart, 'yyyy-MM'),
        type: onePagerType,
        report_title: payload.report_title,
        narrative: onePagerDraft,
        generated_at: new Date().toISOString(),
        generated_by: 'peter',
      }, { onConflict: 'month,type' })
    } catch(e) { setOnePagerError('PDF failed: '+e.message) }
    setPdfGenerating(false)
  }

  async function regenerateOnePager() {
    if (!onePagerType) return
    const monthKey = format(weekStart, 'yyyy-MM')
    await supabase.from('monthly_reports').delete().eq('month', monthKey).eq('type', onePagerType)
    setSavedReports(prev => { const n = {...prev}; delete n[onePagerType]; return n })
    setIsSavedReport(false)
    generateOnePager(onePagerType)
  }

  async function generateOnePager(type) {
    setOnePagerLoading(true); setOnePagerError(null); setOnePagerDraft(''); setOnePagerType(type); setOnePagerSaved(false); setIsSavedReport(false)
    try {
      const monthKey   = format(weekStart, 'yyyy-MM')

      // Check if a saved report already exists for this month/type
      const { data: existingReport } = await supabase
        .from('monthly_reports')
        .select('narrative, report_title')
        .eq('month', monthKey)
        .eq('type', type)
        .single()

      if (existingReport?.narrative) {
        // Load saved narrative — but still fetch real data for PDF numbers
        setIsSavedReport(true)
        setOnePagerDraft(existingReport.narrative)
        const monthLabel = format(weekStart, 'MMMM yyyy')
        const monthStart = monthKey + '-01'
        const monthEnd   = monthKey + '-31'
        const isMid = type === 'mid'

        const [{ data: prodRows }, { data: finRows }, { data: apRows }, { data: arRows },
               { data: peopleRows }, { data: wipSnap }] = await Promise.all([
          supabase.from('production').select('*').gte('week_start', monthStart).lte('week_start', monthEnd).order('week_start'),
          supabase.from('financials_monthly').select('*').gte('period', monthKey+'-W1').lte('period', monthKey+'-W5'),
          supabase.from('financial_ap').select('*').gte('period', monthKey+'-W1').lte('period', monthKey+'-W5'),
          supabase.from('financial_ar').select('*').gte('period', monthKey+'-W1').lte('period', monthKey+'-W5').order('uploaded_at',{ascending:false}).limit(1),
          supabase.from('people_weekly').select('*').gte('week_start', monthStart).lte('week_start', monthEnd).order('week_start',{ascending:false}).limit(1),
          supabase.from('wip_snapshots').select('*').gte('week_start', monthStart).lte('week_start', monthEnd).order('week_start',{ascending:false}).limit(1),
        ])

        const n = v => parseFloat(v)||0
        const fmtD = v => v ? '$'+Math.round(v).toLocaleString() : '—'
        const fmtY = v => v ? v.toLocaleString()+' yds' : '—'
        const pct  = (a,b) => b>0 ? Math.round(a/b*100) : null
        const weeks = prodRows?.length || 0

        const njYds     = prodRows?.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+n(p.nj_data?.[c]?.yards),0),0)||0
        const bnyYds    = prodRows?.reduce((s,p)=>s+['replen','mto','hos','memo','contract'].reduce((ss,c)=>ss+n(p.bny_data?.[c]),0),0)||0
        const njTgt=8610*weeks, bnyTgt=12000*weeks
        const njInvYds  = prodRows?.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+n(p.nj_data?.[c]?.invoiceYds),0),0)||0
        const njInvRev  = prodRows?.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+n(p.nj_data?.[c]?.invoiceRev),0),0)||0
        const njMisc    = prodRows?.reduce((s,p)=>s+n(p.nj_data?.miscFees),0)||0
        const bnyInvYds = prodRows?.reduce((s,p)=>s+['invYdsReplen','invYdsMto','invYdsHos','invYdsMemo','invYdsContract'].reduce((ss,c)=>ss+n(p.bny_data?.[c]),0),0)||0
        const bnyInvRev = prodRows?.reduce((s,p)=>s+['incomeReplen','incomeMto','incomeHos','incomeMemo','incomeContract'].reduce((ss,c)=>ss+n(p.bny_data?.[c]),0),0)||0
        const bnyMisc   = prodRows?.reduce((s,p)=>s+n(p.bny_data?.miscFees),0)||0
        const njWaste   = prodRows?.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+n(p.nj_data?.[c]?.waste),0),0)||0
        const njWastePct = njYds>0 ? (njWaste/njYds*100).toFixed(1)+'%' : '—'
        const opexNJ  = finRows?.filter(r=>r.business_unit==='610').reduce((s,r)=>s+n(r.opex_total),0)||0
        const opexBNY = finRows?.filter(r=>r.business_unit==='609').reduce((s,r)=>s+n(r.opex_total),0)||0
        const invNJ   = finRows?.filter(r=>r.business_unit==='610').reduce((s,r)=>s+n(r.inv_purchases),0)||0
        const invBNY  = finRows?.filter(r=>r.business_unit==='609').reduce((s,r)=>s+n(r.inv_purchases),0)||0
        const apPara  = apRows?.find(r=>r.facility==='Paramount')
        const apBNY   = apRows?.find(r=>r.facility==='BNY')
        const arData  = arRows?.[0]
        const ppl     = peopleRows?.[0]
        const wip     = wipSnap?.[0]

        setOnePagerPayload({
          report_title: existingReport.report_title || `${monthLabel} — ${isMid?'Mid-Month Brief':'Month-End Report'}`,
          period_label: `${monthLabel} · ${weeks} week${weeks!==1?'s':''} · Fiscal Q${Math.ceil(parseInt(monthKey.split('-')[1])/3)}`,
          date_generated: format(new Date(), 'MMMM d, yyyy'),
          filename: `Paramount_${monthLabel.replace(' ','_')}_${isMid?'MidMonth':'MonthEnd'}.pdf`,
          bny: {
            prod_yds: fmtY(bnyYds), prod_tgt: bnyTgt.toLocaleString(), prod_pct: pct(bnyYds,bnyTgt),
            inv_yds: fmtY(bnyInvYds), inv_rev: fmtD(bnyInvRev+bnyMisc),
            opex: fmtD(opexBNY), inv_purch: fmtD(invBNY),
            prod_yds_raw: bnyYds, prod_tgt_raw: bnyTgt,
          },
          nj: {
            prod_yds: fmtY(njYds), prod_tgt: njTgt.toLocaleString(), prod_pct: pct(njYds,njTgt),
            inv_yds: fmtY(njInvYds), inv_rev: fmtD(njInvRev+njMisc), misc_fees: njMisc>0?fmtD(njMisc):null,
            opex: fmtD(opexNJ), inv_purch: fmtD(invNJ), waste_pct: njWastePct,
            prod_yds_raw: njYds, prod_tgt_raw: njTgt,
          },
          financials: {
            opex_combined: fmtD(opexNJ+opexBNY), inv_combined: fmtD(invNJ+invBNY),
            rev_nj: fmtD(njInvRev+njMisc), rev_bny: fmtD(bnyInvRev+bnyMisc),
            rev_combined: fmtD(njInvRev+njMisc+bnyInvRev+bnyMisc),
            combined_prod_yds: fmtY(njYds+bnyYds), combined_prod_tgt: (njTgt+bnyTgt).toLocaleString(),
            combined_prod_pct: pct(njYds+bnyYds, njTgt+bnyTgt),
            combined_inv_yds: fmtY(njInvYds+bnyInvYds),
          },
          people: {
            headcount: ppl ? `${n(ppl.bny_headcount)+n(ppl.nj_headcount)} total (${n(ppl.bny_headcount)} BNY · ${n(ppl.nj_headcount)} NJ)` : '—',
            payroll: ppl ? fmtD(n(ppl.bny_total_pay)+n(ppl.nj_total_pay)) : '—',
            ot: ppl ? (n(ppl.bny_ot_hrs)+n(ppl.nj_ot_hrs)).toFixed(1)+' hrs' : '—',
            hr_notes: ppl?.hr_notes || '',
          },
          wip: wip ? {
            orders: wip.wip_orders, yards: Math.round(wip.wip_yards).toLocaleString(),
            age_0_30: wip.age_0_30_orders, age_31_60: wip.age_31_60_orders,
            age_61_90: wip.age_61_90_orders, age_90plus: wip.age_90plus_orders,
            wallpaper: wip.wallpaper_orders, grasscloth: wip.grasscloth_orders, fabric: wip.fabric_orders,
          } : {},
        })
        setOnePagerLoading(false)
        return
      }
      const monthLabel = format(weekStart, 'MMMM yyyy')
      const monthStart = monthKey + '-01'
      const monthEnd   = monthKey + '-31'

      const [{ data: prodRows }, { data: finRows }, { data: apRows }, { data: arRows },
             { data: peopleRows }, { data: weekRows }, { data: wipSnap }] = await Promise.all([
        supabase.from('production').select('*').gte('week_start', monthStart).lte('week_start', monthEnd).order('week_start'),
        supabase.from('financials_monthly').select('*').gte('period', monthKey+'-W1').lte('period', monthKey+'-W5'),
        supabase.from('financial_ap').select('*').gte('period', monthKey+'-W1').lte('period', monthKey+'-W5'),
        supabase.from('financial_ar').select('*').gte('period', monthKey+'-W1').lte('period', monthKey+'-W5').order('uploaded_at',{ascending:false}).limit(1),
        supabase.from('people_weekly').select('*').gte('week_start', monthStart).lte('week_start', monthEnd).order('week_start',{ascending:false}).limit(1),
        supabase.from('weeks').select('*').gte('week_start', monthStart).lte('week_start', monthEnd).order('week_start'),
        supabase.from('wip_snapshots').select('*').gte('week_start', monthStart).lte('week_start', monthEnd).order('week_start',{ascending:false}).limit(1),
      ])

      const n = v => parseFloat(v)||0
      const fmtD = v => v ? '$'+Math.round(v).toLocaleString() : '—'
      const fmtY = v => v ? v.toLocaleString()+' yds' : '—'
      const pct  = (a,b) => b>0 ? Math.round(a/b*100) : null

      const weeks = prodRows?.length || 0
      const njYds  = prodRows?.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+n(p.nj_data?.[c]?.yards),0),0)||0
      const bnyYds = prodRows?.reduce((s,p)=>s+['replen','mto','hos','memo','contract'].reduce((ss,c)=>ss+n(p.bny_data?.[c]),0),0)||0
      const njTgt=8610*weeks, bnyTgt=12000*weeks
      const njInvYds  = prodRows?.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+n(p.nj_data?.[c]?.invoiceYds),0),0)||0
      const njInvRev  = prodRows?.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+n(p.nj_data?.[c]?.invoiceRev),0),0)||0
      const njMisc    = prodRows?.reduce((s,p)=>s+n(p.nj_data?.miscFees),0)||0
      const bnyInvYds = prodRows?.reduce((s,p)=>s+['invYdsReplen','invYdsMto','invYdsHos','invYdsMemo','invYdsContract'].reduce((ss,c)=>ss+n(p.bny_data?.[c]),0),0)||0
      const bnyInvRev = prodRows?.reduce((s,p)=>s+['incomeReplen','incomeMto','incomeHos','incomeMemo','incomeContract'].reduce((ss,c)=>ss+n(p.bny_data?.[c]),0),0)||0
      const bnyMisc   = prodRows?.reduce((s,p)=>s+n(p.bny_data?.miscFees),0)||0
      const njWaste   = prodRows?.reduce((s,p)=>s+['fabric','grass','paper'].reduce((ss,c)=>ss+n(p.nj_data?.[c]?.waste),0),0)||0
      const njWastePct = njYds>0 ? (njWaste/njYds*100).toFixed(1)+'%' : '—'

      const opexNJ  = finRows?.filter(r=>r.business_unit==='610').reduce((s,r)=>s+n(r.opex_total),0)||0
      const opexBNY = finRows?.filter(r=>r.business_unit==='609').reduce((s,r)=>s+n(r.opex_total),0)||0
      const invNJ   = finRows?.filter(r=>r.business_unit==='610').reduce((s,r)=>s+n(r.inv_purchases),0)||0
      const invBNY  = finRows?.filter(r=>r.business_unit==='609').reduce((s,r)=>s+n(r.inv_purchases),0)||0
      const apPara  = apRows?.find(r=>r.facility==='Paramount')
      const apBNY   = apRows?.find(r=>r.facility==='BNY')
      const arData  = arRows?.[0]
      const ppl     = peopleRows?.[0]
      const wip     = wipSnap?.[0]

      const SL = {green:'On Track',amber:'Watch',red:'Concern',gray:'Pending'}
      const allKpis = {}
      weekRows?.forEach(w=>Object.entries(w.kpis||{}).forEach(([k,v])=>{ if(v?.status&&v.status!=='gray') allKpis[k]=v }))
      const kpiLines = Object.entries(allKpis).map(([k,v])=>`${k}: ${SL[v.status]}${v.notes?' ('+v.notes+')':''}`).join(', ')
      const concerns = weekRows?.map(w=>w.concerns).filter(Boolean).join(' | ')

      const isMid = type === 'mid'

      // Generate narrative via Claude
      const prompt = `You are helping Peter Webster, President of Paramount Prints (specialty printing division of F. Schumacher & Co), write a ${isMid?'mid-month':'month-end'} update for fellow BU leaders and the executive team. Tone: direct, candid, peer-to-peer — like a sharp Slack message from a BU head. First person as Peter. No headers. No bullets.

PERIOD: ${monthLabel} — ${weeks} weeks${isMid?' MTD':' (full month close)'}

PRODUCTION:
BNY Brooklyn: ${bnyYds.toLocaleString()} yds produced / ${bnyTgt.toLocaleString()} target (${pct(bnyYds,bnyTgt)}%) · Invoiced ${fmtY(bnyInvYds)} · ${fmtD(bnyInvRev+bnyMisc)} revenue
NJ Passaic: ${njYds.toLocaleString()} yds produced / ${njTgt.toLocaleString()} target (${pct(njYds,njTgt)}%) · Invoiced ${fmtY(njInvYds)} · ${fmtD(njInvRev+njMisc)} revenue · Waste ${njWastePct}
Combined: ${(njYds+bnyYds).toLocaleString()} yds / ${(njTgt+bnyTgt).toLocaleString()} target (${pct(njYds+bnyYds,njTgt+bnyTgt)}%)

FINANCIALS: OpEx NJ ${fmtD(opexNJ)} · BNY ${fmtD(opexBNY)} · Combined ${fmtD(opexNJ+opexBNY)}
Inv purchases NJ ${fmtD(invNJ)} · BNY ${fmtD(invBNY)}
AP past due: Paramount ${fmtD(n(apPara?.past_due))} · BNY ${fmtD(n(apBNY?.past_due))}
AR outstanding ${fmtD(n(arData?.total_outstanding))} · past due ${fmtD(n(arData?.total_past_due))}

PEOPLE: ${ppl?(n(ppl.bny_headcount)+n(ppl.nj_headcount))+' total headcount · payroll '+fmtD(n(ppl.bny_total_pay)+n(ppl.nj_total_pay)):'No people data'}
WIP: ${wip?wip.wip_orders+' active orders · '+Math.round(wip.wip_yards).toLocaleString()+' yds · 90d+ '+wip.age_90plus_orders+' orders':'No WIP snapshot'}
${kpiLines?'KPIs: '+kpiLines:''}
${concerns?'Concerns: '+concerns:''}

Write exactly 4 paragraphs:
1. ONE sentence — combined ${isMid?'MTD tracking':'month close'} headline
2. BNY Brooklyn — 3-4 sentences: production vs target, invoiced revenue, what drove it, anything to flag
3. Passaic NJ — 3-4 sentences: production vs target, invoiced, waste, what's working/not
4. ${isMid?'Forward look — what to watch for close of month':'Close — AP/AR/OpEx callout, Q2 outlook, momentum'}`

      const resp = await fetch('/api/claude', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:900, messages:[{role:'user',content:prompt}] })
      })
      const aiData = await resp.json()
      const narrative = aiData.content?.find(c=>c.type==='text')?.text?.trim() || ''

      if (!narrative) { setOnePagerError('Could not generate narrative — try again.'); setOnePagerLoading(false); return }
      setOnePagerDraft(narrative)

      // Build PDF payload
      const pdfPayload = {
        report_title: `${monthLabel} — ${isMid?'Mid-Month Brief':'Month-End Report'}`,
        period_label: `${monthLabel} · ${weeks} week${weeks!==1?'s':''} · Fiscal Q${Math.ceil(parseInt(monthKey.split('-')[1])/3)}`,
        date_generated: format(new Date(), 'MMMM d, yyyy'),
        filename: `Paramount_${monthLabel.replace(' ','_')}_${isMid?'MidMonth':'MonthEnd'}.pdf`,
        narrative,
        bny: {
          prod_yds: fmtY(bnyYds), prod_tgt: bnyTgt.toLocaleString(), prod_pct: pct(bnyYds,bnyTgt),
          inv_yds: fmtY(bnyInvYds), inv_rev: fmtD(bnyInvRev+bnyMisc),
          opex: fmtD(opexBNY), inv_purch: fmtD(invBNY),
          prod_yds_raw: bnyYds, prod_tgt_raw: bnyTgt,
        },
        nj: {
          prod_yds: fmtY(njYds), prod_tgt: njTgt.toLocaleString(), prod_pct: pct(njYds,njTgt),
          inv_yds: fmtY(njInvYds), inv_rev: fmtD(njInvRev+njMisc), misc_fees: njMisc>0?fmtD(njMisc):null,
          opex: fmtD(opexNJ), inv_purch: fmtD(invNJ), waste_pct: njWastePct,
          prod_yds_raw: njYds, prod_tgt_raw: njTgt,
        },
        financials: {
          opex_combined: fmtD(opexNJ+opexBNY), inv_combined: fmtD(invNJ+invBNY),
          rev_nj: fmtD(njInvRev+njMisc), rev_bny: fmtD(bnyInvRev+bnyMisc),
          rev_combined: fmtD(njInvRev+njMisc+bnyInvRev+bnyMisc),
          combined_prod_yds: fmtY(njYds+bnyYds), combined_prod_tgt: (njTgt+bnyTgt).toLocaleString(),
          combined_prod_pct: pct(njYds+bnyYds, njTgt+bnyTgt),
          combined_inv_yds: fmtY(njInvYds+bnyInvYds),
        },
        people: {
          headcount: ppl ? `${n(ppl.bny_headcount)+n(ppl.nj_headcount)} total (${n(ppl.bny_headcount)} BNY · ${n(ppl.nj_headcount)} NJ)` : '—',
          payroll: ppl ? fmtD(n(ppl.bny_total_pay)+n(ppl.nj_total_pay)) : '—',
          ot: ppl ? (n(ppl.bny_ot_hrs)+n(ppl.nj_ot_hrs)).toFixed(1)+' hrs' : '—',
          hr_notes: ppl?.hr_notes || '',
        },
        wip: wip ? {
          orders: wip.wip_orders, yards: Math.round(wip.wip_yards).toLocaleString(),
          age_0_30: wip.age_0_30_orders, age_31_60: wip.age_31_60_orders,
          age_61_90: wip.age_61_90_orders, age_90plus: wip.age_90plus_orders,
          wallpaper: wip.wallpaper_orders, grasscloth: wip.grasscloth_orders, fabric: wip.fabric_orders,
        } : {},
      }

      // Store payload for PDF generation after editing
      setOnePagerPayload(pdfPayload)

    } catch(e) { setOnePagerError('Failed: '+e.message) }
    setOnePagerLoading(false)
  }

    async function handlePublishSummary() {
    if (!draftNarrative) return
    setPublishing(true)
    try {
      await onSave({executive_narrative: draftNarrative})
      onRefresh && onRefresh()
      setGenSuccess(true)
      setTimeout(()=>setGenSuccess(false),5000)
    } catch(e) { setGenError('Publish failed.') }
    setPublishing(false)
  }

  return (
    <div style={{ maxWidth:980, margin:'0 auto', padding:'28px 24px 64px' }}>

      {/* Header */}
      <div style={{ marginBottom:24 }}>
        <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:6 }}>Admin · Data Entry</div>
        <h2 style={{ margin:0, fontFamily:'Georgia, serif', fontSize:24, color:'var(--ink)', fontWeight:700 }}>Week of {format(weekStart,'MMMM d, yyyy')}</h2>
      </div>

      {/* Generate Summary card */}
      <div style={{ background:'#FAFAF8', border:'2px solid var(--ink-10)', borderRadius:12, padding:'20px 24px', marginBottom:24, transition:'all 0.2s' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:20, flexWrap:'wrap', marginBottom: draftNarrative ? 16 : 0 }}>
          <div>
            <div style={{ fontSize:15, fontWeight:700, color:'var(--ink)', marginBottom:4, fontFamily:'Georgia, serif' }}>✦ Executive Summary</div>
            <div style={{ fontSize:12, color:'var(--ink-40)' }}>
              {draftNarrative ? 'Review and edit below, then publish to Consolidated.' : allDone ? 'All data entered — ready to generate.' : 'Fill in sections below, then generate the summary for Timur & Emily.'}
            </div>
            {genError  && <div style={{ fontSize:12, color:'#E65100', marginTop:6 }}>⚠ {genError}</div>}
            {genSuccess && <div style={{ fontSize:12, color:'#2E7D32', marginTop:6 }}>✓ Published to Consolidated</div>}
          </div>
          <div style={{ display:'flex', gap:8, flexShrink:0 }}>
            <button onClick={handleGenerateSummary} disabled={generating} style={{ background:'var(--ink)', color:'#fff', border:'none', borderRadius:8, padding:'10px 20px', fontSize:13, fontWeight:600, cursor:generating?'not-allowed':'pointer', whiteSpace:'nowrap', fontFamily:'Georgia, serif', opacity:generating?0.6:1 }}>
              {generating ? '⏳ Generating…' : draftNarrative ? '↻ Regenerate' : '✦ Generate'}
            </button>
            {draftNarrative && (
              <button onClick={handlePublishSummary} disabled={publishing} style={{ background:'#D4A843', color:'#2C2420', border:'none', borderRadius:8, padding:'10px 20px', fontSize:13, fontWeight:700, cursor:publishing?'not-allowed':'pointer', whiteSpace:'nowrap', fontFamily:'Georgia, serif' }}>
                {publishing ? 'Publishing…' : '✓ Publish to Dashboard'}
              </button>
            )}
          </div>
        </div>
        {draftNarrative && (
          <div>
            <div style={{ fontSize:11, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:8 }}>Draft — edit freely before publishing</div>
            <textarea
              value={draftNarrative}
              onChange={e => setDraftNarrative(e.target.value)}
              rows={10}
              style={{ width:'100%', fontFamily:'Georgia, serif', fontSize:14, lineHeight:1.8, padding:'16px', border:'1px solid var(--ink-20)', borderRadius:8, background:'#fff', resize:'vertical', boxSizing:'border-box', color:'var(--ink)' }}
            />
          </div>
        )}
        {weekData?.executive_narrative && !draftNarrative && (
          <div style={{ marginTop:12, padding:'12px 16px', background:'var(--cream-dark,#F5F0EA)', borderRadius:8, borderLeft:'3px solid var(--ink-20)' }}>
            <div style={{ fontSize:10, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink-40)', marginBottom:6 }}>Currently published</div>
            <div style={{ fontSize:13, color:'var(--ink-60)', lineHeight:1.7, whiteSpace:'pre-wrap' }}>{weekData.executive_narrative.slice(0,300)}{weekData.executive_narrative.length>300?'…':''}</div>
            <button onClick={()=>setDraftNarrative(weekData.executive_narrative)} style={{ marginTop:8, fontSize:12, color:'var(--ink-40)', background:'none', border:'none', cursor:'pointer', padding:0 }}>Edit current version →</button>
          </div>
        )}
      </div>

      {/* Status chips */}
      <div style={{ display:'flex', gap:8, marginBottom:28, flexWrap:'wrap' }}>
        {chips.map(c=>(
          <div key={c.label} style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:20, background:c.done?'#F0FAF4':'#F5F5F5', border:`1px solid ${c.done?'#BBE0C8':'#E0E0E0'}`, fontSize:12, fontWeight:500, color:c.done?'#2E7D32':'var(--ink-40)' }}>
            <span style={{ fontSize:11 }}>{c.done?'✓':'○'}</span>{c.label}
          </div>
        ))}
      </div>

      {/* ── One-Pager Buttons ── */}
      <div style={{ display:'flex', gap:12, marginBottom:28, flexWrap:'wrap' }}>
        {[
          { type:'mid', label:'📄 Mid-Month Brief', desc:'MTD snapshot — where we are tracking' },
          { type:'end', label:'📋 Month-End Report', desc:'Full month close — how did we finish' },
        ].map(btn => {
          const saved = savedReports[btn.type]
          const isActive = onePagerType===btn.type && onePagerDraft
          return (
            <div key={btn.type} style={{ display:'flex', flexDirection:'column', gap:0, minWidth:220 }}>
              <button onClick={()=>generateOnePager(btn.type)} disabled={onePagerLoading}
                style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:2,
                  background: isActive ? '#1f2937' : saved ? '#1f2937' : '#F5F5F5',
                  color: isActive||saved ? '#fff' : 'var(--ink)',
                  border:`1.5px solid ${isActive||saved?'#1f2937':'var(--ink-10)'}`,
                  borderRadius: saved ? '10px 10px 0 0' : 10,
                  padding:'12px 18px', cursor:onePagerLoading?'not-allowed':'pointer',
                  opacity:onePagerLoading&&onePagerType!==btn.type?0.6:1, textAlign:'left', width:'100%' }}>
                <span style={{ fontSize:14, fontWeight:700, fontFamily:'Georgia,serif' }}>
                  {onePagerLoading&&onePagerType===btn.type ? '⏳ Generating…' : btn.label}
                </span>
                <span style={{ fontSize:11, opacity:0.6 }}>{saved ? (isActive?'Editing…':'Saved — click to load/edit') : btn.desc}</span>
              </button>
              {saved && !isActive && (
                <div style={{ background:'#F0F4F0', border:'1.5px solid #1f2937', borderTop:'none', borderRadius:'0 0 10px 10px', padding:'8px 18px' }}>
                  <div style={{ fontSize:10, fontWeight:700, color:'#4a7c59', letterSpacing:'0.06em', marginBottom:3 }}>
                    ✓ SAVED · {new Date(saved.generated_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                  </div>
                  <div style={{ fontSize:11, color:'#555', lineHeight:1.5, overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' }}>
                    {saved.narrative?.slice(0,120)}…
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* One-pager draft */}
      {(onePagerDraft||onePagerError) && (
        <div style={{ marginBottom:28, border:'1px solid var(--ink-10)', borderRadius:12, overflow:'hidden' }}>
          <div style={{ background:'#1f2937', padding:'10px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
            <div style={{ fontSize:13, fontWeight:600, color:'#fff' }}>
              {onePagerType==='mid' ? '📄 Mid-Month Brief' : '📋 Month-End Report'} — {format(weekStart,'MMMM yyyy')}
            </div>
            <div style={{ display:'flex', gap:8 }}>
              {isSavedReport && (
                <button onClick={regenerateOnePager}
                  style={{ background:'rgba(255,255,255,0.1)', color:'#fff', border:'1px solid rgba(255,255,255,0.3)', borderRadius:6, padding:'5px 14px', fontSize:12, fontWeight:600, cursor:'pointer' }}>
                  ↺ Regenerate
                </button>
              )}
              <button onClick={()=>{navigator.clipboard.writeText(onePagerDraft);setOnePagerCopied(true);setTimeout(()=>setOnePagerCopied(false),3000)}}
                style={{ background:'rgba(255,255,255,0.15)', color:'#fff', border:'1px solid rgba(255,255,255,0.3)', borderRadius:6, padding:'5px 14px', fontSize:12, fontWeight:600, cursor:'pointer' }}>
                {onePagerCopied ? '✓ Copied!' : '📋 Copy'}
              </button>
              <button onClick={downloadPDF} disabled={pdfGenerating}
                style={{ background:'#D4A843', color:'#1f2937', border:'none', borderRadius:6, padding:'5px 14px', fontSize:12, fontWeight:700, cursor:pdfGenerating?'not-allowed':'pointer', opacity:pdfGenerating?0.7:1 }}>
                {pdfGenerating ? '⏳ Building…' : '⬇ Download PDF'}
              </button>
              <button onClick={saveOnePager}
                style={{ background:'none', color:'rgba(255,255,255,0.7)', border:'1px solid rgba(255,255,255,0.25)', borderRadius:6, padding:'5px 14px', fontSize:12, fontWeight:600, cursor:'pointer' }}>
                {onePagerSaved ? '✓ Saved' : '💾 Save'}
              </button>
              <button onClick={()=>{setOnePagerDraft('');setOnePagerType(null)}}
                style={{ background:'none', color:'rgba(255,255,255,0.5)', border:'1px solid rgba(255,255,255,0.2)', borderRadius:6, padding:'5px 10px', fontSize:12, cursor:'pointer' }}>
                ✕
              </button>
            </div>
          </div>
          {onePagerError && <div style={{ padding:'12px 16px', color:'#b91c1c', fontSize:13 }}>⚠ {onePagerError}</div>}
          {onePagerDraft && (
            <textarea value={onePagerDraft} onChange={e=>setOnePagerDraft(e.target.value)}
              rows={14} style={{ width:'100%', padding:'16px', fontFamily:'Georgia, serif', fontSize:14,
                lineHeight:1.8, border:'none', outline:'none', resize:'vertical', boxSizing:'border-box',
                background:'#FAFAFA', color:'var(--ink)' }}/>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, marginBottom:32, borderBottom:'1px solid var(--ink-10)', overflowX:'auto' }}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSection(t.id)} style={{ padding:'9px 16px', fontSize:13, fontWeight:section===t.id?600:400, background:'none', border:'none', borderBottom:section===t.id?'2px solid var(--ink)':'2px solid transparent', color:section===t.id?'var(--ink)':'var(--ink-40)', cursor:'pointer', marginBottom:-1, whiteSpace:'nowrap', fontFamily:'inherit' }}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {section==='production' && <AdminPanel    weekStart={weekStart} weekData={weekData} onSave={onSave} dbReady={dbReady} defaultSection="production"/>}
      {section==='kpis'       && <AdminPanel    weekStart={weekStart} weekData={weekData} onSave={onSave} dbReady={dbReady} defaultSection="kpis"/>}
      {section==='log'        && <WeeklyLog     weekData={weekData} weekStart={weekStart} onSave={onSave} dbReady={dbReady}/>}
      {section==='financials' && <AdminPanel    weekStart={weekStart} weekData={weekData} onSave={onSave} dbReady={dbReady} defaultSection="financials"/>}
      {section==='people'     && <AdminPeople   weekStart={weekKey(weekStart)} currentUser={userProfile} onSaved={()=>setSection('production')}/>}
      {section==='files'      && <Correspondence weekStart={weekStart} dbReady={dbReady} {...commentProps}/>}
      {section==='history'    && <HistoryPanel  onSelectWeek={()=>{}}/>}
    </div>
  )
}


// ── Live Ops page — unified single-row KPI bar + both facility tables ─────────
function LiveOpsPage({ weekStart }) {
  const {
    bny, nj, digital, hs, loading, error, weekNum, weekInfo, lastRefresh,
    todayIdx, daysIn, bnyT, njT, reload
  } = useProductionData(weekStart)

  const todayLabel = todayIdx>=0 ? ['Mon','Tue','Wed','Thu','Fri'][todayIdx] : null
  const fmt  = n => n!==null&&n!==undefined ? Number(n).toLocaleString() : '—'
  const pct  = (a,b) => a!==null&&b&&b>0 ? Math.round(a/b*100) : null
  const pctColor   = p => p===null ? 'rgba(250,247,242,0.5)' : p>=95 ? '#6FCF97' : p>=80 ? '#F2C94C' : '#EB5757'
  const wasteColor = p => p===null ? 'rgba(250,247,242,0.5)' : p<=10  ? '#6FCF97' : '#EB5757'
  const ouFmt = ou => ou===null ? null : `${ou>=0?'+':''}${Number(ou).toLocaleString()}`

  const [pdfFacility, setPdfFacility] = useState(null) // 'digital' | 'hs' | null

  async function handlePrintPDF(facility) {
    if (pdfFacility) return
    setPdfFacility(facility)
    try {
      const isDigital = facility === 'digital'
      await generateLiveOpsPDF({
        data:          isDigital ? digital : hs,
        dayCols:       isDigital ? BNY_DAYS : NJ_DAYS,
        totals:        isDigital ? digitalT : hsT,
        budget:        isDigital ? 12000 : 8610,
        facilityLabel: isDigital ? 'Digital — Brooklyn + Passaic' : 'Hand Screen — Passaic',
        weekNum, weekInfo, todayIdx,
      })
    } catch(e) {
      console.error('PDF generation failed:', e)
      alert('PDF failed: ' + e.message)
    } finally { setPdfFacility(null) }
  }

  // Combined totals
  const combSched  = (bnyT?.wkSched||0)+(njT?.wkSched||0)
  const combActual = bnyT?.wkActual!==null||njT?.wkActual!==null ? (bnyT?.wkActual||0)+(njT?.wkActual||0) : null
  const combWaste  = bnyT?.wkWaste!==null||njT?.wkWaste!==null   ? (bnyT?.wkWaste||0)+(njT?.wkWaste||0)   : null
  const combSchedP = pct(combActual, combSched)
  const combBudgetP= pct(combActual, 12000+8610)
  const combWasteP = pct(combWaste, combActual)

  const hasData = bnyT !== null || njT !== null

  // ── Sub-components scoped to this bar ──
  function Bubble({ label, value, sub, color }) {
    return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
        background:'rgba(255,255,255,0.06)', borderRadius:6, padding:'5px 10px',
        minWidth:64, gap:1, flexShrink:1 }}>
        <div style={{ fontSize:8, color:'rgba(212,168,67,0.65)', fontWeight:'bold',
          letterSpacing:'0.07em', textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</div>
        <div style={{ fontSize:14, fontWeight:'bold', color:color||'#FAF7F2',
          fontFamily:'Georgia, serif', whiteSpace:'nowrap', lineHeight:1.2 }}>{value}</div>
        {sub && <div style={{ fontSize:8, color:'rgba(250,247,242,0.4)', whiteSpace:'nowrap', marginTop:1 }}>{sub}</div>}
      </div>
    )
  }

  function VDiv() {
    return <div style={{ width:1, alignSelf:'stretch', background:'rgba(212,168,67,0.2)', flexShrink:0, margin:'0 4px' }}/>
  }

  function GroupLabel({ text }) {
    return (
      <div style={{ fontSize:9, color:'rgba(212,168,67,0.7)', fontWeight:'bold',
        letterSpacing:'0.08em', background:'rgba(212,168,67,0.1)', borderRadius:3,
        padding:'2px 6px', whiteSpace:'nowrap', flexShrink:0, alignSelf:'center',
        userSelect:'none' }}>{text}</div>
    )
  }

  return (
    <div style={{ fontFamily:'Georgia, serif', background:'#FAF7F2', minHeight:'100vh' }}>

      {/* ── Sticky KPI bar — two clean rows, no wrapping ── */}
      <div style={{
        position:'sticky', top:0, zIndex:100,
        background:'#2C2420',
        borderBottom:'2px solid rgba(212,168,67,0.2)',
        boxShadow:'0 3px 16px rgba(0,0,0,0.35)',
        padding:'8px 16px',
        overflowX:'hidden',
      }}>

        {/* ROW 1: identity + Combined + BNY + Refresh */}
        <div style={{ display:'flex', alignItems:'center', gap:5, flexWrap:'wrap', marginBottom: hasData ? 6 : 0 }}>

          {/* Identity */}
          <div style={{ flexShrink:0, marginRight:4 }}>
            <div style={{ display:'flex', alignItems:'center', gap:5 }}>
              <span style={{ background:'#D4A843', color:'#2C2420', borderRadius:4,
                padding:'2px 7px', fontSize:11, fontWeight:'bold', whiteSpace:'nowrap' }}>Live Ops</span>
              {weekNum && (
                <span style={{ background:'rgba(212,168,67,0.15)', color:'#D4A843',
                  borderRadius:4, padding:'2px 7px', fontSize:11, fontWeight:'bold' }}>FY WK {weekNum}</span>
              )}
              {weekInfo && (
                <span style={{ fontSize:10, color:'rgba(212,168,67,0.6)', whiteSpace:'nowrap' }}>
                  {weekInfo.month} · {weekInfo.quarter}
                </span>
              )}
            </div>
            {lastRefresh && (
              <div style={{ fontSize:8, color:'rgba(250,247,242,0.3)', marginTop:2 }}>
                {lastRefresh.toLocaleTimeString()}
              </div>
            )}
          </div>

          {hasData && <>
            <VDiv/>
            <GroupLabel text="COMBINED"/>
            <Bubble label="Total Yds"   value={combActual!==null?fmt(combActual):'—'} sub={`of ${fmt(combSched)} sched`} color={pctColor(combSchedP)}/>
            <Bubble label="vs Schedule" value={combSchedP!==null?`${combSchedP}%`:'—'} sub="combined"                   color={pctColor(combSchedP)}/>
            <Bubble label="vs Budget"   value={combBudgetP!==null?`${combBudgetP}%`:'—'} sub="20,610 yd tgt"            color={pctColor(combBudgetP)}/>
            <Bubble label="Waste"       value={combWasteP!==null?`${combWasteP}%`:'—'} sub={`${fmt(combWaste)} yds`}   color={wasteColor(combWasteP)}/>
            <VDiv/>
            <GroupLabel text="BNY"/>
            <Bubble label="Actual"    value={bnyT?.wkActual!==null?fmt(bnyT?.wkActual):'—'} sub={`sched ${fmt(bnyT?.wkSched)}`}   color={pctColor(bnyT?.schedPct)}/>
            <Bubble label="% Sched"   value={bnyT?.schedPct!==null?`${bnyT.schedPct}%`:'—'} sub={ouFmt(bnyT?.overUnder)??'vs exp'} color={pctColor(bnyT?.schedPct)}/>
            <Bubble label="vs Budget" value={bnyT?.budgetPct!==null?`${bnyT.budgetPct}%`:'—'} sub="12,000 yd tgt"                 color={pctColor(bnyT?.budgetPct)}/>
            <Bubble label="Waste"     value={bnyT?.wastePct!==null?`${bnyT.wastePct}%`:'—'} sub={`${fmt(bnyT?.wkWaste)} yds`}    color={wasteColor(bnyT?.wastePct)}/>
          </>}

          <div style={{ flex:1, minWidth:12 }}/>
          <div style={{ display:'flex', gap:6, flexShrink:0 }}>
            <button onClick={()=>handlePrintPDF('digital')} disabled={!!pdfFacility||loading} style={{
              background:'rgba(212,168,67,0.15)', border:'1px solid rgba(212,168,67,0.35)', borderRadius:4,
              padding:'4px 11px', fontSize:11, color:'#D4A843', cursor:pdfFacility?'not-allowed':'pointer',
              whiteSpace:'nowrap', opacity:pdfFacility==='digital'?0.6:1,
            }}>
              {pdfFacility==='digital' ? '⏳ Building…' : '⬇ Digital PDF'}
            </button>
            <button onClick={()=>handlePrintPDF('hs')} disabled={!!pdfFacility||loading} style={{
              background:'rgba(212,168,67,0.15)', border:'1px solid rgba(212,168,67,0.35)', borderRadius:4,
              padding:'4px 11px', fontSize:11, color:'#D4A843', cursor:pdfFacility?'not-allowed':'pointer',
              whiteSpace:'nowrap', opacity:pdfFacility==='hs'?0.6:1,
            }}>
              {pdfFacility==='hs' ? '⏳ Building…' : '⬇ Hand Screen PDF'}
            </button>
            <button onClick={reload} disabled={loading} style={{
              background:'none', border:'1px solid rgba(212,168,67,0.25)', borderRadius:4,
              padding:'4px 11px', fontSize:11, color:'rgba(212,168,67,0.6)',
              cursor:'pointer', whiteSpace:'nowrap', flexShrink:0,
            }}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>

        {/* ROW 2: NJ — indented to align with BNY bubbles above */}
        {hasData && (
          <div style={{ display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
            {/* Invisible spacer — matches identity block width exactly */}
            <div style={{ flexShrink:0, visibility:'hidden', marginRight:4 }}>
              <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                <span style={{ borderRadius:4, padding:'2px 7px', fontSize:11, fontWeight:'bold' }}>Live Ops</span>
                {weekNum && <span style={{ borderRadius:4, padding:'2px 7px', fontSize:11, fontWeight:'bold' }}>FY WK {weekNum}</span>}
                {weekInfo && <span style={{ fontSize:10 }}>{weekInfo.month} · {weekInfo.quarter}</span>}
              </div>
              <div style={{ fontSize:8, marginTop:2 }}>00:00:00 AM</div>
            </div>

            {/* Combined spacer — matches COMBINED group width */}
            <div style={{ display:'flex', alignItems:'center', gap:5, visibility:'hidden', pointerEvents:'none' }}>
              <VDiv/>
              <GroupLabel text="COMBINED"/>
              <Bubble label="Total Yds"   value="—" sub="placeholder"/>
              <Bubble label="vs Schedule" value="—" sub="placeholder"/>
              <Bubble label="vs Budget"   value="—" sub="placeholder"/>
              <Bubble label="Waste"       value="—" sub="placeholder"/>
            </div>

            <VDiv/>
            <GroupLabel text="NJ"/>
            <Bubble label="Actual"    value={njT?.wkActual!==null?fmt(njT?.wkActual):'—'} sub={`sched ${fmt(njT?.wkSched)}`}    color={pctColor(njT?.schedPct)}/>
            <Bubble label="% Sched"   value={njT?.schedPct!==null?`${njT.schedPct}%`:'—'} sub={ouFmt(njT?.overUnder)??'vs exp'} color={pctColor(njT?.schedPct)}/>
            <Bubble label="vs Budget" value={njT?.budgetPct!==null?`${njT.budgetPct}%`:'—'} sub="8,610 yd tgt"                  color={pctColor(njT?.budgetPct)}/>
            <Bubble label="Waste"     value={njT?.wastePct!==null?`${njT.wastePct}%`:'—'} sub={`${fmt(njT?.wkWaste)} yds`}     color={wasteColor(njT?.wastePct)}/>
          </div>
        )}
      </div>

      {/* ── Facility tables ── */}
      <div style={{ padding:'24px' }}>
        <div style={{ fontSize:13, color:'#9C8F87', marginBottom:24 }}>
          Source: Google Sheets (live) · Each cell: Sched / Actual / +− · Waste · Operator · Waste target &lt;10%
        </div>
        {error   && <div style={{ background:'#FFF3E0', border:'1px solid #FFB74D', borderRadius:8, padding:16, color:'#E65100', marginBottom:16 }}>⚠ {error}</div>}
        {loading && <div style={{ color:'#9C8F87', padding:40, textAlign:'center', fontSize:14 }}>Loading from Google Sheets...</div>}
        {!loading && !error && (
          <>
            <div style={{marginBottom:40}}>
              <div style={{fontSize:16,fontWeight:'bold',color:'#2C2420',marginBottom:12,fontFamily:'Georgia, serif'}}>BNY — Digital Production</div>
              <FacilityDetail data={bny} dayCols={BNY_DAYS} todayIdx={todayIdx} budget={12000} title="BNY"/>
              <OperatorScorecard ops={bny?.ops} facility="BNY"/>
            </div>
            <div style={{marginBottom:40}}>
              <div style={{fontSize:16,fontWeight:'bold',color:'#2C2420',marginBottom:12,fontFamily:'Georgia, serif'}}>Passaic — Screen Print</div>
              <FacilityDetail data={nj} dayCols={NJ_DAYS} todayIdx={todayIdx} budget={8610} title="Passaic"/>
              <OperatorScorecard ops={nj?.ops} facility="Passaic"/>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab,   setActiveTab]   = useState('consolidated')
  const [currentWeek, setCurrentWeek] = useState(getDefaultWeek())
  const [weekData,    setWeekData]    = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [dbReady,     setDbReady]     = useState(true)

  const [notifying,     setNotifying]     = useState(false)
  const [notifySuccess, setNotifySuccess] = useState(false)
  const [sessionCommentCount, setSessionCommentCount] = useState(0)
  const sessionCommentsRef = useRef([])
  const sessionStartRef    = useRef(null)

  const [authUser,           setAuthUser]           = useState(null)
  const [userProfile,        setUserProfile]        = useState(null)
  const [authLoading,        setAuthLoading]        = useState(true)
  const [adminAuthenticated, setAdminAuthenticated] = useState(false)
  const isAdmin = userProfile?.role === 'admin'

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setAuthUser(session.user)
        supabase.from('profiles').select('full_name, role').eq('id', session.user.id).single()
          .then(({ data: profile }) => {
            setUserProfile(profile)
            if (profile?.full_name) localStorage.setItem('pp_commenter', profile.full_name)
            if (profile?.role === 'admin') setAdminAuthenticated(true)
          })
      }
      setAuthLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) { setAuthUser(null); setUserProfile(null); setAdminAuthenticated(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => { loadWeek(currentWeek) }, [currentWeek])

  useEffect(() => {
    sessionCommentsRef.current = []
    sessionStartRef.current    = null
    setSessionCommentCount(0)
  }, [currentWeek])

  async function loadWeek(weekDate) {
    setLoading(true)
    const key = weekKey(weekDate)
    try {
      const { data, error } = await supabase.from('weeks').select('*').eq('week_start', key).single()
      if (error && error.code !== 'PGRST116') { console.error('Load error:', error); setDbReady(false) }
      else { setDbReady(true); setWeekData(data || null) }
    } catch (e) { setDbReady(false) }
    setLoading(false)
  }

  async function saveWeekData(updates) {
    const key     = weekKey(currentWeek)
    const payload = { week_start: key, updated_at: new Date().toISOString(), ...updates }
    const { data, error } = await supabase.from('weeks').upsert(payload, { onConflict: 'week_start' }).select().single()
    if (!error && data) setWeekData(data)
    return { data, error }
  }

  function onCommentPosted(commentId) {
    sessionCommentsRef.current = [...sessionCommentsRef.current, commentId]
    setSessionCommentCount(sessionCommentsRef.current.length)
    if (!sessionStartRef.current) sessionStartRef.current = new Date(Date.now() - 2000).toISOString()
  }

  async function handleNotifySlack() {
    const myName = userProfile?.full_name || localStorage.getItem('pp_commenter') || ''
    if (!myName || sessionCommentsRef.current.length === 0) return
    setNotifying(true)
    const key     = weekKey(currentWeek)
    const realIds = sessionCommentsRef.current.filter(id => !String(id).startsWith('local-'))
    let comments  = []
    if (realIds.length > 0) {
      const { data } = await supabase.from('section_comments').select('*').in('id', realIds).order('created_at', { ascending: true })
      comments = data || []
    }
    if (comments.length < sessionCommentsRef.current.length && sessionStartRef.current) {
      const { data: recent } = await supabase.from('section_comments').select('*').eq('week_start', key).eq('author', myName).gte('created_at', sessionStartRef.current).order('created_at', { ascending: true })
      if (recent) {
        const existingIds = new Set(comments.map(c => c.id))
        comments = [...comments, ...recent.filter(c => !existingIds.has(c.id))]
      }
    }
    if (comments?.length > 0) {
      try {
        await fetch('/api/slack', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ author: myName, weekLabel: `Week of ${format(currentWeek,'MMMM d, yyyy')}`, comments, dashboardUrl: window.location.origin }) })
      } catch (e) { console.error('Slack notify failed:', e) }
    }
    sessionCommentsRef.current = []; sessionStartRef.current = null; setSessionCommentCount(0)
    setNotifying(false); setNotifySuccess(true)
    setTimeout(() => setNotifySuccess(false), 3000)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    localStorage.removeItem('pp_commenter')
    setAuthUser(null); setUserProfile(null); setAdminAuthenticated(false)
    setActiveTab('consolidated')
  }

  function handleLogin(user, profile) {
    setAuthUser(user); setUserProfile(profile)
    if (profile?.full_name) localStorage.setItem('pp_commenter', profile.full_name)
    if (profile?.role === 'admin') setAdminAuthenticated(true)
  }

  const fiscalLabel = getFiscalLabel(currentWeek)
  const weekLabel   = `Results: Week of ${format(currentWeek, 'MMMM d, yyyy')}`

  if (authLoading) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--cream)' }}>
      <div style={{ display:'flex', gap:6 }}>
        {[0,1,2].map(i=><span key={i} style={{ width:8, height:8, background:'var(--ink-30)', borderRadius:'50%', animation:`bounce 1.2s ease-in-out ${i*0.2}s infinite` }}/>)}
      </div>
    </div>
  )

  if (!authUser) return <LoginScreen onLogin={handleLogin} />

  const commentProps = { currentUser: userProfile?.full_name, onCommentPosted }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.brand}>
            <img src="/ParamountLogo.png" alt="Paramount Prints" style={{ height:64, width:'auto', display:'block' }}/>
            <p style={{ margin:0, marginTop:4, fontSize:15, fontWeight:700, fontFamily:'Georgia, serif', color:'var(--ink)' }}>
              Executive Operations Dashboard
            </p>
          </div>

          <div className={styles.weekNav}>
            <button onClick={()=>setCurrentWeek(w=>subWeeks(w,1))} className={styles.weekBtn}>←</button>
            <div className={styles.weekLabelStack}>
              <span className={styles.weekLabel}>{weekLabel}</span>
              {fiscalLabel && <span className={styles.fiscalLabel}>{fiscalLabel}</span>}
            </div>
            <button onClick={()=>setCurrentWeek(w=>addWeeks(w,1))} className={styles.weekBtn}>→</button>
            <button onClick={()=>setCurrentWeek(getDefaultWeek())} className={styles.weekTodayBtn}>Last week</button>
          </div>

          <div className={styles.headerRight}>
            <div className={styles.sendUpdateArea}>
              {notifySuccess ? (
                <span className={styles.sendSuccessMsg}>✓ Slack notified</span>
              ) : (
                <button
                  className={`${styles.sendUpdateBtn} ${sessionCommentCount>0?styles.sendUpdateBtnActive:''}`}
                  onClick={handleNotifySlack}
                  disabled={notifying||sessionCommentCount===0}
                >
                  <SlackIcon size={14}/>
                  {notifying?'Notifying…':sessionCommentCount>0?`Notify Slack (${sessionCommentCount})`:'Notify Slack'}
                </button>
              )}
            </div>
            {isAdmin && (
              <button
                className={`${styles.gearBtn} ${activeTab==='admin'?styles.gearBtnActive:''}`}
                onClick={()=>setActiveTab('admin')}
                title="Admin panel"
              >⚙</button>
            )}
          </div>
        </div>

        {!dbReady && (
          <div className={styles.setupBanner}>
            <strong>Setup required:</strong> Connect your Supabase database.
          </div>
        )}

        <nav className={styles.nav}>
          {PUBLIC_TABS.map(t=>(
            <button
              key={t.id}
              className={`${styles.navTab} ${activeTab===t.id?styles.navTabActive:''}`}
              onClick={()=>setActiveTab(t.id)}
            >{t.label}</button>
          ))}
          {isAdmin && ADMIN_TABS.map(t=>(
            <button
              key={t.id}
              className={`${styles.navTab} ${activeTab===t.id?styles.navTabActive:''}`}
              onClick={()=>setActiveTab(t.id)}
              style={{ color: activeTab===t.id ? undefined : 'var(--ink-30)', fontSize: 13 }}
              title="Your daily ops view — not visible to C-suite"
            >{t.label}</button>
          ))}
          <div className={styles.navUserArea}>
            <span className={styles.navUserName}>{userProfile?.full_name?.split(' ')[0]}</span>
            <button className={styles.signOutBtn} onClick={handleSignOut}>Sign out</button>
          </div>
        </nav>
      </header>

      <main className={styles.main}>
        {loading ? (
          <div className={styles.loading}><div className={styles.loadingDots}><span/><span/><span/></div></div>
        ) : (
          <>
            {activeTab==='consolidated' && (
              <ConsolidatedPage weekStart={currentWeek} weekData={weekData} dbReady={dbReady} commentProps={commentProps}/>
            )}
            {activeTab==='financials' && (
              <FinancialTab weekStart={currentWeek} currentPeriod={format(currentWeek,'yyyy-MM-dd').slice(0,7)}/>
            )}
            {activeTab==='people' && (
              <PeopleTab weekStart={weekKey(currentWeek)} readOnly={true} {...commentProps}/>
            )}
            {activeTab==='wip' && (
              <WIPTab weekStart={currentWeek} />
            )}
            {activeTab==='liveops' && adminAuthenticated && (
              <LiveOpsPage weekStart={currentWeek}/>
            )}
            {activeTab==='admin' && adminAuthenticated && (
              <AdminPage weekStart={currentWeek} weekData={weekData} onSave={saveWeekData} onRefresh={()=>loadWeek(currentWeek)} dbReady={dbReady} userProfile={userProfile} commentProps={commentProps}/>
            )}
          </>
        )}
      </main>

      <footer className={styles.footer}>
        <span>Paramount Prints · F. Schumacher & Co.</span>
        <span>Peter Webster, President</span>
      </footer>
    </div>
  )
}
