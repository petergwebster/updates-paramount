-- ============================================================================
-- sched_daily_ops_lines — per-PO production lines under a Live Ops cell
-- ============================================================================
-- Option B (2026-07-06): sched_daily_ops stays the per-cell HEADER
-- (operators, notes, and a ROLLED-UP actual_yards / waste_yards = sum of the
-- lines below). This child table adds one row per PO/SKU that actually ran on
-- a given table / day / shift, so Live Ops can record production BY PO when
-- several jobs share a table in one day.
--
-- Why a child table (not more columns on sched_daily_ops): every existing
-- reader — Heartbeat, operator scorecards, the KPI strip, and Claude's
-- buildRecentActualsSummary — reads the header's actual_yards. Keeping the
-- header as the rolled-up total means none of them change; the per-PO detail
-- is purely additive.
--
-- Keyed naturally by (site, week_start, table_code, day_of_week, shift). No
-- hard unique constraint on the PO columns on purpose: id-based CRUD from the
-- app, and a duplicate PO won't throw an insert error mid-entry during go-live
-- week (reliable-now over strict). RLS disabled to match every other table in
-- this project (the frontend writes with the anon key; F-016 RLS tightening is
-- a separate epic).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sched_daily_ops_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site          text NOT NULL CHECK (site = ANY (ARRAY['passaic'::text, 'bny'::text])),
  week_start    date NOT NULL,
  table_code    text NOT NULL,
  day_of_week   text NOT NULL CHECK (day_of_week = ANY (ARRAY['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])),
  shift         text NOT NULL DEFAULT '1st' CHECK (shift = ANY (ARRAY['1st','2nd'])),
  po_number     text,
  item_sku      text,
  color         text,
  line_description text,
  actual_yards  numeric,
  waste_yards   numeric,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- Fast lookup of all lines for a cell (and for a whole week on load).
CREATE INDEX IF NOT EXISTS sched_daily_ops_lines_cell_idx
  ON public.sched_daily_ops_lines (site, week_start, table_code, day_of_week, shift);

-- Match the rest of the project: RLS disabled (frontend uses the anon key).
ALTER TABLE public.sched_daily_ops_lines DISABLE ROW LEVEL SECURITY;

-- Verify
SELECT 'sched_daily_ops_lines created' AS status,
       count(*) AS existing_rows
FROM public.sched_daily_ops_lines;
