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

const { schedule } = require('@netlify/functions')

const LIFT_BASE_URL = process.env.LIFT_BASE_URL
const SUPABASE_URL   = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY

// How many recent snapshots to keep (best-effort prune each run so the table
// stays bounded). Raised 12 -> 240 (2026-07-24): at 12 the table held only
// ~3-4 hours, so a dropped order had no recent-good snapshot to fall back to
// and post-hoc diagnosis was impossible. 240 keeps ~3+ days even at the current
// (buggy) 3x/hour cadence. Manual uploads also count toward this.
const KEEP_SNAPSHOTS = 240

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

// Non-print product types the feed drops entirely: they're kitted/attached to
// real print orders but aren't scheduled, and the manual "Production WIP"
// export omits them (verified against Data_for_WIP.xlsx — zero ground rows).
// 'Grounds' = the substrate kitted 1:1 to each hand-screen line (the ~2x
// Passaic inflation); 'Packing Charge' = a fee line. Matches the DAX
// [Type Yards vs Fees]="Ground"/"Fees" exclusion.
const EXCLUDED_PRODUCT_TYPES = new Set(['Grounds', 'Ground', 'Packing Charge'])

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
  // ORDER LEDGER — aggregated per ORDER (GP invoices at order level, and an
  // order can carry several SKU lines). Populated for EVERY line including
  // terminal ones, BEFORE the WIP filter drops them. That is the entire point:
  // an invoiced order vanishes from sched_wip_rows, so if its yardage is not
  // recorded here it is unrecoverable. GP's financial_transactions.reference
  // carries this same order number, so invoice → ledger → yards.
  const ledgerMap = new Map()
  let terminalSkipped = 0, missingColorSku = 0, unknownSite = 0, groundFeeSkipped = 0

  for (const rec of O.records) {
    const poNumber = clean(pick(rec, ['PO_NUMBER', 'PONUMBER']))
    const orderNumber = clean(pick(rec, ['ORDER_NUMBER', 'ORDERNUMBER']))
    if (!poNumber && !orderNumber) continue // not a real line

    const orderStatus = clean(pick(rec, ['ORDER_STATUS', 'STATUS']))
    // Terminal orders must still reach the LEDGER — that is its whole purpose —
    // so hold the flag here and drop them from `rows` further down, AFTER the
    // product-master lookup has let us apply the same ground/fee exclusion.
    const isTerminal = TERMINAL_STATUSES.has(orderStatus)

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
    // LIFT already dates its own invoicing — orders.csv carries INVOICE_DATE,
    // YARDS_INVOICED and INVOICED_REVENUE alongside the order. No GP join, no
    // derivation: invoiced yards for a period = sum(yards_invoiced) where
    // invoice_date falls in it.
    const invoiceDate     = parseDate(pick(rec, ['INVOICE_DATE']))
    const yardsInvoiced   = toNum(pick(rec, ['YARDS_INVOICED']))
    const invoicedRevenue = toNum(pick(rec, ['INVOICED_REVENUE']))
    const printedDate     = parseDate(pick(rec, ['PRINTED_DATE']))
    const qtyPrinted      = toNum(pick(rec, ['QTY_PRINTED']))
    const invoiceStatus   = clean(pick(rec, ['INVOICE_STATUS']))

    // Enrich from the product master (product_type, color, colors) by SKU.
    const pm = prod.get(itemSku) || {}
    const productType = clean(pm.product_type)
    const color = clean(pm.color)
    const colorsCount = pm.number_of_colors ?? null

    // Drop non-scheduled ground/fee lines (kitted grounds inflate hand-screen
    // ~2x; the manual export omits them entirely).
    if (EXCLUDED_PRODUCT_TYPES.has(productType)) { groundFeeSkipped++; continue }
    if (colorsCount == null) missingColorSku++

    // Site routing: order_type (Division) primary, material prefix fallback.
    let site = DIVISION_TO_SITE[divisionRaw] || 'unknown'
    if (site === 'unknown') { const f = inferSiteFromMaterial(material); if (f) site = f }
    // Procurement pass-through is typed SCHUMACHER PROC in the product master and
    // carries no production Division in `orders`, so it otherwise mis-routes to a
    // print site by material prefix. Reclassify to procurement — matches the
    // manual export's Division=Procurement (and its 224-row count exactly).
    if (productType === 'SCHUMACHER PROC') site = 'procurement'
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

    // ORDER LEDGER — written HERE, after the ground/fee exclusion and after the
    // site is known, so it counts the same yards the WIP rows do. Writing it
    // earlier (first attempt) included kitted GROUNDS and packing fees, which
    // roughly doubles Passaic: June read 169,188 invoiced yards against a real
    // ~33,000 on the deck. Terminal orders still land here — they are dropped
    // from `rows` on the next line, not from the ledger.
    //
    // TWO YARD FIGURES, DELIBERATELY: yards_written is TOTAL_YARDS (what the
    // order was written for); qty_invoiced is what LIFT actually invoiced. An
    // order can be partly invoiced, so written always runs above invoiced —
    // using written for "invoiced yards" overstated June Passaic by ~32%.
    // This is the same written / produced / invoiced distinction slide 4 of the
    // month-end deck is built on.
    if (orderNumber) {
      const cur = ledgerMap.get(orderNumber) || {
        order_number: orderNumber, po_number: poNumber || null, site,
        customer_type: customerType3p, product_type: productType || null,
        yards_written: 0, qty_invoiced: 0, income_written: 0,
        yards_invoiced: 0, invoiced_revenue: 0, qty_printed: 0,
        invoice_date: null, printed_date: null, invoice_status: null,
        colors_count: colorsCount, last_status: null,
        // Bucket persisted at the LEDGER level (8/2): an invoiced order leaves
        // sched_wip_rows, and with it its bucket — which made invoiced-by-bucket
        // underivable (160 unknown POs on the wk-7/19 prefill test). Stamping it
        // here means buckets survive an order's death; the hourly ledger pass
        // over the full orders.csv also backfills all history automatically.
        bny_bucket: bnyBucket,
        // True written date (8/2): first_seen is ledger bookkeeping (when the
        // SYNC first saw the order — late July for all history), useless for
        // "written this week." order_created is LIFT's own date.
        order_created: orderCreated ? orderCreated.toISOString().slice(0, 10) : null,
      }
      if (!cur.bny_bucket && bnyBucket) cur.bny_bucket = bnyBucket
      if (!cur.order_created && orderCreated) cur.order_created = orderCreated.toISOString().slice(0, 10)
      cur.yards_written    += yardsWritten
      cur.qty_invoiced     += qtyInvoiced
      cur.income_written   += incomeWritten
      cur.yards_invoiced   += yardsInvoiced
      cur.invoiced_revenue += invoicedRevenue
      cur.qty_printed      += qtyPrinted
      // Dates: keep the LATEST seen across the order's lines.
      const iso = d => d ? d.toISOString().slice(0, 10) : null
      const inv = iso(invoiceDate), prn = iso(printedDate)
      if (inv && (!cur.invoice_date || inv > cur.invoice_date)) cur.invoice_date = inv
      if (prn && (!cur.printed_date || prn > cur.printed_date)) cur.printed_date = prn
      if (invoiceStatus) cur.invoice_status = invoiceStatus
      if (orderStatus) cur.last_status = orderStatus
      if (!cur.po_number && poNumber) cur.po_number = poNumber
      ledgerMap.set(orderNumber, cur)
    }

    if (isTerminal) { terminalSkipped++; continue }

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
  notes.push(`${groundFeeSkipped} ground/fee lines excluded (kitted grounds + fees; not scheduled, matches manual)`)
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

  return { rows, summary, notes, ordersHeaders: seen, productCount: prod.size,
           ledger: Array.from(ledgerMap.values()) }
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

// Upsert on a primary key — PostgREST merge-duplicates. Columns not sent are
// left alone, so `first_seen` survives every later touch.
async function sbUpsert(table, body, onConflict) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Supabase upsert ${table} failed: ${await res.text()}`)
}

// Baseline for the completeness guard: the LARGEST recent snapshot (max over
// the last few), so a single mild dip can't lower the bar and let a truncated
// pull slip through. A rolling max still tracks legitimate hour-to-hour
// invoicing shrink, so this won't freeze the feed under normal operation.
async function getRecentSnapshotBaseline() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sched_snapshots?select=total_rows,passaic_orders,bny_orders&order=uploaded_at.desc&limit=6`,
      { headers: SB_HEADERS })
    if (!res.ok) return null
    const arr = await res.json()
    if (!arr.length) return null
    return {
      total_rows:     Math.max(...arr.map(s => s.total_rows     || 0)),
      passaic_orders: Math.max(...arr.map(s => s.passaic_orders || 0)),
      bny_orders:     Math.max(...arr.map(s => s.bny_orders     || 0)),
    }
  } catch { return null }
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
const runSync = async (event) => {
  try {
    if (!LIFT_BASE_URL) throw new Error('LIFT_BASE_URL not set in env')
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not set')

    let dryRun = false, probe = null, tieout = false, loadYields = null
    if (event && event.httpMethod === 'POST' && event.body) {
      try {
        const b = JSON.parse(event.body)
        dryRun = !!b.dryRun
        probe  = b.probe || null
        tieout = !!b.tieout
        loadYields = b.loadYields || null
      } catch { /* ignore */ }
    }

    // PROBE — fetch ANY LIFT report by name and return its headers plus a few
    // sample rows, writing nothing. LIFT Reporting Services exposes twelve
    // reports on the same base URL (orders, products, shipments, po,
    // shipmentshub, InvoiceAdjustments, invoiceshub, printJobs, InvoiceSummary,
    // CreditSummary, OnHandYards, po_details) and this feed only ever used two.
    // Rather than guess at a schema, look.
    if (probe) {
      const text = await fetchCsv(probe)
      const { headers, records } = parseCsv(text)
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report: probe,
          row_count: records.length,
          headers,
          sample: records.slice(0, 3),
        }, null, 2),
      }
    }

    // TIEOUT — line-level invoiced-yards aggregation, writes NOTHING.
    // invoiceshub is one row per SKU line per invoice (QUANTITY + UOM +
    // INVOICE_APPROVED_DATE), which is the granularity the order_ledger
    // rollup lost — the ledger keeps one latest invoice_date per order, so an
    // order invoiced across two months smears into one. Each line's order
    // joins to order_ledger for site + product_type so grounds can be broken
    // out rather than silently included (the ground-kitting trap: Passaic
    // kits a ground 1:1 with every hand-screen line, which once read June as
    // 169,188 invoiced yards against a real ~33,000). Non-yard UOMs (EA memo
    // sets, panel sets) count separately — they are pieces, not yards.
    // Benchmark: deck slide-4 May 610 invoiced = 31,436 (the hard number).
    // LOAD YIELDS — loader for ref_product_yield. Accepts
    // {"loadYields":[{s,y,t},...]} and upserts via the service role. Exists
    // because hand-pasting 2,741 rows through a SQL console truncated on the
    // first attempt (479 landed; the Memo block — the category that matters
    // most — fell off). Files → curl → upsert: no transcription anywhere.
    if (loadYields && Array.isArray(loadYields)) {
      const body = loadYields
        .filter(r => r && r.s)
        .map(r => ({ item_sku: String(r.s), yield: Number(r.y) || 0, product_type: r.t ? String(r.t) : null }))
      const res = await fetch(`${SUPABASE_URL}/rest/v1/ref_product_yield?on_conflict=item_sku`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                   'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(body),
      })
      return { statusCode: res.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ loaded: body.length, ok: res.ok, status: res.status }) }
    }

    if (tieout) {
      // v4 — THE PROVEN FORMULA, against live data. Validated to ±2% on the
      // stale DAX extract (Jan Digital tied to −20 yards): the deck's
      // invoiced yards = Σ QTY_INVOICED × [Yield] per SKU, yard-class lines
      // only, by 4-4-5 fiscal month on INVOICE_DATE, split by Division.
      // Yield comes from ref_product_yield (consultant-maintained, 2,741
      // non-1 SKUs; absent = 1). Class + Division come from the canonical
      // 37-row product-type table (4-Product Type Tables.csv), embedded
      // verbatim below. Source grain: orders.csv IS line-level — the same
      // file Data Invoiced All derives from. Returns per-DAY division sums
      // for 2026 (fiscal bucketing happens in analysis against the 445
      // calendar). Writes nothing.
      const TYPE_MAP = {
        'DESIGN SERVICES': { cls: 'Design Services', div: 'Design Services' },
        'CONTRACT FABRIC': { cls: 'Yards', div: 'Digital' },
        'CONTRACT WALLPAPER': { cls: 'Yards', div: 'Digital' },
        'CREDIT MEMO': { cls: 'Yards', div: 'Digital' },
        'CUSTOM': { cls: 'Yards', div: 'Digital' },
        'ENGINEERED WINGS': { cls: 'Yards', div: 'Digital' },
        'HANDLING FEE': { cls: 'Fees', div: 'Digital' },
        'HOSPITALITY': { cls: 'Yards', div: 'Digital' },
        'MEMO': { cls: 'Yards', div: 'Digital' },
        'PANEL': { cls: 'Yards', div: 'Digital' },
        'PEEL & STICK': { cls: 'Yards', div: 'Digital' },
        'REGULAR': { cls: 'Yards', div: 'Digital' },
        'RUSH FEE - DIGITAL': { cls: 'Fees', div: 'Digital' },
        'FABRIC': { cls: 'Yards', div: 'Screen Print' },
        'GRASS': { cls: 'Yards', div: 'Screen Print' },
        'GROUNDS': { cls: 'Ground', div: 'Screen Print' },
        'PACKING CHARGE': { cls: 'Fees', div: 'Screen Print' },
        'PAPER': { cls: 'Yards', div: 'Screen Print' },
        'RUSH FEE': { cls: 'Fees', div: 'Screen Print' },
        'SCREEN': { cls: 'Fees', div: 'Screen Print' },
        'SET-UP FEE': { cls: 'Fees', div: 'Screen Print' },
        'SHIPPING FEES': { cls: 'Fees', div: 'Screen Print' },
        'STRIKE-OFF': { cls: 'Yards', div: 'Screen Print' },
        'PRICE SHEET PRICING - FOR PRICING ONLY': { cls: 'Fees', div: 'Screen Print' },
        'VIRTUAL CATALOG FOR ORDER TYPE 1143': { cls: 'Fees', div: 'Screen Print' },
        'RUSH FEE - SCREEN PRINT': { cls: 'Fees', div: 'Screen Print' },
        'DIGITAL': { cls: 'Ground', div: 'Digital' },
        'SCREEN PRINT': { cls: 'Ground', div: 'Screen Print' },
        'CREATIVE SERVICES': { cls: 'Design Services', div: 'Design Services' },
        'ROTARY': { cls: 'Yards', div: 'Screen Print' },
        'SCHUMACHER PROC': { cls: 'Ground', div: 'Procurement' },
        'PANEL SCREEN': { cls: 'Yards', div: 'Screen Print' },
        'MEMO SCREEN': { cls: 'Yards', div: 'Screen Print' },
        'SURCHARGE': { cls: 'Fees', div: 'Screen Print' },
        'ENGINEERED WINGS SCREEN': { cls: 'Yards', div: 'Screen Print' },
        'CUSTOM STRIPE': { cls: 'Yards', div: 'Screen Print' },
      }
      const pick = (o, names) => { for (const n of names) if (o[n] != null && o[n] !== '') return o[n]; return '' }

      const [ordersText2, productsText2] = await Promise.all([fetchCsv('orders'), fetchCsv('products')])
      const skuType = {}
      for (const p of parseCsv(productsText2).records) {
        const sku = pick(p, ['ITEMSKU', 'SKU', 'ITEMNUMBER'])
        const pt = pick(p, ['PRODUCTTYPE', 'PRODUCTTYPES'])
        if (sku) skuType[sku] = String(pt).toUpperCase().trim()
      }
      // yields + product types from ref_product_yield (the FULL master
      // mirror, 12,084 SKUs incl. retired ones the live products feed drops —
      // v4's 232 skipped lines were hand-screen classics on retired SKUs,
      // right in the neighbourhood of the −8.6% Screen Print gap), paged
      const yields = {}, refType = {}
      let yoff = 0
      while (true) {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/ref_product_yield?select=item_sku,yield,product_type&limit=1000&offset=${yoff}`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } })
        const page = await res.json()
        for (const r of page) {
          yields[r.item_sku] = Number(r.yield)
          if (r.product_type) refType[r.item_sku] = String(r.product_type).toUpperCase().trim()
        }
        if (!Array.isArray(page) || page.length < 1000) break
        yoff += 1000
      }
      const days = {}
      let noTypeMap = 0, noSkuType = 0, yieldDefaulted = 0, yardLines = 0
      for (const r of parseCsv(ordersText2).records) {
        const rawD = pick(r, ['INVOICEDATE'])
        if (!rawD) continue
        const dt = new Date(rawD)
        if (isNaN(dt) || dt.getFullYear() !== 2026) continue
        const sku = pick(r, ['ITEMSKU', 'SKU'])
        const pt = skuType[sku] || refType[sku]   // live feed first, master mirror for retired SKUs
        if (!pt) { noSkuType++; continue }
        const m = TYPE_MAP[pt]
        if (!m) { noTypeMap++; continue }
        if (m.cls !== 'Yards') continue
        const qty = parseFloat(pick(r, ['QTYINVOICED'])) || 0
        if (!qty) continue
        let y = yields[sku]
        if (y == null) { y = 1; yieldDefaulted++ }
        yardLines++
        const iso = dt.toISOString().slice(0, 10)
        const k = `${iso}|${m.div}`
        days[k] = (days[k] || 0) + qty * y
      }
      const out = Object.entries(days)
        .map(([k, v]) => { const [d, div] = k.split('|'); return { d, div, yd: Math.round(v * 100) / 100 } })
        .sort((a, b) => a.d.localeCompare(b.d) || a.div.localeCompare(b.div))
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tieout: 'v4 — orders.csv line-level × Yield, the proven DAX formula',
          yard_lines_2026: yardLines,
          lines_missing_sku_type: noSkuType,
          lines_missing_type_map: noTypeMap,
          yield_defaulted_to_1: yieldDefaulted,
          yields_loaded: Object.keys(yields).length,
          per_day: out,
        }, null, 2),
      }
    }

    const asOf = new Date()
    const [ordersText, productsText] = await Promise.all([fetchCsv('orders'), fetchCsv('products')])
    const { rows, summary, notes, ordersHeaders, productCount, ledger } = buildRows(ordersText, productsText, asOf)

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
      ledger_orders: ledger.length,
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

    // ── Completeness guard ────────────────────────────────────────────────
    // The failure that lost live orders (2026-07-24): LIFT returns HTTP 200 but
    // a TRUNCATED body, we build a short snapshot, write it as the new current,
    // and pruneOldSnapshots() then deletes the good history -- blanking the
    // scheduling pool with nothing to recover from. Refuse any pull that's
    // implausibly small, or catastrophically smaller than the recent baseline.
    // Freezing on the last good snapshot is the safe failure mode:
    // stale-but-complete beats fresh-but-truncated.
    const GUARD_FLOOR = 0.70   // reject a >30% single-pull drop; invoicing never does this in one hour
    const baseline = await getRecentSnapshotBaseline()
    let guardTrip = null
    if (rows.length < 200) {
      guardTrip = `only ${rows.length} rows parsed (<200 floor) -- LIFT pull looks truncated`
    } else if (baseline) {
      if (summary.passaic.orders < baseline.passaic_orders * GUARD_FLOOR)
        guardTrip = `passaic ${summary.passaic.orders} < 70% of recent max ${baseline.passaic_orders}`
      else if (summary.bny.orders < baseline.bny_orders * GUARD_FLOOR)
        guardTrip = `bny ${summary.bny.orders} < 70% of recent max ${baseline.bny_orders}`
      else if (rows.length < baseline.total_rows * GUARD_FLOOR)
        guardTrip = `total ${rows.length} < 70% of recent max ${baseline.total_rows}`
    }
    if (guardTrip) {
      console.error('lift-wip-sync GUARD refused partial pull --', guardTrip)
      result.skipped = true
      result.guard_tripped = guardTrip
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

    // ORDER LEDGER — permanent, never pruned. Deliberately written AFTER the
    // guard so a truncated pull can't poison it, and in its own try/catch so a
    // ledger failure can never fail the snapshot the floor depends on. This is
    // the record that makes INVOICED YARDS derivable: an order leaves
    // sched_wip_rows when LIFT invoices it, but its yardage stays here, and
    // GP's financial_transactions.reference joins straight to order_number.
    try {
      const B = 500
      for (let i = 0; i < ledger.length; i += B) {
        await sbUpsert('order_ledger',
          ledger.slice(i, i + B).map(o => ({ ...o, last_seen: new Date().toISOString() })),
          'order_number')
      }
      result.ledger_upserted = ledger.length
    } catch (e) {
      console.error('(note) order_ledger upsert failed — snapshot still written:', e.message)
      result.ledger_error = e.message
    }
    result.snapshot_id = snapshotId
    console.log(`lift-wip-sync: wrote snapshot ${snapshotId} with ${rows.length} rows`)
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) }
  } catch (err) {
    console.error('lift-wip-sync error:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}

// The hourly schedule lives HERE, in code — the netlify.toml route silently
// failed to register on this site (proven 2026-07-07: valid [functions] syntax
// deployed and live, tick never fired). schedule() is the documented, reliable
// path. NOTE: wrapping disables public HTTP invocation — use the companion
// lift-wip-run function for the manual trigger / dryRun diagnostic.
exports.runSync = runSync
exports.handler = schedule('@hourly', runSync)
