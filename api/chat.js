// api/chat.js — OpenRouter Proxy
// API key disimpan di env Vercel, gak keliatan di browser

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const API_KEY = process.env.OPENROUTER_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({
      error: { message: 'OPENROUTER_API_KEY belum diset di environment variables Vercel.' }
    });
  }

  try {
    const { model, messages, temperature = 0.7, max_tokens = 2048 } = req.body || {};

    if (!model || !messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: 'Request tidak valid. Butuh: model (string) dan messages (array).' }
      });
    }

    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'HTTP-Referer': req.headers.referer || 'https://nexushub-ai.duckdns.org',
        'X-Title': 'NexusHUB AI'
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens })
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[proxy error]', err);
    return res.status(500).json({ error: { message: err.message || 'Internal server error' } });
  }
    }
