// api/chat.js — OpenRouter Proxy dengan timeout handling

export default async function handler(req, res) {
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
    const { model, messages, temperature = 0.7, max_tokens = 1024 } = req.body || {};

    if (!model || !messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: 'Request tidak valid. Butuh: model (string) dan messages (array).' }
      });
    }

    // Timeout 55 detik (kurang dari maxDuration 60s)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);

    let upstream;
    try {
      upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'HTTP-Referer': req.headers.origin || req.headers.referer || 'http://localhost',
          'X-Title': 'NexusHUB AI'
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens }),
        signal: controller.signal
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        return res.status(504).json({
          error: { message: 'AI butuh waktu lebih lama untuk membalas. Coba kirim pesan yang lebih singkat atau file yang lebih kecil.' }
        });
      }
      return res.status(502).json({
        error: { message: 'Gagal menghubungi server AI. Coba lagi.' }
      });
    }
    clearTimeout(timeoutId);

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: { message: data?.error?.message || `HTTP ${upstream.status}` }
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('[proxy error]', err);
    return res.status(500).json({
      error: { message: err.message || 'Internal server error' }
    });
  }
}
