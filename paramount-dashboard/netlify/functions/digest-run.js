// digest-run.js — public companion to audit-digest (schedule() disables HTTP
// on the wrapped function; every scheduled function on this site gets a -run
// twin — same pattern as lift-wip-run / audit-run / sharefile-run).
//
//   GET  → returns the LATEST daily_digest row as JSON. This is the endpoint
//          Peter's outside-dash scheduled Claude digest reads to fold
//          dashboard flags into the morning brief. Read-only, no secrets:
//          the same content audit_findings already exposes select-all.
//   POST → builds + posts today's digest now (Task Scheduler primary trigger,
//          and the manual re-test after a fix). Idempotent per date.

const { runDigest } = require('./audit-digest')

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const res = await fetch(
        `${SB_URL}/rest/v1/daily_digest?select=digest_date,built_at,headline,body&order=digest_date.desc&limit=1`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } })
      const rows = await res.json()
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify(rows?.[0] || { headline: 'no digest yet' }, null, 2) }
    }
    const r = await runDigest('manual')
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify(r, null, 2) }
  } catch (e) {
    console.error('digest-run error:', e)
    return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) }
  }
}
