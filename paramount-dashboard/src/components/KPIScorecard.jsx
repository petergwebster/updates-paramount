import React, { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import { getFiscalLabel } from '../fiscalCalendar'
import styles from './KPIScorecard.module.css'

const KPIS = [
  { id: 'financial', name: 'Financial Contribution', desc: 'Cash contribution, margin discipline, revenue vs. target', target: 'Topline grow 10% in 2027' },
  { id: 'cost', name: 'Cost Efficiency', desc: 'Cost per yard, cost per color yard, improvement vs. prior period', target: 'Avg cost/yard reduced ~$1 across categories' },
  { id: 'inventory', name: 'Inventory Management', desc: 'Availability across grounds, slow-moving stock, obsolete inventory', target: 'Inventory stability across all grounds' },
  { id: 'quality', name: 'Quality & Waste', desc: 'Production waste %, reprints, write-offs, QA consistency', target: 'Waste <8%, continued QA improvement' },
  { id: 'delivery', name: 'Delivery Performance', desc: 'End-to-end lead times, WIP reduction, on-time shipment', target: 'WIP time below 10 weeks' },
  { id: 'collaboration', name: 'Cross-Group Collaboration', desc: 'Schumacher Design Studio, Patterson Flynn, other group brands', target: 'Proactive communication & problem-solving' },
  { id: 'grounds', name: 'Grounds Management', desc: 'Grounds mix performance, innovation, stewardship decisions', target: 'Strategic decisions on grounds mix & performance' },
  { id: 'vendors', name: 'Vendor Relationships', desc: 'P+W, Wallquest/Omni (primary) · Rotex, Greenland, Stead (developmental)', target: 'High-trust, high-performance partnerships' },
  { id: 'growth', name: 'Top-Line Growth', desc: 'Third-party revenue, Tillett custom business expansion', target: '$500k+ 3rd party · $1M+ Tillett custom' },
  { id: 'passaic', name: 'Passaic Asset Development', desc: 'Building development, construction, regulatory, tenant coordination', target: 'Long-term site planning & value creation' },
]

const STATUS_OPTIONS = [
  { value: 'green', label: 'On Track' },
  { value: 'amber', label: 'Watch' },
  { value: 'red', label: 'Concern' },
  { value: 'gray', label: 'Pending' },
]

const STATUS_LABELS = { green: 'On Track', amber: 'Watch', red: 'Concern', gray: 'Pending' }

// Overall score: red if any red, amber if any amber, green if all green/gray
function calcOverallScore(kpis) {
  const statuses = Object.values(kpis).map(k => k?.status).filter(Boolean)
  if (statuses.includes('red')) return 'red'
  if (statuses.includes('amber')) return 'amber'
  if (statuses.includes('green')) return 'green'
  return 'gray'
}

const OVERALL_LABELS = { green: 'On Track', amber: 'Watch', red: 'Concern', gray: 'Pending' }

// Emoji reactions stored in Supabase
const REACTION_EMOJIS = ['👍', '👎', '❓']

function SlackIcon({ size = 12 }) {
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

// ── Reaction row component ────────────────────────────────────────────────────
function KPIReactions({ weekStart, kpiId, kpiName, currentUser }) {
  const [counts, setCounts] = useState({})
  const [myReactions, setMyReactions] = useState({})
  const [commenting, setCommenting] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [replyingTo, setReplyingTo] = useState(null)
  const [replyText, setReplyText] = useState('')
  const [comments, setComments] = useState([])
  const [sending, setSending] = useState(false)
  const popupRef = React.useRef(null)
  const weekKey = format(weekStart, 'yyyy-MM-dd')
  const sessionKey = `pp_session_${weekKey}`
  const resolvedAuthor = currentUser || localStorage.getItem('pp_commenter') || ''
  const section = `kpi-${kpiId}`

  useEffect(() => { loadReactions(); loadComments() }, [kpiId, weekKey])

  useEffect(() => {
    if (!commenting) return
    function handleClick(e) {
      if (popupRef.current && !popupRef.current.contains(e.target)) setCommenting(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [commenting])

  async function loadReactions() {
    const { data } = await supabase.from('kpi_reactions').select('emoji, author').eq('week_start', weekKey).eq('kpi_id', kpiId)
    if (!data) return
    const c = {}
    REACTION_EMOJIS.forEach(e => { c[e] = 0 })
    data.forEach(r => { c[r.emoji] = (c[r.emoji] || 0) + 1 })
    setCounts(c)
    const myName = localStorage.getItem('pp_commenter') || ''
    if (myName) {
      const mine = {}
      data.filter(r => r.author === myName).forEach(r => { mine[r.emoji] = true })
      setMyReactions(mine)
    }
  }

  async function loadComments() {
    const { data } = await supabase.from('section_comments').select('*').eq('week_start', weekKey).eq('section', section).order('created_at', { ascending: true })
    const all = data || []
    setComments(all.filter(c => c.status === 'sent' || (c.status === 'draft' && c.author === resolvedAuthor)))
  }

  async function toggleReaction(emoji) {
    if (!resolvedAuthor) return
    const alreadyReacted = myReactions[emoji]
    if (alreadyReacted) {
      await supabase.from('kpi_reactions').delete().eq('week_start', weekKey).eq('kpi_id', kpiId).eq('author', resolvedAuthor).eq('emoji', emoji)
      setMyReactions(prev => ({ ...prev, [emoji]: false }))
      setCounts(prev => ({ ...prev, [emoji]: Math.max(0, (prev[emoji] || 1) - 1) }))
    } else {
      await supabase.from('kpi_reactions').insert({ week_start: weekKey, kpi_id: kpiId, author: resolvedAuthor, emoji })
      setMyReactions(prev => ({ ...prev, [emoji]: true }))
      setCounts(prev => ({ ...prev, [emoji]: (prev[emoji] || 0) + 1 }))
    }
  }

  async function submitComment() {
    if (!commentText.trim() || !resolvedAuthor) return
    setSending(true)
    const sessionComments = JSON.parse(localStorage.getItem(sessionKey) || '[]')
    const { data } = await supabase.from('section_comments').insert({
      week_start: weekKey, section, section_label: kpiName,
      author: resolvedAuthor, text: commentText.trim(),
      notify_names: [], status: 'draft', created_at: new Date().toISOString(),
    }).select().single()
    if (data) { sessionComments.push(data.id); localStorage.setItem(sessionKey, JSON.stringify(sessionComments)) }
    setCommentText('')
    setSending(false)
    loadComments()
  }

  async function submitReply(parentId) {
    if (!replyText.trim() || !resolvedAuthor) return
    setSending(true)
    const sessionComments = JSON.parse(localStorage.getItem(sessionKey) || '[]')
    const { data } = await supabase.from('section_comments').insert({
      week_start: weekKey, section, section_label: kpiName,
      author: resolvedAuthor, text: replyText.trim(),
      notify_names: [], status: 'draft', parent_id: parentId,
      created_at: new Date().toISOString(),
    }).select().single()
    if (data) { sessionComments.push(data.id); localStorage.setItem(sessionKey, JSON.stringify(sessionComments)) }
    setReplyText(''); setReplyingTo(null); setSending(false)
    loadComments()
  }

  async function deleteDraft(id) {
    await supabase.from('section_comments').delete().eq('id', id)
    const sessionComments = JSON.parse(localStorage.getItem(sessionKey) || '[]')
    localStorage.setItem(sessionKey, JSON.stringify(sessionComments.filter(s => s !== id)))
    loadComments()
  }

  const topLevel = comments.filter(c => !c.parent_id)
  const replies = comments.filter(c => c.parent_id)
  const sentCount = comments.filter(c => c.status === 'sent').length
  const draftCount = comments.filter(c => c.status === 'draft' && c.author === resolvedAuthor).length

  return (
    <div className={styles.reactionRow} ref={popupRef}>
      <div className={styles.reactionEmojis}>
        {REACTION_EMOJIS.map(emoji => {
          const count = counts[emoji] || 0
          const isMine = myReactions[emoji]
          return (
            <button key={emoji} className={`${styles.reactionBtn} ${isMine ? styles.reactionBtnActive : ''}`} onClick={() => toggleReaction(emoji)} title={emoji === '👍' ? 'On track' : emoji === '👎' ? 'Concern' : 'Question'}>
              <span>{emoji}</span>
              {count > 0 && <span className={styles.reactionCount}>{count}</span>}
            </button>
          )
        })}
      </div>
      <button
        className={`${styles.kpiCommentBtn} ${sentCount > 0 ? styles.kpiCommentBtnActive : ''} ${draftCount > 0 ? styles.kpiCommentBtnDraft : ''}`}
        onClick={() => setCommenting(c => !c)}
      >
        <SlackIcon size={11} />
        <span>{sentCount > 0 ? `${sentCount} comment${sentCount !== 1 ? 's' : ''}` : 'Comment'}</span>
        {draftCount > 0 && <span className={styles.kpiDraftDot} />}
      </button>

      {commenting && (
        <div className={styles.kpiCommentPopup}>
          <div className={styles.kpiPopupHeader}>
            <span className={styles.kpiPopupTitle}>{kpiName}</span>
            <button className={styles.kpiPopupClose} onClick={() => setCommenting(false)}>×</button>
          </div>

          {/* Comment list */}
          <div className={styles.kpiCommentList}>
            {topLevel.length === 0 ? (
              <p className={styles.kpiCommentEmpty}>No comments yet</p>
            ) : topLevel.map(c => {
              const threadReplies = replies.filter(r => r.parent_id === c.id)
              return (
                <div key={c.id} className={styles.kpiCommentThread}>
                  <div className={`${styles.kpiComment} ${c.status === 'draft' ? styles.kpiCommentDraft : ''}`}>
                    <div className={styles.kpiCommentMeta}>
                      <span className={styles.kpiCommentAvatar}>{c.author.split(' ').map(n => n[0]).join('').slice(0,2)}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 12 }}>{c.author}</strong>
                          <span style={{ fontSize: 11, color: 'var(--ink-60)' }}>{new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                          {c.status === 'draft' && <span className={styles.kpiDraftBadge}>draft</span>}
                          {c.status === 'draft' && c.author === resolvedAuthor && (
                            <button className={styles.kpiDeleteBtn} onClick={() => deleteDraft(c.id)}>✕</button>
                          )}
                        </div>
                      </div>
                    </div>
                    <p className={styles.kpiCommentText}>{c.text}</p>
                    <button className={styles.kpiReplyBtn} onClick={() => setReplyingTo(replyingTo === c.id ? null : c.id)}>
                      {replyingTo === c.id ? 'Cancel' : '↩ Reply'}
                    </button>
                  </div>
                  {threadReplies.length > 0 && (
                    <div className={styles.kpiReplyList}>
                      {threadReplies.map(r => (
                        <div key={r.id} className={`${styles.kpiReply} ${r.status === 'draft' ? styles.kpiCommentDraft : ''}`}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                            <span className={`${styles.kpiCommentAvatar} ${styles.kpiCommentAvatarSm}`}>{r.author.split(' ').map(n => n[0]).join('').slice(0,2)}</span>
                            <strong style={{ fontSize: 11 }}>{r.author}</strong>
                            <span style={{ fontSize: 11, color: 'var(--ink-60)' }}>{new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                            {r.status === 'draft' && <span className={styles.kpiDraftBadge}>draft</span>}
                            {r.status === 'draft' && r.author === resolvedAuthor && (
                              <button className={styles.kpiDeleteBtn} onClick={() => deleteDraft(r.id)}>✕</button>
                            )}
                          </div>
                          <p className={styles.kpiCommentText}>{r.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {replyingTo === c.id && (
                    <div className={styles.kpiReplyForm}>
                      <textarea className={styles.kpiCommentTextarea} value={replyText} onChange={e => setReplyText(e.target.value)} placeholder={`Reply as ${resolvedAuthor}…`} rows={2} autoFocus />
                      <div className={styles.kpiCommentActions}>
                        <button onClick={() => { setReplyingTo(null); setReplyText('') }}>Cancel</button>
                        <button className="primary" onClick={() => submitReply(c.id)} disabled={sending || !replyText.trim()}>{sending ? 'Saving…' : 'Save Reply'}</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* New comment form */}
          <div className={styles.kpiCommentForm}>
            <div className={styles.kpiCommentingAs}>Commenting as <strong>{resolvedAuthor}</strong></div>
            <textarea className={styles.kpiCommentTextarea} value={commentText} onChange={e => setCommentText(e.target.value)} placeholder={`Comment on ${kpiName}…`} rows={2} />
            <div className={styles.kpiCommentActions}>
              <button onClick={() => setCommenting(false)}>Cancel</button>
              <button className="primary" onClick={submitComment} disabled={sending || !commentText.trim() || !resolvedAuthor}>{sending ? 'Saving…' : 'Save Draft'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function KPIScorecard({ weekData, weekStart, onSave, dbReady, readOnly = false, currentUser }) {
  const [kpis, setKpis] = useState({})
  const [narrative, setNarrative] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState(null)

  useEffect(() => {
    if (weekData?.kpis) setKpis(weekData.kpis)
    else setKpis({})
    if (weekData?.narrative) setNarrative(weekData.narrative)
    else setNarrative('')
  }, [weekData])

  function updateKPI(id, field, value) {
    setKpis(prev => ({
      ...prev,
      [id]: { ...(prev[id] || { status: 'gray', notes: '' }), [field]: value }
    }))
  }

  async function handleSave() {
    setSaving(true)
    await onSave({ kpis, narrative })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  async function generateNarrative() {
    setGenerating(true)
    setGenError(null)
    const weekLabel = format(weekStart, 'MMMM d, yyyy')
    const kpiSummary = KPIS.map(k => {
      const d = kpis[k.id]
      if (!d || d.status === 'gray') return null
      return `${k.name}: ${STATUS_LABELS[d.status]}${d.notes ? ' — ' + d.notes : ''}`
    }).filter(Boolean).join('\n')
    const redItems = KPIS.filter(k => kpis[k.id]?.status === 'red').map(k => k.name)
    const amberItems = KPIS.filter(k => kpis[k.id]?.status === 'amber').map(k => k.name)
    const greenItems = KPIS.filter(k => kpis[k.id]?.status === 'green').map(k => k.name)
    const prompt = `You are helping Peter Webster, President of Paramount Prints (a specialty printing division of F. Schumacher & Co), draft a concise weekly executive summary for his CEO (Timur) and Chief of Staff (Emily).

Paramount Prints has two facilities: Passaic, NJ (screen printing — fabric, grass cloth, wallpaper) and Brooklyn (digital printing). The business does ~$10M/year in revenue.

Week of: ${weekLabel}

KPI Scorecard:
${kpiSummary || 'No KPI data entered yet.'}

Flags (Concern): ${redItems.length > 0 ? redItems.join(', ') : 'None'}
Watch items: ${amberItems.length > 0 ? amberItems.join(', ') : 'None'}
On track: ${greenItems.length > 0 ? greenItems.join(', ') : 'None'}

Write a 3-4 paragraph executive summary in Peter's voice — direct, factual, and candid. Structure:
1. Overall week assessment (1-2 sentences)
2. Key highlights and what is going well
3. Areas of concern or watch items with context
4. Forward look — what to watch next week

Keep it under 200 words. Write in first person as Peter. No bullet points. No headers. No title line. Start directly with the first sentence of the summary. Clean prose paragraphs only.`

    try {
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
      })
      const data = await response.json()
      const text = data.content?.find(c => c.type === 'text')?.text
      if (text) setNarrative(text.trim())
      else setGenError('Could not generate summary. Try again.')
    } catch (e) {
      setGenError('Generation failed. Check your connection.')
    }
    setGenerating(false)
  }

  const statusCounts = KPIS.reduce((acc, k) => {
    const s = kpis[k.id]?.status || 'gray'
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})

  const hasKPIData = KPIS.some(k => kpis[k.id]?.status && kpis[k.id].status !== 'gray')
  const overallScore = calcOverallScore(kpis)
  const fiscalLabel = getFiscalLabel(weekStart)

  // ── READ-ONLY MEMO VIEW ───────────────────────────────────────────────────
  if (readOnly) {
    const hasContent = narrative || hasKPIData

    return (
      <div className={styles.memoContainer}>
        {/* Memo header */}
        <div className={styles.memoHeader}>
          <div className={styles.memoHeaderLeft}>
            <div className={styles.memoOrg}>PARAMOUNT PRINTS · F. SCHUMACHER & CO.</div>
            <div className={styles.memoTitle}>Weekly Executive Briefing</div>
            <div className={styles.memoMeta}>
              {fiscalLabel || format(weekStart, 'MMMM d, yyyy')}
            </div>
          </div>
          <div className={styles.memoScore}>
            <div className={`${styles.memoScoreDot} ${styles[`memoScoreDot_${overallScore}`]}`} />
            <div className={styles.memoScoreLabel}>
              <span className={styles.memoScoreText}>Overall</span>
              <span className={`${styles.memoScoreValue} ${styles[`memoScoreValue_${overallScore}`]}`}>
                {OVERALL_LABELS[overallScore]}
              </span>
            </div>
          </div>
        </div>

        {!hasContent ? (
          <div className={styles.memoEmpty}>
            <p>No scorecard data has been entered for this week yet.</p>
            <p style={{ marginTop: 6, fontSize: 13 }}>Use the Admin panel to enter KPI statuses and generate the executive summary.</p>
          </div>
        ) : (
          <>
            {/* Executive Summary */}
            {narrative && (
              <div className={styles.memoSection}>
                <div className={styles.memoSectionLabel}>Executive Summary</div>
                <div className={styles.memoDivider} />
                <div className={styles.memoNarrative}>
                  {narrative.split('\n\n').map((para, i) => (
                    <p key={i} className={styles.memoParagraph}>{para.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').trim()}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Scorecard */}
            {hasKPIData && (
              <div className={styles.memoSection}>
                <div className={styles.memoSectionLabel}>Performance Scorecard</div>
                <div className={styles.memoDivider} />

                {/* Score summary pills */}
                <div className={styles.memoScorePills}>
                  {statusCounts.green > 0 && <span className="badge badge-green">{statusCounts.green} On Track</span>}
                  {statusCounts.amber > 0 && <span className="badge badge-amber">{statusCounts.amber} Watch</span>}
                  {statusCounts.red > 0 && <span className="badge badge-red">{statusCounts.red} Concern</span>}
                  {statusCounts.gray > 0 && <span className="badge badge-gray">{statusCounts.gray} Pending</span>}
                </div>

                <div className={styles.memoKpiList}>
                  {KPIS.map((kpi, idx) => {
                    const data = kpis[kpi.id] || { status: 'gray', notes: '' }
                    return (
                      <div key={kpi.id} className={`${styles.memoKpiRow} ${idx < KPIS.length - 1 ? styles.memoKpiRowBorder : ''}`}>
                        <div className={styles.memoKpiMain}>
                          <div className={styles.memoKpiHeader}>
                            <div className={styles.memoKpiLeft}>
                              <span className={`dot dot-${data.status}`} />
                              <span className={styles.memoKpiName}>{kpi.name}</span>
                            </div>
                            <div className={styles.memoKpiRight}>
                              <span className={`badge badge-${data.status}`}>{STATUS_LABELS[data.status]}</span>
                              <KPIReactions weekStart={weekStart} kpiId={kpi.id} kpiName={kpi.name} currentUser={currentUser} />
                            </div>
                          </div>
                          {data.notes && (
                            <p className={styles.memoKpiNotes}>{data.notes}</p>
                          )}
                          {!data.notes && data.status !== 'gray' && (
                            <p className={styles.memoKpiNoNotes}>{kpi.desc}</p>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  // ── EDIT VIEW (used in Admin panel — kept for reference but Admin uses AdminPanel) ──
  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.sectionTitle}>KPI Scorecard</h2>
          <p className={styles.sectionSub}>Week of {format(weekStart, 'MMMM d, yyyy')} · Balanced scorecard across all dimensions</p>
        </div>
        <div className={styles.saveRow}>
          <div className={styles.scoreSummary}>
            {statusCounts.green > 0 && <span className="badge badge-green">{statusCounts.green} On Track</span>}
            {statusCounts.amber > 0 && <span className="badge badge-amber">{statusCounts.amber} Watch</span>}
            {statusCounts.red > 0 && <span className="badge badge-red">{statusCounts.red} Concern</span>}
          </div>
          {saved && <span className={styles.savedMsg}>Saved</span>}
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Scorecard'}
          </button>
        </div>
      </div>

      <div className={styles.narrativeSection}>
        <div className={styles.narrativeHeader}>
          <div>
            <div className={styles.narrativeTitle}>Weekly Executive Summary</div>
            <div className={styles.narrativeSub}>AI-drafted from your KPI notes — edit freely before sending</div>
          </div>
          <button
            className={`${styles.generateBtn} ${generating ? styles.generateBtnLoading : ''}`}
            onClick={generateNarrative}
            disabled={generating || !hasKPIData}
          >
            {generating ? <><span className={styles.spinner} />Drafting…</> : <>✦ Draft with AI</>}
          </button>
        </div>
        {genError && <p className={styles.genError}>{genError}</p>}
        <textarea
          className={styles.narrativeText}
          value={narrative}
          onChange={e => setNarrative(e.target.value)}
          placeholder={hasKPIData ? 'Click "Draft with AI" to generate…' : 'Fill in KPI statuses below first…'}
          rows={8}
        />
        {narrative && (
          <div className={styles.narrativeActions}>
            <button onClick={() => navigator.clipboard.writeText(narrative)} className={styles.copyBtn}>Copy to clipboard</button>
            <span className={styles.narrativeNote}>{narrative.trim().split(/\s+/).length} words</span>
          </div>
        )}
      </div>

      <div className={styles.kpiGrid}>
        {KPIS.map(kpi => {
          const data = kpis[kpi.id] || { status: 'gray', notes: '' }
          const isExpanded = expanded === kpi.id
          return (
            <div key={kpi.id} className={`${styles.kpiCard} ${styles[`kpiCard_${data.status}`]} ${isExpanded ? styles.kpiCardExpanded : ''}`}>
              <div className={styles.kpiTop} onClick={() => setExpanded(isExpanded ? null : kpi.id)}>
                <div className={styles.kpiLeft}>
                  <span className={`dot dot-${data.status}`} />
                  <span className={styles.kpiName}>{kpi.name}</span>
                  {data.notes && <span className={styles.hasNotesDot} />}
                </div>
                <div className={styles.kpiRight}>
                  <span className={`badge badge-${data.status}`}>{STATUS_OPTIONS.find(s => s.value === data.status)?.label || 'Pending'}</span>
                  <span className={styles.chevron}>{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>
              {isExpanded && (
                <div className={`${styles.kpiExpanded} fade-in`}>
                  <p className={styles.kpiDesc}>{kpi.desc}</p>
                  <p className={styles.kpiTarget}><strong>2027 Target:</strong> {kpi.target}</p>
                  <div className={styles.statusPicker}>
                    {STATUS_OPTIONS.map(s => (
                      <button key={s.value} className={`${styles.statusBtn} ${data.status === s.value ? styles[`statusActive_${s.value}`] : ''}`} onClick={() => updateKPI(kpi.id, 'status', s.value)}>
                        <span className={`dot dot-${s.value}`} />{s.label}
                      </button>
                    ))}
                  </div>
                  <label className="label" style={{ marginTop: 12 }}>Notes for this week</label>
                  <textarea value={data.notes || ''} onChange={e => updateKPI(kpi.id, 'notes', e.target.value)} placeholder={`What happened this week on ${kpi.name}?`} rows={4} style={{ marginTop: 6 }} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
