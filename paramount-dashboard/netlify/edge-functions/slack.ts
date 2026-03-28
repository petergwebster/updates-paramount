import type { Context } from "@netlify/edge-functions";

const SLACK_MEMBERS: Record<string, string> = {
  'Peter Webster':          'U044K8RGAMS',
  'Timur Y':                'U4W6D4CF2',
  'Antonella Pilo':         'U0372S95NSH',
  'Abigail Pratt':          'U02A3801X28',
  'Emily Huber':            'U09PEFE8VSS',
  'Brynn Lawlor':           'U04QFDMLA30',
  'Wendy Reger-Hare':       'U08NYSYR4FJ',
  'Estephanie Soto-Martinez': 'U0ACBRTS3E1',
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
    const BOT_TOKEN  = Deno.env.get('SLACK_BOT_TOKEN') || '';
    const CHANNEL_ID = Deno.env.get('SLACK_CHANNEL_ID') || '';

    if (!BOT_TOKEN || !CHANNEL_ID) {
      return new Response(JSON.stringify({ error: 'Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID' }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const { author, weekLabel, comments, dashboardUrl } = await request.json();

    if (!comments || comments.length === 0) {
      return new Response(JSON.stringify({ ok: true, note: 'No comments to notify' }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Build comment lines for the message
    // Each line: bullet + section label + comment text + directed mentions if any
    const commentLines = comments.map((c: any) => {
      const directed = (c.notify_names || [])
        .map((name: string) => {
          const id = SLACK_MEMBERS[name];
          return id ? `<@${id}>` : name;
        });

      const directedStr = directed.length > 0
        ? ` — ${directed.join(' ')}`
        : '';

      return `• *${c.section_label}*: ${c.text}${directedStr}`;
    }).join('\n');

    // Collect all unique people who need to be @mentioned across all comments
    const allMentioned = new Set<string>();
    for (const c of comments) {
      for (const name of (c.notify_names || [])) {
        const id = SLACK_MEMBERS[name];
        if (id) allMentioned.add(`<@${id}>`);
      }
    }

    // If no directed mentions, this goes to the whole group — no individual pings needed
    const mentionLine = allMentioned.size > 0
      ? `\n${Array.from(allMentioned).join(' ')} — you have directed comments above`
      : '';

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
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `💬 *${author}* commented on the *${weekLabel}* dashboard`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: commentLines,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `👉 <${dashboardUrl}|View dashboard>${mentionLine}`,
            },
          },
          {
            type: 'divider',
          },
        ],
        text: `${author} commented on the ${weekLabel} dashboard — ${comments.length} comment${comments.length !== 1 ? 's' : ''}`,
      }),
    });

    const msgData = await msgRes.json();

    return new Response(JSON.stringify({
      ok: msgData.ok,
      ts: msgData.ts,
      error: msgData.error,
    }), {
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
