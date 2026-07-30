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
import { parseInventoryWorkbook } from '../../src/lib/inventoryWorkbook.js'
import { parsePayrollWorkbook } from '../../src/lib/payrollWorkbook.js'
import { canWriteAging } from '../../src/lib/arApLock.js'

const SUB        = (process.env.SHAREFILE_SUBDOMAIN     || '').trim()
const CLIENT_ID  = (process.env.SHAREFILE_CLIENT_ID      || '').trim()
const CLIENT_SEC = (process.env.SHAREFILE_CLIENT_SECRET  || '').trim()
const SEED_TOKEN = (process.env.SHAREFILE_REFRESH_TOKEN  || '').trim()
const SB_URL     = process.env.VITE_SUPABASE_URL
const SB_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY

const API = () => `https://${SUB}.sf-api.com/sf/v3`
const TOKEN_KEY = 'sharefile_oauth'
const STATE_KEY = 'sharefile_last_ingested'
const HEALTH_KEY = 'sharefile_health'

// Where Jen's weekly workbook lives, relative to "Shared Folders".
const JEN_PATH = ['DASH WORK', 'Claude Files', 'Purchases']

// Where Abigail's Vena monthly close lands. Folder name is misspelled on
// ShareFile ("Parmount") — that is the real name, do not "fix" it.
const VENA_PATH = ['Parmount Monthly Results']

// AN ALLOW-LIST, NOT A WILDCARD. The naming has drifted four times across six
// months and every variant is a real monthly close:
//   Paramount Prints_Jan26.xlsx
//   Monthly Results_Paramount_Feb26.xlsx
//   Paramount Results_Mar 2026.xlsx
//   Paramount Results vs Forecast_Apr 2026_Updated 052626.xlsx
//   Paramount Results vs Forecast_May 2026.xlsx
//   Paramount Results vs Forecast_June 2026.xlsx
// The previous pattern was `^Paramount Results vs Forecast` — it matched the
// last three and silently ignored January through March.
//
// The same folder holds two files that are NOT monthly closes and must never
// be parsed as one: "Paramount Planned P&L - 3+9 Final Draft Review.xlsx"
// (a plan, 12.4 MB) and "Paramount BNY Results_Dec25_Updated.xlsx" (prior
// year, BNY-only, 45 sheets, a different animal entirely). A bare /\.xlsx$/
// would swallow both, and a parse failure on one file would block the queue
// behind it — so this stays an explicit list of known-good name families.
// A NEW naming variant will be skipped rather than misread, which is the
// right failure: it shows up as a period missing from the P&L, not as a
// wrong number.
const VENA_RE = /^(paramount results vs forecast|paramount results_|monthly results_paramount|paramount prints_)/i

// Month-end substrate inventory. Two workbooks, one per site, same layout.
// Replaces API_Dashboard_MOS_3_0.xlsx, which was a manual upload and reached
// 84 days stale. MOS is retired — this source carries cost but not the
// months-of-supply model, so the tab reports POSITION, not supply cover.
const INV_PATH = ['Inventory Reports']
const INV_FILES = [
  { site: 'passaic', re: /^Paramount Inventory Reporting.*\.xlsx$/i },
  { site: 'bny',     re: /^BNY Inventory Reporting.*\.xlsx$/i },
]

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

  // ─── AR/AP aging ─────────────────────────────────────────────────
  // Parsed on every run since this function was built, and thrown away every
  // time: the write was never ported over from the Admin tile. financial_aging
  // therefore sat at 25 June, sourced from the superseded
  // "Purchases YTD-2026.xlsx", while the live workbook delivered ~190 fresh
  // aging rows daily. Found 28 July when the Finance AR/AP box read a month
  // stale.
  //
  // This is NOT redundant with financial_transactions. Those carry invoiced and
  // received amounts; the aging tabs are the only source of party-level bucket
  // detail — who owes what and how overdue — which is exactly what
  // FinancialTab renders.
  //
  // LOCK RULE (Peter, 2026-06-25) imported from arApLock.js rather than
  // reimplemented, so the scheduled path and the Admin tile can never drift:
  // ONLY AR/AP locks. At Saturday midnight ET the just-completed week's
  // snapshot freezes; later files still refresh OpEx/COGS/CapEx but must not
  // overwrite a locked week's aging.
  //
  // KNOWN EDGE CASE, deliberately preserved rather than quietly fixed here: a
  // CORRECTED file carrying the SAME as-of date inside an already-locked week
  // is kept, not updated. Peter's steer is that AR/AP only has to truly
  // reconcile at month end, when Jen re-sends after close. Changing that
  // behaviour is a decision, not a bug fix.
  try {
    const asOf = parsed.asOfDate
    const existing = await sb('financial_aging?select=as_of_date')
    const seen = [...new Set((existing || []).map(r => r.as_of_date).filter(Boolean))]
    const verdict = canWriteAging(asOf, seen)
    result.jen.aging_as_of = asOf
    result.jen.aging_decision = verdict.reason

    if (!verdict.allowed || !aging.length) {
      result.jen.aging_written = false
    } else {
      // Replace this as-of date only. Each snapshot is a complete picture of
      // one day, so a scoped delete keeps history and stays idempotent.
      await sb(`financial_aging?as_of_date=eq.${encodeURIComponent(asOf)}`, { method: 'DELETE' })
      for (let i = 0; i < aging.length; i += CHUNK) {
        await sb('financial_aging', { method: 'POST', body: JSON.stringify(aging.slice(i, i + CHUNK)) })
      }
      result.jen.aging_written = true
      console.log(`sharefile-sync: loaded ${aging.length} aging rows as of ${asOf}`)
    }
  } catch (e) {
    // Isolated: aging must never take down the transaction load that already
    // succeeded above.
    console.error('aging write:', e)
    result.jen.aging_error = e.message
  }

  await stateSet(STATE_KEY, { ...prior, jen: fingerprint, jen_at: new Date().toISOString() })
  result.jen.written = true
  console.log(`sharefile-sync: loaded ${transactions.length} txns from ${file.Name} (${months.join(', ')})`)
}

// ─── Vena monthly close ──────────────────────────────────────────
// ONE FILE PER RUN, NEWEST OUTSTANDING FIRST.
//
// This used to take only the newest file and keep a single `vena` fingerprint,
// which is correct for the ongoing monthly feed and structurally incapable of
// backfilling: six closes sat on ShareFile and only June was ever in the
// table. Fingerprints are now per FILE, so any month not yet loaded is simply
// outstanding work.
//
// Deliberately one per invocation. A single close is ~1.2 MB to download,
// parses to ~6,000 rows and writes in chunks — roughly five seconds. Six in
// one pass would blow the function timeout and leave a half-written period,
// which is a far worse state than "not loaded yet". The daily cron therefore
// walks back through history one month at a time; hitting sharefile-run
// repeatedly does the same thing faster. `vena_pending` reports how many
// remain so the backfill has a visible finish line.
async function ingestVena(token, opts, result) {
  const folderId = await resolvePath(VENA_PATH, token)
  const kids = await children(folderId, token)
  const prior = (await stateGet(STATE_KEY)) || {}

  const fpOf  = f => `${f.Name}|${f.FileSizeBytes}|${f.ClientModifiedDate || f.ProgenyEditDate || ''}`
  const keyOf = f => `vena:${f.Name}`

  const candidates = kids
    .filter(k => (k['odata.type'] || '').includes('File'))
    .filter(k => { const n = String(k.Name || ''); return VENA_RE.test(n) && /\.xlsx$/i.test(n) && !/^~\$/.test(n) })
    .sort((a, b) =>
      new Date(b.ClientModifiedDate || b.ProgenyEditDate || b.CreationDate || 0) -
      new Date(a.ClientModifiedDate || a.ProgenyEditDate || a.CreationDate || 0))

  if (!candidates.length) { result.vena = { skipped: 'no Vena monthly close found' }; return }

  const pending = candidates.filter(f => opts.force || prior[keyOf(f)] !== fpOf(f))
  if (!pending.length) {
    result.vena = { skipped: 'all monthly closes already loaded', files: candidates.length }
    return
  }

  const file = pending[0]
  const fingerprint = fpOf(file)
  result.vena_pending = pending.length - 1

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

  await stateSet(STATE_KEY, { ...(await stateGet(STATE_KEY)) || {}, [keyOf(file)]: fingerprint, vena_at: new Date().toISOString() })
  result.vena.written = true
  console.log(`sharefile-sync: loaded ${rows.length} Vena rows for ${parsed.period} from ${file.Name}`)
}

// ─── Weekly payroll (UKG earnings export) ───────────────────────────
// ONE FILE PER RUN, NEWEST OUTSTANDING FIRST — same walk-the-backlog pattern
// as Vena, for the same reason: ~12 historical files sit in the folder and
// hand-keyed people_weekly stopped at 2026-06-14, so the first runs are a
// backfill with a visible finish line (`payroll_pending`).
//
// CONFLICT RULE (2026-07-28): FILE IS TRUTH for any week the feed touches.
// The PATCH below overwrites hours/pay/headcount whether they were hand-keyed
// or not; weeks with no payroll file are never touched, so pre-feed manual
// history stands. Where the file disagrees materially with what the row held,
// the divergence is REPORTED in the run result — replaced, not silently.
//
// PATCH-ONLY, NEVER ROW-REPLACE: people_weekly also carries Wendy's HR
// entries (new_hires, exits, leaves, open_roles, hr_notes) which a payroll
// export knows nothing about. The write touches exactly the keys the parser
// returns and nothing else.
//
// WEEK KEY comes from the file's Period Control Date via the parser — NEVER
// the filename, which lies ("Week of 7.22" contains the July 4th week).
const PAYROLL_PATH = ['DASH WORK', 'Claude Files', 'Payroll']

async function ingestPayroll(token, opts, result) {
  const folderId = await resolvePath(PAYROLL_PATH, token)
  const kids = await children(folderId, token)
  const prior = (await stateGet(STATE_KEY)) || {}

  const fpOf  = f => `${f.Name}|${f.FileSizeBytes}|${f.ClientModifiedDate || f.ProgenyEditDate || ''}`
  const keyOf = f => `payroll:${f.Name}`

  const candidates = kids
    .filter(k => (k['odata.type'] || '').includes('File'))
    .filter(k => { const n = String(k.Name || ''); return /earnings/i.test(n) && /\.xlsx$/i.test(n) && !/^~\$/.test(n) })
    .sort((a, b) =>
      new Date(b.ClientModifiedDate || b.ProgenyEditDate || b.CreationDate || 0) -
      new Date(a.ClientModifiedDate || a.ProgenyEditDate || a.CreationDate || 0))

  if (!candidates.length) { result.payroll = { skipped: 'no earnings workbook found in Payroll' }; return }

  const pending = candidates.filter(f => opts.force || prior[keyOf(f)] !== fpOf(f))
  if (!pending.length) {
    result.payroll = { skipped: 'all payroll files already loaded', files: candidates.length }
    return
  }

  const file = pending[0]
  const fingerprint = fpOf(file)
  result.payroll_pending = pending.length - 1

  const buf = await downloadBuffer(file.Id, token)
  const wb = XLSX.read(buf, { type: 'buffer' })

  let parsed
  try {
    parsed = parsePayrollWorkbook(XLSX, wb, { fileName: file.Name })
  } catch (e) {
    // A historical file with an unrecognisable shape must not dam the backlog
    // behind it — newest-first means one bad old file would otherwise block
    // every older week AND retry forever. Mark it consumed-as-failed, loudly,
    // and let the next run move on. A re-uploaded (changed) file gets a new
    // fingerprint and a fresh attempt. This deliberately differs from Jen/Vena,
    // where retry-forever is correct because those are current-period files.
    // Mark consumed with the PLAIN fingerprint so the file never re-queues —
    // the first version stored `FAILED|${fingerprint}`, which could never
    // equal fpOf(file), so the bad file re-queued and re-failed EVERY run and
    // held the Finance badge red forever (caught live 2026-07-30). The
    // failure reason lives under its own key for visibility instead.
    await stateSet(STATE_KEY, {
      ...(await stateGet(STATE_KEY)) || {},
      [keyOf(file)]: fingerprint,
      [`payroll_failed:${file.Name}`]: e.message,
    })
    result.payroll = { file: file.Name, error: `parse failed, file skipped: ${e.message}` }
    console.error(`sharefile-sync payroll: ${file.Name} failed to parse — skipped`, e)
    return
  }

  result.payroll = {
    file: file.Name,
    week_start: parsed.weekStart,
    control_date: parsed.periodControlDate,
    ...parsed.summary,
    warnings: parsed.warnings,
  }

  if (opts.dryRun) { result.payroll.written = false; result.payroll.dryRun = true; return }

  // File-is-truth with divergence reporting: read what the row holds first.
  const existing = await sb(`people_weekly?week_start=eq.${parsed.weekStart}&select=id,nj_total_hrs,bny_total_hrs,nj_total_pay,bny_total_pay`)
  if (existing && existing.length) {
    const row = existing[0]
    const diffs = []
    const cmp = (label, oldV, newV, tol) => {
      if (oldV != null && Math.abs(Number(oldV) - newV) > tol) diffs.push(`${label}: ${oldV} -> ${newV.toFixed(2)}`)
    }
    cmp('nj_total_hrs',  row.nj_total_hrs,  parsed.fields.nj_total_hrs,  0.5)
    cmp('bny_total_hrs', row.bny_total_hrs, parsed.fields.bny_total_hrs, 0.5)
    cmp('nj_total_pay',  row.nj_total_pay,  parsed.fields.nj_total_pay,  1)
    cmp('bny_total_pay', row.bny_total_pay, parsed.fields.bny_total_pay, 1)
    if (diffs.length) {
      result.payroll.replaced_manual_values = diffs
      console.log(`sharefile-sync payroll: week ${parsed.weekStart} values replaced — ${diffs.join(' · ')}`)
    }
    await sb(`people_weekly?week_start=eq.${parsed.weekStart}`, {
      method: 'PATCH',
      body: JSON.stringify(parsed.fields),
    })
  } else {
    await sb('people_weekly', {
      method: 'POST',
      body: JSON.stringify([{ week_start: parsed.weekStart, ...parsed.fields }]),
    })
  }

  await stateSet(STATE_KEY, { ...(await stateGet(STATE_KEY)) || {}, [keyOf(file)]: fingerprint, payroll_at: new Date().toISOString() })
  result.payroll.written = true
  console.log(`sharefile-sync: payroll week ${parsed.weekStart} loaded from ${file.Name} (${parsed.summary.employees} employees, $${parsed.summary.total_pay})`)
}

// ─── Month-end deck library ──────────────────────────────────
// Peter's exec decks, saved BY HAND as PDFs into ShareFile > "Paramount Month
// End Decks" — that folder IS the intake; there is deliberately no upload
// button (same principle as Vena and payroll). Each PDF is mirrored into the
// public `decks` storage bucket and listed in month_end_decks for the
// Finance > Reports shelf. DISPLAY-ONLY: the PDFs are never parsed here.
// Auto-generating these decks from live data is the standing long-term goal
// (Peter, 2026-07-28); when it arrives it lands beside these, as a comparison.
// Known format drift (Dec'25 → Mar'26 decks differ) costs nothing under this
// design and is recorded for the future generation project, not for this one.
const DECKS_PATH = ['Paramount Month End Decks']

// Month from the filename, tolerant of the folder's real spellings —
// including "Feburary". Year: a 20xx in the name wins; otherwise infer, with
// a month later than "now" assumed to be LAST year (a December deck with no
// year, seen in July, is December last year).
const DECK_MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary|urary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i
const DECK_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']

function deckPeriod(name, warnings) {
  const m = DECK_MONTH_RE.exec(name)
  if (!m) { warnings.push(`no month found in "${name}"`); return null }
  const mi = DECK_MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
  const y = /\b(20\d{2})\b/.exec(name)
  const now = new Date()
  const year = y ? +y[1] : (mi > now.getUTCMonth() ? now.getUTCFullYear() - 1 : now.getUTCFullYear())
  if (!y) warnings.push(`no year in "${name}" — inferred ${year}`)
  const label = new Date(Date.UTC(year, mi, 15)).toLocaleString('en-US', { month: 'long' }) + ' ' + year
    + (/draft/i.test(name) ? ' (draft)' : '')
  return { period: `${year}-${String(mi + 1).padStart(2, '0')}-01`, label }
}

async function ingestDecks(token, opts, result) {
  const folderId = await resolvePath(DECKS_PATH, token)
  const kids = await children(folderId, token)
  const prior = (await stateGet(STATE_KEY)) || {}

  const fpOf  = f => `${f.Name}|${f.FileSizeBytes}|${f.ClientModifiedDate || f.ProgenyEditDate || ''}`
  const keyOf = f => `deck:${f.Name}`

  const candidates = kids
    .filter(k => (k['odata.type'] || '').includes('File'))
    .filter(k => /\.pdf$/i.test(String(k.Name || '')))
    .sort((a, b) =>
      new Date(b.ClientModifiedDate || b.ProgenyEditDate || b.CreationDate || 0) -
      new Date(a.ClientModifiedDate || a.ProgenyEditDate || a.CreationDate || 0))

  if (!candidates.length) { result.decks = { skipped: 'no PDFs in Month End Decks' }; return }

  const pending = candidates.filter(f => opts.force || prior[keyOf(f)] !== fpOf(f))
  if (!pending.length) {
    result.decks = { skipped: 'all decks already mirrored', files: candidates.length }
    return
  }

  const file = pending[0]
  const fingerprint = fpOf(file)
  result.decks_pending = pending.length - 1

  const warnings = []
  const meta = deckPeriod(String(file.Name), warnings)

  result.decks = {
    file: file.Name,
    month: meta ? meta.label : null,
    size_mb: Math.round(file.FileSizeBytes / 1048576 * 10) / 10,
    warnings: warnings.length ? warnings : null,
  }

  // A heavyweight PowerPoint print can outrun the function budget mid-transfer
  // and then retry forever. Refuse it loudly instead, consumed-as-failed like
  // the payroll pattern — a re-saved (smaller) file gets a new fingerprint.
  if (file.FileSizeBytes > 25 * 1024 * 1024) {
    // Plain fingerprint for the same reason as the payroll parse-failure path
    // — a FAILED| prefix never matches fpOf() and re-queues forever.
    await stateSet(STATE_KEY, {
      ...(await stateGet(STATE_KEY)) || {},
      [keyOf(file)]: fingerprint,
      [`deck_failed:${file.Name}`]: 'over 25 MB',
    })
    result.decks.error = 'over 25 MB — compress the PDF (PowerPoint > Compress Pictures, then re-save) '
    return
  }

  if (opts.dryRun) { result.decks.written = false; result.decks.dryRun = true; return }

  const buf = await downloadBuffer(file.Id, token)

  // Mirror into the public decks bucket; x-upsert makes a re-saved deck
  // (e.g. the June invoiced-yards correction) replace its file in place.
  const up = await fetch(`${SB_URL}/storage/v1/object/decks/${encodeURIComponent(file.Name)}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/pdf', 'x-upsert': 'true',
    },
    body: buf,
  })
  if (!up.ok) throw new Error(`deck upload ${file.Name}: HTTP ${up.status} ${await up.text()}`)

  await sb('month_end_decks', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{
      file_name: file.Name,
      month_label: meta ? meta.label : file.Name.replace(/\.pdf$/i, ''),
      period: meta ? meta.period : null,
      storage_path: file.Name,
      file_size: file.FileSizeBytes,
      source_modified: file.ClientModifiedDate || file.ProgenyEditDate || null,
    }]),
  })

  await stateSet(STATE_KEY, { ...(await stateGet(STATE_KEY)) || {}, [keyOf(file)]: fingerprint, decks_at: new Date().toISOString() })
  result.decks.written = true
  console.log(`sharefile-sync: deck mirrored — ${file.Name} (${result.decks.month || 'unlabelled'})`)
}

// ─── Month-end inventory (both sites) ───────────────────────────────
async function ingestInventory(token, opts, result) {
  const folderId = await resolvePath(INV_PATH, token)
  const prior = (await stateGet(STATE_KEY)) || {}
  const out = {}
  let anyWritten = false

  for (const { site, re } of INV_FILES) {
    try {
      const file = await newestFile(folderId, token, n => re.test(n) && !/^~\$/.test(n))
      if (!file) { out[site] = { skipped: 'no matching workbook' }; continue }

      const modified = file.ClientModifiedDate || file.ProgenyEditDate || file.CreationDate || ''
      const fingerprint = `${file.Name}|${file.FileSizeBytes}|${modified}`
      const stateKey = `inv_${site}`
      if (!opts.force && prior[stateKey] === fingerprint) {
        out[site] = { skipped: 'unchanged since last run', file: file.Name }
        continue
      }

      // AS-OF: the workbook states no date of its own — the columns just say
      // "current month". ShareFile's modified date is the only honest signal we
      // have, so the tab labels it as the workbook refresh date rather than
      // implying a month end we cannot actually read.
      const asOf = (modified ? new Date(modified) : new Date()).toISOString().slice(0, 10)

      const buf = await downloadBuffer(file.Id, token)
      const wb = XLSX.read(buf, { type: 'buffer' })
      const parsed = parseInventoryWorkbook(XLSX, wb, { fileName: file.Name, site, asOf })

      out[site] = {
        file: file.Name, sheet: parsed.sheet, as_of: asOf,
        ...parsed.summary,
        warnings: parsed.warnings.length ? parsed.warnings : null,
      }

      if (opts.dryRun) { out[site].written = false; out[site].dryRun = true; continue }

      // Upsert on (site, as_of, lift_sku): re-running the same refresh
      // overwrites in place, and a NEW refresh date adds a snapshot rather than
      // replacing one. That accumulation is what makes an inventory TREND
      // possible — the thing the old tab kept promising and could never show.
      const CHUNK = 500
      for (let i = 0; i < parsed.rows.length; i += CHUNK) {
        await sb('inventory_snapshot', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(parsed.rows.slice(i, i + CHUNK)),
        })
      }
      await stateSet(STATE_KEY, { ...(await stateGet(STATE_KEY)) || {}, [stateKey]: fingerprint })
      out[site].written = true
      anyWritten = true
      console.log(`sharefile-sync: loaded ${parsed.rows.length} ${site} inventory SKUs as of ${asOf}`)
    } catch (e) {
      console.error(`inventory ${site}:`, e)
      out[site] = { error: e.message }
    }
  }

  result.inventory = out
  return anyWritten
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

    // Weekly payroll — independent of the feeds above.
    try { await ingestPayroll(token, opts, result) }
    catch (e) { console.error('payroll feed:', e); result.payroll = { error: e.message } }

    // Month-end deck library — mirror-only, never parsed.
    try { await ingestDecks(token, opts, result) }
    catch (e) { console.error('decks feed:', e); result.decks = { error: e.message } }

    // Month-end inventory — both sites, each isolated inside the function.
    try { await ingestInventory(token, opts, result) }
    catch (e) { console.error('inventory feed:', e); result.inventory = { error: e.message } }

    // HEALTH RECORD — what the dashboard badge reads. Written on every run,
    // success or failure. Recency matters as much as outcome: if this function
    // stops firing entirely the badge must go red on STALENESS, because a
    // silently unregistered cron is a failure mode this site has already had
    // (the netlify.toml schedule deployed clean and never ticked).
    result.ok = !result.jen?.error && !result.vena?.error && !result.inventory?.error && !result.payroll?.error && !result.decks?.error
              && !result.jen?.guard_tripped && !result.vena?.guard_tripped
    try { await stateSet(HEALTH_KEY, result) } catch (e) { console.error('health write:', e) }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) }
  } catch (err) {
    console.error('sharefile-sync error:', err)
    // Record the failure too — a badge that only hears about successes is worse
    // than no badge, because it goes quiet exactly when something is wrong.
    try { await stateSet(HEALTH_KEY, { ...result, ok: false, error: err.message }) } catch { /* best effort */ }
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
