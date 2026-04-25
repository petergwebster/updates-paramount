// ============================================================================
// liftParser.js — Parse the LIFT "Production WIP" xlsx export
// ============================================================================
// Reads a LIFT Production WIP pivot export and returns normalized PO rows
// classified by site (passaic / bny / procurement).
//
// As of v2 (commit 2 of BNY build-out):
//   - Reads two new columns: B "Category Customer MTO" and C "CUSTOMER NAME"
//   - Derives `bny_bucket` for BNY rows using the locked 8-rule logic
//   - Validates header row strictly; throws a clear error on mismatch
//
// USAGE:
//   import { parseLiftWorkbook } from './liftParser'
//   const result = await parseLiftWorkbook(file)
//   result.rows          -> array of PO objects, one per schedulable line
//   result.summary       -> { passaic: {...}, bny: {...}, procurement: {...} }
//   result.unclassified  -> array of rows where site couldn't be determined
//   result.warnings      -> array of strings describing anything unusual
// ============================================================================

import * as XLSX from 'xlsx'

// ─── Site classification ────────────────────────────────────────────────────
const DIVISION_TO_SITE = {
  'Screen Print': 'passaic',
  'Digital':      'bny',
  'Procurement':  'procurement',
}

// Fallback site classifier: when LIFT hasn't filled in Division yet (early-stage
// New Goods orders, ground-only POs awaiting print component), the MATERIAL
// code's prefix usually tells us where the order will produce. "BNY..." codes
// route to BNY/Brooklyn; "PAR..." codes route to Paramount/Passaic. Anything
// else stays unknown — those POs need LIFT-side classification before they
// can be routed to a scheduler.
function inferSiteFromMaterial(material) {
  const m = String(material || '').trim().toUpperCase()
  if (!m || m === '(BLANK)') return null
  if (m.startsWith('BNY')) return 'bny'
  if (m.startsWith('PAR')) return 'passaic'
  return null
}

// ─── Pivot structure constants ──────────────────────────────────────────────
// Header row is at Excel row 7 (0-indexed 6). Data starts at row 8 (0-indexed 7).
// 0-indexed column positions after Peter's Col B and Col C additions:
//   0=Division, 1=Category Customer MTO, 2=CUSTOMER NAME, 3=3rd Party vs House,
//   4=PRODUCT_TYPE, 5=New Goods, 6=ORDER_NUMBER, 7=PO_NUMBER,
//   8=LINE_DESCRIPTION, 9=ITEM_SKU, 10=COLOR, 11=MATERIAL,
//   12=ORDER_STATUS, 13=Number of Colors, 14=Min of ORDER_CREATED_DATE,
//   15=Yards Written, 16=Sum of QTY_INVOICED, 17=Income Written
const HEADER_ROW_INDEX = 6
const DATA_START_INDEX = 7
const SHEET_NAME = 'Production WIP'

const EXPECTED_HEADERS = [
  'Division',
  'Category Customer MTO',
  'CUSTOMER NAME',
  '3rd Party vs  House',   // note: LIFT has a double space here
  'PRODUCT_TYPE',
  'New Goods',
  'ORDER_NUMBER',
  'PO_NUMBER',
  'LINE_DESCRIPTION',
  'ITEM_SKU',
  'COLOR',
  'MATERIAL',
  'ORDER_STATUS',
  'Number of Colors',
  'Min of ORDER_CREATED_DATE',
  'Yards Written',
  'Sum of QTY_INVOICED',
  'Income Written',
]

// Column indices used by row-classification helpers (keep in sync with above)
const COL = {
  DIVISION:      0,
  CATEGORY_B:    1,
  CUSTOMER_C:    2,
  HOUSE_OR_3P:   3,
  PRODUCT_TYPE:  4,
  NEW_GOODS:     5,
  ORDER_NUMBER:  6,
  PO_NUMBER:     7,
  LINE_DESC:     8,
  ITEM_SKU:      9,
  COLOR:        10,
  MATERIAL:     11,
  ORDER_STATUS: 12,
  COLORS_COUNT: 13,
  ORDER_DATE:   14,
  YARDS:        15,
  QTY_INV:      16,
  INCOME:       17,
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const cleanString = (v) => {
  if (v == null) return ''
  const s = String(v).trim()
  if (s === '(blank)') return ''
  return s
}

const isSubtotalRow = (row) => {
  // A subtotal row has "Total" in one of the grouping columns and no PO number.
  const hasPO = row[COL.PO_NUMBER] && String(row[COL.PO_NUMBER]).trim() !== ''
  if (hasPO) return false
  const hasTotal = row.some(c => c && String(c).includes('Total'))
  return hasTotal
}

const isDataRow = (row) => {
  // Real data row: Division, PRODUCT_TYPE, and PO_NUMBER all present,
  // and no "Total" text anywhere.
  if (!row[COL.DIVISION] || !row[COL.PRODUCT_TYPE] || !row[COL.PO_NUMBER]) return false
  if (row.some(c => c && String(c).includes('Total'))) return false
  return true
}

const parseDate = (val) => {
  if (!val) return null
  if (val instanceof Date) return val
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val)
    if (!d) return null
    return new Date(Date.UTC(d.y, d.m - 1, d.d))
  }
  const s = String(val).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

const ageDaysFrom = (orderDate, asOf = new Date()) => {
  if (!orderDate) return null
  const ms = asOf.getTime() - orderDate.getTime()
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)))
}

const ageBucketOf = (days) => {
  if (days == null) return 'no-date'
  if (days <= 30) return '0-30'
  if (days <= 60) return '31-60'
  if (days <= 90) return '61-90'
  return '90+'
}

const toNumber = (v) => {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  const s = String(v).replace(/[,$]/g, '').trim()
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

const toIntOrNull = (v) => {
  if (v == null || v === '' || String(v).trim() === '(blank)') return null
  const n = parseInt(v, 10)
  return isNaN(n) ? null : n
}

// ─── BNY bucket derivation (8-rule logic locked with Peter) ─────────────────
// Only applies to rows where site === 'bny'. Returns null for other sites
// and for excluded categories (Strike-off, SCHUMACHER PROC, Cancellation Fee).
const BNY_EXCLUDED_CATEGORIES = new Set(['Strike-off', 'SCHUMACHER PROC', 'Cancellation Fee'])

function deriveBnyBucket({ site, customer_type, category_customer_mto, customer_name_clean }) {
  if (site !== 'bny') return null

  const category = category_customer_mto || ''
  const customer = customer_name_clean || ''
  const is3P = (customer_type || '').toLowerCase().includes('3rd')

  // Rule 1: Exclusions (excluded from BNY mix entirely)
  if (BNY_EXCLUDED_CATEGORIES.has(category)) return null

  // Rule 2: 3rd Party → 3P (catches Contract Fabric/Wallpaper and any 3P customer)
  if (is3P) return '3P'

  // Rules 3-5: Schumacher category-specific buckets
  // MTO splits into two lanes per Wendy 4/2026: Custom (Sarah's BNY 3600s/570s)
  // vs regular MTO (Passaic digital fleet). Both have category="MTO" in LIFT;
  // the customer-name field is the discriminator. If LIFT later exposes the
  // "Order Title" field in the WIP export, switch to that — Order Title =
  // "Custom MTO" is Wendy's preferred discriminator.
  if (category === 'MTO') {
    if (customer.toUpperCase().includes('CUSTOM MTO')) return 'Custom'
    return 'MTO'
  }
  if (category === 'Memo')        return 'Memo'
  if (category === 'Hospitality') return 'HOS'

  // Rule 6: Panel and Engineered Wings roll into Replen (per Peter)
  if (category === 'Panel' || category === 'Engineered Wings') return 'Replen'

  // Rule 7: NEW GOODS customer gets its own bucket (tracked separately at BNY)
  if (customer === 'F. SCHUMACHER & CO - NEW GOODS') return 'NEW GOODS'

  // Rule 8: Default → Replen (covers Regular + HUB + any other Schumacher)
  return 'Replen'
}

// ─── Main parser ────────────────────────────────────────────────────────────
export async function parseLiftWorkbook(file) {
  const arrayBuffer = await file.arrayBuffer()
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })

  const warnings = []

  if (!wb.SheetNames.includes(SHEET_NAME)) {
    throw new Error(
      `Sheet "${SHEET_NAME}" not found in workbook. ` +
      `Found sheets: ${wb.SheetNames.join(', ')}`
    )
  }

  const ws = wb.Sheets[SHEET_NAME]
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

  if (aoa.length < DATA_START_INDEX + 1) {
    throw new Error('Sheet appears to be empty or missing header rows.')
  }

  // STRICT header validation — the new columns B and C must be present or
  // the data reads will silently shift. Fail loud with a clear message.
  const header = (aoa[HEADER_ROW_INDEX] || []).map(h => (h == null ? '' : String(h).trim()))
  const mismatches = []
  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    if (header[i] !== EXPECTED_HEADERS[i]) {
      mismatches.push(`col ${String.fromCharCode(65 + i)}: expected "${EXPECTED_HEADERS[i]}", got "${header[i] || '(empty)'}"`)
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `LIFT header row (row 7) doesn't match expected layout. ` +
      `Make sure filters are off and Columns B "Category Customer MTO" and C "CUSTOMER NAME" are present. ` +
      `Mismatches: ${mismatches.slice(0, 4).join(' | ')}${mismatches.length > 4 ? ` (+${mismatches.length - 4} more)` : ''}`
    )
  }

  const rows = []
  const unclassified = []
  const asOf = new Date()

  // Pass 1 — Shadow detection. The LIFT pivot sometimes produces "shadow" rows:
  // a row with a real PRODUCT_TYPE (e.g. Fabric) plus a sibling row with the
  // same PO+Order# but PRODUCT_TYPE blank. The blank row is a pivot artifact
  // (LIFT showing the order at a higher grouping) and would double-count if
  // we kept both. Identify which (PO, Order#) keys have at least one real-PT
  // row; later we drop blank-PT rows whose key is in that set. Blank-PT rows
  // whose key is NOT in the set are real "orphans" — early-stage POs that
  // haven't been linked to a print component yet (ground orders awaiting
  // production assignment) — and we keep those.
  const realKeys = new Set()
  for (let i = DATA_START_INDEX; i < aoa.length; i++) {
    const r = aoa[i]
    if (!r || r.length === 0) continue
    if (isSubtotalRow(r)) continue
    if (!isDataRow(r)) continue
    const pt = cleanString(r[COL.PRODUCT_TYPE])
    if (!pt) continue
    const po = cleanString(r[COL.PO_NUMBER])
    const ord = cleanString(r[COL.ORDER_NUMBER])
    if (po && ord) realKeys.add(`${po}::${ord}`)
  }

  let shadowsSkipped = 0

  for (let i = DATA_START_INDEX; i < aoa.length; i++) {
    const r = aoa[i]
    if (!r || r.length === 0) continue
    if (isSubtotalRow(r)) continue
    if (!isDataRow(r)) continue

    const divisionRaw        = cleanString(r[COL.DIVISION])
    const categoryCustomerB  = cleanString(r[COL.CATEGORY_B])
    const customerNameC      = cleanString(r[COL.CUSTOMER_C])
    const customerType       = cleanString(r[COL.HOUSE_OR_3P])
    const productType        = cleanString(r[COL.PRODUCT_TYPE])
    const newGoodsFlag       = cleanString(r[COL.NEW_GOODS])
    const orderNumber        = cleanString(r[COL.ORDER_NUMBER])
    const poNumber           = cleanString(r[COL.PO_NUMBER])
    const lineDescription    = cleanString(r[COL.LINE_DESC])
    const itemSku            = cleanString(r[COL.ITEM_SKU])
    const color              = cleanString(r[COL.COLOR])
    const material           = cleanString(r[COL.MATERIAL])
    const orderStatus        = cleanString(r[COL.ORDER_STATUS])
    const colorsCount        = toIntOrNull(r[COL.COLORS_COUNT])
    const orderCreated       = parseDate(r[COL.ORDER_DATE])
    const yardsWritten       = toNumber(r[COL.YARDS])
    const qtyInvoiced        = toNumber(r[COL.QTY_INV])
    const incomeWritten      = toNumber(r[COL.INCOME])

    // Drop shadow rows: blank PRODUCT_TYPE AND a sibling row with real PT exists.
    if (!productType && realKeys.has(`${poNumber}::${orderNumber}`)) {
      shadowsSkipped++
      continue
    }

    // Site: Division is the primary signal. Fall back to MATERIAL prefix when
    // Division is blank (typical of early-stage orphans). If neither yields a
    // production site, we leave it 'unknown' so it surfaces in the
    // pre-classification view rather than disappearing.
    let site = DIVISION_TO_SITE[divisionRaw] || 'unknown'
    if (site === 'unknown') {
      const fromMaterial = inferSiteFromMaterial(material)
      if (fromMaterial) site = fromMaterial
    }
    if (site === 'unknown') {
      unclassified.push({ row_index: i + 1, division: divisionRaw, po: poNumber, material })
    }

    // Color-yards: only for Passaic (Screen Print). Digital one-passes colors;
    // Procurement has 0 yards and no colors anyway.
    let colorYards = null
    if (site === 'passaic' && colorsCount != null && yardsWritten > 0) {
      colorYards = colorsCount * yardsWritten
    }

    const ageDays = ageDaysFrom(orderCreated, asOf)

    // Derive BNY bucket (null for non-BNY rows or excluded categories)
    const bnyBucket = deriveBnyBucket({
      site,
      customer_type: customerType,
      category_customer_mto: categoryCustomerB,
      customer_name_clean: customerNameC,
    })

    rows.push({
      site,
      division_raw: divisionRaw,
      customer_type: customerType,
      category_customer_mto: categoryCustomerB,
      customer_name_clean: customerNameC,
      bny_bucket: bnyBucket,
      product_type: productType,
      is_new_goods: newGoodsFlag === 'New Goods',
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

  // Summary counts per site (+ BNY bucket breakdown)
  const summary = {
    passaic:     { orders: 0, yards: 0, revenue: 0, color_yards: 0 },
    bny:         { orders: 0, yards: 0, revenue: 0, buckets: {} },
    procurement: { orders: 0, revenue: 0 },
    unknown:     { orders: 0, yards: 0, revenue: 0 },
  }

  for (const row of rows) {
    const s = summary[row.site]
    if (!s) continue
    s.orders += 1
    if ('yards' in s)       s.yards       += row.yards_written
    if ('revenue' in s)     s.revenue     += row.income_written
    if ('color_yards' in s) s.color_yards += (row.color_yards || 0)
    if (row.site === 'bny') {
      const b = row.bny_bucket || 'Excluded'
      s.buckets[b] = (s.buckets[b] || 0) + 1
    }
  }

  if (unclassified.length > 0) {
    warnings.push(
      `${unclassified.length} row(s) had no Division and no recognizable site prefix in MATERIAL. ` +
      `They are stored with site='unknown' and surfaced in the New Goods pre-classification view. ` +
      `LIFT-side classification (assign Division, or fix MATERIAL code) will route them properly.`
    )
  }
  if (shadowsSkipped > 0) {
    warnings.push(
      `Skipped ${shadowsSkipped} pivot shadow row(s) (blank PRODUCT_TYPE rows that duplicate ` +
      `a sibling row with the same PO+Order#).`
    )
  }

  return {
    rows,
    summary,
    unclassified,
    warnings,
    meta: {
      total_rows: rows.length,
      parsed_at: new Date().toISOString(),
      source_filename: file.name,
    },
  }
}
