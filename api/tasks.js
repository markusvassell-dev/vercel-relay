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

  if (!bearerToken || !accessKey) {
    return res.status(500).json({
      error: 'Karbon credentials missing',
      KARBON_BEARER_TOKEN_present: Boolean(bearerToken),
      KARBON_ACCESS_KEY_present: Boolean(accessKey),
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
  // Any status containing one of these words means the work is NOT active.
  const DEAD_STATUS = /complete|cancel|archiv|done|closed|deleted/i;
  // Row "types" that are PART of a work, not the whole work itself.
  const SECTION_LIKE = /section|checklist|subtask|step|task list/i;

  try {
    // Uses the exact internal endpoint with your Workspace ID
    const karbonUrl = 'https://app.karbonhq.com/todo/api/grt99qBcBs2/workViewListItems';

    const response = await fetch(karbonUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'X-Access-Key': accessKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      console.error(`Karbon API error (${response.status}): ${bodyText}`);
      return res.status(response.status).json({
        error: 'Karbon API rejected the request',
        status: response.status,
        karbonResponse: bodyText,
      });
    }

    const parsed = JSON.parse(bodyText);
    const rawRows = Array.isArray(parsed)
      ? parsed
      : (parsed.value || parsed.Items || parsed.WorkItems || parsed.data || parsed.rows || parsed.items || []);

    // Reshape + filter into the clean { tasks:[...] } the dashboard expects.
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
    console.error('Relay Error:', error.message);
    return res.status(500).json({ error: 'Relay crashed', detail: error.message });
  }
}
