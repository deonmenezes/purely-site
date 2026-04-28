/**
 * POST /api/analyze-product { imageUrl, ocrText, refresh }
 *
 * Looks up the product in the huge_dataset Supabase project using OCR text
 * extracted client-side by Tesseract.js. Returns the curated DB row mapped
 * to the AnalyzedProduct shape (real score, real ingredients, real nutrients,
 * mirrored image). If no DB match, returns a structured "no_match" payload
 * — no OpenAI fallback. The UI renders a "not in our database yet" message
 * for unmatched products.
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');
const dbLookup = require('./_db-lookup');
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);
const BUCKET = 'influencer-uploads';

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }

function hashUrl(u) {
  return crypto.createHash('sha1').update(u).digest('hex').slice(0, 16);
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

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const imageUrl = String(body.imageUrl || '').trim();
    const ocrText = String(body.ocrText || '').trim().slice(0, 4000);
    const refresh = !!body.refresh;
    if (!imageUrl) return bad(res, 400, 'imageUrl required');
    if (imageUrl.length > 1000) return bad(res, 400, 'imageUrl too long');

    const id = hashUrl(imageUrl);
    if (!refresh) {
      const cached = await readCache(id);
      if (cached) return res.status(200).json({ ...cached, cached: true });
    }

    // DB-only: every product analysis comes from the curated huge_dataset
    // catalog. No GPT fallback, no fabricated data.
    let item = null;
    if (ocrText) {
      try { item = await dbLookup.findItem(ocrText); }
      catch (e) { console.warn('[analyze-product] db lookup failed:', e.message); }
    }

    if (item) {
      const analysis = dbLookup.buildAnalysisFromItem(item);
      const payload = {
        id,
        // Prefer the Supabase-hosted mirrored image (no CORS, edge-cached)
        // over the third-party live-oasis.com URLs.
        imageUrl: item.mirrored_image || item.transparent_image || item.image || imageUrl,
        originalImageUrl: imageUrl,
        analysis,
        generatedAt: new Date().toISOString(),
        source: 'huge_dataset',
        matchedItemId: item.id,
        matchedName: item.name,
        matchedScore: item._matchScore
      };
      await saveCache(id, payload);
      return res.status(200).json(payload);
    }

    // No match in the curated catalog. Return a structured payload the UI
    // can render as "Couldn't find this product yet — try a clearer label
    // photo, or this brand isn't in our database."
    const noMatchPayload = {
      id,
      imageUrl,
      originalImageUrl: imageUrl,
      analysis: null,
      generatedAt: new Date().toISOString(),
      source: 'no_match',
      reason: ocrText
        ? 'No product in the Purely database matched the label text we read.'
        : 'No label text could be read from the photo. Try a clearer shot.',
      ocrText: ocrText || ''
    };
    // Cache no-match results too so re-uploading the same photo doesn't
    // re-run OCR and DB lookup.
    await saveCache(id, noMatchPayload);
    return res.status(200).json(noMatchPayload);
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
