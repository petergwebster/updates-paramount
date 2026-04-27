import React from 'react'
import AdminPanel from './AdminPanel'
import StubPage from './StubPage'
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
      { id: 'user-management', label: 'User Management', badge: 'NEW' },
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
  commentProps,
  section,
  setSection,
}) {
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
          {SIDEBAR.map(group => (
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

          {section === 'lift-refresh' && (
            <StubPage
              title="LIFT Data Refresh"
              eyebrow="Data"
              description="Upload and parse the API_Dashboard MOS file to refresh inventory and WIP data. Replaces the manual Excel upload flow."
              note="Coming in a future phase. Today: still using Excel uploads on the existing Weekly Data Entry section."
            />
          )}

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

          {section === 'user-management' && (
            <StubPage
              title="User Management"
              eyebrow="Access"
              description="UI for adding, removing, and changing roles for dashboard users. Replaces the SQL-only flow currently used."
              note="Coming in a future phase. Today: user management is done directly in Supabase Auth + SQL."
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
