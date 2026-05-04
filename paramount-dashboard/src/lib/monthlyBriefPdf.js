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

  // ── HERO KPI STRIP ──────────────────────────────────────────────────
  // Four stat cells across the top — at-a-glance summary above the prose.
  y += 14
  drawHeroKpiStrip(doc, MX, y, CW, data)
  y += 64

  // ── EXECUTIVE SUMMARY ───────────────────────────────────────────────
  // Gold accent rule directly under the section label
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
  //   drawProdBlock(x, y, label, mainText, subText, mainColor, options)
  //   - label: "PRODUCED" / "INVOICED YDS" / "OPEX MTD"
  //   - mainText: "33,557 yds" / "$240,896" etc.
  //   - subText: subtitle string OR array of [{ text, color, italic }]
  //   - subColor: accent color when subText is a single string
  //   - options.paceBar: { pct } to draw a thin colored pace bar below
  //
  function drawProdBlock(x, blockY, label, mainText, subText, subColor, options = {}) {
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
    // Subtitle — supports string OR array of {text,color,italic}
    let cursorY = blockY + 38
    if (Array.isArray(subText)) {
      for (const line of subText) {
        if (!line || !line.text) continue
        doc.setFont('helvetica', line.italic ? 'italic' : 'normal')
        doc.setFontSize(line.italic ? 8.5 : 9)
        doc.setTextColor(...(line.color || COLOR.inkMid))
        doc.text(line.text, x, cursorY)
        cursorY += line.italic ? 10 : 12
      }
    } else if (subText) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(...(subColor || COLOR.inkMid))
      doc.text(subText, x, cursorY)
      cursorY += 12
    }
    // Optional pace bar — thin horizontal indicator showing % to target
    if (options.paceBar && options.paceBar.pct != null) {
      const barY = cursorY
      const barW = 110
      const barH = 3
      const pct = options.paceBar.pct
      const fillW = Math.min(barW, Math.max(2, (pct / 100) * barW * 0.9)) // cap at ~111% visually
      // Background track
      doc.setFillColor(...COLOR.borderHair)
      doc.rect(x, barY, barW, barH, 'F')
      // Fill — pace-colored
      doc.setFillColor(...paceColor(pct))
      doc.rect(x, barY, fillW, barH, 'F')
      // Target tick at 100%
      const tickX = x + (barW * 0.9)
      doc.setDrawColor(...COLOR.inkSoft)
      doc.setLineWidth(0.4)
      doc.line(tickX, barY - 1, tickX, barY + barH + 1)
    }
  }

  const blockH = 64  // height per block — accommodates pace bar on PRODUCED row

  // PRODUCED row — both columns, with thin pace bar
  const bnyTargetMtd = data.targets.expectedBnyMtd
  const njTargetMtd  = data.targets.expectedNjMtd
  drawProdBlock(
    leftX, y, 'PRODUCED',
    fmtY(data.production.bnyYards),
    `${pct(data.production.bnyVsTargetPct)} of ${fmt(bnyTargetMtd)} target`,
    paceColor(data.production.bnyVsTargetPct),
    { paceBar: { pct: data.production.bnyVsTargetPct } },
  )
  drawProdBlock(
    rightX, y, 'PRODUCED',
    fmtY(data.production.njYards),
    `${pct(data.production.njVsTargetPct)} of ${fmt(njTargetMtd)} target`,
    paceColor(data.production.njVsTargetPct),
    { paceBar: { pct: data.production.njVsTargetPct } },
  )
  y += blockH
  // Hairline separator between PRODUCED and INVOICED YDS
  doc.setDrawColor(...COLOR.borderHair)
  doc.setLineWidth(0.4)
  doc.line(leftX, y - 4, leftX + colW, y - 4)
  doc.line(rightX, y - 4, rightX + colW, y - 4)
  // Hairline separator between row 1 and row 2
  doc.setDrawColor(...COLOR.borderHair)
  doc.setLineWidth(0.4)
  doc.line(leftX, y - 4, leftX + colW, y - 4)
  doc.line(rightX, y - 4, rightX + colW, y - 4)

  // INVOICED YDS row — operating revenue on line 1, procurement italic on line 2
  function buildInvoicedSubLines(operatingRev, miscRev, procurement) {
    const lines = []
    // Line 1: operating revenue (revenue + misc)
    if (miscRev > 0) {
      lines.push({ text: `Revenue: ${moneyForce(operatingRev - miscRev)}  ·  Misc: ${money(miscRev)}` })
    } else {
      lines.push({ text: `Revenue: ${moneyForce(operatingRev)}` })
    }
    // Line 2: procurement (italic, dimmed) — only if present
    if (procurement > 0) {
      lines.push({
        text: `Procurement: ${money(procurement)} (pass-through)`,
        italic: true,
        color: COLOR.inkSoft,
      })
    }
    return lines
  }

  drawProdBlock(
    leftX, y, 'INVOICED YDS',
    fmtY(data.production.bnyInvoicedYds),
    buildInvoicedSubLines(
      data.production.bnyOperatingRevenue,
      data.production.bnyMiscRevenue,
      data.production.bnyProcurement,
    ),
  )
  drawProdBlock(
    rightX, y, 'INVOICED YDS',
    fmtY(data.production.njInvoicedYds),
    buildInvoicedSubLines(
      data.production.njOperatingRevenue,
      data.production.njMiscRevenue,
      data.production.njProcurement,
    ),
  )
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
    { label: 'Revenue MTD (operating)', highlight: true, bold: true,
      cells: [moneyForce(data.production.njOperatingRevenue), moneyForce(data.production.bnyOperatingRevenue), moneyForce(data.production.combinedOperatingRevenue)] },
    { label: 'Procurement (pass-through)', italic: true, subtle: true,
      cells: [
        data.production.njProcurement > 0  ? money(data.production.njProcurement)  : '—',
        data.production.bnyProcurement > 0 ? money(data.production.bnyProcurement) : '—',
        data.production.combinedProcurement > 0 ? money(data.production.combinedProcurement) : '—',
      ] },
    { label: 'Total Inflows (vs budget)', bold: true, totalRow: true,
      cells: [moneyForce(data.production.njTotalInflows), moneyForce(data.production.bnyTotalInflows), moneyForce(data.production.combinedTotalInflows)] },
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
    } else if (row.totalRow) {
      // Subtle linen band + thicker top border for Total Inflows
      doc.setFillColor(...COLOR.linen)
      doc.rect(x, ry, w, rowH, 'F')
      doc.setDrawColor(...COLOR.border)
      doc.setLineWidth(0.8)
      doc.line(x, ry, x + w, ry)
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
        color = row.italic ? COLOR.inkSoft : COLOR.inkDeep
        weight = row.bold ? 'bold' : 'normal'
      } else if (row.cellColors && row.cellColors[c - 1]) {
        color = row.cellColors[c - 1]
        weight = 'bold'
      } else if (row.bold) {
        color = COLOR.inkDeep
        weight = 'bold'
      } else if (row.italic) {
        color = COLOR.inkSoft
      }

      if (row.pending) {
        color = COLOR.inkSoft
        doc.setFont('helvetica', 'italic')
      } else if (row.italic) {
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

// ---------------------------------------------------------------------------
// Hero KPI strip — at-a-glance summary above the executive summary
// ---------------------------------------------------------------------------
// Four equal-width cells:
//   1. PRODUCTION  — combined yards / % to pace, color-coded
//   2. REVENUE     — combined operating revenue (rev + misc, NOT procurement)
//   3. OPEX        — combined OpEx
//   4. HEADCOUNT   — total active people
// ---------------------------------------------------------------------------

function drawHeroKpiStrip(doc, x, y, w, data) {
  const cellGap = 12
  const cellW = (w - cellGap * 3) / 4
  const cellH = 56

  const cells = [
    {
      label: 'PRODUCTION',
      main: data.production.combinedYards != null ? Math.round(data.production.combinedYards).toLocaleString() : '—',
      sub: data.production.combVsTargetPct != null
        ? `${Math.round(data.production.combVsTargetPct)}% of pace`
        : 'pace n/a',
      subColor: paceColor(data.production.combVsTargetPct),
      unit: 'yds',
    },
    {
      label: 'OPERATING REVENUE',
      main: data.production.combinedOperatingRevenue != null
        ? '$' + Math.round(data.production.combinedOperatingRevenue).toLocaleString()
        : '—',
      sub: data.production.combinedProcurement > 0
        ? `+ $${Math.round(data.production.combinedProcurement).toLocaleString()} pass-through`
        : 'no pass-through',
      subColor: COLOR.inkSoft,
      subItalic: data.production.combinedProcurement > 0,
    },
    {
      label: 'OPEX MTD',
      main: data.financials.opex != null
        ? '$' + Math.round(data.financials.opex).toLocaleString()
        : '—',
      sub: data.financials.invPurchases > 0
        ? `+ $${Math.round(data.financials.invPurchases).toLocaleString()} inv purch`
        : 'no inv purch',
      subColor: COLOR.inkSoft,
    },
    {
      label: 'HEADCOUNT',
      main: data.people?.combined?.headcount ? String(data.people.combined.headcount) : '—',
      sub: data.people?.bny && data.people?.nj
        ? `${data.people.bny.headcount} BNY · ${data.people.nj.headcount} NJ`
        : '— BNY · — NJ',
      subColor: COLOR.inkSoft,
    },
  ]

  for (let i = 0; i < cells.length; i++) {
    const cx = x + i * (cellW + cellGap)
    const cell = cells[i]

    // Card background — subtle paper tone
    doc.setFillColor(...COLOR.paper)
    doc.setDrawColor(...COLOR.borderLt)
    doc.setLineWidth(0.5)
    doc.roundedRect(cx, y, cellW, cellH, 3, 3, 'FD')

    // Label
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    doc.setTextColor(...COLOR.inkSoft)
    doc.text(cell.label, cx + 12, y + 14, { charSpace: 1.2 })

    // Main number
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(18)
    doc.setTextColor(...COLOR.inkDeep)
    let mainText = cell.main
    if (cell.unit) {
      // Render number then small unit label
      doc.text(mainText, cx + 12, y + 34)
      const numW = doc.getTextWidth(mainText)
      doc.setFontSize(10)
      doc.setTextColor(...COLOR.inkSoft)
      doc.text(cell.unit, cx + 12 + numW + 3, y + 34)
    } else {
      doc.text(mainText, cx + 12, y + 34)
    }

    // Sub
    doc.setFont('helvetica', cell.subItalic ? 'italic' : 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(...(cell.subColor || COLOR.inkSoft))
    doc.text(cell.sub, cx + 12, y + 48)
  }
}
