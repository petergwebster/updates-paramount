import { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";
import { parsePurchasesWorkbook } from "../lib/purchasesWorkbook";
import { canWriteAging, weekSaturdayOf } from "../lib/arApLock";

// ── SheetJS loader ──────────────────────────────────────────────────────────
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

// ── Formatters ──────────────────────────────────────────────────────────────
const fmt  = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n||0);
const fmtD = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "";
const MONTH_LABEL = { "01":"January","02":"February","03":"March","04":"April","05":"May","06":"June","07":"July","08":"August","09":"September","10":"October","11":"November","12":"December" };
const monthLabel = m => { if(!m) return ""; const [y,mo]=m.split("-"); return `${MONTH_LABEL[mo]||mo} ${y}`; };

const TAB_LABEL = {
  inventory_ink_freight:"Inventory · Ink · Freight",
  sales_ar_invoiced:"AR — Invoiced (Sales)",
  ar_received:"AR — Received (Cash)",
  ap_invoiced:"AP — Invoiced",
  ap_paid:"AP — Paid",
  opex_te:"OpEx & T&E",
  capex:"CapEx",
};
const CAT_LABEL = {
  material_inventory:"Material / Inventory", ink:"Ink", freight:"Freight", inventory_other:"Inventory (other)",
  opex_temp:"Temp / Contract", opex_te:"Travel & Entertainment", opex_distribution:"Distribution",
  opex_edp:"Office / EDP", opex_supplies:"Supplies", opex_printing:"Printing", opex_services:"Outside Services",
  opex_utilities:"Utilities", opex_rent:"Rent", opex_other:"OpEx (other)", prepaid:"Prepaid", line_dev:"Line Development",
  ar_trade:"AR Trade", ar_adjustment:"AR Adjustments", ar_receipt:"Cash Receipts",
  ap_invoiced:"AP Invoiced", ap_paid:"AP Paid", capex:"CapEx", other:"Other",
};
const BU_LABEL = { BNY:"BNY Brooklyn", NJ:"Passaic NJ", Shared:"Shared", "?":"Unmapped" };

// ── Drop zone ───────────────────────────────────────────────────────────────
function DropZone({ accept, onFile, file, status, color="#4f46e5", busy }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:6}}>
      <div
        onClick={() => !busy && ref.current?.click()}
        onDragOver={e=>{if(!busy){e.preventDefault();setDrag(true)}}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);if(!busy){const f=e.dataTransfer.files[0];if(f)onFile(f)}}}
        style={{ border:`2px dashed ${drag?color:file?"#6ee7b7":"#d1d5db"}`, borderRadius:12,
          padding:"28px 18px", textAlign:"center", cursor:busy?"default":"pointer", transition:"all 0.15s",
          background:drag?"#f0f9ff":file?"#f0fdf4":"#fafafa",
          display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:6 }}
      >
        <input ref={ref} type="file" accept={accept} style={{display:"none"}}
          onChange={e=>{const f=e.target.files?.[0];if(f)onFile(f);e.target.value="";}}/>
        {file ? (
          <><div style={{fontSize:22}}>✓</div><div style={{fontSize:13,fontWeight:600,color:"#15803d",wordBreak:"break-all"}}>{file.name}</div></>
        ) : (
          <><div style={{fontSize:26,color:"#d1d5db"}}>+</div>
            <div style={{fontSize:14,color:"#374151",fontWeight:600}}>Drop the GP Purchases workbook</div>
            <div style={{fontSize:12,color:"#9ca3af"}}>Inventory · AR · AP · OpEx · CapEx · Aging — one .xlsx</div></>
        )}
      </div>
      {status && <div style={{fontSize:12,color:status.startsWith("✓")?"#15803d":status.startsWith("⚠")?"#b45309":"#6b7280"}}>{status}</div>}
    </div>
  );
}

// ── Small UI helpers ─────────────────────────────────────────────────────────
function StatGrid({ title, rows, labelMap }) {
  const entries = Object.entries(rows).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  return (
    <div style={{border:"1px solid #e5e7eb",borderRadius:10,overflow:"hidden"}}>
      <div style={{background:"#f9fafb",padding:"7px 14px",borderBottom:"1px solid #e5e7eb",fontSize:12,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.04em",color:"#6b7280"}}>{title}</div>
      <table style={{width:"100%",fontSize:13,borderCollapse:"collapse"}}>
        <tbody>
          {entries.map(([k,v])=>(
            <tr key={k} style={{borderBottom:"1px solid #f3f4f6"}}>
              <td style={{padding:"6px 14px"}}>{(labelMap&&labelMap[k])||k}</td>
              <td style={{padding:"6px 14px",textAlign:"right",fontVariantNumeric:"tabular-nums",color:v<0?"#b91c1c":"#111827"}}>{fmt(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function AdminFinancials() {
  const [file, setFile]         = useState(null);
  const [status, setStatus]     = useState("");
  const [parsed, setParsed]     = useState(null);
  const [busy, setBusy]         = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saveMsg, setSaveMsg]   = useState(null);
  const [history, setHistory]   = useState([]);
  const [loadingHist, setLoadingHist] = useState(false);

  useEffect(() => { loadHistory(); }, []);

  async function loadHistory() {
    setLoadingHist(true);
    const { data, error } = await supabase
      .from("financial_transactions")
      .select("fiscal_month, source_tab, net")
      .order("fiscal_month", { ascending: false })
      .limit(20000);
    if (!error && data) {
      const byMonth = {};
      for (const r of data) {
        const m = r.fiscal_month || "—";
        if (!byMonth[m]) byMonth[m] = { month:m, count:0, net:0 };
        byMonth[m].count++; byMonth[m].net += (r.net || 0);
      }
      setHistory(Object.values(byMonth).sort((a,b)=> b.month.localeCompare(a.month)));
    }
    setLoadingHist(false);
  }

  async function handleFile(f) {
    setFile(f); setParsed(null); setSaveMsg(null); setBusy(true); setStatus("Reading workbook…");
    try {
      const XLSX = await loadSheetJS();
      const wb   = XLSX.read(await f.arrayBuffer(), { type:"array" });
      const res  = parsePurchasesWorkbook(XLSX, wb, { fileName: f.name });
      if (!res.transactions.length) { setStatus("⚠ No transactional rows found — is this the right workbook?"); setBusy(false); return; }
      setParsed(res);
      setStatus(`✓ ${res.summary.txnCount.toLocaleString()} transactions · ${res.summary.agingCount.toLocaleString()} aging rows · as-of ${fmtD(res.asOfDate)}`);
    } catch (e) {
      console.error(e); setStatus("⚠ " + e.message);
    }
    setBusy(false);
  }

  async function handleSave() {
    if (!parsed) return;
    setSaving(true); setSaveMsg(null);
    try {
      const { transactions, aging, summary, asOfDate } = parsed;
      const months = summary.fiscalMonths.length ? summary.fiscalMonths : [...new Set(transactions.map(t=>t.fiscal_month).filter(Boolean))];

      // 1) Replace-by-window: delete existing txns for every fiscal month in the file.
      //    OpEx / COGS / CapEx / cash-flow ALWAYS refresh — never locked.
      for (const m of months) {
        const { error } = await supabase.from("financial_transactions").delete().eq("fiscal_month", m);
        if (error) throw new Error("Clearing " + m + ": " + error.message);
      }
      // 2) Bulk insert in chunks (Supabase caps ~1000/call)
      const CHUNK = 500;
      for (let i = 0; i < transactions.length; i += CHUNK) {
        const { error } = await supabase.from("financial_transactions").insert(transactions.slice(i, i+CHUNK));
        if (error) throw new Error("Inserting transactions: " + error.message);
      }
      // 3) Aging snapshot (AR/AP ONLY) — LOCK-AWARE.
      //    AR/AP freeze at Saturday-midnight ET for the just-completed week; a locked
      //    week's snapshot is preserved and NOT overwritten by later uploads. (OpEx/COGS/
      //    CapEx above are never locked — they keep refreshing until month-end true-up.)
      let agingLockNote = "";
      if (aging.length && asOfDate) {
        const { data: existing, error: exErr } = await supabase
          .from("financial_aging").select("as_of_date");
        if (exErr) throw new Error("Reading aging history: " + exErr.message);
        const existingDates = [...new Set((existing || []).map(r => r.as_of_date).filter(Boolean))];
        const gate = canWriteAging(asOfDate, existingDates);
        if (!gate.allowed) {
          agingLockNote = `🔒 AR/AP for week ending ${weekSaturdayOf(asOfDate)} is locked — preserved`;
        } else {
          for (const t of [...new Set(aging.map(a=>a.aging_type))]) {
            const { error } = await supabase.from("financial_aging").delete().eq("as_of_date", asOfDate).eq("aging_type", t);
            if (error) throw new Error("Clearing aging " + t + ": " + error.message);
          }
          for (let i = 0; i < aging.length; i += CHUNK) {
            const { error } = await supabase.from("financial_aging").insert(aging.slice(i, i+CHUNK));
            if (error) throw new Error("Inserting aging: " + error.message);
          }
        }
      }
      const agingTxt = agingLockNote
        ? ` · ${agingLockNote}`
        : (aging.length ? ` + ${aging.length.toLocaleString()} aging rows` : "");
      setSaveMsg({ type:"success", text:`✓ Saved ${transactions.length.toLocaleString()} transactions${agingTxt} · ${months.map(monthLabel).join(", ")}` });
      setFile(null); setParsed(null); setStatus("");
      loadHistory();
    } catch (e) {
      console.error(e); setSaveMsg({ type:"error", text:e.message });
    }
    setSaving(false);
  }

  const s = parsed?.summary;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:24}}>
      {/* Intro */}
      <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#15803d"}}>
        Drop Jen's full GP Purchases workbook. It loads <strong>Inventory · AR · AP · OpEx · CapEx</strong> as line-level transactions plus <strong>AR/AP aging</strong> snapshots. Re-uploading the same period safely replaces it (backward adjustments reconcile automatically). <strong>AR/AP aging locks at Saturday midnight ET</strong> for the completed week; OpEx/COGS/CapEx keep refreshing until month-end.
      </div>

      {/* Drop zone */}
      <DropZone accept=".xlsx" file={file} onFile={handleFile} status={status} busy={busy} />

      {/* Preview */}
      {parsed && s && (
        <div style={{display:"flex",flexDirection:"column",gap:18}}>
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:160,border:"1px solid #e5e7eb",borderRadius:10,padding:"12px 16px"}}>
              <div style={{fontSize:11,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.05em",fontWeight:600}}>Fiscal Period</div>
              <div style={{fontSize:18,fontWeight:700,marginTop:3}}>{s.fiscalMonths.map(monthLabel).join(", ") || "—"}</div>
              <div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>as-of {fmtD(s.asOf)}</div>
            </div>
            <div style={{flex:1,minWidth:160,border:"1px solid #e5e7eb",borderRadius:10,padding:"12px 16px"}}>
              <div style={{fontSize:11,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.05em",fontWeight:600}}>Transactions</div>
              <div style={{fontSize:18,fontWeight:700,marginTop:3}}>{s.txnCount.toLocaleString()}</div>
              <div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{s.agingCount.toLocaleString()} aging rows</div>
            </div>
            <div style={{flex:1,minWidth:160,border:"1px solid #e5e7eb",borderRadius:10,padding:"12px 16px"}}>
              <div style={{fontSize:11,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.05em",fontWeight:600}}>AR / AP Aging</div>
              <div style={{fontSize:18,fontWeight:700,marginTop:3}}>{fmt(s.arAgingTotal)}<span style={{fontSize:12,color:"#9ca3af"}}> AR</span></div>
              <div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{fmt(s.apAgingTotal)} AP balance</div>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:14}}>
            <StatGrid title="Net by Source" rows={s.netByTab} labelMap={TAB_LABEL} />
            <StatGrid title="Net by Business Unit" rows={s.netByBU} labelMap={BU_LABEL} />
          </div>
          <StatGrid title="Net by Category" rows={s.netByCategory} labelMap={CAT_LABEL} />

          {parsed.warnings?.length > 0 && (
            <div style={{fontSize:12,color:"#b45309"}}>{parsed.warnings.join(" · ")}</div>
          )}

          <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
            <button onClick={handleSave} disabled={saving}
              style={{padding:"10px 26px",background:saving?"#9ca3af":"#1f2937",color:"#fff",border:"none",borderRadius:8,fontSize:14,fontWeight:600,cursor:saving?"default":"pointer"}}>
              {saving ? "Saving…" : `Save ${s.txnCount.toLocaleString()} transactions`}
            </button>
            {saveMsg && <div style={{fontSize:13,fontWeight:500,color:saveMsg.type==="error"?"#b91c1c":"#15803d"}}>{saveMsg.text}</div>}
          </div>
        </div>
      )}

      {!parsed && saveMsg && (
        <div style={{fontSize:13,fontWeight:500,color:saveMsg.type==="error"?"#b91c1c":"#15803d"}}>{saveMsg.text}</div>
      )}

      {/* History */}
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div style={{fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",color:"#6b7280"}}>Loaded Periods</div>
          <button onClick={loadHistory} style={{fontSize:12,color:"#4f46e5",background:"none",border:"none",cursor:"pointer"}}>{loadingHist?"Loading…":"Refresh"}</button>
        </div>
        {history.length === 0 ? <p style={{fontSize:13,color:"#9ca3af"}}>No financial data loaded yet.</p> : (
          <table style={{width:"100%",fontSize:13,borderCollapse:"collapse"}}>
            <thead><tr style={{borderBottom:"1px solid #e5e7eb"}}>
              {["Fiscal Month","Transactions","Net"].map((h,i)=>
                <th key={h} style={{textAlign:i===0?"left":"right",paddingBottom:8,color:"#6b7280",fontWeight:500}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {history.map(h=>(
                <tr key={h.month} style={{borderBottom:"1px solid #f3f4f6"}}>
                  <td style={{padding:"6px 0"}}>{monthLabel(h.month)}</td>
                  <td style={{padding:"6px 0",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{h.count.toLocaleString()}</td>
                  <td style={{padding:"6px 0",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{fmt(h.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
