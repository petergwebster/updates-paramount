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
import { BNYTab, PassaicTab, useProductionData } from './components/ProductionTab'
import styles from './App.module.css'

// ── Nav: Consolidated | Financials | People | (Live Ops — admin only) | ⚙ ────
const PUBLIC_TABS = [
  { id: 'consolidated', label: 'Consolidated' },
  { id: 'financials',   label: 'Financials'   },
  { id: 'people',       label: 'People'        },
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
  return startOfWeek(subWeeks(new Date(), 1), { weekStartsOn: 1 })
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
  const kpis        = weekData?.kpi_scores || {}
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
function AdminPage({ weekStart, weekData, onSave, dbReady, userProfile, commentProps }) {
  const [section, setSection] = useState('data')
  const tabs = [
    { id:'data',   label:'📊 Weekly Data' },
    { id:'log',    label:'📝 Weekly Log'  },
    { id:'people', label:'👥 People'      },
    { id:'files',  label:'📁 Files'       },
    { id:'history',label:'🕘 History'     },
  ]
  return (
    <div style={{ maxWidth:980, margin:'0 auto', padding:'28px 24px 64px' }}>
      <div style={{ marginBottom:24 }}>
        <h2 style={{ margin:0, fontFamily:'Georgia, serif', fontSize:22, color:'var(--ink)', fontWeight:700 }}>Admin Panel</h2>
        <p style={{ margin:'4px 0 0', fontSize:13, color:'var(--ink-40)' }}>
          Week of {format(weekStart,'MMMM d, yyyy')} · Data entry &amp; management
        </p>
      </div>
      <div style={{ display:'flex', gap:0, marginBottom:32, borderBottom:'1px solid var(--ink-10)' }}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setSection(t.id)} style={{
            padding:'9px 18px', fontSize:13, fontWeight:section===t.id?600:400,
            background:'none', border:'none',
            borderBottom:section===t.id?'2px solid var(--ink)':'2px solid transparent',
            color:section===t.id?'var(--ink)':'var(--ink-40)', cursor:'pointer',
            marginBottom:-1, whiteSpace:'nowrap', fontFamily:'inherit',
          }}>{t.label}</button>
        ))}
      </div>
      {section==='data'    && <AdminPanel weekStart={weekStart} weekData={weekData} onSave={onSave} dbReady={dbReady}/>}
      {section==='log'     && <WeeklyLog  weekData={weekData} weekStart={weekStart} onSave={onSave} dbReady={dbReady}/>}
      {section==='people'  && <AdminPeople weekStart={weekKey(weekStart)} currentUser={userProfile} onSaved={()=>setSection('data')}/>}
      {section==='files'   && <Correspondence weekStart={weekStart} dbReady={dbReady} {...commentProps}/>}
      {section==='history' && <HistoryPanel onSelectWeek={(w)=>{ /* week change handled in App */ }}/>}
    </div>
  )
}


// ── Live Ops page — combined KPI bar + both facility tables ──────────────────
function LiveOpsPage({ weekStart }) {
  const {
    bny, nj, loading, error, weekNum, weekInfo, lastRefresh,
    todayIdx, daysIn, bnyT, njT, reload
  } = useProductionData(weekStart)

  const todayLabel = todayIdx>=0 ? ['Mon','Tue','Wed','Thu','Fri'][todayIdx] : null
  const fmt  = n => n!==null&&n!==undefined ? Number(n).toLocaleString() : '—'
  const pct  = (a,b) => a!==null&&b&&b>0 ? Math.round(a/b*100) : null
  const pctColor   = p => p===null ? 'rgba(250,247,242,0.5)' : p>=95 ? '#6FCF97' : p>=80 ? '#F2C94C' : '#EB5757'
  const wasteColor = p => p===null ? 'rgba(250,247,242,0.5)' : p<=10  ? '#6FCF97' : '#EB5757'
  const ouFmt = ou => ou===null ? null : `${ou>=0?'+':''}${Number(ou).toLocaleString()}`

  function Bubble({ label, value, sub, color }) {
    return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', background:'rgba(255,255,255,0.06)', borderRadius:7, padding:'7px 12px', minWidth:88, gap:1 }}>
        <div style={{ fontSize:9, color:'rgba(212,168,67,0.65)', fontWeight:'bold', letterSpacing:'0.07em', textTransform:'uppercase', whiteSpace:'nowrap' }}>{label}</div>
        <div style={{ fontSize:15, fontWeight:'bold', color:color||'#FAF7F2', fontFamily:'Georgia, serif', whiteSpace:'nowrap', lineHeight:1.2 }}>{value}</div>
        {sub && <div style={{ fontSize:9, color:'rgba(250,247,242,0.45)', whiteSpace:'nowrap', marginTop:1 }}>{sub}</div>}
      </div>
    )
  }
  function Div() { return <div style={{ width:1, alignSelf:'stretch', background:'rgba(212,168,67,0.18)', margin:'0 2px' }}/> }
  function GL({ text }) { return <div style={{ fontSize:9, color:'rgba(212,168,67,0.55)', fontWeight:'bold', letterSpacing:'0.07em', writingMode:'vertical-lr', transform:'rotate(180deg)' }}>{text}</div> }

  const combSched  = (bnyT?.wkSched||0)+(njT?.wkSched||0)
  const combActual = bnyT?.wkActual!==null||njT?.wkActual!==null ? (bnyT?.wkActual||0)+(njT?.wkActual||0) : null
  const combWaste  = bnyT?.wkWaste!==null||njT?.wkWaste!==null   ? (bnyT?.wkWaste||0)+(njT?.wkWaste||0)   : null
  const combSchedP = pct(combActual, combSched)
  const combBudgetP= pct(combActual, 12000+8610)
  const combWasteP = pct(combWaste, combActual)

  return (
    <div style={{ fontFamily:'Georgia, serif', background:'#FAF7F2', minHeight:'100vh' }}>
      {/* Combined sticky KPI bar — 2 rows */}
      <div style={{ position:'sticky', top:0, zIndex:100, background:'#2C2420', borderBottom:'2px solid rgba(212,168,67,0.2)', boxShadow:'0 3px 16px rgba(0,0,0,0.35)', padding:'10px 20px' }}>
        {/* Row 1: identity + combined + BNY */}
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8, flexWrap:'wrap' }}>
          <div style={{ marginRight:6 }}>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ background:'#D4A843', color:'#2C2420', borderRadius:4, padding:'2px 8px', fontSize:11, fontWeight:'bold' }}>Live Ops</span>
              {weekNum && <span style={{ background:'rgba(212,168,67,0.15)', color:'#D4A843', borderRadius:4, padding:'2px 8px', fontSize:11, fontWeight:'bold' }}>FY WK {weekNum}</span>}
              {weekInfo && <span style={{ fontSize:10, color:'rgba(212,168,67,0.6)' }}>{weekInfo.month} · {weekInfo.quarter}</span>}
              {todayLabel && <span style={{ fontSize:10, color:'rgba(212,168,67,0.45)' }}>Today: {todayLabel}</span>}
            </div>
            {lastRefresh && <div style={{ fontSize:9, color:'rgba(250,247,242,0.3)', marginTop:2 }}>{lastRefresh.toLocaleTimeString()}</div>}
          </div>
          <Div/>
          <GL text="COMBINED"/>
          <Bubble label="Total Yds"   value={combActual!==null?fmt(combActual):'—'} sub={`of ${fmt(combSched)} sched`} color={pctColor(combSchedP)}/>
          <Bubble label="vs Schedule" value={combSchedP!==null?`${combSchedP}%`:'—'} sub="combined" color={pctColor(combSchedP)}/>
          <Bubble label="vs Budget"   value={combBudgetP!==null?`${combBudgetP}%`:'—'} sub="20,610 yd target" color={pctColor(combBudgetP)}/>
          <Bubble label="Waste"       value={combWasteP!==null?`${combWasteP}%`:'—'} sub={`${fmt(combWaste)} yds`} color={wasteColor(combWasteP)}/>
          <Div/>
          <GL text="BNY"/>
          <Bubble label="Actual"    value={bnyT?.wkActual!==null?fmt(bnyT?.wkActual):'—'} sub={`sched ${fmt(bnyT?.wkSched)}`} color={pctColor(bnyT?.schedPct)}/>
          <Bubble label="% Sched"   value={bnyT?.schedPct!==null?`${bnyT.schedPct}%`:'—'} sub={ouFmt(bnyT?.overUnder)??'vs exp'} color={pctColor(bnyT?.schedPct)}/>
          <Bubble label="vs Budget" value={bnyT?.budgetPct!==null?`${bnyT.budgetPct}%`:'—'} sub="12,000 yd tgt" color={pctColor(bnyT?.budgetPct)}/>
          <Bubble label="Waste"     value={bnyT?.wastePct!==null?`${bnyT.wastePct}%`:'—'} sub={`${fmt(bnyT?.wkWaste)} yds`} color={wasteColor(bnyT?.wastePct)}/>
          <div style={{ flex:1 }}/>
          <button onClick={reload} disabled={loading} style={{ background:'none', border:'1px solid rgba(212,168,67,0.25)', borderRadius:4, padding:'4px 12px', fontSize:11, color:'rgba(212,168,67,0.6)', cursor:'pointer' }}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
        {/* Row 2: NJ */}
        <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
          <div style={{ marginRight:6, minWidth:140 }}/>
          <Div/>
          <GL text="NJ"/>
          <Bubble label="Actual"    value={njT?.wkActual!==null?fmt(njT?.wkActual):'—'} sub={`sched ${fmt(njT?.wkSched)}`} color={pctColor(njT?.schedPct)}/>
          <Bubble label="% Sched"   value={njT?.schedPct!==null?`${njT.schedPct}%`:'—'} sub={ouFmt(njT?.overUnder)??'vs exp'} color={pctColor(njT?.schedPct)}/>
          <Bubble label="vs Budget" value={njT?.budgetPct!==null?`${njT.budgetPct}%`:'—'} sub="8,610 yd tgt" color={pctColor(njT?.budgetPct)}/>
          <Bubble label="Waste"     value={njT?.wastePct!==null?`${njT.wastePct}%`:'—'} sub={`${fmt(njT?.wkWaste)} yds`} color={wasteColor(njT?.wastePct)}/>
        </div>
      </div>

      {/* Both facility tables */}
      <div style={{ padding:'24px' }}>
        <div style={{ fontSize:13, color:'#9C8F87', marginBottom:24 }}>
          Source: Google Sheets (live) · Each cell: Sched / Actual / +− · Waste · Operator · Waste target &lt;10%
        </div>
        {error   && <div style={{ background:'#FFF3E0', border:'1px solid #FFB74D', borderRadius:8, padding:16, color:'#E65100', marginBottom:16 }}>⚠ {error}</div>}
        {loading && <div style={{ color:'#9C8F87', padding:40, textAlign:'center', fontSize:14 }}>Loading from Google Sheets...</div>}
        {!loading && !error && (
          <>
            <BNYTab weekStart={weekStart}/>
            <PassaicTab weekStart={weekStart}/>
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
            {activeTab==='liveops' && adminAuthenticated && (
              <LiveOpsPage weekStart={currentWeek}/>
            )}
            {activeTab==='admin' && adminAuthenticated && (
              <AdminPage weekStart={currentWeek} weekData={weekData} onSave={saveWeekData} dbReady={dbReady} userProfile={userProfile} commentProps={commentProps}/>
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
