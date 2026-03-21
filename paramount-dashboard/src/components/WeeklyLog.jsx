import React, { useState, useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import styles from './WeeklyLog.module.css'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

const STATUS_OPTIONS = [
  { value: 'green', label: 'On Track' },
  { value: 'amber', label: 'Watch' },
  { value: 'red', label: 'Concern' },
  { value: 'gray', label: 'No Update' },
]

function getDefaultDays() {
  return Object.fromEntries(DAYS.map(d => [d, { text: '', status: 'gray' }]))
}

export default function WeeklyLog({ weekData, weekStart, onSave, dbReady }) {
  const [days, setDays] = useState(getDefaultDays())
  const [concerns, setConcerns] = useState('')
  const [activeDay, setActiveDay] = useState('Monday')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [comments, setComments] = useState([])
  const [commentText, setCommentText] = useState('')
  const [commenterName, setCommenterName] = useState(() => localStorage.getItem('pp_commenter') || '')
  const [loadingComments, setLoadingComments] = useState(false)
  const commentsEndRef = useRef(null)

  useEffect(() => {
    if (weekData) {
      setDays(weekData.days || getDefaultDays())
      setConcerns(weekData.concerns || '')
    } else {
      setDays(getDefaultDays())
      setConcerns('')
    }
  }, [weekData])

  useEffect(() => {
    if (dbReady) {
      loadComments()
      const channel = supabase
        .channel(`comments-log-${format(weekStart, 'yyyy-MM-dd')}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'comments',
          filter: `week_start=eq.${format(weekStart, 'yyyy-MM-dd')}`,
        }, payload => {
          setComments(prev => [...prev, payload.new])
          setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
        })
        .subscribe()
      return () => supabase.removeChannel(channel)
    }
  }, [weekStart, dbReady])

  async function loadComments() {
    setLoadingComments(true)
    const { data } = await supabase
      .from('comments')
      .select('*')
      .eq('week_start', format(weekStart, 'yyyy-MM-dd'))
      .eq('section', 'log')
      .order('created_at', { ascending: true })
    setComments(data || [])
    setLoadingComments(false)
  }

  async function handleSave() {
    setSaving(true)
    await onSave({ days, concerns })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  async function submitComment(e) {
    e.preventDefault()
    if (!commentText.trim()) return
    const name = commenterName.trim() || 'Anonymous'
    localStorage.setItem('pp_commenter', name)
    await supabase.from('comments').insert({
      week_start: format(weekStart, 'yyyy-MM-dd'),
      section: 'log',
      author: name,
      text: commentText.trim(),
      created_at: new Date().toISOString(),
    })
    setCommentText('')
  }

  function updateDay(field, value) {
    setDays(prev => ({ ...prev, [activeDay]: { ...prev[activeDay], [field]: value } }))
  }

  const activeDayData = days[activeDay] || { text: '', status: 'gray' }

  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.sectionTitle}>Weekly Log</h2>
          <p className={styles.sectionSub}>Daily activity, meetings, decisions & follow-ups</p>
        </div>
        <div className={styles.saveRow}>
          {saved && <span className={styles.savedMsg}>Saved</span>}
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Week'}
          </button>
        </div>
      </div>

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

      <div className={`${styles.dayPanel} fade-in`} key={activeDay}>
        <div className={styles.dayHeader}>
          <h3 className={styles.dayTitle}>{activeDay}</h3>
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
        </div>
        <textarea
          className={styles.dayTextarea}
          value={activeDayData.text}
          onChange={e => updateDay('text', e.target.value)}
          placeholder={`Log ${activeDay}'s activities, meetings, decisions, and follow-ups…\n\nExample:\n• Town Hall with Wendy, Brynn, Chandler — WIP review, cost focus\n• Hugh from Ulster visited — pricing review upcoming\n• Rotary head repair with Bob from Screentrans`}
          rows={10}
        />
      </div>

      <div className={styles.concernsPanel}>
        <label className="label">Areas of Concern / Flags for Timur & Emily</label>
        <textarea
          value={concerns}
          onChange={e => setConcerns(e.target.value)}
          placeholder="Anything requiring executive attention, decisions, or awareness this week…"
          rows={4}
          style={{ marginTop: 6 }}
        />
      </div>

      <div className={styles.commentsSection}>
        <h3 className={styles.commentsTitle}>Comments & Responses</h3>
        <p className={styles.commentsSub}>Timur, Emily, or anyone on the team can respond here — comments are timestamped and permanent.</p>

        <div className={styles.commentsList}>
          {loadingComments ? (
            <p style={{ color: 'var(--ink-60)', fontSize: 13 }}>Loading…</p>
          ) : comments.length === 0 ? (
            <p style={{ color: 'var(--ink-60)', fontSize: 13 }}>No comments yet this week.</p>
          ) : (
            comments.map(c => (
              <div key={c.id} className={styles.commentItem}>
                <div className={styles.commentMeta}>
                  <strong>{c.author}</strong>
                  <span>{new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                <p className={styles.commentText}>{c.text}</p>
              </div>
            ))
          )}
          <div ref={commentsEndRef} />
        </div>

        <form className={styles.commentForm} onSubmit={submitComment}>
          <input
            type="text"
            placeholder="Your name (e.g. Timur, Emily, Peter)"
            value={commenterName}
            onChange={e => setCommenterName(e.target.value)}
            style={{ width: 200, flexShrink: 0 }}
          />
          <input
            type="text"
            placeholder="Add a comment or response…"
            value={commentText}
            onChange={e => setCommentText(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" className="primary" disabled={!commentText.trim()}>Post</button>
        </form>
      </div>
    </div>
  )
}
