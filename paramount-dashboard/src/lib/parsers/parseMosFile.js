/**
 * parseMosFile.js — parser for API_Dashboard_MOS_3_0.xlsx
 *
 * Sheets parsed:
 *   1. MOS Material - Color → mos_materials          (the inventory engine)
 *   2. Open POs             → mos_open_pos           (currently open POs)
 *   3. Monthly Velocity     → mos_monthly_velocity   (per-material burn rate)
 *   4. Recvd Curr Month     → mos_received           (received this month)
 *   5. Inv Reconciliation   → mos_inv_reconciliation (LIFT vs actual on-hand)
 *   6. Ground Est Ship      → mos_ground_est_ship    (expected arrivals)
 */

import {
  readWorkbook,
  getSheetMatrix,
  findHeaderRow,
  isSubtotalRow,
  forwardFill,
  toNumber,
  toInt,
  toStr,
  toDateISO,
  buildColumnMap,
  getCol,
  buildRawRow,
} from './parserHelpers.js'

export async function parseMosFile(buffer) {
  const wb = readWorkbook(buffer)
  if (!wb) {
    return { parsedData: {}, errors: { _workbook: 'Could not open workbook' } }
  }

  const parsedData = {}
  const errors = {}

  try { parsedData.materials          = parseMaterials(wb) }       catch (e) { errors.materials          = e?.message || 'Unknown' }
  try { parsedData.open_pos           = parseOpenPos(wb) }         catch (e) { errors.open_pos           = e?.message || 'Unknown' }
  try { parsedData.monthly_velocity   = parseMonthlyVelocity(wb) } catch (e) { errors.monthly_velocity   = e?.message || 'Unknown' }
  try { parsedData.received           = parseReceived(wb) }        catch (e) { errors.received           = e?.message || 'Unknown' }
  try { parsedData.inv_reconciliation = parseInvRecon(wb) }        catch (e) { errors.inv_reconciliation = e?.message || 'Unknown' }
  try { parsedData.ground_est_ship    = parseGroundEstShip(wb) }   catch (e) { errors.ground_est_ship    = e?.message || 'Unknown' }

  return { parsedData, errors }
}

/* ═══════════════════════════════════════════════════════════════════════
   1. MOS Material - Color — the inventory engine, header at row 7
   23 columns: Order Type, Replacement Ground, PO Open Qty, etc
   ═══════════════════════════════════════════════════════════════════════ */
function parseMaterials(wb) {
  const matrix = getSheetMatrix(wb, 'MOS Material - Color')
  if (!matrix) throw new Error('MOS Material - Color sheet not found')

  const hdr = findHeaderRow(matrix, [
    'Order Type', 'Replacement Ground', 'PO Open Qty',
    'On Hand Qty', 'Avg Monthly Last 6 Months', 'Calc Buy in Yards',
  ])
  if (!hdr) throw new Error('Could not find header row in MOS Material - Color sheet')

  const colMap = buildColumnMap(hdr.headerLabels, {
    order_type_screen:                  /order type/i,
    replacement_ground:                 'Replacement Ground',
    po_open_qty:                        'PO Open Qty',
    min_due_date:                       'Min Due Date',
    max_due_date:                       'Max Due Date',
    countd_open_po_dates:               /countd open po/i,
    on_hand_qty:                        'On Hand Qty',
    wip_ground:                         'WIP Ground',
    wip_yards:                          'WIP Yards',
    wip_total:                          'WIP Total',
    curr_available_no_ground:           /curr available no ground/i,
    curr_available_on_hand:             /curr available on hand/i,
    available_on_hand_with_open_pos:    /available on hand with open/i,
    ground_written_last_6_months:       /ground written last 6/i,
    avg_monthly_last_6_months:          /avg monthly last 6/i,
    avg_monthly_last_12_months:         /avg monthly last 12/i,
    avg_last_6_and_12_monthly_yards:    /avg last 6 .* 12/i,
    yards_written_last_30_days:         /yards written last 30/i,
    mos_based_on_last_6_and_12:         /mos based on last/i,
    calc_buy_in_yards_plus_2_months:    /calc buy/i,
    months_of_lead_time:                /months of lead time/i,
    target_mos_plus_2_month:            /target mos/i,
    var_mos_vs_target_plus_2:           /var mos vs target/i,
  })

  // Forward-fill order_type_screen (the "Schumacher" / "Paramount" group label)
  if (colMap.order_type_screen >= 0) {
    forwardFill(matrix, [colMap.order_type_screen], hdr.headerRow + 1)
  }

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue

    const ground = toStr(getCol(row, colMap, 'replacement_ground'))
    const subtotal = isSubtotalRow(row)
    if (!ground && !subtotal) continue

    rows.push({
      order_type_screen:                  toStr(getCol(row, colMap, 'order_type_screen')),
      replacement_ground:                 ground,
      po_open_qty:                        toNumber(getCol(row, colMap, 'po_open_qty')),
      min_due_date:                       toDateISO(getCol(row, colMap, 'min_due_date')),
      max_due_date:                       toDateISO(getCol(row, colMap, 'max_due_date')),
      countd_open_po_dates:               toInt(getCol(row, colMap, 'countd_open_po_dates')),
      on_hand_qty:                        toNumber(getCol(row, colMap, 'on_hand_qty')),
      wip_ground:                         toNumber(getCol(row, colMap, 'wip_ground')),
      wip_yards:                          toNumber(getCol(row, colMap, 'wip_yards')),
      wip_total:                          toNumber(getCol(row, colMap, 'wip_total')),
      curr_available_no_ground:           toNumber(getCol(row, colMap, 'curr_available_no_ground')),
      curr_available_on_hand:             toNumber(getCol(row, colMap, 'curr_available_on_hand')),
      available_on_hand_with_open_pos:    toNumber(getCol(row, colMap, 'available_on_hand_with_open_pos')),
      ground_written_last_6_months:       toNumber(getCol(row, colMap, 'ground_written_last_6_months')),
      avg_monthly_last_6_months:          toNumber(getCol(row, colMap, 'avg_monthly_last_6_months')),
      avg_monthly_last_12_months:         toNumber(getCol(row, colMap, 'avg_monthly_last_12_months')),
      avg_last_6_and_12_monthly_yards:    toNumber(getCol(row, colMap, 'avg_last_6_and_12_monthly_yards')),
      yards_written_last_30_days:         toNumber(getCol(row, colMap, 'yards_written_last_30_days')),
      mos_based_on_last_6_and_12_month_sales: toNumber(getCol(row, colMap, 'mos_based_on_last_6_and_12')),
      calc_buy_in_yards_plus_2_months:    toNumber(getCol(row, colMap, 'calc_buy_in_yards_plus_2_months')),
      months_of_lead_time:                toNumber(getCol(row, colMap, 'months_of_lead_time')),
      target_mos_plus_2_month:            toNumber(getCol(row, colMap, 'target_mos_plus_2_month')),
      var_mos_vs_target_plus_2:           toNumber(getCol(row, colMap, 'var_mos_vs_target_plus_2')),
      is_subtotal:                        subtotal,
      raw_row:                            buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════════
   2. Open POs — currently open purchase orders
   ═══════════════════════════════════════════════════════════════════════ */
function parseOpenPos(wb) {
  const matrix = getSheetMatrix(wb, 'Open POs')
  if (!matrix) throw new Error('Open POs sheet not found')

  const hdr = findHeaderRow(matrix, ['Material'], 1)
  if (!hdr) {
    // If we can't find a clear header, capture all non-empty rows raw
    return captureAllRowsRaw(matrix)
  }

  const colMap = buildColumnMap(hdr.headerLabels, {
    material:  /material/i,
    qty_open:  /qty.*open|po.*open|open.*qty/i,
    due_date:  /due.*date/i,
  })

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    if (isSubtotalRow(row)) continue

    const material = toStr(getCol(row, colMap, 'material'))
    if (!material) continue

    rows.push({
      material,
      qty_open: toNumber(getCol(row, colMap, 'qty_open')),
      due_date: toDateISO(getCol(row, colMap, 'due_date')),
      raw_row:  buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════════
   3. Monthly Velocity — per-material burn rate by month (39 cols wide)
   Wide pivot: rows are materials, columns are year-month buckets
   Convert to long format: one row per (material, year_month, yards)
   ═══════════════════════════════════════════════════════════════════════ */
function parseMonthlyVelocity(wb) {
  const matrix = getSheetMatrix(wb, 'Monthly Velocity')
  if (!matrix) throw new Error('Monthly Velocity sheet not found')

  // Find header row by looking for Material + a date-like column
  let headerRow = -1
  let headerLabels = []
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const row = matrix[i] || []
    const cells = row.map(c => c == null ? '' : String(c).toLowerCase().trim())
    if (cells.some(c => c.includes('material') || c.includes('replacement ground'))) {
      headerRow = i
      headerLabels = row.map(c => c == null ? '' : String(c).trim())
      break
    }
  }
  if (headerRow < 0) {
    return captureAllRowsRaw(matrix)
  }

  // Identify which columns are date-like (year-month buckets)
  // and which are non-date metadata (material name, totals)
  const dateColumns = []
  for (let ci = 0; ci < headerLabels.length; ci++) {
    const label = headerLabels[ci]
    if (label instanceof Date || /\d{4}-\d{2}|^\d{1,2}\/\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(String(label))) {
      dateColumns.push({ col: ci, label: String(label).trim() })
    }
  }

  // Material is typically the first non-empty column
  const materialCol = 0

  const rows = []
  for (let i = headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    if (isSubtotalRow(row)) continue

    const material = toStr(row[materialCol])
    if (!material) continue

    // Emit one row per date column
    for (const dc of dateColumns) {
      const yards = toNumber(row[dc.col])
      if (yards == null || yards === 0) continue
      rows.push({
        material,
        year_month: normalizeYearMonth(dc.label),
        yards,
        raw_row: { material, period: dc.label, yards },
      })
    }
  }
  return rows
}

/**
 * Normalize various year-month formats to YYYY-MM.
 * Handles: '2026-01', '01/2026', 'Jan 2026', Date objects
 */
function normalizeYearMonth(label) {
  if (label instanceof Date) {
    const y = label.getFullYear()
    const m = String(label.getMonth() + 1).padStart(2, '0')
    return `${y}-${m}`
  }
  const s = String(label).trim()
  // Already YYYY-MM
  if (/^\d{4}-\d{2}$/.test(s)) return s
  // MM/YYYY
  const m1 = s.match(/^(\d{1,2})\/(\d{4})$/)
  if (m1) return `${m1[2]}-${String(m1[1]).padStart(2, '0')}`
  // 'Jan 2026'
  const m2 = s.match(/^(\w{3,9})\s+(\d{4})$/i)
  if (m2) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    const idx = months.findIndex(mo => m2[1].toLowerCase().startsWith(mo))
    if (idx >= 0) return `${m2[2]}-${String(idx + 1).padStart(2, '0')}`
  }
  return s  // fallback — store as-is
}

/* ═══════════════════════════════════════════════════════════════════════
   4. Recvd Curr Month
   ═══════════════════════════════════════════════════════════════════════ */
function parseReceived(wb) {
  const matrix = getSheetMatrix(wb, 'Recvd Curr Month')
  if (!matrix) throw new Error('Recvd Curr Month sheet not found')

  const hdr = findHeaderRow(matrix, ['Material'], 1)
  if (!hdr) return captureAllRowsRaw(matrix)

  const colMap = buildColumnMap(hdr.headerLabels, {
    material:      /material/i,
    qty_received:  /qty|received|recv/i,
    date_received: /date|received/i,
  })

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    if (isSubtotalRow(row)) continue

    const material = toStr(getCol(row, colMap, 'material'))
    if (!material) continue

    rows.push({
      material,
      qty_received:  toNumber(getCol(row, colMap, 'qty_received')),
      date_received: toDateISO(getCol(row, colMap, 'date_received')),
      raw_row:       buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════════
   5. Inv Reconciliation — LIFT vs actual on-hand
   ═══════════════════════════════════════════════════════════════════════ */
function parseInvRecon(wb) {
  const matrix = getSheetMatrix(wb, 'Inv Reconciliation')
  if (!matrix) throw new Error('Inv Reconciliation sheet not found')

  const hdr = findHeaderRow(matrix, ['Material'], 1)
  if (!hdr) return captureAllRowsRaw(matrix)

  const colMap = buildColumnMap(hdr.headerLabels, {
    material:                  /material/i,
    on_hand_qty:               /^on hand qty$|on hand$/i,
    on_hand_lift_api:          /on hand lift|lift api/i,
    qty_on_hand_vs_lift_api:   /qty on hand vs|on hand vs lift/i,
  })

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    if (isSubtotalRow(row)) continue

    const material = toStr(getCol(row, colMap, 'material'))
    if (!material) continue

    rows.push({
      material,
      on_hand_qty:             toNumber(getCol(row, colMap, 'on_hand_qty')),
      on_hand_lift_api:        toNumber(getCol(row, colMap, 'on_hand_lift_api')),
      qty_on_hand_vs_lift_api: toNumber(getCol(row, colMap, 'qty_on_hand_vs_lift_api')),
      raw_row:                 buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════════
   6. Ground Est Ship
   ═══════════════════════════════════════════════════════════════════════ */
function parseGroundEstShip(wb) {
  const matrix = getSheetMatrix(wb, 'Ground Est Ship ')  // note trailing space in actual sheet name
  if (!matrix) {
    // Try without trailing space in case it gets fixed
    const alt = getSheetMatrix(wb, 'Ground Est Ship')
    if (!alt) throw new Error('Ground Est Ship sheet not found')
    return parseGroundEstShipMatrix(alt)
  }
  return parseGroundEstShipMatrix(matrix)
}

function parseGroundEstShipMatrix(matrix) {
  const hdr = findHeaderRow(matrix, ['Material'], 1)
  if (!hdr) return captureAllRowsRaw(matrix)

  const colMap = buildColumnMap(hdr.headerLabels, {
    material:       /material/i,
    est_ship_date:  /est.*ship|ship.*date/i,
    qty_expected:   /qty|expected|ground/i,
  })

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    if (isSubtotalRow(row)) continue

    const material = toStr(getCol(row, colMap, 'material'))
    if (!material) continue

    rows.push({
      material,
      est_ship_date: toDateISO(getCol(row, colMap, 'est_ship_date')),
      qty_expected:  toNumber(getCol(row, colMap, 'qty_expected')),
      raw_row:       buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ─── Fallback: capture all non-empty rows as raw_row ─────────────────── */
function captureAllRowsRaw(matrix) {
  const rows = []
  // Use first non-empty row as header guess
  let headerLabels = []
  let firstDataRow = 0
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i] || []
    const nonNull = row.filter(c => c != null)
    if (nonNull.length >= 2) {
      headerLabels = row.map(c => c == null ? '' : String(c).trim())
      firstDataRow = i + 1
      break
    }
  }
  for (let i = firstDataRow; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    rows.push({ raw_row: buildRawRow(row, headerLabels) })
  }
  return rows
}
