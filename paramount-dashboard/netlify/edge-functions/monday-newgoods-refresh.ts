// netlify/edge-functions/monday-newgoods-refresh.ts
//
// Pulls both pre-production boards from Monday.com and writes a snapshot
// to mng_snapshots + mng_items. Triggered by:
//   • Manual refresh button on the NEW Goods tab
//   • Auto-refresh on tab load when current snapshot > 24h old
//
// Why server-side, not client-side?
//   • Monday API token must not be exposed to browsers
//   • Service-role write to Supabase requires server-side auth
//   • Lets us swap to live-mode later without changing client code:
//     this same function can become a "fetch-and-return" instead of
//     "fetch-and-store" when we go live.
//
// Returns: { ok, snapshot_id, passaic, bny, duration_ms, warnings? }
//
// Env vars required:
//   • VITE_MONDAY_TOKEN     — Monday personal API token
//   • SUPABASE_SERVICE_ROLE_KEY — Supabase service role
//   • VITE_SUPABASE_URL     — Supabase project URL

import type { Config, Context } from "https://edge.netlify.com"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Monday board IDs from Peter's URLs
const BOARD_PASSAIC = 3855381957
const BOARD_BNY     = 18395941611

// Hard cap so a misbehaving board doesn't blow memory. Both boards are
// well under 1k items; bump this if a board ever genuinely exceeds it.
const MAX_ITEMS_PER_BOARD = 5000

interface MondayColumnValue {
  id: string
  type?: string
  text?: string | null
  value?: string | null
}

interface MondayItem {
  id: string
  name: string
  group?: { id: string; title: string } | null
  column_values: MondayColumnValue[]
}

// One column-value lookup helper. We index by Monday's column id (the slug)
// AND by display title — different boards use different ids for the "same"
// concept (Status, Status_1, etc.), so we resolve loosely.
//
// Returns an object with both `text` (human-readable rendered value, what
// you see in the Monday UI) and `value` (raw JSON Monday stores).
function lookupByTitle(item: MondayItem, columnTitleByID: Record<string, string>, title: string): { text: string | null, value: string | null } {
  const lc = title.toLowerCase().trim()
  for (const cv of item.column_values) {
    const colTitle = columnTitleByID[cv.id]
    if (colTitle && colTitle.toLowerCase().trim() === lc) {
      return { text: cv.text ?? null, value: cv.value ?? null }
    }
  }
  return { text: null, value: null }
}

// Date columns on Monday come as either a plain ISO string in `text` or
// as JSON like {"date":"2026-07-06"} in `value`. Normalize to YYYY-MM-DD.
function parseDate(text: string | null, value: string | null): string | null {
  if (text) {
    // Monday surfaces date as "2026-07-06" or "Mon, Jul 6 2026" — accept both
    const iso = text.match(/^\d{4}-\d{2}-\d{2}$/) ? text : null
    if (iso) return iso
    const d = new Date(text)
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  if (value) {
    try {
      const j = JSON.parse(value)
      if (j?.date) return String(j.date)
    } catch {}
  }
  return null
}

// Map a Monday item to the row we'll insert into mng_items. `site` and
// `boardId` and `columnTitleByID` (board-specific column id → title map)
// are passed in by the caller — same logic regardless of which board.
function mapItemToRow(
  item: MondayItem,
  site: 'passaic' | 'bny',
  boardId: number,
  columnTitleByID: Record<string, string>,
  snapshotId: string,
) {
  // Build raw_columns from every column on the item — useful for components
  // that want a column we haven't surfaced yet, and for debugging.
  const rawColumns: Record<string, { text: string | null, value: string | null, title?: string }> = {}
  for (const cv of item.column_values) {
    rawColumns[cv.id] = {
      text: cv.text ?? null,
      value: cv.value ?? null,
      title: columnTitleByID[cv.id],
    }
  }

  // Both boards have two columns titled "Status" — Monday differentiates
  // them by id (status / status_1__1 / similar). We grab both by title;
  // ties resolve to the first match (timeline) and the second to pipeline.
  // The board export indicated col 3 = timeline-status, col 9/10 = pipeline.
  // Since lookupByTitle takes the first match, we collect both ourselves:
  const allStatuses: string[] = []
  for (const cv of item.column_values) {
    const t = columnTitleByID[cv.id]
    if (t && t.toLowerCase().trim() === 'status' && cv.text) {
      allStatuses.push(cv.text)
    }
  }
  const statusTimeline = allStatuses[0] ?? null
  const statusPipeline = allStatuses[1] ?? null

  const launchRaw = lookupByTitle(item, columnTitleByID, 'Launch Date')
  const cfaRaw    = lookupByTitle(item, columnTitleByID, 'CFA Due Date')
  const tlStart   = lookupByTitle(item, columnTitleByID, 'Timeline - Start')
  const tlEnd     = lookupByTitle(item, columnTitleByID, 'Timeline - End')
  const trialsDue = lookupByTitle(item, columnTitleByID, 'Trials Due')
  const apprDate  = lookupByTitle(item, columnTitleByID, 'Approval Date (Trials Due)')

  // Development Type appears as "Development Type" on Passaic and
  // "Developement Type" (typo) on BNY. Match either.
  const devType =
    lookupByTitle(item, columnTitleByID, 'Development Type').text
    ?? lookupByTitle(item, columnTitleByID, 'Developement Type').text

  return {
    snapshot_id: snapshotId,
    monday_id:   Number(item.id),
    board_id:    boardId,
    site,
    group_label: item.group?.title ?? null,
    item_name:   item.name ?? null,

    status_timeline: statusTimeline,
    status_pipeline: statusPipeline,

    development_type: devType,
    approver:         lookupByTitle(item, columnTitleByID, 'Approver/Point Person').text,
    waiting_on:       lookupByTitle(item, columnTitleByID, 'Waiting on....').text
                     ?? lookupByTitle(item, columnTitleByID, 'Waiting On....').text,
    priority:         lookupByTitle(item, columnTitleByID, 'Priority').text,
    summary:          lookupByTitle(item, columnTitleByID, 'Summarize').text,

    timeline_start:   parseDate(tlStart.text, tlStart.value),
    timeline_end:     parseDate(tlEnd.text, tlEnd.value),
    launch_date_text: launchRaw.text,  // free-text — preserve as-is
    cfa_due:          parseDate(cfaRaw.text, cfaRaw.value),

    // Passaic-only (will be null on BNY but column titles don't exist there)
    customer:      lookupByTitle(item, columnTitleByID, 'Customer').text,
    product_type:  lookupByTitle(item, columnTitleByID, 'Product Type').text,
    colorway:      lookupByTitle(item, columnTitleByID, 'Colorway').text,
    ground:        lookupByTitle(item, columnTitleByID, 'Ground').text,
    sku_ref:       lookupByTitle(item, columnTitleByID, 'SKU # / Mill Ref.').text,
    trials_due:    parseDate(trialsDue.text, trialsDue.value),
    approval_date: parseDate(apprDate.text, apprDate.value),

    raw_columns: rawColumns,
  }
}

// Pull all items from a board with cursor pagination. Monday caps each page
// at 500 items by default. Stop early if MAX_ITEMS_PER_BOARD is exceeded.
async function fetchBoardItems(boardId: number, token: string): Promise<{
  items: MondayItem[],
  columnTitleByID: Record<string, string>,
  warnings: string[],
}> {
  const warnings: string[] = []
  const items: MondayItem[] = []
  let cursor: string | null = null

  // First call also fetches the columns map — needed to look up values by title.
  const firstQuery = `
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id title type }
        items_page(limit: 500) {
          cursor
          items {
            id
            name
            group { id title }
            column_values { id type text value }
          }
        }
      }
    }`

  const firstResp = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query: firstQuery, variables: { boardId: String(boardId) } }),
  })
  if (!firstResp.ok) {
    throw new Error(`Monday API HTTP ${firstResp.status} on board ${boardId}: ${await firstResp.text()}`)
  }
  const firstJson = await firstResp.json()
  if (firstJson.errors) {
    throw new Error(`Monday GraphQL errors on board ${boardId}: ${JSON.stringify(firstJson.errors)}`)
  }
  const board = firstJson?.data?.boards?.[0]
  if (!board) {
    throw new Error(`Monday returned no board for id ${boardId} (token scope?)`)
  }
  const columnTitleByID: Record<string, string> = {}
  for (const c of board.columns ?? []) columnTitleByID[c.id] = c.title

  items.push(...(board.items_page?.items ?? []))
  cursor = board.items_page?.cursor ?? null

  // Subsequent pages — Monday wants `next_items_page(cursor:)` (NOT `items_page` again)
  while (cursor && items.length < MAX_ITEMS_PER_BOARD) {
    const pageQuery = `
      query ($cursor: String!) {
        next_items_page(limit: 500, cursor: $cursor) {
          cursor
          items {
            id
            name
            group { id title }
            column_values { id type text value }
          }
        }
      }`
    const pageResp = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'API-Version': '2024-10',
      },
      body: JSON.stringify({ query: pageQuery, variables: { cursor } }),
    })
    if (!pageResp.ok) {
      warnings.push(`Pagination HTTP ${pageResp.status} on board ${boardId} — partial results`)
      break
    }
    const pageJson = await pageResp.json()
    if (pageJson.errors) {
      warnings.push(`Pagination errors on board ${boardId}: ${JSON.stringify(pageJson.errors)} — partial results`)
      break
    }
    const page = pageJson?.data?.next_items_page
    if (!page) break
    items.push(...(page.items ?? []))
    cursor = page.cursor ?? null
  }

  if (items.length >= MAX_ITEMS_PER_BOARD) {
    warnings.push(`Board ${boardId} hit MAX_ITEMS_PER_BOARD (${MAX_ITEMS_PER_BOARD}) — increase if needed`)
  }

  return { items, columnTitleByID, warnings }
}

export default async (request: Request, _context: Context) => {
  const t0 = Date.now()

  // Reject non-POST early — refreshes are state-changing.
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
      status: 405, headers: { 'content-type': 'application/json' },
    })
  }

  const token = Deno.env.get('VITE_MONDAY_TOKEN') || Deno.env.get('MONDAY_TOKEN')
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'VITE_MONDAY_TOKEN not configured' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    })
  }
  const supabaseUrl = Deno.env.get('VITE_SUPABASE_URL')
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: 'Supabase env vars missing' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    })
  }

  // Body is optional — { trigger?: 'manual'|'auto'|'scheduled', refreshed_by?: uuid }
  let trigger: string = 'manual'
  let refreshedBy: string | null = null
  try {
    const body = await request.json()
    if (body?.trigger) trigger = String(body.trigger)
    if (body?.refreshed_by) refreshedBy = String(body.refreshed_by)
  } catch { /* empty body is fine */ }
  if (!['manual','auto','scheduled'].includes(trigger)) trigger = 'manual'

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const allWarnings: string[] = []
  let passaicCount = 0
  let bnyCount = 0
  let snapshotId: string | null = null

  try {
    // Pull both boards in parallel — independent calls, no shared state.
    const [passaicRes, bnyRes] = await Promise.all([
      fetchBoardItems(BOARD_PASSAIC, token),
      fetchBoardItems(BOARD_BNY,     token),
    ])
    allWarnings.push(...passaicRes.warnings, ...bnyRes.warnings)
    passaicCount = passaicRes.items.length
    bnyCount     = bnyRes.items.length

    // Insert snapshot row first — child rows FK to it.
    const { data: snap, error: snapErr } = await supabase
      .from('mng_snapshots')
      .insert({
        refreshed_by: refreshedBy,
        trigger,
        is_current: true,
        passaic_items: passaicCount,
        bny_items: bnyCount,
        total_items: passaicCount + bnyCount,
        warnings: allWarnings.length ? allWarnings.join(' | ') : null,
      })
      .select()
      .single()
    if (snapErr) throw new Error(`Snapshot insert failed: ${snapErr.message}`)
    snapshotId = snap.id

    // Map items → rows. Insert in batches of 500.
    const passaicRows = passaicRes.items.map(it => mapItemToRow(it, 'passaic', BOARD_PASSAIC, passaicRes.columnTitleByID, snapshotId!))
    const bnyRows     = bnyRes.items.map(it     => mapItemToRow(it, 'bny',     BOARD_BNY,     bnyRes.columnTitleByID, snapshotId!))
    const allRows = [...passaicRows, ...bnyRows]

    const batchSize = 500
    for (let i = 0; i < allRows.length; i += batchSize) {
      const chunk = allRows.slice(i, i + batchSize)
      const { error: insErr } = await supabase.from('mng_items').insert(chunk)
      if (insErr) throw new Error(`Items insert failed at batch ${i}: ${insErr.message}`)
    }

    const duration_ms = Date.now() - t0
    // Update snapshot with final timing
    await supabase.from('mng_snapshots')
      .update({ duration_ms })
      .eq('id', snapshotId)

    return new Response(JSON.stringify({
      ok: true,
      snapshot_id: snapshotId,
      passaic: passaicCount,
      bny: bnyCount,
      total: passaicCount + bnyCount,
      duration_ms,
      warnings: allWarnings.length ? allWarnings : undefined,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  } catch (e) {
    const duration_ms = Date.now() - t0
    // Best-effort: stamp the snapshot with the error so the UI can display it.
    if (snapshotId) {
      await supabase.from('mng_snapshots')
        .update({ error_message: String(e), duration_ms })
        .eq('id', snapshotId)
        .then(() => {})
        .catch(() => {})
    }
    return new Response(JSON.stringify({
      ok: false,
      error: String(e),
      snapshot_id: snapshotId,
      duration_ms,
    }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}

export const config: Config = {
  path: '/api/monday-newgoods-refresh',
}
