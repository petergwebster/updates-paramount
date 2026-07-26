import React from 'react'
import { destinationsFor, DESTINATIONS } from '../lib/access'
import styles from './DestinationNav.module.css'

/**
 * DestinationNav — the top-level pill toggle that lives in the App header
 * once a user has entered a destination.
 *
 * Shows ONLY destinations the user has access to. If the user only has access
 * to one destination, no toggle is shown at all.
 *
 * 2026-07-25: the "← Welcome" button was removed. With two destinations the
 * chooser is a detour, not a destination — you land in one and switch between
 * them here. The Welcome page still exists as the login landing for users who
 * have a genuine choice to make.
 *
 * Props:
 *   userProfile — for computing access
 *   activeDestination — current destination id
 *   onChange — (destinationId) => void
 */
export default function DestinationNav({ userProfile, activeDestination, onChange }) {
  const accessible = destinationsFor(userProfile)

  // No nav needed if user only has one destination
  if (accessible.length <= 1) return null

  return (
    <div className={styles.nav}>
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
