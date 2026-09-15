// lift-api-probe.mjs -- S1 read-only probe of the LIFT REST API (QA1 sandbox by default).
// READ-ONLY: only GET requests. Proves auth, reachability, and the identifier mapping
// (orderNumber / lineNumber / stepNumber + exact machine names) before any write is built.
//
// Run:   node paramount-dashboard\scripts\lift-api-probe.mjs
// Needs: paramount-dashboard\.env.liftapi  (create via setup-lift-creds.ps1)
// Writes: paramount-dashboard\scripts\lift-probe-output.json  (full payloads for Claude to read)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, '..', '.env.liftapi');
const outPath = path.join(here, 'lift-probe-output.json');

// ---- load creds (tolerate CRLF / UTF-8 BOM from Set-Content) ----
if (!fs.existsSync(envPath)) {
  console.error('Missing .env.liftapi -- run setup-lift-creds.ps1 first.');
  process.exit(1);
}
const env = {};
for (const raw of fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = raw.indexOf('=');
  if (i > 0) env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
}
const BASE = (env.LIFT_API_BASE || '').replace(/\/+$/, '');
const { LIFT_USER, LIFT_PASS, LIFT_COMPANY_ID } = env;
if (!BASE || !LIFT_USER || !LIFT_PASS) {
  console.error('.env.liftapi incomplete (need LIFT_API_BASE, LIFT_USER, LIFT_PASS).');
  process.exit(1);
}

// Send BOTH auth styles: Basic (the v1 endpoints' declared scheme) and the
// legacy USERNAME/PASSWORD/COMPANY_ID headers. Redundant but harmless; the
// probe report shows which the server honored.
const HEADERS = {
  Authorization: 'Basic ' + Buffer.from(`${LIFT_USER}:${LIFT_PASS}`).toString('base64'),
  USERNAME: LIFT_USER,
  PASSWORD: LIFT_PASS,
  COMPANY_ID: LIFT_COMPANY_ID || '1162',
  Accept: 'application/json',
};

const report = { ranAt: new Date().toISOString(), base: BASE, calls: [] };

async function get(label, pathAndQuery) {
  const url = `${BASE}${pathAndQuery}`;
  const entry = { label, url, ok: false };
  report.calls.push(entry);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    entry.status = res.status;
    entry.ms = Date.now() - t0;
    const text = await res.text();
    try { entry.body = JSON.parse(text); } catch { entry.bodyText = text.slice(0, 2000); }
    entry.ok = res.ok;
    console.log(`${res.ok ? 'OK ' : 'ERR'} [${res.status}] ${entry.ms}ms  ${label}`);
    if (!res.ok) console.log('     ' + (text || '').slice(0, 300).replace(/\s+/g, ' '));
  } catch (e) {
    entry.error = String(e);
    console.log(`FAIL ${label}: ${e}`);
  }
  return entry;
}

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const from = new Date(today.getTime() - 14 * 86400000);

console.log(`LIFT API read probe -> ${BASE}`);
console.log('(read-only: GET requests only)\n');

// 1) Production dashboard: step overview (which manufacturing steps exist, orders queued at each)
const steps = await get('production-dashboard: step overview', '/api/v1/production-management/production-dashboard?includeSteps=true');

// 2) Drill into the busiest step: orders + lines (this exposes orderNumber/lineNumber/stepNumber shapes)
let stepList = [];
if (steps.ok && steps.body) {
  const dig = (o) => {
    if (Array.isArray(o)) return o;
    for (const k of ['steps', 'items', 'data', 'rows']) if (Array.isArray(o?.[k])) return o[k];
    return [];
  };
  stepList = dig(steps.body);
  report.stepCount = stepList.length;
}
if (stepList.length) {
  const counted = stepList
    .map((s) => ({ s, n: Number(s.orderCount ?? s.orders ?? s.count ?? s.ORDER_COUNT ?? 0) }))
    .sort((a, b) => b.n - a.n);
  const busiest = counted[0]?.s || stepList[0];
  const stepNo = busiest.stepNumber ?? busiest.step_number ?? busiest.STEP_NUMBER;
  report.busiestStep = busiest;
  if (stepNo !== undefined) {
    await get(
      `production-dashboard: orders+lines at step ${stepNo}`,
      `/api/v1/production-management/production-dashboard?includeOrders=true&includeLines=true&stepNumber=${encodeURIComponent(stepNo)}&fetchSize=10`
    );
  }
}

// 3) order-machines: machine assignment per line/step for recent orders -> machine-name inventory
const om = await get(
  'order-machines: last 14 days',
  `/api/v1/order-management/order-machines?creationDateFrom=${iso(from)}&creationDateTo=${iso(today)}&fetchSize=200&includeTotalCount=true`
);
if (om.ok && om.body) {
  const rows = Array.isArray(om.body) ? om.body : om.body.items || om.body.data || om.body.rows || [];
  report.orderMachinesRowCount = rows.length;
  const names = new Set();
  for (const r of rows) {
    const n = r.machineName ?? r.machine_name ?? r.MACHINE_NAME ?? r.targetMachineName;
    if (n) names.add(n);
  }
  report.distinctMachineNames = [...names].sort();
  report.orderMachinesSample = rows.slice(0, 5);
  console.log(`\nDistinct machine names seen (${names.size}):`);
  for (const n of report.distinctMachineNames) console.log('  - ' + n);
}

// 4) Paul's known example order, for shape comparison against the working JSON
await get('order-machines: F0015652 (Paul\'s example)', '/api/v1/order-management/order-machines?orderNumber=F0015652');

// 5) A couple of order headers, to line the REST identifiers up against our PO-keyed pool
await get('order-headers: recent sample', `/api/v1/order-management/order-headers?creationDateFrom=${iso(from)}&creationDateTo=${iso(today)}&fetchSize=5`);

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
const okCount = report.calls.filter((c) => c.ok).length;
console.log(`\n${okCount}/${report.calls.length} calls OK. Full payloads -> ${outPath}`);
console.log('Nothing was written to LIFT.');
