-- ============================================
-- Paramount Prints Dashboard — Supabase Schema
-- Run this entire file in the SQL Editor
-- ============================================

-- Weeks table: stores all weekly log + KPI data
CREATE TABLE IF NOT EXISTS weeks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start date NOT NULL UNIQUE,
  days jsonb DEFAULT '{}',
  kpis jsonb DEFAULT '{}',
  concerns text DEFAULT '',
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Comments table: real-time comments on weekly log and KPI sections
CREATE TABLE IF NOT EXISTS comments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start date NOT NULL,
  section text NOT NULL DEFAULT 'log',  -- 'log' or 'kpis'
  author text NOT NULL,
  text text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Correspondence table: all filed emails, notes, and file references
CREATE TABLE IF NOT EXISTS correspondence (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start date NOT NULL,
  subject text NOT NULL,
  contact text DEFAULT '',
  contact_type text DEFAULT 'other',
  direction text DEFAULT 'received',   -- 'received', 'sent', 'note'
  kpi_tag text DEFAULT 'General',
  body text DEFAULT '',
  file_url text DEFAULT NULL,
  file_name text DEFAULT NULL,
  created_at timestamptz DEFAULT now()
);

-- Indexes for fast lookups by week
CREATE INDEX IF NOT EXISTS idx_weeks_week_start ON weeks(week_start);
CREATE INDEX IF NOT EXISTS idx_comments_week_start ON comments(week_start);
CREATE INDEX IF NOT EXISTS idx_correspondence_week_start ON correspondence(week_start);
CREATE INDEX IF NOT EXISTS idx_correspondence_kpi_tag ON correspondence(kpi_tag);

-- ============================================
-- Row Level Security (RLS)
-- Since this is a no-login shared dashboard,
-- we enable RLS but allow full public access
-- via the anon key. Anyone with the link can
-- read and write — which is what you want.
-- ============================================

ALTER TABLE weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE correspondence ENABLE ROW LEVEL SECURITY;

-- Allow anyone with the anon key (i.e. your Netlify app) to read/write
CREATE POLICY "Public read weeks" ON weeks FOR SELECT USING (true);
CREATE POLICY "Public insert weeks" ON weeks FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update weeks" ON weeks FOR UPDATE USING (true);

CREATE POLICY "Public read comments" ON comments FOR SELECT USING (true);
CREATE POLICY "Public insert comments" ON comments FOR INSERT WITH CHECK (true);

CREATE POLICY "Public read correspondence" ON correspondence FOR SELECT USING (true);
CREATE POLICY "Public insert correspondence" ON correspondence FOR INSERT WITH CHECK (true);
CREATE POLICY "Public delete correspondence" ON correspondence FOR DELETE USING (true);

-- ============================================
-- Storage bucket for file uploads
-- ============================================

-- Create the correspondence storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('correspondence', 'correspondence', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public uploads and reads
CREATE POLICY "Public upload correspondence files"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'correspondence');

CREATE POLICY "Public read correspondence files"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'correspondence');

CREATE POLICY "Public delete correspondence files"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'correspondence');

-- ============================================
-- Enable Realtime on all tables
-- (So comments and updates appear live
--  without refreshing the page)
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE weeks;
ALTER PUBLICATION supabase_realtime ADD TABLE comments;
ALTER PUBLICATION supabase_realtime ADD TABLE correspondence;
