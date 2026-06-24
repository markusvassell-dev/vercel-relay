export default async function handler(req, res) {
  // --- CORS ---
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- Read credentials, trimming stray whitespace from copy-paste ---
  // A trailing newline pasted into Vercel is the #1 cause of "key looks right
  // but Karbon says it's missing". .trim() removes it.
  const bearerToken = (process.env.KARBON_BEARER_TOKEN || '').trim();
  const accessKey = (process.env.KARBON_ACCESS_KEY || '').trim();

  // --- Fail loudly if a credential never reached this deployment at runtime ---
  // If either of these is false, the env var is NOT attached to the running
  // build. Add it in Vercel, then REDEPLOY (env vars only bind to deployments
  // created after they are added).
  if (!bearerToken || !accessKey) {
    return res.status(500).json({
      error: 'Karbon credentials missing at runtime',
      KARBON_BEARER_TOKEN_present: Boolean(bearerToken),
      KARBON_ACCESS_KEY_present: Boolean(accessKey),
    });
  }

  try {
    const karbonUrl = 'https://api.karbonhq.com/v3/WorkItems';

    const response = await fetch(karbonUrl, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'AccessKey': accessKey,
        'Content-Type': 'application/json',
      },
    });

    // Read the body once as text so we can show it on error OR parse it on success.
    const bodyText = await response.text();

    if (!response.ok) {
      // DEBUG: surfaces Karbon's actual error to the browser instead of a
      // generic message. Once this endpoint works, replace the body below with
      // a generic message — /api/tasks is public.
      console.error(`Karbon API error (${response.status}): ${bodyText}`);
      return res.status(response.status).json({
        error: 'Karbon API rejected the request',
        status: response.status,
        karbonResponse: bodyText,
      });
    }

    const data = JSON.parse(bodyText);
    return res.status(200).json(data);
  } catch (error) {
    console.error('Relay Error:', error.message);
    return res.status(500).json({ error: 'Relay crashed', detail: error.message });
  }
}