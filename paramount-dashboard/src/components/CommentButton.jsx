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

export default function CommentButton({ weekStart, section, label, currentUser }) {
  const [open, setOpen]           = useState(false)
  const [comments, setComments]   = useState([])
  const [text, setText]           = useState('')
  const [notify, setNotify]       = useState([])
  const [posting, setPosting]     = useState(false)
  const [replyingTo, setReplyingTo] = useState(null)
  const [replyText, setReplyText] = useState('')
  const panelRef      = useRef(null)
  const commentsEndRef = useRef(null)

  const weekKey       = format(weekStart, 'yyyy-MM-dd')
  const resolvedAuthor = currentUser || localStorage.getItem('pp_commenter') || ''
  const commentCount  = comments.length

  useEffect(() => { loadComments() }, [weekStart, section])

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
    setComments(data || [])
  }

  async function submit() {
    if (!text.trim() || !resolvedAuthor) return
    setPosting(true)
    const commentText  = text.trim()
    const notifyNames  = [...notify]
    setText('')
    setNotify([])

    const { data: inserted } = await supabase
      .from('section_comments')
      .insert({
        week_start:    weekKey,
        section,
        section_label: label,
        author:        resolvedAuthor,
        text:          commentText,
        notify_names:  notifyNames,
        status:        'sent',
        created_at:    new Date().toISOString(),
      })
      .select()
      .single()

    if (inserted?.id && onCommentPosted) onCommentPosted(inserted.id)

    setPosting(false)
    loadComments()
  }

  async function submitReply(parentId) {
    if (!replyText.trim() || !resolvedAuthor) return
    setPosting(true)
    await supabase.from('section_comments').insert({
      week_start:    weekKey,
      section,
      section_label: label,
      author:        resolvedAuthor,
      text:          replyText.trim(),
      notify_names:  [],
      status:        'sent',
      parent_id:     parentId,
      created_at:    new Date().toISOString(),
    })
    setReplyText('')
    setReplyingTo(null)
    setPosting(false)
    loadComments()
  }

  async function deleteComment(id) {
    await supabase.from('section_comments').delete().eq('id', id)
    loadComments()
  }

  function toggleNotify(name) {
    setNotify(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  function initials(name) {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  }

  const topLevel = comments.filter(c => !c.parent_id)
  const replies  = comments.filter(c => c.parent_id)

  return (
    <div className={styles.wrapper} ref={panelRef}>
      <button
        className={`${styles.trigger} ${commentCount > 0 ? styles.triggerActive : ''}`}
        onClick={() => setOpen(o => !o)}
        title={`${commentCount} comment${commentCount !== 1 ? 's' : ''} on ${label}`}
      >
        <SlackIcon size={13} />
        {commentCount > 0 && <span className={styles.badge}>{commentCount}</span>}
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitleArea}>
              <span className={styles.panelTitle}>{label}</span>
              {commentCount > 0 && <span className={styles.panelCount}>{commentCount}</span>}
            </div>
            <button className={styles.closeBtn} onClick={() => setOpen(false)}>×</button>
          </div>

          {/* Comment list */}
          <div className={styles.commentList}>
            {topLevel.length === 0 ? (
              <p className={styles.empty}>No comments yet</p>
            ) : topLevel.map(c => {
              const threadReplies = replies.filter(r => r.parent_id === c.id)
              const isOwn = c.author === resolvedAuthor
              return (
                <div key={c.id} className={styles.commentThread}>
                  <div className={styles.comment}>
                    <div className={styles.commentMeta}>
                      <span className={styles.avatar}>{initials(c.author)}</span>
                      <div className={styles.metaRight}>
                        <div className={styles.metaTop}>
                          <strong className={styles.authorName}>{c.author}</strong>
                          <span className={styles.commentTime}>{fmtTime(c.created_at)}</span>
                          {isOwn && (
                            <button className={styles.deleteBtn} onClick={() => deleteComment(c.id)} title="Delete">✕</button>
                          )}
                        </div>
                        {c.notify_names?.length > 0 && (
                          <span className={styles.notified}>→ {c.notify_names.join(', ')}</span>
                        )}
                      </div>
                    </div>
                    <p className={styles.commentText}>{c.text}</p>
                    <button className={styles.replyBtn} onClick={() => setReplyingTo(replyingTo === c.id ? null : c.id)}>
                      {replyingTo === c.id ? 'Cancel' : '↩ Reply'}
                    </button>
                  </div>

                  {threadReplies.length > 0 && (
                    <div className={styles.replyList}>
                      {threadReplies.map(r => (
                        <div key={r.id} className={styles.reply}>
                          <div className={styles.commentMeta}>
                            <span className={`${styles.avatar} ${styles.avatarSm}`}>{initials(r.author)}</span>
                            <div className={styles.metaRight}>
                              <div className={styles.metaTop}>
                                <strong className={styles.authorName}>{r.author}</strong>
                                <span className={styles.commentTime}>{fmtTime(r.created_at)}</span>
                                {r.author === resolvedAuthor && (
                                  <button className={styles.deleteBtn} onClick={() => deleteComment(r.id)} title="Delete">✕</button>
                                )}
                              </div>
                            </div>
                          </div>
                          <p className={styles.commentText}>{r.text}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {replyingTo === c.id && (
                    <div className={styles.replyForm}>
                      <textarea
                        className={styles.textInput}
                        placeholder={`Reply as ${resolvedAuthor}…`}
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        rows={2}
                        autoFocus
                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitReply(c.id) }}
                      />
                      <div className={styles.replyFormActions}>
                        <button onClick={() => { setReplyingTo(null); setReplyText('') }}>Cancel</button>
                        <button className={styles.postBtn} onClick={() => submitReply(c.id)} disabled={posting || !replyText.trim()}>
                          {posting ? '…' : 'Post reply'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            <div ref={commentsEndRef} />
          </div>

          {/* New comment form */}
          <div className={styles.form}>
            <div className={styles.authorDisplay}>
              Commenting as <strong>{resolvedAuthor || 'Unknown'}</strong>
            </div>
            <textarea
              className={styles.textInput}
              placeholder="Add a comment…"
              value={text}
              onChange={e => setText(e.target.value)}
              rows={3}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
            />

            {/* Notify pills */}
            <div className={styles.notifyRow}>
              <span className={styles.notifyLabel}>Notify:</span>
              <div className={styles.pills}>
                <button
                  type="button"
                  className={`${styles.pill} ${notify.length === 0 ? styles.pillActive : ''}`}
                  onClick={() => setNotify([])}
                >
                  Everyone
                </button>
                {TEAM.map(t => (
                  <button
                    key={t.name}
                    type="button"
                    className={`${styles.pill} ${notify.includes(t.name) ? styles.pillActive : ''}`}
                    onClick={() => toggleNotify(t.name)}
                  >
                    {t.name.split(' ')[0]}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              className={styles.postBtn}
              onClick={submit}
              disabled={posting || !text.trim() || !resolvedAuthor}
            >
              {posting ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
