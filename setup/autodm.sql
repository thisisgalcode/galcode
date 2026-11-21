-- galcode auto DM: per-reel rules and presets
-- Run once in Supabase -> SQL Editor.

create table if not exists public.autodm_rules (
  account      text not null,                 -- Instagram account ID
  media_id     text not null,                 -- reel / post ID
  enabled      boolean not null default false,
  trigger      text not null default 'all' check (trigger in ('all', 'keywords')),
  keywords     text[] not null default '{}',
  reply        text not null default '',
  dm           text not null default '',
  button_text  text not null default '',
  button_link  text not null default '',
  caption      text,
  thumb        text,
  permalink    text,
  updated_at   timestamptz not null default now(),
  primary key (account, media_id)
);

create table if not exists public.autodm_presets (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  trigger      text not null default 'all' check (trigger in ('all', 'keywords')),
  keywords     text[] not null default '{}',
  reply        text not null default '',
  dm           text not null default '',
  button_text  text not null default '',
  button_link  text not null default '',
  created_at   timestamptz not null default now()
);

grant select, insert, update, delete on public.autodm_rules   to authenticated;
grant select, insert, update, delete on public.autodm_presets to authenticated;

alter table public.autodm_rules   enable row level security;
alter table public.autodm_presets enable row level security;

drop policy if exists "admins manage autodm rules" on public.autodm_rules;
create policy "admins manage autodm rules" on public.autodm_rules
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins manage autodm presets" on public.autodm_presets;
create policy "admins manage autodm presets" on public.autodm_presets
  for all using (public.is_admin()) with check (public.is_admin());

-- The bot reads ONE reel's rule through this function (only the fields it needs).
create or replace function public.autodm_rule(p_account text, p_media text)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select row_to_json(r) from (
    select enabled, trigger, keywords, reply, dm, button_text, button_link
    from public.autodm_rules
    where account = p_account and media_id = p_media
  ) r;
$$;

revoke all on function public.autodm_rule(text, text) from public;
grant execute on function public.autodm_rule(text, text) to anon, authenticated;

-- Starter preset: today's galcode message
insert into public.autodm_presets (name, trigger, reply, dm, button_text, button_link)
select 'galcode default', 'all',
       'Check ur dms for more details!',
       E'galcode is a girls-only community based in Chennai, built by a girl''s girl.\nTo join our exclusive girls only events, Click the button below⬇️',
       'Girls Only Events',
       'https://galcode.vercel.app/'
where not exists (select 1 from public.autodm_presets where name = 'galcode default');
