-- Run once in the Supabase SQL editor (project dpapwmittcowsrwwsajo).
-- Adds shipment-tracking fields to purchase_orders.
alter table purchase_orders
  add column if not exists shipping_line         text,         -- SCAC code, e.g. MAEU (or blank to auto-detect)
  add column if not exists bill_of_lading        text,
  add column if not exists container_number      text,
  add column if not exists live_eta              date,         -- written ONLY by the server (cron / refresh button)
  add column if not exists live_eta_source       text,         -- 'predictive' (DataLoop estimate) or 'carrier'
  add column if not exists tracking_updated_at   timestamptz,
  add column if not exists tracking_status       text,         -- 'ok' | 'error' | 'no_eta'
  add column if not exists tracking_error        text,
  add column if not exists tracking_raw          jsonb;        -- last DataLoop response, kept so field mapping can be checked

-- Ask PostgREST to reload its schema cache so the new columns are visible immediately.
notify pgrst, 'reload schema';
