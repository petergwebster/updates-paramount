// netlify/functions/lift-demo-snapshot.js
// ===========================================================================
// DEMO snapshot builder — LIFT user-group demo, PrintUnited 9/22/26
// ---------------------------------------------------------------------------
// Freezes a QA1-sandbox WIP pool into ONE sched_snapshots row (uploaded_by =
// 'DEMO') so the dashboard's demo mode can schedule orders that exist
// IDENTICALLY in the QA1 LIFT instance the write-back demo points at.
//
// Reuses lift-wip-sync's buildRows verbatim (exports._internals) — the demo
// pool runs through the IDENTICAL production transform: same kit/ground
// exclusion, site routing, status handling, color-yards math. No second parser.
//
// DELIBERATE OMISSIONS vs the hourly feed — QA1 clone data must never touch
// production history:
//   • NO order_ledger writes        • NO po_lines writes
//   • NO pruning                    • NO completeness-guard baseline updates
// (The hourly job's pruner + baseline now explicitly skip DEMO snapshots.)
//
// MODES (POST JSON):
//   {} or {"dryRun":true}   → fetch QA1, build, RETURN counts + status
//                             breakdowns + samples. WRITES NOTHING. (default)
//   {"write":true}          → insert the DEMO snapshot + wip rows. Returns id.
//
// ENV: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already set for the
// hourly feed). LIFT_DEMO_BASE_URL optional override of the QA1 flush base.
// ===========================================================================

const { _internals } = require('./lift-wip-sync.js')
const { buildRows } = _internals

const QA1_BASE = process.env.LIFT_DEMO_BASE_URL ||
  'https://bny-qa1.lifterp.com/ords/liftqa1/erp/flush/ondemand/1162'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function fetchQa1Csv(report) {
  const res = await fetch(`${QA1_BASE}/${report}/${report}.csv?`)
  if (!res.ok) throw new Error(`QA1 ${report} fetch failed: HTTP ${res.status}`)
  return new TextDecoder('windows-1252').decode(await res.arrayBuffer())
}

const SB_HEADERS = () => ({
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
})

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) }
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not set')

    let write = false
    try { write = !!JSON.parse(event.body || '{}').write } catch { /* dryRun */ }

    const asOf = new Date()
    const [ordersText, productsText] = await Promise.all([
      fetchQa1Csv('orders'), fetchQa1Csv('products'),
    ])
    // Identical transform. buildRows also returns a ledger — deliberately
    // IGNORED here (QA1 clone data must never reach order_ledger).
    const { rows, summary, notes } = buildRows(ordersText, productsText, asOf)

    // Status breakdown per site — the demo pool's vital signs.
    const statusBySite = {}
    for (const r of rows) {
      const sb = statusBySite[r.site] = statusBySite[r.site] || {}
      sb[r.order_status || '(blank)'] = (sb[r.order_status || '(blank)'] || 0) + 1
    }
    const result = {
      mode: write ? 'WRITE' : 'dryRun',
      source: QA1_BASE,
      total_rows: rows.length,
      by_site: {
        passaic: summary.passaic.orders,
        bny: summary.bny.orders,
        procurement: summary.procurement.orders,
        unknown: summary.unknown.orders,
      },
      status_passaic: statusBySite.passaic || {},
      status_bny: statusBySite.bny || {},
      sample_passaic: rows.filter(r => r.site === 'passaic').slice(0, 3),
      notes,
    }

    // Sanity floor: a truncated QA1 pull must not become the demo pool.
    if (rows.length < 200) {
      result.refused = `only ${rows.length} rows parsed — QA1 pull looks truncated; nothing written`
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) }
    }

    if (!write) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) }
    }

    // WRITE: one DEMO snapshot + batched wip rows. Nothing else. No prune.
    const snapRes = await fetch(`${SUPABASE_URL}/rest/v1/sched_snapshots`, {
      method: 'POST',
      headers: { ...SB_HEADERS(), 'Prefer': 'return=representation' },
      body: JSON.stringify({
        uploaded_by: 'DEMO',
        source_filename: `DEMO FREEZE (QA1 ${asOf.toISOString().slice(0, 10)})`,
        passaic_orders: summary.passaic.orders,
        passaic_yards: summary.passaic.yards,
        passaic_revenue: summary.passaic.revenue,
        bny_orders: summary.bny.orders,
        bny_yards: summary.bny.yards,
        bny_revenue: summary.bny.revenue,
        procurement_orders: summary.procurement.orders,
        procurement_revenue: summary.procurement.revenue,
        total_rows: rows.length,
        unclassified_rows: summary.unknown.orders,
        parse_notes: 'DEMO snapshot from QA1 sandbox — pinned (pruner skips DEMO). ' + notes.join(' | '),
      }),
    })
    if (!snapRes.ok) throw new Error(`snapshot insert failed: ${await snapRes.text()}`)
    const snapshotId = (await snapRes.json())[0].id

    const batchSize = 500
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize).map(r => ({ snapshot_id: snapshotId, ...r }))
      const res = await fetch(`${SUPABASE_URL}/rest/v1/sched_wip_rows`, {
        method: 'POST',
        headers: { ...SB_HEADERS(), 'Prefer': 'return=minimal' },
        body: JSON.stringify(chunk),
      })
      if (!res.ok) throw new Error(`wip rows batch ${i} failed: ${await res.text()}`)
    }

    result.snapshot_id = snapshotId
    console.log(`lift-demo-snapshot: wrote DEMO snapshot ${snapshotId} with ${rows.length} rows`)
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) }
  } catch (err) {
    console.error('lift-demo-snapshot error:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
