/**
 * Karbon Scheduling relay — /api/tasks
 * ------------------------------------------------------------------
 * Uses Karbon's PUBLIC developer API (api.karbonhq.com/v3), which is what a
 * KARBON_BEARER_TOKEN + KARBON_ACCESS_KEY are issued for.
 *
 * IMPORTANT — why the old URL 401'd:
 *   https://app.karbonhq.com/todo/api/.../workViewListItems  is Karbon's
 *   INTERNAL web-app endpoint. It authenticates with your browser's login
 *   SESSION COOKIES, not an API token, so a Bearer token can never authorize
 *   there — it always returns 401. The public /v3 API below is the correct,
 *   supported home for token auth.
 *
 * Vercel → Settings → Environment Variables (then REDEPLOY):
 *   KARBON_BEARER_TOKEN   Karbon Bearer access token
 *   KARBON_ACCESS_KEY     Karbon AccessKey (Settings → Connected Apps)
 *   ALLOWED_ORIGIN        your dashboard URL (optional; defaults to *)
 */

const KARBON_BASE = 'https://api.karbonhq.com/v3';

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  // Accept BOTH GET and POST so the dashboard works either way.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bearerToken = (process.env.KARBON_BEARER_TOKEN || '').trim();
  const accessKey = (process.env.KARBON_ACCESS_KEY || '').trim();

  // Non-secret fingerprint — confirms the env vars populated without leaking
  // them. A length of 0 = the var never reached this deployment.
  const fingerprint = {
    bearer_len: bearerToken.length,
    bearer_preview: bearerToken ? bearerToken.slice(0, 4) + '…' + bearerToken.slice(-4) : '(empty)',
    accessKey_len: accessKey.length,
    accessKey_preview: accessKey ? accessKey.slice(0, 4) + '…' + accessKey.slice(-4) : '(empty)',
  };

  if (!bearerToken || !accessKey) {
    return res.status(500).json({
      error: 'Karbon credentials missing at runtime',
      KARBON_BEARER_TOKEN_present: Boolean(bearerToken),
      KARBON_ACCESS_KEY_present: Boolean(accessKey),
      fingerprint,
    });
  }

  // --- Filters that enforce "active whole works only" ---
  const DEAD_STATUS = /complete|cancel|archiv|done|closed|deleted/i;
  const SECTION_LIKE = /section|checklist|subtask|step|task list/i;

  const headers = {
    'Authorization': 'Bearer ' + bearerToken,
    'AccessKey': accessKey,
    'Accept': 'application/json',
  };

  // Active work only, 100 per page; follow @odata.nextLink for the rest.
  let url = KARBON_BASE + "/WorkItems?$filter=" +
    encodeURIComponent("PrimaryStatus ne 'Completed' and PrimaryStatus ne 'Cancelled'") +
    "&$top=100";

  try {
    const raw = [];

    for (let page = 0; page < 25 && url; page++) {
      const response = await fetch(url, { headers });
      const bodyText = await response.text();

      // Rate limit (120/min) — wait the advised time, then retry the same page.
      if (response.status === 429) {
        const wait = Number(response.headers.get('Retry-After') || 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        // Surface EVERYTHING Karbon told us, raw, into the browser Response tab.
        const karbonHeaders = {};
        response.headers.forEach((v, k) => { karbonHeaders[k] = v; });
        console.error(`Karbon API error (${response.status} ${response.statusText}): ${bodyText}`);
        return res.status(response.status).json({
          error: 'Karbon API rejected the request',
          status: response.status,
          statusText: response.statusText,
          url,
          karbonResponse: bodyText,                       // exact message Karbon sent
          wwwAuthenticate: karbonHeaders['www-authenticate'] || null,
          karbonHeaders,
          sentHeaders: {
            Authorization: 'Bearer <token len ' + bearerToken.length + '>',
            AccessKey: '<key len ' + accessKey.length + '>',
          },
          fingerprint,
        });
      }

      let json;
      try { json = JSON.parse(bodyText); }
      catch (e) {
        return res.status(502).json({
          error: 'Karbon returned a non-JSON body',
          url,
          karbonResponse: bodyText.slice(0, 2000),
          fingerprint,
        });
      }

      const items = json.value || json.WorkItems || json.Items || [];
      raw.push(...items);
      url = json['@odata.nextLink'] || null;
    }

    // Reshape + filter into the clean { tasks:[...] } the dashboard expects.
    const seen = new Set();
    const tasks = [];

    for (const it of raw) {
      // 1) WHOLE WORKS ONLY — skip section / checklist / subtask rows.
      const entity = String(it.EntityType ?? it.entityType ?? it.Type ?? 'work').toLowerCase();
      if (SECTION_LIKE.test(entity)) continue;

      // 2) ACTIVE ONLY — skip completed / canceled / archived work.
      const status = String(it.PrimaryStatus ?? it.SecondaryStatus ?? it.status ?? '').trim();
      if (DEAD_STATUS.test(status)) continue;

      // 3) De-dupe so each whole work appears once.
      const id = it.WorkItemKey ?? it.Key ?? it.Id ?? it.id ?? (it.Title ?? it.WorkType ?? '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);

      tasks.push({
        id,
        task: it.Title || it.WorkType || it.WorkTemplateTitle || 'Untitled',
        client: it.ClientName || it.PrimaryClientName || '',
        assignee: String(it.AssigneeName || it.AssignedToName || '').trim(),
        due: it.DueDate || it.DeadlineDate || null,
        added: it.WorkCreatedDate || it.CreatedDate || null,
        hours: Number(it.ActualHours || it.LoggedHours || 0) || 0,
        status,
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: tasks.length, tasks });
  } catch (error) {
    console.error('Relay Error:', error && error.stack ? error.stack : error);
    return res.status(500).json({
      error: 'Relay crashed before/while contacting Karbon',
      detail: String(error && error.message ? error.message : error),
      name: error && error.name ? error.name : null,
      fingerprint,
    });
  }
}
