// ============================================================================
// monthlyBriefPdf.js — Render a Monthly Brief to PDF using jsPDF.
// ============================================================================
// Mirrors the April Mid-Month PDF reference: header crumb + period,
// Executive Summary block, two-column Production MTD (BNY + NJ),
// Production Summary tracking table (6 rows × 3 cols), People line,
// WIP Snapshot, Confidential footer.
//
// Loads jsPDF from CDN at runtime — same pattern as ProductionTab.jsx's
// generateLiveOpsPDF. No npm dep.
//
// Layout uses 'pt' units, letter portrait. Margins: 48pt left/right,
// 56pt top/bottom. Page width = 612pt, content width = 516pt.
// ============================================================================

import { format } from 'date-fns'

// Paper & Ink palette colors as RGB triples for jsPDF
const COLOR = {
  ink:       [58, 63, 69],     // #3A3F45 primary text
  inkDeep:   [45, 49, 56],     // #2D3138 headers
  inkSoft:   [122, 126, 133],  // #7A7E85 secondary
  paper:     [245, 241, 232],  // #F5F1E8 cream
  linen:     [235, 230, 217],  // #EBE6D9
  border:    [184, 187, 192],  // #B8BBC0
  borderLt:  [213, 215, 218],  // #D5D7DA
  green:     [61, 110, 82],    // #3D6E52 emerald
  red:       [168, 54, 44],    // #A8362C crimson
  amber:     [176, 122, 45],   // #B07A2D amber
  forest:    [46, 80, 67],     // #2E5043 perf accent
  brick:     [107, 58, 56],    // #6B3A38 heartbeat accent
}

// ---------------------------------------------------------------------------
// jsPDF loader (matches ProductionTab.jsx pattern)
// ---------------------------------------------------------------------------

async function ensureJsPdf() {
  if (window.jspdf) return window.jspdf.jsPDF
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
  return window.jspdf.jsPDF
}

// ---------------------------------------------------------------------------
// Number formatters
// ---------------------------------------------------------------------------

const fmt   = n => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString()
const money = n => (n == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString()
const pct   = n => (n == null || isNaN(n)) ? '—' : n.toFixed(0) + '%'
const pct1  = n => (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'

// Choose color for a "% of pace" cell — green if ≥95%, amber 75-94%, red below
function paceColor(p) {
  if (p == null) return COLOR.inkSoft
  if (p >= 95) return COLOR.green
  if (p >= 75) return COLOR.amber
  return COLOR.red
}

// ---------------------------------------------------------------------------
// Main entry: generate the PDF and trigger download
// ---------------------------------------------------------------------------

export async function generateMonthlyBriefPdf({ data, narrative, returnBlob = false }) {
  const JsPDF = await ensureJsPdf()
  const doc = new JsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' })

  const PAGE_W = 612
  const PAGE_H = 792
  const MARGIN_X = 48
  const CONTENT_W = PAGE_W - 2 * MARGIN_X
  let y = 56

  const phase = data.pacing.phase
  const phaseLabel = phase === 'mid' ? 'Mid-Month Brief' : 'End-of-Month Brief'
  const monthLabel = data.pacing.monthLabel

  // ── HEADER ──────────────────────────────────────────────────────────
  // Crumb
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...COLOR.forest)
  doc.text('PARAMOUNT PRINTS · F. SCHUMACHER & CO.', MARGIN_X, y)

  doc.setTextColor(...COLOR.inkSoft)
  const dateStr = format(new Date(), 'MMMM d, yyyy')
  doc.text(dateStr, PAGE_W - MARGIN_X, y, { align: 'right' })
  y += 10

  // Title
  doc.setFont('times', 'normal')
  doc.setFontSize(28)
  doc.setTextColor(...COLOR.inkDeep)
  doc.text(phaseLabel, MARGIN_X, y + 18)

  // Period chip on right
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(...COLOR.ink)
  doc.text(monthLabel, PAGE_W - MARGIN_X, y + 8, { align: 'right' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...COLOR.inkSoft)
  const subParts = []
  if (data.pacing.fiscalQuarter) subParts.push(data.pacing.fiscalQuarter)
  subParts.push(`${data.pacing.weeksInMonth}-week month`)
  if (phase === 'mid') subParts.push(`Day ${data.pacing.daysElapsed}/${data.pacing.daysInMonth}`)
  else subParts.push('period closed')
  doc.text(subParts.join('  ·  '), PAGE_W - MARGIN_X, y + 22, { align: 'right' })

  y += 36

  // Header rule
  doc.setDrawColor(...COLOR.borderLt)
  doc.setLineWidth(0.5)
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y)
  y += 18

  // ── EXECUTIVE SUMMARY ───────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...COLOR.forest)
  doc.text('EXECUTIVE SUMMARY', MARGIN_X, y)
  y += 14

  doc.setFont('times', 'normal')
  doc.setFontSize(10.5)
  doc.setTextColor(...COLOR.ink)
  const narrativeText = (narrative || '(No narrative generated.)').trim()
  const wrapped = doc.splitTextToSize(narrativeText, CONTENT_W)
  // Line height: fontSize * lineHeightFactor ≈ 10.5 * 1.45 ≈ 15.2pt
  const lineHeight = 15.2
  doc.text(wrapped, MARGIN_X, y, { lineHeightFactor: 1.45 })
  y += wrapped.length * lineHeight + 18

  // ── PRODUCTION MTD — two-column ─────────────────────────────────────
  if (y > PAGE_H - 280) { doc.addPage(); y = 56 }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...COLOR.forest)
  doc.text('PRODUCTION MTD', MARGIN_X, y)
  y += 14

  const colW = CONTENT_W / 2 - 8
  drawSiteColumn(doc, MARGIN_X, y, colW, 'BROOKLYN (DIGITAL)', {
    'Produced': `${fmt(data.production.bnyYards)} yds`,
    '% to pace': pct(data.production.bnyVsTargetPct),
    'Target MTD': `${fmt(data.targets.expectedBnyMtd)} yds`,
    'Revenue': money(data.financials.byUnit?.BNY?.revenue),
    'OpEx': money(data.financials.byUnit?.BNY?.opex),
    'Inv. purchases': money(data.financials.byUnit?.BNY?.invPurchases),
  }, paceColor(data.production.bnyVsTargetPct))

  drawSiteColumn(doc, MARGIN_X + colW + 16, y, colW, 'PASSAIC (HAND-SCREEN)', {
    'Produced': `${fmt(data.production.njYards)} yds`,
    '% to pace': pct(data.production.njVsTargetPct),
    'Color-yards': fmt(data.production.njColorYards),
    'Waste %': pct1(data.production.njWastePct),
    'Revenue': money(data.financials.byUnit?.NJ?.revenue || data.financials.byUnit?.Passaic?.revenue),
    'OpEx': money(data.financials.byUnit?.NJ?.opex || data.financials.byUnit?.Passaic?.opex),
  }, paceColor(data.production.njVsTargetPct))

  y += 124

  // ── PRODUCTION SUMMARY — MTD TRACKING TABLE ─────────────────────────
  if (y > PAGE_H - 200) { doc.addPage(); y = 56 }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...COLOR.forest)
  doc.text('MTD TRACKING — NJ · BNY · COMBINED', MARGIN_X, y)
  y += 14

  const cogsAvail = data.financials.cogsAvailable
  const fByUnit = data.financials.byUnit || {}
  const njRev = fByUnit.NJ?.revenue || fByUnit.Passaic?.revenue || 0
  const bnyRev = fByUnit.BNY?.revenue || 0
  const njOpex = fByUnit.NJ?.opex || fByUnit.Passaic?.opex || 0
  const bnyOpex = fByUnit.BNY?.opex || 0
  const njCogs = fByUnit.NJ?.cogsTotal || fByUnit.Passaic?.cogsTotal || 0
  const bnyCogs = fByUnit.BNY?.cogsTotal || 0

  const tableRows = [
    ['Produced MTD',
      `${fmt(data.production.njYards)} yds`,
      `${fmt(data.production.bnyYards)} yds`,
      `${fmt(data.production.combinedYards)} yds`],
    ['vs Target',
      pct(data.production.njVsTargetPct),
      pct(data.production.bnyVsTargetPct),
      pct(data.production.combVsTargetPct)],
    ['Revenue MTD',
      money(njRev),
      money(bnyRev),
      money(data.financials.revenue)],
    ['OpEx MTD',
      money(njOpex),
      money(bnyOpex),
      money(data.financials.opex)],
    ['COGS MTD',
      cogsAvail ? money(njCogs) : 'pending',
      cogsAvail ? money(bnyCogs) : 'pending',
      cogsAvail ? money(data.financials.cogsTotal) : 'pending'],
    ['Inv. Purchases',
      money(fByUnit.NJ?.invPurchases || fByUnit.Passaic?.invPurchases),
      money(fByUnit.BNY?.invPurchases),
      money(data.financials.invPurchases)],
    ['NJ Waste %',
      pct1(data.production.njWastePct),
      '—',
      pct1(data.production.njWastePct)],
  ]

  drawTable(doc, MARGIN_X, y, CONTENT_W, ['Metric', 'NJ', 'BNY', 'Combined'], tableRows, {
    paceColCheck: (rowIdx, colIdx) => rowIdx === 1 && colIdx > 0,  // color-code "vs Target" row
    paceCellValue: (rowIdx, colIdx) => {
      if (rowIdx !== 1) return null
      return [
        null,
        data.production.njVsTargetPct,
        data.production.bnyVsTargetPct,
        data.production.combVsTargetPct,
      ][colIdx]
    },
    pendingCells: cogsAvail ? null : [{ row: 4, cols: [1, 2, 3] }], // grey out COGS row
  })

  y += (tableRows.length + 1) * 18 + 8

  if (!cogsAvail) {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(8)
    doc.setTextColor(...COLOR.inkSoft)
    const note = `COGS pending — ${data.financials.cogsPendingNote || 'finance releases after the 10th of next month.'}`
    doc.text(note, MARGIN_X, y)
    y += 14
  }
  y += 8

  // ── PEOPLE ──────────────────────────────────────────────────────────
  if (data.people && data.people.bny) {
    if (y > PAGE_H - 90) { doc.addPage(); y = 56 }

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...COLOR.forest)
    doc.text('PEOPLE', MARGIN_X, y)
    y += 14

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(...COLOR.ink)
    const peopleParts = [
      `BNY ${data.people.bny.headcount} active · ${fmt(data.people.bny.hours)} hrs · ${money(data.people.bny.pay)}`,
      `Passaic ${data.people.nj.headcount} active · ${fmt(data.people.nj.hours)} hrs · ${money(data.people.nj.pay)}`,
      `Combined ${data.people.combined.headcount} headcount · ${money(data.people.combined.pay)} payroll MTD`,
    ]
    for (const line of peopleParts) {
      doc.text(line, MARGIN_X, y)
      y += 13
    }
    y += 8
  }

  // ── WIP SNAPSHOT ────────────────────────────────────────────────────
  if (data.wip && data.wip.available) {
    if (y > PAGE_H - 110) { doc.addPage(); y = 56 }

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...COLOR.forest)
    doc.text('WIP SNAPSHOT', MARGIN_X, y)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...COLOR.inkSoft)
    if (data.wip.snapshotAt) {
      doc.text(`as of ${format(new Date(data.wip.snapshotAt), 'MMM d')}`, PAGE_W - MARGIN_X, y, { align: 'right' })
    }
    y += 14

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(...COLOR.ink)
    doc.text(`Active orders: ${data.wip.totalActive} · ${fmt(data.wip.activeYards)} yards · ${fmt(data.wip.activeColorYards)} color-yards`, MARGIN_X, y)
    y += 13
    const a = data.wip.ageBuckets
    doc.text(`Age: <30d ${a.lt30} · 30-60d ${a.b30_60} · 60-90d ${a.b60_90} · 90+d ${a.gt90}`, MARGIN_X, y)
    y += 13

    if (Object.keys(data.wip.byProductType).length) {
      const cats = Object.entries(data.wip.byProductType)
        .map(([k, v]) => `${k}: ${v.count} (${fmt(v.yards)} yds)`)
        .join('  ·  ')
      doc.text('By category: ' + cats, MARGIN_X, y)
      y += 13
    }
    if (data.wip.newGoodsActive) {
      doc.text(`NEW Goods active: ${data.wip.newGoodsActive}`, MARGIN_X, y)
      y += 13
    }
    y += 8
  }

  // ── FOOTER on every page ────────────────────────────────────────────
  const pageCount = doc.internal.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setDrawColor(...COLOR.borderLt)
    doc.setLineWidth(0.5)
    doc.line(MARGIN_X, PAGE_H - 36, PAGE_W - MARGIN_X, PAGE_H - 36)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...COLOR.inkSoft)
    const footer = `Paramount Prints · F. Schumacher & Co. · ${monthLabel} — ${phaseLabel} · Confidential`
    doc.text(footer, MARGIN_X, PAGE_H - 22)
    doc.text(`${i} / ${pageCount}`, PAGE_W - MARGIN_X, PAGE_H - 22, { align: 'right' })
  }

  // Filename
  const filename = `PP_${phase === 'mid' ? 'Mid_Month' : 'End_of_Month'}_${data.pacing.monthKey.replace('-', '_')}.pdf`

  if (returnBlob) {
    return { blob: doc.output('blob'), filename }
  }
  doc.save(filename)
  return { filename }
}

// ---------------------------------------------------------------------------
// Helpers — drawing primitives
// ---------------------------------------------------------------------------

function drawSiteColumn(doc, x, y, w, title, kvPairs, accentColor) {
  // Card background
  doc.setFillColor(255, 255, 255)
  doc.setDrawColor(...COLOR.borderLt)
  doc.setLineWidth(0.5)
  doc.roundedRect(x, y, w, 110, 4, 4, 'FD')

  // Top accent stripe
  doc.setFillColor(...accentColor)
  doc.rect(x, y, w, 3, 'F')

  // Title
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...COLOR.inkDeep)
  doc.text(title, x + 12, y + 18)

  // Key-value rows
  doc.setFontSize(9)
  let row = 0
  const entries = Object.entries(kvPairs)
  for (const [k, v] of entries) {
    const ry = y + 32 + row * 13
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...COLOR.inkSoft)
    doc.text(k, x + 12, ry)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...COLOR.ink)
    doc.text(String(v), x + w - 12, ry, { align: 'right' })
    row++
  }
}

function drawTable(doc, x, y, w, headers, rows, opts = {}) {
  const colCount = headers.length
  const firstColW = Math.round(w * 0.34)
  const otherW = Math.round((w - firstColW) / (colCount - 1))
  const widths = [firstColW, ...Array(colCount - 1).fill(otherW)]
  const rowH = 18

  // Header row
  doc.setFillColor(...COLOR.linen)
  doc.rect(x, y, w, rowH, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...COLOR.inkDeep)
  let cx = x
  for (let c = 0; c < colCount; c++) {
    const align = c === 0 ? 'left' : 'right'
    const tx = align === 'left' ? cx + 8 : cx + widths[c] - 8
    doc.text(headers[c].toUpperCase(), tx, y + 12, { align })
    cx += widths[c]
  }

  // Data rows
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  let ry = y + rowH

  rows.forEach((row, rowIdx) => {
    // Zebra stripe
    if (rowIdx % 2 === 0) {
      doc.setFillColor(250, 248, 244)
      doc.rect(x, ry, w, rowH, 'F')
    }

    // Bottom border
    doc.setDrawColor(...COLOR.borderLt)
    doc.setLineWidth(0.3)
    doc.line(x, ry + rowH, x + w, ry + rowH)

    let ccx = x
    for (let c = 0; c < colCount; c++) {
      const cellText = String(row[c])
      const align = c === 0 ? 'left' : 'right'
      const tx = align === 'left' ? ccx + 8 : ccx + widths[c] - 8

      // Color logic
      let color = COLOR.ink
      let weight = 'normal'

      if (c === 0) {
        color = COLOR.inkDeep
        weight = 'bold'
      } else if (opts.paceColCheck && opts.paceColCheck(rowIdx, c)) {
        const v = opts.paceCellValue(rowIdx, c)
        color = paceColor(v)
        weight = 'bold'
      }

      // Pending cells render in lighter italic grey
      const isPending = opts.pendingCells?.some(p => p.row === rowIdx && p.cols.includes(c))
      if (isPending) {
        color = COLOR.inkSoft
        doc.setFont('helvetica', 'italic')
      } else {
        doc.setFont('helvetica', weight)
      }

      doc.setTextColor(...color)
      doc.text(cellText, tx, ry + 12, { align })
      ccx += widths[c]
    }

    ry += rowH
  })

  // Outer border
  doc.setDrawColor(...COLOR.border)
  doc.setLineWidth(0.5)
  doc.rect(x, y, w, (rows.length + 1) * rowH)
}
