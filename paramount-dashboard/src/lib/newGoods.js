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
