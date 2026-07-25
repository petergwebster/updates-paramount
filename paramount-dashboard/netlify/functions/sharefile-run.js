// netlify/functions/sharefile-run.js
// ===========================================================================
// Manual trigger / diagnostic companion for sharefile-sync.
// ---------------------------------------------------------------------------
// Wrapping a function with schedule() DISABLES public HTTP invocation, so the
// scheduled feed cannot be poked directly. This exposes the same runSync over
// POST — same pattern as lift-wip-run.
//
//   POST {}                    → run for real (fetch, guard, write)
//   POST { "dryRun": true }    → fetch + parse + guard, RETURN counts, WRITE NOTHING
//   POST { "force": true }     → ignore the unchanged-since-last-run check
//
// Use dryRun FIRST on any new deploy: it proves the ShareFile auth, the folder
// path, the parser and the guard all work before anything touches production
// financial data.
// ===========================================================================

// MODULE FORMAT: ESM, matching sharefile-sync.js (see the note there — the
// shared parser must be statically imported to survive bundling).
import { runSync } from './sharefile-sync.js'

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'POST only',
        usage: {
          dryRun: 'POST {"dryRun": true}  — safe: reads and reports, writes nothing',
          real:   'POST {}                — runs the load for real',
          force:  'POST {"force": true}   — ignore the unchanged check',
        },
      }, null, 2),
    }
  }
  return runSync(event)
}
