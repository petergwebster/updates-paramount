import React from 'react'
import { destinationsFor, DESTINATIONS } from '../lib/access'
import styles from './DestinationNav.module.css'

/**
 * DestinationNav — the top-level pill toggle that lives in the App header
 * once a user has entered a destination.
 *
 * Shows ONLY destinations the user has access to. If the user only has access
 * to one destination, no toggle is shown (just the brand and back button hidden).
 *
 * Props:
 *   userProfile — for computing access
 *   activeDestination — current destination id
 *   onChange — (destinationId) => void; passing 'landing' returns to chooser
 */
export default function DestinationNav({ userProfile, activeDestination, onChange }) {
  const accessible = destinationsFor(userProfile)

  // No nav needed if user only has one destination
  if (accessible.length <= 1) return null

  return (
    <div className={styles.nav}>
      <button
        type="button"
        className={`${styles.navBtn} ${styles.back}`}
        onClick={() => onChange('landing')}
        title="Back to Welcome"
      >
        ← Welcome
      </button>
      {accessible.map(destId => {
        const dest = DESTINATIONS[destId]
        const isActive = activeDestination === destId
        return (
          <button
            key={destId}
            type="button"
            className={`${styles.navBtn} ${isActive ? styles.active : ''}`}
            onClick={() => onChange(destId)}
          >
            {dest.shortName}
          </button>
        )
      })}
    </div>
  )
}
