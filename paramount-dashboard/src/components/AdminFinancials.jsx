import { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";

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

function findCol(row, ...candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const norm = c.toLowerCase().replace(/\s+/g, "");
    const hit  = keys.find((k) => k.toLowerCase().replace(/\s+/g, "") === norm);
    if (hit !== undefined) return hit;
  }
  return null;
}

// ─── Full GL parser with sub-column breakdown ─────────────────────────────────
//
// Account object codes → DB columns:
//
//  COGS (use NET):
//    4104, 4105 → cogs_material
//    4108, 4109 → cogs_labor
//    4111, 4112 → cogs_wip
//    4113, 4114 → cogs_other
//
//  Inventory (use Debit Amount):
//    1437       → inv_purchases
//
//  OpEx (use positive NET, exclude 6116):
//    6115                              → salary
//    6120, 6125, 6130, 6135           → salary_ot
//    6195                              → fringe
//    6205, 6220, 6221, 6255, 6260,
//      6270, 6271                      → te
//    4305, 4313, 6405, 6410, 6415,
//      6420, 6430, 6435               → distribution
//    6312                              → printing
//    4815, 6505, 6510, 6515, 6520,
//      6525, 6530, 6540, 6550,
//      6640, 6815                      → office_edp
//    6630                              → consulting
//    6710                              → building
//    6715                              → utilities
//    6740, 6745                        → rent
//    6116 (NET, usually negative)      → capitalization
//
function parseGL(rows) {
  if (!rows.length) return {};
  const UNITS = ["609", "610", "612"];
  const zero  = () => ({
    cogs_material:0, cogs_labor:0, cogs_wip:0, cogs_other:0,
    salary:0, salary_ot:0, fringe:0, te:0, printing:0,
    distribution:0, office_edp:0, consulting:0,
    building:0, utilities:0, rent:0, capitalization:0,
    inv_purchases:0,
    _vendors:{},
  });
  const totals = {};
  UNITS.forEach((u) => { totals[u] = zero(); });

  const s      = rows[0];
  const colBU  = findCol(s,"BusinessUnit","Business Unit","BU");
  const colAcc = findCol(s,"Account Number","AccountNumber","Account No");
  const colDeb = findCol(s,"Debit Amount","DebitAmount","Debit");
  const colNet = findCol(s,"NET","Net","Net Amount");

  rows.forEach((row) => {
    const bu = String(colBU ? row[colBU] : "").trim();
    if (!UNITS.includes(bu)) return;
    const acct = String(colAcc ? row[colAcc] : "");
    const m    = acct.match(/-(\d{4})-/);
    if (!m) return;
    const obj  = parseInt(m[1], 10);
    const deb  = parseFloat(colDeb ? row[colDeb] : 0) || 0;
    const net  = parseFloat(colNet ? row[colNet] : 0) || 0;
    const posNet = net > 0 ? net : 0;
    const t    = totals[bu];

    // COGS — use NET
    if      ([4104,4105].includes(obj)) t.cogs_material += net;
    else if ([4108,4109].includes(obj)) t.cogs_labor    += net;
    else if ([4111,4112].includes(obj)) t.cogs_wip      += net;
    else if ([4113,4114].includes(obj)) t.cogs_other    += net;
    // Inventory purchases — use Debit Amount
    else if (obj === 1437 && deb > 0) {
      t.inv_purchases += deb;
      const rawName = row[findCol(row,"Originating Master Name","OriginatingMasterName","Master Name")||""] || "";
      const name = String(rawName).replace(/\s*-\s*FOR\s+(PARAMOUNT|BNY)[\w\s]*$/i,"").replace(/\s+/g," ").trim() || "Unknown";
      t._vendors[name] = (t._vendors[name] || 0) + deb;
    }
    // Capitalization contra — use NET (typically negative)
    else if (obj === 6116)              t.capitalization += net;
    // OpEx — use positive NET
    else if (obj === 6115)                                          t.salary       += posNet;
    else if ([6120,6125,6130,6135].includes(obj))                   t.salary_ot    += posNet;
    else if (obj === 6195)                                          t.fringe       += posNet;
    else if ([6205,6220,6221,6255,6260,6270,6271].includes(obj))    t.te           += posNet;
    else if ([4305,4313,6405,6410,6415,6420,6430,6435].includes(obj)) t.distribution += posNet;
    else if (obj === 6312)                                          t.printing     += posNet;
    else if ([4815,6505,6510,6515,6520,6525,6530,6540,6550,6640,6815].includes(obj)) t.office_edp += posNet;
    else if (obj === 6630)                                          t.consulting   += posNet;
    else if (obj === 6710)                                          t.building     += posNet;
    else if (obj === 6715)                                          t.utilities    += posNet;
    else if ([6740,6745].includes(obj))                             t.rent         += posNet;
  });

  return totals;
}

function buildRow(period, bu, t) {
  const r = (n) => Math.round((n || 0) * 100) / 100;
  return {
    period, business_unit: bu,
    cogs_material:  r(t.cogs_material),
    cogs_labor:     r(t.cogs_labor),
    cogs_wip:       r(t.cogs_wip),
    cogs_other:     r(t.cogs_other),
    salary:         r(t.salary),
    salary_ot:      r(t.salary_ot),
    fringe:         r(t.fringe),
    te:             r(t.te),
    printing:       r(t.printing),
    distribution:   r(t.distribution),
    office_edp:     r(t.office_edp),
    consulting:     r(t.consulting),
    building:       r(t.building),
    utilities:      r(t.utilities),
    rent:           r(t.rent),
    capitalization: r(t.capitalization),
    inv_purchases:  r(t.inv_purchases),
    inv_vendors:    Object.entries(t._vendors||{})
      .map(([name,amount])=>({name,amount:Math.round(amount*100)/100}))
      .sort((a,b)=>b.amount-a.amount),
    uploaded_at:    new Date().toISOString(),
  };
}

function generatePeriodOptions() {
  const options = [];
  const now = new Date();
  for (let m = -2; m <= 1; m++) {
    const d  = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const yr = d.getFullYear();
    const mo = d.getMonth() + 1;
    const mm = String(mo).padStart(2,"0");
    const lb = d.toLocaleString("en-US",{month:"long"});
    for (let w = 1; w <= 5; w++)
      options.push({ value:`${yr}-${mm}-W${w}`, label:`${lb} ${yr} — Week ${w}  (${yr}-${mm}-W${w})` });
  }
  return options;
}

function guessPeriod(rows) {
  if (!rows.length) return null;
  const pid = rows[0]["Period ID"];
  const yr  = rows[0]["Open Year"];
  if (typeof pid !== "number" || !yr) return null;
  const mm = String(pid).padStart(2,"0");
  let maxDay = 1;
  rows.forEach((row) => {
    const raw = row["TRX Date"];
    if (typeof raw === "string") { const m = raw.match(/DATE\(\d+,\d+,(\d+)\)/); if (m) maxDay = Math.max(maxDay,+m[1]); }
    else if (typeof raw === "number") maxDay = Math.max(maxDay, new Date((raw-25569)*86400000).getDate());
  });
  return `${parseInt(yr)}-${mm}-W${Math.min(Math.ceil(maxDay/7),5)}`;
}

export default function AdminFinancials({ weekStart }) {
  const [uploading, setUploading]           = useState(false);
  const [message, setMessage]               = useState(null);
  const [preview, setPreview]               = useState(null);
  const [uploads, setUploads]               = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [showPeriodPicker, setShowPeriodPicker] = useState(false);
  const fileInputRef = useRef(null);
  const periodOptions = generatePeriodOptions();

  // Auto-derive period from weekStart prop
  function derivePeriodFromWeekStart(ws) {
    if (!ws) return "";
    const d = typeof ws === "string" ? new Date(ws + "T12:00:00") : ws;
    const yr = d.getFullYear();
    const mo = d.getMonth() + 1;
    const mm = String(mo).padStart(2, "0");
    const day = d.getDate();
    const wk = Math.min(Math.ceil(day / 7), 5);
    return `${yr}-${mm}-W${wk}`;
  }

  const [selectedPeriod, setSelectedPeriod] = useState(() => derivePeriodFromWeekStart(weekStart));

  useEffect(() => {
    setSelectedPeriod(derivePeriodFromWeekStart(weekStart));
    loadHistory();
  }, [weekStart]);

  async function loadHistory() {
    setLoadingHistory(true);
    const { data } = await supabase
      .from("financials_monthly")
      .select("period, business_unit, cogs_total, opex_total, inv_purchases, uploaded_at")
      .order("period",{ascending:false})
      .order("business_unit",{ascending:true})
      .limit(30);
    setUploads(data || []);
    setLoadingHistory(false);
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMessage(null); setPreview(null);
    try {
      const XLSX  = await loadSheetJS();
      const buf   = await file.arrayBuffer();
      const wb    = XLSX.read(buf, { type:"array" });
      const rows  = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw:true });
      if (!rows.length) { setMessage({type:"error",text:"File appears empty."}); return; }
      const s = rows[0];
      const missing = [];
      if (!findCol(s,"BusinessUnit","Business Unit","BU"))           missing.push("BusinessUnit");
      if (!findCol(s,"Account Number","AccountNumber","Account No")) missing.push("Account Number");
      if (!findCol(s,"Debit Amount","DebitAmount","Debit"))          missing.push("Debit Amount");
      if (!findCol(s,"NET","Net","Net Amount"))                      missing.push("NET");
      if (missing.length) {
        setMessage({type:"error", text:`Can't find: ${missing.join(", ")}. File columns: ${Object.keys(s).slice(0,10).join(", ")}`});
        return;
      }
      const totals  = parseGL(rows);
      const guessed = guessPeriod(rows);
      if (guessed && !selectedPeriod) setSelectedPeriod(guessed); // only override if weekStart didn't set one
      setPreview({ totals, rowCount:rows.length, guessed });
    } catch(err) { setMessage({type:"error", text:`Parse error: ${err.message}`}); }
  }

  async function handleSave() {
    if (!preview || !selectedPeriod) return;
    setUploading(true); setMessage(null);
    const rows = Object.entries(preview.totals).map(([bu,t]) => buildRow(selectedPeriod, bu, t));
    const { error } = await supabase.from("financials_monthly").upsert(rows, {onConflict:"period,business_unit"});
    if (error) { setMessage({type:"error", text:`Save failed: ${error.message}`}); }
    else {
      setMessage({type:"success", text:`✓ Saved as ${selectedPeriod}`});
      setPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      loadHistory();
    }
    setUploading(false);
  }

  const fmt     = (n) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n??0);
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "";
  const BU      = {"609":"BNY Brooklyn","610":"Passaic NJ","612":"Shared"};

  return (
    <div style={{display:"flex",flexDirection:"column",gap:24}}>
      <div>
        <h2 style={{fontSize:20,fontWeight:600,margin:0}}>Financial Data Upload</h2>
        <p style={{fontSize:13,color:"#666",marginTop:4}}>Upload the weekly GP purchase report. <strong>Select the correct week</strong> before saving.</p>
      </div>

      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"8px 14px"}}>
        <span style={{fontSize:12,color:"#15803d",fontWeight:600}}>📅 Saving to period:</span>
        <span style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:"#15803d"}}>{selectedPeriod || "—"}</span>
        <button onClick={()=>setShowPeriodPicker(p=>!p)} style={{fontSize:11,color:"#4338ca",background:"none",border:"1px solid #c7d2fe",borderRadius:4,padding:"2px 8px",cursor:"pointer",marginLeft:4}}>
          {showPeriodPicker ? "✕ close" : "change"}
        </button>
        {showPeriodPicker && (
          <select value={selectedPeriod} onChange={(e)=>{setSelectedPeriod(e.target.value);setShowPeriodPicker(false);}}
            style={{border:"1px solid #ccc",borderRadius:6,padding:"4px 8px",fontSize:12,background:"#fff",cursor:"pointer"}}>
            <option value="">— pick a week —</option>
            {periodOptions.map((o)=><option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </div>

      <label style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",width:"100%",height:140,border:"2px dashed #ccc",borderRadius:12,cursor:"pointer",background:"#fafafa"}}>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8,color:"#888"}}>
          <svg width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="#aaa" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z"/>
          </svg>
          <span style={{fontSize:13,fontWeight:500}}>Drop GP purchase report here or click to browse</span>
          <span style={{fontSize:11,color:"#aaa"}}>.xlsx · .xls · .csv</span>
        </div>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={handleFile}/>
      </label>

      {message && (
        <div style={{borderRadius:8,padding:"10px 14px",fontSize:13,fontWeight:500,
          background:message.type==="error"?"#fef2f2":"#f0fdf4",
          color:message.type==="error"?"#b91c1c":"#15803d",
          border:`1px solid ${message.type==="error"?"#fecaca":"#bbf7d0"}`}}>
          {message.text}
        </div>
      )}

      {preview && (
        <div style={{border:"1px solid #e5e7eb",borderRadius:12,overflow:"hidden"}}>
          <div style={{background:"#f9fafb",padding:"10px 16px",borderBottom:"1px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
            <div style={{fontSize:13}}>
              <strong>Preview — </strong>
              {selectedPeriod ? <span style={{color:"#4338ca",fontWeight:600}}>{selectedPeriod}</span> : <span style={{color:"#dc2626"}}>⚠ select a period above</span>}
              {preview.guessed && preview.guessed!==selectedPeriod && <span style={{marginLeft:8,fontSize:11,color:"#d97706"}}>(file suggests {preview.guessed})</span>}
              <span style={{marginLeft:12,fontSize:11,color:"#9ca3af"}}>{preview.rowCount.toLocaleString()} rows</span>
            </div>
            <button onClick={handleSave} disabled={uploading||!selectedPeriod}
              style={{padding:"6px 16px",background:selectedPeriod?"#4f46e5":"#a5b4fc",color:"#fff",border:"none",borderRadius:8,fontSize:13,fontWeight:500,cursor:selectedPeriod?"pointer":"not-allowed"}}>
              {uploading?"Saving…":`Save as ${selectedPeriod||"…"}`}
            </button>
          </div>
          <table style={{width:"100%",fontSize:13,borderCollapse:"collapse"}}>
            <thead>
              <tr style={{background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}>
                {["Business Unit","COGS","OpEx","Inv Purchases"].map((h,i)=>(
                  <th key={h} style={{textAlign:i===0?"left":"right",padding:"8px 16px",color:"#6b7280",fontWeight:500}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.totals).map(([bu,t])=>{
                const cogs = t.cogs_material+t.cogs_labor+t.cogs_wip+t.cogs_other;
                const opex = t.salary+t.salary_ot+t.fringe+t.te+t.printing+t.distribution+t.office_edp+t.consulting+t.building+t.utilities+t.rent;
                return (
                  <tr key={bu} style={{borderBottom:"1px solid #f3f4f6"}}>
                    <td style={{padding:"10px 16px",fontWeight:500}}>{BU[bu]}</td>
                    <td style={{padding:"10px 16px",textAlign:"right"}}>{fmt(cogs)}</td>
                    <td style={{padding:"10px 16px",textAlign:"right"}}>{fmt(opex)}</td>
                    <td style={{padding:"10px 16px",textAlign:"right"}}>{fmt(t.inv_purchases)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {Object.values(preview.totals).every((t)=>t.cogs_material+t.cogs_labor+t.cogs_wip+t.cogs_other===0) && (
            <div style={{padding:"8px 16px",background:"#fffbeb",borderTop:"1px solid #fde68a",fontSize:12,color:"#92400e"}}>
              ⚠ COGS = $0 — normal for mid-month files before closing entries are posted.
            </div>
          )}
        </div>
      )}

      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <h3 style={{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",color:"#6b7280",margin:0}}>Previous Uploads</h3>
          <button onClick={loadHistory} style={{fontSize:12,color:"#4f46e5",background:"none",border:"none",cursor:"pointer"}}>
            {loadingHistory?"Loading…":"Refresh"}
          </button>
        </div>
        {uploads.length===0 ? <p style={{fontSize:13,color:"#9ca3af"}}>No uploads yet.</p> : (
          <table style={{width:"100%",fontSize:13,borderCollapse:"collapse"}}>
            <thead>
              <tr style={{borderBottom:"1px solid #e5e7eb"}}>
                {["Period","BU","COGS","OpEx","Inv Purchases","Uploaded"].map((h,i)=>(
                  <th key={h} style={{textAlign:i<2?"left":"right",paddingBottom:8,color:"#6b7280",fontWeight:500}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {uploads.map((u,i)=>(
                <tr key={i} style={{borderBottom:"1px solid #f3f4f6"}}>
                  <td style={{padding:"7px 0",fontFamily:"monospace",fontSize:12}}>{u.period}</td>
                  <td style={{padding:"7px 0"}}>{BU[u.business_unit]||u.business_unit}</td>
                  <td style={{padding:"7px 0",textAlign:"right"}}>{fmt(u.cogs_total)}</td>
                  <td style={{padding:"7px 0",textAlign:"right"}}>{fmt(u.opex_total)}</td>
                  <td style={{padding:"7px 0",textAlign:"right"}}>{fmt(u.inv_purchases)}</td>
                  <td style={{padding:"7px 0",textAlign:"right",fontSize:11,color:"#9ca3af"}}>{fmtDate(u.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
