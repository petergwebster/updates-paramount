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
// Sheet: "AP Aging Revised" — row 0 = headers (array format)
// Cols: [0]VendorID [7]VendorName [8]HOLD [9]Balance [10]Current [11]1-7 [12]8-14 [13]15-30 [14]31-45 [15]45+
function parseAPSheet(XLSX, workbook, facility) {
  const sheetName = workbook.SheetNames.find(s => s.toLowerCase().includes("ap aging"));
  if (!sheetName) return null;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header:1, defval:null });
  if (rows.length < 2) return null;
  const vendors = [];
  let total=0, current=0, d1=0, d8=0, d15=0, d31=0, d45=0;
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
  vendors.sort((a,b)=>b.balance-a.balance);
  return { facility, vendors, total, current, days1_7:d1, days8_14:d8, days15_30:d15, days31_45:d31, days45plus:d45,
    pastDue: d1+d8+d15+d31+d45 };
}

// ── AR parser ─────────────────────────────────────────────────────────────────
// "AR" sheet: rows[2]=Current [3]=1-30 [4]=31-60 [5]=61-90 [6]=91+ [7]=Total — take last non-null col
// "Paramount & BNY Summary": pivot with key accounts + notes
function parseARFile(XLSX, workbook) {
  const result = { aging:{}, keyAccounts:[], totalOutstanding:0, totalPastDue:0 };

  const arSheet = workbook.Sheets["AR"];
  if (arSheet) {
    const rows = XLSX.utils.sheet_to_json(arSheet, { header:1, defval:null });
    const lastVal = r => {
      const vals = (r||[]).slice(2).filter(v=>v!==null&&v!=="");
      return parseFloat(vals[vals.length-1])||0;
    };
    result.aging = { current:lastVal(rows[2]), days1_30:lastVal(rows[3]),
      days31_60:lastVal(rows[4]), days61_90:lastVal(rows[5]), days91plus:lastVal(rows[6]), total:lastVal(rows[7]) };
    result.totalOutstanding = result.aging.total;
    result.totalPastDue = result.aging.days1_30+result.aging.days31_60+result.aging.days61_90+result.aging.days91plus;
  }

  const summSheet = workbook.Sheets["Paramount & BNY Summary"];
  if (summSheet) {
    const rows = XLSX.utils.sheet_to_json(summSheet, { header:1, defval:null });
    for (let i=0; i<rows.length; i++) {
      if (!rows[i]||String(rows[i][0]||"").trim()!=="Row Labels") continue;
      for (let j=i+1; j<rows.length; j++) {
        const r = rows[j];
        if (!r||!r[0]) continue;
        if (String(r[0]).trim()==="Row Labels") break;
        if (String(r[0]).trim()==="Grand Total") continue;
        result.keyAccounts.push({
          name:     String(r[0]).trim(),
          unapplied:parseFloat(r[1])||0,
          current:  parseFloat(r[2])||0,
          days1_7:  parseFloat(r[3])||0,
          pastDue:  parseFloat(r[8])||0,
          notes:    String(r[9]||r[10]||"").trim(),
        });
      }
    }
  }
  return result;
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
  const [apParaFile,setApParaFile]= useState(null);
  const [apBnyFile, setApBnyFile] = useState(null);
  const [arFile,    setArFile]    = useState(null);
  const [gpPreview,  setGpPreview]  = useState(null);
  const [apParaData, setApParaData] = useState(null);
  const [apBnyData,  setApBnyData]  = useState(null);
  const [arData,     setArData]     = useState(null);
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

  async function handleAPPara(file) {
    setApParaFile(file); setStatus("apPara","Parsing…");
    try {
      const XLSX = await loadSheetJS();
      const wb   = XLSX.read(await file.arrayBuffer(),{type:"array"});
      const data = parseAPSheet(XLSX, wb, "Paramount");
      if (!data) { setStatus("apPara","⚠ AP Aging sheet not found"); return; }
      setApParaData(data);
      setStatus("apPara",`✓ ${data.vendors.length} vendors · ${fmt(data.total)}`);
    } catch(e) { setStatus("apPara","⚠ "+e.message); }
  }

  async function handleAPBny(file) {
    setApBnyFile(file); setStatus("apBny","Parsing…");
    try {
      const XLSX = await loadSheetJS();
      const wb   = XLSX.read(await file.arrayBuffer(),{type:"array"});
      const data = parseAPSheet(XLSX, wb, "BNY");
      if (!data) { setStatus("apBny","⚠ AP Aging sheet not found"); return; }
      setApBnyData(data);
      setStatus("apBny",`✓ ${data.vendors.length} vendors · ${fmt(data.total)}`);
    } catch(e) { setStatus("apBny","⚠ "+e.message); }
  }

  async function handleAR(file) {
    setArFile(file); setStatus("ar","Parsing…");
    try {
      const XLSX = await loadSheetJS();
      const wb   = XLSX.read(await file.arrayBuffer(),{type:"array"});
      const data = parseARFile(XLSX, wb);
      setArData(data);
      setStatus("ar",`✓ ${fmt(data.totalOutstanding)} outstanding · ${data.keyAccounts.length} key accounts`);
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
      if (apParaData) apRows.push({ period:selectedPeriod, facility:"Paramount",
        total:apParaData.total, current:apParaData.current, days1_7:apParaData.days1_7,
        days8_14:apParaData.days8_14, days15_30:apParaData.days15_30, days31_45:apParaData.days31_45,
        days45plus:apParaData.days45plus, past_due:apParaData.pastDue,
        top_vendors:apParaData.vendors.slice(0,10), uploaded_at:new Date().toISOString() });
      if (apBnyData) apRows.push({ period:selectedPeriod, facility:"BNY",
        total:apBnyData.total, current:apBnyData.current, days1_7:apBnyData.days1_7,
        days8_14:apBnyData.days8_14, days15_30:apBnyData.days15_30, days31_45:apBnyData.days31_45,
        days45plus:apBnyData.days45plus, past_due:apBnyData.pastDue,
        top_vendors:apBnyData.vendors.slice(0,10), uploaded_at:new Date().toISOString() });
      if (apRows.length) {
        const {error} = await supabase.from("financial_ap").upsert(apRows,{onConflict:"period,facility"});
        if (error) throw new Error("AP: "+error.message);
      }
      if (arData) {
        const {error} = await supabase.from("financial_ar").upsert({
          period:selectedPeriod, aging_current:arData.aging.current||0,
          aging_1_30:arData.aging.days1_30||0, aging_31_60:arData.aging.days31_60||0,
          aging_61_90:arData.aging.days61_90||0, aging_91plus:arData.aging.days91plus||0,
          total_outstanding:arData.totalOutstanding||0, total_past_due:arData.totalPastDue||0,
          key_accounts:arData.keyAccounts, uploaded_at:new Date().toISOString()
        },{onConflict:"period"});
        if (error) throw new Error("AR: "+error.message);
      }
      setSaveMsg({type:"success",text:`✓ All saved to ${selectedPeriod}`});
      setGpFile(null); setApParaFile(null); setApBnyFile(null); setArFile(null);
      setGpPreview(null); setApParaData(null); setApBnyData(null); setArData(null);
      setFileStatus({});
      loadHistory();
    } catch(e) { setSaveMsg({type:"error",text:e.message}); }
    setSaving(false);
  }

  const hasAnyFile = gpPreview||apParaData||apBnyData||arData;

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

      {/* Drop zones */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:14}}>
        <DropZone label="GP Report"     sublabel="COGS · OpEx · Inventory" accept=".xlsx,.xls,.csv" file={gpFile}     onFile={handleGP}     status={fileStatus.gp}     color="#4f46e5"/>
        <DropZone label="AP — Paramount" sublabel="Payment Schedule"        accept=".xlsx"           file={apParaFile} onFile={handleAPPara} status={fileStatus.apPara} color="#0369a1"/>
        <DropZone label="AP — BNY"       sublabel="Payment Schedule"        accept=".xlsx"           file={apBnyFile}  onFile={handleAPBny}  status={fileStatus.apBny}  color="#0369a1"/>
        <DropZone label="AR Aging"       sublabel="AR Update"               accept=".xlsx"           file={arFile}     onFile={handleAR}     status={fileStatus.ar}     color="#7c3aed"/>
        <DropZone label="Cash"           sublabel="Coming soon"             accept=".xlsx"           file={null}       onFile={()=>{}}       status="○ Not yet configured" disabled/>
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
      {(apParaData||apBnyData)&&(
        <div style={{border:"1px solid #e5e7eb",borderRadius:10,overflow:"hidden"}}>
          <div style={{background:"#f9fafb",padding:"8px 16px",borderBottom:"1px solid #e5e7eb",fontSize:13,fontWeight:600}}>AP Preview</div>
          <table style={{width:"100%",fontSize:13,borderCollapse:"collapse"}}>
            <thead><tr style={{borderBottom:"1px solid #e5e7eb"}}>
              {["Facility","Total","Current","1–7d","8–14d","15–30d","31–45d","45d+","Past Due"].map((h,i)=>
                <th key={h} style={{textAlign:i===0?"left":"right",padding:"7px 12px",color:"#6b7280",fontWeight:500,fontSize:11}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {[apParaData,apBnyData].filter(Boolean).map(d=>(
                <tr key={d.facility} style={{borderBottom:"1px solid #f3f4f6"}}>
                  <td style={{padding:"8px 12px",fontWeight:600}}>{d.facility}</td>
                  {[d.total,d.current,d.days1_7,d.days8_14,d.days15_30,d.days31_45,d.days45plus].map((v,i)=>
                    <td key={i} style={{padding:"8px 12px",textAlign:"right"}}>{fmt(v)}</td>)}
                  <td style={{padding:"8px 12px",textAlign:"right",color:d.pastDue>0?"#b91c1c":"#15803d",fontWeight:600}}>{fmt(d.pastDue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {[apParaData,apBnyData].filter(Boolean).map(d=>(
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
            AR — {fmt(arData.totalOutstanding)} total outstanding
          </div>
          <div style={{display:"flex",borderBottom:"1px solid #f3f4f6"}}>
            {[["Current",arData.aging.current,0],["1–30d",arData.aging.days1_30,1],
              ["31–60d",arData.aging.days31_60,2],["61–90d",arData.aging.days61_90,3],["91d+",arData.aging.days91plus,4]]
              .map(([label,val,i])=>(
              <div key={label} style={{flex:1,padding:"10px 8px",textAlign:"center",borderRight:i<4?"1px solid #f3f4f6":"none"}}>
                <div style={{fontSize:10,color:"#9ca3af",fontWeight:600,textTransform:"uppercase"}}>{label}</div>
                <div style={{fontSize:14,fontWeight:700,marginTop:2,
                  color:i===0?"#15803d":i>=3?"#b91c1c":"#b45309"}}>{fmt(val)}</div>
              </div>
            ))}
          </div>
          {arData.keyAccounts.length>0&&(
            <div style={{padding:"10px 14px"}}>
              <div style={{fontSize:11,fontWeight:600,color:"#6b7280",marginBottom:8}}>KEY ACCOUNTS TO WATCH</div>
              <table style={{width:"100%",fontSize:12,borderCollapse:"collapse"}}>
                <thead><tr>
                  {["Account","Unapplied","Current","Past Due","Notes"].map((h,i)=>
                    <th key={h} style={{textAlign:i===0?"left":"right",padding:"4px 8px",color:"#9ca3af",fontWeight:500,fontSize:11,borderBottom:"1px solid #f3f4f6"}}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {arData.keyAccounts.map(a=>(
                    <tr key={a.name} style={{borderBottom:"1px solid #f9fafb"}}>
                      <td style={{padding:"5px 8px",fontWeight:500}}>{a.name}</td>
                      <td style={{padding:"5px 8px",textAlign:"right"}}>{fmt(a.unapplied)}</td>
                      <td style={{padding:"5px 8px",textAlign:"right"}}>{fmt(a.current)}</td>
                      <td style={{padding:"5px 8px",textAlign:"right",color:a.pastDue>0?"#b91c1c":"#15803d",fontWeight:500}}>{fmt(a.pastDue)}</td>
                      <td style={{padding:"5px 8px",color:"#6b7280",fontSize:11}}>{a.notes.slice(0,80)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Save */}
      {hasAnyFile&&(
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <button onClick={handleSaveAll} disabled={saving||!selectedPeriod}
            style={{padding:"10px 24px",background:selectedPeriod?"#1f2937":"#9ca3af",color:"#fff",
              border:"none",borderRadius:8,fontSize:14,fontWeight:600,cursor:selectedPeriod?"pointer":"not-allowed"}}>
            {saving?"Saving…":`Save All to ${selectedPeriod||"…"}`}
          </button>
          {saveMsg&&<div style={{fontSize:13,fontWeight:500,color:saveMsg.type==="error"?"#b91c1c":"#15803d"}}>{saveMsg.text}</div>}
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
