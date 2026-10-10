export default async function handler(req, res) {
  const { q } = req.query;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!q) return res.status(400).json({ error: 'Missing q' });

  const KEY = process.env.TAVILY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Missing key' });

  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: KEY,
        query: q,
        max_results: 3,
        search_depth: 'basic'
      })
    });
    const data = await r.json();
    const context = (data.results || [])
      .map(x => `• ${x.title}: ${x.content?.slice(0, 400)}`)
      .join('\n\n');
    return res.status(200).json({ context, results: data.results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}