/**
 * fileFingerprint.js — verify uploaded files are what they claim to be.
 *
 * Each of the three files has a stable signature: which sheets exist,
 * what the file's name pattern looks like. We use this to catch
 * "user uploaded WIP file to MOS slot" before wasting time parsing.
 *
 * Returns { ok: true, fileKind } if the file matches the expected slot,
 * or { ok: false, error, suggestedKind? } if it looks like a different file.
 *
 * Uses SheetJS to peek at sheet names without parsing data.
 *
 * This is fast — typically <200ms even for the 17MB inventory file because
 * we only read the workbook structure, not data.
 */

import * as XLSX from 'xlsx'

// Each file_kind has a fingerprint: required sheets that must exist + filename hint
const FILE_FINGERPRINTS = {
  wip: {
    label: 'WIP file',
    expectedFilenameHint: /data.?for.?wip/i,
    requiredSheets: ['WIP', 'YTD Plan vs Act', 'Production WIP'],
    optionalSheets: ['Color Yards', 'Written Prod Invoiced'],
  },
  mos: {
    label: 'MOS file',
    expectedFilenameHint: /api.?dashboard.?mos|mos.?3/i,
    requiredSheets: ['MOS Material - Color', 'Open POs'],
    optionalSheets: ['Monthly Velocity', 'Recvd Curr Month', 'Inv Reconciliation', 'Ground Est Ship'],
  },
  inventory: {
    label: 'Inventory file',
    expectedFilenameHint: /paramount.?inventory.?reporting/i,
    requiredSheets: ['COGS Summary', 'Ground Sold'],
    optionalSheets: ['POs Shipped', 'Schu On Hand Oct'],
  },
}

/**
 * Read just the workbook structure (sheet names) without parsing cell data.
 *
 * @param {ArrayBuffer} buffer - the raw file content
 * @returns {{ sheetNames: string[], error?: string }}
 */
export function getSheetNames(buffer) {
  try {
    // bookSheets: true → only read sheet names, not cell data — much faster
    const wb = XLSX.read(buffer, { bookSheets: true, type: 'array' })
    return { sheetNames: wb.SheetNames || [] }
  } catch (e) {
    return { sheetNames: [], error: e?.message || 'Failed to read workbook' }
  }
}

/**
 * Check if a file matches an expected fileKind.
 *
 * @param {ArrayBuffer} buffer
 * @param {string} filename
 * @param {'wip'|'mos'|'inventory'} expectedKind
 * @returns {{ ok, fileKind?, error?, suggestedKind?, sheetNames?, missingSheets? }}
 */
export function validateFile(buffer, filename, expectedKind) {
  const fp = FILE_FINGERPRINTS[expectedKind]
  if (!fp) {
    return { ok: false, error: `Unknown file kind: ${expectedKind}` }
  }

  // Read sheet names
  const { sheetNames, error } = getSheetNames(buffer)
  if (error) {
    return { ok: false, error: `Could not read workbook: ${error}` }
  }
  if (sheetNames.length === 0) {
    return { ok: false, error: 'Workbook contains no sheets' }
  }

  // Check required sheets are present
  const missing = fp.requiredSheets.filter(s => !sheetNames.includes(s))
  if (missing.length > 0) {
    // It's not the file we expected — maybe it's a different one
    const suggested = guessFileKind(sheetNames, filename)
    return {
      ok: false,
      error: `This file is missing required sheets for ${fp.label}: ${missing.join(', ')}`,
      missingSheets: missing,
      sheetNames,
      suggestedKind: suggested && suggested !== expectedKind ? suggested : undefined,
    }
  }

  return {
    ok: true,
    fileKind: expectedKind,
    sheetNames,
  }
}

/**
 * Guess which file_kind a file most likely is, by checking which
 * fingerprint it best matches. Used when the user uploads to the wrong slot.
 *
 * @param {string[]} sheetNames
 * @param {string} filename
 * @returns {'wip'|'mos'|'inventory'|null}
 */
export function guessFileKind(sheetNames, filename = '') {
  let bestMatch = null
  let bestScore = 0
  for (const [kind, fp] of Object.entries(FILE_FINGERPRINTS)) {
    let score = 0
    // Required sheets matched
    for (const s of fp.requiredSheets) {
      if (sheetNames.includes(s)) score += 10
    }
    // Optional sheets matched
    for (const s of (fp.optionalSheets || [])) {
      if (sheetNames.includes(s)) score += 2
    }
    // Filename hint
    if (filename && fp.expectedFilenameHint.test(filename)) {
      score += 5
    }
    if (score > bestScore) {
      bestScore = score
      bestMatch = kind
    }
  }
  // Need at least one full required-sheet match to call it
  return bestScore >= 10 ? bestMatch : null
}

/**
 * Get a friendly label for a fileKind ("WIP file", "MOS file", etc.)
 */
export function fileKindLabel(fileKind) {
  return FILE_FINGERPRINTS[fileKind]?.label || fileKind
}

/**
 * Get the expected filename hint pattern (for UI hints).
 */
export function expectedFilenamePattern(fileKind) {
  const fp = FILE_FINGERPRINTS[fileKind]
  if (!fp) return null
  return {
    wip: 'Data_for_WIP.xlsx',
    mos: 'API_Dashboard_MOS_3_0.xlsx',
    inventory: 'Paramount_Inventory_Reporting_2026.xlsx',
  }[fileKind]
}
