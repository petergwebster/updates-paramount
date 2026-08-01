// audit-run.js — public manual trigger for the audit battery.
//
// schedule() disables HTTP invocation on audit-nightly, so this companion is
// how a human (or Claude) fires the battery on demand:
//   POST /.netlify/functions/audit-run              → real run, writes tables
//   POST /.netlify/functions/audit-run {"dryRun":true} → run checks, write nothing
//
// Same pattern as lift-wip-run. Returns the full findings list either way.

const { runAudit } = require('./audit-nightly')

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'POST only' }
  let dryRun = false
  try { dryRun = !!JSON.parse(event.body || '{}').dryRun } catch { /* default false */ }
  try {
    const r = await runAudit('manual', dryRun)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun, ...r }, null, 2),
    }
  } catch (e) {
    console.error('[audit-run] crashed:', e)
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) }
  }
}
