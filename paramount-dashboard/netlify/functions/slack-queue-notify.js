// slack-queue-notify — Phase 3 of the Queue build (Emily/Lydia initiative).
//
// "A way for the teams to slack one another direct from the board" (Peter,
// 8/1). POST a queue row + comment; posts one message to the shared queue
// channel with full order context, so the cross-team conversation starts
// with the facts attached instead of "which PO do you mean?"
//
// Channel: SLACK_QUEUE_CHANNEL_ID once Peter creates #paramount-queue and
// invites the bot; until then falls back to the production notes channel
// (bot already a member). Same bot-token plumbing as slack-note-notify and
// the audit alerts.
//
// POST body: { po, desc, sku, colorway, site, status, age_days, yards,
//              planned (string or null), comment, from }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'POST only' }

  let p = {}
  try { p = JSON.parse(event.body || '{}') } catch { /* fall through */ }
  if (!p.po || !p.comment) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, reason: 'po and comment are required' }) }
  }

  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_QUEUE_CHANNEL_ID || process.env.SLACK_NOTES_CHANNEL_ID
  if (!token || !channel) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, reason: 'slack env not set' }) }
  }

  const siteLabel = p.site === 'passaic' ? 'Passaic (screen)' : p.site === 'bny' ? 'BNY (digital)' : (p.site || '')
  const planned = p.planned ? `📅 ${p.planned}` : '🔴 unscheduled'
  // Identity line ALL BOLD (Peter, 8/1): SKU · description · PO — the order
  // should jump off the message; colorway trails unbolded.
  const idBits = [p.sku, p.desc, p.po].filter(Boolean).join(' · ')
  const text = [
    `💬 *Queue note from ${p.from || 'the dashboard'}* · ${siteLabel}`,
    `*${idBits || p.po}*${p.colorway ? ` · ${p.colorway}` : ''}`,
    `Status: *${p.status || 'unknown'}* · ${p.age_days != null ? `${p.age_days}d old · ` : ''}${p.yards != null ? `${p.yards} yd · ` : ''}${planned}`,
    `> ${String(p.comment).slice(0, 600)}`,
  ].join('\n')

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
