-- galcode day-before reminder emails.
-- Run once in Supabase -> SQL Editor. Adds a "sent" marker so nobody gets the reminder twice.

alter table public.bookings  add column if not exists reminder_sent_at timestamptz;
alter table public.cf_orders add column if not exists reminder_sent_at timestamptz;
