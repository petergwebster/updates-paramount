// IncomingPOs — the PURCHASING side of procurement (Brynn, 8/3-4).
//
// Reads po_lines: LIFT's po_details report, the screen Brynn maintains live —
// mill POs with vendor, cost, ordered/received/open quantities, due dates and
// invoice linkage. Fed hourly by lift-wip-sync (same clock as WIP).
//
// This is the INBOUND lane. The rest of the Procurement destination is the
// OUTBOUND lane (customer orders moving through LIFT steps). Outbound tells
// procurement what production will consume; this view tells them whether the
// material will be there to consume.
//
// DRILL-DOWN STANDARD (Peter, 8/4): high-level rows are clickable. Vendor
// rows expand to their open PO lines; nothing is a dead end.
//
// v1 deliberately shows OPEN lines only (open_qty > 0) — the live inbound
// book. Received-history and cost-trend cuts come after Brynn's walkthrough
// teaches us her status semantics; don't guess what "in transit" means.

import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'
import { C, fmt, fmtK } from '../lib/scheduleUtils'
import BigSearch from './BigSearch'

const todayIso = () => new Date().toISOString().slice(0, 10)

export default function IncomingPOs() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)
  const [q, setQ] = useState('')
  const [openVendors, setOpenVendors] = useState(() => new Set())

  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('po_lines')
          .select('po_line_id, po_number, material, material_category, material_sub_category, vendor_name, ordered_qty, received_qty, open_qty, unit_cost, extended_cost, uom, status, creation_date, due_date, invoice_number, invoice_date, last_update_date')
          .gt('open_qty', 0)
          .order('due_date', { ascending: true, nullsFirst: false })
          .range(0, 3999)
        if (error) throw error
        if (!dead) setRows(data || [])
      } catch (e) {
        if (!dead) setErr(String(e?.message || e))
      }
    })()
    return () => { dead = true }
  }, [])

  const today = todayIso()

  const filtered = useMemo(() => {
    if (!rows) return []
    if (!q.trim()) return rows
    const s = q.toLowerCase()
    return rows.filter(r =>
      (r.material || '').toLowerCase().includes(s) ||
      (r.po_number || '').toLowerCase().includes(s) ||
      (r.vendor_name || '').toLowerCase().includes(s) ||
      (r.invoice_number || '').toLowerCase().includes(s) ||
      (r.material_category || '').toLowerCase().includes(s) ||
      (r.material_sub_category || '').toLowerCase().includes(s))
  }, [rows, q])

  const byVendor = useMemo(() => {
    const m = new Map()
    for (const r of filtered) {
      const v = r.vendor_name || '(no vendor)'
      if (!m.has(v)) m.set(v, { vendor: v, lines: [], openQty: 0, openValue: 0, pos: new Set(), overdue: 0 })
      const g = m.get(v)
      g.lines.push(r)
      g.openQty += Number(r.open_qty || 0)
      // Open value = open share of the extended cost (unit cost × open qty
      // when unit cost exists; falls back to extended_cost prorated).
      g.openValue += Number(r.unit_cost || 0) > 0
        ? Number(r.open_qty || 0) * Number(r.unit_cost || 0)
        : Number(r.extended_cost || 0)
      g.pos.add(r.po_number)
      if (r.due_date && r.due_date < today) g.overdue++
    }
    return [...m.values()].sort((a, b) => b.openValue - a.openValue)
  }, [filtered, today])

  const totals = useMemo(() => ({
    lines: filtered.length,
    pos: new Set(filtered.map(r => r.po_number)).size,
    vendors: byVendor.length,
    openQty: filtered.reduce((s, r) => s + Number(r.open_qty || 0), 0),
    openValue: byVendor.reduce((s, g) => s + g.openValue, 0),
    overdue: filtered.filter(r => r.due_date && r.due_date < today).length,
  }), [filtered, byVendor, today])

  function toggleVendor(v) {
    setOpenVendors(prev => {
      const next = new Set(prev)
      next.has(v) ? next.delete(v) : next.add(v)
      return next
    })
  }

  if (err) return <div style={{ padding: 40, color: C.rose }}>Incoming failed to load: {err}</div>
  if (!rows) return <div style={{ padding: 40, color: C.inkLight }}>Loading…</div>

  if (rows.length === 0) return (
    <div style={{ padding: 40, color: C.inkLight, fontSize: 13 }}>
      No open purchase lines yet — the purchasing feed lands with the next hourly LIFT sync.
    </div>
  )

  return (
    <div>
      {/* Header + doctrine line */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: C.ink, margin: 0, fontFamily: 'var(--font-display)' }}>Incoming — open purchase lines</h2>
        <span style={{ fontSize: 11, color: C.inkLight }}>
          LIFT purchasing side (Brynn's screen) · refreshes hourly · open quantity &gt; 0
        </span>
      </div>

      <BigSearch value={q} onChange={setQ}
        placeholder="Find a PO, material, vendor, or invoice…"
        count={q.trim() ? filtered.length : null} />

      {/* Totals strip */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 12, fontSize: 12, color: C.inkMid }}>
        <span><strong style={{ color: C.ink }}>{fmt(totals.pos)}</strong> open POs</span>
        <span><strong style={{ color: C.ink }}>{fmt(totals.lines)}</strong> lines</span>
        <span><strong style={{ color: C.ink }}>{fmt(totals.vendors)}</strong> vendors</span>
        <span><strong style={{ color: C.yards }}>{fmt(Math.round(totals.openQty))}</strong> units open</span>
        <span><strong style={{ color: C.revenue }}>{fmtK(totals.openValue)}</strong> open value</span>
        {totals.overdue > 0 && (
          <span style={{ color: C.rose, fontWeight: 700 }}>{fmt(totals.overdue)} line{totals.overdue !== 1 ? 's' : ''} past due date</span>
        )}
      </div>

      {/* Vendor groups — click a vendor row to drill into its lines.
          A live search auto-expands every matching vendor so the found PO
          line is visible without a second click. */}
      {byVendor.map(g => {
        const open = openVendors.has(g.vendor) || q.trim().length > 0
        return (
          <div key={g.vendor} style={{ marginBottom: 8, background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <div
              onClick={() => toggleVendor(g.vendor)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer', background: open ? 'var(--surface-2)' : 'transparent' }}
            >
              <span style={{ fontSize: 12, color: C.inkLight, width: 14 }}>{open ? '▾' : '▸'}</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: C.ink }}>{g.vendor}</span>
              {g.overdue > 0 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: C.rose, background: 'color-mix(in srgb, var(--waste) 15%, transparent)', padding: '2px 8px', borderRadius: 4 }}>
                  {g.overdue} past due
                </span>
              )}
              <span style={{ fontSize: 12, color: C.inkMid }}>{fmt(g.pos.size)} PO{g.pos.size !== 1 ? 's' : ''}</span>
              <span style={{ fontSize: 12, color: C.yards, fontWeight: 600, width: 110, textAlign: 'right' }}>{fmt(Math.round(g.openQty))} open</span>
              <span style={{ fontSize: 12, color: C.revenue, fontWeight: 700, width: 90, textAlign: 'right' }}>{fmtK(g.openValue)}</span>
            </div>
            {open && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ color: C.inkLight, textAlign: 'left' }}>
                    {['PO', 'Material', 'Category', 'Ordered', 'Received', 'Open', 'Unit cost', 'Open value', 'Due', 'Status', 'Invoice'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', borderTop: `1px solid ${C.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {g.lines.map(r => {
                    const late = r.due_date && r.due_date < today
                    return (
                      <tr key={r.po_line_id} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: C.inkMid, whiteSpace: 'nowrap' }}>{r.po_number}</td>
                        <td style={{ padding: '6px 10px', color: C.ink }}>{r.material}</td>
                        <td style={{ padding: '6px 10px', color: C.inkLight, whiteSpace: 'nowrap' }}>
                          {[r.material_category, r.material_sub_category].filter(Boolean).join(' · ')}
                        </td>
                        <td style={{ padding: '6px 10px', color: C.inkMid, textAlign: 'right' }}>{fmt(Math.round(r.ordered_qty || 0))}</td>
                        <td style={{ padding: '6px 10px', color: C.inkMid, textAlign: 'right' }}>{fmt(Math.round(r.received_qty || 0))}</td>
                        <td style={{ padding: '6px 10px', color: C.yards, fontWeight: 700, textAlign: 'right' }}>{fmt(Math.round(r.open_qty || 0))} {r.uom === 'YARD' ? 'yd' : (r.uom || '').toLowerCase()}</td>
                        <td style={{ padding: '6px 10px', color: C.inkMid, textAlign: 'right' }}>{Number(r.unit_cost) > 0 ? `$${Number(r.unit_cost).toFixed(2)}` : '—'}</td>
                        <td style={{ padding: '6px 10px', color: C.revenue, textAlign: 'right' }}>
                          {Number(r.unit_cost) > 0 ? fmtK(Number(r.open_qty || 0) * Number(r.unit_cost)) : (Number(r.extended_cost) > 0 ? fmtK(r.extended_cost) : '—')}
                        </td>
                        <td style={{ padding: '6px 10px', color: late ? C.rose : C.inkMid, fontWeight: late ? 700 : 400, whiteSpace: 'nowrap' }}>
                          {r.due_date || '—'}{late ? ' ⚠' : ''}
                        </td>
                        <td style={{ padding: '6px 10px', color: C.inkLight, whiteSpace: 'nowrap' }}>{r.status || '—'}</td>
                        <td style={{ padding: '6px 10px', color: r.invoice_number ? C.inkMid : C.inkLight, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                          {r.invoice_number || '—'}{r.invoice_date ? ` · ${r.invoice_date}` : ''}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
    </div>
  )
}
