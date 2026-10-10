// api/chat.js — OpenRouter multi-model proxy
// Mode:
//   model = "nexus-fast" | "nexus-reason" | ...  -> 1 model (alias), fallback otomatis
//   model = "auto"   -> routing bergantian: coba model satu per satu sampai ada yang berhasil
//   model = "fusion" -> semua model jawab bersamaan, lalu digabung jadi 1 jawaban final
// Nama model asli TIDAK pernah dikirim ke browser.

// Alias -> model asli. Daftar model gratis OpenRouter sering berganti,
// jadi bisa di-override lewat env MODEL_POOL (JSON), contoh:
// {"nexus-fast":"nvidia/nemotron-3.5-lightning:free","nexus-lite":"mistralai/mistral-nemo:free"}
const DEFAULT_POOL = {
  'nexus-fast': 'nvidia/nemotron-3.5-lightning:free',
  'nexus-reason': 'deepseek/deepseek-r1:free',
  'nexus-balanced': 'qwen/qwen-2.5-72b-instruct:free',
  'nexus-lite': 'mistralai/mistral-nemo:free',
  'nexus-flash': 'inclusionai/ling-3.1-flash'
};
const ROUTER_FALLBACK = 'openrouter/free'; // router OpenRouter: pilih model gratis yang aktif

function getPool() {
  try {
    if (process.env.MODEL_POOL) {
      const p = JSON.parse(process.env.MODEL_POOL);
      if (p && typeof p === 'object' && Object.keys(p).length) return p;
    }
  } catch { /* abaikan, pakai default */ }
  return DEFAULT_POOL;
}

const FUSION_SIZE = Math.max(2, parseInt(process.env.FUSION_SIZE || '4', 10));

function shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

function clean(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

// Panggil OpenRouter. modelIds = array (urut prioritas, OpenRouter fallback sendiri)
async function callOpenRouter({ apiKey, origin, modelIds, messages, temperature, max_tokens, timeoutMs }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': origin || 'http://nexushub-ai.duckdns.org',
        'X-Title': 'NexusHUB AI'
      },
      body: JSON.stringify({ models: modelIds, messages, temperature, max_tokens }),
      signal: controller.signal
    });
    let data = null;
    try { data = await r.json(); } catch { /* bukan JSON */ }
    if (!r.ok) {
      return { ok: false, status: r.status, error: data?.error?.message || `HTTP ${r.status}` };
    }
    const text = clean(data?.choices?.[0]?.message?.content);
    if (!text) return { ok: false, status: 502, error: 'Empty response' };
    return { ok: true, text };
  } catch (e) {
    return {
      ok: false,
      status: e.name === 'AbortError' ? 504 : 502,
      error: e.name === 'AbortError' ? 'timeout' : (e.message || 'network')
    };
  } finally {
    clearTimeout(t);
  }
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const c = messages[i].content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.filter(p => p?.type === 'text').map(p => p.text).join('\n');
    }
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'OPENROUTER_API_KEY belum diset di environment variables Vercel.' }
    });
  }

  try {
    const { model = 'auto', messages, temperature = 0.7, max_tokens = 1024 } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({
        error: { message: 'Request tidak valid. Butuh: messages (array).' }
      });
    }

    const origin = req.headers.origin || req.headers.referer;
    const pool = getPool();
    const aliases = Object.keys(pool);
    const started = Date.now();
    const remaining = (budgetMs) => Math.max(3000, Math.min(budgetMs, 56000 - (Date.now() - started)));
    const base = { apiKey, origin, temperature };

    const reply = (text, mode, used) =>
      res.status(200).json({
        choices: [{ message: { role: 'assistant', content: text } }],
        nexus: { mode, used }
      });

    // ---------- MODE: FUSION (semua model -> 1 jawaban) ----------
    if (model === 'fusion') {
      const picked = shuffle(aliases).slice(0, FUSION_SIZE);
      const draftTokens = Math.min(max_tokens, 900);

      const results = await Promise.all(
        picked.map(a =>
          callOpenRouter({
            ...base, messages, max_tokens: draftTokens,
            modelIds: [pool[a]], timeoutMs: remaining(26000)
          }).then(r => ({ alias: a, ...r }))
        )
      );
      const drafts = results.filter(r => r.ok);

      // Tidak ada yang berhasil -> router gratis sebagai penyelamat
      if (!drafts.length) {
        const r = await callOpenRouter({
          ...base, messages, max_tokens,
          modelIds: [ROUTER_FALLBACK], timeoutMs: remaining(25000)
        });
        if (r.ok) return reply(r.text, 'fusion', 1);
        const err = results.find(x => x.error)?.error || r.error;
        return res.status(r.status || 502).json({ error: { message: err } });
      }
      if (drafts.length === 1) return reply(drafts[0].text, 'fusion', 1);

      // Gabungkan jadi 1 jawaban
      const sys = messages.find(m => m.role === 'system')?.content || '';
      const question = lastUserText(messages);
      const merged = drafts
        .map((d, i) => `--- Draf ${i + 1} ---\n${d.text}`)
        .join('\n\n');

      const synthMessages = [
        {
          role: 'system',
          content:
            `${sys}\n\n` +
            `Tugasmu sekarang: kamu menerima beberapa draf jawaban untuk pertanyaan yang sama. ` +
            `Tulis SATU jawaban final yang terbaik: ambil poin paling akurat dan berguna dari semua draf, ` +
            `buang pengulangan dan bagian yang saling bertentangan atau meragukan, rapikan strukturnya. ` +
            `Gunakan bahasa yang sama dengan pengguna. Jangan menyebut kata "draf", model, ` +
            `atau proses penggabungan. Langsung tulis jawaban finalnya.`
        },
        { role: 'user', content: `Pertanyaan pengguna:\n${question}\n\n${merged}` }
      ];

      const synth = await callOpenRouter({
        ...base, messages: synthMessages, max_tokens,
        modelIds: [pool[drafts[0].alias], ROUTER_FALLBACK],
        timeoutMs: remaining(24000)
      });
      if (synth.ok) return reply(synth.text, 'fusion', drafts.length);

      // Penggabungan gagal -> pakai draf terpanjang
      const best = drafts.reduce((a, b) => (b.text.length > a.text.length ? b : a));
      return reply(best.text, 'fusion', drafts.length);
    }

    // ---------- MODE: AUTO (routing bergantian) ----------
    if (model === 'auto') {
      const order = shuffle(aliases);
      let lastErr = null;
      for (const a of order) {
        if (Date.now() - started > 42000) break;
        const r = await callOpenRouter({
          ...base, messages, max_tokens,
          modelIds: [pool[a]], timeoutMs: remaining(18000)
        });
        if (r.ok) return reply(r.text, 'auto', 1);
        lastErr = r;
        if (r.status === 401 || r.status === 403) break; // masalah API key, percuma lanjut
      }
      const r = await callOpenRouter({
        ...base, messages, max_tokens,
        modelIds: [ROUTER_FALLBACK], timeoutMs: remaining(15000)
      });
      if (r.ok) return reply(r.text, 'auto', 1);
      return res.status(r.status || lastErr?.status || 502).json({
        error: { message: r.error || lastErr?.error || 'Semua engine sedang sibuk.' }
      });
    }

    // ---------- MODE: SATU MODEL (alias) ----------
    const real = pool[model];
    if (!real) {
      return res.status(400).json({ error: { message: `Engine tidak dikenal: ${model}` } });
    }
    const r = await callOpenRouter({
      ...base, messages, max_tokens,
      modelIds: [real, ROUTER_FALLBACK], timeoutMs: remaining(55000)
    });
    if (r.ok) return reply(r.text, 'single', 1);
    return res.status(r.status || 502).json({ error: { message: r.error } });
  } catch (err) {
    console.error('[proxy error]', err);
    return res.status(500).json({ error: { message: err.message || 'Internal server error' } });
  }
}
