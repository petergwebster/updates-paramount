import type { Context } from "@netlify/edge-functions";

const SLACK_MEMBERS = {
  'Peter Webster': 'U044K8RGAMS',
  'Timur Y': 'U4W6D4CF2',
  'Antonella Pilo': 'U0372S95NSH',
  'Abigail Pratt': 'U02A3801X28',
  'Emily Huber': 'U09PEFE8VSS',
  'Brynn Lawlor': 'U04QFDMLA30',
  'Wendy Reger-Hare': 'U08NYSYR4FJ',
  'Estephanie Soto-Martinez': 'U0ACBRTS3E1',
} as Record<string, string>;

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
    const WEBHOOK_URL = Deno.env.get('SLACK_WEBHOOK_URL') || '';
    const BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN') || '';
    const CHANNEL_ID = Deno.env.get('SLACK_CHANNEL_ID') || '';
    const SUPABASE_URL = Deno.env.get('VITE_SUPABASE_URL') || '';
    const SUPABASE_KEY = Deno.env.get('VITE_SUPABASE_ANON_KEY') || '';

    if (!WEBHOOK_URL) {
      return new Response(JSON.stringify({ error: 'SLACK_WEBHOOK_URL not set' }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const { author, weekLabel, comments, dashboardUrl } = await request.json();

    // Post a header message first via webhook
    const headerPayload = {
      text: `💬 ${author} reviewed the ${weekLabel} dashboard`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `💬 ${author} reviewed the ${weekLabel} dashboard`,
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `👉 <${dashboardUrl}|View dashboard> — reply to any section below to leave feedback`,
          },
        },
      ],
    };

    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(headerPayload),
    });

    // Post each comment as a SEPARATE message via Bot API so we get the ts back
    // This lets us match Slack replies back to specific dashboard sections
    const postedMessages: Array<{ commentId: string; slackTs: string }> = [];

    if (BOT_TOKEN && CHANNEL_ID) {
      for (const comment of comments) {
        const mentionTags = (comment.notify_names || [])
          .map((name: string) => {
            const id = SLACK_MEMBERS[name];
            return id ? `<@${id}>` : `@${name}`;
          })
          .join(' ');

        const mentionLine = mentionTags ? `\n${mentionTags}` : '';

        const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BOT_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channel: CHANNEL_ID,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*${comment.section_label}*\n${comment.text}${mentionLine}`,
                },
              },
            ],
            text: `${comment.section_label}: ${comment.text}`,
          }),
        });

        const msgData = await msgRes.json();

        if (msgData.ok && msgData.ts && comment.id) {
          postedMessages.push({ commentId: comment.id, slackTs: msgData.ts });
        }
      }

      // Store slack_message_ts back on each comment in Supabase
      for (const { commentId, slackTs } of postedMessages) {
        await fetch(`${SUPABASE_URL}/rest/v1/section_comments?id=eq.${commentId}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ slack_message_ts: slackTs }),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, posted: postedMessages.length }), {
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

export const config = { path: "/api/slack" };
