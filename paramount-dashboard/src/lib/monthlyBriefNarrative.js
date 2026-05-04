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
// The brief audience is FSCO leadership: Timur, Antonella, Emily, Abigail
// (plus Peter and Brynn). It's the SAME audience as weekly recap but
// monthly cadence and a more reflective register. Should read like a
// COO's monthly note — sharp, evidence-based, no filler.
//
// Keep voice consistent with the weeklyRecapNarrative voice — these
// briefs are more polished/durable than the live Heartbeat read.
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

  // Production
  lines.push('## Production MTD')
  lines.push(`BNY (digital): ${fmt(p.bnyYards)} yards produced · target ${fmt(targets.expectedBnyMtd)} · ${pct(p.bnyVsTargetPct)} of pace`)
  lines.push(`Passaic (NJ hand-screen): ${fmt(p.njYards)} yards · ${fmt(p.njColorYards)} color-yards · target ${fmt(targets.expectedNjMtd)} · ${pct(p.njVsTargetPct)} of pace`)
  lines.push(`  Waste: ${fmt(p.njWaste)} yards (${p.njWastePct != null ? p.njWastePct.toFixed(1) + '%' : 'n/a'})`)
  lines.push(`Combined: ${fmt(p.combinedYards)} yards · ${pct(p.combVsTargetPct)} of MTD pace · monthly target ${fmt(targets.monthCombinedTarget)}`)
  lines.push('')

  if (p.weekRows.length) {
    lines.push('Week-by-week:')
    for (const w of p.weekRows) {
      lines.push(`  ${w.weekLabel} (${w.weekStart}): BNY ${fmt(w.bnyYards)} · Passaic ${fmt(w.njYards)} (${fmt(w.njColorYards)} color-yds, ${fmt(w.njWaste)} waste)`)
    }
    lines.push('')
  }

  if (p.weekRows.length && Object.keys(p.weekRows[0].njByCategory || {}).length) {
    const catTotals = { fabric: 0, grass: 0, paper: 0 }
    for (const w of p.weekRows) {
      for (const c of Object.keys(w.njByCategory || {})) {
        catTotals[c] = (catTotals[c] || 0) + (w.njByCategory[c]?.yards || 0)
      }
    }
    lines.push(`Passaic by category MTD: ${Object.entries(catTotals).filter(([, v]) => v).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}`)
    lines.push('')
  }

  // Financials
  lines.push('## Financials MTD')
  lines.push(`Revenue: ${money(f.revenue)}`)
  lines.push(`OpEx: ${money(f.opex)}`)
  lines.push(`Inventory purchases: ${money(f.invPurchases)}`)
  if (f.cogsAvailable) {
    lines.push(`COGS total: ${money(f.cogsTotal)} (Material ${money(f.cogsMaterial)}, Labor ${money(f.cogsLabor)}, Other ${money(f.cogsOther)})`)
    lines.push(`Gross profit: ${money(f.grossProfit)} · ${f.revenue > 0 ? (100 * f.grossProfit / f.revenue).toFixed(1) + '%' : 'n/a'} margin`)
  } else {
    lines.push(`COGS: PENDING — ${f.cogsPendingNote}`)
    lines.push(`Do NOT speculate about gross profit or margin in the narrative — finance hasn't released COGS yet.`)
  }
  if (Object.keys(f.byUnit).length) {
    lines.push('By business unit:')
    for (const [u, v] of Object.entries(f.byUnit)) {
      lines.push(`  ${u}: revenue ${money(v.revenue)} · opex ${money(v.opex)} · inv purchases ${money(v.invPurchases)}`)
    }
  }
  lines.push('')

  if (ap || ar || cash) {
    lines.push('## Working capital')
    if (ap) lines.push(`AP (${ap.period}): ${money(ap.total)} total · ${money(ap.pastDue)} past due`)
    if (ar) lines.push(`AR (${ar.period}): ${money(ar.totalOutstanding)} outstanding · ${money(ar.aging91Plus)} over 90 days`)
    if (cash && cash.total != null) lines.push(`Cash (${cash.period}): ${money(cash.total)}`)
    lines.push('')
  }

  // People
  if (people && people.bny) {
    lines.push('## People MTD')
    lines.push(`BNY: ${people.bny.headcount} active · ${fmt(people.bny.hours)} hours · ${money(people.bny.pay)} payroll · ${people.bny.otPct != null ? people.bny.otPct.toFixed(1) + '%' : 'n/a'} OT`)
    lines.push(`Passaic: ${people.nj.headcount} active · ${fmt(people.nj.hours)} hours · ${money(people.nj.pay)} payroll · ${people.nj.otPct != null ? people.nj.otPct.toFixed(1) + '%' : 'n/a'} OT`)
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

function fmt(n) {
  if (n == null || isNaN(n)) return '—'
  return Math.round(n).toLocaleString()
}
function money(n) {
  if (n == null || isNaN(n)) return '—'
  return '$' + Math.round(n).toLocaleString()
}
function pct(n) {
  if (n == null || isNaN(n)) return '—'
  return n.toFixed(0) + '%'
}

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

export function buildMonthlyBriefPrompt({ data }) {
  const phase = data.pacing.phase
  const monthLabel = data.pacing.monthLabel
  const contextString = formatBriefContext(data)

  const phaseFraming = phase === 'mid'
    ? `This is a **mid-month** brief. The month is still in flight. Audience is FSCO \
leadership reading at the halftime mark — they want a confident read of where we \
sit, an honest call on whether we're on track to land the month, and a short list \
of what to watch in the back half. Tone: confident but not premature. Don't \
declare victory or defeat — name the trajectory.`
    : `This is an **end-of-month** brief. The month has closed. Audience is FSCO \
leadership reading on the first or second working day of the new month — they \
want a clean retrospective: what landed, what didn't, what it means for the next \
period. Tone: reflective, evidence-based, slightly more polished than the live \
floor read. This is the durable monthly memo.`

  const cogsGuidance = data.financials.cogsAvailable
    ? `COGS is available — discuss it directly. Reference gross profit and margin \
where relevant.`
    : `**COGS is NOT available yet.** Finance does not release COGS until after \
the 10th of the following month. Do NOT speculate about gross profit, margin, or \
profitability. You can discuss revenue against the prior month or against budget, \
and you can discuss OpEx against budget pace. If asked-or-tempted to read the \
month's profitability, plainly state that COGS is pending and the picture is \
incomplete on that dimension. Move on. Do not invent numbers.`

  const phaseStructure = phase === 'mid' ? `
## Structure (3-4 paragraphs, ~250 words total)

1. **Headline + halftime read.** Open with the most important signal at the \
halfway mark. Are we tracking to land the month? Lead with the combined yardage \
vs pace number. Name the dominant driver (BNY pulling, Passaic dragging — or \
inverse).

2. **Production picture by site.** BNY and Passaic separately. Cite specific \
yards, % to pace, color-yards on the Passaic side, waste% if notable. Honor \
the BNY/Passaic accounting convention.

3. **Financial pace + working capital.** Revenue, OpEx, inventory purchases. \
COGS guidance above. Note any AP/AR signal worth surfacing.

4. **Watch items for the back half.** 2-3 specific things execs should track. \
Tied to data, not generic.
`.trim() : `
## Structure (4-5 paragraphs, ~350 words total)

1. **Headline + month verdict.** Open with the cleanest read of how the month \
landed. Cite the combined number and how it compared to plan. If revenue \
landed materially over or under, name it in sentence one.

2. **Production retrospective.** BNY and Passaic separately. What worked, \
what didn't. Reference specific weeks if one was an outlier. Color-yards story \
on Passaic. Waste%.

3. **Financials.** Revenue and OpEx vs pace. COGS guidance above — if pending, \
say so plainly and don't speculate. Inventory purchases. Working capital signals.

4. **WIP and what's carrying into next month.** Active orders, age buckets, NEW \
Goods activity. What's queued up for the next month from where we sit today.

5. **Watch items / what shaped the month / what to take forward.** \
Forward-looking close. 2-3 specific things.
`.trim()

  return `You are an internal analyst at Paramount Prints writing the **${monthLabel} ${phase === 'mid' ? 'Mid-Month' : 'End-of-Month'} Brief** for FSCO leadership. \
Audience: Timur Yumusaklar (CEO), Antonella Pilo, Emily Huber, Abigail Pratt, \
Kim Carrera — plus Peter Webster (President) and the Paramount ops team.

${phaseFraming}

This brief gets distributed as a PDF and quoted in conversations with the \
broader FSCO team. It should read like a sharp internal monthly memo — the \
kind a competent COO would write summarizing the period.

---

${contextString}

---

## Critical guidance

${cogsGuidance}

Honor the BNY/Passaic accounting convention: when Passaic ran digital work, \
BNY gets the revenue and production credit. Don't misattribute Passaic-run \
digital work to Passaic.

Frame everything in yards, color-yards, dollars, or WIP — the operational \
metrics that matter. Use "Paramount" or "we" — not "the company."

Be direct. Avoid hedge words ("appears," "going forward"). Avoid filler ("as \
expected," "best in class"). Avoid corporate boilerplate.

If a section has nothing notable, write one sentence and move on. Do not \
manufacture significance.

${phaseStructure}

## Output format

- Prose only. No bullets, no headers, no title line.
- Specific numbers throughout.
- Numbers must come from the data above. Do not invent.
- Begin with your first sentence. No preamble. No "Here is the brief" framing.
- No closing valediction or sign-off.

Begin now.`
}
