// netlify/functions/sharefile-cron.js
// ---------------------------------------------------------------------------
// The daily trigger for sharefile-sync. Exists because of a three-way
// constraint proven on this site (2026-07-25..30):
//
//   1. netlify.toml [functions] schedule blocks SILENTLY fail to register
//      here (deployed valid syntax, tick never fired — proven 2026-07-07).
//   2. The in-code schedule() wrapper from @netlify/functions DOES work —
//      but it ships as CJS, and sharefile-sync.js must be ESM for its
//      static parser imports to bundle (the module-format saga).
//   3. sharefile-sync's ESM `export const config = { schedule }` was the
//      third mechanism tried — and its first autonomous run NEVER CAME.
//      The health record went stale and the Finance badge ran red all
//      week (Peter, 2026-07-30). Verdict: config-export scheduling does
//      not register on this site either.
//
// So: CJS + schedule() (the one proven mechanism) in a separate tiny
// function that POSTs to sharefile-run over HTTP. sharefile-sync stays ESM
// and untouched. If this file's runs appear in integration_state's
// sharefile_health at ~13:00 UTC daily, the loop is finally closed.
//
// process.env.URL is provided by Netlify (the site's canonical URL).
// ---------------------------------------------------------------------------
const { schedule } = require('@netlify/functions')

async function fireSync() {
  const base = process.env.URL || 'https://updates-paramount.netlify.app'
  try {
    const res = await fetch(`${base}/.netlify/functions/sharefile-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const text = await res.text()
    console.log(`sharefile-cron: fired sharefile-run — HTTP ${res.status} — ${text.slice(0, 300)}`)
    return { statusCode: 200 }
  } catch (e) {
    console.error('sharefile-cron: failed to reach sharefile-run:', e)
    return { statusCode: 500 }
  }
}

exports.handler = schedule('0 13 * * *', fireSync)
