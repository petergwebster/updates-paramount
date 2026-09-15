// lift-qa1-flush-check.mjs -- READ-ONLY. Does QA1 expose the same flush CSV
// reports the hourly feed uses? Tries the module-swapped base and reports
// row counts + the Passaic status distribution (the demo pool's vocabulary).
//
// Run:  node paramount-dashboard\scripts\lift-qa1-flush-check.mjs

const CANDIDATES = [
  'https://bny-qa1.lifterp.com/ords/liftqa1/erp/flush/ondemand/1162',
  'https://bny-qa1.lifterp.com/ords/lift/erp/flush/ondemand/1162',
];

function parseLoose(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[\s,]*$/.test(line)) continue;
    rows.push(line.split(','));
  }
  const headers = (rows[0] || []).map(h => (h || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return { headers, records: rows.slice(1) };
}

for (const base of CANDIDATES) {
  const url = `${base}/orders/orders.csv?`;
  process.stdout.write(`Trying ${base} ... `);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) { console.log(`HTTP ${res.status}`); continue; }
    const text = new TextDecoder('windows-1252').decode(await res.arrayBuffer());
    const { headers, records } = parseLoose(text);
    console.log(`OK — ${records.length} rows`);
    const iSt = headers.indexOf('ORDERSTATUS') >= 0 ? headers.indexOf('ORDERSTATUS') : headers.indexOf('STATUS');
    const iDiv = headers.indexOf('ORDERTYPE') >= 0 ? headers.indexOf('ORDERTYPE') : headers.indexOf('DIVISION');
    if (iSt >= 0) {
      const dist = {};
      for (const r of records) {
        const div = iDiv >= 0 ? (r[iDiv] || '').trim() : '?';
        if (div !== 'Screen Print') continue;
        const s = (r[iSt] || '').trim() || '(blank)';
        dist[s] = (dist[s] || 0) + 1;
      }
      console.log('Screen Print rows by status (QA1):');
      for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
    } else {
      console.log('headers:', headers.slice(0, 20).join(', '));
    }
    console.log('\nWorking QA1 flush base:', base);
    break;
  } catch (e) {
    console.log(`FAIL: ${e}`);
  }
}
console.log('\nNothing was written anywhere.');
