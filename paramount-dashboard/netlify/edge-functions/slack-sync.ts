import type { Context } from "@netlify/edge-functions";

const SLACK_MEMBERS_BY_ID: Record<string, string> = {
  'U044K8RGAMS': 'Peter Webster',
  'U4W6D4CF2': 'Timur Y',
  'U0372S95NSH': 'Antonella Pilo',
  'U02A3801X28': 'Abigail Pratt',
  'U09PEFE8VSS': 'Emily Huber',
  'U04QFDMLA30': 'Brynn Lawlor',
  'U08NYSYR4FJ': 'Wendy Reger-Hare',
  'U0ACBRTS3E1': 'Estephanie Soto-Martinez',
};

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
    const BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN') || '';
    const CHANNEL_ID = Deno.env.get('SLACK_CHANNEL_ID') || '';
    const SUPABASE_URL = Deno.env.get('VITE_SUPABASE_URL') || '';
    const SUPABASE_KEY = Deno.env.get('VITE_SUPABASE_ANON_KEY') || '';

    if (!BOT_TOKEN || !CHANNEL_ID) {
      return new Response(JSON.stringify({ error: 'Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID' }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const { week_start } = await request.json();
    if (!week_start) {
      return new Response(JSON.stringify({ error: 'week_start required' }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Load all section comments for this week that have a slack_message_ts
    const commentsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/section_comments?week_start=eq.${week_start}&slack_message_ts=not.is.null&select=id,section,section_label,slack_message_ts`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const sectionComments = await commentsRes.json();

    if (!sectionComments?.length) {
      return new Response(JSON.stringify({ ok: true, synced: 0, note: 'No section comments with Slack message timestamps found for this week' }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Build a map of slack_message_ts -> section comment info
    const tsToSection: Record<string, { id: string; section: string; section_label: string }> = {};
    for (const c of sectionComments) {
      tsToSection[c.slack_message_ts] = { id: c.id, section: c.section, section_label: c.section_label };
    }

    let syncedCount = 0;

    // For each tracked message, fetch its thread replies
    for (const [slackMsgTs, sectionInfo] of Object.entries(tsToSection)) {
      const threadRes = await fetch(
        `https://slack.com/api/conversations.replies?channel=${CHANNEL_ID}&ts=${slackMsgTs}`,
        { headers: { 'Authorization': `Bearer ${BOT_TOKEN}` } }
      );
      const threadData = await threadRes.json();
      if (!threadData.ok) continue;

      const replies = (threadData.messages || []).slice(1); // skip original

      for (const reply of replies) {
        const replyTs = reply.ts;
        const authorName = SLACK_MEMBERS_BY_ID[reply.user] || `Slack (${reply.user})`;
        const replyText = reply.text || '';
        const replyDate = new Date(parseFloat(replyTs) * 1000).toISOString();

        // Check if already synced
        const checkRes = await fetch(
          `${SUPABASE_URL}/rest/v1/section_comments?slack_ts=eq.${replyTs}&select=id`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const existing = await checkRes.json();
        if (existing?.length > 0) continue;

        // Insert as a reply in the correct section, with parent_id pointing to the original comment
        await fetch(`${SUPABASE_URL}/rest/v1/section_comments`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({
            week_start,
            section: sectionInfo.section,
            section_label: sectionInfo.section_label,
            author: authorName,
            text: replyText,
            notify_names: [],
            status: 'sent',
            slack_ts: replyTs,
            parent_id: sectionInfo.id,
            created_at: replyDate,
          }),
        });
        syncedCount++;
      }
    }

    return new Response(JSON.stringify({ ok: true, synced: syncedCount }), {
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

export const config = { path: "/api/slack-sync" };
