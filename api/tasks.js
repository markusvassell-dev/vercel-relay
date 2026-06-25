export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bearerToken = (process.env.KARBON_BEARER_TOKEN || '').trim();
  const accessKey = (process.env.KARBON_ACCESS_KEY || '').trim();

  // Non-secret fingerprint so you can confirm the env vars actually populated
  // WITHOUT leaking the values. A length of 0 here = the var never reached this
  // deployment (add it in Vercel, then REDEPLOY — env vars only bind to builds
  // created after they're added). Whitespace-only paste is the #1 silent 401.
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

  // THE EXACT REQUEST KARBON'S OWN "WORK" TAB USES
  // This asks for the active Work view, 100 per page.
  const requestPayload = {
    listSortBy: "name",
    sortDescending: false,
    showCompletedColumns: false,
    modelPath: "data",
    perPage: 100,
    status: [],
    impliedStatus: [],
    take: 100,
    skip: 0,
  };

  // --- Filters that enforce "active whole works only" ---
  const DEAD_STATUS = /complete|cancel|archiv|done|closed|deleted/i;
  const SECTION_LIKE = /section|checklist|subtask|step|task list/i;

  // Keep the URL EXACTLY as provided (Workspace ID grt99qBcBs2).
  const karbonUrl = 'https://app.karbonhq.com/todo/api/grt99qBcBs2/workViewListItems';

  try {
    const response = await fetch(karbonUrl, {
      method: 'POST',
      headers: {
        // Verified exactly as requested:
        'Authorization': 'Bearer ' + process.env.KARBON_BEARER_TOKEN,
        'X-Access-Key': process.env.KARBON_ACCESS_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    // Read the raw body ONCE as text so we can surface it verbatim on error
    // or parse it on success.
    const bodyText = await response.text();

    // Collect Karbon's response headers — for a 401, 'www-authenticate' usually
    // spells out the reason (e.g. invalid_token, expired, missing AccessKey).
    const karbonHeaders = {};
    response.headers.forEach((v, k) => { karbonHeaders[k] = v; });

    if (!response.ok) {
      console.error(`Karbon API error (${response.status} ${response.statusText}): ${bodyText}`);
      // Surface EVERYTHING Karbon told us, raw, into the browser Response tab.
      return res.status(response.status).json({
        error: 'Karbon API rejected the request',
        status: response.status,
        statusText: response.statusText,
        url: karbonUrl,
        karbonResponse: bodyText,            // <-- the exact message Karbon sent
        wwwAuthenticate: karbonHeaders['www-authenticate'] || null,
        karbonHeaders,
        sentHeaders: {
          Authorization: 'Bearer <token len ' + bearerToken.length + '>',
          'X-Access-Key': '<key len ' + accessKey.length + '>',
        },
        fingerprint,
      });
    }

    // Success — parse and reshape.
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (e) {
      // 200 but not JSON (e.g. an HTML login page returned by an internal route)
      return res.status(502).json({
        error: 'Karbon returned a non-JSON body (often an HTML login page — this internal endpoint may require a browser session, not a token)',
        url: karbonUrl,
        karbonResponse: bodyText.slice(0, 2000),
        fingerprint,
      });
    }

    const rawRows = Array.isArray(parsed)
      ? parsed
      : (parsed.value || parsed.Items || parsed.WorkItems || parsed.data || parsed.rows || parsed.items || []);

    const seen = new Set();
    const tasks = [];

    for (const it of rawRows) {
      // 1) WHOLE WORKS ONLY — skip section / checklist / subtask rows.
      const entity = String(it.entityType ?? it.type ?? it.kind ?? it.rowType ?? 'work').toLowerCase();
      if (SECTION_LIKE.test(entity)) continue;

      // 2) ACTIVE ONLY — skip completed / canceled / archived work.
      const status = String(
        it.status ?? it.Status ?? it.primaryStatus ?? it.PrimaryStatus ?? it.impliedStatus ?? ''
      ).trim();
      if (DEAD_STATUS.test(status)) continue;

      // 3) De-dupe so each whole work appears once.
      const id = it.id ?? it.Id ?? it.workItemId ?? it.permaKey ?? it.key ?? (it.title ?? it.Title ?? it.name ?? '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);

      tasks.push({
        id,
        task: it.title ?? it.task ?? it.Title ?? it.name ?? 'Untitled',
        client: it.client ?? it.clientName ?? it.ClientName ?? it.primaryClientName ?? '',
        assignee: String(it.assignee ?? it.assigneeName ?? it.AssigneeName ?? it.assignedTo ?? '').trim(),
        due: it.dueDate ?? it.due ?? it.DueDate ?? it.deadline ?? it.DeadlineDate ?? null,
        added: it.added ?? it.createdDate ?? it.WorkCreatedDate ?? it.createdAt ?? null,
        hours: Number(it.loggedHours ?? it.hours ?? it.LoggedHours ?? it.actualHours ?? 0) || 0,
        status,
      });
    }

    return res.status(200).json({ count: tasks.length, tasks });
  } catch (error) {
    // Network / DNS / TLS / unexpected crash — surface the raw message + stack.
    console.error('Relay Error:', error && error.stack ? error.stack : error);
    return res.status(500).json({
      error: 'Relay crashed before/while contacting Karbon',
      detail: String(error && error.message ? error.message : error),
      name: error && error.name ? error.name : null,
      url: karbonUrl,
      fingerprint,
    });
  }
}
