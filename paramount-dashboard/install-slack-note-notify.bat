@echo off
REM Writes slack-note-notify.ts safely, bypassing OneDrive auto-link
REM Run from your repo root: install-slack-note-notify.bat

set OUT=netlify\edge-functions\slack-note-notify.ts
> "%OUT%" echo // slack-note-notify v3 - DM the assignee directly
>> "%OUT%" echo import type { Context } from "@netlify/edge-functions"
>> "%OUT%" echo:
>> "%OUT%" echo const ROLE_TO_USER: Record^<string, string^> = {
>> "%OUT%" echo   'QA Lead':             'U08NYSWFT88',
>> "%OUT%" echo   'Production Manager':  'U08NYSYR4FJ',
>> "%OUT%" echo   'Operations Manager':  'U04QFDMLA30',
>> "%OUT%" echo   'Peter Webster':       'U044K8RGAMS',
>> "%OUT%" echo }
>> "%OUT%" echo:
>> "%OUT%" echo const URL_OPEN_DM = 'https://slack' + '.com/api/conversations' + '.open'
>> "%OUT%" echo const URL_POST    = 'https://slack' + '.com/api/chat' + '.postMessage'
>> "%OUT%" echo:
>> "%OUT%" echo export default async (request: Request, _context: Context) =^> {
>> "%OUT%" echo   if (request['method'] !== "POST") return new Response("Method Not Allowed", { status: 405 })
>> "%OUT%" echo   try {
>> "%OUT%" echo     const BOT_TOKEN = (Deno as any)['env']['get']("SLACK_BOT_TOKEN") ^|^| ""
>> "%OUT%" echo     if (!BOT_TOKEN) return r({ ok: false, reason: "config", marker: "v3" })
>> "%OUT%" echo     const p: any = await request['json']()['catch'](() =^> null)
>> "%OUT%" echo     if (!p) return r({ ok: false, reason: "bad_json", marker: "v3" })
>> "%OUT%" echo     const assignedTo: string = p['assignedTo']
>> "%OUT%" echo     const noteText:   string = p['noteText']
>> "%OUT%" echo     const site:       string = p['site']
>> "%OUT%" echo     const tableLabel: string = p['tableLabel']
>> "%OUT%" echo     const dateLabel:  string = p['dateLabel']
>> "%OUT%" echo     if (!assignedTo ^|^| !noteText) return r({ ok: false, reason: "missing_fields", marker: "v3" })
>> "%OUT%" echo     const userId = ROLE_TO_USER[assignedTo]
>> "%OUT%" echo     if (!userId) return r({ ok: false, reason: "unknown_role", role: assignedTo, marker: "v3" })
>> "%OUT%" echo     const dmRes = await fetch(URL_OPEN_DM, {
>> "%OUT%" echo       method: "POST",
>> "%OUT%" echo       headers: { Authorization: "Bearer " + BOT_TOKEN, "Content-Type": "application/json" },
>> "%OUT%" echo       body: JSON.stringify({ users: userId }),
>> "%OUT%" echo     })
>> "%OUT%" echo     const dmData: any = await dmRes['json']()
>> "%OUT%" echo     if (!dmData['ok']) return r({ ok: false, reason: dmData['error'] ^|^| "dm_open_failed", step: "open_dm", marker: "v3" })
>> "%OUT%" echo     const dmChannel = dmData['channel']
>> "%OUT%" echo     const channelId = dmChannel ? dmChannel['id'] : null
>> "%OUT%" echo     if (!channelId) return r({ ok: false, reason: "no_channel_id", step: "open_dm", marker: "v3" })
>> "%OUT%" echo     const rawNote = String(noteText)['replace'](/\s+/g, " ")['trim']()
>> "%OUT%" echo     const previewShort = rawNote['length'] ^> 280 ? rawNote['slice'](0, 277) + "..." : rawNote
>> "%OUT%" echo     const siteLabel = site === "bny" ? "Brooklyn" : site === "passaic" ? "Passaic" : String(site ^|^| "")
>> "%OUT%" echo     const contextLine = [siteLabel, tableLabel, dateLabel]['filter'](Boolean)['join'](" - ")
>> "%OUT%" echo     const text = "New note for you" + (contextLine ? " - " + contextLine : "") + ": " + previewShort
>> "%OUT%" echo     const postRes = await fetch(URL_POST, {
>> "%OUT%" echo       method: "POST",
>> "%OUT%" echo       headers: { Authorization: "Bearer " + BOT_TOKEN, "Content-Type": "application/json; charset=utf-8" },
>> "%OUT%" echo       body: JSON.stringify({ channel: channelId, text }),
>> "%OUT%" echo     })
>> "%OUT%" echo     const postData: any = await postRes['json']()
>> "%OUT%" echo     if (!postData['ok']) return r({ ok: false, reason: postData['error'] ^|^| "post_failed", step: "post_message", marker: "v3" })
>> "%OUT%" echo     return r({ ok: true, ts: postData['ts'], channel: channelId, marker: "v3" })
>> "%OUT%" echo   } catch (err) {
>> "%OUT%" echo     return r({ ok: false, reason: "exception", message: String(err), marker: "v3" })
>> "%OUT%" echo   }
>> "%OUT%" echo }
>> "%OUT%" echo:
>> "%OUT%" echo function r(body: any) {
>> "%OUT%" echo   return new Response(JSON.stringify(body), {
>> "%OUT%" echo     status: 200,
>> "%OUT%" echo     headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
>> "%OUT%" echo   })
>> "%OUT%" echo }
>> "%OUT%" echo:
>> "%OUT%" echo export const config = { path: "/api/slack-note-notify" }

echo Done. File written to %OUT%
echo.
echo Verify:
echo   type %OUT% ^| findstr "marker"
echo Should return ~10 lines containing 'marker: "v3"'
