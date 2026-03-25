import React, { useState, useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import styles from './CommentButton.module.css'

export const TEAM = [
  { name: 'Peter Webster' },
  { name: 'Timur Y' },
  { name: 'Antonella Pilo' },
  { name: 'Abigail Pratt' },
  { name: 'Emily Huber' },
  { name: 'Brynn Lawlor' },
  { name: 'Wendy Reger-Hare' },
  { name: 'Estephanie Soto-Martinez' },
]

function SlackIcon({ size = 13 }) {
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

export default function CommentButton({ weekStart, section, label, sendVersion }) {
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState([])
  const [text, setText] = useState('')
  const [author, setAuthor] = useState(() => localStorage.getItem('pp_commenter') || '')
  const [notify, setNotify] = useState([])
  const [sending, setSending] = useState(false)
  const [sentCount, setSentCount] = useState(0)
  const [draftCount, setDraftCount] = useState(0)
  const panelRef = useRef(null)
  const weekKey = format(weekStart, 'yyyy-MM-dd')
  const sessionKey = `pp_session_${weekKey}`

  useEffect(() => { loadComments() }, [weekStart, section])
  // Close panel and reset when a send completes
  useEffect(() => { if (sendVersion > 0) { setOpen(false); setText(''); setNotify([]) } }, [sendVersion])

  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function loadComments() {
    const myName = localStorage.getItem('pp_commenter') || ''
    const { data } = await supabase
      .from('section_comments')
      .select('*')
      .eq('week_start', weekKey)
      .eq('section', section)
      .order('created_at', { ascending: true })
    const all = data || []
    const visible = all.filter(c =>
      c.status === 'sent' || (c.status === 'draft' && c.author === myName)
    )
    setComments(visible)
    setSentCount(all.filter(c => c.status === 'sent').length)
    setDraftCount(all.filter(c => c.status === 'draft' && c.author === myName).length)
  }

  async function submit(e) {
    e.preventDefault()
    console.log('CommentButton submit called, text:', text, 'author:', author, 'section:', section)
    if (!text.trim() || !author) return
    setSending(true)
    localStorage.setItem('pp_commenter', author)
    const sessionComments = JSON.parse(localStorage.getItem(sessionKey) || '[]')
    const commentText = text.trim()
    const notifyNames = [...notify]
    // Clear form immediately before async operations to prevent double-submit
    setText('')
    setNotify([])
    // Guard: don't insert if identical draft already exists
    const { data: existing } = await supabase
      .from('section_comments')
      .select('id')
      .eq('week_start', weekKey)
      .eq('section', section)
      .eq('author', author)
      .eq('text', commentText)
      .eq('status', 'draft')
      .maybeSingle()
    if (existing) { loadComments(); return }
    setSending(true)
    const comment = {
      week_start: weekKey,
      section,
      section_label: label,
      author,
      text: commentText,
      notify_names: notifyNames,
      status: 'draft',
      created_at: new Date().toISOString(),
    }
    const { data } = await supabase.from('section_comments').insert(comment).select().single()
    if (data) {
      sessionComments.push(data.id)
      localStorage.setItem(sessionKey, JSON.stringify(sessionComments))
    }
    setSending(false)
    loadComments()
  }

  function toggleNotify(name) {
    setNotify(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }

  return (
    <div className={styles.wrapper} ref={panelRef}>
      <button
        className={`${styles.trigger} ${sentCount > 0 ? styles.triggerActive : ''} ${draftCount > 0 ? styles.triggerDraft : ''}`}
        onClick={() => setOpen(o => !o)}
        title={`${sentCount} comment${sentCount !== 1 ? 's' : ''}${draftCount > 0 ? ` · ${draftCount} draft` : ''} on ${label}`}
      >
        <SlackIcon size={13} />
        {sentCount > 0 && <span className={styles.badge}>{sentCount}</span>}
        {draftCount > 0 && <span className={styles.draftDot} />}
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
              <div key={c.id} className={`${styles.comment} ${c.status === 'draft' ? styles.commentDraft : ''}`}>
                <div className={styles.commentMeta}>
                  <strong>{c.author}</strong>
                  <span>{new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                  {c.status === 'draft' && <span className={styles.draftBadge}>draft</span>}
                  {c.notify_names?.length > 0 && <span className={styles.notified}>→ {c.notify_names.join(', ')}</span>}
                </div>
                <p className={styles.commentText}>{c.text}</p>
              </div>
            ))}
          </div>

          <form onSubmit={submit} className={styles.form}>
            <select
              value={author}
              onChange={e => { setAuthor(e.target.value); localStorage.setItem('pp_commenter', e.target.value) }}
              className={styles.nameInput}
            >
              <option value="">Select your name…</option>
              {TEAM.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            <textarea
              placeholder="Add a comment…"
              value={text}
              onChange={e => setText(e.target.value)}
              rows={3}
              className={styles.textInput}
            />
            <div className={styles.notifyRow}>
              <span className={styles.notifyLabel}>@mention:</span>
              <div className={styles.notifyBtns}>
                {TEAM.map(t => (
                  <button
                    key={t.name}
                    type="button"
                    className={`${styles.notifyBtn} ${notify.includes(t.name) ? styles.notifyBtnActive : ''}`}
                    onClick={() => toggleNotify(t.name)}
                  >
                    {t.name.split(' ')[0]}
                  </button>
                ))}
              </div>
            </div>
            <button type="submit" className={`primary ${styles.submitBtn}`} disabled={sending || !text.trim() || !author}>
              {sending ? 'Saving…' : 'Save Draft'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
