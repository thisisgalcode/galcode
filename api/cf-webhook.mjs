// POST /api/cf-webhook  ← Cashfree payment notifications (backup in case the buyer closes the page)
import { createHmac, timingSafeEqual } from "node:crypto";
import { json, configured, syncOrder } from "./_cf.mjs";

export async function POST(request) {
  if (!configured()) return json({ ok: false }, 503);
  const raw = await request.text();
  const ts = request.headers.get("x-webhook-timestamp") || "";
  const sig = request.headers.get("x-webhook-signature") || "";
  const expected = createHmac("sha256", process.env.CASHFREE_SECRET).update(ts + raw).digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(sig);
  if (!ts || a.length !== b.length || !timingSafeEqual(a, b)) return json({ ok: false }, 401);

  let body = {};
  try { body = JSON.parse(raw); } catch {}
  const orderId = body && body.data && body.data.order && body.data.order.order_id;
  // Never trust the webhook's own status: re-check with Cashfree before marking paid
  if (orderId && /^gc_/.test(orderId)) await syncOrder(orderId);
  return json({ ok: true });
}
