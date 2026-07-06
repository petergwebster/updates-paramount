// ============================================================================
// MonthlyBriefs.jsx — Admin section for generating Mid-Month / End-of-Month
// briefs for FSCO leadership.
// ============================================================================
// Flow:
//   1) Pick month + phase, click Generate
//   2) Data gathers, Claude drafts, preview renders inline
//   3) Edit the executive summary in the editable textarea
//   4) Save Brief — writes to monthly_briefs table with data snapshot
//   5) Download PDF — uses current narrative state
//
// The History panel shows previously-saved briefs for the current
// (month, phase) — click any to load it back into the editor.
//
// Visual layout mirrors the April Mid-Month PDF reference exactly:
//   - Editorial header (PARAMOUNT PRINTS / period overline / serif title)
//   - Gold rule under EXECUTIVE SUMMARY
//   - Two-column production cards with stacked PRODUCED / INVOICED YDS / OPEX
//   - MTD tracking table with target shown ("76% of 17,220"), Revenue
//     MTD highlighted, COGS row showing "pending" before the 10th
//   - People one-liner: "Headcount: 49 total (13 BNY · 36 NJ)"
//   - WIP with em-dash placeholders when data missing
// ============================================================================

import { useState, useEffect, useMemo, useCallback } from 'react'
import { format, subMonths, startOfMonth } from 'date-fns'
import {
  gatherMonthlyBriefData,
  saveMonthlyBrief,
  listSavedBriefs,
  loadSavedBrief,
} from '../lib/monthlyBriefData'
import { buildMonthlyBriefPrompt } from '../lib/monthlyBriefNarrative'
import { generateMonthlyBriefPdf } from '../lib/monthlyBriefPdf'
import styles from './MonthlyBriefs.module.css'

// 12 most recent months as picker options (current month first)
function buildMonthOptions(anchor = new Date()) {
  const opts = []
  for (let i = 0; i < 12; i++) {
    const d = subMonths(startOfMonth(anchor), i)
    opts.push({ key: format(d, 'yyyy-MM'), label: format(d, 'MMMM yyyy') })
  }
  return opts
}

export default function MonthlyBriefs({ weekStart, authUser }) {
  const monthOptions = useMemo(() => buildMonthOptions(), [])
  const defaultMonthKey = useMemo(() => {
    const anchor = weekStart instanceof Date ? weekStart : new Date()
    return format(startOfMonth(anchor), 'yyyy-MM')
  }, [weekStart])

  const [monthKey, setMonthKey] = useState(defaultMonthKey)
  // True once the user manually picks a month from the dropdown. Until then,
  // each phase button targets its natural month on generate (End = last closed
  // month, Mid = the month in progress).
  const [userPickedMonth, setUserPickedMonth] = useState(false)
  const [phase, setPhase] = useState(null)
  const [stage, setStage] = useState('idle')          // idle | gathering | drafting | ready | error | saving
  const [error, setError] = useState(null)
  const [briefData, setBriefData] = useState(null)
  const [narrative, setNarrative] = useState('')
  const [pdfFilename, setPdfFilename] = useState(null)

  // Save state
  const [savedHistory, setSavedHistory] = useState([])
  const [loadedFromId, setLoadedFromId] = useState(null)
  const [unsavedChanges, setUnsavedChanges] = useState(false)
  const [lastSaveAt, setLastSaveAt] = useState(null)

  const monthLabel = monthOptions.find(m => m.key === monthKey)?.label || monthKey

  // Refresh saved history whenever month or phase changes
  const refreshHistory = useCallback(async () => {
    if (!phase) {
      setSavedHistory([])
      return
    }
    const rows = await listSavedBriefs({ monthKey, phase })
    setSavedHistory(rows)
  }, [monthKey, phase])

  useEffect(() => { refreshHistory() }, [refreshHistory])

  // Mark narrative changes as unsaved (after initial load)
  useEffect(() => {
    if (stage === 'ready' && narrative) setUnsavedChanges(true)
  }, [narrative]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Generate flow ─────────────────────────────────────────────────────
  async function generate(selectedPhase) {
    setError(null)
    setBriefData(null)
    setNarrative('')
    setLoadedFromId(null)
    setLastSaveAt(null)
    setUnsavedChanges(false)
    setPhase(selectedPhase)
    setStage('gathering')

    // Unless the user hand-picked a month, target the natural one for the phase:
    // End-of-Month = last CLOSED month (previous); Mid-Month = the month in
    // progress (current). Stops an early-in-the-month End-of-Month click from
    // silently building an empty current month (the July-vs-June mixup).
    const effectiveMonthKey = userPickedMonth
      ? monthKey
      : format(
          selectedPhase === 'end'
            ? subMonths(startOfMonth(new Date()), 1)
            : startOfMonth(new Date()),
          'yyyy-MM',
        )
    if (effectiveMonthKey !== monthKey) setMonthKey(effectiveMonthKey)

    try {
      const data = await gatherMonthlyBriefData({ monthKey: effectiveMonthKey, phase: selectedPhase })
      setBriefData(data)
      setStage('drafting')

      const prompt = buildMonthlyBriefPrompt({ data })
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!response.ok) throw new Error(`Claude API returned ${response.status}`)

      const result = await response.json()
      const text = result.content?.find(c => c.type === 'text')?.text?.trim()
      if (!text) throw new Error('Claude returned no narrative text')

      setNarrative(text)
      // Allow the unsaved-changes effect to flip from initial load
      setTimeout(() => setUnsavedChanges(false), 50)
      setStage('ready')
    } catch (e) {
      console.error('MonthlyBriefs.generate:', e)
      setError(e.message || 'Generation failed')
      setStage('error')
    }
  }

  // ── Save flow ─────────────────────────────────────────────────────────
  async function saveBrief() {
    if (!briefData || !narrative || !phase) return
    setStage('saving')
    try {
      const saved = await saveMonthlyBrief({
        monthKey,
        phase,
        narrative,
        dataSnapshot: briefData,
        authUser,
      })
      setLastSaveAt(saved.saved_at)
      setLoadedFromId(saved.id)
      setUnsavedChanges(false)
      setStage('ready')
      await refreshHistory()
    } catch (e) {
      console.error('MonthlyBriefs.saveBrief:', e)
      setError('Save failed: ' + (e.message || 'unknown'))
      setStage('ready')
    }
  }

  // ── Load saved brief ──────────────────────────────────────────────────
  async function loadSaved(id) {
    setError(null)
    setStage('gathering')
    try {
      const row = await loadSavedBrief(id)
      setBriefData(row.data_snapshot)
      setNarrative(row.narrative)
      setPhase(row.phase)
      setLoadedFromId(row.id)
      setLastSaveAt(row.saved_at)
      setUnsavedChanges(false)
      setStage('ready')
    } catch (e) {
      console.error('MonthlyBriefs.loadSaved:', e)
      setError('Load failed: ' + (e.message || 'unknown'))
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
    setLoadedFromId(null)
    setLastSaveAt(null)
    setUnsavedChanges(false)
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Monthly Briefs</h2>
        <p className={styles.subtitle}>
          Generate the Mid-Month or End-of-Month brief for FSCO leadership.
          Claude drafts the executive summary from the month's production,
          financial, people, and WIP data. Edit the narrative, save the version,
          and download the PDF — saved versions stay in history for reference.
        </p>
      </div>

      {/* Month picker + buttons */}
      <div className={styles.controls}>
        <label className={styles.monthLabel}>
          Month
          <select
            className={styles.monthSelect}
            value={monthKey}
            onChange={e => { setMonthKey(e.target.value); setUserPickedMonth(true); reset() }}
            disabled={stage === 'gathering' || stage === 'drafting' || stage === 'saving'}
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
            disabled={stage === 'gathering' || stage === 'drafting' || stage === 'saving'}
          >
            <div className={styles.btnLabel}>Mid-Month Brief</div>
            <div className={styles.btnSub}>Halftime · forward-looking</div>
          </button>

          <button
            className={`${styles.btn} ${styles.btnEnd} ${phase === 'end' && stage === 'ready' ? styles.btnActive : ''}`}
            onClick={() => generate('end')}
            disabled={stage === 'gathering' || stage === 'drafting' || stage === 'saving'}
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
          {loadedFromId ? `Loading saved brief…` : `Gathering ${monthLabel} data — production, financials, people, WIP…`}
        </div>
      )}
      {stage === 'drafting' && (
        <div className={styles.status}>
          <div className={styles.spinner} />
          Claude is drafting the executive summary…
        </div>
      )}
      {stage === 'saving' && (
        <div className={styles.status}>
          <div className={styles.spinner} />
          Saving brief…
        </div>
      )}
      {stage === 'error' && (
        <div className={styles.errorBanner}>
          <strong>Action failed.</strong> {error}
          <button className={styles.btnLink} onClick={reset}>Try again</button>
        </div>
      )}

      {/* Saved history list — visible whenever a phase is selected */}
      {phase && (
        <SavedHistoryList
          items={savedHistory}
          monthLabel={monthLabel}
          phase={phase}
          loadedFromId={loadedFromId}
          onLoad={loadSaved}
        />
      )}

      {/* Preview */}
      {(stage === 'ready' || stage === 'saving') && briefData && (
        <BriefPreview
          data={briefData}
          phase={phase}
          narrative={narrative}
          onNarrativeChange={setNarrative}
          onDownload={downloadPdf}
          onSave={saveBrief}
          pdfFilename={pdfFilename}
          unsavedChanges={unsavedChanges}
          lastSaveAt={lastSaveAt}
          isSaving={stage === 'saving'}
        />
      )}
    </div>
  )
}

// =============================================================================
// SavedHistoryList — shows previous saves for the current (month, phase)
// =============================================================================

function SavedHistoryList({ items, monthLabel, phase, loadedFromId, onLoad }) {
  const phaseLabel = phase === 'mid' ? 'Mid-Month' : 'End-of-Month'

  if (items.length === 0) {
    return (
      <div className={styles.historyEmpty}>
        <div className={styles.historyEmptyLabel}>SAVED VERSIONS</div>
        <div className={styles.historyEmptyText}>
          No saved versions yet for {monthLabel} {phaseLabel}. Generate a brief and click Save to create one.
        </div>
      </div>
    )
  }

  return (
    <div className={styles.historyPanel}>
      <div className={styles.historyHeader}>
        <span className={styles.historyLabel}>SAVED VERSIONS · {monthLabel} {phaseLabel}</span>
        <span className={styles.historyCount}>{items.length} {items.length === 1 ? 'version' : 'versions'}</span>
      </div>
      <ul className={styles.historyList}>
        {items.map(item => {
          const isLoaded = loadedFromId === item.id
          const ts = item.saved_at ? new Date(item.saved_at) : null
          return (
            <li
              key={item.id}
              className={`${styles.historyItem} ${isLoaded ? styles.historyItemActive : ''}`}
              onClick={() => onLoad(item.id)}
            >
              <div className={styles.historyTime}>
                {ts ? format(ts, 'MMM d, yyyy · h:mm a') : '—'}
                {isLoaded && <span className={styles.historyBadge}>VIEWING</span>}
              </div>
              <div className={styles.historyMeta}>
                {item.saved_by_email || 'unknown user'}
              </div>
              <div className={styles.historyPreview}>
                {item.narrative ? item.narrative.slice(0, 140).replace(/\s+/g, ' ').trim() + (item.narrative.length > 140 ? '…' : '') : ''}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// =============================================================================
// BriefPreview — mirrors PDF layout for in-app review/edit
// =============================================================================

function BriefPreview({
  data, phase, narrative, onNarrativeChange, onDownload, onSave,
  pdfFilename, unsavedChanges, lastSaveAt, isSaving,
}) {
  const phaseLabel = phase === 'mid' ? 'Mid-Month Brief' : 'End-of-Month Brief'
  const cogsAvail = data.financials.cogsAvailable

  const fByUnit = data.financials.byUnit || {}
  const njRev   = data.production.njRevenue || 0
  const bnyRev  = data.production.bnyRevenue || 0
  const njOpex  = fByUnit.nj?.opex || 0
  const bnyOpex = fByUnit.bny?.opex || 0
  const njCogs  = fByUnit.nj?.cogsTotal || 0
  const bnyCogs = fByUnit.bny?.cogsTotal || 0
  const njInvP  = fByUnit.nj?.invPurchases || 0
  const bnyInvP = fByUnit.bny?.invPurchases || 0

  // Operating revenue & total inflows for budget reconciliation
  const njOpRev    = data.production.njOperatingRevenue    || 0
  const bnyOpRev   = data.production.bnyOperatingRevenue   || 0
  const combOpRev  = data.production.combinedOperatingRevenue || 0
  const njInflows  = data.production.njTotalInflows        || 0
  const bnyInflows = data.production.bnyTotalInflows       || 0
  const combInflows = data.production.combinedTotalInflows || 0
  const combProc   = data.production.combinedProcurement   || 0

  const bnyTargetMtd = data.targets?.expectedBnyMtd || 0
  const njTargetMtd  = data.targets?.expectedNjMtd  || 0
  const combinedTargetMtd = bnyTargetMtd + njTargetMtd

  const njVsTargetText  = `${pct(data.production.njVsTargetPct)} of ${fmt(njTargetMtd)}`
  const bnyVsTargetText = `${pct(data.production.bnyVsTargetPct)} of ${fmt(bnyTargetMtd)}`
  const combVsTargetText = `${pct(data.production.combVsTargetPct)} of ${fmt(combinedTargetMtd)}`

  return (
    <div className={styles.preview}>
      {/* Editorial header bar */}
      <div className={styles.previewHeader}>
        <div>
          <div className={styles.previewCrumb}>PARAMOUNT PRINTS</div>
          <div className={styles.previewOverline}>{data.pacing.monthLabel.toUpperCase()}</div>
          <h3 className={styles.previewTitle}>{phaseLabel}</h3>
          <div className={styles.previewSubline}>
            {data.pacing.monthLabel}
            {phase === 'mid' ? ` · ${data.pacing.weeksElapsed}-week mark` : ' · period closed'}
            {data.pacing.fiscalQuarter ? ` · Fiscal ${data.pacing.fiscalQuarter}` : ''}
          </div>
        </div>
        <div className={styles.previewHeaderActions}>
          <div className={styles.savedStatus}>
            {isSaving ? 'Saving…' :
             unsavedChanges ? <span className={styles.unsaved}>Unsaved changes</span> :
             lastSaveAt ? <span className={styles.saved}>Saved {format(new Date(lastSaveAt), 'h:mm a')}</span> :
             <span className={styles.draft}>Draft</span>}
          </div>
          <button
            className={`${styles.saveBtn} ${unsavedChanges ? styles.saveBtnPending : ''}`}
            onClick={onSave}
            disabled={isSaving}
          >
            {isSaving ? 'Saving…' : 'Save Brief'}
          </button>
          <button className={styles.downloadBtn} onClick={onDownload}>
            Download PDF
          </button>
        </div>
      </div>

      {pdfFilename && (
        <div className={styles.success}>
          PDF generated: <code>{pdfFilename}</code>
        </div>
      )}

      {/* Hero KPI strip — at-a-glance summary above the narrative */}
      <div className={styles.kpiStrip}>
        <KpiCell
          label="PRODUCTION"
          main={`${fmt(data.production.combinedYards)}`}
          unit="yds"
          sub={`${pct(data.production.combVsTargetPct)} of pace`}
          subClass={paceClass(data.production.combVsTargetPct)}
        />
        <KpiCell
          label="OPERATING REVENUE"
          main={moneyForce(combOpRev)}
          sub={combProc > 0 ? `+ ${money(combProc)} pass-through` : 'no pass-through'}
          subItalic={combProc > 0}
        />
        <KpiCell
          label="OPEX MTD"
          main={moneyForce(data.financials.opex)}
          sub={data.financials.invPurchases > 0
            ? `+ ${money(data.financials.invPurchases)} inv purch`
            : 'no inv purch'}
        />
        <KpiCell
          label="HEADCOUNT"
          main={data.people?.combined?.headcount ? String(data.people.combined.headcount) : '—'}
          sub={data.people?.bny && data.people?.nj
            ? `${data.people.bny.headcount} BNY · ${data.people.nj.headcount} NJ`
            : '— BNY · — NJ'}
        />
      </div>

      {/* Executive Summary — gold rule + editable */}
      <section className={styles.section}>
        <div className={styles.sectionLabelEditorial}>EXECUTIVE SUMMARY</div>
        <div className={styles.goldRule} />
        <textarea
          className={styles.narrativeEditor}
          value={narrative}
          onChange={e => onNarrativeChange(e.target.value)}
          rows={Math.max(10, narrative.split('\n').length + 2)}
          spellCheck
        />
        <div className={styles.helperText}>
          Edit freely — Save Brief stores this version with a timestamp; Download PDF uses the current text.
        </div>
      </section>

      {/* Production — Month-to-Date (two-column with stacked blocks) */}
      <section className={styles.section}>
        <div className={styles.sectionLabelEditorial}>PRODUCTION — MONTH-TO-DATE</div>
        <div className={styles.thinRule} />

        <div className={styles.twoCol}>
          {/* BNY column */}
          <div className={styles.siteCol}>
            <div className={styles.siteTitle}>BNY — BROOKLYN DIGITAL</div>
            <ProdBlock
              label="PRODUCED"
              main={`${fmt(data.production.bnyYards)} yds`}
              sub={`${pct(data.production.bnyVsTargetPct)} of ${fmt(bnyTargetMtd)} target`}
              subClass={paceClass(data.production.bnyVsTargetPct)}
              paceBarPct={data.production.bnyVsTargetPct}
            />
            <ProdBlock
              label="INVOICED YDS"
              main={`${fmt(data.production.bnyInvoicedYds)} yds`}
              subLines={[
                {
                  text: data.production.bnyMiscRevenue > 0
                    ? `Revenue: ${moneyForce(bnyRev)}  ·  Misc: ${money(data.production.bnyMiscRevenue)}`
                    : `Revenue: ${moneyForce(bnyRev)}`,
                },
                data.production.bnyProcurement > 0 ? {
                  text: `Procurement: ${money(data.production.bnyProcurement)} (pass-through)`,
                  italic: true,
                } : null,
              ].filter(Boolean)}
            />
            <ProdBlock
              label="OPEX MTD"
              main={moneyForce(bnyOpex)}
              sub={cogsAvail
                ? `Inv Purchases: ${money(bnyInvP)}  ·  COGS: ${money(bnyCogs)}`
                : `Inv Purchases: ${money(bnyInvP)}`
              }
            />
          </div>

          {/* NJ column */}
          <div className={styles.siteCol}>
            <div className={styles.siteTitle}>NJ — PASSAIC SCREEN PRINT</div>
            <ProdBlock
              label="PRODUCED"
              main={`${fmt(data.production.njYards)} yds`}
              sub={`${pct(data.production.njVsTargetPct)} of ${fmt(njTargetMtd)} target`}
              subClass={paceClass(data.production.njVsTargetPct)}
              paceBarPct={data.production.njVsTargetPct}
            />
            <ProdBlock
              label="INVOICED YDS"
              main={`${fmt(data.production.njInvoicedYds)} yds`}
              subLines={[
                {
                  text: data.production.njMiscRevenue > 0
                    ? `Revenue: ${moneyForce(njRev)}  ·  Misc: ${money(data.production.njMiscRevenue)}`
                    : `Revenue: ${moneyForce(njRev)}`,
                },
                data.production.njProcurement > 0 ? {
                  text: `Procurement: ${money(data.production.njProcurement)} (pass-through)`,
                  italic: true,
                } : null,
              ].filter(Boolean)}
            />
            <ProdBlock
              label="OPEX MTD"
              main={moneyForce(njOpex)}
              sub={[
                data.production.njWastePct != null ? `Waste: ${pct1(data.production.njWastePct)}` : null,
                `Inv: ${money(njInvP)}`,
                cogsAvail && njCogs ? `COGS: ${money(njCogs)}` : null,
              ].filter(Boolean).join(' · ')}
            />
          </div>
        </div>
      </section>

      {/* Production summary — MTD tracking table */}
      <section className={styles.section}>
        <div className={styles.sectionLabelEditorial}>PRODUCTION SUMMARY — MTD TRACKING</div>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th className={styles.thLeft}>METRIC</th>
              <th>PARAMOUNT NJ</th>
              <th>BNY BROOKLYN</th>
              <th>COMBINED</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={styles.tdLabel}>Produced MTD</td>
              <td>{fmt(data.production.njYards)} yds</td>
              <td>{fmt(data.production.bnyYards)} yds</td>
              <td className={styles.tdBold}>{fmt(data.production.combinedYards)} yds</td>
            </tr>
            <tr className={styles.subtleRow}>
              <td className={styles.tdLabel}>vs Target</td>
              <td className={styles[paceClass(data.production.njVsTargetPct)]}>{njVsTargetText}</td>
              <td className={styles[paceClass(data.production.bnyVsTargetPct)]}>{bnyVsTargetText}</td>
              <td className={styles[paceClass(data.production.combVsTargetPct)]}>{combVsTargetText}</td>
            </tr>
            <tr>
              <td className={styles.tdLabel}>Invoiced YDS</td>
              <td>{fmt(data.production.njInvoicedYds)} yds</td>
              <td>{fmt(data.production.bnyInvoicedYds)} yds</td>
              <td className={styles.tdBold}>{fmt(data.production.combinedInvoicedYds)} yds</td>
            </tr>
            <tr className={styles.highlightRow}>
              <td className={`${styles.tdLabel} ${styles.tdBold}`}>Revenue MTD <span className={styles.subLabel}>(operating)</span></td>
              <td className={styles.tdBold}>{moneyForce(njOpRev)}</td>
              <td className={styles.tdBold}>{moneyForce(bnyOpRev)}</td>
              <td className={styles.tdBold}>{moneyForce(combOpRev)}</td>
            </tr>
            <tr className={styles.italicRow}>
              <td className={styles.tdLabel}>Procurement <span className={styles.subLabel}>(pass-through)</span></td>
              <td>{data.production.njProcurement > 0 ? money(data.production.njProcurement) : '—'}</td>
              <td>{data.production.bnyProcurement > 0 ? money(data.production.bnyProcurement) : '—'}</td>
              <td>{combProc > 0 ? money(combProc) : '—'}</td>
            </tr>
            <tr className={styles.totalRow}>
              <td className={`${styles.tdLabel} ${styles.tdBold}`}>Total Inflows <span className={styles.subLabel}>(vs budget)</span></td>
              <td className={styles.tdBold}>{moneyForce(njInflows)}</td>
              <td className={styles.tdBold}>{moneyForce(bnyInflows)}</td>
              <td className={styles.tdBold}>{moneyForce(combInflows)}</td>
            </tr>
            <tr>
              <td className={styles.tdLabel}>OpEx MTD</td>
              <td>{moneyForce(njOpex)}</td>
              <td>{moneyForce(bnyOpex)}</td>
              <td className={styles.tdBold}>{moneyForce(data.financials.opex)}</td>
            </tr>
            <tr className={cogsAvail ? '' : styles.pendingRow}>
              <td className={styles.tdLabel}>COGS MTD</td>
              <td>{cogsAvail ? money(njCogs) : 'pending'}</td>
              <td>{cogsAvail ? money(bnyCogs) : 'pending'}</td>
              <td className={cogsAvail ? styles.tdBold : ''}>{cogsAvail ? money(data.financials.cogsTotal) : 'pending'}</td>
            </tr>
            <tr className={styles.subtleRow}>
              <td className={styles.tdLabel}>NJ Waste %</td>
              <td>{pct1(data.production.njWastePct)}</td>
              <td>—</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
        {!cogsAvail && (
          <div className={styles.cogsNote}>
            COGS pending — {data.financials.cogsPendingNote}
          </div>
        )}
      </section>

      {/* People + WIP — two columns */}
      <section className={styles.section}>
        <div className={styles.twoCol}>
          <div>
            <div className={styles.sectionLabelEditorial}>PEOPLE</div>
            {data.people && data.people.bny ? (
              <>
                <div className={styles.peopleLine}>
                  Headcount: <strong>{data.people.combined.headcount} total</strong> ({data.people.bny.headcount} BNY · {data.people.nj.headcount} NJ)
                </div>
                {data.people.combined.pay > 0 && (
                  <div className={styles.peopleSubline}>
                    Payroll MTD: {money(data.people.combined.pay)} · BNY {money(data.people.bny.pay)} · NJ {money(data.people.nj.pay)}
                  </div>
                )}
              </>
            ) : (
              <div className={styles.peopleLineEmpty}>Headcount: — total (— BNY · — NJ)</div>
            )}
          </div>

          <div>
            <div className={styles.sectionLabelEditorial}>WIP SNAPSHOT</div>
            {data.wip && data.wip.available ? (
              <>
                <div className={styles.peopleLine}>
                  Active: <strong>{data.wip.totalActive} orders</strong> · {fmt(data.wip.activeYards)} yds
                </div>
                <div className={styles.peopleSubline}>
                  Age: 0-30d {data.wip.ageBuckets.lt30} · 31-60d {data.wip.ageBuckets.b30_60} · 61-90d {data.wip.ageBuckets.b60_90} · 90d+ {data.wip.ageBuckets.gt90}
                </div>
                {Object.keys(data.wip.byProductType).length > 0 && (
                  <div className={styles.peopleSubline}>
                    {Object.entries(data.wip.byProductType)
                      .map(([k, v]) => `${capitalize(k)} ${v.count}`)
                      .join(' · ')}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className={styles.peopleLineEmpty}>Active: — orders · — yds</div>
                <div className={styles.peopleSublineEmpty}>Age: 0-30d — · 31-60d — · 61-90d — · 90d+ —</div>
                <div className={styles.peopleSublineEmpty}>Wallpaper — · Grasscloth — · Fabric —</div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Bottom action row mirrors top */}
      <div className={styles.bottomActions}>
        <div className={styles.savedStatus}>
          {unsavedChanges
            ? <span className={styles.unsaved}>Unsaved changes</span>
            : lastSaveAt ? <span className={styles.saved}>Saved {format(new Date(lastSaveAt), 'MMM d, h:mm a')}</span> : null}
        </div>
        <button
          className={`${styles.saveBtn} ${unsavedChanges ? styles.saveBtnPending : ''}`}
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving ? 'Saving…' : 'Save Brief'}
        </button>
        <button className={styles.downloadBtn} onClick={onDownload}>
          Download PDF
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// Sub-components & helpers
// =============================================================================

function ProdBlock({ label, main, sub, subClass, subLines, paceBarPct }) {
  return (
    <div className={styles.prodBlock}>
      <div className={styles.prodBlockLabel}>{label}</div>
      <div className={styles.prodBlockMain}>{main}</div>
      {sub && (
        <div className={`${styles.prodBlockSub} ${subClass ? styles[subClass] : ''}`}>{sub}</div>
      )}
      {subLines && subLines.map((line, i) => (
        <div
          key={i}
          className={`${styles.prodBlockSub} ${line.italic ? styles.prodBlockSubItalic : ''}`}
        >
          {line.text}
        </div>
      ))}
      {paceBarPct != null && (
        <div className={styles.paceBarTrack}>
          <div
            className={`${styles.paceBarFill} ${styles[paceClass(paceBarPct)]}`}
            style={{ width: `${Math.min(100, Math.max(2, paceBarPct))}%` }}
          />
          <div className={styles.paceBarTargetTick} />
        </div>
      )}
    </div>
  )
}

function KpiCell({ label, main, unit, sub, subClass, subItalic }) {
  return (
    <div className={styles.kpiCell}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiMain}>
        {main}
        {unit && <span className={styles.kpiUnit}>{unit}</span>}
      </div>
      <div className={`${styles.kpiSub} ${subClass ? styles[subClass] : ''} ${subItalic ? styles.kpiSubItalic : ''}`}>
        {sub}
      </div>
    </div>
  )
}

const fmt        = n => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString()
const money      = n => (n == null || isNaN(n) || n === 0) ? '—' : '$' + Math.round(n).toLocaleString()
const moneyForce = n => (n == null || isNaN(n)) ? '$0' : '$' + Math.round(n).toLocaleString()
const pct        = n => (n == null || isNaN(n)) ? '—' : Math.round(n) + '%'
const pct1       = n => (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'

function paceClass(p) {
  if (p == null) return ''
  if (p >= 95) return 'paceGreen'
  if (p >= 75) return 'paceAmber'
  return 'paceRed'
}

function capitalize(s) {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}
