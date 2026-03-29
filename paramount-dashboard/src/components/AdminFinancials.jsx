import { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";

// ─── Load SheetJS from CDN (no npm install needed) ───────────────────────────
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

// ─── Fuzzy column finder ──────────────────────────────────────────────────────
function findCol(row, ...candidates) {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const norm = candidate.toLowerCase().replace(/\s+/g, "");
    const found = keys.find((k) => k.toLowerCase().replace(/\s+/g, "") === norm);
    if (found !== undefined) return found;
  }
  return null;
}

// ─── Account-code based GL parser ────────────────────────────────────────────
function parseGL(rows) {
  if (!rows.length) return {};
  const UNITS = ["609", "610", "612"];
  const totals = {};
  UNITS.forEach((u) => { totals[u] = { cogs: 0, opex: 0, inv: 0 }; });

  const sample = rows[0];
  const colBU    = findCol(sample, "BusinessUnit", "Business Unit", "BU");
  const colAcct  = findCol(sample, "Account Number", "AccountNumber", "Account No");
  const colDebit = findCol(sample, "Debit Amount", "DebitAmount", "Debit");
  const colNet   = findCol(sample, "NET", "Net", "Net Amount");

  rows.forEach((row) => {
    const bu = String(colBU ? row[colBU] : "").trim();
    if (!UNITS.includes(bu)) return;

    const acctNum = String(colAcct ? row[colAcct] : "");
    const objMatch = acctNum.match(/-(\d{4})-/);
    if (!objMatch) return;
    const obj = parseInt(objMatch[1], 10);

    const debit = parseFloat(colDebit ? row[colDebit] : 0) || 0;
    const net   = parseFloat(colNet   ? row[colNet]   : 0) || 0;

    if (obj >= 4100 && obj <= 4199) {
      totals[bu].cogs += net;
    } else if (obj === 1437) {
      totals[bu].inv += debit;
    } else if (
      (obj >= 4300 && obj <= 4399) ||
      (obj >= 4800 && obj <= 4899) ||
      (obj >= 6000 && obj !== 6116)
    ) {
      if (debit > 0) totals[bu].opex += debit;
    }
  });

  return totals;
}

// ─── Period options: past 3 months + next month, W1–W5 ───────────────────────
function generatePeriodOptions() {
  const options = [];
  const now = new Date();
  for (let m = -2; m <= 1; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const mm = String(month).padStart(2, "0");
    const monthLabel = d.toLocaleString("en-US", { month: "long" });
    for (let w = 1; w <= 5; w++) {
      options.push({
        value: `${year}-${mm}-W${w}`,
        label: `${monthLabel} ${year} — Week ${w}  (${year}-${mm}-W${w})`,
      });
    }
  }
  return options;
}

function guessPeriodFromFile(rows) {
  if (!rows.length) return null;
  const periodId = rows[0]["Period ID"];
  const openYear = rows[0]["Open Year"];
  if (typeof periodId !== "number" || !openYear) return null;

  const year  = parseInt(openYear);
  const month = periodId;
  const mm    = String(month).padStart(2, "0");

  let maxDay = 1;
  rows.forEach((row) => {
    const raw = row["TRX Date"];
    if (typeof raw === "string") {
      const m = raw.match(/DATE\(\d+,\d+,(\d+)\)/);
      if (m) maxDay = Math.max(maxDay, parseInt(m[1]));
    } else if (typeof raw === "number") {
      const d = new Date((raw - 25569) * 86400000);
      maxDay = Math.max(maxDay, d.getDate());
    }
  });

  const weekNum = Math.min(Math.ceil(maxDay / 7), 5);
  return `${year}-${mm}-W${weekNum}`;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function AdminFinancials({ weekStart }) {
  const [uploading, setUploading]           = useState(false);
  const [message, setMessage]               = useState(null);
  const [preview, setPreview]               = useState(null);
  const [uploads, setUploads]               = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [detectedCols, setDetectedCols]     = useState(null);
  const fileInputRef = useRef(null);

  const periodOptions = generatePeriodOptions();

  useEffect(() => { loadHistory(); }, []);

  async function loadHistory() {
    setLoadingHistory(true);
    const { data, error } = await supabase
      .from("financials_monthly")
      .select("period, business_unit, business_unit_label, cogs, opex, inv_purchases, uploaded_at")
      .order("period", { ascending: false })
      .order("business_unit", { ascending: true })
      .limit(30);
    if (!error) setUploads(data || []);
    setLoadingHistory(false);
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMessage(null);
    setPreview(null);
    setDetectedCols(null);

    try {
      const XLSX = await loadSheetJS();
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: "array" });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { raw: true });

      if (!rows.length) {
        setMessage({ type: "error", text: "File appears empty." });
        return;
      }

      // Detect columns
      const sample = rows[0];
      const colBU    = findCol(sample, "BusinessUnit", "Business Unit", "BU");
      const colAcct  = findCol(sample, "Account Number", "AccountNumber", "Account No");
      const colDebit = findCol(sample, "Debit Amount", "DebitAmount", "Debit");
      const colNet   = findCol(sample, "NET", "Net", "Net Amount");

      const missing = [];
      if (!colBU)    missing.push("BusinessUnit");
      if (!colAcct)  missing.push("Account Number");
      if (!colDebit) missing.push("Debit Amount");
      if (!colNet)   missing.push("NET");

      if (missing.length) {
        // Show the actual column names from the file to help debug
        const actualCols = Object.keys(sample).slice(0, 12).join(", ");
        setMessage({ type: "error", text: `Could not find: ${missing.join(", ")}. File columns: ${actualCols}` });
        return;
      }

      setDetectedCols({ colBU, colAcct, colDebit, colNet });

      const totals  = parseGL(rows);
      const guessed = guessPeriodFromFile(rows);
      if (guessed && !selectedPeriod) setSelectedPeriod(guessed);

      setPreview({ totals, rowCount: rows.length, guessed });
    } catch (err) {
      setMessage({ type: "error", text: `Parse error: ${err.message}` });
    }
  }

  async function handleSave() {
    if (!preview || !selectedPeriod) return;
    setUploading(true);
    setMessage(null);

    const BU_LABELS = { "609": "BNY Brooklyn", "610": "Passaic NJ", "612": "Shared" };

    const rows = Object.entries(preview.totals).map(([bu, vals]) => ({
      period:              selectedPeriod,
      business_unit:       bu,
      business_unit_label: BU_LABELS[bu],
      cogs:          Math.round(vals.cogs * 100) / 100,
      opex:          Math.round(vals.opex * 100) / 100,
      inv_purchases: Math.round(vals.inv  * 100) / 100,
      uploaded_at:   new Date().toISOString(),
    }));

    const { error } = await supabase
      .from("financials_monthly")
      .upsert(rows, { onConflict: "period,business_unit" });

    if (error) {
      setMessage({ type: "error", text: `Save failed: ${error.message}` });
    } else {
      setMessage({ type: "success", text: `✓ Saved as ${selectedPeriod}` });
      setPreview(null);
      setDetectedCols(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      loadHistory();
    }
    setUploading(false);
  }

  const fmt = (n) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n ?? 0);

  const fmtDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

  const BU_DISPLAY = { "609": "BNY Brooklyn", "610": "Passaic NJ", "612": "Shared" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Financial Data Upload</h2>
        <p style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
          Upload the weekly GP purchase report. <strong>Select the correct week</strong> before saving.
        </p>
      </div>

      {/* Period picker */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>Save to period:</label>
        <select
          value={selectedPeriod}
          onChange={(e) => setSelectedPeriod(e.target.value)}
          style={{ border: "1px solid #ccc", borderRadius: 8, padding: "6px 10px", fontSize: 13, background: "#fff", cursor: "pointer" }}
        >
          <option value="">— pick a week —</option>
          {periodOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {selectedPeriod && (
          <span style={{ fontFamily: "monospace", fontSize: 12, background: "#eef2ff", color: "#4338ca", border: "1px solid #c7d2fe", padding: "3px 8px", borderRadius: 6 }}>
            {selectedPeriod}
          </span>
        )}
      </div>

      {/* Drop zone */}
      <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%", height: 140, border: "2px dashed #ccc", borderRadius: 12, cursor: "pointer", background: "#fafafa" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: "#888" }}>
          <svg width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="#aaa" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Drop GP purchase report here or click to browse</span>
          <span style={{ fontSize: 11, color: "#aaa" }}>.xlsx · .xls · .csv</span>
        </div>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={handleFile} />
      </label>

      {/* Message */}
      {message && (
        <div style={{
          borderRadius: 8, padding: "10px 14px", fontSize: 13, fontWeight: 500,
          background: message.type === "error" ? "#fef2f2" : "#f0fdf4",
          color: message.type === "error" ? "#b91c1c" : "#15803d",
          border: `1px solid ${message.type === "error" ? "#fecaca" : "#bbf7d0"}`
        }}>
          {message.text}
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: "#f9fafb", padding: "10px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 13 }}>
              <strong>Preview — </strong>
              {selectedPeriod
                ? <span style={{ color: "#4338ca", fontWeight: 600 }}>{selectedPeriod}</span>
                : <span style={{ color: "#dc2626" }}>⚠ select a period above</span>}
              {preview.guessed && preview.guessed !== selectedPeriod && (
                <span style={{ marginLeft: 8, fontSize: 11, color: "#d97706" }}>(file suggests {preview.guessed})</span>
              )}
              <span style={{ marginLeft: 12, fontSize: 11, color: "#9ca3af" }}>{preview.rowCount.toLocaleString()} rows</span>
            </div>
            <button
              onClick={handleSave}
              disabled={uploading || !selectedPeriod}
              style={{ padding: "6px 16px", background: selectedPeriod ? "#4f46e5" : "#a5b4fc", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: selectedPeriod ? "pointer" : "not-allowed" }}
            >
              {uploading ? "Saving…" : `Save as ${selectedPeriod || "…"}`}
            </button>
          </div>

          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ textAlign: "left", padding: "8px 16px", color: "#6b7280", fontWeight: 500 }}>Business Unit</th>
                <th style={{ textAlign: "right", padding: "8px 16px", color: "#6b7280", fontWeight: 500 }}>COGS</th>
                <th style={{ textAlign: "right", padding: "8px 16px", color: "#6b7280", fontWeight: 500 }}>OpEx</th>
                <th style={{ textAlign: "right", padding: "8px 16px", color: "#6b7280", fontWeight: 500 }}>Inv Purchases</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.totals).map(([bu, vals]) => (
                <tr key={bu} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "10px 16px", fontWeight: 500 }}>{BU_DISPLAY[bu]}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right" }}>{fmt(vals.cogs)}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right" }}>{fmt(vals.opex)}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right" }}>{fmt(vals.inv)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {Object.values(preview.totals).every((v) => v.cogs === 0) && (
            <div style={{ padding: "8px 16px", background: "#fffbeb", borderTop: "1px solid #fde68a", fontSize: 12, color: "#92400e" }}>
              ⚠ COGS = $0 — normal for mid-month files before closing entries are posted.
            </div>
          )}
        </div>
      )}

      {/* History */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h3 style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b7280", margin: 0 }}>Previous Uploads</h3>
          <button onClick={loadHistory} style={{ fontSize: 12, color: "#4f46e5", background: "none", border: "none", cursor: "pointer" }}>
            {loadingHistory ? "Loading…" : "Refresh"}
          </button>
        </div>
        {uploads.length === 0 ? (
          <p style={{ fontSize: 13, color: "#9ca3af" }}>No uploads yet.</p>
        ) : (
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ textAlign: "left", paddingBottom: 8, color: "#6b7280", fontWeight: 500 }}>Period</th>
                <th style={{ textAlign: "left", paddingBottom: 8, color: "#6b7280", fontWeight: 500 }}>BU</th>
                <th style={{ textAlign: "right", paddingBottom: 8, color: "#6b7280", fontWeight: 500 }}>COGS</th>
                <th style={{ textAlign: "right", paddingBottom: 8, color: "#6b7280", fontWeight: 500 }}>OpEx</th>
                <th style={{ textAlign: "right", paddingBottom: 8, color: "#6b7280", fontWeight: 500 }}>Inv Purchases</th>
                <th style={{ textAlign: "right", paddingBottom: 8, color: "#6b7280", fontWeight: 500 }}>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((u, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "7px 0", fontFamily: "monospace", fontSize: 12 }}>{u.period}</td>
                  <td style={{ padding: "7px 0" }}>{u.business_unit_label || BU_DISPLAY[u.business_unit] || u.business_unit}</td>
                  <td style={{ padding: "7px 0", textAlign: "right" }}>{fmt(u.cogs)}</td>
                  <td style={{ padding: "7px 0", textAlign: "right" }}>{fmt(u.opex)}</td>
                  <td style={{ padding: "7px 0", textAlign: "right" }}>{fmt(u.inv_purchases)}</td>
                  <td style={{ padding: "7px 0", textAlign: "right", fontSize: 11, color: "#9ca3af" }}>{fmtDate(u.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
