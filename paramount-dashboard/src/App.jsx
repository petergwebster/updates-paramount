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
import AdminLayout from './components/AdminLayout'
import LoginScreen from './components/LoginScreen'
import PeopleTab from './components/PeopleTab'
import FinancialTab from './components/FinancialTab'
import AdminPeople from './components/AdminPeople'
import { FacilityDetail, OperatorScorecard, useProductionData, generateLiveOpsPDF } from './components/ProductionTab'
import WIPTab from './components/WIPTab'
import SchedulerTab from './components/SchedulerTab'
import LiveOpsTab from './components/LiveOpsTab'
import StubPage from './components/StubPage'
import DashboardPage from './components/DashboardPage'
import ExecutiveDashboardPage from './components/ExecutiveDashboardPage'
import HeartbeatPage from './components/HeartbeatPage'
import LandingPage from './components/LandingPage'
import DestinationNav from './components/DestinationNav'
import UserManagement from './components/UserManagement'
import { destinationsFor, isSuperAdmin, DESTINATIONS } from './lib/access'
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
// DESTINATION / TAB DEFINITIONS
//
// Phase A change: Executive/Operations mode toggle is REPLACED with the
// three-destination model (Performance / Operations / Heartbeat). Users land
// on the chooser (LandingPage) after login and pick a destination.
//
// The `destination` state can be:
//   'landing'     — the chooser is showing
//   'performance' — Paramount Performance destination
//   'operations'  — Operations destination
//   'heartbeat'   — Paramount's Heartbeat destination
//
// Inside each destination, the tab structure is destination-specific.
// ─────────────────────────────────────────────────────────────────────────────

const PERFORMANCE_TABS = [
  { id: 'dashboard',  label: 'Recap'      },  // weekly recap (was: Dashboard in exec mode)
  { id: 'financials', label: 'Financials' },
  { id: 'people',     label: 'People'     },
  { id: 'inventory',  label: 'Inventory', isNew: true },
]

const OPERATIONS_TABS = [
  { id: 'liveops',   label: 'Live Ops'  },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'wip',       label: 'WIP', isNew: true },
]

// QA users get a stripped-down Operations tab list
const QA_OPERATIONS_TABS = [
  { id: 'liveops',   label: 'Live Ops'  },
  { id: 'scheduler', label: 'Scheduler' },
]

// Heartbeat is a single-page deep view, so no tab strip is shown.
// The `'pulse'` id is just an internal route identifier.
const HEARTBEAT_TABS = [
  { id: 'pulse', label: 'Pulse' },
]

/**
 * Default tab to land on when entering a destination.
 */
function defaultTabFor(destination, role) {
  if (destination === 'performance') return 'dashboard'
  if (destination === 'operations')  return 'liveops'
  if (destination === 'heartbeat')   return 'pulse'
  return null
}

/**
 * Tab list for the current destination.
 */
function tabsFor(destination, role) {
  if (destination === 'performance') return PERFORMANCE_TABS
  if (destination === 'operations')  return role === 'qa' ? QA_OPERATIONS_TABS : OPERATIONS_TABS
  if (destination === 'heartbeat')   return HEARTBEAT_TABS
  return []
}

function canAccessGear(role) {
  return role === 'admin'
}

function canSwitchMode(role) {
  return role !== 'qa'
}

function getInitials(name) {
  if (!name) return '??'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
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
// ADMIN PAGE — uses AdminLayout sidebar shell. Existing AdminPanel renders
// inside the "Weekly Data Entry" section. New stub sections (LIFT Refresh,
// AI Monitoring, Daily Digest, User Management, System Info) are routed
// inside AdminLayout. Phase 4 will replace stubs with real implementations.
// ─────────────────────────────────────────────────────────────────────────────
function AdminPage({ weekStart, weekData, onSave, onRefresh, dbReady, userProfile, authUser, commentProps, adminSection, setAdminSection }) {
  return (
    <AdminLayout
      weekStart={weekStart}
      weekData={weekData}
      onSave={onSave}
      onRefresh={onRefresh}
      dbReady={dbReady}
      userProfile={userProfile}
      authUser={authUser}
      commentProps={commentProps}
      section={adminSection}
      setSection={setAdminSection}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // destination = 'landing' | 'performance' | 'operations' | 'heartbeat'
  const [destination,  setDestination]  = useState('landing')
  const [activeTab,    setActiveTab]    = useState(null)
  const [currentWeek,  setCurrentWeek]  = useState(getDefaultWeek())
  const [weekData,     setWeekData]     = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [dbReady,      setDbReady]      = useState(true)
  const [inAdmin,      setInAdmin]      = useState(false)
  const [adminSection, setAdminSection] = useState('weekly-data')

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
  const tabsForCurrentDestination = tabsFor(destination, role)
  const isOnLanding    = destination === 'landing'

  // ── Auth bootstrap — every user lands on the chooser ────────────────────────
  useEffect(() => {
    let cancelled = false

    async function loadProfile(userId, attempt = 1) {
      try {
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('full_name, role, active')
          .eq('id', userId)
          .single()
        if (cancelled) return null

        if (error) {
          console.error(`[Auth] Profile fetch attempt ${attempt} failed:`, error.message)
          // Retry once after a short delay — sometimes the auth JWT
          // hasn't fully propagated when a stored session is restored
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 500))
            return loadProfile(userId, attempt + 1)
          }
          return null
        }
        return profile
      } catch (e) {
        console.error('[Auth] Profile fetch threw:', e)
        return null
      }
    }

    async function bootstrap() {
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled) return

      if (session?.user) {
        setAuthUser(session.user)
        const profile = await loadProfile(session.user.id)
        if (cancelled) return

        if (profile) {
          setUserProfile(profile)
          if (profile.full_name) localStorage.setItem('pp_commenter', profile.full_name)
          if (profile.role === 'admin') setAdminAuthenticated(true)
        } else {
          // Profile failed to load even after retry. Surface it instead of
          // silently showing "no destinations available".
          console.error('[Auth] Profile could not be loaded — user will see no destinations. Sign out and back in.')
        }
        setDestination('landing')
        setActiveTab(null)
      }
      setAuthLoading(false)
    }
    bootstrap()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return
      if (!session) { setAuthUser(null); setUserProfile(null); setAdminAuthenticated(false) }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => { loadWeek(currentWeek) }, [currentWeek])

  useEffect(() => {
    sessionCommentsRef.current = []
    sessionStartRef.current    = null
    setSessionCommentCount(0)
  }, [currentWeek])

  // Persist the current destination + tab so a hard refresh inside a destination
  // returns the user to it. Landing isn't persisted — the chooser is the entry
  // point only after a fresh login.
  useEffect(() => {
    if (userProfile && !inAdmin && destination !== 'landing') {
      localStorage.setItem('pp_destination', destination)
      if (activeTab) localStorage.setItem('pp_active_tab', activeTab)
    }
  }, [destination, activeTab, userProfile, inAdmin])

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
    localStorage.removeItem('pp_destination')
    localStorage.removeItem('pp_active_tab')
    // Older keys from before the redesign — clean up if present
    localStorage.removeItem('pp_mode')
    setAuthUser(null); setUserProfile(null); setAdminAuthenticated(false)
    setDestination('landing'); setActiveTab(null); setInAdmin(false)
  }

  function handleLogin(user, profile) {
    setAuthUser(user); setUserProfile(profile)
    if (profile?.full_name) localStorage.setItem('pp_commenter', profile.full_name)
    if (profile?.role === 'admin') setAdminAuthenticated(true)
    // Every user lands on the chooser
    setDestination('landing')
    setActiveTab(null)
    setInAdmin(false)
  }

  /**
   * handleDestinationChange — called from LandingPage.onChoose AND DestinationNav.
   * Routes the user into a destination, OR back to the landing chooser.
   */
  function handleDestinationChange(newDestination) {
    if (newDestination === 'landing') {
      setDestination('landing')
      setActiveTab(null)
      setInAdmin(false)
      return
    }
    // Validate user has access to the destination they're trying to enter
    if (!destinationsFor(userProfile).includes(newDestination)) {
      console.warn('Access denied to destination:', newDestination)
      return
    }
    setDestination(newDestination)
    setActiveTab(defaultTabFor(newDestination, role))
    setInAdmin(false)
  }

  function handleTabChange(tabId) {
    setActiveTab(tabId)
    setInAdmin(false)
  }

  function toggleAdmin() {
    setInAdmin(v => !v)
  }

  // Week nav is shown in destinations that have a week-based view (Performance recap)
  const showWeekNav = destination === 'performance' && !inAdmin

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
  const userInitials = getInitials(userProfile?.full_name)
  const firstName = userProfile?.full_name?.split(' ')[0] || ''

  return (
    <div className={styles.app}>
      <header className={styles.header}>

        {/* ── Header top row: brand left, week-nav center (exec only), user+gear right ── */}
        <div className={styles.headerTop}>
          <div className={styles.brand}>
            <img src="/ParamountLogo.png" alt="Paramount Prints" className={styles.brandLogo}/>
            <div className={styles.brandText}>
              <div className={styles.brandName}>Paramount Prints</div>
              <div className={styles.brandSub}>Operations Dashboard</div>
            </div>
          </div>

          {showWeekNav ? (
            <div className={styles.weekNav}>
              <button onClick={()=>setCurrentWeek(w=>subWeeks(w,1))} className={styles.weekBtn}>←</button>
              <div className={styles.weekLabelStack}>
                <span className={styles.weekLabel}>{weekLabel}</span>
                {fiscalLabel && <span className={styles.fiscalLabel}>{fiscalLabel}</span>}
              </div>
              <button onClick={()=>setCurrentWeek(w=>addWeeks(w,1))} className={styles.weekBtn}>→</button>
              <button onClick={()=>setCurrentWeek(getDefaultWeek())} className={styles.weekTodayBtn}>Last week</button>
            </div>
          ) : (
            <div className={styles.headerCenter}/>
          )}

          <div className={styles.headerRight}>
            {sessionCommentCount > 0 || notifySuccess || notifying ? (
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
            ) : null}

            <div className={styles.userPill} title={userProfile?.full_name}>
              <div className={styles.userAvatar}>{userInitials}</div>
              <span className={styles.userName}>{firstName}</span>
            </div>

            {showGear && (
              <button
                className={`${styles.gearBtn} ${inAdmin ? styles.gearBtnActive : ''}`}
                onClick={toggleAdmin}
                title={inAdmin ? 'Close admin' : 'Admin'}
              >⚙</button>
            )}

            <button className={styles.signOutLink} onClick={handleSignOut} title="Sign out">
              Sign out
            </button>
          </div>
        </div>

        {/* ── Destination nav (replaces old Executive/Operations mode toggle) ── */}
        {!inAdmin && !isOnLanding && (
          <div className={styles.modeToggleRow}>
            <DestinationNav
              userProfile={userProfile}
              activeDestination={destination}
              onChange={handleDestinationChange}
            />
          </div>
        )}

        {!dbReady && (
          <div className={styles.setupBanner}>
            <strong>Setup required:</strong> Connect your Supabase database.
          </div>
        )}

        {/* ── Tab nav (hidden on landing and in admin) ── */}
        {!inAdmin && !isOnLanding && tabsForCurrentDestination.length > 1 && (
          <nav className={styles.nav}>
            {tabsForCurrentDestination.map(t=>(
              <button
                key={t.id}
                className={`${styles.navTab} ${activeTab===t.id?styles.navTabActive:''}`}
                onClick={()=>handleTabChange(t.id)}
              >
                {t.label}
                {t.isNew && <span className={styles.navTabNew}>NEW</span>}
              </button>
            ))}
          </nav>
        )}

        {/* In admin, show a slim "back to app" bar so user always has an escape */}
        {inAdmin && (
          <div className={styles.adminBackBar}>
            <button className={styles.adminBackBtn} onClick={() => setInAdmin(false)}>
              ← Back to {destination === 'landing' ? 'Welcome' : DESTINATIONS[destination]?.shortName || 'app'}
            </button>
            <span className={styles.adminBackLabel}>Admin Panel</span>
          </div>
        )}
      </header>

      <main className={styles.main}>
        {loading ? (
          <div className={styles.loading}><div className={styles.loadingDots}><span/><span/><span/></div></div>
        ) : (
          <>
            {/* Landing — the destination chooser */}
            {isOnLanding && !inAdmin && (
              <LandingPage
                userProfile={userProfile}
                onChoose={handleDestinationChange}
              />
            )}

            {inAdmin && adminAuthenticated && (
              <AdminPage
                weekStart={currentWeek}
                weekData={weekData}
                onSave={saveWeekData}
                onRefresh={()=>loadWeek(currentWeek)}
                dbReady={dbReady}
                userProfile={userProfile}
                authUser={authUser}
                commentProps={commentProps}
                adminSection={adminSection}
                setAdminSection={setAdminSection}
              />
            )}

            {!inAdmin && !isOnLanding && (
              <>
                {/* Performance · Recap (the weekly recap) */}
                {destination === 'performance' && activeTab==='dashboard' && (
                  <ExecutiveDashboardPage
                    weekStart={currentWeek}
                    weekData={weekData}
                    dbReady={dbReady}
                    commentProps={commentProps}
                    currentUser={userProfile?.full_name}
                    userId={authUser?.id}
                  />
                )}
                {destination === 'performance' && activeTab==='financials' && (
                  <FinancialTab weekStart={currentWeek} currentPeriod={format(currentWeek,'yyyy-MM-dd').slice(0,7)}/>
                )}
                {destination === 'performance' && activeTab==='people' && (
                  <PeopleTab weekStart={weekKey(currentWeek)} readOnly={true} {...commentProps}/>
                )}
                {destination === 'performance' && activeTab==='inventory' && (
                  <StubPage
                    title="Inventory"
                    eyebrow="Performance · Inventory"
                    description="Three-zone inventory: Paramount Buy, Pass-Through, FSCO Watchlist with audit log + reorder cart."
                    note="Pending Brynn's review of the v5 mockup. Coming in Phase 3."
                  />
                )}

                {/* Operations · Live Ops, Scheduler, WIP */}
                {destination === 'operations' && activeTab==='liveops' && (
                  <LiveOpsTab currentUser={userProfile?.full_name} />
                )}
                {destination === 'operations' && activeTab==='scheduler' && (
                  <SchedulerTab/>
                )}
                {destination === 'operations' && activeTab==='wip' && (
                  <WIPTab weekStart={currentWeek} />
                )}

                {/* Heartbeat · The deep operational view */}
                {destination === 'heartbeat' && activeTab==='pulse' && (
                  <HeartbeatPage
                    weekStart={currentWeek}
                    currentUser={userProfile?.full_name}
                    userId={authUser?.id}
                  />
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
