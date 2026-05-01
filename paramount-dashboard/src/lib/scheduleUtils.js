// ============================================================================
// scheduleUtils.js — Shared utilities for SchedulerTab, LiveOps, and Heartbeat
// ============================================================================
// Palette, formatters, date helpers, day labels, cross-site constants.
//
// Phase A rewrite (May 1, 2026):
//   - Weeks are SUNDAY-anchored (FSCO 4/4/5 fiscal calendar; matches
//     Migration A's week_start shift and Heartbeat's startOfWeek convention).
//   - day_of_week helpers return TEXT labels ('Sun'..'Sat') matching
//     Migration B2's column type.
//
// Backward compat:
//   - `mondayOf` is kept as an alias for `sundayOf` so existing callers don't
//     break in this push. The function name is now a misnomer — use
//     `sundayOf` going forward. Phase B will rename callers.
//   - `weekLabelFiscal` is an alias for `weekLabel`. With Sunday-anchored
//     weeks they're equivalent; the old `Fiscal` version offset from a
//     Monday input, no longer needed.
//   - `dateForDayOfWeek` accepts either text ('Mon') or integer (1) for the
//     day argument during the transition window.
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

// Sunday of the week containing d. FSCO 4/4/5 fiscal weeks run Sun → Sat.
// week_start columns store this Sunday's date (post Migration A).
export function sundayOf(d) {
  const x = new Date(d)
  x.setHours(0,0,0,0)
  // getDay() returns 0=Sun ... 6=Sat. Subtract that many days to land on Sunday.
  x.setDate(x.getDate() - x.getDay())
  return x
}

// DEPRECATED: alias for `sundayOf`. The function is no longer Monday-anchored
// after Migration A; the name is kept only so existing imports don't break
// while Phase B updates callers. Use `sundayOf` going forward.
export const mondayOf = sundayOf

export function addDays(d, n)  { const x = new Date(d); x.setDate(x.getDate() + n); return x }
export function addWeeks(d, n) { return addDays(d, n * 7) }
export function isoDate(d)     { return d.toISOString().slice(0,10) }

// Format a label for a `days`-long range starting at d. Default 7 days
// matches the Sun-Sat fiscal week. Examples:
//   weekLabel(Sun Apr 26)          → "Apr 26–May 2, 2026"
//   weekLabel(Sun Apr 26, 5)       → "Apr 26–30, 2026"
export function weekLabel(d, days = 7) {
  return formatRange(d, addDays(d, days - 1))
}

// DEPRECATED: pre-Migration-A, this took a Monday week_start and offset to
// produce a Sun-Sat label. Now that week_start IS Sunday, plain `weekLabel`
// does the same thing. Kept as alias so existing callers don't break.
export const weekLabelFiscal = weekLabel

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

// Default starting week: Sunday April 26, 2026 (start of FSCO Week 4 of April).
// If today has passed that, default to the next upcoming Sunday.
export function defaultSchedulerWeek() {
  const target = new Date(2026, 3, 26)  // Sunday April 26, 2026
  const today = new Date()
  today.setHours(0,0,0,0)
  if (today > target) return sundayOf(addWeeks(today, 1))
  return target
}

// "Yesterday" relative to today, returned as a Date at 00:00.
export function yesterday() {
  const d = new Date()
  d.setHours(0,0,0,0)
  d.setDate(d.getDate() - 1)
  return d
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

// ─── Day labels — canonical Sun=0..Sat=6 ordering ─────────────────────────

// Ordered list, Sun first. Useful for iteration: DAY_NAMES_SHORT.forEach(d => ...).
export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Short → full label lookup. Pre-migration this was an integer-indexed array;
// post Migration B2, day_of_week is text, so this is now a TEXT-keyed object:
//   DAY_NAMES_FULL['Mon']  // → 'Monday'
// Keeping the same export name so callers using `DAY_NAMES_FULL[r.day_of_week]`
// keep working — the lookup just shifts from int-index to text-key.
export const DAY_NAMES_FULL = {
  Sun: 'Sunday',  Mon: 'Monday',   Tue: 'Tuesday',
  Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday',
  Sat: 'Saturday',
}

// Reverse lookup: text → integer index. Useful for sorting daily ops in
// chronological order, or for any code that still needs to compare days numerically.
export const DAY_INDEX = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

// Convenience: 'Mon' → 1; unknown input → -1 (sentinel, not undefined).
export function dayIndex(name) {
  return DAY_INDEX[name] ?? -1
}

// Given a Sunday week_start and a Date, return the day_of_week text label
// ('Sun' through 'Sat') for that Date within the Sun-Sat range, or null if
// the Date is outside the week.
export function dayOfWeekFiscal(weekStartSunday, d) {
  const sun = new Date(weekStartSunday); sun.setHours(0,0,0,0)
  const sat = addDays(sun, 6)
  const x = new Date(d); x.setHours(0,0,0,0)
  if (x < sun || x > sat) return null
  const idx = Math.round((x.getTime() - sun.getTime()) / 86400000)
  return DAY_NAMES_SHORT[idx] || null
}

// Given a Sunday week_start and a day_of_week, return the actual Date.
// Accepts text labels ('Mon') OR integer indices (1) for backward compat
// during the Phase A→B transition window. Returns null on bad input.
export function dateForDayOfWeek(weekStartSunday, dayOfWeek) {
  const idx = typeof dayOfWeek === 'number'
    ? dayOfWeek
    : DAY_INDEX[dayOfWeek]
  if (idx == null || idx < 0 || idx > 6) return null
  return addDays(weekStartSunday, idx)
}
