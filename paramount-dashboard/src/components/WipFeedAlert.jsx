import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, STATUS_BAD, STATUS_BAD_BORDER } from '../lib/scheduleUtils'

// WipFeedAlert — prominent banner when the automated LIFT -> WIP feed is DOWN.
// Reads the lift_wip_health heartbeat the lift-wip-sync function writes each run
// (ok:false + the error when LIFT's ORDS API stops responding) and shows how old
// the displayed snapshot is, so stale numbers can't pass for current ones.
// Renders nothing when healthy and clears itself on the next good run (re-polls
// every few minutes). Complements the quieter LiftFreshnessBadge, which only
// reddens after 24h of snapshot age — too slow to catch a mid-day LIFT outage.

function parseTs(s) {
  if (!s) return null
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s)
  return new Date(hasTz ? s : s + 'Z')
}
function ago(s) {
  const t = parseTs(s); if (!t) return ''
  const mins = Math.round((Date.now() - t.getTime()) / 60000)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs !== 1 ? 's' : ''} ago`
  const d = Math.round(hrs / 24)
  return `${d} day${d !== 1 ? 's' : ''} ago`
}
function clockET(s) {
  const t = parseTs(s); if (!t) return ''
  return t.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function WipFeedAlert() {
  const [health, setHealth] = useState(null)
  const [snapAt, setSnapAt] = useState(null)

  async function load() {
    try {
      const [{ data: h }, { data: s }] = await Promise.all([
        supabase.from('integration_state').select('value').eq('key', 'lift_wip_health').limit(1),
        supabase.from('sched_snapshots').select('uploaded_at').order('uploaded_at', { ascending: false }).limit(1),
      ])
      setHealth(h && h[0] ? h[0].value : null)
      setSnapAt(s && s[0] ? s[0].uploaded_at : null)
    } catch { /* best-effort: a read failure just hides the banner */ }
  }

  useEffect(() => {
    load()
    const q = setInterval(load, 3 * 60 * 1000)
    return () => clearInterval(q)
  }, [])

  if (!health || health.ok !== false) return null

  return (
    <div role="alert" style={{
      margin: '12px 0 4px', padding: '12px 16px', borderRadius: 8,
      background: C.roseBg, border: `1px solid ${STATUS_BAD_BORDER}`, borderLeft: `4px solid ${STATUS_BAD}`,
      display: 'flex', gap: 12, alignItems: 'flex-start',
    }}>
      <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1.2 }}>⚠️</span>
      <div style={{ fontSize: 13, color: C.rose, lineHeight: 1.5 }}>
        <div style={{ fontWeight: 700 }}>WIP feed down — the automated LIFT sync isn’t updating.</div>
        <div style={{ marginTop: 3 }}>
          These numbers are the last good snapshot{snapAt ? ` from ${clockET(snapAt)} (${ago(snapAt)})` : ''}, not current.
          LIFT’s reporting API stopped responding{health.ran_at ? `; last checked ${clockET(health.ran_at)}` : ''}.
          WIP refreshes on its own once LIFT is back.
        </div>
        {health.error && (
          <div style={{ marginTop: 4, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11, opacity: 0.85 }}>
            {String(health.error)}
          </div>
        )}
      </div>
    </div>
  )
}
