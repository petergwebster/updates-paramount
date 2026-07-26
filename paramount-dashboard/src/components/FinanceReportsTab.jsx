import React, { useState } from 'react'
import MonthlyBriefs from './MonthlyBriefs'
import WeeklyProductionSummary from './WeeklyProductionSummary'
import ExecutiveDashboardPage from './ExecutiveDashboardPage'
import ProductionDashboard from './ProductionDashboard'

// ═══════════════════════════════════════════════════════════════════════════
// FinanceReportsTab — one home for everything that produces a report.
//
// These four surfaces were scattered: Monthly Briefs and the Weekly Production
// Summary sat behind the Admin gear (they are finance/reporting work wearing an
// admin costume), while the exec Recap and the capacity Dashboard were their own
// top-level tabs almost nobody opened. Collecting them here keeps the Finance
// tab strip to five items and makes "generate and send" one place rather than
// three.
//
// DIRECTION OF TRAVEL (Peter, Q4): the exec Recap stops being a screen someone
// visits and becomes a report that generates and emails itself. It is listed
// here as a report, not as a destination, on purpose — that is the shape it is
// heading toward.
// ═══════════════════════════════════════════════════════════════════════════

const REPORTS = [
  { id: 'monthly', label: 'Monthly brief',    sub: 'Mid-month and end-of-month, for FSCO leadership' },
  { id: 'weekly',  label: 'Weekly production', sub: 'The operating week — tables, operators, waste, lost capacity' },
  { id: 'recap',   label: 'Exec recap',        sub: 'Weekly narrative. Becomes a generated email in Q4.' },
  { id: 'capacity',label: 'Capacity',          sub: 'MTD and YTD against plan' },
]

export default function FinanceReportsTab({
  weekStart, weekData, dbReady, commentProps, currentUser, userId, authUser,
}) {
  const [active, setActive] = useState('monthly')

  const S = {
    wrap:   { padding: '24px 28px 8px', maxWidth: 1180, margin: '0 auto' },
    over:   { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'var(--ink-60)', marginBottom: 4 },
    h:      { fontSize: 22, fontWeight: 600, margin: '0 0 18px' },
    grid:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))', gap: 10, marginBottom: 8 },
    card:   (on) => ({
              textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
              background: on ? 'var(--accent-light)' : 'var(--surface)',
              color: 'var(--ink)',
              border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
            }),
    cardT:  { fontSize: 13, fontWeight: 600, marginBottom: 3 },
    cardS:  (on) => ({ fontSize: 11, lineHeight: 1.45, color: on ? 'var(--accent-mid)' : 'var(--ink-60)' }),
  }

  return (
    <div>
      <div style={S.wrap}>
        <div style={S.over}>Finance · reporting</div>
        <h2 style={S.h}>Reports</h2>
        <div style={S.grid}>
          {REPORTS.map(r => {
            const on = active === r.id
            return (
              <button key={r.id} onClick={() => setActive(r.id)} style={S.card(on)}>
                <div style={S.cardT}>{r.label}</div>
                <div style={S.cardS(on)}>{r.sub}</div>
              </button>
            )
          })}
        </div>
      </div>

      {active === 'monthly' && (
        <MonthlyBriefs weekStart={weekStart} authUser={authUser} />
      )}
      {active === 'weekly' && (
        <WeeklyProductionSummary weekStart={weekStart} authUser={authUser} />
      )}
      {active === 'recap' && (
        <ExecutiveDashboardPage
          weekStart={weekStart}
          weekData={weekData}
          dbReady={dbReady}
          commentProps={commentProps}
          currentUser={currentUser}
          userId={userId}
        />
      )}
      {active === 'capacity' && (
        <ProductionDashboard weekStart={weekStart} readOnly={true} />
      )}
    </div>
  )
}
