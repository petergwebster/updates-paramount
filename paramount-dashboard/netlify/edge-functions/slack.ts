import type { Context } from "@netlify/edge-functions";

const SLACK_MEMBERS: Record<string, string> = {
  'Peter Webster': 'U044K8RGAMS',
  'Timur Y': 'U4W6D4CF2',
  'Antonella Pilo': 'U0372S95NSH',
  'Abigail Pratt': 'U02A3801X28',
  'Emily Huber': 'U09PEFE8VSS',
  'Brynn Lawlor': 'U04QFDMLA30',
  'Wendy Reger-Hare': 'U08NYSYR4FJ',
  'Estephanie Soto-Martinez': 'U0ACBRTS3E1',
};

const WEBHOOK_URL = Deno.env.get('SLACK_WEBHOOK_URL') || '';

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
    const { author, weekLabel, comments, dashboardUrl } = await request.json();

    // Build the Slack message blocks
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `💬 ${author} reviewed the ${weekLabel} dashboard`,
          emoji: true,
        },
      },
    ];

    // Collect all unique mentioned Slack IDs across all comments
    const allMentionedIds = new Set<string>();

    for (const comment of comments) {
      // Build mention text for this comment
      const mentionTags = (comment.notify_names || [])
        .map((name: string) => {
          const id = SLACK_MEMBERS[name];
          if (id) { allMentionedIds.add(id); return `<@${id}>`; }
          return `@${name}`;
        })
        .join(' ');

      const mentionLine = mentionTags ? `\n${mentionTags}` : '';

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${comment.section_label}*\n_${comment.text}_${mentionLine}`,
        },
      });

      blocks.push({ type: "divider" });
    }

    // Footer with dashboard link
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `👉 <${dashboardUrl}|View dashboard>`,
      },
    });

    // Build the text fallback — mention everyone who was @mentioned
    const mentionSummary = allMentionedIds.size > 0
      ? [...allMentionedIds].map(id => `<@${id}>`).join(' ') + ' — '
      : '';

    const payload = {
      text: `${mentionSummary}${author} posted a dashboard review for ${weekLabel}`,
      blocks,
    };

    const slackRes = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!slackRes.ok) {
      const errText = await slackRes.text();
      return new Response(JSON.stringify({ error: errText }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
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

export const config = { path: "/api/slack" };
