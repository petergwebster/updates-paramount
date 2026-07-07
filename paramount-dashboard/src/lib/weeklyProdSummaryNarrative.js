// ============================================================================
// weeklyProdSummaryNarrative.js — builds the Claude prompt for the weekly
// production summary. Order enforces Peter's priorities: DATA INTEGRITY first
// (the picture is only as good as the recording), then production-vs-plan by
// table/machine, then waste (where + why), then lost capacity.
// ============================================================================

const fmt  = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString()
const pct  = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n) + '%'
const pct1 = (n) => (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'

const siteLabel = (s) => (s === 'bny' ? 'BNY (Brooklyn digital)' : 'Passaic (hand-screen)')

// ── Context block — lays the week's numbers out for Claude ──────────────────
export function formatWeeklyProdContext(data) {
  const { integrity, bySite, combined, byProduct, wasteByProduct, notesByCategory, lostCapacity, attribution, units } = data
  const L = []

  L.push(`# Week of ${data.weekStart}`)
  L.push('')

  // 1) Data integrity
  L.push('## Data integrity (recording completeness)')
  L.push(`Completed work days so far: ${integrity.elapsedDays.length ? integrity.elapsedDays.join(', ') : 'none yet (week just started)'}.`)
  L.push(`Recording coverage: ${integrity.recordedCells} of ${integrity.plannedCells} planned table/machine-days recorded on completed days (${pct(integrity.coveragePct)}).`)
  if (integrity.notRecorded.length > 0) {
    L.push(`NOT RECORDED — planned but no end-of-shift entry (${integrity.notRecorded.length}):`)
    for (const nr of integrity.notRecorded) {
      L.push(`  - ${siteLabel(nr.site)} · ${nr.unitCode} (${nr.product}) · ${nr.dayLabel} · planned ${fmt(nr.planned)} yds · crew ${nr.operators.length ? nr.operators.join(' / ') : '—'}`)
    }
  } else {
    L.push('NOT RECORDED: none — every planned unit was closed out on completed days.')
  }
  if (attribution.coveragePct != null) {
    L.push(`PO-tagging: ${pct(attribution.coveragePct)} of produced yards are on lines tied to a scheduled PO; the remainder are "Other/unplanned" and cannot be attributed to product or color-yards.`)
  }
  L.push('')

  // 2) Production vs plan + reconciliation
  L.push('## Production vs plan (daily plan is the driver)')
  for (const site of ['passaic', 'bny']) {
    const s = bySite[site]
    L.push(`${siteLabel(site)}: actual ${fmt(s.actualYards)} vs planned ${fmt(s.plannedYards)} yds (${pct(s.attainmentPct)} attainment); waste ${fmt(s.wasteYards)} (${pct1(s.wastePct)}).`)
    if (site === 'passaic' && s.scheduledColorYards) {
      L.push(`  Color-yards (hand-screen labor unit): actual ${fmt(s.colorYards)} vs scheduled ${fmt(s.scheduledColorYards)} (${pct(s.colorAttainmentPct)}).`)
    }
    const r = s.reconciliation
    if (r.weeklyGoal > 0) {
      L.push(`  Reconciliation: daily plans sum to ${fmt(r.dailyPlanSum)} vs the weekly goal of ${fmt(r.weeklyGoal)} — ${r.tiesOut ? 'ties out.' : `off by ${fmt(r.deltaYards)} yds, i.e. daily planning is incomplete for this site.`}`)
    }
  }
  L.push(`Combined: actual ${fmt(combined.actualYards)} vs planned ${fmt(combined.plannedYards)} yds (${pct(combined.attainmentPct)}).`)
  L.push('')

  // Per-unit scorecard, worst attainment first
  const planned = units.filter(u => u.plannedYards > 0).sort((a, b) => (a.attainmentPct ?? 9999) - (b.attainmentPct ?? 9999))
  if (planned.length) {
    L.push('## Table/machine scorecard (worst attainment first)')
    for (const u of planned.slice(0, 15)) {
      L.push(`  - ${u.unitCode} (${siteLabel(u.site)}, ${u.product}): ${fmt(u.actualYards)} / ${fmt(u.plannedYards)} yds = ${pct(u.attainmentPct)}${u.missingDays.length ? ` · not recorded: ${u.missingDays.join('/')}` : ''}`)
    }
    L.push('')
  }

  // By product
  if (byProduct.length) {
    L.push('## By product category (Passaic substrates)')
    for (const p of byProduct) {
      L.push(`  - ${p.product}: ${fmt(p.actualYards)} / ${fmt(p.plannedYards)} yds (${pct(p.attainmentPct)}); waste ${fmt(p.wasteYards)} (${pct1(p.wastePct)})`)
    }
    L.push('')
  }

  // 3) Waste — where + why
  L.push('## Waste — where and why')
  const anyWaste = wasteByProduct.some(w => w.wasteYards > 0)
  if (anyWaste) {
    L.push('Where (by product category):')
    for (const w of wasteByProduct.filter(w => w.wasteYards > 0)) {
      L.push(`  - ${w.product}: ${fmt(w.wasteYards)} yds (${pct1(w.wastePct)} of run)`)
    }
  } else {
    L.push('Where: no waste recorded this week.')
  }
  L.push('Why (note cause-categories, ranked by how often they came up):')
  if (notesByCategory.length) {
    for (const c of notesByCategory) {
      L.push(`  - ${c.category}: ${c.count} note${c.count === 1 ? '' : 's'}`)
      for (const n of c.notes.slice(0, 4)) L.push(`      · ${n.unitCode}/${n.day}: ${n.text}`)
    }
  } else {
    L.push('  - no categorized notes recorded this week.')
  }
  L.push('')

  // 4) Lost capacity
  if (lostCapacity.length) {
    L.push('## Lost capacity (planned − actual; yards short, NOT measured hours)')
    for (const lc of lostCapacity.slice(0, 10)) {
      const notes = lc.interruptionNotes.length ? ` · interruptions logged: ${lc.interruptionNotes.map(n => n.text).join('; ')}` : ''
      L.push(`  - ${lc.unitCode} (${lc.product}): ${fmt(lc.shortfallYards)} yds short (${fmt(lc.actualYards)}/${fmt(lc.plannedYards)}, ${pct(lc.attainmentPct)})${notes}`)
    }
    L.push('')
  }

  return L.join('\n')
}

// ── Prompt ──────────────────────────────────────────────────────────────────
export function buildWeeklyProdPrompt({ data }) {
  const context = formatWeeklyProdContext(data)
  const cov = data.integrity.coveragePct
  const lowCoverage = cov != null && cov < 80

  return `You are writing the weekly PRODUCTION SUMMARY for Peter Webster, President of Paramount Prints (F. Schumacher's in-house print manufacturing: Passaic, NJ hand-screen TABLES and Brooklyn Navy Yard digital MACHINES, ~60 people). This is an internal operations read for Peter's Monday-morning review and his follow-ups with the team — not a polished leadership brief. Be direct, factual, and specific. Peter prefers honesty about data gaps over false precision.

Here is the week's data:

${context}

Write the summary in this order:

1. DATA INTEGRITY FIRST. ${lowCoverage
  ? `Recording coverage is ${pct(cov)} — this is LOW. Open by stating plainly that the picture is incomplete and everything below is provisional until the missing entries are recorded. Name the specific tables/machines, days, and crews that were not recorded, so Peter can follow up on specifics rather than generalizations. This is the most important section — do not soften it.`
  : `Recording coverage is ${pct(cov)}. Note it briefly, and if any specific units/days were not recorded, name them (with crew) so Peter can follow up.`}

2. PRODUCTION VS PLAN. How each site did against the daily plan (the driver), naming the worst-attainment tables/machines. Where daily plans don't sum to the weekly goal, flag it as a scheduling-completeness gap (planning wasn't done at the day level), NOT a production miss — these are different failures.

3. WASTE — where and why. Which product category carries the most waste (where), connected to the note cause-categories (why). State which of the five cause-categories is coming up most.

4. LOST CAPACITY. The biggest planned-minus-actual shortfalls, paired with any workflow-interruption notes. Be explicit that this is yards short, not measured downtime hours (Live Ops does not yet track time).

Rules:
- Passaic units are "tables"; BNY units are "machines." Never mix them up.
- Use the specific names and numbers from the data above. Invent nothing.
- If a section has no data (e.g., no waste recorded), say so in one line and move on.
- Prose, not bullet lists — except when listing the not-recorded units, where a short list is fine.
- Roughly 250–400 words. No title line. Start directly with the integrity read.`
}
