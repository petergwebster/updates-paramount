import React, { useState, useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import styles from './CommentButton.module.css'

const TEAM = [
  { name: 'Peter', email: 'peter@consultexllc.com' },
  { name: 'Timur', email: 'timur@fschumacher.com' },
  { name: 'Emily', email: 'emily@fschumacher.com' },
]

export default function CommentButton({ weekStart, section, label }) {
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState([])
  const [text, setText] = useState('')
  const [author, setAuthor] = useState(() => localStorage.getItem('pp_commenter') || '')
  const [notify, setNotify] = useState([])
  const [sending, setSending] = useState(false)
  const [count, setCount] = useState(0)
  const panelRef = useRef(null)
  const weekKey = format(weekStart, 'yyyy-MM-dd')

  useEffect(() => {
    loadComments()
  }, [weekStart, section])

  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function loadComments() {
    const { data } = await supabase
      .from('section_comments')
      .select('*')
      .eq('week_start', weekKey)
      .eq('section', section)
      .order('created_at', { ascending: true })
    setComments(data || [])
    setCount((data || []).length)
  }

  async function submit(e) {
    e.preventDefault()
    if (!text.trim()) return
    setSending(true)
    const name = author.trim() || 'Anonymous'
    localStorage.setItem('pp_commenter', name)

    const comment = {
      week_start: weekKey,
      section,
      section_label: label,
      author: name,
      text: text.trim(),
      notify_names: notify,
      created_at: new Date().toISOString(),
    }

    await supabase.from('section_comments').insert(comment)

    // Send email notifications
    if (notify.length > 0) {
      const recipients = TEAM.filter(t => notify.includes(t.name))
      try {
        await fetch('https://twsfmzohaymobqmmeayd.supabase.co/functions/v1/notify-comment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
          body: JSON.stringify({
            comment: comment,
            recipients,
            dashboardUrl: window.location.href,
          })
        })
      } catch (e) {
        console.log('Notification send attempted')
      }
    }

    setText('')
    setNotify([])
    setSending(false)
    loadComments()
  }

  function toggleNotify(name) {
    setNotify(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }

  return (
    <div className={styles.wrapper} ref={panelRef}>
      <button
        className={`${styles.trigger} ${count > 0 ? styles.triggerActive : ''}`}
        onClick={() => setOpen(o => !o)}
        title={`${count} comment${count !== 1 ? 's' : ''} on ${label}`}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="M14 1H2C1.45 1 1 1.45 1 2v9c0 .55.45 1 1 1h2v3l3-3h7c.55 0 1-.45 1-1V2c0-.55-.45-1-1-1z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
        </svg>
        {count > 0 && <span className={styles.badge}>{count}</span>}
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>{label}</span>
            <button className={styles.closeBtn} onClick={() => setOpen(false)}>×</button>
          </div>

          <div className={styles.commentList}>
            {comments.length === 0 ? (
              <p className={styles.empty}>No comments yet</p>
            ) : comments.map(c => (
              <div key={c.id} className={styles.comment}>
                <div className={styles.commentMeta}>
                  <strong>{c.author}</strong>
                  <span>{new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                  {c.notify_names?.length > 0 && <span className={styles.notified}>→ {c.notify_names.join(', ')}</span>}
                </div>
                <p className={styles.commentText}>{c.text}</p>
              </div>
            ))}
          </div>

          <form onSubmit={submit} className={styles.form}>
            <input
              type="text"
              placeholder="Your name"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              className={styles.nameInput}
            />
            <textarea
              placeholder="Add a comment…"
              value={text}
              onChange={e => setText(e.target.value)}
              rows={3}
              className={styles.textInput}
            />
            <div className={styles.notifyRow}>
              <span className={styles.notifyLabel}>Notify:</span>
              {TEAM.map(t => (
                <button
                  key={t.name}
                  type="button"
                  className={`${styles.notifyBtn} ${notify.includes(t.name) ? styles.notifyBtnActive : ''}`}
                  onClick={() => toggleNotify(t.name)}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <button type="submit" className={`primary ${styles.submitBtn}`} disabled={sending || !text.trim()}>
              {sending ? 'Sending…' : notify.length > 0 ? `Send & Notify ${notify.join(', ')}` : 'Post Comment'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
