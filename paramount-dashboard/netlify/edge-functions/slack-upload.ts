import type { Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  try {
    const BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN") || "";

    if (!BOT_TOKEN) {
      return new Response(JSON.stringify({ error: "SLACK_BOT_TOKEN not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const { pdfBase64, filename, recipient, message } = await request.json();

    if (!pdfBase64 || !filename || !recipient) {
      return new Response(JSON.stringify({ error: "Missing pdfBase64, filename, or recipient" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const clean = recipient.replace(/^[@#]/, "").trim().toLowerCase();
    let channelId: string | null = null;

    // Try channel lookup first (if starts with # or no @)
    if (!recipient.startsWith("@")) {
      const chanRes = await fetch(
        "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200",
        { headers: { Authorization: `Bearer ${BOT_TOKEN}` } }
      );
      const chanData = await chanRes.json();
      if (chanData.ok) {
        const match = chanData.channels?.find((c: any) => c.name.toLowerCase() === clean);
        if (match) channelId = match.id;
      }
    }

    // Try user lookup
    if (!channelId) {
      const usersRes = await fetch("https://slack.com/api/users.list?limit=200", {
        headers: { Authorization: `Bearer ${BOT_TOKEN}` },
      });
      const usersData = await usersRes.json();
      if (usersData.ok) {
        const match = usersData.members?.find(
          (m: any) =>
            !m.deleted &&
            !m.is_bot &&
            (m.name?.toLowerCase() === clean ||
              m.profile?.display_name?.toLowerCase() === clean ||
              m.profile?.real_name?.toLowerCase().includes(clean) ||
              m.profile?.display_name?.toLowerCase().includes(clean))
        );
        if (match) {
          const dmRes = await fetch("https://slack.com/api/conversations.open", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${BOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ users: match.id }),
          });
          const dmData = await dmRes.json();
          if (dmData.ok) channelId = dmData.channel.id;
        }
      }
    }

    if (!channelId) {
      return new Response(
        JSON.stringify({ error: `Could not find Slack user or channel: "${recipient}"` }),
        { status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    // Decode base64 PDF
    const binaryStr = atob(pdfBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    // Get upload URL
    const urlRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filename, length: bytes.length }),
    });
    const urlData = await urlRes.json();
    if (!urlData.ok) {
      return new Response(
        JSON.stringify({ error: `Slack getUploadURL failed: ${urlData.error}` }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    // Upload file bytes
    await fetch(urlData.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: bytes,
    });

    // Complete upload and share to channel
    const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id }],
        channel_id: channelId,
        initial_comment: message || `Production report: ${filename}`,
      }),
    });
    const completeData = await completeRes.json();
    if (!completeData.ok) {
      return new Response(
        JSON.stringify({ error: `files.completeUpload failed: ${completeData.error}` }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
};

export const config = { path: "/api/slack-upload" };
