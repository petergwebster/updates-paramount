// netlify/functions/weekly-lift-summary.js
// ===========================================================================
// Weekly Production Data — on-demand LIFT summary  (Brynn/Peter 8/9)
// ---------------------------------------------------------------------------
// WHY: the weekly production report's official numbers come from Data Lift
// 4.0.xlsx — a Power Pivot model whose data connection is the LIFT `orders`
// export sliced by per-line dates on the 4-4-5 calendar. Live Ops floor
// entries aren't reliable enough yet to be the official source (Brynn 8/9),
// and the old scan-then-apply prefill flow was awkward. This function pulls
// the SAME export her model refreshes from and aggregates one fiscal week
// with HER model's own mapping tables (extracted verbatim from Data Lift 4.0
// sheets '3 Customer Tables' and '4 Product Type Tables') — so the number the
// form pre-fills IS the number her pivots would show.
//
// DELIBERATELY NOT SCHEDULED. A human presses "Load week from LIFT", reviews,
// edits, saves. Derive by default, correct by exception, human owns the save.
//
// MODES
//   POST { "week_start": "YYYY-MM-DD" }             → aggregate that week (Sun-anchored, 7 days)
//   POST { "week_start": "...", "days": 28 }        → wider window (month tie-outs)
//   POST { "probe": true }                          → counts + unmapped product types/customers
//
// ENV: LIFT_BASE_URL (same as lift-wip-sync). Reads LIFT only; writes nothing.
// ===========================================================================

const LIFT_BASE_URL = process.env.LIFT_BASE_URL
const SUPABASE_URL  = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

// Completeness guard — a full orders export runs ~16k+ lines. A truncated
// pull must never quietly produce a half-week (stale-but-complete doctrine).
const MIN_ORDER_LINES = 5000

// ─── LIFT fetch + parse (mirrors lift-wip-sync; win1252, quoting OFF) ──────
function reportUrl(report) { return `${LIFT_BASE_URL}/${report}/${report}.csv?` }
async function fetchCsv(report) {
  const res = await fetch(reportUrl(report))
  if (!res.ok) throw new Error(`LIFT ${report} fetch failed: HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  return new TextDecoder('windows-1252').decode(buf)
}
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
      else if (c === '\r') { /* \n handles */ }
      else field += c
    }
  }
  if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record) }
  return rows
}
function parseCsv(text) {
  const quotesAreReal = text.charAt(0) === '"'
  let rows
  if (quotesAreReal) rows = splitRowsRfc(text)
  else {
    rows = []
    for (const line of text.split(/\r?\n/)) {
      if (/^[\s,]*$/.test(line)) continue
      rows.push(line.split(','))
    }
  }
  if (rows.length === 0) return { records: [] }
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const headerNorm = rows[0].map(norm)
  const records = []
  for (let r = 1; r < rows.length; r++) {
    const obj = {}
    for (let c = 0; c < headerNorm.length; c++) obj[headerNorm[c]] = (rows[r][c] ?? '').trim()
    records.push(obj)
  }
  return { records }
}
const num = v => {
  const x = parseFloat(String(v ?? '').replace(/[$,]/g, ''))
  return Number.isFinite(x) ? x : 0
}
const normKey = s => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim()

// ─── MAPPINGS — extracted verbatim from Data Lift 4.0 (8/9/2026) ───────────
// '4 Product Type Tables': PRODUCT TYPE → Division + grouped category +
// Yards-vs-Fees. cat: fabric/grass/paper (NJ) · 'yards' (digital yardage) ·
// 'other' (counts in totals, no category) · null kind means skip entirely.
const PRODUCT_MAP = {
  // Screen Print — yards
  'FABRIC':                  { div: 'sp', kind: 'yards', cat: 'fabric' },
  'ROTARY':                  { div: 'sp', kind: 'yards', cat: 'fabric' },
  'GRASS':                   { div: 'sp', kind: 'yards', cat: 'grass' },
  'PAPER':                   { div: 'sp', kind: 'yards', cat: 'paper' },
  'PANEL SCREEN':            { div: 'sp', kind: 'yards', cat: 'paper' },
  'MEMO SCREEN':             { div: 'sp', kind: 'yards', cat: 'paper' },
  'ENGINEERED WINGS SCREEN': { div: 'sp', kind: 'yards', cat: 'paper' },
  'CUSTOM STRIPE':           { div: 'sp', kind: 'yards', cat: 'paper' },
  'STRIKE-OFF':              { div: 'sp', kind: 'yards', cat: 'other' },
  // Screen Print — grounds & fees (excluded from yard math, per the model)
  'GROUNDS':                 { div: 'sp', kind: 'ground' },
  'SCREEN PRINT':            { div: 'sp', kind: 'ground' },
  'PACKING CHARGE':          { div: 'sp', kind: 'fee' },
  'RUSH FEE':                { div: 'sp', kind: 'fee' },
  'RUSH FEE - SCREEN PRINT': { div: 'sp', kind: 'fee' },
  'SCREEN':                  { div: 'sp', kind: 'fee' },
  'SET-UP FEE':              { div: 'sp', kind: 'fee' },
  'SHIPPING FEES':           { div: 'sp', kind: 'fee' },
  'SURCHARGE':               { div: 'sp', kind: 'fee' },
  'PRICE SHEET PRICING - FOR PRICING ONLY': { div: 'sp', kind: 'fee' },
  'VIRTUAL CATALOG FOR ORDER TYPE 1143':    { div: 'sp', kind: 'fee' },
  // Digital — yards
  'CONTRACT FABRIC':         { div: 'dg', kind: 'yards' },
  'CONTRACT WALLPAPER':      { div: 'dg', kind: 'yards' },
  'CREDIT MEMO':             { div: 'dg', kind: 'yards' },
  'CUSTOM':                  { div: 'dg', kind: 'yards' },
  'ENGINEERED WINGS':        { div: 'dg', kind: 'yards' },
  'HOSPITALITY':             { div: 'dg', kind: 'yards' },
  'MEMO':                    { div: 'dg', kind: 'yards' },
  'PANEL':                   { div: 'dg', kind: 'yards' },
  'PEEL & STICK':            { div: 'dg', kind: 'yards' },
  'REGULAR':                 { div: 'dg', kind: 'yards' },
  // Digital — grounds & fees
  'DIGITAL':                 { div: 'dg', kind: 'ground' },
  'HANDLING FEE':            { div: 'dg', kind: 'fee' },
  'RUSH FEE - DIGITAL':      { div: 'dg', kind: 'fee' },
  // Out of scope for weekly production yards
  'DESIGN SERVICES':         { div: 'ds', kind: 'skip' },
  'CREATIVE SERVICES':       { div: 'ds', kind: 'skip' },
  'SCHUMACHER PROC':         { div: 'proc', kind: 'skip' },
}

// '3 Customer Tables': CUSTOMER NAME → BNY group + Schumacher/3P.
// Form buckets: HUB→replen · MTO→mto · Hospitality→hos · Memos→memo ·
// everything else (Contract + all named 3P groups + Backdrop + P&W)→contract.
const SCH = 'SCH', TP = '3P'
const CUSTOMER_MAP = {}
function addCust(names, bucket, house) { for (const n of names) CUSTOMER_MAP[normKey(n)] = { bucket, house } }
addCust(['F. SCHUMACHER & CO - HUB', 'F. SCHUMACHER & CO - MERCH', 'F. SCHUMACHER & CO - STUDIO', 'DROZMARIN@FSCO.COM',
  'F. SCHUMACHER & CO.', 'F. SCHUMACHER & CO - NEW GOODS', 'F. SCHUMACHER & CO., PATTERSON FLYNN',
  'F. SCHUMACHER & CO - PATTERSON FLYNN', 'F. SCHUMACHER & CO., PROCUREMENT', 'F. SCHUMACHER & CO., SUPPLY CHAIN',
  'F. SCHUMACHER & CO.  PATTERSON FLYNN', 'F. SCHUMACHER TEST COMPANY', 'SCHUMACHER'], 'replen', SCH)
addCust(['F. SCHUMACHER & CO - MTO', 'F. SCHUMACHER & CO., ATTN: HUDSON MOORE', 'F. SCHUMACHER & CO., MTO',
  'F. SCHUMACHER MTO,', 'F. SCHUMACHER & CO.  CUSTOM MTO', 'F. SCHUMACHER & CO. CUSTOM MTO'], 'mto', SCH)
addCust(['F. SCHUMACHER & CO - HOSPITALITY', 'F. SCHUMACHER & CO., HOSPITALITY', 'F. SCHUMACHER & CO., HOSPITALITY, KATIE IX',
  'F. SCHUMACHER & CO., HOSPITALITY, MEGHAN SUDNIKOVICH'], 'hos', SCH)
addCust(['F. SCHUMACHER & CO - MEMOS', 'F. SCHUMACHER & CO., MEMOS'], 'memo', SCH)
addCust(['BACKDROP', 'F. SCHUMACHER & CO.  PARAMOUNT HANDPRINTS', 'F. SCHUMACHER & CO. PARAMOUNT HANDPRINTS',
  'TILLETT TEXTILES', 'F. SCHUMACHER & CO - P&W'], 'contract', SCH)
addCust(['CARLETON V LTD.', 'SERENA & LILY', 'E.W. BREDEMEIER & CO.', 'THE AIRTEX GROUP', 'LEE INDUSTRIES',
  'SERENA & LILY, SERENA & LILY DISTRIBUTION CENTER', 'CHINA SEAS', 'COWTAN AND TOUT', 'KRAVET', 'QUADRILLE INC.',
  'UNIVERSAL CONVERTERS & IMPORTERS', 'CLK COLLECTIVE', 'GREIGE TEXTILES', 'MAISON C.', 'MALLY SKOK DESIGN',
  'MCLAURIN & PIERCY', 'MEG BRAFF DESIGNS', 'GIVEN CAMPBELL', 'STUDIO FOUR NYC', 'WALTER KNABE STUDIOS INC.',
  '20TH CENTURY FOX FILM CORP', '3FORM', 'AMY KARYN INC.', 'BRIGHTON CONCEPTS LTD', 'CARLETONV',
  'CHINA SEAS "SCREENS" ACCOUNT', 'CLAIRE BURBRIDGE DESIGN', 'ELLISHA ALEXINA TEXTILES', 'EMILY DICKINSON MUSEUM',
  'FAYCE TEXTILES', 'KLSHAND LLC', 'KRAVET INC.', 'LOUISE VOYAZIS COLLECTION', 'MASON & WOLF',
  'MEG BRAFF DESIGNS, LLC', 'MUGSY & LULU LLC DBA VICTORIA LARSON', 'PATTERNSEED DESIGN STUDIO LLC',
  'PETER FASANO LTD, LLC', 'QUADRILLE "SCREENS" ACCOUNT', 'STUDIO BON TEXTILES', 'TWENTY2  LLC',
  'UMA STEWART INTERIORS & LIFESTYLE', 'UPHOLD ENTERTAINMENT INVORPORATED', 'VAAHTERA', 'WALLSHOPPE',
  'WALTER G TEXTILES', 'WALTER KNABE STUDIOS', 'ZAK + FOX', 'AMY KARYN', 'MASON & WOLF WALLPAPER',
  'HEIDI CAILLIER DESIGN', 'THE CLI GROUP', 'SISTER PARISH DESIGN', 'BOB COLLINS & SONS INC.', 'DRUSUS TABOR',
  'FERRICK MASON', 'KLS TEXTILES LTD', 'DYE INTO PRINT'], 'contract', TP)

function customerOf(name, warnSet) {
  const hit = CUSTOMER_MAP[normKey(name)]
  if (hit) return hit
  // Unmapped: infer house from the name, bucket to contract, and surface it.
  const sch = /SCHUMACHER|FSCO/i.test(String(name || ''))
  if (name) warnSet.add(String(name))
  return { bucket: 'contract', house: sch ? SCH : TP }
}

// Machine name → form machine id (AdminPanel grids).
const MACHINE_MAP = {}
for (const [id, label] of [['glow', 'GLOW'], ['sasha', 'SASHA'], ['trish', 'TRISH'], ['bianca', 'BIANCA'],
  ['lash', 'LASH'], ['chyna', 'CHYNA'], ['rhonda', 'RHONDA'], ['dakota_ka', 'DAKOTA KA'], ['dementia', 'DEMENTIA'],
  ['ember', 'EMBER'], ['ivy_nile', 'IVY NILE'], ['jacy_jayne', 'JACY JAYNE'], ['ruby', 'RUBY'],
  ['valhalla', 'VALHALLA'], ['xia', 'XIA'], ['apollo', 'APOLLO'], ['nemesis', 'NEMESIS'],
  ['poseidon', 'POSEIDON'], ['zoey', 'ZOEY']]) MACHINE_MAP[label] = id

// ── Yield map — the consultant's per-SKU conversion (dax_measures_reference.md:
// "CANONICAL — DO NOT RE-DERIVE"). Every yard in Data Lift 4.0 is qty × [Yield]
// per line; Panel ≈8.6, Memo ≈0.08, most Screen Print = 1.0. Lives in
// ref_product_yield (loaded from 2-PRODUCT MASTER.csv). Missing SKU → 1, flagged.
async function fetchYieldMap() {
  const map = new Map()
  if (!SUPABASE_URL || !SUPABASE_KEY) return map
  let off = 0
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ref_product_yield?select=item_sku,yield,product_type&limit=5000&offset=${off}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    if (!res.ok) throw new Error(`ref_product_yield fetch failed: HTTP ${res.status}`)
    const rows = await res.json()
    for (const r of rows) if (r.item_sku) map.set(String(r.item_sku), { yield: Number(r.yield) || 1, type: r.product_type || '' })
    if (rows.length < 5000) break
    off += 5000
  }
  return map
}

// ─── Per-line date helpers ──────────────────────────────────────
// Yard math lives inline in the loop: qty × [Yield] per line, verbatim from
// the DAX — Produced = QTY_PRINTED×Yield (CORRECT_AMOUNT wins), Gross
// Invoiced = QTY_INVOICED×Yield, Written ≈ QTY_ORDERED×Yield.
const inWin = (d, from, to) => d && d >= from && d < to     // ISO string compare
const dateOf = v => String(v || '').slice(0, 10)

exports.handler = async (event) => {
  const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' })
  if (!LIFT_BASE_URL) return json(500, { error: 'LIFT_BASE_URL not configured' })

  let payload = {}
  try { payload = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'bad JSON' }) }

  let orders, products, yieldMap, adjustments
  try {
    // PRODUCT_TYPE is NOT on the orders export — it lives on the products
    // report, joined on ITEM_SKU (exactly what lift-wip-sync and the Data
    // Lift 4.0 model both do). products also carries NUMBER_OF_COLORS.
    // Yield comes from ref_product_yield — the consultant's master.
    // InvoiceAdjustments = the credits feed: DAX "Net" = Gross + Credited.
    const [oTxt, pTxt, yMap, aTxt] = await Promise.all([
      fetchCsv('orders'), fetchCsv('products'), fetchYieldMap(),
      fetchCsv('InvoiceAdjustments').catch(() => null),
    ])
    orders = parseCsv(oTxt).records
    products = parseCsv(pTxt).records
    yieldMap = yMap
    adjustments = aTxt ? parseCsv(aTxt).records : null
  } catch (e) { return json(502, { error: `pull failed: ${e.message}` }) }
  if (orders.length < MIN_ORDER_LINES) {
    return json(502, { error: `completeness guard: only ${orders.length} order lines (< ${MIN_ORDER_LINES}) — refusing to summarize a truncated pull` })
  }
  const skuInfo = new Map()
  for (const p of products) {
    if (p.ITEMSKU) skuInfo.set(p.ITEMSKU, { type: p.PRODUCTTYPE || '', colors: num(p.NUMBEROFCOLORS) })
  }

  if (payload.probe) {
    const types = {}, unmappedCust = new Set()
    let noSku = 0
    for (const r of orders) {
      const t = normKey(skuInfo.get(r.ITEMSKU)?.type || r.PRODUCTTYPE)
      if (!t) noSku++
      types[t || '(none)'] = (types[t || '(none)'] || 0) + 1
      if (!CUSTOMER_MAP[normKey(r.CUSTOMERNAME)]) unmappedCust.add(r.CUSTOMERNAME)
    }
    const unknownTypes = Object.keys(types).filter(t => t !== '(none)' && !PRODUCT_MAP[t])
    return json(200, { lines: orders.length, productRows: products.length, linesWithoutSkuType: noSku, productTypes: types, unknownTypes, unmappedCustomers: [...unmappedCust].slice(0, 40) })
  }

  const weekStart = String(payload.week_start || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return json(400, { error: 'week_start required (YYYY-MM-DD, a Sunday)' })
  const days = Math.min(Math.max(Number(payload.days) || 7, 1), 35)
  const from = weekStart
  const to = new Date(Date.parse(weekStart + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)

  const unmappedCust = new Set(), unknownTypes = new Set(), unknownMachines = new Set()
  let correctionsApplied = 0, designSkipped = 0, noTypeLines = 0, colorlessProduced = 0, noYieldLines = 0, heldYds = 0, heldLines = 0

  const zeroCat = () => ({ produced: 0, colorYards: 0, waste: 0, invoiceYds: 0, invoiceRev: 0 })
  const nj = {
    fabric: zeroCat(), grass: zeroCat(), paper: zeroCat(), other: zeroCat(),
    schWritten: 0, schProduced: 0, schInvoiced: 0, tpWritten: 0, tpProduced: 0, tpInvoiced: 0,
  }
  const bny = {
    replen: 0, mto: 0, hos: 0, memo: 0, contract: 0,
    invYdsReplen: 0, invYdsMto: 0, invYdsHos: 0, invYdsMemo: 0, invYdsContract: 0,
    incomeReplen: 0, incomeMto: 0, incomeHos: 0, incomeMemo: 0, incomeContract: 0,
    schWritten: 0, schProduced: 0, schInvoiced: 0, tpWritten: 0, tpProduced: 0, tpInvoiced: 0,
  }
  const bucketKey = b => b.charAt(0).toUpperCase() + b.slice(1)
  let prodLines = 0, invLines = 0

  for (const r of orders) {
    const info = skuInfo.get(r.ITEMSKU)
    const ref = yieldMap.get(String(r.ITEMSKU))
    // Type: live products report first, then the consultant's master
    // (ref_product_yield carries product_type for RETIRED SKUs the live
    // report has dropped — recovered 2/9 tie-out, was ~1,700 skipped lines).
    const typeRaw = info?.type || ref?.type || r.PRODUCTTYPE || ''
    if (!typeRaw) { noTypeLines++; continue }
    const pm = PRODUCT_MAP[normKey(typeRaw)]
    if (!pm) { unknownTypes.add(typeRaw); continue }
    if (pm.kind === 'skip') { designSkipped++; continue }
    if (pm.kind === 'ground' || pm.kind === 'fee') continue   // model excludes from yard math

    const cust = customerOf(r.CUSTOMERNAME, unmappedCust)
    const created = dateOf(r.ORDERCREATEDDATE)
    const printed = dateOf(r.PRINTEDDATE)
    const invoiced = dateOf(r.INVOICEDATE)
    if (num(r.CORRECTAMOUNTPRINTED)) correctionsApplied++

    // The consultant's transform: every yard = qty × per-SKU Yield.
    // DAX-VERBATIM: Yards Produced uses raw QTY_PRINTED. CORRECT_AMOUNT_PRINTED
    // exists on the export but her measure does NOT apply it — overriding with
    // it read consistently LOW vs her pivot (8/9 tie-out). Count it, don't use it.
    let yieldF = ref?.yield
    if (yieldF == null) { yieldF = 1; noYieldLines++ }
    const writtenY  = num(r.QTYORDERED) * yieldF
    const producedQ = num(r.QTYPRINTED)
    const producedY = producedQ * yieldF
    const invoicedY = num(r.QTYINVOICED) * yieldF
    const wasteY    = Math.max(0, (producedQ - num(r.QTYINVOICED)) * yieldF)

    if (pm.div === 'sp') {
      if (inWin(created, from, to)) nj[cust.house === SCH ? 'schWritten' : 'tpWritten'] += writtenY
      if (inWin(printed, from, to)) {
        // MODEL RULE (proven 2/9 tie-out on her own rows): "Yards Produced"
        // counts printed lines whose ORDER has reached Invoiced/Shipped —
        // printed-but-held (In Packing / In Production etc.) is excluded until
        // it invoices, exactly the deck's Held-to-Invoice machinery. In closed
        // months this equals the Approved-invoice reading; in recent months
        // invoiced-pending-approval lines COUNT (her flag is order-based).
        const done = ['invoiced', 'shipped'].includes((r.ORDERSTATUS || '').toLowerCase())
        if (done) {
          nj[pm.cat].produced += producedY
          const colors = info?.colors || 0
          if (colors > 0) nj[pm.cat].colorYards += producedY * colors
          else colorlessProduced += producedY
          nj[cust.house === SCH ? 'schProduced' : 'tpProduced'] += producedY
          prodLines++
        } else {
          heldYds += producedY; heldLines++
        }
      }
      if (inWin(invoiced, from, to)) {
        nj[pm.cat].invoiceYds += invoicedY
        nj[pm.cat].invoiceRev += num(r.INVOICEDREVENUE)
        nj[pm.cat].waste += wasteY
        nj[cust.house === SCH ? 'schInvoiced' : 'tpInvoiced'] += invoicedY
        invLines++
      }
    } else if (pm.div === 'dg') {
      if (inWin(created, from, to)) bny[cust.house === SCH ? 'schWritten' : 'tpWritten'] += writtenY
      if (inWin(printed, from, to)) {
        const done = ['invoiced', 'shipped'].includes((r.ORDERSTATUS || '').toLowerCase())
        if (done) {
          bny[cust.bucket] += producedY
          bny[cust.house === SCH ? 'schProduced' : 'tpProduced'] += producedY
          prodLines++
        } else {
          heldYds += producedY; heldLines++
        }
      }
      if (inWin(invoiced, from, to)) {
        bny['invYds' + bucketKey(cust.bucket)] += invoicedY
        bny['income' + bucketKey(cust.bucket)] += num(r.INVOICEDREVENUE)
        bny[cust.house === SCH ? 'schInvoiced' : 'tpInvoiced'] += invoicedY
        invLines++
      }
    }
  }

  // ── CREDITS (DAX: Net Yards Invoiced = Gross + Yards Credited) ────────
  // InvoiceAdjustments carries per-line QTY_CHANGE (negative yards) and
  // EXTENDED_PRICE_CHANGE, dated by CANCELLED_DATE. Same Yield transform,
  // same category/bucket routing, subtracted inside the window.
  let creditYds = 0, creditRev = 0, creditLines = 0
  if (adjustments) {
    for (const a of adjustments) {
      const cd = dateOf(a.CANCELLEDDATE)
      if (!inWin(cd, from, to)) continue
      const info = skuInfo.get(a.ITEMSKU)
      const typeRaw = info?.type || ''
      const pm = PRODUCT_MAP[normKey(typeRaw)]
      if (!pm || pm.kind === 'skip' || pm.kind === 'ground' || pm.kind === 'fee') continue
      const yf = yieldMap.get(String(a.ITEMSKU))?.yield ?? 1
      const dy = num(a.QTYCHANGE) * yf              // negative
      const dr = num(a.EXTENDEDPRICECHANGE)         // negative
      const cust = customerOf(a.CUSTOMERNAME, unmappedCust)
      creditYds += dy; creditRev += dr; creditLines++
      if (pm.div === 'sp') {
        nj[pm.cat].invoiceYds += dy
        nj[pm.cat].invoiceRev += dr
        nj[cust.house === SCH ? 'schInvoiced' : 'tpInvoiced'] += dy
      } else if (pm.div === 'dg') {
        bny['invYds' + bucketKey(cust.bucket)] += dy
        bny['income' + bucketKey(cust.bucket)] += dr
        bny[cust.house === SCH ? 'schInvoiced' : 'tpInvoiced'] += dy
      }
    }
  }

  // Machines — print_jobs report carries MACHINE_NAME per run. Optional:
  // if the report name differs or the pull fails, degrade with a warning.
  const machines = {}
  let machinesOk = false
  try {
    const jobs = parseCsv(await fetchCsv('print_jobs')).records
    for (const r of jobs) {
      const printed = dateOf(r.PRINTEDDATE)
      if (!inWin(printed, from, to)) continue
      const id = MACHINE_MAP[normKey(r.MACHINENAME)]
      if (!id) { if (r.MACHINENAME) unknownMachines.add(r.MACHINENAME); continue }
      const yf = yieldMap.get(String(r.ITEMSKU))?.yield ?? 1
      machines[id] = (machines[id] || 0) + num(r.QTYPRINTED) * yf
    }
    machinesOk = true
  } catch { /* degrade */ }

  const r2 = o => { const out = {}; for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : (v && typeof v === 'object' ? r2(v) : v); return out }
  const warnings = []
  if (nj.other.produced || nj.other.invoiceYds) warnings.push(`Strike-offs/untyped: ${Math.round(nj.other.produced)} yd produced / ${Math.round(nj.other.invoiceYds)} yd invoiced — counted in SCH/3P totals, excluded from Fabric/Grass/Paper splits (matches the model)`)
  if (heldLines) warnings.push(`${Math.round(heldYds)} yd printed in-window still Held to Invoice (${heldLines} lines) — excluded from Produced per the model's rule; they back-fill when invoiced`)
  if (noTypeLines) warnings.push(`${noTypeLines} order line(s) whose SKU isn't in the products report — skipped entirely`)
  if (noYieldLines) warnings.push(`${noYieldLines} counted line(s) missing from ref_product_yield — Yield defaulted to 1 (doctrine: flag, don't guess)`)
  if (colorlessProduced > 0) warnings.push(`${Math.round(colorlessProduced)} produced yd on SKUs with no color count — CY undercounted by that share`)
  if (unmappedCust.size) warnings.push(`${unmappedCust.size} customer name(s) not in the model's table (bucketed to Contract): ${[...unmappedCust].slice(0, 5).join(' · ')}${unmappedCust.size > 5 ? '…' : ''}`)
  if (unknownTypes.size) warnings.push(`Unknown product type(s) skipped: ${[...unknownTypes].slice(0, 5).join(' · ')}`)
  if (correctionsApplied) warnings.push(`${correctionsApplied} line(s) carry CORRECT_AMOUNT_PRINTED — present but NOT applied (DAX uses raw QTY_PRINTED)`)
  if (adjustments == null) warnings.push('InvoiceAdjustments pull failed — invoiced numbers are GROSS (credits not netted)')
  else if (creditLines) warnings.push(`Net of ${creditLines} credit line(s): ${Math.round(creditYds)} yd / $${Math.round(creditRev).toLocaleString()} (DAX Net = Gross + Credited)`)
  if (!machinesOk) warnings.push('Machine outputs unavailable (print_jobs pull failed) — machine grid left as-is')
  if (unknownMachines.size) warnings.push(`Machine name(s) not in the form grid, skipped: ${[...unknownMachines].slice(0, 6).join(' · ')}`)

  return json(200, {
    week_start: weekStart, days, window: { from, to },
    coverage: { orderLines: orders.length, producedLines: prodLines, invoicedLines: invLines },
    nj: r2(nj), bny: r2(bny), machines: r2(machines), machinesOk,
    warnings,
  })
}
