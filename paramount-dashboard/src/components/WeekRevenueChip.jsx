import { C } from '../lib/scheduleUtils'
import { forecastWeeklyRevenue } from '../lib/budgets'

// ═══════════════════════════════════════════════════════════════════════════
// WeekRevenueChip — scheduled revenue for the visible week vs the deck-
// forecast weekly target (exec ask, 2026-07-29 meeting).
//
// PURE component: SchedulerTab already holds the site's wipRows and the
// week's assignments, so this computes from props and fetches nothing.
// Mounted once in SchedulerTab's header, it serves both schedulers and
// re-renders on every site/week change and assignment reload.
//
// PRICING: each PO's $/yd comes from its own WIP rows — income_written /
// yards_written (the dollars were in the LIFT feed all along). Planned
// yards are summed per PO across all placements FIRST, then priced once —
// a PO split across tables or days must not double-count, and piece goods
// (memos/panel sets: income but zero written yards) contribute their whole
// order value once when scheduled. A PO no longer in the pool (invoiced
// since scheduling) prices at zero — slight undercount, visible not silent.
// ═══════════════════════════════════════════════════════════════════════════

const k = (n) => '$' + (Math.round(n / 100) / 10).toLocaleString() + 'K'

export default function WeekRevenueChip({ site, wipRows, assignments }) {
  const target = forecastWeeklyRevenue(site)
  if (!target) return null

  // $/yd per PO from the pool.
  const pool = new Map()
  for (const r of wipRows || []) {
    const po = r.po_number || r.order_number
    if (!po) continue
    const p = pool.get(po) || { income: 0, yards: 0 }
    p.income += Number(r.income_written) || 0
    p.yards  += Number(r.yards_written) || 0
    pool.set(po, p)
  }

  // Planned yards per PO across the whole week.
  const planned = new Map()
  for (const a of assignments || []) {
    if (!a.po_number) continue
    planned.set(a.po_number, (planned.get(a.po_number) || 0) + (Number(a.planned_yards) || 0))
  }

  let sched = 0
  for (const [po, yds] of planned) {
    const p = pool.get(po)
    if (!p || !p.income) continue
    if (p.yards > 0) sched += yds * (p.income / p.yards)
    else sched += p.income
  }

  const pct = (sched / target) * 100
  const color = pct >= 100 ? 'var(--green)' : pct >= 85 ? 'var(--amber)' : 'var(--red)'

  return (
    <div
      title={'Scheduled revenue this week vs the weekly target from the month-end deck forecast (June 2026 ÷ 5 fiscal weeks). Each PO priced at its own written income per yard; piece goods count at full order value.'}
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
