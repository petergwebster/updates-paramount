import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, STATUS_GOOD, STATUS_WARN, STATUS_BAD } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// LiftFreshnessBadge — honest live-status pill for the LIFT feed.
//
// The status is FRESHNESS-based, not a live ping: it reads the newest
// sched_snapshots.uploaded_at and reports how recent the data is. That's the
// signal that actually matters — "is the dashboard showing current data?" —
// and it reflects the hourly feed cron actually landing, not just whether a
// browser can reach a URL.
//
// The auto-feed cron runs hourly, so the tiers are:
//   • FRESH   (green, flashing dot)  — within 2h (one hourly run + grace)
//   • DELAYED (amber, steady)        — 2–24h (a few missed runs, still today)
//   • STALE   (red, steady)          — >24h, or no snapshot at all
//
// Under the pill: "Refreshed hourly · last updated <relative time>". The
// timestamp is the proof the pulse is telling the truth.
// ═══════════════════════════════════════════════════════════════════════════

const FRESH_MS   = 2  * 60 * 60 * 1000
const DELAYED_MS = 24 * 60 * 60 * 1000

function tierFor(uploadedAt) {
  if (!uploadedAt) return 'stale'
  const age = Date.now() - new Date(uploadedAt).getTime()
  if (age <= FRESH_MS)   return 'fresh'
  if (age <= DELAYED_MS) return 'delayed'
  return 'stale'
}

function relativeTime(uploadedAt) {
  if (!uploadedAt) return 'never'
  const mins = Math.round((Date.now() - new Date(uploadedAt).getTime()) / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24)  return `${hrs} hr${hrs !== 1 ? 's' : ''} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days !== 1 ? 's' : ''} ago`
}

const TIERS = {
  fresh:   { color: STATUS_GOOD, label: 'LIFT LIVE',    pulse: true  },
  delayed: { color: STATUS_WARN, label: 'LIFT DELAYED', pulse: false },
  stale:   { color: STATUS_BAD,  label: 'LIFT STALE',   pulse: false },
}

export default function LiftFreshnessBadge({ compact = false }) {
  const [snap, setSnap] = useState(null)
  const [, setTick] = useState(0)  // forces re-render so tier + relative time stay live

  async function load() {
    const { data } = await supabase
      .from('sched_snapshots')
      .select('uploaded_at, source_filename')
      .order('uploaded_at', { ascending: false })
      .limit(1)
    setSnap(data?.[0] || null)
  }

  useEffect(() => {
    load()
    // Re-query every 5 min to catch a fresh hourly snapshot; re-tick every 30s
    // so the relative-time label and tier stay honest without a page reload.
    const q = setInterval(load, 5 * 60 * 1000)
    const t = setInterval(() => setTick(n => n + 1), 30 * 1000)
    return () => { clearInterval(q); clearInterval(t) }
  }, [])

  const uploadedAt = snap?.uploaded_at || null
  const tier = tierFor(uploadedAt)
  const { color, label, pulse } = TIERS[tier]
  const isAuto = (snap?.source_filename || '').toLowerCase().includes('auto feed')

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <style>{`@keyframes liftPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <span style={{
          width: 9, height: 9, borderRadius: '50%', background: color, display: 'inline-block',
          animation: pulse ? 'liftPulse 1.4s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color }}>{label}</span>
      </div>
      {!compact && (
        <span style={{ fontSize: 10, color: C.inkLight }}>
          {isAuto ? 'Refreshed hourly' : 'Manual upload'} · last updated {relativeTime(uploadedAt)}
        </span>
      )}
    </div>
  )
}
