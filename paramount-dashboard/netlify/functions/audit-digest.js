// audit-digest.js — the daily morning digest AND the forward-ready audit
// report. Runs 10:30 UTC (6:30am ET), after the 1am audit, before Peter's
// coffee. Builds ONE truth from data that already exists — the latest audit
// run + findings (now carrying research identity: PO · SKU · pattern ·
// colorway · customer), the clocks' freshness stamps — and delivers it three
// ways from one source:
//   1. daily_digest row  → the dashboard (Feed health report block)
//   2. Slack post        → the audit channel (once per day, guarded)
//   3. digest-run GET    → Peter's outside-dash morning brief
//
// body.report is the FORWARD-READY layer (Peter, 8/3): headline counts, a
// plain-English narrative per issue (no check_key jargon — terms the team
// understands), the research table, and a Slack-formatted memo Peter can
// forward verbatim. The briefer RELAYS this instead of interpreting raw
// digest JSON — that's what killed the 8/3-morning stale-memo problem class.
//
// TIME RULE (Peter, 8/3): everything rendered for humans is US Eastern.
//
// SCHEDULING: CJS in-code schedule() — the only mechanism that registers on
// this site. schedule() disables HTTP, so digest-run.js is the companion.
// IDEMPOTENT: one daily_digest row per date, Slack once per date.

const { schedule } = require('@netlify/functions')
const { slackNotify } = require('./audit-nightly')

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function sb(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const hoursSince = (d) => d ? (Date.now() - new Date(d).getTime()) / 3600000 : null
const ET = { timeZone: 'America/New_York' }
const etStamp = (d = new Date()) => new Date(d).toLocaleString('en-US',
  { ...ET, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const etDay = (d = new Date()) => new Date(d).toLocaleDateString('en-US',
  { ...ET, weekday: 'short', month: 'short', day: 'numeric' })

// ─── Plain-English layer ───────────────────────────────────────────────────
// Every check gets a human name + a one-line explanation of what a failure
// MEANS in business terms. Unknown keys fall back to the raw summary.
const FRIENDLY = {
  kit_price_band:   { name: 'Pricing check',
    what: 'an invoiced price that does not fit the kit price structure — usually a keying error in LIFT' },
  kit_integrity:    { name: 'Kit / ground check',
    what: 'print orders whose kitted ground is missing or does not match the print yardage' },
  files_triage:     { name: 'Document intake',
    what: 'a file arrived in the drop folders that no feed has read and nobody has dispositioned' },
  hti_chain:        { name: 'Held-to-invoice continuity',
    what: 'the month-to-month held-to-invoice numbers no longer chain — a deck or data edit broke the sequence' },
  sharefile_health: { name: 'Finance feed',
    what: 'the daily finance file sync has not completed on schedule' },
  lift_freshness:   { name: 'LIFT feed',
    what: 'the hourly LIFT order feed has stopped delivering' },
  lift_completeness:{ name: 'LIFT feed size',
    what: 'the LIFT pull came back suspiciously small — possible truncation' },
  txn_bbf_guard:    { name: 'GP transaction integrity',
    what: 'phantom balance-brought-forward rows are accumulating in the transaction table' },
  txn_single_source:{ name: 'GP file consistency',
    what: 'transactions are loaded from more than one weekly file at once' },
  deck_freshness:   { name: 'Month-end deck age',
    what: 'the newest month-end deck is older than expected' },
  deck_kpis_shape:  { name: 'Deck KPI completeness',
    what: 'the extracted deck KPIs are missing expected rows' },
  deck_vena_coverage:{ name: 'Deck ↔ Vena coverage',
    what: 'a loaded month is missing its matching Vena financials (or vice versa)' },
  cost_per_yd_sane: { name: 'Cost per yard sanity',
    what: 'a computed cost per yard fell outside the plausible range' },
  vena_period_volume:{ name: 'Vena load size',
    what: 'a Vena month loaded with far fewer rows than normal' },
  people_freshness: { name: 'Payroll feed',
    what: 'no new payroll week has landed in the expected window' },
  order_ledger_floor:{ name: 'Order ledger',
    what: 'the order ledger shrank — it should only ever grow' },
}

// One research-table line per flagged item. Fields arrive from the audit's
// identity stamp; anything absent renders as an em-dash.
const itemRow = (it) => ({
  po: it.po || '—', order: it.order || '—', sku: it.sku || '—',
  pattern: [it.pattern, it.colorway].filter(Boolean).join(' / ') || '—',
  customer: it.customer || '—',
  yards: it.printYds != null ? `${it.printYds} print${it.groundYds != null ? ` / ${it.groundYds} ground` : ''}`
       : it.perYd != null ? `$${it.perYd}/yd` : '—',
  why: it.why || it.summary || '—',
})

function composeReport(run, findings, clocks) {
  const nonPass = findings.filter(f => f.status !== 'pass')
  const items = []
  for (const f of nonPass) {
    const list = f.detail?.outliers || f.detail?.broken || f.detail?.untriaged || []
    for (const it of list) if (typeof it === 'object') items.push({ check: f.check_key, ...itemRow(it) })
  }

  const clocksOk = Object.values(clocks).every(c => c.ok)
  const headline = !run
    ? 'No audit run found — the auditor itself may be down.'
    : `${run.failed} red / ${run.warned} amber of ${run.checks_run} checks · ${items.length} item(s) need eyes · clocks ${clocksOk ? 'all healthy' : 'NOT all healthy'}.`

  // Narrative: one plain paragraph per issue, grouped where grouping helps.
  const narrative = []
  for (const f of nonPass) {
    const fr = FRIENDLY[f.check_key] || { name: f.check_key, what: f.summary }
    if (f.check_key === 'kit_integrity') {
      const list = f.detail?.broken || []
      const ratio = list.filter(x => x.groundYds > 0)
      const zero  = list.filter(x => !x.groundYds)
      if (ratio.length) narrative.push(
        `${ratio.length} order(s) show kitted ground out of proportion to the print yardage — most at a suspiciously clean ratio. Question for the team: is that a deliberate ordering convention (e.g. hub pass-through on the same PO) or a duplicated/mis-keyed ground line? One LIFT lookup usually answers a whole group.`)
      if (zero.length) narrative.push(
        `${zero.length} order(s) have no ground kitted at all past the material stage. Unless the customer supplies their own material, the ground needs adding in LIFT before these hit the table.`)
    } else {
      narrative.push(`${fr.name}: ${fr.what}. (${f.summary})`)
    }
  }
  for (const [k, v] of Object.entries(clocks)) if (!v.ok)
    narrative.push(`Clock warning: ${k.replace(/_/g, ' ')} last fired ${v.last ? etStamp(v.last) + ' ET' : 'never'} — the schedule may have skipped.`)
  if (narrative.length === 0) narrative.push('Nothing needs attention — every check passed and every feed is on schedule.')

  // Forward-ready Slack memo (Peter reviews & sends — never auto-posted).
  let memo = `:bar_chart: *Paramount Dashboard — daily audit (${etDay()})*\n${headline}`
  if (items.length) {
    memo += `\n\nAll flagged items below — please check the LIFT entries; fix what's wrong, and tell Peter which are actually correct so the dashboard learns them:`
    const byCheck = {}
    for (const it of items) (byCheck[it.check] = byCheck[it.check] || []).push(it)
    for (const [check, list] of Object.entries(byCheck)) {
      const fr = FRIENDLY[check] || { name: check }
      memo += `\n\n*${fr.name}* (${list.length})`
      for (const it of list)
        memo += `\n• ${it.po} / ${it.order} — ${it.sku} ${it.pattern}${it.customer !== '—' ? ` (${it.customer})` : ''} — ${it.yards} — ${it.why}`
    }
    memo += `\n\nThanks! :pray:`
  } else {
    memo += `\nAll clear — nothing for the team today.`
  }

  return { generated: `${etStamp()} ET`, headline, narrative, items, memo }
}

async function buildDigest() {
  const today = new Date().toISOString().slice(0, 10)

  const runs = await sb('audit_runs?select=id,ran_at,checks_run,passed,warned,failed&order=ran_at.desc&limit=1')
  const run = runs?.[0] || null
  let findings = []
  if (run) findings = await sb(
    `audit_findings?select=check_key,status,summary,detail&run_id=eq.${run.id}&status=neq.pass`) || []

  const snaps = await sb('sched_snapshots?select=uploaded_at&order=uploaded_at.desc&limit=1')
  const sfRows = await sb('integration_state?select=value&key=eq.sharefile_health')
  const sf = sfRows?.[0]?.value || {}
  const clocks = {
    lift_hourly:   { last: snaps?.[0]?.uploaded_at || null, ok: hoursSince(snaps?.[0]?.uploaded_at) < 3 },
    finance_daily: { last: sf.ran_at || null, ok: sf.ok === true && hoursSince(sf.ran_at) < 26 },
    audit_nightly: { last: run?.ran_at || null, ok: hoursSince(run?.ran_at) < 26 },
  }

  const report = composeReport(run, findings, clocks)

  // Slack digest = the short version; the memo + table live in the report.
  const clockLine = Object.entries(clocks)
    .map(([k, v]) => `${v.ok ? '✓' : '✗'} ${k.replace(/_/g, ' ')}`).join(' · ')
  const slackText = `☀️ *Paramount daily digest — ${etDay()}*\n${report.headline}\n${clockLine}`
    + (report.items.length
        ? `\n${report.items.length} item(s) on the research list — full report + forward-ready memo in the morning brief and on Dashboard → gear → Feed health.`
        : '')

  const body = { run, findings, clocks, report, slack_text: slackText }
  return { today, report, body, slackText }
}

async function runDigest(trigger = 'scheduled') {
  const { today, report, body, slackText } = await buildDigest()

  const existing = await sb(`daily_digest?select=body&digest_date=eq.${today}`)
  const alreadySent = existing?.[0]?.body?.slack_sent === true

  let slack = { ok: false, reason: 'already sent today' }
  if (!alreadySent) slack = await slackNotify(slackText)

  await sb(`daily_digest?on_conflict=digest_date`, {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
    body: { digest_date: today, headline: report.headline,
            body: { ...body, slack_sent: alreadySent || slack.ok, trigger } },
  })
  return { today, headline: report.headline, items: report.items.length,
           slack_sent: alreadySent || slack.ok }
}

exports.runDigest = runDigest
exports.handler = schedule('30 10 * * *', async () => {
  try {
    const r = await runDigest('scheduled')
    console.log(`[audit-digest] ${r.today}: ${r.headline}`)
    return { statusCode: 200 }
  } catch (e) {
    console.error('[audit-digest] crashed:', e)
    return { statusCode: 500 }
  }
})
