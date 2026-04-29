import React from 'react'
import UploadTile from './UploadTile'
import styles from './LIFTDataRefresh.module.css'

/**
 * LIFTDataRefresh — admin page replacing the StubPage.
 *
 * Three upload tiles for the three core daily files:
 *   1. WIP file        (Data_for_WIP.xlsx)
 *   2. MOS file        (API_Dashboard_MOS_3_0.xlsx)
 *   3. Inventory file  (Paramount_Inventory_Reporting_2026.xlsx)
 *
 * Stage B status: tiles render fully, validate uploaded files, but parsing
 * + database write is stubbed. Stage C wires the parsers.
 *
 * Future:
 *   - ShareFile auto-refresh (~60-day timeline) — when wired, the tile chrome
 *     stays the same but the "Source" line says "Auto · ShareFile" instead
 *     of "Manual"
 */
export default function LIFTDataRefresh() {
  return (
    <div className={styles.page}>
      {/* ── Header ── */}
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

      {/* ── ShareFile prep banner ── */}
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

      {/* ── Tile grid ── */}
      <div className={styles.tileGrid}>
        <UploadTile fileKind="wip" />
        <UploadTile fileKind="mos" />
        <UploadTile fileKind="inventory" />
      </div>

      {/* ── Footer note ── */}
      <div className={styles.footerNote}>
        <strong>How it works</strong>
        <p>
          Each upload creates a snapshot row in <code>data_snapshots</code> plus
          rows in the relevant child tables. Heartbeat and Inventory pages always
          read the most recent successful snapshot. Old snapshots stay in the
          database for audit (showing the most recent 10 per file in the
          "Show recent uploads" panel).
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
