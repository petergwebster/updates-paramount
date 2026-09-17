// netlify/functions/lift-api-read.js
// ===========================================================================
// Read LIFT — the READ-ONLY companion to lift-push-schedule.js.
// ---------------------------------------------------------------------------
// POST { path, query }   ->   proxies a GET to the LIFT REST API and returns JSON.
// POST { list: true }    ->   returns the catalog of readable endpoints.
//
// Lets Claude answer live operational questions against LIFT ("what's Approved
// to Print past its ship date", "which P+W POs are past due", "WIP by customer")
// by reading Paul's REST API. The Sensor->Analyst foundation of the SOW.
//
// SAFETY — three independent guarantees, in order of strength:
//   1. METHOD IS HARDCODED GET. This function never issues anything but a GET,
//      whatever `path` is passed. No write endpoint is reachable through it,
//      even by mistake or malice. This is the primary guarantee.
//   2. PATH ALLOWLIST. `path` must match one of the 55 documented GET templates
//      (below). Anything else is refused before a request is made. Tidiness +
//      defense in depth.
//   3. QA1 LOCK. Refuses unless LIFT_API_BASE contains 'qa1' — same guard the
//      writer uses. PROD is a deliberate, separate decision with Paul.
//
// ENV (Netlify, already set for the writer): LIFT_API_BASE, LIFT_API_USER,
// LIFT_API_PASS, LIFT_API_COMPANY_ID (default 1162). No Supabase, no secrets
// beyond what the push function already uses.
//
// Optional: set LIFT_READ_TOKEN on Netlify to require an x-read-token header
// (off by default so the demo is frictionless; turn on to lock before PROD).
// ===========================================================================

const BASE = (process.env.LIFT_API_BASE || '').replace(/\/+$/, '')
const LH = () => ({
  Authorization: 'Basic ' + Buffer.from(`${process.env.LIFT_API_USER}:${process.env.LIFT_API_PASS}`).toString('base64'),
  USERNAME: process.env.LIFT_API_USER,
  PASSWORD: process.env.LIFT_API_PASS,
  COMPANY_ID: process.env.LIFT_API_COMPANY_ID || '1162',
  Accept: 'application/json',
})

// ---- The 55 documented GET (read) endpoints, from the LiftERP OpenAPI spec.
// {param} placeholders match one path segment. This is the ENTIRE read surface;
// no write path appears here, and the function issues GET regardless.
const READ_TEMPLATES = [
  '/api/v1/address-locations/{id}',
  '/api/v1/crm/addresses/{id}',
  '/api/v1/crm/contacts/{id}',
  '/api/v1/crm/customers/{id}',
  '/api/v1/crm/customers/{id}/third-party-billing-accounts',
  '/api/v1/customer-management/customers',
  '/api/v1/customer-management/customers/{id}/third-party-billing-accounts',
  '/api/v1/customer-management/third-party-billing-accounts/{id}',
  '/api/v1/estimation/quotes/{id}',
  '/api/v1/flags-management/flags',
  '/api/v1/flags-management/flags/{id}',
  '/api/v1/inventory-management/locations',
  '/api/v1/inventory-management/locations/{id}',
  '/api/v1/inventory-management/material-types',
  '/api/v1/inventory-management/material-types/{id}',
  '/api/v1/inventory-management/materials',
  '/api/v1/inventory-management/materials/{id}',
  '/api/v1/inventory-management/storage-types',
  '/api/v1/inventory-management/storage-types/{id}',
  '/api/v1/inventory-management/vendor-materials',
  '/api/v1/inventory-management/vendors',
  '/api/v1/inventory-management/vendors/{id}',
  '/api/v1/order-management/attachment-types',
  '/api/v1/order-management/order-headers',
  '/api/v1/order-management/order-machines',
  '/api/v1/order-management/order-shippings',
  '/api/v1/product-management/products',
  '/api/v1/production-management/production-dashboard',
  '/api/v1/production-management/production-jobs',
  '/api/v1/production-management/production-jobs/{id}',
  '/api/v1/production-management/production-jobs/{id}/lines',
  '/api/v1/production-management/production-jobs/{id}/lines/{id}',
  '/api/v1/purchasing/purchase-orders',
  '/price-sheets/v1',
  '/price-sheets/v1/{name}/customers',
  '/price-sheets/v1/{name}/finishing-surcharges',
  '/price-sheets/v1/{name}/groups',
  '/price-sheets/v1/{name}/groups/{group}/prices',
  '/price-sheets/v1/{name}/groups/{group}/products',
  '/price-sheets/v1/{name}/lines',
  '/price-sheets/v1/{name}/poster-pricing',
  '/price-sheets/v1/{name}/products',
  '/price-sheets/v1/{name}/shipping-rates',
]

const ALLOW = READ_TEMPLATES.map(t =>
  new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+') + '$'))

const MAX_FETCH = 500

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return resp(405, { error: 'POST only' })
    if (!BASE) return resp(500, { error: 'LIFT_API_BASE env var not set on Netlify' })
    if (!BASE.includes('qa1')) return resp(400, { error: `SAFETY STOP: LIFT_API_BASE is not QA1 (${BASE}). Read function is sandbox-only.` })
    if (!process.env.LIFT_API_USER || !process.env.LIFT_API_PASS) return resp(500, { error: 'LIFT_API_USER / LIFT_API_PASS not set on Netlify' })

    // Optional lock (off unless LIFT_READ_TOKEN is set on Netlify)
    if (process.env.LIFT_READ_TOKEN) {
      const tok = (event.headers && (event.headers['x-read-token'] || event.headers['X-Read-Token'])) || ''
      if (tok !== process.env.LIFT_READ_TOKEN) return resp(401, { error: 'bad or missing x-read-token' })
    }

    let body = {}
    try { body = JSON.parse(event.body || '{}') } catch { return resp(400, { error: 'body must be JSON' }) }

    if (body.list === true) {
      return resp(200, { base: BASE, count: READ_TEMPLATES.length, endpoints: READ_TEMPLATES })
    }

    let path = String(body.path || '').trim()
    if (!path) return resp(400, { error: 'path is required, e.g. "/api/v1/production-management/production-dashboard". Or pass { list:true }.' })
    if (!path.startsWith('/')) path = '/' + path
    path = path.split('?')[0] // query goes in `query`, not baked into path

    if (!ALLOW.some(re => re.test(path))) {
      return resp(400, { error: `path not in the read allowlist: ${path}. POST { list:true } to see the ${READ_TEMPLATES.length} readable endpoints.` })
    }

    // Build query string; cap fetchSize so a bad ask can't pull the world.
    const q = new URLSearchParams()
    const query = (body.query && typeof body.query === 'object') ? body.query : {}
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      q.set(k, String(v))
    }
    if (q.has('fetchSize')) q.set('fetchSize', String(Math.min(Number(q.get('fetchSize')) || 100, MAX_FETCH)))
    const qs = q.toString()
    const url = BASE + path + (qs ? '?' + qs : '')

    const t0 = Date.now()
    const res = await fetch(url, { method: 'GET', headers: LH(), signal: AbortSignal.timeout(60000) })
    const ms = Date.now() - t0
    const text = await res.text()
    let data; try { data = JSON.parse(text) } catch { data = { _raw: text.slice(0, 1000) } }

    // Best-effort row count for the common ORDS list shapes.
    let count = null
    if (data && typeof data === 'object') {
      if (Array.isArray(data.items)) count = data.items.length
      else if (Array.isArray(data.machines)) count = data.machines.length
      else if (Array.isArray(data)) count = data.length
    }

    return resp(res.ok ? 200 : 502, { ok: res.ok, httpStatus: res.status, ms, path, query, count, data })
  } catch (err) {
    return resp(500, { error: err.message })
  }
}

function resp(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }
}