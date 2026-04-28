import React from 'react'
import { format, addDays } from 'date-fns'
import { getFiscalLabel } from '../fiscalCalendar'
import KPIScorecard from './KPIScorecard'
import ProductionDashboard from './ProductionDashboard'
import ClaudeReadBlock from './ClaudeReadBlock'
import WeekPaceStrip from './WeekPaceStrip'
import { buildWeeklyRecapNarrativePrompt } from '../lib/prompts/weeklyRecapNarrative'
import styles from './ExecutiveDashboardPage.module.css'

/**
 * ExecutiveDashboardPage — the weekly recap view for FSCO leadership.
 *
 * Routed when mode === 'executive' AND activeTab === 'dashboard'.
 *
 * Page structure (top to bottom):
 *   1. Page header — eyebrow, week title, fiscal label, prepared-by attribution
 *   2. KPI status strip — counts of green/amber/red KPIs (only if KPIs are populated)
 *   3. WeekPaceStrip — the embedded mini Run Rate panel showing THIS week's pace
 *      (so execs see live pace without having to toggle to Operations mode)
 *   4. ClaudeReadBlock with `time_window='recap'` and the weekly recap prompt —
 *      auto-generates an executive recap narrative, editable, save-able
 *   5. Areas of Concern — if `concerns` field is populated for the week
 *   6. Production Summary — Brooklyn (BNY) and Passaic detail
 *   7. KPI Scorecard Detail — full breakdown of each KPI
 *
 * What's new vs the old ExecutiveDashboardPage:
 *   - v5 visual treatment (Georgia serif headers, italic subtitles, cream-dark accents)
 *   - WeekPaceStrip embedded so execs always see this week's pace inline
 *   - The old "Executive Summary" narrative (manually drafted in admin) is replaced
 *     by Claude's weekly recap — auto-generated from real data, editable, save-able
 *   - The old narrative in `weeks.executive_narrative` is honored as a fallback if
 *     it exists, but new narratives go to dashboard_narratives keyed by 'recap'
 *
 * Props:
 *   weekStart     Date — the Monday of the week being recapped
 *   weekData      object — row from `weeks` table (kpis, concerns, etc.)
 *   dbReady       boolean — false if Supabase not configured
 *   commentProps  { currentUser, onCommentPosted } — passed to children
 *   currentUser   string — full name (for ClaudeReadBlock attribution)
 *   userId        string — auth UUID (for edited_by FK)
 */
export default function ExecutiveDashboardPage({
  weekStart,
  weekData,
  dbReady,
  commentProps,
  currentUser,
  userId,
}) {
  const fiscalLabel = getFiscalLabel(weekStart)
  const kpis = weekData?.kpis || {}
  const flags = weekData?.flags || weekData?.concerns || null
  const kpiList = Object.values(kpis)
  const onTrack = kpiList.filter(k => k?.status === 'green').length
  const watch   = kpiList.filter(k => k?.status === 'amber').length
  const concern = kpiList.filter(k => k?.status === 'red').length
  const hasKPIs = kpiList.length > 0

  const weekEnd = addDays(weekStart, 4)
  const dateRange = `${format(weekStart, 'MMM d')}–${format(weekEnd, 'd, yyyy')}`

  // Determine if there's enough production data for Claude's recap
  // (so the prompt can adjust tone if data hasn't been entered yet)
  const hasData = !!(weekData && (weekData.kpis || weekData.executive_narrative))

  return (
    <div className={styles.page}>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Weekly Operations Report · Recap</div>
          <h1 className={styles.title}>{dateRange}</h1>
          {fiscalLabel && <div className={styles.fiscalLabel}>{fiscalLabel}</div>}
        </div>
        <div className={styles.preparedBy}>
          <div className={styles.preparedLabel}>Prepared for</div>
          <div className={styles.preparedTeam}>FSCO Executive Team</div>
          <div className={styles.preparedSub}>Paramount Prints · F. Schumacher &amp; Co.</div>
        </div>
      </div>

      {/* ── KPI Status Strip ────────────────────────────────────────────── */}
      {hasKPIs && (
        <div className={styles.statusStrip}>
          {[
            { color: '#4F8A4B', count: onTrack, label: 'On Track' },
            { color: '#C49A2A', count: watch,   label: 'Watch'    },
            { color: '#B0533C', count: concern, label: 'Concern'  },
          ].map(({ color, count, label }) => (
            <div key={label} className={styles.statusItem}>
              <span className={styles.statusDot} style={{ background: color }} />
              <span className={styles.statusText}>
                <strong>{count}</strong> {label}
              </span>
            </div>
          ))}
          <div className={styles.statusSpacer} />
          <div className={styles.statusMeta}>KPI Scorecard · {kpiList.length} metrics</div>
        </div>
      )}

      {/* ── This Week's Pace (embedded mini Run Rate) ──────────────────── */}
      <WeekPaceStrip />

      {/* ── Claude's Executive Recap ──────────────────────────────────── */}
      <SectionLabel>Executive Recap</SectionLabel>
      <ClaudeReadBlock
        weekStart={weekStart}
        timeWindow="recap"
        currentData={{
          actuals:  {}, // recap focuses on whole-week, so detailed metrics come from contextBuilder's recent-weeks block
          expected: {},
          gaps:     {},
          hasData,
        }}
        currentUser={currentUser}
        userId={userId}
        eyebrow="Claude's recap"
        subtitle="Executive summary of the week — performance, financials, and what to watch."
        promptBuilder={buildWeeklyRecapNarrativePrompt}
      />

      {/* ── Areas of Concern (legacy field, surfaced if present) ──────── */}
      {flags && (
        <>
          <SectionLabel>Areas of Concern</SectionLabel>
          <div className={styles.concernsBlock}>{flags}</div>
        </>
      )}

      {/* ── Production Summary ────────────────────────────────────────── */}
      <SectionLabel>Production — Brooklyn (BNY) &amp; Passaic</SectionLabel>
      <div className={styles.subPanel}>
        <ProductionDashboard
          weekStart={weekStart}
          dbReady={dbReady}
          readOnly
          {...commentProps}
        />
      </div>

      {/* ── KPI Scorecard Detail ──────────────────────────────────────── */}
      {hasKPIs && (
        <>
          <SectionLabel>KPI Scorecard Detail</SectionLabel>
          <div className={styles.subPanel}>
            <KPIScorecard
              weekData={weekData}
              weekStart={weekStart}
              onSave={null}
              dbReady={dbReady}
              readOnly
              {...commentProps}
            />
          </div>
        </>
      )}
    </div>
  )
}

function SectionLabel({ children }) {
  return <div className={styles.sectionLabel}>{children}</div>
}
