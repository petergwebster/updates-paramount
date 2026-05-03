import { useState, useEffect, useMemo } from 'react'
import { C, fmt } from '../lib/scheduleUtils'
import {
  getCurrentSnapshot,
  getNewGoodsItems,
  triggerRefresh,
  isStale,
  groupItemsByGroup,
  inProgressOnly,
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
      } else {
        setItems([])
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
      // Reload snapshot + items
      const snap = await getCurrentSnapshot()
      setSnapshot(snap)
      const data = await getNewGoodsItems({ site })
      setItems(data)
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

  // Reload items when site changes (snapshot stays the same)
  useEffect(() => {
    if (!snapshot) { loadAll(); return }
    let cancelled = false
    getNewGoodsItems({ site })
      .then(data => { if (!cancelled) setItems(data) })
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
    return out
  }, [items, showAll, search])

  const grouped = useMemo(() => groupItemsByGroup(visibleItems), [visibleItems])
  const groupOrder = orderGroups(Array.from(grouped.keys()))

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
          <div style={{ marginTop: 12, fontSize: 12, color: C.rose, background: C.roseBg, border: '1px solid #E8A0A0', borderRadius: 6, padding: '8px 12px' }}>{error}</div>
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
          <PipelineSummary site={site} groups={totalsAll} />

          {/* ── Filter row ───────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
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
    </div>
  )
}

// ─── Group ordering — show in-flight first, archive last ──────────────────

const GROUP_ORDER_HINT = [
  'Studio in Progress',
  'Studio In Progress',
  'TRANSITIONS',
  'Transitions in Progress',
  'Re-engravings',
  'Backdrop',
  'Contract',
  'APPROVED',
  'Approved',
  'DROPPED',
  'Dropped',
]

function orderGroups(groups) {
  const known = GROUP_ORDER_HINT.filter(g => groups.includes(g))
  const rest  = groups.filter(g => !GROUP_ORDER_HINT.includes(g)).sort()
  return [...known, ...rest]
}

// ─── Pipeline summary — counts per group ──────────────────────────────────

function PipelineSummary({ site, groups }) {
  if (groups.size === 0) return null

  const groupNames = orderGroups(Array.from(groups.keys()))
  const total = Array.from(groups.values()).reduce((s, arr) => s + arr.length, 0)

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', background: C.parchment, borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pipeline</span>
        <span style={{ fontSize: 11, color: C.inkLight }}>{fmt(total)} items total</span>
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
          {items.map(item => (
            <tr key={item.id} style={{ borderBottom: `1px solid ${C.border}` }}>
              <Td><strong style={{ color: C.ink }}>{item.item_name || '—'}</strong></Td>
              <Td><StatusPill value={item.status_timeline} /></Td>
              <Td><PipelinePill value={item.status_pipeline} /></Td>
              <Td>{item.customer || '—'}</Td>
              <Td>{item.development_type || '—'}</Td>
              <Td>{item.product_type || '—'}</Td>
              <Td>{item.colorway || '—'}</Td>
              <Td>{item.ground || '—'}</Td>
              <Td>{item.approver || '—'}</Td>
              <Td>{fmtDate(item.trials_due)}</Td>
              <Td>{item.launch_date_text || '—'}</Td>
            </tr>
          ))}
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
          {items.map(item => (
            <tr key={item.id} style={{ borderBottom: `1px solid ${C.border}` }}>
              <Td><strong style={{ color: C.ink }}>{item.item_name || '—'}</strong></Td>
              <Td><StatusPill value={item.status_timeline} /></Td>
              <Td><PipelinePill value={item.status_pipeline} /></Td>
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
          ))}
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
  const tone = TIMELINE_STATUS_TONES[value] || { bg: C.parchment, fg: C.inkMid, border: C.border }
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
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      fontSize: 10, fontWeight: 600,
      background: '#fff',
      color: C.inkMid,
      border: `1px solid ${C.border}`,
      borderRadius: 3,
    }}>{value}</span>
  )
}

const TIMELINE_STATUS_TONES = {
  'On time':       { bg: '#E6F2EA', fg: '#0F7A4E', border: '#9DCAB1' },
  'May be late':   { bg: '#FCF3DC', fg: '#A87A2E', border: '#E5C883' },
  'Late':          { bg: '#FCE2DE', fg: '#C12B1A', border: '#E8A0A0' },
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
