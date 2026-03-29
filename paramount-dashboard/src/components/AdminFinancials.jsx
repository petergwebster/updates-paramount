import { useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../supabaseClient";

// ─── Account-code based GL parser ───────────────────────────────────────────
//
// Account Number format: "BU-OBJECT-0000" e.g. "610-4105-0000"
//   BU segment:     609 = BNY Brooklyn, 610 = Passaic NJ, 612 = Shared
//   Object segment: 14xx = Inventory/WIP balance sheet accounts
//                   41xx = COGS (posted at month-end; absent mid-month → $0)
//                   43xx, 48xx, 6xxx = Operating Expenses
//
// Rules:
//   COGS          = sum of NET where object is 4100–4199
//   OpEx          = sum of Debit Amount where object is 6000+ (excl. payroll
//                   clearing 6116) PLUS 43xx / 48xx debit rows
//   Inv Purchases = sum of Debit Amount where object is 1437
//
// This handles mid-month GL files where 41xx rows simply don't exist yet.
// ────────────────────────────────────────────────────────────────────────────

function parseGL(rows) {
  // rows = array of objects keyed by header name
  const BU_MAP = { "609": "609", "610": "610", "612": "612" };
  const UNITS = ["609", "610", "612"];

  const totals = {};
  UNITS.forEach((u) => {
    totals[u] = { cogs: 0, opex: 0, inv: 0 };
  });

  rows.forEach((row) => {
    // BusinessUnit column is numeric in the file; coerce to string
    const bu = String(row["BusinessUnit"] ?? "").trim();
    if (!UNITS.includes(bu)) return;

    const acctNum = String(row["Account Number"] ?? "");
    // Extract the 4-digit object segment: "610-4105-0000" → "4105"
    const objMatch = acctNum.match(/-(\d{4})-/);
    if (!objMatch) return;
    const obj = parseInt(objMatch[1], 10);

    const debit = parseFloat(row["Debit Amount"]) || 0;
    const net = parseFloat(row["NET"]) || 0;

    // COGS: object 4100–4199 (absent in mid-month files → stays 0)
    if (obj >= 4100 && obj <= 4199) {
      totals[bu].cogs += net;
    }
    // Inventory Purchases: object 1437 (use Debit Amount, not NET)
    else if (obj === 1437) {
      totals[bu].inv += debit;
    }
    // OpEx: 43xx, 48xx, 6000+ (exclude 6116 payroll clearing contra account)
    else if (
      (obj >= 4300 && obj <= 4399) ||
      (obj >= 4800 && obj <= 4899) ||
      (obj >= 6000 && obj !== 6116)
    ) {
      if (debit > 0) {
        totals[bu].opex += debit;
      }
    }
  });

  return totals;
}

// ─── Fiscal week helper ──────────────────────────────────────────────────────
function getFiscalWeek(date) {
  // Week 1 = days 1–7 of the month, Week 2 = 8–14, etc.
  const d = new Date(date);
  const day = d.getDate();
  return Math.ceil(day / 7);
}

function getPeriodKey(year, month, weekNum) {
  // Format: "2026-03-W1"
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm}-W${weekNum}`;
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function AdminFinancials({ weekStart }) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Derive period key from weekStart prop (ISO date string "YYYY-MM-DD")
  function derivePeriod(ws) {
    if (!ws) return null;
    const d = new Date(ws + "T00:00:00");
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const weekNum = getFiscalWeek(d);
    return getPeriodKey(year, month, weekNum);
  }

  const currentPeriod = derivePeriod(weekStart);

  async function loadHistory() {
    setLoadingHistory(true);
    const { data, error } = await supabase
      .from("financials_monthly")
      .select("period, business_unit, cogs, opex, inv_purchases, uploaded_at")
      .order("period", { ascending: false })
      .order("business_unit", { ascending: true })
      .limit(30);
    if (!error) setUploads(data || []);
    setLoadingHistory(false);
  }

  // Run loadHistory on first render
  useState(() => {
    loadHistory();
  });

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setMessage(null);
    setPreview(null);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { raw: true });

      if (!rows.length) {
        setMessage({ type: "error", text: "File appears empty." });
        return;
      }

      // Validate required columns
      const required = ["BusinessUnit", "Account Number", "Debit Amount", "NET"];
      const missing = required.filter((c) => !(c in rows[0]));
      if (missing.length) {
        setMessage({
          type: "error",
          text: `Missing columns: ${missing.join(", ")}. Is this the GP purchase report?`,
        });
        return;
      }

      const totals = parseGL(rows);

      // Detect month/year from the file data (Period ID column: 2=Feb, 3=Mar…)
      const periodId = rows[0]["Period ID"];
      const openYear = rows[0]["Open Year"];
      const fileMonth = typeof periodId === "number" ? periodId : null;
      const fileYear = typeof openYear === "string" ? parseInt(openYear) : null;

      // Determine period key: prefer prop-derived, fall back to file-derived
      let period = currentPeriod;
      if (!period && fileMonth && fileYear) {
        const weekNum = getFiscalWeek(new Date(fileYear, fileMonth - 1, 1));
        period = getPeriodKey(fileYear, fileMonth, weekNum);
      }
      if (!period) {
        setMessage({ type: "error", text: "Could not determine period. Make sure a week is selected." });
        return;
      }

      setPreview({ totals, period, rowCount: rows.length });
    } catch (err) {
      setMessage({ type: "error", text: `Parse error: ${err.message}` });
    }
  }

  async function handleSave() {
    if (!preview) return;
    setUploading(true);
    setMessage(null);

    const { totals, period } = preview;
    const BU_LABELS = { "609": "BNY Brooklyn", "610": "Passaic NJ", "612": "Shared" };

    const rows = Object.entries(totals).map(([bu, vals]) => ({
      period,
      business_unit: bu,
      business_unit_label: BU_LABELS[bu],
      cogs: Math.round(vals.cogs * 100) / 100,
      opex: Math.round(vals.opex * 100) / 100,
      inv_purchases: Math.round(vals.inv * 100) / 100,
      uploaded_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from("financials_monthly")
      .upsert(rows, { onConflict: "period,business_unit" });

    if (error) {
      setMessage({ type: "error", text: `Save failed: ${error.message}` });
    } else {
      setMessage({ type: "success", text: `Saved ${period} successfully.` });
      setPreview(null);
      loadHistory();
    }
    setUploading(false);
  }

  function fmt(n) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n ?? 0);
  }

  function fmtDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  const BU_DISPLAY = { "609": "BNY Brooklyn", "610": "Passaic NJ", "612": "Shared" };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Financial Data Upload</h2>
        <p className="text-sm text-gray-500 mt-1">
          Upload the weekly GP purchase report — cumulative MTD. Each upload
          replaces the current week's data.
          {currentPeriod && (
            <span className="ml-2 font-medium text-indigo-600">
              Current period: {currentPeriod}
            </span>
          )}
        </p>
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
        <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
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
          <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <div>
              <span className="font-semibold text-gray-800">Preview — {preview.period}</span>
              <span className="ml-3 text-xs text-gray-500">{preview.rowCount.toLocaleString()} GL rows parsed</span>
            </div>
            <button
              onClick={handleSave}
              disabled={uploading}
              className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {uploading ? "Saving…" : "Save to Supabase"}
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
              ⚠ COGS shows $0 — this is expected for mid-month files before the closing journal entries are posted.
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
                  <td className="py-2 text-gray-800 font-mono text-xs">{u.period}</td>
                  <td className="py-2 text-gray-700">{u.business_unit_label || BU_DISPLAY[u.business_unit] || u.business_unit}</td>
                  <td className="py-2 text-right text-gray-700">{fmt(u.cogs)}</td>
                  <td className="py-2 text-right text-gray-700">{fmt(u.opex)}</td>
                  <td className="py-2 text-right text-gray-700">{fmt(u.inv_purchases)}</td>
                  <td className="py-2 text-right text-gray-400 text-xs">{fmtDate(u.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
