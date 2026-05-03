/**
 * newGoods.js — read layer for the NEW Goods (Monday.com pre-production) data.
 *
 * COMPONENTS CALL THIS, NOT SUPABASE DIRECTLY. This is the swap point for
 * the eventual move to live-mode (querying Monday on every page load
 * instead of reading the snapshot table).
 *
 * Today (snapshot mode):
 *   getCurrentSnapshot()       → latest mng_snapshots row
 *   getNewGoodsItems({ site }) → reads from v_current_mng_items
 *   triggerRefresh({ trigger }) → calls /api/monday-newgoods-refresh
 *   isStale(snapshot, hours)   → boolean — for auto-refresh logic
 *
 * Future (live mode):
 *   Same function signatures. Implementations swap to call a different
 *   edge function that returns rows from Monday's GraphQL directly.
 *   Components never know the difference.
 */

import { supabase } from '../supabase'

const STALE_HOURS_DEFAULT = 24

/**
 * Get the most recent NEW Goods snapshot (or null if none exists).
 */
export async function getCurrentSnapshot() {
  const { data, error } = await supabase
    .from('mng_snapshots')
    .select('*')
    .order('refreshed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * Get NEW Goods items for a site from the current snapshot.
 *
 * @param {object} opts
 * @param {'passaic'|'bny'} opts.site
 * @returns {Promise<Array>} mapped rows from mng_items
 */
export async function getNewGoodsItems({ site }) {
  if (!site) throw new Error('getNewGoodsItems requires { site }')

  const { data, error } = await supabase
    .from('v_current_mng_items')
    .select('*')
    .eq('site', site)
  if (error) throw error
  return data || []
}

/**
 * Trigger a refresh from Monday.com. Returns the response from the edge
 * function — { ok, snapshot_id, passaic, bny, total, duration_ms, warnings? }.
 *
 * Errors throw; callers should catch + surface to the UI.
 */
export async function triggerRefresh({ trigger = 'manual', refreshedBy = null } = {}) {
  const resp = await fetch('/api/monday-newgoods-refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger, refreshed_by: refreshedBy }),
  })
  const json = await resp.json()
  if (!resp.ok || !json.ok) {
    throw new Error(json.error || `Refresh failed (HTTP ${resp.status})`)
  }
  return json
}

/**
 * Is the given snapshot older than `hours` hours? Used to decide whether
 * to auto-trigger a refresh on tab load.
 */
export function isStale(snapshot, hours = STALE_HOURS_DEFAULT) {
  if (!snapshot?.refreshed_at) return true
  const ageMs = Date.now() - new Date(snapshot.refreshed_at).getTime()
  return ageMs > hours * 60 * 60 * 1000
}

/**
 * Group items by their group_label, returning a Map preserving insertion
 * order. Pure utility — no I/O.
 */
export function groupItemsByGroup(items) {
  const map = new Map()
  for (const item of items) {
    const key = item.group_label || '(no group)'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return map
}

/**
 * Standard "in-progress" filter — the items actively in development pipeline.
 * Excludes Approved (already through QA) and Dropped (no longer pursued).
 * Used as the default view on the NEW Goods tab.
 */
export function inProgressOnly(items) {
  const exclude = new Set(['APPROVED', 'Approved', 'DROPPED', 'Dropped'])
  return items.filter(i => !exclude.has(i.group_label || ''))
}

// ─── Claude Observations ──────────────────────────────────────────────────

/**
 * Get the most recent observation for (site, snapshot_id), if any.
 * Used to power the "Last run: ..." timestamp on the Observations button
 * AND to show stale observations when the snapshot has refreshed since.
 *
 * Returns null when no observation exists (or only ones for older snapshots).
 *
 * @param {object} opts
 * @param {'passaic'|'bny'} opts.site
 * @param {string} [opts.snapshotId] — if provided, only matches that snapshot.
 *   if omitted, returns the most recent observation for the site regardless
 *   of snapshot (useful for showing stale-but-still-readable content).
 */
export async function getObservation({ site, snapshotId = null }) {
  if (!site) throw new Error('getObservation requires { site }')
  let q = supabase.from('mng_observations').select('*').eq('site', site)
  if (snapshotId) q = q.eq('snapshot_id', snapshotId)
  q = q.order('generated_at', { ascending: false }).limit(1)
  const { data, error } = await q.maybeSingle()
  if (error) throw error
  return data
}

/**
 * Generate (or fetch cached) observations for one site + snapshot.
 *
 * @param {object} opts
 * @param {'passaic'|'bny'} opts.site
 * @param {string} opts.snapshotId
 * @param {boolean} [opts.forceRegenerate] — true = ignore cache, re-run Claude.
 * @param {string|null} [opts.generatedBy] — user UUID for audit.
 * @returns {Promise<object>} { ok, cached, observations_md, generated_at, item_count, group_summary, duration_ms }
 */
export async function generateObservations({ site, snapshotId, forceRegenerate = false, generatedBy = null }) {
  if (!site || !snapshotId) throw new Error('generateObservations requires { site, snapshotId }')
  const resp = await fetch('/api/monday-newgoods-observations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      site,
      snapshot_id: snapshotId,
      force_regenerate: forceRegenerate,
      generated_by: generatedBy,
    }),
  })

  // Defensive parse: edge function timeouts return HTML (Netlify error page),
  // not JSON. Detect by content-type and surface a useful error instead of
  // a confusing JSON parse error like "Unexpected token 'h'".
  const contentType = resp.headers.get('content-type') || ''
  let json
  if (contentType.includes('application/json')) {
    try {
      json = await resp.json()
    } catch (e) {
      throw new Error(`Server returned malformed JSON (HTTP ${resp.status})`)
    }
  } else {
    // Non-JSON response — almost certainly a gateway error page
    const body = await resp.text().catch(() => '')
    if (resp.status === 504 || /timeout|timed out|edge function/i.test(body)) {
      throw new Error(`Edge function timed out — try again (Sonnet should handle the full payload, but if this keeps happening let's check the logs)`)
    }
    throw new Error(`Server error (HTTP ${resp.status}): ${body.slice(0, 200) || 'no body'}`)
  }

  if (!resp.ok || !json.ok) {
    throw new Error(json.error || `Observations call failed (HTTP ${resp.status})`)
  }
  return json
}
