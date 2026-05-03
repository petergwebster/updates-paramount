import { useState, useEffect, useMemo } from 'react'
import {
  C, fmt,
  ACCENT_TEAL, ACCENT_DEEP_TEAL,
  STATUS_GOOD, STATUS_GOOD_BG, STATUS_GOOD_BORDER,
  STATUS_WARN, STATUS_WARN_BG, STATUS_WARN_BORDER,
  STATUS_BAD,  STATUS_BAD_BG,  STATUS_BAD_BORDER,
} from '../lib/scheduleUtils'
import {
  getCurrentSnapshot,
  getNewGoodsItems,
  triggerRefresh,
  isStale,
  groupItemsByGroup,
  inProgressOnly,
  getObservation,
  generateObservations,
} from '../lib/newGoods'

// ═══════════════════════════════════════════════════════════════════════════
// NewGoodsTab — Monday.com pre-production pipeline view
//
// Two boards, one tab:
//   • Passaic (NEW PARAMOUNT PRE-PRODUCTION) — hand-screen NG with 44 columns
//   • Brooklyn (BNY PRE-PRODUCTION) — digital NG with 14 columns
//
// Same conceptual model, different column sets — site toggle at top, each
// site renders its own native columns. No forced unification.
//
// Data plumbing today: snapshot table populated by /api/monday-newgoods-refresh.
// Auto-refresh on load if snapshot > 24h. Manual refresh button always
// available. Going live later swaps the read implementation in newGoods.js
// without touching this component.
//
// Default view: in-progress only (excludes APPROVED + DROPPED — together they're
// ~half the rows and aren't actionable). Toggle to show all.
// ═══════════════════════════════════════════════════════════════════════════

const SITES = [
  { id: 'passaic', label: 'Passaic',  sub: 'Hand-Screen' },
  { id: 'bny',     label: 'Brooklyn', sub: 'Digital'     },
]

export default function NewGoodsTab({ currentUser } = {}) {
  const [site, setSite] = useState('passaic')
  const [snapshot, setSnapshot] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [refreshStatus, setRefreshStatus] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const [search, setSearch] = useState('')
  const [pipelineFilters, setPipelineFilters] = useState(new Set())  // multi-select OR
  const [lateOnly, setLateOnly] = useState(false)

  // Observations modal — observation is { observations_md, generated_at, ... } or null
  const [observation, setObservation] = useState(null)
  const [obsModalOpen, setObsModalOpen] = useState(false)
  const [obsLoading, setObsLoading] = useState(false)
  const [obsError, setObsError] = useState(null)

  // Auto-refresh on first load if snapshot is stale (or doesn't exist).
  // Background — doesn't block render.
  async function loadAll() {
    setLoading(true); setError(null)
    try {
      const snap = await getCurrentSnapshot()
      setSnapshot(snap)
      if (snap) {
        const data = await getNewGoodsItems({ site })
        setItems(data)
        // Pull latest observation for this site (any snapshot — handles stale case)
        const obs = await getObservation({ site })
        setObservation(obs)
      } else {
        setItems([])
        setObservation(null)
      }
      // Auto-refresh in background if stale
      if (isStale(snap, 24) && !refreshing) {
        // fire-and-forget — UI keeps showing stale data while it pulls
        runRefresh('auto').catch(() => { /* errors surfaced via state */ })
      }
    } catch (e) {
      console.error(e); setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  async function runRefresh(trigger = 'manual') {
    setRefreshing(true); setRefreshStatus(`Refreshing from Monday.com…`); setError(null)
    try {
      const result = await triggerRefresh({ trigger })
      setRefreshStatus(`✓ Refreshed · Passaic ${fmt(result.passaic)} · Brooklyn ${fmt(result.bny)} · ${result.duration_ms}ms`)
      // Reload snapshot + items + latest observation
      const snap = await getCurrentSnapshot()
      setSnapshot(snap)
      const data = await getNewGoodsItems({ site })
      setItems(data)
      const obs = await getObservation({ site })
      setObservation(obs)
      // Clear status after a few seconds
      setTimeout(() => setRefreshStatus(null), 5000)
    } catch (e) {
      console.error(e)
      setError(e.message || String(e))
      setRefreshStatus(null)
    } finally {
      setRefreshing(false)
    }
  }

  // Generate (or fetch cached) observations for current site + snapshot.
  // Called from the modal's Generate / Re-run buttons.
  async function runObservations({ force = false } = {}) {
    if (!snapshot) return
    setObsLoading(true); setObsError(null)
    try {
      const result = await generateObservations({
        site,
        snapshotId: snapshot.id,
        forceRegenerate: force,
      })
      setObservation({
        snapshot_id: snapshot.id,
        site,
        observations_md: result.observations_md,
        generated_at: result.generated_at,
        item_count: result.item_count,
        group_summary: result.group_summary,
      })
    } catch (e) {
      console.error(e)
      setObsError(e.message || String(e))
    } finally {
      setObsLoading(false)
    }
  }

  // Reload items + observation when site changes (snapshot stays the same)
  useEffect(() => {
    if (!snapshot) { loadAll(); return }
    let cancelled = false
    Promise.all([
      getNewGoodsItems({ site }),
      getObservation({ site }),
    ])
      .then(([data, obs]) => {
        if (cancelled) return
        setItems(data)
        setObservation(obs)
      })
      .catch(e => { if (!cancelled) setError(e.message || String(e)) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site])

  // Initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadAll() }, [])

  // ── Derived ────────────────────────────────────────────────────────────

  const visibleItems = useMemo(() => {
    let out = showAll ? items : inProgressOnly(items)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(i =>
        (i.item_name || '').toLowerCase().includes(q) ||
        (i.development_type || '').toLowerCase().includes(q) ||
        (i.approver || '').toLowerCase().includes(q) ||
        (i.customer || '').toLowerCase().includes(q)
      )
    }
    // Pipeline filter pills (multi-select OR). Read each row's resolved
    // pipeline value via the same logic the table uses.
    if (pipelineFilters.size > 0) {
      out = out.filter(i => {
        const { pipeline } = resolveStatuses(i)
        return pipeline && pipelineFilters.has(pipeline)
      })
    }
    // Late-only — filter to rows where resolved timeline status is "Late"
    // or "May be late". Useful as a single click for "show me what needs attention."
    if (lateOnly) {
      out = out.filter(i => {
        const { timeline } = resolveStatuses(i)
        return timeline === 'Late' || timeline === 'May be late'
      })
    }
    return out
  }, [items, showAll, search, pipelineFilters, lateOnly])

  // Pipeline values present in the current item set — drives which pills
  // to render. Sorted by frequency desc so most-common appear first.
  const pipelineValuesAvailable = useMemo(() => {
    const counts = new Map()
    for (const i of items) {
      const { pipeline } = resolveStatuses(i)
      if (!pipeline) continue
      counts.set(pipeline, (counts.get(pipeline) || 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => ({ value: v, count: n }))
  }, [items])

  function togglePipelineFilter(v) {
    setPipelineFilters(prev => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  }
  function clearPipelineFilters() { setPipelineFilters(new Set()) }

  const grouped = useMemo(() => groupItemsByGroup(visibleItems), [visibleItems])
  const groupOrder = orderGroupsForSite(Array.from(grouped.keys()), site)

  // Per-group item counts for the header (all rows, not filtered)
  const totalsAll = useMemo(() => groupItemsByGroup(items), [items])

  return (
    <div style={{ background: C.cream, minHeight: '100vh', padding: '0 0 48px', fontFamily: 'system-ui,-apple-system,sans-serif' }}>

      {/* ── Header ───────────────────────────────────────────────────── */}
      <div style={{ padding: '20px 0 16px', marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: C.ink, fontFamily: 'Georgia,serif' }}>
              Production · NEW Goods
            </h2>
            <p style={{ fontSize: 13, color: C.inkLight, margin: '4px 0 0' }}>
              {snapshot
                ? <>Pre-production pipeline · refreshed {new Date(snapshot.refreshed_at).toLocaleString()}{snapshot.trigger === 'auto' && <span style={{ marginLeft: 6, fontSize: 11, color: C.inkLight }}>(auto)</span>}</>
                : 'Pre-production pipeline · no data yet'}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => runRefresh('manual')} disabled={refreshing}
              style={{ padding: '9px 20px', background: refreshing ? C.warm : C.ink, color: refreshing ? C.inkLight : '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: refreshing ? 'not-allowed' : 'pointer' }}>
              {refreshing ? 'Refreshing…' : '↻ Refresh from Monday.com'}
            </button>
          </div>
        </div>
        {refreshStatus && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.inkMid, background: C.goldBg, border: `1px solid ${C.warm}`, borderRadius: 6, padding: '8px 12px' }}>{refreshStatus}</div>
        )}
        {error && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.rose, background: C.roseBg, border: `1px solid ${STATUS_BAD_BORDER}`, borderRadius: 6, padding: '8px 12px' }}>{error}</div>
        )}
      </div>

      {/* ── No-data state ─────────────────────────────────────────────── */}
      {!snapshot && !loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.2 }}>✦</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.inkMid, fontFamily: 'Georgia,serif', marginBottom: 8 }}>No NEW Goods data yet</div>
          <div style={{ fontSize: 13, color: C.inkLight }}>Click "Refresh from Monday.com" to pull the latest pipeline.</div>
        </div>
      )}

      {loading && !snapshot && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: C.inkLight, fontSize: 14 }}>Loading…</div>
      )}

      {snapshot && (
        <>
          {/* ── Site toggle ──────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {SITES.map(s => {
              const active = site === s.id
              const sub = active && snapshot
                ? `${fmt(s.id === 'passaic' ? snapshot.passaic_items ?? 0 : snapshot.bny_items ?? 0)} items`
                : s.sub
              return (
                <button key={s.id} onClick={() => setSite(s.id)}
                  style={{
                    padding: '12px 20px',
                    background: active ? C.ink : '#fff',
                    color: active ? '#fff' : C.inkMid,
                    border: `1px solid ${active ? C.ink : C.border}`,
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: active ? 700 : 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                    minWidth: 140,
                  }}>
                  <div style={{ fontFamily: 'Georgia,serif', fontSize: 15 }}>{s.label}</div>
                  <div style={{ fontSize: 10, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{sub}</div>
                </button>
              )
            })}
          </div>

          {/* ── Pipeline summary card ────────────────────────────────── */}
          <PipelineSummary
            site={site}
            groups={totalsAll}
            observation={observation}
            snapshot={snapshot}
            onOpenObservations={() => setObsModalOpen(true)}
          />

          {/* ── Filter row ───────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Search name, type, person, customer…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                flex: '1 1 280px',
                padding: '8px 12px',
                fontSize: 13,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                background: '#fff',
                color: C.ink,
              }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.inkMid, cursor: 'pointer' }}>
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
              Include Approved / Dropped
            </label>
            <span style={{ fontSize: 11, color: C.inkLight, marginLeft: 'auto' }}>
              {fmt(visibleItems.length)} of {fmt(items.length)} items
            </span>
          </div>

          {/* ── Pipeline filter pills ────────────────────────────────── */}
          {pipelineValuesAvailable.length > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.inkLight, marginRight: 4 }}>
                Pipeline:
              </span>
              <button onClick={() => setLateOnly(v => !v)}
                style={{
                  padding: '5px 12px', fontSize: 11,
                  fontWeight: lateOnly ? 700 : 600,
                  borderRadius: 14,
                  border: `1px solid ${lateOnly ? STATUS_BAD : C.border}`,
                  background: lateOnly ? STATUS_BAD_BG : '#fff',
                  color: lateOnly ? STATUS_BAD : C.inkMid,
                  cursor: 'pointer',
                }}>
                ⚠ Late only
              </button>
              {pipelineValuesAvailable.map(({ value, count }) => {
                const active = pipelineFilters.has(value)
                const bucket = pipelineBucket(value)
                const tone = PIPELINE_TONES[bucket]
                return (
                  <button key={value} onClick={() => togglePipelineFilter(value)}
                    style={{
                      padding: '5px 12px', fontSize: 11,
                      fontWeight: active ? 700 : 600,
                      borderRadius: 14,
                      border: `1px solid ${active ? tone.fg : tone.border}`,
                      background: active ? tone.bg : '#fff',
                      color: active ? tone.fg : C.inkMid,
                      cursor: 'pointer',
                    }}>
                    {value} <span style={{ opacity: 0.7, marginLeft: 4 }}>({fmt(count)})</span>
                  </button>
                )
              })}
              {(pipelineFilters.size > 0 || lateOnly) && (
                <button onClick={() => { clearPipelineFilters(); setLateOnly(false) }}
                  style={{
                    padding: '5px 10px', fontSize: 11, fontWeight: 500,
                    background: 'transparent', color: C.inkLight,
                    border: 'none', cursor: 'pointer', textDecoration: 'underline',
                  }}>
                  clear filters
                </button>
              )}
            </div>
          )}

          {/* ── Group sections ───────────────────────────────────────── */}
          {visibleItems.length === 0 ? (
            <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.inkLight, fontSize: 13, fontStyle: 'italic' }}>
              No items match the current filter.
            </div>
          ) : (
            groupOrder.map(groupName => (
              <GroupSection
                key={groupName}
                groupName={groupName}
                items={grouped.get(groupName) || []}
                site={site}
              />
            ))
          )}
        </>
      )}

      {/* ── Observations Modal ─────────────────────────────────────────── */}
      {obsModalOpen && (
        <ObservationsModal
          site={site}
          snapshot={snapshot}
          observation={observation}
          loading={obsLoading}
          error={obsError}
          onClose={() => { setObsModalOpen(false); setObsError(null) }}
          onGenerate={() => runObservations({ force: false })}
          onRerun={() => runObservations({ force: true })}
        />
      )}
    </div>
  )
}

// ─── Per-site canonical group ordering ────────────────────────────────────
//
// Each Monday board has its own group structure — Passaic and Brooklyn are
// genuinely different workflows. We hardcode the ORDER per site so the
// pipeline summary and group sections render consistently. Any group
// name appearing in the data that isn't in the canonical list still
// renders, just appended at the end alphabetically (forward-compat for
// when Monday adds new groups).
//
// Source: the Monday boards' actual group structure as of 2026-05.
// Verified against board exports.

const GROUP_ORDER_PASSAIC = [
  'TRANSITIONS',
  'Re-engravings',
  'APPROVED',
  'DROPPED',
]
const GROUP_ORDER_BNY = [
  'Studio in Progress',
  'Transitions in Progress',
  'Backdrop',
  'Contract',
  'Approved',
  'Dropped',
]

function orderGroupsForSite(groups, site) {
  const canonical = site === 'passaic' ? GROUP_ORDER_PASSAIC : GROUP_ORDER_BNY
  const known = canonical.filter(g => groups.includes(g))
  const rest  = groups.filter(g => !canonical.includes(g)).sort()
  return [...known, ...rest]
}

// ─── Pipeline summary — counts per group ──────────────────────────────────

function PipelineSummary({ site, groups, observation, snapshot, onOpenObservations }) {
  if (groups.size === 0) return null

  const groupNames = orderGroupsForSite(Array.from(groups.keys()), site)
  const total = Array.from(groups.values()).reduce((s, arr) => s + arr.length, 0)
  const accent = site === 'passaic' ? ACCENT_TEAL : ACCENT_DEEP_TEAL  // Path A: site identity collapses to teal

  // "Last run" status. Three cases:
  //   • Observation exists for current snapshot → "Last run: time"
  //   • Observation exists but for an older snapshot → "Last run: time · stale"
  //   • No observation → "Not yet generated"
  let lastRunLabel = 'Not yet generated'
  let isStaleObs = false
  if (observation) {
    const t = new Date(observation.generated_at).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
    if (snapshot && observation.snapshot_id === snapshot.id) {
      lastRunLabel = `Last run: ${t}`
    } else {
      lastRunLabel = `Last run: ${t}`
      isStaleObs = true
    }
  }

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', background: C.parchment, borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pipeline</span>
          <span style={{ fontSize: 11, color: C.inkLight }}>{fmt(total)} items total</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 10, color: isStaleObs ? STATUS_WARN : C.inkLight, textAlign: 'right' }}>
            {lastRunLabel}
            {isStaleObs && <span style={{ display: 'block' }}>(data has refreshed since)</span>}
          </span>
          <button onClick={onOpenObservations}
            style={{
              padding: '7px 14px',
              background: accent, color: '#fff',
              border: 'none', borderRadius: 6,
              fontSize: 12, fontWeight: 700, letterSpacing: '0.02em',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
            <span style={{ fontSize: 13 }}>✦</span> Claude's Observations
          </button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(140px, 1fr))`, gap: 0 }}>
        {groupNames.map((g, i) => (
          <div key={g} style={{
            padding: '14px 16px',
            borderRight: i < groupNames.length - 1 ? `1px solid ${C.border}` : 'none',
            borderTop: `1px solid transparent`,
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              {g}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.ink, fontFamily: 'Georgia,serif' }}>
              {fmt(groups.get(g).length)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Group section — heading + item table ─────────────────────────────────

function GroupSection({ groupName, items, site }) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          padding: '12px 16px',
          background: C.ink, color: '#fff',
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          cursor: 'pointer',
          userSelect: 'none',
        }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, fontFamily: 'Georgia,serif' }}>
          {groupName}
          <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.7)' }}>
            {fmt(items.length)} item{items.length === 1 ? '' : 's'}
          </span>
        </h3>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {expanded && (
        site === 'passaic'
          ? <PassaicItemTable items={items} />
          : <BNYItemTable items={items} />
      )}
    </div>
  )
}

// ─── Passaic item table — heavier column set ──────────────────────────────

function PassaicItemTable({ items }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: C.parchment, borderBottom: `1px solid ${C.border}` }}>
            <Th>Name</Th>
            <Th>Status</Th>
            <Th>Pipeline</Th>
            <Th>Customer</Th>
            <Th>Type</Th>
            <Th>Product</Th>
            <Th>Colorway</Th>
            <Th>Ground</Th>
            <Th>Approver</Th>
            <Th>Trials Due</Th>
            <Th>Launch</Th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const { timeline, pipeline } = resolveStatuses(item)
            return (
            <tr key={item.id} style={{ borderBottom: `1px solid ${C.border}` }}>
              <Td><strong style={{ color: C.ink }}>{item.item_name || '—'}</strong></Td>
              <Td><StatusPill value={timeline} /></Td>
              <Td><PipelinePill value={pipeline} /></Td>
              <Td>{item.customer || '—'}</Td>
              <Td>{item.development_type || '—'}</Td>
              <Td>{item.product_type || '—'}</Td>
              <Td>{item.colorway || '—'}</Td>
              <Td>{item.ground || '—'}</Td>
              <Td>{item.approver || '—'}</Td>
              <Td>{fmtDate(item.trials_due)}</Td>
              <Td>{item.launch_date_text || '—'}</Td>
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── BNY item table — lighter column set ──────────────────────────────────

function BNYItemTable({ items }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: C.parchment, borderBottom: `1px solid ${C.border}` }}>
            <Th>Name</Th>
            <Th>Status</Th>
            <Th>Pipeline</Th>
            <Th>Type</Th>
            <Th>Approver</Th>
            <Th>Waiting On</Th>
            <Th>Timeline</Th>
            <Th>Launch</Th>
            <Th>CFA Due</Th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const { timeline, pipeline } = resolveStatuses(item)
            return (
            <tr key={item.id} style={{ borderBottom: `1px solid ${C.border}` }}>
              <Td><strong style={{ color: C.ink }}>{item.item_name || '—'}</strong></Td>
              <Td><StatusPill value={timeline} /></Td>
              <Td><PipelinePill value={pipeline} /></Td>
              <Td>{item.development_type || '—'}</Td>
              <Td>{item.approver || '—'}</Td>
              <Td>{item.waiting_on || '—'}</Td>
              <Td>
                {item.timeline_start && item.timeline_end
                  ? `${fmtDate(item.timeline_start)} → ${fmtDate(item.timeline_end)}`
                  : '—'}
              </Td>
              <Td>{item.launch_date_text || '—'}</Td>
              <Td>{fmtDate(item.cfa_due)}</Td>
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Cells + pills ─────────────────────────────────────────────────────────

function Th({ children }) {
  return <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.inkLight, whiteSpace: 'nowrap' }}>{children}</th>
}
function Td({ children }) {
  return <td style={{ padding: '8px 12px', color: C.inkMid, verticalAlign: 'top' }}>{children}</td>
}

function StatusPill({ value }) {
  if (!value) return <span style={{ color: C.inkLight }}>—</span>
  const tone = TIMELINE_TONES[value] || PIPELINE_TONES.neutral
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      fontSize: 10, fontWeight: 700,
      background: tone.bg, color: tone.fg,
      border: `1px solid ${tone.border}`,
      borderRadius: 3, letterSpacing: '0.04em',
      textTransform: 'uppercase',
    }}>{value}</span>
  )
}

function PipelinePill({ value }) {
  if (!value) return <span style={{ color: C.inkLight }}>—</span>
  const tone = PIPELINE_TONES[pipelineBucket(value)]
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      fontSize: 10, fontWeight: 700,
      background: tone.bg, color: tone.fg,
      border: `1px solid ${tone.border}`,
      borderRadius: 3, letterSpacing: '0.04em',
      textTransform: 'uppercase',
    }}>{value}</span>
  )
}

// Unified color tones — Couture palette (matches Heartbeat's emerald /
// saffron / crimson references). Used by both StatusPill and PipelinePill.
const TIMELINE_TONES = {
  'On time':     { bg: STATUS_GOOD_BG, fg: STATUS_GOOD, border: STATUS_GOOD_BORDER },
  'May be late': { bg: STATUS_WARN_BG, fg: STATUS_WARN, border: STATUS_WARN_BORDER },
  'Late':        { bg: STATUS_BAD_BG,  fg: STATUS_BAD,  border: STATUS_BAD_BORDER  },
}
const PIPELINE_TONES = {
  green:   { bg: STATUS_GOOD_BG, fg: STATUS_GOOD, border: STATUS_GOOD_BORDER },
  yellow:  { bg: STATUS_WARN_BG, fg: STATUS_WARN, border: STATUS_WARN_BORDER },
  red:     { bg: STATUS_BAD_BG,  fg: STATUS_BAD,  border: STATUS_BAD_BORDER  },
  neutral: { bg: C.parchment,    fg: C.inkMid,    border: C.border           },
}

// ─── Status resolution ─────────────────────────────────────────────────────
//
// Both Monday boards have TWO columns titled "Status" — one captures
// timeline status (small vocab) and the other captures pipeline status
// (open-ended). Column order differs between boards: BNY stores
// timeline-first, Passaic stores pipeline-first. The edge function reads
// them in column-order so the two fields end up swapped on Passaic.
//
// Fix at read time: detect by value. Timeline status has exactly 3 known
// values; anything else is pipeline. Self-correcting regardless of which
// column came first or whether Monday reorders columns later.

const TIMELINE_VALUES = new Set(['On time', 'May be late', 'Late'])

function resolveStatuses(item) {
  const a = item.status_timeline
  const b = item.status_pipeline
  if (TIMELINE_VALUES.has(a)) return { timeline: a, pipeline: b }
  if (TIMELINE_VALUES.has(b)) return { timeline: b, pipeline: a }
  // Neither field looks like a timeline status — render whichever has data
  // as a pipeline pill, leave timeline empty.
  return { timeline: null, pipeline: a || b || null }
}

// Pipeline status → color bucket. Case + whitespace insensitive match.
// New / unknown values fall through to neutral gray (signals "needs
// classification" without breaking render).
const PIPELINE_GREEN = new Set([
  'approved',
  'screens ready',
  's/o done - awaiting feedback',
  's/o done',
])
const PIPELINE_YELLOW = new Set([
  'awaiting feedback',
  'awaiting fabric/plates',
  'eng file in progress',
  'eng - in queue',
  'in progress',
  'engraving approval',
])
const PIPELINE_RED = new Set([
  'on hold',
  'dropped',
])

function pipelineBucket(value) {
  if (!value) return 'neutral'
  const norm = String(value).trim().toLowerCase().replace(/\s+/g, ' ')
  if (PIPELINE_GREEN.has(norm))  return 'green'
  if (PIPELINE_YELLOW.has(norm)) return 'yellow'
  if (PIPELINE_RED.has(norm))    return 'red'
  return 'neutral'
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

// ─── Observations Modal ───────────────────────────────────────────────────
//
// Centered overlay. Header in site accent color (Passaic blood-orange,
// Brooklyn saffron). Body shows Claude's observations rendered from
// markdown — minimal renderer, no external lib needed.
//
// Three states:
//   1. No observation exists yet for current snapshot, none cached at all
//      → "Generate observations" prompt
//   2. Observation exists for current snapshot
//      → Show observations + "Re-run" button
//   3. Observation exists but for an older snapshot (data has refreshed
//      since) → Show stale observations with "data has refreshed" banner
//      + Re-run prominently offered
//
// First-click cost is explicit: opening the modal is free; clicking
// Generate or Re-run burns ~$0.05-0.10 in Claude API tokens.

function ObservationsModal({ site, snapshot, observation, loading, error, onClose, onGenerate, onRerun }) {
  const accent = site === 'passaic' ? ACCENT_TEAL : ACCENT_DEEP_TEAL
  // Light teal-tinted background for the stale banner — harmonizes with
  // the accent color regardless of which site is showing.
  const accentBg = '#D9E2E5'
  const siteLabel = site === 'passaic' ? 'Passaic' : 'Brooklyn'

  // Determine state
  const hasObs = !!observation?.observations_md
  const isStaleObs = hasObs && snapshot && observation.snapshot_id !== snapshot.id

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(33, 42, 49, 0.55)',
        zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 12,
          maxWidth: 760, width: '100%',
          maxHeight: '85vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}>
        {/* Header */}
        <div style={{
          background: accent,
          color: '#fff',
          padding: '14px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, fontFamily: 'Georgia,serif' }}>
              ✦ Claude's Observations · {siteLabel}
            </h3>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', marginTop: 2 }}>
              {snapshot
                ? <>Snapshot from {new Date(snapshot.refreshed_at).toLocaleString()}</>
                : 'No snapshot'}
            </div>
          </div>
          <button onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.2)', color: '#fff',
              border: 'none', borderRadius: 6,
              padding: '6px 12px', fontSize: 16, fontWeight: 700,
              cursor: 'pointer', lineHeight: 1,
            }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, color: C.ink, fontSize: 14, lineHeight: 1.6 }}>
          {error && (
            <div style={{ background: STATUS_BAD_BG, color: STATUS_BAD, border: `1px solid ${STATUS_BAD_BORDER}`, borderRadius: 6, padding: '10px 14px', fontSize: 12, marginBottom: 16 }}>
              {error}
            </div>
          )}

          {/* Stale banner */}
          {hasObs && isStaleObs && !loading && (
            <div style={{
              background: accentBg, color: accent,
              border: `1px solid ${accent}`, borderRadius: 6,
              padding: '8px 12px', fontSize: 12,
              marginBottom: 16,
            }}>
              <strong>Data has refreshed since these observations were generated.</strong>{' '}
              Hit Re-run for a fresh take.
            </div>
          )}

          {/* No observation yet — prompt to generate */}
          {!hasObs && !loading && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: 14, color: C.inkMid, marginBottom: 16, lineHeight: 1.6 }}>
                Claude will read the {siteLabel} pre-production pipeline and give you a useful operational read — organized by group, focusing on aging concerns, blockers, and items at risk.
                <div style={{ marginTop: 8, fontSize: 12, color: C.inkLight }}>
                  Generation takes 5-10 seconds and costs roughly $0.05-0.10 in API tokens.
                </div>
              </div>
              <button onClick={onGenerate}
                style={{
                  padding: '10px 24px',
                  background: accent, color: '#fff',
                  border: 'none', borderRadius: 8,
                  fontSize: 13, fontWeight: 700,
                  cursor: 'pointer',
                }}>
                ✦ Generate Observations
              </button>
            </div>
          )}

          {/* Observation content */}
          {hasObs && !loading && (
            <ObservationMarkdown md={observation.observations_md} />
          )}

          {/* Loading state */}
          {loading && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: C.inkLight, fontSize: 13, fontStyle: 'italic' }}>
              <div style={{ fontSize: 24, marginBottom: 12 }}>✦</div>
              Claude is reading the pipeline…
            </div>
          )}
        </div>

        {/* Footer */}
        {(hasObs || isStaleObs) && !loading && (
          <div style={{
            borderTop: `1px solid ${C.border}`,
            padding: '12px 20px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            background: C.parchment,
          }}>
            <div style={{ fontSize: 11, color: C.inkLight }}>
              {observation?.generated_at && (
                <>Generated {new Date(observation.generated_at).toLocaleString()}</>
              )}
              {observation?.item_count && (
                <span style={{ marginLeft: 8 }}>· {observation.item_count} items</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={onClose}
                style={{
                  padding: '7px 14px',
                  background: 'transparent', color: C.inkMid,
                  border: `1px solid ${C.border}`, borderRadius: 6,
                  fontSize: 12, fontWeight: 500,
                  cursor: 'pointer',
                }}>
                Close
              </button>
              <button onClick={onRerun}
                style={{
                  padding: '7px 14px',
                  background: isStaleObs ? accent : '#fff',
                  color: isStaleObs ? '#fff' : accent,
                  border: `1px solid ${accent}`, borderRadius: 6,
                  fontSize: 12, fontWeight: 700,
                  cursor: 'pointer',
                }}>
                ↻ Re-run
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Lightweight Markdown renderer ────────────────────────────────────────
// Supports: **bold**, *italic*, `code`, paragraphs, line breaks, simple lists.
// No external lib — Claude's output is structured but doesn't need full GFM.
//
// Reasoning for inline rendering vs react-markdown: avoids adding a dep;
// Claude's prompt explicitly requests bold-only headers + paragraphs, which
// this handles. If output style ever needs richer markdown, swap in
// react-markdown — straightforward upgrade.

function ObservationMarkdown({ md }) {
  if (!md) return null
  const blocks = md.split(/\n\s*\n/)  // split on blank lines

  return (
    <div>
      {blocks.map((block, i) => {
        // Bullet list block
        if (/^\s*[-*•]\s/.test(block)) {
          const items = block.split(/\n/).map(l => l.replace(/^\s*[-*•]\s/, '')).filter(Boolean)
          return (
            <ul key={i} style={{ marginTop: 0, marginBottom: 12, paddingLeft: 20 }}>
              {items.map((it, j) => (
                <li key={j} style={{ marginBottom: 4 }}>
                  <span dangerouslySetInnerHTML={{ __html: renderInline(it) }} />
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i} style={{ marginTop: 0, marginBottom: 12 }}>
            <span dangerouslySetInnerHTML={{ __html: renderInline(block) }} />
          </p>
        )
      })}
    </div>
  )
}

function renderInline(text) {
  // Order matters — code first so its ** doesn't get interpreted
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code style="background:#F4F1EA;padding:1px 5px;border-radius:3px;font-size:12px;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>')
}
