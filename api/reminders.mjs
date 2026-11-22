// GET /api/reminders  ← Vercel cron, every day at 6:00 pm IST (see vercel.json)
// Emails everyone booked for tomorrow's events: the "friendly checklist" reminder.
//
//   ?preview=1                  show the email for the next event in the browser (nothing sent)
//   ?date=2026-11-29            run for a specific event date instead of tomorrow
//   ?dry=1                      list who would get it, send nothing
// Every call needs  Authorization: Bearer <CRON_SECRET>  or  ?key=<CRON_SECRET>.
import { sb, json } from "./_cf.mjs";
import { mailConfigured, sendMail, reminderEmail } from "./_mail.mjs";

const IST = "Asia/Kolkata";
const istDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const tomorrowIST = (now = new Date()) => istDate(new Date(now.getTime() + 24 * 3600 * 1000));

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

// One person per event per email address; a paid Cashfree ticket wins over a plain booking.
export function recipients(bookings, orders) {
  const out = new Map();
  for (const o of orders) {
    if (!validEmail(o.email)) continue;
    const k = o.event_id + "|" + o.email.trim().toLowerCase();
    out.set(k, { kind: "order", id: o.order_id, event_id: o.event_id, name: o.name, email: o.email.trim(), ticket: o.ticket_code, sent: !!o.reminder_sent_at });
  }
  for (const b of bookings) {
    if (!validEmail(b.email) || (b.status || "complete") !== "complete") continue;
    const k = b.event_id + "|" + b.email.trim().toLowerCase();
    const prev = out.get(k);
    if (prev) { prev.sent = prev.sent || !!b.reminder_sent_at; prev.alsoBooking = b.id; continue; }
    out.set(k, { kind: "booking", id: b.id, event_id: b.event_id, name: b.name, email: b.email.trim(), ticket: null, sent: !!b.reminder_sent_at });
  }
  return [...out.values()];
}

async function markSent(r) {
  const at = JSON.stringify({ reminder_sent_at: new Date().toISOString() });
  if (r.kind === "order") await sb("cf_orders?order_id=eq." + encodeURIComponent(r.id), { method: "PATCH", body: at });
  const bid = r.kind === "booking" ? r.id : r.alsoBooking;
  if (bid) await sb("bookings?id=eq." + encodeURIComponent(bid), { method: "PATCH", body: at });
}

export async function GET(request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("key") || "";
  if (!secret || given !== secret) return json({ error: "Not allowed" }, 401);
  if (!process.env.SUPABASE_SERVICE_KEY) return json({ error: "SUPABASE_SERVICE_KEY is missing" }, 503);

  if (url.searchParams.get("preview")) {
    const ev = await sb("events?select=*&status=neq.draft&event_date=gte." + istDate(new Date()) + "&order=event_date&limit=1");
    const e = (ev.body && ev.body[0]) || { title: "Sunset Picnic", title_em: "Club", date_label: "Saturday, 29 November", time_label: "4:30 – 7:00 PM", venue: "Besant Nagar beach", maps_url: "https://maps.google.com/?q=Besant+Nagar+beach" };
    const m = reminderEmail({ name: "Priya", event: e, ticket: url.searchParams.get("ticket") ? "GC-7KQ2MX" : null });
    return new Response(m.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || "") ? url.searchParams.get("date") : tomorrowIST();
  const dry = !!url.searchParams.get("dry");
  if (!dry && !mailConfigured()) return json({ error: "GMAIL_USER / GMAIL_APP_PASSWORD are missing" }, 503);

  const evRes = await sb("events?select=*&status=neq.draft&event_date=eq." + date);
  const events = evRes.ok && Array.isArray(evRes.body) ? evRes.body : [];
  if (!events.length) return json({ date, events: 0, sent: 0 });

  const ids = events.map((e) => e.id).join(",");
  const [bk, od] = await Promise.all([
    sb("bookings?select=*&event_id=in.(" + ids + ")"),
    sb("cf_orders?select=*&status=eq.paid&event_id=in.(" + ids + ")"),
  ]);
  const list = recipients(bk.ok ? bk.body : [], od.ok ? od.body : []).filter((r) => !r.sent);
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));

  if (dry) return json({ date, events: events.length, would_send: list.map((r) => ({ name: r.name, email: r.email, event: byId[r.event_id]?.slug })) });

  let sent = 0;
  const failed = [];
  for (const r of list) {
    try {
      const m = reminderEmail({ name: r.name, event: byId[r.event_id], ticket: r.ticket });
      await sendMail({ to: r.email, ...m });
      await markSent(r);
      sent++;
    } catch (e) {
      failed.push({ email: r.email, error: String(e && e.message || e).slice(0, 200) });
    }
  }
  return json({ date, events: events.length, sent, failed });
}
