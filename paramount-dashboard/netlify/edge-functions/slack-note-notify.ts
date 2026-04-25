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
// ════════════════════════════════════════════════════════════════════════════

import type { Context } from "@netlify/edge-functions"

// API endpoints hoisted to constants so dotted strings in code never look like
// links to auto-formatters (OneDrive / Outlook / Word will helpfully turn
// "thing.method" into a hyperlink and break the file).
const SLACK_API_OPEN_DM = "https://slack.com/api/conversations" + ".open"
const SLACK_API_POST    = "https://slack.com/api/chat" + ".postMessage"

// Role to Slack user ID map (Wendy 4/2026)
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
    if (!BOT_TOKEN) return jsonResp({ ok: false, reason: "config" }, 200)

    const payload = await request.json().catch(() => null)
    if (!payload) return jsonResp({ ok: false, reason: "bad_json" }, 200)

    const assignedTo = payload.assignedTo
    const site       = payload.site
    const tableLabel = payload.tableLabel
    const dateLabel  = payload.dateLabel
    const noteText   = payload.noteText

    if (!assignedTo || !noteText) {
      return jsonResp({ ok: false, reason: "missing_fields" }, 200)
    }

    const userId = ROLE_TO_USER[assignedTo]
    if (!userId) {
      console.error("slack-note-notify v2: no Slack user ID for role " + assignedTo)
      return jsonResp({ ok: false, reason: "unknown_role", role: assignedTo }, 200)
    }

    // Step 1: open a DM with the assignee
    const dmRes = await fetch(SLACK_API_OPEN_DM, {
      method:  "POST",
      headers: { Authorization: "Bearer " + BOT_TOKEN, "Content-Type": "application/json" },
      body:    JSON.stringify({ users: userId }),
    })
    const dmData = await dmRes.json()
    if (!dmData.ok) {
      console.error("slack-note-notify v2: open_dm failed: " + dmData.error)
      return jsonResp({ ok: false, reason: dmData.error || "dm_open_failed", step: "open_dm" }, 200)
    }
    const dmChannel = dmData.channel
    const channelId = dmChannel ? dmChannel.id : null
    if (!channelId) {
      return jsonResp({ ok: false, reason: "no_channel_id", step: "open_dm" }, 200)
    }

    // Step 2: build message blocks
    const rawNote = String(noteText).replace(/\s+/g, " ").trim()
    const previewShort = rawNote.length > 280 ? rawNote.slice(0, 277) + "…" : rawNote

    const siteLabel = site === "bny"     ? "Brooklyn"
                    : site === "passaic" ? "Passaic"
                    : String(site || "")

    const contextLine = [siteLabel, tableLabel, dateLabel].filter(Boolean).join(" · ")

    const blocks: any[] = []
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "📌 *You have a new note from Paramount production*" },
    })
    if (contextLine) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: contextLine }],
      })
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "> " + previewShort },
    })
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "<https://updates-paramount.netlify.app/|Open in Paramount production tool →>",
      }],
    })

    const fallbackText = "📌 New note for you" + (contextLine ? " — " + contextLine : "") + ": " + previewShort

    // Step 3: post the message
    const postRes = await fetch(SLACK_API_POST, {
      method:  "POST",
      headers: { Authorization: "Bearer " + BOT_TOKEN, "Content-Type": "application/json; charset=utf-8" },
      body:    JSON.stringify({ channel: channelId, text: fallbackText, blocks }),
    })
    const postData = await postRes.json()
    if (!postData.ok) {
      console.error("slack-note-notify v2: post_message failed: " + postData.error)
      return jsonResp({ ok: false, reason: postData.error || "post_failed", step: "post_message" }, 200)
    }

    return jsonResp({ ok: true, ts: postData.ts, channel: channelId }, 200)
  } catch (err) {
    console.error("slack-note-notify v2 exception: " + String(err))
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
