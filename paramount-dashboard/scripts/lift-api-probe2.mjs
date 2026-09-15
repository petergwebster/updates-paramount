// lift-api-probe2.mjs -- S1 round 2, still READ-ONLY (GET only), QA1 by default.
// Goals: (1) full machine inventory with exact names, (2) the step-14 Print pool
// with line detail (the demo population), (3) how many lines sit on 'Scheduler'.
//
// Run:   node paramount-dashboard\scripts\lift-api-probe2.mjs
// Writes: paramount-dashboard\scripts\lift-probe2-output.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, '..', '.env.liftapi');
const outPath = path.join(here, 'lift-probe2-output.json');

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

const report = { ranAt: new Date().toISOString(), base: BASE, notes: [] };

async function get(label, pq) {
  const url = `${BASE}${pq}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 800) }; }
    console.log(`${res.ok ? 'OK ' : 'ERR'} [${res.status}] ${Date.now() - t0}ms  ${label}`);
    if (!res.ok) console.log('     ' + text.slice(0, 250).replace(/\s+/g, ' '));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    console.log(`FAIL ${label}: ${e}`);
    return { ok: false, error: String(e) };
  }
}

console.log(`LIFT API probe round 2 -> ${BASE}\n(read-only)\n`);

// ---- A. Machine inventory via order-machines, paged. Try unfiltered first;
//         if the API demands a date window, fall back to 60-day chunks from 2025-01-01.
const machines = new Map(); // name -> {machineId, rows}
const stepCounts = new Map(); // stepNumber -> rows
let omRows = 0;

async function harvest(pq) {
  let offset = 0, pages = 0;
  while (pages < 40) {
    const r = await get(`order-machines page offset=${offset}`, `${pq}&fetchSize=5000&fetchOffset=${offset}`);
    if (!r.ok) return { ok: false, r };
    const rows = r.body.machines || [];
    for (const m of rows) {
      omRows++;
      const name = m.machine ?? '';
      if (!machines.has(name)) machines.set(name, { machineId: m.machineId, rows: 0 });
      machines.get(name).rows++;
      const s = String(m.stepNumber);
      stepCounts.set(s, (stepCounts.get(s) || 0) + 1);
    }
    if (!r.body.hasMore) return { ok: true };
    offset += rows.length; pages++;
  }
  return { ok: true, capped: true };
}

let h = await harvest('/api/v1/order-management/order-machines?includeTotalCount=false');
if (!h.ok) {
  report.notes.push('Unfiltered order-machines rejected; falling back to 60-day windows from 2025-01-01.');
  const start = new Date('2025-01-01');
  for (let d = new Date(start); d < new Date(); d = new Date(d.getTime() + 60 * 86400000)) {
    const to = new Date(Math.min(d.getTime() + 60 * 86400000 - 1, Date.now()));
    const f = d.toISOString().slice(0, 10), t = to.toISOString().slice(0, 10);
    await harvest(`/api/v1/order-management/order-machines?creationDateFrom=${f}&creationDateTo=${t}`);
  }
}

report.orderMachineRowsSeen = omRows;
report.machineInventory = [...machines.entries()]
  .map(([name, v]) => ({ name, machineId: v.machineId, rows: v.rows }))
  .sort((a, b) => b.rows - a.rows);
report.rowsByStep = Object.fromEntries([...stepCounts.entries()].sort());

console.log(`\nMachine inventory (${machines.size} distinct):`);
for (const m of report.machineInventory) console.log(`  ${String(m.machineId).padStart(6)}  ${m.name}  (${m.rows} rows)`);

// ---- B. The step-14 Print pool with lines (the demo population), paged.
const pool = [];
let offset = 0;
for (let p = 0; p < 10; p++) {
  const r = await get(
    `production-dashboard Print pool page ${p}`,
    `/api/v1/production-management/production-dashboard?includeOrders=true&includeLines=true&stepNumber=14&fetchSize=100&fetchOffset=${offset}`
  );
  if (!r.ok) break;
  const orders = r.body.orders || [];
  pool.push(...orders);
  if (!r.body.pagination?.hasMore) break;
  offset += orders.length;
}
report.printPoolOrderCount = pool.length;
report.printPoolSample = pool.slice(0, 3);
if (pool[0]?.lines?.length || pool[0]?.orderLines?.length) {
  const l = (pool[0].lines || pool[0].orderLines)[0];
  report.lineFieldNames = Object.keys(l);
}
console.log(`\nPrint-step pool: ${pool.length} orders.`);
if (report.lineFieldNames) console.log('Line fields: ' + report.lineFieldNames.join(', '));

// ---- C. Lines currently parked on 'Scheduler' (hypothesis: the unscheduled queue)
const sched = await get('order-machines: machineName=Scheduler', '/api/v1/order-management/order-machines?machineName=Scheduler&fetchSize=5000&includeTotalCount=true');
if (sched.ok) {
  const rows = sched.body.machines || [];
  report.schedulerParked = { totalCount: sched.body.totalCount, returned: rows.length };
  const bySt = {};
  for (const m of rows) bySt[m.stepNumber] = (bySt[m.stepNumber] || 0) + 1;
  report.schedulerParkedByStep = bySt;
  report.schedulerSample = rows.slice(0, 5);
  console.log(`\n'Scheduler' parked lines: total ${sched.body.totalCount}, by step: ${JSON.stringify(bySt)}`);
}

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nFull detail -> ${outPath}\nNothing was written to LIFT.`);
