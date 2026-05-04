// ============================================================================
// monthlyBriefNarrative.js — Prompt template for the Monthly Brief.
// ============================================================================
// Two phases share one prompt builder. The phase parameter changes the
// framing — same data, different stance:
//
//   phase: 'mid' — halftime check. Forward-looking. "Are we tracking?
//                  what to watch in the back half?" Confidence + concern.
//
//   phase: 'end' — book closing. Reflective. "Here's what landed, what
//                  didn't, what carries into next month." Hindsight stance.
//
// ── Output structure (per Peter, May 4 2026) ───────────────────────────
//   Para 1: Brief overall picture (1-2 sentences). The headline.
//   Para 2: BNY (3-4 sentences) — yards produced, invoiced/shipped,
//           revenue, machine notes if relevant, capacity.
//   Para 3: NJ (3-4 sentences) — yards, color-yards, waste, mixing,
//           categories where relevant.
//   Para 4: Cost / financial picture — opex vs budget pace, inventory
//           purchases, AP/AR/cash signals. COGS pending guidance.
//   Para 5 (end-of-month only, optional): WIP carrying into next month
//           and 1-2 watch items.
//
// Audience is FSCO leadership (Timur, Antonella, Emily, Abigail) plus
// Peter and Brynn. Same audience as weekly recap, monthly cadence, more
// reflective register.
// ============================================================================

import { format } from 'date-fns'

// ---------------------------------------------------------------------------
// Format the brief data into a clean context block for Claude
// ---------------------------------------------------------------------------

function formatBriefContext(data) {
  const { pacing, targets, production: p, financials: f, ap, ar, cash, people, wip } = data
  const lines = []

  // Header
  lines.push(`## ${pacing.monthLabel} — ${pacing.phase === 'mid' ? 'Mid-Month' : 'End-of-Month'} snapshot`)
  lines.push(`Today: ${format(new Date(), 'EEEE, MMMM d, yyyy')}`)
  lines.push(`Phase: ${pacing.phase === 'mid' ? 'mid-month (still in flight)' : 'end of month (period closed)'}`)
  lines.push(`Calendar: ${pacing.daysElapsed}/${pacing.daysInMonth} days elapsed (${pacing.pctMonthElapsed}% of month)`)
  lines.push(`Fiscal: ${pacing.fiscalQuarter || 'unknown'} · ${pacing.weeksInMonth}-week month · ${pacing.weeksElapsed} weeks of data`)
  lines.push('')

  // Production — by site, then combined
  lines.push('## BNY (Brooklyn digital)')
  lines.push(`Produced: ${fmt(p.bnyYards)} yards (${pct(p.bnyVsTargetPct)} of expected MTD pace, target ${fmt(targets.expectedBnyMtd)} of monthly ${fmt(targets.monthBnyTarget)})`)
  lines.push(`Invoiced/Shipped: ${fmt(p.bnyInvoicedYds)} yards`)
  lines.push(`Operating revenue: ${money(p.bnyRevenue)}${p.bnyMiscRevenue ? ` (+${money(p.bnyMiscRevenue)} misc fees → ${money(p.bnyOperatingRevenue)} operating total)` : ''}`)
  if (p.bnyProcurement) {
    lines.push(`Procurement (PASS-THROUGH, not operating revenue): ${money(p.bnyProcurement)}`)
    lines.push(`Total inflows BNY (for budget reconciliation): ${money(p.bnyTotalInflows)}`)
  }
  if (Object.keys(p.weekRows[0]?.bnyByBucket || {}).length) {
    const buckets = {}
    for (const w of p.weekRows) {
      for (const [b, v] of Object.entries(w.bnyByBucket || {})) {
        if (!buckets[b]) buckets[b] = { yards: 0, revenue: 0 }
        buckets[b].yards += v.yards
        buckets[b].revenue += v.revenue
      }
    }
    lines.push(`By bucket: ${Object.entries(buckets).map(([k, v]) => `${k} ${fmt(v.yards)} yds / ${money(v.revenue)}`).join(' · ')}`)
  }
  lines.push('')

  lines.push('## NJ (Passaic hand-screen)')
  lines.push(`Produced: ${fmt(p.njYards)} yards (${pct(p.njVsTargetPct)} of expected MTD pace, target ${fmt(targets.expectedNjMtd)} of monthly ${fmt(targets.monthNjTarget)})`)
  lines.push(`Color-yards: ${fmt(p.njColorYards)} (the labor unit — 1 color-yard = 1 yard × 1 color)`)
  lines.push(`Waste: ${fmt(p.njWaste)} yards (${p.njWastePct != null ? p.njWastePct.toFixed(1) + '% waste rate' : 'rate unavailable'})`)
  lines.push(`Invoiced/Shipped: ${fmt(p.njInvoicedYds)} yards`)
  lines.push(`Operating revenue: ${money(p.njRevenue)}${p.njMiscRevenue ? ` (+${money(p.njMiscRevenue)} misc fees → ${money(p.njOperatingRevenue)} operating total)` : ''}`)
  if (p.njProcurement) {
    lines.push(`Procurement (PASS-THROUGH, not operating revenue): ${money(p.njProcurement)}`)
  }

  if (p.weekRows.length) {
    const catTotals = { fabric: 0, grass: 0, paper: 0 }
    const catWaste  = { fabric: 0, grass: 0, paper: 0 }
    const catColorYds = { fabric: 0, grass: 0, paper: 0 }
    for (const w of p.weekRows) {
      for (const [c, v] of Object.entries(w.njByCategory || {})) {
        catTotals[c]    = (catTotals[c]    || 0) + (v.yards || 0)
        catWaste[c]     = (catWaste[c]     || 0) + (v.waste || 0)
        catColorYds[c]  = (catColorYds[c]  || 0) + (v.colorYards || 0)
      }
    }
    if (Object.values(catTotals).some(v => v > 0)) {
      const cats = Object.entries(catTotals)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} ${fmt(v)} yds (${fmt(catColorYds[k])} cy, ${fmt(catWaste[k])} waste)`)
        .join(' · ')
      lines.push(`By category: ${cats}`)
    }
  }
  lines.push('')

  lines.push('## Combined')
  lines.push(`Produced: ${fmt(p.combinedYards)} of ${fmt(targets.expectedCombMtd)} expected (${pct(p.combVsTargetPct)} of pace, monthly target ${fmt(targets.monthCombinedTarget)})`)
  lines.push(`Invoiced/Shipped: ${fmt(p.combinedInvoicedYds)} yards`)
  lines.push(`Operating revenue: ${money(p.combinedOperatingRevenue)}  (revenue ${money(p.combinedRevenue)} + misc ${money(p.combinedMiscRevenue)})`)
  if (p.combinedProcurement) {
    lines.push(`Procurement (PASS-THROUGH): ${money(p.combinedProcurement)}`)
    lines.push(`Total inflows for budget reconciliation: ${money(p.combinedTotalInflows)}`)
  }
  lines.push('')

  if (p.weekRows.length) {
    lines.push('Week-by-week:')
    for (const w of p.weekRows) {
      lines.push(`  ${w.weekLabel} (${w.weekStart}): BNY ${fmt(w.bnyYards)} yds / ${money(w.bnyRevenue)} · Passaic ${fmt(w.njYards)} yds / ${fmt(w.njColorYards)} cy / ${fmt(w.njWaste)} waste / ${money(w.njRevenue)}`)
    }
    lines.push('')
  }

  // Financials — operating cost story
  lines.push('## Cost / financial picture')
  lines.push(`OpEx total: ${money(f.opex)}  ·  by unit:  NJ ${money(f.byUnit?.nj?.opex)}  ·  BNY ${money(f.byUnit?.bny?.opex)}  ·  Shared ${money(f.byUnit?.shared?.opex)}`)
  lines.push(`Inventory purchases total: ${money(f.invPurchases)}  ·  NJ ${money(f.byUnit?.nj?.invPurchases)}  ·  BNY ${money(f.byUnit?.bny?.invPurchases)}  ·  Shared ${money(f.byUnit?.shared?.invPurchases)}`)
  if (f.cogsAvailable) {
    lines.push(`COGS total: ${money(f.cogsTotal)} (Material ${money(f.cogsMaterial)}, Labor ${money(f.cogsLabor)}, Other ${money(f.cogsOther)})`)
  } else {
    lines.push(`COGS: PENDING — ${f.cogsPendingNote}`)
  }
  lines.push('')

  if (ap || ar || cash) {
    lines.push('## Working capital')
    if (ap) lines.push(`AP (${ap.period}): ${money(ap.total)} total · ${money(ap.pastDue)} past due · ${money(ap.current)} current`)
    if (ar) lines.push(`AR (${ar.period}): ${money(ar.totalOutstanding)} outstanding · ${money(ar.aging91Plus)} over 90 days`)
    if (cash && cash.total != null) lines.push(`Cash (${cash.period}): ${money(cash.total)}`)
    lines.push('')
  }

  // People
  if (people && people.bny) {
    lines.push('## People MTD')
    lines.push(`BNY: ${people.bny.headcount} active · ${fmt(people.bny.hours)} hours · ${money(people.bny.pay)} payroll · ${people.bny.otPct != null ? people.bny.otPct.toFixed(1) + '% OT' : 'no OT data'}`)
    lines.push(`Passaic: ${people.nj.headcount} active · ${fmt(people.nj.hours)} hours · ${money(people.nj.pay)} payroll · ${people.nj.otPct != null ? people.nj.otPct.toFixed(1) + '% OT' : 'no OT data'}`)
    lines.push(`Combined headcount: ${people.combined.headcount} · combined payroll MTD ${money(people.combined.pay)}`)
    lines.push('')
  }

  // WIP
  if (wip && wip.available) {
    lines.push('## WIP (current snapshot)')
    lines.push(`Active orders: ${wip.totalActive} · ${fmt(wip.activeYards)} yards · ${fmt(wip.activeColorYards)} color-yards`)
    lines.push(`Age buckets: <30d ${wip.ageBuckets.lt30} · 30-60d ${wip.ageBuckets.b30_60} · 60-90d ${wip.ageBuckets.b60_90} · 90+d ${wip.ageBuckets.gt90}`)
    if (Object.keys(wip.byProductType).length) {
      lines.push('By category: ' + Object.entries(wip.byProductType).map(([k, v]) => `${k} ${v.count} orders / ${fmt(v.yards)} yds`).join(' · '))
    }
    if (Object.keys(wip.bySite).length) {
      lines.push('By site: ' + Object.entries(wip.bySite).map(([k, v]) => `${k} ${v.count} orders / ${fmt(v.yards)} yds`).join(' · '))
    }
    lines.push(`NEW Goods active: ${wip.newGoodsActive}`)
    lines.push('')
  }

  return lines.join('\n')
}

function fmt(n)   { return (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString() }
function money(n) { return (n == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString() }
function pct(n)   { return (n == null || isNaN(n)) ? '—' : n.toFixed(0) + '%' }

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

export function buildMonthlyBriefPrompt({ data }) {
  const phase = data.pacing.phase
  const monthLabel = data.pacing.monthLabel
  const contextString = formatBriefContext(data)

  // Detect data sufficiency so Claude doesn't fabricate when production is empty
  const hasProduction = data.production.combinedYards > 0
  const hasRevenue = data.production.combinedRevenue > 0
  const hasFinancials = data.financials.opex > 0 || data.financials.invPurchases > 0

  const phaseFraming = phase === 'mid'
    ? `This is a **mid-month** brief. The month is still in flight. Audience is FSCO \
leadership reading at the halftime mark — they want a confident read of where we \
sit, an honest call on whether we're on track to land the month, and a short list \
of what to watch in the back half. Tone: confident but not premature. Don't \
declare victory or defeat — name the trajectory. Verbs are present-tense ("we're \
tracking"), forward-looking where appropriate.`
    : `This is an **end-of-month** brief. The month has closed. Audience is FSCO \
leadership reading on the first or second working day of the new month — they \
want a clean retrospective: what landed, what didn't, what it means for the next \
period. Tone: reflective, evidence-based. Verbs are past-tense ("April closed"), \
with a short forward-look in the closing.`

  const cogsGuidance = data.financials.cogsAvailable
    ? `COGS is available — discuss it directly. Reference gross profit and margin \
where relevant.`
    : `**COGS is NOT available yet.** Finance does not release COGS until after \
the 10th of the following month. Do NOT speculate about gross profit, margin, or \
profitability. Discuss revenue against budget pace, and OpEx against budget pace. \
If tempted to read the month's profitability, plainly state that COGS is pending \
and the picture is incomplete on that dimension. Move on. Do not invent numbers.`

  // Build a data-completeness block so Claude doesn't read missing data as zero
  const completenessNotes = []
  if (!hasProduction) {
    completenessNotes.push(`PRODUCTION DATA APPEARS EMPTY. Production has not been filled in for this month. \
Do NOT write a narrative claiming we produced zero yards. Note that production data entry is incomplete and \
that what IS visible (financials, people, WIP) suggests an active operation. Recommend the team finish their \
entries before the next read.`)
  }
  if (!hasRevenue && hasProduction) {
    completenessNotes.push(`REVENUE IS ZERO despite production showing yards. The invoiced-yards / income-by-bucket \
fields weren't filled in. Note this as a data-entry gap, not as an actual zero-revenue month.`)
  }
  if (!hasFinancials) {
    completenessNotes.push(`FINANCIALS APPEAR EMPTY for this month. The GP report may not be uploaded yet. \
Note this gap rather than treating zero OpEx as truth.`)
  }
  const completenessBlock = completenessNotes.length
    ? '\n## Data completeness — read carefully before writing\n\n' + completenessNotes.join('\n\n')
    : ''

  const phaseStructure = phase === 'mid' ? `
## Structure — mid-month, ~250-350 words total

**Paragraph 1 — Headline (1-2 sentences):**
Open with the cleanest read of where we sit at halftime. Lead with the combined pace number \
and the dominant driver in one sentence. Match the model: "We're tracking 113% to target MTD \
with 46,577 yards combined, driven entirely by Brooklyn's monster performance while Passaic \
continues to drag." Two sentences max.

**Paragraph 2 — BNY (3-4 sentences):**
What's happening at Brooklyn. Yards produced and what % to target. Yards invoiced / shipped \
and revenue. One observation about machine utilization, capacity, mix shifts, or noteworthy \
buckets. If inventory purchases are notable, mention them here.

**Paragraph 3 — NJ (3-4 sentences):**
What's happening at Passaic. Yards, color-yards, and what % to target. Waste% and what it \
implies. Yards invoiced and revenue. One observation about category mix, mixing queue, \
ready-to-print, or staffing if relevant.

**Paragraph 4 — Cost / financial picture (3-4 sentences):**
OpEx vs pace. Inventory purchases. AP / AR / cash signals if material. Apply the COGS \
pending guidance — if pending, say so plainly and don't speculate about margin.
`.trim() : `
## Structure — end-of-month, ~300-400 words total

**Paragraph 1 — Headline (1-2 sentences):**
Open with the cleanest read of how the month landed. Lead with the combined number and the \
dominant story. If revenue landed materially over or under, name it.

**Paragraph 2 — BNY (3-4 sentences):**
What happened at Brooklyn. Yards produced and final % to target. Yards invoiced / shipped \
and revenue. One observation about machine utilization, capacity, or mix shifts.

**Paragraph 3 — NJ (3-4 sentences):**
What happened at Passaic. Yards, color-yards, and final % to target. Waste% and what it \
implies. Yards invoiced and revenue. One observation about category mix, mixing queue, or \
staffing.

**Paragraph 4 — Cost / financial picture (3-4 sentences):**
OpEx vs budget pace. Inventory purchases. AP / AR / cash signals. Apply the COGS pending \
guidance — if pending, say so plainly. Do not speculate about margin.

**Paragraph 5 — WIP and what's carrying forward (2-3 sentences):**
Active orders carrying into next month. Notable age-bucket signals. NEW Goods activity. \
One short forward-look item.
`.trim()

  return `You are an internal analyst at Paramount Prints writing the **${monthLabel} ${phase === 'mid' ? 'Mid-Month' : 'End-of-Month'} Brief** for FSCO leadership. \
Audience: Timur Yumusaklar (CEO), Antonella Pilo, Emily Huber, Abigail Pratt, \
Kim Carrera — plus Peter Webster (President) and the Paramount ops team.

${phaseFraming}

This brief gets distributed as a PDF and quoted in conversations with the \
broader FSCO team. It should read like a sharp internal monthly memo — the \
kind a competent COO writes summarizing the period.

---

${contextString}
---

## Critical guidance

${cogsGuidance}

**Procurement revenue is a PASS-THROUGH, not operating revenue.** When BNY (or \
NJ) shows procurement, it means Paramount executed a purchase on FSCO's behalf \
— FSCO sells to the end customer, Paramount takes no margin. Discuss procurement \
SEPARATELY from operating revenue. Never lump procurement with "miscellaneous \
income" or operating revenue. Misc fees are operating; procurement is not. \
Three distinct things:
  - Operating revenue = invoice revenue + misc fees (drives margin)
  - Procurement = pass-through (does NOT drive margin, but is real cash flowing)
  - Total inflows = operating + procurement (reconciles to top-line budget)

In the cost paragraph, name the operating revenue figure first, then call out \
procurement as a separate pass-through line, then note the total inflows for \
budget reconciliation if procurement is meaningful (>$10k).

Honor the BNY/Passaic accounting convention: when Passaic ran digital work, \
BNY gets the revenue and production credit. Don't misattribute Passaic-run \
digital work to Passaic.

Frame everything in yards, color-yards, dollars, or WIP — the operational \
metrics that matter. Use "Paramount" or "we" — not "the company."

Be direct. Avoid hedge words ("appears," "going forward"). Avoid filler ("as \
expected," "best in class"). Avoid corporate boilerplate.

If a section has nothing notable, write one short sentence and move on. Do not \
manufacture significance.

**REALITY CHECK on numbers.** Sanity-check every figure before writing. \
Paramount produces on the order of thousands of yards per week, not millions \
or billions. Monthly revenue is on the order of hundreds of thousands to low \
millions. If any number looks like trillions, sextillions, or other absurdly \
large values, it is a data-entry or pipeline bug, not real production. \
Surface as a data-entry concern — never report extraordinary volumes as real.${completenessBlock}

${phaseStructure}

## Output format

- Prose only. No bullets, no headers, no title line.
- Specific numbers throughout, drawn from the data block above.
- Numbers must come from the data above. Do not invent.
- Begin with your first sentence. No preamble. No "Here is the brief" framing.
- No closing valediction or sign-off.
- Use single blank lines between paragraphs.

Begin now.`
}
