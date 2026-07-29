// src/lib/payrollWorkbook.js
// ===========================================================================
// Parses the weekly UKG "Earnings Pay History" export into one people_weekly
// row. Used by sharefile-sync (server-side, via the ShareFile API) — there is
// deliberately NO browser upload path for payroll.
//
// WHY CONTENT, NEVER FILENAME. The folder's naming has four different
// conventions and at least one outright lie: "Week of 7.22" contains the
// pay run whose Period Control Date is 2026-07-02 (the July 4th week),
// because the name records when Peter saved it, not what it covers. The
// Period Control Date column is on every employee row and is the only
// trustworthy period signal.
//
// WEEK KEY — CONFIRMED WITH PETER 2026-07-28. The report is processed on
// Wednesday and ALWAYS covers the full PRIOR week, Sunday through Saturday
// (FSCO runs 4-4-5; the dashboard week is Sun–Sat everywhere). The Period
// Control Date is the PAY DATE — the Friday ~6 days AFTER the covered week
// ends — not a date inside the covered week. So:
//   week_start = sundayOnOrBefore(controlDate) - 7 days
// e.g. control date Fri 2026-07-24 → covered week Sun 7/12 – Sat 7/18
// → week_start 2026-07-12, matching the file's own "WE 7.18" name.
// The first version omitted the -7 and filed every week one week late —
// caught because the "Week of 6.14" file landed on 6/21 while the hand-keyed
// entry for the SAME numbers sat on 6/14. A shifted pay date (e.g. Thu 7/02
// when Fri 7/03 was the observed July-4th holiday) still resolves correctly,
// because sundayOnOrBefore() only cares which Sun–Sat window the pay date
// falls in. This conversion lives HERE, in one place — the Sunday/Monday
// date-key trap took 12 commits to unwind when it was scattered.
//
// COLUMNS ARE DISCOVERED, NOT FIXED. Row 2 carries earnings-type labels (OT,
// PTO, REG — and sometimes GTL, group term life) each spanning an
// amount+hours pair; row 3 confirms with "Current Amount"/"Current Hours".
// The 7.18 file has three earnings blocks, the 7.22 file has four, and the
// pair positions shift accordingly. Hardcoding positions from one file would
// have read GTL dollars as OT dollars in the other. Unknown blocks (GTL
// today, whatever UKG adds tomorrow) are parsed, reported in warnings, and
// deliberately NOT folded into reg/ot/pto — GTL is imputed income, not hours
// worked.
//
// SITES. Org Level 1 is the cost centre: 610 -> nj, 609 -> bny. 612
// (corporate/admin) appears occasionally and is EXCLUDED from both site
// buckets — people_weekly models plant labour — but counted in warnings so
// the hours don't vanish silently. Blank org levels likewise.
//
// SELF-CHECK. The sheet ends with a "Total" row. We sum employee rows and
// require our total-amount and total-hours to match the file's own Total to
// within a dollar/an hour, else refuse. Same principle as the Vena 610
// check and the lift-wip completeness guard: a parse that cannot prove
// itself does not get to write.
// ===========================================================================

const num = (v) => {
  if (v == null || v === '') return 0
  const n = Number(String(v).replace(/[,$\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

// Sunday on-or-before a date, in UTC to dodge TZ off-by-ones.
function sundayOnOrBefore(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay())
  return dt.toISOString().slice(0, 10)
}

function parseControlDate(v) {
  if (v instanceof Date) return v
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return null
}

export function parsePayrollWorkbook(XLSX, workbook, opts = {}) {
  const warnings = []
  const ws = workbook.Sheets[workbook.SheetNames[0]]
  if (!ws) throw new Error('Payroll workbook has no sheets')
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

  // ── discover the earnings blocks from row 2 ──────────────────────────────
  // Each label sits over an amount column; hours is the column to its right,
  // confirmed by row 3 reading "Current Amount"/"Current Hours". "Total
  // Amount"/"Total Hours" are the row-level totals, not an earnings block.
  const labelRow = rows[1] || []
  const subRow = rows[2] || []
  const blocks = []   // { key, amountCol, hoursCol }
  let totalAmountCol = -1, totalHoursCol = -1
  for (let c = 0; c < labelRow.length; c++) {
    const raw = labelRow[c]
    if (typeof raw !== 'string' || !raw.trim()) continue
    const label = raw.trim().toUpperCase()
    if (label === 'TOTAL AMOUNT') { totalAmountCol = c; continue }
    if (label === 'TOTAL HOURS') { totalHoursCol = c; continue }
    const subOk = /current\s*amount/i.test(String(subRow[c] || ''))
    if (!subOk) continue
    blocks.push({ key: label.replace(/\s+/g, ''), amountCol: c, hoursCol: c + 1 })
  }
  if (!blocks.length || totalAmountCol < 0) {
    throw new Error('Payroll sheet shape not recognised — no earnings blocks under row 2')
  }
  const known = new Set(['REG', 'OT', 'PTO', 'HOL'])
  for (const b of blocks) {
    if (!known.has(b.key)) warnings.push(`unrecognised earnings type "${b.key}" parsed but not mapped into reg/ot/pto/hol`)
  }

  // ── locate the employee header row ───────────────────────────────────────
  const hdrIdx = rows.findIndex(r => r && r.some(c => typeof c === 'string' && c.includes('Employee Name')))
  if (hdrIdx < 0) throw new Error('No "Employee Name" header row found')
  const hdr = rows[hdrIdx]
  const col = (name) => hdr.findIndex(c => typeof c === 'string' && c.trim().toLowerCase().includes(name))
  const NAME = col('employee name'), DATE = col('period control date'), ORG = col('org level 1')
  if (NAME < 0 || DATE < 0 || ORG < 0) throw new Error('Employee header row missing expected columns')

  // ── walk employee rows ───────────────────────────────────────────────────
  const mk = () => ({ headcount: 0, reg_hrs: 0, ot_hrs: 0, pto_hrs: 0, hol_hrs: 0,
                      reg_pay: 0, ot_pay: 0, pto_pay: 0, hol_pay: 0, total_pay: 0, total_hrs: 0 })
  const site = { nj: mk(), bny: mk() }
  const employees = []
  let excluded612 = 0, excludedBlank = 0, controlDate = null
  let sumAmount = 0, sumHours = 0
  let fileTotalAmount = null, fileTotalHours = null

  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r) continue
    const first = String(r[0] || '').trim()
    const name = r[NAME] ? String(r[NAME]).trim() : ''

    // The sheet ends with TWO Total rows — UKG prints a group total with the
    // label in the EMPLOYEE NAME column, then a report total with the label
    // in column A. The first version of this parser only checked column A,
    // so the group-total row sailed through the name filter as an extra
    // "employee" called Total and DOUBLED every number — caught by the
    // self-check on both test files (80,596.54 parsed vs the sheet's own
    // 40,298.27). Match the label in either column, and require a Period
    // Control Date on anything treated as an employee: every real row
    // carries one, no total or footer row does.
    if (/^total$/i.test(first) || /^total$/i.test(name)) {
      fileTotalAmount = num(r[totalAmountCol])
      fileTotalHours = num(r[totalHoursCol])
      break
    }
    if (!name) continue

    const cd = parseControlDate(r[DATE])
    if (!cd) {
      warnings.push(`row ${i + 1} ("${name.slice(0, 30)}") has no Period Control Date — skipped, not an employee row`)
      continue
    }
    if (!controlDate) controlDate = cd
    if (cd.getTime() !== controlDate.getTime()) {
      warnings.push(`mixed Period Control Dates in one file (${cd.toISOString().slice(0,10)} vs ${controlDate.toISOString().slice(0,10)})`)
    }

    const org = String(r[ORG] || '').trim()
    const bucket = org === '610' ? 'nj' : org === '609' ? 'bny' : null
    const rowTotalAmt = num(r[totalAmountCol])
    const rowTotalHrs = num(r[totalHoursCol])
    sumAmount += rowTotalAmt
    sumHours += rowTotalHrs

    if (!bucket) {
      if (org === '612') excluded612++
      else excludedBlank++
      continue
    }

    const s = site[bucket]
    s.headcount++
    s.total_pay += rowTotalAmt
    s.total_hrs += rowTotalHrs
    const emp = { name, org, total_pay: rowTotalAmt, total_hrs: rowTotalHrs }
    for (const b of blocks) {
      const amt = num(r[b.amountCol]), hrs = num(r[b.hoursCol])
      if (b.key === 'REG') { s.reg_hrs += hrs; s.reg_pay += amt; emp.reg_hrs = hrs }
      else if (b.key === 'OT') { s.ot_hrs += hrs; s.ot_pay += amt; emp.ot_hrs = hrs }
      else if (b.key === 'PTO') { s.pto_hrs += hrs; s.pto_pay += amt; emp.pto_hrs = hrs }
      else if (b.key === 'HOL') { s.hol_hrs += hrs; s.hol_pay += amt; emp.hol_hrs = hrs }
      // unknown blocks (e.g. GTL): included in row totals by the file itself,
      // deliberately not attributed to any hours bucket.
    }
    employees.push(emp)
  }

  if (!controlDate) throw new Error('No Period Control Date found in any employee row')

  // ── self-check against the sheet's own Total row ─────────────────────────
  if (fileTotalAmount != null) {
    if (Math.abs(sumAmount - fileTotalAmount) > 1.0) {
      throw new Error(`Parsed pay ${sumAmount.toFixed(2)} != sheet Total ${fileTotalAmount.toFixed(2)} — refusing to write`)
    }
    if (Math.abs(sumHours - fileTotalHours) > 1.0) {
      throw new Error(`Parsed hours ${sumHours.toFixed(2)} != sheet Total ${fileTotalHours.toFixed(2)} — refusing to write`)
    }
  } else {
    warnings.push('no Total row found — file self-check skipped')
  }

  if (excluded612) warnings.push(`${excluded612} employee(s) in org 612 (corporate) excluded from site buckets`)
  if (excludedBlank) warnings.push(`${excludedBlank} employee(s) with blank Org Level 1 excluded`)

  // Pay date → covered week: the Sunday of the pay-date's week, minus one
  // full week (see WEEK KEY note at top).
  const payWeekSunday = new Date(sundayOnOrBefore(controlDate) + 'T00:00:00Z')
  payWeekSunday.setUTCDate(payWeekSunday.getUTCDate() - 7)
  const weekStart = payWeekSunday.toISOString().slice(0, 10)

  return {
    weekStart,
    periodControlDate: controlDate.toISOString().slice(0, 10),
    // Exactly the columns the feed OWNS in people_weekly. The write must be a
    // PATCH of these keys only — the table also carries Wendy's HR entries
    // (hires, exits, leaves, notes) which a payroll file knows nothing about
    // and must never null out.
    fields: {
      period_control_date: controlDate.toISOString().slice(0, 10),
      nj_headcount: site.nj.headcount, nj_reg_hrs: site.nj.reg_hrs, nj_ot_hrs: site.nj.ot_hrs,
      nj_pto_hrs: site.nj.pto_hrs, nj_hol_hrs: site.nj.hol_hrs, nj_hol_pay: site.nj.hol_pay,
      nj_total_hrs: site.nj.total_hrs, nj_total_pay: site.nj.total_pay,
      bny_headcount: site.bny.headcount, bny_reg_hrs: site.bny.reg_hrs, bny_ot_hrs: site.bny.ot_hrs,
      bny_pto_hrs: site.bny.pto_hrs, bny_hol_hrs: site.bny.hol_hrs, bny_hol_pay: site.bny.hol_pay,
      bny_total_hrs: site.bny.total_hrs, bny_total_pay: site.bny.total_pay,
      employees,
    },
    summary: {
      employees: employees.length,
      nj: site.nj.headcount, bny: site.bny.headcount,
      excluded_612: excluded612, excluded_blank: excludedBlank,
      total_pay: Math.round(sumAmount * 100) / 100,
      total_hrs: Math.round(sumHours * 100) / 100,
    },
    warnings: warnings.length ? warnings : null,
  }
}
