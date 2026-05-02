import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, SITES, isoDate, defaultSchedulerWeek } from '../lib/scheduleUtils'
import PassaicScheduler from './PassaicScheduler'
import BNYScheduler from './BNYScheduler'

// ═══════════════════════════════════════════════════════════════════════════
// SchedulerTab — schedule grid orchestrator
//
// Stripped-down responsibility (Push C-prep, May 2026):
//   • Site pill (Passaic / BNY)
//   • Routes to PassaicScheduler / BNYScheduler for the weekly schedule grid
//
// LIFT WIP upload moved to the WIP tab (the data source of truth). Scheduler
// reads from sched_wip_rows like before — same snapshot, just refreshed
// from the WIP tab now. Refresh button stays here so users can pull the
// latest snapshot after a co-worker uploads on another tab.
//
// WIP-list, New-Goods, and Procurement views previously lived here. They
// now live in the WIP tab.
// ═══════════════════════════════════════════════════════════════════════════

// Filter scheduleUtils' SITES down to the two that actually get scheduled.
// Procurement is pass-through (no scheduling) and now lives in the WIP tab.
const SCHEDULER_SITES = SITES.filter(s => s.key === 'passaic' || s.key === 'bny')

export default function SchedulerTab() {
  const [site, setSite] = useState('passaic')
  const [snapshot, setSnapshot] = useState(null)
  const [wipRows, setWipRows] = useState([])
  const [assignments, setAssignments] = useState([])
  const [weekStart, setWeekStart] = useState(defaultSchedulerWeek())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function loadLatest() {
    setLoading(true); setError(null)
    try {
      const { data: snaps, error: se } = await supabase
        .from('sched_snapshots')
        .select('*')
        .order('uploaded_at', { ascending: false })
        .limit(1)
      if (se) throw se
      const snap = snaps?.[0] || null
      setSnapshot(snap)

      if (!snap) { setWipRows([]); setAssignments([]); return }

      const all = []
      const pageSize = 1000
      let from = 0
      while (true) {
        const { data, error: re } = await supabase
          .from('sched_wip_rows')
          .select('*')
          .eq('snapshot_id', snap.id)
          .eq('site', site)
          .range(from, from + pageSize - 1)
        if (re) throw re
        if (!data || data.length === 0) break
        all.push(...data)
        if (data.length < pageSize) break
        from += pageSize
      }
      setWipRows(all)

      const { data: asg, error: ae } = await supabase
        .from('sched_assignments')
        .select('*')
        .eq('site', site)
        .eq('week_start', isoDate(weekStart))
      if (ae) throw ae
      setAssignments(asg || [])
    } catch (e) {
      console.error(e); setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadLatest() }, [site, weekStart])

  async function reloadAssignments() {
    const { data } = await supabase
      .from('sched_assignments')
      .select('*')
      .eq('site', site)
      .eq('week_start', isoDate(weekStart))
    setAssignments(data || [])
  }

  return (
    <div style={{ background: C.cream, minHeight: '100vh', padding: '0 0 48px', fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      <div style={{ padding: '20px 0 16px', marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: C.ink, fontFamily: 'Georgia,serif' }}>Production · Scheduler</h2>
            <p style={{ fontSize: 13, color: C.inkLight, margin: '4px 0 0' }}>
              LIFT WIP · {snapshot ? `Uploaded ${new Date(snapshot.uploaded_at).toLocaleString()}` : 'No data yet — upload on the WIP tab'}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={loadLatest} disabled={loading}
              style={{ padding: '9px 16px', background: 'transparent', color: C.inkMid, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>
        {error && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.rose, background: C.roseBg, border: '1px solid #E8A0A0', borderRadius: 6, padding: '8px 12px' }}>{error}</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {SCHEDULER_SITES.map(s => {
          const active = site === s.key
          return (
            <button key={s.key} onClick={() => setSite(s.key)}
              style={{ padding: '10px 18px', borderRadius: 8, border: `1.5px solid ${active ? s.color : C.border}`, background: active ? s.color : 'transparent', color: active ? '#fff' : C.inkMid, fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 130, gap: 2 }}>
              <span>{s.label}</span>
              <span style={{ fontSize: 10, opacity: 0.75, fontWeight: 400, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.sub}</span>
            </button>
          )
        })}
      </div>

      {!snapshot && !loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.2 }}>⌘</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.inkMid, fontFamily: 'Georgia,serif', marginBottom: 8 }}>No WIP data yet</div>
          <div style={{ fontSize: 13, color: C.inkLight }}>Head to the WIP tab and upload the latest LIFT export to get started.</div>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: C.inkLight, fontSize: 14 }}>Loading…</div>
      )}

      {snapshot && !loading && site === 'passaic' && (
        <PassaicScheduler
          wipRows={wipRows}
          assignments={assignments}
          weekStart={weekStart}
          onWeekChange={setWeekStart}
          onAssignmentsChange={reloadAssignments}
        />
      )}

      {snapshot && !loading && site === 'bny' && (
        <BNYScheduler
          wipRows={wipRows}
          assignments={assignments}
          weekStart={weekStart}
          onWeekChange={setWeekStart}
          onAssignmentsChange={reloadAssignments}
        />
      )}
    </div>
  )
}
