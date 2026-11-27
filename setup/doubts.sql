-- galcode doubts: questions sent from the website chat ("I have another doubt")
-- Run once in Supabase -> SQL Editor.

create table if not exists public.doubts (
  id          uuid primary key default gen_random_uuid(),
  event_id    text,
  name        text not null,
  phone       text not null,
  email       text not null,
  question    text not null,
  answer      text not null default '',
  status      text not null default 'new' check (status in ('new', 'replied')),
  created_at  timestamptz not null default now(),
  replied_at  timestamptz
);

create index if not exists doubts_created_idx on public.doubts (created_at desc);

grant select, update, delete on public.doubts to authenticated;

alter table public.doubts enable row level security;

drop policy if exists "admins manage doubts" on public.doubts;
create policy "admins manage doubts" on public.doubts
  for all using (public.is_admin()) with check (public.is_admin());

-- Visitors send a doubt through this function only (they can't read anyone's doubts).
create or replace function public.ask_doubt(p_event text, p_name text, p_phone text, p_email text, p_question text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  p_name := trim(coalesce(p_name, ''));
  p_email := trim(coalesce(p_email, ''));
  p_question := trim(coalesce(p_question, ''));
  if length(p_name) < 2 or length(p_name) > 80 then raise exception 'invalid name'; end if;
  if coalesce(p_phone, '') !~ '^\+91[6-9][0-9]{9}$' then raise exception 'invalid phone'; end if;
  if p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(p_email) > 120 then raise exception 'invalid email'; end if;
  if length(p_question) < 3 or length(p_question) > 1000 then raise exception 'invalid question'; end if;
  -- simple spam guard: at most 5 doubts per number per hour
  if (select count(*) from public.doubts where phone = p_phone and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too many doubts';
  end if;
  insert into public.doubts (event_id, name, phone, email, question)
  values (nullif(left(coalesce(p_event, ''), 64), ''), p_name, p_phone, p_email, p_question);
end;
$$;

revoke all on function public.ask_doubt(text, text, text, text, text) from public;
grant execute on function public.ask_doubt(text, text, text, text, text) to anon, authenticated;
