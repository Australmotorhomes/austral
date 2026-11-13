-- =====================================================================
-- Stage 2: remember the payment-instalment choice on each quote
-- Run once in the Supabase SQL editor, BEFORE deploying the Stage 2 App.jsx.
-- Safe to re-run. Contains no DROP, DELETE or TRUNCATE statements.
-- 'special' = made to order (33% / 33% / 34%)   'stock' = in stock (50% / 50%)
-- =====================================================================
alter table public.quotes add column if not exists order_type text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_order_type_check') then
    alter table public.quotes
      add constraint quotes_order_type_check
      check (order_type is null or order_type in ('special', 'stock'));
  end if;
end
$$;
