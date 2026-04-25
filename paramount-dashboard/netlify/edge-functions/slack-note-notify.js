// ════════════════════════════════════════════════════════════════════════════
// /api/slack-note-notify  —  Note-delegation Slack ping (Edge Function)
// ────────────────────────────────────────────────────────────────────────────
// Place this file at:    netlify/edge-functions/slack-note-notify.js
//
// Add this to netlify.toml under your other edge_functions entries:
//   [[edge_functions]]
//     path = "/api/slack-note-notify"
//     function = "slack-note-notify"
//
// Required Netlify env vars:
//   SLACK_BOT_TOKEN          — already set (used by slack-upload)
//   SLACK_NOTES_CHANNEL_ID   — channel ID (e.g. "C0XXXXXXX") for notes channel
//
// Behavior: best-effort. Returns 200 even on Slack failures so client save
// flow isn't blocked when notifications are flaky. Errors logged via console.
// ════════════════════════════════════════════════════════════════════════════

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const token   = Deno.env.get('SLACK_BOT_TOKEN')
  const channel = Deno.env.get('SLACK_NOTES_CHANNEL_ID')
  if (!token || !channel) {
    console.error('slack-note-notify: missing SLACK_BOT_TOKEN or SLACK_NOTES_CHANNEL_ID')
    return Response.json({ ok: false, reason: 'config' }, { status: 200 })
  }

  let payload
  try {
    payload = await request.json()
  } catch {
    return new Response('Bad JSON', { status: 400 })
  }

  const { assignedTo, site, tableLabel, dateLabel, noteText } = payload || {}
  if (!assignedTo || !noteText) {
    return new Response('Missing assignedTo or noteText', { status: 400 })
  }

  // Truncate long notes for the Slack preview — full note lives in the tool.
  const preview = String(noteText).replace(/\s+/g, ' ').trim()
  const previewShort = preview.length > 280 ? preview.slice(0, 277) + '…' : preview

  const siteLabel = site === 'bny' ? 'Brooklyn'
                  : site === 'passaic' ? 'Passaic'
                  : String(site || '')

  // Block Kit message — readable in Slack and on mobile.
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `📌 *Note assigned to ${assignedTo}*` },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${siteLabel}${tableLabel ? ` · ${tableLabel}` : ''}${dateLabel ? ` · ${dateLabel}` : ''}`,
      }],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `> ${previewShort}` },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '<https://updates-paramount.netlify.app/|Open in Paramount production tool →>',
      }],
    },
  ]

  // Plain-text fallback for notification previews
  const text = `📌 Note assigned to ${assignedTo} — ${siteLabel}${tableLabel ? ` · ${tableLabel}` : ''}: ${previewShort}`

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text, blocks }),
    })
    const json = await res.json().catch(() => ({}))
    if (!json.ok) {
      console.error('slack-note-notify Slack API error:', json.error || json)
      return Response.json({ ok: false, reason: json.error || 'slack_api' }, { status: 200 })
    }
    return Response.json({ ok: true, ts: json.ts }, { status: 200 })
  } catch (err) {
    console.error('slack-note-notify exception:', err?.message || err)
    return Response.json({ ok: false, reason: 'exception' }, { status: 200 })
  }
}
