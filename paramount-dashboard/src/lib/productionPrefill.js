// productionPrefill.js — compute the weekly Production entry from live systems.
//
// The Production tab (Admin › Weekly Data Entry) feeds the `production` table,
// which feeds the Capacity report. Until 8/2 every number was typed by hand.
// This module computes each field from the systems that already know it:
//   PRODUCED  — sched_daily_ops (+ _lines) : the floor's own Live Ops entries
//   CY        — line yards × the planned CY/yd ratio from sched_assignments
//               (deriveColorYards' method, applied at the line level)
//   INVOICED  — order_ledger by invoice_date       (yards + revenue)
//   WRITTEN   — order_ledger by first_seen
//   PRINTED   — order_ledger by printed_date
//   BUCKETS   — po → bny_bucket via the latest LIFT snapshot
//
// Honesty rules: a field the systems can't see returns null (never zero),
// and `gaps` reports what was missing so the human knows why. Manual always
// wins — this module only proposes.

import { supabase } from '../supabase'

const DAY_MS = 86400 * 1000

function weekDays(weekKey) {
  const start = new Date(weekKey + 'T00:00:00')
  return [...Array(7)].map((_, i) => new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10))
}

function catOfTable(code) {
  const c = (code || '').toUpperCase()
  if (c.startsWith('GC')) return 'grass'
  if (c.startsWith('WP')) return 'paper'
  return 'fabric'
}
function catOfProduct(pt) {
  // Exact LIFT product types only. Strike-offs, design services, and untyped
  // rows do NOT belong in a fabric/grass/paper bucket — they are excluded
  // from category splits and reported in gaps (proven on wk 7/19: 275 yd of
  // strike-offs + untyped were inflating "fabric" by exactly their sum).
  const t = (pt || '').toLowerCase()
  if (t.includes('grass')) return 'grass'
  if (t.includes('paper') || t.includes('panel')) return 'paper'
  if (t === 'fabric') return 'fabric'
  return null
}
const is3P = ct => (ct || '').toLowerCase().includes('3rd')
const R = n => (n == null || isNaN(n)) ? null : String(Math.round(n))

export async function computePrefill(weekKey) {
  const days = weekDays(weekKey)
  const weekEnd = days[6]
  const gaps = { missingOps: [], cyUncovered: 0, cyTotalLines: 0, unknownBucket: [], notes: [] }

  const [opsQ, linesQ, asgQ, snapQ] = await Promise.all([
    supabase.from('sched_daily_ops').select('site, table_code, day_of_week, actual_yards, waste_yards').eq('week_start', weekKey).range(0, 4999),
    supabase.from('sched_daily_ops_lines').select('site, table_code, po_number, actual_yards, waste_yards').eq('week_start', weekKey).range(0, 4999),
    supabase.from('sched_assignments').select('site, table_code, po_number, planned_yards, planned_cy').eq('week_start', weekKey).range(0, 4999),
    supabase.from('sched_snapshots').select('id').order('uploaded_at', { ascending: false }).limit(1),
  ])
  for (const [q, name] of [[opsQ, 'daily ops'], [linesQ, 'ops lines'], [asgQ, 'assignments']]) {
    if (q.error) throw new Error(`${name}: ${q.error.message}`)
  }
  const ops = opsQ.data || [], lines = linesQ.data || [], asg = asgQ.data || []

  // Bucket + procurement maps from the latest snapshot
  let bucketMap = {}
  if (snapQ.data?.[0]?.id) {
    const { data: wip } = await supabase.from('sched_wip_rows')
      .select('po_number, bny_bucket').eq('snapshot_id', snapQ.data[0].id).range(0, 4999)
    for (const r of (wip || [])) if (r.po_number && r.bny_bucket) bucketMap[r.po_number] = r.bny_bucket
  }

  // Ledger slices — three date lenses on the same table
  const [invQ, prtQ, wrtQ] = await Promise.all([
    supabase.from('order_ledger').select('po_number, site, customer_type, product_type, yards_invoiced, invoiced_revenue').gte('invoice_date', weekKey).lte('invoice_date', weekEnd).range(0, 4999),
    supabase.from('order_ledger').select('site, customer_type, qty_printed').gte('printed_date', weekKey).lte('printed_date', weekEnd).range(0, 4999),
    supabase.from('order_ledger').select('site, customer_type, yards_written').gte('first_seen', weekKey).lte('first_seen', weekEnd + 'T23:59:59').range(0, 4999),
  ])
  const inv = invQ.data || [], prt = prtQ.data || [], wrt = wrtQ.data || []

  // ── Passaic produced (yards/waste by table category, from the daily totals) ──
  const njCat = { fabric: { yards: 0, waste: 0, cy: 0 }, grass: { yards: 0, waste: 0, cy: 0 }, paper: { yards: 0, waste: 0, cy: 0 } }
  for (const o of ops.filter(o => o.site === 'passaic')) {
    const c = njCat[catOfTable(o.table_code)]
    c.yards += Number(o.actual_yards || 0)
    c.waste += Number(o.waste_yards || 0)
  }
  // CY from lines × assignment ratio (planned_cy / planned_yards)
  const ratioKey = (s, t, p) => `${s}|${t}|${p}`
  const ratios = {}
  for (const a of asg) {
    const py = Number(a.planned_yards), pcy = Number(a.planned_cy)
    if (py > 0 && pcy > 0) ratios[ratioKey(a.site, a.table_code, a.po_number)] = pcy / py
  }
  for (const l of lines.filter(l => l.site === 'passaic')) {
    gaps.cyTotalLines++
    const r = ratios[ratioKey(l.site, l.table_code, l.po_number)]
    if (r) njCat[catOfTable(l.table_code)].cy += Number(l.actual_yards || 0) * r
    else gaps.cyUncovered++
  }
  // Which scheduled days have no ops entry at all (honesty panel)
  const opsDays = new Set(ops.filter(o => o.site === 'passaic' && (o.actual_yards != null)).map(o => o.day_of_week))
  if (ops.length === 0) gaps.missingOps.push('No Live Ops entries at all for this week')
  else if (opsDays.size < 5) gaps.notes.push(`Passaic ops entries cover ${opsDays.size} day(s)`) 

  // ── Invoiced by category / bucket / customer-type ──
  const njInv = { fabric: { yds: 0, rev: 0 }, grass: { yds: 0, rev: 0 }, paper: { yds: 0, rev: 0 } }
  const bnyInv = {}, bnyIncome = {}
  let procRevenue = 0
  const sch = { passaic: { w: 0, p: 0, i: 0 }, bny: { w: 0, p: 0, i: 0 } }
  const tp = { passaic: { w: 0, p: 0, i: 0 }, bny: { w: 0, p: 0, i: 0 } }
  const BKEY = { 'Replen': 'Replen', 'MTO': 'MTO', 'HOS': 'HOS', 'Memo': 'Memo', 'Contract': 'Contract', '3P': 'Contract' }
  let uncatN = 0, uncatY = 0, uncatR = 0
  for (const r of inv) {
    const yds = Number(r.yards_invoiced || 0), rev = Number(r.invoiced_revenue || 0)
    if (r.site === 'passaic') {
      const cat = catOfProduct(r.product_type)
      if (cat) { const c = njInv[cat]; c.yds += yds; c.rev += rev }
      else { uncatN++; uncatY += yds; uncatR += rev }
      ;(is3P(r.customer_type) ? tp : sch).passaic.i += yds
    } else if (r.site === 'bny') {
      const bucket = BKEY[bucketMap[r.po_number]] || null
      if (bucket) { bnyInv[bucket] = (bnyInv[bucket] || 0) + yds; bnyIncome[bucket] = (bnyIncome[bucket] || 0) + rev }
      else gaps.unknownBucket.push(r.po_number)
      ;(is3P(r.customer_type) ? tp : sch).bny.i += yds
    } else if (r.site === 'procurement') {
      procRevenue += rev
    }
  }
  for (const r of prt) {
    const t = r.site === 'passaic' ? 'passaic' : r.site === 'bny' ? 'bny' : null
    if (t) (is3P(r.customer_type) ? tp : sch)[t].p += Number(r.qty_printed || 0)
  }
  for (const r of wrt) {
    const t = r.site === 'passaic' ? 'passaic' : r.site === 'bny' ? 'bny' : null
    if (t) (is3P(r.customer_type) ? tp : sch)[t].w += Number(r.yards_written || 0)
  }

  // ── BNY produced by bucket (lines → po → bucket) + machines grid ──
  const bnyProd = {}
  for (const l of lines.filter(l => l.site === 'bny')) {
    const bucket = BKEY[bucketMap[l.po_number]] || null
    if (bucket) bnyProd[bucket] = (bnyProd[bucket] || 0) + Number(l.actual_yards || 0)
    else gaps.unknownBucket.push(l.po_number)
  }
  const machines = {}
  for (const o of ops.filter(o => o.site === 'bny')) {
    machines[o.table_code] = (machines[o.table_code] || 0) + Number(o.actual_yards || 0)
  }

  gaps.unknownBucket = [...new Set(gaps.unknownBucket)]
  if (uncatN > 0) gaps.notes.push(`${uncatN} invoiced row(s) with no fabric/grass/paper type (strike-offs, services, untyped) — ${Math.round(uncatY)} yd / $${Math.round(uncatR)} counted in SCH/3P totals but excluded from category splits`)

  const nj = {
    fabric: { yards: R(njCat.fabric.yards), colorYards: R(njCat.fabric.cy), waste: R(njCat.fabric.waste), postWaste: null, invoiceYds: R(njInv.fabric.yds), invoiceRev: R(njInv.fabric.rev) },
    grass:  { yards: R(njCat.grass.yards),  colorYards: R(njCat.grass.cy),  waste: R(njCat.grass.waste),  postWaste: null, invoiceYds: R(njInv.grass.yds),  invoiceRev: R(njInv.grass.rev) },
    paper:  { yards: R(njCat.paper.yards),  colorYards: R(njCat.paper.cy),  waste: R(njCat.paper.waste),  postWaste: null, invoiceYds: R(njInv.paper.yds),  invoiceRev: R(njInv.paper.rev) },
    schWritten: R(sch.passaic.w), schProduced: R(sch.passaic.p), schInvoiced: R(sch.passaic.i),
    tpWritten: R(tp.passaic.w), tpProduced: R(tp.passaic.p), tpInvoiced: R(tp.passaic.i),
  }
  const bny = {
    replen: R(bnyProd.Replen), mto: R(bnyProd.MTO), hos: R(bnyProd.HOS), memo: R(bnyProd.Memo), contract: R(bnyProd.Contract),
    invYdsReplen: R(bnyInv.Replen), invYdsMto: R(bnyInv.MTO), invYdsHos: R(bnyInv.HOS), invYdsMemo: R(bnyInv.Memo), invYdsContract: R(bnyInv.Contract),
    incomeReplen: R(bnyIncome.Replen), incomeMto: R(bnyIncome.MTO), incomeHos: R(bnyIncome.HOS), incomeMemo: R(bnyIncome.Memo), incomeContract: R(bnyIncome.Contract),
    schWritten: R(sch.bny.w), schProduced: R(sch.bny.p), schInvoiced: R(sch.bny.i),
    tpWritten: R(tp.bny.w), tpProduced: R(tp.bny.p), tpInvoiced: R(tp.bny.i),
    procurement: R(procRevenue),
    machines: Object.fromEntries(Object.entries(machines).map(([k, v]) => [k, R(v)])),
  }
  return { nj, bny, gaps }
}
