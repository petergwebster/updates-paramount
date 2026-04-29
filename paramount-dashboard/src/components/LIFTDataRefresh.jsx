import React from 'react'
import { supabase } from '../supabase'
import UploadTile from './UploadTile'
import { parseWipFile } from '../lib/parsers/parseWipFile'
import { parseMosFile } from '../lib/parsers/parseMosFile'
import { parseInventoryFile } from '../lib/parsers/parseInventoryFile'
import { persistSnapshot } from '../lib/persistSnapshot'
import styles from './LIFTDataRefresh.module.css'

/**
 * LIFTDataRefresh — admin page with three upload tiles.
 *
 * Stage C: tiles are now fully functional.
 */
export default function LIFTDataRefresh() {

  async function handleUpload(fileKind, file, buffer, onComplete) {
    const t0 = performance.now()
    let parserResult
    try {
      switch (fileKind) {
        case 'wip':       parserResult = await parseWipFile(buffer); break
        case 'mos':       parserResult = await parseMosFile(buffer); break
        case 'inventory': parserResult = await parseInventoryFile(buffer); break
        default: throw new Error(`Unknown fileKind: ${fileKind}`)
      }
    } catch (e) {
      console.error('Parser failed:', e)
      parserResult = {
        parsedData: {},
        errors: { _parser: e?.message || 'Parser threw an exception' },
      }
    }
    const parseDurationMs = Math.round(performance.now() - t0)

    const { data: { user } } = await supabase.auth.getUser()

    const result = await persistSnapshot({
      fileKind,
      sourceFile: file.name,
      fileSizeBytes: file.size,
      source: 'manual_upload',
      authUser: user,
      parsedData: parserResult.parsedData,
      errors: parserResult.errors,
      parseDurationMs,
    })

    if (!result.ok) {
      console.error('Persist failed:', result)
      alert(`Upload failed: ${result.error || 'unknown error'}`)
    } else {
      const totalRows = Object.values(result.rows_written || {}).reduce((s, n) => s + n, 0)
      console.log(`Upload complete · ${totalRows.toLocaleString()} rows captured in ${parseDurationMs}ms`)
    }

    if (onComplete) onComplete()
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <div className={styles.eyebrow}>Data Pipeline</div>
          <h1 className={styles.title}>LIFT Data Refresh</h1>
          <p className={styles.sub}>
            Daily snapshot uploads. Drop today's WIP, MOS, and Inventory files —
            they get parsed and pushed to the dashboard. Each upload preserves a
            history snapshot so you can audit or roll back.
          </p>
        </div>
      </div>

      <div className={styles.shareFileBanner}>
        <div className={styles.bannerIcon}>↻</div>
        <div className={styles.bannerText}>
          <strong>Coming soon · ShareFile auto-refresh.</strong>
          <span>
            Targeting end of June 2026: these three files will pull from
            ShareFile automatically every morning. Manual upload below stays as
            a fallback for re-running a snapshot or fixing a bad day.
          </span>
        </div>
      </div>

      <div className={styles.tileGrid}>
        <UploadTile fileKind="wip"       onUpload={handleUpload} />
        <UploadTile fileKind="mos"       onUpload={handleUpload} />
        <UploadTile fileKind="inventory" onUpload={handleUpload} />
      </div>

      <div className={styles.footerNote}>
        <strong>How it works</strong>
        <p>
          Each upload creates a snapshot row in <code>data_snapshots</code> plus
          rows in the relevant child tables. Heartbeat and Inventory pages always
          read the most recent successful snapshot. Old snapshots stay in the
          database for audit.
        </p>
        <p>
          File validation happens in the browser before upload — wrong file in
          the wrong slot will get caught and you'll be told which slot it should
          go in. Parsing happens in the browser too, then results write to
          Supabase in batches.
        </p>
      </div>
    </div>
  )
}
