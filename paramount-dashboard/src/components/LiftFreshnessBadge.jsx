import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// LiftFreshnessBadge — honest live-status pill for the LIFT feed.
//
// FRESHNESS-based, not a live ping: reads the newest sched_snapshots.uploaded_at
// and reports how recent the data is — the signal that actually matters ("is the
// dashboard showing current data?") and reflects the hourly feed cron landing.
//
// Styling matches the Heartbeat page's "LIVE · PLANT PULSE" treatment: a 12px
// dot with a soft halo ring that breathes (scales + expands outward), plus a
// wide-tracked small-caps eyebrow. Colors are semantic and the dot pulses in
// every state — a live feed should read as *alive*.
//
// The auto-feed cron runs hourly:
//   • LIVE    (green)  — within 2h (one hourly run + grace)
//   • DELAYED (amber)  — 2–24h (a few missed runs, still today's data)
//   • STALE   (red)    — >24h, or no snapshot at all
// ═══════════════════════════════════════════════════════════════════════════

const FRESH_MS   = 2  * 60 * 60 * 1000
const DELAYED_MS = 24 * 60 * 60 * 1000

// Parse a Supabase timestamp defensively: strings WITHOUT timezone info
// (naive "2026-07-02T14:30:00") are UTC from Postgres but JS parses them as
// LOCAL — skewing "last updated" by the UTC offset (the bug where a morning
// upload showed "6 hrs ago" at night). Append Z only when no tz is present,
// so timestamptz strings (+00:00) keep working untouched.
function parseTs(s) {
  if (!s) return null
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s)
  return new Date(hasTz ? s : s + 'Z')
}

function tierFor(uploadedAt) {
  if (!uploadedAt) return 'stale'
  const age = Date.now() - parseTs(uploadedAt).getTime()
  if (age <= FRESH_MS)   return 'fresh'
  if (age <= DELAYED_MS) return 'delayed'
  return 'stale'
}

function relativeTime(uploadedAt) {
  if (!uploadedAt) return 'never'
  const mins = Math.round((Date.now() - parseTs(uploadedAt).getTime()) / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24)  return `${hrs} hr${hrs !== 1 ? 's' : ''} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days !== 1 ? 's' : ''} ago`
}

// dot = solid dot + eyebrow color; halo = same color as an "r,g,b" triplet so
// the keyframe can fade a colored ring out around it.
const TIERS = {
  fresh:   { dot: '#0F7A4E', halo: '15,122,78',  word: 'LIVE'    },  // emerald
  delayed: { dot: '#C17F24', halo: '193,127,36', word: 'DELAYED' },  // amber
  stale:   { dot: '#E5484D', halo: '229,72,77',  word: 'STALE'   },  // bright red
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
  const { dot, halo, word } = TIERS[tierFor(uploadedAt)]
  const isAuto = (snap?.source_filename || '').toLowerCase().includes('auto feed')

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
      <style>{`
        @keyframes liftHeartbeat {
          0%, 100% { transform: scale(1);    box-shadow: 0 0 0 4px rgba(var(--lift-halo),0.20), 0 0 0 8px  rgba(var(--lift-halo),0); }
          50%      { transform: scale(1.25); box-shadow: 0 0 0 6px rgba(var(--lift-halo),0.10), 0 0 0 14px rgba(var(--lift-halo),0); }
        }
      `}</style>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        <span style={{
          '--lift-halo': halo,
          width: 12, height: 12, borderRadius: '50%', background: dot, display: 'inline-block',
          boxShadow: `0 0 0 4px rgba(${halo},0.18)`,
          animation: 'liftHeartbeat 1.4s ease-in-out infinite',
        }} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.28em', textTransform: 'uppercase', color: dot }}>
          LIFT · {word}
        </span>
      </div>
      {!compact && (
        <span style={{ fontSize: 10, color: C.inkLight, paddingLeft: 24 }}>
          {isAuto ? 'Refreshed hourly' : 'Manual upload'} · last updated {relativeTime(uploadedAt)}
        </span>
      )}
    </div>
  )
}
