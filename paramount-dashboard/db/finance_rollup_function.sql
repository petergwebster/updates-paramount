-- Server-side financial rollup: returns per-(scope/category/BU) sums so the client
-- never paginates raw transactions. Kills truncation + page-skew bugs permanently.
-- Week-aware: MTD = selected month capped at p_week; YTD = prior months full + current capped.

create or replace function public.finance_rollup(
  p_month text,   -- e.g. '2026-06'
  p_week  int     -- week-in-month cap (1..5); use 99 for full month
)
returns table (
  scope         text,   -- 'MTD' or 'YTD'
  category      text,
  business_unit text,
  net           numeric
)
language sql
stable
as $$
  -- MTD: just the selected month, capped at the selected week
  select 'MTD'::text as scope, t.category, t.business_unit, sum(t.net) as net
  from financial_transactions t
  where t.fiscal_month = p_month
    and coalesce(t.fiscal_week, 0) <= p_week
  group by t.category, t.business_unit

  union all

  -- YTD: every prior month in the same fiscal year IN FULL,
  --      plus the selected month capped at the selected week
  select 'YTD'::text as scope, t.category, t.business_unit, sum(t.net) as net
  from financial_transactions t
  where t.fiscal_year = left(p_month, 4)
    and (
      t.fiscal_month < p_month
      or (t.fiscal_month = p_month and coalesce(t.fiscal_week, 0) <= p_week)
    )
  group by t.category, t.business_unit;
$$;

-- Allow the app's anon/auth roles to call it
grant execute on function public.finance_rollup(text, int) to anon, authenticated;
