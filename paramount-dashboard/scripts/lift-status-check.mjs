// lift-status-check.mjs -- S1 close-out, READ-ONLY. Decodes orderStatus ids to names
// using fieldMode=detailed (displayValue), so the writer can honor Ramon's rule:
// schedulable = "ready to print" and/or "approved to print".
//
// Run:   node paramount-dashboard\scripts\lift-status-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const raw of fs.readFileSync(path.join(here, '..', '.env.liftapi'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = raw.indexOf('=');
  if (i > 0) env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
}
const BASE = (env.LIFT_API_BASE || '').replace(/\/+$/, '');
const HEADERS = {
  Authorization: 'Basic ' + Buffer.from(`${env.LIFT_USER}:${env.LIFT_PASS}`).toString('base64'),
  USERNAME: env.LIFT_USER, PASSWORD: env.LIFT_PASS, COMPANY_ID: env.LIFT_COMPANY_ID || '1162',
  Accept: 'application/json',
};

const seen = new Map(); // statusValue -> displayValue

async function pull(f, t) {
  const url = `${BASE}/api/v1/order-management/order-headers?creationDateFrom=${f}&creationDateTo=${t}&fieldMode=detailed&fetchSize=200`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
  if (!res.ok) { console.log(`ERR [${res.status}] ${f}..${t}: ${(await res.text()).slice(0, 200)}`); return; }
  const body = await res.json();
  const orders = body.orders || [];
  for (const o of orders) {
    const s = o.orderStatus;
    if (s && typeof s === 'object') seen.set(String(s.value), s.displayValue ?? '(no displayValue)');
    else if (s != null) seen.set(String(s), '(flat scalar — detailed mode not applied?)');
  }
  console.log(`OK  ${f}..${t}: ${orders.length} orders`);
}

console.log(`Status decode -> ${BASE}\n(read-only)\n`);
for (const [f, t] of [['2026-06-01','2026-08-31'], ['2026-01-01','2026-05-31'], ['2025-07-01','2025-12-31']]) {
  await pull(f, t);
}

console.log('\norderStatus id -> name:');
for (const [v, d] of [...seen.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  ${v.padStart(6)} = ${d}`);
}
fs.writeFileSync(path.join(here, 'lift-status-output.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), statuses: Object.fromEntries(seen) }, null, 2));
console.log('\nSaved -> scripts/lift-status-output.json\nNothing was written to LIFT.');
