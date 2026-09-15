// demoMode.js — LIFT user-group demo (PrintUnited 9/22/26).
//
// Opening the app with ?demo=<snapshotId> pins the WIP + Scheduler tabs to that
// sched_snapshots id (the frozen QA1 pool, e.g. 4019) for THIS BROWSER TAB ONLY
// (sessionStorage — other tabs, other users, and every other page stay on live
// data). ?demo=off or the banner's Exit button clears it. Because
// PassaicScheduler/BNYScheduler receive wipRows as props from SchedulerTab,
// pinning the tab also pins everything downstream — including the pool
// Ask-Claude sees when building schedules.

const KEY = 'demoSnapshotId'

function initFromUrl() {
  try {
    const v = new URLSearchParams(window.location.search).get('demo')
    if (v == null) return
    if (v === 'off' || v === '0' || v === '') sessionStorage.removeItem(KEY)
    else if (/^\d+$/.test(v)) sessionStorage.setItem(KEY, v)
  } catch { /* no window (tests) — demo mode simply off */ }
}
initFromUrl()

export function getDemoSnapshotId() {
  try {
    const v = sessionStorage.getItem(KEY)
    return v ? Number(v) : null
  } catch { return null }
}

export function exitDemoMode() {
  try {
    sessionStorage.removeItem(KEY)
    const url = new URL(window.location.href)
    url.searchParams.delete('demo')
    window.location.href = url.toString()
  } catch {
    window.location.reload()
  }
}
