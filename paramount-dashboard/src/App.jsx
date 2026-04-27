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
import SchedulerTab from './components/SchedulerTab'
import LiveOpsTab from './components/LiveOpsTab'
import StubPage from './components/StubPage'
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

// ─────────────────────────────────────────────────────────────────────────────
// MODE / ROLE / TAB DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// Roles:
//   admin   — Peter, Brynn. Lands in Operations. Can flip to Executive.
//             Sees gear/admin. Full access.
//   manager — Wendy, Chandler, future Production Planning Director, future
//             CX & Ops Associate. Lands in Operations → Live Ops.
//             Can flip to Executive for context.
//   qa      — Sami. Lands in Operations → Live Ops. Scheduler is read-only.
//             No Inventory/WIP. No gear. No Executive view.
//   exec    — Timur, Antonella, Emily, Abigail, Kim. Lands in Executive →
//             Dashboard. Can flip to Operations to peek (read-only feel).
//             No gear.
//
// Mode determines which tabs render in the nav.
// Tab definition includes which roles see it.
// ─────────────────────────────────────────────────────────────────────────────

const EXEC_TABS = [
  { id: 'dashboard',  label: 'Dashboard'  },
  { id: 'financials', label: 'Financials' },
  { id: 'people',     label: 'People'     },
  { id: 'inventory',  label: 'Inventory'  },
]

const OPS_TABS = [
  { id: 'liveops',   label: 'Live Ops'  },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'wip',       label: 'WIP'       },
  { id: 'inventory', label: 'Inventory' },
  { id: 'dashboard', label: 'Dashboard' },
]

// QA gets a stripped-down Operations tab list — no WIP, no Inventory, no Dashboard.
const QA_OPS_TABS = [
  { id: 'liveops',   label: 'Live Ops'  },
  { id: 'scheduler', label: 'Scheduler' },
]

function landingFor(role) {
  if (role === 'exec')                        return { mode: 'executive',  tab: 'dashboard' }
  if (role === 'manager' || role === 'qa')    return { mode: 'operations', tab: 'liveops'   }
  if (role === 'admin')                       return { mode: 'operations', tab: 'liveops'   }
  // unknown / null role: safest is Executive Dashboard
  return { mode: 'executive', tab: 'dashboard' }
}

function tabsFor(mode, role) {
  if (mode === 'executive') return EXEC_TABS
  if (role === 'qa')        return QA_OPS_TABS
  return OPS_TABS
}

function canAccessGear(role) {
  return role === 'admin'
}

function canSwitchMode(role) {
  // Everyone except qa can flip modes. QA stays in Ops.
  return role !== 'qa'
}

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

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTIVE DASHBOARD
// Phase 1 keeps the existing ConsolidatedPage layout untouched for the
// Dashboard tab. Phase 2 will replace this with the Today/This Week/MTD
// time-window toggle and Claude's read.
// ─────────────────────────────────────────────────────────────────────────────
function ExecutiveDashboardPage({ weekStart, weekData, dbReady, commentProps }) {
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

      {flags && (
        <div style={{ marginBottom:48 }}>
          <SectionLabel>Areas of Concern</SectionLabel>
          <div style={{ background:'#FFF8F0', border:'1px solid #FFE4C0', borderRadius:8, padding:'16px 20px', fontSize:14, lineHeight:1.7, color:'var(--ink)' }}>
            {flags}
          </div>
        </div>
      )}

      <div style={{ marginBottom:48 }}>
        <SectionLabel>Production — Brooklyn (BNY) &amp; Passaic</SectionLabel>
        <ProductionDashboard weekStart={weekStart} dbReady={dbReady} readOnly {...commentProps} />
      </div>

      {hasKPIs && (
        <div style={{ marginBottom:48 }}>
          <SectionLabel>KPI Scorecard Detail</SectionLabel>
          <KPIScorecard weekData={weekData} weekStart={weekStart} onSave={null} dbReady={dbReady} readOnly {...commentProps}/>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PAGE — wraps AdminPanel. AdminPanel manages its own section state
// internally and accepts { weekStart, weekData, onSave, dbReady }.
// Phase 4 will add the redesigned admin sidebar (LIFT Refresh, AI Monitoring,
// User Management, etc.) — for now this is a passthrough.
// ─────────────────────────────────────────────────────────────────────────────
function AdminPage({ weekStart, weekData, onSave, onRefresh, dbReady, userProfile, commentProps }) {
  return (
    <div style={{ minHeight:'calc(100vh - 200px)' }}>
      <AdminPanel
        weekStart={weekStart}
        weekData={weekData}
        onSave={onSave}
        dbReady={dbReady}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE TOGGLE — pill toggle in header for switching between Exec / Ops
// ─────────────────────────────────────────────────────────────────────────────
function ModeToggle({ mode, onChange, allowSwitch }) {
  if (!allowSwitch) return null
  return (
    <div className={styles.modeToggle}>
      <button
        className={`${styles.modeToggleBtn} ${mode==='executive' ? styles.modeToggleBtnActive : ''}`}
        onClick={()=>onChange('executive')}
      >Executive</button>
      <button
        className={`${styles.modeToggleBtn} ${mode==='operations' ? styles.modeToggleBtnActive : ''}`}
        onClick={()=>onChange('operations')}
      >Operations</button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [mode,         setMode]         = useState('executive')
  const [activeTab,    setActiveTab]    = useState('dashboard')
  const [currentWeek,  setCurrentWeek]  = useState(getDefaultWeek())
  const [weekData,     setWeekData]     = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [dbReady,      setDbReady]      = useState(true)
  const [inAdmin,      setInAdmin]      = useState(false)

  const [notifying,           setNotifying]           = useState(false)
  const [notifySuccess,       setNotifySuccess]       = useState(false)
  const [sessionCommentCount, setSessionCommentCount] = useState(0)
  const sessionCommentsRef = useRef([])
  const sessionStartRef    = useRef(null)

  const [authUser,           setAuthUser]           = useState(null)
  const [userProfile,        setUserProfile]        = useState(null)
  const [authLoading,        setAuthLoading]        = useState(true)
  const [adminAuthenticated, setAdminAuthenticated] = useState(false)

  const role           = userProfile?.role || null
  const isAdmin        = role === 'admin'
  const showGear       = canAccessGear(role)
  const allowModeSwitch = canSwitchMode(role)
  const tabsForCurrentMode = tabsFor(mode, role)

  // ── Auth bootstrap + role-based landing ─────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setAuthUser(session.user)
        supabase.from('profiles').select('full_name, role').eq('id', session.user.id).single()
          .then(({ data: profile }) => {
            setUserProfile(profile)
            if (profile?.full_name) localStorage.setItem('pp_commenter', profile.full_name)
            if (profile?.role === 'admin') setAdminAuthenticated(true)

            // Land them in the right place based on role
            const landing = landingFor(profile?.role)

            // Respect saved preference if it's compatible with their role
            const savedMode = localStorage.getItem('pp_mode')
            const savedTab  = localStorage.getItem('pp_active_tab')
            if (savedMode && (savedMode === 'executive' || savedMode === 'operations') && canSwitchMode(profile?.role)) {
              setMode(savedMode)
              const validTabs = tabsFor(savedMode, profile?.role).map(t=>t.id)
              setActiveTab(validTabs.includes(savedTab) ? savedTab : tabsFor(savedMode, profile?.role)[0].id)
            } else if (profile?.role === 'qa') {
              // QA always lands in Ops, ignores any saved exec preference
              setMode('operations')
              setActiveTab('liveops')
            } else {
              setMode(landing.mode)
              setActiveTab(landing.tab)
            }
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

  // Persist mode + tab so reload returns to where you were
  useEffect(() => {
    if (userProfile && !inAdmin) {
      localStorage.setItem('pp_mode', mode)
      localStorage.setItem('pp_active_tab', activeTab)
    }
  }, [mode, activeTab, userProfile, inAdmin])

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
    localStorage.removeItem('pp_mode')
    localStorage.removeItem('pp_active_tab')
    setAuthUser(null); setUserProfile(null); setAdminAuthenticated(false)
    setMode('executive'); setActiveTab('dashboard'); setInAdmin(false)
  }

  function handleLogin(user, profile) {
    setAuthUser(user); setUserProfile(profile)
    if (profile?.full_name) localStorage.setItem('pp_commenter', profile.full_name)
    if (profile?.role === 'admin') setAdminAuthenticated(true)
    const landing = landingFor(profile?.role)
    setMode(landing.mode)
    setActiveTab(landing.tab)
    setInAdmin(false)
  }

  function handleModeChange(newMode) {
    if (!allowModeSwitch) return
    setMode(newMode)
    setInAdmin(false)
    // Set default tab for new mode if current tab is not in that mode's list
    const validTabs = tabsFor(newMode, role).map(t=>t.id)
    if (!validTabs.includes(activeTab)) {
      setActiveTab(tabsFor(newMode, role)[0].id)
    }
  }

  function handleTabChange(tabId) {
    setActiveTab(tabId)
    setInAdmin(false)
  }

  function handleGearClick() {
    setInAdmin(true)
  }

  // Week-nav visibility: only in Executive mode, not on Admin
  const showWeekNav = mode === 'executive' && !inAdmin

  const fiscalLabel = getFiscalLabel(currentWeek)
  const weekLabel   = `Week of ${format(currentWeek, 'MMMM d, yyyy')}`

  if (authLoading) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--cream)' }}>
      <div style={{ display:'flex', gap:6 }}>
        {[0,1,2].map(i=><span key={i} style={{ width:8, height:8, background:'var(--ink-30)', borderRadius:'50%', animation:`bounce 1.2s ease-in-out ${i*0.2}s infinite` }}/>)}
      </div>
    </div>
  )

  if (!authUser) return <LoginScreen onLogin={handleLogin}/>

  const commentProps = { currentUser: userProfile?.full_name, onCommentPosted }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.brand}>
            <img src="/ParamountLogo.png" alt="Paramount Prints" style={{ height:64, width:'auto', display:'block' }}/>
            <p style={{ margin:0, marginTop:4, fontSize:15, fontWeight:700, fontFamily:'Georgia, serif', color:'var(--ink)' }}>
              Operations Dashboard
            </p>
          </div>

          {showWeekNav && (
            <div className={styles.weekNav}>
              <button onClick={()=>setCurrentWeek(w=>subWeeks(w,1))} className={styles.weekBtn}>←</button>
              <div className={styles.weekLabelStack}>
                <span className={styles.weekLabel}>{weekLabel}</span>
                {fiscalLabel && <span className={styles.fiscalLabel}>{fiscalLabel}</span>}
              </div>
              <button onClick={()=>setCurrentWeek(w=>addWeeks(w,1))} className={styles.weekBtn}>→</button>
              <button onClick={()=>setCurrentWeek(getDefaultWeek())} className={styles.weekTodayBtn}>Last week</button>
            </div>
          )}

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
            {showGear && (
              <button
                className={`${styles.gearBtn} ${inAdmin ? styles.gearBtnActive : ''}`}
                onClick={handleGearClick}
                title="Admin"
              >⚙</button>
            )}
          </div>
        </div>

        {/* Mode toggle row — only shown for users who can switch */}
        {allowModeSwitch && !inAdmin && (
          <div className={styles.modeToggleRow}>
            <ModeToggle mode={mode} onChange={handleModeChange} allowSwitch={allowModeSwitch}/>
          </div>
        )}

        {!dbReady && (
          <div className={styles.setupBanner}>
            <strong>Setup required:</strong> Connect your Supabase database.
          </div>
        )}

        {!inAdmin && (
          <nav className={styles.nav}>
            {tabsForCurrentMode.map(t=>(
              <button
                key={t.id}
                className={`${styles.navTab} ${activeTab===t.id?styles.navTabActive:''}`}
                onClick={()=>handleTabChange(t.id)}
              >{t.label}</button>
            ))}
            <div className={styles.navUserArea}>
              <span className={styles.navUserName}>{userProfile?.full_name?.split(' ')[0]}</span>
              <button className={styles.signOutBtn} onClick={handleSignOut}>Sign out</button>
            </div>
          </nav>
        )}
      </header>

      <main className={styles.main}>
        {loading ? (
          <div className={styles.loading}><div className={styles.loadingDots}><span/><span/><span/></div></div>
        ) : (
          <>
            {/* Admin (gear) takes precedence over tab routing */}
            {inAdmin && adminAuthenticated && (
              <AdminPage
                weekStart={currentWeek}
                weekData={weekData}
                onSave={saveWeekData}
                onRefresh={()=>loadWeek(currentWeek)}
                dbReady={dbReady}
                userProfile={userProfile}
                commentProps={commentProps}
              />
            )}

            {!inAdmin && (
              <>
                {/* Dashboard — both modes */}
                {activeTab==='dashboard' && (
                  <ExecutiveDashboardPage weekStart={currentWeek} weekData={weekData} dbReady={dbReady} commentProps={commentProps}/>
                )}

                {/* Executive-mode tabs */}
                {activeTab==='financials' && (
                  <FinancialTab weekStart={currentWeek} currentPeriod={format(currentWeek,'yyyy-MM-dd').slice(0,7)}/>
                )}
                {activeTab==='people' && (
                  <PeopleTab weekStart={weekKey(currentWeek)} readOnly={true} {...commentProps}/>
                )}

                {/* Inventory — both modes, different views (Phase 3 splits these) */}
                {activeTab==='inventory' && (
                  <StubPage
                    title="Inventory"
                    eyebrow={mode === 'executive' ? 'Executive View' : 'Operations View'}
                    description={
                      mode === 'executive'
                        ? "Exec overview — WIP exposure headline, FSCO Watchlist with audit log, KPI rollup."
                        : "Three-zone working surface — Paramount Buy, Pass-Through, FSCO Watchlist with reorder cart."
                    }
                    note="Pending Brynn's review of the v5 mockup. Coming in Phase 3."
                  />
                )}

                {/* Ops-mode tabs */}
                {/* Phase 2 TODO: add `readOnly` prop to SchedulerTab so QA users
                    (Sami) get a read-only Scheduler. Requires component support. */}
                {activeTab==='liveops' && (
                  <LiveOpsTab/>
                )}
                {activeTab==='scheduler' && (
                  <SchedulerTab/>
                )}
                {activeTab==='wip' && (
                  <WIPTab weekStart={currentWeek} />
                )}
              </>
            )}
          </>
        )}
      </main>

      <footer className={styles.footer}>
        <span>Paramount Prints · F. Schumacher &amp; Co.</span>
        <span>Peter Webster, President</span>
      </footer>
    </div>
  )
}
