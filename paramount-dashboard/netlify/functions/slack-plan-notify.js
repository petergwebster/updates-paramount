// slack-plan-notify — Ramon's ask (8/4): when a scheduler SUBMITS a week,
// post the plan to Slack so the team can see it and — the real point —
// ANNOTATE it in a thread. His driving case: context that lives off the
// board ("I'm accounting for X but it's not in LIFT yet") had nowhere to
// go; now it rides the submission as a note and lands in the channel where
// Wendy and Sami can answer it.
//
// Slack over email, deliberately: the Slack plumbing exists and is proven
// (same bot token + channel envs as slack-queue-notify); email would mean a
// new provider, new credentials, and a new failure mode. The CSV export
// covers the occasional need to send a plan outside Slack.
//
// POST body: { site, week_start, version, totals: {count,yards,revenue?},
//              note, lines: [{ table, day, po, desc, yards }], from }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'POST only' }

  let p = {}
  try { p = JSON.parse(event.body || '{}') } catch { /* fall through */ }
  if (!p.site || !p.week_start) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, reason: 'site and week_start are required' }) }
  }

  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_QUEUE_CHANNEL_ID || process.env.SLACK_NOTES_CHANNEL_ID
  if (!token || !channel) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, reason: 'slack env not set' }) }
  }

  const siteLabel = p.site === 'passaic' ? 'Passaic (hand-screen)' : p.site === 'bny' ? 'BNY (digital)' : p.site
  const t = p.totals || {}
  const fmt = (n) => Math.round(Number(n || 0)).toLocaleString('en-US')

  // Group lines by table/machine so the message reads like the board.
  const byTable = {}
  for (const l of (p.lines || [])) {
    const key = l.table || '?'
    ;(byTable[key] = byTable[key] || []).push(l)
  }
  const CAP = 45
  let shown = 0, truncated = 0
  const tableBlocks = []
  for (const [table, list] of Object.entries(byTable)) {
    const rows = []
    for (const l of list) {
      if (shown >= CAP) { truncated++; continue }
      shown++
      rows.push(`    • ${l.po || '?'} — ${(l.desc || '').slice(0, 40)} — ${fmt(l.yards)} yd${l.day ? ` (${l.day})` : ''}`)
    }
    if (rows.length) tableBlocks.push(`  *${table}*\n${rows.join('\n')}`)
  }

  const text = [
    `📋 *${siteLabel} plan submitted* — week of ${p.week_start} · v${p.version || 1}${p.from ? ` · by ${p.from}` : ''}`,
    `${fmt(t.count)} jobs · ${fmt(t.yards)} yd planned${t.revenue ? ` · $${fmt(t.revenue)}` : ''}`,
    p.note ? `📌 *Note from the scheduler:*\n> ${String(p.note).slice(0, 600)}` : null,
    tableBlocks.join('\n'),
    truncated > 0 ? `_…and ${truncated} more line${truncated !== 1 ? 's' : ''} — full board on the dashboard._` : null,
    `_Reply in this thread to annotate the plan — questions, priorities, anything the board can't see._`,
  ].filter(Boolean).join('\n')

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    })
    const j = await res.json()
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: !!j.ok, reason: j.error }) }
  } catch (e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, reason: String(e) }) }
  }
}
