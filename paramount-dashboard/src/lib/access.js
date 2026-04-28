/**
 * access.js — central source of truth for who can access what.
 *
 * Two concepts:
 *   1. Destination access: which of {performance, operations, heartbeat} a user can enter
 *   2. Super-admin: who can access User Management (only Peter)
 *
 * Roles (set in profiles.role column):
 *   - admin     — Peter, Brynn, Wendy: full access to all three destinations
 *   - exec      — leadership team: full access to all three destinations
 *   - manager   — Chandler, Shelby: Operations + Heartbeat
 *   - qa        — Sami: Operations + Heartbeat
 *
 * Inactive users (profiles.active = false) get no destinations regardless of role.
 *
 * Super-admin is hardcoded by email — only Peter can manage other users' rights.
 */

// Hardcoded super-admin email. Only this user sees User Management.
export const SUPER_ADMIN_EMAIL = 'pwebster@fsco.com'

/**
 * Returns the array of destinations a user can access.
 * @param {object} profile - row from `profiles` table
 * @returns {string[]} - subset of ['performance', 'operations', 'heartbeat']
 */
export function destinationsFor(profile) {
  if (!profile) return []
  if (profile.active === false) return []

  switch (profile.role) {
    case 'admin':
    case 'exec':
      return ['performance', 'operations', 'heartbeat']
    case 'manager':
    case 'qa':
      return ['operations', 'heartbeat']
    default:
      // Unknown role — give nothing. Safer than guessing.
      return []
  }
}

/**
 * Returns true if the user can access the given destination.
 */
export function canAccess(profile, destination) {
  return destinationsFor(profile).includes(destination)
}

/**
 * Returns true if the user is the super-admin (Peter).
 * Used to gate User Management UI.
 */
export function isSuperAdmin(authUser) {
  if (!authUser?.email) return false
  return authUser.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()
}

/**
 * Display metadata for each destination — used by LandingPage and DestinationNav.
 */
export const DESTINATIONS = {
  performance: {
    id: 'performance',
    name: 'Paramount Performance',
    shortName: 'Performance',
    mission: 'Mission Control · The Journey',
    tagline: 'Our journey to the moon. The weekly results, the quarterly arc, the score on the board.',
    accessSummary: 'Recap · Financials · People · Inventory',
    accentClass: 'performance',
  },
  operations: {
    id: 'operations',
    name: 'Operations',
    shortName: 'Operations',
    mission: 'The Engineers · Daily Drivers',
    tagline: 'For our NASA engineers. Plan the week, run the floor, capture the shift.',
    accessSummary: 'Live Ops · Scheduler · WIP',
    accentClass: 'operations',
  },
  heartbeat: {
    id: 'heartbeat',
    name: "Paramount's Heartbeat",
    shortName: 'Heartbeat',
    mission: 'Real-time · The Pulse',
    tagline: 'Our goals and how we\'re doing on the journey, right now. The pulse of the plant — Passaic and Brooklyn.',
    accessSummary: 'Plant rollup · Passaic · Brooklyn',
    accentClass: 'heartbeat',
  },
}
