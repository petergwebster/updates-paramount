// netlify/functions/lift-wip-run.js
// ===========================================================================
// Manual HTTP trigger for the LIFT WIP feed.
//
// The real feed (lift-wip-sync.js) is wrapped with schedule('@hourly'), and
// Netlify disables public HTTP invocation on scheduled functions — so this
// tiny companion exists to preserve the manual trigger and the dryRun
// diagnostic that proved LIFT reachability during the July 2026 debugging.
//
//   POST {}                 → run the sync now (writes a snapshot)
//   POST { "dryRun": true } → fetch + build + report, write nothing
//
// It reuses the exact same code path — one implementation, two doors.
// ===========================================================================

const { runSync } = require('./lift-wip-sync')

exports.handler = (event) => runSync(event)
