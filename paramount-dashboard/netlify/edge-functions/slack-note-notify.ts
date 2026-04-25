// slack-note-notify v3 - DM the assignee directly
import type { Context } from "@netlify/edge-functions"

const ROLE_TO_USER: Record<string, string> = {
  'QA Lead':             'U08NYSWFT88',
  'Production Manager':  'U08NYSYR4FJ',
  'Operations Manager':  'U04QFDMLA30',
  'Peter Webster':       'U044K8RGAMS',
}

const URL_OPEN_DM = 'https://slack' + '.com/api/conversations' + '.open'
const URL_POST    = 'https://slack' + '.com/api/chat' + '.postMessage'

export default async (request: Request, _context: Context) => {
  if (request['method'] !== "POST") return new Response("Method Not Allowed", { status: 405 })
  try {
    const BOT_TOKEN = (Deno as any)['env']['get']("SLACK_BOT_TOKEN") || ""
    if (!BOT_TOKEN) return r({ ok: false, reason: "config", marker: "v3" })
    const p: any = await request['json']()['catch'](() => null)
    if (!p) return r({ ok: false, reason: "bad_json", marker: "v3" })
    const assignedTo: string = p['assignedTo']
    const noteText:   string = p['noteText']
    const site:       string = p['site']
    const tableLabel: string = p['tableLabel']
    const dateLabel:  string = p['dateLabel']
    if (!assignedTo || !noteText) return r({ ok: false, reason: "missing_fields", marker: "v3" })
    const userId = ROLE_TO_USER[assignedTo]
    if (!userId) return r({ ok: false, reason: "unknown_role", role: assignedTo, marker: "v3" })
    const dmRes = await fetch(URL_OPEN_DM, {
      method: "POST",
      headers: { Authorization: "Bearer " + BOT_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ users: userId }),
    })
    const dmData: any = await dmRes['json']()
    if (!dmData['ok']) return r({ ok: false, reason: dmData['error'] || "dm_open_failed", step: "open_dm", marker: "v3" })
    const dmChannel = dmData['channel']
    const channelId = dmChannel ? dmChannel['id'] : null
    if (!channelId) return r({ ok: false, reason: "no_channel_id", step: "open_dm", marker: "v3" })
    const rawNote = String(noteText)['replace'](/\s+/g, " ")['trim']()
    const previewShort = rawNote['length'] > 280 ? rawNote['slice'](0, 277) + "..." : rawNote
    const siteLabel = site === "bny" ? "Brooklyn" : site === "passaic" ? "Passaic" : String(site || "")
    const contextLine = [siteLabel, tableLabel, dateLabel]['filter'](Boolean)['join'](" - ")
    const text = "New note for you" + (contextLine ? " - " + contextLine : "") + ": " + previewShort
    const postRes = await fetch(URL_POST, {
      method: "POST",
      headers: { Authorization: "Bearer " + BOT_TOKEN, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: channelId, text }),
    })
    const postData: any = await postRes['json']()
    if (!postData['ok']) return r({ ok: false, reason: postData['error'] || "post_failed", step: "post_message", marker: "v3" })
    return r({ ok: true, ts: postData['ts'], channel: channelId, marker: "v3" })
  } catch (err) {
    return r({ ok: false, reason: "exception", message: String(err), marker: "v3" })
  }
}

function r(body: any) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
}

export const config = { path: "/api/slack-note-notify" }
