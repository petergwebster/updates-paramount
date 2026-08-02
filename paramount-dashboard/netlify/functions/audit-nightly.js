// audit-nightly.js — the data-integrity battery. Runs at 05:00 UTC (~1am ET,
// after the day's feeds have all fired) and writes one audit_runs row plus an
// audit_findings row per check — passes included, so "when did this start
// failing" is a query, not archaeology.
//
// SCHEDULING: in-code schedule() wrapper, CommonJS — the ONLY mechanism that
// registers on this site (netlify.toml blocks and ESM config exports both
// silently fail; proven July 2026). schedule() disables HTTP invocation, so
// audit-run.js is the public manual trigger; it requires runAudit from here.
//
// Every check encodes something this project learned the hard way:
// the HTI chain was the deck extraction's verification gate; the BBF guard
// exists because four NULL-month rows once compounded $1.55M/week of phantom
// inventory; the completeness check re-states the lift-wip-sync guard at rest.

const { schedule } = require('@netlify/functions')

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// ── Slack on FAILURE ONLY ── warns stay badge-amber; the nightly all-clear is
// deliberately silent (a daily "all good" trains everyone to stop reading).
// Uses the SAME bot-token plumbing as the edge functions (chat.postMessage,
// SLACK_BOT_TOKEN). Channel: SLACK_AUDIT_CHANNEL_ID if set, else the
// production notes channel — rerouting later is one env var, no code.
// Peter's Slack ID from the edge functions' role map.
const SLACK_PETER = 'U044K8RGAMS'
async function slackNotify(text) {
  try {
    const token = process.env.SLACK_BOT_TOKEN
    const channel = process.env.SLACK_AUDIT_CHANNEL_ID || process.env.SLACK_NOTES_CHANNEL_ID
    if (!token || !channel) return { ok: false, reason: 'slack env not set' }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    })
    const j = await res.json()
    return { ok: !!j.ok, reason: j.error }
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}

async function sb(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (method === 'HEAD') {
    const range = res.headers.get('content-range') || ''
    return { count: Number(range.split('/')[1] || 0), ok: res.ok }
  }
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}`)
  // PostgREST answers bare POSTs with 201 and an EMPTY body — res.json() on
  // nothing throws. Parse only what exists.
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
const headCount = (path) => sb(path, { method: 'HEAD', headers: { Prefer: 'count=exact' } })

const daysSince = (d) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null
const hoursSince = (d) => d ? (Date.now() - new Date(d).getTime()) / 3600000 : null

// ── the checks ──────────────────────────────────────────────────────────────
// Each returns { status: 'pass'|'warn'|'fail', summary, detail }.

async function checkDeckKpis() {
  // One fetch feeds four checks: chain, shape, freshness, and (with vena) $/yd.
  const rows = await sb(
    'deck_kpis?select=period,cost_center,metric_key,scenario,value'
    + '&unit=eq.yards&cut_type=eq.total&cut_key=eq.total')
  const periods = [...new Set(rows.map(r => r.period))].sort()
  const val = (p, cc, mk) => rows.find(r =>
    r.period === p && r.cost_center === cc && r.metric_key === mk && r.scenario === 'actual')?.value

  // 1. hti_chain
  const breaks = []
  for (const cc of ['610', '609'])
    for (let i = 1; i < periods.length; i++) {
      const h = val(periods[i - 1], cc, 'hti'), p = val(periods[i], cc, 'prior_hti')
      if (h == null || p == null || Math.abs(h - p) >= 1)
        breaks.push({ cc, from: periods[i - 1], to: periods[i], hti: h, prior: p })
    }
  const chain = breaks.length === 0
    ? { status: 'pass', summary: `HTI chain closes across all ${periods.length} months, both cost centres`, detail: { links: (periods.length - 1) * 2 } }
    : { status: 'fail', summary: `HTI chain broken at ${breaks.length} link(s)`, detail: { breaks } }

  // 2. deck_kpis_shape
  const thin = []
  for (const p of periods) for (const cc of ['610', '609']) {
    const a = rows.filter(r => r.period === p && r.cost_center === cc && r.scenario === 'actual').length
    const t = rows.filter(r => r.period === p && r.cost_center === cc && r.scenario === 'target').length
    if (a < 6 || t < 6) thin.push({ period: p, cc, actuals: a, targets: t })
  }
  const shape = thin.length === 0
    ? { status: 'pass', summary: 'Every deck month carries its full actual and target set', detail: { periods: periods.length } }
    : { status: 'warn', summary: `${thin.length} month/CC combination(s) missing actuals or targets`, detail: { thin } }

  // 3. deck_freshness — nag ~40 days after the latest extracted month ends
  const latest = periods[periods.length - 1]
  const monthEnd = new Date(latest); monthEnd.setMonth(monthEnd.getMonth() + 1)
  const overdue = daysSince(monthEnd.toISOString())
  const fresh = overdue <= 40
    ? { status: 'pass', summary: `Latest extracted deck month is ${latest.slice(0, 7)}`, detail: { latest, daysPastMonthEnd: overdue } }
    : { status: 'warn', summary: `Newest deck month is ${latest.slice(0, 7)} — the next deck is likely published but not extracted`, detail: { latest, daysPastMonthEnd: overdue } }

  return { chain, shape, fresh, periods, invoiced: Object.fromEntries(
    periods.flatMap(p => ['610', '609'].map(cc => [`${cc}|${p}`, val(p, cc, 'invoiced')]))) }
}

async function checkVena(deckPeriods, invoiced) {
  const rows = await sb(
    'vena_monthly?select=period,cost_center,line_key,amount'
    + '&timeframe=eq.month&scenario=eq.actual'
    + '&line_key=in.(total_revenue,total_cost_of_goods_sold)'
    + '&cost_center=in.(610,609)')
  const amt = (p, cc, lk) => {
    const r = rows.find(x => x.period === p && x.cost_center === cc && x.line_key === lk)
    return r ? Number(r.amount) : null
  }

  // 4. deck_vena_coverage — every deck month must be joinable
  const gaps = []
  for (const p of deckPeriods) {
    const vp = p.slice(0, 7)
    for (const cc of ['610', '609'])
      for (const lk of ['total_revenue', 'total_cost_of_goods_sold'])
        if (amt(vp, cc, lk) == null) gaps.push({ period: vp, cc, missing: lk })
  }
  const coverage = gaps.length === 0
    ? { status: 'pass', summary: 'Every deck month has Vena revenue and COGS to join', detail: { months: deckPeriods.length } }
    : { status: 'fail', summary: `${gaps.length} Vena line(s) missing for deck months — dollar rows will show gaps`, detail: { gaps } }

  // 5. cost_per_yd_sane — COGS ÷ invoiced yards between $3 and $40
  const odd = []
  for (const p of deckPeriods) for (const cc of ['610', '609']) {
    const cogs = amt(p.slice(0, 7), cc, 'total_cost_of_goods_sold')
    const inv = invoiced[`${cc}|${p}`]
    if (cogs == null || !inv) continue
    const cpy = cogs / inv
    if (cpy < 3 || cpy > 40) odd.push({ period: p.slice(0, 7), cc, costPerYd: Math.round(cpy * 100) / 100 })
  }
  const sane = odd.length === 0
    ? { status: 'pass', summary: 'Cost per invoiced yard within $3–$40 everywhere', detail: {} }
    : { status: 'warn', summary: `${odd.length} cost-per-yard value(s) outside sanity band — check units`, detail: { odd } }

  // 6. vena_period_volume — a loaded period under 3,000 rows is a partial load
  const light = []
  for (const p of deckPeriods) {
    const { count } = await headCount(`vena_monthly?period=eq.${p.slice(0, 7)}&select=period`)
    if (count < 3000) light.push({ period: p.slice(0, 7), rows: count })
  }
  const volume = light.length === 0
    ? { status: 'pass', summary: 'Every Vena period fully loaded (≥3,000 rows)', detail: {} }
    : { status: 'warn', summary: `${light.length} Vena period(s) look partially loaded`, detail: { light } }

  return { coverage, sane, volume }
}

async function checkTransactions() {
  // 7. txn_bbf_guard — the four known BBF rows must stay exactly ≤4
  const { count: nulls } = await headCount('financial_transactions?fiscal_month=is.null&select=id')
  const bbf = nulls <= 4
    ? { status: 'pass', summary: `${nulls} NULL-fiscal-month rows (the known BBF set)`, detail: { nulls } }
    : { status: 'fail', summary: `${nulls} NULL-fiscal-month rows — the BBF compounding bug may be back`, detail: { nulls, expectedMax: 4 } }

  // 8. txn_single_source — idempotency invariant
  const srcRows = await sb('financial_transactions?select=source_file&limit=20000')
  const sources = [...new Set(srcRows.map(r => r.source_file))]
  const single = sources.length === 1
    ? { status: 'pass', summary: 'financial_transactions carries exactly one source_file', detail: { source: sources[0] } }
    : { status: 'warn', summary: `${sources.length} distinct source_files — scope-replace may have missed a wipe`, detail: { sources } }
  return { bbf, single }
}

async function checkLift() {
  const snaps = await sb('sched_snapshots?select=uploaded_at,total_rows&order=uploaded_at.desc&limit=24')
  // 9. lift_freshness
  const age = hoursSince(snaps[0]?.uploaded_at)
  const freshness = age != null && age < 3
    ? { status: 'pass', summary: `Latest LIFT snapshot ${age.toFixed(1)}h old`, detail: { latest: snaps[0]?.uploaded_at } }
    : { status: 'fail', summary: `Latest LIFT snapshot is ${age == null ? 'missing' : age.toFixed(1) + 'h old'} — hourly feed may be down`, detail: { latest: snaps[0]?.uploaded_at } }
  // 10. lift_completeness — latest vs median of recent
  const sizes = snaps.map(s => s.total_rows).filter(n => n != null).sort((a, b) => a - b)
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0
  const latestRows = snaps[0]?.total_rows || 0
  const completeness = median === 0 || latestRows >= median * 0.7
    ? { status: 'pass', summary: `Latest snapshot ${latestRows} rows vs recent median ${median}`, detail: { latestRows, median } }
    : { status: 'warn', summary: `Latest snapshot ${latestRows} rows is <70% of recent median ${median}`, detail: { latestRows, median } }
  return { freshness, completeness }
}

async function checkShareFile() {
  // 11. sharefile_health — ran within 26h and ok
  const rows = await sb('integration_state?select=value&key=eq.sharefile_health')
  const v = rows?.[0]?.value || {}
  const age = hoursSince(v.ran_at)
  const good = v.ok === true && age != null && age < 26
  return {
    health: good
      ? { status: 'pass', summary: `Finance feed ran ${age.toFixed(1)}h ago, ok:true`, detail: { ran_at: v.ran_at } }
      : { status: 'fail', summary: `Finance feed ${v.ok !== true ? 'reported not-ok' : 'has not run in ' + (age == null ? '∞' : age.toFixed(0)) + 'h'}`, detail: { ran_at: v.ran_at, ok: v.ok } },
  }
}

async function checkPeople() {
  // 12. people_freshness
  const rows = await sb('people_weekly?select=week_start&order=week_start.desc&limit=1')
  const age = daysSince(rows?.[0]?.week_start)
  return {
    people: age != null && age <= 21
      ? { status: 'pass', summary: `Newest payroll week ${rows[0].week_start} (${age}d old)`, detail: {} }
      : { status: 'warn', summary: `Newest payroll week is ${age == null ? 'missing' : age + ' days old'}`, detail: { latest: rows?.[0]?.week_start } },
  }
}

async function checkLedger() {
  // 13. order_ledger_floor — never pruned, can only grow
  const { count } = await headCount('order_ledger?select=order_number')
  return {
    ledger: count >= 14000
      ? { status: 'pass', summary: `order_ledger holds ${count} orders`, detail: { count } }
      : { status: 'warn', summary: `order_ledger has shrunk to ${count} orders — it is never supposed to be pruned`, detail: { count, floor: 14000 } },
  }
}

async function checkKitAnatomy() {
  // 14 + 15 — the LIFT kit doctrine as machinery (8/2). Hand-screen orders
  // kit a PRINT line (carries the FULL kit $) with a GROUND line (~1:1 yards,
  // ~$0), linked by shared PO. Outliers here are almost always LIFT ENTRY
  // ERRORS — a price keyed per-roll instead of per-yard, a kit built without
  // its ground — and the whole point is catching them the morning after
  // they're keyed, while the order is still warm. Peter's doctrine: track
  // problems back to what was ENTERED, not what a report spat out.
  const d7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const d14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)

  // 14. kit_price_band — SCH intercompany per-yd kit price inside its band.
  // Bands from observed July ranges with headroom: Grass $14–26, Paper $4–9.
  // 3P excluded (list pricing ~2x); Fabric excluded (residual unexplained —
  // COM/specialty grounds; open with Brynn before it can carry a band).
  const BAND = { Grass: [14, 26], Paper: [4, 9] }
  const inv = await sb(
    'order_ledger?select=order_number,product_type,yards_invoiced,invoiced_revenue'
    + `&site=eq.passaic&customer_type=eq.Schumacher&product_type=in.(Grass,Paper)`
    + `&invoice_date=gte.${d7}&yards_invoiced=gt.0`)
  const outliers = []
  for (const r of (inv || [])) {
    const perYd = Number(r.invoiced_revenue) / Number(r.yards_invoiced)
    const [lo, hi] = BAND[r.product_type]
    if (perYd < lo || perYd > hi)
      outliers.push({ order: r.order_number, type: r.product_type, perYd: Math.round(perYd * 100) / 100, band: `${lo}–${hi}` })
  }
  const band = outliers.length === 0
    ? { status: 'pass', summary: `All SCH kit prices invoiced this week sit inside their bands (${(inv || []).length} order(s))`, detail: { checked: (inv || []).length } }
    : { status: 'warn', summary: `${outliers.length} order(s) invoiced outside the SCH kit price band — likely LIFT entry error`, detail: { outliers: outliers.slice(0, 10) } }

  // 15. kit_integrity — ground yards ≈ print yards (1:1 kitting) on recently
  // written Grass/Paper orders. Missing or badly mismatched ground = the kit
  // was built wrong at entry. Ratio tolerance 0.7–1.3.
  const wrt = await sb(
    'order_ledger?select=order_number,product_type,yards_written,ground_yards'
    + `&site=eq.passaic&product_type=in.(Grass,Paper)`
    + `&order_created=gte.${d14}&yards_written=gt.0`)
  const broken = []
  for (const r of (wrt || [])) {
    const gy = Number(r.ground_yards || 0), py = Number(r.yards_written)
    const ratio = gy / py
    if (gy === 0 || ratio < 0.7 || ratio > 1.3)
      broken.push({ order: r.order_number, type: r.product_type, printYds: py, groundYds: gy })
  }
  const integrity = broken.length === 0
    ? { status: 'pass', summary: `Every recent Grass/Paper order kits its ground ~1:1 (${(wrt || []).length} order(s))`, detail: { checked: (wrt || []).length } }
    : { status: 'warn', summary: `${broken.length} recent order(s) with missing or mismatched kitted ground — check the LIFT entry`, detail: { broken: broken.slice(0, 10) } }

  return { band, integrity }
}

// ── the run ─────────────────────────────────────────────────────────────────
async function runAudit(trigger = 'nightly', dryRun = false) {
  const t0 = Date.now()
  const findings = []
  const add = (key, r) => findings.push({ check_key: key, status: r.status, summary: r.summary, detail: r.detail || {} })

  const deck = await checkDeckKpis()
  add('hti_chain', deck.chain); add('deck_kpis_shape', deck.shape); add('deck_freshness', deck.fresh)
  const vena = await checkVena(deck.periods, deck.invoiced)
  add('deck_vena_coverage', vena.coverage); add('cost_per_yd_sane', vena.sane); add('vena_period_volume', vena.volume)
  const txn = await checkTransactions()
  add('txn_bbf_guard', txn.bbf); add('txn_single_source', txn.single)
  const lift = await checkLift()
  add('lift_freshness', lift.freshness); add('lift_completeness', lift.completeness)
  add('sharefile_health', (await checkShareFile()).health)
  add('people_freshness', (await checkPeople()).people)
  add('order_ledger_floor', (await checkLedger()).ledger)
  const kit = await checkKitAnatomy()
  add('kit_price_band', kit.band); add('kit_integrity', kit.integrity)

  const passed = findings.filter(f => f.status === 'pass').length
  const warned = findings.filter(f => f.status === 'warn').length
  const failed = findings.filter(f => f.status === 'fail').length
  const duration_ms = Date.now() - t0

  if (!dryRun) {
    const [run] = await sb('audit_runs', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: { trigger_by: trigger, checks_run: findings.length, passed, warned, failed, duration_ms },
    })
    await sb('audit_findings', {
      method: 'POST',
      body: findings.map(f => ({ ...f, run_id: run.id })),
    })
    // Alert on exception only. One message, every failing check named in
    // plain English, pointing at the self-serve panel.
    if (failed > 0) {
      const fails = findings.filter(f => f.status === 'fail')
        .map(f => `• *${f.check_key}* — ${f.summary}`).join('\n')
      await slackNotify(
        `🔴 <@${SLACK_PETER}> Nightly audit: *${failed} check${failed > 1 ? 's' : ''} FAILED* (${passed} passed${warned ? `, ${warned} warned` : ''})\n${fails}\n_Dashboard → gear → Feed health for detail · Run audit now to re-test after a fix_`)
    }
  }
  return { checks: findings.length, passed, warned, failed, duration_ms, findings }
}

exports.runAudit = runAudit
exports.slackNotify = slackNotify
exports.handler = schedule('0 5 * * *', async () => {
  try {
    const r = await runAudit('nightly', false)
    console.log(`[audit-nightly] ${r.passed} pass / ${r.warned} warn / ${r.failed} fail in ${r.duration_ms}ms`)
    return { statusCode: 200 }
  } catch (e) {
    console.error('[audit-nightly] crashed:', e)
    // The auditor failing to run is itself an alertable failure — silence
    // must never look like health.
    await slackNotify(`🔴 <@${SLACK_PETER}> Nightly audit CRASHED before completing: ${String(e).slice(0, 300)}\n_The Audit badge will go red on staleness; check Netlify function logs._`)
    return { statusCode: 500 }
  }
})
