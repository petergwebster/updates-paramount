// ════════════════════════════════════════════════════════════════════════════
// /api/slack-note-notify  —  Note-delegation Slack ping (v1)
// ────────────────────────────────────────────────────────────────────────────
// Place this file at:    netlify/functions/slack-note-notify.js
//
// Required env vars in Netlify:
//   SLACK_BOT_TOKEN          — already set (used by slack-upload)
//   SLACK_NOTES_CHANNEL_ID   — channel ID for the production notes channel
//                               (e.g. "C0XXXXXXX"). Create #paramount-production
//                               or similar; Wendy mentioned production-specific
//                               channel in her replies.
//
// Request body (POST application/json):
//   { assignedTo: "QA Lead",
//     site:       "passaic",
//     tableLabel: "Fabric 3",
//     dateLabel:  "Mon Apr 28",     // optional, free-form
//     noteText:   "Color drift…" }
//
// Behavior:
//   - Posts a single message to SLACK_NOTES_CHANNEL_ID via chat.postMessage.
//   - Mentions the assignee by ROLE (text) for now. When Peter provides a
//     role→Slack-user-ID mapping, swap to <@U0XXXXXXX> mentions.
//   - Best-effort: returns 200 even on Slack API errors so the client save
//     flow doesn't fail when notifications are flaky. Errors are logged to
//     Netlify function logs for debugging.
//
// Future hardening (deferred):
//   - role→Slack-user-ID mapping for @mentions
//   - rate limiting (if assignment churn becomes noisy)
//   - retry queue (if Slack API is down)
// ════════════════════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  const token   = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_NOTES_CHANNEL_ID
  if (!token || !channel) {
    console.error('slack-note-notify: missing SLACK_BOT_TOKEN or SLACK_NOTES_CHANNEL_ID')
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'config' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: 'Bad JSON' }
  }

  const { assignedTo, site, tableLabel, dateLabel, noteText } = payload
  if (!assignedTo || !noteText) {
    return { statusCode: 400, body: 'Missing assignedTo or noteText' }
  }

  // Truncate long notes for the Slack preview — full note lives in the tool.
  const preview = (noteText || '').replace(/\s+/g, ' ').trim()
  const previewShort = preview.length > 280 ? preview.slice(0, 277) + '…' : preview

  const siteLabel = site === 'bny' ? 'Brooklyn'
                  : site === 'passaic' ? 'Passaic'
                  : (site || '').toString()

  // Block Kit message — readable in Slack and on mobile.
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📌 *Note assigned to ${assignedTo}*`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${siteLabel}${tableLabel ? ` · ${tableLabel}` : ''}${dateLabel ? ` · ${dateLabel}` : ''}`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `> ${previewShort}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<https://updates-paramount.netlify.app/|Open in Paramount production tool →>',
        },
      ],
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
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: json.error || 'slack_api' }) }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, ts: json.ts }) }
  } catch (err) {
    console.error('slack-note-notify exception:', err)
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) }
  }
}
