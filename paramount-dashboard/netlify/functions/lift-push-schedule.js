// netlify/functions/lift-push-schedule.js
// ===========================================================================
// Push a schedule into LIFT — the write half of the PrintUnited demo (9/22/26).
// ---------------------------------------------------------------------------
// POST { moves: [{ orderNumber, table }], dryRun }
//   moves.table is a DASHBOARD code (WP-16, FAB-5, GC-1), resolved server-side
//   through ref_lift_table_map. dryRun defaults TRUE: resolves everything,
//   fetches before-states, returns the exact plan — writes nothing.
//   dryRun:false executes machines/change per target machine, reconciles the
//   PARTIAL-SUCCESS response per line (proven live 9/15: HTTP 200 can carry
//   failures), re-reads each order (verify by orderNumber — the proven
//   filter), and reports per-line verdicts.
//
// REST-only — no flush CSVs, so no timeout risk (API answers in ms).
// SAFETY: refuses to run unless LIFT_API_BASE contains 'qa1'. recalculateQuote
// is FALSE until Paul confirms its semantics. Ground kit sub-lines are excluded
// by construction (they carry no step 14).
//
// ENV (Netlify): LIFT_API_BASE (QA1 REST base), LIFT_API_USER, LIFT_API_PASS,
// LIFT_API_COMPANY_ID (default 1162) + existing VITE_SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY for the crosswalk read.
// ===========================================================================

const STEP = 14 // Print — the demo step

const BASE = (process.env.LIFT_API_BASE || '').replace(/\/+$/, '')
const LH = () => ({
  Authorization: 'Basic ' + Buffer.from(`${process.env.LIFT_API_USER}:${process.env.LIFT_API_PASS}`).toString('base64'),
  USERNAME: process.env.LIFT_API_USER,
  PASSWORD: process.env.LIFT_API_PASS,
  COMPANY_ID: process.env.LIFT_API_COMPANY_ID || '1162',
  Accept: 'application/json',
  'Content-Type': 'application/json',
})
const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function getOrderMachines(orderNumber) {
  const res = await fetch(`${BASE}/api/v1/order-management/order-machines?orderNumber=${encodeURIComponent(orderNumber)}&fetchSize=500`, { headers: LH() })
  if (!res.ok) throw new Error(`order-machines GET ${orderNumber}: HTTP ${res.status}`)
  return (await res.json()).machines || []
}

async function loadCrosswalk() {
  const res = await fetch(`${SB_URL}/rest/v1/ref_lift_table_map?select=dash_code,lift_machine`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  })
  if (!res.ok) throw new Error(`crosswalk read failed: ${await res.text()}`)
  const map = new Map()
  for (const r of await res.json()) map.set(r.dash_code, r.lift_machine)
  return map
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) }
    if (!BASE) return { statusCode: 500, body: JSON.stringify({ error: 'LIFT_API_BASE env var not set on Netlify' }) }
    if (!BASE.includes('qa1')) return { statusCode: 400, body: JSON.stringify({ error: `SAFETY STOP: LIFT_API_BASE is not QA1 (${BASE}). This writer only runs against the sandbox.` }) }
    if (!process.env.LIFT_API_USER || !process.env.LIFT_API_PASS) return { statusCode: 500, body: JSON.stringify({ error: 'LIFT_API_USER / LIFT_API_PASS env vars not set on Netlify' }) }
    if (!SB_URL || !SB_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Supabase env not set' }) }

    let body = {}
    try { body = JSON.parse(event.body || '{}') } catch { /* dryRun default */ }
    const dryRun = body.dryRun !== false // default TRUE — explicit false to write
    const rawMoves = Array.isArray(body.moves) ? body.moves : []
    if (!rawMoves.length) return { statusCode: 400, body: JSON.stringify({ error: 'moves[] is required: [{ orderNumber, table }]' }) }
    if (rawMoves.length > 60) return { statusCode: 400, body: JSON.stringify({ error: `too many moves (${rawMoves.length}); cap is 60 per push` }) }

    const crosswalk = await loadCrosswalk()
    const warnings = []
    const perOrder = []

    // Dedupe on orderNumber (one target per order; last table wins, warn on conflict)
    const byOrder = new Map()
    for (const m of rawMoves) {
      if (!m.orderNumber || !m.table) { warnings.push(`skipped malformed move ${JSON.stringify(m)}`); continue }
      if (byOrder.has(m.orderNumber) && byOrder.get(m.orderNumber) !== m.table) {
        warnings.push(`${m.orderNumber}: multiple targets requested (${byOrder.get(m.orderNumber)} vs ${m.table}) — using ${m.table}`)
      }
      byOrder.set(m.orderNumber, m.table)
    }

    // Resolve + gather before-states
    for (const [orderNumber, table] of byOrder) {
      const entry = { orderNumber, table }
      if (!crosswalk.has(table)) {
        entry.error = `'${table}' is not in ref_lift_table_map — failing loudly, not skipping silently`
        perOrder.push(entry); continue
      }
      const machine = crosswalk.get(table)
      if (!machine) {
        entry.error = `'${table}' has NO LIFT machine (FAB-10/11 unresolved per Ramon 9/15) — unwritable`
        perOrder.push(entry); continue
      }
      entry.targetMachine = machine
      try {
        entry.before = await getOrderMachines(orderNumber)
      } catch (e) {
        entry.error = e.message; perOrder.push(entry); continue
      }
      entry.items = entry.before
        .filter(r => Number(r.stepNumber) === STEP)
        .map(r => ({ orderNumber, lineNumber: r.lineNumber, stepNumber: r.stepNumber }))
      if (!entry.items.length) entry.error = `no step-${STEP} (Print) lines on this order — nothing to move`
      perOrder.push(entry)
    }

    const actionable = perOrder.filter(o => !o.error)
    const summary = {
      mode: dryRun ? 'dryRun' : 'EXECUTE',
      orders: actionable.length,
      lines: actionable.reduce((n, o) => n + o.items.length, 0),
      machines: new Set(actionable.map(o => o.targetMachine)).size,
      errors: perOrder.length - actionable.length,
    }
    for (const o of perOrder.filter(o => o.error)) warnings.push(`${o.orderNumber}: ${o.error}`)

    if (dryRun) {
      // Plan only — strip bulky before-states down to the step-14 picture.
      const plan = perOrder.map(o => ({
        orderNumber: o.orderNumber, table: o.table, targetMachine: o.targetMachine || null,
        error: o.error || null,
        printLines: (o.items || []).map(i => i.lineNumber),
        currentMachines: (o.before || []).filter(r => Number(r.stepNumber) === STEP).map(r => `${r.lineNumber}: ${r.machine}`),
      }))
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary, warnings, plan }) }
    }

    // EXECUTE — one machines/change per target machine, then verify per order.
    const byMachine = new Map()
    for (const o of actionable) {
      if (!byMachine.has(o.targetMachine)) byMachine.set(o.targetMachine, [])
      byMachine.get(o.targetMachine).push(...o.items)
    }
    const rawResults = []
    for (const [machine, items] of byMachine) {
      const res = await fetch(`${BASE}/api/v1/production-management/machines/change`, {
        method: 'POST', headers: LH(),
        body: JSON.stringify({ items, targetMachineName: machine, recalculateQuote: false, keepSchedulePosition: false }),
      })
      const text = await res.text()
      let parsed; try { parsed = JSON.parse(text) } catch { parsed = { _raw: text.slice(0, 500) } }
      rawResults.push({ machine, http: res.status, response: parsed })
    }

    // Reconcile per line + independent AFTER verification per order
    let success = 0, failed = 0
    for (const o of actionable) {
      o.results = []
      for (const raw of rawResults) {
        for (const r of (raw.response.results || [])) {
          if (r.orderNumber === o.orderNumber) {
            o.results.push({ lineNumber: r.lineNumber, status: r.status, message: r.message || null })
            r.status === 'SUCCESS' ? success++ : failed++
          }
        }
      }
      try {
        const after = await getOrderMachines(o.orderNumber)
        o.changed = []
        for (const b of o.before) {
          const a = after.find(x => x.lineNumber === b.lineNumber && x.stepNumber === b.stepNumber)
          if (a && a.machine !== b.machine) o.changed.push(`line ${b.lineNumber}: '${b.machine}' -> '${a.machine}'`)
        }
      } catch (e) { o.verifyError = e.message }
      delete o.before // keep the response lean
      delete o.items
    }
    summary.success = success
    summary.failed = failed
    console.log(`lift-push-schedule: ${summary.orders} orders, ${success} moved, ${failed} failed`)
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary, warnings, perOrder: actionable, errors: perOrder.filter(o => o.error) }) }
  } catch (err) {
    console.error('lift-push-schedule error:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
