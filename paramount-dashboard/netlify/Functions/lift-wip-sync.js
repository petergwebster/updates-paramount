// netlify/Functions/lift-wip-sync.js
// ===========================================================================
// Automated LIFT → sched_wip_rows feed  (replaces the manual WIP upload)
// ---------------------------------------------------------------------------
// Pulls the LIFT `orders` + `products` reports straight from the LIFT ORDS API
// (FSCO-owned, cloud-hosted, open endpoints — no office network, no Triad),
// joins them on ITEM_SKU, derives the same fields liftParser.js produces from
// the manual Excel pivot, and writes ONE sched_snapshots row + the matching
// sched_wip_rows — exactly what a manual "Upload LIFT WIP" produces, just
// automatically. The Scheduler/WIP tabs read the newest snapshot unchanged.
//
// MODES
//   Scheduled run (cron)         → fetch, build, WRITE a new snapshot.
//   POST {}                      → same as scheduled (manual trigger).
//   POST { "dryRun": true }      → fetch + build, RETURN counts + samples,
//                                  WRITE NOTHING. Use this to reconcile against
//                                  a manual upload before trusting the feed.
//
// ENV (set in Netlify — never in code):
//   LIFT_BASE_URL              e.g. https://bny.lifterp.com/ords/lift/erp/flush/ondemand/1162
//   VITE_SUPABASE_URL          the updates-paramount Supabase URL
//   SUPABASE_SERVICE_ROLE_KEY  service role (writes, bypasses RLS)
//
// Boundary note: reads ONLY FSCO's LIFT API + writes ONLY the updates-paramount
// Supabase. It does not touch the Triad Supabase or any personal infra.
// ===========================================================================

const LIFT_BASE_URL = process.env.LIFT_BASE_URL
const SUPABASE_URL   = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY

// How many recent snapshots to keep (best-effort prune each run so the table
// stays bounded under an hourly cadence). Manual uploads are also snapshots and
// count toward this; bump it if you want more history.
const KEEP_SNAPSHOTS = 12

// ─── LIFT fetch (win1252 CSV, per the bridge) ──────────────────────────────
function reportUrl(report) {
  // LIFT builds each report as <BASE>/<report>/<report>.csv?  (trailing
  // filename ignored by ORDS; a full pull needs no query params).
  return `${LIFT_BASE_URL}/${report}/${report}.csv?`
}

async function fetchCsv(report) {
  const res = await fetch(reportUrl(report))
  if (!res.ok) throw new Error(`LIFT ${report} fetch failed: HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  // LIFT exports are Windows-1252 (inch marks / smart quotes).
  return new TextDecoder('windows-1252').decode(buf)
}

// ─── CSV parser tuned for LIFT (mirrors the Triad bridge's QUOTE_NONE) ─────
// LIFT CSVs write inch-marks as bare double-quotes (e.g. 60") and do NOT
// quote/escape fields. Treating " as an RFC quote char corrupts every row that
// contains an inch-mark — it swallows all following columns into one field.
// So we parse with quoting OFF: split purely on commas + newlines, " is a
// literal character. (If a file ever genuinely starts with a quote, fall back
// to RFC-style parsing — same guard the bridge uses.)
function splitRowsRfc(text) {
  const rows = []
  let field = '', record = [], inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { record.push(field); field = '' }
      else if (c === '\n') { record.push(field); rows.push(record); record = []; field = '' }
      else if (c === '\r') { /* handled by \n */ }
      else field += c
    }
  }
  if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record) }
  return rows
}
function parseCsv(text) {
  const quotesAreReal = text.charAt(0) === '"'
  let rows
  if (quotesAreReal) {
    rows = splitRowsRfc(text)
  } else {
    rows = []
    for (const line of text.split(/\r?\n/)) {
      if (/^[\s,]*$/.test(line)) continue      // skip blank / all-comma lines
      rows.push(line.split(','))
    }
  }
  if (rows.length === 0) return { headers: [], headerNorm: [], records: [] }

  const rawHeaders = rows[0].map(h => (h || '').trim())
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const headerNorm = rawHeaders.map(norm)

  const records = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const obj = {}
    for (let c = 0; c < headerNorm.length; c++) obj[headerNorm[c]] = (row[c] ?? '').trim()
    records.push(obj)
  }
  return { headers: rawHeaders, headerNorm, records }
}

// Resolve a field by trying normalized candidate names in order.
function pick(rec, candidates) {
  for (const cand of candidates) {
    const key = String(cand).toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (rec[key] !== undefined && rec[key] !== '') return rec[key]
  }
  return ''
}
function requireHeader(headerNorm, candidates, label, seenHeaders) {
  for (const cand of candidates) {
    const key = String(cand).toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (headerNorm.includes(key)) return true
  }
  throw new Error(
    `LIFT orders report missing a column for "${label}" (looked for ${candidates.join('/')}). ` +
    `Headers seen: ${seenHeaders.join(', ')}`
  )
}

// ─── Helpers ported from liftParser.js ─────────────────────────────────────
const clean = v => {
  if (v == null) return ''
  const s = String(v).trim()
  return s === '(blank)' ? '' : s
}
const toNum = v => {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  const n = parseFloat(String(v).replace(/[,$]/g, '').trim())
  return isNaN(n) ? 0 : n
}
const toIntOrNull = v => {
  if (v == null || v === '' || String(v).trim() === '(blank)') return null
  const n = parseInt(v, 10)
  return isNaN(n) ? null : n
}
function parseDate(val) {
  if (!val) return null
  const s = String(val).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]))
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}
function ageDaysFrom(orderDate, asOf) {
  if (!orderDate) return null
  return Math.max(0, Math.floor((asOf.getTime() - orderDate.getTime()) / 86400000))
}
function ageBucketOf(days) {
  if (days == null) return 'no-date'
  if (days <= 30) return '0-30'
  if (days <= 60) return '31-60'
  if (days <= 90) return '61-90'
  return '90+'
}

const DIVISION_TO_SITE = { 'Screen Print': 'passaic', 'Digital': 'bny', 'Procurement': 'procurement' }
function inferSiteFromMaterial(material) {
  const m = String(material || '').trim().toUpperCase()
  if (!m || m === '(BLANK)') return null
  if (m.startsWith('BNY')) return 'bny'
  if (m.startsWith('PAR')) return 'passaic'
  return null
}

// BNY bucket derivation — verbatim rules from liftParser.deriveBnyBucket.
const BNY_EXCLUDED_CATEGORIES = new Set(['Strike-off', 'SCHUMACHER PROC', 'Cancellation Fee'])
function deriveBnyBucket({ site, customer_type, category_customer_mto, customer_name_clean }) {
  if (site !== 'bny') return null
  const category = category_customer_mto || ''
  const customer = customer_name_clean || ''
  const is3P = (customer_type || '').toLowerCase().includes('3rd')
  if (BNY_EXCLUDED_CATEGORIES.has(category)) return null
  if (is3P) return '3P'
  if (category === 'MTO') return customer.toUpperCase().includes('CUSTOM MTO') ? 'Custom' : 'MTO'
  if (category === 'Memo') return 'Memo'
  if (category === 'Hospitality') return 'HOS'
  if (category === 'Panel' || category === 'Engineered Wings') return 'Replen'
  if (customer === 'F. SCHUMACHER & CO - NEW GOODS') return 'NEW GOODS'
  return 'Replen'
}

// Terminal statuses — a row in one of these is "done", not WIP. Mirrors the
// scheduler pool blacklist so the snapshot's scope == the schedulable universe.
const TERMINAL_STATUSES = new Set([
  'Shipped', 'Invoiced', 'Cancelled', 'Canceled', 'Cancellation Fee',
  'Closed', 'Complete', 'Completed',
])

// ─── Build sched_wip_rows-shaped objects from orders ⨝ products ────────────
function buildRows(ordersText, productsText, asOf) {
  const notes = []

  const P = parseCsv(productsText)
  // Product master: ITEM_SKU → { product_type, color, number_of_colors }
  const prod = new Map()
  for (const rec of P.records) {
    const sku = pick(rec, ['ITEM_SKU'])
    if (!sku) continue
    prod.set(sku, {
      product_type: pick(rec, ['PRODUCT_TYPE']),
      color: pick(rec, ['COLOR']),
      number_of_colors: toIntOrNull(pick(rec, ['NUMBER_OF_COLORS'])),
    })
  }

  const O = parseCsv(ordersText)
  const seen = O.headers
  // Fail loud if the orders report doesn't carry what we need.
  requireHeader(O.headerNorm, ['PO_NUMBER', 'PONUMBER'], 'po_number', seen)
  requireHeader(O.headerNorm, ['ORDER_STATUS', 'STATUS'], 'order_status', seen)
  requireHeader(O.headerNorm, ['ORDER_TYPE', 'DIVISION'], 'order_type/division', seen)
  requireHeader(O.headerNorm, ['ITEM_SKU'], 'item_sku', seen)

  const rows = []
  let terminalSkipped = 0, missingColorSku = 0, unknownSite = 0

  for (const rec of O.records) {
    const poNumber = clean(pick(rec, ['PO_NUMBER', 'PONUMBER']))
    const orderNumber = clean(pick(rec, ['ORDER_NUMBER', 'ORDERNUMBER']))
    if (!poNumber && !orderNumber) continue // not a real line

    const orderStatus = clean(pick(rec, ['ORDER_STATUS', 'STATUS']))
    if (TERMINAL_STATUSES.has(orderStatus)) { terminalSkipped++; continue }

    const divisionRaw = clean(pick(rec, ['ORDER_TYPE', 'DIVISION']))
    const itemSku = clean(pick(rec, ['ITEM_SKU']))
    const customerName = clean(pick(rec, ['CUSTOMER_NAME', 'CUSTOMERNAME']))
    const categoryCustomerMto = clean(pick(rec, ['CUSTOMER_TYPE', 'CATEGORY_CUSTOMER_MTO', 'CATEGORY']))
    const material = clean(pick(rec, ['MATERIAL']))
    const lineDescription = clean(pick(rec, ['LINE_DESCRIPTION', 'LINEDESCRIPTION']))
    const orderCreated = parseDate(pick(rec, ['ORDER_CREATED_DATE', 'ORDER_CREATED', 'CREATED_DATE', 'MIN_OF_ORDER_CREATED_DATE']))
    const yardsWritten = toNum(pick(rec, ['TOTAL_YARDS', 'YARDS_WRITTEN', 'YARDS']))
    const qtyInvoiced = toNum(pick(rec, ['QTY_INVOICED', 'SUM_OF_QTY_INVOICED']))
    const incomeWritten = toNum(pick(rec, ['ORDERED_SALES', 'INCOME_WRITTEN']))

    // Enrich from the product master (product_type, color, colors) by SKU.
    const pm = prod.get(itemSku) || {}
    const productType = clean(pm.product_type)
    const color = clean(pm.color)
    const colorsCount = pm.number_of_colors ?? null
    if (colorsCount == null) missingColorSku++

    // Site routing: order_type (Division) primary, material prefix fallback.
    let site = DIVISION_TO_SITE[divisionRaw] || 'unknown'
    if (site === 'unknown') { const f = inferSiteFromMaterial(material); if (f) site = f }
    if (site === 'unknown') unknownSite++

    // 3rd-Party-vs-House: not a column in `orders`; derive from customer name.
    // Any "F. SCHUMACHER" entity is House; everything else is 3rd Party.
    const customerType3p = /schumacher/i.test(customerName) ? 'Schumacher' : '3rd Party'

    // is_new_goods: no flag column in `orders`. Proxy off the NEW GOODS
    // customer. (If the team needs broader New-Goods detection, we need the
    // source field — flagged in parse_notes.)
    const isNewGoods = /NEW GOODS/i.test(customerName)

    const colorYards = (site === 'passaic' && colorsCount != null && yardsWritten > 0)
      ? colorsCount * yardsWritten : null

    const ageDays = ageDaysFrom(orderCreated, asOf)
    const bnyBucket = deriveBnyBucket({
      site, customer_type: customerType3p,
      category_customer_mto: categoryCustomerMto, customer_name_clean: customerName,
    })

    rows.push({
      site,
      division_raw: divisionRaw,
      customer_type: customerType3p,
      category_customer_mto: categoryCustomerMto,
      customer_name_clean: customerName,
      bny_bucket: bnyBucket,
      product_type: productType,
      is_new_goods: isNewGoods,
      order_number: orderNumber,
      po_number: poNumber,
      line_description: lineDescription,
      item_sku: itemSku,
      color,
      material,
      order_status: orderStatus,
      colors_count: colorsCount,
      color_yards: colorYards,
      order_created: orderCreated ? orderCreated.toISOString().slice(0, 10) : null,
      yards_written: yardsWritten,
      qty_invoiced: qtyInvoiced,
      income_written: incomeWritten,
      age_days: ageDays,
      age_bucket: ageBucketOf(ageDays),
    })
  }

  if (missingColorSku > 0) notes.push(`${missingColorSku} rows had no NUMBER_OF_COLORS from the product master (color-yards left null; not zeroed)`)
  if (unknownSite > 0) notes.push(`${unknownSite} rows had no recognizable site (Division/material)`)
  notes.push(`${terminalSkipped} terminal/done rows excluded (WIP scope)`)
  notes.push('auto feed: LIFT orders⨝products; is_new_goods & 3rd-party-vs-house are derived (see function header)')

  // Summary mirrors liftParser.summary (used for the sched_snapshots row).
  const summary = {
    passaic: { orders: 0, yards: 0, revenue: 0 },
    bny: { orders: 0, yards: 0, revenue: 0 },
    procurement: { orders: 0, revenue: 0 },
    unknown: { orders: 0 },
  }
  for (const r of rows) {
    const s = summary[r.site]
    if (!s) continue
    s.orders += 1
    if ('yards' in s) s.yards += r.yards_written
    if ('revenue' in s) s.revenue += r.income_written
  }

  return { rows, summary, notes, ordersHeaders: seen, productCount: prod.size }
}

// ─── Supabase REST helpers (raw fetch, same as lock-wip) ───────────────────
const SB_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
}
async function sbInsert(table, body, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': opts.returnRepresentation ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Supabase insert ${table} failed: ${await res.text()}`)
  return opts.returnRepresentation ? res.json() : null
}

async function pruneOldSnapshots() {
  // Best-effort: keep the newest KEEP_SNAPSHOTS; never fatal.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sched_snapshots?select=id&order=uploaded_at.desc`,
      { headers: SB_HEADERS })
    if (!res.ok) return
    const all = await res.json()
    const old = all.slice(KEEP_SNAPSHOTS).map(r => r.id)
    if (old.length === 0) return
    const inList = `(${old.join(',')})`
    await fetch(`${SUPABASE_URL}/rest/v1/sched_wip_rows?snapshot_id=in.${inList}`, { method: 'DELETE', headers: SB_HEADERS })
    await fetch(`${SUPABASE_URL}/rest/v1/sched_snapshots?id=in.${inList}`, { method: 'DELETE', headers: SB_HEADERS })
    console.log(`pruned ${old.length} old snapshot(s)`)
  } catch (e) {
    console.log('(note) prune skipped:', e.message)
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    if (!LIFT_BASE_URL) throw new Error('LIFT_BASE_URL not set in env')
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not set')

    let dryRun = false
    if (event && event.httpMethod === 'POST' && event.body) {
      try { dryRun = !!JSON.parse(event.body).dryRun } catch { /* ignore */ }
    }

    const asOf = new Date()
    const [ordersText, productsText] = await Promise.all([fetchCsv('orders'), fetchCsv('products')])
    const { rows, summary, notes, ordersHeaders, productCount } = buildRows(ordersText, productsText, asOf)

    const result = {
      dryRun,
      total_rows: rows.length,
      product_master_skus: productCount,
      by_site: {
        passaic: summary.passaic.orders,
        bny: summary.bny.orders,
        procurement: summary.procurement.orders,
        unknown: summary.unknown.orders,
      },
      passaic_yards: Math.round(summary.passaic.yards),
      bny_yards: Math.round(summary.bny.yards),
      notes,
    }

    if (dryRun) {
      // Distinct-PO counts + per-site status breakdown so we can tell whether a
      // row-count gap vs a manual upload is grain (line-level) or scope.
      const posBySite = {}, statusBySite = {}, ageBySite = {}, ptypeBySite = {}
      const ageB = d => d == null ? 'no-date' : d <= 30 ? '0-30' : d <= 90 ? '31-90' : d <= 180 ? '91-180' : d <= 365 ? '181-365' : '365+'
      for (const r of rows) {
        (posBySite[r.site] = posBySite[r.site] || new Set()).add(r.po_number || r.order_number)
        const sb = statusBySite[r.site] = statusBySite[r.site] || {}
        sb[r.order_status || '(blank)'] = (sb[r.order_status || '(blank)'] || 0) + 1
        const ab = ageBySite[r.site] = ageBySite[r.site] || {}
        const k = ageB(r.age_days)
        ab[k] = (ab[k] || 0) + 1
        const pb = ptypeBySite[r.site] = ptypeBySite[r.site] || {}
        pb[r.product_type || '(none)'] = (pb[r.product_type || '(none)'] || 0) + 1
      }
      result.distinct_pos = Object.fromEntries(Object.entries(posBySite).map(([k, v]) => [k, v.size]))
      result.status_passaic = statusBySite.passaic || {}
      result.status_bny = statusBySite.bny || {}
      result.age_passaic = ageBySite.passaic || {}
      result.age_bny = ageBySite.bny || {}
      result.ptype_passaic = ptypeBySite.passaic || {}
      result.ptype_bny = ptypeBySite.bny || {}
      const sample = site => rows.filter(r => r.site === site).slice(0, 3)
      result.samples = { passaic: sample('passaic'), bny: sample('bny') }
      result.orders_headers = ordersHeaders
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) }
    }

    // WRITE: one snapshot row, then batched wip rows (matches WIPTab exactly).
    const snapArr = await sbInsert('sched_snapshots', {
      uploaded_by: null,
      source_filename: 'LIFT API (auto feed)',
      passaic_orders: summary.passaic.orders,
      passaic_yards: summary.passaic.yards,
      passaic_revenue: summary.passaic.revenue,
      bny_orders: summary.bny.orders,
      bny_yards: summary.bny.yards,
      bny_revenue: summary.bny.revenue,
      procurement_orders: summary.procurement.orders,
      procurement_revenue: summary.procurement.revenue,
      total_rows: rows.length,
      unclassified_rows: summary.unknown.orders,
      parse_notes: notes.join(' | '),
    }, { returnRepresentation: true })

    const snapshotId = snapArr[0].id
    const batchSize = 500
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize).map(r => ({ snapshot_id: snapshotId, ...r }))
      await sbInsert('sched_wip_rows', chunk)
    }

    await pruneOldSnapshots()
    result.snapshot_id = snapshotId
    console.log(`lift-wip-sync: wrote snapshot ${snapshotId} with ${rows.length} rows`)
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) }
  } catch (err) {
    console.error('lift-wip-sync error:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
