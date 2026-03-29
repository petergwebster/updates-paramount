import { useState, useEffect } from 'react'
import styles from './WIPTab.module.css'

const TOKEN = import.meta.env.VITE_MONDAY_TOKEN || ''
const BOARD_ID = '6053588909'

// ─── Monday API ───────────────────────────────────────────────────────────────
async function fetchAllItems() {
  const q = (cursor) => cursor
    ? `{ next_items_page(limit: 500, cursor: "${cursor}") { cursor items { id name group { id title } column_values { id text } } } }`
    : `{ boards(ids: ${BOARD_ID}) { items_page(limit: 500) { cursor items { id name group { id title } column_values { id text } } } } }`

  const call = async (query) => {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN, 'API-Version': '2024-01' },
      body: JSON.stringify({ query })
    })
    return res.json()
  }

  let all = []
  let d = await call(q(null))
  let page = d.data?.boards?.[0]?.items_page
  if (!page) throw new Error('Monday API error: ' + JSON.stringify(d.errors || d))
  all = page.items || []
  let cursor = page.cursor
  let n = 0
  while (cursor && n < 20) {
    d = await call(q(cursor))
    page = d.data?.next_items_page
    if (!page?.items?.length) break
    all = [...all, ...page.items]
    cursor = page.cursor
    n++
  }
  return all
}

// ─── Column helpers ───────────────────────────────────────────────────────────
const col = (item, id) => item.column_values.find(c => c.id === id)?.text?.trim() || ''
const yards = item => parseFloat(col(item, 'text')?.replace(/,/g, '')) || 0
const wipAmt = item => parseFloat(col(item, 'numeric_mm1t59xg')?.replace(/,/g, '')) || 0

// ─── Classification ───────────────────────────────────────────────────────────
const HTI_GROUPS = new Set(['HELD TO INVOICE CURRENT', '3-27-26 PICK UP', 'shipping this week', 'NEW SHIPPED MARCH'])
const POST_GROUPS = new Set(['POST PRODUCTION - FREIGHT', 'POST PRODUCTION - SHIP DIRECT'])
const HOLD_GROUPS = new Set(['ON HOLD', 'Backstock', 'SCHUMACHER SHORT SHIPPED SKUS', 'SYSTEM ISSUES?',
  'MISSING STANDARD/WAITING ON SAMPLE1', 'STOCK CHECK', 'IN QA / INSPECTION', 'PENDING CFA APPROVAL',
  'Tillett SKO APPROVED NO ORDERS', 'GROUND ORDERS SCHUMACHER',
  'HARUKI - FULFILL IN JANUARY', 'HARUKI - FULFILL IN FEBRUARY', 'HARUKI - FULFILL IN MARCH', 'Fulfill from Stock'])

// Detect schedule groups: day-named groups
const isScheduleGroup = (title) => /^(MON|TUE|WED|THURS|FRI)\b/i.test(title) || /^WEEK\s/i.test(title)

function classify(item) {
  const grp = item.group?.title || ''
  const schedWip = col(item, 'dropdown_mm1xk5rp')
  const goodsType = col(item, 'status_1__1')
  if (isScheduleGroup(grp) || schedWip === 'SCHEDULE') return 'SCHEDULE'
  if (HTI_GROUPS.has(grp)) return 'HTI'
  if (POST_GROUPS.has(grp)) return 'POST'
  if (HOLD_GROUPS.has(grp)) return 'HOLD'
  if (goodsType === 'NEW GOODS') return 'NEW_GOODS'
  return 'WIP'
}

function dept(item) {
  const d = col(item, 'status_12').toUpperCase()
  if (d.includes('WALLPAPER') || d.includes('WP COLOR')) return 'Wallpaper'
  if (d.includes('GRASSCLOTH') || d.includes('GC COLOR')) return 'Grasscloth'
  if (d.includes('FABRIC')) return 'Fabric'
  if (d.includes('ROTARY')) return 'Rotary'
  return d || 'Other'
}

// ─── Schedule: extract week groups and sort Mon→Fri ──────────────────────────
const DAY_ORDER = { MON: 0, TUE: 1, WED: 2, THURS: 3, FRI: 4 }
function dayKey(title) {
  const m = title.match(/^(MON|TUE|WED|THURS|FRI)/i)
  return m ? m[1].toUpperCase() : null
}
function parseGroupDate(title) {
  const m = title.match(/(\d+)\/(\d+)/)
  if (!m) return null
  return new Date(2026, parseInt(m[1]) - 1, parseInt(m[2]))
}

// ─── Formatting ───────────────────────────────────────────────────────────────
const fmt = n => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
const fmtD = n => '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 })

function statusColor(status) {
  if (!status) return '#9ca3af'
  const s = status.toUpperCase()
  if (s === 'COMPLETE') return '#22c55e'
  if (s === 'IN PRODUCTION' || s === 'MIXING' || s === 'INK MIXING QUEUE') return '#3b82f6'
  if (s === 'APPROVED FOR PROD') return '#8b5cf6'
  if (s.includes('WAITING') || s === 'NOT STARTED' || s === 'INBOUND') return '#f59e0b'
  if (s === 'CANCELLED') return '#ef4444'
  if (s.includes('STRIKE') || s.includes('S/O')) return '#ec4899'
  return '#9ca3af'
}

function deptColor(d) {
  if (d === 'Wallpaper') return { bg: '#eff6ff', border: '#3b82f6', text: '#1d4ed8' }
  if (d === 'Grasscloth') return { bg: '#f0fdf4', border: '#22c55e', text: '#15803d' }
  if (d === 'Fabric') return { bg: '#fdf4ff', border: '#a855f7', text: '#7e22ce' }
  return { bg: '#f9fafb', border: '#9ca3af', text: '#6b7280' }
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function KPICard({ label, count, yards: yds, wip, color, sub }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', border: `2px solid ${color}20`, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', minWidth: 180 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color, lineHeight: 1 }}>{fmt(count)}</div>
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>orders</div>
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #f3f4f6' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{fmt(yds)} yds</span>
        {wip > 0 && <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>{fmtD(wip)}</span>}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function DeptBar({ label, count, yds, total }) {
  const pct = total ? Math.round((yds / total) * 100) : 0
  const dc = deptColor(label)
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: dc.text }}>{label}</span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>{count} orders · {fmt(yds)} yds</span>
      </div>
      <div style={{ height: 6, background: '#f3f4f6', borderRadius: 99 }}>
        <div style={{ height: 6, width: pct + '%', background: dc.border, borderRadius: 99, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

function OrderRow({ item, showGroup }) {
  const d = dept(item)
  const dc = deptColor(d)
  const status = col(item, 'status5')
  const sc = statusColor(status)
  const yds = yards(item)
  const toPrint = col(item, 'numeric_mm1p86dj')
  const colors = col(item, 'text6__1')
  const operator = col(item, 'status_1_mkmee286')
  const esd = col(item, 'date')
  const orderNum = col(item, 'text8')
  const goodsType = col(item, 'status_1__1')
  const wip = wipAmt(item)
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
        {/* Dept badge */}
        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: dc.bg, color: dc.text, border: `1px solid ${dc.border}`, whiteSpace: 'nowrap', minWidth: 68, textAlign: 'center' }}>{d}</span>
        {/* Name */}
        <span style={{ fontSize: 13, fontWeight: 500, color: '#111827', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
        {/* Goods type badge */}
        {goodsType === 'NEW GOODS' && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa', whiteSpace: 'nowrap' }}>NEW GOODS</span>}
        {goodsType === 'TRANSITION' && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd', whiteSpace: 'nowrap' }}>TRANSITION</span>}
        {/* Yards */}
        <span style={{ fontSize: 12, color: '#374151', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(yds)} yds</span>
        {/* Status dot */}
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: sc, flexShrink: 0 }} title={status} />
        {/* Expand */}
        <span style={{ fontSize: 10, color: '#d1d5db' }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '6px 12px 10px 12px', background: '#fafafa', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '4px 16px' }}>
          {orderNum && <div style={{ fontSize: 11, color: '#6b7280' }}>Order: <strong>{orderNum}</strong></div>}
          {esd && <div style={{ fontSize: 11, color: '#6b7280' }}>ESD: <strong>{esd}</strong></div>}
          {toPrint && <div style={{ fontSize: 11, color: '#6b7280' }}>To Print: <strong>{fmt(parseInt(toPrint))} yds</strong></div>}
          {colors && <div style={{ fontSize: 11, color: '#6b7280' }}>Colors: <strong>{colors}</strong></div>}
          {operator && <div style={{ fontSize: 11, color: '#6b7280' }}>Operator: <strong>{operator}</strong></div>}
          {wip > 0 && <div style={{ fontSize: 11, color: '#6b7280' }}>WIP $: <strong>{fmtD(wip)}</strong></div>}
          {showGroup && <div style={{ fontSize: 11, color: '#6b7280' }}>Group: <strong>{item.group?.title}</strong></div>}
          <div style={{ fontSize: 11, color: sc, fontWeight: 600 }}>{status}</div>
        </div>
      )}
    </div>
  )
}

function ScheduleDay({ dayLabel, dateLabel, items }) {
  const depts = {}
  items.forEach(i => { const d = dept(i); depts[d] = (depts[d] || 0) + 1 })
  const totalYds = items.reduce((s, i) => s + yards(i), 0)
  const complete = items.filter(i => col(i, 'status5').toUpperCase() === 'COMPLETE').length
  const inProd = items.filter(i => col(i, 'status5').toUpperCase() === 'IN PRODUCTION').length
  const approved = items.filter(i => col(i, 'status5').toUpperCase() === 'APPROVED FOR PROD').length

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Day header */}
      <div style={{ background: '#1c1c1e', padding: '10px 14px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{dayLabel}</div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{dateLabel}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#22c55e20', color: '#22c55e', border: '1px solid #22c55e40' }}>{complete} done</span>
          {inProd > 0 && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#3b82f620', color: '#3b82f6', border: '1px solid #3b82f640' }}>{inProd} in prod</span>}
          {approved > 0 && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#8b5cf620', color: '#8b5cf6', border: '1px solid #8b5cf640' }}>{approved} ready</span>}
        </div>
      </div>
      {/* Stats bar */}
      <div style={{ padding: '8px 14px', background: '#f9fafb', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>{items.length} orders · {fmt(totalYds)} yds</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {Object.entries(depts).map(([d, n]) => {
            const dc = deptColor(d)
            return <span key={d} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: dc.bg, color: dc.text, border: `1px solid ${dc.border}` }}>{d.slice(0,3)} {n}</span>
          })}
        </div>
      </div>
      {/* Order list */}
      <div style={{ flex: 1, overflowY: 'auto', maxHeight: 340 }}>
        {items.length === 0
          ? <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>No items</div>
          : items.map(item => <OrderRow key={item.id} item={item} />)
        }
      </div>
    </div>
  )
}

function WIPSection({ title, items, color, defaultCollapsed }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed || false)
  const [deptFilter, setDeptFilter] = useState('All')
  const [search, setSearch] = useState('')

  const totalYds = items.reduce((s, i) => s + yards(i), 0)
  const totalWip = items.reduce((s, i) => s + wipAmt(i), 0)

  const depts = [...new Set(items.map(dept))].sort()

  const filtered = items.filter(i => {
    const matchDept = deptFilter === 'All' || dept(i) === deptFilter
    const matchSearch = !search || i.name.toLowerCase().includes(search.toLowerCase()) || col(i, 'text8').includes(search)
    return matchDept && matchSearch
  })

  // Dept breakdown for bars
  const deptStats = {}
  items.forEach(i => {
    const d = dept(i)
    if (!deptStats[d]) deptStats[d] = { count: 0, yards: 0 }
    deptStats[d].count++
    deptStats[d].yards += yards(i)
  })

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: `1px solid #e5e7eb`, overflow: 'hidden', marginBottom: 16 }}>
      {/* Section header */}
      <div style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', borderLeft: `4px solid ${color}` }}
        onClick={() => setCollapsed(!collapsed)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{title}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color, background: color + '15', padding: '2px 8px', borderRadius: 20 }}>{items.length} orders</span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{fmt(totalYds)} yds</span>
          {totalWip > 0 && <span style={{ fontSize: 12, color: '#6b7280' }}>{fmtD(totalWip)}</span>}
        </div>
        <span style={{ color: '#9ca3af', fontSize: 12 }}>{collapsed ? '▼ Show' : '▲ Hide'}</span>
      </div>

      {!collapsed && (
        <div>
          {/* Dept bars */}
          <div style={{ padding: '12px 20px 0', background: '#fafafa', borderTop: '1px solid #f3f4f6' }}>
            {Object.entries(deptStats).sort((a,b)=>b[1].yards-a[1].yards).map(([d, s]) => (
              <DeptBar key={d} label={d} count={s.count} yds={s.yards} total={totalYds} />
            ))}
          </div>

          {/* Filters */}
          <div style={{ padding: '10px 20px', background: '#fafafa', borderTop: '1px solid #f3f4f6', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              placeholder="Search orders..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 12, width: 200, outline: 'none' }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              {['All', ...depts].map(d => (
                <button key={d} onClick={() => setDeptFilter(d)}
                  style={{ padding: '4px 10px', fontSize: 11, borderRadius: 6, border: '1px solid', cursor: 'pointer', fontWeight: deptFilter === d ? 600 : 400,
                    background: deptFilter === d ? color : 'transparent',
                    color: deptFilter === d ? '#fff' : '#6b7280',
                    borderColor: deptFilter === d ? color : '#e5e7eb' }}>
                  {d}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>{filtered.length} shown</span>
          </div>

          {/* Order rows */}
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {filtered.length === 0
              ? <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No orders match filter</div>
              : filtered.map(item => <OrderRow key={item.id} item={item} showGroup />)
            }
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function WIPTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastFetched, setLastFetched] = useState(null)
  const [activeView, setActiveView] = useState('wip') // 'schedule' | 'wip'

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const items = await fetchAllItems()

      // Classify
      const buckets = { SCHEDULE: [], HTI: [], POST: [], HOLD: [], NEW_GOODS: [], WIP: [] }
      items.forEach(i => buckets[classify(i)].push(i))

      // Build schedule: group by day key, pick the most recent week with data
      const scheduleByDay = {}
      buckets.SCHEDULE.forEach(item => {
        const grpTitle = item.group?.title || ''
        const dk = dayKey(grpTitle)
        if (!dk) return
        const d = parseGroupDate(grpTitle)
        if (!d) return
        const key = dk
        if (!scheduleByDay[key] || d > scheduleByDay[key].date) {
          scheduleByDay[key] = { date: d, title: grpTitle, items: [] }
        }
        if (scheduleByDay[key].title === grpTitle) {
          scheduleByDay[key].items.push(item)
        }
      })

      // Collect all groups, pick the upcoming week
      const allSchedGroups = {}
      buckets.SCHEDULE.forEach(item => {
        const grpTitle = item.group?.title || ''
        const dk = dayKey(grpTitle)
        if (!dk) return
        const d = parseGroupDate(grpTitle)
        if (!d) return
        if (!allSchedGroups[grpTitle]) allSchedGroups[grpTitle] = { day: dk, date: d, items: [] }
        allSchedGroups[grpTitle].items.push(item)
      })

      // Find the upcoming week (closest future Mon–Fri set)
      const today = new Date()
      const upcomingGroups = Object.values(allSchedGroups)
        .filter(g => g.date >= new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))
        .sort((a, b) => a.date - b.date)

      // Take Mon–Fri window starting from the earliest upcoming Monday
      const schedDays = {}
      upcomingGroups.forEach(g => {
        const dk = g.day
        if (!schedDays[dk]) {
          schedDays[dk] = { title: g.title, date: g.date, items: g.items }
        }
      })

      setData({ buckets, schedDays, total: items.length })
      setLastFetched(new Date())
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  const wip = data?.buckets.WIP || []
  const hti = data?.buckets.HTI || []
  const newGoods = data?.buckets.NEW_GOODS || []
  const post = data?.buckets.POST || []
  const schedDays = data?.schedDays || {}

  const DAY_LABELS = [
    { key: 'MON', label: 'Monday' },
    { key: 'TUE', label: 'Tuesday' },
    { key: 'WED', label: 'Wednesday' },
    { key: 'THURS', label: 'Thursday' },
    { key: 'FRI', label: 'Friday' },
  ]

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '0 0 40px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>Production · WIP & Schedule</h2>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Live from Monday.com — Paramount Handprints</p>
        </div>
        <div style={{ display: 'flex', align: 'center', gap: 10 }}>
          {lastFetched && <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center' }}>Last refreshed: {lastFetched.toLocaleTimeString()}</span>}
          <button onClick={load} disabled={loading}
            style={{ padding: '8px 18px', background: loading ? '#e5e7eb' : '#1c1c1e', color: loading ? '#9ca3af' : '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Loading…' : data ? '↻ Refresh' : 'Load Data'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 16px', color: '#dc2626', fontSize: 13, marginBottom: 20 }}>
          {error}
        </div>
      )}

      {!data && !loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: '#9ca3af' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#374151', marginBottom: 6 }}>No data loaded yet</div>
          <div style={{ fontSize: 13 }}>Click "Load Data" to pull from Monday.com</div>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: '#9ca3af' }}>
          <div style={{ fontSize: 13 }}>Fetching from Monday.com…</div>
        </div>
      )}

      {data && (
        <>
          {/* KPI Cards */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}>
            <KPICard
              label="Active WIP"
              count={wip.length}
              yards={wip.reduce((s,i) => s+yards(i),0)}
              wip={wip.reduce((s,i) => s+wipAmt(i),0)}
              color="#3b82f6"
              sub="Excl. New Goods & HTI"
            />
            <KPICard
              label="Held to Invoice"
              count={hti.length}
              yards={hti.reduce((s,i) => s+yards(i),0)}
              wip={0}
              color="#f59e0b"
              sub="Complete · awaiting shipment"
            />
            <KPICard
              label="New Goods"
              count={newGoods.length}
              yards={newGoods.reduce((s,i) => s+yards(i),0)}
              wip={0}
              color="#9ca3af"
              sub="In dev · not actionable"
            />
            <KPICard
              label="Post Production"
              count={post.length}
              yards={post.reduce((s,i) => s+yards(i),0)}
              wip={0}
              color="#22c55e"
              sub="Freight · ship direct"
            />
            <KPICard
              label="This Week Scheduled"
              count={Object.values(schedDays).reduce((s,d) => s+d.items.length, 0)}
              yards={Object.values(schedDays).reduce((s,d) => s+d.items.reduce((ss,i) => ss+yards(i),0), 0)}
              wip={Object.values(schedDays).reduce((s,d) => s+d.items.reduce((ss,i) => ss+wipAmt(i),0), 0)}
              color="#8b5cf6"
              sub="Mon – Fri"
            />
          </div>

          {/* View toggle */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
            {[{ id: 'schedule', label: '📅 Weekly Schedule' }, { id: 'wip', label: '🔵 WIP & Backlog' }].map(v => (
              <button key={v.id} onClick={() => setActiveView(v.id)}
                style={{ padding: '8px 18px', fontSize: 13, fontWeight: activeView === v.id ? 700 : 400, borderRadius: 8, cursor: 'pointer', border: 'none',
                  background: activeView === v.id ? '#1c1c1e' : '#f3f4f6', color: activeView === v.id ? '#fff' : '#6b7280' }}>
                {v.label}
              </button>
            ))}
          </div>

          {/* ── Schedule View ── */}
          {activeView === 'schedule' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
              {DAY_LABELS.map(({ key, label }) => {
                const dayData = schedDays[key]
                return (
                  <ScheduleDay
                    key={key}
                    dayLabel={label}
                    dateLabel={dayData?.title || 'No data'}
                    items={dayData?.items || []}
                  />
                )
              })}
            </div>
          )}

          {/* ── WIP & Backlog View ── */}
          {activeView === 'wip' && (
            <div>
              <WIPSection
                title="🔵 Active WIP Backlog"
                items={wip}
                color="#3b82f6"
              />
              <WIPSection
                title="🟡 Held to Invoice"
                items={hti}
                color="#f59e0b"
                defaultCollapsed={false}
              />
              <WIPSection
                title="⚪ New Goods — Parked, Not Actionable"
                items={newGoods}
                color="#9ca3af"
                defaultCollapsed={true}
              />
              <WIPSection
                title="🟢 Post Production"
                items={post}
                color="#22c55e"
                defaultCollapsed={true}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
