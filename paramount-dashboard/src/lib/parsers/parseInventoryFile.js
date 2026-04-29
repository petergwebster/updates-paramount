/**
 * parseInventoryFile.js — parser for Paramount_Inventory_Reporting_2026.xlsx
 *
 * Sheets parsed:
 *   1. COGS Summary    → inv_cogs_summary  (monthly COGS roll-forward)
 *   2. Ground Sold     → inv_ground_sold   (ground sold to FSCO)
 *   3. POs Shipped     → inv_pos_shipped   (POs shipped this period)
 *   4. Schu On Hand Oct → inv_schu_on_hand (Schumacher on-hand reference)
 *
 * For Inventory file, most sheets are smaller and simpler than WIP/MOS.
 * Two of these (Ground Sold, POs Shipped, Schu On Hand) we capture as raw
 * JSONB only since we haven't done the column-level analysis yet —
 * structure can be refined later when a feature consumes the data.
 *
 * COGS Summary is the most structured, so we parse it explicitly.
 */

import {
  readWorkbook,
  getSheetMatrix,
  monthLabelToNum,
  toNumber,
  toStr,
  buildRawRow,
} from './parserHelpers.js'

export async function parseInventoryFile(buffer) {
  const wb = readWorkbook(buffer)
  if (!wb) {
    return { parsedData: {}, errors: { _workbook: 'Could not open workbook' } }
  }

  const parsedData = {}
  const errors = {}

  try { parsedData.cogs_summary = parseCogsSummary(wb) } catch (e) { errors.cogs_summary = e?.message || 'Unknown' }
  try { parsedData.ground_sold  = captureRaw(wb, 'Ground Sold') } catch (e) { errors.ground_sold = e?.message || 'Unknown' }
  try { parsedData.pos_shipped  = captureRaw(wb, 'POs Shipped') } catch (e) { errors.pos_shipped = e?.message || 'Unknown' }
  try { parsedData.schu_on_hand = captureRaw(wb, 'Schu On Hand Oct') } catch (e) { errors.schu_on_hand = e?.message || 'Unknown' }

  return { parsedData, errors }
}

/* ═══════════════════════════════════════════════════════════════════════
   COGS Summary — monthly roll-forward
   Structure: line items in column A, months across columns
   First row: Paramount COGS / 2024 / 2025 / 2025.1 / 2025.2 / 2025.3 / blank / 2025.4 / Actual Invoices / COGS Variance
   Second row: 'Month' / 'Dec' / 'Jan' / 'Feb' / 'Mar' / 'Apr' / blank / 'YTD' / 'Actual Invoices' / 'COGS Variance'
   So we have month labels in row 2 (index 1), columns 1-9
   Then line items in column 0 starting row 3
   ═══════════════════════════════════════════════════════════════════════ */
function parseCogsSummary(wb) {
  const matrix = getSheetMatrix(wb, 'COGS Summary')
  if (!matrix) throw new Error('COGS Summary sheet not found')

  // Find the 'Month' label row — that's our month-axis header
  let monthRowIdx = -1
  for (let i = 0; i < Math.min(matrix.length, 10); i++) {
    const row = matrix[i] || []
    if (row.some(c => String(c || '').toLowerCase().trim() === 'month')) {
      monthRowIdx = i
      break
    }
  }
  if (monthRowIdx < 0) throw new Error('COGS Summary: could not find "Month" header row')

  const monthRow = matrix[monthRowIdx]
  // Build column → month mapping
  const monthColumns = []
  for (let ci = 1; ci < monthRow.length; ci++) {
    const v = toStr(monthRow[ci])
    if (!v) continue
    monthColumns.push({ col: ci, label: v })
  }

  // Walk down column A — each non-empty value is a line_item
  const rows = []
  for (let i = monthRowIdx + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    const lineItem = toStr(row[0])
    if (!lineItem) continue

    // Emit one row per (line_item, month) where the cell has a value
    for (const mc of monthColumns) {
      const amount = toNumber(row[mc.col])
      if (amount == null) continue
      rows.push({
        line_item:    lineItem,
        month_label:  mc.label,
        month_num:    monthLabelToNum(mc.label),
        amount,
        raw_row: { line_item: lineItem, month: mc.label, amount },
      })
    }
  }
  return rows
}

/* ─── Capture all rows of a sheet as raw_row JSONB ──────────────────── */
function captureRaw(wb, sheetName) {
  const matrix = getSheetMatrix(wb, sheetName)
  if (!matrix) throw new Error(`${sheetName} sheet not found`)

  // Identify the header row by finding the first row with multiple non-empty cells
  let headerRowIdx = 0
  let headerLabels = []
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const row = matrix[i] || []
    const nonNull = row.filter(c => c != null)
    if (nonNull.length >= 2) {
      headerRowIdx = i
      headerLabels = row.map(c => c == null ? '' : String(c).trim())
      break
    }
  }

  const rows = []
  for (let i = headerRowIdx + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    rows.push({ raw_row: buildRawRow(row, headerLabels) })
  }
  return rows
}
