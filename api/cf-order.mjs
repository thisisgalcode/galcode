// POST /api/cf-order  { slug, name, phone, email, age }
// Creates a Cashfree order for a live galcode event and returns the payment session.
import { json, configured, cf, sb, parsePrice, isProd, SITE, SUPABASE_URL } from "./_cf.mjs";

const PUBLIC_KEY = "sb_publishable_3pvwaKstZSHy0fN8P6nR6A_7bP6mEY8";

export async function POST(request) {
  if (!configured()) return json({ error: "Payments aren't switched on yet." }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

  const slug = String(b.slug || "").trim();
  const name = String(b.name || "").trim().slice(0, 80);
  const phone = String(b.phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
  const age = parseInt(b.age, 10);
  if (!slug) return json({ error: "Event missing" }, 400);
  if (name.length < 2) return json({ error: "Enter your name." }, 400);
  if (!/^[6-9]\d{9}$/.test(phone)) return json({ error: "Enter a 10-digit mobile number." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email." }, 400);
  if (!(age >= 13 && age <= 100)) return json({ error: "Enter your age." }, 400);

  // Price always comes from the database, never from the browser
  const er = await fetch(SUPABASE_URL + "/rest/v1/events?slug=eq." + encodeURIComponent(slug) + "&status=eq.live&select=id,slug,title,title_em,price,date_label,event_date,time_label,venue", {
    headers: { apikey: PUBLIC_KEY, Authorization: "Bearer " + PUBLIC_KEY },
  });
  const evs = er.ok ? await er.json() : [];
  const ev = evs[0];
  if (!ev) return json({ error: "This event isn't open for booking." }, 404);
  const amount = parsePrice(ev.price);
  if (!amount) return json({ error: "This event doesn't have a price yet." }, 400);

  const orderId = "gc_" + Date.now().toString(36) + "_" + [...crypto.getRandomValues(new Uint8Array(5))].map((x) => x.toString(36)).join("");
  const title = [ev.title, ev.title_em].filter(Boolean).join(" ");

  const ins = await sb("cf_orders", {
    method: "POST",
    body: JSON.stringify({
      order_id: orderId, event_id: ev.id, event_slug: ev.slug, event_title: title,
      event_date_label: ev.date_label || ev.event_date || "", event_time: ev.time_label || "", event_venue: ev.venue || "",
      name, phone, email, age, amount, status: "created", mode: isProd() ? "production" : "sandbox",
    }),
  });
  if (!ins.ok) { console.log("cf_orders insert failed", ins.status, JSON.stringify(ins.body)); return json({ error: "Couldn't start the payment. Try again." }, 500); }

  const r = await cf("/orders", {
    method: "POST",
    body: JSON.stringify({
      order_id: orderId,
      order_amount: amount,
      order_currency: "INR",
      customer_details: { customer_id: "c" + phone, customer_name: name, customer_phone: phone, customer_email: email },
      order_meta: {
        return_url: SITE + "/checkout?order_id={order_id}",
        notify_url: SITE + "/api/cf-webhook",
      },
      order_note: title.slice(0, 200),
      order_tags: { event: ev.slug.slice(0, 50) },
    }),
  });
  if (!r.ok || !r.body.payment_session_id) {
    console.log("cashfree create order failed", r.status, JSON.stringify(r.body));
    await sb("cf_orders?order_id=eq." + orderId, { method: "PATCH", body: JSON.stringify({ status: "failed" }) });
    return json({ error: "Couldn't start the payment. Try again in a minute." }, 502);
  }
  return json({ order_id: orderId, payment_session_id: r.body.payment_session_id, mode: isProd() ? "production" : "sandbox", amount });
}
