import React, { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import styles from './KPIScorecard.module.css'

const KPIS = [
  { id: 'financial', name: 'Financial Contribution', desc: 'Cash contribution, margin discipline, revenue vs. target', target: 'Topline grow 10% in 2027' },
  { id: 'cost', name: 'Cost Efficiency', desc: 'Cost per yard, cost per color yard, improvement vs. prior period', target: 'Avg cost/yard reduced ~$1 across categories' },
  { id: 'inventory', name: 'Inventory Management', desc: 'Availability across grounds, slow-moving stock, obsolete inventory', target: 'Inventory stability across all grounds' },
  { id: 'quality', name: 'Quality & Waste', desc: 'Production waste %, reprints, write-offs, QA consistency', target: 'Waste <8%, continued QA improvement' },
  { id: 'delivery', name: 'Delivery Performance', desc: 'End-to-end lead times, WIP reduction, on-time shipment', target: 'WIP time below 10 weeks' },
  { id: 'collaboration', name: 'Cross-Group Collaboration', desc: 'Schumacher Design Studio, Patterson Flynn, other group brands', target: 'Proactive communication & problem-solving' },
  { id: 'grounds', name: 'Grounds Management', desc: 'Grounds mix performance, innovation, stewardship decisions', target: 'Strategic decisions on grounds mix & performance' },
  { id: 'vendors', name: 'Vendor Relationships', desc: 'P+W, Wallquest/Omni (primary) · Rotex, Greenland, Stead (developmental)', target: 'High-trust, high-performance partnerships' },
  { id: 'growth', name: 'Top-Line Growth', desc: 'Third-party revenue, Tillett custom business expansion', target: '$500k+ 3rd party · $1M+ Tillett custom' },
  { id: 'passaic', name: 'Passaic Asset Development', desc: 'Building development, construction, regulatory, tenant coordination', target: 'Long-term site planning & value creation' },
]

const STATUS_OPTIONS = [
  { value: 'green', label: 'On Track' },
  { value: 'amber', label: 'Watch' },
  { value: 'red', label: 'Concern' },
  { value: 'gray', label: 'Pending' },
]

const STATUS_LABELS = { green: 'On Track', amber: 'Watch', red: 'Concern', gray: 'Pending' }

export default function KPIScorecard({ weekData, weekStart, onSave, dbReady }) {
  const [kpis, setKpis] = useState({})
  const [narrative, setNarrative] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState(null)

  useEffect(() => {
    if (weekData?.kpis) setKpis(weekData.kpis)
    else setKpis({})
    if (weekData?.narrative) setNarrative(weekData.narrative)
    else setNarrative('')
  }, [weekData])

  function updateKPI(id, field, value) {
    setKpis(prev => ({
      ...prev,
      [id]: { ...(prev[id] || { status: 'gray', notes: '' }), [field]: value }
    }))
  }

  async function handleSave() {
    setSaving(true)
    await onSave({ kpis, narrative })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  async function generateNarrative() {
    setGenerating(true)
    setGenError(null)
    const weekLabel = format(weekStart, 'MMMM d, yyyy')
    const kpiSummary = KPIS.map(k => {
      const d = kpis[k.id]
      if (!d || d.status === 'gray') return null
      return `${k.name}: ${STATUS_LABELS[d.status]}${d.notes ? ' — ' + d.notes : ''}`
    }).filter(Boolean).join('\n')
    const redItems = KPIS.filter(k => kpis[k.id]?.status === 'red').map(k => k.name)
    const amberItems = KPIS.filter(k => kpis[k.id]?.status === 'amber').map(k => k.name)
    const greenItems = KPIS.filter(k => kpis[k.id]?.status === 'green').map(k => k.name)
    const prompt = `You are helping Peter Webster, President of Paramount Prints (a specialty printing division of F. Schumacher & Co), draft a concise weekly executive summary for his CEO (Timur) and Chief of Staff (Emily).

Paramount Prints has two facilities: Passaic, NJ (screen printing — fabric, grass cloth, wallpaper) and Brooklyn (digital printing). The business does ~$10M/year in revenue.

Week of: ${weekLabel}

KPI Scorecard:
${kpiSummary || 'No KPI data entered yet.'}

Flags (Concern): ${redItems.length > 0 ? redItems.join(', ') : 'None'}
Watch items: ${amberItems.length > 0 ? amberItems.join(', ') : 'None'}
On track: ${greenItems.length > 0 ? greenItems.join(', ') : 'None'}

Write a 3-4 paragraph executive summary in Peter's voice — direct, factual, and candid. Structure:
1. Overall week assessment (1-2 sentences)
2. Key highlights and what is going well
3. Areas of concern or watch items with context
4. Forward look — what to watch next week

Keep it under 200 words. Write in first person as Peter. No bullet points. No headers. Clean paragraphs only.`

    try {
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        })
      })
      const data = await response.json()
      const text = data.content?.find(c => c.type === 'text')?.text
      if (text) setNarrative(text.trim())
      else setGenError('Could not generate summary. Try again.')
    } catch (e) {
      setGenError('Generation failed. Check your connection.')
    }
    setGenerating(false)
  }

  const statusCounts = KPIS.reduce((acc, k) => {
    const s = kpis[k.id]?.status || 'gray'
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})

  const hasKPIData = KPIS.some(k => kpis[k.id]?.status && kpis[k.id].status !== 'gray')

  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.sectionTitle}>KPI Scorecard</h2>
          <p className={styles.sectionSub}>Week of {format(weekStart, 'MMMM d, yyyy')} · Balanced scorecard across all dimensions</p>
        </div>
        <div className={styles.saveRow}>
          <div className={styles.scoreSummary}>
            {statusCounts.green > 0 && <span className="badge badge-green">{statusCounts.green} On Track</span>}
            {statusCounts.amber > 0 && <span className="badge badge-amber">{statusCounts.amber} Watch</span>}
            {statusCounts.red > 0 && <span className="badge badge-red">{statusCounts.red} Concern</span>}
          </div>
          {saved && <span className={styles.savedMsg}>Saved</span>}
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Scorecard'}
          </button>
        </div>
      </div>

      <div className={styles.narrativeSection}>
        <div className={styles.narrativeHeader}>
          <div>
            <div className={styles.narrativeTitle}>Weekly Executive Summary</div>
            <div className={styles.narrativeSub}>AI-drafted from your KPI notes — edit freely before sending</div>
          </div>
          <button
            className={`${styles.generateBtn} ${generating ? styles.generateBtnLoading : ''}`}
            onClick={generateNarrative}
            disabled={generating || !hasKPIData}
            title={!hasKPIData ? 'Fill in at least one KPI status below first' : ''}
          >
            {generating ? <><span className={styles.spinner} />Drafting…</> : <>✦ Draft with AI</>}
          </button>
        </div>
        {genError && <p className={styles.genError}>{genError}</p>}
        <textarea
          className={styles.narrativeText}
          value={narrative}
          onChange={e => setNarrative(e.target.value)}
          placeholder={hasKPIData
            ? 'Click "Draft with AI" to generate a summary from your KPI notes, or type your own here…'
            : 'Fill in your KPI statuses and notes below, then click "Draft with AI"…'}
          rows={8}
        />
        {narrative && (
          <div className={styles.narrativeActions}>
            <button onClick={() => navigator.clipboard.writeText(narrative)} className={styles.copyBtn}>Copy to clipboard</button>
            <span className={styles.narrativeNote}>{narrative.trim().split(/\s+/).length} words</span>
          </div>
        )}
      </div>

      <div className={styles.kpiGrid}>
        {KPIS.map(kpi => {
          const data = kpis[kpi.id] || { status: 'gray', notes: '' }
          const isExpanded = expanded === kpi.id
          return (
            <div key={kpi.id} className={`${styles.kpiCard} ${styles[`kpiCard_${data.status}`]} ${isExpanded ? styles.kpiCardExpanded : ''}`}>
              <div className={styles.kpiTop} onClick={() => setExpanded(isExpanded ? null : kpi.id)}>
                <div className={styles.kpiLeft}>
                  <span className={`dot dot-${data.status}`} />
                  <span className={styles.kpiName}>{kpi.name}</span>
                  {data.notes && <span className={styles.hasNotesDot} />}
                </div>
                <div className={styles.kpiRight}>
                  <span className={`badge badge-${data.status}`}>{STATUS_OPTIONS.find(s => s.value === data.status)?.label || 'Pending'}</span>
                  <span className={styles.chevron}>{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>
              {isExpanded && (
                <div className={`${styles.kpiExpanded} fade-in`}>
                  <p className={styles.kpiDesc}>{kpi.desc}</p>
                  <p className={styles.kpiTarget}><strong>2027 Target:</strong> {kpi.target}</p>
                  <div className={styles.statusPicker}>
                    {STATUS_OPTIONS.map(s => (
                      <button key={s.value} className={`${styles.statusBtn} ${data.status === s.value ? styles[`statusActive_${s.value}`] : ''}`} onClick={() => updateKPI(kpi.id, 'status', s.value)}>
                        <span className={`dot dot-${s.value}`} />{s.label}
                      </button>
                    ))}
                  </div>
                  <label className="label" style={{ marginTop: 12 }}>Notes for this week</label>
                  <textarea value={data.notes || ''} onChange={e => updateKPI(kpi.id, 'notes', e.target.value)} placeholder={`What happened this week on ${kpi.name}?`} rows={4} style={{ marginTop: 6 }} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
