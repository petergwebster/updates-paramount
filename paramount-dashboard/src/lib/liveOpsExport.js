// liveOpsExport.js — Build an Excel (.xlsx) download of Live Ops daily production.
//   scope 'day'  = the selected day
//   scope 'week' = the full fiscal week already held in memory
// Three sheets: Summary (per machine x shift), Line detail (per PO), Notes.
// Uses the same lazy SheetJS loader the rest of the app uses (cdnjs 0.18.5).

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_FULL = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' }

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
function dateForDow(weekStart, dow) {
  const i = DOW.indexOf(dow); if (i < 0) return ''
  const d = new Date(weekStart); d.setDate(d.getDate() + i); return isoOf(d)
}
function wastePct(y, w) {
  const yy = Number(y || 0), ww = Number(w || 0)
  return (yy + ww) > 0 ? Math.round((ww / (yy + ww)) * 1000) / 10 : ''
}

export async function exportLiveOps(opts) {
  const {
    scope = 'day', site, selectedDate, weekStart, dayOfWeek,
    tables = [], dailyOps = [], opLines = [], opNotes = [], assignments = [],
    showCY = false, deriveColorYards,
  } = opts
  const XLSX = await loadSheetJS()
  const isWeek = scope === 'week'
  const shifts = site === 'passaic' ? ['1st', '2nd'] : ['1st']
  const labelOf = code => (tables.find(t => t.code === code) || {}).label || code
  const inScope = dow => isWeek ? true : dow === dayOfWeek

  const siteOps   = dailyOps.filter(o => o.site === site && inScope(o.day_of_week))
  const siteLines = opLines.filter(l => l.site === site && inScope(l.day_of_week))
  const siteNotes = opNotes.filter(n => n.site === site && inScope(n.day_of_week))

  const cyFor = (line) => {
    if (!showCY || !deriveColorYards) return null
    const asg = assignments.find(a =>
      a.site === site && a.table_code === line.table_code &&
      (a.po_number || '') === (line.po_number || '') &&
      (a.item_sku || '') === (line.item_sku || '') &&
      (a.color || '') === (line.color || ''))
    const cy = deriveColorYards(Number(line.actual_yards || 0), asg)
    return cy == null ? null : Math.round(cy * 10) / 10
  }

  const dateCols = (dow) => isWeek ? [DOW_FULL[dow] || dow, dateForDow(weekStart, dow)] : [isoOf(selectedDate)]
  const dateHdr  = isWeek ? ['Day', 'Date'] : ['Date']

  // ---------- Summary (per machine x shift [x day]) ----------
  const sumHeader = [...dateHdr, 'Machine', 'Shift', 'Operator 1', 'Operator 2',
    'Planned yds', 'Actual yds', 'Waste yds', 'Waste %', ...(showCY ? ['Color yds'] : []), 'Notes']
  const sumRows = []
  const dows = isWeek ? DOW : [dayOfWeek]
  let tA = 0, tW = 0, tCY = 0
  for (const dow of dows) {
    for (const t of tables) {
      for (const sh of shifts) {
        const op = siteOps.find(o => o.table_code === t.code && o.day_of_week === dow && (o.shift || '1st') === sh)
        const cellLines = siteLines.filter(l => l.table_code === t.code && l.day_of_week === dow && (l.shift || '1st') === sh)
        const hasData = (op && (op.actual_yards != null || op.waste_yards != null || op.planned_yards != null || (op.notes && op.notes.trim()))) || cellLines.length > 0
        if (!hasData) continue
        const actual = op && op.actual_yards != null ? Number(op.actual_yards) : cellLines.reduce((s, l) => s + Number(l.actual_yards || 0), 0)
        const waste  = op && op.waste_yards != null ? Number(op.waste_yards) : cellLines.reduce((s, l) => s + Number(l.waste_yards || 0), 0)
        let cy = null
        if (showCY) { cy = 0; for (const l of cellLines) { const v = cyFor(l); if (v != null) cy += v }; cy = Math.round(cy * 10) / 10 }
        tA += actual; tW += waste; if (cy != null) tCY += cy
        sumRows.push([...dateCols(dow), labelOf(t.code), sh,
          (op && op.operator_1) || '', (op && op.operator_2) || '',
          op && op.planned_yards != null ? Number(op.planned_yards) : '',
          actual, waste, wastePct(actual, waste), ...(showCY ? [cy != null ? cy : ''] : []),
          (op && op.notes) || ''])
      }
    }
  }
  const totalRow = [...(isWeek ? ['TOTAL', ''] : ['TOTAL']), '', '', '', '', '', tA, tW, wastePct(tA, tW),
    ...(showCY ? [Math.round(tCY * 10) / 10] : []), '']
  const summaryAoa = [sumHeader, ...sumRows, [], totalRow]

  // ---------- Line detail (per PO) ----------
  const lineHeader = [...dateHdr, 'Machine', 'Shift', 'PO #', 'Item SKU', 'Color', 'Description',
    'Actual yds', 'Waste yds', ...(showCY ? ['Color yds'] : []), 'Complete']
  const lineRows = siteLines.slice()
    .sort((a, b) => (DOW.indexOf(a.day_of_week) - DOW.indexOf(b.day_of_week)) || String(a.table_code).localeCompare(String(b.table_code)))
    .map(l => [...dateCols(l.day_of_week), labelOf(l.table_code), l.shift || '1st',
      l.po_number || '', l.item_sku || '', l.color || '', l.line_description || '',
      l.actual_yards != null ? Number(l.actual_yards) : '', l.waste_yards != null ? Number(l.waste_yards) : '',
      ...(showCY ? [(() => { const v = cyFor(l); return v != null ? v : '' })()] : []), l.is_complete ? 'Yes' : ''])
  const linesAoa = [lineHeader, ...lineRows]

  // ---------- Notes ----------
  const noteHeader = [...dateHdr, 'Machine', 'Shift', 'Category', 'Note', 'PO #', 'Recorded by']
  const noteRows = siteNotes.slice()
    .sort((a, b) => (DOW.indexOf(a.day_of_week) - DOW.indexOf(b.day_of_week)))
    .map(n => [...dateCols(n.day_of_week), n.table_code ? labelOf(n.table_code) : '', n.shift || '1st',
      n.category || '', n.note_text || '', n.po_number || '', n.recorded_by || ''])
  const notesAoa = [noteHeader, ...noteRows]

  // ---------- Workbook ----------
  const wb = XLSX.utils.book_new()
  const sheet = (aoa, widths) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = widths.map(w => ({ wch: w })); return ws }
  const dW = isWeek ? [12, 11] : [11]
  XLSX.utils.book_append_sheet(wb, sheet(summaryAoa, [...dW, 16, 7, 16, 16, 11, 11, 11, 8, ...(showCY ? [9] : []), 44]), 'Summary')
  XLSX.utils.book_append_sheet(wb, sheet(linesAoa,   [...dW, 16, 7, 12, 14, 14, 34, 11, 11, ...(showCY ? [9] : []), 9]), 'Line detail')
  XLSX.utils.book_append_sheet(wb, sheet(notesAoa,   [...dW, 16, 7, 18, 52, 12, 16]), 'Notes')

  const siteLabel = site === 'passaic' ? 'Passaic' : 'BNY'
  const fname = isWeek
    ? `LiveOps_${siteLabel}_Week_${isoOf(weekStart)}.xlsx`
    : `LiveOps_${siteLabel}_${isoOf(selectedDate)}.xlsx`
  XLSX.writeFile(wb, fname)
  return fname
}
