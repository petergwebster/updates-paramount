// netlify/functions/slack-upload.mjs
// Receives a base64 PDF from the browser, resolves a Slack user/channel,
// and uploads the file via Slack's files.getUploadURLExternal API.

export default async function handler(req, context) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
  if (!SLACK_BOT_TOKEN) {
    return new Response(JSON.stringify({ error: 'SLACK_BOT_TOKEN not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }

  let body
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }

  const { pdfBase64, filename, recipient, message } = body
  if (!pdfBase64 || !filename || !recipient) {
    return new Response(JSON.stringify({ error: 'Missing pdfBase64, filename, or recipient' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }

  // ── 1. Resolve recipient to a channel ID ──────────────────────────────────
  let channelId = null
  const clean = recipient.replace(/^[@#]/, '').trim().toLowerCase()

  if (recipient.startsWith('#') || !recipient.startsWith('@')) {
    // Channel lookup
    const chanRes = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200', {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    })
    const chanData = await chanRes.json()
    if (chanData.ok) {
      const match = chanData.channels?.find(c => c.name.toLowerCase() === clean)
      if (match) channelId = match.id
    }
  }

  if (!channelId) {
    // User lookup — try by display name or real name
    const usersRes = await fetch('https://slack.com/api/users.list?limit=200', {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    })
    const usersData = await usersRes.json()
    if (usersData.ok) {
      const match = usersData.members?.find(m =>
        !m.deleted && !m.is_bot && (
          m.name?.toLowerCase() === clean ||
          m.profile?.display_name?.toLowerCase() === clean ||
          m.profile?.real_name?.toLowerCase().includes(clean) ||
          m.profile?.display_name?.toLowerCase().includes(clean)
        )
      )
      if (match) {
        // Open a DM to get channel ID
        const dmRes = await fetch('https://slack.com/api/conversations.open', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ users: match.id })
        })
        const dmData = await dmRes.json()
        if (dmData.ok) channelId = dmData.channel.id
      }
    }
  }

  if (!channelId) {
    return new Response(JSON.stringify({ error: `Could not find Slack user or channel: "${recipient}"` }), {
      status: 404, headers: { 'Content-Type': 'application/json' }
    })
  }

  // ── 2. Get upload URL ─────────────────────────────────────────────────────
  const pdfBytes = Buffer.from(pdfBase64, 'base64')
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, length: pdfBytes.length })
  })
  const urlData = await urlRes.json()
  if (!urlData.ok) {
    return new Response(JSON.stringify({ error: `Slack getUploadURL failed: ${urlData.error}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }

  // ── 3. Upload the file ────────────────────────────────────────────────────
  const uploadRes = await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdfBytes
  })
  if (!uploadRes.ok) {
    return new Response(JSON.stringify({ error: `File upload failed: ${uploadRes.status}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }

  // ── 4. Complete upload and share to channel ───────────────────────────────
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ id: urlData.file_id }],
      channel_id: channelId,
      initial_comment: message || `Production report: ${filename}`
    })
  })
  const completeData = await completeRes.json()
  if (!completeData.ok) {
    return new Response(JSON.stringify({ error: `files.completeUpload failed: ${completeData.error}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ ok: true, fileId: urlData.file_id }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  })
}

export const config = { path: '/api/slack-upload' }
