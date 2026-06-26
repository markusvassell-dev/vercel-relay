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

  // ── Mirror the dashboard's Report tab EXACTLY (buildView + reportHTML in
  //    index.html), so this email == what you see in the "Report" tab.
  //    Karbon stores dates as calendar dates at UTC midnight; parse the Y-M-D
  //    parts directly so the day-offset matches the dashboard, and recompute
  //    against "today" so each Monday's email is current.
  const parseCal = (raw) => {
    if (!raw) return null;
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(raw);
    if (isNaN(d)) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const dayOff = (raw) => {
    const d = parseCal(raw);
    return d ? Math.round((d.getTime() - todayMs) / 86400000) : null;
  };
  const fmt = (raw) => {
    const d = parseCal(raw);
    return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  };

  // Current week = Monday → Sunday (ISO); overdue looks back ONE month, no more.
  const dow = (today.getDay() + 6) % 7;            // 0 = Mon … 6 = Sun
  const weekEndOff = 6 - dow;                        // offset to Sunday
  const monthAgo = new Date(today); monthAgo.setMonth(monthAgo.getMonth() - 1);
  const monthStartOff = Math.round((monthAgo.getTime() - todayMs) / 86400000);

  const rows = tasks.map((t) => ({
    ...t,
    off: dayOff(t.due),
    addedOff: dayOff(t.added),
    dateLabel: fmt(t.due),
    addedLabel: fmt(t.added),
  }));

  // Same buckets as the dashboard's buildView():
  const overdue = rows
    .filter((t) => t.off != null && t.off < 0 && t.off >= monthStartOff)
    .sort((a, b) => a.off - b.off);
  const dueWeek = rows
    .filter((t) => t.off != null && t.off >= 1 && t.off <= weekEndOff)
    .sort((a, b) => a.off - b.off);
  const addedWeek = rows
    .filter((t) => t.addedOff != null && t.addedOff >= -6)
    .sort((a, b) => (a.off ?? 1e9) - (b.off ?? 1e9));
  const nextWeek = rows
    .filter((t) => t.off != null && t.off >= weekEndOff + 1 && t.off <= weekEndOff + 7)
    .sort((a, b) => a.off - b.off);
  const unassigned = rows.filter((t) => !(t.assignee && t.assignee.trim()));
  const hours = rows.reduce((s, t) => s + (t.hours || 0), 0).toFixed(1);

  // Per-item tier color, matching decorate() in the dashboard.
  const tier = (t) => {
    if (t.off == null) return { b: "#5f7d4f", fg: "#3f5636" };
    if (t.off < 0) return { b: "#c14733", fg: "#8f2f1f" };
    if (t.off <= 1) return { b: "#bd8a2c", fg: "#7d5c12" };
    return { b: "#5f7d4f", fg: "#3f5636" };
  };
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pl = (n, s, p) => n + " " + (n === 1 ? s : (p || s + "s"));
  const whoName = (t) => (t.assignee && t.assignee.trim()) ? t.assignee : "Undetermined — no one assigned";
  const noteOf = (t) => t.status || (t.dateLabel ? "Due " + t.dateLabel : "No status");

  const repItem = (t, right) => {
    const c = tier(t);
    const assigned = !!(t.assignee && t.assignee.trim());
    return `<div style="border-left:3px solid ${c.b};padding:9px 0 9px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <span style="font-weight:600;font-size:14px;">${esc(t.task)}${t.client ? ` <span style="color:#9a8f7f;font-weight:500;">· ${esc(t.client)}</span>` : ""}</span>
          <span style="font-size:12px;font-family:monospace;color:${c.fg};white-space:nowrap;">${esc(right)}</span>
        </div>
        <div style="font-size:12.5px;margin-top:4px;line-height:1.5;">
          <span style="color:${assigned ? "#5f574c" : "#a8714a"};font-weight:${assigned ? "500" : "700"};">${esc(whoName(t))}</span>
          <span style="color:#9a8f7f;"> · ${(t.hours || 0).toFixed(1)}h · ${esc(noteOf(t))}</span>
        </div>
      </div>`;
  };
  const repSec = (tag, color, items, rightFn, empty) =>
    `<div style="display:flex;align-items:center;gap:8px;padding:18px 0 8px;">
       <span style="font:700 11px monospace;letter-spacing:.1em;text-transform:uppercase;color:${color};">${tag}</span>
       <span style="font:11px monospace;color:#b3a89a;">${items.length}</span>
       <span style="height:1px;flex:1;background:#efe6d6;"></span>
     </div>` +
    (items.length
      ? items.map((t) => repItem(t, rightFn(t))).join("")
      : `<div style="font-size:12.5px;color:#9a8f7f;padding:2px 0 6px;">${empty}</div>`);

  const mostOver = overdue[0];
  let summary = `The week opens with ${pl(overdue.length, "overdue task")} and ${pl(dueWeek.length, "task")} due before the week is out, with ${hours}h logged so far. `;
  if (mostOver) summary += `The furthest behind is ${esc(mostOver.task)}${mostOver.client ? ` for ${esc(mostOver.client)}` : ""}, ${-mostOver.off} day${mostOver.off === -1 ? "" : "s"} past due. `;
  summary += `${pl(addedWeek.length, "task")} ${addedWeek.length === 1 ? "was" : "were"} added this week, and ${pl(nextWeek.length, "task")} ${nextWeek.length === 1 ? "is" : "are"} already on next week's calendar.`;

  const dateStr = today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  const html = `
    <div style="max-width:640px;margin:0 auto;font-family:sans-serif;color:#29251f;">
      <div style="border:1px solid #efe6d6;border-radius:12px;overflow:hidden;">
        <div style="padding:12px 22px;background:#f9f5ee;border-bottom:1px solid #efe6d6;">
          <div style="font-size:13.5px;font-weight:700;">Weekly schedule — ${overdue.length} overdue, ${dueWeek.length} due this week</div>
          <div style="font-size:11.5px;color:#9a8f7f;margin-top:3px;">To: Admin (you) · ${dateStr} · 8:00 AM Mountain Time</div>
        </div>
        <div style="background:#c1632f;padding:22px 24px;color:#fff;">
          <div style="font:600 11px monospace;letter-spacing:.12em;text-transform:uppercase;opacity:.82;">${dateStr} · Mountain Time</div>
          <div style="font-size:21px;font-weight:700;margin-top:6px;">All active assignments</div>
        </div>
        <div style="display:flex;flex-wrap:wrap;border-bottom:1px solid #efe6d6;">
          <div style="flex:1;min-width:120px;padding:14px 20px;border-right:1px solid #efe6d6;"><div style="font-size:24px;font-weight:700;color:#8f2f1f;">${overdue.length}</div><div style="font-size:11px;color:#9a8f7f;">Overdue</div></div>
          <div style="flex:1;min-width:120px;padding:14px 20px;border-right:1px solid #efe6d6;"><div style="font-size:24px;font-weight:700;color:#7d5c12;">${dueWeek.length}</div><div style="font-size:11px;color:#9a8f7f;">Due this week</div></div>
          <div style="flex:1;min-width:120px;padding:14px 20px;border-right:1px solid #efe6d6;"><div style="font-size:24px;font-weight:700;color:#3f5636;">${addedWeek.length}</div><div style="font-size:11px;color:#9a8f7f;">Added this week</div></div>
          <div style="flex:1;min-width:120px;padding:14px 20px;"><div style="font-size:24px;font-weight:700;color:#6f6657;">${nextWeek.length}</div><div style="font-size:11px;color:#9a8f7f;">Due next week</div></div>
        </div>
        <div style="padding:18px 24px;">
          <div style="font:11px monospace;letter-spacing:.1em;text-transform:uppercase;color:#9a8f7f;margin-bottom:8px;">Summary</div>
          <p style="margin:0;font-size:13.5px;line-height:1.65;color:#4f483e;">${summary}</p>
          ${unassigned.length ? `<div style="margin-top:10px;font-size:12.5px;color:#a8714a;background:#f9efe6;border:1px solid #ecd8c5;border-radius:8px;padding:8px 12px;">⚠ ${pl(unassigned.length, "task")} currently ${unassigned.length === 1 ? "has" : "have"} no assignee and ${unassigned.length === 1 ? "needs" : "need"} to be allocated.</div>` : ""}
          ${repSec("Overdue", "#8f2f1f", overdue, (t) => `${-t.off}d overdue`, "Nothing overdue.")}
          ${repSec("Due this week", "#7d5c12", dueWeek, (t) => `due ${t.dateLabel || ""}`, "Nothing due this week.")}
          ${repSec("Newly added this week", "#3f5636", addedWeek, (t) => `added ${t.addedLabel || ""}`, "Nothing added this week.")}
          ${repSec("Due next week", "#6f6657", nextWeek, (t) => `due ${t.dateLabel || ""}`, "Nothing on next week.")}
        </div>
        <div style="padding:14px 24px;background:#f9f5ee;border-top:1px solid #efe6d6;font:11px monospace;color:#9a8f7f;text-align:center;">Auto-generated from Karbon · tasks with no assignee flagged "Undetermined"</div>
      </div>
    </div>`;

  await sendEmail(
    process.env.BOSS_EMAIL,
    `Weekly schedule — ${overdue.length} overdue, ${dueWeek.length} due this week`,
    html
  );
}
