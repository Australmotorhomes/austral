-- =====================================================================
-- Stage 1: Quote sharing (customer link, view tracking, acceptance)
-- Run once in the Supabase SQL editor (project dpapwmittcowsrwwsajo).
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE.
-- =====================================================================

-- One row per quote VERSION that has been sent to a customer.
-- Re-sending an edited quote creates a new row (version + 1); older rows are
-- kept (status = 'superseded') so you can compare what each version said.
create table if not exists public.quote_shares (
  id                  uuid primary key default gen_random_uuid(),
  token               text not null unique,          -- unguessable, goes in the customer URL
  quote_id            text not null,                 -- text so it works whatever type quotes.id is
  quote_number        text,
  version             int  not null default 1,
  status              text not null default 'active'
                        check (status in ('active', 'superseded', 'revoked')),
  brand               text,                          -- 'austral' | 'platinum' (optional)
  recipient_name      text,
  recipient_email     text,
  total               numeric,
  snapshot_html       text not null,                 -- frozen copy of the quote as sent
  sent_at             timestamptz not null default now(),
  expires_at          timestamptz not null,          -- sent_at + 14 days (set by the API)
  first_viewed_at     timestamptz,
  last_viewed_at      timestamptz,
  view_count          int  not null default 0,
  accepted_at         timestamptz,
  accepted_name       text,                          -- name the customer typed
  accepted_ip         text,
  accepted_user_agent text,
  accepted_terms_text text,                          -- exact wording of the tick-box they agreed to
  created_by          text,                          -- staff member's email
  unique (quote_id, version)
);

create index if not exists quote_shares_quote_id_idx   on public.quote_shares (quote_id);
create index if not exists quote_shares_last_viewed_idx on public.quote_shares (last_viewed_at desc);

-- One row per counted view (audit trail; IP is stored hashed, not raw).
create table if not exists public.quote_share_views (
  id          uuid primary key default gen_random_uuid(),
  share_id    uuid not null references public.quote_shares(id) on delete cascade,
  viewed_at   timestamptz not null default now(),
  ip_hash     text,
  user_agent  text
);

create index if not exists quote_share_views_share_idx on public.quote_share_views (share_id, viewed_at desc);

-- ---------------------------------------------------------------------
-- Row-level security
-- Customers never touch these tables directly. Only the Vercel API
-- (using the secret/service key, which bypasses RLS) writes to them.
-- Logged-in staff can READ them (for the "Sent quotes" screen in Stage 4).
-- There are deliberately NO anon policies and NO insert/update/delete
-- policies for authenticated users.
-- ---------------------------------------------------------------------
alter table public.quote_shares      enable row level security;
alter table public.quote_share_views enable row level security;

drop policy if exists "staff read quote_shares" on public.quote_shares;
create policy "staff read quote_shares"
  on public.quote_shares for select to authenticated using (true);

drop policy if exists "staff read quote_share_views" on public.quote_share_views;
create policy "staff read quote_share_views"
  on public.quote_share_views for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- record_quote_view(): atomically counts a view.
--  * ignores revoked links, and expired links that were never accepted
--  * ignores a repeat view from the same (hashed) IP within 60 seconds
-- Returns JSON: { recorded: bool, first_view: bool, view_count: int }
-- Callable only by the service role (i.e. our API), not by the public.
-- ---------------------------------------------------------------------
create or replace function public.record_quote_view(
  p_token text, p_ip_hash text, p_user_agent text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s        public.quote_shares%rowtype;
  v_recent boolean;
begin
  select * into s from public.quote_shares where token = p_token for update;
  if not found then
    return jsonb_build_object('recorded', false, 'first_view', false, 'view_count', 0);
  end if;

  if s.status = 'revoked' or (s.expires_at < now() and s.accepted_at is null) then
    return jsonb_build_object('recorded', false, 'first_view', false, 'view_count', s.view_count);
  end if;

  select exists (
    select 1 from public.quote_share_views v
    where v.share_id = s.id and v.ip_hash = p_ip_hash
      and v.viewed_at > now() - interval '60 seconds'
  ) into v_recent;

  if v_recent then
    return jsonb_build_object('recorded', false, 'first_view', false, 'view_count', s.view_count);
  end if;

  insert into public.quote_share_views (share_id, ip_hash, user_agent)
  values (s.id, p_ip_hash, left(coalesce(p_user_agent, ''), 300));

  update public.quote_shares
     set view_count      = view_count + 1,
         last_viewed_at  = now(),
         first_viewed_at = coalesce(first_viewed_at, now())
   where id = s.id;

  return jsonb_build_object(
    'recorded', true,
    'first_view', s.first_viewed_at is null,
    'view_count', s.view_count + 1
  );
end;
$$;

revoke all on function public.record_quote_view(text, text, text) from public, anon, authenticated;
grant execute on function public.record_quote_view(text, text, text) to service_role;
