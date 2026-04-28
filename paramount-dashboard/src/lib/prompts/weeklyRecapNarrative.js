/**
 * weeklyRecapNarrative.js — Prompt template for the Executive Dashboard's
 * weekly recap narrative.
 *
 * Different from the Run Rate prompt:
 *   - Run Rate is forward-looking: "how is THIS week building, what's queued?"
 *   - Weekly Recap is backward-looking: "here's what happened LAST week,
 *     framed for FSCO leadership reading on Monday morning."
 *
 * Output is longer than Run Rate (5-7 paragraphs vs 3-5), more narrative,
 * more polished. Written for execs who want a real recap they can reference
 * in their own conversations with the broader FSCO team.
 *
 * Same `contextBuilder` powers it — same business facts, same tiered
 * history. Just a different output instruction set.
 */

/**
 * Build the prompt for a weekly recap narrative.
 *
 * @param {Object} opts
 * @param {string} opts.contextString — output of buildDashboardContext
 * @param {boolean} opts.hasData      — true if production data was entered
 *                                       for the week being recapped
 * @returns {string}
 */
export function buildWeeklyRecapNarrativePrompt({ contextString, hasData = true }) {
  const dataStateGuidance = hasData
    ? `## Data state\nProduction data has been entered for this week. Treat the actuals as real and analyze accordingly.`
    : `## Data state — IMPORTANT\nProduction data for the week being recapped has NOT been fully entered yet. Do NOT \
write a recap that says we were "shut down" or "behind pace." Instead, write a brief \
honest note (2-3 paragraphs) that:
- Explains plainly that the recap is incomplete because data has not been fully entered
- Surfaces whatever partial data IS available
- References recent prior-week trends so the reader has context while waiting for current data
- Invites the reader to check back once the week's data is finalized
- Avoids alarmist framing — this is a data-entry state, not an operational issue`

  return `You are an internal analyst at Paramount Prints writing the **Executive Weekly \
Recap** that FSCO leadership reads to understand how Paramount performed last week. \
Audience: Timur Yumusaklar, Antonella Pilo, Emily Huber, Abigail Pratt, Kim Carrera, \
plus Peter Webster (President) and the Paramount ops leadership team.

This is the polished retrospective. It should read like a sharp internal weekly memo — \
the kind a competent COO would write Monday morning summarizing the prior week. It \
should give execs enough context to walk into their own meetings and speak with \
authority about Paramount's week.

${contextString}

---

${dataStateGuidance}

---

## Your task

Write the **Executive Weekly Recap** for the week being analyzed. This is the full \
retrospective — what happened, what it means, what to watch.

## Structure (5-7 paragraphs)

1. **Headline paragraph** — open with the most important thing from the week. Did we \
hit our pace? Miss it? Was there a notable event? Lead with what matters.

2. **Production performance** — Brooklyn (BNY) and Passaic. Cite specific yards, \
compare to expected, note any sites that over- or under-performed. Honor the BNY/Passaic \
accounting convention: when Passaic ran digital work, BNY gets the credit.

3. **Financial picture** — revenue against budget, any cost-side observations, anything \
about the mix of work (replenishment vs MTO vs HOS, etc.) that affected the bottom line.

4. **Inventory / WIP** — where Paramount's WIP sits, anything notable about ground \
arrivals, FSCO procurement watchlist (Zone 3) flags. If FSCO procurement let us down, \
say so plainly and factually — these are observations, not accusations.

5. **Trends and context** — how this week fits in. Compare to prior weeks, prior month, \
prior quarter where the data supports it. Surface trends forming. If something has been \
true 3 weeks in a row, name it.

6. **Watch items going into next week** — what should execs be tracking? Risks, \
opportunities, decisions pending.

7. **(Optional) Closing line** — one sentence that gives the reader something to take away.

## Voice and constraints

- 5-7 short-to-medium paragraphs, prose only — no bullets, no headers, no title.
- Specific numbers throughout. Round to clean figures only when the precision adds nothing.
- Frame everything in terms of WIP, yards produced, or cost per yard — those are the \
three operational metrics that matter most.
- Use "Paramount" or "we" — never "the company" or "the business."
- Direct, evidence-based, slightly confident. Avoid hedging language ("it appears that," \
"going forward," "as expected"). When something is concerning, say so plainly.
- This is for execs who skim — every paragraph should earn its place. Cut filler.
- If the data shows nothing notable in a section, write one short sentence and move on. \
Don't manufacture significance.

Begin the recap now. Start with your headline sentence — no preamble, no title, no \
"Here is the recap" framing.`
}
