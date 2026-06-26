/**
 * Karbon Scheduling relay — /api/tasks
 * ------------------------------------------------------------------
 * Karbon PUBLIC developer API (api.karbonhq.com/v3). Auth is a
 * KARBON_BEARER_TOKEN + KARBON_ACCESS_KEY pair (Settings → Connected Apps).
 *
 * Why this version exists:
 *   The previous version looped up to 25 pages. On Vercel's Hobby plan the
 *   function is killed at the time limit, which shows as a bare
 *   FUNCTION_INVOCATION_FAILED crash page instead of a clean JSON error.
 *   This version enforces a TIME BUDGET: it paginates only while there is
 *   time left, then returns whatever it has. It can never time out.
 *
 *   It also EXPORTS fetchKarbonTasks() so api/weekly.js can reuse it.
 *
 * Vercel → Settings → Environment Variables (then REDEPLOY):
 *   KARBON_BEARER_TOKEN   Karbon Bearer access token
 *   KARBON_ACCESS_KEY     Karbon AccessKey
 *   ALLOWED_ORIGIN        your dashboard URL (optional; defaults to *)
 */

const KARBON_BASE = 'https://api.karbonhq.com/v3';

// Stop paginating once we have spent this long, so we always return cleanly
// before Vercel's function limit. (maxDuration is raised to 30s in vercel.json.)
const TIME_BUDGET_MS = 25000;
// Per-request hard timeout so one slow Karbon call can't hang the whole thing.
const PER_REQUEST_MS = 9000;

const DEAD_STATUS = /complete|cancel|archiv|done|closed|deleted/i;
const SECTION_LIKE = /section|checklist|subtask|step|task list/i;

/**
 * Fetch + reshape active whole-work items from Karbon.
 * Returns a clean array of task objects. Throws on a non-OK Karbon response
 * with a .karbon property carrying the status + body for the caller to surface.
 */
export async function fetchKarbonTasks(opts = {}) {
  const bearerToken = (process.env.KARBON_BEARER_TOKEN || '').trim();
  const accessKey = (process.env.KARBON_ACCESS_KEY || '').trim();

  if (!bearerToken || !accessKey) {
    const err = new Error('Karbon credentials missing at runtime');
    err.code = 'NO_CREDS';
    throw err;
  }

  const headers = {
    'Authorization': 'Bearer ' + bearerToken,
    'AccessKey': accessKey,
    'Accept': 'application/json',
  };

  const start = Date.now();

  // Page through a list endpoint within the time budget. Returns the items.
  //
  // IMPORTANT: Karbon's WorkItems endpoint does NOT return an @odata.nextLink
  // here, so following nextLink stops after the first 100 items (that bug left
  // the dashboard seeing only ~100 of ~300 work items — and, when sorted, only
  // the future-dated ones, hiding all the overdue/current work). We paginate
  // EXPLICITLY with $skip instead, which Karbon supports, and stop when a page
  // comes back short (fewer than the page size) or empty.
  //
  // If Karbon rejects the FIRST page with a 400 (e.g. an unsupported $orderby
  // property), it throws BAD_REQUEST so the caller can retry without it.
  const PAGE_SIZE = 100;
  async function collect(baseUrl) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const items = [];
    for (let page = 0; page < 200; page++) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      const url = baseUrl + sep + '$skip=' + (page * PAGE_SIZE);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_REQUEST_MS);
      let response, bodyText;
      try {
        response = await fetch(url, { headers, signal: controller.signal });
        bodyText = await response.text();
      } finally {
        clearTimeout(timer);
      }

      // Rate limited (120/min) — wait once, then retry the same page.
      if (response.status === 429) {
        const wait = Number(response.headers.get('Retry-After') || 2) * 1000;
        await new Promise((r) => setTimeout(r, Math.min(wait, 4000)));
        page--;
        continue;
      }

      // A 400 on the FIRST page means the query itself is bad — signal a retry.
      if (response.status === 400 && page === 0) {
        const err = new Error('Karbon rejected the query (400)');
        err.code = 'BAD_REQUEST';
        err.karbon = { status: 400, statusText: response.statusText, body: bodyText, url };
        throw err;
      }

      if (!response.ok) {
        const err = new Error('Karbon API rejected the request');
        err.code = 'KARBON_ERROR';
        err.karbon = { status: response.status, statusText: response.statusText, body: bodyText, url };
        throw err;
      }

      let json;
      try { json = JSON.parse(bodyText); }
      catch (e) {
        const err = new Error('Karbon returned a non-JSON body');
        err.code = 'KARBON_NON_JSON';
        err.karbon = { status: response.status, body: bodyText.slice(0, 2000), url };
        throw err;
      }

      const batch = json.value || json.WorkItems || json.Items || [];
      items.push(...batch);
      // Short (or empty) page => we've reached the end of the collection.
      if (batch.length < PAGE_SIZE) break;
    }
    return items;
  }

  // Collect ALL work, then drop completed/cancelled items in the reshape loop.
  //
  // We sort by StartDate ASCENDING purely to give $skip a stable, deterministic
  // order to page through (so no item is skipped or seen twice across pages).
  // We do NOT sort descending: that put next-year's planned work first and, with
  // only the first page fetched, hid every overdue/current item.
  //
  // No server-side status filter is used: Karbon's WorkItems $filter only allows
  // eq/ge/le/and (NO "ne", NO "or"), so "PrimaryStatus ne 'Completed'" is illegal
  // and the active statuses can't be OR'd. We pull the whole list and filter
  // client-side — reliable and complete.
  const filteredUrl = KARBON_BASE + '/WorkItems' +
    '?$orderby=' + encodeURIComponent('StartDate') +
    '&$top=' + PAGE_SIZE;
  // Plain fallback in case Karbon ever rejects the $orderby with a 400.
  const plainUrl = KARBON_BASE + '/WorkItems?$top=' + PAGE_SIZE;

  let raw;
  let usedFallback = false;
  try {
    raw = await collect(filteredUrl);
  } catch (e) {
    if (e.code === 'BAD_REQUEST') {
      usedFallback = true;
      raw = await collect(plainUrl);
    } else {
      throw e;
    }
  }

  // Reshape + filter into the clean task objects the dashboard expects.
  const seen = new Set();
  const tasks = [];

  for (const it of raw) {
    const entity = String(it.EntityType ?? it.entityType ?? it.Type ?? 'work').toLowerCase();
    if (SECTION_LIKE.test(entity)) continue;

    const status = String(it.PrimaryStatus ?? it.SecondaryStatus ?? it.status ?? '').trim();
    if (DEAD_STATUS.test(status)) continue;

    const id = it.WorkItemKey ?? it.Key ?? it.Id ?? it.id ?? (it.Title ?? it.WorkType ?? '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);

    tasks.push({
      id,
      task: it.Title || it.WorkType || it.WorkTemplateTitle || 'Untitled',
      client: it.ClientName || it.PrimaryClientName || '',
      assignee: String(it.AssigneeName || it.AssignedToName || '').trim(),
      due: it.DueDate || it.DeadlineDate || null,
      // The WorkItemSummaryDTO has no "created" field; StartDate is the closest
      // proxy for when the work entered the schedule.
      added: it.WorkCreatedDate || it.CreatedDate || it.StartDate || null,
      hours: Number(it.ActualHours || it.LoggedHours || 0) || 0,
      status,
    });
  }

  if (opts.debug) {
    // Date audit: for every RAW item (active or not), surface the date fields
    // Karbon's work-overview columns could be keyed off, plus its statuses, so
    // we can see (a) whether we fetched everything and (b) which field marks an
    // item "due today" / "due this week" the way Karbon's columns do.
    const audit = raw.map(it => ({
      Title: it.Title || it.WorkType || it.WorkTemplateTile || '(untitled)',
      PrimaryStatus: it.PrimaryStatus ?? null,
      WorkStatus: it.WorkStatus ?? null,
      StartDate: it.StartDate ?? null,
      DueDate: it.DueDate ?? null,
      DeadlineDate: it.DeadlineDate ?? null,
      ToDoPeriod: it.ToDoPeriod ?? null,
    }));
    const isDead = s => DEAD_STATUS.test(String(s || ''));
    const activeAudit = audit.filter(a => !isDead(a.PrimaryStatus));
    return {
      tasks,
      _debug: {
        rawCount: raw.length,                 // how many work items we actually fetched
        activeCount: activeAudit.length,      // …of which are not completed/cancelled
        filteredCount: tasks.length,          // …that became dashboard tasks
        usedFallback: usedFallback,
        firstRawKeys: raw[0] ? Object.keys(raw[0]) : [],
        // Up to 120 active items with their candidate date fields, so we can see
        // exactly which date Karbon uses for Due Today / Due This Week.
        activeDateAudit: activeAudit.slice(0, 120),
      },
    };
  }

  return tasks;
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bearerToken = (process.env.KARBON_BEARER_TOKEN || '').trim();
  const accessKey = (process.env.KARBON_ACCESS_KEY || '').trim();

  // Non-secret fingerprint — confirms the env vars populated without leaking them.
  const fingerprint = {
    bearer_len: bearerToken.length,
    bearer_preview: bearerToken ? bearerToken.slice(0, 4) + '…' + bearerToken.slice(-4) : '(empty)',
    accessKey_len: accessKey.length,
    accessKey_preview: accessKey ? accessKey.slice(0, 4) + '…' + accessKey.slice(-4) : '(empty)',
  };

  try {
    const debug = /(?:[?&])debug=1\b/.test(req.url || '') ||
      (req.query && (req.query.debug === '1' || req.query.debug === 'true'));
    const result = await fetchKarbonTasks({ debug });
    res.setHeader('Cache-Control', 'no-store');
    if (debug) {
      return res.status(200).json({ count: result.tasks.length, ...result._debug });
    }
    return res.status(200).json({ count: result.length, tasks: result });
  } catch (error) {
    if (error.code === 'NO_CREDS') {
      return res.status(500).json({
        error: 'Karbon credentials missing at runtime',
        KARBON_BEARER_TOKEN_present: Boolean(bearerToken),
        KARBON_ACCESS_KEY_present: Boolean(accessKey),
        fingerprint,
      });
    }
    if (error.code === 'KARBON_ERROR' || error.code === 'KARBON_NON_JSON' || error.code === 'BAD_REQUEST') {
      const k = error.karbon || {};
      return res.status(k.status || 502).json({
        error: error.message,
        status: k.status || null,
        statusText: k.statusText || null,
        url: k.url || null,
        karbonResponse: k.body || null,
        sentHeaders: {
          Authorization: 'Bearer <token len ' + bearerToken.length + '>',
          AccessKey: '<key len ' + accessKey.length + '>',
        },
        fingerprint,
      });
    }
    console.error('Relay Error:', error && error.stack ? error.stack : error);
    return res.status(500).json({
      error: 'Relay crashed before/while contacting Karbon',
      detail: String(error && error.message ? error.message : error),
      name: error && error.name ? error.name : null,
      fingerprint,
    });
  }
}
