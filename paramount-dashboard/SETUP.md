# Paramount Prints Dashboard — Setup Guide

Total setup time: ~20 minutes

---

## Step 1 — Create your Supabase project (5 min)

1. Go to https://supabase.com and sign up for a free account
2. Click "New Project"
   - Name: `paramount-dashboard`
   - Database Password: choose something strong, save it
   - Region: US East (cheapest/fastest for NJ/NY)
3. Wait ~2 minutes for the project to spin up

---

## Step 2 — Create the database tables (5 min)

1. In your Supabase project, click **SQL Editor** in the left sidebar
2. Click **New Query**
3. Paste in the entire contents of `supabase-schema.sql` (in this folder)
4. Click **Run**
5. You should see "Success" — no errors

---

## Step 3 — Get your API keys (2 min)

1. In Supabase, go to **Settings → API**
2. Copy two values:
   - **Project URL** (looks like: `https://abcdefgh.supabase.co`)
   - **anon public key** (long string starting with `eyJ...`)

---

## Step 4 — Add your keys to the project (2 min)

Create a file called `.env` in the root of the project folder (same level as `package.json`):

```
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=eyJyour-anon-key-here
```

Replace the values with what you copied in Step 3.

---

## Step 5 — Push to GitHub (3 min)

1. Go to https://github.com and create a new repository called `paramount-dashboard`
2. Make it Private
3. In your terminal, navigate to this folder and run:

```bash
git init
git add .
git commit -m "Initial Paramount Dashboard"
git remote add origin https://github.com/YOUR_USERNAME/paramount-dashboard.git
git push -u origin main
```

---

## Step 6 — Deploy to Netlify (3 min)

1. Go to https://netlify.com and log in (or create a free account)
2. Click **"Add new site" → "Import an existing project"**
3. Connect to GitHub and select your `paramount-dashboard` repo
4. Build settings (should auto-detect):
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
5. Click **"Add environment variables"** and add:
   - `VITE_SUPABASE_URL` = your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon key
6. Click **Deploy site**
7. After ~2 minutes you'll get a URL like `https://cheerful-mango-123456.netlify.app`

---

## Step 7 — Share the link

Send the Netlify URL to Timur and Emily. Anyone with the link can:
- View all weekly logs and KPI scorecards
- Add comments and responses (real-time)
- View filed correspondence

Only you will be entering the weekly data and filing correspondence.

---

## Optional: Custom domain

In Netlify → Domain settings, you can add a custom domain like `updates.paramountprints.com` if you have one.

---

## Troubleshooting

**"Cannot read from Supabase"** — Check your `.env` file has no spaces around the `=` sign

**Files not uploading** — In Supabase → Storage, make sure the `correspondence` bucket is set to Public

**Site not building on Netlify** — Make sure environment variables are set in Netlify's site settings, not just locally
