// render-check.mjs — walk the live site like a user and leave evidence.
//
// WHY: every "does the page look right" check has been Peter screenshotting
// and pasting. This script logs in, clicks through every destination and tab
// (the app is state-based — no URLs — so it presses the real buttons), and
// writes full-page screenshots + a report.json of console errors, page
// crashes, and failed network requests into render-checks/RUN_<stamp>/.
// Claude reads that folder through the Filesystem connector. No more pasting.
//
// SETUP (once):
//   cd C:\Dev\updates-paramount\paramount-dashboard
//   npm i -D playwright
//   npx playwright install chromium
//   Create .env.render in this folder (gitignored) containing:
//     RENDER_CHECK_EMAIL=you@example.com
//     RENDER_CHECK_PASSWORD=yourpassword
//     RENDER_CHECK_URL=https://updates-paramount.netlify.app   (optional)
//
// RUN:
//   node scripts/render-check.mjs
//
// Credentials live ONLY in .env.render on this machine. Never in the repo,
// never in chat.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnv() {
  const p = path.join(root, '.env.render')
  if (!fs.existsSync(p)) {
    console.error('Missing .env.render — see the header of this script for setup.')
    process.exit(1)
  }
  const out = {}
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}
const env = loadEnv()
const BASE = env.RENDER_CHECK_URL || 'https://updates-paramount.netlify.app'
if (!env.RENDER_CHECK_EMAIL || !env.RENDER_CHECK_PASSWORD) {
  console.error('.env.render must set RENDER_CHECK_EMAIL and RENDER_CHECK_PASSWORD')
  process.exit(1)
}

// ── output dir ──────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2')
const outDir = path.join(root, '..', 'render-checks', `RUN_${stamp}`)
fs.mkdirSync(outDir, { recursive: true })

// ── the walk ────────────────────────────────────────────────────────────────
// Each step: a name, and an action that gets the app there. Views are
// captured AFTER the action settles. Home screens are reached by the
// destination toggle; sections by clicking a home box once (which summons
// the tab strip) and the nav tabs after that.
const results = []

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })

  // Per-view evidence buckets, reset before each capture.
  let consoleErrors = [], pageErrors = [], failedReqs = []
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500))
  })
  page.on('pageerror', err => pageErrors.push(String(err).slice(0, 500)))
  page.on('requestfailed', req => {
    // net::ERR_ABORTED is a CANCELLED request (React unmount cleanup aborting
    // an in-flight fetch during navigation) — not a failure. Counting it made
    // healthy pages read ERR on the first walk.
    const why = req.failure()?.errorText || '?'
    if (why === 'net::ERR_ABORTED') return
    failedReqs.push(`${req.method()} ${req.url().slice(0, 200)} — ${why}`)
  })
  page.on('response', res => {
    if (res.status() >= 400 && !res.url().includes('favicon'))
      failedReqs.push(`${res.status()} ${res.request().method()} ${res.url().slice(0, 200)}`)
  })

  async function capture(name, settleMs = 2800) {
    await page.waitForTimeout(settleMs)
    const file = `${String(results.length + 1).padStart(2, '0')}_${name}.png`
    await page.screenshot({ path: path.join(outDir, file), fullPage: true })
    results.push({
      name, file,
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      failedRequests: [...failedReqs],
    })
    const bad = consoleErrors.length + pageErrors.length + failedReqs.length
    console.log(`${bad === 0 ? 'OK ' : 'ERR'} ${name}${bad ? `  (${bad} issue${bad > 1 ? 's' : ''})` : ''}`)
    consoleErrors = []; pageErrors = []; failedReqs = []
  }

  const click = async (locator) => { await locator.first().click() }

  console.log(`render-check → ${BASE}`)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // ── login ──
  await page.fill('input[type="email"]', env.RENDER_CHECK_EMAIL)
  await page.fill('input[type="password"]', env.RENDER_CHECK_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForSelector('text=OPERATIONS', { timeout: 20000 })
  await capture('ops_home')

  // ── operations sections ──
  // First section from a home box (summons the tab strip), rest via nav.
  await click(page.getByText('Pulse', { exact: true }))
  await capture('ops_pulse', 4000)
  for (const [tab, name] of [
    ['WIP', 'ops_wip'], ['NEW Goods', 'ops_newgoods'], ['Scheduler', 'ops_scheduler'],
    ['Queue', 'ops_queue'],
    ['Live Ops', 'ops_liveops'], ['Status', 'ops_status'],
  ]) {
    await click(page.getByRole('button', { name: tab, exact: true }))
    await capture(name, tab === 'Scheduler' ? 4500 : tab === 'Queue' ? 4000 : 3000)
  }

  // ── finance ──
  await click(page.getByRole('button', { name: 'FINANCE' }))
  await capture('finance_home', 3500)
  await click(page.getByText('P&L', { exact: true }))
  await capture('finance_pnl', 4000)
  for (const [tab, name] of [
    [/KPIs/, 'finance_kpis'], ['Spend detail', 'finance_spend'],
    ['AR / AP', 'finance_arap'],
    ['Inventory', 'finance_inventory'], ['People', 'finance_people'],
    ['Reports', 'finance_reports'],
  ]) {
    // Regex tolerates the NEW badge inside a tab's accessible name.
    await click(page.getByRole('button', { name: tab, exact: typeof tab === 'string' }))
    await capture(name, 3200)
  }

  // ── procurement (Emily/Lydia destination, 8/1) ──
  await click(page.getByRole('button', { name: 'PROCUREMENT' }))
  await capture('proc_home', 3500)
  await click(page.getByText('Queue', { exact: true }).first())
  await capture('proc_queue', 4000)
  for (const [tab, name] of [
    ['WIP', 'proc_wip'], ['NEW Goods', 'proc_newgoods'],
    ['Procurement WIP', 'proc_procwip'],
  ]) {
    await click(page.getByRole('button', { name: tab, exact: true }))
    await capture(name, 3200)
  }

  await browser.close()
}

function writeReport() {
  const issues = results.filter(r =>
    r.consoleErrors.length || r.pageErrors.length || r.failedRequests.length)
  const report = {
    ranAt: new Date().toISOString(), base: BASE,
    views: results.length, viewsWithIssues: issues.length,
    results,
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${results.length} views captured, ${issues.length} with issues`)
  console.log(`→ ${outDir}`)
  if (issues.length) process.exitCode = 1
}

// The report writes EVEN IF the walk crashes mid-way — a partial run's
// evidence is exactly what you need to fix the crash.
main()
  .then(writeReport)
  .catch(err => { console.error('render-check failed:', err); writeReport(); process.exit(1) })
