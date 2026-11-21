-- galcode Cashfree checkout: one row per payment attempt.
-- Run once in Supabase -> SQL Editor. Only the server (service key) writes here;
-- signed-in galcode admins can read it.

create table if not exists public.cf_orders (
  order_id          text primary key,
  event_id          uuid,
  event_slug        text not null,
  event_title       text not null default '',
  event_date_label  text not null default '',
  event_time        text not null default '',
  event_venue       text not null default '',
  name              text not null,
  phone             text not null,
  email             text not null,
  age               int,
  amount            numeric(10,2) not null,
  status            text not null default 'created' check (status in ('created','paid','failed')),
  mode              text not null default 'sandbox',
  ticket_code       text unique,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);

create index if not exists cf_orders_event_idx on public.cf_orders (event_slug, status);

alter table public.cf_orders enable row level security;

grant select on public.cf_orders to authenticated;
grant select, insert, update on public.cf_orders to service_role;

drop policy if exists "admins read payments" on public.cf_orders;
create policy "admins read payments" on public.cf_orders
  for select using (public.is_admin());
