// lift-api-probe3.mjs -- S1 round 3, READ-ONLY (GET only), QA1 by default.
// Goals:
//   (1) validate the exact spelling of every mapped LIFT table name (the crosswalk targets)
//   (2) check whether LIFT's extra Flr-2 Table-10/11/12 exist (the "too many tables" question)
//   (3) machine x step cross-tab from raw order-machines rows (rows saved for offline analysis)
//   (4) find where "ready to print" / "approved to print" lives in the REST payloads
//
// Run:   node paramount-dashboard\scripts\lift-api-probe3.mjs
// Writes: paramount-dashboard\scripts\lift-probe3-output.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, '..', '.env.liftapi');
const outPath = path.join(here, 'lift-probe3-output.json');

const env = {};
for (const raw of fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = raw.indexOf('=');
  if (i > 0) env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
}
const BASE = (env.LIFT_API_BASE || '').replace(/\/+$/, '');
const HEADERS = {
  Authorization: 'Basic ' + Buffer.from(`${env.LIFT_USER}:${env.LIFT_PASS}`).toString('base64'),
  USERNAME: env.LIFT_USER, PASSWORD: env.LIFT_PASS, COMPANY_ID: env.LIFT_COMPANY_ID || '1162',
  Accept: 'application/json',
};

const report = { ranAt: new Date().toISOString(), base: BASE };

async function get(label, pq, quiet = false) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${pq}`, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 500) }; }
    if (!quiet) console.log(`${res.ok ? 'OK ' : 'ERR'} [${res.status}] ${Date.now() - t0}ms  ${label}`);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    console.log(`FAIL ${label}: ${e}`);
    return { ok: false, error: String(e) };
  }
}

console.log(`LIFT API probe round 3 -> ${BASE}\n(read-only)\n`);

// ---- 1+2. Machine name validation --------------------------------------
const mappedNames = [
  'Flr-2 Table-1','Flr-2 Table-2','Flr-2 Table-3','Flr-2 Table-4','Flr-2 Table-5',
  'Flr-2 Table-6','Flr-2 Table-7','Flr-2 Table-8','Flr-2 Table-9',
  'Flr-3 Table-1','Flr-3 Table-2','Flr-3 Table-3','Flr-3 Table-4','Flr-3 Table-5','Flr-3 Table-6',
];
const extraNames = ['Flr-2 Table-10','Flr-2 Table-11','Flr-2 Table-12'];

report.nameChecks = [];
console.log('Validating machine names against QA1 (exact-match query per name):');
for (const name of [...mappedNames, ...extraNames]) {
  const r = await get(`machineName=${name}`, `/api/v1/order-management/order-machines?machineName=${encodeURIComponent(name)}&fetchSize=1&includeTotalCount=true`, true);
  const rows = r.body?.machines?.length ?? 0;
  const total = r.body?.totalCount;
  const verdict = !r.ok ? `HTTP ${r.status ?? r.error}` : rows > 0 ? 'EXISTS (has rows)' : 'accepted, 0 rows';
  report.nameChecks.push({ name, status: r.status, rows, totalCount: total, verdict,
    machineId: r.body?.machines?.[0]?.machineId ?? null });
  console.log(`  ${name.padEnd(16)} ${verdict}${total !== undefined ? `  total=${total}` : ''}`);
}

// ---- 3. Raw harvest + machine x step cross-tab --------------------------
console.log('\nHarvesting order-machines raw rows...');
const rawRows = [];
let offset = 0;
for (let p = 0; p < 40; p++) {
  const r = await get(`order-machines page offset=${offset}`, `/api/v1/order-management/order-machines?fetchSize=5000&fetchOffset=${offset}`, true);
  if (!r.ok) { report.harvestError = r.status ?? r.error; break; }
  const rows = r.body.machines || [];
  rawRows.push(...rows);
  if (!r.body.hasMore) break;
  offset += rows.length;
}
report.rawRowCount = rawRows.length;
const cross = {}; // machine -> step -> count
for (const m of rawRows) {
  const mn = m.machine ?? '?', st = String(m.stepNumber ?? '?');
  (cross[mn] ??= {})[st] = ((cross[mn] ??= {})[st] || 0) + 1;
}
report.machineStepCrossTab = cross;
console.log(`Harvested ${rawRows.length} rows; cross-tab built.`);

// ---- 4. Status hunt ------------------------------------------------------
// order-headers over a wide window (QA1 clone is stale; go back far enough to get rows).
console.log('\nHunting for order status fields...');
let sampleOrders = [];
for (const [f, t] of [['2026-06-01','2026-08-31'], ['2026-01-01','2026-05-31'], ['2025-06-01','2025-12-31']]) {
  const r = await get(`order-headers ${f}..${t}`, `/api/v1/order-management/order-headers?creationDateFrom=${f}&creationDateTo=${t}&fetchSize=10`);
  const rows = r.body?.orders || [];
  if (rows.length) { sampleOrders = rows; report.orderHeadersWindow = `${f}..${t}`; break; }
}
if (sampleOrders.length) {
  report.orderHeaderFieldNames = Object.keys(sampleOrders[0]);
  report.orderHeaderSample = sampleOrders.slice(0, 3);
  const statusFields = report.orderHeaderFieldNames.filter(k => /status|state|approv|ready/i.test(k));
  report.orderHeaderStatusFields = statusFields;
  console.log('order-header fields: ' + report.orderHeaderFieldNames.join(', '));
  if (statusFields.length) {
    const vals = new Set();
    for (const o of sampleOrders) for (const k of statusFields) if (o[k] != null) vals.add(`${k}=${o[k]}`);
    report.statusValuesSeen = [...vals];
    console.log('status-ish values: ' + [...vals].join(' | '));
  } else {
    console.log('No status-like field on order headers.');
  }
} else {
  console.log('No order-header rows found in any window tried.');
}

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nFull detail (incl. raw rows summary + cross-tab) -> ${outPath}\nNothing was written to LIFT.`);
