/**
 * access.js — central source of truth for who can access what.
 *
 * Two concepts:
 *   1. Destination access: which of {finance, operations} a user can enter
 *   2. Super-admin: who can access User Management (only Peter)
 *
 * Roles (set in profiles.role column):
 *   - admin     — Peter, Brynn, Wendy: full access to all destinations
 *   - exec      — leadership team: full access to all destinations
 *   - manager   — Chandler, Shelby: Operations only
 *   - qa        — Sami: Operations only
 *
 * 2026-07-25: Heartbeat is no longer its own destination. Its Pulse page is now
 * the LANDING TAB of Operations — the plant view and the working surface belong
 * together. Consequence: manager and qa users now have exactly ONE destination,
 * so the chooser is skipped for them entirely and they land straight on the floor.
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
 * @returns {string[]} - subset of ['finance', 'operations']
 */
export function destinationsFor(profile) {
  if (!profile) return []
  if (profile.active === false) return []

  switch (profile.role) {
    case 'admin':
    case 'exec':
      return ['finance', 'operations']
    case 'manager':
    case 'qa':
      return ['operations']
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
  finance: {
    id: 'finance',
    name: 'Finance',
    shortName: 'Finance',
    mission: 'The Numbers · The Close',
    tagline: 'The P&L as closed, the spend behind it, and the reports that go out.',
    accessSummary: 'P&L · Spend detail · Inventory · Reports',
    accentClass: 'performance',
  },
  operations: {
    id: 'operations',
    name: 'Operations',
    shortName: 'Operations',
    mission: 'The Engineers · Daily Drivers',
    tagline: 'For our NASA engineers. The pulse of the plant, then plan the week, run the floor, capture the shift.',
    accessSummary: 'Pulse · Scheduler · Live Ops · WIP',
    accentClass: 'operations',
  },
}
