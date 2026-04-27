/**
 * dashboardNarrative.js — Prompt template for the Dashboard "Run Rate" narrative.
 *
 * Wraps the contextBuilder output with a clear instruction set for what
 * Claude should produce. Keeps prompt construction in one place so we can
 * tune voice and structure without hunting through component files.
 *
 * Phase 2a: just this one prompt.
 * Future phases: digestPrompt, inventoryAnalysisPrompt, etc.
 */

/**
 * Build the full prompt for a dashboard narrative.
 *
 * @param {Object} opts
 * @param {string} opts.contextString — output of buildDashboardContext
 * @param {string} opts.timeWindow    — 'today' | 'week' | 'month'
 * @returns {string}
 */
export function buildDashboardNarrativePrompt({ contextString, timeWindow }) {
  const windowGuidance = {
    today: `Focus on what we have done so far today versus what was scheduled and budgeted. \
Surface anything off-pace. Set up the rest of the week — what to watch.`,
    week: `Focus on the week's pace through today — what we have produced, where we sit \
versus expected (scheduler) and budget, and what is queued for the rest of the week. \
Reference last week's same-day comparison where useful.`,
    month: `Focus on the month-to-date picture. Compare against the prior month's same-point \
pace. Pull on quarter-over-quarter and year-over-year context where the data supports it. \
Surface any trends that are forming.`,
  }[timeWindow] || ''

  return `You are an internal analyst writing a Run Rate narrative for the Paramount Prints \
operations dashboard. Peter Webster (President) and the FSCO exec team (Timur, Antonella, \
Emily, Abigail) read this. Brynn, Wendy, and the ops team also read it.

${contextString}

---

## Your task

Write the Run Rate narrative for: **${timeWindow}**.

${windowGuidance}

## Output requirements

- 3 to 5 short paragraphs, prose only — no bullets, no headers, no title.
- Specific numbers. If you cite a figure, cite it correctly from the context above.
- Frame everything in terms of what it means for Paramount's WIP, yards produced, or \
cost per yard — those are the three metrics that matter most.
- Honor the BNY/Passaic accounting convention: when Passaic runs digital work, BNY gets \
the credit. Do not mistakenly attribute Passaic-run digital work to Passaic.
- If FSCO procurement is a factor in something concerning (Zone 3 watchlist), name it \
plainly. Use neutral factual language — observations, not accusations.
- Surface trade-offs and risks. Avoid hedging language like "it appears that" or \
"going forward." Avoid filler like "as expected" or "as anticipated."
- Use "Paramount" or "we" — not "the company" or "the business."
- If the data shows nothing notable, say so briefly. Do not invent significance that is \
not there.

Begin the narrative now. Start with your first sentence — no preamble, no title, no \
"Here is the narrative" framing.`
}
