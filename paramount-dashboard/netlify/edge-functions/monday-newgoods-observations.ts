// netlify/edge-functions/monday-newgoods-observations.ts
//
// Generates Claude's observations for one site's NEW Goods pre-production
// pipeline. Cached per (site, snapshot_id) — re-runs UPSERT.
//
// POST /api/monday-newgoods-observations
//   body: { site: 'passaic'|'bny', snapshot_id: uuid, force_regenerate?: bool, generated_by?: uuid }
//
// Returns: { ok, observations_md, generated_at, cached, item_count, group_summary, duration_ms }
//
// Env:
//   • VITE_ANTHROPIC_API_KEY   — Claude API key
//   • SUPABASE_SERVICE_ROLE_KEY — Supabase service role
//   • VITE_SUPABASE_URL         — Supabase project URL

import type { Config, Context } from "https://edge.netlify.com"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 2000

// Build a structured prompt from items. Claude sees the full dataset —
// every item, every group — so it can comment on completed work, dropped
// patterns, and concentration risk across the entire pipeline. Compact
// per-line format keeps token usage reasonable even at 600+ items.
function buildPrompt(site: string, items: any[]): string {
  // Group items
  const byGroup: Record<string, any[]> = {}
  for (const it of items) {
    const g = it.group_label || '(no group)'
    if (!byGroup[g]) byGroup[g] = []
    byGroup[g].push(it)
  }
  const groupSummary = Object.fromEntries(
    Object.entries(byGroup).map(([g, arr]) => [g, arr.length])
  )

  // Per-item compact line. Skip null fields to keep prompt tight.
  const itemLine = (i: any) => {
    const parts = [
      `[${i.group_label}]`,
      i.item_name || '?',
      i.status_pipeline ? `pipeline=${i.status_pipeline}` : null,
      i.status_timeline && i.status_timeline !== 'On time' ? `timeline=${i.status_timeline}` : null,
      i.development_type ? `type=${i.development_type}` : null,
      i.approver ? `approver=${i.approver}` : null,
      i.waiting_on ? `waiting=${i.waiting_on}` : null,
      i.customer ? `customer=${i.customer}` : null,
      i.product_type ? `product=${i.product_type}` : null,
      i.launch_date_text ? `launch=${i.launch_date_text}` : null,
      i.cfa_due ? `cfa=${i.cfa_due}` : null,
      i.trials_due ? `trials=${i.trials_due}` : null,
    ].filter(Boolean)
    return parts.join(' · ')
  }

  // Note: timeline/pipeline columns may be swapped in stored data depending
  // on Monday board column order. The component handles this at render time.
  // Here we just send what we have — Claude can infer.
  const siteLabel = site === 'passaic' ? 'Passaic (hand-screen)' : 'Brooklyn (digital)'

  // Build the items section group-by-group so Claude can see the structure
  // mirrored in the prompt itself.
  const itemsByGroup = Object.entries(byGroup)
    .map(([group, arr]) => {
      const lines = arr.map(itemLine).join('\n')
      return `### ${group} (${arr.length} items)\n${lines}`
    })
    .join('\n\n')

  return `You are reading the NEW Goods pre-production pipeline for Paramount Prints, ${siteLabel}.

PIPELINE STRUCTURE:
${Object.entries(groupSummary).map(([g, n]) => `  • ${g}: ${n} items`).join('\n')}
Total: ${items.length} items

ALL ITEMS (organized by group):

${itemsByGroup}

YOUR JOB:
Give Peter (Paramount President) a useful operational read. Organize the read by group/category — one short paragraph per group that has notable signal. Skip groups with nothing worth saying.

For each group, look for:
  • Aging concerns — items that look stuck (specific status repeated across many items, or stale-looking dates)
  • Blockers — patterns of "Waiting On" the same person/role, items in "On Hold" that may need a decision
  • Late risk — items with timeline=Late or May be late, especially with near launch dates
  • Concentration — does one approver own a disproportionate share? One development type dominating?
  • Things worth celebrating — clear progress, items moving well, recent wins worth flagging
  • For Approved/Dropped groups — comment briefly only if there's a meaningful pattern (e.g. high drop rate, concentration of drops on one approver/type)

Style:
  • Conversational, not a report. Peter reads carefully and prefers dense prose.
  • Specific over vague. Reference item names when you mention something.
  • If you don't see notable signal in a group, say so briefly or skip it. Don't pad.
  • Use Markdown. **Bold** group names as section headers. Don't use H1/H2.
  • 400-700 words total. Be tight.
  • End with a "Bottom line" paragraph — 2-3 sentences synthesizing the read.

Don't:
  • Don't list every item.
  • Don't recommend specific actions unless there's a clear blocker (e.g., "X is on hold and the launch is next month — worth checking with Y").
  • Don't speculate on data you don't have.`
}

export default async (request: Request, _context: Context) => {
  const t0 = Date.now()

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
      status: 405, headers: { 'content-type': 'application/json' },
    })
  }

  const claudeKey  = Deno.env.get('VITE_ANTHROPIC_API_KEY') || Deno.env.get('ANTHROPIC_API_KEY')
  const supabaseUrl = Deno.env.get('VITE_SUPABASE_URL')
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!claudeKey || !supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing env vars (VITE_ANTHROPIC_API_KEY / Supabase)' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    })
  }

  let body: any = {}
  try { body = await request.json() } catch {}
  const site: string = body?.site
  const snapshotId: string = body?.snapshot_id
  const force: boolean = !!body?.force_regenerate
  const generatedBy: string | null = body?.generated_by ?? null
  if (!site || !['passaic','bny'].includes(site)) {
    return new Response(JSON.stringify({ ok: false, error: 'site required (passaic|bny)' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })
  }
  if (!snapshotId) {
    return new Response(JSON.stringify({ ok: false, error: 'snapshot_id required' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // Cache check (unless force_regenerate)
    if (!force) {
      const { data: cached } = await supabase
        .from('mng_observations')
        .select('*')
        .eq('snapshot_id', snapshotId)
        .eq('site', site)
        .maybeSingle()
      if (cached) {
        return new Response(JSON.stringify({
          ok: true,
          cached: true,
          observations_md: cached.observations_md,
          generated_at: cached.generated_at,
          item_count: cached.item_count,
          group_summary: cached.group_summary,
          duration_ms: Date.now() - t0,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }

    // Pull items for this site + snapshot
    const { data: items, error: itemsErr } = await supabase
      .from('mng_items')
      .select('group_label, item_name, status_timeline, status_pipeline, development_type, approver, waiting_on, customer, product_type, launch_date_text, cfa_due, trials_due, timeline_start, timeline_end')
      .eq('snapshot_id', snapshotId)
      .eq('site', site)
    if (itemsErr) throw new Error(`Items query failed: ${itemsErr.message}`)
    if (!items || items.length === 0) {
      throw new Error(`No items found for snapshot ${snapshotId} site ${site}`)
    }

    const groupSummary: Record<string, number> = {}
    for (const it of items) {
      const g = it.group_label || '(no group)'
      groupSummary[g] = (groupSummary[g] || 0) + 1
    }

    const prompt = buildPrompt(site, items)

    // Call Claude API
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!claudeResp.ok) {
      const errText = await claudeResp.text()
      throw new Error(`Claude API HTTP ${claudeResp.status}: ${errText.slice(0, 500)}`)
    }
    const claudeJson = await claudeResp.json()
    const content = claudeJson?.content?.[0]?.text
    if (!content) {
      throw new Error(`Claude returned no content: ${JSON.stringify(claudeJson).slice(0, 300)}`)
    }

    const duration_ms = Date.now() - t0

    // UPSERT observation row
    const { error: upsertErr } = await supabase
      .from('mng_observations')
      .upsert({
        snapshot_id: snapshotId,
        site,
        observations_md: content,
        generated_by: generatedBy,
        duration_ms,
        item_count: items.length,
        group_summary: groupSummary,
        model_used: MODEL,
        generated_at: new Date().toISOString(),
      }, { onConflict: 'snapshot_id,site' })
    if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`)

    return new Response(JSON.stringify({
      ok: true,
      cached: false,
      observations_md: content,
      generated_at: new Date().toISOString(),
      item_count: items.length,
      group_summary: groupSummary,
      duration_ms,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: String(e),
      duration_ms: Date.now() - t0,
    }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}

export const config: Config = {
  path: '/api/monday-newgoods-observations',
}
