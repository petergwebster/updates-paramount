import React, { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import CommentButton from './CommentButton'
import styles from './WeeklyLog.module.css'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

const STATUS_OPTIONS = [
  { value: 'green', label: 'On Track' },
  { value: 'amber', label: 'Watch' },
  { value: 'red',   label: 'Concern' },
  { value: 'gray',  label: 'No Update' },
]

function getDefaultDays() {
  return Object.fromEntries(DAYS.map(d => [d, { text: '', status: 'gray' }]))
}

export default function WeeklyLog({ weekData, weekStart, onSave, dbReady, readOnly = false, currentUser, onCommentPosted }) {
  const [days, setDays]           = useState(getDefaultDays())
  const [concerns, setConcerns]   = useState('')
  const [activeDay, setActiveDay] = useState('Monday')
  const [saving, setSaving]       = useState(false)
  const [saved, setSaved]         = useState(false)

  useEffect(() => {
    if (weekData) {
      setDays(weekData.days || getDefaultDays())
      setConcerns(weekData.concerns || '')
    } else {
      setDays(getDefaultDays())
      setConcerns('')
    }
  }, [weekData])

  async function handleSave() {
    setSaving(true)
    await onSave({ days, concerns })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  function updateDay(field, value) {
    setDays(prev => ({ ...prev, [activeDay]: { ...prev[activeDay], [field]: value } }))
  }

  const activeDayData = days[activeDay] || { text: '', status: 'gray' }
  const weekKey = format(weekStart, 'yyyy-MM-dd')

  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.sectionTitle}>Weekly Log</h2>
          <p className={styles.sectionSub}>Daily activity, meetings, decisions & follow-ups</p>
        </div>
        <div className={styles.saveRow}>
          {!readOnly && saved && <span className={styles.savedMsg}>Saved</span>}
          {!readOnly && (
            <button className="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Week'}
            </button>
          )}
        </div>
      </div>

      {/* Day tabs */}
      <div className={styles.dayTabs}>
        {DAYS.map(day => {
          const d = days[day] || { text: '', status: 'gray' }
          return (
            <button
              key={day}
              className={`${styles.dayTab} ${activeDay === day ? styles.dayTabActive : ''}`}
              onClick={() => setActiveDay(day)}
            >
              <span className={`dot dot-${d.status}`} style={{ marginRight: 6 }} />
              {day.slice(0, 3)}
              {d.text && <span className={styles.dayHasEntry} />}
            </button>
          )
        })}
      </div>

      {/* Active day panel */}
      <div className={`${styles.dayPanel} fade-in`} key={activeDay}>
        <div className={styles.dayHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 className={styles.dayTitle}>{activeDay}</h3>
            {/* Comment button per day */}
            <CommentButton
              weekStart={weekStart}
              section={`log-${activeDay.toLowerCase()}`}
              label={`${activeDay} Log`}
              currentUser={currentUser}
              onCommentPosted={onCommentPosted}
            />
          </div>
          {!readOnly && (
            <div className={styles.statusRow}>
              <span className="label" style={{ marginBottom: 0, marginRight: 8 }}>Status</span>
              {STATUS_OPTIONS.map(s => (
                <button
                  key={s.value}
                  className={`${styles.statusBtn} ${activeDayData.status === s.value ? styles[`statusActive_${s.value}`] : ''}`}
                  onClick={() => updateDay('status', s.value)}
                >
                  <span className={`dot dot-${s.value}`} />
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <textarea
          className={styles.dayTextarea}
          value={activeDayData.text}
          onChange={e => !readOnly && updateDay('text', e.target.value)}
          readOnly={readOnly}
          placeholder={`Log ${activeDay}'s activities, meetings, decisions, and follow-ups…\n\nExample:\n• Town Hall with Wendy, Brynn, Chandler — WIP review, cost focus\n• Hugh from Ulster visited — pricing review upcoming\n• Rotary head repair with Bob from Screentrans`}
          rows={10}
        />
      </div>

      {/* Areas of concern */}
      <div className={styles.concernsPanel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span className="label" style={{ margin: 0, userSelect: 'none' }}>Areas of Concern</span>
          <CommentButton
            weekStart={weekStart}
            section="log-concerns"
            label="Areas of Concern"
            currentUser={currentUser}
            onCommentPosted={onCommentPosted}
          />
        </div>
        <textarea
          value={concerns}
          onChange={e => !readOnly && setConcerns(e.target.value)}
          readOnly={readOnly}
          placeholder="Anything requiring executive attention, decisions, or awareness this week…"
          rows={4}
        />
      </div>
    </div>
  )
}
