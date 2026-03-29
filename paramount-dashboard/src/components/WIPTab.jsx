import { useState, useEffect, useMemo } from 'react'

const TOKEN = import.meta.env.VITE_MONDAY_TOKEN || ''
const BOARD_ID = '6053588909'

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  cream:    '#FAF7F2',
  parchment:'#F2EDE4',
  warm:     '#E8DDD0',
  border:   '#DDD4C8',
  ink:      '#2C2420',
  inkMid:   '#5C4F47',
  inkLight: '#9C8F87',
  gold:     '#B8860B',
  goldLight:'#D4A843',
  goldBg:   '#FDF8EC',
  navy:     '#1E3A5F',
  navyLight:'#E8EEF5',
  amber:    '#C17F24',
  amberBg:  '#FEF3E2',
  sage:     '#4A6741',
  sageBg:   '#EEF3EC',
  rose:     '#8B3A3A',
  roseBg:   '#F9EDED',
  slate:    '#4A5568',
  slateBg:  '#EDF2F7',
}

// ─── Monday API ───────────────────────────────────────────────────────────────
async function fetchAllItems() {
  const call = async (query) => {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN, 'API-Version': '2024-01' },
      body: JSON.stringify({ query })
    })
    return res.json()
  }
  const q = (cursor) => cursor
    ? `{ next_items_page(limit: 500, cursor: "${cursor}") { cursor items { id name group { id title } column_values { id text } } } }`
    : `{ boards(ids: ${BOARD_ID}) { items_page(limit: 500) { cursor items { id name group { id title } column_values { id text } } } } }`

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

// ─── Helpers ─────────────────────────────────────────────────────────────────
const col = (item, id) => item.column_values.find(c => c.id === id)?.text?.trim() || ''
const yards = item => parseFloat(col(item, 'text')?.replace(/,/g, '')) || 0
const wipAmt = item => parseFloat(col(item, 'numeric_mm1t59xg')?.replace(/,/g, '')) || 0
const fmt = n => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
const fmtD = n => '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 })

function getDept(item) {
  const d = col(item, 'status_12').toUpperCase()
  if (d.includes('WALLPAPER') || d.includes('WP COLOR')) return 'Wallpaper'
  if (d.includes('GRASSCLOTH') || d.includes('GC COLOR')) return 'Grasscloth'
  if (d.includes('FABRIC')) return 'Fabric'
  if (d.includes('ROTARY')) return 'Rotary'
  return d || 'Other'
}

// ESD bucketing
function getDateBucket(item) {
  const esd = col(item, 'date')
  if (!esd) return '90+'
  const d = new Date(esd)
  const today = new Date()
  today.setHours(0,0,0,0)
  const diff = Math.floor((d - today) / (1000*60*60*24))
  if (diff < 0) return 'Overdue'
  if (diff <= 30) return '0–30 days'
  if (diff <= 60) return '31–60 days'
  if (diff <= 90) return '61–90 days'
  return '90+ days'
}

const DATE_BUCKETS = ['Overdue', '0–30 days', '31–60 days', '61–90 days', '90+ days']
const DATE_BUCKET_COLORS = {
  'Overdue':    { bg: C.roseBg,   text: C.rose,   border: '#E8A0A0' },
  '0–30 days':  { bg: C.amberBg,  text: C.amber,  border: '#F0C070' },
  '31–60 days': { bg: C.goldBg,   text: C.gold,   border: '#E0C060' },
  '61–90 days': { bg: C.navyLight,text: C.navy,   border: '#A0B8D0' },
  '90+ days':   { bg: C.slateBg,  text: C.slate,  border: '#C0CBD8' },
}

function statusDot(status) {
  const s = (status || '').toUpperCase()
  if (s === 'COMPLETE') return C.sage
  if (s === 'IN PRODUCTION' || s === 'MIXING') return C.navy
  if (s === 'APPROVED FOR PROD') return C.gold
  if (s.includes('WAITING') || s === 'NOT STARTED' || s === 'INBOUND') return C.amber
  if (s === 'CANCELLED') return C.rose
  return C.inkLight
}

// ─── Classification ───────────────────────────────────────────────────────────
const HTI_GROUPS  = new Set(['HELD TO INVOICE CURRENT','3-27-26 PICK UP','shipping this week','NEW SHIPPED MARCH'])
const POST_GROUPS = new Set(['POST PRODUCTION - FREIGHT','POST PRODUCTION - SHIP DIRECT'])
const HOLD_GROUPS = new Set(['ON HOLD','Backstock','SCHUMACHER SHORT SHIPPED SKUS','SYSTEM ISSUES?',
  'MISSING STANDARD/WAITING ON SAMPLE1','STOCK CHECK','IN QA / INSPECTION','PENDING CFA APPROVAL',
  'Tillett SKO APPROVED NO ORDERS','GROUND ORDERS SCHUMACHER',
  'HARUKI - FULFILL IN JANUARY','HARUKI - FULFILL IN FEBRUARY','HARUKI - FULFILL IN MARCH','Fulfill from Stock'])
const isScheduleGroup = t => /^(MON|TUE|WED|THURS|FRI)\b/i.test(t) || /^WEEK\s/i.test(t)

function classify(item) {
  const grp = item.group?.title || ''
  const goodsType = col(item, 'status_1__1')
  const schedWip = col(item, 'dropdown_mm1xk5rp')
  if (isScheduleGroup(grp) || schedWip === 'SCHEDULE') return 'SCHEDULE'
  if (HTI_GROUPS.has(grp)) return 'HTI'
  if (POST_GROUPS.has(grp)) return 'POST'
  if (HOLD_GROUPS.has(grp)) return 'HOLD'
  if (goodsType === 'NEW GOODS') return 'NEW_GOODS'
  return 'WIP'
}

// ─── Schedule helpers ─────────────────────────────────────────────────────────
const DAY_ORDER = { MON: 0, TUE: 1, WED: 2, THURS: 3, FRI: 4 }
function dayKey(title) {
  const m = title.match(/^(MON|TUE|WED|THURS|FRI)/i)
  return m ? m[1].toUpperCase() : null
}
function parseGroupDate(title) {
  const m = title.match(/(\d+)\/(\d+)/)
  if (!m) return null
  const year = new Date().getFullYear()
  return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]))
}

// ─── Summary Card ─────────────────────────────────────────────────────────────
function SummaryCard({ id, label, count, totalYards, totalWip, sub, active, onClick }) {
  const isActive = active === id
  return (
    <div onClick={() => onClick(id)} style={{
      flex: 1, minWidth: 160, cursor: 'pointer',
      background: isActive ? C.ink : '#fff',
      border: `1.5px solid ${isActive ? C.ink : C.border}`,
      borderRadius: 10, padding: '16px 18px',
      boxShadow: isActive ? '0 4px 20px rgba(44,36,32,0.15)' : '0 1px 4px rgba(0,0,0,0.04)',
      transition: 'all 0.2s ease',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: isActive ? C.goldLight : C.inkLight, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color: isActive ? '#fff' : C.ink, lineHeight: 1, fontFamily: 'Georgia, serif' }}>{fmt(count)}</div>
      <div style={{ fontSize: 11, color: isActive ? '#aaa' : C.inkLight, marginTop: 3 }}>orders</div>
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${isActive ? '#ffffff20' : C.border}` }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: isActive ? C.goldLight : C.inkMid }}>{fmt(totalYards)} yds</span>
        {totalWip > 0 && <span style={{ fontSize: 11, color: isActive ? '#aaa' : C.inkLight, marginLeft: 8 }}>{fmtD(totalWip)}</span>}
      </div>
      {sub && <div style={{ fontSize: 10, color: isActive ? '#888' : C.inkLight, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ─── Order Row ────────────────────────────────────────────────────────────────
function OrderRow({ item }) {
  const [open, setOpen] = useState(false)
  const d = getDept(item)
  const status = col(item, 'status5')
  const sc = statusDot(status)
  const yds = yards(item)
  const toPrint = col(item, 'numeric_mm1p86dj')
  const colors = col(item, 'text6__1')
  const operator = col(item, 'status_1_mkmee286')
  const esd = col(item, 'date')
  const orderNum = col(item, 'text8')
  const po = col(item, 'text0')
  const goodsType = col(item, 'status_1__1')
  const wip = wipAmt(item)
  const bucket = getDateBucket(item)
  const bc = DATE_BUCKET_COLORS[bucket]
  const customer = col(item, 'text4')

  const DEPT_COLORS = {
    Wallpaper:  { bg: C.navyLight, text: C.navy },
    Grasscloth: { bg: C.sageBg,   text: C.sage },
    Fabric:     { bg: C.amberBg,  text: C.amber },
    Rotary:     { bg: C.slateBg,  text: C.slate },
  }
  const dc = DEPT_COLORS[d] || { bg: C.parchment, text: C.inkMid }

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, background: open ? C.parchment : 'transparent', transition: 'background 0.15s' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', cursor: 'pointer' }}>
        <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: dc.bg, color: dc.text, whiteSpace: 'nowrap', minWidth: 62, textAlign: 'center', letterSpacing: '0.04em' }}>{d.toUpperCase()}</span>
        <span style={{ flex: 1, fontSize: 13, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{item.name}</span>
        {goodsType === 'NEW GOODS' && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: C.amberBg, color: C.amber, border: `1px solid ${C.goldLight}40`, whiteSpace: 'nowrap' }}>NEW GOODS</span>}
        {goodsType === 'TRANSITION' && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: C.navyLight, color: C.navy, whiteSpace: 'nowrap' }}>TRANSITION</span>}
        {esd && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: bc.bg, color: bc.text, border: `1px solid ${bc.border}`, whiteSpace: 'nowrap' }}>{esd}</span>}
        <span style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, whiteSpace: 'nowrap' }}>{fmt(yds)} yds</span>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc, flexShrink: 0 }} />
        <span style={{ fontSize: 9, color: C.border }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ padding: '8px 16px 12px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '4px 20px' }}>
          {orderNum && <Detail label="Order #" value={orderNum} />}
          {po && <Detail label="PO #" value={po} />}
          {customer && <Detail label="Customer" value={customer} />}
          {esd && <Detail label="ESD" value={esd} />}
          {toPrint && <Detail label="Yards to Print" value={fmt(parseInt(toPrint))} />}
          {colors && <Detail label="# Colors" value={colors} />}
          {operator && <Detail label="Operator" value={operator} />}
          {wip > 0 && <Detail label="WIP Value" value={fmtD(wip)} />}
          <Detail label="Status" value={status} color={sc} />
          {goodsType && <Detail label="Type" value={goodsType} />}
          <Detail label="Group" value={item.group?.title} />
        </div>
      )}
    </div>
  )
}

function Detail({ label, value, color }) {
  if (!value) return null
  return (
    <div style={{ fontSize: 11 }}>
      <span style={{ color: C.inkLight, marginRight: 4 }}>{label}:</span>
      <span style={{ color: color || C.inkMid, fontWeight: 600 }}>{value}</span>
    </div>
  )
}

// ─── WIP Detail Panel ─────────────────────────────────────────────────────────
function WIPDetailPanel({ items, title }) {
  const [deptFilter, setDeptFilter] = useState('All')
  const [bucketFilter, setBucketFilter] = useState('All')
  const [search, setSearch] = useState('')
  const [groupBy, setGroupBy] = useState('date') // 'date' | 'dept' | 'status' | 'flat'

  const depts   = useMemo(() => ['All', ...new Set(items.map(getDept))].filter((v,i,a) => a.indexOf(v)===i), [items])
  const statuses = useMemo(() => ['All', ...new Set(items.map(i => col(i,'status5')).filter(Boolean))], [items])

  const filtered = useMemo(() => items.filter(i => {
    if (deptFilter !== 'All' && getDept(i) !== deptFilter) return false
    if (bucketFilter !== 'All' && getDateBucket(i) !== bucketFilter) return false
    if (search && !i.name.toLowerCase().includes(search.toLowerCase()) &&
        !col(i,'text8').includes(search) && !col(i,'text4').toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [items, deptFilter, bucketFilter, search])

  const totalYds = filtered.reduce((s,i) => s+yards(i),0)
  const totalWip = filtered.reduce((s,i) => s+wipAmt(i),0)

  // Group by date bucket
  const byBucket = useMemo(() => {
    const g = {}
    DATE_BUCKETS.forEach(b => { g[b] = [] })
    filtered.forEach(i => { const b = getDateBucket(i); if (g[b]) g[b].push(i) })
    return g
  }, [filtered])

  // Group by dept
  const byDept = useMemo(() => {
    const g = {}
    filtered.forEach(i => { const d = getDept(i); if (!g[d]) g[d] = []; g[d].push(i) })
    return g
  }, [filtered])

  // Dept summary bars
  const deptStats = useMemo(() => {
    const s = {}
    items.forEach(i => {
      const d = getDept(i)
      if (!s[d]) s[d] = { count:0, yards:0, wip:0 }
      s[d].count++; s[d].yards += yards(i); s[d].wip += wipAmt(i)
    })
    return Object.entries(s).sort((a,b) => b[1].yards - a[1].yards)
  }, [items])
  const maxYds = Math.max(...deptStats.map(([,v]) => v.yards), 1)

  const DEPT_COLORS = { Wallpaper: C.navy, Grasscloth: C.sage, Fabric: C.amber, Rotary: C.slate }

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
      {/* Dept overview bars */}
      <div style={{ padding: '16px 20px', background: C.parchment, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {deptStats.map(([d, s]) => {
            const dc = DEPT_COLORS[d] || C.inkMid
            const pct = Math.round((s.yards / maxYds) * 100)
            return (
              <div key={d} style={{ flex: 1, minWidth: 140 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: dc, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{d}</span>
                  <span style={{ fontSize: 11, color: C.inkLight }}>{s.count} · {fmt(s.yards)} yds{s.wip > 0 ? ` · ${fmtD(s.wip)}` : ''}</span>
                </div>
                <div style={{ height: 5, background: C.warm, borderRadius: 99 }}>
                  <div style={{ height: 5, width: pct+'%', background: dc, borderRadius: 99, transition: 'width 0.6s' }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', background: '#fdfcfb' }}>
        <input placeholder="Search name, order #, customer…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, width: 220, outline: 'none', background: '#fff', color: C.ink }} />

        <FilterTabs label="Dept" options={depts} active={deptFilter} onChange={setDeptFilter} />
        <FilterTabs label="Date" options={['All', ...DATE_BUCKETS]} active={bucketFilter} onChange={setBucketFilter}
          colorMap={DATE_BUCKET_COLORS} />

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {[['date','By Date'],['dept','By Dept'],['flat','All']].map(([v,l]) => (
            <button key={v} onClick={() => setGroupBy(v)}
              style={{ padding: '4px 10px', fontSize: 11, borderRadius: 6, cursor: 'pointer', fontWeight: groupBy===v?700:400, border: `1px solid ${groupBy===v ? C.ink : C.border}`, background: groupBy===v ? C.ink : 'transparent', color: groupBy===v ? '#fff' : C.inkMid }}>
              {l}
            </button>
          ))}
        </div>

        <span style={{ fontSize: 11, color: C.inkLight }}>
          {fmt(filtered.length)} orders · {fmt(totalYds)} yds{totalWip > 0 ? ` · ${fmtD(totalWip)}` : ''}
        </span>
      </div>

      {/* Order list */}
      <div style={{ maxHeight: 520, overflowY: 'auto' }}>
        {filtered.length === 0
          ? <div style={{ padding: 32, textAlign: 'center', color: C.inkLight, fontSize: 13 }}>No orders match filter</div>
          : groupBy === 'date'
          ? DATE_BUCKETS.map(b => byBucket[b]?.length ? (
            <div key={b}>
              <BucketHeader label={b} count={byBucket[b].length} yds={byBucket[b].reduce((s,i)=>s+yards(i),0)} wip={byBucket[b].reduce((s,i)=>s+wipAmt(i),0)} colors={DATE_BUCKET_COLORS[b]} />
              {byBucket[b].map(i => <OrderRow key={i.id} item={i} />)}
            </div>
          ) : null)
          : groupBy === 'dept'
          ? Object.entries(byDept).map(([d, ditems]) => (
            <div key={d}>
              <BucketHeader label={d} count={ditems.length} yds={ditems.reduce((s,i)=>s+yards(i),0)} wip={ditems.reduce((s,i)=>s+wipAmt(i),0)}
                colors={{ bg: C.parchment, text: C.inkMid, border: C.border }} />
              {ditems.map(i => <OrderRow key={i.id} item={i} />)}
            </div>
          ))
          : filtered.map(i => <OrderRow key={i.id} item={i} />)
        }
      </div>
    </div>
  )
}

function BucketHeader({ label, count, yds, wip, colors }) {
  return (
    <div style={{ padding: '7px 16px', background: colors.bg, borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, zIndex: 1 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: colors.text, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</span>
      <span style={{ fontSize: 11, color: colors.text, opacity: 0.7 }}>{count} orders · {fmt(yds)} yds{wip > 0 ? ` · ${fmtD(wip)}` : ''}</span>
    </div>
  )
}

function FilterTabs({ label, options, active, onChange, colorMap }) {
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: C.inkLight, marginRight: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}:</span>
      {options.map(o => {
        const isActive = active === o
        const cm = colorMap?.[o]
        return (
          <button key={o} onClick={() => onChange(o)}
            style={{ padding: '3px 8px', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: `1px solid ${isActive ? (cm?.text || C.ink) : C.border}`,
              background: isActive ? (cm?.bg || C.ink) : 'transparent',
              color: isActive ? (cm?.text || '#fff') : C.inkMid,
              fontWeight: isActive ? 700 : 400 }}>
            {o}
          </button>
        )
      })}
    </div>
  )
}

// ─── Schedule Day ─────────────────────────────────────────────────────────────
function ScheduleDay({ dayLabel, dateLabel, items }) {
  const [collapsed, setCollapsed] = useState(false)
  if (!items.length) return null

  const complete   = items.filter(i => col(i,'status5').toUpperCase() === 'COMPLETE').length
  const inProd     = items.filter(i => col(i,'status5').toUpperCase() === 'IN PRODUCTION').length
  const approved   = items.filter(i => col(i,'status5').toUpperCase() === 'APPROVED FOR PROD').length
  const totalYds   = items.reduce((s,i) => s+yards(i), 0)

  // Dept breakdown
  const deptCounts = {}
  items.forEach(i => { const d = getDept(i); deptCounts[d] = (deptCounts[d]||0)+1 })

  const DEPT_C = { Wallpaper: { bg: C.navyLight, text: C.navy }, Grasscloth: { bg: C.sageBg, text: C.sage }, Fabric: { bg: C.amberBg, text: C.amber } }

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden', marginBottom: 12 }}>
      {/* Day header */}
      <div onClick={() => setCollapsed(!collapsed)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: C.ink, cursor: 'pointer' }}>
        <div style={{ minWidth: 90 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', fontFamily: 'Georgia, serif' }}>{dayLabel}</div>
          <div style={{ fontSize: 11, color: C.goldLight, marginTop: 1 }}>{dateLabel}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
          <Pill label={`${items.length} orders`} bg="#ffffff15" text="#fff" />
          <Pill label={`${fmt(totalYds)} yds`} bg="#ffffff15" text={C.goldLight} />
          <Pill label={`${complete} complete`} bg="#22c55e20" text="#86efac" />
          {inProd > 0 && <Pill label={`${inProd} in prod`} bg="#3b82f620" text="#93c5fd" />}
          {approved > 0 && <Pill label={`${approved} ready`} bg={C.goldBg+'40'} text={C.goldLight} />}
          {Object.entries(deptCounts).map(([d,n]) => {
            const dc = DEPT_C[d] || {}
            return <Pill key={d} label={`${d.slice(0,3)} ${n}`} bg="#ffffff10" text="#ccc" />
          })}
        </div>
        <span style={{ color: '#666', fontSize: 11 }}>{collapsed ? '▼' : '▲'}</span>
      </div>

      {/* Orders — full width table */}
      {!collapsed && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 90px 80px 80px 120px 90px', gap: 0, padding: '6px 16px', background: C.parchment, borderBottom: `1px solid ${C.border}` }}>
            {['Dept','Item','Ordered','To Print','Colors','Operator','Status'].map(h => (
              <span key={h} style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.inkLight }}>{h}</span>
            ))}
          </div>
          {items.map(item => <ScheduleRow key={item.id} item={item} />)}
        </div>
      )}
    </div>
  )
}

function ScheduleRow({ item }) {
  const [open, setOpen] = useState(false)
  const d = getDept(item)
  const status = col(item, 'status5')
  const sc = statusDot(status)
  const yds = yards(item)
  const toPrint = col(item, 'numeric_mm1p86dj')
  const colors = col(item, 'text6__1')
  const operator = col(item, 'status_1_mkmee286')
  const goodsType = col(item, 'status_1__1')
  const wip = wipAmt(item)
  const shift = col(item, 'shift_mkme25cp')

  const DEPT_C = { Wallpaper: { bg: C.navyLight, text: C.navy }, Grasscloth: { bg: C.sageBg, text: C.sage }, Fabric: { bg: C.amberBg, text: C.amber } }
  const dc = DEPT_C[d] || { bg: C.parchment, text: C.inkMid }

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, background: open ? C.parchment : 'transparent' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 90px 80px 80px 120px 90px', gap: 0, padding: '8px 16px', cursor: 'pointer', alignItems: 'center' }}>
        <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3, background: dc.bg, color: dc.text, display: 'inline-block', textAlign: 'center' }}>{d.toUpperCase().slice(0,4)}</span>
        <div style={{ minWidth: 0, paddingRight: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
          {goodsType === 'NEW GOODS' && <span style={{ fontSize: 9, color: C.amber, fontWeight: 700 }}>NEW GOODS</span>}
        </div>
        <span style={{ fontSize: 12, color: C.inkMid }}>{fmt(yds)} yds</span>
        <span style={{ fontSize: 12, color: C.inkMid }}>{toPrint ? fmt(parseInt(toPrint))+' yds' : '—'}</span>
        <span style={{ fontSize: 12, color: C.inkMid }}>{colors || '—'}</span>
        <span style={{ fontSize: 11, color: C.inkMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{operator || '—'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc, flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: C.inkMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status}</span>
        </div>
      </div>
      {open && (
        <div style={{ padding: '6px 16px 10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '4px 20px', background: C.cream }}>
          {col(item,'text8') && <Detail label="Order #" value={col(item,'text8')} />}
          {col(item,'text0') && <Detail label="PO #" value={col(item,'text0')} />}
          {col(item,'text4') && <Detail label="Customer" value={col(item,'text4')} />}
          {col(item,'date') && <Detail label="ESD" value={col(item,'date')} />}
          {wip > 0 && <Detail label="WIP $" value={fmtD(wip)} />}
          {shift && <Detail label="Shift" value={shift} />}
        </div>
      )}
    </div>
  )
}

function Pill({ label, bg, text }) {
  return <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: bg, color: text, fontWeight: 500 }}>{label}</span>
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function WIPTab() {
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)
  const [lastFetched, setLastFetched] = useState(null)
  const [activeCard, setActiveCard]   = useState('WIP')
  const [view, setView]               = useState('wip') // 'wip' | 'schedule'

  async function load() {
    setLoading(true); setError(null)
    try {
      const items = await fetchAllItems()
      const buckets = { SCHEDULE:[], HTI:[], POST:[], HOLD:[], NEW_GOODS:[], WIP:[] }
      items.forEach(i => buckets[classify(i)].push(i))

      // Build schedule days
      const groups = {}
      buckets.SCHEDULE.forEach(item => {
        const t = item.group?.title || ''
        const dk = dayKey(t)
        const dt = parseGroupDate(t)
        if (!dk || !dt) return
        if (!groups[t]) groups[t] = { day: dk, date: dt, title: t, items: [] }
        groups[t].items.push(item)
      })

      // Pick upcoming week groups (next 5 days with data)
      const today = new Date(); today.setHours(0,0,0,0)
      const upcoming = Object.values(groups)
        .filter(g => g.date >= new Date(today.getTime() - 86400000))
        .sort((a,b) => a.date - b.date)

      const schedDays = {}
      upcoming.forEach(g => {
        if (!schedDays[g.day]) schedDays[g.day] = g
      })

      setData({ buckets, schedDays, total: items.length })
      setLastFetched(new Date())
    } catch(e) { setError(e.message) }
    setLoading(false)
  }

  const wip      = data?.buckets.WIP || []
  const hti      = data?.buckets.HTI || []
  const newGoods = data?.buckets.NEW_GOODS || []
  const post     = data?.buckets.POST || []
  const schedDays = data?.schedDays || {}

  const DAY_LABELS = [
    { key:'MON', label:'Monday' },
    { key:'TUE', label:'Tuesday' },
    { key:'WED', label:'Wednesday' },
    { key:'THURS', label:'Thursday' },
    { key:'FRI', label:'Friday' },
  ]

  const CARDS = [
    { id:'WIP',      label:'Active WIP',          items:wip,      sub:'Excl. New Goods & HTI',       color:C.navy },
    { id:'HTI',      label:'Held to Invoice',      items:hti,      sub:'Complete · awaiting shipment', color:C.amber },
    { id:'NEW_GOODS',label:'New Goods',            items:newGoods, sub:'In dev · not actionable',      color:C.inkLight },
    { id:'POST',     label:'Post Production',      items:post,     sub:'Freight & ship direct',        color:C.sage },
  ]

  const activeItems = CARDS.find(c => c.id === activeCard)?.items || []
  const activeTitle = CARDS.find(c => c.id === activeCard)?.label || ''

  return (
    <div style={{ background: C.cream, minHeight: '100vh', padding: '0 0 48px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Page header */}
      <div style={{ padding: '20px 0 16px', marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: C.ink, fontFamily: 'Georgia, serif' }}>Production · WIP & Schedule</h2>
            <p style={{ fontSize: 13, color: C.inkLight, margin: '4px 0 0' }}>Paramount Handprints · Monday.com · {data?.total ? `${data.total} total items` : 'Not loaded'}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {lastFetched && <span style={{ fontSize: 11, color: C.inkLight }}>Refreshed {lastFetched.toLocaleTimeString()}</span>}
            <button onClick={load} disabled={loading} style={{ padding: '9px 20px', background: loading ? C.warm : C.ink, color: loading ? C.inkLight : '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', letterSpacing: '0.02em' }}>
              {loading ? 'Loading…' : data ? '↻ Refresh' : 'Load Data'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ background: C.roseBg, border: `1px solid #E8A0A0`, borderRadius: 8, padding: '12px 16px', color: C.rose, fontSize: 13, marginBottom: 16 }}>{error}</div>
      )}

      {!data && !loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>⚑</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.inkMid, fontFamily: 'Georgia, serif', marginBottom: 8 }}>No data loaded</div>
          <div style={{ fontSize: 13, color: C.inkLight }}>Click "Load Data" to pull live from Monday.com</div>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: C.inkLight, fontSize: 14 }}>Fetching from Monday.com…</div>
      )}

      {data && (
        <>
          {/* View toggle */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
            {[{ v:'wip', l:'WIP & Backlog' },{ v:'schedule', l:'Weekly Schedule' }].map(({ v, l }) => (
              <button key={v} onClick={() => setView(v)}
                style={{ padding: '8px 20px', fontSize: 13, fontWeight: view===v?700:400, borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${view===v ? C.ink : C.border}`, background: view===v ? C.ink : 'transparent', color: view===v ? '#fff' : C.inkMid, letterSpacing: '0.02em' }}>
                {l}
              </button>
            ))}
          </div>

          {/* ── WIP VIEW ── */}
          {view === 'wip' && (
            <>
              {/* Summary cards */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                {CARDS.map(c => (
                  <SummaryCard key={c.id} id={c.id} label={c.label}
                    count={c.items.length}
                    totalYards={c.items.reduce((s,i)=>s+yards(i),0)}
                    totalWip={c.items.reduce((s,i)=>s+wipAmt(i),0)}
                    sub={c.sub}
                    active={activeCard}
                    onClick={setActiveCard}
                  />
                ))}
              </div>

              {/* Detail panel */}
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: C.ink, margin: 0, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{activeTitle}</h3>
                <span style={{ fontSize: 12, color: C.inkLight }}>— {activeItems.length} orders</span>
              </div>
              <WIPDetailPanel items={activeItems} title={activeTitle} />
            </>
          )}

          {/* ── SCHEDULE VIEW ── */}
          {view === 'schedule' && (
            <div>
              {DAY_LABELS.map(({ key, label }) => {
                const dayData = schedDays[key]
                return (
                  <ScheduleDay key={key} dayLabel={label} dateLabel={dayData?.title || ''} items={dayData?.items || []} />
                )
              })}
              {Object.keys(schedDays).length === 0 && (
                <div style={{ textAlign: 'center', padding: 40, color: C.inkLight }}>No scheduled items found for upcoming week</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
