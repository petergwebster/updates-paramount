// ============================================================================
// MonthlyBriefs.jsx — Admin section for generating Mid-Month / End-of-Month
// briefs for FSCO leadership.
// ============================================================================
// Two buttons:
//   • Mid-Month Brief — halftime check, forward-looking framing
//   • End-of-Month Brief — month-closed retrospective framing
//
// Flow on click:
//   1) Gather data via gatherMonthlyBriefData (production, financials,
//      people, WIP for the selected month)
//   2) Build prompt via buildMonthlyBriefPrompt
//   3) Call /api/claude (model claude-sonnet-4-20250514)
//   4) Render preview: header card, executive-summary textarea (editable),
//      MTD tracking table, people, WIP
//   5) Download PDF button → generateMonthlyBriefPdf
//
// Month selector defaults to the chrome week's month, but Peter can pick
// any past or current month from a dropdown — useful for backfill.
//
// Narratives are NOT cached for v1. Each generate call fires Claude.
// Future: cache to a `monthly_briefs` table keyed on (month_key, phase).
// ============================================================================

import { useState, useMemo } from 'react'
import { format, subMonths, startOfMonth } from 'date-fns'
import { gatherMonthlyBriefData } from '../lib/monthlyBriefData'
import { buildMonthlyBriefPrompt } from '../lib/monthlyBriefNarrative'
import { generateMonthlyBriefPdf } from '../lib/monthlyBriefPdf'
import styles from './MonthlyBriefs.module.css'

// Build a list of selectable months — current month + 11 prior
function buildMonthOptions(anchor = new Date()) {
  const opts = []
  for (let i = 0; i < 12; i++) {
    const d = subMonths(startOfMonth(anchor), i)
    opts.push({
      key: format(d, 'yyyy-MM'),
      label: format(d, 'MMMM yyyy'),
    })
  }
  return opts
}

export default function MonthlyBriefs({ weekStart }) {
  // Month options, defaulting to chrome-week's month
  const monthOptions = useMemo(() => buildMonthOptions(), [])
  const defaultMonthKey = useMemo(() => {
    const anchor = weekStart instanceof Date ? weekStart : new Date()
    return format(startOfMonth(anchor), 'yyyy-MM')
  }, [weekStart])

  const [monthKey, setMonthKey] = useState(defaultMonthKey)
  const [phase, setPhase] = useState(null)             // 'mid' | 'end' | null
  const [stage, setStage] = useState('idle')           // idle | gathering | drafting | ready | error
  const [error, setError] = useState(null)
  const [briefData, setBriefData] = useState(null)
  const [narrative, setNarrative] = useState('')
  const [pdfFilename, setPdfFilename] = useState(null)

  const monthLabel = monthOptions.find(m => m.key === monthKey)?.label || monthKey

  // ── Generate flow ─────────────────────────────────────────────────────
  async function generate(selectedPhase) {
    setError(null)
    setBriefData(null)
    setNarrative('')
    setPhase(selectedPhase)
    setStage('gathering')

    try {
      // 1) Gather data
      const data = await gatherMonthlyBriefData({ monthKey, phase: selectedPhase })
      setBriefData(data)
      setStage('drafting')

      // 2) Build prompt
      const prompt = buildMonthlyBriefPrompt({ data })

      // 3) Call Claude
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        }),
      })

      if (!response.ok) {
        throw new Error(`Claude API returned ${response.status}`)
      }

      const result = await response.json()
      const text = result.content?.find(c => c.type === 'text')?.text?.trim()
      if (!text) throw new Error('Claude returned no narrative text')

      setNarrative(text)
      setStage('ready')
    } catch (e) {
      console.error('MonthlyBriefs.generate:', e)
      setError(e.message || 'Generation failed')
      setStage('error')
    }
  }

  async function downloadPdf() {
    if (!briefData || !narrative) return
    try {
      const { filename } = await generateMonthlyBriefPdf({ data: briefData, narrative })
      setPdfFilename(filename)
    } catch (e) {
      console.error('MonthlyBriefs.downloadPdf:', e)
      setError('PDF generation failed: ' + (e.message || 'unknown'))
    }
  }

  function reset() {
    setPhase(null)
    setStage('idle')
    setError(null)
    setBriefData(null)
    setNarrative('')
    setPdfFilename(null)
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <h2 className={styles.title}>Monthly Briefs</h2>
        <p className={styles.subtitle}>
          Generate the Mid-Month or End-of-Month brief that goes to FSCO leadership.
          Claude drafts the executive summary from the month's production, financial,
          people, and WIP data. You can edit the narrative before downloading the PDF.
        </p>
      </div>

      {/* Month picker + buttons */}
      <div className={styles.controls}>
        <label className={styles.monthLabel}>
          Month
          <select
            className={styles.monthSelect}
            value={monthKey}
            onChange={e => { setMonthKey(e.target.value); reset() }}
            disabled={stage === 'gathering' || stage === 'drafting'}
          >
            {monthOptions.map(m => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </label>

        <div className={styles.buttonRow}>
          <button
            className={`${styles.btn} ${styles.btnMid} ${phase === 'mid' && stage === 'ready' ? styles.btnActive : ''}`}
            onClick={() => generate('mid')}
            disabled={stage === 'gathering' || stage === 'drafting'}
          >
            <div className={styles.btnLabel}>Mid-Month Brief</div>
            <div className={styles.btnSub}>Halftime · forward-looking</div>
          </button>

          <button
            className={`${styles.btn} ${styles.btnEnd} ${phase === 'end' && stage === 'ready' ? styles.btnActive : ''}`}
            onClick={() => generate('end')}
            disabled={stage === 'gathering' || stage === 'drafting'}
          >
            <div className={styles.btnLabel}>End-of-Month Brief</div>
            <div className={styles.btnSub}>Closed · retrospective</div>
          </button>
        </div>
      </div>

      {/* Status messages */}
      {stage === 'gathering' && (
        <div className={styles.status}>
          <div className={styles.spinner} />
          Gathering {monthLabel} data — production, financials, people, WIP…
        </div>
      )}
      {stage === 'drafting' && (
        <div className={styles.status}>
          <div className={styles.spinner} />
          Claude is drafting the executive summary…
        </div>
      )}
      {stage === 'error' && (
        <div className={styles.error}>
          <strong>Generation failed.</strong> {error}
          <button className={styles.btnLink} onClick={reset}>Try again</button>
        </div>
      )}

      {/* Preview */}
      {stage === 'ready' && briefData && (
        <BriefPreview
          data={briefData}
          phase={phase}
          narrative={narrative}
          onNarrativeChange={setNarrative}
          onDownload={downloadPdf}
          pdfFilename={pdfFilename}
        />
      )}
    </div>
  )
}

// =============================================================================
// Preview block — renders the brief inline so Peter can review/edit before PDF
// =============================================================================

function BriefPreview({ data, phase, narrative, onNarrativeChange, onDownload, pdfFilename }) {
  const phaseLabel = phase === 'mid' ? 'Mid-Month Brief' : 'End-of-Month Brief'
  const cogsAvail = data.financials.cogsAvailable

  const fByUnit = data.financials.byUnit || {}
  const njRev = fByUnit.NJ?.revenue || fByUnit.Passaic?.revenue || 0
  const bnyRev = fByUnit.BNY?.revenue || 0
  const njOpex = fByUnit.NJ?.opex || fByUnit.Passaic?.opex || 0
  const bnyOpex = fByUnit.BNY?.opex || 0
  const njCogs = fByUnit.NJ?.cogsTotal || fByUnit.Passaic?.cogsTotal || 0
  const bnyCogs = fByUnit.BNY?.cogsTotal || 0

  return (
    <div className={styles.preview}>
      <div className={styles.previewHeader}>
        <div>
          <div className={styles.previewCrumb}>{phaseLabel}</div>
          <h3 className={styles.previewTitle}>{data.pacing.monthLabel}</h3>
        </div>
        <button className={styles.downloadBtn} onClick={onDownload}>
          Download PDF
        </button>
      </div>

      {pdfFilename && (
        <div className={styles.success}>
          PDF generated: <code>{pdfFilename}</code>
        </div>
      )}

      {/* Executive Summary — editable */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>EXECUTIVE SUMMARY · editable</div>
        <textarea
          className={styles.narrativeEditor}
          value={narrative}
          onChange={e => onNarrativeChange(e.target.value)}
          rows={Math.max(8, narrative.split('\n').length + 2)}
          spellCheck
        />
        <div className={styles.helperText}>
          Edit freely — your changes flow into the PDF when you click Download.
        </div>
      </section>

      {/* Production MTD two-column */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>PRODUCTION MTD</div>
        <div className={styles.twoCol}>
          <SiteCard
            title="Brooklyn (Digital)"
            accent="forest"
            rows={[
              ['Produced',     `${fmt(data.production.bnyYards)} yds`],
              ['% to pace',    pct(data.production.bnyVsTargetPct), paceClass(data.production.bnyVsTargetPct)],
              ['Target MTD',   `${fmt(data.targets.expectedBnyMtd)} yds`],
              ['Revenue',      money(bnyRev)],
              ['OpEx',         money(bnyOpex)],
              ['Inv. purch.',  money(fByUnit.BNY?.invPurchases)],
            ]}
          />
          <SiteCard
            title="Passaic (Hand-Screen)"
            accent="brick"
            rows={[
              ['Produced',     `${fmt(data.production.njYards)} yds`],
              ['% to pace',    pct(data.production.njVsTargetPct), paceClass(data.production.njVsTargetPct)],
              ['Color-yards',  fmt(data.production.njColorYards)],
              ['Waste %',      pct1(data.production.njWastePct)],
              ['Revenue',      money(njRev)],
              ['OpEx',         money(njOpex)],
            ]}
          />
        </div>
      </section>

      {/* MTD tracking table */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>MTD TRACKING — NJ · BNY · COMBINED</div>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th className={styles.thLeft}>Metric</th>
              <th>NJ</th>
              <th>BNY</th>
              <th>Combined</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={styles.tdLabel}>Produced MTD</td>
              <td>{fmt(data.production.njYards)} yds</td>
              <td>{fmt(data.production.bnyYards)} yds</td>
              <td>{fmt(data.production.combinedYards)} yds</td>
            </tr>
            <tr>
              <td className={styles.tdLabel}>vs Target</td>
              <td className={paceClass(data.production.njVsTargetPct)}>{pct(data.production.njVsTargetPct)}</td>
              <td className={paceClass(data.production.bnyVsTargetPct)}>{pct(data.production.bnyVsTargetPct)}</td>
              <td className={paceClass(data.production.combVsTargetPct)}>{pct(data.production.combVsTargetPct)}</td>
            </tr>
            <tr>
              <td className={styles.tdLabel}>Revenue MTD</td>
              <td>{money(njRev)}</td>
              <td>{money(bnyRev)}</td>
              <td>{money(data.financials.revenue)}</td>
            </tr>
            <tr>
              <td className={styles.tdLabel}>OpEx MTD</td>
              <td>{money(njOpex)}</td>
              <td>{money(bnyOpex)}</td>
              <td>{money(data.financials.opex)}</td>
            </tr>
            <tr className={cogsAvail ? '' : styles.pendingRow}>
              <td className={styles.tdLabel}>COGS MTD</td>
              <td>{cogsAvail ? money(njCogs) : 'pending'}</td>
              <td>{cogsAvail ? money(bnyCogs) : 'pending'}</td>
              <td>{cogsAvail ? money(data.financials.cogsTotal) : 'pending'}</td>
            </tr>
            <tr>
              <td className={styles.tdLabel}>Inv. Purchases</td>
              <td>{money(fByUnit.NJ?.invPurchases || fByUnit.Passaic?.invPurchases)}</td>
              <td>{money(fByUnit.BNY?.invPurchases)}</td>
              <td>{money(data.financials.invPurchases)}</td>
            </tr>
            <tr>
              <td className={styles.tdLabel}>NJ Waste %</td>
              <td>{pct1(data.production.njWastePct)}</td>
              <td>—</td>
              <td>{pct1(data.production.njWastePct)}</td>
            </tr>
          </tbody>
        </table>
        {!cogsAvail && (
          <div className={styles.cogsNote}>
            COGS pending — {data.financials.cogsPendingNote}
          </div>
        )}
      </section>

      {/* People */}
      {data.people && data.people.bny && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>PEOPLE MTD</div>
          <div className={styles.peopleGrid}>
            <div>
              <div className={styles.peopleLabel}>BNY</div>
              <div className={styles.peopleValue}>
                {data.people.bny.headcount} active · {fmt(data.people.bny.hours)} hrs · {money(data.people.bny.pay)}
              </div>
            </div>
            <div>
              <div className={styles.peopleLabel}>Passaic</div>
              <div className={styles.peopleValue}>
                {data.people.nj.headcount} active · {fmt(data.people.nj.hours)} hrs · {money(data.people.nj.pay)}
              </div>
            </div>
            <div>
              <div className={styles.peopleLabel}>Combined</div>
              <div className={styles.peopleValue}>
                {data.people.combined.headcount} headcount · {money(data.people.combined.pay)} payroll MTD
              </div>
            </div>
          </div>
        </section>
      )}

      {/* WIP */}
      {data.wip && data.wip.available && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>WIP SNAPSHOT</div>
          <div className={styles.wipGrid}>
            <div>
              <div className={styles.peopleLabel}>Active orders</div>
              <div className={styles.peopleValue}>
                {data.wip.totalActive} · {fmt(data.wip.activeYards)} yds · {fmt(data.wip.activeColorYards)} color-yds
              </div>
            </div>
            <div>
              <div className={styles.peopleLabel}>Age</div>
              <div className={styles.peopleValue}>
                &lt;30d {data.wip.ageBuckets.lt30} · 30-60d {data.wip.ageBuckets.b30_60} ·
                60-90d {data.wip.ageBuckets.b60_90} · 90+d {data.wip.ageBuckets.gt90}
              </div>
            </div>
            {Object.keys(data.wip.byProductType).length > 0 && (
              <div>
                <div className={styles.peopleLabel}>By category</div>
                <div className={styles.peopleValue}>
                  {Object.entries(data.wip.byProductType)
                    .map(([k, v]) => `${k} ${v.count} (${fmt(v.yards)})`)
                    .join(' · ')}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Download CTA repeats at bottom for long previews */}
      <div className={styles.bottomActions}>
        <button className={styles.downloadBtn} onClick={onDownload}>
          Download PDF
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// Sub-components and helpers
// =============================================================================

function SiteCard({ title, accent, rows }) {
  return (
    <div className={`${styles.siteCard} ${styles['accent_' + accent]}`}>
      <div className={styles.siteCardTitle}>{title}</div>
      <div className={styles.siteCardRows}>
        {rows.map(([k, v, klass]) => (
          <div key={k} className={styles.siteCardRow}>
            <span className={styles.siteCardKey}>{k}</span>
            <span className={`${styles.siteCardVal} ${klass ? styles[klass] : ''}`}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const fmt   = n => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString()
const money = n => (n == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString()
const pct   = n => (n == null || isNaN(n)) ? '—' : n.toFixed(0) + '%'
const pct1  = n => (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'

function paceClass(p) {
  if (p == null) return ''
  if (p >= 95) return 'paceGreen'
  if (p >= 75) return 'paceAmber'
  return 'paceRed'
}
