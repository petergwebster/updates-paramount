import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, fmt } from '../lib/scheduleUtils'
import { Box, Ring, Columns, StackBar, Delta } from './OpsHome'
import { METRICS, statusOf } from './DeckKpiTrend'

// Money, always comma-delimited. fmtK was rendering $1334K — any figure over
// three digits needs separators or it reads as a serial number. Millions get
// two decimals; anything smaller gets thousands with commas.
const money = (v) => {
  if (v === null || v === undefined) return '\u2014'
  const n = Number(v)
  if (!isFinite(n)) return '\u2014'
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`
  if (a >= 1_000)     return `${sign}$${Math.round(a / 1000).toLocaleString()}K`
  return `${sign}$${Math.round(a).toLocaleString()}`
}

// ═══════════════════════════════════════════════════════════════════════════
// FinanceHome — the Finance home screen. Same model as Operations: you land
// here, no tab strip, click a box to enter a section.
//
// WHY IT DIFFERS FROM OPS: operations data is continuous — the floor records
// every day, so "this week" is always the question. Finance data arrives in
// BATCHES at different cadences: Vena monthly at close, Jen's GP file weekly,
// AR/AP aging when it happens to be re-sent, payroll on upload. Right now
// those are June, July, 25 June and mid-June respectively.
//
// So every box here states HOW CURRENT it is, and goes amber when it has
// fallen behind. A finance number without its as-of date is a trap — the
// number looks authoritative regardless of whether it is a month old.
// ═══════════════════════════════════════════════════════════════════════════

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }

// Days between a date string and today.
function daysOld(d) {
  if (!d) return null
  const t = new Date(String(d).slice(0, 10) + 'T00:00:00')
  if (isNaN(t)) return null
  return Math.floor((Date.now() - t.getTime()) / 86400000)
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function periodLabel(p) {
  if (!p) return '—'
  const [y, m] = String(p).split('-')
  return `${MONTHS[Number(m) - 1] || m} ${y}`
}

export default function FinanceHome({ onOpen }) {
  const [d, setD] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      // ── Vena: latest closed period, month/actual ───────────────────────
      const { data: perRows } = await supabase.from('vena_monthly')
        .select('period').order('period', { ascending: false }).limit(1)
      if (dead) return
      const period = perRows?.[0]?.period || null

      let vena = [], venaPrev = []
      if (period) {
        const [y, m] = period.split('-').map(Number)
        const pm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
        const [cur, prv] = await Promise.all([
          supabase.from('vena_monthly')
            .select('cost_center,line_key,account_code,amount')
            .eq('period', period).eq('timeframe', 'month').eq('scenario', 'actual'),
          supabase.from('vena_monthly')
            .select('cost_center,line_key,amount')
            .eq('period', pm).eq('timeframe', 'month').eq('scenario', 'actual'),
        ])
        if (dead) return
        vena = cur.data || []; venaPrev = prv.data || []
      }

      const vLine = (rows, cc, key) => {
        const r = rows.find(x => x.cost_center === cc && x.line_key === key)
        return r ? num(r.amount) : null
      }
      const revenue    = vLine(vena, 'CONS', 'total_revenue')
      const revenuePrev= vLine(venaPrev, 'CONS', 'total_revenue')
      const ebitda     = vLine(vena, 'CONS', 'ebitdap')
      const eb610      = vLine(vena, '610', 'ebitdap')
      const eb609      = vLine(vena, '609', 'ebitdap')
      const eb612      = vLine(vena, '612', 'ebitdap')

      // ── Transactions: latest fiscal month present ──────────────────────
      const { data: fmRows } = await supabase.from('financial_transactions')
        .select('fiscal_month').not('fiscal_month', 'is', null)
        .order('fiscal_month', { ascending: false }).limit(1)
      if (dead) return
      const fm = fmRows?.[0]?.fiscal_month || null

      let txn = []
      if (fm) {
        const { data } = await supabase.from('financial_transactions')
          .select('source_tab,net,business_unit,trx_date').eq('fiscal_month', fm)
        if (dead) return
        txn = data || []
      }
      const tabSum = (tab) => txn.filter(t => t.source_tab === tab)
                                 .reduce((s, t) => s + num(t.net), 0)
      const opex   = tabSum('opex_te')
      const inv    = tabSum('inventory_ink_freight')
      const capex  = tabSum('capex')
      const latestTxn = txn.reduce((mx, t) => (t.trx_date && t.trx_date > mx ? t.trx_date : mx), '')

      const buSum = (bu) => txn.filter(t => t.source_tab === 'opex_te' && t.business_unit === bu)
                               .reduce((s, t) => s + num(t.net), 0)

      // ── Aging ──────────────────────────────────────────────────────────
      const { data: agRows } = await supabase.from('financial_aging')
        .select('as_of_date').order('as_of_date', { ascending: false }).limit(1)
      if (dead) return
      const agingAsOf = agRows?.[0]?.as_of_date || null

      let ar = 0, ap = 0
      if (agingAsOf) {
        // aging_type, NOT kind. There is no `kind` column on financial_aging —
        // the values are the literal strings 'ar' and 'ap'. Selecting a column
        // that does not exist makes PostgREST reject the whole select, so this
        // returned null and the AR/AP box read 0 / 0 with nothing to indicate
        // it had failed. Same class of bug as work_date on OpsHome, found the
        // same day by checking every selected column against the live schema
        // rather than fixing the one that happened to be visible.
        // Verified 27 July against as_of 2026-06-25: ar 206,351.87 across 159
        // rows, ap 427,427.25 across 32.
        const { data, error } = await supabase.from('financial_aging')
          .select('aging_type,balance').eq('as_of_date', agingAsOf)
        if (dead) return
        if (error) console.error('[FinanceHome] aging', error)
        for (const r of (data || [])) {
          const b = num(r.balance)
          if (String(r.aging_type || '').toLowerCase().startsWith('ap')) ap += b
          else ar += b
        }
      }

      // ── People ─────────────────────────────────────────────────────────
      const { data: pplRows } = await supabase.from('people_weekly')
        .select('week_start').order('week_start', { ascending: false }).limit(1)
      if (dead) return
      const peopleAsOf = pplRows?.[0]?.week_start || null

      // ── Reports ────────────────────────────────────────────────────────
      const { count: summaryCount } = await supabase.from('weekly_prod_summaries')
        .select('*', { count: 'exact', head: true })
      if (dead) return

      // Deck KPIs: latest month, both cost centres, graded with the SAME
      // statusOf the KPI tab uses — one definition, imported, so the home
      // box and the tab cannot disagree.
      const { data: kpiPer } = await supabase.from('deck_kpis')
        .select('period').order('period', { ascending: false }).limit(1)
      if (dead) return
      const kpiPeriod = kpiPer?.[0]?.period || null
      let kpiCounts = null, kpiMonths = 0
      if (kpiPeriod) {
        const [{ data: kd }, { data: km }] = await Promise.all([
          supabase.from('deck_kpis')
            .select('cost_center,metric_key,scenario,value,display')
            .eq('period', kpiPeriod).eq('unit', 'yards')
            .eq('cut_type', 'total').eq('cut_key', 'total'),
          supabase.from('deck_kpis').select('period'),
        ])
        if (dead) return
        kpiMonths = new Set((km || []).map(r => r.period)).size
        const cell = (cc, mk, sc) => (kd || []).find(r =>
          r.cost_center === cc && r.metric_key === mk && r.scenario === sc)
        let g = 0, a = 0, r = 0
        for (const cc of ['610', '609']) {
          for (const m of METRICS) {
            if (m.key === 'prior_hti') continue   // mirrors last month's HTI
            const act = cell(cc, m.key, 'actual'), tg = cell(cc, m.key, 'target')
            const st = statusOf(m.dir, act?.value, tg?.value, cell(cc, m.key, 'gap')?.display)
            if (st === 'green') g++
            else if (st === 'amber') a++
            else if (st === 'red') r++
          }
        }
        kpiCounts = { g, a, r }
      }

      // ── Levers ── the strategy deck's three committed weekly targets, read
      // from the latest saved production week (same source as the Levers tab).
      const { data: prodRows } = await supabase.from('production')
        .select('week_start, nj_data, bny_data')
        .order('week_start', { ascending: false }).limit(6)
      if (dead) return
      const pnum = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0 }
      let lever = null
      for (const r of (prodRows || [])) {
        const nj = r.nj_data || {}, bny = r.bny_data || {}
        let inv = 0, waste = 0, prod = 0
        for (const c of ['fabric', 'grass', 'paper']) {
          const x = nj[c] || {}
          inv += pnum(x.invoiceYds); prod += pnum(x.yards)
          waste += pnum(x.waste) + pnum(x.postWaste)
        }
        const bnyProd = pnum(bny.schProduced) + pnum(bny.tpProduced)
        if (inv > 0 || prod > 0 || bnyProd > 0) {
          lever = {
            week: r.week_start,
            ship: inv, wastePct: prod > 0 ? (waste / prod) * 100 : null, bny: bnyProd, produce: prod,
            hits: (prod >= 9400 ? 1 : 0) + (inv >= 8500 ? 1 : 0) + (prod > 0 && (waste / prod) * 100 <= 8 ? 1 : 0) + (bnyProd >= 15000 ? 1 : 0),
          }
          break
        }
      }

      setD({
        period, revenue, revenuePrev, ebitda, eb610, eb609, eb612,
        fm, opex, inv, capex, latestTxn,
        buNJ: buSum('NJ'), buBNY: buSum('BNY'), buSH: buSum('SHARED'),
        agingAsOf, ar, ap, peopleAsOf, summaryCount: summaryCount || 0,
        kpiPeriod, kpiCounts, kpiMonths, lever,
      })
    })()
    return () => { dead = true }
  }, [])

  const grid = {
    display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 16, paddingTop: 8,
  }

  if (!d) return (
    <div style={grid}>
      {[0,1,2,3,4,5].map(i => (
        <div key={i} style={{ minHeight: 232, borderRadius: 12, background: C.parchment,
                              border: `1px solid ${C.border}` }} />
      ))}
    </div>
  )

  const go = (t) => () => onOpen && onOpen(t)
  const margin = d.revenue ? (d.ebitda / d.revenue) * 100 : 0
  const agingDays = daysOld(d.agingAsOf)
  const peopleDays = daysOld(d.peopleAsOf)

  // A finance figure without its as-of date is a trap. Anything past a month
  // is called out rather than presented as current.
  const staleTone = (days, limit) => days == null ? 'warn' : days > limit ? 'warn' : undefined

  return (
    <div>
      <div style={grid}>

        <Box title="P&L" value={money(d.revenue)} unit="revenue"
             sub={`${periodLabel(d.period)} · closed · EBITDA ${money(d.ebitda)} at ${margin.toFixed(1)}%`}
             delta={<Delta now={d.revenue} prev={d.revenuePrev} suffix="vs prior month" />}
             onClick={go('pnl')}>
          <Columns bars={[
            { v: Math.max(0, d.eb610 || 0), color: C.siteNJ,  label: '610' },
            { v: Math.max(0, d.eb609 || 0), color: C.siteBNY, label: '609' },
            { v: Math.max(0, d.eb612 || 0), color: C.inkLight, label: '612' },
          ]} />
        </Box>

        <Box title="KPIs" value={d.kpiCounts ? `${d.kpiCounts.g}/${d.kpiCounts.g + d.kpiCounts.a + d.kpiCounts.r}` : '—'}
             unit={d.kpiCounts ? `on target · ${periodLabel(d.kpiPeriod ? String(d.kpiPeriod).slice(0, 7) : null)}` : 'not loaded'}
             sub={d.kpiCounts
                  ? `${d.kpiMonths} months from the decks · both sites, every metric vs target`
                  : 'Deck KPI extraction has not run'}
             subTone={d.kpiCounts ? undefined : 'warn'}
             onClick={go('kpis')}>
          <StackBar segs={[
            { v: d.kpiCounts?.g || 0, color: C.revenue, label: 'On' },
            { v: d.kpiCounts?.a || 0, color: C.scheduled, label: 'Close' },
            { v: d.kpiCounts?.r || 0, color: C.waste, label: 'Off' },
          ]} />
        </Box>

        <Box title="Spend" value={money(d.opex)} unit="opex purchases"
             sub={d.latestTxn ? `through ${String(d.latestTxn).slice(0, 10)}` : 'no transactions loaded'}
             onClick={go('spend')}>
          <Columns bars={[
            { v: Math.abs(d.buNJ),  color: C.siteNJ,   label: 'Passaic' },
            { v: Math.abs(d.buBNY), color: C.siteBNY,  label: 'Brooklyn' },
            { v: Math.abs(d.buSH),  color: C.coloryards, label: 'Shared' },
          ]} />
        </Box>

        <Box title="AR / AP" value={money(d.ar)} unit="receivable"
             sub={agingDays == null ? 'no aging loaded'
                  : `as of ${String(d.agingAsOf).slice(0, 10)} · ${agingDays} days old`}
             subTone={staleTone(agingDays, 14)}
             onClick={go('arap')}>
          <StackBar segs={[
            { v: Math.abs(d.ar), color: C.revenue, label: 'AR' },
            { v: Math.abs(d.ap), color: C.waste,   label: 'AP' },
          ]} />
        </Box>

        <Box title="Inventory" value={money(d.inv)} unit="purchased"
             sub={`${periodLabel(d.fm)} to date · ink, material and freight`}
             onClick={go('inventory')}>
          <StackBar segs={[
            { v: Math.abs(d.inv),   color: C.yards,     label: 'Inventory' },
            { v: Math.abs(d.capex), color: C.scheduled, label: 'CapEx' },
          ]} />
        </Box>

        <Box title="People" value={peopleDays == null ? '—' : `${peopleDays}d`}
             unit={peopleDays == null ? 'no data' : 'since update'}
             sub={d.peopleAsOf ? `Last week loaded: ${String(d.peopleAsOf).slice(0, 10)}`
                               : 'Nothing loaded yet'}
             subTone={staleTone(peopleDays, 14)}
             onClick={go('people')}>
          <Ring pct={peopleDays == null ? 0 : Math.max(0, 100 - peopleDays * 2)}
                color={peopleDays > 14 ? C.amber : C.sage}
                caption="freshness of the people feed" />
        </Box>

        <Box title="Reports" value={`${d.summaryCount}`} unit="saved"
             sub={d.summaryCount === 0
                  ? 'No weekly summaries saved yet — generate one'
                  : 'Monthly brief, weekly production, recap'}
             subTone={d.summaryCount === 0 ? 'warn' : undefined}
             onClick={go('reports')}>
          <StackBar segs={[
            { v: Math.max(d.summaryCount, 0), color: C.coloryards, label: 'Saved' },
            { v: d.summaryCount === 0 ? 1 : 0, color: C.warm, label: 'None yet' },
          ]} />
        </Box>

        <Box title="Held to Invoice" value="LIVE" unit="from LIFT"
             sub="Printed, not yet billed · goal ≤ one week's production per site · click to pull the stock"
             onClick={go('hti')}>
          <StackBar segs={[
            { v: 8610,  color: C.siteNJ,  label: 'NJ bar 8.6K' },
            { v: 12000, color: C.siteBNY, label: 'BK bar 12K' },
          ]} />
        </Box>

        <Box title="Levers" value={d.lever ? `${d.lever.hits}/4` : '—'}
             unit={d.lever ? `on target · wk ${String(d.lever.week).slice(5)}` : 'no production weeks saved'}
             sub={d.lever
                  ? `Produce ${Math.round(d.lever.produce).toLocaleString()}/9.4K · ship ${Math.round(d.lever.ship).toLocaleString()}/8.5K · waste ${d.lever.wastePct == null ? '—' : d.lever.wastePct.toFixed(1) + '%'}/8% · digital ${Math.round(d.lever.bny).toLocaleString()}/15K`
                  : 'The 2027 bridge tracked weekly'}
             subTone={d.lever && d.lever.hits === 0 ? 'warn' : undefined}
             onClick={go('levers')}>
          <StackBar segs={[
            { v: d.lever?.hits || 0, color: C.revenue, label: 'On' },
            { v: d.lever ? 4 - d.lever.hits : 4, color: C.waste, label: 'Off' },
          ]} />
        </Box>

      </div>
    </div>
  )
}
