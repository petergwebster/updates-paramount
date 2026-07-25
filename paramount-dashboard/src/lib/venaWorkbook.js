// Parser for the Vena monthly P&L export.
//   "Paramount Results vs Forecast_<Month> <Year>.xlsx"  (Abigail's close)
//
// Usage: parseVenaWorkbook(XLSX, workbook, { fileName })
//   -> { rows: [...], summary: {...}, period, fileName, warnings: [] }
//
// WHY THIS EXISTS: Vena is the authoritative financial view — revenue, COGS,
// EBITDA, capitalization. The month-end deck's financial half already ties to
// it to the dollar (verified by hand for June 2026: revenue 500,477.21, COGS
// 441,513.47, EBITDAP 58,963.73). The dashboard should INGEST and DISPLAY
// these numbers, never recompute them.
//
// SHEET SHAPE (learned from the June 2026 file, 2026-07-25):
//   - One "<CC> Variance" sheet per cost centre: Cons, 609, 610, 612.
//   - Line labels sit in column H, with leaf GL accounts spelled out as
//     "3020 (Sales - 3rd Party)".
//   - Value columns are NOT at fixed positions. Three header rows describe
//     them: year, period, scenario (the scenario row is the one containing
//     "Actual"; year is two rows above it, period one row above).
//   - The sheet carries MONTH, QTD and YTD blocks side by side, each with its
//     own scenario columns. The period header cell is the discriminator:
//     6 -> month, "6 QTD" -> qtd, "6 YTD" -> ytd. Column position is NOT
//     reliable and must not be hard-coded.
//   - Rows labelled "MultiDynamic: Account" are Vena scaffolding, not data.
// ---------------------------------------------------------------------------

const MONTHS = ['january','february','march','april','may','june','july',
                'august','september','october','november','december']

// ---- helpers ---------------------------------------------------------------
const isNum = v => typeof v === 'number' && isFinite(v)
const snake = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

function timeframeOf(periodCell) {
  const s = String(periodCell == null ? '' : periodCell).toUpperCase()
  if (s.includes('YTD')) return 'ytd'
  if (s.includes('QTD')) return 'qtd'
  return 'month'
}

// actual | forecast | plan | py_actual — derived from label + year, never position.
function scenarioOf(label, year, reportYear) {
  const l = String(label || '').trim().toLowerCase()
  if (l.startsWith('forecast')) return 'forecast'
  if (l.startsWith('plan') || l.startsWith('budget')) return 'plan'
  if (l.startsWith('actual')) {
    return (year != null && reportYear != null && Number(year) < Number(reportYear))
      ? 'py_actual' : 'actual'
  }
  return snake(l) || 'unknown'
}

// "Paramount Results vs Forecast_June 2026.xlsx" -> { year: 2026, month: 6 }
function periodFromName(fileName) {
  if (!fileName) return null
  const s = String(fileName).toLowerCase()
  const y = s.match(/(20\d{2})/)
  const mi = MONTHS.findIndex(m => s.includes(m))
  if (!y || mi < 0) return null
  return { year: +y[1], month: mi + 1 }
}

// ---- one "<CC> Variance" sheet --------------------------------------------
function parseVarianceSheet(XLSX, sheet, costCenter, ctx) {
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true })
  if (!grid.length) return []

  // Locate the scenario header row: the first row in the top block that carries
  // the literal "Actual" somewhere in the value columns.
  let scRow = -1
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const r = grid[i] || []
    for (let c = 8; c < r.length; c++) {
      if (typeof r[c] === 'string' && r[c].trim() === 'Actual') { scRow = i; break }
    }
    if (scRow >= 0) break
  }
  if (scRow < 1) { ctx.warnings.push(`${costCenter}: scenario header row not found`); return [] }

  const yearRow = grid[scRow - 2] || []
  const perRow  = grid[scRow - 1] || []
  const scLine  = grid[scRow] || []

  const cols = []
  for (let c = 8; c < scLine.length; c++) {
    const lab = scLine[c]
    if (typeof lab !== 'string' || !lab.trim()) continue
    const year = yearRow[c]
    cols.push({
      c,
      scenario_label: lab.trim(),
      timeframe: timeframeOf(perRow[c]),
      scenario: scenarioOf(lab, year, ctx.reportYear),
      year,
    })
  }
  if (!cols.length) { ctx.warnings.push(`${costCenter}: no value columns found`); return [] }

  const out = []
  const seen = Object.create(null)
  for (let i = scRow + 3; i < grid.length; i++) {
    const r = grid[i] || []
    let lab = r[7]
    if (typeof lab !== 'string') continue
    lab = lab.trim()
    if (!lab) continue
    if (lab.startsWith('#') || lab.startsWith('MultiDynamic')) continue
    if (lab === 'Add Description' || lab === 'Line-Item Detail') continue

    // "3020 (Sales - 3rd Party)" -> account 3020, label "Sales - 3rd Party"
    const m = lab.match(/^(\d{4})\s*\((.*)\)\s*$/)
    const account_code = m ? m[1] : null
    const line_label = m ? m[2].trim() : lab

    // A leaf GL account is unique within a sheet; subtotal labels may repeat
    // (e.g. "Freight", "Other"), so those get a deterministic suffix.
    let key = account_code || snake(line_label)
    if (!key) continue
    seen[key] = (seen[key] || 0) + 1
    if (seen[key] > 1) key = `${key}_${seen[key]}`

    for (const col of cols) {
      const amt = r[col.c]
      if (!isNum(amt)) continue
      out.push({
        period: ctx.period,
        period_year: ctx.reportYear,
        period_month: ctx.reportMonth,
        cost_center: costCenter,
        timeframe: col.timeframe,
        scenario: col.scenario,
        scenario_label: col.scenario_label,
        line_key: key,
        line_label,
        account_code,
        amount: Math.round(amt * 100) / 100,
        source_file: ctx.fileName,
      })
    }
  }
  return out
}

// ---- main ------------------------------------------------------------------
export function parseVenaWorkbook(XLSX, workbook, opts = {}) {
  const fileName = opts.fileName || null
  const warnings = []

  const p = opts.period || periodFromName(fileName)
  if (!p) throw new Error(`Cannot determine period from file name: ${fileName}`)
  const ctx = {
    fileName,
    warnings,
    reportYear: p.year,
    reportMonth: p.month,
    period: `${p.year}-${String(p.month).padStart(2, '0')}`,
  }

  // Cost centre is taken from the sheet name, so a new one appears automatically.
  const SHEETS = []
  for (const name of workbook.SheetNames) {
    const m = String(name).match(/^(cons|\d{3})\s+variance$/i)
    if (m) SHEETS.push([name, m[1].toUpperCase()])
  }
  if (!SHEETS.length) throw new Error('No "<CC> Variance" sheets found — is this a Vena export?')

  let rows = []
  for (const [name, cc] of SHEETS) {
    rows = rows.concat(parseVarianceSheet(XLSX, workbook.Sheets[name], cc, ctx))
  }

  // De-duplicate on the table's primary key. Vena occasionally repeats a line
  // within a sheet; last value wins, and we surface the count rather than
  // letting a bulk insert fail on a constraint violation.
  const byKey = new Map()
  let dupes = 0
  for (const r of rows) {
    const k = `${r.period}|${r.cost_center}|${r.timeframe}|${r.scenario}|${r.line_key}`
    if (byKey.has(k)) dupes++
    byKey.set(k, r)
  }
  const deduped = [...byKey.values()]
  if (dupes) warnings.push(`${dupes} duplicate key rows collapsed (last value wins)`)

  const pick = (cc, key, tf = 'month', sc = 'actual') => {
    const r = deduped.find(x => x.cost_center === cc && x.line_key === key &&
                                x.timeframe === tf && x.scenario === sc)
    return r ? r.amount : null
  }
  const summary = {
    period: ctx.period,
    costCenters: [...new Set(deduped.map(r => r.cost_center))],
    timeframes: [...new Set(deduped.map(r => r.timeframe))],
    scenarios: [...new Set(deduped.map(r => r.scenario))],
    rowCount: deduped.length,
    // Headline tie-out points, month/actual. These are the figures verified by
    // hand against the June 2026 deck — if they move, something has shifted.
    check_610: {
      revenue: pick('610', 'total_revenue'),
      cogs: pick('610', 'cost_of_goods_sold_2') ?? pick('610', 'cost_of_goods_sold'),
      gross_margin: pick('610', 'gross_margin'),
      ebitdap: pick('610', 'ebitdap'),
      opex_total: pick('610', 'total_operating_expenses'),
    },
  }
  if (!deduped.length) warnings.push('No Vena rows parsed')

  return { rows: deduped, summary, period: ctx.period, fileName, warnings }
}
