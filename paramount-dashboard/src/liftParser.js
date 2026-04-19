// ============================================================================
// liftParser.js — Parse the LIFT "Production WIP" xlsx export
// ============================================================================
// Reads a LIFT Production WIP pivot export and returns normalized PO rows
// classified by site (passaic / bny / procurement).
//
// USAGE:
//   import { parseLiftWorkbook } from './liftParser'
//   const result = await parseLiftWorkbook(file)  // file = File object from <input type="file">
//   result.rows          -> array of PO objects, one per schedulable line
//   result.summary       -> { passaic: {...}, bny: {...}, procurement: {...} }
//   result.unclassified  -> array of rows where site couldn't be determined
//   result.warnings      -> array of strings describing anything unusual
// ============================================================================

import * as XLSX from 'xlsx'

// ─── Site classification ────────────────────────────────────────────────────
// The LIFT Division column is the authoritative site signal.
// These values come directly from the LIFT ERP.
const DIVISION_TO_SITE = {
  'Screen Print': 'passaic',
  'Digital':      'bny',
  'Procurement':  'procurement',
}

// ─── Pivot structure constants ──────────────────────────────────────────────
// When the pivot is exported with filters OFF for Division and Holding to Invoice,
// the header row is at row 7 (1-indexed). Data starts at row 8.
// Column order (1-indexed):
//   1=Division, 2=3rd Party vs House, 3=PRODUCT_TYPE, 4=New Goods,
//   5=ORDER_NUMBER, 6=PO_NUMBER, 7=LINE_DESCRIPTION, 8=ITEM_SKU,
//   9=COLOR, 10=MATERIAL, 11=ORDER_STATUS, 12=Number of Colors,
//   13=Min of ORDER_CREATED_DATE, 14=Yards Written,
//   15=Sum of QTY_INVOICED, 16=Income Written
const HEADER_ROW_INDEX = 6  // 0-indexed: row 7 in Excel
const DATA_START_INDEX = 7  // 0-indexed: row 8 in Excel
const SHEET_NAME = 'Production WIP'

// ─── Helpers ────────────────────────────────────────────────────────────────
const isSubtotalRow = (row) => {
  // A subtotal row has "Total" in one of the grouping columns
  // and no PO number in column F (index 5).
  const hasPO = row[5] && String(row[5]).trim() !== ''
  if (hasPO) return false
  const hasTotal = row.some(c => c && String(c).includes('Total'))
  return hasTotal
}

const isDataRow = (row) => {
  // Real data row: Division, PRODUCT_TYPE, and PO_NUMBER all present,
  // and no "Total" text anywhere.
  if (!row[0] || !row[2] || !row[5]) return false
  if (row.some(c => c && String(c).includes('Total'))) return false
  return true
}

const parseDate = (val) => {
  if (!val) return null
  if (val instanceof Date) return val
  if (typeof val === 'number') {
    // Excel serial date
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

// ─── Main parser ────────────────────────────────────────────────────────────
export async function parseLiftWorkbook(file) {
  const arrayBuffer = await file.arrayBuffer()
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })

  const warnings = []

  // Find the Production WIP sheet
  if (!wb.SheetNames.includes(SHEET_NAME)) {
    throw new Error(
      `Sheet "${SHEET_NAME}" not found in workbook. ` +
      `Found sheets: ${wb.SheetNames.join(', ')}`
    )
  }

  const ws = wb.Sheets[SHEET_NAME]
  // Convert to array-of-arrays; keeps empty cells so column positions are stable.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

  if (aoa.length < DATA_START_INDEX + 1) {
    throw new Error('Sheet appears to be empty or missing header rows.')
  }

  // Light header sanity check
  const header = aoa[HEADER_ROW_INDEX] || []
  const expectFirst = String(header[0] || '').trim()
  if (expectFirst && expectFirst !== 'Division') {
    warnings.push(
      `Header row column 1 says "${expectFirst}", expected "Division". ` +
      `Classifier may misread. Check that filters are off on the pivot.`
    )
  }

  const rows = []
  const unclassified = []
  const asOf = new Date()

  for (let i = DATA_START_INDEX; i < aoa.length; i++) {
    const r = aoa[i]
    if (!r || r.length === 0) continue
    if (isSubtotalRow(r)) continue
    if (!isDataRow(r)) continue

    const divisionRaw = String(r[0] || '').trim()
    const customerType = String(r[1] || '').trim()
    const productType = String(r[2] || '').trim()
    const newGoodsFlag = String(r[3] || '').trim()
    const orderNumber = String(r[4] || '').trim()
    const poNumber = String(r[5] || '').trim()
    const lineDescription = String(r[6] || '').trim()
    const itemSku = String(r[7] || '').trim()
    const color = String(r[8] || '').trim()
    const material = String(r[9] || '').trim()
    const orderStatus = String(r[10] || '').trim()
    const colorsCount = toIntOrNull(r[11])
    const orderCreated = parseDate(r[12])
    const yardsWritten = toNumber(r[13])
    const qtyInvoiced = toNumber(r[14])
    const incomeWritten = toNumber(r[15])

    const site = DIVISION_TO_SITE[divisionRaw] || 'unknown'
    if (site === 'unknown') {
      unclassified.push({ row_index: i + 1, division: divisionRaw, po: poNumber })
    }

    // Color-yards: only computed for Passaic (Screen Print).
    // Digital machines print all colors in one pass, so CY isn't a labor unit.
    // Procurement has 0 yards and no colors anyway.
    let colorYards = null
    if (site === 'passaic' && colorsCount != null && yardsWritten > 0) {
      colorYards = colorsCount * yardsWritten
    }

    const ageDays = ageDaysFrom(orderCreated, asOf)

    rows.push({
      site,
      division_raw: divisionRaw,
      customer_type: customerType,
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

  // Build summary counts per site
  const summary = {
    passaic:     { orders: 0, yards: 0, revenue: 0, color_yards: 0 },
    bny:         { orders: 0, yards: 0, revenue: 0 },
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
  }

  if (unclassified.length > 0) {
    warnings.push(
      `${unclassified.length} row(s) had an unrecognized Division value. ` +
      `They are stored with site='unknown' and excluded from schedulers.`
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
