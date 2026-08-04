// PoolSearchExplain — Ramon's feedback (8/4, born from PO2049262): a pool
// search that finds nothing used to say only "No POs match these filters",
// which is technically correct and humanly useless — the system KNEW the PO
// was fully scheduled on GC-2 and said nothing. This component makes the
// empty state answer the question it was asked: where IS this PO?
//
//   scheduled → "✓ SCHEDULED — yds, table(s), week(s)" (the Ramon case)
//   terminal  → "Shipped/Invoiced — done work never enters the pool"
//   filtered  → in WIP but excluded by pool rules/filters (e.g. New Goods)
//   missing   → not in the current LIFT snapshot at all
//
// Rendered inside both schedulers' pool empty state. Fires only when the
// search text is ≥4 chars, so casual typing doesn't spam lookups.

import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { C, fmt } from '../lib/scheduleUtils'

const TERMINAL = new Set([
  'Shipped', 'Invoiced', 'Cancelled', 'Canceled', 'Cancellation Fee', 'Closed', 'Complete', 'Completed',
])

export default function PoolSearchExplain({ query, site, wipRows }) {
  const [hit, setHit] = useState(null)

  useEffect(() => {
    let dead = false
    const q = (query || '').trim()
    if (q.length < 4) { setHit(null); return }
    const core = q.toLowerCase().replace(/^po/, '')
    ;(async () => {
      // 1. Scheduled anywhere (any week, this site)? The Ramon case.
      const { data } = await supabase.from('sched_assignments')
        .select('po_number, week_start, table_code, planned_yards')
        .eq('site', site).ilike('po_number', `%${core}%`).limit(50)
      if (dead) return
      if (data && data.length > 0) {
        const yards = data.reduce((s, a) => s + Number(a.planned_yards || 0), 0)
        const weeks = [...new Set(data.map(a => a.week_start))].sort()
        const tables = [...new Set(data.map(a => a.table_code))]
        setHit({ kind: 'scheduled', po: data[0].po_number, yards, weeks, tables })
        return
      }
      // 2. In the WIP universe but not in this pool?
      const w = (wipRows || []).find(r => (r.po_number || '').toLowerCase().replace(/^po/, '').includes(core))
      if (w) setHit({ kind: TERMINAL.has(w.order_status || '') ? 'terminal' : 'filtered', po: w.po_number, status: w.order_status })
      else setHit({ kind: 'missing', q })
    })()
    return () => { dead = true }
  }, [query, site, wipRows])

  if (!hit) return null
  const box = (borderColor, color, children) => (
    <div style={{ margin: '10px 12px 0', padding: '10px 12px', background: 'var(--surface-2)',
                  border: `1px solid ${borderColor}`, borderRadius: 6, fontSize: 11, color,
                  textAlign: 'left', lineHeight: 1.5 }}>
      {children}
    </div>
  )
  if (hit.kind === 'scheduled') return box(C.sage, C.sage, <>
    <strong>✓ {hit.po} is SCHEDULED</strong> — {fmt(Math.round(hit.yards))} yd on {hit.tables.join(', ')},
    {' '}week of {hit.weeks.map(w => w.slice(5).replace('-', '/')).join(' + ')}.
    {' '}Fully planned POs leave the pool — it's on the board row, and the Queue tab shows it too.
  </>)
  if (hit.kind === 'terminal') return box(C.border, C.inkMid, <>
    {hit.po} is <strong>{hit.status}</strong> — completed work never enters the pool.
  </>)
  if (hit.kind === 'filtered') return box(C.amber, C.amber, <>
    {hit.po} is in WIP with status <strong>{hit.status}</strong> but isn't in this pool —
    check the filter chips above, or it may live in the New Goods view.
  </>)
  return box(C.border, C.inkLight, <>
    Nothing in the current LIFT snapshot matches "{hit.q}" — if it was just entered in LIFT,
    the next hourly refresh picks it up.
  </>)
}
