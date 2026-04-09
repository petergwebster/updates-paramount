import type { Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
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

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();

    const res = await fetch("https://slack.com/api/users.list?limit=200", {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
    const data = await res.json();

    if (!data.ok) {
      return new Response(JSON.stringify({ error: data.error }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const members = (data.members || [])
      .filter((m: any) => !m.deleted && !m.is_bot && m.id !== "USLACKBOT")
      .map((m: any) => ({
        id: m.id,
        name: m.profile?.real_name || m.name,
        display: m.profile?.display_name || m.name,
        avatar: m.profile?.image_48 || null,
        title: m.profile?.title || "",
      }))
      .filter((m: any) =>
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.display.toLowerCase().includes(q) ||
        m.title.toLowerCase().includes(q)
      )
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .slice(0, 20);

    return new Response(JSON.stringify({ members }), {
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

export const config = { path: "/api/slack-users" };
