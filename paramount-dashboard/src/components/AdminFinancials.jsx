import { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";

// ── SheetJS loader ────────────────────────────────────────────────────────────
function loadSheetJS() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) { resolve(window.XLSX); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error("Failed to load SheetJS"));
    document.head.appendChild(script);
  });
}

// ── Period helpers ────────────────────────────────────────────────────────────
function derivePeriod(ws) {
  if (!ws) return "";
  const d  = typeof ws === "string" ? new Date(ws + "T12:00:00") : ws;
  const yr = d.getFullYear(), mo = d.getMonth() + 1;
  return `${yr}-${String(mo).padStart(2,"0")}-W${Math.min(Math.ceil(d.getDate()/7),5)}`;
}

function findCol(row, ...candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const norm = c.toLowerCase().replace(/\s+/g,"");
    const hit  = keys.find(k => k.toLowerCase().replace(/\s+/g,"") === norm);
    if (hit !== undefined) return hit;
  }
  return null;
}

// ── GP Report parser ──────────────────────────────────────────────────────────
function parseGL(rows) {
  if (!rows.length) return {};
  const UNITS = ["609","610","612"];
  const zero  = () => ({ cogs_material:0, cogs_labor:0, cogs_wip:0, cogs_other:0,
    salary:0, salary_ot:0, fringe:0, te:0, printing:0, distribution:0,
    office_edp:0, consulting:0, building:0, utilities:0, rent:0,
    capitalization:0, inv_purchases:0, _vendors:{} });
  const totals = {}; UNITS.forEach(u => { totals[u] = zero(); });
  const s = rows[0];
  const colBU  = findCol(s,"BusinessUnit","Business Unit","BU");
  const colAcc = findCol(s,"Account Number","AccountNumber","Account No");
  const colDeb = findCol(s,"Debit Amount","DebitAmount","Debit");
  const colNet = findCol(s,"NET","Net","Net Amount");
  rows.forEach(row => {
    const bu = String(colBU ? row[colBU] : "").trim();
    if (!UNITS.includes(bu)) return;
    const m = String(colAcc ? row[colAcc] : "").match(/-(\d{4})-/);
    if (!m) return;
    const obj = parseInt(m[1],10);
    const deb = parseFloat(colDeb ? row[colDeb] : 0)||0;
    const net = parseFloat(colNet ? row[colNet] : 0)||0;
    const pos = net>0?net:0, t = totals[bu];
    if      ([4104,4105].includes(obj)) t.cogs_material += net;
    else if ([4108,4109].includes(obj)) t.cogs_labor    += net;
    else if ([4111,4112].includes(obj)) t.cogs_wip      += net;
    else if ([4113,4114].includes(obj)) t.cogs_other    += net;
    else if (obj===1437&&deb>0) {
      t.inv_purchases += deb;
      const name = String(row[findCol(row,"Originating Master Name","Master Name")||""]||"")
        .replace(/\s*-\s*FOR\s+(PARAMOUNT|BNY)[\w\s]*/i,"").replace(/\s+/g," ").trim()||"Unknown";
      t._vendors[name] = (t._vendors[name]||0)+deb;
    }
    else if (obj===6116) t.capitalization += net;
    else if (obj===6115) t.salary       += pos;
    else if ([6120,6125,6130,6135].includes(obj)) t.salary_ot += pos;
    else if (obj===6195) t.fringe       += pos;
    else if ([6205,6220,6221,6255,6260,6270,6271].includes(obj)) t.te += pos;
    else if ([4305,4313,6405,6410,6415,6420,6430,6435].includes(obj)) t.distribution += pos;
    else if (obj===6312) t.printing     += pos;
    else if ([4815,6505,6510,6515,6520,6525,6530,6540,6550,6640,6815].includes(obj)) t.office_edp += pos;
    else if (obj===6630) t.consulting   += pos;
    else if (obj===6710) t.building     += pos;
    else if (obj===6715) t.utilities    += pos;
    else if ([6740,6745].includes(obj)) t.rent += pos;
  });
  return totals;
}

function buildGPRow(period, bu, t) {
  const r = n => Math.round((n||0)*100)/100;
  return { period, business_unit:bu,
    cogs_material:r(t.cogs_material), cogs_labor:r(t.cogs_labor), cogs_wip:r(t.cogs_wip), cogs_other:r(t.cogs_other),
    salary:r(t.salary), salary_ot:r(t.salary_ot), fringe:r(t.fringe), te:r(t.te), printing:r(t.printing),
    distribution:r(t.distribution), office_edp:r(t.office_edp), consulting:r(t.consulting),
    building:r(t.building), utilities:r(t.utilities), rent:r(t.rent),
    capitalization:r(t.capitalization), inv_purchases:r(t.inv_purchases),
    inv_vendors: Object.entries(t._vendors||{}).map(([name,amount])=>({name,amount:Math.round(amount*100)/100})).sort((a,b)=>b.amount-a.amount),
    uploaded_at: new Date().toISOString() };
}

function guessGPPeriod(rows) {
  if (!rows.length) return null;
  const pid = rows[0]["Period ID"], yr = rows[0]["Open Year"];
  if (typeof pid !== "number"||!yr) return null;
  let maxDay = 1;
  rows.forEach(row => {
    const raw = row["TRX Date"];
    if (typeof raw === "string") { const m=raw.match(/DATE\(\d+,\d+,(\d+)\)/); if(m) maxDay=Math.max(maxDay,+m[1]); }
    else if (typeof raw === "number") maxDay = Math.max(maxDay, new Date((raw-25569)*86400000).getDate());
  });
  return `${parseInt(yr)}-${String(pid).padStart(2,"0")}-W${Math.min(Math.ceil(maxDay/7),5)}`;
}

// ── AP parser ─────────────────────────────────────────────────────────────────
// Parse a single AP sheet tab — col headers: Vendor Name[1], HOLD[8], Balance[9], Current[10], 1-7[11], 8-14[12], 15-30[13], 31-45[14], 45+[15]
function parseAPTab(XLSX, sheet, facility) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:null })
  if (rows.length < 2) return null
  const hdr = (rows[0]||[]).map(v => String(v||'').toLowerCase())
  // Find columns by header name
  const ci = name => hdr.findIndex(h => h.includes(name))
  const nameCol = ci('vendor name') >= 0 ? ci('vendor name') : 1
  const holdCol = ci('hold')        >= 0 ? ci('hold')        : 8
  const balCol  = ci('balance')     >= 0 ? ci('balance')     : 9
  const curCol  = ci('current')     >= 0 ? ci('current')     : 10
  const d1Col   = hdr.findIndex(h => h.includes('1 to 7') || h.match(/^1.*(7|seven)/)) >= 0
                    ? hdr.findIndex(h => h.includes('1 to 7') || h.match(/^1.*(7|seven)/)) : 11
  const d8Col   = hdr.findIndex(h => h.includes('8 to 14') || h.includes('8-14')) >= 0
                    ? hdr.findIndex(h => h.includes('8 to 14') || h.includes('8-14')) : 12
  const d15Col  = hdr.findIndex(h => h.includes('15 to 30') || h.includes('15-30')) >= 0
                    ? hdr.findIndex(h => h.includes('15 to 30') || h.includes('15-30')) : 13
  const d31Col  = hdr.findIndex(h => h.includes('31 to 45') || h.includes('31-45')) >= 0
                    ? hdr.findIndex(h => h.includes('31 to 45') || h.includes('31-45')) : 14
  const d45Col  = hdr.findIndex(h => h.includes('45 and') || h.includes('45+') || h.includes('over')) >= 0
                    ? hdr.findIndex(h => h.includes('45 and') || h.includes('45+') || h.includes('over')) : 15

  const vendors = []
  let total=0, current=0, d1=0, d8=0, d15=0, d31=0, d45=0
  for (const row of rows.slice(1)) {
    if (!row || !row[nameCol]) continue
    const balance = parseFloat(row[balCol]) || 0
    if (balance === 0) continue
    const name = String(row[nameCol]).trim().replace(/\s*-\s*(FOR\s+)?(PARAMOUNT|BNY)[^,]*/i, '').trim()
    const c=parseFloat(row[curCol])||0, r1=parseFloat(row[d1Col])||0, r8=parseFloat(row[d8Col])||0,
          r15=parseFloat(row[d15Col])||0, r31=parseFloat(row[d31Col])||0, r45=parseFloat(row[d45Col])||0
    const pastDue = r1+r8+r15+r31+r45
    vendors.push({ name, balance, current:c, days1_7:r1, days8_14:r8, days15_30:r15, days31_45:r31, days45plus:r45, pastDue,
      hold: String(row[holdCol]||'').toLowerCase() === 'yes' })
    total+=balance; current+=c; d1+=r1; d8+=r8; d15+=r15; d31+=r31; d45+=r45
  }
  vendors.sort((a,b) => b.balance - a.balance)
  return { facility, vendors, total, current, days1_7:d1, days8_14:d8, days15_30:d15, days31_45:d31, days45plus:d45,
    pastDue: d1+d8+d15+d31+d45 }
}

// Parse combined AP file — finds Paramount and BNY tabs (by name or position)
function parseAPCombinedFile(XLSX, workbook) {
  const names = workbook.SheetNames
  const paraName = names.find(s => /paramount|para|ph/i.test(s)) || names[0]
  const bnyName  = names.find(s => /bny|brooklyn/i.test(s))       || (names.length > 1 ? names[1] : null)
  const para = paraName ? parseAPTab(XLSX, workbook.Sheets[paraName], 'Paramount') : null
  const bny  = bnyName  ? parseAPTab(XLSX, workbook.Sheets[bnyName],  'BNY')       : null
  return { para, bny }
}

// Old: [0]VendorID [7]VendorName [8]HOLD [9]Balance [10]Current [11]1-7 [12]8-14 [13]15-30 [14]31-45 [15]45+
// New pivot: [0]Row Labels [1]Sum of Current [2]Sum of 1 to 7 Days ... [6]Sum of 91 and Over
function parseAPSheet(XLSX, workbook, facility) {
  // Try named sheet first, then fall back to first sheet
  const sheetName = workbook.SheetNames.find(s => s.toLowerCase().includes("ap aging"))
    || workbook.SheetNames[0];
  if (!sheetName) return null;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header:1, defval:null });
  if (rows.length < 2) return null;

  const vendors = [];
  let total=0, current=0, d1=0, d8=0, d15=0, d31=0, d45=0;

  // Detect format by looking at header row
  const hdr = (rows[0]||[]).map(v=>String(v||'').toLowerCase());
  const isPivot = hdr.some(h=>h.includes('row label')||h.includes('sum of current'));

  if (isPivot) {
    // New pivot format: Row Labels | Current | 1-7 | 8-30 | 31-60 | 61-90 | 91+
    // Find header row (may not be row 0 if there are blank rows at top)
    let headerIdx = rows.findIndex(r => (r||[]).some(v=>String(v||'').toLowerCase().includes('row label')))
    if (headerIdx < 0) headerIdx = 0
    const hdrs = (rows[headerIdx]||[]).map(v=>String(v||'').toLowerCase())
    const col = name => hdrs.findIndex(h=>h.includes(name))
    const nameCol = col('row label') >= 0 ? col('row label') : 0
    const curCol  = col('current')
    const d1Col   = col('1 to 7')  >= 0 ? col('1 to 7')  : col('1-7')
    const d8Col   = col('8 to 30') >= 0 ? col('8 to 30') : col('8-30')
    const d31Col  = col('31 to 60')>= 0 ? col('31 to 60'): col('31-60')
    const d61Col  = col('61 to 90')>= 0 ? col('61 to 90'): col('61-90')
    const d91Col  = col('91')

    for (const row of rows.slice(headerIdx+1)) {
      if (!row||!row[nameCol]) continue
      const name = String(row[nameCol]).trim()
      if (!name || name.toLowerCase().includes('grand total') || name.toLowerCase().includes('total')) {
        // Use Grand Total row for totals if present
        if (name.toLowerCase().includes('grand total')) {
          total = (curCol>=0?parseFloat(row[curCol])||0:0)
               + (d1Col>=0?parseFloat(row[d1Col])||0:0)
               + (d8Col>=0?parseFloat(row[d8Col])||0:0)
               + (d31Col>=0?parseFloat(row[d31Col])||0:0)
               + (d61Col>=0?parseFloat(row[d61Col])||0:0)
               + (d91Col>=0?parseFloat(row[d91Col])||0:0)
        }
        continue
      }
      const c   = curCol>=0  ? parseFloat(row[curCol])||0  : 0
      const r1  = d1Col>=0   ? parseFloat(row[d1Col])||0   : 0
      const r8  = d8Col>=0   ? parseFloat(row[d8Col])||0   : 0
      const r31 = d31Col>=0  ? parseFloat(row[d31Col])||0  : 0
      const r61 = d61Col>=0  ? parseFloat(row[d61Col])||0  : 0
      const r91 = d91Col>=0  ? parseFloat(row[d91Col])||0  : 0
      const balance = c+r1+r8+r31+r61+r91
      if (balance===0) continue
      const pastDue = r1+r8+r31+r61+r91
      vendors.push({ name, balance, current:c, days1_7:r1, days8_14:r8, days15_30:0, days31_45:r31, days45plus:r61+r91, pastDue, hold:false })
      current+=c; d1+=r1; d8+=r8; d31+=r31; d45+=r61+r91
    }
    if (total===0) total = current+d1+d8+d31+d45
  } else {
    // Old format
    for (const row of rows.slice(1)) {
      if (!row||!row[7]) continue;
      const balance = parseFloat(row[9])||0;
      if (balance===0) continue;
      const name = String(row[7]).trim().replace(/\s*-\s*(FOR\s+)?(PARAMOUNT|BNY)[^,]*/i,"").trim();
      const c=parseFloat(row[10])||0, r1=parseFloat(row[11])||0, r8=parseFloat(row[12])||0,
            r15=parseFloat(row[13])||0, r31=parseFloat(row[14])||0, r45=parseFloat(row[15])||0;
      const pastDue = r1+r8+r15+r31+r45;
      vendors.push({ name, balance, current:c, days1_7:r1, days8_14:r8, days15_30:r15, days31_45:r31, days45plus:r45, pastDue,
        hold: String(row[8]||"").toLowerCase()==="yes" });
      total+=balance; current+=c; d1+=r1; d8+=r8; d15+=r15; d31+=r31; d45+=r45;
    }
  }

  vendors.sort((a,b)=>b.balance-a.balance);
  return { facility, vendors, total, current, days1_7:d1, days8_14:d8, days15_30:d15, days31_45:d31, days45plus:d45,
    pastDue: d1+d8+d15+d31+d45 };
}

// ── AR parser ─────────────────────────────────────────────────────────────────
// Raw "Sheet" tab: col[0]=CustomerID col[1]=CustomerName col[7]=LiftOrderType(PARA/BNY)
//   col[10]=DocumentAmount col[11]=UnappliedAmount col[12]=Current col[13]=1-7d col[14]=8-30d
//   col[15]=31-60d col[16]=61-90d col[17]=91+
function parseARFile(XLSX, workbook) {
  const makeResult = () => ({ aging:{current:0,days1_7:0,days8_30:0,days31_60:0,days61_90:0,days91plus:0,total:0},
    customers:[], totalOutstanding:0, totalPastDue:0 })
  const para = makeResult(), bny = makeResult()

  // Try raw detail sheet first ("Sheet" or second sheet)
  const rawName = workbook.SheetNames.find(s => s === 'Sheet')
    || workbook.SheetNames.find(s => !s.toLowerCase().includes('sheet1') && s !== workbook.SheetNames[0])
    || workbook.SheetNames[workbook.SheetNames.length > 1 ? 1 : 0]

  const rawSheet = workbook.Sheets[rawName]
  if (rawSheet) {
    const rows = XLSX.utils.sheet_to_json(rawSheet, { header:1, defval:null })
    // Find header row
    const hdrIdx = rows.findIndex(r => (r||[]).some(v => String(v||'').toLowerCase().includes('customer id') || String(v||'').toLowerCase().includes('lift order')))
    if (hdrIdx >= 0) {
      const hdr = (rows[hdrIdx]||[]).map(v => String(v||'').toLowerCase())
      const ci = (name) => hdr.findIndex(h => h.includes(name))
      const nameCol   = ci('customer name') >= 0 ? ci('customer name') : 1
      const divCol    = ci('lift order')    >= 0 ? ci('lift order')    : 7
      const unapplCol = ci('unapplied')     >= 0 ? ci('unapplied')     : 11
      const curCol    = ci('current')       >= 0 ? ci('current')       : 12
      const d1Col     = hdr.findIndex(h => h.includes('1 to 7') || h.match(/^1.+7/)) >= 0
                          ? hdr.findIndex(h => h.includes('1 to 7') || h.match(/^1.+7/)) : 13
      const d8Col     = hdr.findIndex(h => h.includes('8 to 30') || h.match(/^8.+30/)) >= 0
                          ? hdr.findIndex(h => h.includes('8 to 30') || h.match(/^8.+30/)) : 14
      const d31Col    = hdr.findIndex(h => h.includes('31 to 60') || h.match(/^31.+60/)) >= 0
                          ? hdr.findIndex(h => h.includes('31 to 60') || h.match(/^31.+60/)) : 15
      const d61Col    = hdr.findIndex(h => h.includes('61 to 90') || h.match(/^61.+90/)) >= 0
                          ? hdr.findIndex(h => h.includes('61 to 90') || h.match(/^61.+90/)) : 16
      const d91Col    = hdr.findIndex(h => h.includes('91')) >= 0
                          ? hdr.findIndex(h => h.includes('91')) : 17

      const customerTotals = {} // { name: { facility, unapplied, current, d1, d8, d31, d61, d91 } }

      for (const row of rows.slice(hdrIdx + 1)) {
        if (!row || !row[nameCol]) continue
        const div = String(row[divCol] || '').trim().toUpperCase()
        if (div !== 'PARA' && div !== 'BNY') continue
        const name    = String(row[nameCol]).trim()
        const unappl  = parseFloat(row[unapplCol]) || 0
        if (unappl === 0) continue
        const c   = parseFloat(row[curCol])  || 0
        const r1  = parseFloat(row[d1Col])   || 0
        const r8  = parseFloat(row[d8Col])   || 0
        const r31 = parseFloat(row[d31Col])  || 0
        const r61 = parseFloat(row[d61Col])  || 0
        const r91 = parseFloat(row[d91Col])  || 0
        const key = `${div}::${name}`
        if (!customerTotals[key]) customerTotals[key] = { name, facility:div, unapplied:0, current:0, d1:0, d8:0, d31:0, d61:0, d91:0 }
        const ct = customerTotals[key]
        ct.unapplied += unappl; ct.current += c; ct.d1 += r1; ct.d8 += r8; ct.d31 += r31; ct.d61 += r61; ct.d91 += r91
      }

      for (const ct of Object.values(customerTotals)) {
        const target = ct.facility === 'PARA' ? para : bny
        const pastDue = ct.d1 + ct.d8 + ct.d31 + ct.d61 + ct.d91
        target.customers.push({ name:ct.name, balance:ct.unapplied, current:ct.current,
          days1_7:ct.d1, days8_30:ct.d8, days31_60:ct.d31, days61_90:ct.d61, days91plus:ct.d91, pastDue })
        target.aging.current    += ct.current
        target.aging.days1_7    += ct.d1
        target.aging.days8_30   += ct.d8
        target.aging.days31_60  += ct.d31
        target.aging.days61_90  += ct.d61
        target.aging.days91plus += ct.d91
        target.totalOutstanding += ct.unapplied
      }

      for (const t of [para, bny]) {
        t.aging.total = t.totalOutstanding
        t.totalPastDue = t.aging.days1_7 + t.aging.days8_30 + t.aging.days31_60 + t.aging.days61_90 + t.aging.days91plus
        t.customers.sort((a,b) => b.balance - a.balance)
      }
    }
  }

  return { para, bny,
    // Combined totals for backward compat
    aging: {
      current:    para.aging.current    + bny.aging.current,
      days1_30:   para.aging.days1_7    + bny.aging.days1_7 + para.aging.days8_30 + bny.aging.days8_30,
      days31_60:  para.aging.days31_60  + bny.aging.days31_60,
      days61_90:  para.aging.days61_90  + bny.aging.days61_90,
      days91plus: para.aging.days91plus + bny.aging.days91plus,
      total:      para.totalOutstanding + bny.totalOutstanding,
    },
    keyAccounts: [...para.customers, ...bny.customers],
    totalOutstanding: para.totalOutstanding + bny.totalOutstanding,
    totalPastDue:     para.totalPastDue     + bny.totalPastDue,
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────
const fmt  = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n||0);
const fmtD = iso => iso ? new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "";
const BU   = {"609":"BNY Brooklyn","610":"Passaic NJ","612":"Shared"};

// ── Drop zone ─────────────────────────────────────────────────────────────────
function DropZone({ label, sublabel, accept, onFile, file, status, color="#4f46e5", disabled }) {
  const ref  = useRef(null);
  const [drag, setDrag] = useState(false);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:5}}>
      <div style={{fontSize:12,fontWeight:700,color:"#374151",textTransform:"uppercase",letterSpacing:"0.05em"}}>{label}</div>
      {sublabel && <div style={{fontSize:11,color:"#9ca3af",marginTop:-3}}>{sublabel}</div>}
      <div
        onClick={() => !disabled && ref.current?.click()}
        onDragOver={e=>{if(!disabled){e.preventDefault();setDrag(true)}}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);if(!disabled){const f=e.dataTransfer.files[0];if(f)onFile(f)}}}
        style={{ border:`2px dashed ${disabled?"#e5e7eb":drag?color:file?"#6ee7b7":"#d1d5db"}`,
          borderRadius:10, padding:"14px 10px", textAlign:"center",
          cursor:disabled?"default":"pointer", transition:"all 0.15s",
          background:disabled?"#f9fafb":drag?"#f0f9ff":file?"#f0fdf4":"#fafafa",
          minHeight:76, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:3 }}
      >
        <input ref={ref} type="file" accept={accept} style={{display:"none"}}
          onChange={e=>{const f=e.target.files?.[0];if(f)onFile(f);e.target.value="";}}/>
        {disabled ? (
          <div style={{fontSize:12,color:"#9ca3af"}}>Coming soon</div>
        ) : file ? (
          <><div style={{fontSize:18}}>✓</div><div style={{fontSize:11,fontWeight:600,color:"#15803d",wordBreak:"break-all"}}>{file.name}</div></>
        ) : (
          <><div style={{fontSize:22,color:"#d1d5db"}}>+</div><div style={{fontSize:12,color:"#6b7280"}}>Drop or click</div><div style={{fontSize:11,color:"#9ca3af"}}>.xlsx</div></>
        )}
      </div>
      {status && <div style={{fontSize:11,color:status.startsWith("✓")?"#15803d":status.startsWith("⚠")?"#b45309":"#9ca3af"}}>{status}</div>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function AdminFinancials({ weekStart }) {
  const [selectedPeriod,   setSelectedPeriod]   = useState(() => derivePeriod(weekStart));
  const [showPeriodPicker, setShowPeriodPicker] = useState(false);
  const [gpFile,    setGpFile]    = useState(null);
  const [apFile,    setApFile]    = useState(null);
  const [arFile,    setArFile]    = useState(null);
  const [gpPreview,  setGpPreview]  = useState(null);
  const [apData,     setApData]     = useState(null);  // { para, bny }
  const [arData,     setArData]     = useState(null);
  const [cashPassaic, setCashPassaic] = useState('');
  const [cashBNY,     setCashBNY]     = useState('');
  const [fileStatus, setFileStatus] = useState({});
  const setStatus = (key, msg) => setFileStatus(p=>({...p,[key]:msg}));
  const [saving,      setSaving]      = useState(false);
  const [saveMsg,     setSaveMsg]     = useState(null);
  const [uploads,     setUploads]     = useState([]);
  const [loadingHist, setLoadingHist] = useState(false);

  useEffect(() => { setSelectedPeriod(derivePeriod(weekStart)); loadHistory(); }, [weekStart]);

  async function loadHistory() {
    setLoadingHist(true);
    const { data } = await supabase.from("financials_monthly")
      .select("period,business_unit,cogs_total,opex_total,inv_purchases,uploaded_at")
      .order("period",{ascending:false}).order("business_unit",{ascending:true}).limit(20);
    setUploads(data||[]);
    setLoadingHist(false);
  }

  async function handleGP(file) {
    setGpFile(file); setStatus("gp","Parsing…");
    try {
      const XLSX = await loadSheetJS();
      const rows = XLSX.utils.sheet_to_json(XLSX.read(await file.arrayBuffer(),{type:"array"}).Sheets[
        XLSX.read(await file.arrayBuffer(),{type:"array"}).SheetNames[0]],{raw:true});
      if (!rows.length) { setStatus("gp","⚠ File empty"); return; }
      const totals = parseGL(rows);
      const guess  = guessGPPeriod(rows);
      if (guess && !selectedPeriod) setSelectedPeriod(guess);
      setGpPreview({totals, rowCount:rows.length});
      setStatus("gp",`✓ ${rows.length.toLocaleString()} rows`);
    } catch(e) { setStatus("gp","⚠ "+e.message); }
  }

  async function handleAP(file) {
    setApFile(file); setStatus("ap","Parsing…");
    try {
      const XLSX = await loadSheetJS();
      const wb   = XLSX.read(await file.arrayBuffer(),{type:"array"});
      const data = parseAPCombinedFile(XLSX, wb);
      if (!data.para && !data.bny) { setStatus("ap","⚠ No AP data found"); return; }
      setApData(data);
      const parts = [data.para&&`Paramount: ${fmt(data.para.total)}`, data.bny&&`BNY: ${fmt(data.bny.total)}`].filter(Boolean)
      setStatus("ap",`✓ ${parts.join(' · ')}`);
    } catch(e) { setStatus("ap","⚠ "+e.message); }
  }

  async function handleAR(file) {
    setArFile(file); setStatus("ar","Parsing…");
    try {
      const XLSX = await loadSheetJS();
      const wb   = XLSX.read(await file.arrayBuffer(),{type:"array"});
      const data = parseARFile(XLSX, wb);
      setArData(data);
      setStatus("ar",`✓ Paramount: ${fmt(data.para.totalOutstanding)} · BNY: ${fmt(data.bny.totalOutstanding)}`);
    } catch(e) { setStatus("ar","⚠ "+e.message); }
  }

  async function handleSaveAll() {
    if (!selectedPeriod) { setSaveMsg({type:"error",text:"Select a period first"}); return; }
    setSaving(true); setSaveMsg(null);
    try {
      if (gpPreview) {
        const rows = Object.entries(gpPreview.totals).map(([bu,t])=>buildGPRow(selectedPeriod,bu,t));
        const {error} = await supabase.from("financials_monthly").upsert(rows,{onConflict:"period,business_unit"});
        if (error) throw new Error("GP: "+error.message);
      }
      const apRows = [];
      if (apData?.para) apRows.push({ period:selectedPeriod, facility:"Paramount",
        total:apData.para.total, current:apData.para.current, days1_7:apData.para.days1_7,
        days8_14:apData.para.days8_14, days15_30:apData.para.days15_30, days31_45:apData.para.days31_45,
        days45plus:apData.para.days45plus, past_due:apData.para.pastDue,
        top_vendors:apData.para.vendors.slice(0,10), uploaded_at:new Date().toISOString() });
      if (apData?.bny) apRows.push({ period:selectedPeriod, facility:"BNY",
        total:apData.bny.total, current:apData.bny.current, days1_7:apData.bny.days1_7,
        days8_14:apData.bny.days8_14, days15_30:apData.bny.days15_30, days31_45:apData.bny.days31_45,
        days45plus:apData.bny.days45plus, past_due:apData.bny.pastDue,
        top_vendors:apData.bny.vendors.slice(0,10), uploaded_at:new Date().toISOString() });
      if (apRows.length) {
        const {error} = await supabase.from("financial_ap").upsert(apRows,{onConflict:"period,facility"});
        if (error) throw new Error("AP: "+error.message);
      }
      if (arData) {
        const arPayload = {
          period:selectedPeriod, aging_current:arData.aging.current||0,
          aging_1_30:arData.aging.days1_30||0, aging_31_60:arData.aging.days31_60||0,
          aging_61_90:arData.aging.days61_90||0, aging_91plus:arData.aging.days91plus||0,
          total_outstanding:arData.totalOutstanding||0, total_past_due:arData.totalPastDue||0,
          key_accounts: {
            combined: arData.keyAccounts,
            para: { aging: arData.para?.aging||{}, customers: (arData.para?.customers||[]).slice(0,15),
              totalOutstanding: arData.para?.totalOutstanding||0, totalPastDue: arData.para?.totalPastDue||0 },
            bny:  { aging: arData.bny?.aging||{}, customers: (arData.bny?.customers||[]).slice(0,15),
              totalOutstanding: arData.bny?.totalOutstanding||0, totalPastDue: arData.bny?.totalPastDue||0 },
          },
          uploaded_at:new Date().toISOString()
        };
        const {error} = await supabase.from("financial_ar").upsert(arPayload,{onConflict:"period"});
        if (error) throw new Error("AR: "+error.message);
      }
      if (cashPassaic || cashBNY) {
        const {error} = await supabase.from("financial_cash").upsert({
          period: selectedPeriod,
          passaic_cash: parseFloat(cashPassaic)||0,
          bny_cash: parseFloat(cashBNY)||0,
          uploaded_at: new Date().toISOString()
        },{onConflict:"period"});
        if (error) throw new Error("Cash: "+error.message);
      }
      setSaveMsg({type:"success",text:`✓ All saved to ${selectedPeriod}`});
      setGpFile(null); setApFile(null); setArFile(null);
      setGpPreview(null); setApData(null); setArData(null);
      setCashPassaic(''); setCashBNY('');
      setFileStatus({});
      loadHistory();
    } catch(e) { setSaveMsg({type:"error",text:e.message}); }
    setSaving(false);
  }

  const hasAnyFile = gpPreview||apData||arData||(cashPassaic||cashBNY);

  // Warn before navigating away with unsaved uploads
  useEffect(() => {
    if (!hasAnyFile) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasAnyFile]);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:28}}>

      {/* Period */}
      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",
        background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"8px 14px"}}>
        <span style={{fontSize:12,color:"#15803d",fontWeight:600}}>📅 Saving to period:</span>
        <span style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:"#15803d"}}>{selectedPeriod||"—"}</span>
        <button onClick={()=>setShowPeriodPicker(p=>!p)}
          style={{fontSize:11,color:"#4338ca",background:"none",border:"1px solid #c7d2fe",borderRadius:4,padding:"2px 8px",cursor:"pointer"}}>
          {showPeriodPicker?"✕ close":"change"}
        </button>
        {showPeriodPicker&&(
          <select value={selectedPeriod} onChange={e=>{setSelectedPeriod(e.target.value);setShowPeriodPicker(false);}}
            style={{border:"1px solid #ccc",borderRadius:6,padding:"4px 8px",fontSize:12,background:"#fff",cursor:"pointer"}}>
            <option value="">— pick —</option>
            {(()=>{const opts=[];const now=new Date();for(let m=-2;m<=1;m++){const d=new Date(now.getFullYear(),now.getMonth()+m,1);const yr=d.getFullYear(),mo=d.getMonth()+1,mm=String(mo).padStart(2,"0"),lb=d.toLocaleString("en-US",{month:"long"});for(let w=1;w<=5;w++)opts.push(<option key={`${yr}-${mm}-W${w}`} value={`${yr}-${mm}-W${w}`}>{lb} {yr} — Week {w}</option>);}return opts;})()}
          </select>
        )}
      </div>

      {/* Save bar — always at top */}
      <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <button onClick={handleSaveAll} disabled={saving||!selectedPeriod||!hasAnyFile}
          style={{padding:"10px 24px",
            background:hasAnyFile&&selectedPeriod?"#1f2937":"#d1d5db",
            color:hasAnyFile&&selectedPeriod?"#fff":"#9ca3af",
            border:"none",borderRadius:8,fontSize:14,fontWeight:600,
            cursor:hasAnyFile&&selectedPeriod?"pointer":"not-allowed"}}>
          {saving?"Saving…":hasAnyFile?`Save All to ${selectedPeriod||"…"}`:"Save All (upload files first)"}
        </button>
        {saveMsg&&<div style={{fontSize:13,fontWeight:500,color:saveMsg.type==="error"?"#b91c1c":"#15803d"}}>{saveMsg.text}</div>}
        {hasAnyFile&&!saveMsg&&(
          <span style={{fontSize:12,color:"#92400e",fontWeight:500}}>⚠️ Unsaved uploads — save before navigating away</span>
        )}
      </div>

      {/* Drop zones */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:14}}>
        <DropZone label="GP Report"     sublabel="COGS · OpEx · Inventory" accept=".xlsx,.xls,.csv" file={gpFile}     onFile={handleGP}     status={fileStatus.gp}     color="#4f46e5"/>
        <DropZone label="AP Aging"       sublabel="Paramount + BNY (combined)"  accept=".xlsx"           file={apFile}     onFile={handleAP}     status={fileStatus.ap}     color="#0369a1"/>
        <DropZone label="AR Aging"       sublabel="AR Update"               accept=".xlsx"           file={arFile}     onFile={handleAR}     status={fileStatus.ar}     color="#7c3aed"/>
        <div style={{display:"flex",flexDirection:"column",gap:5}}>
          <div style={{fontSize:12,fontWeight:700,color:"#374151",textTransform:"uppercase",letterSpacing:"0.05em"}}>Cash</div>
          <div style={{fontSize:11,color:"#9ca3af",marginTop:-3}}>Cash Position</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,padding:"12px",border:"1px solid #e5e7eb",borderRadius:10,background:"#fafafa"}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:11,fontWeight:600,color:"#374151",width:80}}>Passaic</span>
              <div style={{position:"relative",flex:1}}>
                <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",color:"#9ca3af",fontSize:13}}>$</span>
                <input type="number" value={cashPassaic} onChange={e=>setCashPassaic(e.target.value)}
                  placeholder="0"
                  style={{width:"100%",paddingLeft:20,paddingRight:8,paddingTop:6,paddingBottom:6,border:"1px solid #d1d5db",borderRadius:6,fontSize:13,boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:11,fontWeight:600,color:"#374151",width:80}}>BNY</span>
              <div style={{position:"relative",flex:1}}>
                <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",color:"#9ca3af",fontSize:13}}>$</span>
                <input type="number" value={cashBNY} onChange={e=>setCashBNY(e.target.value)}
                  placeholder="0"
                  style={{width:"100%",paddingLeft:20,paddingRight:8,paddingTop:6,paddingBottom:6,border:"1px solid #d1d5db",borderRadius:6,fontSize:13,boxSizing:"border-box"}}/>
              </div>
            </div>
            {(cashPassaic||cashBNY)&&<div style={{fontSize:11,color:"#15803d"}}>✓ Total: ${(parseFloat(cashPassaic||0)+parseFloat(cashBNY||0)).toLocaleString()}</div>}
          </div>
        </div>
      </div>

      {/* GP Preview */}
      {gpPreview&&(
        <div style={{border:"1px solid #e5e7eb",borderRadius:10,overflow:"hidden"}}>
          <div style={{background:"#f9fafb",padding:"8px 16px",borderBottom:"1px solid #e5e7eb",fontSize:13,fontWeight:600}}>
            GP Report — {gpPreview.rowCount.toLocaleString()} rows
          </div>
          <table style={{width:"100%",fontSize:13,borderCollapse:"collapse"}}>
            <thead><tr style={{borderBottom:"1px solid #e5e7eb"}}>
              {["Business Unit","COGS","OpEx","Inv Purchases"].map((h,i)=>
                <th key={h} style={{textAlign:i===0?"left":"right",padding:"7px 14px",color:"#6b7280",fontWeight:500}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {Object.entries(gpPreview.totals).map(([bu,t])=>{
                const cogs=t.cogs_material+t.cogs_labor+t.cogs_wip+t.cogs_other;
                const opex=t.salary+t.salary_ot+t.fringe+t.te+t.printing+t.distribution+t.office_edp+t.consulting+t.building+t.utilities+t.rent;
                return(<tr key={bu} style={{borderBottom:"1px solid #f3f4f6"}}>
                  <td style={{padding:"8px 14px",fontWeight:500}}>{BU[bu]||bu}</td>
                  <td style={{padding:"8px 14px",textAlign:"right"}}>{fmt(cogs)}</td>
                  <td style={{padding:"8px 14px",textAlign:"right"}}>{fmt(opex)}</td>
                  <td style={{padding:"8px 14px",textAlign:"right"}}>{fmt(t.inv_purchases)}</td>
                </tr>);
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* AP Preview */}
      {apData&&(
        <div style={{border:"1px solid #e5e7eb",borderRadius:10,overflow:"hidden"}}>
          <div style={{background:"#f9fafb",padding:"8px 16px",borderBottom:"1px solid #e5e7eb",fontSize:13,fontWeight:600}}>AP Preview</div>
          <table style={{width:"100%",fontSize:13,borderCollapse:"collapse"}}>
            <thead><tr style={{borderBottom:"1px solid #e5e7eb"}}>
              {["Facility","Total","Current","1–7d","8–14d","15–30d","31–45d","45d+","Past Due"].map((h,i)=>
                <th key={h} style={{textAlign:i===0?"left":"right",padding:"7px 12px",color:"#6b7280",fontWeight:500,fontSize:11}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {[apData.para,apData.bny].filter(Boolean).map(d=>(
                <tr key={d.facility} style={{borderBottom:"1px solid #f3f4f6"}}>
                  <td style={{padding:"8px 12px",fontWeight:600}}>{d.facility}</td>
                  {[d.total,d.current,d.days1_7,d.days8_14,d.days15_30,d.days31_45,d.days45plus].map((v,i)=>
                    <td key={i} style={{padding:"8px 12px",textAlign:"right"}}>{fmt(v)}</td>)}
                  <td style={{padding:"8px 12px",textAlign:"right",color:d.pastDue>0?"#b91c1c":"#15803d",fontWeight:600}}>{fmt(d.pastDue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {[apData.para,apData.bny].filter(Boolean).map(d=>(
            <div key={d.facility} style={{padding:"10px 14px",borderTop:"1px solid #f3f4f6"}}>
              <div style={{fontSize:11,fontWeight:600,color:"#6b7280",marginBottom:6}}>TOP VENDORS — {d.facility.toUpperCase()}</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {d.vendors.slice(0,6).map(v=>(
                  <div key={v.name} style={{fontSize:11,background:v.pastDue>0?"#fef2f2":"#f9fafb",
                    border:`1px solid ${v.pastDue>0?"#fecaca":"#e5e7eb"}`,borderRadius:6,padding:"3px 8px"}}>
                    <span style={{fontWeight:500}}>{v.name.slice(0,22)}</span>
                    <span style={{color:"#6b7280",marginLeft:5}}>{fmt(v.balance)}</span>
                    {v.pastDue>0&&<span style={{color:"#b91c1c",marginLeft:4}}>({fmt(v.pastDue)} overdue)</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* AR Preview */}
      {arData&&(
        <div style={{border:"1px solid #e5e7eb",borderRadius:10,overflow:"hidden"}}>
          <div style={{background:"#f9fafb",padding:"8px 16px",borderBottom:"1px solid #e5e7eb",fontSize:13,fontWeight:600}}>
            AR — {fmt(arData.totalOutstanding)} total outstanding · Paramount: {fmt(arData.para?.totalOutstanding||0)} · BNY: {fmt(arData.bny?.totalOutstanding||0)}
          </div>
          {[{label:'Paramount (PARA)', d: arData.para}, {label:'Brooklyn (BNY)', d: arData.bny}].map(({label, d}) => d && (
            <div key={label} style={{borderBottom:"1px solid #f3f4f6"}}>
              <div style={{padding:"6px 14px",fontSize:11,fontWeight:700,color:"#6b7280",background:"#fafafa",textTransform:"uppercase"}}>{label} — {fmt(d.totalOutstanding)}</div>
              <div style={{display:"flex"}}>
                {[["Current",d.aging.current,0],["1–7d",d.aging.days1_7,1],
                  ["8–30d",d.aging.days8_30,2],["31–60d",d.aging.days31_60,3],
                  ["61–90d",d.aging.days61_90,4],["91d+",d.aging.days91plus,5]]
                  .map(([lbl,val,i])=>(
                  <div key={lbl} style={{flex:1,padding:"8px 6px",textAlign:"center",borderRight:i<5?"1px solid #f3f4f6":"none"}}>
                    <div style={{fontSize:10,color:"#9ca3af",fontWeight:600,textTransform:"uppercase"}}>{lbl}</div>
                    <div style={{fontSize:13,fontWeight:700,marginTop:2,
                      color:i===0?"#15803d":i>=4?"#b91c1c":"#b45309"}}>{fmt(val)}</div>
                  </div>
                ))}
              </div>
              {d.customers.length>0&&(
                <div style={{padding:"8px 14px"}}>
                  <div style={{fontSize:11,fontWeight:600,color:"#6b7280",marginBottom:6}}>TOP ACCOUNTS</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {d.customers.slice(0,6).map(a=>(
                      <div key={a.name} style={{fontSize:11,background:a.pastDue>0?"#fef2f2":"#f9fafb",
                        border:`1px solid ${a.pastDue>0?"#fecaca":"#e5e7eb"}`,borderRadius:6,padding:"3px 8px"}}>
                        <span style={{fontWeight:500}}>{a.name.slice(0,24)}</span>
                        <span style={{color:"#6b7280",marginLeft:5}}>{fmt(a.balance)}</span>
                        {a.pastDue>0&&<span style={{color:"#b91c1c",marginLeft:4}}>({fmt(a.pastDue)} past due)</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}


      {/* History */}
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div style={{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",color:"#6b7280"}}>GP Report History</div>
          <button onClick={loadHistory} style={{fontSize:12,color:"#4f46e5",background:"none",border:"none",cursor:"pointer"}}>
            {loadingHist?"Loading…":"Refresh"}
          </button>
        </div>
        {uploads.length===0?<p style={{fontSize:13,color:"#9ca3af"}}>No uploads yet.</p>:(
          <table style={{width:"100%",fontSize:13,borderCollapse:"collapse"}}>
            <thead><tr style={{borderBottom:"1px solid #e5e7eb"}}>
              {["Period","BU","COGS","OpEx","Inv Purchases","Uploaded"].map((h,i)=>
                <th key={h} style={{textAlign:i<2?"left":"right",paddingBottom:8,color:"#6b7280",fontWeight:500}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {uploads.map((u,i)=>(
                <tr key={i} style={{borderBottom:"1px solid #f3f4f6"}}>
                  <td style={{padding:"6px 0",fontFamily:"monospace",fontSize:12}}>{u.period}</td>
                  <td style={{padding:"6px 0"}}>{BU[u.business_unit]||u.business_unit}</td>
                  <td style={{padding:"6px 0",textAlign:"right"}}>{fmt(u.cogs_total)}</td>
                  <td style={{padding:"6px 0",textAlign:"right"}}>{fmt(u.opex_total)}</td>
                  <td style={{padding:"6px 0",textAlign:"right"}}>{fmt(u.inv_purchases)}</td>
                  <td style={{padding:"6px 0",textAlign:"right",fontSize:11,color:"#9ca3af"}}>{fmtD(u.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
