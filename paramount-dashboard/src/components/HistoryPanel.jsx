import React, { useState, useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import { supabase } from '../supabase'
import styles from './HistoryPanel.module.css'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

export default function HistoryPanel({ onSelectWeek }) {
  const [weeks, setWeeks] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    loadHistory()
  }, [])

  async function loadHistory() {
    setLoading(true)
    const { data } = await supabase
      .from('weeks')
      .select('*')
      .order('week_start', { ascending: false })
      .limit(52)
    setWeeks(data || [])
    setLoading(false)
  }

  function getOverallStatus(weekData) {
    if (!weekData?.kpis) return 'gray'
    const statuses = Object.values(weekData.kpis).map(k => k.status)
    if (statuses.includes('red')) return 'red'
    if (statuses.includes('amber')) return 'amber'
    if (statuses.some(s => s === 'green')) return 'green'
    return 'gray'
  }

  function getDayEntries(weekData) {
    if (!weekData?.days) return []
    return DAYS.filter(d => weekData.days[d]?.text?.trim())
  }

  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.sectionTitle}>History</h2>
          <p className={styles.sectionSub}>All saved weekly updates — click any week to open it</p>
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--ink-60)', fontSize: 13 }}>Loading…</p>
      ) : weeks.length === 0 ? (
        <div className={styles.empty}>
          <p>No weeks saved yet.</p>
          <p style={{ marginTop: 6, fontSize: 13 }}>Complete your first weekly log and save it to start building your track record.</p>
        </div>
      ) : (
        <div className={styles.list}>
          {weeks.map(week => {
            const status = getOverallStatus(week)
            const dayEntries = getDayEntries(week)
            const kpiData = week.kpis || {}
            const concerns = week.concerns || ''
            const isExpanded = expanded === week.week_start
            const weekDate = parseISO(week.week_start + 'T12:00:00')

            return (
              <div key={week.week_start} className={`${styles.weekCard} ${styles[`weekCard_${status}`]}`}>
                <div className={styles.weekTop} onClick={() => setExpanded(isExpanded ? null : week.week_start)}>
                  <div className={styles.weekLeft}>
                    <span className={`dot dot-${status}`} />
                    <div>
                      <div className={styles.weekTitle}>Week of {format(weekDate, 'MMMM d, yyyy')}</div>
                      <div className={styles.weekMeta}>
                        {dayEntries.length > 0
                          ? `Entries: ${dayEntries.map(d => d.slice(0, 3)).join(', ')}`
                          : 'No daily entries'}
                        {week.updated_at && ` · Saved ${format(parseISO(week.updated_at), 'MMM d')}`}
                      </div>
                    </div>
                  </div>
                  <div className={styles.weekRight}>
                    <button
                      className={styles.openBtn}
                      onClick={e => { e.stopPropagation(); onSelectWeek(week.week_start) }}
                    >
                      Open ↗
                    </button>
                    <span className={styles.chevron}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className={`${styles.weekExpanded} fade-in`}>
                    {DAYS.map(day => {
                      const d = week.days?.[day]
                      if (!d?.text) return null
                      return (
                        <div key={day} className={styles.dayEntry}>
                          <div className={styles.dayEntryHeader}>
                            <span className={`dot dot-${d.status || 'gray'}`} />
                            <strong>{day}</strong>
                          </div>
                          <p className={styles.dayEntryText}>{d.text}</p>
                        </div>
                      )
                    })}

                    {Object.entries(kpiData).filter(([, v]) => v.notes).length > 0 && (
                      <div className={styles.kpiSection}>
                        <div className={styles.kpiSectionTitle}>KPI Notes</div>
                        {Object.entries(kpiData).filter(([, v]) => v.notes).map(([id, v]) => (
                          <div key={id} className={styles.kpiEntry}>
                            <span className={`dot dot-${v.status}`} />
                            <span className={styles.kpiEntryName}>{id}</span>
                            <span className={styles.kpiEntryNote}>{v.notes}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {concerns && (
                      <div className={styles.concernsEntry}>
                        <div className={styles.kpiSectionTitle}>Flags / Concerns</div>
                        <p style={{ fontSize: 13, color: 'var(--ink-60)', lineHeight: 1.6, marginTop: 6 }}>{concerns}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
