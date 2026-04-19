// ============================================================================
// scheduleUtils.js — Shared utilities for SchedulerTab and its child schedulers
// ============================================================================
// Palette, formatters, date helpers, and cross-site constants.
// Extracted from SchedulerTab.jsx during the Passaic/BNY split refactor.
// ============================================================================

// ─── Palette ───────────────────────────────────────────────────────────────
export const C = {
  cream:'#FAF7F2', parchment:'#F2EDE4', warm:'#E8DDD0', border:'#DDD4C8',
  ink:'#2C2420', inkMid:'#5C4F47', inkLight:'#9C8F87',
  gold:'#B8860B', goldLight:'#D4A843', goldBg:'#FDF8EC',
  navy:'#1E3A5F', navyLight:'#E8EEF5',
  amber:'#C17F24', amberBg:'#FEF3E2',
  sage:'#4A6741', sageBg:'#EEF3EC',
  rose:'#8B3A3A', roseBg:'#F9EDED',
  slate:'#4A5568', slateBg:'#EDF2F7',
}

// ─── Number / money formatters ─────────────────────────────────────────────
export const fmt  = n => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
export const fmtD = n => '$' + (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
export const fmtK = n => {
  const v = n || 0
  if (Math.abs(v) >= 1000) return '$' + (v/1000).toFixed(0) + 'K'
  return fmtD(v)
}

// ─── Date helpers ──────────────────────────────────────────────────────────
export function mondayOf(d) {
  const x = new Date(d)
  x.setHours(0,0,0,0)
  const day = x.getDay()
  const diff = day === 0 ? -6 : 1 - day
  x.setDate(x.getDate() + diff)
  return x
}
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x }
export function addWeeks(d, n) { return addDays(d, n * 7) }
export function isoDate(d) { return d.toISOString().slice(0,10) }
export function weekLabel(d) {
  const end = addDays(d, 4)
  const m = { 0:'Jan',1:'Feb',2:'Mar',3:'Apr',4:'May',5:'Jun',6:'Jul',7:'Aug',8:'Sep',9:'Oct',10:'Nov',11:'Dec' }
  return `${m[d.getMonth()]} ${d.getDate()}–${end.getDate()}, ${d.getFullYear()}`
}

// Default starting week: April 27, 2026 (Week 4 of April per agreement with Peter)
// If today is past that, default to the next upcoming Monday.
export function defaultSchedulerWeek() {
  const target = new Date(2026, 3, 27)  // April 27, 2026
  const today = new Date()
  today.setHours(0,0,0,0)
  if (today > target) return mondayOf(addWeeks(today, 1))
  return target
}

// ─── Cross-site constants ──────────────────────────────────────────────────
export const SITES = [
  { key: 'passaic',     label: 'Passaic',     sub: 'Screen Print',  color: C.navy },
  { key: 'bny',         label: 'Brooklyn',    sub: 'Digital',       color: C.amber },
  { key: 'procurement', label: 'Procurement', sub: 'Pass-through',  color: C.slate },
]
