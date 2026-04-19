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
export function weekLabel(d, days = 5) {
  const end = addDays(d, days - 1)
  return formatRange(d, end)
}

// Fiscal Sun–Sat label given a Monday-based week_start.
// Example: weekLabelFiscal(Mon 2026-04-27) → "Apr 26–May 2, 2026"
export function weekLabelFiscal(d) {
  const start = addDays(d, -1)   // Sunday before the Monday week_start
  const end   = addDays(d, 5)    // Saturday after the Monday week_start
  return formatRange(start, end)
}

function formatRange(start, end) {
  const m = { 0:'Jan',1:'Feb',2:'Mar',3:'Apr',4:'May',5:'Jun',6:'Jul',7:'Aug',8:'Sep',9:'Oct',10:'Nov',11:'Dec' }
  const sameMonth = start.getMonth() === end.getMonth()
  const sameYear  = start.getFullYear() === end.getFullYear()
  if (sameMonth && sameYear) {
    return `${m[start.getMonth()]} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`
  }
  if (sameYear) {
    return `${m[start.getMonth()]} ${start.getDate()}–${m[end.getMonth()]} ${end.getDate()}, ${start.getFullYear()}`
  }
  return `${m[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}–${m[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`
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

// ─── Passaic operator roster (42 screen-print operators from Employees sheet) ─
export const PASSAIC_OPERATORS = [
  'Angel Acevedo', 'Armando Acevedo', 'Christian Acevedo', 'Jesus Acevedo',
  'Heriberto Arroyo', 'Juan Arteaga', 'Rodney Bermudez', 'Samuel Brito',
  'Yvanna Cabrera', 'Miguel Carpio', 'Salomon Cruz JR', 'Alberto De Leon',
  'Jeremy Dominguez', 'Elizabeth Doyle', 'Patrizia Galati', 'Humberto Gonzalez',
  'Edward Hanratty III', 'Yensi Henriquez', 'Miguel Hijuitl', 'Louis Hillen',
  'Jerome Jeter Jr.', 'Alejandro Leal', 'Felix Maihuay', 'Freddy Martinez',
  'Emilio Medina', 'Lesly Mendoza', 'Jose Molina', 'Abiodun Obagbemi',
  'Roberto Ortiz', 'Romer Osorto', 'Heriberto Perez', 'Miguel Picon',
  'Wendy Reger-Hare', 'Steven Sanguino', 'Marcos Shehata', 'Sergio Solis',
  'Estephanie Soto Martinez', 'Genaro Tobias', 'Daniel Velez', 'Kevin Vinas',
  'Ariel Williams', 'Santos Zambrano',
]

// ─── BNY operator rosters (from previous commits; duplicated here for Live Ops) ─
export const BNY_OPERATORS_BROOKLYN = [
  'Shelby Adams', 'Ramon Bermudez', 'Blake Devine-Rosser',
  'Sara Howard', 'Susan Jean-Baptiste', 'Philip Keefer',
  'Brynn Lawlor', 'Adam McClellan', "John O'Connor",
  'Sydney Remson', 'Denzell Silvia', 'Xiachen Zhou',
]
export const BNY_OPERATORS_PASSAIC_DIGITAL = [
  'Joseph Horton', 'Luis Mendoza Capecchi', 'Jeanne Villeneuve',
]

// ─── Day labels (0=Sun..6=Sat fiscal week) ─────────────────────────────────
export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const DAY_NAMES_FULL  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Return day_of_week (0=Sun..6=Sat) given a Monday-based week_start and an
// absolute Date, or null if the date is outside the fiscal week containing
// that week_start (Sun before → Sat after).
export function dayOfWeekFiscal(weekStartMonday, d) {
  const sun = addDays(weekStartMonday, -1)
  const sat = addDays(weekStartMonday, 5)
  const x = new Date(d); x.setHours(0,0,0,0)
  if (x < sun || x > sat) return null
  const diffMs = x.getTime() - sun.getTime()
  return Math.round(diffMs / 86400000)
}

// Reverse: given a Monday-based week_start and a day_of_week (0..6, Sun=0),
// return the actual Date of that day.
export function dateForDayOfWeek(weekStartMonday, dayOfWeek) {
  // day 0 = Sunday before Monday week_start = weekStart - 1
  // day 1 = Monday = weekStart
  return addDays(weekStartMonday, dayOfWeek - 1)
}

// "Yesterday" relative to today, returned as a Date at 00:00.
export function yesterday() {
  const d = new Date()
  d.setHours(0,0,0,0)
  d.setDate(d.getDate() - 1)
  return d
}
