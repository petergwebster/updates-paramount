/**
 * contextBuilder.js — Assembles tiered Claude context for any prompt.
 *
 * The architecture:
 *   Bucket A — Static facts (business_facts table, slow-changing)
 *   Bucket B — Recent history (last 4 weeks raw, last 13 weeks weekly summaries,
 *              last 12 months monthly summaries, last 3 yrs quarterly summaries)
 *   Bucket C — Forward state (current schedule, open POs, WIP commitments,
 *              outstanding flags) — populated when relevant tables exist
 *
 * Each Claude API call gets a context block tailored to what THAT prompt
 * needs. The context block becomes part of the prompt sent to /api/claude.
 *
 * Phase 2a implements buildDashboardContext(). Future phases add
 * buildInventoryContext, buildDigestContext, etc. — all reuse this base.
 */

import { format, subWeeks, subMonths, subQuarters, startOfWeek } from 'date-fns'
import { supabase } from '../supabase'

// ─────────────────────────────────────────────────────────────────────────────
// Bucket A — Static facts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches all active business facts. Returns them as a numbered list
 * Claude can read directly.
 */
export async function fetchBusinessFacts() {
  const { data, error } = await supabase
    .from('business_facts')
    .select('fact_number, category, fact')
    .eq('active', true)
    .order('fact_number', { ascending: true })

  if (error) {
    console.error('contextBuilder: failed to fetch business_facts', error)
    return []
  }
  return data || []
}

function formatBusinessFacts(facts) {
  if (!facts || facts.length === 0) return ''
  const lines = facts.map(f => `${f.fact_number}. ${f.fact}`)
  return [
    '## About Paramount Prints',
    'These are foundational facts about the business. Use them as authoritative context for every observation.',
    '',
    ...lines,
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucket B — Recent history (tiered)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches recent week production data — last 4 weeks in detail.
 * Pulls from the existing `weeks` and `production` tables.
 */
async function fetchRecentWeeksDetail(weekStart, count = 4) {
  const startDate = format(subWeeks(weekStart, count), 'yyyy-MM-dd')
  const endDate = format(weekStart, 'yyyy-MM-dd')

  const { data: weeks } = await supabase
    .from('weeks')
    .select('week_start, kpis, concerns')
    .gte('week_start', startDate)
    .lte('week_start', endDate)
    .order('week_start', { ascending: true })

  const { data: production } = await supabase
    .from('production')
    .select('week_start, nj_data, bny_data')
    .gte('week_start', startDate)
    .lte('week_start', endDate)
    .order('week_start', { ascending: true })

  // Merge by week_start
  const merged = {}
  ;(weeks || []).forEach(w => {
    merged[w.week_start] = { week_start: w.week_start, kpis: w.kpis, concerns: w.concerns }
  })
  ;(production || []).forEach(p => {
    if (!merged[p.week_start]) merged[p.week_start] = { week_start: p.week_start }
    merged[p.week_start].nj_data = p.nj_data
    merged[p.week_start].bny_data = p.bny_data
  })

  return Object.values(merged).sort((a, b) => a.week_start.localeCompare(b.week_start))
}

function formatRecentWeeksDetail(weekRows) {
  if (!weekRows || weekRows.length === 0) {
    return '(No detailed weekly data available for the last 4 weeks.)'
  }

  const lines = weekRows.map(w => {
    const weekLabel = format(new Date(w.week_start + 'T00:00:00'), 'MMM d, yyyy')
    const parts = [`### Week of ${weekLabel}`]

    // BNY production summary
    if (w.bny_data) {
      const bny = w.bny_data
      const totalActual = (bny.replen?.actual || 0) + (bny.mto?.actual || 0) +
                          (bny.hos?.actual || 0) + (bny.memo?.actual || 0) + (bny.contract?.actual || 0)
      parts.push(`- BNY: ${totalActual.toLocaleString()} yards produced`)
    }

    // Passaic production summary
    if (w.nj_data) {
      const nj = w.nj_data
      const totalActual = (nj.fabric?.yards || 0) + (nj.grass?.yards || 0) + (nj.paper?.yards || 0)
      const totalWaste  = (nj.fabric?.waste || 0) + (nj.grass?.waste || 0) + (nj.paper?.waste || 0)
      parts.push(`- Passaic: ${totalActual.toLocaleString()} yards produced, ${totalWaste.toLocaleString()} waste`)
    }

    // KPI status summary (count green/amber/red)
    if (w.kpis) {
      const statuses = Object.values(w.kpis).map(k => k?.status).filter(Boolean)
      const greens = statuses.filter(s => s === 'green').length
      const ambers = statuses.filter(s => s === 'amber').length
      const reds   = statuses.filter(s => s === 'red').length
      if (greens + ambers + reds > 0) {
        parts.push(`- KPI status: ${greens} green, ${ambers} amber, ${reds} red`)
      }
    }

    // Concerns flag
    if (w.concerns && w.concerns.trim()) {
      parts.push(`- Concerns flagged: "${w.concerns.trim().slice(0, 200)}"`)
    }

    return parts.join('\n')
  })

  return ['## Recent weeks (detail)', '', ...lines].join('\n')
}

/**
 * Fetches weekly summaries from historical_summaries — coarser tier, last 13 weeks.
 * Returns empty array gracefully if the table is empty (early days of dashboard).
 */
async function fetchWeeklySummaries(weekStart, count = 13) {
  const startDate = format(subWeeks(weekStart, count), 'yyyy-MM-dd')
  const endDate = format(subWeeks(weekStart, 4), 'yyyy-MM-dd')  // before the detail tier

  const { data } = await supabase
    .from('historical_summaries')
    .select('*')
    .eq('period_type', 'weekly')
    .gte('period_start', startDate)
    .lte('period_start', endDate)
    .order('period_start', { ascending: true })

  return data || []
}

function formatWeeklySummaries(rows) {
  if (!rows || rows.length === 0) {
    return '(No weekly summary data yet — historical_summaries fills in as weeks age.)'
  }
  const lines = rows.map(r => {
    return `- ${r.period_label}: ${r.total_yards_produced?.toLocaleString() || '?'} yards, ${r.waste_pct ?? '?'}% waste${r.notes ? ` · ${r.notes}` : ''}`
  })
  return ['## Weekly trend (last quarter)', '', ...lines].join('\n')
}

/**
 * Monthly summaries — last 12 months.
 */
async function fetchMonthlySummaries(weekStart, count = 12) {
  const startDate = format(subMonths(weekStart, count), 'yyyy-MM-dd')
  const endDate   = format(subMonths(weekStart, 1), 'yyyy-MM-dd')

  const { data } = await supabase
    .from('historical_summaries')
    .select('*')
    .eq('period_type', 'monthly')
    .gte('period_start', startDate)
    .lte('period_start', endDate)
    .order('period_start', { ascending: true })

  return data || []
}

function formatMonthlySummaries(rows) {
  if (!rows || rows.length === 0) return ''
  const lines = rows.map(r => {
    const revenuePart = r.revenue ? ` · $${Number(r.revenue).toLocaleString()} revenue` : ''
    return `- ${r.period_label}: ${r.total_yards_produced?.toLocaleString() || '?'} yards${revenuePart}${r.notes ? ` · ${r.notes}` : ''}`
  })
  return ['## Monthly trend (last year)', '', ...lines].join('\n')
}

/**
 * Quarterly summaries — last 3 fiscal years.
 */
async function fetchQuarterlySummaries(weekStart, count = 12) {
  const startDate = format(subQuarters(weekStart, count), 'yyyy-MM-dd')
  const endDate   = format(subQuarters(weekStart, 1), 'yyyy-MM-dd')

  const { data } = await supabase
    .from('historical_summaries')
    .select('*')
    .eq('period_type', 'quarterly')
    .gte('period_start', startDate)
    .lte('period_start', endDate)
    .order('period_start', { ascending: true })

  return data || []
}

function formatQuarterlySummaries(rows) {
  if (!rows || rows.length === 0) return ''
  const lines = rows.map(r => {
    const revenuePart = r.revenue ? ` · $${Number(r.revenue).toLocaleString()}` : ''
    return `- ${r.period_label}: ${r.total_yards_produced?.toLocaleString() || '?'} yards${revenuePart}${r.notes ? ` · ${r.notes}` : ''}`
  })
  return ['## Quarterly trend (last 3 years)', '', ...lines].join('\n')
}

/**
 * Recent section comments — last 30 days. These are the human notes
 * Brynn/Wendy/Peter have left in the dashboard. Real signal for Claude.
 */
async function fetchRecentComments(weekStart, days = 30) {
  const since = format(subWeeks(weekStart, Math.ceil(days / 7)), 'yyyy-MM-dd')

  const { data } = await supabase
    .from('section_comments')
    .select('week_start, section, author, text, created_at')
    .gte('week_start', since)
    .order('created_at', { ascending: false })
    .limit(40)

  return data || []
}

function formatRecentComments(rows) {
  if (!rows || rows.length === 0) return ''
  const lines = rows.slice(0, 30).map(c => {
    const when = format(new Date(c.created_at), 'MMM d')
    return `- ${when} · ${c.author} on ${c.section}: "${c.text.slice(0, 200)}"`
  })
  return ['## Recent notes & comments (last ~30 days)', '', ...lines].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucket B — recent narratives (Claude's own previous outputs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The last 4 weeks of generated dashboard narratives. So today's narrative
 * knows what the previous weeks said.
 */
async function fetchRecentNarratives(weekStart, count = 4) {
  const startDate = format(subWeeks(weekStart, count), 'yyyy-MM-dd')

  const { data } = await supabase
    .from('dashboard_narratives')
    .select('week_start, time_window, narrative, generated_at')
    .gte('week_start', startDate)
    .lt('week_start', format(weekStart, 'yyyy-MM-dd'))
    .order('week_start', { ascending: false })
    .limit(8)

  return data || []
}

function formatRecentNarratives(rows) {
  if (!rows || rows.length === 0) return ''
  const lines = rows.slice(0, 4).map(n => {
    const weekLabel = format(new Date(n.week_start + 'T00:00:00'), 'MMM d')
    return `### Week of ${weekLabel} (${n.time_window})\n${n.narrative.slice(0, 600)}`
  })
  return ['## Recent narratives (what we said in prior weeks)', '', ...lines].join('\n\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the full context block for a Claude prompt.
 *
 * @param {Object} opts
 * @param {Date}   opts.weekStart    — the Sunday/Monday of the week being analyzed
 * @param {string} opts.timeWindow   — 'today' | 'week' | 'month' | 'heartbeat' | 'recap'
 * @param {Object} opts.currentData  — { actuals, expected } for the time window
 * @param {string} [opts.scope]      — 'full' (default) | 'minimal'
 *
 *   'full'    — pulls business_facts + recent weeks + tiered summaries +
 *               section comments + prior narratives. The right shape for
 *               the weekly Recap and Run Rate prompts.
 *
 *   'minimal' — pulls only business_facts and the current data payload.
 *               The right shape for Heartbeat, where the prompt is about
 *               THIS WEEK'S schedule-vs-actuals only and stale historical
 *               commentary actively poisons the output (Claude parrots
 *               months-old concerns and prior hallucinations as if they
 *               were current truth).
 *
 * @returns {Promise<{ contextString: string, contextObject: Object }>}
 */
export async function buildDashboardContext({ weekStart, timeWindow, currentData, scope = 'full' }) {
  // Minimal scope: just business facts + the current data payload.
  // Used by the heartbeat narrative to keep the prompt focused on this
  // week's live schedule-vs-actuals and avoid feedback loops from prior
  // narratives or stale section comments.
  if (scope === 'minimal') {
    const facts = await fetchBusinessFacts()
    const sections = [
      formatBusinessFacts(facts),
      formatCurrentWindow(timeWindow, weekStart, currentData),
    ].filter(s => s && s.trim().length > 0)

    return {
      contextString: sections.join('\n\n---\n\n'),
      contextObject: {
        time_window: timeWindow,
        scope: 'minimal',
        week_start: format(weekStart, 'yyyy-MM-dd'),
        fact_count: facts.length,
        current_data: currentData,
      },
    }
  }

  // Full scope (default): everything.
  // Fetch all the pieces in parallel
  const [
    facts,
    recentWeeks,
    weeklySums,
    monthlySums,
    quarterlySums,
    recentComments,
    recentNarratives,
  ] = await Promise.all([
    fetchBusinessFacts(),
    fetchRecentWeeksDetail(weekStart, 4),
    fetchWeeklySummaries(weekStart, 13),
    fetchMonthlySummaries(weekStart, 12),
    fetchQuarterlySummaries(weekStart, 12),
    fetchRecentComments(weekStart, 30),
    fetchRecentNarratives(weekStart, 4),
  ])

  const sections = [
    formatBusinessFacts(facts),
    formatCurrentWindow(timeWindow, weekStart, currentData),
    formatRecentWeeksDetail(recentWeeks),
    formatWeeklySummaries(weeklySums),
    formatMonthlySummaries(monthlySums),
    formatQuarterlySummaries(quarterlySums),
    formatRecentComments(recentComments),
    formatRecentNarratives(recentNarratives),
  ].filter(s => s && s.trim().length > 0)

  const contextString = sections.join('\n\n---\n\n')

  // Also return as structured object for ai_call_log
  const contextObject = {
    time_window: timeWindow,
    scope: 'full',
    week_start: format(weekStart, 'yyyy-MM-dd'),
    fact_count: facts.length,
    recent_weeks_count: recentWeeks.length,
    weekly_summaries_count: weeklySums.length,
    monthly_summaries_count: monthlySums.length,
    quarterly_summaries_count: quarterlySums.length,
    recent_comments_count: recentComments.length,
    recent_narratives_count: recentNarratives.length,
    current_data: currentData,
  }

  return { contextString, contextObject }
}

/**
 * Formats the current time window's data as Claude-readable context.
 * "Today" / "Week" / "Month" each get the same shape but different scope.
 *
 * Two formatting modes:
 *   1. Heartbeat-specific shape — when currentData has `plant` or `passaic`
 *      keys, format as structured Heartbeat sections (Plant Pulse, per-
 *      category Passaic, BNY mix, top jobs, operator scorecards). This gives
 *      the heartbeat narrative real numbers to work from.
 *   2. Generic shape — when currentData has actuals/expected/gaps keys,
 *      format as the original three-section layout. Used by Recap, Run Rate,
 *      and other dashboard pages.
 */
function formatCurrentWindow(timeWindow, weekStart, currentData) {
  if (!currentData) return ''

  const windowLabel = {
    today:     `Today (${format(new Date(), 'MMMM d, yyyy')})`,
    week:      `This week (week of ${format(weekStart, 'MMMM d, yyyy')})`,
    month:     `This month (${format(weekStart, 'MMMM yyyy')})`,
    heartbeat: `This week (heartbeat — week of ${format(weekStart, 'MMMM d, yyyy')})`,
    recap:     `Last week (recap — week of ${format(weekStart, 'MMMM d, yyyy')})`,
  }[timeWindow] || timeWindow

  const lines = [`## Current period: ${windowLabel}`, '']

  // ── Heartbeat-shaped payload ─────────────────────────────────────────────
  // HeartbeatPage passes a structured object with plant/passaic/bny/etc.
  // keys. Format it as named sections so Claude sees the budget/scheduled/
  // actual three-layer story plus per-category breakdown.
  const isHeartbeatShape = currentData.plant || currentData.passaic || currentData.bny

  if (isHeartbeatShape) {
    // Plant Pulse — three layers + shift split
    if (currentData.plant) {
      const p = currentData.plant
      lines.push('### Plant Pulse — yards')
      lines.push(`- Budget (annual plan, weekly): ${fmt(p.budget)} yds`)
      lines.push(`- Scheduled (Wendy + Chandler this week): ${fmt(p.scheduled)} yds`)
      lines.push(`- Actual (Live Ops to date): ${fmt(p.actual)} yds`)
      if (p.shift1 || p.shift2) {
        const s1s = p.shift1?.scheduled || 0
        const s1a = p.shift1?.actual || 0
        const s2s = p.shift2?.scheduled || 0
        const s2a = p.shift2?.actual || 0
        if (s2s > 0 || s2a > 0) {
          lines.push(`- 1st shift (6:30a-3p): ${fmt(s1s)} sched · ${fmt(s1a)} actual`)
          lines.push(`- 2nd shift (3p-11p, Passaic only): ${fmt(s2s)} sched · ${fmt(s2a)} actual`)
        }
      }
      lines.push('')
    }

    // Per-category Passaic
    if (currentData.passaic?.byCategory?.length) {
      lines.push('### Passaic — per category')
      for (const cat of currentData.passaic.byCategory) {
        const parts = [`- ${cat.name} (${cat.tableRange}):`]
        parts.push(`${fmt(cat.scheduledYards || 0)} sched / ${fmt(cat.actualYards || 0)} actual`)
        if (cat.budgetYards) parts.push(`vs ${fmt(cat.budgetYards)} budget`)
        if (cat.activeTables != null && cat.tableCount != null) {
          parts.push(`${cat.activeTables}/${cat.tableCount} tables active`)
        }
        if (cat.bottleneck?.label) parts.push(`bottleneck: ${cat.bottleneck.label}`)
        // Shift split if 2nd shift active for this category
        if (cat.shiftAgg?.['2nd']?.plannedYards > 0 || cat.shiftAgg?.['2nd']?.actualYards > 0) {
          parts.push(
            `(1st: ${fmt(cat.shiftAgg['1st'].plannedYards)} sched/${fmt(cat.shiftAgg['1st'].actualYards)} actual; ` +
            `2nd: ${fmt(cat.shiftAgg['2nd'].plannedYards)} sched/${fmt(cat.shiftAgg['2nd'].actualYards)} actual)`
          )
        }
        lines.push(parts.join(' '))
      }
      lines.push('')
    }

    // BNY summary
    if (currentData.bny) {
      const b = currentData.bny
      lines.push('### Brooklyn (BNY) digital')
      if (b.totalScheduled != null || b.totalActual != null) {
        lines.push(`- Total: ${fmt(b.totalScheduled || 0)} sched / ${fmt(b.totalActual || 0)} actual yds`)
      }
      if (b.byBucket && Object.keys(b.byBucket).length) {
        const bucketLines = Object.entries(b.byBucket)
          .filter(([, yards]) => yards > 0)
          .map(([bucket, yards]) => `${bucket}: ${fmt(yards)}`)
        if (bucketLines.length) lines.push(`- By bucket: ${bucketLines.join(', ')}`)
      }
      if (b.machinesActive != null && b.machinesTotal != null) {
        lines.push(`- ${b.machinesActive}/${b.machinesTotal} machines active`)
      }
      lines.push('')
    }

    // Top complexity jobs (Passaic, planned_cy desc)
    if (currentData.topJobs?.length) {
      lines.push('### Top complexity jobs (Passaic, by color-yards)')
      for (const j of currentData.topJobs.slice(0, 5)) {
        const cy = j.planned_cy ? `${fmt(j.planned_cy)} cy` : ''
        const yd = j.planned_yards ? `${fmt(j.planned_yards)} yd` : ''
        const colors = j.colors_count ? `${j.colors_count}c` : ''
        const where = j.table_code || ''
        const desc = j.line_description || j.po_number || ''
        lines.push(`- ${desc} · ${[where, yd, cy, colors].filter(Boolean).join(' · ')}`)
      }
      lines.push('')
    }

    // Operator scorecards (rolled up — top performers and laggards)
    if (currentData.scorecards) {
      const sc = currentData.scorecards
      const summary = []
      if (sc.brooklyn_1st?.length) summary.push(`Brooklyn 1st: ${sc.brooklyn_1st.length} operators`)
      if (sc.passaic_1st?.length)  summary.push(`Passaic 1st: ${sc.passaic_1st.length} operators`)
      if (sc.passaic_2nd?.length)  summary.push(`Passaic 2nd: ${sc.passaic_2nd.length} operators (independent crew)`)
      if (summary.length) {
        lines.push('### Operator scorecards')
        lines.push(`- ${summary.join(' · ')}`)
        // List top 3 by Target across each shift bucket
        for (const [key, label] of [['passaic_1st','Passaic 1st'], ['passaic_2nd','Passaic 2nd'], ['brooklyn_1st','Brooklyn 1st']]) {
          const list = sc[key] || []
          if (!list.length) continue
          const top = list.slice(0, 3).map(op => {
            const tgt = op.targetYards ? fmt(op.targetYards) : '0'
            const act = op.actualYards ? fmt(op.actualYards) : '—'
            const pct = op.targetYards > 0 ? Math.round((op.actualYards / op.targetYards) * 100) : null
            return `${op.name} (${tgt} target, ${act} actual${pct != null ? `, ${pct}%` : ''})`
          })
          lines.push(`- ${label} top 3: ${top.join('; ')}`)
        }
        lines.push('')
      }
    }

    // High-signal flags — surface things Claude should notice
    if (currentData.flags?.length) {
      lines.push('### Notable flags')
      for (const flag of currentData.flags) lines.push(`- ${flag}`)
      lines.push('')
    }

    return lines.join('\n')
  }

  // ── Generic actuals/expected/gaps shape (legacy callers) ─────────────────
  if (currentData.actuals) {
    lines.push('### Actuals so far')
    Object.entries(currentData.actuals).forEach(([k, v]) => {
      lines.push(`- ${k}: ${typeof v === 'number' ? v.toLocaleString() : v}`)
    })
    lines.push('')
  }

  if (currentData.expected) {
    lines.push('### Expected (per scheduler/budget)')
    Object.entries(currentData.expected).forEach(([k, v]) => {
      lines.push(`- ${k}: ${typeof v === 'number' ? v.toLocaleString() : v}`)
    })
    lines.push('')
  }

  if (currentData.gaps) {
    lines.push('### Gap analysis (actual vs expected)')
    Object.entries(currentData.gaps).forEach(([k, v]) => {
      lines.push(`- ${k}: ${v}`)
    })
  }

  return lines.join('\n')
}

// Local helper for formatting numbers in this module (top of file imports
// don't include one and this section uses many numeric formats).
function fmt(n) {
  if (n == null || isNaN(n)) return '0'
  return Math.round(Number(n)).toLocaleString()
}

// ─────────────────────────────────────────────────────────────────────────────
// AI call logging — used by anything that calls /api/claude
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logs a Claude API call to ai_call_log. Best-effort: errors are swallowed
 * because logging should never break the actual feature.
 */
export async function logAICall({
  callerId,
  promptType,
  context,
  prompt,
  response,
  model,
  inputTokens,
  outputTokens,
  durationMs,
  error,
}) {
  try {
    await supabase.from('ai_call_log').insert({
      caller_id:    callerId || null,
      prompt_type:  promptType,
      context:      context || {},
      prompt:       prompt || '',
      response:     response || '',
      model:        model || 'claude-sonnet-4-20250514',
      input_tokens: inputTokens || null,
      output_tokens: outputTokens || null,
      duration_ms:  durationMs || null,
      error:        error || null,
    })
  } catch (e) {
    console.warn('logAICall: failed to record call', e)
  }
}
