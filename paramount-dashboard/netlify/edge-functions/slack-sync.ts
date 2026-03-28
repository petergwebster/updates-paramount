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

    // Fetch last 100 messages from channel since start of week
    const oldest = new Date(week_start).getTime() / 1000;
    const historyRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${CHANNEL_ID}&oldest=${oldest}&limit=100`,
      { headers: { 'Authorization': `Bearer ${BOT_TOKEN}` } }
    );
    const historyData = await historyRes.json();

    if (!historyData.ok) {
      return new Response(JSON.stringify({ error: historyData.error }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const messages = historyData.messages || [];
    let syncedCount = 0;

    for (const msg of messages) {
      if (!msg.thread_ts || !msg.reply_count) continue;

      // Fetch thread replies
      const threadRes = await fetch(
        `https://slack.com/api/conversations.replies?channel=${CHANNEL_ID}&ts=${msg.thread_ts}`,
        { headers: { 'Authorization': `Bearer ${BOT_TOKEN}` } }
      );
      const threadData = await threadRes.json();
      if (!threadData.ok) continue;

      const replies = (threadData.messages || []).slice(1); // skip original message
      for (const reply of replies) {
        const authorName = SLACK_MEMBERS_BY_ID[reply.user] || `Slack (${reply.user})`;
        const replyTs = reply.ts;
        const replyText = reply.text || '';
        const replyDate = new Date(parseFloat(replyTs) * 1000).toISOString();

        // Check if already synced
        const checkRes = await fetch(
          `${SUPABASE_URL}/rest/v1/section_comments?slack_ts=eq.${replyTs}&select=id`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const existing = await checkRes.json();
        if (existing?.length > 0) continue;

        // Insert reply as sent comment
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
            section: 'slack-reply',
            section_label: 'Slack Reply',
            author: authorName,
            text: replyText,
            notify_names: [],
            status: 'sent',
            slack_ts: replyTs,
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
