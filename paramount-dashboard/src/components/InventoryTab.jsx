// src/components/InventoryTab.jsx
//
// Performance > Inventory tab. Three drill levels:
//   1. Overview — summary trend cards (BNY / Passaic / All) + cross-cutting alarm
//      banner + three category cards (Schumacher / Screen Print / Digital).
//   2. Bucket detail — filtered SKU table for a chosen bucket.
//   3. SKU detail — full row context for a chosen SKU.
//
// Inline upload bar at the top — same parser+persist flow as the admin
// LIFT Data Refresh tile. Brynn refreshes here without leaving the tab.
//
// Source: API_Dashboard_MOS_3_0.xlsx, sheet "MOS Material - Color".
// ----------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '../supabase';
import { parseMosMaterialColor } from '../lib/parsers/parseMosMaterialColor';
import { persistSnapshot } from '../lib/persistSnapshot';
import styles from './InventoryTab.module.css';

const BUCKETS = ['Schumacher', 'Screen Print', 'Digital'];

// BNY/Passaic mapping for the finance summary card.
//   BNY      = Digital
//   Passaic  = Screen Print + Schumacher (Schumacher ground physically lives at Passaic)
const SITE_MAP = {
  BNY:     ['Digital'],
  Passaic: ['Screen Print', 'Schumacher'],
};

// Bucket-card framing copy (different per bucket per the bucket-behavior wrinkle).
const BUCKET_FRAMING = {
  'Schumacher':   { label: 'Exception monitor',                 leadLabel: 'SKUs oversold' },
  'Screen Print': { label: 'MOS health · primary signal',       leadLabel: 'below target MOS' },
  'Digital':      { label: 'Full list · fast turn',             leadLabel: 'below target' },
};

// Format helpers
const fmtInt = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString();
const fmtDec1 = (n) => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(1);
const fmtUsd = (n) => (n == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString();
const fmtSign = (n) => {
  if (n == null || isNaN(n)) return '—';
  const v = Math.round(Number(n));
  return v < 0 ? `−${Math.abs(v).toLocaleString()}` : v.toLocaleString();
};
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const relTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const hrs = (Date.now() - d.getTime()) / 3.6e6;
  if (hrs < 1)   return `${Math.round(hrs * 60)} min ago`;
  if (hrs < 48)  return `${Math.round(hrs)} hrs ago`;
  return `${Math.round(hrs / 24)} days ago`;
};

// ============================================================================
// Top-level component
// ============================================================================
export default function InventoryTab({ profile }) {
  const [view, setView] = useState('overview');
  const [selectedBucket, setSelectedBucket] = useState(null);
  const [selectedSku, setSelectedSku] = useState(null);

  const [rows, setRows] = useState([]);
  const [history, setHistory] = useState([]);
  const [snapshotInfo, setSnapshotInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploadState, setUploadState] = useState({ stage: 'idle' });

  useEffect(() => { loadInventory(); /* eslint-disable-next-line */ }, []);

  async function loadInventory() {
    setLoading(true);
    const [{ data: rowData }, { data: histData }] = await Promise.all([
      supabase.from('v_current_mos_material_color').select('*'),
      supabase.from('v_inventory_bucket_history').select('*').order('uploaded_at', { ascending: true }),
    ]);
    setRows(rowData || []);
    setHistory(histData || []);
    if (rowData && rowData.length > 0) {
      setSnapshotInfo({
        uploaded_at: rowData[0].snapshot_uploaded_at,
        uploaded_by: rowData[0].snapshot_uploaded_by,
      });
    }
    setLoading(false);
  }

  async function handleUpload(file) {
    if (!file) return;
    try {
      setUploadState({ stage: 'reading', filename: file.name });
      const buf = await file.arrayBuffer();

      setUploadState({ stage: 'parsing', filename: file.name });
      const parseStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const parsed = parseMosMaterialColor(wb);
      const parseDurationMs = Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - parseStart
      );

      const rowCount = parsed.material_color?.length || 0;
      if (rowCount === 0) {
        setUploadState({ stage: 'error', message: 'No rows parsed — check sheet name "MOS Material - Color"' });
        return;
      }

      setUploadState({ stage: 'persisting', filename: file.name, count: rowCount });

      // Get current auth user for the persistSnapshot call
      const { data: { user: authUser } } = await supabase.auth.getUser();

      const result = await persistSnapshot({
        fileKind: 'mos_material_color',
        sourceFile: file.name,
        fileSizeBytes: file.size,
        source: 'manual_upload',
        authUser: authUser ? { id: authUser.id, email: authUser.email } : null,
        parsedData: parsed,
        errors: {},
        parseDurationMs,
      });

      if (!result.ok) {
        setUploadState({ stage: 'error', message: result.error || 'Upload failed' });
        return;
      }

      const written = result.rows_written?.material_color ?? rowCount;
      setUploadState({ stage: 'success', filename: file.name, count: written });
      await loadInventory();
    } catch (err) {
      console.error('[Inventory upload]', err);
      setUploadState({ stage: 'error', message: err.message || String(err) });
    }
  }

  // Bucket-level aggregates
  const bucketStats = useMemo(() => buildBucketStats(rows), [rows]);
  const allOversold = useMemo(() => rows.filter(r => (r.available_on_hand_with_open_pos ?? 0) < 0), [rows]);
  const totalBuyRec = useMemo(
    () => rows.reduce((sum, r) => sum + Math.max(0, r.calc_buy_yards_plus_2_months || 0), 0),
    [rows]
  );
  const longLeadAtRisk = useMemo(
    () => rows.filter(r => (r.months_of_lead_time ?? 0) >= 5 && (r.var_mos_vs_target_plus_2 ?? 0) < 0).length,
    [rows]
  );

  if (loading) {
    return <div className={styles.tab}><div className={styles.empty}>Loading inventory…</div></div>;
  }

  const noData = rows.length === 0;

  return (
    <div className={styles.tab}>
      <Header />
      <UploadBar
        snapshotInfo={snapshotInfo}
        uploadState={uploadState}
        onFile={handleUpload}
      />

      {noData ? (
        <EmptyState />
      ) : view === 'overview' ? (
        <OverviewView
          rows={rows}
          history={history}
          bucketStats={bucketStats}
          alarmStats={{ oversold: allOversold.length, totalBuy: totalBuyRec, longLead: longLeadAtRisk }}
          onSelectBucket={(b) => { setSelectedBucket(b); setView('bucket'); }}
          onShowAllOversold={() => { setSelectedBucket('__OVERSOLD__'); setView('bucket'); }}
        />
      ) : view === 'bucket' ? (
        <BucketView
          bucket={selectedBucket}
          rows={rows}
          onBack={() => setView('overview')}
          onSelectSku={(sku) => { setSelectedSku(sku); setView('sku'); }}
        />
      ) : (
        <SkuView
          sku={selectedSku}
          row={rows.find(r => r.replacement_ground === selectedSku)}
          onBack={() => setView('bucket')}
        />
      )}
    </div>
  );
}

// ============================================================================
// Header + UploadBar
// ============================================================================
function Header() {
  return (
    <div className={styles.pageHeader}>
      <div>
        <div className={styles.crumb}>Performance · Inventory</div>
        <h1>Months of Supply</h1>
        <div className={styles.subtitle}>
          Ground inventory health across Schumacher pass-through, Screen Print, and Digital substrates
        </div>
      </div>
    </div>
  );
}

function UploadBar({ snapshotInfo, uploadState, onFile }) {
  const inputRef = useRef(null);
  const handlePick = () => inputRef.current?.click();
  const handleChange = (e) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = '';  // allow re-selecting same file
  };

  const stage = uploadState.stage;
  const busy = stage === 'reading' || stage === 'parsing' || stage === 'persisting';

  let chipClass = styles.chipFresh, chipLabel = 'Fresh';
  if (snapshotInfo?.uploaded_at) {
    const ageHrs = (Date.now() - new Date(snapshotInfo.uploaded_at).getTime()) / 3.6e6;
    if (ageHrs > 24 * 35)      { chipClass = styles.chipStale; chipLabel = 'Stale'; }
    else if (ageHrs > 24 * 7)  { chipClass = styles.chipAging; chipLabel = 'Aging'; }
  } else {
    chipClass = styles.chipStale; chipLabel = 'No data';
  }

  return (
    <div className={styles.uploadBar}>
      <div>
        <div className={styles.smallLabel}>Source</div>
        <div className={styles.fileLine}>
          <span className={styles.filename}>API_Dashboard_MOS_3_0.xlsx</span>
          <span className={`${styles.freshChip} ${chipClass}`}>{chipLabel}</span>
        </div>
      </div>
      <div style={{ marginLeft: 18 }}>
        <div className={styles.smallLabel}>Last Refresh</div>
        <div className={styles.timestamp}>
          {snapshotInfo
            ? `${fmtDate(snapshotInfo.uploaded_at)} · ${relTime(snapshotInfo.uploaded_at)} · ${snapshotInfo.uploaded_by || 'unknown'}`
            : 'Never uploaded'}
        </div>
      </div>
      <div className={styles.spacer} />

      {stage === 'success' && (
        <div className={styles.uploadStatusOk}>
          ✓ {uploadState.count} rows captured
        </div>
      )}
      {stage === 'error' && (
        <div className={styles.uploadStatusErr}>
          ✗ {uploadState.message}
        </div>
      )}
      {busy && (
        <div className={styles.uploadStatusBusy}>
          {stage === 'reading'    && 'Reading file…'}
          {stage === 'parsing'    && 'Parsing sheet…'}
          {stage === 'persisting' && `Writing ${uploadState.count} rows…`}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xlsm"
        style={{ display: 'none' }}
        onChange={handleChange}
      />
      <button className={styles.btnPrimary} onClick={handlePick} disabled={busy}>
        ↑ Refresh File
      </button>
    </div>
  );
}

// ============================================================================
// Overview view (Level 1)
// ============================================================================
function OverviewView({ rows, history, bucketStats, alarmStats, onSelectBucket, onShowAllOversold }) {
  return (
    <>
      {/* --- Inventory Trend Summary (finance / valuation) --- */}
      <SectionHeader title="Inventory Trend" subtitle="On-hand yards by site for valuation & finance" />
      <TrendSummary history={history} rows={rows} />

      {/* --- Cross-cutting alarm banner --- */}
      <SectionHeader title="Active Alerts" subtitle="Cross-cutting exceptions across all buckets" />
      <AlarmBanner stats={alarmStats} onShowAll={onShowAllOversold} />

      {/* --- Three category cards --- */}
      <SectionHeader title="By Category" subtitle="Click a card for SKU-level detail" />
      <div className={styles.cardRow}>
        {BUCKETS.map(b => (
          <CategoryCard
            key={b}
            bucket={b}
            stats={bucketStats[b]}
            onClick={() => onSelectBucket(b)}
          />
        ))}
      </div>
    </>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <div className={styles.sectionHeader}>
      <h2>{title}</h2>
      {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
    </div>
  );
}

// ----- Trend summary (BNY + Passaic + All) ---------------------------------
function TrendSummary({ history, rows }) {
  // Compute current bucket totals from rows (so it matches the user's freshly-uploaded snapshot)
  const currentByBucket = useMemo(() => {
    const out = {};
    for (const r of rows) {
      const b = r.order_type;
      if (!out[b]) out[b] = { yards: 0, skuCount: 0, valuated_yards: 0, valuated_dollars: 0 };
      out[b].yards += r.on_hand_qty || 0;
      out[b].skuCount += 1;
      // $ valuation pulled from raw_row.unit_cost if present (stamped during upload from
      // mos_received join). For initial Phase 1, leave at 0; will populate when we wire
      // the cost join in Phase 1B.
    }
    return out;
  }, [rows]);

  const sites = ['BNY', 'Passaic'];
  const siteTotals = sites.map(site => {
    const buckets = SITE_MAP[site];
    const yards = buckets.reduce((s, b) => s + (currentByBucket[b]?.yards || 0), 0);
    const skuCount = buckets.reduce((s, b) => s + (currentByBucket[b]?.skuCount || 0), 0);
    return { site, yards, skuCount, buckets };
  });
  const grandYards = siteTotals.reduce((s, x) => s + x.yards, 0);

  // Trend points — group history by snapshot_month, then per site
  const trendBySite = useMemo(() => buildTrendBySite(history), [history]);

  return (
    <div className={styles.trendBlock}>
      <div className={styles.trendCards}>
        {siteTotals.map(s => (
          <SiteTrendCard
            key={s.site}
            site={s.site}
            yards={s.yards}
            skuCount={s.skuCount}
            trend={trendBySite[s.site] || []}
          />
        ))}
        <div className={styles.totalCard}>
          <div className={styles.smallLabel}>Total On-Hand</div>
          <div className={styles.bigStat}>{fmtInt(grandYards)} <span className={styles.unit}>yd</span></div>
          <div className={styles.subtitle} style={{ marginTop: 8 }}>
            Sum across all three buckets · current snapshot
          </div>
          <div className={styles.dollarNote}>
            $ valuation populates as receipt-cost data is wired (Phase 1B).
          </div>
        </div>
      </div>
    </div>
  );
}

function SiteTrendCard({ site, yards, skuCount, trend }) {
  return (
    <div className={styles.siteCard}>
      <div className={styles.siteCardHeader}>
        <span className={styles.smallLabel}>{site}</span>
        <span className={styles.subtitle}>{skuCount} SKUs in stock</span>
      </div>
      <div className={styles.bigStat}>{fmtInt(yards)} <span className={styles.unit}>yd</span></div>
      <Sparkline points={trend} />
      <div className={styles.subtitle}>
        {trend.length <= 1
          ? 'Trend builds as monthly refreshes accumulate'
          : `${trend.length} months of history`}
      </div>
    </div>
  );
}

function Sparkline({ points }) {
  if (!points || points.length < 1) {
    return <div className={styles.sparkPlaceholder}>—</div>;
  }
  const W = 200, H = 40, P = 4;
  const ys = points.map(p => p.yards);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const range = maxY - minY || 1;
  const xStep = points.length > 1 ? (W - 2 * P) / (points.length - 1) : 0;

  if (points.length === 1) {
    return (
      <svg className={styles.spark} viewBox={`0 0 ${W} ${H}`}>
        <circle cx={W/2} cy={H/2} r="3.5" fill="var(--perf, #124E66)" />
      </svg>
    );
  }

  const path = points.map((p, i) => {
    const x = P + i * xStep;
    const y = P + (1 - (p.yards - minY) / range) * (H - 2 * P);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg className={styles.spark} viewBox={`0 0 ${W} ${H}`}>
      <path d={path} fill="none" stroke="var(--perf, #124E66)" strokeWidth="1.6" />
      {points.map((p, i) => {
        const x = P + i * xStep;
        const y = P + (1 - (p.yards - minY) / range) * (H - 2 * P);
        return <circle key={i} cx={x} cy={y} r="2" fill="var(--perf, #124E66)" />;
      })}
    </svg>
  );
}

// ----- Alarm banner --------------------------------------------------------
function AlarmBanner({ stats, onShowAll }) {
  return (
    <div className={styles.alarmBanner}>
      <div>
        <div className={styles.alarmLabel}>Oversold SKUs</div>
        <div className={`${styles.alarmValue} ${styles.alert}`}>{stats.oversold}</div>
        <div className={styles.alarmSub}>WIP committed exceeds On Hand + Open POs</div>
      </div>
      <div>
        <div className={styles.alarmLabel}>Total Buy Recommendation (+2 mo)</div>
        <div className={styles.alarmValue}>{fmtInt(stats.totalBuy)}</div>
        <div className={styles.alarmSub}>yards across SKUs short of target</div>
      </div>
      <div>
        <div className={styles.alarmLabel}>Long-Lead at Risk</div>
        <div className={styles.alarmValue}>{stats.longLead}</div>
        <div className={styles.alarmSub}>SKUs with 5+ mo lead time below target</div>
      </div>
      <div className={styles.alarmCta}>
        <button className={styles.btnAlarm} onClick={onShowAll}>View All {stats.oversold} →</button>
      </div>
    </div>
  );
}

// ----- Category card -------------------------------------------------------
function CategoryCard({ bucket, stats, onClick }) {
  const framing = BUCKET_FRAMING[bucket];
  const leadNum = bucket === 'Schumacher' ? stats.oversold : stats.shortOfTarget;

  return (
    <div className={styles.catCard} onClick={onClick} role="button" tabIndex={0}
         onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}>
      <div className={styles.catStrip} />
      <div className={styles.catHeader}>
        <div className={styles.catName}>{bucket}</div>
        <div className={styles.skuCount}>{stats.total} SKUs</div>
      </div>
      <div className={styles.catFraming}>{framing.label}</div>
      <div className={styles.leadStat}>
        <div className={`${styles.leadNum} ${leadNum > 0 ? styles.alert : styles.ok}`}>{leadNum}</div>
        <div className={styles.leadLabel}>
          {bucket === 'Schumacher'
            ? `${stats.oversold} oversold (committed > available)`
            : `${stats.shortOfTarget} below target · ${stats.oversold} oversold`}
        </div>
      </div>
      <div className={styles.statsRow}>
        <div className={styles.miniStat}>
          <div className={styles.miniV}>{fmtInt(stats.totalOnHand)}</div>
          <div className={styles.miniL}>{bucket === 'Schumacher' ? 'WIP yards' : 'On Hand yards'}</div>
        </div>
        <div className={styles.miniStat}>
          <div className={styles.miniV}>{stats.leadTimeRange}</div>
          <div className={styles.miniL}>Lead time</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Bucket view (Level 2)
// ============================================================================
function BucketView({ bucket, rows, onBack, onSelectSku }) {
  const [filter, setFilter] = useState('below'); // 'below' | 'all' | 'oversold' | 'longLead'

  const isOversold = bucket === '__OVERSOLD__';
  const title = isOversold ? 'All Oversold SKUs' : bucket;

  const sourceRows = isOversold
    ? rows.filter(r => (r.available_on_hand_with_open_pos ?? 0) < 0)
    : rows.filter(r => r.order_type === bucket);

  const filteredRows = useMemo(() => {
    let list = sourceRows;
    if (filter === 'below')    list = list.filter(r => (r.var_mos_vs_target_plus_2 ?? 0) < 0);
    if (filter === 'oversold') list = list.filter(r => (r.available_on_hand_with_open_pos ?? 0) < 0);
    if (filter === 'longLead') list = list.filter(r => (r.months_of_lead_time ?? 0) >= 3);
    // sort: most negative variance first, then by SKU
    return [...list].sort((a, b) =>
      (a.var_mos_vs_target_plus_2 ?? 0) - (b.var_mos_vs_target_plus_2 ?? 0)
    );
  }, [sourceRows, filter]);

  const counts = {
    below:    sourceRows.filter(r => (r.var_mos_vs_target_plus_2 ?? 0) < 0).length,
    all:      sourceRows.length,
    oversold: sourceRows.filter(r => (r.available_on_hand_with_open_pos ?? 0) < 0).length,
    longLead: sourceRows.filter(r => (r.months_of_lead_time ?? 0) >= 3).length,
  };

  return (
    <div>
      <button className={styles.backBtn} onClick={onBack}>← Back to Inventory Overview</button>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h3>{title}</h3>
          <div className={styles.filterChips}>
            {!isOversold && (
              <Chip active={filter === 'below'}    onClick={() => setFilter('below')}>Below Target ({counts.below})</Chip>
            )}
            <Chip active={filter === 'all' || isOversold} onClick={() => setFilter('all')}>{isOversold ? `All (${counts.all})` : `All (${counts.all})`}</Chip>
            {!isOversold && (
              <Chip active={filter === 'oversold'} onClick={() => setFilter('oversold')}>Oversold ({counts.oversold})</Chip>
            )}
            {!isOversold && (
              <Chip active={filter === 'longLead'} onClick={() => setFilter('longLead')}>Long-lead ({counts.longLead})</Chip>
            )}
          </div>
        </div>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>SKU</th>
              {isOversold && <th>Bucket</th>}
              <th className={styles.num}>On Hand</th>
              <th className={styles.num}>WIP</th>
              <th className={styles.num}>MOS</th>
              <th className={styles.num}>Lead</th>
              <th className={styles.num}>Target</th>
              <th className={styles.num}>Var vs Target</th>
              <th className={styles.num}>Buy +2mo</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr><td colSpan={isOversold ? 10 : 9} className={styles.emptyCell}>No SKUs match this filter</td></tr>
            ) : filteredRows.map(r => {
              const oversold = (r.available_on_hand_with_open_pos ?? 0) < 0;
              const below = (r.var_mos_vs_target_plus_2 ?? 0) < 0;
              return (
                <tr key={r.id} className={oversold ? styles.crit : ''} onClick={() => onSelectSku(r.replacement_ground)}>
                  <td className={styles.skuCell}>{r.replacement_ground}</td>
                  {isOversold && <td className={styles.bucketCell}>{r.order_type}</td>}
                  <td className={styles.num}>{fmtInt(r.on_hand_qty)}</td>
                  <td className={styles.num}>{fmtInt(r.wip_total)}</td>
                  <td className={styles.num}>{fmtDec1(r.mos_based_on_6_12)}</td>
                  <td className={styles.num}>{fmtDec1(r.months_of_lead_time)}</td>
                  <td className={styles.num}>{fmtDec1(r.target_mos_plus_2)}</td>
                  <td className={`${styles.num} ${below ? styles.varNeg : styles.varPos}`}>
                    {fmtSign(r.var_mos_vs_target_plus_2)}
                  </td>
                  <td className={styles.num}>{fmtInt(r.calc_buy_yards_plus_2_months)}</td>
                  <td>
                    {oversold
                      ? <span className={`${styles.pill} ${styles.pillCrit}`}>Oversold</span>
                      : below
                        ? <span className={`${styles.pill} ${styles.pillWarn}`}>Below target</span>
                        : <span className={`${styles.pill} ${styles.pillOk}`}>On track</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <span className={`${styles.chip} ${active ? styles.chipActive : ''}`} onClick={onClick}>
      {children}
    </span>
  );
}

// ============================================================================
// SKU view (Level 3)
// ============================================================================
function SkuView({ sku, row, onBack }) {
  if (!row) {
    return (
      <div>
        <button className={styles.backBtn} onClick={onBack}>← Back</button>
        <div className={styles.empty}>SKU "{sku}" not found in current snapshot.</div>
      </div>
    );
  }

  const oversold = (row.available_on_hand_with_open_pos ?? 0) < 0;
  const below = (row.var_mos_vs_target_plus_2 ?? 0) < 0;
  const buyAmt = row.calc_buy_yards_plus_2_months;

  return (
    <div>
      <button className={styles.backBtn} onClick={onBack}>← Back</button>

      <div className={styles.drill}>
        <div className={styles.drillHead}>
          <div className={styles.drillBack}>{row.order_type} · {below ? 'Below Target' : 'On Track'}</div>
          <h2>
            {row.replacement_ground}
            {oversold && <span className={`${styles.pill} ${styles.pillCrit}`} style={{ marginLeft: 10 }}>Oversold</span>}
            {!oversold && below && <span className={`${styles.pill} ${styles.pillWarn}`} style={{ marginLeft: 10 }}>Below target</span>}
          </h2>
          <div className={styles.drillMeta}>
            {row.order_type} substrate · {fmtDec1(row.months_of_lead_time)} month lead time ·
            target MOS {fmtDec1(row.target_mos_plus_2)} ·
            written {fmtInt(row.ground_written_last_6_months)} yd in past 6 months
          </div>
        </div>

        <div className={styles.drillBody}>
          <div>
            <h4>Current Position</h4>
            <div className={styles.statGrid}>
              <Stat label="On Hand" value={`${fmtInt(row.on_hand_qty)} yd`} />
              <Stat label="WIP Total" value={`${fmtInt(row.wip_total)} yd`} />
              <Stat label="Open PO Qty" value={`${fmtInt(row.po_open_qty)} yd`} />
              <Stat label="Available with Open POs"
                    value={`${fmtSign(row.available_on_hand_with_open_pos)} yd`}
                    alert={oversold} />
            </div>

            <div className={styles.subSection}>
              <h4>Demand History</h4>
              <div className={styles.demandBars}>
                <DemandBar label="6mo Total"      value={fmtInt(row.ground_written_last_6_months)} />
                <DemandBar label="Avg 6mo / mo"   value={fmtDec1(row.avg_monthly_last_6_months)} />
                <DemandBar label="Avg 12mo / mo"  value={fmtDec1(row.avg_monthly_last_12_months)} />
                <DemandBar label="Last 30 days"   value={fmtInt(row.yards_written_last_30_days)} />
              </div>
              {(row.avg_last_6_12_monthly_yards ?? 0) < 1 && row.wip_total > 100 && (
                <div className={styles.note}>
                  Burn rate is essentially zero on rolling average — the WIP commitment is what's driving the position, not steady demand.
                </div>
              )}
            </div>
          </div>

          <div>
            <h4>MOS Engine</h4>
            <div className={styles.statGrid}>
              <Stat label="Current MOS"     value={fmtDec1(row.mos_based_on_6_12)} alert={(row.mos_based_on_6_12 ?? 0) < 0} />
              <Stat label="Target MOS (+2)" value={fmtDec1(row.target_mos_plus_2)} />
              <Stat label="Lead Time"       value={`${fmtDec1(row.months_of_lead_time)} mo`} />
              <Stat label="Variance"        value={fmtSign(row.var_mos_vs_target_plus_2)} alert={below} />
            </div>

            <div className={styles.subSection}>
              <h4>Open POs</h4>
              {(row.po_open_qty ?? 0) > 0 ? (
                <div className={styles.poLine}>
                  <div className={styles.poDot} />
                  <div>
                    <strong>{fmtInt(row.po_open_qty)} yd</strong> on order
                    <div className={styles.subtitle}>
                      {row.min_due_date ? `Due ${fmtDate(row.min_due_date)}` : 'Due dates not in source'}
                      {row.max_due_date && row.max_due_date !== row.min_due_date
                        ? ` – ${fmtDate(row.max_due_date)}` : ''}
                    </div>
                  </div>
                </div>
              ) : (
                <div className={styles.poEmpty}>No open POs on this SKU</div>
              )}
            </div>

            {buyAmt && buyAmt > 0 && (
              <div className={styles.recommend}>
                <div className={styles.recLabel}>Recommended Buy</div>
                <div className={styles.recValue}>{fmtInt(buyAmt)} yards</div>
                <div className={styles.recNote}>
                  To cover the position and rebuild to +2 month buffer.
                  Expected shipment delay: {fmtDec1(row.months_of_lead_time)} months from PO.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, alert }) {
  return (
    <div className={styles.statItem}>
      <div className={styles.statL}>{label}</div>
      <div className={`${styles.statV} ${alert ? styles.alert : ''}`}>{value}</div>
    </div>
  );
}

function DemandBar({ label, value }) {
  return (
    <div className={styles.demandBar}>
      <div className={styles.demandL}>{label}</div>
      <div className={styles.demandV}>{value}</div>
    </div>
  );
}

// ============================================================================
// Empty state
// ============================================================================
function EmptyState() {
  return (
    <div className={styles.empty}>
      <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 400, fontSize: 22 }}>No inventory data yet</h3>
      <p>Use the <strong>Refresh File</strong> button above to upload the latest API_Dashboard_MOS_3_0.xlsx
      from ShareFile. The Inventory tab will populate once the first snapshot is captured.</p>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================
function buildBucketStats(rows) {
  const stats = {};
  for (const b of BUCKETS) {
    stats[b] = {
      total: 0,
      shortOfTarget: 0,
      oversold: 0,
      negativeMos: 0,
      totalOnHand: 0,
      totalWip: 0,
      leadTimes: [],
    };
  }
  for (const r of rows) {
    const s = stats[r.order_type];
    if (!s) continue;
    s.total++;
    if ((r.var_mos_vs_target_plus_2 ?? 0) < 0)         s.shortOfTarget++;
    if ((r.available_on_hand_with_open_pos ?? 0) < 0)  s.oversold++;
    if ((r.mos_based_on_6_12 ?? 0) < 0)                s.negativeMos++;
    s.totalOnHand += r.on_hand_qty || 0;
    s.totalWip    += r.wip_total   || 0;
    if (r.months_of_lead_time != null) s.leadTimes.push(r.months_of_lead_time);
  }
  for (const s of Object.values(stats)) {
    if (s.leadTimes.length) {
      const min = Math.min(...s.leadTimes);
      const max = Math.max(...s.leadTimes);
      s.leadTimeRange = (min === max) ? `${fmtDec1(min)} mo` : `${fmtDec1(min)}–${fmtDec1(max)} mo`;
    } else {
      s.leadTimeRange = '—';
    }
  }
  // Schumacher card surfaces "WIP yards" not "On Hand yards" because pass-through
  // ground is rarely held — the meaningful inventory is committed WIP.
  if (stats['Schumacher']) {
    stats['Schumacher'].totalOnHand = stats['Schumacher'].totalWip;
  }
  return stats;
}

function buildTrendBySite(history) {
  // history rows: { snapshot_id, snapshot_month, order_type, total_on_hand_yards, ... }
  // Group by month + site, sum across mapped buckets.
  const byMonthSite = {};  // { 'YYYY-MM-DD::BNY': yards }
  for (const h of history) {
    const monthKey = h.snapshot_month?.substring(0, 10) || '';
    for (const site of Object.keys(SITE_MAP)) {
      if (SITE_MAP[site].includes(h.order_type)) {
        const key = `${monthKey}::${site}`;
        byMonthSite[key] = (byMonthSite[key] || 0) + (Number(h.total_on_hand_yards) || 0);
      }
    }
  }
  const out = { BNY: [], Passaic: [] };
  const months = [...new Set(Object.keys(byMonthSite).map(k => k.split('::')[0]))].sort();
  for (const m of months) {
    for (const site of Object.keys(SITE_MAP)) {
      const v = byMonthSite[`${m}::${site}`];
      if (v != null) out[site].push({ month: m, yards: v });
    }
  }
  return out;
}
