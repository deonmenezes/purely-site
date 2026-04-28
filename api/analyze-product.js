/**
 * POST /api/analyze-product { imageUrl, refresh }
 *
 * Server-side OCR via gpt-5-nano vision (cheap, fast — ~$0.0001/scan).
 * The model reads the label and returns structured fields (brand, name,
 * type, keywords) which we use to look up the real product in
 * huge_dataset.items_full. Returns the curated DB row mapped to the
 * AnalyzedProduct shape (real score, real ingredients, real nutrients,
 * mirrored image). If no DB match, returns a structured "no_match"
 * payload so the UI can show a helpful message.
 *
 * No GPT analysis — gpt-5-nano is used ONLY for label-text extraction.
 * All scoring/ingredients/nutrients come from the curated catalog.
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');
const dbLookup = require('./_db-lookup');
const crypto = require('crypto');

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OCR_MODEL = (process.env.OCR_MODEL || 'gpt-5-nano').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);
const BUCKET = 'influencer-uploads';

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }
function hashUrl(u) { return crypto.createHash('sha1').update(u).digest('hex').slice(0, 16); }

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
  } catch { /* non-fatal */ }
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

const OCR_SYSTEM_PROMPT = `You are a product-label reader. Look at the photo and return ONLY a JSON object describing what is printed on the label — exactly as written. Do not analyze, do not judge, do not invent fields. If you cannot read something, leave it empty.

Return this exact shape:
{
  "brand": "the brand name as it appears, exactly (e.g. \\"Kirkland Signature\\", \\"siggi's\\", \\"FIJI\\")",
  "name": "the product name (variant, flavor, type) as printed (e.g. \\"Ultra-Filtered Reduced Fat Milk\\", \\"Strawberry Skyr\\")",
  "type": "best one-word category guess (water, milk, yogurt, cereal, bar, supplement, soda, juice, snack, shampoo, cleaner, etc.)",
  "keywords": ["3-6 distinctive search words from the label, lowercase, no stopwords"],
  "barcode": "the UPC/EAN digits if visible, else empty",
  "confidence": "high|medium|low"
}`;

async function extractProductInfo(dataUrl) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OCR_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: OCR_SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: 'Read the product label and return the JSON.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
        ] }
      ]
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OCR ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(content); }
  catch { return {}; }
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

    // 1. Fetch image + 2. Run gpt-5-nano OCR
    const dataUrl = await fetchAsDataUrl(imageUrl);
    if (!dataUrl) return bad(res, 400, 'could not fetch image');

    let extracted = {};
    try { extracted = await extractProductInfo(dataUrl); }
    catch (e) {
      console.warn('[analyze-product] OCR failed:', e.message);
      // OCR failure is fatal — we have nothing to search with.
      return bad(res, 502, `Label read failed: ${e.message.slice(0, 120)}`);
    }

    // 3. Build a focused search text from brand + name + keywords. Skip the
    // type token — it's a category, not a distinctive search term.
    const searchText = [
      extracted.brand || '',
      extracted.name || '',
      ...(Array.isArray(extracted.keywords) ? extracted.keywords : [])
    ].filter(Boolean).join(' ').trim();

    // 4. DB lookup. Barcode hits are deterministic — try that first if we got one.
    let item = null;
    if (extracted.barcode && /^\d{8,14}$/.test(extracted.barcode)) {
      try { item = await dbLookup.findByBarcode(extracted.barcode); }
      catch (e) { console.warn('[analyze-product] barcode lookup failed:', e.message); }
    }
    if (!item && searchText) {
      try { item = await dbLookup.findItem(searchText); }
      catch (e) { console.warn('[analyze-product] db lookup failed:', e.message); }
    }

    if (item) {
      const analysis = dbLookup.buildAnalysisFromItem(item);
      const payload = {
        id,
        imageUrl: item.mirrored_image || item.transparent_image || item.image || imageUrl,
        originalImageUrl: imageUrl,
        analysis,
        generatedAt: new Date().toISOString(),
        source: 'huge_dataset',
        matchedItemId: item.id,
        matchedName: item.name,
        matchedScore: item._matchScore,
        ocrExtracted: extracted
      };
      await saveCache(id, payload);
      return res.status(200).json(payload);
    }

    const noMatchPayload = {
      id,
      imageUrl,
      originalImageUrl: imageUrl,
      analysis: null,
      generatedAt: new Date().toISOString(),
      source: 'no_match',
      reason: searchText
        ? `Read "${[extracted.brand, extracted.name].filter(Boolean).join(' — ').slice(0, 80)}" off the label, but no match in the Purely database.`
        : 'Could not read clear product info from the photo. Try a closer shot of the label.',
      ocrExtracted: extracted
    };
    await saveCache(id, noMatchPayload);
    return res.status(200).json(noMatchPayload);
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
