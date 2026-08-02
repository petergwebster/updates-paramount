// audit-digest.js — the daily morning digest. Runs 10:30 UTC (~6:30am ET),
// after the 1am audit, before Peter's coffee. Builds ONE summary from data
// that already exists — the latest audit run + findings, the four clocks'
// freshness stamps — writes it to daily_digest (readable by the dashboard AND
// by Peter's outside-dash scheduled Claude digest), and posts it to Slack.
//
// Design decision (Peter, 8/2): this REVERSES July's alert-on-exception-only
// stance for warns. Reds still alert immediately at 1am via audit-nightly;
// this digest is the daily "here is everything amber and what to do about
// it" — short on clean days so it stays readable.
//
// SCHEDULING: CJS in-code schedule() — the only mechanism that registers on
// this site. schedule() disables HTTP, so digest-run.js is the companion
// (manual trigger + GET for the outside-dash digest to read).
//
// IDEMPOTENT: upserts one daily_digest row per date; Slack posts only once
// per date (slack_sent recorded in body), so Task-Scheduler + Netlify-cron
// double-fires are harmless.

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

async function buildDigest() {
  const today = new Date().toISOString().slice(0, 10)

  // 1. Latest audit run + non-pass findings (with detail so order numbers show)
  const runs = await sb('audit_runs?select=id,ran_at,checks_run,passed,warned,failed&order=ran_at.desc&limit=1')
  const run = runs?.[0] || null
  let findings = []
  if (run) findings = await sb(
    `audit_findings?select=check_key,status,summary,detail&run_id=eq.${run.id}&status=neq.pass`) || []

  // 2. The four clocks
  const snaps = await sb('sched_snapshots?select=uploaded_at&order=uploaded_at.desc&limit=1')
  const sfRows = await sb('integration_state?select=value&key=eq.sharefile_health')
  const sf = sfRows?.[0]?.value || {}
  const clocks = {
    lift_hourly:   { last: snaps?.[0]?.uploaded_at || null, ok: hoursSince(snaps?.[0]?.uploaded_at) < 3 },
    finance_daily: { last: sf.ran_at || null, ok: sf.ok === true && hoursSince(sf.ran_at) < 26 },
    audit_nightly: { last: run?.ran_at || null, ok: hoursSince(run?.ran_at) < 26 },
  }

  // 3. Items awaiting disposition = every entity in an amber kit finding not
  // yet trained into audit_exceptions (fix-in-LIFT items keep appearing here
  // until the data changes — that IS the open queue).
  const items = []
  for (const f of findings) {
    const list = f.detail?.outliers || f.detail?.broken || []
    for (const it of list) items.push({ check: f.check_key, ...it })
  }

  // 4. Compose
  const clockLine = Object.entries(clocks)
    .map(([k, v]) => `${v.ok ? '✓' : '✗'} ${k.replace(/_/g, ' ')}`).join(' · ')
  let headline, lines = []
  if (!run) {
    headline = 'No audit run found — the auditor itself may be down.'
  } else if (findings.length === 0 && Object.values(clocks).every(c => c.ok)) {
    headline = `All ${run.checks_run} checks pass · all clocks fired · nothing needs you.`
  } else {
    headline = `${run.failed} red / ${run.warned} amber of ${run.checks_run} checks · ${items.length} item(s) awaiting disposition.`
    for (const f of findings) {
      lines.push(`${f.status === 'fail' ? '🔴' : '🟡'} *${f.check_key}* — ${f.summary}`)
      const list = f.detail?.outliers || f.detail?.broken || f.detail?.untriaged || []
      for (const it of list.slice(0, 6)) {
        if (typeof it === 'string') lines.push(`    · ${it}`)
        else lines.push(`    · ${it.order || it.period || ''} ${it.why || it.summary || ''}`.trimEnd())
      }
    }
    for (const [k, v] of Object.entries(clocks))
      if (!v.ok) lines.push(`🔴 clock *${k}* — last fired ${v.last || 'never'}`)
  }

  const body = { run, findings, clocks, items, lines }
  return { today, headline, clockLine, body, lines }
}

async function runDigest(trigger = 'scheduled') {
  const { today, headline, clockLine, body, lines } = await buildDigest()

  // Already built + posted today? (double-fire guard)
  const existing = await sb(`daily_digest?select=body&digest_date=eq.${today}`)
  const alreadySent = existing?.[0]?.body?.slack_sent === true

  let slack = { ok: false, reason: 'skipped' }
  if (!alreadySent) {
    const text = `☀️ *Paramount daily digest — ${today}*\n${headline}\n${clockLine}`
      + (lines.length ? `\n${lines.join('\n')}` : '')
      + `\n_Dashboard → gear → Feed health to disposition items (Correct = train it · leave open = fix in LIFT)._`
    slack = await slackNotify(text)
  }

  await sb(`daily_digest?on_conflict=digest_date`, {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
    body: { digest_date: today, headline,
            body: { ...body, slack_sent: alreadySent || slack.ok, trigger } },
  })
  return { today, headline, items: body.items.length, slack_sent: alreadySent || slack.ok }
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
