// src/lib/parsers/parseMosMaterialColor.js
//
// Parses the "MOS Material - Color" sheet from API_Dashboard_MOS_3_0.xlsx.
// Headers live on row 7 (1-indexed). The "Order Type Screen All Together"
// column groups SKUs into buckets — the column is sparse (forward-fill required)
// and contains subtotal rows ("Schumacher Total", "Screen Print Total", etc.)
// plus a "Grand Total" footer that we filter out.
//
// Returns { source_type, rows } ready to hand to persistSnapshot().
// ----------------------------------------------------------------------------

import {
  readWorkbook,
  findHeaderRow,
  isSubtotalRow,
  forwardFill,
  toNumber,
  toInt,
  toStr,
  toDateISO,
  buildColumnMap,
  buildRawRow,
} from './parserHelpers.js';

const SHEET_NAME = 'MOS Material - Color';

// Map between sheet column header (left) and DB column (right)
const COLUMN_MAP = {
  'Order Type Screen All Together':       { col: 'order_type',                         type: 'str'   },
  'Replacement Ground':                   { col: 'replacement_ground',                 type: 'str'   },

  'PO Open Qty':                          { col: 'po_open_qty',                        type: 'num'   },
  'Min Due Date':                         { col: 'min_due_date',                       type: 'date'  },
  'Max Due Date':                         { col: 'max_due_date',                       type: 'date'  },
  'CountD Open PO Dates':                 { col: 'countd_open_po_dates',               type: 'int'   },

  'On Hand Qty':                          { col: 'on_hand_qty',                        type: 'num'   },
  'WIP Ground':                           { col: 'wip_ground',                         type: 'num'   },
  'WIP Yards':                            { col: 'wip_yards',                          type: 'num'   },
  'WIP Total':                            { col: 'wip_total',                          type: 'num'   },
  'Curr Available NO Ground':             { col: 'curr_available_no_ground',           type: 'num'   },
  'Curr Available On Hand':               { col: 'curr_available_on_hand',             type: 'num'   },
  'Available On Hand With Open POs':      { col: 'available_on_hand_with_open_pos',    type: 'num'   },

  'Ground Written Last 6 Months':         { col: 'ground_written_last_6_months',       type: 'num'   },
  'Avg Monthly Last 6 Months':            { col: 'avg_monthly_last_6_months',          type: 'num'   },
  'Avg Monthly Last 12 Months':           { col: 'avg_monthly_last_12_months',         type: 'num'   },
  'Avg Last 6 & 12 Monthly Yards':        { col: 'avg_last_6_12_monthly_yards',        type: 'num'   },
  'Yards Written Last 30 Days':           { col: 'yards_written_last_30_days',         type: 'num'   },

  'MOS Based on Last 6 & 12 Month Sales': { col: 'mos_based_on_6_12',                  type: 'num'   },
  'Calc Buy in Yards +2 Months':          { col: 'calc_buy_yards_plus_2_months',       type: 'num'   },
  'Months of Lead Time':                  { col: 'months_of_lead_time',                type: 'num'   },
  'Target MOS +2 Month':                  { col: 'target_mos_plus_2',                  type: 'num'   },
  'Var MOS vs Target +2':                 { col: 'var_mos_vs_target_plus_2',           type: 'num'   },
};

// Subtotal/footer rows we filter out (keyed on order_type or replacement_ground)
const SUBTOTAL_VALUES = new Set([
  'Grand Total',
  'Schumacher Total',
  'Screen Print Total',
  'Digital Total',
]);

const VALID_BUCKETS = new Set(['Schumacher', 'Screen Print', 'Digital']);

function castValue(raw, type) {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (type) {
    case 'str':  return toStr(raw);
    case 'num':  return toNumber(raw);
    case 'int':  return toInt(raw);
    case 'date': return toDateISO(raw);
    default:     return raw;
  }
}

/**
 * Parse the MOS Material - Color sheet from a workbook (already loaded via SheetJS).
 *
 * @param {object} workbook  SheetJS workbook
 * @returns {{ source_type: string, rows: Array<object> }}
 */
export function parseMosMaterialColor(workbook) {
  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) {
    throw new Error(`Sheet "${SHEET_NAME}" not found in workbook`);
  }

  // Sheet is a pivot — first 6 rows are filter dropdowns. Headers on row 7.
  // findHeaderRow scans for the row containing both 'Order Type Screen All Together'
  // and 'Replacement Ground' to be resilient if rows shift.
  const aoa = readWorkbook(sheet, { header: 1, defval: null, raw: true });
  const headerRowIdx = findHeaderRow(aoa, ['Order Type Screen All Together', 'Replacement Ground']);
  if (headerRowIdx === -1) {
    throw new Error(`Could not locate header row in "${SHEET_NAME}"`);
  }

  const headers = aoa[headerRowIdx];
  const dataRows = aoa.slice(headerRowIdx + 1);

  // Forward-fill the bucket column — pivot table leaves it blank between rows
  const orderTypeColIdx = headers.indexOf('Order Type Screen All Together');
  const filledRows = forwardFill(dataRows, orderTypeColIdx);

  const colMap = buildColumnMap(headers, COLUMN_MAP);

  const rows = [];
  for (const r of filledRows) {
    const orderTypeRaw = r[orderTypeColIdx];
    const replacementGround = r[headers.indexOf('Replacement Ground')];

    // Skip subtotal/footer rows
    if (isSubtotalRow(orderTypeRaw, SUBTOTAL_VALUES) || isSubtotalRow(replacementGround, SUBTOTAL_VALUES)) {
      continue;
    }

    // Skip if no SKU on the row (blank line)
    if (!replacementGround) continue;

    // Skip if bucket isn't one we recognize (defensive — pivot might add "Other")
    if (!VALID_BUCKETS.has(toStr(orderTypeRaw))) continue;

    const out = {};
    for (const [headerName, def] of Object.entries(COLUMN_MAP)) {
      const idx = colMap[headerName];
      const raw = idx >= 0 ? r[idx] : null;
      out[def.col] = castValue(raw, def.type);
    }

    // Stash the raw row for fallback / future fields
    out.raw_row = buildRawRow(headers, r);

    rows.push(out);
  }

  return {
    source_type: 'mos_material_color',
    rows,
  };
}

export default parseMosMaterialColor;
