// netlify/functions/lock-wip.js
// Runs automatically every Saturday at midnight ET
// Also callable manually via POST /api/lock-wip (from Admin panel)

const MONDAY_TOKEN   = process.env.VITE_MONDAY_TOKEN
const BOARD_ID       = '6053588909'
const SUPABASE_URL   = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY  // service role for writes

// ─── Monday fetch (same logic as frontend) ───────────────────────────────────
async function fetchAllMonday() {
  const call = async (query) => {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version': '2024-01' },
      body: JSON.stringify({ query })
    })
    return res.json()
  }

  const q = (cursor) => cursor
    ? `{ next_items_page(limit:500,cursor:"${cursor}"){cursor items{id name group{id title}column_values{id text}}}}`
    : `{ boards(ids:${BOARD_ID}){items_page(limit:500){cursor items{id name group{id title}column_values{id text}}}}}`

  let all = []
  let d = await call(q(null))
  let page = d.data?.boards?.[0]?.items_page
  if (!page) throw new Error('Monday API error: ' + JSON.stringify(d.errors || d))
  all = (page.items || []).filter(i => i?.column_values)
  let cursor = page.cursor, n = 0
  while (cursor && n < 20) {
    d = await call(q(cursor))
    page = d.data?.next_items_page
    if (!page?.items?.length) break
    all = [...all, ...(page.items || []).filter(i => i?.column_values)]
    cursor = page.cursor; n++
  }
  return all
}

// ─── Helpers (mirrored from WIPTab.jsx) ──────────────────────────────────────
const col  = (item, id) => item?.column_values?.find(c => c.id === id)?.text?.trim() || ''
const yds  = item => parseFloat(col(item, 'text')?.replace(/,/g, '')) || 0

const HTI_G  = new Set(['HELD TO INVOICE CURRENT','3-27-26 PICK UP','shipping this week','NEW SHIPPED MARCH'])
const POST_G = new Set(['POST PRODUCTION - FREIGHT','POST PRODUCTION - SHIP DIRECT'])
const HOLD_G = new Set(['ON HOLD','Backstock','SCHUMACHER SHORT SHIPPED SKUS','SYSTEM ISSUES?',
  'MISSING STANDARD/WAITING ON SAMPLE1','STOCK CHECK','IN QA / INSPECTION','PENDING CFA APPROVAL',
  'Tillett SKO APPROVED NO ORDERS','GROUND ORDERS SCHUMACHER',
  'HARUKI - FULFILL IN JANUARY','HARUKI - FULFILL IN FEBRUARY','HARUKI - FULFILL IN MARCH','Fulfill from Stock'])
const isSched = t => /^(MON|TUE|WED|THURS|FRI)\b/i.test(t) || /^WEEK\s/i.test(t)

function classify(item) {
  const g = item.group?.title || ''
  const gt = col(item, 'status_1__1')
  const sw = col(item, 'dropdown_mm1xk5rp')
  if (isSched(g) || sw === 'SCHEDULE') return 'SCHEDULE'
  if (HTI_G.has(g))  return 'HTI'
  if (POST_G.has(g)) return 'POST'
  if (HOLD_G.has(g)) return 'HOLD'
  if (gt === 'NEW GOODS') return 'NEW_GOODS'
  return 'WIP'
}

function getDept(item) {
  const d = col(item, 'status_12').toUpperCase()
  if (d.includes('WALLPAPER') || d.includes('WP COLOR')) return 'Wallpaper'
  if (d.includes('GRASSCLOTH') || d.includes('GC COLOR')) return 'Grasscloth'
  if (d.includes('FABRIC')) return 'Fabric'
  return 'Other'
}

function getBucket(item) {
  const orderDate = col(item, 'date4')
  if (!orderDate?.trim()) return 'No Date'
  const parts = orderDate.trim().split('-')
  if (parts.length !== 3) return 'No Date'
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const age = Math.floor((today - d) / (1000 * 60 * 60 * 24))
  if (isNaN(age) || age < 0) return 'No Date'
  if (age <= 30) return '0-30'
  if (age <= 60) return '31-60'
  if (age <= 90) return '61-90'
  return '90+'
}

// ─── Get current fiscal week info ─────────────────────────────────────────────
function getWeekInfo() {
  const now = new Date()
  // Get Monday of current week
  const day = now.getDay()
  const diff = now.getDate() - day + (day === 0 ? -6 : 1)
  const monday = new Date(now.setDate(diff))
  monday.setHours(0, 0, 0, 0)

  const weekStart = monday.toISOString().split('T')[0]
  const month = monday.toLocaleString('en-US', { month: 'short' })
  const weekOfMonth = Math.ceil(monday.getDate() / 7)
  const year = monday.getFullYear()
  const weekLabel = `${month} Week ${weekOfMonth} ${year}`

  return { weekStart, weekLabel }
}

// ─── Save snapshot to Supabase ────────────────────────────────────────────────
async function saveSnapshot(snapshot) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/wip_snapshots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'resolution=merge-duplicates'  // upsert on week_start
    },
    body: JSON.stringify(snapshot)
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase save failed: ${err}`)
  }
  return res.json()
}

// ─── Main snapshot builder ────────────────────────────────────────────────────
async function buildAndSaveSnapshot(weekStart, weekLabel, lockedBy = 'auto') {
  console.log(`Building WIP snapshot for ${weekLabel} (${weekStart})...`)

  const items = await fetchAllMonday()
  console.log(`Fetched ${items.length} items from Monday.com`)

  const buckets = { SCHEDULE: [], HTI: [], POST: [], HOLD: [], NEW_GOODS: [], WIP: [] }
  items.forEach(i => { const c = classify(i); if (buckets[c]) buckets[c].push(i) })

  const wip = buckets.WIP
  const hti = buckets.HTI
  const ng  = buckets.NEW_GOODS
  const post = buckets.POST

  // Dept breakdown within WIP
  const depts = { Wallpaper: { orders: 0, yards: 0 }, Grasscloth: { orders: 0, yards: 0 }, Fabric: { orders: 0, yards: 0 } }
  wip.forEach(i => {
    const d = getDept(i)
    if (depts[d]) { depts[d].orders++; depts[d].yards += yds(i) }
  })

  // Age bucket breakdown within WIP
  const ages = { '0-30': { orders: 0, yards: 0 }, '31-60': { orders: 0, yards: 0 }, '61-90': { orders: 0, yards: 0 }, '90+': { orders: 0, yards: 0 }, 'No Date': { orders: 0, yards: 0 } }
  wip.forEach(i => {
    const b = getBucket(i)
    if (ages[b]) { ages[b].orders++; ages[b].yards += yds(i) }
  })

  // Serialize orders for full snapshot (key fields only to keep size reasonable)
  const serializeOrder = (item, bucket) => ({
    id:         item.id,
    name:       item.name,
    group:      item.group?.title || '',
    bucket,
    order_num:  col(item, 'text8'),
    po_num:     col(item, 'text0'),
    customer:   col(item, 'text4'),
    dept:       getDept(item),
    yards:      yds(item),
    status:     col(item, 'status5'),
    goods_type: col(item, 'status_1__1'),
    order_date: col(item, 'date4'),
    esd:        col(item, 'date'),
    colors:     col(item, 'text6__1'),
    wip_amt:    parseFloat(col(item, 'numeric_mm1t59xg')) || 0,
  })

  const allOrders = [
    ...buckets.WIP.map(i => serializeOrder(i, 'WIP')),
    ...buckets.HTI.map(i => serializeOrder(i, 'HTI')),
    ...buckets.NEW_GOODS.map(i => serializeOrder(i, 'NEW_GOODS')),
    ...buckets.POST.map(i => serializeOrder(i, 'POST')),
    ...buckets.SCHEDULE.map(i => serializeOrder(i, 'SCHEDULE')),
    ...buckets.HOLD.map(i => serializeOrder(i, 'HOLD')),
  ]

  const snapshot = {
    week_start:   weekStart,
    week_label:   weekLabel,
    locked_at:    new Date().toISOString(),
    locked_by:    lockedBy,
    total_orders: items.length,
    total_yards:  items.reduce((s, i) => s + yds(i), 0),

    wip_orders:       wip.length,
    wip_yards:        wip.reduce((s, i) => s + yds(i), 0),
    hti_orders:       hti.length,
    hti_yards:        hti.reduce((s, i) => s + yds(i), 0),
    new_goods_orders: ng.length,
    new_goods_yards:  ng.reduce((s, i) => s + yds(i), 0),
    post_orders:      post.length,
    post_yards:       post.reduce((s, i) => s + yds(i), 0),

    wallpaper_orders:  depts.Wallpaper.orders,
    wallpaper_yards:   depts.Wallpaper.yards,
    grasscloth_orders: depts.Grasscloth.orders,
    grasscloth_yards:  depts.Grasscloth.yards,
    fabric_orders:     depts.Fabric.orders,
    fabric_yards:      depts.Fabric.yards,

    age_0_30_orders:    ages['0-30'].orders,
    age_0_30_yards:     ages['0-30'].yards,
    age_31_60_orders:   ages['31-60'].orders,
    age_31_60_yards:    ages['31-60'].yards,
    age_61_90_orders:   ages['61-90'].orders,
    age_61_90_yards:    ages['61-90'].yards,
    age_90plus_orders:  ages['90+'].orders,
    age_90plus_yards:   ages['90+'].yards,
    age_no_date_orders: ages['No Date'].orders,
    age_no_date_yards:  ages['No Date'].yards,

    orders: allOrders,
  }

  await saveSnapshot(snapshot)
  console.log(`✓ Snapshot saved: ${allOrders.length} orders`)
  return snapshot
}

// ─── Netlify function handler ─────────────────────────────────────────────────
exports.handler = async (event, context) => {
  try {
    // Allow manual trigger with custom week override
    let weekStart, weekLabel, lockedBy = 'auto'

    if (event.httpMethod === 'POST' && event.body) {
      const body = JSON.parse(event.body)
      weekStart  = body.weekStart  || getWeekInfo().weekStart
      weekLabel  = body.weekLabel  || getWeekInfo().weekLabel
      lockedBy   = body.lockedBy   || 'manual'
    } else {
      // Scheduled run — use current week
      const info = getWeekInfo()
      weekStart  = info.weekStart
      weekLabel  = info.weekLabel
    }

    const snapshot = await buildAndSaveSnapshot(weekStart, weekLabel, lockedBy)

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        weekStart,
        weekLabel,
        orders: snapshot.orders.length,
        wip: snapshot.wip_orders,
        yards: snapshot.wip_yards,
      })
    }
  } catch (err) {
    console.error('lock-wip error:', err)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    }
  }
}
