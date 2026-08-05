// ProcurementHome — the Procurement destination's landing screen.
//
// The Emily/Lydia initiative (8/1): procurement manages the pipe and the
// communication back to the HUB, SPO/MTO customers, and the exec team. This
// home gives them four doors: the Queue (the flagship — every order, status,
// planned week), overall production WIP, the New Goods pipeline, and their
// own division's WIP (the 256-order / ~$770K procurement book that the LIFT
// feed already classifies but nothing surfaced until today).
//
// Reuses Box/StackBar from OpsHome. One snapshot query feeds all four boxes.

import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, fmt } from '../lib/scheduleUtils'
import { Box, StackBar } from './OpsHome'

const TERMINAL = new Set([
  'Shipped', 'Invoiced', 'Cancelled', 'Canceled', 'Cancellation Fee', 'Closed', 'Complete', 'Completed',
])

export default function ProcurementHome({ onOpen }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data: snaps, error: e1 } = await supabase
          .from('sched_snapshots').select('id, uploaded_at')
          .order('uploaded_at', { ascending: false }).limit(1)
        if (e1) throw e1
        const snapId = snaps?.[0]?.id
        const { data: rows, error: e2 } = await supabase
          .from('sched_wip_rows')
          .select('site, order_status, is_new_goods, age_days, yards_written, income_written')
          .eq('snapshot_id', snapId).range(0, 4999)
        if (e2) throw e2
        // Inventory (Peter, 8/1): the on-hand book, latest snapshot.
        let inv = null
        try {
          const { data: invDates } = await supabase.from('inventory_snapshot')
            .select('as_of').order('as_of', { ascending: false }).limit(1)
          const asOf = invDates?.[0]?.as_of
          if (asOf) {
            const { data: invRows } = await supabase.from('inventory_snapshot')
              .select('on_hand_curr, cost_per_yard, material_group').eq('as_of', asOf).limit(2000)
            const yards = (invRows || []).reduce((s, r) => s + Number(r.on_hand_curr || 0), 0)
            const value = (invRows || []).reduce((s, r) => s + Number(r.on_hand_curr || 0) * Number(r.cost_per_yard || 0), 0)
            // Top material groups by on-hand yards — gives the box its strip
            // (it was the only home box without a visual; Peter 8/5).
            const byGroup = {}
            for (const r of (invRows || [])) {
              const g = (r.material_group || 'Other').trim() || 'Other'
              byGroup[g] = (byGroup[g] || 0) + Number(r.on_hand_curr || 0)
            }
            const groups = Object.entries(byGroup).sort((a, b) => b[1] - a[1])
            const top = groups.slice(0, 4)
            const rest = groups.slice(4).reduce((s, [, v]) => s + v, 0)
            if (rest > 0) top.push(['Other', rest])
            inv = { asOf, yards, value, skus: (invRows || []).length, groups: top }
          }
        } catch { /* box simply hides if inventory isn't loaded */ }
        // INCOMING (Brynn 8/3-4): the purchasing side — open mill PO lines.
        // Box hides until the first hourly sync lands rows.
        let incoming = null
        try {
          const { data: poRows } = await supabase.from('po_lines')
            .select('po_number, open_qty, unit_cost, extended_cost, due_date')
            .gt('open_qty', 0).range(0, 3999)
          if (poRows && poRows.length > 0) {
            const today = new Date().toISOString().slice(0, 10)
            incoming = {
              pos: new Set(poRows.map(r => r.po_number)).size,
              qty: poRows.reduce((s, r) => s + Number(r.open_qty || 0), 0),
              value: poRows.reduce((s, r) => s + (Number(r.unit_cost || 0) > 0
                ? Number(r.open_qty || 0) * Number(r.unit_cost || 0)
                : Number(r.extended_cost || 0)), 0),
              overdue: poRows.filter(r => r.due_date && r.due_date < today).length,
            }
          }
        } catch { /* box simply hides until the purchasing feed lands */ }
        if (cancelled) return
        const open = (rows || []).filter(r => !TERMINAL.has(r.order_status || ''))
        const prod = open.filter(r => r.site === 'passaic' || r.site === 'bny')
        const proc = open.filter(r => r.site === 'procurement')
        const ng   = open.filter(r => r.is_new_goods)
        const ageStack = list => {
          const s = { cur: 0, d30: 0, d60: 0, d90: 0, d120: 0 }
          for (const r of list) {
            const a = r.age_days || 0
            if (a < 30) s.cur++; else if (a < 60) s.d30++; else if (a < 90) s.d60++
            else if (a < 120) s.d90++; else s.d120++
          }
          return s
        }
        setD({
          prodCount: prod.length,
          prodYards: prod.reduce((s, r) => s + Number(r.yards_written || 0), 0),
          prodAge: ageStack(prod),
          ngCount: ng.length,
          ngLate: ng.filter(r => (r.age_days || 0) > 90).length,
          ngAge: ageStack(ng),
          procCount: proc.length,
          procRev: proc.reduce((s, r) => s + Number(r.income_written || 0), 0),
          procAge: ageStack(proc),
          inv,
          incoming,
          asOf: snaps?.[0]?.uploaded_at,
        })
      } catch (e) {
        if (!cancelled) setErr(String(e?.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (err) return <div style={{ padding: 40, color: C.rose }}>Home failed to load: {err}</div>
  if (!d) return <div style={{ padding: 40, color: C.inkLight }}>Loading…</div>

  const go = (t) => () => onOpen && onOpen(t)
  const stackSegs = s => ([
    { v: s.cur,  color: C.sage,      label: '<30d' },
    { v: s.d30,  color: C.yards,     label: '30–59' },
    { v: s.d60,  color: C.amber,     label: '60–89' },
    { v: s.d90,  color: C.scheduled, label: '90–119' },
    { v: s.d120, color: C.rose,      label: '120+' },
  ])

  return (
    <div>
      <div style={{ fontSize: 12, color: C.inkLight, marginBottom: 14 }}>
        The pipe, live from LIFT · every number below refreshes hourly
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>

        <Box title="Queue" value={fmt(d.prodCount)} unit="open order lines"
             sub="The flagship — every order line, its LIFT status, and the week it's planned for. Slack the team from any row."
             onClick={go('queue')}>
          <StackBar segs={stackSegs(d.prodAge)} />
        </Box>

        {d.incoming && (
          <Box title="Incoming" value={fmt(d.incoming.pos)} unit="open mill POs"
               sub={d.incoming.overdue > 0
                 ? `$${fmt(Math.round(d.incoming.value))} on order · ${d.incoming.overdue} line${d.incoming.overdue !== 1 ? 's' : ''} past due`
                 : `$${fmt(Math.round(d.incoming.value))} on order · ${fmt(Math.round(d.incoming.qty))} units open`}
               subTone={d.incoming.overdue > 0 ? 'warn' : 'good'}
               onClick={go('incoming')}>
            <div style={{ fontSize: 11, color: C.inkLight }}>
              The purchasing side — what's on order from the mills, at what cost, received vs open, due when. Brynn's screen, live.
            </div>
          </Box>
        )}

        <Box title="WIP" value={fmt(Math.round(d.prodYards))} unit="yds open"
             sub={`${fmt(d.prodCount)} production lines across Passaic + BNY`}
             onClick={go('wip')}>
          <StackBar segs={stackSegs(d.prodAge)} />
        </Box>

        <Box title="New goods" value={fmt(d.ngCount)} unit="items in the pipeline"
             sub={d.ngLate > 0 ? `${d.ngLate} over 90 days` : 'Pipeline running clean'}
             subTone={d.ngLate > 0 ? 'warn' : 'good'}
             onClick={go('newgoods')}>
          <StackBar segs={stackSegs(d.ngAge)} />
        </Box>

        {/* "Procurement WIP" box retired 8/5 with its tab — it was the Queue
            through a second door. The division's pass-through book lives one
            click away: Queue → Procurement chip. */}

        {d.inv && (
          <Box title="Inventory" value={fmt(Math.round(d.inv.yards))} unit="yds"
               sub={`$${fmt(Math.round(d.inv.value))} across ${fmt(d.inv.skus)} SKUs · as of ${d.inv.asOf}`}
               onClick={go('inventory')}>
            <StackBar segs={(d.inv.groups || []).map(([label, v], i) => ({
              v, label,
              color: [C.sage, C.yards, C.coloryards, C.gold, C.slate][i % 5],
            }))} />
          </Box>
        )}

      </div>
    </div>
  )
}
