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
const NG_COLOR = 'var(--coloryards)'

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
  const total = Math.max(s.coreYds + s.ngYds, s.target)
  const coreW = (s.coreYds / total) * 100
  const ngW = (s.ngYds / total) * 100
  const tgtMark = Math.min(100, (s.target / total) * 100)
  return (
    <div style={{ flex: 1, minWidth: 320, background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px 20px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight }}>{SITE_LABEL[k]}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
        <span style={{ fontSize: 32, fontWeight: 700, color: pctColor(pct), fontFamily: 'var(--font-display)' }}>{fmt(s.coreYds)}</span>
        <span style={{ fontSize: 13, color: C.inkMid }}>yd held · {s.coreLines} lines · <b style={{ color: pctColor(pct) }}>{pct}% of the bar</b></span>
      </div>
      <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 1 }}>Goal ≤ {fmt(s.target)} · one week's production</div>
      <div style={{ position: 'relative', height: 10, background: 'var(--surface-2)', borderRadius: 5, marginTop: 8, overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: `${coreW}%`, background: pctColor(pct) }} />
        <div style={{ width: `${ngW}%`, background: NG_COLOR, opacity: 0.85 }} title={`new goods ${fmt(s.ngYds)} yd`} />
        <div style={{ position: 'absolute', left: `${tgtMark}%`, top: -2, bottom: -2, width: 2, background: C.ink }} title={`target ${fmt(s.target)}`} />
      </div>
      {s.ngYds > 0 && (
        <div style={{ fontSize: 11.5, color: NG_COLOR, marginTop: 6 }}>
          ＋ {fmt(s.ngYds)} yd new goods awaiting design approval ({s.ngLines} lines) — excluded from the bar; hold is upstream, not shipping
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        {AGE_ORDER.map(([key, label, color]) => (
          <span key={key} style={{ fontSize: 10.5, color: C.inkMid, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
            {label}: {fmt(s.ages[key] || 0)}
          </span>
        ))}
      </div>
    </div>
  )
}

const CAT_LABEL = { fabric: 'Fabric', grass: 'Grass', paper: 'Paper', other: 'Strike-offs', digital: 'Digital', 'new goods': 'New Goods — design approval' }

function SiteSection({ k, s, lines, weekStart }) {
  const [open, setOpen] = useState(() => new Set())
  const toggle = (cat) => setOpen(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n })
  const siteLines = lines.filter(l => l.div === k)
  return (
    <div style={{ background: 'var(--surface)', border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkLight, background: C.parchment }}>
        {SITE_LABEL[k]} · by category — click a row for its POs, oldest first
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '16px 1.6fr 70px 100px 90px 1fr', padding: '6px 16px', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.inkLight }}>
        <span /><span>Category</span><span style={{ textAlign: 'right' }}>Lines</span><span style={{ textAlign: 'right' }}>Yards</span><span style={{ textAlign: 'right' }}>Oldest</span><span style={{ textAlign: 'right' }}>Carried from prior weeks</span>
      </div>
      {s.cats.map((c) => {
        const isOpen = open.has(c.cat)
        const catLines = siteLines.filter(l => l.cat === c.cat).sort((a, b) => (b.age ?? -1) - (a.age ?? -1))
        return (
          <div key={c.cat}>
            <div onClick={() => toggle(c.cat)}
              style={{ display: 'grid', gridTemplateColumns: '16px 1.6fr 70px 100px 90px 1fr', padding: '9px 16px', fontSize: 12.5, alignItems: 'center', borderTop: `1px solid ${C.border}`, cursor: 'pointer', background: isOpen ? C.parchment : 'transparent', userSelect: 'none' }}>
              <span style={{ fontSize: 10, color: C.inkLight }}>{isOpen ? '▾' : '▸'}</span>
              <span style={{ color: c.ng ? NG_COLOR : C.ink, fontWeight: 600 }}>{CAT_LABEL[c.cat] || c.cat}</span>
              <span style={{ textAlign: 'right', color: C.inkMid }}>{c.lines}</span>
              <span style={{ textAlign: 'right', color: C.ink, fontWeight: 600 }}>{fmt(c.yds)}</span>
              <span style={{ textAlign: 'right', fontWeight: c.oldest >= 30 ? 700 : 400, color: ageColor(c.oldest) }}>{c.oldest}d</span>
              <span style={{ textAlign: 'right', color: c.carryLines > 0 ? 'var(--waste)' : C.inkLight, fontWeight: c.carryLines > 0 ? 700 : 400 }}>
                {c.carryLines > 0 ? `⚑ ${c.carryLines} PO lines · ${fmt(c.carryYds)} yd` : '—'}
              </span>
            </div>
            {isOpen && (
              <div style={{ borderTop: `1px dashed ${C.border}` }}>
                {catLines.map((l, i) => (
                  <div key={l.order + l.sku + i} style={{ display: 'grid', gridTemplateColumns: '120px 1.1fr 1.6fr 100px 84px 70px 74px', padding: '7px 16px 7px 34px', fontSize: 11.5, alignItems: 'center', borderTop: i === 0 ? 'none' : `1px solid ${C.border}` }}>
                    <span style={{ color: C.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {l.po || l.order}
                      {l.carry && <span title={`printed before week of ${weekStart} — carried over`} style={{ marginLeft: 5, color: 'var(--waste)', fontWeight: 700 }}>⚑</span>}
                    </span>
                    <span style={{ color: C.inkMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(l.customer || '').replace('F. SCHUMACHER & CO', 'FSCO')}</span>
                    <span style={{ color: C.inkMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${l.sku} · ${l.desc}`}>{l.sku}{l.desc ? ` · ${l.desc}` : ''}</span>
                    <span style={{ color: C.inkLight, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.status}</span>
                    <span style={{ color: C.inkLight, fontSize: 10.5 }}>{l.printed || '—'}</span>
                    <span style={{ textAlign: 'right', fontWeight: l.age >= 30 ? 700 : 400, color: ageColor(l.age) }}>{l.age == null ? '—' : `${l.age}d`}</span>
                    <span style={{ textAlign: 'right', color: C.ink, fontWeight: 600 }}>{fmt(l.yds)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function HeldToInvoiceTab() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

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

  const carryTotal = (data?.lines || []).filter(l => l.carry && !l.ng).length

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, fontFamily: 'var(--font-display)' }}>Held to Invoice</div>
          <div style={{ fontSize: 12, color: C.inkMid }}>
            Printed, not yet billed — live from LIFT{data ? ` · as of ${new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ET` : ''}. Lines drop off the moment the invoice dates.
            {carryTotal > 0 && <b style={{ color: 'var(--waste)' }}> ⚑ {carryTotal} lines carried from prior weeks.</b>}
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
          <SiteSection k="sp" s={data.sites.passaic} lines={data.lines} weekStart={data.weekStart} />
          <SiteSection k="dg" s={data.sites.bny} lines={data.lines} weekStart={data.weekStart} />
        </>
      )}

      {!data && busy && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: C.inkLight, fontSize: 13 }}>Pulling the live stock from LIFT…</div>
      )}
    </div>
  )
}
