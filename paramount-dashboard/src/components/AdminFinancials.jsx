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

// ─── Account-code based GL parser ────────────────────────────────────────────
function parseGL(rows) {
  const UNITS = ["609", "610", "612"];
  const totals = {};
  UNITS.forEach((u) => { totals[u] = { cogs: 0, opex: 0, inv: 0 }; });

  rows.forEach((row) => {
    const bu = String(row["BusinessUnit"] ?? "").trim();
    if (!UNITS.includes(bu)) return;

    const acctNum = String(row["Account Number"] ?? "");
    const objMatch = acctNum.match(/-(\d{4})-/);
    if (!objMatch) return;
    const obj = parseInt(objMatch[1], 10);

    const debit = parseFloat(row["Debit Amount"]) || 0;
    const net   = parseFloat(row["NET"]) || 0;

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

      const required = ["BusinessUnit", "Account Number", "Debit Amount", "NET"];
      const missing  = required.filter((c) => !(c in rows[0]));
      if (missing.length) {
        setMessage({ type: "error", text: `Missing columns: ${missing.join(", ")}` });
        return;
      }

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
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Financial Data Upload</h2>
        <p className="text-sm text-gray-500 mt-1">
          Upload the weekly GP purchase report. <strong>Select the correct week</strong> before saving.
        </p>
      </div>

      {/* Period picker */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm font-semibold text-gray-700 whitespace-nowrap">
          Save to period:
        </label>
        <select
          value={selectedPeriod}
          onChange={(e) => setSelectedPeriod(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <option value="">— pick a week —</option>
          {periodOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {selectedPeriod && (
          <span className="font-mono text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-1 rounded">
            {selectedPeriod}
          </span>
        )}
      </div>

      {/* Drop zone */}
      <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition-colors">
        <div className="flex flex-col items-center gap-2 text-gray-500">
          <svg className="w-10 h-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-sm font-medium">Drop GP purchase report here or click to browse</span>
          <span className="text-xs text-gray-400">.xlsx · .xls · .csv</span>
        </div>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      </label>

      {/* Message */}
      {message && (
        <div className={`rounded-lg px-4 py-3 text-sm font-medium ${
          message.type === "error"
            ? "bg-red-50 text-red-700 border border-red-200"
            : "bg-green-50 text-green-700 border border-green-200"
        }`}>
          {message.text}
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm">
              <span className="font-semibold text-gray-800">Preview — </span>
              {selectedPeriod
                ? <span className="text-indigo-700 font-semibold">{selectedPeriod}</span>
                : <span className="text-red-500">⚠ select a period above</span>}
              {preview.guessed && preview.guessed !== selectedPeriod && (
                <span className="ml-2 text-xs text-amber-600">(file suggests {preview.guessed})</span>
              )}
              <span className="ml-3 text-xs text-gray-400">{preview.rowCount.toLocaleString()} rows</span>
            </div>
            <button
              onClick={handleSave}
              disabled={uploading || !selectedPeriod}
              className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              {uploading ? "Saving…" : `Save as ${selectedPeriod || "…"}`}
            </button>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2 text-gray-600 font-medium">Business Unit</th>
                <th className="text-right px-4 py-2 text-gray-600 font-medium">COGS</th>
                <th className="text-right px-4 py-2 text-gray-600 font-medium">OpEx</th>
                <th className="text-right px-4 py-2 text-gray-600 font-medium">Inv Purchases</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.totals).map(([bu, vals]) => (
                <tr key={bu} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-gray-800">{BU_DISPLAY[bu]}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmt(vals.cogs)}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmt(vals.opex)}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmt(vals.inv)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {Object.values(preview.totals).every((v) => v.cogs === 0) && (
            <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-700">
              ⚠ COGS = $0 — normal for mid-month files before closing entries are posted.
            </div>
          )}
        </div>
      )}

      {/* History */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Previous Uploads</h3>
          <button onClick={loadHistory} className="text-xs text-indigo-600 hover:underline">
            {loadingHistory ? "Loading…" : "Refresh"}
          </button>
        </div>
        {uploads.length === 0 ? (
          <p className="text-sm text-gray-400">No uploads yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left pb-2 text-gray-500 font-medium">Period</th>
                <th className="text-left pb-2 text-gray-500 font-medium">BU</th>
                <th className="text-right pb-2 text-gray-500 font-medium">COGS</th>
                <th className="text-right pb-2 text-gray-500 font-medium">OpEx</th>
                <th className="text-right pb-2 text-gray-500 font-medium">Inv Purchases</th>
                <th className="text-right pb-2 text-gray-500 font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((u, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  <td className="py-2 font-mono text-xs text-gray-800">{u.period}</td>
                  <td className="py-2 text-gray-700">{u.business_unit_label || BU_DISPLAY[u.business_unit] || u.business_unit}</td>
                  <td className="py-2 text-right text-gray-700">{fmt(u.cogs)}</td>
                  <td className="py-2 text-right text-gray-700">{fmt(u.opex)}</td>
                  <td className="py-2 text-right text-gray-700">{fmt(u.inv_purchases)}</td>
                  <td className="py-2 text-right text-xs text-gray-400">{fmtDate(u.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
