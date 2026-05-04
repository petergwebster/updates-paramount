// src/lib/parsers/parseMosMaterialColor.js
//
// Parses the "MOS Material - Color" sheet from API_Dashboard_MOS_3_0.xlsx.
// Self-contained — does not depend on parserHelpers.js. Returns the
// { sheet_key: rows } shape that persistSnapshot.js expects.
//
// Headers live ~row 7 (1-indexed). The "Order Type Screen All Together"
// column groups SKUs into buckets — sparse pivot column needs forward-fill.
// Filters out subtotal rows ("Schumacher Total", "Grand Total", etc.).
// ----------------------------------------------------------------------------

import * as XLSX from 'xlsx';

const SHEET_NAME = 'MOS Material - Color';

const VALID_BUCKETS = new Set(['Schumacher', 'Screen Print', 'Digital']);
const SUBTOTAL_VALUES = new Set([
  'Grand Total',
  'Schumacher Total',
  'Screen Print Total',
  'Digital Total',
]);

// Header → DB column mapping
const COLUMN_MAP = {
  'Order Type Screen All Together':       { col: 'order_type',                         type: 'str'  },
  'Replacement Ground':                   { col: 'replacement_ground',                 type: 'str'  },
  'PO Open Qty':                          { col: 'po_open_qty',                        type: 'num'  },
  'Min Due Date':                         { col: 'min_due_date',                       type: 'date' },
  'Max Due Date':                         { col: 'max_due_date',                       type: 'date' },
  'CountD Open PO Dates':                 { col: 'countd_open_po_dates',               type: 'int'  },
  'On Hand Qty':                          { col: 'on_hand_qty',                        type: 'num'  },
  'WIP Ground':                           { col: 'wip_ground',                         type: 'num'  },
  'WIP Yards':                            { col: 'wip_yards',                          type: 'num'  },
  'WIP Total':                            { col: 'wip_total',                          type: 'num'  },
  'Curr Available NO Ground':             { col: 'curr_available_no_ground',           type: 'num'  },
  'Curr Available On Hand':               { col: 'curr_available_on_hand',             type: 'num'  },
  'Available On Hand With Open POs':      { col: 'available_on_hand_with_open_pos',    type: 'num'  },
  'Ground Written Last 6 Months':         { col: 'ground_written_last_6_months',       type: 'num'  },
  'Avg Monthly Last 6 Months':            { col: 'avg_monthly_last_6_months',          type: 'num'  },
  'Avg Monthly Last 12 Months':           { col: 'avg_monthly_last_12_months',         type: 'num'  },
  'Avg Last 6 & 12 Monthly Yards':        { col: 'avg_last_6_12_monthly_yards',        type: 'num'  },
  'Yards Written Last 30 Days':           { col: 'yards_written_last_30_days',         type: 'num'  },
  'MOS Based on Last 6 & 12 Month Sales': { col: 'mos_based_on_6_12',                  type: 'num'  },
  'Calc Buy in Yards +2 Months':          { col: 'calc_buy_yards_plus_2_months',       type: 'num'  },
  'Months of Lead Time':                  { col: 'months_of_lead_time',                type: 'num'  },
  'Target MOS +2 Month':                  { col: 'target_mos_plus_2',                  type: 'num'  },
  'Var MOS vs Target +2':                 { col: 'var_mos_vs_target_plus_2',           type: 'num'  },
};

// ---------- inlined helpers ----------
function toStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function toInt(v) {
  const n = toNum(v);
  return n == null ? null : Math.round(n);
}
function toDateISO(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  // Excel serial date number
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function findHeaderRow(aoa, requiredHeaders) {
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i] || [];
    if (requiredHeaders.every(h => row.includes(h))) return i;
  }
  return -1;
}

function forwardFillColumn(rows, colIdx) {
  let last = null;
  const out = [];
  for (const r of rows) {
    const copy = [...r];
    const v = copy[colIdx];
    if (v != null && v !== '') {
      last = v;
    } else {
      copy[colIdx] = last;
    }
    out.push(copy);
  }
  return out;
}

// ---------- main ----------
/**
 * Parse the MOS Material - Color sheet.
 * @param {object} workbook  SheetJS workbook
 * @returns {{ material_color: Array<object> }}  shape that persistSnapshot expects
 */
export function parseMosMaterialColor(workbook) {
  const sheet = workbook?.Sheets?.[SHEET_NAME];
  if (!sheet) {
    throw new Error(`Sheet "${SHEET_NAME}" not found in workbook`);
  }

  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  if (!Array.isArray(aoa) || aoa.length === 0) {
    throw new Error(`Sheet "${SHEET_NAME}" is empty`);
  }

  const headerRowIdx = findHeaderRow(aoa, ['Order Type Screen All Together', 'Replacement Ground']);
  if (headerRowIdx === -1) {
    throw new Error(`Header row not found in "${SHEET_NAME}".`);
  }

  const headers = aoa[headerRowIdx];
  const orderTypeIdx = headers.indexOf('Order Type Screen All Together');
  const skuIdx       = headers.indexOf('Replacement Ground');

  const headerIdx = {};
  for (const headerName of Object.keys(COLUMN_MAP)) {
    headerIdx[headerName] = headers.indexOf(headerName);
  }

  const dataRows = aoa.slice(headerRowIdx + 1);
  const filled = forwardFillColumn(dataRows, orderTypeIdx);

  const rows = [];
  for (const r of filled) {
    const orderType = toStr(r[orderTypeIdx]);
    const sku       = toStr(r[skuIdx]);

    if (!sku) continue;
    if (SUBTOTAL_VALUES.has(orderType) || SUBTOTAL_VALUES.has(sku)) continue;
    if (!VALID_BUCKETS.has(orderType)) continue;

    const out = {};
    for (const [headerName, def] of Object.entries(COLUMN_MAP)) {
      const idx = headerIdx[headerName];
      const raw = idx >= 0 ? r[idx] : null;
      switch (def.type) {
        case 'str':  out[def.col] = toStr(raw);     break;
        case 'num':  out[def.col] = toNum(raw);     break;
        case 'int':  out[def.col] = toInt(raw);     break;
        case 'date': out[def.col] = toDateISO(raw); break;
        default:     out[def.col] = raw;
      }
    }

    const raw_row = {};
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]) raw_row[headers[i]] = r[i];
    }
    out.raw_row = raw_row;

    rows.push(out);
  }

  return { material_color: rows };
}

export default parseMosMaterialColor;
