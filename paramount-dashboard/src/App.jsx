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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
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

  useEffect(() => { loadWeek(currentWeek) }, [currentWeek])
  useEffect(() => { checkDrafts() }, [currentWeek])

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
    setTimeout(() => setSendSuccess(false), 3000)
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
