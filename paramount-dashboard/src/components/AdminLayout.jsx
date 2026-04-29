import React from 'react'
import AdminPanel from './AdminPanel'
import StubPage from './StubPage'
import UserManagement from './UserManagement'
import LIFTDataRefresh from './LIFTDataRefresh'
import { isSuperAdmin } from '../lib/access'
import styles from './AdminLayout.module.css'

/**
 * AdminLayout — sidebar shell for the admin area.
 *
 * Left sidebar groups: DATA / INTELLIGENCE / ACCESS / SYSTEM
 * Right content area: renders AdminPanel for "weekly-data", or StubPage
 * for sections not yet built (LIFT Refresh, AI Monitoring, etc.).
 *
 * The existing AdminPanel is reused as-is — we just wrap it and suppress
 * its internal title/sub-tabs since the layout provides chrome.
 *
 * Props match what App.jsx passes through.
 */

const SIDEBAR = [
  {
    group: 'Data',
    items: [
      { id: 'weekly-data',  label: 'Weekly Data Entry' },
      { id: 'lift-refresh', label: 'LIFT Data Refresh', badge: 'NEW' },
    ],
  },
  {
    group: 'Intelligence',
    items: [
      { id: 'ai-monitoring', label: 'AI Monitoring',  badge: 'NEW' },
      { id: 'daily-digest',  label: 'Daily Digest',   badge: 'NEW' },
    ],
  },
  {
    group: 'Access',
    items: [
      // superAdminOnly items only render in the sidebar if the current user
      // is the super-admin (Peter). Defense-in-depth — UserManagement also
      // checks itself.
      { id: 'user-management', label: 'User Management', badge: 'NEW', superAdminOnly: true },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'system-info', label: 'System Info' },
    ],
  },
]

export default function AdminLayout({
  weekStart,
  weekData,
  onSave,
  onRefresh,
  dbReady,
  userProfile,
  authUser,
  commentProps,
  section,
  setSection,
}) {
  const userIsSuperAdmin = isSuperAdmin(authUser)

  // Filter sidebar groups so super-admin items only appear for super-admin
  const visibleSidebar = SIDEBAR
    .map(group => ({
      ...group,
      items: group.items.filter(item => !item.superAdminOnly || userIsSuperAdmin),
    }))
    .filter(group => group.items.length > 0)
  return (
    <div className={styles.layout}>
      {/* ── Page header ── */}
      <div className={styles.pageHeader}>
        <div className={styles.eyebrow}>Settings</div>
        <h1 className={styles.title}>Admin</h1>
        <div className={styles.subtitle}>
          Data entry, user access, AI monitoring, and system configuration
        </div>
      </div>

      <div className={styles.body}>
        {/* ── Sidebar ── */}
        <aside className={styles.sidebar}>
          {visibleSidebar.map(group => (
            <div key={group.group} className={styles.sidebarGroup}>
              <div className={styles.sidebarGroupLabel}>{group.group}</div>
              {group.items.map(item => (
                <button
                  key={item.id}
                  className={`${styles.sidebarItem} ${section === item.id ? styles.sidebarItemActive : ''}`}
                  onClick={() => setSection(item.id)}
                >
                  <span>{item.label}</span>
                  {item.badge && <span className={styles.sidebarBadge}>{item.badge}</span>}
                </button>
              ))}
            </div>
          ))}
        </aside>

        {/* ── Content ── */}
        <section className={styles.content}>
          {section === 'weekly-data' && (
            <AdminPanel
              weekStart={weekStart}
              weekData={weekData}
              onSave={onSave}
              dbReady={dbReady}
              hideChrome
            />
          )}

          {section === 'lift-refresh' && <LIFTDataRefresh />}

          {section === 'ai-monitoring' && (
            <StubPage
              title="AI Monitoring"
              eyebrow="Intelligence"
              description="See what Claude has been doing for the dashboard — weekly narratives generated, prompts used, costs to date, response times. Useful for understanding spend and behavior."
              note="Coming in a future phase. Today: AI generation logs are not surfaced in the UI."
            />
          )}

          {section === 'daily-digest' && (
            <StubPage
              title="Daily Digest"
              eyebrow="Intelligence"
              description="Configure the morning email digest sent to the exec team — recipient list, send time, content sections, and per-recipient personalization."
              note="Coming in a future phase. Today: no automated email digest is being sent."
            />
          )}

          {section === 'user-management' && userIsSuperAdmin && (
            <UserManagement authUser={authUser} />
          )}
          {section === 'user-management' && !userIsSuperAdmin && (
            <StubPage
              title="Restricted"
              eyebrow="Access"
              description="User Management is restricted to the super-admin only."
            />
          )}

          {section === 'system-info' && (
            <SystemInfoPanel dbReady={dbReady} userProfile={userProfile} />
          )}
        </section>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// System Info — small read-only panel showing app state
// ─────────────────────────────────────────────────────────────────────────────
function SystemInfoPanel({ dbReady, userProfile }) {
  const buildTime = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown'
  const items = [
    { label: 'Database',       value: dbReady ? 'Connected' : 'Disconnected', status: dbReady ? 'ok' : 'error' },
    { label: 'Auth',           value: userProfile ? `Logged in as ${userProfile.full_name}` : 'Not authenticated', status: userProfile ? 'ok' : 'error' },
    { label: 'Role',           value: userProfile?.role || 'unknown', status: 'info' },
    { label: 'Environment',    value: window.location.hostname, status: 'info' },
    { label: 'User agent',     value: navigator.userAgent.split(' ').slice(-2).join(' '), status: 'info' },
  ]

  return (
    <div className={styles.systemInfo}>
      <div className={styles.systemHeader}>
        <h2 className={styles.systemTitle}>System Info</h2>
        <p className={styles.systemSub}>Read-only diagnostics</p>
      </div>
      <table className={styles.systemTable}>
        <tbody>
          {items.map(item => (
            <tr key={item.label}>
              <td className={styles.systemLabel}>{item.label}</td>
              <td className={styles.systemValue}>
                <span className={`${styles.systemDot} ${styles[`systemDot_${item.status}`]}`} />
                {item.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
