// galcode auto-DM bot (Cloudflare Worker "galcode-autodm", free plan)
//
// What it does:
//   - Someone comments on a reel/post of @ft.rakshaa or @thisisgalcode
//   - The bot looks up that reel's rule in Supabase (set in admin.html -> Auto DM)
//   - If the rule is ON and the comment matches the trigger, it sends ONE private DM
//     (Instagram allows one per comment, within 7 days) and replies under the comment.
//     If Instagram won't deliver the DM (e.g. their DMs are limited to people they
//     follow), the reply asks them to follow and comment again instead.
//   - Reels with no rule, or switched off, get nothing.
//
// It also serves GET /media?account=<IG_ID>&after=<cursor> so the admin panel can
// list every reel/post of each account (public info only: caption, thumbnail, link, date).
//
// Cloudflare variables (Settings -> Variables and Secrets):
//   IG_ID_1, IG_ID_2           Instagram account IDs (text)
//   Token_1, Token_2           access tokens for those accounts (secret)
//   VERIFY_TOKEN               any password; the same one goes into Meta's webhook setup (secret)
//   APP_SECRET                 Meta app secret, used to check webhooks really come from Meta (secret)

const SUPABASE_URL = "https://hbhhtmxabsjxwiirancm.supabase.co";
const SUPABASE_KEY = "sb_publishable_3pvwaKstZSHy0fN8P6nR6A_7bP6mEY8"; // public key, same as the website
const ALLOWED_ORIGINS = ["https://galcode.vercel.app"];

// Instagram-login tokens (start with "IG") use graph.instagram.com; other tokens use graph.facebook.com
const apiFor = (token) =>
  (token || "").startsWith("IG") ? "https://graph.instagram.com/v23.0" : "https://graph.facebook.com/v23.0";

function accountsFrom(env) {
  return {
    [env.IG_ID_1]: { token: env.TOKEN_1 || env.Token_1 },
    [env.IG_ID_2]: { token: env.TOKEN_2 || env.Token_2 },
  };
}

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors(request) });

    // Reel list for the admin panel
    if (request.method === "GET" && url.pathname === "/media") {
      return listMedia(request, url, env);
    }

    // Meta's one-time webhook verification
    if (request.method === "GET") {
      if (
        url.searchParams.get("hub.mode") === "subscribe" &&
        env.VERIFY_TOKEN &&
        url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN
      ) {
        return new Response(url.searchParams.get("hub.challenge"), { status: 200 });
      }
      return new Response("Auto-DM worker is running", { status: 200 });
    }

    // Comment notifications from Meta
    if (request.method === "POST") {
      const raw = await request.text();
      if (!(await validSignature(raw, request.headers.get("x-hub-signature-256"), env.APP_SECRET))) {
        console.log("Rejected webhook: bad signature");
        return new Response("bad signature", { status: 403 });
      }
      let body;
      try { body = JSON.parse(raw); } catch { return new Response("ok"); }
      ctx.waitUntil(handleEvent(body, env));
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

async function listMedia(request, url, env) {
  const headers = { ...cors(request), "Content-Type": "application/json", "Cache-Control": "max-age=60" };
  const id = url.searchParams.get("account") || "";
  const account = accountsFrom(env)[id];
  if (!id || !account || !account.token) {
    return new Response(JSON.stringify({ error: "Unknown account" }), { status: 400, headers });
  }
  const q = new URLSearchParams({
    fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp",
    limit: "30",
  });
  const after = url.searchParams.get("after");
  if (after) q.set("after", after);
  const res = await fetch(`${apiFor(account.token)}/${id}/media?${q}`, {
    headers: { Authorization: `Bearer ${account.token}` },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    console.log("media list failed", res.status, JSON.stringify(j.error || j));
    return new Response(JSON.stringify({ error: (j.error && j.error.message) || "Couldn't load posts" }), { status: 502, headers });
  }
  const items = (j.data || []).map((m) => ({
    id: m.id,
    caption: (m.caption || "").slice(0, 300),
    type: m.media_product_type === "REELS" ? "reel" : (m.media_type || "").toLowerCase(),
    thumb: m.thumbnail_url || (m.media_type === "VIDEO" ? "" : m.media_url) || "",
    permalink: m.permalink || "",
    timestamp: m.timestamp || "",
  }));
  const next = j.paging && j.paging.next && j.paging.cursors ? j.paging.cursors.after : null;
  return new Response(JSON.stringify({ items, next }), { headers });
}

async function getRule(account, mediaId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/autodm_rule`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_account: account, p_media: mediaId }),
  });
  if (!res.ok) { console.log("rule lookup failed", res.status, await res.text()); return null; }
  return res.json(); // null when the reel has no rule
}

function matches(rule, text) {
  if (rule.trigger !== "keywords") return true;
  const t = (text || "").toLowerCase();
  return (rule.keywords || []).some((k) => k && t.includes(String(k).toLowerCase().trim()));
}

async function handleEvent(body, env) {
  const accounts = accountsFrom(env);

  for (const entry of body.entry || []) {
    const account = accounts[entry.id];
    if (!account || !account.token) { console.log("Unknown account id:", entry.id); continue; }
    const API = apiFor(account.token);

    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;
      const c = change.value || {};
      const commentId = c.id;
      const mediaId = c.media && c.media.id;
      const fromId = c.from && c.from.id;

      // Skip our own replies (no loops) and replies-to-replies
      if (!commentId || !mediaId || fromId === entry.id || c.parent_id) continue;

      // Reels with their own rule use it (on or off). New posts with no rule fall back to the default.
      const rule = (await getRule(entry.id, mediaId)) || (await defaultRule(API, account.token, mediaId));
      if (!rule || !rule.enabled) continue;          // not set up / switched off -> no auto DM
      if (!matches(rule, c.text)) continue;          // keyword trigger didn't match

      // Send the DM first, so the comment reply can say whether it actually went through
      let dmSent = false;
      if (rule.dm) {
        const hasButton = rule.button_text && rule.button_link;
        let out = "";
        if (hasButton) {
          out = await call(`${API}/${entry.id}/messages`, account.token, {
            recipient: { comment_id: commentId },
            message: {
              attachment: {
                type: "template",
                payload: {
                  template_type: "button",
                  text: rule.dm,
                  buttons: [{ type: "web_url", url: rule.button_link, title: rule.button_text }],
                },
              },
            },
          });
          dmSent = sent(out);
        }
        // No button, or Instagram rejected the button -> plain text (with the link if there is one)
        if (!dmSent) {
          const text = hasButton ? `${rule.dm}\n\n${rule.button_text}: ${rule.button_link}` : rule.dm;
          out = await call(`${API}/${entry.id}/messages`, account.token, {
            recipient: { comment_id: commentId },
            message: { text },
          });
          dmSent = sent(out);
        }
      }

      // DM delivered -> the reel's normal reply. DM blocked (e.g. their messages are
      // limited to people they follow) -> ask them to follow and comment again.
      if (rule.dm && !dmSent) {
        const handle = await username(API, entry.id, account.token);
        await call(`${API}/${commentId}/replies`, account.token, {
          message: `We couldn't DM you because of your message settings. Follow ${handle ? "@" + handle : "us"} and comment again, and we'll send you the details!`,
        });
      } else if (rule.reply) {
        await call(`${API}/${commentId}/replies`, account.token, { message: rule.reply });
      }
    }
  }
}

// Instagram answers a delivered message with a message_id; anything else means it didn't go through
function sent(out) {
  try { const j = JSON.parse(out || "{}"); return !j.error && !!j.message_id; } catch { return false; }
}

const handles = {};
async function username(API, id, token) {
  if (handles[id]) return handles[id];
  try {
    const res = await fetch(`${API}/${id}?fields=username`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    if (j.username) handles[id] = j.username;
  } catch {}
  return handles[id] || "";
}

async function call(endpoint, token, payload) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const out = await res.text();
  console.log(res.status, endpoint.replace(/\/\d+\//g, "/…/"), out); // visible in Cloudflare -> Logs
  return out;
}

async function validSignature(raw, header, secret) {
  if (!secret) return true; // APP_SECRET not set yet -> check skipped
  if (!header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === header.slice(7);
}

// ---- Default for new posts ----
// Any post published after DEFAULT_SINCE that has no rule of its own in the admin panel
// gets this rule automatically. Setting a post up (or switching it off) in the admin
// panel always wins. Change DEFAULT_RULE / DEFAULT_SINCE when the next event comes up.
const DEFAULT_SINCE = "2026-11-27T00:00:00Z";
const DEFAULT_RULE = {
  enabled: true,
  trigger: "keywords",
  keywords: ["run"],
  reply: "Check your DMs for the details!",
  dm: "Hi girlie! Thanks for showing interest in our Sunset Girlies Run. We are galcode, a girls-only community based in Chennai built for girls by a girl's girl. To get more event details and reserve your spot, press the button below!",
  button_text: "Sunset Girlies Run",
  button_link: "https://galcode.vercel.app/#sunset-run-club",
};

async function defaultRule(API, token, mediaId) {
  try {
    const res = await fetch(`${API}/${mediaId}?fields=timestamp`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    if (j.timestamp && Date.parse(j.timestamp) >= Date.parse(DEFAULT_SINCE)) return DEFAULT_RULE;
  } catch {}
  return null;
}
