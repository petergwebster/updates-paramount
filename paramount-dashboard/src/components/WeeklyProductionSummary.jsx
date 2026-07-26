// ============================================================================
// WeeklyProductionSummary.jsx — Admin > Intelligence section. Claude reads the
// week's Scheduler + Live Ops data and writes a production commentary. Mirrors
// the Monthly Briefs generate → edit → save/lock → history pattern.
// Priority order (Peter's): DATA INTEGRITY first, then per-SITE sections
// (units then operators), then waste (where + why), then lost capacity.
// ============================================================================

import { useState, useEffect, useMemo, useCallback } from 'react'
import { format, startOfWeek, subWeeks } from 'date-fns'
import {
  gatherWeeklyProdData,
  saveWeeklyProdSummary,
  listSavedWeeklySummaries,
  loadSavedWeeklySummary,
} from '../lib/weeklyProdSummaryData'
import { buildWeeklyProdPrompt } from '../lib/weeklyProdSummaryNarrative'

const C = {
  navy: '#2f4a5c', ink: '#2b2b28', inkMid: '#5c6169', inkLight: '#9099a0',
  border: '#dcd8cc', warm: '#f5f2ea', card: '#ffffff',
  red: '#b04a2f', amber: '#b07a2f', green: '#4a7c59', redBg: '#f6e4dc',
}
const fmt  = n => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString()
const pct  = n => (n == null || isNaN(n)) ? '—' : Math.round(n) + '%'
const pct1 = n => (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'
const siteShort = s => (s === 'bny' ? 'BNY' : 'Passaic')

function buildWeekOptions(anchor = new Date()) {
  const sun = startOfWeek(anchor, { weekStartsOn: 0 })
  const opts = []
  for (let i = 0; i < 12; i++) {
    const d = subWeeks(sun, i)
    opts.push({ key: format(d, 'yyyy-MM-dd'), label: `Week of ${format(d, 'MMM d, yyyy')}` })
  }
  return opts
}

export default function WeeklyProductionSummary({ authUser }) {
  const weekOptions = useMemo(() => buildWeekOptions(), [])
  const [weekKey, setWeekKey] = useState(weekOptions[0].key)
  const [stage, setStage] = useState('idle')     // idle | gathering | drafting | ready | error | saving
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const [narrative, setNarrative] = useState('')
  const [history, setHistory] = useState([])
  const [loadedFromId, setLoadedFromId] = useState(null)
  const [lastSaveAt, setLastSaveAt] = useState(null)
  const [unsaved, setUnsaved] = useState(false)

  const weekLabel = weekOptions.find(w => w.key === weekKey)?.label || weekKey
  const busy = stage === 'gathering' || stage === 'drafting' || stage === 'saving'

  const refreshHistory = useCallback(async () => {
    setHistory(await listSavedWeeklySummaries({ weekStart: weekKey }))
  }, [weekKey])
  useEffect(() => { refreshHistory() }, [refreshHistory])
  useEffect(() => { if (stage === 'ready' && narrative) setUnsaved(true) }, [narrative]) // eslint-disable-line

  async function generate() {
    setError(null); setData(null); setNarrative(''); setLoadedFromId(null); setLastSaveAt(null); setUnsaved(false)
    setStage('gathering')
    try {
      const d = await gatherWeeklyProdData({ weekStart: new Date(weekKey + 'T00:00:00') })
      setData(d); setStage('drafting')
      const prompt = buildWeeklyProdPrompt({ data: d })
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      })
      if (!res.ok) throw new Error(`Claude API returned ${res.status}`)
      const result = await res.json()
      const text = result.content?.find(c => c.type === 'text')?.text?.trim()
      if (!text) throw new Error('Claude returned no summary text')
      setNarrative(text)
      setTimeout(() => setUnsaved(false), 50)
      setStage('ready')
    } catch (e) {
      console.error('WeeklyProductionSummary.generate:', e)
      setError(e.message || 'Generation failed'); setStage('error')
    }
  }

  async function save() {
    if (!data || !narrative) return
    setStage('saving')
    try {
      const saved = await saveWeeklyProdSummary({ weekStart: weekKey, narrative, dataSnapshot: data, authUser })
      setLastSaveAt(saved.saved_at); setLoadedFromId(saved.id); setUnsaved(false); setStage('ready')
      await refreshHistory()
    } catch (e) {
      console.error('WeeklyProductionSummary.save:', e)
      setError('Save failed: ' + (e.message || 'unknown')); setStage('ready')
    }
  }

  async function loadSaved(id) {
    setError(null); setStage('gathering')
    try {
      const row = await loadSavedWeeklySummary(id)
      setData(row.data_snapshot); setNarrative(row.narrative)
      setLoadedFromId(row.id); setLastSaveAt(row.saved_at); setUnsaved(false); setStage('ready')
    } catch (e) {
      console.error('WeeklyProductionSummary.loadSaved:', e)
      setError('Load failed: ' + (e.message || 'unknown')); setStage('error')
    }
  }

  function reset() {
    setStage('idle'); setError(null); setData(null); setNarrative('')
    setLoadedFromId(null); setLastSaveAt(null); setUnsaved(false)
  }

  return (
    <div style={{ maxWidth: 940 }}>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: C.ink, margin: '0 0 6px' }}>Weekly Production Summary</h2>
      <p style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.5, margin: '0 0 18px', maxWidth: 660 }}>
        Claude reads the week's Scheduler and Live Ops data and writes a production commentary — leading with
        data-recording completeness, then production vs plan by table/machine, waste (where and why), and lost
        capacity. Generate, review and edit, then Save to lock the version for the week.
      </p>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: C.inkLight, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', flexDirection: 'column', gap: 4 }}>
          Week
          <select value={weekKey} onChange={e => { setWeekKey(e.target.value); reset() }} disabled={busy}
            style={{ padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 14, fontWeight: 400, color: C.ink, background: 'var(--surface)', minWidth: 210 }}>
            {weekOptions.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </label>
        <button onClick={generate} disabled={busy}
          style={{ padding: '10px 20px', background: C.navy, color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
          Generate Summary
        </button>
      </div>

      {stage === 'gathering' && <Status text={loadedFromId ? 'Loading saved summary…' : `Gathering ${weekLabel} — scheduler, actuals, notes…`} />}
      {stage === 'drafting' && <Status text="Claude is analyzing the week and writing the summary…" />}
      {stage === 'saving' && <Status text="Saving…" />}
      {stage === 'error' && (
        <div style={{ padding: 14, background: C.redBg, border: `1px solid ${C.red}`, borderRadius: 6, fontSize: 13, color: C.ink, marginBottom: 16 }}>
          <strong>Action failed.</strong> {error}
          <button onClick={reset} style={{ marginLeft: 8, background: 'none', border: 'none', color: C.navy, textDecoration: 'underline', cursor: 'pointer' }}>Try again</button>
        </div>
      )}

      <HistoryList items={history} weekLabel={weekLabel} loadedFromId={loadedFromId} onLoad={loadSaved} />

      {(stage === 'ready' || stage === 'saving') && data && (
        <Preview
          data={data} narrative={narrative} onNarrative={setNarrative}
          onSave={save} isSaving={stage === 'saving'} unsaved={unsaved}
          lastSaveAt={lastSaveAt} weekLabel={weekLabel}
        />
      )}
    </div>
  )
}

// ── Preview ─────────────────────────────────────────────────────────────────
function Preview({ data, narrative, onNarrative, onSave, isSaving, unsaved, lastSaveAt, weekLabel }) {
  const I = data.integrity
  const cov = I.coveragePct
  const covColor = cov == null ? C.inkLight : cov >= 90 ? C.green : cov >= 70 ? C.amber : C.red

  return (
    <div style={{ marginTop: 18, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', background: C.navy, color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', opacity: 0.8 }}>PARAMOUNT PRINTS · PRODUCTION</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{weekLabel}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            {isSaving ? 'Saving…' : unsaved ? 'Unsaved changes' : lastSaveAt ? `Saved ${format(new Date(lastSaveAt), 'h:mm a')}` : 'Draft'}
          </span>
          <button onClick={onSave} disabled={isSaving}
            style={{ padding: '8px 16px', background: unsaved ? 'var(--surface)' : 'rgba(255,255,255,0.2)', color: unsaved ? C.navy : 'var(--surface)', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Save &amp; Lock
          </button>
        </div>
      </div>

      <div style={{ padding: 20 }}>
        {/* DATA INTEGRITY — pinned first */}
        <div style={{ border: `1px solid ${covColor}`, borderLeft: `4px solid ${covColor}`, borderRadius: 8, padding: 16, marginBottom: 20, background: (cov != null && cov < 70) ? C.redBg : C.warm }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.inkLight, letterSpacing: '0.06em' }}>DATA INTEGRITY</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: covColor }}>{pct(cov)} <span style={{ fontSize: 12, color: C.inkMid, fontWeight: 400 }}>recorded</span></div>
          </div>
          <div style={{ fontSize: 13, color: C.inkMid, marginBottom: I.notRecorded.length ? 10 : 0 }}>
            {I.recordedCells} of {I.plannedCells} planned table/machine-days recorded on completed days
            ({I.elapsedDays.length ? I.elapsedDays.join(', ') : 'none yet'}).
          </div>
          {I.notRecorded.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Not recorded — follow up ({I.notRecorded.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {I.notRecorded.map((nr, i) => (
                  <div key={i} style={{ fontSize: 13, color: C.ink, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{siteShort(nr.site)} · {nr.unitCode}</strong>
                    <span style={{ color: C.inkMid }}>{nr.dayLabel}</span>
                    <span style={{ color: C.inkLight }}>planned {fmt(nr.planned)} yds{nr.operators.length ? ` · ${nr.operators.join(' / ')}` : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
          <Kpi label="PRODUCTION" main={fmt(data.combined.actualYards)} unit="yds" sub={`${pct(data.combined.attainmentPct)} of ${fmt(data.combined.plannedYards)} planned`} />
          <Kpi label="COLOR-YARDS · PASSAIC" main={fmt(data.bySite.passaic.colorYards)} unit="cyds" sub={data.bySite.passaic.scheduledColorYards ? `${pct(data.bySite.passaic.colorAttainmentPct)} of ${fmt(data.bySite.passaic.scheduledColorYards)}` : '—'} />
          <Kpi label="WASTE" main={fmt(data.combined.wasteYards)} unit="yds" sub={`${pct1(data.combined.wastePct)} of run`} />
          <Kpi label="PO-TAGGING" main={pct(data.attribution.coveragePct)} sub={`${fmt(data.attribution.producedAttributed)} of ${fmt(data.attribution.producedTotal)} yds tagged`} />
        </div>

        {/* Editable narrative */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.inkLight, letterSpacing: '0.06em', marginBottom: 6 }}>PRODUCTION COMMENTARY</div>
          <div style={{ height: 2, width: 40, background: C.navy, marginBottom: 10 }} />
          <textarea value={narrative} onChange={e => onNarrative(e.target.value)} spellCheck
            rows={Math.max(12, narrative.split('\n').length + 2)}
            style={{ width: '100%', padding: '12px 14px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, lineHeight: 1.6, color: C.ink, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
          <div style={{ fontSize: 11, color: C.inkLight, marginTop: 6 }}>Edit freely — Save &amp; Lock stores this version with a timestamp for the week.</div>
        </div>

        {/* ── Per-site sections: units then operators ── */}
        {['passaic', 'bny'].map(site => {
          const siteUnits = data.units
            .filter(u => u.site === site && (u.plannedYards > 0 || u.actualYards > 0))
            .sort((a, b) => (a.attainmentPct ?? 9999) - (b.attainmentPct ?? 9999))
          const siteOps = (data.operators || []).filter(o => o.site === site)
          if (siteUnits.length === 0 && siteOps.length === 0) return null
          const isBny = site === 'bny'
          return (
            <div key={site} style={{ marginBottom: 26 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.navy, marginBottom: 12, paddingBottom: 6, borderBottom: `2px solid ${C.navy}` }}>
                {isBny ? 'BNY · DIGITAL MACHINES' : 'PASSAIC · HAND-SCREEN TABLES'}
              </div>

              <SubLabel>{isBny ? 'Machines' : 'Tables'} · worst attainment first</SubLabel>
              <UnitScorecard units={siteUnits} unitHeader={isBny ? 'Machine' : 'Table'} />

              <div style={{ marginTop: 16 }}>
                <SubLabel>Operators</SubLabel>
                <OperatorScorecard operators={siteOps} />
              </div>
            </div>
          )
        })}
        <div style={{ fontSize: 11, color: C.inkLight, fontStyle: 'italic', lineHeight: 1.5, marginTop: -10, marginBottom: 24 }}>
          Operator yards and waste credit BOTH operators on a table — not split — so a total reflects tables worked,
          not solo output. “Recorded” shows closed-out vs planned cells; a low producer with a low recorded count is
          likely a data-entry gap, not a performance issue.
        </div>

        {/* Waste + notes */}
        <SectionLabel>WASTE — WHERE &amp; WHY</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 22 }}>
          <div>
            <div style={{ fontSize: 11, color: C.inkLight, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Where · by product</div>
            {data.wasteByProduct.filter(w => w.wasteYards > 0).length
              ? data.wasteByProduct.filter(w => w.wasteYards > 0).map((w, i) => (
                  <div key={i} style={{ fontSize: 13, color: C.ink, display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                    <span>{w.product}</span><span>{fmt(w.wasteYards)} yds · {pct1(w.wastePct)}</span>
                  </div>
                ))
              : <div style={{ fontSize: 13, color: C.inkLight, fontStyle: 'italic' }}>No waste recorded this week.</div>}
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.inkLight, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Why · note categories</div>
            {data.notesByCategory.length
              ? data.notesByCategory.map((c, i) => (
                  <div key={i} style={{ fontSize: 13, color: C.ink, display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                    <span>{c.category}</span><span>{c.count}</span>
                  </div>
                ))
              : <div style={{ fontSize: 13, color: C.inkLight, fontStyle: 'italic' }}>No categorized notes this week.</div>}
          </div>
        </div>

        {/* Lost capacity */}
        {data.lostCapacity.length > 0 && (
          <>
            <SectionLabel>LOST CAPACITY · yards short (not measured hours)</SectionLabel>
            <div>
              {data.lostCapacity.slice(0, 8).map((lc, i) => (
                <div key={i} style={{ fontSize: 13, color: C.ink, padding: '5px 0', borderTop: i ? `1px solid ${C.border}` : 'none' }}>
                  <strong>{lc.unitCode}</strong> <span style={{ color: C.inkLight }}>({lc.product})</span> — {fmt(lc.shortfallYards)} yds short ({fmt(lc.actualYards)}/{fmt(lc.plannedYards)}, {pct(lc.attainmentPct)})
                  {lc.interruptionNotes.length > 0 && <span style={{ color: C.inkMid }}> · {lc.interruptionNotes.map(n => n.text).join('; ')}</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Scorecard sub-components ─────────────────────────────────────────────────
function UnitScorecard({ units, unitHeader }) {
  if (!units.length) return <div style={{ fontSize: 13, color: C.inkLight, fontStyle: 'italic' }}>Nothing recorded.</div>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ color: C.inkLight, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          <th style={thL}>{unitHeader}</th><th style={thL}>Product</th>
          <th style={thR}>Actual</th><th style={thR}>Planned</th><th style={thR}>Attain.</th><th style={thL}>Not rec.</th>
        </tr>
      </thead>
      <tbody>
        {units.map((u, i) => (
          <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={{ ...tdL, fontWeight: 600 }}>{u.unitCode}</td>
            <td style={tdL}>{u.product}</td>
            <td style={tdR}>{fmt(u.actualYards)}</td>
            <td style={tdR}>{u.plannedYards > 0 ? fmt(u.plannedYards) : '—'}</td>
            <td style={{ ...tdR, color: attColor(u.attainmentPct), fontWeight: 600 }}>{u.plannedYards > 0 ? pct(u.attainmentPct) : 'no plan'}</td>
            <td style={{ ...tdL, color: C.red }}>{u.missingDays.join('/') || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function OperatorScorecard({ operators }) {
  if (!operators.length) return <div style={{ fontSize: 13, color: C.inkLight, fontStyle: 'italic' }}>No operators recorded.</div>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ color: C.inkLight, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          <th style={thL}>Operator</th>
          <th style={thR}>Produced</th><th style={thR}>Waste</th><th style={thR}>Waste %</th>
          <th style={thR}>Attain.</th><th style={thR}>Recorded</th>
        </tr>
      </thead>
      <tbody>
        {operators.map((o, i) => (
          <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={{ ...tdL, fontWeight: 600 }}>{o.name}</td>
            <td style={tdR}>{fmt(o.actualYards)}</td>
            <td style={tdR}>{fmt(o.wasteYards)}</td>
            <td style={{ ...tdR, color: (o.wastePct != null && o.wastePct > 8) ? C.red : C.ink }}>{pct1(o.wastePct)}</td>
            <td style={{ ...tdR, color: attColor(o.attainmentPct), fontWeight: 600 }}>{o.plannedYards > 0 ? pct(o.attainmentPct) : 'no plan'}</td>
            <td style={{ ...tdR, color: (o.coveragePct != null && o.coveragePct < 100) ? C.amber : C.inkMid }}>{o.plannedCells > 0 ? `${o.recordedCells}/${o.plannedCells}` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Small components + style helpers ────────────────────────────────────────
function Status({ text }) {
  return <div style={{ padding: '10px 0', fontSize: 13, color: C.inkMid, fontStyle: 'italic', marginBottom: 12 }}>{text}</div>
}

function HistoryList({ items, weekLabel, loadedFromId, onLoad }) {
  if (!items || items.length === 0) return null
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', marginBottom: 16, background: C.warm }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.inkLight, letterSpacing: '0.06em', marginBottom: 8 }}>
        SAVED VERSIONS · {weekLabel} · {items.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map(it => {
          const active = loadedFromId === it.id
          return (
            <div key={it.id} onClick={() => onLoad(it.id)}
              style={{ cursor: 'pointer', padding: '6px 8px', borderRadius: 6, background: active ? 'var(--surface)' : 'transparent', border: `1px solid ${active ? C.border : 'transparent'}` }}>
              <div style={{ fontSize: 12, color: C.ink }}>
                {it.saved_at ? format(new Date(it.saved_at), 'MMM d · h:mm a') : '—'}
                {active && <span style={{ fontSize: 10, color: C.green, fontWeight: 700 }}> · VIEWING</span>}
              </div>
              <div style={{ fontSize: 11, color: C.inkLight }}>
                {it.saved_by_email || 'unknown'} — {(it.narrative || '').slice(0, 90).replace(/\s+/g, ' ').trim()}…
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Kpi({ label, main, unit, sub }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', background: C.warm }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.inkLight, letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: C.ink }}>
        {main}{unit && <span style={{ fontSize: 12, color: C.inkLight, fontWeight: 400, marginLeft: 3 }}>{unit}</span>}
      </div>
      <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>{sub}</div>
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: C.inkLight, letterSpacing: '0.06em', marginBottom: 10, borderBottom: `1px solid ${C.border}`, paddingBottom: 6 }}>
      {children}
    </div>
  )
}

function SubLabel({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: C.inkLight, letterSpacing: '0.05em', marginBottom: 6, textTransform: 'uppercase' }}>{children}</div>
}

const thL = { padding: '6px 8px', textAlign: 'left', fontWeight: 700 }
const thR = { padding: '6px 8px', textAlign: 'right', fontWeight: 700 }
const tdL = { padding: '6px 8px', textAlign: 'left', color: C.ink }
const tdR = { padding: '6px 8px', textAlign: 'right', color: C.ink, fontVariantNumeric: 'tabular-nums' }
function attColor(p) { if (p == null) return C.inkLight; if (p >= 95) return C.green; if (p >= 75) return C.amber; return C.red }
