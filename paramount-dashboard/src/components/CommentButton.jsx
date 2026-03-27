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

export default function CommentButton({ weekStart, section, label, sendVersion, currentUser }) {
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState([])
  const [text, setText] = useState('')
  const [author] = useState(() => currentUser || localStorage.getItem('pp_commenter') || '')
  const [notify, setNotify] = useState([])
  const [sending, setSending] = useState(false)
  const [sentCount, setSentCount] = useState(0)
  const [draftCount, setDraftCount] = useState(0)
  const [replyingTo, setReplyingTo] = useState(null) // comment id being replied to
  const [replyText, setReplyText] = useState('')
  const panelRef = useRef(null)
  const commentsEndRef = useRef(null)
  const weekKey = format(weekStart, 'yyyy-MM-dd')
  const sessionKey = `pp_session_${weekKey}`
  const resolvedAuthor = currentUser || localStorage.getItem('pp_commenter') || ''

  useEffect(() => { loadComments() }, [weekStart, section])
  useEffect(() => { if (sendVersion > 0) { setOpen(false); setText(''); setNotify([]) } }, [sendVersion])

  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  useEffect(() => {
    if (open) setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }, [open, comments.length])

  async function loadComments() {
    const { data } = await supabase
      .from('section_comments')
      .select('*')
      .eq('week_start', weekKey)
      .eq('section', section)
      .order('created_at', { ascending: true })
    const all = data || []
    const visible = all.filter(c =>
      c.status === 'sent' || (c.status === 'draft' && c.author === resolvedAuthor)
    )
    setComments(visible)
    setSentCount(all.filter(c => c.status === 'sent').length)
    setDraftCount(all.filter(c => c.status === 'draft' && c.author === resolvedAuthor).length)
  }

  async function submit() {
    if (!text.trim() || !resolvedAuthor) return
    setSending(true)
    const commentText = text.trim()
    const notifyNames = [...notify]
    setText('')
    setNotify([])
    const { data: existing } = await supabase
      .from('section_comments').select('id')
      .eq('week_start', weekKey).eq('section', section)
      .eq('author', resolvedAuthor).eq('text', commentText).eq('status', 'draft')
      .maybeSingle()
    if (existing) { loadComments(); setSending(false); return }
    const comment = {
      week_start: weekKey, section, section_label: label,
      author: resolvedAuthor, text: commentText,
      notify_names: notifyNames, status: 'draft',
      created_at: new Date().toISOString(),
    }
    const { data } = await supabase.from('section_comments').insert(comment).select().single()
    if (data) {
      const sessionComments = JSON.parse(localStorage.getItem(sessionKey) || '[]')
      sessionComments.push(data.id)
      localStorage.setItem(sessionKey, JSON.stringify(sessionComments))
    }
    setSending(false)
    loadComments()
  }

  async function submitReply(parentId) {
    if (!replyText.trim() || !resolvedAuthor) return
    setSending(true)
    const replyComment = {
      week_start: weekKey, section, section_label: label,
      author: resolvedAuthor, text: replyText.trim(),
      notify_names: [], status: 'draft',
      parent_id: parentId,
      created_at: new Date().toISOString(),
    }
    const { data } = await supabase.from('section_comments').insert(replyComment).select().single()
    if (data) {
      const sessionComments = JSON.parse(localStorage.getItem(sessionKey) || '[]')
      sessionComments.push(data.id)
      localStorage.setItem(sessionKey, JSON.stringify(sessionComments))
    }
    setReplyText('')
    setReplyingTo(null)
    setSending(false)
    loadComments()
  }

  async function deleteDraft(id) {
    await supabase.from('section_comments').delete().eq('id', id)
    const sessionComments = JSON.parse(localStorage.getItem(sessionKey) || '[]')
    localStorage.setItem(sessionKey, JSON.stringify(sessionComments.filter(s => s !== id)))
    loadComments()
  }

  function toggleNotify(name) {
    setNotify(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }

  // Separate top-level comments from replies
  const topLevel = comments.filter(c => !c.parent_id)
  const replies = comments.filter(c => c.parent_id)

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
            <div className={styles.panelTitleArea}>
              <SlackIcon size={12} />
              <span className={styles.panelTitle}>{label}</span>
              {sentCount > 0 && <span className={styles.panelCount}>{sentCount} comment{sentCount !== 1 ? 's' : ''}</span>}
            </div>
            <button className={styles.closeBtn} onClick={() => setOpen(false)}>×</button>
          </div>

          <div className={styles.commentList}>
            {topLevel.length === 0 ? (
              <p className={styles.empty}>No comments yet — be the first</p>
            ) : topLevel.map(c => {
              const threadReplies = replies.filter(r => r.parent_id === c.id)
              return (
                <div key={c.id} className={styles.commentThread}>
                  {/* Main comment */}
                  <div className={`${styles.comment} ${c.status === 'draft' ? styles.commentDraft : ''}`}>
                    <div className={styles.commentMeta}>
                      <span className={styles.commentAvatar}>{c.author.split(' ').map(n => n[0]).join('').slice(0,2)}</span>
                      <div className={styles.commentMetaRight}>
                        <div className={styles.commentMetaTop}>
                          <strong>{c.author}</strong>
                          <span className={styles.commentTime}>{new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                          {c.status === 'draft' && <span className={styles.draftBadge}>draft</span>}
                          {c.status === 'draft' && c.author === resolvedAuthor && (
                            <button className={styles.deleteBtn} onClick={() => deleteDraft(c.id)} title="Delete draft">✕</button>
                          )}
                        </div>
                        {c.notify_names?.length > 0 && <span className={styles.notified}>→ {c.notify_names.join(', ')}</span>}
                      </div>
                    </div>
                    <p className={styles.commentText}>{c.text}</p>
                    <button className={styles.replyBtn} onClick={() => setReplyingTo(replyingTo === c.id ? null : c.id)}>
                      {replyingTo === c.id ? 'Cancel' : '↩ Reply'}
                    </button>
                  </div>

                  {/* Replies */}
                  {threadReplies.length > 0 && (
                    <div className={styles.replyList}>
                      {threadReplies.map(r => (
                        <div key={r.id} className={`${styles.reply} ${r.status === 'draft' ? styles.commentDraft : ''}`}>
                          <div className={styles.commentMeta}>
                            <span className={`${styles.commentAvatar} ${styles.commentAvatarSmall}`}>{r.author.split(' ').map(n => n[0]).join('').slice(0,2)}</span>
                            <div className={styles.commentMetaRight}>
                              <div className={styles.commentMetaTop}>
                                <strong>{r.author}</strong>
                                <span className={styles.commentTime}>{new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                                {r.status === 'draft' && <span className={styles.draftBadge}>draft</span>}
                                {r.status === 'draft' && r.author === resolvedAuthor && (
                                  <button className={styles.deleteBtn} onClick={() => deleteDraft(r.id)} title="Delete draft">✕</button>
                                )}
                              </div>
                            </div>
                          </div>
                          <p className={styles.commentText}>{r.text}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Reply input */}
                  {replyingTo === c.id && (
                    <div className={styles.replyForm}>
                      <textarea
                        placeholder={`Reply as ${resolvedAuthor}…`}
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        rows={2}
                        className={styles.textInput}
                        autoFocus
                      />
                      <div className={styles.replyFormActions}>
                        <button onClick={() => { setReplyingTo(null); setReplyText('') }}>Cancel</button>
                        <button className="primary" onClick={() => submitReply(c.id)} disabled={sending || !replyText.trim()}>
                          {sending ? 'Saving…' : 'Save Reply'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            <div ref={commentsEndRef} />
          </div>

          <div className={styles.form}>
            <div className={styles.authorDisplay}>
              Commenting as <strong>{resolvedAuthor || 'Unknown'}</strong>
            </div>
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
                  <button key={t.name} type="button"
                    className={`${styles.notifyBtn} ${notify.includes(t.name) ? styles.notifyBtnActive : ''}`}
                    onClick={() => toggleNotify(t.name)}>
                    {t.name.split(' ')[0]}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className={`primary ${styles.submitBtn}`} onClick={submit} disabled={sending || !text.trim() || !resolvedAuthor}>
              {sending ? 'Saving…' : 'Save Draft'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
