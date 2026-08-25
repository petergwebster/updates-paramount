import React, { useState, useEffect } from 'react'
import { C, fmt } from '../lib/scheduleUtils'

// ═══════════════════════════════════════════════════════════════════════════
// HELD TO INVOICE — the live stock of printed-but-unbilled work, from LIFT.
//
// THE GOAL (exec deck): each site carries no more than ONE WEEK'S production
// target in HTI — Passaic 8,610 yd · BNY 12,000 yd. This page scores the live
// stock against that bar and shows every line behind the number, oldest
// first, so the bottleneck has names on it. Lines drop off automatically the
// moment LIFT dates their invoice.
//
// Measure = John's DAX (proven in the 8/9 tie-out, matches Wendy's 8/25
// drill-through): printed quantity × per-SKU Yield, no invoice date yet.
// Built 8/25 from Peter + Wendy's ask. v1 is visibility; action affordances
// come after the re-org pass.
// ═══════════════════════════════════════════════════════════════════════════

const SITE_LABEL = { sp: 'Passaic — Screen Print', dg: 'Brooklyn — Digital' }
const AGE_ORDER = [
  ['d7', '< 7 days', 'var(--revenue)'],
  ['d14', '7–14', 'var(--yards)'],
  ['d30', '14–30', 'var(--scheduled)'],
  ['d60', '30–60', 'var(--site-nj)'],
  ['d60plus', '60+ days', 'var(--waste)'],
]

function pctColor(pct) {
  if (pct <= 100) return 'var(--revenue)'
  if (pct <= 130) return 'var(--scheduled)'
  return 'var(--waste)'
}
function ageColor(age) {
  if (age == null) return C.inkLight
  if (age >= 60) return 'var(--waste)'
  if (age >= 30) return 'var(--site-nj)'
  if (age >= 14) return 'var(--scheduled)'
  return C.inkMid
}

function SiteCard({ k, s }) {
  const pct = s.pctOfTarget
  const barPct = Math.min(100, Math.round((s.yds / Math.max(s.yds, s.target)) * 100))
  const tgtMark = Math.min(100, Math.round((s.target / Math.max(s.yds, s.target)) * 100))
  return (
    <div style={{ flex: 1, minWidth: 320, background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight }}>{SITE_LABEL[k]}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
        <span style={{ fontSize: 34, fontWeight: 700, color: pctColor(pct), fontFamily: 'var(--font-display)' }}>{fmt(s.yds)}</span>
        <span style={{ fontSize: 13, color: C.inkMid }}>yd held · {s.lines} lines</span>
      </div>
      <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>
        Goal ≤ {fmt(s.target)} (one week's production) · <b style={{ color: pctColor(pct) }}>{pct}% of the bar</b>
      </div>
      <div style={{ position: 'relative', height: 10, background: 'var(--surface-2)', borderRadius: 5, marginTop: 10, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${barPct}%`, background: pctColor(pct), borderRadius: 5 }} />
        <div style={{ position: 'absolute', left: `${tgtMark}%`, top: -2, bottom: -2, width: 2, background: C.ink }} title={`target ${fmt(s.target)}`} />
      </div>
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.inkLight, marginBottom: 6 }}>Age of held yards</div>
        <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--surface-2)' }}>
          {AGE_ORDER.map(([key, , color]) => {
            const v = s.ages[key] || 0
            const w = s.yds > 0 ? (v / s.yds) * 100 : 0
            return w > 0 ? <div key={key} style={{ width: `${w}%`, background: color }} title={`${fmt(v)} yd`} /> : null
          })}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
          {AGE_ORDER.map(([key, label, color]) => (
            <span key={key} style={{ fontSize: 10.5, color: C.inkMid, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
              {label}: {fmt(s.ages[key] || 0)}
            </span>
          ))}
        </div>
      </div>
      {s.topCustomers?.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11.5, color: C.inkMid }}>
          <b style={{ color: C.inkLight, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Largest holders: </b>
          {s.topCustomers.slice(0, 4).map(c => `${c.name.replace('F. SCHUMACHER & CO', 'FSCO')} ${fmt(c.yds)}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

export default function HeldToInvoiceTab() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [siteFilter, setSiteFilter] = useState('all')

  async function pull() {
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/.netlify/functions/hti-summary', { method: 'POST' })
      const j = await res.json()
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`)
      setData(j)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  useEffect(() => { pull() }, [])

  const lines = (data?.lines || []).filter(l => siteFilter === 'all' || l.div === siteFilter)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, fontFamily: 'var(--font-display)' }}>Held to Invoice</div>
          <div style={{ fontSize: 12, color: C.inkMid }}>
            Printed, not yet billed — live from LIFT{data ? ` · as of ${new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ET` : ''}. Lines drop off the moment the invoice dates.
          </div>
        </div>
        <button onClick={pull} disabled={busy}
          style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'var(--surface)', color: busy ? C.inkLight : C.ink, fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
          {busy ? 'Pulling from LIFT…' : '↻ Refresh from LIFT'}
        </button>
      </div>

      {err && (
        <div style={{ padding: '12px 16px', borderRadius: 8, border: '1px solid var(--waste)', color: 'var(--waste)', fontSize: 13, marginBottom: 14 }}>
          Pull failed: {err}
        </div>
      )}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
            <SiteCard k="sp" s={data.sites.passaic} />
            <SiteCard k="dg" s={data.sites.bny} />
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {[['all', 'All lines'], ['sp', 'Passaic'], ['dg', 'Brooklyn']].map(([k, label]) => (
              <button key={k} onClick={() => setSiteFilter(k)}
                style={{ padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${siteFilter === k ? C.ink : C.border}`,
                  background: siteFilter === k ? C.ink : 'transparent',
                  color: siteFilter === k ? 'var(--paper)' : C.inkMid }}>
                {label}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: C.inkLight, alignSelf: 'center' }}>
              {lines.length} lines · oldest first
            </span>
          </div>

          <div style={{ background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '56px 120px 1.2fr 1.5fr 90px 110px 84px 58px 80px', padding: '8px 14px', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.inkLight, background: C.parchment }}>
              <span>Site</span><span>PO</span><span>Customer</span><span>Item · Description</span>
              <span>Category</span><span>Status</span><span>Printed</span>
              <span style={{ textAlign: 'right' }}>Age</span><span style={{ textAlign: 'right' }}>Yds</span>
            </div>
            {lines.map((l, i) => (
              <div key={l.order + l.po + i} style={{ display: 'grid', gridTemplateColumns: '56px 120px 1.2fr 1.5fr 90px 110px 84px 58px 80px', padding: '8px 14px', fontSize: 12, alignItems: 'center', borderTop: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: l.div === 'sp' ? 'var(--site-nj)' : 'var(--site-bny)' }}>{l.div === 'sp' ? 'NJ' : 'BK'}</span>
                <span style={{ color: C.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.po || l.order}</span>
                <span style={{ color: C.inkMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(l.customer || '').replace('F. SCHUMACHER & CO', 'FSCO')}</span>
                <span style={{ color: C.inkMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${l.sku} · ${l.desc}`}>{l.sku}{l.desc ? ` · ${l.desc}` : ''}</span>
                <span style={{ color: C.inkLight, fontSize: 11 }}>{l.cat}</span>
                <span style={{ color: C.inkLight, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.status}</span>
                <span style={{ color: C.inkLight, fontSize: 11 }}>{l.printed || '—'}</span>
                <span style={{ textAlign: 'right', fontWeight: l.age >= 30 ? 700 : 400, color: ageColor(l.age) }}>{l.age == null ? '—' : `${l.age}d`}</span>
                <span style={{ textAlign: 'right', color: C.ink, fontWeight: 600 }}>{fmt(l.yds)}</span>
              </div>
            ))}
            {lines.length === 0 && !busy && (
              <div style={{ padding: '18px 16px', fontSize: 13, color: C.inkLight, fontStyle: 'italic' }}>Nothing held — every printed line is billed. Frame this screen.</div>
            )}
          </div>
        </>
      )}

      {!data && busy && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: C.inkLight, fontSize: 13 }}>Pulling the live stock from LIFT…</div>
      )}
    </div>
  )
}
