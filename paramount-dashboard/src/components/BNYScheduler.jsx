import { C } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// BNYScheduler — STUB for commit 1 (architecture-ready refactor)
// Wired into the orchestrator but not reachable via UI yet, because the
// view toggle is still Passaic-only. The real MVP lands in commit 3.
// Props interface matches PassaicScheduler for easy swap-in.
// ═══════════════════════════════════════════════════════════════════════════
export default function BNYScheduler({ wipRows, assignments, weekStart, onWeekChange, onAssignmentsChange }) {
  return (
    <div style={{ textAlign: 'center', padding: '80px 20px' }}>
      <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.2 }}>✦</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: C.inkMid, fontFamily: 'Georgia,serif', marginBottom: 8 }}>
        BNY Scheduler — coming next commit
      </div>
      <div style={{ fontSize: 13, color: C.inkLight, maxWidth: 440, margin: '0 auto' }}>
        Machine-day capacity grid with operator assignment, Replen / New Goods / MTO / HOS / Memo / 3P mix gauges, and Ask Claude wired for Chandler.
      </div>
    </div>
  )
}
