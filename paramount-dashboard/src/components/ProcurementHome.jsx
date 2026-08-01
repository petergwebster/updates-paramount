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

        <Box title="Queue" value={fmt(d.prodCount)} unit="open production orders"
             sub="The flagship — every order, its LIFT status, and the week it's planned for. Slack the team from any row."
             onClick={go('queue')}>
          <StackBar segs={stackSegs(d.prodAge)} />
        </Box>

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

        <Box title="Procurement WIP" value={fmt(d.procCount)} unit="orders"
             sub={`$${fmt(Math.round(d.procRev))} in the procurement division's own book`}
             onClick={go('procwip')}>
          <StackBar segs={stackSegs(d.procAge)} />
        </Box>

      </div>
    </div>
  )
}
