import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import AdminPanel from './AdminPanel'
import StubPage from './StubPage'
import UserManagement from './UserManagement'
import LIFTDataRefresh from './LIFTDataRefresh'
import MonthlyBriefs from './MonthlyBriefs'
import WeeklyProductionSummary from './WeeklyProductionSummary'
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

// ADMIN IS FOR ADMINISTRATION (2026-07-26). Monthly Briefs and the Weekly
// Production Summary moved to Finance › Reports — they are reports, not admin.
// AI Monitoring folded into System → feed health, which is a real need with no
// home. Daily Digest retired here; Wendy's daily recap belongs next to the
// production it describes, on Operations › Pulse, not behind a gear.
// What is left is genuinely administrative: data entry, access, system health.
const SIDEBAR = [
  {
    group: 'Data',
    items: [
      { id: 'weekly-data',  label: 'Weekly Data Entry' },
      { id: 'lift-refresh', label: 'LIFT Data Refresh' },
    ],
  },
  {
    group: 'Access',
    items: [
      // superAdminOnly items only render in the sidebar if the current user
      // is the super-admin (Peter). Defense-in-depth — UserManagement also
      // checks itself.
      { id: 'user-management', label: 'User Management', superAdminOnly: true },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'system-info', label: 'Feed health' },
    ],
  },
]

// Sections that used to live here. An old bookmark or stale state should land
// somewhere sensible rather than render a blank panel.
const RETIRED = {
  'monthly-briefs': 'weekly-data',
  'weekly-summary': 'weekly-data',
  'ai-monitoring':  'system-info',
  'daily-digest':   'system-info',
}

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
  const view = RETIRED[section] || section

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
          Data entry, user access, and feed health
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
                  className={`${styles.sidebarItem} ${view === item.id ? styles.sidebarItemActive : ''}`}
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
          {view === 'weekly-data' && (
            <AdminPanel
              weekStart={weekStart}
              weekData={weekData}
              onSave={onSave}
              dbReady={dbReady}
              hideChrome
            />
          )}

          {view === 'lift-refresh' && <LIFTDataRefresh />}

          {view === 'user-management' && userIsSuperAdmin && (
            <UserManagement authUser={authUser} />
          )}
          {view === 'user-management' && !userIsSuperAdmin && (
            <StubPage
              title="Restricted"
              eyebrow="Access"
              description="User Management is restricted to the super-admin only."
            />
          )}

          {view === 'system-info' && (
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
// ───────────────────────────────────────────────────────────────────────
// Feed health — what Admin is actually FOR.
//
// The header dots tell you green or red. This tells you WHY: when each feed
// last ran, how old each dataset is, and how much is in it. Every number here
// is the answer to "can I trust what I'm looking at", which is the question
// that matters most when you are managing to the dashboard rather than walking
// the floor.
//
// AGE IS THE POINT. A row count without a date is reassuring and useless.
// ───────────────────────────────────────────────────────────────────────
function ageOf(ts) {
  if (!ts) return null
  const s = String(ts)
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s)
  const t = new Date(s.length <= 10 ? s + 'T00:00:00' : (hasTz ? s : s + 'Z'))
  if (isNaN(t)) return null
  return Math.floor((Date.now() - t.getTime()) / 3600000)   // hours
}
function ageLabel(h) {
  if (h == null) return 'never'
  if (h < 1) return 'just now'
  if (h < 48) return `${h} hr${h !== 1 ? 's' : ''} ago`
  return `${Math.floor(h / 24)} days ago`
}

function SystemInfoPanel({ dbReady, userProfile }) {
  const [feeds, setFeeds] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const [snap, health, txn, vena, aging, ppl, wip] = await Promise.all([
        supabase.from('sched_snapshots').select('uploaded_at')
          .order('uploaded_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('integration_state').select('value, updated_at')
          .eq('key', 'sharefile_health').maybeSingle(),
        supabase.from('financial_transactions')
          .select('trx_date, source_file', { count: 'exact' })
          .order('trx_date', { ascending: false }).limit(1),
        supabase.from('vena_monthly').select('period')
          .order('period', { ascending: false }).limit(1),
        supabase.from('financial_aging').select('as_of_date')
          .order('as_of_date', { ascending: false }).limit(1),
        supabase.from('people_weekly').select('week_start')
          .order('week_start', { ascending: false }).limit(1),
        supabase.from('sched_snapshots').select('*', { count: 'exact', head: true }),
      ])
      if (dead) return
      const v = health.data?.value || null
      setFeeds({
        liftAt:   snap.data?.uploaded_at || null,
        snapCount: wip.count ?? null,
        finAt:    v?.ran_at || health.data?.updated_at || null,
        finOk:    v ? v.ok !== false : null,
        finNote:  v?.error || v?.jen?.error || v?.vena?.error
                  || v?.jen?.skipped || v?.vena?.skipped || null,
        txnAt:    txn.data?.[0]?.trx_date || null,
        txnFile:  txn.data?.[0]?.source_file || null,
        txnCount: txn.count ?? null,
        venaAt:   vena.data?.[0]?.period || null,
        agingAt:  aging.data?.[0]?.as_of_date || null,
        pplAt:    ppl.data?.[0]?.week_start || null,
      })
    })()
    return () => { dead = true }
  }, [])

  // Each feed carries the cadence it is SUPPOSED to run at, so "stale" means
  // something specific rather than "old". LIFT is hourly, the finance feed is
  // daily, Vena is monthly at close, payroll is a manual weekly upload.
  const rows = feeds ? [
    { label: 'LIFT · WIP feed', at: feeds.liftAt, limit: 2,
      detail: feeds.snapCount != null ? `${feeds.snapCount} snapshots retained` : null, cadence: 'hourly' },
    { label: 'ShareFile · finance feed', at: feeds.finAt, limit: 26,
      detail: feeds.finNote || (feeds.finOk === false ? 'last run reported an error' : 'last run clean'),
      bad: feeds.finOk === false, cadence: 'daily 9am ET' },
    { label: 'Purchases · transactions', at: feeds.txnAt, limit: 24 * 9,
      detail: `${feeds.txnCount ?? '—'} rows · ${feeds.txnFile || 'no file'}`, cadence: 'weekly (Jen)' },
    { label: 'Vena · monthly close', at: feeds.venaAt ? feeds.venaAt + '-28' : null, limit: 24 * 45,
      detail: feeds.venaAt ? `latest period ${feeds.venaAt}` : 'nothing loaded', cadence: 'monthly (Abigail)' },
    { label: 'AR / AP aging', at: feeds.agingAt, limit: 24 * 14,
      detail: feeds.agingAt ? `as of ${String(feeds.agingAt).slice(0,10)}` : 'nothing loaded', cadence: 'with the weekly file' },
    { label: 'People · payroll', at: feeds.pplAt, limit: 24 * 14,
      detail: feeds.pplAt ? `week of ${String(feeds.pplAt).slice(0,10)}` : 'nothing loaded', cadence: 'manual upload' },
  ] : []

  return (
    <div className={styles.systemInfo}>
      <div className={styles.systemHeader}>
        <h2 className={styles.systemTitle}>Feed health</h2>
        <p className={styles.systemSub}>
          When each feed last delivered, and how old the data behind each screen is.
        </p>
      </div>

      {!feeds && <p style={{ fontSize: 13, color: 'var(--ink-40)' }}>Checking feeds…</p>}

      {feeds && (
        <table className={styles.systemTable}>
          <tbody>
            {rows.map(r => {
              const h = ageOf(r.at)
              const bad = r.bad || h == null || h > r.limit
              const warn = !bad && h != null && h > r.limit * 0.6
              const status = bad ? 'error' : warn ? 'info' : 'ok'
              return (
                <tr key={r.label}>
                  <td className={styles.systemLabel}>
                    {r.label}
                    <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 2 }}>{r.cadence}</div>
                  </td>
                  <td className={styles.systemValue}>
                    <span className={`${styles.systemDot} ${styles[`systemDot_${status}`]}`} />
                    {ageLabel(h)}
                    {r.detail && (
                      <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 2 }}>{r.detail}</div>
                    )}
                  </td>
                </tr>
              )
            })}
            <tr>
              <td className={styles.systemLabel}>Session</td>
              <td className={styles.systemValue}>
                <span className={`${styles.systemDot} ${styles[dbReady ? 'systemDot_ok' : 'systemDot_error']}`} />
                {dbReady ? 'Database connected' : 'Database disconnected'}
                <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 2 }}>
                  {userProfile ? `${userProfile.full_name} · ${userProfile.role}` : 'not authenticated'}
                  {' · '}{window.location.hostname}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}
