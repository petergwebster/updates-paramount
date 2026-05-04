// ============================================================================
// monthlyBriefPdf.js — Render a Monthly Brief to PDF using jsPDF.
// ============================================================================
// Mirrors the April Mid-Month PDF reference EXACTLY:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ PARAMOUNT PRINTS                                  [date]        │
//   │ APRIL 2026                                                      │
//   │                                                                 │
//   │ Mid-Month Brief                                                 │
//   │ April 2026 · 2 weeks · Fiscal Q2                  April 21,2026 │
//   │ ───── gold rule ─────                                           │
//   │                                                                 │
//   │ EXECUTIVE SUMMARY                                               │
//   │ [headline paragraph]                                            │
//   │ [BNY paragraph]                                                 │
//   │ [NJ paragraph]                                                  │
//   │ [cost paragraph]                                                │
//   │                                                                 │
//   │ PRODUCTION — MONTH-TO-DATE                                      │
//   │ ┌─────────────────────────┬─────────────────────────┐           │
//   │ │ BNY — BROOKLYN DIGITAL  │ NJ — PASSAIC SCREEN PR  │           │
//   │ ├─────────────────────────┼─────────────────────────┤           │
//   │ │ PRODUCED                │ PRODUCED                │           │
//   │ │ 33,557 yds              │ 13,020 yds              │           │
//   │ │ 140% of 24,000 (green)  │ 76% of 17,220 (red)     │           │
//   │ ├─────────────────────────┼─────────────────────────┤           │
//   │ │ INVOICED YDS            │ INVOICED YDS            │           │
//   │ │ 24,302 yds              │ 9,686 yds               │           │
//   │ │ Revenue: $240,896       │ Revenue: $128,354       │           │
//   │ │                         │ · Misc: $63,141         │           │
//   │ ├─────────────────────────┼─────────────────────────┤           │
//   │ │ OPEX MTD                │ OPEX MTD                │           │
//   │ │ $49,957                 │ $11,470                 │           │
//   │ │ Inv Purchases: $134,795 │ Waste:12.6% Inv:$29,753 │           │
//   │ └─────────────────────────┴─────────────────────────┘           │
//   │                                                                 │
//   │ PRODUCTION SUMMARY — MTD TRACKING                               │
//   │ ┌─Metric─┬─NJ─┬─BNY─┬─Combined─┐                                │
//   │ │ Produced MTD ...                                              │
//   │ │ vs Target  76% of 17,220  140% of 24,000  113% of 41,220      │
//   │ │ Invoiced YDS ...                                              │
//   │ │ Revenue MTD (cream highlight)                                 │
//   │ │ OpEx MTD ...                                                  │
//   │ │ NJ Waste % ...                                                │
//   │ └────────────────────────────────────────────────────────────────┘
//   │                                                                 │
//   │ PEOPLE                          WIP SNAPSHOT                    │
//   │ Headcount: 49 total             Active: ─ orders · ─ yds        │
//   │   (13 BNY · 36 NJ)              Age: 0-30d ─  31-60d ─ ...      │
//   │                                                                 │
//   │ ─── Paramount Prints · F. Schumacher & Co. · Confidential ───   │
//   └─────────────────────────────────────────────────────────────────┘
//
// jsPDF loaded from CDN at runtime. No npm dep.
// Layout: 'pt' units, letter portrait.
// Margins: 56pt L/R, 56pt top, 48pt bottom.
// Content width: 612 - 112 = 500pt
// ============================================================================

import { format } from 'date-fns'

// Paper & Ink palette as RGB triples
const COLOR = {
  ink:      [58, 63, 69],     // primary text
  inkDeep:  [35, 39, 44],     // headers / titles
  inkSoft:  [122, 126, 133],  // secondary
  inkMid:   [88, 92, 100],    // labels
  paper:    [245, 241, 232],  // cream
  cream:    [248, 244, 233],  // lighter cream for revenue highlight
  linen:    [235, 230, 217],
  border:   [184, 187, 192],
  borderLt: [218, 220, 224],
  borderHair: [232, 232, 230],
  green:    [61, 110, 82],    // emerald
  red:      [168, 54, 44],    // crimson
  amber:    [176, 122, 45],   // amber
  forest:   [46, 80, 67],
  brick:    [107, 58, 56],
  gold:     [184, 142, 52],   // editorial accent rule under EXEC SUMMARY
  tableHead:[40, 38, 35],     // dark table header
}

// ---------------------------------------------------------------------------
// jsPDF loader — same pattern as ProductionTab.jsx generateLiveOpsPDF
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
const fmtY  = n => (n == null || isNaN(n)) ? '—' : `${Math.round(n).toLocaleString()} yds`
const money = n => (n == null || isNaN(n) || n === 0) ? '—' : '$' + Math.round(n).toLocaleString()
const moneyForce = n => (n == null || isNaN(n)) ? '$0' : '$' + Math.round(n).toLocaleString()
const pct   = n => (n == null || isNaN(n)) ? '—' : Math.round(n) + '%'
const pct1  = n => (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'

function paceColor(p) {
  if (p == null) return COLOR.inkSoft
  if (p >= 95) return COLOR.green
  if (p >= 75) return COLOR.amber
  return COLOR.red
}

// ---------------------------------------------------------------------------
// Main entry: generate the PDF and return blob OR trigger download
// ---------------------------------------------------------------------------

export async function generateMonthlyBriefPdf({ data, narrative, returnBlob = false }) {
  const JsPDF = await ensureJsPdf()
  const doc = new JsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' })

  const PAGE_W = 612
  const PAGE_H = 792
  const MX = 56                    // left/right margin
  const CW = PAGE_W - 2 * MX       // 500pt content width
  let y = 56

  const phase = data.pacing.phase
  const phaseLabel = phase === 'mid' ? 'Mid-Month Brief' : 'End-of-Month Brief'
  const monthLabel = data.pacing.monthLabel
  const monthUpper = monthLabel.toUpperCase()
  const dateStr = format(new Date(), 'MMMM d, yyyy')

  // ── HEADER ──────────────────────────────────────────────────────────
  // PARAMOUNT PRINTS crumb (left) + date (right)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...COLOR.inkSoft)
  doc.text('PARAMOUNT PRINTS', MX, y, { charSpace: 1.2 })
  doc.text(dateStr, PAGE_W - MX, y, { align: 'right' })
  y += 12

  // Period overline (e.g. "APRIL 2026")
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...COLOR.inkMid)
  doc.text(monthUpper, MX, y, { charSpace: 0.5 })
  y += 28

  // Title — Mid-Month Brief / End-of-Month Brief, serif, large
  doc.setFont('times', 'normal')
  doc.setFontSize(34)
  doc.setTextColor(...COLOR.inkDeep)
  doc.text(phaseLabel, MX, y)
  y += 16

  // Sub-line: "April 2026 · 2 weeks · Fiscal Q2"
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...COLOR.inkMid)
  const subParts = [monthLabel]
  if (phase === 'mid') subParts.push(`${data.pacing.weeksElapsed}-week mark`)
  else                 subParts.push('period closed')
  if (data.pacing.fiscalQuarter) subParts.push(`Fiscal ${data.pacing.fiscalQuarter}`)
  doc.text(subParts.join(' · '), MX, y)

  // Right-side date matches the title line height
  doc.text(dateStr, PAGE_W - MX, y, { align: 'right' })
  y += 14

  // ── EXECUTIVE SUMMARY ───────────────────────────────────────────────
  // Gold accent rule directly under the section label
  y += 10
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(...COLOR.inkMid)
  doc.text('EXECUTIVE SUMMARY', MX, y, { charSpace: 1.4 })
  y += 4
  doc.setDrawColor(...COLOR.gold)
  doc.setLineWidth(0.8)
  doc.line(MX, y, PAGE_W - MX, y)
  y += 14

  // Narrative — serif body, generous line height
  doc.setFont('times', 'normal')
  doc.setFontSize(10.5)
  doc.setTextColor(...COLOR.ink)
  const narrativeText = (narrative || '(No narrative generated.)').trim()
  // Render paragraph-by-paragraph for proper inter-paragraph spacing
  const paragraphs = narrativeText.split(/\n\s*\n/).filter(p => p.trim())
  const lineH = 14.5
  for (const para of paragraphs) {
    const wrapped = doc.splitTextToSize(para.trim(), CW)
    // Page-break safety
    if (y + wrapped.length * lineH > PAGE_H - 80) { doc.addPage(); y = 56 }
    doc.text(wrapped, MX, y, { lineHeightFactor: 1.4 })
    y += wrapped.length * lineH + 8
  }
  y += 12

  // ── PRODUCTION — MONTH-TO-DATE ──────────────────────────────────────
  if (y > PAGE_H - 280) { doc.addPage(); y = 56 }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(...COLOR.inkMid)
  doc.text('PRODUCTION — MONTH-TO-DATE', MX, y, { charSpace: 1.4 })
  y += 4
  doc.setDrawColor(...COLOR.borderHair)
  doc.setLineWidth(0.5)
  doc.line(MX, y, PAGE_W - MX, y)
  y += 16

  // Two-column site headers — "BNY — BROOKLYN DIGITAL" / "NJ — PASSAIC SCREEN PRINT"
  const colGap = 24
  const colW = (CW - colGap) / 2
  const leftX = MX
  const rightX = MX + colW + colGap

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(...COLOR.inkDeep)
  doc.text('BNY — BROOKLYN DIGITAL', leftX, y)
  doc.text('NJ — PASSAIC SCREEN PRINT', rightX, y)
  y += 16

  // Build the 3 stacked blocks per side
  const fByUnit = data.financials.byUnit || {}
  const njOpex   = fByUnit.nj?.opex || 0
  const bnyOpex  = fByUnit.bny?.opex || 0
  const njInvP   = fByUnit.nj?.invPurchases || 0
  const bnyInvP  = fByUnit.bny?.invPurchases || 0

  // Block helper:
  //   drawProdBlock(x, y, label, mainText, subText, mainColor)
  //   - label: "PRODUCED" / "INVOICED YDS" / "OPEX MTD"
  //   - mainText: "33,557 yds" / "$240,896" etc.
  //   - subText: "140% of 24,000 target" or "Revenue: $240,896" or "Inv Purchases: $134,795"
  //   - mainColor: optional accent color for the sub line (used on PRODUCED for pace %)
  //
  function drawProdBlock(x, blockY, label, mainText, subText, subColor) {
    // Label
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...COLOR.inkSoft)
    doc.text(label, x, blockY, { charSpace: 1.2 })
    // Main number
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(20)
    doc.setTextColor(...COLOR.inkDeep)
    doc.text(mainText, x, blockY + 22)
    // Subtitle
    if (subText) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(...(subColor || COLOR.inkMid))
      doc.text(subText, x, blockY + 38)
    }
  }

  const blockH = 56  // height per block (label 8 + gap + number 22 + sub 38 → ~50, +6 spacing)

  // PRODUCED row — both columns
  const bnyTargetMtd = data.targets.expectedBnyMtd
  const njTargetMtd  = data.targets.expectedNjMtd
  drawProdBlock(
    leftX, y, 'PRODUCED',
    fmtY(data.production.bnyYards),
    `${pct(data.production.bnyVsTargetPct)} of ${fmt(bnyTargetMtd)} target`,
    paceColor(data.production.bnyVsTargetPct),
  )
  drawProdBlock(
    rightX, y, 'PRODUCED',
    fmtY(data.production.njYards),
    `${pct(data.production.njVsTargetPct)} of ${fmt(njTargetMtd)} target`,
    paceColor(data.production.njVsTargetPct),
  )
  y += blockH
  // Hairline separator between row 1 and row 2
  doc.setDrawColor(...COLOR.borderHair)
  doc.setLineWidth(0.4)
  doc.line(leftX, y - 4, leftX + colW, y - 4)
  doc.line(rightX, y - 4, rightX + colW, y - 4)

  // INVOICED YDS row — revenue + misc subtitle
  const bnySubParts = [`Revenue: ${moneyForce(data.production.bnyRevenue)}`]
  if (data.production.bnyMiscRevenue > 0) bnySubParts.push(`Misc: ${money(data.production.bnyMiscRevenue)}`)
  if (data.production.bnyProcurement > 0) bnySubParts.push(`Procurement: ${money(data.production.bnyProcurement)}`)

  const njSubParts = [`Revenue: ${moneyForce(data.production.njRevenue)}`]
  if (data.production.njMiscRevenue > 0) njSubParts.push(`Misc: ${money(data.production.njMiscRevenue)}`)
  if (data.production.njProcurement > 0) njSubParts.push(`Procurement: ${money(data.production.njProcurement)}`)

  drawProdBlock(leftX,  y, 'INVOICED YDS', fmtY(data.production.bnyInvoicedYds), bnySubParts.join(' · '))
  drawProdBlock(rightX, y, 'INVOICED YDS', fmtY(data.production.njInvoicedYds),  njSubParts.join(' · '))
  y += blockH
  doc.line(leftX, y - 4, leftX + colW, y - 4)
  doc.line(rightX, y - 4, rightX + colW, y - 4)

  // OPEX MTD row — Inv Purchases for BNY, Waste % + Inv Purchases for NJ
  const bnyOpexSub = data.financials.cogsAvailable
    ? `Inv Purchases: ${money(bnyInvP)}  ·  COGS: ${money(fByUnit.bny?.cogsTotal)}`
    : `Inv Purchases: ${money(bnyInvP)}`
  const njOpexSubParts = []
  if (data.production.njWastePct != null) njOpexSubParts.push(`Waste: ${pct1(data.production.njWastePct)}`)
  njOpexSubParts.push(`Inv: ${money(njInvP)}`)
  if (data.financials.cogsAvailable && fByUnit.nj?.cogsTotal) {
    njOpexSubParts.push(`COGS: ${money(fByUnit.nj.cogsTotal)}`)
  }

  drawProdBlock(leftX,  y, 'OPEX MTD', moneyForce(bnyOpex), bnyOpexSub)
  drawProdBlock(rightX, y, 'OPEX MTD', moneyForce(njOpex),  njOpexSubParts.join(' · '))
  y += blockH + 4

  // ── PRODUCTION SUMMARY — MTD TRACKING TABLE ─────────────────────────
  if (y > PAGE_H - 220) { doc.addPage(); y = 56 }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(...COLOR.inkMid)
  doc.text('PRODUCTION SUMMARY — MTD TRACKING', MX, y, { charSpace: 1.4 })
  y += 12

  const cogsAvail = data.financials.cogsAvailable
  const njCogs  = fByUnit.nj?.cogsTotal || 0
  const bnyCogs = fByUnit.bny?.cogsTotal || 0

  // Build target text strings ("76% of 17,220")
  const njVsTargetText  = data.production.njVsTargetPct  != null ? `${pct(data.production.njVsTargetPct)} of ${fmt(njTargetMtd)}`     : '—'
  const bnyVsTargetText = data.production.bnyVsTargetPct != null ? `${pct(data.production.bnyVsTargetPct)} of ${fmt(bnyTargetMtd)}`   : '—'
  const combinedTargetMtd = bnyTargetMtd + njTargetMtd
  const combVsTargetText = data.production.combVsTargetPct != null ? `${pct(data.production.combVsTargetPct)} of ${fmt(combinedTargetMtd)}` : '—'

  const tableRows = [
    { label: 'Produced MTD',
      cells: [fmtY(data.production.njYards), fmtY(data.production.bnyYards), fmtY(data.production.combinedYards)] },
    { label: 'vs Target', subtle: true,
      cells: [njVsTargetText, bnyVsTargetText, combVsTargetText],
      cellColors: [
        paceColor(data.production.njVsTargetPct),
        paceColor(data.production.bnyVsTargetPct),
        paceColor(data.production.combVsTargetPct),
      ] },
    { label: 'Invoiced YDS',
      cells: [fmtY(data.production.njInvoicedYds), fmtY(data.production.bnyInvoicedYds), fmtY(data.production.combinedInvoicedYds)] },
    { label: 'Revenue MTD', highlight: true, bold: true,
      cells: [moneyForce(data.production.njRevenue), moneyForce(data.production.bnyRevenue), moneyForce(data.production.combinedRevenue)] },
    { label: 'OpEx MTD',
      cells: [moneyForce(njOpex), moneyForce(bnyOpex), moneyForce(data.financials.opex)] },
    { label: 'COGS MTD', pending: !cogsAvail,
      cells: cogsAvail
        ? [money(njCogs), money(bnyCogs), money(data.financials.cogsTotal)]
        : ['pending', 'pending', 'pending'] },
    { label: 'NJ Waste %', subtle: true,
      cells: [pct1(data.production.njWastePct), '—', '—'] },
  ]

  drawTable(doc, MX, y, CW, tableRows)
  y += (tableRows.length + 1) * 22 + 6

  if (!cogsAvail) {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(8)
    doc.setTextColor(...COLOR.inkSoft)
    const note = `COGS pending — ${data.financials.cogsPendingNote || 'finance releases after the 10th of next month.'}`
    doc.text(note, MX, y)
    y += 14
  }
  y += 6

  // ── PEOPLE + WIP — TWO-COLUMN ────────────────────────────────────────
  if (y > PAGE_H - 130) { doc.addPage(); y = 56 }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(...COLOR.inkMid)
  doc.text('PEOPLE',        leftX,  y, { charSpace: 1.4 })
  doc.text('WIP SNAPSHOT',  rightX, y, { charSpace: 1.4 })
  y += 14

  // PEOPLE — one-liner: "Headcount: 49 total (13 BNY · 36 NJ)"
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...COLOR.ink)
  if (data.people && data.people.bny) {
    const total = data.people.combined.headcount
    const bnyHc = data.people.bny.headcount
    const njHc  = data.people.nj.headcount
    doc.text(`Headcount: ${total} total (${bnyHc} BNY · ${njHc} NJ)`, leftX, y)
    // Optional second line — payroll if known
    if (data.people.combined.pay > 0) {
      doc.setFontSize(9)
      doc.setTextColor(...COLOR.inkSoft)
      doc.text(`Payroll MTD: ${money(data.people.combined.pay)} · BNY ${money(data.people.bny.pay)} · NJ ${money(data.people.nj.pay)}`, leftX, y + 14)
    }
  } else {
    doc.setTextColor(...COLOR.inkSoft)
    doc.text('Headcount: — total (— BNY · — NJ)', leftX, y)
  }

  // WIP SNAPSHOT — Active line + Age line + category line
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...COLOR.ink)
  if (data.wip && data.wip.available) {
    doc.text(`Active: ${data.wip.totalActive} orders · ${fmtY(data.wip.activeYards)}`, rightX, y)

    doc.setFontSize(9)
    doc.setTextColor(...COLOR.inkSoft)
    const a = data.wip.ageBuckets
    doc.text(`Age: 0-30d ${a.lt30} · 31-60d ${a.b30_60} · 61-90d ${a.b60_90} · 90d+ ${a.gt90}`, rightX, y + 14)

    // Category line
    if (Object.keys(data.wip.byProductType).length) {
      const catLine = Object.entries(data.wip.byProductType)
        .map(([k, v]) => `${capitalize(k)} ${v.count}`)
        .join(' · ')
      doc.text(catLine, rightX, y + 28)
    } else {
      doc.text('Wallpaper — · Grasscloth — · Fabric —', rightX, y + 28)
    }
  } else {
    doc.setTextColor(...COLOR.inkSoft)
    doc.text('Active: — orders · — yds', rightX, y)
    doc.setFontSize(9)
    doc.text('Age: 0-30d — · 31-60d — · 61-90d — · 90d+ —', rightX, y + 14)
    doc.text('Wallpaper — · Grasscloth — · Fabric —', rightX, y + 28)
  }
  y += 50

  // ── FOOTER ON EVERY PAGE ────────────────────────────────────────────
  const pageCount = doc.internal.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setDrawColor(...COLOR.borderHair)
    doc.setLineWidth(0.5)
    doc.line(MX, PAGE_H - 38, PAGE_W - MX, PAGE_H - 38)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...COLOR.inkSoft)
    const footerL = `Paramount Prints · F. Schumacher & Co. · ${monthLabel} — ${phaseLabel} · Confidential`
    doc.text(footerL, MX, PAGE_H - 22)
    doc.text(`${i} / ${pageCount}`, PAGE_W - MX, PAGE_H - 22, { align: 'right' })
  }

  // Filename
  const filename = `PP_${phase === 'mid' ? 'Mid_Month' : 'End_of_Month'}_${data.pacing.monthKey.replace('-', '_')}.pdf`

  if (returnBlob) return { blob: doc.output('blob'), filename }
  doc.save(filename)
  return { filename }
}

// ---------------------------------------------------------------------------
// Drawing primitive — MTD tracking table
// ---------------------------------------------------------------------------

function drawTable(doc, x, y, w, rows) {
  const headers = ['Metric', 'Paramount NJ', 'BNY Brooklyn', 'Combined']
  const firstColW = Math.round(w * 0.30)
  const otherW = Math.round((w - firstColW) / 3)
  const widths = [firstColW, otherW, otherW, otherW]
  const rowH = 22

  // Dark header bar
  doc.setFillColor(...COLOR.tableHead)
  doc.rect(x, y, w, rowH, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(255, 255, 255)
  let cx = x
  for (let c = 0; c < headers.length; c++) {
    const align = c === 0 ? 'left' : 'right'
    const tx = align === 'left' ? cx + 12 : cx + widths[c] - 12
    doc.text(headers[c].toUpperCase(), tx, y + 14, { align, charSpace: 1.0 })
    cx += widths[c]
  }

  // Data rows
  let ry = y + rowH

  rows.forEach((row, rowIdx) => {
    // Row background
    if (row.highlight) {
      // Cream highlight for Revenue MTD
      doc.setFillColor(...COLOR.cream)
      doc.rect(x, ry, w, rowH, 'F')
    } else if (row.subtle) {
      // Subtle band for vs Target / NJ Waste %
      doc.setFillColor(250, 248, 244)
      doc.rect(x, ry, w, rowH, 'F')
    }

    // Bottom hairline
    doc.setDrawColor(...COLOR.borderLt)
    doc.setLineWidth(0.4)
    doc.line(x, ry + rowH, x + w, ry + rowH)

    // Cells
    let ccx = x
    for (let c = 0; c < headers.length; c++) {
      const isLabel = c === 0
      const text = isLabel ? row.label : row.cells[c - 1]
      const align = isLabel ? 'left' : 'right'
      const tx = align === 'left' ? ccx + 12 : ccx + widths[c] - 12

      // Color/weight
      let color = COLOR.ink
      let weight = 'normal'

      if (isLabel) {
        color = COLOR.inkDeep
        weight = row.bold ? 'bold' : 'normal'
      } else if (row.cellColors && row.cellColors[c - 1]) {
        color = row.cellColors[c - 1]
        weight = 'bold'
      } else if (row.bold) {
        color = COLOR.inkDeep
        weight = 'bold'
      }

      if (row.pending) {
        color = COLOR.inkSoft
        doc.setFont('helvetica', 'italic')
      } else {
        doc.setFont('helvetica', weight)
      }

      doc.setFontSize(10)
      doc.setTextColor(...color)
      doc.text(String(text), tx, ry + 14, { align })
      ccx += widths[c]
    }

    ry += rowH
  })

  // Outer border
  doc.setDrawColor(...COLOR.border)
  doc.setLineWidth(0.5)
  doc.rect(x, y, w, (rows.length + 1) * rowH)
}

function capitalize(s) {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}
