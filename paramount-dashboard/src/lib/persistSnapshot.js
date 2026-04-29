import { supabase } from '../supabase'

/**
 * persistSnapshot.js — universal write path for parsed file data.
 *
 * Called from two future places:
 *   1. Manual upload UI (Stage B/C of this push)
 *   2. ShareFile auto-fetch scheduled function (future)
 *
 * Both invoke the same parser and then this same persistence helper.
 *
 * Flow:
 *   1. Insert one row into data_snapshots with status='parsing'
 *   2. Bulk-insert all child rows linked to that snapshot_id
 *   3. Mark the snapshot is_current=true and status='success'
 *      (the trigger on data_snapshots auto-clears is_current on prior snapshots)
 *   4. If any step fails, mark status='failed' and DO NOT set is_current
 *
 * Returns:
 *   { ok: true,  snapshot_id, rows_written: { sheet_name: count } }
 *   { ok: false, snapshot_id?, error }
 *
 * The snapshot row is created EVEN ON FAILURE so we have an audit trail of
 * "someone tried to upload at 9:14am and it broke." Failed snapshots have
 * status='failed' and is_current=false.
 */

// Map from file_kind → { sheet_name → child_table_name }
// This drives where rows from each parsed sheet get written
const CHILD_TABLE_MAP = {
  wip: {
    rollup_lines:      'wip_rollup_lines',
    monthly_pacing:    'wip_monthly_pacing',
    production_lines:  'wip_production_lines',
    color_yards:       'wip_color_yards',
    written_invoiced:  'wip_written_invoiced',
  },
  mos: {
    materials:           'mos_materials',
    open_pos:            'mos_open_pos',
    monthly_velocity:    'mos_monthly_velocity',
    received:            'mos_received',
    inv_reconciliation:  'mos_inv_reconciliation',
    ground_est_ship:     'mos_ground_est_ship',
  },
  inventory: {
    cogs_summary: 'inv_cogs_summary',
    ground_sold:  'inv_ground_sold',
    pos_shipped:  'inv_pos_shipped',
    schu_on_hand: 'inv_schu_on_hand',
  },
}

/**
 * Main entry point.
 *
 * @param {Object} params
 * @param {'wip'|'mos'|'inventory'} params.fileKind
 * @param {string} params.sourceFile - original filename
 * @param {number} params.fileSizeBytes
 * @param {string} params.source - 'manual_upload' | 'sharefile_auto' | 'api'
 * @param {Object} params.authUser - { id, email } from supabase.auth
 * @param {Object} params.parsedData - { sheet_key: [rows], ... } from the parser
 * @param {Object} params.errors - { sheet_key: error_message } for any sheets that failed
 * @param {number} params.parseDurationMs
 * @param {string} [params.notes]
 *
 * @returns {Promise<{ok, snapshot_id, rows_written?, error?}>}
 */
export async function persistSnapshot({
  fileKind,
  sourceFile,
  fileSizeBytes,
  source = 'manual_upload',
  authUser,
  parsedData,
  errors = {},
  parseDurationMs,
  notes,
}) {
  // Validate fileKind
  if (!CHILD_TABLE_MAP[fileKind]) {
    return { ok: false, error: `Unknown file_kind: ${fileKind}` }
  }

  // Build sheets_parsed summary: { sheet_key: row_count }
  const sheetsParsed = {}
  for (const [sheetKey, rows] of Object.entries(parsedData || {})) {
    sheetsParsed[sheetKey] = Array.isArray(rows) ? rows.length : 0
  }

  // Determine status
  // - 'failed' if no sheets parsed at all
  // - 'partial' if some sheets parsed but others errored
  // - 'success' if all expected sheets parsed without errors
  const expectedSheets = Object.keys(CHILD_TABLE_MAP[fileKind])
  const parsedSheetCount = Object.values(sheetsParsed).filter(c => c > 0).length
  const errorCount = Object.keys(errors).length
  let status
  if (parsedSheetCount === 0)                                          status = 'failed'
  else if (errorCount > 0 || parsedSheetCount < expectedSheets.length) status = 'partial'
  else                                                                  status = 'success'

  // ─── Step 1: Insert parent snapshot row ───────────────────────────────
  const { data: snapshot, error: snapErr } = await supabase
    .from('data_snapshots')
    .insert({
      file_kind: fileKind,
      uploaded_by: authUser?.id || null,
      uploaded_by_email: authUser?.email || null,
      source_file: sourceFile,
      file_size_bytes: fileSizeBytes,
      source,
      status: 'parsing',  // upgrade after children written
      sheets_parsed: sheetsParsed,
      errors,
      parse_duration_ms: parseDurationMs,
      notes: notes || null,
      is_current: false,  // become current only after success
    })
    .select()
    .single()

  if (snapErr || !snapshot) {
    console.error('persistSnapshot: failed to insert parent', snapErr)
    return { ok: false, error: snapErr?.message || 'Snapshot insert failed' }
  }

  const snapshotId = snapshot.id

  // ─── Step 2: Insert child rows for each sheet ─────────────────────────
  const childMap = CHILD_TABLE_MAP[fileKind]
  const rowsWritten = {}
  const writeErrors = []

  for (const [sheetKey, rows] of Object.entries(parsedData || {})) {
    const tableName = childMap[sheetKey]
    if (!tableName) {
      writeErrors.push(`Unknown sheet key for ${fileKind}: ${sheetKey}`)
      continue
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      rowsWritten[sheetKey] = 0
      continue
    }

    // Stamp every row with snapshot_id
    const stamped = rows.map(r => ({ ...r, snapshot_id: snapshotId }))

    // Insert in batches of 500 to avoid request size limits
    // Production WIP can have ~1600 rows; MOS materials ~480
    const BATCH = 500
    let insertedCount = 0
    for (let i = 0; i < stamped.length; i += BATCH) {
      const batch = stamped.slice(i, i + BATCH)
      const { error: insErr, count } = await supabase
        .from(tableName)
        .insert(batch, { count: 'exact' })
      if (insErr) {
        writeErrors.push(`${sheetKey} batch ${i}-${i + batch.length}: ${insErr.message}`)
        // Don't fail the whole thing — keep going, capture error
      } else {
        insertedCount += (count ?? batch.length)
      }
    }
    rowsWritten[sheetKey] = insertedCount
  }

  // ─── Step 3: Finalize the snapshot ────────────────────────────────────
  const finalStatus = writeErrors.length > 0
    ? (Object.values(rowsWritten).some(c => c > 0) ? 'partial' : 'failed')
    : status

  // Only mark is_current=true if status is success OR partial with at least
  // some data. Failed snapshots stay invisible to the dashboard.
  const shouldBecomeCurrent = finalStatus === 'success' || finalStatus === 'partial'

  // Combine original errors with any write errors
  const finalErrors = { ...errors }
  if (writeErrors.length > 0) finalErrors._write_errors = writeErrors

  const { error: updErr } = await supabase
    .from('data_snapshots')
    .update({
      status: finalStatus,
      is_current: shouldBecomeCurrent,
      sheets_parsed: rowsWritten,
      errors: finalErrors,
    })
    .eq('id', snapshotId)

  if (updErr) {
    console.error('persistSnapshot: failed to update parent', updErr)
    return {
      ok: false,
      snapshot_id: snapshotId,
      error: `Children written but parent finalize failed: ${updErr.message}`,
    }
  }

  return {
    ok: finalStatus !== 'failed',
    snapshot_id: snapshotId,
    rows_written: rowsWritten,
    status: finalStatus,
    write_errors: writeErrors.length > 0 ? writeErrors : undefined,
  }
}

/**
 * Get the current snapshot for a file_kind (or null if none).
 * Used by the upload UI to display "last successful upload at...".
 */
export async function getCurrentSnapshot(fileKind) {
  const { data, error } = await supabase
    .from('data_snapshots')
    .select('*')
    .eq('file_kind', fileKind)
    .eq('is_current', true)
    .maybeSingle()
  if (error) {
    console.error('getCurrentSnapshot:', error)
    return null
  }
  return data
}

/**
 * Get the full upload history for a file_kind, most recent first.
 * Useful for the admin's "show me recent uploads" view.
 */
export async function getSnapshotHistory(fileKind, limit = 30) {
  const { data, error } = await supabase
    .from('data_snapshots')
    .select('*')
    .eq('file_kind', fileKind)
    .order('uploaded_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('getSnapshotHistory:', error)
    return []
  }
  return data || []
}
