import React, { useState, useEffect, useRef } from 'react'
import { format, startOfWeek, addWeeks, subWeeks } from 'date-fns'
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
import WIPTab from './components/WIPTab'
import AdminPeople from './components/AdminPeople'
import styles from './App.module.css'

const PUBLIC_TABS = [
  { id: 'dashboard',  label: 'Dashboard' },
  { id: 'kpis',       label: 'KPI Scorecard' },
  { id: 'log',        label: 'Weekly Log' },
  { id: 'people',     label: 'People' },
  { id: 'financials', label: 'Financials' },
  { id: 'wip',        label: 'WIP & Schedule' },
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

function getWeekStart(date = new Date()) {
  return startOfWeek(date, { weekStartsOn: 1 })
}
function weekKey(date) { return format(date, 'yyyy-MM-dd') }

export default function App() {
  const [activeTab, setActiveTab]     = useState('dashboard')
  const [currentWeek, setCurrentWeek] = useState(getWeekStart())
  const [weekData, setWeekData]       = useState(null)
  const [loading, setLoading]         = useState(true)
  const [dbReady, setDbReady]         = useState(true)
  const [adminSection, setAdminSection] = useState('main')

  const [notifying, setNotifying]         = useState(false)
  const [notifySuccess, setNotifySuccess] = useState(false)
  const [sessionCommentCount, setSessionCommentCount] = useState(0)
  const sessionCommentsRef = useRef([])
  const sessionStartRef    = useRef(null)

  const [authUser, setAuthUser]           = useState(null)
  const [userProfile, setUserProfile]     = useState(null)
  const [authLoading, setAuthLoading]     = useState(true)
  const isAdmin = userProfile?.role === 'admin'
  const [adminAuthenticated, setAdminAuthenticated] = useState(false)

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
    sessionStartRef.current = null
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
    const key = weekKey(currentWeek)
    const payload = { week_start: key, updated_at: new Date().toISOString(), ...updates }
    const { data, error } = await supabase.from('weeks').upsert(payload, { onConflict: 'week_start' }).select().single()
    if (!error && data) setWeekData(data)
    return { data, error }
  }

  function onCommentPosted(commentId) {
    sessionCommentsRef.current = [...sessionCommentsRef.current, commentId]
    setSessionCommentCount(sessionCommentsRef.current.length)
    // Track session start time on first comment
    if (!sessionStartRef.current) sessionStartRef.current = new Date(Date.now() - 2000).toISOString()
  }

  async function handleNotifySlack() {
    const myName = userProfile?.full_name || localStorage.getItem('pp_commenter') || ''
    if (!myName) return
    if (sessionCommentsRef.current.length === 0) return
    setNotifying(true)
    const key = weekKey(currentWeek)
    // Fetch by real IDs where possible, fall back to author+week+session window
    const realIds = sessionCommentsRef.current.filter(id => !String(id).startsWith('local-'))
    let comments = []
    if (realIds.length > 0) {
      const { data } = await supabase
        .from('section_comments')
        .select('*')
        .in('id', realIds)
        .order('created_at', { ascending: true })
      comments = data || []
    }
    // Also fetch any recent comments by this author this session (catches local- ids)
    if (comments.length < sessionCommentsRef.current.length && sessionStartRef.current) {
      const { data: recent } = await supabase
        .from('section_comments')
        .select('*')
        .eq('week_start', key)
        .eq('author', myName)
        .gte('created_at', sessionStartRef.current)
        .order('created_at', { ascending: true })
      if (recent) {
        const existingIds = new Set(comments.map(c => c.id))
        comments = [...comments, ...recent.filter(c => !existingIds.has(c.id))]
      }
    }
    if (comments && comments.length > 0) {
      const wkLabel = `Week of ${format(currentWeek, 'MMMM d, yyyy')}`
      try {
        await fetch('/api/slack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author: myName, weekLabel: wkLabel, comments, dashboardUrl: window.location.origin }),
        })
      } catch (e) { console.error('Slack notify failed:', e) }
    }
    sessionCommentsRef.current = []
    sessionStartRef.current = null
    setSessionCommentCount(0)
    setNotifying(false)
    setNotifySuccess(true)
    setTimeout(() => setNotifySuccess(false), 3000)
  }

  function handleGearClick() {
    if (isAdmin) { setAdminSection('main'); setActiveTab('admin') }
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    localStorage.removeItem('pp_commenter')
    setAuthUser(null); setUserProfile(null); setAdminAuthenticated(false)
    setActiveTab('dashboard')
  }

  function handleLogin(user, profile) {
    setAuthUser(user)
    setUserProfile(profile)
    if (profile?.full_name) localStorage.setItem('pp_commenter', profile.full_name)
    if (profile?.role === 'admin') setAdminAuthenticated(true)
  }

  const weekLabel   = `Week of ${format(currentWeek, 'MMMM d, yyyy')}`
  const fiscalLabel = getFiscalLabel(currentWeek)
  const allTabs     = PUBLIC_TABS

  if (authLoading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--cream)' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <span style={{ width: 8, height: 8, background: 'var(--ink-30)', borderRadius: '50%', animation: 'bounce 1.2s ease-in-out infinite' }} />
        <span style={{ width: 8, height: 8, background: 'var(--ink-30)', borderRadius: '50%', animation: 'bounce 1.2s ease-in-out 0.2s infinite' }} />
        <span style={{ width: 8, height: 8, background: 'var(--ink-30)', borderRadius: '50%', animation: 'bounce 1.2s ease-in-out 0.4s infinite' }} />
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
            <img src="/ParamountLogo.png" alt="Paramount Prints" style={{ height: 64, width: 'auto', display: 'block' }} />
            <p style={{ margin: 0, marginTop: 4, fontSize: 15, fontWeight: 700, fontFamily: 'Georgia, serif', color: 'var(--ink)' }}>Executive Operations Dashboard</p>
          </div>
          <div className={styles.weekNav}>
            <button onClick={() => setCurrentWeek(w => subWeeks(w, 1))} className={styles.weekBtn}>←</button>
            <div className={styles.weekLabelStack}>
              <span className={styles.weekLabel}>{weekLabel}</span>
              {fiscalLabel && <span className={styles.fiscalLabel}>{fiscalLabel}</span>}
            </div>
            <button onClick={() => setCurrentWeek(w => addWeeks(w, 1))} className={styles.weekBtn}>→</button>
            <button onClick={() => setCurrentWeek(getWeekStart())} className={styles.weekTodayBtn}>This week</button>
          </div>
          <div className={styles.headerRight}>
            <div className={styles.sendUpdateArea}>
              {notifySuccess ? (
                <span className={styles.sendSuccessMsg}>✓ Slack notified</span>
              ) : (
                <button
                  className={`${styles.sendUpdateBtn} ${sessionCommentCount > 0 ? styles.sendUpdateBtnActive : ''}`}
                  onClick={handleNotifySlack}
                  disabled={notifying || sessionCommentCount === 0}
                  title={sessionCommentCount > 0 ? `Notify Slack about ${sessionCommentCount} comment${sessionCommentCount !== 1 ? 's' : ''}` : 'Post comments first, then notify Slack'}
                >
                  <SlackIcon size={14} />
                  {notifying ? 'Notifying…' : sessionCommentCount > 0 ? `Notify Slack (${sessionCommentCount})` : 'Notify Slack'}
                </button>
              )}
            </div>
            {isAdmin && (
              <button className={`${styles.gearBtn} ${styles.gearBtnActive}`} onClick={handleGearClick} title="Admin panel">⚙</button>
            )}
          </div>
        </div>

        {!dbReady && (
          <div className={styles.setupBanner}>
            <strong>Setup required:</strong> Connect your Supabase database.
          </div>
        )}

        <nav className={styles.nav}>
          {allTabs.map(t => (
            <button
              key={t.id}
              className={`${styles.navTab} ${activeTab === t.id ? styles.navTabActive : ''} ${t.id === 'admin' ? styles.navTabAdmin : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <div className={styles.navUserArea}>
            <span className={styles.navUserName}>{userProfile?.full_name?.split(' ')[0]}</span>
            <button className={styles.signOutBtn} onClick={handleSignOut}>Sign out</button>
          </div>
        </nav>
      </header>

      <main className={styles.main}>
        {loading ? (
          <div className={styles.loading}><div className={styles.loadingDots}><span /><span /><span /></div></div>
        ) : (
          <>
            {activeTab === 'dashboard'      && <ProductionDashboard weekStart={currentWeek} dbReady={dbReady} readOnly {...commentProps} />}
            {activeTab === 'log'            && <WeeklyLog weekData={weekData} weekStart={currentWeek} onSave={saveWeekData} dbReady={dbReady} readOnly {...commentProps} />}
            {activeTab === 'kpis'           && <KPIScorecard weekData={weekData} weekStart={currentWeek} onSave={saveWeekData} dbReady={dbReady} readOnly {...commentProps} />}
            {activeTab === 'people'         && <PeopleTab weekStart={weekKey(currentWeek)} readOnly={true} {...commentProps} />}
            {activeTab === 'financials'     && <FinancialTab weekStart={currentWeek} currentPeriod={format(currentWeek, 'yyyy-MM-dd').slice(0,7)} />}
            {activeTab === 'wip'            && <WIPTab />}

            {activeTab === 'admin' && adminAuthenticated && (
              <>
                <div style={{ marginBottom: '1rem', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {[
                    { id: 'main',          label: 'Production / KPI / Log' },
                    { id: 'people',        label: 'People Upload' },
                    { id: 'correspondence',label: 'Correspondence' },
                    { id: 'history',       label: 'History' },
                  ].map(s => (
                    <button key={s.id} onClick={() => setAdminSection(s.id)} style={{ padding: '6px 14px', fontSize: 13, borderRadius: 8, cursor: 'pointer', background: adminSection === s.id ? '#1a1a1a' : 'transparent', color: adminSection === s.id ? '#fff' : '#888', border: '0.5px solid ' + (adminSection === s.id ? '#1a1a1a' : 'rgba(0,0,0,0.2)') }}>{s.label}</button>
                  ))}
                </div>
                {adminSection === 'main'          && <AdminPanel weekStart={currentWeek} weekData={weekData} onSave={saveWeekData} dbReady={dbReady} />}
                {adminSection === 'people'        && <AdminPeople weekStart={weekKey(currentWeek)} currentUser={userProfile} onSaved={() => { setAdminSection('main'); setActiveTab('people') }} />}
                {adminSection === 'correspondence'&& <Correspondence weekStart={currentWeek} dbReady={dbReady} {...commentProps} />}
                {adminSection === 'history'       && <HistoryPanel onSelectWeek={(w) => { setCurrentWeek(new Date(w + 'T12:00:00')); setAdminSection('main') }} />}
              </>
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
