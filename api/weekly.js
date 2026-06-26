/**
 * Karbon Scheduling — Monday email  (replaces the Cloudflare Worker scheduled())
 * ------------------------------------------------------------------------------
 * Vercel Cron hits this endpoint on the schedule in vercel.json. It pulls
 * Karbon, builds the weekly summary, and emails your boss via Resend.
 *
 * Extra env vars (in addition to the two Karbon ones in tasks.js):
 *   RESEND_API_KEY   Resend api key
 *   BOSS_EMAIL       where the Monday report goes      (e.g. boss@firm.com)
 *   FROM_EMAIL       a VERIFIED Resend sender           (e.g. scheduling@yourfirm.com)
 *   CRON_SECRET      any random string — Vercel sends it so only cron can fire this
 *
 * Test on demand without waiting for Monday:
 *   curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://<project>.vercel.app/api/weekly
 */

import { fetchKarbonTasks } from "./tasks.js";

export default async function handler(req, res) {
  // CORS — the dashboard's "Send report now" button calls this from the browser.
  // (Vercel Cron calls it server-side and ignores these headers.)
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Vercel Cron sends  Authorization: Bearer ${CRON_SECRET}  automatically; the
  // dashboard sends the same header from the secret you paste into it.
  const expected = "Bearer " + (process.env.CRON_SECRET || "");
  if (process.env.CRON_SECRET && req.headers.authorization !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await runWeeklyReport();
    return res.status(200).json({ ok: true });
  } catch (err) {
    // Vercel does NOT retry a failed cron — alert yourself instead.
    await sendEmail(
      process.env.FROM_EMAIL,
      "⚠ Karbon weekly report FAILED",
      "<pre>" + String(err.message || err) + "</pre>"
    ).catch(() => {});
    return res.status(500).json({ error: String(err.message || err) });
  }
}

async function sendEmail(to, subject, html) {
  const send = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: process.env.FROM_EMAIL, to: [to], subject, html }),
  });
  if (!send.ok) throw new Error("Resend " + send.status + ": " + (await send.text()));
}

async function runWeeklyReport() {
  const tasks = await fetchKarbonTasks();

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dayOff = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    d.setUTCHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  };
  const fmt = (iso) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

  const rows = tasks.map((t) => ({ ...t, off: dayOff(t.due), addedOff: dayOff(t.added) }));
  const overdue   = rows.filter((t) => t.off != null && t.off < 0).sort((a, b) => a.off - b.off);
  const dueWeek   = rows.filter((t) => t.off != null && t.off >= 0 && t.off <= 4).sort((a, b) => a.off - b.off);
  const addedWeek = rows.filter((t) => t.addedOff != null && t.addedOff >= -6);
  const nextWeek  = rows.filter((t) => t.off != null && t.off >= 7 && t.off <= 11);
  const hours     = rows.reduce((s, t) => s + (t.hours || 0), 0).toFixed(1);

  const esc = (s) =>
    String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const who = (t) => (t.assignee && t.assignee.trim() ? esc(t.assignee) : "Undetermined — no one assigned");
  const section = (title, list, label) =>
    !list.length
      ? ""
      : `<h3 style="font:600 12px monospace;letter-spacing:.1em;text-transform:uppercase;color:#7d5c12;margin:22px 0 8px;">${title} · ${list.length}</h3>` +
        list.map((t) =>
          `<div style="border-left:3px solid #bd8a2c;padding:8px 0 8px 14px;margin-bottom:8px;">
             <div style="font:600 14px sans-serif;">${esc(t.task)} <span style="color:#9a8f7f;font-weight:500;">· ${esc(t.client)}</span></div>
             <div style="font:13px sans-serif;color:#5f574c;margin-top:3px;">${who(t)} · ${(t.hours || 0).toFixed(1)}h · ${label(t)}</div>
           </div>`
        ).join("");

  const html = `
    <div style="max-width:640px;margin:0 auto;font-family:sans-serif;color:#29251f;">
      <div style="background:#c1632f;color:#fff;padding:22px 24px;border-radius:10px 10px 0 0;">
        <div style="font:600 11px monospace;letter-spacing:.12em;text-transform:uppercase;opacity:.85;">Weekly schedule · Mountain Time</div>
        <div style="font-size:21px;font-weight:700;margin-top:6px;">${overdue.length} overdue · ${dueWeek.length} due this week</div>
      </div>
      <div style="border:1px solid #efe6d6;border-top:none;border-radius:0 0 10px 10px;padding:6px 24px 22px;">
        <p style="font:13.5px/1.6 sans-serif;color:#4f483e;">
          The week opens with <b>${overdue.length}</b> overdue and <b>${dueWeek.length}</b> due before week's end, ${hours}h logged so far.
          <b>${addedWeek.length}</b> added this week; <b>${nextWeek.length}</b> already on next week's calendar.
        </p>
        ${section("Overdue", overdue, (t) => (-t.off) + "d overdue")}
        ${section("Due this week", dueWeek, (t) => "due " + fmt(t.due))}
        ${section("Newly added this week", addedWeek, (t) => "added " + fmt(t.added))}
        ${section("Due next week", nextWeek, (t) => "due " + fmt(t.due))}
        <div style="margin-top:20px;font:11px monospace;color:#9a8f7f;text-align:center;">Auto-generated from Karbon · unassigned work flagged “Undetermined”.</div>
      </div>
    </div>`;

  await sendEmail(
    process.env.BOSS_EMAIL,
    `Weekly schedule — ${overdue.length} overdue, ${dueWeek.length} due this week`,
    html
  );
}
