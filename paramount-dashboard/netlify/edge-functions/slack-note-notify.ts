// ════════════════════════════════════════════════════════════════════════════
// /api/slack-note-notify  —  Note-delegation Slack DM (Edge Function)
// ────────────────────────────────────────────────────────────────────────────
// Place at:  netlify/edge-functions/slack-note-notify.ts
//
// Matches the DM-based pattern of slack-upload.ts. Each note assignee role
// maps to a specific Slack user; the function opens a DM with that user and
// posts the note there.
//
// Required env: SLACK_BOT_TOKEN  (already set, shared with slack-upload)
//
// Best-effort: returns 200 even on Slack errors so the client save flow isn't
// blocked when notifications fail. Errors are surfaced in the response body
// for diagnostics. Console errors land in Netlify function logs.
// ════════════════════════════════════════════════════════════════════════════

import type { Context } from "@netlify/edge-functions"

// Role → Slack user ID map (Wendy 4/2026)
// Update IDs here when org changes; no code edits needed elsewhere.
const ROLE_TO_USER: Record<string, string> = {
  'QA Lead':             'U08NYSWFT88',  // Samuel Brito
  'Production Manager':  'U08NYSYR4FJ',  // Wendy Reger-Hare
  'Operations Manager':  'U04QFDMLA30',  // Brynn Lawlor
  'Peter Webster':       'U044K8RGAMS',  // Peter Webster
}

export default async (request: Request, _context: Context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    })
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  try {
    const BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN") || ""
    if (!BOT_TOKEN) {
      return jsonResp({ ok: false, reason: "config" }, 200)
    }

    const payload = await request.json().catch(() => null)
    if (!payload) return jsonResp({ ok: false, reason: "bad_json" }, 200)

    const { assignedTo, site, tableLabel, dateLabel, noteText } = payload
    if (!assignedTo || !noteText) {
      return jsonResp({ ok: false, reason: "missing_fields" }, 200)
    }

    const userId = ROLE_TO_USER[assignedTo]
    if (!userId) {
      console.error(`slack-note-notify: no Slack user ID for role "${assignedTo}"`)
      return jsonResp({ ok: false, reason: "unknown_role", role: assignedTo }, 200)
    }

    // Open DM channel with the assignee
    const dmRes = await fetch("https://slack.com/api/conversations.open", {
      method:  "POST",
      headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ users: userId }),
    })
    const dmData = await dmRes.json()
    if (!dmData.ok) {
      console.error(`slack-note-notify: conversations.open failed: ${dmData.error}`)
      return jsonResp({ ok: false, reason: dmData.error || "dm_open_failed" }, 200)
    }
    const channelId = dmData.channel?.id
    if (!channelId) {
      return jsonResp({ ok: false, reason: "no_channel_id" }, 200)
    }

    // Build the message — preview truncated, full note lives in the tool
    const preview = String(noteText).replace(/\s+/g, " ").trim()
    const previewShort = preview.length > 280 ? preview.slice(0, 277) + "…" : preview

    const siteLabel = site === "bny"     ? "Brooklyn"
                    : site === "passaic" ? "Passaic"
                    : String(site || "")

    const contextLine = [siteLabel, tableLabel, dateLabel].filter(Boolean).join(" · ")

    const blocks: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `📌 *You have a new note from Paramount production*` },
      },
    ]
    if (contextLine) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: contextLine }],
      })
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `> ${previewShort}` },
    })
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "<https://updates-paramount.netlify.app/|Open in Paramount production tool →>",
      }],
    })

    const text = `📌 New note for you${contextLine ? ` — ${contextLine}` : ""}: ${previewShort}`

    const postRes = await fetch("https://slack.com/api/chat.postMessage", {
      method:  "POST",
      headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
      body:    JSON.stringify({ channel: channelId, text, blocks }),
    })
    const postData = await postRes.json()
    if (!postData.ok) {
      console.error(`slack-note-notify: chat.postMessage failed: ${postData.error}`)
      return jsonResp({ ok: false, reason: postData.error || "post_failed" }, 200)
    }

    return jsonResp({ ok: true, ts: postData.ts, channel: channelId }, 200)
  } catch (err) {
    console.error("slack-note-notify exception:", err)
    return jsonResp({ ok: false, reason: "exception", message: String(err) }, 200)
  }
}

function jsonResp(body: any, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

export const config = { path: "/api/slack-note-notify" }
