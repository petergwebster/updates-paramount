/**
 * parseWipFile.js — parser for Data_for_WIP.xlsx
 *
 * Sheets parsed:
 *   1. WIP                  → wip_rollup_lines     (9-status rollup by division/customer)
 *   2. YTD Plan vs Act      → wip_monthly_pacing   (monthly Plan vs Actual per division)
 *   3. Production WIP       → wip_production_lines (line-level open WIP, ~1600 rows)
 *   4. Color Yards          → wip_color_yards      (per-color-count breakdown)
 *   5. Written Prod Invoiced → wip_written_invoiced (weekly time series, long format)
 *
 * Each sheet parser is a try/catch unit. If one fails, others still run.
 * Returns: { parsedData: { sheet_key: rows[] }, errors: { sheet_key: msg } }
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
  monthLabelToNum,
  buildColumnMap,
  getCol,
  buildRawRow,
} from './parserHelpers.js'

export async function parseWipFile(buffer) {
  const wb = readWorkbook(buffer)
  if (!wb) {
    return {
      parsedData: {},
      errors: { _workbook: 'Could not open workbook' },
    }
  }

  const parsedData = {}
  const errors = {}

  // ─── 1. WIP rollup ─────────────────────────────────────────────
  try {
    parsedData.rollup_lines = parseWipRollup(wb)
  } catch (e) {
    console.error('parseWipRollup failed:', e)
    errors.rollup_lines = e?.message || 'Unknown error'
  }

  // ─── 2. YTD Plan vs Act ────────────────────────────────────────
  try {
    parsedData.monthly_pacing = parseMonthlyPacing(wb)
  } catch (e) {
    console.error('parseMonthlyPacing failed:', e)
    errors.monthly_pacing = e?.message || 'Unknown error'
  }

  // ─── 3. Production WIP ─────────────────────────────────────────
  try {
    parsedData.production_lines = parseProductionWip(wb)
  } catch (e) {
    console.error('parseProductionWip failed:', e)
    errors.production_lines = e?.message || 'Unknown error'
  }

  // ─── 4. Color Yards ────────────────────────────────────────────
  try {
    parsedData.color_yards = parseColorYards(wb)
  } catch (e) {
    console.error('parseColorYards failed:', e)
    errors.color_yards = e?.message || 'Unknown error'
  }

  // ─── 5. Written Prod Invoiced ──────────────────────────────────
  try {
    parsedData.written_invoiced = parseWrittenInvoiced(wb)
  } catch (e) {
    console.error('parseWrittenInvoiced failed:', e)
    errors.written_invoiced = e?.message || 'Unknown error'
  }

  return { parsedData, errors }
}

/* ═══════════════════════════════════════════════════════════════════════
   1. WIP rollup — 9-status breakdown by division/customer
   Structure: filter rows top, header at row containing 'Division' + 'Yards Written'
   Forward-fill: Division and 3rd Party vs House columns (merged-style indenting)
   ═══════════════════════════════════════════════════════════════════════ */
function parseWipRollup(wb) {
  const matrix = getSheetMatrix(wb, 'WIP')
  if (!matrix) throw new Error('WIP sheet not found')

  const hdr = findHeaderRow(matrix, [
    'Division', '3rd Party vs', 'Yard Order Status',
    '# of Orders Ordered', 'Yards Written', 'Income Written',
  ])
  if (!hdr) throw new Error('Could not find header row in WIP sheet')

  const colMap = buildColumnMap(hdr.headerLabels, {
    division:                'Division',
    third_party_vs_house:    /3rd party vs/i,
    yard_order_status:       'Yard Order Status',
    num_orders:              '# of Orders Ordered',
    yards_written:           'Yards Written',
    total_yards_held:        /total yards held/i,
    income_written:          'Income Written',
  })

  // Forward-fill Division and 3rd Party vs House
  forwardFill(matrix, [colMap.division, colMap.third_party_vs_house], hdr.headerRow + 1)

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    const status = toStr(getCol(row, colMap, 'yard_order_status'))
    const subtotal = isSubtotalRow(row)

    // Skip rows with no data at all (no order count, no yards, no status)
    const num = toInt(getCol(row, colMap, 'num_orders'))
    const yds = toInt(getCol(row, colMap, 'yards_written'))
    if (status == null && !subtotal && num == null && yds == null) continue

    rows.push({
      division:                toStr(getCol(row, colMap, 'division')),
      third_party_vs_house:    toStr(getCol(row, colMap, 'third_party_vs_house')),
      yard_order_status:       status,
      num_orders:              num,
      yards_written:           yds,
      total_yards_held_to_invoice: toInt(getCol(row, colMap, 'total_yards_held')),
      income_written:          toNumber(getCol(row, colMap, 'income_written')),
      is_subtotal:             subtotal,
      raw_row:                 buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════════
   2. YTD Plan vs Act — monthly Plan vs Actual per division
   Structure: header at row with 'Division' + '445 Month Label' + 'Yards Produced'
   Forward-fill: Division (Screen Print rows have Division blank for Feb/Mar/Apr)
   Subtotals: 'Screen Print Total', 'Digital Total', 'Grand Total'
   ═══════════════════════════════════════════════════════════════════════ */
function parseMonthlyPacing(wb) {
  const matrix = getSheetMatrix(wb, 'YTD Plan vs Act')
  if (!matrix) throw new Error('YTD Plan vs Act sheet not found')

  const hdr = findHeaderRow(matrix, [
    'Division', '445 Month Label', 'Yards Produced',
    'Yards Planned', 'Income Planned',
  ])
  if (!hdr) throw new Error('Could not find header row in YTD Plan vs Act sheet')

  const colMap = buildColumnMap(hdr.headerLabels, {
    division:                  'Division',
    month_label:               '445 Month Label',
    weeks:                     'Weeks',
    yards_produced:            'Yards Produced',
    income_produced:           'Income Produced',
    gross_yards_invoiced:      'Gross Yards Invoiced',
    yards_credited:            'Yards Credited',
    income_credited:           'Income Credited',
    net_yards_invoiced:        'Net Yards Invoiced',
    yards_planned:             'Yards Planned',
    yards_planned_vs_produced: /yards planned vs produced/i,
    pct_yards_produced:        /% yards produced/i,
    income_planned:            'Income Planned',
    net_income_invoiced:       'Net Income Invoiced',
  })

  forwardFill(matrix, [colMap.division], hdr.headerRow + 1)

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue

    const monthLabel = toStr(getCol(row, colMap, 'month_label'))
    const subtotal = isSubtotalRow(row)

    // For subtotal rows, the division column may have "Screen Print Total" — keep as-is
    rows.push({
      division:                  toStr(getCol(row, colMap, 'division')),
      month_label:               monthLabel,
      month_num:                 monthLabelToNum(monthLabel),
      yards_produced:            toNumber(getCol(row, colMap, 'yards_produced')),
      income_produced:           toNumber(getCol(row, colMap, 'income_produced')),
      gross_yards_invoiced:      toNumber(getCol(row, colMap, 'gross_yards_invoiced')),
      yards_credited:            toNumber(getCol(row, colMap, 'yards_credited')),
      income_credited:           toNumber(getCol(row, colMap, 'income_credited')),
      net_yards_invoiced:        toNumber(getCol(row, colMap, 'net_yards_invoiced')),
      yards_planned:             toNumber(getCol(row, colMap, 'yards_planned')),
      yards_planned_vs_produced: toNumber(getCol(row, colMap, 'yards_planned_vs_produced')),
      pct_yards_produced_vs_plan: toNumber(getCol(row, colMap, 'pct_yards_produced')),
      income_planned:            toNumber(getCol(row, colMap, 'income_planned')),
      net_income_invoiced:       toNumber(getCol(row, colMap, 'net_income_invoiced')),
      is_subtotal:               subtotal,
      raw_row:                   buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════════
   3. Production WIP — line-level open WIP
   Structure: filter rows top, header has Division/Customer Name/Order Number/etc
   ~1600 rows of detail
   ═══════════════════════════════════════════════════════════════════════ */
function parseProductionWip(wb) {
  const matrix = getSheetMatrix(wb, 'Production WIP')
  if (!matrix) throw new Error('Production WIP sheet not found')

  const hdr = findHeaderRow(matrix, [
    'Division', 'CUSTOMER NAME', 'ORDER_NUMBER', 'PO_NUMBER',
  ])
  if (!hdr) throw new Error('Could not find header row in Production WIP sheet')

  const colMap = buildColumnMap(hdr.headerLabels, {
    division:                  'Division',
    category_customer_mto:     /category customer mto/i,
    customer_name:             'CUSTOMER NAME',
    third_party_vs_house:      /3rd party vs/i,
    product_type:              'PRODUCT_TYPE',
    new_goods:                 'New Goods',
    order_number:              'ORDER_NUMBER',
    po_number:                 'PO_NUMBER',
    yards_ordered:             /yards ordered|qty.*ordered/i,
    yards_written:             'Yards Written',
    yard_order_status:         'Yard Order Status',
    date_entered:              /date entered|order.*date/i,
    date_promised:             /date promised|due.*date/i,
  })

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue

    const orderNum = toStr(getCol(row, colMap, 'order_number'))
    const subtotal = isSubtotalRow(row)
    // Skip purely empty rows; keep subtotals (parent table tracks them)
    if (!orderNum && !subtotal) continue

    rows.push({
      division:               toStr(getCol(row, colMap, 'division')),
      category_customer_mto:  toStr(getCol(row, colMap, 'category_customer_mto')),
      customer_name:          toStr(getCol(row, colMap, 'customer_name')),
      third_party_vs_house:   toStr(getCol(row, colMap, 'third_party_vs_house')),
      product_type:           toStr(getCol(row, colMap, 'product_type')),
      new_goods:              toStr(getCol(row, colMap, 'new_goods')),
      order_number:           orderNum,
      po_number:              toStr(getCol(row, colMap, 'po_number')),
      yards_ordered:          toNumber(getCol(row, colMap, 'yards_ordered')),
      yards_written:          toNumber(getCol(row, colMap, 'yards_written')),
      yard_order_status:      toStr(getCol(row, colMap, 'yard_order_status')),
      date_entered:           toDateISO(getCol(row, colMap, 'date_entered')),
      date_promised:          toDateISO(getCol(row, colMap, 'date_promised')),
      raw_row:                buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════════
   4. Color Yards — per-color-count breakdown
   Structure: filter rows top, then header row with year/month/product type/colors
   Multi-level subtotals (year/month/category)
   Forward-fill: 445 Year, 445 Month Label, Weeks, PRODUCT TYPE
   ═══════════════════════════════════════════════════════════════════════ */
function parseColorYards(wb) {
  const matrix = getSheetMatrix(wb, 'Color Yards')
  if (!matrix) throw new Error('Color Yards sheet not found')

  const hdr = findHeaderRow(matrix, [
    '445 Year', '445 Month Label', 'NUMBER_OF_COLORS', 'Yards Produced',
  ])
  if (!hdr) throw new Error('Could not find header row in Color Yards sheet')

  const colMap = buildColumnMap(hdr.headerLabels, {
    year_445:           '445 Year',
    month_label:        '445 Month Label',
    weeks:              'Weeks',
    product_type:       /product.?type/i,
    number_of_colors:   'NUMBER_OF_COLORS',
    yards_produced:     'Yards Produced',
    color_x_yards:      /color.x.yards|color x yards/i,
    ratio:              /ratio yards/i,
    net_yards_invoiced: 'Net Yards Invoiced',
    count_single:       /count of single/i,
  })

  forwardFill(matrix, [
    colMap.year_445, colMap.month_label, colMap.weeks, colMap.product_type,
  ].filter(i => i >= 0), hdr.headerRow + 1)

  const rows = []
  for (let i = hdr.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue

    const numColors = toInt(getCol(row, colMap, 'number_of_colors'))
    const subtotal = isSubtotalRow(row)
    const yards = toNumber(getCol(row, colMap, 'yards_produced'))

    if (numColors == null && !subtotal && yards == null) continue

    rows.push({
      year_445:                            toInt(getCol(row, colMap, 'year_445')),
      month_label:                         toStr(getCol(row, colMap, 'month_label')),
      month_num:                           monthLabelToNum(getCol(row, colMap, 'month_label')),
      weeks:                               toInt(getCol(row, colMap, 'weeks')),
      product_type:                        toStr(getCol(row, colMap, 'product_type')),
      number_of_colors:                    numColors,
      yards_produced:                      yards,
      color_x_yards_produced:              toNumber(getCol(row, colMap, 'color_x_yards')),
      ratio_yards_produced_to_color_yards: toNumber(getCol(row, colMap, 'ratio')),
      net_yards_invoiced:                  toNumber(getCol(row, colMap, 'net_yards_invoiced')),
      count_of_single_orders:              toInt(getCol(row, colMap, 'count_single')),
      is_subtotal:                         subtotal,
      raw_row:                             buildRawRow(row, hdr.headerLabels),
    })
  }
  return rows
}

/* ═══════════════════════════════════════════════════════════════════════
   5. Written Prod Invoiced — weekly time series, ~52 columns wide
   Structure: very wide pivot, weeks as columns
   Convert to long format: one row per (division, week, metric)
   ═══════════════════════════════════════════════════════════════════════ */
function parseWrittenInvoiced(wb) {
  const matrix = getSheetMatrix(wb, 'Written Prod Invoiced')
  if (!matrix) throw new Error('Written Prod Invoiced sheet not found')

  // This sheet is highly variable in structure. For Stage C we just capture
  // the raw rows as JSONB so the data is preserved. Future feature work can
  // refine the parse if/when we build a UI consuming this data.
  // Skip the first few filter context rows.
  let firstDataRow = 0
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const row = matrix[i] || []
    const nonNull = row.filter(c => c != null)
    if (nonNull.length >= 5) {
      firstDataRow = i
      break
    }
  }

  const headerLabels = (matrix[firstDataRow] || []).map(c => c == null ? '' : String(c).trim())

  const rows = []
  for (let i = firstDataRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every(c => c == null)) continue
    const division = toStr(row[0])

    // Capture the entire row as JSONB. Each cell becomes a key-value pair.
    // No structured columns — Stage C just preserves the data, future work
    // can unpivot when we have a feature consuming it.
    rows.push({
      division,
      week_start: null,    // To be filled by future parser refinement
      metric_name: null,
      metric_value: null,
      raw_row: buildRawRow(row, headerLabels),
    })
  }
  return rows
}
