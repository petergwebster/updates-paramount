import React from 'react'
import { destinationsFor, DESTINATIONS } from '../lib/access'
import styles from './LandingPage.module.css'

/**
 * LandingPage — the destination chooser.
 *
 * Every user lands here after login. Shows three destination tiles
 * (Performance, Operations, Heartbeat). Tiles the user doesn't have access
 * to are not rendered.
 *
 * The "live pulse" data shown on each tile is intentionally NOT wired in this
 * phase — those status lines are hardcoded placeholders. Wiring them to real
 * data is a follow-up phase. For now they communicate the design intent.
 *
 * Props:
 *   userProfile  — row from `profiles` table (includes role, active, full_name)
 *   onChoose     — callback (destinationId) => void, parent routes to that destination
 */
export default function LandingPage({ userProfile, onChoose }) {
  const accessible = destinationsFor(userProfile)
  const firstName = userProfile?.full_name?.split(' ')[0] || 'there'

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <svg className={styles.heroArc} viewBox="0 0 280 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M 10 45 Q 140 -10 270 45" stroke="currentColor" strokeWidth="1" fill="none" strokeDasharray="2 4" />
          <circle cx="140" cy="8" r="2.5" fill="var(--royal)" />
        </svg>

        <div className={styles.heroEyebrow}>Welcome, {firstName}</div>
        <h1 className={styles.heroTitle}>
          Paramount Prints — <span className={styles.accent}>where today?</span>
        </h1>
        <p className={styles.heroSub}>
          {accessible.length === 3
            ? 'Three destinations. Pick your altitude.'
            : accessible.length === 2
              ? 'Two destinations. Pick your altitude.'
              : accessible.length === 1
                ? 'Your destination is ready.'
                : 'No destinations available — contact your administrator.'}
        </p>
      </div>

      {accessible.length === 0 ? (
        <div className={styles.noAccess}>
          You don't currently have access to any destinations. If you believe this is a mistake,
          contact Peter Webster.
        </div>
      ) : (
        <div className={styles.tilesWrap}>
          <div className={styles.tiles} data-count={accessible.length}>
            {accessible.map(destId => {
              const dest = DESTINATIONS[destId]
              return (
                <DestinationTile
                  key={destId}
                  destination={dest}
                  pulses={getPulsesFor(destId)}
                  onClick={() => onChoose(destId)}
                />
              )
            })}
          </div>
        </div>
      )}

      <p className={styles.footnote}>
        Each destination has its own role-based permissions.
        Once you enter a destination, you can navigate between any others you have access to from the top nav.
      </p>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────── */

function DestinationTile({ destination, pulses, onClick }) {
  return (
    <button
      className={`${styles.tile} ${styles[destination.accentClass]}`}
      onClick={onClick}
      type="button"
    >
      <div className={styles.tileMission}>
        <span className={styles.dot} />
        {destination.mission}
      </div>
      <h2 className={styles.tileName}>{destination.name}</h2>
      <p className={styles.tileTag}>{destination.tagline}</p>
      <div className={styles.tileBody}>
        <div className={styles.pulseLabel}>Pulse · This week</div>
        <ul className={styles.pulseList}>
          {pulses.map((p, i) => (
            <li key={i}>
              <span className={`${styles.pulseChip} ${styles[p.tone]}`}>{p.chip}</span>
              {p.text}
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.tileFooter}>
        <span className={styles.tileEnter}>
          Enter <span className={styles.arrow}>→</span>
        </span>
        <span className={styles.tileAccess}>{destination.accessSummary}</span>
      </div>
    </button>
  )
}

/**
 * Hardcoded pulse data for now. Future phase wires these to real metrics.
 * Returning hardcoded values keeps the visual intent without lying about
 * data connections that don't exist yet.
 */
function getPulsesFor(destinationId) {
  switch (destinationId) {
    case 'performance':
      return [
        { chip: 'preview',  tone: 'neutral', text: 'Weekly recap, financials, people, inventory' },
        { chip: 'auto',     tone: 'neutral', text: "Claude's recap auto-generates Mondays" },
        { chip: 'rollup',   tone: 'neutral', text: 'KPIs and quarterly trends in one place' },
      ]
    case 'operations':
      return [
        { chip: 'live',  tone: 'emerald', text: 'Live Ops daily entry · Scheduler · WIP' },
        { chip: 'plan',  tone: 'neutral', text: 'Manage the production week from here' },
        { chip: 'tools', tone: 'neutral', text: 'For Wendy, Chandler, Shelby, and Sami' },
      ]
    case 'heartbeat':
      return [
        { chip: 'live',     tone: 'crimson', text: 'Plant pulse · Passaic + Brooklyn together' },
        { chip: 'detail',   tone: 'neutral', text: '17 tables · 7 machines · all in one view' },
        { chip: 'analysis', tone: 'neutral', text: "Claude's combined read on what's happening" },
      ]
    default:
      return []
  }
}
