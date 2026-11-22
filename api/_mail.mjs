// Email helpers for galcode (Vercel functions).
//
// Vercel environment variables:
//   GMAIL_USER           thisisgalcode@gmail.com
//   GMAIL_APP_PASSWORD   16-letter Google "App password" for that account   (sensitive)
//   CRON_SECRET          any long random text; Vercel sends it with each cron run (sensitive)

export const mailConfigured = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

let transport = null;
export async function sendMail({ to, subject, html, text }) {
  if (!transport) {
    const nodemailer = (await import("nodemailer")).default;
    transport = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transport.sendMail({
    from: '"galcode" <' + process.env.GMAIL_USER + ">",
    replyTo: process.env.GMAIL_USER,
    to, subject, html, text,
  });
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https:\/\//i.test(String(u || "")) ? String(u) : "");

export const plainTitle = (e) => [e.title, e.title_em].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || "your galcode event";

// Design C, "friendly checklist": warm amber card, short checklist, ticket code when there is one.
export function reminderEmail({ name, event, ticket }) {
  const first = String(name || "").trim().split(/\s+/)[0] || "you";
  const title = plainTitle(event);
  const when = [event.date_label, event.time_label].filter(Boolean).join(" · ");
  const maps = safeUrl(event.maps_url);
  const checklist = [
    "Wear something comfy",
    ticket ? "Show your ticket code at entry" : "Show this email at entry",
    "Bring a water bottle",
    "Come solo, leave with friends",
  ];

  const subject = "tomorrow: " + title + " ✦";
  const html =
`<!doctype html><html><body style="margin:0;padding:0;background:#f6f1ea;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1ea;padding:24px 12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FAEEDA;border-radius:18px;">
<tr><td style="padding:28px 24px 8px;">
  <div style="font-size:12px;letter-spacing:.5px;color:#854F0B;">galcode</div>
  <div style="font-size:24px;line-height:1.3;color:#633806;margin-top:10px;">it's almost time, ${esc(first)}</div>
  <div style="font-size:15px;line-height:1.6;color:#854F0B;margin-top:8px;">
    <b style="color:#633806;">${esc(title)}</b> is tomorrow.<br>
    ${esc(when)}${event.venue ? "<br>" + esc(event.venue) : ""}
  </div>
</td></tr>
${ticket ? `<tr><td style="padding:12px 24px 0;">
  <div style="background:#ffffff;border:1px dashed #EF9F27;border-radius:12px;padding:12px 16px;color:#633806;font-size:14px;">
    Your ticket <span style="float:right;font-family:Menlo,Consolas,monospace;font-size:15px;letter-spacing:1px;">${esc(ticket)}</span>
  </div>
</td></tr>` : ""}
<tr><td style="padding:14px 24px 0;">
  <div style="background:#ffffff;border-radius:12px;padding:14px 18px;color:#633806;font-size:15px;line-height:2;">
    ${checklist.map((t) => "☐&nbsp; " + esc(t)).join("<br>")}
  </div>
</td></tr>
${maps ? `<tr><td style="padding:16px 24px 0;" align="center">
  <a href="${esc(maps)}" style="display:inline-block;background:#854F0B;color:#ffffff;text-decoration:none;border-radius:10px;padding:11px 22px;font-size:14px;">Get directions</a>
</td></tr>` : ""}
<tr><td style="padding:18px 24px 26px;font-size:13px;line-height:1.6;color:#854F0B;">
  Can't make it? Just reply to this email and let us know.<br>See you there ♡
</td></tr>
</table>
<div style="font-size:11px;color:#a08a6c;margin-top:14px;">galcode · a girls-only community in Chennai · <a href="https://galcode.vercel.app" style="color:#a08a6c;">galcode.vercel.app</a></div>
</td></tr></table></body></html>`;

  const text =
`it's almost time, ${first}

${title} is tomorrow.
${when}${event.venue ? "\n" + event.venue : ""}${ticket ? "\n\nYour ticket: " + ticket : ""}

${checklist.map((t) => "[ ] " + t).join("\n")}
${maps ? "\nDirections: " + maps + "\n" : ""}
Can't make it? Just reply to this email and let us know.
See you there,
galcode`;

  return { subject, html, text };
}
