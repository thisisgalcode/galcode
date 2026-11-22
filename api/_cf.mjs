// Shared helpers for galcode's Cashfree checkout (Vercel functions).
//
// Vercel environment variables (Project → Settings → Environment Variables):
//   CASHFREE_APP_ID        Cashfree App ID (Client ID)
//   CASHFREE_SECRET        Cashfree Secret Key                       (sensitive)
//   CASHFREE_ENV           "sandbox" while testing, "production" when approved
//   SUPABASE_SERVICE_KEY   Supabase service_role / secret key        (sensitive)

export const SUPABASE_URL = "https://hbhhtmxabsjxwiirancm.supabase.co";
export const SITE = "https://galcode.vercel.app";
export const CF_VERSION = "2023-08-01";

export const isProd = () => (process.env.CASHFREE_ENV || "sandbox").toLowerCase() === "production";
export const cfBase = () => (isProd() ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function configured() {
  return !!(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET && process.env.SUPABASE_SERVICE_KEY);
}

export async function cf(path, init = {}) {
  const res = await fetch(cfBase() + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-version": CF_VERSION,
      "x-client-id": process.env.CASHFREE_APP_ID,
      "x-client-secret": process.env.CASHFREE_SECRET,
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Supabase REST with the service key (server only, never sent to the browser)
export async function sb(path, init = {}) {
  const key = String(process.env.SUPABASE_SERVICE_KEY || "").replace(/\s+/g, "");
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// "₹1,499" / "Rs. 899 per person" -> 1499 / 899 ; anything unclear -> null
export function parsePrice(p) {
  const m = String(p || "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 100000 ? Math.round(n * 100) / 100 : null;
}

export function ticketCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return "GC-" + [...b].map((x) => abc[x % abc.length]).join("");
}

// Ask Cashfree for the real status of an order and record it. Returns the stored row.
export async function syncOrder(orderId) {
  const got = await sb("cf_orders?order_id=eq." + encodeURIComponent(orderId) + "&select=*");
  const row = got.ok && Array.isArray(got.body) ? got.body[0] : null;
  if (!row) return null;
  if (row.status === "paid") return row;

  const r = await cf("/orders/" + encodeURIComponent(orderId));
  if (!r.ok) return row;
  const st = r.body.order_status; // ACTIVE | PAID | EXPIRED | TERMINATED | ...
  const amountOk = Number(r.body.order_amount) === Number(row.amount);
  let patch = null;
  if (st === "PAID" && amountOk) patch = { status: "paid", paid_at: new Date().toISOString(), ticket_code: row.ticket_code || ticketCode() };
  else if (st === "EXPIRED" || st === "TERMINATED") patch = { status: "failed" };
  if (!patch) return row;

  // only move forward from "created"/"failed", never overwrite a paid row
  const up = await sb("cf_orders?order_id=eq." + encodeURIComponent(orderId) + "&status=neq.paid", { method: "PATCH", body: JSON.stringify(patch) });
  if (up.ok && Array.isArray(up.body) && up.body[0]) return up.body[0];
  const again = await sb("cf_orders?order_id=eq." + encodeURIComponent(orderId) + "&select=*");
  return again.ok && Array.isArray(again.body) ? again.body[0] : row;
}

export function publicTicket(row) {
  return {
    order_id: row.order_id,
    status: row.status,
    ticket: row.status === "paid" ? row.ticket_code : null,
    name: row.name,
    amount: row.amount,
    event: { title: row.event_title, date: row.event_date_label, time: row.event_time, venue: row.event_venue, slug: row.event_slug },
  };
}
