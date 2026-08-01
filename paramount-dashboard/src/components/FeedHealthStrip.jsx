import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

// ═══════════════════════════════════════════════════════════════════════════
// FeedHealthStrip — the two automated feeds, visible from every destination.
//
// WHY IT LIVES IN THE HEADER: if you are managing to the dashboard rather than
// walking the floor, feed health is the first thing you need to trust and the
// last thing that should require navigation. It is not a tab.
//
// TWO FEEDS + THE AUDITOR. The LIFT snapshot IS the WIP pool — a separate "WIP"
// light would be inventing a distinction that does not exist in the plumbing.
//   • LIFT    — lift-wip-sync, hourly. Source: newest sched_snapshots.uploaded_at
//   • Finance — sharefile-sync, daily 9am ET. Source: integration_state
//               where key = 'sharefile_health' (the only row RLS exposes to the
//               browser; the OAuth token in that table is not readable here)
//   • Audit   — audit-nightly, daily ~1am ET: the 13-check data-integrity
//               battery. Not a feed — the thing that CHECKS the feeds and the
//               invariants behind every number on screen. Green = ran recently
//               AND zero fails AND zero warns; a warn shows amber so it nags
//               without alarming; silence goes red like everything else.
//
// GREEN REQUIRES RECENCY *AND* OUTCOME. A light that only reports the last
// outcome stays green forever if a feed stops running altogether — which has
// already happened once on this site, when a netlify.toml schedule deployed
// clean and never ticked. Silence is treated as failure, not success.
// ═══════════════════════════════════════════════════════════════════════════

const LIFT_FRESH   = 2  * 60 * 60 * 1000   // hourly cron + grace
const LIFT_DELAYED = 24 * 60 * 60 * 1000
const FIN_FRESH    = 26 * 60 * 60 * 1000   // daily cron + grace
const FIN_DELAYED  = 50 * 60 * 60 * 1000

const TIERS = {
  fresh:   { dot: '#0F7A4E', label: 'live'    },
  delayed: { dot: '#C17F24', label: 'delayed' },
  stale:   { dot: '#E5484D', label: 'stale'   },
}

function parseTs(s) {
  if (!s) return null
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s)
  return new Date(hasTz ? s : s + 'Z')
}

function ago(ts) {
  if (!ts) return 'never'
  const mins = Math.round((Date.now() - parseTs(ts).getTime()) / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24)  return `${hrs} hr${hrs !== 1 ? 's' : ''} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days !== 1 ? 's' : ''} ago`
}

function tier(ts, freshMs, delayedMs, failed) {
  if (failed) return 'stale'
  if (!ts) return 'stale'
  const age = Date.now() - parseTs(ts).getTime()
  if (age <= freshMs)   return 'fresh'
  if (age <= delayedMs) return 'delayed'
  return 'stale'
}

function Pill({ name, tierKey, detail }) {
  const t = TIERS[tierKey] || TIERS.stale
  return (
    <span
      title={`${name} — ${t.label}. ${detail}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
    >
      <span style={{
        '--fh': t.dot.replace('#', ''),
        width: 8, height: 8, borderRadius: '50%', background: t.dot,
        display: 'inline-block', flexShrink: 0,
        animation: 'fhPulse 1.8s ease-in-out infinite',
      }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: t.dot, letterSpacing: '0.02em' }}>{name}</span>
    </span>
  )
}

export default function FeedHealthStrip() {
  const [lift, setLift]   = useState(null)
  const [fin, setFin]     = useState(null)
  const [audit, setAudit] = useState(null)
  const [, setTick]       = useState(0)

  async function load() {
    const [{ data: snap }, { data: health }, { data: auditRun }] = await Promise.all([
      supabase.from('sched_snapshots').select('uploaded_at')
        .order('uploaded_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('integration_state').select('value, updated_at')
        .eq('key', 'sharefile_health').maybeSingle(),
      supabase.from('audit_runs').select('ran_at, checks_run, passed, warned, failed')
        .order('ran_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    setLift(snap?.uploaded_at || null)
    setFin(health || null)
    setAudit(auditRun || null)
  }

  useEffect(() => {
    load()
    const q = setInterval(load, 10 * 60 * 1000)
    const t = setInterval(() => setTick(n => n + 1), 60 * 1000)
    return () => { clearInterval(q); clearInterval(t) }
  }, [])

  const v = fin?.value || null
  const finRun = v?.ran_at || fin?.updated_at || null
  const finFailed = v?.ok === false

  const liftTier = tier(lift, LIFT_FRESH, LIFT_DELAYED, false)
  const finTier  = tier(finRun, FIN_FRESH, FIN_DELAYED, finFailed)

  // Audit: failed → red; warned → amber; clean-and-recent → green;
  // silence (never ran / past grace) → red, same as everything else.
  const auditBase = tier(audit?.ran_at, FIN_FRESH, FIN_DELAYED, (audit?.failed || 0) > 0)
  const auditTier = auditBase === 'fresh' && (audit?.warned || 0) > 0 ? 'delayed' : auditBase
  const auditDetail = !audit
    ? 'No audit run yet'
    : `${audit.checks_run} checks · ${audit.passed} pass / ${audit.warned} warn / ${audit.failed} fail · ran ${ago(audit.ran_at)}`

  const finDetail = v?.error            ? v.error
    : v?.jen?.error                     ? `Jen feed: ${v.jen.error}`
    : v?.vena?.error                    ? `Vena feed: ${v.vena.error}`
    : v?.jen?.guard_tripped             ? 'Jen feed held — file looked truncated'
    : v?.vena?.guard_tripped            ? 'Vena feed held — sheet shape changed'
    : `Last run ${ago(finRun)}`

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
      <style>{`
        @keyframes fhPulse {
          0%, 100% { transform: scale(1);   opacity: 1;   }
          50%      { transform: scale(1.2); opacity: 0.75; }
        }
      `}</style>
      <Pill name="LIFT"    tierKey={liftTier} detail={`Last snapshot ${ago(lift)}`} />
      <Pill name="Finance" tierKey={finTier}  detail={finDetail} />
      <Pill name="Audit"   tierKey={auditTier} detail={auditDetail} />
    </div>
  )
}
