import React, { useState } from 'react'
import styles from './WIPStatusBar.module.css'

/**
 * WIPStatusBar — the canonical WIP visualization for Heartbeat.
 *
 * VISUAL: Three-segment horizontal bar (Ready / In Prep / Blocked), sized
 * proportionally to yard counts. Reads at a glance.
 *
 * DETAIL: On hover, expands to show the full 9 LIFT statuses underneath each
 * segment. This preserves fidelity to the ERP for ops users who want detail,
 * while keeping the headline visual simple for execs.
 *
 * UNALLOCATED CALLOUT: Orders Unallocated lives inside "In Prep" but it's
 * upstream of mixing/strike-off — these are orders Wendy hasn't put on a
 * table yet. Surfaced as a small callout above the bar so it can't hide.
 *
 * Bucket mapping (matches LIFT exactly — 9 statuses → 3 buckets):
 *   Ready   = Ready to Print + Approved to Print + In Progress + In Packing
 *   In Prep = In Mixing Queue + Strike Off + Orders Unallocated + Waiting for Approval
 *   Blocked = Waiting for Material
 *
 * Props:
 *   data: {
 *     unallocated:        { yards, orders },
 *     waitingApproval:    { yards, orders },
 *     waitingMaterial:    { yards, orders },
 *     approvedToPrint:    { yards, orders },
 *     readyToPrint:       { yards, orders },
 *     inPacking:          { yards, orders },
 *     inProgress:         { yards, orders },
 *     strikeOff:          { yards, orders },
 *     inMixingQueue:      { yards, orders },
 *   }
 *   compact: optional boolean — smaller bar for table cells
 */
export default function WIPStatusBar({ data, compact = false }) {
  const [hoveredBucket, setHoveredBucket] = useState(null)

  if (!data) return null

  // ─── Compute bucket totals ───
  const ready = sumBucket([
    data.readyToPrint, data.approvedToPrint, data.inProgress, data.inPacking,
  ])
  const inPrep = sumBucket([
    data.inMixingQueue, data.strikeOff, data.unallocated, data.waitingApproval,
  ])
  const blocked = sumBucket([data.waitingMaterial])
  const total = ready.yards + inPrep.yards + blocked.yards

  if (total === 0) {
    return <div className={styles.empty}>No WIP data</div>
  }

  const readyPct   = (ready.yards   / total) * 100
  const inPrepPct  = (inPrep.yards  / total) * 100
  const blockedPct = (blocked.yards / total) * 100

  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`}>

      {/* Unallocated callout — visible above the bar when significant */}
      {data.unallocated?.orders > 0 && (
        <div className={styles.unallocatedCallout}>
          <span className={styles.warnIcon}>⚠</span>
          <span>
            <strong>{data.unallocated.orders}</strong> orders unallocated
            ({fmt(data.unallocated.yards)} yds) — not yet on a table
          </span>
        </div>
      )}

      {/* The 3-segment bar */}
      <div className={styles.bar}>
        <BucketSegment
          name="ready" label="Ready" pct={readyPct} yards={ready.yards}
          isHovered={hoveredBucket === 'ready'}
          onHover={() => setHoveredBucket('ready')}
          onLeave={() => setHoveredBucket(null)}
        />
        <BucketSegment
          name="inPrep" label="In Prep" pct={inPrepPct} yards={inPrep.yards}
          isHovered={hoveredBucket === 'inPrep'}
          onHover={() => setHoveredBucket('inPrep')}
          onLeave={() => setHoveredBucket(null)}
        />
        <BucketSegment
          name="blocked" label="Blocked" pct={blockedPct} yards={blocked.yards}
          isHovered={hoveredBucket === 'blocked'}
          onHover={() => setHoveredBucket('blocked')}
          onLeave={() => setHoveredBucket(null)}
        />
      </div>

      {/* Legend showing bucket totals */}
      {!compact && (
        <div className={styles.legend}>
          <LegendItem dotClass="ready" label="Ready" yards={ready.yards} orders={ready.orders} />
          <LegendItem dotClass="inPrep" label="In Prep" yards={inPrep.yards} orders={inPrep.orders} />
          <LegendItem dotClass="blocked" label="Blocked" yards={blocked.yards} orders={blocked.orders} />
        </div>
      )}

      {/* Hover detail panel — shows the 9 LIFT statuses for the hovered bucket */}
      {hoveredBucket && !compact && (
        <div className={styles.detailPanel}>
          <div className={styles.detailLabel}>
            {hoveredBucket === 'ready'   && 'Ready bucket · 4 LIFT statuses'}
            {hoveredBucket === 'inPrep'  && 'In Prep bucket · 4 LIFT statuses'}
            {hoveredBucket === 'blocked' && 'Blocked bucket · 1 LIFT status'}
          </div>
          <div className={styles.detailRows}>
            {hoveredBucket === 'ready' && (
              <>
                <DetailRow label="Ready to Print"     data={data.readyToPrint}    />
                <DetailRow label="Approved to Print"  data={data.approvedToPrint} />
                <DetailRow label="In Progress"        data={data.inProgress}      />
                <DetailRow label="In Packing"         data={data.inPacking}       />
              </>
            )}
            {hoveredBucket === 'inPrep' && (
              <>
                <DetailRow label="In Mixing Queue"    data={data.inMixingQueue}   />
                <DetailRow label="Strike Off"         data={data.strikeOff}       />
                <DetailRow label="Orders Unallocated" data={data.unallocated}     highlight />
                <DetailRow label="Waiting for Approval" data={data.waitingApproval} />
              </>
            )}
            {hoveredBucket === 'blocked' && (
              <DetailRow label="Waiting for Material" data={data.waitingMaterial} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── helpers ───────────────────────────────────────────────────────────── */

function sumBucket(items) {
  return {
    yards:  items.reduce((s, x) => s + (x?.yards  || 0), 0),
    orders: items.reduce((s, x) => s + (x?.orders || 0), 0),
  }
}

function fmt(n) {
  if (n == null) return '—'
  return n.toLocaleString()
}

function BucketSegment({ name, label, pct, yards, isHovered, onHover, onLeave }) {
  // Don't render extremely thin segments (under 1.5%)
  if (pct < 1.5) return null
  return (
    <div
      className={`${styles.segment} ${styles[name]} ${isHovered ? styles.hovered : ''}`}
      style={{ width: `${pct}%` }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      {pct >= 8 && (
        <span className={styles.segmentLabel}>
          {fmt(yards)}
        </span>
      )}
    </div>
  )
}

function LegendItem({ dotClass, label, yards, orders }) {
  return (
    <span className={styles.legendItem}>
      <span className={`${styles.legendDot} ${styles[`dot_${dotClass}`]}`} />
      <strong>{label}</strong>
      <span className={styles.legendNum}>{fmt(yards)} yds</span>
      <span className={styles.legendOrders}>· {orders} orders</span>
    </span>
  )
}

function DetailRow({ label, data, highlight = false }) {
  return (
    <div className={`${styles.detailRow} ${highlight ? styles.detailRowHighlight : ''}`}>
      <span className={styles.detailRowLabel}>{label}</span>
      <span className={styles.detailRowYds}>{fmt(data?.yards)} yds</span>
      <span className={styles.detailRowOrders}>{fmt(data?.orders)} orders</span>
    </div>
  )
}
