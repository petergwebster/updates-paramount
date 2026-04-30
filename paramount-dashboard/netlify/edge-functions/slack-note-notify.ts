// slack-note-notify v4 — channel post with sender attribution + @mention assignee
//
// Behavior change from v3:
//   v3: Opened a DM to the assignee role and posted there. Only the assignee
//       saw it. Required the bot to do conversations.open.
//   v4: Posts to SLACK_NOTES_CHANNEL_ID (the production channel) with:
//       - "From" attribution showing the dashboard user (e.g. Wendy)
//       - @mention of the assignee role's user ID (Sami / Brynn / Peter / Wendy)
//       - Site / table / date context line
//       - Note text
//     Channel-only — no DMs.
//
// Required env vars:
//   SLACK_BOT_TOKEN          — the xoxb- token
//   SLACK_NOTES_CHANNEL_ID   — channel ID for #paramount-prints-production
//
// Required Slack scopes (already in place):
//   chat:write — bot can post to channels it's a member of
//
// Required state:
//   Bot must be a member of SLACK_NOTES_CHANNEL_ID. If not, posts fail with
//   not_in_channel and the response body will say so.

import type { Context } from "@netlify/edge-functions"

// Map role names (from the Note Assignees dropdown in LiveOpsTab) → Slack user ID
const ROLE_TO_USER: Record<string, string> = {
  'QA Lead':             'U08NYSWFT88',  // Sami
  'Production Manager':  'U08NYSYR4FJ',  // Wendy
  'Operations Manager':  'U04QFDMLA30',  // Brynn
  'Peter Webster':       'U044K8RGAMS',  // Peter
}

const URL_POST = 'https://slack' + '.com/api/chat' + '.postMessage'

export default async (request: Request, _context: Context) => {
  if (request['method'] !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const BOT_TOKEN  = (Deno as any)['env']['get']('SLACK_BOT_TOKEN') || ''
    const CHANNEL_ID = (Deno as any)['env']['get']('SLACK_NOTES_CHANNEL_ID') || ''

    if (!BOT_TOKEN)  return r({ ok: false, reason: 'missing_token', marker: 'v4' })
    if (!CHANNEL_ID) return r({ ok: false, reason: 'missing_channel_id', marker: 'v4' })

    const p: any = await request['json']()['catch'](() => null)
    if (!p) return r({ ok: false, reason: 'bad_json', marker: 'v4' })

    const assignedTo: string = p['assignedTo']
    const assignedBy: string = p['assignedBy'] || 'Someone'  // dashboard user's full name
    const noteText:   string = p['noteText']
    const site:       string = p['site']
    const tableLabel: string = p['tableLabel']
    const dateLabel:  string = p['dateLabel']

    if (!assignedTo || !noteText) {
      return r({ ok: false, reason: 'missing_fields', marker: 'v4' })
    }

    const assigneeUserId = ROLE_TO_USER[assignedTo]
    if (!assigneeUserId) {
      return r({ ok: false, reason: 'unknown_role', role: assignedTo, marker: 'v4' })
    }

    // Build context line: "Passaic · Fabric 3 · Apr 30, 2026"
    const siteLabel = site === 'bny'      ? 'Brooklyn'
                    : site === 'passaic'  ? 'Passaic'
                    : String(site || '')
    const contextParts = [siteLabel, tableLabel, dateLabel].filter(Boolean)
    const contextLine = contextParts.join(' · ')

    // Compress whitespace in note text. Keep full length — don't truncate
    // since the channel post is the authoritative record (no DM follow-up).
    const noteClean = String(noteText).replace(/\s+/g, ' ').trim()

    // Build the Block Kit message
    // Header: who posted, who it's for, where (context)
    // Body: the note itself
    // The fallback `text` is for notification previews (mobile push, email)
    const headerLine = `*${escapeSlack(assignedBy)}* left a note for <@${assigneeUserId}>`
    const contextBlockText = contextLine ? `_${escapeSlack(contextLine)}_` : ''

    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: headerLine },
      },
    ]
    if (contextBlockText) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: contextBlockText }],
      })
    }
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `>${escapeSlack(noteClean)}` },
    })

    // Fallback text for notification previews — keep short and informative
    const fallbackText = `${assignedBy} → ${assignedTo}${contextLine ? ' · ' + contextLine : ''}: ${noteClean.slice(0, 140)}`

    const postRes = await fetch(URL_POST, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + BOT_TOKEN,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: CHANNEL_ID,
        text: fallbackText,
        blocks,
      }),
    })
    const postData: any = await postRes['json']()

    if (!postData['ok']) {
      // Common errors and what they mean:
      //   not_in_channel    — bot isn't a member of the channel; need to invite
      //   channel_not_found — wrong channel ID
      //   invalid_auth      — bot token is wrong
      //   missing_scope     — bot lacks chat:write
      return r({
        ok: false,
        reason: postData['error'] || 'post_failed',
        step: 'post_message',
        marker: 'v4',
      })
    }

    return r({
      ok: true,
      ts: postData['ts'],
      channel: CHANNEL_ID,
      assignee_role: assignedTo,
      assignee_user_id: assigneeUserId,
      marker: 'v4',
    })
  } catch (err) {
    return r({ ok: false, reason: 'exception', message: String(err), marker: 'v4' })
  }
}

// Slack mrkdwn doesn't escape much, but we should at least handle the basics
// to avoid weird formatting bugs from special chars in notes.
function escapeSlack(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function r(body: any) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

export const config = { path: '/api/slack-note-notify' }
