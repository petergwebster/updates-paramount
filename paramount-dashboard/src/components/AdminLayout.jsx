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
            <>
              <SystemInfoPanel dbReady={dbReady} userProfile={userProfile} />
              <DailyReportPanel />
              <AuditPanel userProfile={userProfile} />
            </>
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

// ─────────────────────────────────────────────────────────────────────
// Daily audit report — the forward-ready version of the nightly's findings.
// Same source the Slack digest and Peter's morning brief read (daily_digest,
// composed by audit-digest.js): headline, plain-English narrative, the
// research table (PO · order · SKU · pattern/colorway · customer · yards ·
// why), and a one-click copy of the Slack memo Peter forwards to the team.
// The three surfaces can never disagree because none of them composes —
// they all relay.
function DailyReportPanel() {
  const [row, setRow] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const { data } = await supabase.from('daily_digest')
        .select('digest_date, built_at, headline, body')
        .order('digest_date', { ascending: false }).limit(1).maybeSingle()
      if (!dead) setRow(data || null)
    })()
    return () => { dead = true }
  }, [])

  const report = row?.body?.report
  async function copyMemo() {
    try {
      await navigator.clipboard.writeText(report.memo)
      setCopied(true); setTimeout(() => setCopied(false), 2500)
    } catch { window.prompt('Copy the memo:', report.memo) }
  }

  if (!row) return null
  return (
    <div className={styles.systemInfo} style={{ marginTop: 28 }}>
      <div className={styles.systemHeader} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h2 className={styles.systemTitle}>Daily audit report</h2>
          <p className={styles.systemSub}>
            {report?.generated ? `Generated ${report.generated}` : `Digest of ${row.digest_date}`} —
            the forward-ready version: what's off, in plain terms, with the research list.
          </p>
        </div>
        {report?.memo && (
          <button
            onClick={copyMemo}
            style={{ fontSize: 12, fontWeight: 600, padding: '8px 14px', borderRadius: 8,
                     border: '1px solid var(--border)', background: 'var(--surface-2)',
                     color: 'var(--ink)', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >{copied ? 'Copied ✓' : 'Copy team memo'}</button>
        )}
      </div>

      <div style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 600, marginBottom: 8 }}>
        {row.headline}
      </div>

      {(report?.narrative || []).map((p, i) => (
        <p key={i} style={{ fontSize: 13, color: 'var(--ink-60)', margin: '0 0 8px', lineHeight: 1.5 }}>{p}</p>
      ))}

      {report?.items?.length > 0 && (
        <table className={styles.systemTable} style={{ marginTop: 10 }}>
          <thead>
            <tr>
              {['Client PO', 'LIFT order', 'SKU', 'Pattern / Colorway', 'Customer', 'Yds', 'Issue'].map(h => (
                <th key={h} style={{ textAlign: 'left', fontSize: 11, color: 'var(--ink-40)',
                                     fontWeight: 600, padding: '4px 10px 4px 0', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.items.map((it, i) => (
              <tr key={i}>
                <td style={{ fontSize: 12, color: 'var(--ink-60)', padding: '4px 10px 4px 0', whiteSpace: 'nowrap' }}>{it.po}</td>
                <td style={{ fontSize: 12, color: 'var(--ink)', padding: '4px 10px 4px 0', whiteSpace: 'nowrap' }}>{it.order}</td>
                <td style={{ fontSize: 12, color: 'var(--ink-60)', padding: '4px 10px 4px 0', whiteSpace: 'nowrap' }}>{it.sku}</td>
                <td style={{ fontSize: 12, color: 'var(--ink-60)', padding: '4px 10px 4px 0' }}>{it.pattern}</td>
                <td style={{ fontSize: 12, color: 'var(--ink-60)', padding: '4px 10px 4px 0' }}>{it.customer}</td>
                <td style={{ fontSize: 12, color: 'var(--ink-60)', padding: '4px 10px 4px 0', whiteSpace: 'nowrap' }}>{it.yards}</td>
                <td style={{ fontSize: 12, color: 'var(--ink-40)', padding: '4px 0' }}>{it.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// Audit panel — the nightly battery's latest verdicts, and the answer to
// "the header light is red, what happened." Every check writes a row every
// run, so this is the latest run's thirteen lines, fails first, in the same
// plain English the function wrote. Run-now exists so a fix can be re-tested
// immediately instead of waiting for 1am.
// ─────────────────────────────────────────────────────────────────────

const CHECK_LABELS = {
  hti_chain:          'HTI chain — deck months link',
  deck_kpis_shape:    'Deck KPI completeness',
  deck_freshness:     'Deck extraction current',
  deck_vena_coverage: 'Deck ↔ Vena join coverage',
  cost_per_yd_sane:   'Cost per yard sanity band',
  vena_period_volume: 'Vena load volume',
  txn_bbf_guard:      'BBF phantom-row guard',
  txn_single_source:  'Transactions single-source',
  lift_freshness:     'LIFT feed freshness',
  lift_completeness:  'LIFT snapshot completeness',
  sharefile_health:   'Finance feed health',
  people_freshness:   'Payroll freshness',
  order_ledger_floor: 'Order ledger never shrinks',
  kit_price_band:     'Kit price band (SCH invoiced)',
  kit_integrity:      'Kit integrity — ground per print',
  files_triage:       'Claude Files all triaged',
}
const STATUS_ORDER = { fail: 0, warn: 1, pass: 2 }
const STATUS_DOT   = { fail: 'systemDot_error', warn: 'systemDot_info', pass: 'systemDot_ok' }

function AuditPanel({ userProfile }) {
  const [run, setRun]           = useState(null)
  const [findings, setFindings] = useState(null)
  const [firing, setFiring]     = useState(false)
  const [fireNote, setFireNote] = useState('')
  // Trained exceptions — (check_key|entity) pairs the checks now skip. Loaded
  // so an item trained today shows as such even before the next run clears it.
  const [exceptions, setExceptions] = useState(new Set())

  async function load() {
    const { data: ex } = await supabase.from('audit_exceptions').select('check_key, entity')
    setExceptions(new Set((ex || []).map(e => `${e.check_key}|${e.entity}`)))
    const { data: r } = await supabase.from('audit_runs')
      .select('id, ran_at, trigger_by, checks_run, passed, warned, failed, duration_ms')
      .order('ran_at', { ascending: false }).limit(1).maybeSingle()
    setRun(r || null)
    if (r) {
      const { data: f } = await supabase.from('audit_findings')
        .select('check_key, status, summary, detail')
        .eq('run_id', r.id)
      setFindings((f || []).sort((a, b) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
        || a.check_key.localeCompare(b.check_key)))
    } else {
      setFindings([])
    }
  }
  useEffect(() => { load() }, [])

  async function runNow() {
    setFiring(true); setFireNote('')
    try {
      const res = await fetch('/.netlify/functions/audit-run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      const j = await res.json()
      if (j.failed != null) {
        setFireNote(`Ran: ${j.passed} pass / ${j.warned} warn / ${j.failed} fail in ${(j.duration_ms / 1000).toFixed(1)}s`)
        await load()
      } else {
        setFireNote(`Run failed: ${j.error || res.status}`)
      }
    } catch (e) {
      setFireNote(`Run failed: ${e.message}`)
    }
    setFiring(false)
  }

  // TRAIN — Peter's triage loop (8/2): a flagged item confirmed correct by
  // the team gets an audit_exceptions row and never flags again; anything NOT
  // trained keeps appearing in the nightly + daily digest until the LIFT data
  // changes — that recurrence IS the open fix queue. Quick, not month-end.
  async function train(checkKey, entity, why) {
    const reason = window.prompt(
      `Mark ${entity} as CORRECT for \"${CHECK_LABELS[checkKey] || checkKey}\" — it will never flag again.\nWhy is it correct?`,
      why || '')
    if (reason == null) return
    const { error } = await supabase.from('audit_exceptions').insert({
      check_key: checkKey, entity, reason,
      decided_by: userProfile?.full_name || null,
    })
    if (!error) setExceptions(prev => new Set(prev).add(`${checkKey}|${entity}`))
    else window.alert(`Could not save: ${error.message}`)
  }

  const headline = !run ? 'Never run'
    : `${run.checks_run} checks · ${run.passed} pass / ${run.warned} warn / ${run.failed} fail`
  const headDot = !run ? 'systemDot_error'
    : run.failed > 0 ? 'systemDot_error'
    : run.warned > 0 ? 'systemDot_info'
    : 'systemDot_ok'

  return (
    <div className={styles.systemInfo} style={{ marginTop: 28 }}>
      <div className={styles.systemHeader} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h2 className={styles.systemTitle}>Nightly audit</h2>
          <p className={styles.systemSub}>
            Sixteen data-integrity checks, every night at ~1am — the header Audit light is this run.
            Amber items list below: “Correct — train it” teaches the check; anything left keeps
            flagging daily until it’s fixed in LIFT.
          </p>
        </div>
        <button
          onClick={runNow}
          disabled={firing}
          style={{
            fontSize: 12, fontWeight: 600, padding: '8px 14px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--surface-2)',
            color: 'var(--ink)', cursor: firing ? 'wait' : 'pointer', whiteSpace: 'nowrap',
          }}
        >{firing ? 'Running…' : 'Run audit now'}</button>
      </div>

      <div style={{ fontSize: 13, color: 'var(--ink-60)', margin: '2px 0 12px' }}>
        <span className={`${styles.systemDot} ${styles[headDot]}`} />
        {headline}
        {run && <span style={{ color: 'var(--ink-40)' }}>{' · '}{ageLabel(ageOf(run.ran_at))}{run.trigger_by ? ` · ${run.trigger_by}` : ''}</span>}
        {fireNote && <span style={{ marginLeft: 10, color: 'var(--ink-40)' }}>{fireNote}</span>}
      </div>

      {findings && findings.length > 0 && (
        <table className={styles.systemTable}>
          <tbody>
            {findings.map(f => {
              const items = (f.detail && (f.detail.outliers || f.detail.broken)) || []
              return (
                <React.Fragment key={f.check_key}>
                  <tr>
                    <td className={styles.systemLabel}>{CHECK_LABELS[f.check_key] || f.check_key}</td>
                    <td className={styles.systemValue}>
                      <span className={`${styles.systemDot} ${styles[STATUS_DOT[f.status] || 'systemDot_error']}`} />
                      {f.summary}
                    </td>
                  </tr>
                  {items.map((it, i) => {
                    const entity = it.order || ''
                    const trained = entity && exceptions.has(`${f.check_key}|${entity}`)
                    return (
                      <tr key={`${f.check_key}-${entity}-${i}`}>
                        <td className={styles.systemLabel} style={{ paddingLeft: 26, fontSize: 12, color: 'var(--ink-40)' }}>
                          {entity}{it.type ? ` · ${it.type}` : ''}
                        </td>
                        <td className={styles.systemValue} style={{ fontSize: 12 }}>
                          <span style={{ color: 'var(--ink-60)' }}>
                            {it.why || ''}
                            {it.printYds != null ? ` · print ${it.printYds} / ground ${it.groundYds}` : ''}
                            {it.perYd != null ? ` · $${it.perYd}/yd` : ''}
                            {it.perColor != null ? ` · $${it.perColor}/color` : ''}
                          </span>
                          {trained ? (
                            <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--ink-40)' }}>trained — clears next run</span>
                          ) : entity ? (
                            <button
                              onClick={() => train(f.check_key, entity, it.why)}
                              style={{ marginLeft: 10, fontSize: 11, fontWeight: 600, padding: '3px 9px',
                                       borderRadius: 6, border: '1px solid var(--border)',
                                       background: 'var(--surface-2)', color: 'var(--ink)', cursor: 'pointer' }}
                            >Correct — train it</button>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
