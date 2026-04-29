/**
 * parserHelpers.js — shared utilities for pivot-table parsing.
 *
 * The Excel files we ingest are pivot table outputs from LIFT. They share
 * common patterns that need helper functions:
 *   - Filter context rows at the top to skip
 *   - Header rows at varying positions — find by content
 *   - Forward-fill merged cells (Division column blank for indented rows)
 *   - Subtotal rows that need to be detected and either skipped or flagged
 *   - Safe number/date parsing (Excel sends nulls, strings, numbers, dates)
 */

import * as XLSX from 'xlsx'

/* ─── Workbook reading ───────────────────────────────────────────────── */

/**
 * Read a workbook from an ArrayBuffer.
 * Returns the XLSX workbook object or null on failure.
 */
export function readWorkbook(buffer) {
  try {
    return XLSX.read(buffer, { type: 'array', cellDates: true })
  } catch (e) {
    console.error('readWorkbook failed:', e)
    return null
  }
}

/**
 * Get a sheet's rows as a 2D array (no header inference).
 * Each row is an array of cell values aligned to column positions.
 * Empty cells are null (not undefined).
 */
export function getSheetMatrix(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName]
  if (!ws) return null
  // header: 1 = use first row, defval: null = preserve column alignment
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false })
  return matrix
}

/* ─── Header row detection ───────────────────────────────────────────── */

/**
 * Find the header row in a sheet by searching for a row that contains
 * all (or most) of the expected column labels.
 *
 * Returns { headerRow: number, headerLabels: string[] } or null.
 *
 * @param {Array<Array>} matrix - sheet rows
 * @param {string[]} expectedLabels - labels we expect in the header row
 * @param {number} minMatches - minimum number of matches to call it a header (default: half)
 */
export function findHeaderRow(matrix, expectedLabels, minMatches = null) {
  const min = minMatches ?? Math.ceil(expectedLabels.length / 2)
  const lcExpected = expectedLabels.map(l => l.toLowerCase().trim())
  for (let i = 0; i < Math.min(matrix.length, 20); i++) {
    const row = matrix[i] || []
    const cells = row.map(c => c == null ? '' : String(c).toLowerCase().trim())
    let matches = 0
    for (const exp of lcExpected) {
      if (cells.some(c => c === exp || c.includes(exp))) matches++
    }
    if (matches >= min) {
      return { headerRow: i, headerLabels: row.map(c => c == null ? '' : String(c).trim()) }
    }
  }
  return null
}

/* ─── Subtotal detection ─────────────────────────────────────────────── */

/**
 * Detect if a row is a subtotal/total row.
 * Looks for "Total" / "Grand Total" / "Subtotal" anywhere in the row.
 */
export function isSubtotalRow(row) {
  if (!Array.isArray(row)) return false
  for (const cell of row) {
    if (cell == null) continue
    const s = String(cell).toLowerCase()
    if (s.includes('total') || s.includes('subtotal') || s.includes('grand')) {
      return true
    }
  }
  return false
}

/* ─── Forward-fill ───────────────────────────────────────────────────── */

/**
 * Forward-fill blank cells in a column for "merged-style" pivot tables.
 * Mutates the input matrix.
 *
 * Example: Division column has 'Screen Print' on row 5 then blank on rows 6-9.
 * After forward-fill, rows 6-9 also have 'Screen Print'.
 *
 * @param {Array<Array>} matrix
 * @param {number[]} colIndices - column indices to forward-fill
 * @param {number} startRow - row to start filling from (after header)
 */
export function forwardFill(matrix, colIndices, startRow = 0) {
  const lastSeen = {}
  for (let i = startRow; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row) continue
    for (const ci of colIndices) {
      if (row[ci] == null || String(row[ci]).trim() === '') {
        if (lastSeen[ci] !== undefined) row[ci] = lastSeen[ci]
      } else {
        lastSeen[ci] = row[ci]
      }
    }
  }
  return matrix
}

/* ─── Safe value coercion ────────────────────────────────────────────── */

/**
 * Convert a cell value to a number, returning null on failure.
 * Handles: numbers, numeric strings, '$1,234.56', percentages, blanks.
 */
export function toNumber(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '').replace(/%$/, '')
    if (cleaned === '' || cleaned === '-') return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Convert a cell value to an integer, returning null on failure.
 */
export function toInt(v) {
  const n = toNumber(v)
  if (n == null) return null
  return Math.round(n)
}

/**
 * Convert a cell value to a date (ISO YYYY-MM-DD), returning null on failure.
 * SheetJS with cellDates:true gives us Date objects directly.
 */
export function toDateISO(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null
    return v.toISOString().slice(0, 10)
  }
  if (typeof v === 'number') {
    // Excel serial date — convert via SheetJS helper if needed
    // SheetJS already converts these when cellDates:true is set on read
    return null
  }
  if (typeof v === 'string') {
    const d = new Date(v)
    if (isNaN(d.getTime())) return null
    return d.toISOString().slice(0, 10)
  }
  return null
}

/**
 * Convert a cell to a clean string, or null if blank.
 */
export function toStr(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (s === '' || s === '(blank)') return null
  return s
}

/* ─── Month label → number ───────────────────────────────────────────── */

const MONTH_MAP = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

export function monthLabelToNum(label) {
  if (label == null) return null
  const s = String(label).toLowerCase().trim()
  return MONTH_MAP[s] || null
}

/* ─── Build column index map ─────────────────────────────────────────── */

/**
 * Build a map from logical column name → column index.
 * Tolerant matching: case-insensitive, ignores whitespace differences.
 *
 * @param {string[]} headerLabels - the actual header row labels
 * @param {Object<string, string|RegExp>} mappings - logical name → expected label or regex
 * @returns {Object<string, number>} - logical name → column index (or -1 if not found)
 */
export function buildColumnMap(headerLabels, mappings) {
  const result = {}
  const normHeaders = headerLabels.map(h => (h == null ? '' : String(h).toLowerCase().replace(/\s+/g, ' ').trim()))
  for (const [logicalName, expected] of Object.entries(mappings)) {
    let foundIdx = -1
    if (expected instanceof RegExp) {
      foundIdx = normHeaders.findIndex(h => expected.test(h))
    } else {
      const target = String(expected).toLowerCase().replace(/\s+/g, ' ').trim()
      foundIdx = normHeaders.findIndex(h => h === target)
      if (foundIdx === -1) foundIdx = normHeaders.findIndex(h => h.includes(target))
    }
    result[logicalName] = foundIdx
  }
  return result
}

/**
 * Get a value by logical column name from a row, using a column map.
 */
export function getCol(row, columnMap, logicalName) {
  const idx = columnMap[logicalName]
  if (idx == null || idx < 0) return null
  return row[idx]
}

/* ─── Bulk row capture for raw_row JSONB ─────────────────────────────── */

/**
 * Build a raw_row JSONB blob from a row + header labels.
 * Used to capture the original data when we don't model every column explicitly.
 */
export function buildRawRow(row, headerLabels) {
  const obj = {}
  for (let i = 0; i < (headerLabels?.length || 0); i++) {
    const key = headerLabels[i]
    if (key && key.trim() !== '') {
      const v = row[i]
      if (v instanceof Date) obj[key] = v.toISOString()
      else obj[key] = v
    }
  }
  return obj
}
