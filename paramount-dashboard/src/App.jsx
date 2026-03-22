import React, { useState, useEffect } from 'react'
import { format, startOfWeek, addWeeks, subWeeks } from 'date-fns'
import { supabase } from './supabase'
import { getFiscalLabel } from './fiscalCalendar'
import WeeklyLog from './components/WeeklyLog'
import KPIScorecard from './components/KPIScorecard'
import Correspondence from './components/Correspondence'
import HistoryPanel from './components/HistoryPanel'
import ProductionDashboard from './components/ProductionDashboard'
import styles from './App.module.css'

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

  useEffect(() => {
    loadWeek(currentWeek)
  }, [currentWeek])

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
    const payload = {
      week_start: key,
      updated_at: new Date().toISOString(),
      ...updates,
    }
    const { data, error } = await supabase
      .from('weeks')
      .upsert(payload, { onConflict: 'week_start' })
      .select()
      .single()

    if (!error && data) setWeekData(data)
    return { data, error }
  }

  const weekLabel = `Week of ${format(currentWeek, 'MMMM d, yyyy')}`
  const fiscalLabel = getFiscalLabel(currentWeek)

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
            <div className={styles.loadingDots}>
              <span /><span /><span />
            </div>
          </div>
        ) : (
          <>
            {activeTab === 'dashboard' && (
              <ProductionDashboard
                weekStart={currentWeek}
                dbReady={dbReady}
              />
            )}
            {activeTab === 'log' && (
              <WeeklyLog
                weekData={weekData}
                weekStart={currentWeek}
                onSave={saveWeekData}
                dbReady={dbReady}
              />
            )}
            {activeTab === 'kpis' && (
              <KPIScorecard
                weekData={weekData}
                weekStart={currentWeek}
                onSave={saveWeekData}
                dbReady={dbReady}
              />
            )}
            {activeTab === 'correspondence' && (
              <Correspondence
                weekStart={currentWeek}
                dbReady={dbReady}
              />
            )}
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
