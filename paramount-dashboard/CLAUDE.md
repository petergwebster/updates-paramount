# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps
npm run dev          # Vite dev server (frontend only — /api/* routes 404)
npm run build        # production build → dist/
npm run preview      # serve the built dist/
```

There is **no test runner and no linter** configured — `dev`, `build`, and `preview` are the only scripts.

To exercise the `/api/*` serverless routes locally you need the Netlify CLI (`netlify dev`), since they are Netlify edge/serverless functions, not part of the Vite server. Without it the frontend runs but every Claude/Slack/Monday/PDF call fails.

## Environment

**Client-exposed env** — any `VITE_`-prefixed var that is read in `src/` via `import.meta.env` gets inlined into the public JS bundle at build time. Only three are actually read in `src/`: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (`src/supabase.js`), and `VITE_GOOGLE_SHEETS_API_KEY` (`src/components/ProductionTab.jsx`). The Supabase anon key being public is by design (RLS is permissive — see Database). Copy `.env.example` → `.env`.

> `VITE_GOOGLE_SHEETS_API_KEY` is still referenced in `ProductionTab.jsx`, but that component's live-data exports (`useProductionData`, `FacilityDetail`, …) are imported into `App.jsx` and **never mounted** — the Google Sheets integration is effectively orphaned. Don't build on it; the active production data comes from the snapshot pipeline (`production` table / `v_current_*` views).

**Server-only secrets** — set as **Netlify environment variables** and read only inside `netlify/` functions (via `process.env` / `Netlify.env` / `Deno.env`): the Anthropic key, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, the Monday token, and `SUPABASE_SERVICE_ROLE_KEY` (service role — used by functions that write while bypassing RLS).

> ⚠️ **Naming footgun**: the Anthropic and Monday keys are currently named `VITE_ANTHROPIC_API_KEY` and `VITE_MONDAY_TOKEN`. They are **not** in the client bundle today only because no `src/` file references them — but the `VITE_` prefix means the instant any frontend code reads one, the secret is baked into public JS. Prefer the unprefixed names (`ANTHROPIC_API_KEY`, `MONDAY_TOKEN`). The functions already accept unprefixed fallbacks in places (`monday-newgoods-observations.ts`, `monday-newgoods-refresh.ts`); `claude.ts`, `claude-stream.mjs`, and `Functions/claude.mjs` still read the `VITE_`-prefixed name only.

## Architecture

A single-page React 18 + Vite dashboard for Paramount Prints (a wallpaper/fabric printer, division of F. Schumacher & Co.). **Supabase is the entire backend** — Postgres, Auth, Realtime, and Storage. There is no custom server; the only server-side code is Netlify functions that proxy third-party APIs.

### Routing & the three "destinations"

There is **no router library**. `src/App.jsx` is a hand-rolled router driven by two state values: `destination` (`'landing' | 'performance' | 'operations' | 'heartbeat'`) and `activeTab`. After login every user lands on `LandingPage` (the chooser), then enters a destination whose tab set is destination- and role-specific (see `PERFORMANCE_TABS`, `OPERATIONS_TABS`, `HEARTBEAT_TABS` in App.jsx). Destination + tab are persisted to `localStorage` so a refresh returns the user to where they were.

- **Performance** — weekly recap, financials, people, inventory. Defaults to the *prior closed* week (the week being reviewed).
- **Operations** — WIP → NEW Goods → Scheduler → Live Ops (the floor-planning flow). Defaults to current week.
- **Heartbeat** — single deep "pulse" page across both plants (Passaic / Brooklyn). Defaults to current week.

### Access control

`src/lib/access.js` is the single source of truth for who sees what. Access is derived from `profiles.role` (`admin`, `exec`, `manager`, `qa`) plus `profiles.active`; the super-admin (User Management) is gated by a **hardcoded email** (`SUPER_ADMIN_EMAIL`). Note: this is *client-side* gating only — Supabase RLS policies allow full public read/write via the anon key (see below), so do not treat the role system as a security boundary.

### Auth

Email/password via Supabase Auth (`src/supabase.js`, session persisted under storage key `pp_auth`). On bootstrap App.jsx loads the matching `profiles` row (with a one-shot retry for JWT-propagation races). `LoginScreen` handles sign-in.

### Serverless functions (`/api/*`)

Routes are declared in `netlify.toml` and/or via each function's `export const config = { path }`.

- `netlify/edge-functions/` — Deno edge functions: `claude.ts` & `claude-stream.mjs` (thin proxies to `api.anthropic.com`, keeping the API key server-side), the `slack*` functions (notify/sync/upload/users), and `monday-newgoods-*` (fetch + AI-observe the Monday.com NEW Goods board).
- `netlify/Functions/` — Node functions: `lock-wip.js`, `generate-pdf.mjs`, `claude.mjs`.
- `lock-wip` is a **scheduled function** (cron `0 5 * * 6` = Saturday midnight ET): it pulls the full Monday.com WIP board, classifies every item into buckets (SCHEDULE/HTI/POST/HOLD/NEW_GOODS/WIP), and writes a weekly `wip_snapshots` row. Also POST-callable from the Admin panel.
- Note there are **two implementations of `/api/claude`** (an edge `claude.ts` and a Node `claude.mjs`) — the edge function wins. Prefer editing `claude.ts` / `claude-stream.mjs`.

### Fiscal calendar & week anchoring (important, easy to get wrong)

The business runs a **4/4/5 fiscal calendar** with **Sunday-anchored weeks**. `week_start` columns store the **Sunday** date as a `yyyy-MM-dd` string. `src/fiscalCalendar.js` hardcodes the 2026 week→fiscal-period map. `src/lib/scheduleUtils.js` holds the shared date helpers (`sundayOf`, `weekLabel`, `dayOfWeekFiscal`, …), formatters, the color palette, and operator rosters. Beware deprecated aliases kept for back-compat: `mondayOf` is now an alias for `sundayOf`, and `weekLabelFiscal` for `weekLabel`.

`day_of_week` is stored as **TEXT** (`'Sun'`..`'Sat'`), not an integer — a recent migration. Several recent commits fix numeric→text coercion at DB write/read boundaries; when touching scheduler assignments, always normalize to text.

### Data ingestion pipeline

Operational data originates as Excel pivot exports from **LIFT** and a Monday.com board. `src/lib/parsers/*` parse the workbooks (`parserHelpers.js` has the shared pivot-table machinery). `src/lib/persistSnapshot.js` is the universal write path: it inserts a parent `data_snapshots` row, bulk-inserts child rows (batched at 500) into per-sheet tables (`wip_*`, `mos_*`, `inv_*`), then flips `is_current=true` only on success. **Snapshots are versioned** — read the current data via the `v_current_*` views, which resolve to the latest successful snapshot.

### AI / narrative generation

`src/lib/contextBuilder.js` assembles a **tiered context block** for Claude prompts: Bucket A = static `business_facts`, Bucket B = tiered history (`weeks`, `production`, `historical_summaries`), Bucket C = forward state (schedule, WIP). Prompt templates live in `src/lib/prompts/` and `src/prompts/`. Generated narratives are cached in `dashboard_narratives` and rendered by `ClaudeReadBlock.jsx`. All model calls go through `/api/claude` or `/api/claude-stream`.

## Database

`supabase-schema.sql` is the **original bootstrap only** (`weeks`, `comments`, `correspondence`) and is now stale — the live schema has grown well beyond it through migrations that are **not committed to this repo**. Notably the app reads/writes `section_comments` (not the `comments` table in the SQL file). Treat the actual Supabase project as the source of truth, not `supabase-schema.sql`.

Tables/views referenced across the codebase include: `profiles`, `weeks`, `production`, `section_comments`, `kpi_reactions`, `correspondence`, `business_facts`, `historical_summaries`, `dashboard_narratives`, `ai_call_log`, `sched_snapshots`, `sched_wip_rows`, `sched_assignments`, `sched_daily_ops`, `wip_snapshots`, `data_snapshots` + `wip_*`/`mos_*`/`inv_*` child tables, `financials_monthly`, `financial_ap`/`ar`/`cash`, `people_weekly`, `monthly_briefs`, `mng_snapshots`/`mng_items`/`mng_observations`, `role_change_log`, and `v_current_*` views.

**RLS is intentionally permissive** — policies grant public read/write through the anon key because this is a shared, link-based internal dashboard. Security relies on the obscurity of the deployment URL plus client-side role gating, not on database policies.

## Conventions

- **Styling**: CSS Modules per component (`Component.module.css`) plus CSS custom properties in `src/styles/tokens.css`. A second palette source-of-truth, the `C` export in `scheduleUtils.js`, is used by scheduler/ops/heartbeat components — keep the two in sync. The theme is "Pure Cosmic" (teal/slate); status colors (green/amber/red) are deliberately kept loud regardless of theme.
- **Realtime**: comments and week updates use Supabase Realtime subscriptions for live updates without refresh.
- Components are large and self-contained; most data fetching happens directly inside components via the shared `supabase` client rather than a central store.

## Deployment

Hosted on **Netlify**, auto-deploying from `main`. Build command `npm run build`, publish dir `dist`. Setup details (Supabase project creation, schema load, env vars) are in `SETUP.md`.
