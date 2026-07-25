import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// ShareFileFreshnessBadge — live-status pill for the automated ShareFile feed
// (Jen's weekly GP workbook + Abigail's Vena monthly close).
//
// TWO DIMENSIONS, deliberately. A badge that only reports the last outcome is
// worse than no badge, because it stays green forever if the function stops
// running at all — and that is a failure this site has already had once (the
// netlify.toml schedule deployed clean, reported no error, and never ticked).
// So:
//    RECENCY  — how long since sharefile-sync last ran at all
//    OUTCOME  — did that run succeed, or did a feed error / trip its guard
// Green requires BOTH. Silence is treated as failure, not as success.
//
// The feed runs daily at 13:00 UTC (9am ET) and exits in ~1s when nothing has
// changed, so a healthy system writes a health record every single day.
//   • LIVE    (green) — ran within 26h and succeeded
//   • DELAYED (amber) — ran 26–50h ago (one missed run) and succeeded
//   • STALE   (red)   — >50h since any run, never run, or the last run failed
//
// Styling matches LiftFreshnessBadge so the two read as one family.
// ═══════════════════════════════════════════════════════════════════════════

const FRESH_MS   = 26 * 60 * 60 * 1000   // one daily run + grace
const DELAYED_MS = 50 * 60 * 60 * 1000   // two missed runs

function parseTs(s) {
  if (!s) return null
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s)
  return new Date(hasTz ? s : s + 'Z')
}

function relativeTime(ts) {
  if (!ts) return 'never'
  const mins = Math.round((Date.now() - parseTs(ts).getTime()) / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24)  return `${hrs} hr${hrs !== 1 ? 's' : ''} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days !== 1 ? 's' : ''} ago`
}

const TIERS = {
  fresh:   { dot: '#0F7A4E', halo: '15,122,78',  word: 'LIVE'    },
  delayed: { dot: '#C17F24', halo: '193,127,36', word: 'DELAYED' },
  stale:   { dot: '#E5484D', halo: '229,72,77',  word: 'STALE'   },
}

// A feed leg is fine if it wrote, or skipped because nothing had changed.
// "skipped" is a healthy steady state here, not a warning.
function legLabel(leg) {
  if (!leg) return null
  if (leg.error)         return 'error'
  if (leg.guard_tripped) return 'guard held'
  if (leg.written)       return 'loaded'
  if (leg.skipped)       return 'no change'
  return 'ok'
}

export default function ShareFileFreshnessBadge({ compact = false }) {
  const [health, setHealth] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [, setTick] = useState(0)

  async function load() {
    const { data } = await supabase
      .from('integration_state')
      .select('value, updated_at')
      .eq('key', 'sharefile_health')
      .maybeSingle()
    setHealth(data || null)
    setLoaded(true)
  }

  useEffect(() => {
    load()
    const q = setInterval(load, 10 * 60 * 1000)
    const t = setInterval(() => setTick(n => n + 1), 60 * 1000)
    return () => { clearInterval(q); clearInterval(t) }
  }, [])

  const v = health?.value || null
  const lastRun = v?.ran_at || health?.updated_at || null

  let tier = 'stale'
  if (lastRun) {
    const age = Date.now() - parseTs(lastRun).getTime()
    if (v?.ok === false) tier = 'stale'          // a failed run is red regardless of recency
    else if (age <= FRESH_MS)   tier = 'fresh'
    else if (age <= DELAYED_MS) tier = 'delayed'
  }

  const { dot, halo, word } = TIERS[tier]
  const jen  = legLabel(v?.jen)
  const vena = legLabel(v?.vena)

  // Prefer the specific reason when something is wrong — "STALE" alone sends
  // someone hunting. Name the leg and the cause.
  const detail = !loaded ? 'checking…'
    : v?.error                 ? v.error
    : v?.jen?.error            ? `Jen feed: ${v.jen.error}`
    : v?.vena?.error           ? `Vena feed: ${v.vena.error}`
    : v?.jen?.guard_tripped    ? 'Jen feed held — incoming file looked truncated'
    : v?.vena?.guard_tripped   ? 'Vena feed held — sheet shape changed'
    : !lastRun                 ? 'no run recorded yet'
    : `Jen ${jen} · Vena ${vena} · last run ${relativeTime(lastRun)}`

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
      <style>{`
        @keyframes sfHeartbeat {
          0%, 100% { transform: scale(1);    box-shadow: 0 0 0 4px rgba(var(--sf-halo),0.20), 0 0 0 8px  rgba(var(--sf-halo),0); }
          50%      { transform: scale(1.25); box-shadow: 0 0 0 6px rgba(var(--sf-halo),0.10), 0 0 0 14px rgba(var(--sf-halo),0); }
        }
      `}</style>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        <span style={{
          '--sf-halo': halo,
          width: 12, height: 12, borderRadius: '50%', background: dot, display: 'inline-block',
          boxShadow: `0 0 0 4px rgba(${halo},0.18)`,
          animation: 'sfHeartbeat 1.4s ease-in-out infinite',
        }} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.28em', textTransform: 'uppercase', color: dot }}>
          FINANCE FEED · {word}
        </span>
      </div>
      {!compact && (
        <span style={{ fontSize: 10, color: C.inkLight, paddingLeft: 24 }}>
          {detail}
        </span>
      )}
    </div>
  )
}
