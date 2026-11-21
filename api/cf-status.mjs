// GET /api/cf-status?order_id=...  → checks the payment with Cashfree and returns the ticket
import { json, configured, syncOrder, publicTicket } from "./_cf.mjs";

export async function GET(request) {
  if (!configured()) return json({ error: "Payments aren't switched on yet." }, 503);
  const id = new URL(request.url).searchParams.get("order_id") || "";
  if (!/^gc_[a-z0-9_]{6,60}$/.test(id)) return json({ error: "Unknown order" }, 400);
  const row = await syncOrder(id);
  if (!row) return json({ error: "Unknown order" }, 404);
  return json(publicTicket(row));
}
