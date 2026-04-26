/**
 * POST /api/analyze-product { imageUrl }
 * Sends the product photo to GPT-4o vision with Purely's ruthless scoring rubric.
 * Returns structured JSON used by the UI and the mockup generator.
 *
 * The image must already be hosted (e.g. uploaded via /api/sign-upload to Supabase).
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');
const { PURELY_RULES } = require('./_purely-prompt');
const crypto = require('crypto');

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);
const BUCKET = 'influencer-uploads';

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }

const SYSTEM_PROMPT = `${PURELY_RULES}

Return STRICT JSON in this exact shape — no prose, no markdown fences. Every field must be populated. Microplastics MUST have a real status (use the rule above; never default to "No data" for bottled water or other well-studied categories). Contaminants/harmful/beneficial arrays should reflect everything you know about this product, not just the visible label.
{
  "product": {
    "name": "string",
    "brand": "string or empty",
    "category": "water|food|supplement|clothing|cosmetic|personal-care|other",
    "subcategory": "short string e.g. 'Bottled Water', 'Protein Bar'",
    "image_subject": "concise visual description: shape, color, packaging style, label, container type",
    "package_color": "one word"
  },
  "score": 0-100 integer,
  "verdict": "Excellent | Good | Okay | Poor | Very Poor | Bad",
  "headline": "1 sentence summary of why the score is what it is",
  "harmfulCount": integer,
  "beneficialCount": integer,
  "microplastics": {
    "status": "Detected|Likely|Not Detected|No data available",
    "level": "string or empty",
    "context": "1 sentence",
    "source": "string"
  },
  "contaminants": [
    {
      "name": "string",
      "amount": "string with units (e.g. '0.006 mg/L') or 'Trace' or 'Detected'",
      "limit": "string with regulatory/health guideline limit",
      "limitSource": "EPA|WHO|California Prop 65|...",
      "status": "ABOVE | AT LIMIT | TRACE | NON-DETECT",
      "multiplier": "string e.g. '9× above EPA health guideline' or 'Below limit'",
      "concern": "1 sentence — what this does to the body",
      "source": "Named source (e.g. 'EWG Tap Water Database', 'Lead Safe Mama')"
    }
  ],
  "harmfulIngredients": [
    {
      "name": "ingredient",
      "reason": "why it's harmful, 1-2 sentences",
      "source": "named source if applicable"
    }
  ],
  "beneficialAttributes": [
    {
      "attribute": "string",
      "why": "1 sentence",
      "source": "named cert/source"
    }
  ],
  "sources": [
    { "name": "string", "description": "string", "url": "string or empty" }
  ],
  "breakdown": {
    "deductions": [ { "item": "string", "points": negative_integer } ],
    "additions": [ { "item": "string", "points": positive_integer } ]
  },
  "uiSummary": {
    "topAttributes": [
      { "label": "Flour quality | Oil quality | Water source | etc.", "value": "concise value", "verdict": "good|warn|bad" }
    ]
  }
}`;

function hashUrl(u) {
  return crypto.createHash('sha1').update(u).digest('hex').slice(0, 16);
}

async function fetchAsDataUrl(url, maxBytes = 8 * 1024 * 1024) {
  if (!url) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) return null;
    let ct = (r.headers.get('content-type') || 'image/jpeg').toLowerCase();
    if (!/^image\/(png|jpeg|jpg|webp|gif)/.test(ct)) ct = 'image/jpeg';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

async function readCache(id) {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(`product-analyses/${id}.json`);
    if (error) return null;
    return JSON.parse(await data.text());
  } catch { return null; }
}
async function saveCache(id, payload) {
  try {
    await supabase.storage.from(BUCKET).upload(`product-analyses/${id}.json`, JSON.stringify(payload, null, 2), {
      contentType: 'application/json', upsert: true, cacheControl: '60'
    });
  } catch (e) { /* non-fatal */ }
}

module.exports = async function handler(req, res) {
  if (!(await guard(req, res, { perMinute: 6, dailyKey: 'analyze-product', dailyMax: 200 }))) return;
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!OPENAI_API_KEY) return bad(res, 500, 'OPENAI_API_KEY not configured');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const imageUrl = String(body.imageUrl || '').trim();
    const refresh = !!body.refresh;
    if (!imageUrl) return bad(res, 400, 'imageUrl required');
    if (imageUrl.length > 1000) return bad(res, 400, 'imageUrl too long');

    const id = hashUrl(imageUrl);
    if (!refresh) {
      const cached = await readCache(id);
      if (cached) return res.status(200).json({ ...cached, cached: true });
    }

    const dataUrl = await fetchAsDataUrl(imageUrl);
    if (!dataUrl) return bad(res, 400, 'could not fetch image');

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: 'Analyze the product visible in this image. Be ruthless. Return strict JSON per the schema.' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
          ] }
        ]
      })
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      return bad(res, 502, `OpenAI ${aiRes.status}: ${t.slice(0, 240)}`);
    }
    const j = await aiRes.json();
    const content = j.choices?.[0]?.message?.content || '{}';
    let analysis;
    try { analysis = JSON.parse(content); }
    catch { return bad(res, 502, 'AI response was not valid JSON'); }

    const payload = {
      id,
      imageUrl,
      analysis,
      generatedAt: new Date().toISOString()
    };
    await saveCache(id, payload);
    return res.status(200).json(payload);
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
