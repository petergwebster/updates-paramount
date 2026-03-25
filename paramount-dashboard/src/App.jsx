import React, { useState, useEffect, useCallback } from 'react'
import { format, startOfWeek, addWeeks, subWeeks } from 'date-fns'
import { supabase } from './supabase'
import { getFiscalLabel } from './fiscalCalendar'
import WeeklyLog from './components/WeeklyLog'
import KPIScorecard from './components/KPIScorecard'
import Correspondence from './components/Correspondence'
import HistoryPanel from './components/HistoryPanel'
import ProductionDashboard from './components/ProductionDashboard'
import styles from './App.module.css'

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

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'kpis', label: 'KPI Scorecard' },
  { id: 'log', label: 'Weekly Log' },
  { id: 'correspondence', label: 'Correspondence' },
  { id: 'history', label: 'History' },
]

function getWeekStart(date = new Date()) {
  return startOfWeek(date, { weekStartsOn: 1 })
}

function weekKey(date) {
  return format(date, 'yyyy-MM-dd')
}

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [currentWeek, setCurrentWeek] = useState(getWeekStart())
  const [weekData, setWeekData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dbReady, setDbReady] = useState(true)
  const [draftCount, setDraftCount] = useState(0)
  const [sending, setSending] = useState(false)
  const [sendSuccess, setSendSuccess] = useState(false)

  const justSentRef = React.useRef(false)

  useEffect(() => { loadWeek(currentWeek) }, [currentWeek])
  useEffect(() => { checkDrafts() }, [currentWeek])
  useEffect(() => {
    const interval = setInterval(() => {
      if (!justSentRef.current) checkDrafts()
    }, 5000)
    return () => clearInterval(interval)
  }, [currentWeek])

  async function checkDrafts() {
    const key = weekKey(currentWeek)
    const myName = localStorage.getItem('pp_commenter') || ''
    if (!myName) { setDraftCount(0); return }
    const { data } = await supabase
      .from('section_comments')
      .select('id')
      .eq('week_start', key)
      .eq('status', 'draft')
      .eq('author', myName)
    setDraftCount((data || []).length)
  }

  async function loadWeek(weekDate) {
    setLoading(true)
    const key = weekKey(weekDate)
    try {
      const { data, error } = await supabase
        .from('weeks')
        .select('*')
        .eq('week_start', key)
        .single()
      if (error && error.code !== 'PGRST116') {
        console.error('Load error:', error)
        setDbReady(false)
      } else {
        setDbReady(true)
        setWeekData(data || null)
      }
    } catch (e) {
      setDbReady(false)
    }
    setLoading(false)
  }

  async function saveWeekData(updates) {
    const key = weekKey(currentWeek)
    const payload = { week_start: key, updated_at: new Date().toISOString(), ...updates }
    const { data, error } = await supabase
      .from('weeks')
      .upsert(payload, { onConflict: 'week_start' })
      .select()
      .single()
    if (!error && data) setWeekData(data)
    return { data, error }
  }

  async function handleSendUpdate() {
    const myName = localStorage.getItem('pp_commenter') || ''
    if (!myName) { alert('Please open a comment box and select your name first.'); return }
    const key = weekKey(currentWeek)
    setSending(true)

    // Fetch all draft comments for this author this week
    const { data: drafts } = await supabase
      .from('section_comments')
      .select('*')
      .eq('week_start', key)
      .eq('status', 'draft')
      .eq('author', myName)
      .order('created_at', { ascending: true })

    if (!drafts || drafts.length === 0) {
      setSending(false)
      alert('No draft comments to send.')
      return
    }

    // Mark all drafts as sent
    const ids = drafts.map(d => d.id)
    await supabase.from('section_comments').update({ status: 'sent' }).in('id', ids)

    // Auto-archive public comments (no notify_names) to Correspondence
    const publicComments = drafts.filter(d => !d.notify_names || d.notify_names.length === 0)
    if (publicComments.length > 0) {
      const body = publicComments
        .map(c => `[${c.section_label}]\n${c.text}`)
        .join('\n\n')
      await supabase.from('correspondence').insert({
        week_start: key,
        subject: `${myName} — Dashboard Review`,
        contact: myName,
        contact_type: 'internal',
        direction: 'note',
        kpi_tag: 'General',
        body,
        created_at: new Date().toISOString(),
      })
    }

    // Send to Slack
    const weekLabel = `Week of ${format(currentWeek, 'MMMM d, yyyy')}`
    try {
      await fetch('/api/slack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: myName,
          weekLabel,
          comments: drafts,
          dashboardUrl: window.location.origin,
        }),
      })
    } catch (e) {
      console.log('Slack notification attempted')
    }

    // Clear session storage for this week
    localStorage.removeItem(`pp_session_${key}`)
    setDraftCount(0)
    setSending(false)
    setSendSuccess(true)
    // Reload after 2s to reset all component state cleanly
    setTimeout(() => { window.location.reload() }, 2000)
  }

  const weekLabel = `Week of ${format(currentWeek, 'MMMM d, yyyy')}`
  const fiscalLabel = getFiscalLabel(currentWeek)
  const myName = localStorage.getItem('pp_commenter') || ''

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.brand}>
            <span className={styles.brandMark}>PP</span>
            <div>
              <h1 className={styles.brandName}>Paramount Prints</h1>
              <p className={styles.brandSub}>Executive Operations Dashboard</p>
            </div>
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
          <div className={styles.sendUpdateArea}>
            {sendSuccess ? (
              <span className={styles.sendSuccessMsg}>✓ Sent to Slack</span>
            ) : (
              <button
                className={`${styles.sendUpdateBtn} ${draftCount > 0 ? styles.sendUpdateBtnActive : ''}`}
                onClick={handleSendUpdate}
                disabled={sending || draftCount === 0}
                title={draftCount > 0 ? `Send ${draftCount} draft comment${draftCount !== 1 ? 's' : ''} to Slack` : 'No drafts to send'}
              >
                <SlackIcon size={14} />
                {sending ? 'Sending…' : draftCount > 0 ? `Send Update (${draftCount})` : 'Send Update'}
              </button>
            )}
          </div>
        </div>

        {!dbReady && (
          <div className={styles.setupBanner}>
            <strong>Setup required:</strong> Connect your Supabase database — see <code>SETUP.md</code> for instructions.
          </div>
        )}

        <nav className={styles.nav}>
          {TABS.map(t => (
            <button
              key={t.id}
              className={`${styles.navTab} ${activeTab === t.id ? styles.navTabActive : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className={styles.main}>
        {loading ? (
          <div className={styles.loading}>
            <div className={styles.loadingDots}><span /><span /><span /></div>
          </div>
        ) : (
          <>
            {activeTab === 'dashboard' && <ProductionDashboard weekStart={currentWeek} dbReady={dbReady} />}
            {activeTab === 'log' && <WeeklyLog weekData={weekData} weekStart={currentWeek} onSave={saveWeekData} dbReady={dbReady} />}
            {activeTab === 'kpis' && <KPIScorecard weekData={weekData} weekStart={currentWeek} onSave={saveWeekData} dbReady={dbReady} />}
            {activeTab === 'correspondence' && <Correspondence weekStart={currentWeek} dbReady={dbReady} />}
            {activeTab === 'history' && (
              <HistoryPanel
                onSelectWeek={(w) => {
                  setCurrentWeek(new Date(w + 'T12:00:00'))
                  setActiveTab('dashboard')
                }}
              />
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
