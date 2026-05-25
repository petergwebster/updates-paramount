-- ============================================================
-- Paramount Dashboard — Live Supabase Schema Export
-- ============================================================
-- Project: updates-paramount (Supabase project ID: twsfmzohaymobqmmeayd)
-- Captured: May 2026 via Supabase dashboard schema export + SQL Editor queries
-- Purpose: Phase 2 (data model) of the architecture audit
--
-- This file is the live schema as observed against the deployed database.
-- It supersedes the stale supabase-schema.sql in the repo root.
--
-- Sections:
--   1. TABLES — CREATE TABLE statements with PK/FK/CHECK constraints
--   2. VIEWS — view definitions (8 views, all snapshot-versioned)
--   3. RLS POLICIES — every policy on every table in public schema
--   4. TRIGGERS — trigger definitions (function bodies not extracted)
--
-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.
-- ============================================================


-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE public.ai_call_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  caller_id uuid,
  prompt_type text NOT NULL,
  context jsonb DEFAULT '{}'::jsonb,
  prompt text DEFAULT ''::text,
  response text DEFAULT ''::text,
  model text DEFAULT 'claude-sonnet-4-20250514'::text,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  error text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_call_log_pkey PRIMARY KEY (id),
  CONSTRAINT ai_call_log_caller_id_fkey FOREIGN KEY (caller_id) REFERENCES auth.users(id)
);

CREATE TABLE public.business_facts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fact_number integer NOT NULL UNIQUE,
  category text NOT NULL,
  fact text NOT NULL,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT business_facts_pkey PRIMARY KEY (id)
);

CREATE TABLE public.comments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  section text NOT NULL DEFAULT 'log'::text,
  author text NOT NULL,
  text text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT comments_pkey PRIMARY KEY (id)
);

CREATE TABLE public.correspondence (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  subject text NOT NULL,
  contact text DEFAULT ''::text,
  contact_type text DEFAULT 'other'::text,
  direction text DEFAULT 'received'::text,
  kpi_tag text DEFAULT 'General'::text,
  body text DEFAULT ''::text,
  file_url text,
  file_name text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT correspondence_pkey PRIMARY KEY (id)
);

CREATE TABLE public.dashboard_narratives (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  time_window text NOT NULL CHECK (time_window = ANY (ARRAY['today'::text, 'week'::text, 'month'::text, 'recap'::text, 'heartbeat'::text])),
  narrative text NOT NULL,
  generated_at timestamp with time zone DEFAULT now(),
  edited_by uuid,
  edited_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT dashboard_narratives_pkey PRIMARY KEY (id),
  CONSTRAINT dashboard_narratives_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES auth.users(id)
);

CREATE TABLE public.data_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  uploaded_at timestamp with time zone NOT NULL DEFAULT now(),
  uploaded_by uuid,
  uploaded_by_email text,
  file_kind text NOT NULL CHECK (file_kind = ANY (ARRAY['wip'::text, 'mos'::text, 'inventory'::text, 'mos_material_color'::text])),
  is_current boolean NOT NULL DEFAULT false,
  source_file text,
  file_size_bytes bigint,
  source text NOT NULL DEFAULT 'manual_upload'::text CHECK (source = ANY (ARRAY['manual_upload'::text, 'sharefile_auto'::text, 'api'::text])),
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'parsing'::text, 'success'::text, 'partial'::text, 'failed'::text])),
  sheets_parsed jsonb DEFAULT '{}'::jsonb,
  errors jsonb DEFAULT '{}'::jsonb,
  parse_duration_ms integer,
  notes text,
  CONSTRAINT data_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT data_snapshots_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id)
);

CREATE TABLE public.data_source_config (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  file_kind text NOT NULL UNIQUE CHECK (file_kind = ANY (ARRAY['wip'::text, 'mos'::text, 'inventory'::text])),
  auto_fetch_enabled boolean NOT NULL DEFAULT false,
  sharefile_folder_id text,
  sharefile_filename_pattern text,
  expected_frequency_hours integer DEFAULT 24,
  last_fetch_at timestamp with time zone,
  last_fetch_status text,
  last_fetch_error text,
  config jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT data_source_config_pkey PRIMARY KEY (id)
);

CREATE TABLE public.financial_ap (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period text NOT NULL,
  facility text NOT NULL,
  total numeric,
  current numeric,
  days1_7 numeric,
  days8_14 numeric,
  days15_30 numeric,
  days31_45 numeric,
  days45plus numeric,
  past_due numeric,
  top_vendors jsonb,
  uploaded_at timestamp with time zone,
  CONSTRAINT financial_ap_pkey PRIMARY KEY (id)
);

CREATE TABLE public.financial_ar (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period text NOT NULL UNIQUE,
  aging_current numeric,
  aging_1_30 numeric,
  aging_31_60 numeric,
  aging_61_90 numeric,
  aging_91plus numeric,
  total_outstanding numeric,
  total_past_due numeric,
  key_accounts jsonb,
  uploaded_at timestamp with time zone,
  CONSTRAINT financial_ar_pkey PRIMARY KEY (id)
);

CREATE TABLE public.financial_cash (
  period text NOT NULL,
  passaic_cash numeric DEFAULT 0,
  bny_cash numeric DEFAULT 0,
  uploaded_at text,
  CONSTRAINT financial_cash_pkey PRIMARY KEY (period)
);

CREATE TABLE public.financials_monthly (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  period text NOT NULL,
  business_unit text NOT NULL,
  cogs_material numeric DEFAULT 0,
  cogs_labor numeric DEFAULT 0,
  cogs_wip numeric DEFAULT 0,
  cogs_other numeric DEFAULT 0,
  cogs_total numeric DEFAULT (((cogs_material + cogs_labor) + cogs_wip) + cogs_other),
  salary numeric DEFAULT 0,
  salary_ot numeric DEFAULT 0,
  fringe numeric DEFAULT 0,
  te numeric DEFAULT 0,
  printing numeric DEFAULT 0,
  distribution numeric DEFAULT 0,
  office_edp numeric DEFAULT 0,
  consulting numeric DEFAULT 0,
  building numeric DEFAULT 0,
  utilities numeric DEFAULT 0,
  rent numeric DEFAULT 0,
  opex_total numeric DEFAULT ((((((((((salary + salary_ot) + fringe) + te) + printing) + distribution) + office_edp) + consulting) + building) + utilities) + rent),
  capitalization numeric DEFAULT 0,
  inv_purchases numeric DEFAULT 0,
  inv_vendors jsonb DEFAULT '[]'::jsonb,
  upload_notes text,
  uploaded_at timestamp with time zone DEFAULT now(),
  CONSTRAINT financials_monthly_pkey PRIMARY KEY (id)
);

CREATE TABLE public.historical_summaries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_type text NOT NULL CHECK (period_type = ANY (ARRAY['weekly'::text, 'monthly'::text, 'quarterly'::text, 'yearly'::text])),
  period_start date NOT NULL,
  period_end date NOT NULL,
  period_label text NOT NULL,
  bny_yards_produced integer DEFAULT 0,
  passaic_yards_produced integer DEFAULT 0,
  total_yards_produced integer DEFAULT 0,
  total_color_yards integer DEFAULT 0,
  total_waste_yards integer DEFAULT 0,
  waste_pct numeric DEFAULT NULL::numeric,
  net_yards_produced integer DEFAULT 0,
  revenue numeric DEFAULT NULL::numeric,
  cost_per_yard numeric DEFAULT NULL::numeric,
  notes text,
  generated_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT historical_summaries_pkey PRIMARY KEY (id)
);

CREATE TABLE public.inv_cogs_summary (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  line_item text,
  month_label text,
  month_num integer,
  amount numeric,
  raw_row jsonb,
  CONSTRAINT inv_cogs_summary_pkey PRIMARY KEY (id),
  CONSTRAINT inv_cogs_summary_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.inv_ground_sold (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  raw_row jsonb,
  CONSTRAINT inv_ground_sold_pkey PRIMARY KEY (id),
  CONSTRAINT inv_ground_sold_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.inv_pos_shipped (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  raw_row jsonb,
  CONSTRAINT inv_pos_shipped_pkey PRIMARY KEY (id),
  CONSTRAINT inv_pos_shipped_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.inv_schu_on_hand (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  raw_row jsonb,
  CONSTRAINT inv_schu_on_hand_pkey PRIMARY KEY (id),
  CONSTRAINT inv_schu_on_hand_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.kpi_reactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  kpi_id text NOT NULL,
  author text NOT NULL,
  emoji text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT kpi_reactions_pkey PRIMARY KEY (id)
);

CREATE TABLE public.mng_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  monday_id bigint NOT NULL,
  board_id bigint NOT NULL,
  site text NOT NULL CHECK (site = ANY (ARRAY['passaic'::text, 'bny'::text])),
  group_label text,
  item_name text,
  status_timeline text,
  status_pipeline text,
  development_type text,
  approver text,
  waiting_on text,
  priority text,
  summary text,
  timeline_start date,
  timeline_end date,
  launch_date_text text,
  cfa_due date,
  customer text,
  product_type text,
  colorway text,
  ground text,
  sku_ref text,
  trials_due date,
  approval_date date,
  raw_columns jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mng_items_pkey PRIMARY KEY (id),
  CONSTRAINT mng_items_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.mng_snapshots(id)
);

CREATE TABLE public.mng_observations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  site text NOT NULL CHECK (site = ANY (ARRAY['passaic'::text, 'bny'::text])),
  observations_md text NOT NULL,
  generated_at timestamp with time zone NOT NULL DEFAULT now(),
  generated_by uuid,
  duration_ms integer,
  item_count integer,
  group_summary jsonb,
  model_used text,
  CONSTRAINT mng_observations_pkey PRIMARY KEY (id),
  CONSTRAINT mng_observations_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.mng_snapshots(id),
  CONSTRAINT mng_observations_generated_by_fkey FOREIGN KEY (generated_by) REFERENCES auth.users(id)
);

CREATE TABLE public.mng_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  refreshed_at timestamp with time zone NOT NULL DEFAULT now(),
  refreshed_by uuid,
  trigger text NOT NULL CHECK (trigger = ANY (ARRAY['manual'::text, 'auto'::text, 'scheduled'::text])),
  is_current boolean NOT NULL DEFAULT true,
  passaic_items integer,
  bny_items integer,
  total_items integer,
  duration_ms integer,
  warnings text,
  error_message text,
  CONSTRAINT mng_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT mng_snapshots_refreshed_by_fkey FOREIGN KEY (refreshed_by) REFERENCES auth.users(id)
);

CREATE TABLE public.monthly_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  month text NOT NULL,
  type text NOT NULL,
  report_title text,
  narrative text,
  generated_at timestamp with time zone DEFAULT now(),
  generated_by text,
  CONSTRAINT monthly_reports_pkey PRIMARY KEY (id)
);

CREATE TABLE public.mos_ground_est_ship (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  material text,
  est_ship_date date,
  qty_expected numeric,
  raw_row jsonb,
  CONSTRAINT mos_ground_est_ship_pkey PRIMARY KEY (id),
  CONSTRAINT mos_ground_est_ship_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.mos_inv_reconciliation (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  material text,
  on_hand_qty numeric,
  on_hand_lift_api numeric,
  qty_on_hand_vs_lift_api numeric,
  raw_row jsonb,
  CONSTRAINT mos_inv_reconciliation_pkey PRIMARY KEY (id),
  CONSTRAINT mos_inv_reconciliation_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.mos_material_color (
  id bigint NOT NULL DEFAULT nextval('mos_material_color_id_seq'::regclass),
  snapshot_id uuid NOT NULL,
  order_type text NOT NULL,
  replacement_ground text NOT NULL,
  po_open_qty numeric,
  min_due_date date,
  max_due_date date,
  countd_open_po_dates integer,
  on_hand_qty numeric,
  wip_ground numeric,
  wip_yards numeric,
  wip_total numeric,
  curr_available_no_ground numeric,
  curr_available_on_hand numeric,
  available_on_hand_with_open_pos numeric,
  ground_written_last_6_months numeric,
  avg_monthly_last_6_months numeric,
  avg_monthly_last_12_months numeric,
  avg_last_6_12_monthly_yards numeric,
  yards_written_last_30_days numeric,
  mos_based_on_6_12 numeric,
  calc_buy_yards_plus_2_months numeric,
  months_of_lead_time numeric,
  target_mos_plus_2 numeric,
  var_mos_vs_target_plus_2 numeric,
  raw_row jsonb,
  inserted_at timestamp with time zone DEFAULT now(),
  CONSTRAINT mos_material_color_pkey PRIMARY KEY (id),
  CONSTRAINT mos_material_color_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.mos_materials (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  order_type_screen text,
  replacement_ground text,
  po_open_qty numeric,
  min_due_date date,
  max_due_date date,
  countd_open_po_dates integer,
  on_hand_qty numeric,
  wip_ground numeric,
  wip_yards numeric,
  wip_total numeric,
  curr_available_no_ground numeric,
  curr_available_on_hand numeric,
  available_on_hand_with_open_pos numeric,
  ground_written_last_6_months numeric,
  avg_monthly_last_6_months numeric,
  avg_monthly_last_12_months numeric,
  avg_last_6_and_12_monthly_yards numeric,
  yards_written_last_30_days numeric,
  mos_based_on_last_6_and_12_month_sales numeric,
  calc_buy_in_yards_plus_2_months numeric,
  months_of_lead_time numeric,
  target_mos_plus_2_month numeric,
  var_mos_vs_target_plus_2 numeric,
  is_subtotal boolean DEFAULT false,
  raw_row jsonb,
  CONSTRAINT mos_materials_pkey PRIMARY KEY (id),
  CONSTRAINT mos_materials_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.mos_monthly_velocity (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  material text,
  year_month text,
  yards numeric,
  raw_row jsonb,
  CONSTRAINT mos_monthly_velocity_pkey PRIMARY KEY (id),
  CONSTRAINT mos_monthly_velocity_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.mos_open_pos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  material text,
  qty_open numeric,
  due_date date,
  raw_row jsonb,
  CONSTRAINT mos_open_pos_pkey PRIMARY KEY (id),
  CONSTRAINT mos_open_pos_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.mos_received (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  material text,
  qty_received numeric,
  date_received date,
  raw_row jsonb,
  CONSTRAINT mos_received_pkey PRIMARY KEY (id),
  CONSTRAINT mos_received_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.people_weekly (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL UNIQUE,
  bny_headcount integer,
  bny_total_hrs numeric,
  bny_reg_hrs numeric,
  bny_ot_hrs numeric,
  bny_pto_hrs numeric,
  bny_total_pay numeric,
  bny_bonus_total numeric,
  nj_headcount integer,
  nj_total_hrs numeric,
  nj_reg_hrs numeric,
  nj_ot_hrs numeric,
  nj_pto_hrs numeric,
  nj_total_pay numeric,
  nj_bonus_total numeric,
  employees jsonb,
  new_hires_bny integer DEFAULT 0,
  new_hires_nj integer DEFAULT 0,
  exits_bny integer DEFAULT 0,
  exits_nj integer DEFAULT 0,
  leaves jsonb,
  open_roles jsonb,
  hr_notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT people_weekly_pkey PRIMARY KEY (id)
);

CREATE TABLE public.production (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL UNIQUE,
  nj_data jsonb DEFAULT '{}'::jsonb,
  bny_data jsonb DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT production_pkey PRIMARY KEY (id)
);

CREATE TABLE public.profiles (
  id uuid NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL DEFAULT 'viewer'::text CHECK (role = ANY (ARRAY['admin'::text, 'manager'::text, 'qa'::text, 'exec'::text])),
  created_at timestamp with time zone DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id)
);

CREATE TABLE public.sched_assignments (
  id bigint NOT NULL DEFAULT nextval('sched_assignments_id_seq'::regclass),
  site text NOT NULL CHECK (site = ANY (ARRAY['passaic'::text, 'bny'::text, 'procurement'::text])),
  po_number text NOT NULL,
  line_description text,
  product_type text,
  table_code text,
  week_start date NOT NULL,
  day_of_week text CHECK (day_of_week IS NULL OR (day_of_week = ANY (ARRAY['Sun'::text, 'Mon'::text, 'Tue'::text, 'Wed'::text, 'Thu'::text, 'Fri'::text, 'Sat'::text]))),
  planned_yards numeric,
  planned_cy numeric,
  assigned_by text,
  assigned_at timestamp with time zone DEFAULT now(),
  notes text,
  status text DEFAULT 'planned'::text CHECK (status = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'slipped'::text, 'cancelled'::text])),
  updated_at timestamp with time zone DEFAULT now(),
  operator text,
  shift text NOT NULL DEFAULT '1st'::text CHECK (shift = ANY (ARRAY['1st'::text, '2nd'::text])),
  CONSTRAINT sched_assignments_pkey PRIMARY KEY (id)
);

CREATE TABLE public.sched_daily_ops (
  id bigint NOT NULL DEFAULT nextval('sched_daily_ops_id_seq'::regclass),
  site text NOT NULL CHECK (site = ANY (ARRAY['passaic'::text, 'bny'::text])),
  week_start date NOT NULL,
  table_code text NOT NULL,
  day_of_week text NOT NULL CHECK (day_of_week = ANY (ARRAY['Sun'::text, 'Mon'::text, 'Tue'::text, 'Wed'::text, 'Thu'::text, 'Fri'::text, 'Sat'::text])),
  operator_1 text,
  operator_2 text,
  actual_yards integer,
  waste_yards integer,
  notes text,
  recorded_by text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  planned_yards integer,
  note_assigned_to text,
  note_status text,
  shift text NOT NULL CHECK (shift = ANY (ARRAY['1st'::text, '2nd'::text])),
  CONSTRAINT sched_daily_ops_pkey PRIMARY KEY (id)
);

CREATE TABLE public.sched_snapshots (
  id bigint NOT NULL DEFAULT nextval('sched_snapshots_id_seq'::regclass),
  uploaded_at timestamp with time zone NOT NULL DEFAULT now(),
  uploaded_by text,
  source_filename text,
  passaic_orders integer DEFAULT 0,
  passaic_yards numeric DEFAULT 0,
  passaic_revenue numeric DEFAULT 0,
  bny_orders integer DEFAULT 0,
  bny_yards numeric DEFAULT 0,
  bny_revenue numeric DEFAULT 0,
  procurement_orders integer DEFAULT 0,
  procurement_revenue numeric DEFAULT 0,
  total_rows integer DEFAULT 0,
  unclassified_rows integer DEFAULT 0,
  parse_notes text,
  CONSTRAINT sched_snapshots_pkey PRIMARY KEY (id)
);

CREATE TABLE public.sched_wip_rows (
  id bigint NOT NULL DEFAULT nextval('sched_wip_rows_id_seq'::regclass),
  snapshot_id bigint NOT NULL,
  site text NOT NULL CHECK (site = ANY (ARRAY['passaic'::text, 'bny'::text, 'procurement'::text, 'unknown'::text])),
  division_raw text,
  customer_type text,
  product_type text,
  is_new_goods boolean DEFAULT false,
  order_number text,
  po_number text,
  line_description text,
  item_sku text,
  color text,
  material text,
  order_status text,
  colors_count integer,
  color_yards numeric,
  order_created date,
  yards_written numeric DEFAULT 0,
  qty_invoiced numeric DEFAULT 0,
  income_written numeric DEFAULT 0,
  age_days integer,
  age_bucket text,
  created_at timestamp with time zone DEFAULT now(),
  category_customer_mto text,
  customer_name_clean text,
  bny_bucket text,
  CONSTRAINT sched_wip_rows_pkey PRIMARY KEY (id),
  CONSTRAINT sched_wip_rows_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.sched_snapshots(id)
);

CREATE TABLE public.section_comments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  section text NOT NULL,
  section_label text DEFAULT ''::text,
  author text NOT NULL,
  text text NOT NULL,
  notify_names ARRAY DEFAULT '{}'::text[],
  created_at timestamp with time zone DEFAULT now(),
  status text DEFAULT 'sent'::text,
  parent_id uuid,
  slack_ts text,
  slack_message_ts text,
  CONSTRAINT section_comments_pkey PRIMARY KEY (id),
  CONSTRAINT section_comments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.section_comments(id)
);

CREATE TABLE public.weeks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL UNIQUE,
  days jsonb DEFAULT '{}'::jsonb,
  kpis jsonb DEFAULT '{}'::jsonb,
  concerns text DEFAULT ''::text,
  updated_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  narrative text,
  executive_narrative text,
  CONSTRAINT weeks_pkey PRIMARY KEY (id)
);

CREATE TABLE public.wip_color_yards (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  year_445 integer,
  month_label text,
  month_num integer,
  weeks integer,
  product_type text,
  number_of_colors integer,
  yards_produced numeric,
  color_x_yards_produced numeric,
  ratio_yards_produced_to_color_yards numeric,
  net_yards_invoiced numeric,
  count_of_single_orders integer,
  is_subtotal boolean DEFAULT false,
  raw_row jsonb,
  CONSTRAINT wip_color_yards_pkey PRIMARY KEY (id),
  CONSTRAINT wip_color_yards_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.wip_monthly_pacing (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  division text,
  month_label text,
  month_num integer,
  yards_produced numeric,
  income_produced numeric,
  gross_yards_invoiced numeric,
  yards_credited numeric,
  income_credited numeric,
  net_yards_invoiced numeric,
  yards_planned numeric,
  yards_planned_vs_produced numeric,
  pct_yards_produced_vs_plan numeric,
  income_planned numeric,
  net_income_invoiced numeric,
  is_subtotal boolean DEFAULT false,
  raw_row jsonb,
  CONSTRAINT wip_monthly_pacing_pkey PRIMARY KEY (id),
  CONSTRAINT wip_monthly_pacing_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.wip_production_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  division text,
  category_customer_mto text,
  customer_name text,
  third_party_vs_house text,
  product_type text,
  new_goods text,
  order_number text,
  po_number text,
  yards_ordered numeric,
  yards_written numeric,
  yard_order_status text,
  date_entered date,
  date_promised date,
  raw_row jsonb,
  CONSTRAINT wip_production_lines_pkey PRIMARY KEY (id),
  CONSTRAINT wip_production_lines_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.wip_rollup_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  division text,
  third_party_vs_house text,
  yard_order_status text,
  num_orders integer,
  yards_written integer,
  total_yards_held_to_invoice integer,
  income_written numeric,
  is_subtotal boolean DEFAULT false,
  raw_row jsonb,
  CONSTRAINT wip_rollup_lines_pkey PRIMARY KEY (id),
  CONSTRAINT wip_rollup_lines_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);

CREATE TABLE public.wip_written_invoiced (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  division text,
  week_start date,
  metric_name text,
  metric_value numeric,
  raw_row jsonb,
  CONSTRAINT wip_written_invoiced_pkey PRIMARY KEY (id),
  CONSTRAINT wip_written_invoiced_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.data_snapshots(id)
);


-- ============================================================
-- 2. VIEWS
-- ============================================================

-- VIEW: sched_current_wip
CREATE OR REPLACE VIEW public.sched_current_wip AS
 SELECT id,
    snapshot_id,
    site,
    division_raw,
    customer_type,
    product_type,
    is_new_goods,
    order_number,
    po_number,
    line_description,
    item_sku,
    color,
    material,
    order_status,
    colors_count,
    color_yards,
    order_created,
    yards_written,
    qty_invoiced,
    income_written,
    age_days,
    age_bucket,
    created_at
   FROM sched_wip_rows w
  WHERE (snapshot_id = ( SELECT sched_snapshots.id
           FROM sched_snapshots
          ORDER BY sched_snapshots.uploaded_at DESC
         LIMIT 1));

-- VIEW: v_current_mng_items
CREATE OR REPLACE VIEW public.v_current_mng_items AS
 SELECT i.id,
    i.snapshot_id,
    i.monday_id,
    i.board_id,
    i.site,
    i.group_label,
    i.item_name,
    i.status_timeline,
    i.status_pipeline,
    i.development_type,
    i.approver,
    i.waiting_on,
    i.priority,
    i.summary,
    i.timeline_start,
    i.timeline_end,
    i.launch_date_text,
    i.cfa_due,
    i.customer,
    i.product_type,
    i.colorway,
    i.ground,
    i.sku_ref,
    i.trials_due,
    i.approval_date,
    i.raw_columns
   FROM (mng_items i
     JOIN mng_snapshots s ON ((s.id = i.snapshot_id)))
  WHERE (s.is_current = true);

-- VIEW: v_current_monthly_pacing
CREATE OR REPLACE VIEW public.v_current_monthly_pacing AS
 SELECT p.id,
    p.snapshot_id,
    p.division,
    p.month_label,
    p.month_num,
    p.yards_produced,
    p.income_produced,
    p.gross_yards_invoiced,
    p.yards_credited,
    p.income_credited,
    p.net_yards_invoiced,
    p.yards_planned,
    p.yards_planned_vs_produced,
    p.pct_yards_produced_vs_plan,
    p.income_planned,
    p.net_income_invoiced,
    p.is_subtotal,
    p.raw_row
   FROM (wip_monthly_pacing p
     JOIN data_snapshots s ON ((s.id = p.snapshot_id)))
  WHERE ((s.file_kind = 'wip'::text) AND (s.is_current = true));

-- VIEW: v_current_mos_material_color
CREATE OR REPLACE VIEW public.v_current_mos_material_color AS
 SELECT m.id,
    m.snapshot_id,
    m.order_type,
    m.replacement_ground,
    m.po_open_qty,
    m.min_due_date,
    m.max_due_date,
    m.countd_open_po_dates,
    m.on_hand_qty,
    m.wip_ground,
    m.wip_yards,
    m.wip_total,
    m.curr_available_no_ground,
    m.curr_available_on_hand,
    m.available_on_hand_with_open_pos,
    m.ground_written_last_6_months,
    m.avg_monthly_last_6_months,
    m.avg_monthly_last_12_months,
    m.avg_last_6_12_monthly_yards,
    m.yards_written_last_30_days,
    m.mos_based_on_6_12,
    m.calc_buy_yards_plus_2_months,
    m.months_of_lead_time,
    m.target_mos_plus_2,
    m.var_mos_vs_target_plus_2,
    m.raw_row,
    m.inserted_at,
    s.uploaded_at AS snapshot_uploaded_at,
    s.uploaded_by_email AS snapshot_uploaded_by,
    s.file_kind AS snapshot_file_kind,
    s.source_file AS snapshot_source_file
   FROM (mos_material_color m
     JOIN data_snapshots s ON ((s.id = m.snapshot_id)))
  WHERE (s.is_current = true);

-- VIEW: v_current_mos_materials
CREATE OR REPLACE VIEW public.v_current_mos_materials AS
 SELECT m.id,
    m.snapshot_id,
    m.order_type_screen,
    m.replacement_ground,
    m.po_open_qty,
    m.min_due_date,
    m.max_due_date,
    m.countd_open_po_dates,
    m.on_hand_qty,
    m.wip_ground,
    m.wip_yards,
    m.wip_total,
    m.curr_available_no_ground,
    m.curr_available_on_hand,
    m.available_on_hand_with_open_pos,
    m.ground_written_last_6_months,
    m.avg_monthly_last_6_months,
    m.avg_monthly_last_12_months,
    m.avg_last_6_and_12_monthly_yards,
    m.yards_written_last_30_days,
    m.mos_based_on_last_6_and_12_month_sales,
    m.calc_buy_in_yards_plus_2_months,
    m.months_of_lead_time,
    m.target_mos_plus_2_month,
    m.var_mos_vs_target_plus_2,
    m.is_subtotal,
    m.raw_row
   FROM (mos_materials m
     JOIN data_snapshots s ON ((s.id = m.snapshot_id)))
  WHERE ((s.file_kind = 'mos'::text) AND (s.is_current = true));

-- VIEW: v_current_wip_rollup
CREATE OR REPLACE VIEW public.v_current_wip_rollup AS
 SELECT r.id,
    r.snapshot_id,
    r.division,
    r.third_party_vs_house,
    r.yard_order_status,
    r.num_orders,
    r.yards_written,
    r.total_yards_held_to_invoice,
    r.income_written,
    r.is_subtotal,
    r.raw_row
   FROM (wip_rollup_lines r
     JOIN data_snapshots s ON ((s.id = r.snapshot_id)))
  WHERE ((s.file_kind = 'wip'::text) AND (s.is_current = true));

-- VIEW: v_inventory_bucket_history
CREATE OR REPLACE VIEW public.v_inventory_bucket_history AS
 SELECT s.id AS snapshot_id,
    s.uploaded_at,
    date_trunc('month'::text, s.uploaded_at) AS snapshot_month,
    m.order_type,
    count(*) AS sku_count,
    sum(COALESCE(m.on_hand_qty, (0)::numeric)) AS total_on_hand_yards,
    sum(COALESCE(m.wip_total, (0)::numeric)) AS total_wip_yards,
    sum(
        CASE
            WHEN (m.var_mos_vs_target_plus_2 < (0)::numeric) THEN 1
            ELSE 0
        END) AS short_of_target_count,
    sum(
        CASE
            WHEN (m.available_on_hand_with_open_pos < (0)::numeric) THEN 1
            ELSE 0
        END) AS oversold_count,
    sum(
        CASE
            WHEN (m.calc_buy_yards_plus_2_months > (0)::numeric) THEN m.calc_buy_yards_plus_2_months
            ELSE (0)::numeric
        END) AS total_buy_recommendation_yards
   FROM (mos_material_color m
     JOIN data_snapshots s ON ((s.id = m.snapshot_id)))
  GROUP BY s.id, s.uploaded_at, m.order_type
  ORDER BY s.uploaded_at DESC, m.order_type;

-- VIEW: v_latest_snapshots
CREATE OR REPLACE VIEW public.v_latest_snapshots AS
 SELECT file_kind,
    id AS snapshot_id,
    uploaded_at,
    uploaded_by_email,
    source,
    status,
    source_file,
    sheets_parsed,
    errors,
    parse_duration_ms
   FROM data_snapshots
  WHERE (is_current = true);


-- ============================================================
-- 3. RLS POLICIES
-- ============================================================
-- Format: POLICY <name> | cmd=<command> | permissive=<P/R> | roles=<roles> | qual=<USING clause> | with_check=<CHECK clause>
--
-- Tables WITH at least one RLS policy:
--   comments, correspondence, dashboard_narratives, financials_monthly, kpi_reactions,
--   mng_items, mng_observations, mng_snapshots, mos_material_color, people_weekly,
--   production, profiles, sched_assignments, sched_daily_ops, sched_wip_rows,
--   section_comments, weeks
--
-- Tables WITHOUT any RLS policy (likely RLS disabled — anon key has full access):
--   ai_call_log, business_facts, data_snapshots, data_source_config,
--   financial_ap, financial_ar, financial_cash, historical_summaries,
--   inv_cogs_summary, inv_ground_sold, inv_pos_shipped, inv_schu_on_hand,
--   monthly_reports, mos_ground_est_ship, mos_inv_reconciliation, mos_materials,
--   mos_monthly_velocity, mos_open_pos, mos_received, sched_snapshots,
--   wip_color_yards, wip_monthly_pacing, wip_production_lines,
--   wip_rollup_lines, wip_written_invoiced

-- TABLE: public.comments
POLICY Public insert comments | cmd=INSERT | permissive=PERMISSIVE | roles=public | qual=true | with_check=true
POLICY Public read comments | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=true

-- TABLE: public.correspondence
POLICY Public delete correspondence | cmd=DELETE | permissive=PERMISSIVE | roles=public | qual=true
POLICY Public insert correspondence | cmd=INSERT | permissive=PERMISSIVE | roles=public | qual=true | with_check=true
POLICY Public read correspondence | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=true

-- TABLE: public.dashboard_narratives
POLICY auth full access dashboard_narratives | cmd=ALL | permissive=PERMISSIVE | roles=authenticated | qual=true | with_check=true

-- TABLE: public.financials_monthly
POLICY Anon write financials | cmd=ALL | permissive=PERMISSIVE | roles=public | qual=true | with_check=true
POLICY Public read financials | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=true

-- TABLE: public.kpi_reactions
POLICY Public delete kpi_reactions | cmd=DELETE | permissive=PERMISSIVE | roles=public | qual=true
POLICY Public insert kpi_reactions | cmd=INSERT | permissive=PERMISSIVE | roles=public | qual=true | with_check=true
POLICY Public read kpi_reactions | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=true

-- TABLE: public.mng_items
POLICY mng_items_read | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=(auth.role() = 'authenticated'::text)

-- TABLE: public.mng_observations
POLICY mng_observations_read | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=(auth.role() = 'authenticated'::text)

-- TABLE: public.mng_snapshots
POLICY mng_snapshots_read | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=(auth.role() = 'authenticated'::text)

-- TABLE: public.mos_material_color
POLICY mos_mc_authenticated_all | cmd=ALL | permissive=PERMISSIVE | roles=authenticated | qual=true | with_check=true

-- TABLE: public.people_weekly
POLICY Admin can insert people_weekly | cmd=INSERT | permissive=PERMISSIVE | roles=authenticated | qual=true | with_check=(EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))
POLICY Admin can update people_weekly | cmd=UPDATE | permissive=PERMISSIVE | roles=authenticated | qual=(EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))
POLICY Authenticated users can read people_weekly | cmd=SELECT | permissive=PERMISSIVE | roles=authenticated | qual=true

-- TABLE: public.production
POLICY Public insert production | cmd=INSERT | permissive=PERMISSIVE | roles=public | qual=true | with_check=true
POLICY Public read production | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=true
POLICY Public update production | cmd=UPDATE | permissive=PERMISSIVE | roles=public | qual=true

-- TABLE: public.profiles
POLICY Public read profiles | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=true
POLICY Users can update own profile | cmd=UPDATE | permissive=PERMISSIVE | roles=public | qual=(auth.uid() = id)

-- TABLE: public.sched_assignments
POLICY auth full access sched_assignments | cmd=ALL | permissive=PERMISSIVE | roles=authenticated | qual=true | with_check=true

-- TABLE: public.sched_daily_ops
POLICY auth full access sched_daily_ops | cmd=ALL | permissive=PERMISSIVE | roles=authenticated | qual=true | with_check=true

-- TABLE: public.sched_wip_rows
POLICY auth full access sched_wip_rows | cmd=ALL | permissive=PERMISSIVE | roles=authenticated | qual=true | with_check=true

-- TABLE: public.section_comments
POLICY Public delete section_comments | cmd=DELETE | permissive=PERMISSIVE | roles=public | qual=true
POLICY Public insert section_comments | cmd=INSERT | permissive=PERMISSIVE | roles=public | qual=true | with_check=true
POLICY Public read section_comments | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=true
POLICY Public update section_comments | cmd=UPDATE | permissive=PERMISSIVE | roles=public | qual=true | with_check=true

-- TABLE: public.weeks
POLICY Public insert weeks | cmd=INSERT | permissive=PERMISSIVE | roles=public | qual=true | with_check=true
POLICY Public read weeks | cmd=SELECT | permissive=PERMISSIVE | roles=public | qual=true
POLICY Public update weeks | cmd=UPDATE | permissive=PERMISSIVE | roles=public | qual=true


-- ============================================================
-- 4. TRIGGERS
-- ============================================================
-- Function bodies were not extracted in this export; function names are listed
-- and can be queried separately via pg_get_functiondef() if Phase 2 needs them.

-- TRIGGER: data_snapshots.trg_data_snapshots_single_current
-- Timing: AFTER INSERT, AFTER UPDATE
-- Function: enforce_single_current_snapshot()
-- Purpose: enforce the "only one is_current=true per file_kind" invariant
--          for the data_snapshots versioning machinery (used by persistSnapshot.js)

-- TRIGGER: mng_snapshots.mng_snapshot_set_current_trg
-- Timing: AFTER INSERT
-- Function: mng_snapshot_set_current()
-- Purpose: same is_current-flip pattern for Monday New Goods snapshots

-- TRIGGER: sched_assignments.trg_sched_assignments_updated
-- Timing: BEFORE UPDATE
-- Function: sched_touch_updated_at()
-- Purpose: standard updated_at touch on row update


-- ============================================================
-- END OF SCHEMA EXPORT
-- ============================================================
