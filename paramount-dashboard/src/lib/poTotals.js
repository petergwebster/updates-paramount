// ============================================================================
// poTotals.js — "how big is this PO, and how much of it is already done?"
// ============================================================================
// Two questions the floor keeps asking that the dashboard could not answer,
// and ONE definition of each so no two screens can disagree.
//
//   1. PO TOTAL  — the whole PO's yards (and colour-yards at Passaic),
//      regardless of how it was split across tables, days or weeks. This is
//      the number the team has to reach before a PO is genuinely finished.
//      Requested by Sami (7/27): a job split across tables looks small on each
//      table, so he was going back to LIFT to re-check the real size.
//
//   2. RECORDED TO DATE — every yard entered in Live Ops against that PO
//      across ALL WEEKS. Requested by Ramon: "week should not be a filter —
//      every week's entries need to be included in this total." A PO that ran
//      three weeks ago and is still open must show what it already banked.
//
// WHY A SHARED FILE. Live Ops, the Status tab and the schedulers all want
// these two numbers. Computing them in three places is how a PO ends up
// reading 500 yd on one screen and 510 on another. Same rule as
// deriveColorYards: one function, imported everywhere.
//
// ── PO TOTAL: WHICH SOURCE, AND WHY TWO ──────────────────────────────────
// Primary source is the latest LIFT WIP snapshot (sched_wip_rows), summed by
// po_number across every line of that PO.
//
// Fallback is order_ledger. This matters more than it looks: an order LEAVES
// sched_wip_rows the moment LIFT invoices it. PO066996 (7/27) is exactly that
// case — printed 7/24, invoiced 7/25, gone from WIP, and Ramon reasonably read
// its disappearance as lost data. order_ledger is never pruned, so a closed PO
// still reports its size and can be labelled "invoiced" rather than blank.
//
// COLOUR-YARDS. Verified against production 2026-07-27: on all 565 Passaic WIP
// rows carrying colours, color_yards = yards_written x colors_count exactly.
// So the PO total colour-yards is read straight off the feed, not derived —
// and it agrees with the assignment ratio (planned_cy / planned_yards) that
// deriveColorYards uses, because they are the same colour count.
//
// BNY has no colour-yards (digital). Those fields come back null, and the UI
// shows an em-dash, exactly as it does everywhere else.
//
// ── THE ROW CAP ──────────────────────────────────────────────────────────
// Nothing here does a bare select across all history. Every query is SCOPED
// to the POs actually on screen and paginated in 1,000-row pages, because
// PostgREST silently truncates at 1,000 and a silently truncated total is
// worse than no total — it looks authoritative and it is short.
// (sched_daily_ops_lines was 699 rows on 7/27 and growing ~230 a week, so the
// cap is about two weeks away, not theoretical.)
// ============================================================================

import { supabase } from '../supabase'
import { deriveColorYards } from './dailyOps'

const PAGE = 1000
// PO numbers go into a PostgREST in.() list, which lives in the URL. 150 keys
// is roughly 1.8 kB — comfortably inside every proxy limit, and it keeps the
// chunk count low enough that a busy week is two or three round trips.
const KEY_CHUNK = 150

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

const num = v => {
  const n = Number(v)
  return isNaN(n) ? 0 : n
}

// Paginate one query to exhaustion. `build` receives (from, to) and returns a
// ready-to-await PostgREST query. Returns every row, never a truncated 1,000.
async function fetchAll(build) {
  const all = []
  let from = 0
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) { console.error('poTotals fetchAll', error); break }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

// ─── THE RULE, AS A PURE FUNCTION ───────────────────────────────────────────
// Sum WIP rows into per-PO totals. Exported because the two schedulers ALREADY
// hold the full snapshot as a prop — they should not pay for a round trip to
// learn something they are already holding, and they must not re-implement the
// summing, which is exactly how one screen ends up saying 500 and another 510.
//
// lineCount matters and is not decoration. 155 of 1,053 open POs carry more
// than one line (up to nine) — almost all BNY hospitality bundles and memo
// sets, where one PO is a dozen different patterns. On those, the PO total is
// NOT the size of the job in front of you, so the count has to be shown.
export function poTotalsFromWipRows(rows) {
  const out = new Map()
  for (const r of rows || []) {
    if (!r || !r.po_number) continue
    const cur = out.get(r.po_number) || { yards: 0, colorYards: 0, cyKnown: false, cyPartial: false, lineCount: 0, source: 'wip', invoiced: false }
    const yd = num(r.yards_written)
    cur.yards += yd
    if (r.color_yards != null && num(r.color_yards) > 0) {
      cur.colorYards += num(r.color_yards)
      cur.cyKnown = true
    } else if (yd > 0) {
      // A LINE WITH YARDS BUT NO COLOUR-YARDS. Verified 2026-07-27: 26 of 539
      // open Passaic POs are mixed like this. Summing only the lines that
      // carry cy gives a PO total that is short and looks authoritative —
      // PO024733 reads 2,853 yd against 1,503 cy, which is arithmetically
      // impossible at Passaic where every yard is at least one colour-yard.
      // Partial is UNKNOWN, not a smaller number. A zero-yard line (memo,
      // panel set, strike-off) legitimately has no cy and does not count.
      cur.cyPartial = true
    }
    cur.lineCount += 1
    out.set(r.po_number, cur)
  }
  for (const [, v] of out) if (!v.cyKnown || v.cyPartial) v.colorYards = null
  return out
}

// ─── PO TOTALS ──────────────────────────────────────────────────────────────
// Returns Map<po_number, {
//   yards, colorYards, lineCount, source: 'wip' | 'ledger', invoiced: bool
// }>
// POs with no record anywhere are simply absent from the map — callers should
// treat "missing" as "unknown", never as zero.
export async function loadPoTotals(poNumbers) {
  const pos = [...new Set((poNumbers || []).filter(Boolean))]
  const out = new Map()
  if (pos.length === 0) return out

  // Latest snapshot only. Same access pattern SchedulerTab uses, so the pool
  // and these totals are always reading the same pull of LIFT.
  const { data: snaps } = await supabase
    .from('sched_snapshots')
    .select('id')
    .order('uploaded_at', { ascending: false })
    .limit(1)
  const snapId = snaps?.[0]?.id ?? null

  if (snapId != null) {
    for (const part of chunk(pos, KEY_CHUNK)) {
      const rows = await fetchAll((a, b) => supabase
        .from('sched_wip_rows')
        .select('po_number, yards_written, color_yards, colors_count')
        .eq('snapshot_id', snapId)
        .in('po_number', part)
        .range(a, b))
      // Same rule the schedulers use, from the same function. Merged across
      // chunks, so cyKnown is re-derived at the end rather than trusted here.
      // A null colorYards coming back means partial-or-absent — either way the
      // PO's colour-yards is unknown and must not be reported as a number.
      for (const [po, v] of poTotalsFromWipRows(rows)) {
        const cur = out.get(po) || { yards: 0, colorYards: 0, cyKnown: false, cyPartial: false, lineCount: 0, source: 'wip', invoiced: false }
        cur.yards += v.yards
        if (v.colorYards != null) { cur.colorYards += v.colorYards; cur.cyKnown = true }
        else cur.cyPartial = true
        cur.lineCount += v.lineCount
        out.set(po, cur)
      }
    }
  }

  // Anything the live snapshot doesn't know about has almost certainly been
  // invoiced and dropped out of WIP. The ledger keeps it.
  const missing = pos.filter(p => !out.has(p))
  if (missing.length > 0) {
    for (const part of chunk(missing, KEY_CHUNK)) {
      const rows = await fetchAll((a, b) => supabase
        .from('order_ledger')
        .select('po_number, yards_written, colors_count, invoice_date, last_status')
        .in('po_number', part)
        .range(a, b))
      for (const r of rows) {
        const cur = out.get(r.po_number) || { yards: 0, colorYards: 0, cyKnown: false, lineCount: 0, source: 'ledger', invoiced: false }
        // AN INVOICED PO'S SIZE IS WHAT INVOICED, NOT WHAT WAS WRITTEN.
        // Ramon 8/13 (PO2032815 / Seraphina): written 200 yd, invoiced 94.1 —
        // the dashboard said "200 (600 cy), 100 to go" on a finished job.
        // Open work plans against written yards; closed work reports actuals.
        // qty_invoiced falls back to written when LIFT left it empty.
        const closed = !!r.invoice_date
        const yd = closed ? (num(r.qty_invoiced) || num(r.yards_written)) : num(r.yards_written)
        const cc = num(r.colors_count)
        cur.yards += yd
        if (yd > 0 && cc > 0) { cur.colorYards += yd * cc; cur.cyKnown = true }
        cur.lineCount += 1
        if (closed) cur.invoiced = true
        out.set(r.po_number, cur)
      }
    }
  }

  // Normalise: colourYards is null (not 0) when we genuinely don't know it —
  // which is every BNY PO, and any PO whose lines disagree about whether they
  // carry colour-yards. Zero and unknown must not look the same.
  for (const [, v] of out) if (!v.cyKnown || v.cyPartial) v.colorYards = null
  return out
}

// ─── RECORDED TO DATE, ALL WEEKS ────────────────────────────────────────────
// Returns Map<po_number, { yards, waste, colorYards, weeks: [ISO dates] }>
//
// Colour-yards is derived PER LINE against that line's own assignment ratio,
// never from a blended week average — a PO's ratio ranges 1 to 12 at Passaic,
// and averaging them overstated colour-yards by 82% the last time it was tried.
export async function loadPoRecordedAllWeeks(site, poNumbers) {
  const pos = [...new Set((poNumbers || []).filter(Boolean))]
  const out = new Map()
  if (pos.length === 0) return out

  const lines = []
  const asgs = []
  for (const part of chunk(pos, KEY_CHUNK)) {
    lines.push(...await fetchAll((a, b) => supabase
      .from('sched_daily_ops_lines')
      .select('po_number, item_sku, color, table_code, week_start, actual_yards, waste_yards')
      .eq('site', site)
      .in('po_number', part)
      .range(a, b)))
    asgs.push(...await fetchAll((a, b) => supabase
      .from('sched_assignments')
      .select('po_number, item_sku, color, table_code, week_start, planned_yards, planned_cy')
      .eq('site', site)
      .in('po_number', part)
      .range(a, b)))
  }

  // Match an actuals line to its plan the SAME way the Status tab and the Live
  // Ops KPI strip do — (week, table, po, sku, colour) — so the derived
  // colour-yards here tie to those screens by construction. The week is part
  // of the key because a PO rescheduled to a different table in a later week
  // must pick up that week's ratio, not the first one it ever had.
  const asgKey = a => `${a.week_start}|${a.table_code}|${a.po_number || ''}|${a.item_sku || ''}|${a.color || ''}`
  const asgIndex = new Map()
  for (const a of asgs) asgIndex.set(asgKey(a), a)
  // Looser fallback for lines recorded on a table the PO was never formally
  // assigned to (it happens — the floor moves work). Keyed on PO + SKU +
  // colour, first assignment wins.
  const asgLoose = new Map()
  for (const a of asgs) {
    const k = `${a.po_number || ''}|${a.item_sku || ''}|${a.color || ''}`
    if (!asgLoose.has(k)) asgLoose.set(k, a)
  }

  for (const l of lines) {
    if (!l.po_number) continue
    const cur = out.get(l.po_number) || { yards: 0, waste: 0, colorYards: 0, cyKnown: false, weeks: new Set() }
    const yd = num(l.actual_yards)
    cur.yards += yd
    cur.waste += num(l.waste_yards)
    if (l.week_start) cur.weeks.add(l.week_start)
    if (yd > 0) {
      const match = asgIndex.get(asgKey(l)) ||
                    asgLoose.get(`${l.po_number || ''}|${l.item_sku || ''}|${l.color || ''}`)
      const cy = deriveColorYards(yd, match)
      if (cy != null) { cur.colorYards += cy; cur.cyKnown = true }
    }
    out.set(l.po_number, cur)
  }

  for (const [, v] of out) {
    v.weeks = [...v.weeks].sort()
    if (!v.cyKnown) v.colorYards = null
  }
  return out
}

// ─── DISPLAY ────────────────────────────────────────────────────────────────
// Sami, 7/27: "always put the total amount of yds in parens after the PO
// number, everywhere." One formatter so "everywhere" actually means the same
// thing everywhere — and so the day someone wants it to read differently, it
// changes in one place.
//
// Deliberately renders NOTHING when the total is unknown rather than "(0 yd)",
// because a zero-yard PO is a real thing here (memos, panel sets, strike-offs
// come from LIFT with no yardage) and must not be confused with a missing one.

export function poTotalText(total, { withCY = false } = {}) {
  if (!total || !(total.yards > 0)) return ''
  const yd = Math.round(total.yards).toLocaleString()
  if (withCY && total.colorYards != null && total.colorYards > 0) {
    return `${yd} yd / ${Math.round(total.colorYards).toLocaleString()} cy`
  }
  return `${yd} yd`
}

// "PO066996 (500 yd)" — the canonical label.
export function poWithTotal(po, total, opts) {
  const t = poTotalText(total, opts)
  return t ? `${po} (${t})` : String(po ?? '')
}

// The parenthesised part on its own, for places that already render the PO
// number in its own element and just want the size after it.
//
// A MULTI-LINE PO MUST SAY SO. On HOSP2044909 the PO total is nine different
// patterns added together — it is emphatically not the size of the job on the
// card in front of you, and a bare "(1,095 yd)" there would be worse than
// showing nothing. Passaic hand-screen is one line per PO, so this suffix
// almost never appears on Ramon's or Sami's screens; it is there for Chandler.
export function poTotalParens(total, opts) {
  const t = poTotalText(total, opts)
  if (!t) return ''
  const lines = (total && total.lineCount > 1) ? ` · ${total.lineCount} lines` : ''
  return `(${t}${lines})`
}
