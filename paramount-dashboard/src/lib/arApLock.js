// AR/AP snapshot lock — "lock at Saturday midnight ET" via lock-on-read (lazy, no scheduler).
// Rule (Peter, 2026-06-25): ONLY AR and AP lock. At midnight Saturday (America/New_York),
// the just-completed week's AR/AP snapshot freezes; later uploads still refresh
// OpEx/COGS/CapEx but must not overwrite a locked week's AR/AP. Week is derived from
// as_of_date (no schema change). OpEx/COGS/CapEx are NEVER locked.

function nowET(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const dowMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  let hh = parseInt(p.hour, 10); if (hh === 24) hh = 0;
  return { y:+p.year, m:+p.month, d:+p.day, hh, mm:+p.minute, dow: dowMap[p.weekday] };
}
function ymdISO(y, m, d) { return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function addDays(iso, n) {
  const dt = new Date(iso + 'T12:00:00'); dt.setDate(dt.getDate() + n);
  return ymdISO(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

// Latest fully-completed Saturday (YYYY-MM-DD) in ET. A week ending Sat S locks at Sun 00:00 ET.
export function lockedThroughSaturday(now = new Date()) {
  const e = nowET(now);
  const todayISO = ymdISO(e.y, e.m, e.d);
  const thisWeekSunday = addDays(todayISO, -e.dow);
  return addDays(thisWeekSunday, -1);
}
// Saturday of the Sun–Sat week containing iso.
export function weekSaturdayOf(iso) {
  const s = String(iso).slice(0, 10);
  const dt = new Date(s + 'T12:00:00');
  return addDays(s, 6 - dt.getDay());
}
// Is the aging snapshot for this as_of_date locked right now?
export function isAgingLocked(asOfDate, now = new Date()) {
  if (!asOfDate) return false;
  return weekSaturdayOf(asOfDate) <= lockedThroughSaturday(now);
}
// May we write AR/AP for this incoming snapshot, given the as_of_dates already stored?
// Block only when the incoming snapshot's week is locked AND a snapshot for that same
// week already exists in the DB.
export function canWriteAging(asOfDate, existingAsOfDates, now = new Date()) {
  if (!asOfDate) return { allowed:false, reason:'no as-of date on snapshot' };
  if (!isAgingLocked(asOfDate, now)) return { allowed:true, reason:'week not yet locked' };
  const wk = weekSaturdayOf(asOfDate);
  const alreadyHave = (existingAsOfDates || []).some(d => weekSaturdayOf(d) === wk);
  return alreadyHave
    ? { allowed:false, reason:'week already locked with stored AR/AP — preserved' }
    : { allowed:true, reason:'week locked but nothing stored yet — first write allowed' };
}
