import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'

// ═══════════════════════════════════════════════════════════════════════════
// LeversTab — the 2027 strategy deck's committed H2 levers, tracked live.
//
// The deck (Paramount_Prints_2027_Strategy_FINAL, June '26) commits three
// measurable weekly targets whose EBITDA stakes total ~$2.1M of the '26F
// bridge. The dashboard already carries every number they need — this tab
// just puts the weekly actuals against the target lines so lever attainment
// is a chart, not a quarterly argument.
//
//   1. Ship → 8,500 invoiced yd/wk  (Screenprint · +$1.33M — biggest lever)
//   2. Waste → 8%                    (Screenprint · +$226K)
//   3. Hold ~15,000 produced yd/wk   (Digital · +$531K)
//
// Source: production table (the weekly rows Naomy saves — now machine-
// prefilled). Baselines shown are the lever model's Jan–May averages.
// ═══════════════════════════════════════════════════════════════════════════

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0 }
const NJ_CATS = ['fabric', 'grass', 'paper']
const ACCENT = { sage: '#3DD68C', amber: '#F5B544', rose: '#F2555A', teal: '#3E8FA8' }

const LEVERS = [
  {
    key: 'ship', title: 'Ship → 8,500 invoiced yd / wk',
    sub: 'Screenprint · +$1.33M EBITDA · the biggest lever in the bridge',
    target: 8500, baseline: 'baseline 6,344 (Jan–May avg)', fmt: (v) => Math.round(v).toLocaleString(),
    status: (v) => v >= 8500 ? 'sage' : v >= 7400 ? 'amber' : 'rose',
  },
  {
    key: 'waste', title: 'Waste → 8%',
    sub: 'Screenprint · +$226K EBITDA · QA lead owns it',
    target: 8, baseline: 'baseline 11.8% (Jan–May avg)', fmt: (v) => v.toFixed(1) + '%',
    status: (v) => v <= 8 ? 'sage' : v <= 11.8 ? 'amber' : 'rose',
  },
  {
    key: 'bny', title: 'Hold ~15,000 produced yd / wk',
    sub: 'Digital · +$531K EBITDA · keep the efficient engine at pace',
    target: 15000, baseline: 'smart scheduling + substrate optimization', fmt: (v) => Math.round(v).toLocaleString(),
    status: (v) => v >= 15000 ? 'sage' : v >= 12750 ? 'amber' : 'rose',
  },
]

function weekLabel(ws) {
  const d = new Date(String(ws).slice(0, 10) + 'T12:00:00')
  return isNaN(d) ? ws : `${d.getMonth() + 1}/${d.getDate()}`
}

function LeverCard({ lever, rows }) {
  const series = rows.map(r => ({ week: r.week, v: r[lever.key] })).filter(p => p.v != null)
  const latest = series.length ? series[series.length - 1] : null
  const peak = Math.max(lever.target * 1.15, ...series.map(p => p.v || 0), 1)
  const targetPct = (lever.target / peak) * 100
  const st = latest ? lever.status(latest.v) : 'amber'
  const inverted = lever.key === 'waste' // lower is better

  return (
    <div style={{ border: '1px solid var(--ink-10)', borderRadius: 10, padding: '18px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{lever.title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-40)', marginTop: 2 }}>{lever.sub}</div>
        </div>
        {latest && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: ACCENT[st] }}>{lever.fmt(latest.v)}</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-40)' }}>
              wk {weekLabel(latest.week)} · target {lever.fmt(lever.target)}
            </div>
          </div>
        )}
      </div>

      {/* weekly bars with the target line */}
      <div style={{ position: 'relative', height: 110, marginTop: 14 }}>
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: `${targetPct}%`,
          borderTop: `2px dashed ${ACCENT.teal}`, opacity: 0.75, zIndex: 1,
        }} />
        <div style={{
          position: 'absolute', right: 0, bottom: `calc(${targetPct}% + 3px)`,
          fontSize: 9.5, color: ACCENT.teal, fontWeight: 700, letterSpacing: '0.04em',
        }}>TARGET</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: '100%' }}>
          {series.map((p) => {
            const h = Math.max(3, Math.min(100, (p.v / peak) * 100))
            const hit = inverted ? p.v <= lever.target : p.v >= lever.target
            return (
              <div key={p.week} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                <div title={`${weekLabel(p.week)}: ${lever.fmt(p.v)}`} style={{
                  width: '100%', maxWidth: 44, height: `${h}%`, borderRadius: '4px 4px 0 0',
                  background: hit ? ACCENT.sage : 'var(--ink-30)', opacity: hit ? 0.95 : 0.6,
                }} />
              </div>
            )
          })}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {series.map(p => (
          <div key={p.week} style={{ flex: 1, textAlign: 'center', fontSize: 9.5, color: 'var(--ink-40)' }}>{weekLabel(p.week)}</div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 8 }}>{lever.baseline}</div>
    </div>
  )
}

export default function LeversTab() {
  const [rows, setRows] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const { data } = await supabase.from('production')
        .select('week_start, nj_data, bny_data')
        .order('week_start', { ascending: false }).limit(12)
      if (dead) return
      const out = (data || []).slice().reverse().map(r => {
        const nj = r.nj_data || {}, bny = r.bny_data || {}
        let inv = 0, waste = 0, prod = 0
        for (const c of NJ_CATS) {
          const d = nj[c] || {}
          inv += num(d.invoiceYds)
          prod += num(d.yards)
          waste += num(d.waste) + num(d.postWaste)
        }
        const bnyProd = num(bny.schProduced) + num(bny.tpProduced)
        return {
          week: r.week_start,
          ship: inv > 0 ? inv : null,
          waste: prod > 0 ? (waste / prod) * 100 : null,
          bny: bnyProd > 0 ? bnyProd : null,
          any: inv > 0 || prod > 0 || bnyProd > 0,
        }
      }).filter(r => r.any)
      setRows(out)
    })()
    return () => { dead = true }
  }, [])

  if (rows === null) return <div style={{ padding: 32, color: 'var(--ink-40)' }}>Loading lever data…</div>

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-40)' }}>
          2027 strategy · committed H2 levers
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-40)', marginTop: 6, lineHeight: 1.5 }}>
          The three measurable weekly commitments from the strategy deck, against their target lines.
          Weekly actuals come from the Production tab — the same rows the Capacity report reads.
          Green bars clear the target; the stakes shown are the deck's EBITDA bridge values.
        </div>
      </div>
      {LEVERS.map(l => <LeverCard key={l.key} lever={l} rows={rows} />)}
      <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 4, lineHeight: 1.5 }}>
        Waste = (in-process + post-production waste) ÷ produced yards, Screenprint categories only.
        Digital produced = SCH + 3P printed. Weeks with no saved production row are omitted.
      </div>
    </div>
  )
}
