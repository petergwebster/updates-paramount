import React, { useState, useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import { buildDashboardContext, logAICall } from '../lib/contextBuilder'
import { buildDashboardNarrativePrompt } from '../lib/prompts/dashboardNarrative'
import styles from './ClaudeReadBlock.module.css'

/**
 * ClaudeReadBlock — Auto-generating, editable, save-able AI narrative widget.
 *
 * Behavior:
 *   1. On mount, looks up an existing narrative for (week_start, time_window).
 *   2. If found and fresh (< 2 hours old), shows it.
 *   3. If not found, or stale and the user hasn't manually edited it, auto-generates
 *      a new one via /api/claude.
 *   4. User can edit (pencil icon) → makes textarea editable.
 *   5. User can save → writes back to dashboard_narratives, marks edited_by + edited_at.
 *   6. User can regenerate → confirms if there are unsaved edits, then re-runs Claude.
 *
 * Costs are kept down by:
 *   - Only auto-generating when narrative is missing or >2 hours stale
 *   - Storing in Supabase so reloads don't re-trigger generation
 *
 * Props:
 *   weekStart    Date — Monday of the week being analyzed
 *   timeWindow   'today' | 'week' | 'month'
 *   currentData  { actuals, expected, gaps } — passed in from parent page
 *   currentUser  string — user's full name (for edited_by attribution)
 *   userId       string — user's auth UUID (for edited_by FK)
 */

const STALE_HOURS = 2

export default function ClaudeReadBlock({ weekStart, timeWindow, currentData, currentUser, userId }) {
  const [narrative, setNarrative] = useState(null)
  const [generatedAt, setGeneratedAt] = useState(null)
  const [editedBy, setEditedBy] = useState(null)
  const [editedAt, setEditedAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [isEditing, setIsEditing] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [showRegenConfirm, setShowRegenConfirm] = useState(false)

  const weekKey = format(weekStart, 'yyyy-MM-dd')
  const lastFetchRef = useRef({ weekKey: null, timeWindow: null })

  // ── Load + maybe-auto-generate when window or week changes ────────────────
  useEffect(() => {
    // Skip if we already loaded for this exact (week, window)
    if (lastFetchRef.current.weekKey === weekKey && lastFetchRef.current.timeWindow === timeWindow) {
      return
    }
    lastFetchRef.current = { weekKey, timeWindow }

    let cancelled = false
    async function loadOrGenerate() {
      // Clear stale narrative state from prior window FIRST so user sees a
      // clean loading state instead of last window's text
      setNarrative(null)
      setGeneratedAt(null)
      setEditedBy(null)
      setEditedAt(null)
      setLoading(true)
      setError(null)
      setIsEditing(false)

      // 1. Try to load existing narrative
      const { data: existing } = await supabase
        .from('dashboard_narratives')
        .select('*')
        .eq('week_start', weekKey)
        .eq('time_window', timeWindow)
        .single()

      if (cancelled) return

      if (existing?.narrative) {
        setNarrative(existing.narrative)
        setGeneratedAt(existing.generated_at)
        setEditedBy(existing.edited_by)
        setEditedAt(existing.edited_at)

        // If recently edited by a human, never auto-regen — respect their edits
        if (existing.edited_at) {
          setLoading(false)
          return
        }

        // If auto-generated and fresh, just show it
        const ageMs = Date.now() - new Date(existing.generated_at).getTime()
        const ageHours = ageMs / (1000 * 60 * 60)
        if (ageHours < STALE_HOURS) {
          setLoading(false)
          return
        }
        // Otherwise fall through to regenerate
      }

      // 2. Auto-generate
      await generateNarrative({ silent: true })
      if (!cancelled) setLoading(false)
    }

    loadOrGenerate()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekKey, timeWindow])

  // ── Generate via /api/claude ──────────────────────────────────────────────
  async function generateNarrative({ silent = false } = {}) {
    if (!silent) setGenerating(true)
    setError(null)
    const startedAt = Date.now()

    try {
      // Build context
      const { contextString, contextObject } = await buildDashboardContext({
        weekStart,
        timeWindow,
        currentData,
      })

      // Build prompt
      const prompt = buildDashboardNarrativePrompt({
        contextString,
        timeWindow,
        hasData: currentData?.hasData ?? true,
      })

      // Call Claude (matching the existing /api/claude pattern in admin)
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      const data = await response.json()
      const text = data.content?.find(c => c.type === 'text')?.text?.trim()

      if (!text) {
        setError('Could not generate narrative. Try again.')
        if (!silent) setGenerating(false)
        // Log failure
        logAICall({
          callerId: userId,
          promptType: 'dashboard_narrative',
          context: contextObject,
          prompt,
          response: '',
          durationMs: Date.now() - startedAt,
          error: 'no text in response',
        })
        return
      }

      // Save to dashboard_narratives (upsert so re-runs replace)
      const generatedAtISO = new Date().toISOString()
      await supabase.from('dashboard_narratives').upsert({
        week_start: weekKey,
        time_window: timeWindow,
        narrative: text,
        generated_at: generatedAtISO,
        edited_by: null,
        edited_at: null,
      }, { onConflict: 'week_start,time_window' })

      // Log success
      logAICall({
        callerId: userId,
        promptType: 'dashboard_narrative',
        context: contextObject,
        prompt,
        response: text,
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
        durationMs: Date.now() - startedAt,
      })

      setNarrative(text)
      setGeneratedAt(generatedAtISO)
      setEditedBy(null)
      setEditedAt(null)
    } catch (e) {
      console.error('ClaudeReadBlock: generation failed', e)
      setError('Generation failed. Check your connection.')
      logAICall({
        callerId: userId,
        promptType: 'dashboard_narrative',
        context: { time_window: timeWindow },
        prompt: '',
        response: '',
        durationMs: Date.now() - startedAt,
        error: e?.message || String(e),
      })
    } finally {
      if (!silent) setGenerating(false)
    }
  }

  // ── Edit / save / regenerate handlers ─────────────────────────────────────
  function startEdit() {
    setDraftText(narrative || '')
    setIsEditing(true)
  }

  function cancelEdit() {
    setDraftText('')
    setIsEditing(false)
  }

  async function saveEdit() {
    if (!draftText.trim()) return
    setSaving(true)
    setError(null)
    try {
      const editedAtISO = new Date().toISOString()
      await supabase.from('dashboard_narratives').upsert({
        week_start: weekKey,
        time_window: timeWindow,
        narrative: draftText.trim(),
        generated_at: generatedAt || editedAtISO,
        edited_by: userId || null,
        edited_at: editedAtISO,
      }, { onConflict: 'week_start,time_window' })
      setNarrative(draftText.trim())
      setEditedBy(userId)
      setEditedAt(editedAtISO)
      setIsEditing(false)
      setDraftText('')
    } catch (e) {
      setError('Save failed. Try again.')
    }
    setSaving(false)
  }

  function tryRegenerate() {
    if (editedAt) {
      // Has manual edits — confirm first
      setShowRegenConfirm(true)
    } else {
      generateNarrative()
    }
  }

  function confirmRegenerate() {
    setShowRegenConfirm(false)
    generateNarrative()
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const ageLabel = editedAt
    ? `Edited by ${currentUser?.split(' ')[0] || 'someone'} ${formatRelativeTime(editedAt)}`
    : generatedAt
      ? `Generated ${formatRelativeTime(generatedAt)}`
      : null

  return (
    <div className={styles.block}>
      <div className={styles.header}>
        <div className={styles.icon}>C</div>
        <div className={styles.headerText}>
          <div className={styles.eyebrow}>Claude's read</div>
          <div className={styles.subtitle}>{getSubtitleForWindow(timeWindow)}</div>
        </div>
        <div className={styles.actions}>
          {!isEditing && narrative && (
            <>
              <button className={styles.actionBtn} onClick={startEdit} title="Edit">
                ✎ Edit
              </button>
              <button
                className={styles.actionBtn}
                onClick={tryRegenerate}
                disabled={generating}
                title="Regenerate"
              >
                {generating ? 'Regenerating…' : '↻ Regenerate'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className={styles.body}>
        {loading && !narrative && (
          <div className={styles.loadingState}>Generating Claude's read…</div>
        )}

        {error && (
          <div className={styles.errorState}>
            {error} <button className={styles.linkBtn} onClick={() => generateNarrative()}>Try again</button>
          </div>
        )}

        {!loading && !narrative && !error && (
          <div className={styles.emptyState}>
            No narrative yet. <button className={styles.linkBtn} onClick={() => generateNarrative()}>Generate one</button>
          </div>
        )}

        {!isEditing && narrative && (
          <div className={styles.narrativeText}>
            {narrative.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}
          </div>
        )}

        {isEditing && (
          <div className={styles.editor}>
            <textarea
              className={styles.editorTextarea}
              value={draftText}
              onChange={e => setDraftText(e.target.value)}
              rows={Math.max(8, draftText.split('\n').length + 2)}
              autoFocus
            />
            <div className={styles.editorActions}>
              <button className={styles.cancelBtn} onClick={cancelEdit} disabled={saving}>Cancel</button>
              <button className={styles.saveBtn} onClick={saveEdit} disabled={saving || !draftText.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {ageLabel && !isEditing && (
        <div className={styles.footer}>{ageLabel}</div>
      )}

      {showRegenConfirm && (
        <div className={styles.modalOverlay} onClick={() => setShowRegenConfirm(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Replace your edits?</div>
            <div className={styles.modalBody}>
              This narrative was edited manually. Regenerating will replace your edits with a fresh AI-generated version.
            </div>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setShowRegenConfirm(false)}>Cancel</button>
              <button className={styles.dangerBtn} onClick={confirmRegenerate}>Replace with new</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── helpers ──────────────────────────────────────────────────────────────
function getSubtitleForWindow(timeWindow) {
  switch (timeWindow) {
    case 'today': return "How today is shaping up — what we've done so far vs. what was scheduled."
    case 'week':  return "Where the week stands — pace, gaps, and what's queued for the rest."
    case 'month': return "Month-to-date picture, with trend context against prior months."
    default:      return ''
  }
}

function formatRelativeTime(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / (1000 * 60))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}
