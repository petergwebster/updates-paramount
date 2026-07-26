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
// Path A · Pure Cosmic (locked May 3, 2026, replacing Couture).
//
// Design intent:
//   • Warm light-gray base, near-black navy text, single teal accent.
//   • Site identity collapses — Heartbeat / Operations / Performance all
//     read as variations on a teal/slate theme rather than distinct colors.
//   • EXCEPTION: status colors stay loud — green/yellow/red preserved for
//     aging cards, Plant Pulse misses, status pills, anywhere operational
//     clarity matters more than aesthetic cohesion.
//
// The C export contract is unchanged — every existing key (cream, parchment,
// warm, border, ink, inkMid, inkLight, gold, navy, amber, sage, rose, slate
// + Bg/Light variants) still resolves. Hex values are remapped to Cosmic.
// This lets every consumer keep its existing `import { C } from '...'` line.
//
// New named exports (ACCENT_*, STATUS_*) are also provided for components
// that previously hardcoded inline hex values. Those components should
// migrate to the named tokens.

export const C = {
  // ── Base surfaces ──────────────────────────────────────────────────────
  cream:     '#14171A',  // page background — dark (mirrors --paper)
  parchment: '#1D2126',  // card / section backgrounds (mirrors --surface)
  surface2:  '#262B31',  // nested panel / SECTION HEADER / active chip bg
  warm:      '#2E3238',  // disabled buttons / muted fills
  border:    '#333940',  // card borders, dividers

  // ── Text ───────────────────────────────────────────────────────────────
  // NOTE: `ink` doubles as an ACTIVE-STATE BACKGROUND in several components
  // (selected site cards, active pills). Because `ink` and `cream` both flipped,
  // the usual ink-background / cream-text pairing still reads correctly — it is
  // simply inverted: a light chip on a dark page rather than the reverse.
  ink:       '#F4F3EF',  // PRIMARY TEXT ONLY — never a background.
                         // It used to double as an active-state background back
                         // when it was near-black. Now that it is near-white,
                         // using it as a background produces an unreadable light
                         // chip with light text on it. Use surface2 (neutral
                         // active) or navy (accent active) instead.
  inkMid:    '#A2A9B1',  // secondary text, subheaders
  inkLight:  '#737A82',  // tertiary text, captions

  // ── Accent slots — REMAPPED to single-teal Cosmic identity ────────────
  // Pre-Path-A these were distinct colors per destination. Now all destination
  // accents resolve to teal variants. Status loudness is preserved separately.
  navy:        '#3E8FA8',   // scheduled / primary accent — lifted teal
  navyLight:   '#1C2E35',   // teal-tinted panel bg
  gold:        '#ADB2B8',   // Operations chrome — slate
  goldLight:   '#848A91',
  goldBg:      '#23272C',
  slate:       '#ADB2B8',
  slateBg:     '#23272C',

  // ── Status colors — kept LOUD per design directive ─────────────────────
  // These power aging cards (60/90/90+), Plant Pulse miss bars, status pills,
  // and anywhere operational signal matters more than visual cohesion.
  // Hex values match prior Couture so behavior in status contexts is identical.
  sage:    '#3DD68C', sageBg:  '#102C21',   // emerald — Ready / on-track / good
  amber:   '#F5B544', amberBg: '#2E2410',   // amber — May be late / awaiting / warn
  rose:    '#F2555A', roseBg:  '#2E1417',   // crimson — Late / on hold / misses / bad

  // ── DATA SERIES — every core metric owns a colour, everywhere ─────────
  // Learn once that blue is yards and violet is colour-yards, and you stop
  // reading labels. Saturated deliberately: muted colour on dark reads grey.
  yards:       '#4EA8DE',   // yards produced
  coloryards:  '#A78BFA',   // colour-yards — the Passaic labour unit
  waste:       '#F2555A',   // waste — always this red, never anything else
  scheduled:   '#F5B544',   // the plan / commitment
  budget:      '#5C636B',   // the target — quiet on purpose, it is a reference
  revenue:     '#3DD68C',   // money
  siteNJ:      '#E8825A',   // Passaic · hand-screen
  siteBNY:     '#4EA8DE',   // Brooklyn · digital
}

// ─── Named accent exports ─────────────────────────────────────────────────
// New tokens for components that previously hardcoded inline hex. Importing
// from these names (rather than C.X) makes intent explicit at the call site.

// Destination accents — single-teal Cosmic identity
export const ACCENT_PERF       = '#3E8FA8'   // Finance    — mid teal
export const ACCENT_HEART      = '#2E7D9A'   // Pulse      — deeper teal
export const ACCENT_OPS        = '#7A8088'   // Operations — slate
export const ACCENT_TEAL       = '#3E8FA8'   // generic accent alias
export const ACCENT_DEEP_TEAL  = '#2E7D9A'   // generic deep alias

// Status loudness tokens — same hex as C.sage / C.amber / C.rose, named for intent
export const STATUS_GOOD       = '#55A47C'   // emerald
export const STATUS_GOOD_BG    = '#1C2E24'
export const STATUS_GOOD_BORDER= '#2F5C43'
export const STATUS_WARN       = '#D6A250'   // amber
export const STATUS_WARN_BG    = '#2E2617'
export const STATUS_WARN_BORDER= '#5C4A24'
export const STATUS_BAD        = '#D96F63'   // crimson
export const STATUS_BAD_BG     = '#2E1C19'
export const STATUS_BAD_BORDER = '#5C2F2B'


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

// Default starting week: the CURRENT fiscal week (Sunday of the week containing
// today). Per Wendy's list + the 6/30 ops review, the scheduler should open on
// the current week rather than jumping ahead — users found the "next week" jump
// disorienting. Forward navigation is one click away. (Was: hardcoded Apr 26
// 2026 seed, then +1 week once today passed it, which made it always land ahead.)
export function defaultSchedulerWeek() {
  return sundayOf(new Date())
}

// "Yesterday" relative to today, returned as a Date at 00:00.
export function yesterday() {
  const d = new Date()
  d.setHours(0,0,0,0)
  d.setDate(d.getDate() - 1)
  return d
}

// ─── Scheduler line identity ──────────────────────────────────────────
// Stable per-LINE key for matching pool rows (sched_wip_rows) to their
// assignments (sched_assignments). A multi-SKU PO produces multiple pool rows
// (one per SKU line); keying assignment consumption by PO alone made scheduling
// one SKU zero out its siblings' remaining. This composite (PO + SKU + color)
// is stable across LIFT snapshots — unlike the snapshot-local row id — so it
// survives re-uploads. Both wip rows and assignments carry po_number/item_sku/
// color, so it computes identically on both sides.
export function schedLineKey(r) {
  return [r.po_number, r.item_sku, r.color].map(v => String(v ?? '').trim()).join('|')
}

// ─── Cross-site constants ──────────────────────────────────────────────────
// Site `color` is the destination accent used in modals, headers, and
// site-identity contexts. Path A collapses these to teal/slate variants —
// they distinguish but harmonize. The slight differences (mid-teal vs
// deep-teal vs slate) preserve enough visual distinction for users to know
// which site they're on without breaking palette cohesion.
export const SITES = [
  { key: 'passaic',     label: 'Passaic',     sub: 'Screen Print',  color: ACCENT_TEAL      },  // #124E66 mid teal
  { key: 'bny',         label: 'Brooklyn',    sub: 'Digital',       color: ACCENT_DEEP_TEAL },  // #0E3D52 deep teal
  { key: 'procurement', label: 'Procurement', sub: 'Pass-through',  color: ACCENT_OPS       },  // #2E3944 charcoal slate
]

// ─── Passaic HAND-SCREEN operator roster (Paramount payroll, org 610) ────────
// Hand-screen tables ONLY — never digital. Reconciled to payroll 6/30/2026:
// removed departed (Arteaga, R. Bermudez, Maihuay, Soto Martinez, Vinas,
// Williams) and salaried (Brito/"Sami", Reger-Hare/"Wendy", Shehata — salaried
// staff don't belong in an operator pick-list); kept Alberto De Leon (unpaid
// leave) and Roberto Ortiz (active); added new hires.
export const PASSAIC_OPERATORS = [
  'Angel Acevedo', 'Armando Acevedo', 'Christian Acevedo', 'Jesus Acevedo',
  'Heriberto Arroyo', 'Yvanna Cabrera', 'Miguel Carpio', 'Salomon Cruz JR',
  'Alberto De Leon', 'Jeremy Dominguez', 'Elizabeth Doyle', 'Patrizia Galati',
  'Humberto Gonzalez', 'Edward Hanratty III', 'Yensi Henriquez', 'Miguel Hijuitl',
  'Louis Hillen', 'Jerome Jeter Jr.', 'Alejandro Leal', 'Freddy Martinez',
  'Emilio Medina', 'Lesly Mendoza', 'Jose Molina', 'Abiodun Obagbemi',
  'Roberto Ortiz', 'Romer Osorto', 'Heriberto Perez', 'Miguel Picon',
  'Steven Sanguino', 'Sergio Solis', 'Genaro Tobias', 'Daniel Velez',
  'Santos Zambrano',
  // new hires (payroll 6/30)
  'Juan Carrasco Garcia', 'Johan Reyes', 'Xavier Rivera', 'William Sanchez',
]

// ─── DIGITAL operator rosters (BNY payroll, org 609) ─────────────────────
// ALL digital operators are on the Brooklyn Navy Yard payroll — including the
// four who physically run the small digital fleet at Passaic (Horton, Mendoza
// Capecchi, Acosta, Villeneuve). Per Peter 6/30: every digital operator can run
// ANY digital machine at EITHER site, so BNY_OPERATORS_ALL (the union below) is
// the pick-list for all digital machines. Salaried removed (Adams, Lawlor,
// O'Connor/"Chandler").
export const BNY_OPERATORS_BROOKLYN = [
  'Ramon Bermudez', 'Blake Devine-Rosser', 'Sara Howard',
  'Susan Jean-Baptiste', 'Philip Keefer', 'Adam McClellan',
  'Sydney Remson', 'Denzell Silvia', 'Xiachen Zhou',
]
export const BNY_OPERATORS_PASSAIC_DIGITAL = [
  'Joseph Horton', 'Luis Mendoza Capecchi', 'Jessica Acosta', 'Jeanne Villeneuve',
]
// Combined digital pool — every digital operator is eligible on every digital
// machine (Brooklyn + Passaic-located). Use this for ALL digital dropdowns.
export const BNY_OPERATORS_ALL = [
  ...new Set([...BNY_OPERATORS_BROOKLYN, ...BNY_OPERATORS_PASSAIC_DIGITAL]),
].sort()

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
