export default async function handler(req, res) {
  // --- Auth gate: only Vercel Cron may trigger this ---
  // Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on scheduled
  // runs and when you press the "Run" button. Opening this URL in a browser sends
  // no secret, so it will (correctly) return 401 — test with "Run", not the URL.
  const authHeader = req.headers.authorization;
  const expectedSecret = `Bearer ${process.env.CRON_SECRET}`;

  if (authHeader !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- Read + trim everything the job needs (strips stray paste whitespace) ---
  const bearerToken = (process.env.KARBON_BEARER_TOKEN || '').trim();
  const accessKey = (process.env.KARBON_ACCESS_KEY || '').trim();
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const fromEmail = (process.env.FROM_EMAIL || '').trim();
  const toEmail = (process.env.BOSS_EMAIL || '').trim();

  // --- Fail loudly, naming exactly what's missing at runtime ---
  const missing = [];
  if (!bearerToken) missing.push('KARBON_BEARER_TOKEN');
  if (!accessKey) missing.push('KARBON_ACCESS_KEY');
  if (!resendKey) missing.push('RESEND_API_KEY');
  if (!fromEmail) missing.push('FROM_EMAIL');
  if (!toEmail) missing.push('BOSS_EMAIL');
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Required environment variables missing at runtime',
      missing,
    });
  }

  try {
    // --- 1. Pull work items from Karbon ---
    const karbonUrl = 'https://api.karbonhq.com/v3/WorkItems';
    const karbonResponse = await fetch(karbonUrl, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'AccessKey': accessKey,
        'Content-Type': 'application/json',
      },
    });

    const karbonText = await karbonResponse.text();
    if (!karbonResponse.ok) {
      // Surface Karbon's real words instead of a generic message
      throw new Error(`Karbon API error (${karbonResponse.status}): ${karbonText}`);
    }

    // Karbon list endpoints return an OData envelope: { value: [...] }, NOT a
    // bare array. Pulling .value out keeps .map() from crashing the email build.
    const parsed = JSON.parse(karbonText);
    const tasks = Array.isArray(parsed) ? parsed : (parsed.value || []);

    // --- 2. Build + send the weekly summary via Resend ---
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: 'Your Weekly Karbon Summary',
        html: `
          <h1>Weekly Karbon Report</h1>
          <p>Here is your task summary for the week:</p>
          <ul>
            ${tasks.map(t => `<li>${t.title || t.name || 'Unnamed Task'} - ${t.status || 'N/A'}</li>`).join('')}
          </ul>
          <p>Have a great week!</p>
        `,
      }),
    });

    if (!emailResponse.ok) {
      const err = await emailResponse.text();
      throw new Error(`Resend error (${emailResponse.status}): ${err}`);
    }

    return res.status(200).json({
      message: 'Email sent successfully!',
      taskCount: tasks.length,
    });
  } catch (error) {
    console.error('Weekly job error:', error.message);
    return res.status(500).json({ error: 'Weekly job failed', detail: error.message });
  }
}