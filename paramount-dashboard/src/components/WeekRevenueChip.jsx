import { C, schedLineKey } from '../lib/scheduleUtils'
import { forecastWeeklyRevenue } from '../lib/budgets'

// ═══════════════════════════════════════════════════════════════════════════
// WeekRevenueChip — scheduled revenue for the visible week vs the deck-
// forecast weekly target, in the SchedulerTab header (Peter, 2026-07-30:
// keep the at-a-glance header number AND the in-page Revenue gauge).
//
// CRITICAL DESIGN CONSTRAINT — this chip must agree with the Revenue gauge
// to the dollar, or the page tells two stories (the exact incoherence Peter
// flagged when the first version priced piece-goods at full order value and
// read $137.8K against the gauge's $126K). So the computation below MIRRORS
// PassaicScheduler's mixTotals exactly: per assignment, resolve the WIP line
// by line signature (PO+SKU+color) with PO-level fallback, price at that
// line's income_written / yards_written, sum planned_yards × rate. Zero-yard
// piece goods therefore price at ZERO here too — matching the gauge — and
// their value shows up when invoiced, not when scheduled. If mixTotals'
// pricing ever changes, change this the same way.
//
// PURE component: SchedulerTab already holds wipRows and the week's
// assignments; nothing is fetched.
// ═══════════════════════════════════════════════════════════════════════════

const k = (n) => '$' + (Math.round(n / 100) / 10).toLocaleString() + 'K'

export default function WeekRevenueChip({ site, wipRows, assignments }) {
  const target = forecastWeeklyRevenue(site)
  if (!target) return null

  // Index WIP rows the same two ways the schedulers do.
  const byLine = {}
  const byPO = {}
  for (const r of wipRows || []) {
    byLine[schedLineKey(r)] = r
    if (r.po_number) byPO[r.po_number] = r
  }

  let sched = 0
  for (const a of assignments || []) {
    const src = byLine[schedLineKey(a)] || byPO[a.po_number] || {}
    const rate = src.income_written && src.yards_written
      ? src.income_written / src.yards_written
      : 0
    sched += (Number(a.planned_yards) || 0) * rate
  }

  const pct = (sched / target) * 100
  const color = pct >= 100 ? 'var(--green)' : pct >= 85 ? 'var(--amber)' : 'var(--red)'

  return (
    <div
      title={'Scheduled revenue this week vs the weekly target from the month-end deck forecast (June 2026 ÷ 5 fiscal weeks). Same computation as the Revenue gauge below — each assignment priced at its WIP line\u2019s written income per yard.'}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 7, padding: '8px 13px',
        borderRadius: 8, border: `1px solid ${C.border}`, background: 'var(--surface)',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-40)', fontWeight: 600 }}>
        Wk rev
      </span>
      <span style={{ fontSize: 15, fontWeight: 700, color, fontFamily: 'var(--font-display)' }}>
        {k(sched)}
      </span>
      <span style={{ fontSize: 11, color: 'var(--ink-60)' }}>
        / {k(target)} target · {Math.round(pct)}%
      </span>
    </div>
  )
}
