export default async function handler(req, res) {
    const authHeader = req.headers.authorization;
    const expectedSecret = `Bearer ${process.env.CRON_SECRET}`;

    if (authHeader !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const karbonUrl = 'https://api.karbonhq.com/v3/WorkItems'; 
        const karbonResponse = await fetch(karbonUrl, {
            headers: {
                'Authorization': `Bearer ${process.env.KARBON_BEARER_TOKEN}`,
                'X-Access-Key': process.env.KARBON_ACCESS_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (!karbonResponse.ok) throw new Error('Failed to fetch Karbon data');
        const tasks = await karbonResponse.json();

        const emailResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: process.env.FROM_EMAIL,
                to: [process.env.BOSS_EMAIL],
                subject: 'Your Weekly Karbon Summary',
                html: `
                    <h1>Weekly Karbon Report</h1>
                    <p>Here is your task summary for the week:</p>
                    <ul>
                        ${tasks.map(t => `<li>${t.title || t.name || 'Unnamed Task'} - ${t.status || 'N/A'}</li>`).join('')}
                    </ul>
                    <p>Have a great week!</p>
                `
            })
        });

        if (!emailResponse.ok) {
            const err = await emailResponse.text();
            throw new Error(`Resend error: ${err}`);
        }

        return res.status(200).json({ message: 'Email sent successfully!' });

    } catch (error) {
        console.error('Weekly job error:', error.message);
        return res.status(500).json({ error: error.message });
    }
}