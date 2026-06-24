export default async function handler(req, res) {
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

    try {
        // IMPORTANT: Replace this URL with your actual Karbon endpoint if different
        const karbonUrl = 'https://api.karbonhq.com/v3/WorkItems'; 

        const response = await fetch(karbonUrl, {
            headers: {
                'Authorization': `Bearer ${process.env.KARBON_BEARER_TOKEN}`,
                'X-Access-Key': process.env.KARBON_ACCESS_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Karbon API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error('Relay Error:', error.message);
        return res.status(500).json({ error: 'Failed to fetch from Karbon relay' });
    }
}