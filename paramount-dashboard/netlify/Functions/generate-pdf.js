const PDFDocument = require('pdfkit')

// Colors
const INK       = '#2C2420'
const GOLD      = '#D4A843'
const CREAM_DK  = '#F2EDE4'
const BORDER    = '#DDD4C8'
const INK_LIGHT = '#9C8F87'
const GREEN     = '#15803d'
const AMBER     = '#b45309'
const RED       = '#b91c1c'

function pctColor(p) {
  if (p == null) return INK_LIGHT
  if (p >= 95) return GREEN
  if (p >= 80) return AMBER
  return RED
}

function fmt(v) {
  if (!v && v !== 0) return '—'
  if (typeof v === 'string') return v
  return '$' + Math.round(v).toLocaleString()
}

function generatePDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 43, info: { Title: data.report_title } })
    const chunks = []
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const PW = doc.page.width - 86   // usable width
    const L  = 43                     // left margin
    const MID = L + PW / 2

    // ── HEADER ──────────────────────────────────────────────────────────────
    doc.fontSize(7).fillColor(INK_LIGHT).font('Helvetica')
       .text('PARAMOUNT PRINTS', L, 43, { characterSpacing: 1.5 })

    doc.fontSize(20).fillColor(INK).font('Helvetica-Bold')
       .text(data.report_title, L, 54)

    doc.fontSize(9).fillColor(INK_LIGHT).font('Helvetica')
       .text(data.period_label, L, 79)
       .text(data.date_generated, L, 79, { align: 'right', width: PW })

    // Gold rule
    doc.moveTo(L, 95).lineTo(L + PW, 95).lineWidth(2).strokeColor(GOLD).stroke()

    // ── NARRATIVE ────────────────────────────────────────────────────────────
    let y = 103
    doc.fontSize(7).fillColor(INK_LIGHT).font('Helvetica')
       .text('EXECUTIVE SUMMARY', L, y, { characterSpacing: 1.5 })
    y += 13

    const paras = data.narrative.split('\n\n').filter(p => p.trim())
    paras.forEach(para => {
      doc.fontSize(9.5).fillColor(INK).font('Helvetica')
         .text(para.trim(), L, y, { width: PW, lineGap: 2 })
      y = doc.y + 6
    })

    // thin rule
    y += 4
    doc.moveTo(L, y).lineTo(L + PW, y).lineWidth(0.5).strokeColor(BORDER).stroke()
    y += 8

    // ── PRODUCTION ───────────────────────────────────────────────────────────
    doc.fontSize(7).fillColor(INK_LIGHT).font('Helvetica')
       .text('PRODUCTION — MONTH-TO-DATE', L, y, { characterSpacing: 1.5 })
    y += 13

    const colW = PW / 2 - 6
    const bny = data.bny, nj = data.nj

    // Facility headers
    doc.fontSize(10).fillColor(INK).font('Helvetica-Bold')
       .text('BNY — BROOKLYN DIGITAL', L, y)
       .text('NJ — PASSAIC SCREEN PRINT', MID + 6, y)
    y += 16

    // 3 metric rows: Produced | Invoiced | OpEx
    const metricRows = [
      {
        bny: { label: 'PRODUCED', val: bny.prod_yds, sub: `${bny.prod_pct}% of ${bny.prod_tgt} target`, valColor: pctColor(bny.prod_pct) },
        nj:  { label: 'PRODUCED', val: nj.prod_yds,  sub: `${nj.prod_pct}% of ${nj.prod_tgt} target`,  valColor: pctColor(nj.prod_pct) },
      },
      {
        bny: { label: 'INVOICED YDS', val: bny.inv_yds, sub: `Revenue: ${bny.inv_rev}`, valColor: INK },
        nj:  { label: 'INVOICED YDS', val: nj.inv_yds,  sub: `Revenue: ${nj.inv_rev}${nj.misc_fees ? ' · Misc: ' + nj.misc_fees : ''}`, valColor: INK },
      },
      {
        bny: { label: 'OPEX MTD', val: bny.opex, sub: `Inv Purchases: ${bny.inv_purch}`, valColor: INK },
        nj:  { label: 'OPEX MTD', val: nj.opex,  sub: `Waste: ${nj.waste_pct || '—'} · Inv: ${nj.inv_purch}`, valColor: INK },
      },
    ]

    metricRows.forEach((row, i) => {
      // BNY side
      doc.fontSize(7).fillColor(INK_LIGHT).font('Helvetica')
         .text(row.bny.label, L, y, { characterSpacing: 0.8 })
      doc.fontSize(13).fillColor(row.bny.valColor).font('Helvetica-Bold')
         .text(row.bny.val || '—', L, y + 9)
      doc.fontSize(7.5).fillColor(INK_LIGHT).font('Helvetica')
         .text(row.bny.sub, L, y + 24, { width: colW })

      // NJ side
      doc.fontSize(7).fillColor(INK_LIGHT).font('Helvetica')
         .text(row.nj.label, MID + 6, y, { characterSpacing: 0.8 })
      doc.fontSize(13).fillColor(row.nj.valColor).font('Helvetica-Bold')
         .text(row.nj.val || '—', MID + 6, y + 9)
      doc.fontSize(7.5).fillColor(INK_LIGHT).font('Helvetica')
         .text(row.nj.sub, MID + 6, y + 24, { width: colW })

      // vertical divider
      doc.moveTo(MID, y - 2).lineTo(MID, y + 38).lineWidth(0.5).strokeColor(BORDER).stroke()

      // light row separator
      if (i < metricRows.length - 1) {
        doc.moveTo(L, y + 42).lineTo(L + PW, y + 42).lineWidth(0.3).strokeColor(CREAM_DK).stroke()
      }
      y += 46
    })

    // ── FINANCIALS TABLE ──────────────────────────────────────────────────────
    y += 4
    doc.moveTo(L, y).lineTo(L + PW, y).lineWidth(0.5).strokeColor(BORDER).stroke()
    y += 8

    doc.fontSize(7).fillColor(INK_LIGHT).font('Helvetica')
       .text('FINANCIALS', L, y, { characterSpacing: 1.5 })
    y += 13

    const fin = data.financials
    const cols = [120, 120, 120, 120]
    const headers = ['METRIC', 'PARAMOUNT NJ', 'BNY BROOKLYN', 'COMBINED']
    const rows = [
      ['OpEx MTD',        nj.opex,               bny.opex,              fin.opex_combined],
      ['Inv Purchases',   nj.inv_purch,            bny.inv_purch,         fin.inv_combined],
      ['AP Total',        fin.ap_para_total,       fin.ap_bny_total,      fin.ap_combined],
      ['AP Past Due',     fin.ap_para_pd,          fin.ap_bny_pd,         fin.ap_combined_pd, true],
      ['AR Outstanding',  '—',                     '—',                   fin.ar_outstanding],
      ['AR Past Due',     '—',                     '—',                   fin.ar_past_due, true],
    ]

    // Header row
    doc.rect(L, y, PW, 16).fill(INK)
    let cx = L
    headers.forEach((h, i) => {
      doc.fontSize(7).fillColor('#ffffff').font('Helvetica-Bold')
         .text(h, cx + 6, y + 5, { width: cols[i] - 8, characterSpacing: 0.8 })
      cx += cols[i]
    })
    y += 16

    rows.forEach((row, ri) => {
      const rowH = 16
      if (ri % 2 === 1) doc.rect(L, y, PW, rowH).fill(CREAM_DK)
      cx = L
      row.forEach((cell, ci) => {
        if (ci === 0) {
          doc.fontSize(8).fillColor(INK_LIGHT).font('Helvetica')
             .text(cell || '—', cx + 6, y + 4, { width: cols[ci] - 8 })
        } else {
          const isPastDue = row[4] === true && ci === 3
          const isAnyPD = row[4] === true
          doc.fontSize(8).fillColor(isAnyPD && ci > 0 ? RED : INK)
             .font(ci === 3 ? 'Helvetica-Bold' : 'Helvetica')
             .text(cell || '—', cx + 6, y + 4, { width: cols[ci] - 8 })
        }
        cx += cols[ci]
      })
      // grid line
      doc.moveTo(L, y + rowH).lineTo(L + PW, y + rowH).lineWidth(0.3).strokeColor(BORDER).stroke()
      y += rowH
    })

    // ── PEOPLE + WIP ─────────────────────────────────────────────────────────
    y += 10
    doc.moveTo(L, y).lineTo(L + PW, y).lineWidth(0.5).strokeColor(BORDER).stroke()
    y += 8

    const ppl = data.people, wip = data.wip

    // People
    doc.fontSize(7).fillColor(INK_LIGHT).font('Helvetica')
       .text('PEOPLE', L, y, { characterSpacing: 1.5 })
    doc.fontSize(7).fillColor(INK_LIGHT).font('Helvetica')
       .text('WIP SNAPSHOT', MID + 6, y, { characterSpacing: 1.5 })
    y += 12

    doc.fontSize(9).fillColor(INK).font('Helvetica')
       .text(`Headcount: ${ppl.headcount || '—'}`, L, y)
       .text(`Payroll MTD: ${ppl.payroll || '—'}`, L, y + 12)
       .text(`OT Hours: ${ppl.ot || '—'}`, L, y + 24)
    if (ppl.hr_notes) {
      doc.fontSize(7.5).fillColor(INK_LIGHT).font('Helvetica')
         .text(ppl.hr_notes, L, y + 36, { width: colW })
    }

    doc.moveTo(MID, y - 2).lineTo(MID, y + 48).lineWidth(0.5).strokeColor(BORDER).stroke()

    doc.fontSize(9).fillColor(INK).font('Helvetica')
       .text(`Active: ${wip.orders || '—'} orders · ${wip.yards || '—'} yds`, MID + 6, y)
    doc.fontSize(7.5).fillColor(INK_LIGHT).font('Helvetica')
       .text(`Age: 0-30d ${wip.age_0_30 || '—'}  ·  31-60d ${wip.age_31_60 || '—'}  ·  61-90d ${wip.age_61_90 || '—'}  ·  90d+ ${wip.age_90plus || '—'}`, MID + 6, y + 14, { width: colW })
       .text(`By type: Wallpaper ${wip.wallpaper || '—'}  ·  Grasscloth ${wip.grasscloth || '—'}  ·  Fabric ${wip.fabric || '—'}`, MID + 6, y + 26, { width: colW })

    // ── FOOTER ───────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 35
    doc.moveTo(L, footerY).lineTo(L + PW, footerY).lineWidth(0.5).strokeColor(BORDER).stroke()
    doc.fontSize(7.5).fillColor(INK_LIGHT).font('Helvetica')
       .text(`Paramount Prints · F. Schumacher & Co. · ${data.report_title} · Confidential`,
             L, footerY + 6, { align: 'center', width: PW })

    doc.end()
  })
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' }
  }

  try {
    const data = JSON.parse(event.body)
    const pdfBuffer = await generatePDF(data)
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${data.filename || 'paramount-report.pdf'}"`,
        'Access-Control-Allow-Origin': '*',
      },
      body: pdfBuffer.toString('base64'),
      isBase64Encoded: true,
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    }
  }
}
