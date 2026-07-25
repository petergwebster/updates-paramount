// netlify/functions/sharefile-sync.js
// ===========================================================================
// Automated ShareFile → updates-paramount feed
// ---------------------------------------------------------------------------
// Pulls Jen's weekly GP workbook straight off ShareFile and loads it through
// the SAME code path as the Admin > Financials tile — same parser, same
// completeness guard, same replace-by-fiscal-month. No laptop in the loop.
//
// WHY THIS EXISTS: every finance input was a manual upload from Peter's
// machine. That is a person-dependency sitting exactly where the business is
// trying to remove one. This function reads ShareFile directly from the cloud.
//
// SCHEDULE: daily, not Sunday-only. Jen's file lands early Sunday, but a
// Sunday-only cron has no recovery — a late or bad file costs a whole week.
// The run exits in ~1s when nothing changed, so daily is nearly free.
//
// MODES
//   Scheduled run (cron)    → fetch, parse, guard, WRITE.
//   runSync({dryRun:true})  → fetch, parse, guard, RETURN counts. WRITES NOTHING.
//   (Invoke manually via the companion function sharefile-run — wrapping with
//    schedule() disables public HTTP invocation.)
//
// ENV (set in Netlify — never in code):
//   SHAREFILE_SUBDOMAIN        e.g. schumacher
//   SHAREFILE_CLIENT_ID
//   SHAREFILE_CLIENT_SECRET
//   SHAREFILE_REFRESH_TOKEN    SEED ONLY — see token note below
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// TOKEN NOTE: ShareFile returns a fresh refresh_token on every refresh and a
// Netlify function has no disk to write it to. We persist it in the
// integration_state table and fall back to the env seed only on first run.
// ===========================================================================

// MODULE FORMAT: ESM (package.json has "type": "module"). Deliberate, and
// arrived at the hard way on 2026-07-25:
//   - CJS + dynamic import() of the parser -> parser silently not bundled
//     ("Cannot find module /var/task/src/lib/purchasesWorkbook.js").
//   - ESM + schedule() from @netlify/functions -> the helper ships as CJS and
//     the ESM loader cannot resolve it ("...dist/main.cjs" not found).
// So: ESM with a STATIC parser import (traceable by the bundler) and the
// schedule declared via the exported `config` object, which needs no helper
// library at all. lift-wip-sync.js stays CommonJS with schedule(); the two
// formats coexist fine.
import * as XLSX from 'xlsx'
import { parsePurchasesWorkbook } from '../../src/lib/purchasesWorkbook.js'
import { parseVenaWorkbook } from '../../src/lib/venaWorkbook.js'

const SUB        = (process.env.SHAREFILE_SUBDOMAIN     || '').trim()
const CLIENT_ID  = (process.env.SHAREFILE_CLIENT_ID      || '').trim()
const CLIENT_SEC = (process.env.SHAREFILE_CLIENT_SECRET  || '').trim()
const SEED_TOKEN = (process.env.SHAREFILE_REFRESH_TOKEN  || '').trim()
const SB_URL     = process.env.VITE_SUPABASE_URL
const SB_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY

const API = () => `https://${SUB}.sf-api.com/sf/v3`
const TOKEN_KEY = 'sharefile_oauth'
const STATE_KEY = 'sharefile_last_ingested'

// Where Jen's weekly workbook lives, relative to "Shared Folders".
const JEN_PATH = ['DASH WORK', 'Claude Files', 'Purchases']

// Where Abigail's Vena monthly close lands. Folder name is misspelled on
// ShareFile ("Parmount") — that is the real name, do not "fix" it.
const VENA_PATH = ['Parmount Monthly Results']
const VENA_RE = /^Paramount Results vs Forecast.*\.xlsx$/i

// Guard floor, matching AdminFinancials.jsx and lift-wip-sync: a real
// year-to-date ledger does not lose 30% of its rows in a week.
const GUARD_FLOOR = 0.70

// ─── Supabase (PostgREST) ──────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: HTTP ${res.status} ${await res.text()}`)
  const txt = await res.text()
  return txt ? JSON.parse(txt) : null
}

async function stateGet(key) {
  const rows = await sb(`integration_state?key=eq.${encodeURIComponent(key)}&select=value`)
  return rows && rows.length ? rows[0].value : null
}

async function stateSet(key, value) {
  await sb('integration_state', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
  })
}

async function countRows(table, filter) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}&select=*`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  })
  if (!res.ok) throw new Error(`count ${table}: HTTP ${res.status}`)
  const cr = res.headers.get('content-range') || '0-0/0'
  return parseInt(cr.split('/')[1], 10) || 0
}

// ─── ShareFile auth ────────────────────────────────────────────────────────
async function accessToken() {
  const saved = await stateGet(TOKEN_KEY)
  const refresh = (saved && saved.refresh_token) || SEED_TOKEN
  if (!refresh) throw new Error('No ShareFile refresh token (state empty and SHAREFILE_REFRESH_TOKEN unset)')

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SEC,
    refresh_token: refresh,
  })
  const res = await fetch(`https://${SUB}.sf-api.com/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`ShareFile token refresh failed: HTTP ${res.status} ${await res.text()}`)
  const tok = await res.json()

  // Persist the (possibly rotated) refresh token so the next run can authenticate.
  if (tok.refresh_token) await stateSet(TOKEN_KEY, { refresh_token: tok.refresh_token })
  return tok.access_token
}

// ─── ShareFile navigation ──────────────────────────────────────────────────
async function sfGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`ShareFile GET ${url}: HTTP ${res.status}`)
  return res.json()
}

async function children(id, token) {
  const j = await sfGet(`${API()}/Items(${id})/Children`, token)
  return j.value || []
}

async function resolvePath(segments, token) {
  const root = await sfGet(`${API()}/Items(allshared)`, token)
  let id = root.Id
  for (const seg of segments) {
    const kids = await children(id, token)
    const hit = kids.find(k =>
      (k['odata.type'] || '').includes('Folder') &&
      String(k.Name || '').toLowerCase() === seg.toLowerCase())
    if (!hit) throw new Error(`ShareFile folder not found: ${segments.join(' / ')} (missing "${seg}")`)
    id = hit.Id
  }
  return id
}

// Newest file in a folder, by ShareFile's own modified date (falling back to
// creation date). We deliberately do NOT trust filename ordering — the naming
// in these folders is inconsistent.
async function newestFile(folderId, token, matcher) {
  const kids = await children(folderId, token)
  const files = kids
    .filter(k => (k['odata.type'] || '').includes('File'))
    .filter(k => (matcher ? matcher(String(k.Name || '')) : true))
  if (!files.length) return null
  files.sort((a, b) =>
    new Date(b.ClientModifiedDate || b.ProgenyEditDate || b.CreationDate || 0) -
    new Date(a.ClientModifiedDate || a.ProgenyEditDate || a.CreationDate || 0))
  return files[0]
}

async function downloadBuffer(itemId, token) {
  const res = await fetch(`${API()}/Items(${itemId})/Download`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`ShareFile download failed: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// ─── Jen's weekly GP workbook ──────────────────────────────────────────────
async function ingestJen(token, opts, result) {
  const folderId = await resolvePath(JEN_PATH, token)
  const file = await newestFile(folderId, token, n => /\.xlsx$/i.test(n) && !/^~\$/.test(n))
  if (!file) { result.jen = { skipped: 'no .xlsx found in Purchases' }; return }

  const fingerprint = `${file.Name}|${file.FileSizeBytes}|${file.ClientModifiedDate || file.ProgenyEditDate || ''}`
  const prior = (await stateGet(STATE_KEY)) || {}
  if (!opts.force && prior.jen === fingerprint) {
    result.jen = { skipped: 'unchanged since last run', file: file.Name }
    return
  }

  const buf = await downloadBuffer(file.Id, token)
  const wb = XLSX.read(buf, { type: 'buffer' })
  const parsed = parsePurchasesWorkbook(XLSX, wb, { fileName: file.Name })
  const { transactions, aging, summary } = parsed
  if (!transactions.length) throw new Error(`Parsed 0 transactions from ${file.Name}`)

  const months = summary.fiscalMonths.length
    ? summary.fiscalMonths
    : [...new Set(transactions.map(t => t.fiscal_month).filter(Boolean))]

  // COMPLETENESS GUARD — never let a truncated export wipe good months.
  const incoming = {}
  for (const t of transactions) if (t.fiscal_month) incoming[t.fiscal_month] = (incoming[t.fiscal_month] || 0) + 1
  const shortfalls = []
  for (const m of months) {
    const have = await countRows('financial_transactions', `fiscal_month=eq.${encodeURIComponent(m)}`)
    const coming = incoming[m] || 0
    if (have > 0 && coming < have * GUARD_FLOOR) shortfalls.push(`${m}: ${coming} vs ${have} loaded`)
  }

  result.jen = {
    file: file.Name,
    asOf: parsed.asOfDate,
    months,
    transactions: transactions.length,
    aging: aging.length,
    guard_tripped: shortfalls.length ? shortfalls : null,
  }

  if (shortfalls.length) {
    console.error('sharefile-sync GUARD refused Jen workbook —', shortfalls.join(' · '))
    result.jen.written = false
    return
  }
  if (opts.dryRun) { result.jen.written = false; result.jen.dryRun = true; return }

  for (const m of months) {
    await sb(`financial_transactions?fiscal_month=eq.${encodeURIComponent(m)}`, { method: 'DELETE' })
  }
  // Rows whose trx_date falls outside the fiscal calendar carry a NULL
  // fiscal_month — in practice the GP "Balance Brought Forward" opening
  // balances, dated the day before the fiscal year starts. A month-scoped
  // delete can never match a NULL, so without this they survive the replace
  // AND get re-inserted every run: 4 more rows and ~$1.5M of phantom inventory
  // per week, growing silently. Jen's file is year-to-date and authoritative,
  // so clearing them alongside the dated rows is correct.
  await sb('financial_transactions?fiscal_month=is.null', { method: 'DELETE' })
  const CHUNK = 500
  for (let i = 0; i < transactions.length; i += CHUNK) {
    await sb('financial_transactions', { method: 'POST', body: JSON.stringify(transactions.slice(i, i + CHUNK)) })
  }

  await stateSet(STATE_KEY, { ...prior, jen: fingerprint, jen_at: new Date().toISOString() })
  result.jen.written = true
  console.log(`sharefile-sync: loaded ${transactions.length} txns from ${file.Name} (${months.join(', ')})`)
}

// ─── Vena monthly close ──────────────────────────────────────────
async function ingestVena(token, opts, result) {
  const folderId = await resolvePath(VENA_PATH, token)
  const file = await newestFile(folderId, token, n => VENA_RE.test(n) && !/^~\$/.test(n))
  if (!file) { result.vena = { skipped: 'no "Paramount Results vs Forecast" file found' }; return }

  const fingerprint = `${file.Name}|${file.FileSizeBytes}|${file.ClientModifiedDate || file.ProgenyEditDate || ''}`
  const prior = (await stateGet(STATE_KEY)) || {}
  if (!opts.force && prior.vena === fingerprint) {
    result.vena = { skipped: 'unchanged since last run', file: file.Name }
    return
  }

  const buf = await downloadBuffer(file.Id, token)
  const wb = XLSX.read(buf, { type: 'buffer' })
  const parsed = parseVenaWorkbook(XLSX, wb, { fileName: file.Name })
  const { rows, summary } = parsed

  result.vena = {
    file: file.Name,
    period: parsed.period,
    cost_centers: summary.costCenters,
    timeframes: summary.timeframes,
    scenarios: summary.scenarios,
    rows: rows.length,
    check_610: summary.check_610,
    warnings: parsed.warnings.length ? parsed.warnings : null,
  }

  // SANITY GUARD: if the 610 revenue tie-out point comes back empty the sheet
  // shape has moved and the parse has silently degraded. Refuse rather than
  // write a half-read P&L — the whole point of ingesting Vena is that it is the
  // authoritative number.
  if (summary.check_610.revenue == null || summary.check_610.ebitdap == null) {
    result.vena.written = false
    result.vena.guard_tripped = '610 revenue/EBITDAP not found — sheet shape may have changed'
    console.error('sharefile-sync GUARD refused Vena workbook — 610 tie-out missing')
    return
  }
  if (opts.dryRun) { result.vena.written = false; result.vena.dryRun = true; return }

  // Upsert on the primary key (period, cost_center, timeframe, scenario,
  // line_key). No delete step is needed: reloading a period simply overwrites
  // it, which is idempotent by construction.
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    await sb('vena_monthly', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + CHUNK)),
    })
  }

  await stateSet(STATE_KEY, { ...(await stateGet(STATE_KEY)) || {}, vena: fingerprint, vena_at: new Date().toISOString() })
  result.vena.written = true
  console.log(`sharefile-sync: loaded ${rows.length} Vena rows for ${parsed.period} from ${file.Name}`)
}

// ─── main ──────────────────────────────────────────────────────────────────
async function runSync(event) {
  let opts = {}
  try { if (event && event.body) opts = JSON.parse(event.body) || {} } catch { /* cron sends no body */ }

  const result = { ran_at: new Date().toISOString(), dryRun: !!opts.dryRun }

  // diag mode: report the SHAPE of each credential, never the value. Lengths
  // and whitespace flags are enough to catch a bad paste (wrong field copied,
  // truncated string, trailing newline) without putting a secret on screen.
  if (opts.diag) {
    const shape = (raw) => {
      if (raw == null || raw === '') return 'MISSING'
      const t = raw.trim()
      return `len ${raw.length}` + (t.length !== raw.length ? ` (TRIMS TO ${t.length} \u2014 has surrounding whitespace)` : '')
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      subdomain:     SUB || 'MISSING',
      client_id:     shape(process.env.SHAREFILE_CLIENT_ID),
      client_secret: shape(process.env.SHAREFILE_CLIENT_SECRET),
      refresh_token: shape(process.env.SHAREFILE_REFRESH_TOKEN),
      supabase_url:  SB_URL ? 'set' : 'MISSING',
      supabase_key:  SB_KEY ? 'set' : 'MISSING',
      note: 'refresh_token length should match token.json exactly (74 as of 2026-07-25).',
    }, null, 2) }
  }
  try {
    for (const [k, v] of Object.entries({ SHAREFILE_SUBDOMAIN: SUB, SHAREFILE_CLIENT_ID: CLIENT_ID, SHAREFILE_CLIENT_SECRET: CLIENT_SEC, VITE_SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY })) {
      if (!v) throw new Error(`Missing env var ${k}`)
    }
    const token = await accessToken()

    // Each feed is isolated: a failure in one must not block the other.
    try { await ingestJen(token, opts, result) }
    catch (e) { console.error('jen feed:', e); result.jen = { error: e.message } }

    // Vena monthly close — independent of the Jen feed above.
    try { await ingestVena(token, opts, result) }
    catch (e) { console.error('vena feed:', e); result.vena = { error: e.message } }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) }
  } catch (err) {
    console.error('sharefile-sync error:', err)
    return { statusCode: 500, body: JSON.stringify({ ...result, error: err.message }, null, 2) }
  }
}

// The schedule is declared HERE, in code. The netlify.toml schedule block
// silently fails to register on this site (proven 2026-07-07) — a toml-scheduled
// function deploys clean, reports no error, and never fires.
// Daily 13:00 UTC (9am ET): Jen's file lands early Sunday, but a Sunday-only
// cron has no recovery, and the run exits in ~1s when nothing has changed.
export { runSync }

export default async () => {
  const res = await runSync(null)
  return new Response(res.body, {
    status: res.statusCode,
    headers: res.headers || { 'Content-Type': 'application/json' },
  })
}

export const config = { schedule: '0 13 * * *' }
