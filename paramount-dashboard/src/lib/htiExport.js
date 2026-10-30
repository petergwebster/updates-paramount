// htiExport.js — Build an Excel (.xlsx) download of Held to Invoice.
//   Sheet 1 "Summary"     — per-site headline (held yds, % of bar, target,
//                           new goods, age buckets) + the category breakdown.
//   Sheet 2 "Line detail" — every held line, both sites, oldest first.
// Snapshot = whatever the tab currently has loaded from hti-summary.
// Uses the same lazy SheetJS loader the rest of the app uses (cdnjs 0.18.5).

const SITE_NAME = { sp: 'Passaic', dg: 'BNY' }
const CAT_LABEL = {
  fabric: 'Fabric', grass: 'Grass', paper: 'Paper', other: 'Strike-offs',
  digital: 'Digital', 'new goods': 'New Goods — design approval',
}

function loadSheetJS() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) { resolve(window.XLSX); return }
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    s.onload = () => resolve(window.XLSX)
    s.onerror = () => reject(new Error('Failed to load SheetJS'))
    document.head.appendChild(s)
  })
}

function isoOf(d) {
  const x = new Date(d)
  const y = x.getFullYear(), m = String(x.getMonth() + 1).padStart(2, '0'), da = String(x.getDate()).padStart(2, '0')
  return `${y}-${m}-${da}`
}
const num = (v) => (v == null || v === '' ? '' : Number(v))

export async function exportHti(data) {
  if (!data || !data.sites) throw new Error('No HTI data loaded to export')
  const XLSX = await loadSheetJS()
  const asOf = data.asOf ? new Date(data.asOf) : new Date()
  const sites = [['sp', data.sites.passaic], ['dg', data.sites.bny]].filter(([, s]) => s)
  const lines = Array.isArray(data.lines) ? data.lines : []

  // ---------- Summary ----------
  const summaryAoa = []
  summaryAoa.push(['Held to Invoice — printed, not yet billed (live from LIFT)'])
  summaryAoa.push([`As of ${asOf.toLocaleString('en-US')}`])
  summaryAoa.push([])
  summaryAoa.push(['Site', 'Held yds', 'Lines', '% of bar', 'Target yds',
    'New goods yds', 'New goods lines', '<7d', '7-14', '14-30', '30-60', '60+'])
  for (const [k, s] of sites) {
    const a = s.ages || {}
    summaryAoa.push([SITE_NAME[k], num(s.coreYds), num(s.coreLines), num(s.pctOfTarget), num(s.target),
      num(s.ngYds), num(s.ngLines), num(a.d7), num(a.d14), num(a.d30), num(a.d60), num(a.d60plus)])
  }
  summaryAoa.push([])
  summaryAoa.push(['Category breakdown (oldest = age of oldest line, days)'])
  summaryAoa.push(['Site', 'Category', 'Lines', 'Yards', 'Oldest (days)', 'Carried PO lines', 'Carried yds', 'New goods'])
  for (const [k, s] of sites) {
    for (const c of (s.cats || [])) {
      summaryAoa.push([SITE_NAME[k], CAT_LABEL[c.cat] || c.cat, num(c.lines), num(c.yds), num(c.oldest),
        num(c.carryLines), num(c.carryYds), c.ng ? 'Yes' : ''])
    }
  }

  // ---------- Line detail (both sites, oldest first) ----------
  const lineHeader = ['Site', 'Category', 'PO #', 'Order #', 'Customer', 'Item SKU', 'Description',
    'Status', 'Printed', 'Age (days)', 'Yards', 'Carried', 'New goods']
  const lineRows = lines.slice()
    .sort((a, b) => String(a.div).localeCompare(String(b.div)) || ((b.age ?? -1) - (a.age ?? -1)))
    .map(l => [SITE_NAME[l.div] || l.div || '', CAT_LABEL[l.cat] || l.cat || '', l.po || '', l.order || '',
      (l.customer || '').replace('F. SCHUMACHER & CO', 'FSCO'), l.sku || '', l.desc || '',
      l.status || '', l.printed || '', l.age == null ? '' : Number(l.age), num(l.yds),
      l.carry ? 'Yes' : '', l.ng ? 'Yes' : ''])
  const linesAoa = [lineHeader, ...lineRows]

  // ---------- Workbook ----------
  const wb = XLSX.utils.book_new()
  const sheet = (aoa, widths) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = widths.map(w => ({ wch: w })); return ws }
  XLSX.utils.book_append_sheet(wb, sheet(summaryAoa, [26, 11, 8, 9, 11, 13, 14, 8, 8, 8, 8, 8]), 'Summary')
  XLSX.utils.book_append_sheet(wb, sheet(linesAoa, [9, 24, 14, 14, 26, 16, 34, 16, 12, 11, 11, 9, 10]), 'Line detail')

  const fname = `HeldToInvoice_${isoOf(asOf)}.xlsx`
  XLSX.writeFile(wb, fname)
  return fname
}
