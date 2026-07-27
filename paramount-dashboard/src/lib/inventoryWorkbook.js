// ============================================================================
// inventoryWorkbook.js — parses the ShareFile substrate inventory workbooks.
//
//   "Paramount Inventory Reporting <year>.xlsx"  → site 'passaic'  (~174 SKUs)
//   "BNY Inventory Reporting <year>.xlsx"        → site 'bny'      (~61 SKUs)
//
// Both share one layout, with three things that will bite anyone who assumes
// otherwise:
//
//  1. THE HEADER IS ON ROW 3. Rows 1–2 are a title banner and a "NO INK or
//     Other" caveat. Reading row 0 yields nothing and silently produces zero
//     rows — the same failure mode the purchases parser had.
//  2. COLUMN NAMES DIFFER SLIGHTLY BETWEEN SITES. Passaic says "Material Group
//     - Color" and "On Hand Curr"; BNY says "Material Grouping" and "On Hand
//     Current". Match on a prefix, never on an exact string.
//  3. THE SHEET IS ENORMOUSLY WIDE (Passaic reports A1:XBR174) because of trailing
//     junk columns, and there are TWO inventory sheets per file — the current
//     year and the prior year. Pick the one whose name carries the year.
//
// Only substrate is in here. Ink and "other" are explicitly excluded at source,
// which is what the row-2 caveat means — so this is not total inventory value.
// ============================================================================

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const clean = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s }
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return isFinite(n) ? n : null
}

// Find a column by prefix match against the header row.
function col(hdr, ...prefixes) {
  for (let i = 0; i < hdr.length; i++) {
    const h = norm(hdr[i])
    if (!h) continue
    for (const p of prefixes) if (h.startsWith(norm(p))) return i
  }
  return -1
}

// The header row is row 3 in practice, but search rather than hardcode it —
// that assumption is exactly what broke the purchases parser.
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = (rows[i] || []).map(norm)
    const hasSku = r.some(c => c.includes('lift sku'))
    const hasOnHand = r.some(c => c.startsWith('on hand'))
    if (hasSku && hasOnHand) return i
  }
  return -1
}

// Prefer the sheet whose name mentions the report year; fall back to any sheet
// that looks like an inventory sheet.
function pickSheet(names, year) {
  const inv = names.filter(n => /inventory/i.test(n))
  if (!inv.length) return null
  const withYear = inv.find(n => n.includes(String(year)))
  return withYear || inv[0]
}

/**
 * @param XLSX      the SheetJS module
 * @param workbook  parsed workbook
 * @param opts      { fileName, site, asOf }  asOf = ISO date string
 * @returns { rows, sheet, warnings }
 */
export function parseInventoryWorkbook(XLSX, workbook, opts = {}) {
  const { fileName = '', site, asOf } = opts
  const warnings = []
  if (!site) throw new Error('parseInventoryWorkbook: site is required')
  if (!asOf) throw new Error('parseInventoryWorkbook: asOf is required')

  const year = new Date(asOf).getUTCFullYear()
  const sheetName = pickSheet(workbook.SheetNames, year)
  if (!sheetName) throw new Error(`No inventory sheet in ${fileName} (sheets: ${workbook.SheetNames.join(', ')})`)
  if (!sheetName.includes(String(year))) {
    warnings.push(`Using sheet "${sheetName}" — no sheet named for ${year}. Check the workbook has a current-year tab.`)
  }

  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true })
  const hi = findHeaderRow(grid)
  if (hi < 0) throw new Error(`Could not find the header row in "${sheetName}" — expected a row containing "LIFT SKU" and "On Hand"`)
  const hdr = grid[hi] || []

  const cSku      = col(hdr, 'lift sku')
  const cGroup    = col(hdr, 'material group')       // "Material Group - Color" | "Material Grouping"
  const cSupplier = col(hdr, 'supplier')
  const cPrev     = col(hdr, 'on hand prev')
  const cCurr     = col(hdr, 'on hand curr')         // "On Hand Curr" | "On Hand Current"
  const cShortY   = col(hdr, 'yards short')
  const cShortC   = col(hdr, 'cost short')
  const cRecvY    = col(hdr, 'recvd yards', 'received yards')
  const cRecvC    = col(hdr, 'revd cost', 'recvd cost', 'received cost')
  const cSold     = col(hdr, 'sold per lift')
  const cCat      = col(hdr, 'cat')                  // Passaic only
  const cCostYd   = col(hdr, 'cost yard', 'cost/yard')

  if (cSku < 0 || cCurr < 0) {
    throw new Error(`"${sheetName}" is missing LIFT SKU or On Hand Current — the sheet shape has moved. Refusing to write a half-read inventory.`)
  }

  const seen = new Set()
  const rows = []
  let dupes = 0

  for (let i = hi + 1; i < grid.length; i++) {
    const r = grid[i] || []
    const sku = clean(r[cSku])
    if (!sku) continue
    // Skip any repeated header or a total line that slipped into the range.
    if (/^lift sku/i.test(sku) || /^total/i.test(sku)) continue

    // The primary key is (site, as_of, sku), so a duplicate SKU inside one file
    // would silently overwrite itself. Count them rather than lose them quietly.
    if (seen.has(sku)) { dupes++; continue }
    seen.add(sku)

    rows.push({
      site,
      as_of: asOf,
      lift_sku: sku,
      material_group: cGroup    >= 0 ? clean(r[cGroup])    : null,
      supplier:       cSupplier >= 0 ? clean(r[cSupplier]) : null,
      category:       cCat      >= 0 ? clean(r[cCat])      : null,
      on_hand_prev:   cPrev     >= 0 ? num(r[cPrev])       : null,
      on_hand_curr:   cCurr     >= 0 ? num(r[cCurr])       : null,
      yards_short:    cShortY   >= 0 ? num(r[cShortY])     : null,
      cost_short:     cShortC   >= 0 ? num(r[cShortC])     : null,
      recvd_yards:    cRecvY    >= 0 ? num(r[cRecvY])      : null,
      recvd_cost:     cRecvC    >= 0 ? num(r[cRecvC])      : null,
      sold_lift:      cSold     >= 0 ? num(r[cSold])       : null,
      cost_per_yard:  cCostYd   >= 0 ? num(r[cCostYd])     : null,
      source_file:    fileName,
    })
  }

  if (dupes) warnings.push(`${dupes} duplicate SKU row${dupes !== 1 ? 's' : ''} in "${sheetName}" — first occurrence kept.`)

  // Guard: a file that parses to almost nothing means the shape moved. Better to
  // keep the last good snapshot than overwrite it with a truncated read — the
  // same principle as the LIFT completeness guard.
  const MIN = site === 'bny' ? 20 : 60
  if (rows.length < MIN) {
    throw new Error(`Only ${rows.length} inventory rows parsed from ${fileName} (expected at least ${MIN}). Refusing to write.`)
  }

  const onHand = rows.reduce((s, r) => s + (r.on_hand_curr || 0), 0)
  const valued = rows.reduce((s, r) => s + ((r.on_hand_curr || 0) * (r.cost_per_yard || 0)), 0)

  return {
    rows, sheet: sheetName, warnings,
    summary: { skus: rows.length, on_hand_yards: Math.round(onHand), on_hand_value: Math.round(valued) },
  }
}
