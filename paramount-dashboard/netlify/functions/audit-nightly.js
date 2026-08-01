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
  return res.status === 204 ? null : res.json()
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
  }
  return { checks: findings.length, passed, warned, failed, duration_ms, findings }
}

exports.runAudit = runAudit
exports.handler = schedule('0 5 * * *', async () => {
  try {
    const r = await runAudit('nightly', false)
    console.log(`[audit-nightly] ${r.passed} pass / ${r.warned} warn / ${r.failed} fail in ${r.duration_ms}ms`)
    return { statusCode: 200 }
  } catch (e) {
    console.error('[audit-nightly] crashed:', e)
    return { statusCode: 500 }
  }
})
