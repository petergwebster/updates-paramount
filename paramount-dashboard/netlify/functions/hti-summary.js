// hti-summary.js — LIVE Held-to-Invoice stock from LIFT.
//
// THE BUSINESS RULE (exec deck goal): each site should carry no more than
// ONE WEEK'S production target in held-to-invoice at any time —
// Passaic 8,610 yd · BNY 12,000 yd. This function reports the live stock
// against that bar.
//
// THE MEASURE (John's DAX, proven in the 8/9 tie-out and matching Wendy's
// 8/25 drill-through export line-for-line): a line is HELD when it has
// printed quantity but NO INVOICE DATE yet. Yards = raw QTY_PRINTED ×
// per-SKU Yield (consultant's master via ref_product_yield, with the
// new-SKU fallback chain). Lines drop off automatically the moment LIFT
// dates their invoice — this is a stock snapshot, not a ledger.
//
// POST {} → { asOf, sites: { passaic: {...}, bny: {...} }, lines: [...] }

const LIFT_BASE_URL = process.env.LIFT_BASE_URL
const SUPABASE_URL  = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

const MIN_ORDER_LINES = 5000
const WEEK_TARGET = { sp: 8610, dg: 12000 }

function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  if (!rows.length) return { headers: [], records: [] }
  const headers = rows[0].map(h => h.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
  const records = rows.slice(1).map(r => {
    const o = {}
    for (let i = 0; i < headers.length; i++) o[headers[i]] = (r[i] || '').trim()
    return o
  })
  return { headers, records }
}

async function fetchCsv(report) {
  const res = await fetch(`${LIFT_BASE_URL}/${report}/${report}.csv`)
  if (!res.ok) throw new Error(`${report}: HTTP ${res.status}`)
  return res.text()
}

async function fetchYieldMap() {
  const map = new Map()
  if (!SUPABASE_URL || !SUPABASE_KEY) return map
  // PostgREST caps every response at 1,000 rows — page by exactly 1,000.
  const PAGE = 1000
  let off = 0
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ref_product_yield?select=item_sku,yield,product_type&limit=${PAGE}&offset=${off}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    if (!res.ok) throw new Error(`ref_product_yield fetch failed: HTTP ${res.status}`)
    const rows = await res.json()
    for (const r of rows) if (r.item_sku) map.set(String(r.item_sku), { yield: Number(r.yield) || 1, type: r.product_type || '' })
    if (rows.length < PAGE) break
    off += PAGE
  }
  return map
}

const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,%\s,]/g, '')); return Number.isFinite(n) ? n : 0 }
const normKey = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')
const dateOf = v => String(v || '').slice(0, 10)

const PRODUCT_MAP = {
  'FABRIC':               { div: 'sp', cat: 'fabric', kind: 'yards' },
  'STRIKE-OFF':           { div: 'sp', cat: 'other',  kind: 'yards' },
  'GRASS':                { div: 'sp', cat: 'grass',  kind: 'yards' },
  'PAPER':                { div: 'sp', cat: 'paper',  kind: 'yards' },
  'ROTARY':               { div: 'sp', cat: 'fabric', kind: 'yards' },
  'PANEL SCREEN':         { div: 'sp', cat: 'paper',  kind: 'yards' },
  'MEMO SCREEN':          { div: 'sp', cat: 'paper',  kind: 'yards' },
  'ENGINEERED WINGS SCREEN': { div: 'sp', cat: 'paper', kind: 'yards' },
  'CUSTOM STRIPE':        { div: 'sp', cat: 'paper',  kind: 'yards' },
  'REGULAR':              { div: 'dg', cat: 'digital', kind: 'yards' },
  'CONTRACT WALLPAPER':   { div: 'dg', cat: 'digital', kind: 'yards' },
  'PEEL & STICK':         { div: 'dg', cat: 'digital', kind: 'yards' },
  'CUSTOM':               { div: 'dg', cat: 'digital', kind: 'yards' },
  'HOSPITALITY':          { div: 'dg', cat: 'digital', kind: 'yards' },
  'MEMO':                 { div: 'dg', cat: 'digital', kind: 'yards' },
  'PANEL':                { div: 'dg', cat: 'digital', kind: 'yards' },
  'ENGINEERED WINGS':     { div: 'dg', cat: 'digital', kind: 'yards' },
  'CONTRACT FABRIC':      { div: 'dg', cat: 'digital', kind: 'yards' },
  'GROUNDS':              { kind: 'skip' },
  'FEES':                 { kind: 'skip' },
  'PACKING CHARGE':       { kind: 'skip' },
  'CANCELLATION FEE':     { kind: 'skip' },
  'DESIGN SERVICES':      { kind: 'skip' },
  'SCHUMACHER PROC':      { kind: 'skip' },
}

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

exports.handler = async function () {
  let orders, products, yieldMap
  try {
    const [oTxt, pTxt, yMap] = await Promise.all([fetchCsv('orders'), fetchCsv('products'), fetchYieldMap()])
    orders = parseCsv(oTxt).records
    products = parseCsv(pTxt).records
    yieldMap = yMap
  } catch (e) { return json(502, { error: `pull failed: ${e.message}` }) }
  if (orders.length < MIN_ORDER_LINES) {
    return json(502, { error: `completeness guard: only ${orders.length} order lines — refusing a truncated pull` })
  }

  const skuInfo = new Map()
  for (const p of products) {
    if (p.ITEMSKU) skuInfo.set(p.ITEMSKU, {
      type: p.PRODUCTTYPE || '', up: num(p.NUMBERUP), hy: num(p.HISTORICALYIELD),
    })
  }
  const NUP_TYPES = new Set(['REGULAR', 'CONTRACT WALLPAPER', 'PEEL & STICK'])
  function resolveYield(ref, info, typeRaw) {
    if (ref?.yield != null) return ref.yield
    if (info?.hy > 0) return info.hy
    const t = normKey(typeRaw)
    if (NUP_TYPES.has(t) && info?.up > 1) return 1 / info.up
    if (t === 'MEMO') return 0.08
    return 1
  }

  const today = new Date().toISOString().slice(0, 10)
  const ageOf = d => Math.max(0, Math.round((Date.parse(today) - Date.parse(d)) / 86400000))

  const lines = []
  let unresolvedLines = 0
  const site = {
    sp: { yds: 0, lines: 0, byCat: {}, byCustomer: {}, ages: { d7: 0, d14: 0, d30: 0, d60: 0, d60plus: 0 } },
    dg: { yds: 0, lines: 0, byCat: {}, byCustomer: {}, ages: { d7: 0, d14: 0, d30: 0, d60: 0, d60plus: 0 } },
  }

  for (const r of orders) {
    const invoiced = dateOf(r.INVOICEDATE)
    if (invoiced) continue
    const q = num(r.QTYPRINTED)
    if (!(q > 0)) continue
    const status = (r.ORDERSTATUS || '').toLowerCase()
    if (status.includes('cancel') || status.includes('void')) continue

    const info = skuInfo.get(r.ITEMSKU)
    const ref = yieldMap.get(String(r.ITEMSKU))
    const typeRaw = info?.type || ref?.type || r.PRODUCTTYPE || ''
    const pm = PRODUCT_MAP[normKey(typeRaw)]
    // KNOWN non-yards types (grounds, fees, packing, procurement) stay out.
    if (pm && pm.kind !== 'yards') continue
    // UNKNOWN type — overwhelmingly NEW-GOODS SKUs absent from the live
    // products report, and new goods sit held longest (Wendy's 8/25 drill:
    // largest holders all FSCO NEW GOODS). Skipping these was a 5–15×
    // undercount. Keep the line: division from LIFT's ORDER_TYPE, category
    // 'new goods', yield via the fallback chain.
    let div, cat
    if (pm) { div = pm.div; cat = pm.cat }
    else {
      div = ((r.ORDERTYPE || '').toLowerCase().includes('digital')) ? 'dg' : 'sp'
      cat = 'new goods'
      unresolvedLines++
    }

    const yf = resolveYield(ref, info, typeRaw)
    const yds = q * yf
    const printed = dateOf(r.PRINTEDDATE)
    const age = printed ? ageOf(printed) : null
    const s = site[div]
    s.yds += yds; s.lines++
    s.byCat[cat] = (s.byCat[cat] || 0) + yds
    const cust = r.CUSTOMERNAME || '—'
    s.byCustomer[cust] = (s.byCustomer[cust] || 0) + yds
    if (age != null) {
      if (age < 7) s.ages.d7 += yds
      else if (age < 14) s.ages.d14 += yds
      else if (age < 30) s.ages.d30 += yds
      else if (age < 60) s.ages.d60 += yds
      else s.ages.d60plus += yds
    }
    lines.push({
      div, po: r.PONUMBER || '', order: r.ORDERNUMBER || '',
      sku: r.ITEMSKU || '', desc: r.LINEDESCRIPTION || '', customer: cust,
      cat, status: r.ORDERSTATUS || '', printed, age,
      qty: q, yield: yf, yds: Math.round(yds * 10) / 10,
    })
  }
  lines.sort((a, b) => (b.age ?? -1) - (a.age ?? -1))

  const shape = (k) => {
    const s = site[k]
    const topCustomers = Object.entries(s.byCustomer).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([name, yds]) => ({ name, yds: Math.round(yds) }))
    return {
      yds: Math.round(s.yds), lines: s.lines,
      target: WEEK_TARGET[k], pctOfTarget: Math.round((s.yds / WEEK_TARGET[k]) * 100),
      byCat: Object.fromEntries(Object.entries(s.byCat).map(([c, v]) => [c, Math.round(v)])),
      ages: Object.fromEntries(Object.entries(s.ages).map(([c, v]) => [c, Math.round(v)])),
      topCustomers,
    }
  }

  return json(200, {
    asOf: new Date().toISOString(),
    goal: "Each site ≤ one week's production target in held-to-invoice",
    sites: { passaic: shape('sp'), bny: shape('dg') },
    lineCount: lines.length,
    unresolvedTypeLines: unresolvedLines,
    lines,
  })
}
