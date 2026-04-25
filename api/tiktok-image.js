/**
 * POST /api/tiktok-image { tiktokId, productIdx, screen: 'scan'|'analysis'|'ingredients' }
 * Reads cached analysis, builds a detailed prompt for the requested screen, calls
 * OpenAI gpt-image-1, uploads PNG to Supabase Storage, returns public URL.
 *
 * Cache: each {tiktokId}/{productIdx}-{screen}.png is reused on repeat calls.
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);

const BUCKET = 'influencer-uploads';

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }

async function readAnalysis(id) {
  const { data, error } = await supabase.storage.from(BUCKET).download(`tiktok-analyses/${id}.json`);
  if (error) return null;
  return JSON.parse(await data.text());
}

function buildPrompt(product, screen) {
  const verdict = product.verdict || 'Good Choice';
  const score = Number.isFinite(product.score) ? product.score : 80;
  const subject = product.image_subject || `${product.brand ? product.brand + ' ' : ''}${product.name || 'product'}`;
  const color = product.image_color || 'green';
  const ingTop = (product.ingredients || []).slice(0, 8);
  const goodCount = ingTop.filter((x) => /good/i.test(x.label)).length;
  const watchCount = ingTop.filter((x) => /watch/i.test(x.label)).length;
  const avoidCount = ingTop.filter((x) => /avoid/i.test(x.label)).length;

  const common = `Photorealistic 9:19 iPhone 15 Pro screenshot, modern wellness app UI named "Purely". Clean white background. Soft natural shadows. Minimal modern sans-serif typography. Forest-green primary brand color (#2f7a47) with light sage accents (#eaf5ed). Status bar shows 9:41, full signal, full battery. Rounded corners. Realistic mobile app rendering, NOT a sketch.`;

  if (screen === 'scan') {
    return `${common}
Screen title at top: "Scan Product" with a back arrow on the left and a help icon on the right.
Subtitle: "Scan the barcode on any product".
A photorealistic hand holding a ${color} ${subject}, label visible. The product is centered with a corner-bracket scan frame around the barcode. A horizontal scanning line glows in green across the barcode.
At the bottom there are two segmented buttons: "Barcode" (selected, dark green pill) and "Photo" (outlined). Below them is a large round white shutter button with thin border. To the left, a small image-gallery icon. To the right, a small flash/lightning icon.
Background outside the phone: out-of-focus warm neutral.
Make it feel premium, exactly like a real app screenshot in a marketing carousel. No watermarks, no logos other than "Purely". No text outside the phone screen.`;
  }

  if (screen === 'analysis') {
    return `${common}
Screen title at top: "Analysis Report" with a back arrow on the left and a share icon on the right.
Top card: a small thumbnail image of "${subject}" on the left, product name on the right with a one-line subtitle (flavor or size). On the far right of the card, a circular ring badge showing "${score}" big and "${verdict}" below.
Section heading: "Health Score". One sentence: "Based on ingredients and nutritional value." A horizontal red→yellow→green gradient bar with a small triangle pointer near the ${score >= 70 ? 'right' : score >= 40 ? 'middle' : 'left'} end. Labels under the bar: "Poor" left, "Excellent" right.
Highlight card with leaf icon, headline "${verdict === 'Good Choice' ? 'This product is a better choice' : verdict === 'Watch Out' ? 'Some ingredients to watch' : 'Better swaps available'}" and a one-line summary.
"Report Summary" list of four rows with leading icons: Calories, Sugars, Sodium, Additives — each with a value and a small green/yellow/red pill on the right.
Big primary green pill button at the bottom: "View Ingredients →".
Make it look like a polished iOS production app. No real brand logos. No text "Purely" inside the screen except optionally as the app brand top-left if natural.`;
  }

  // ingredients
  return `${common}
Screen title at top: "Ingredients" with a back arrow on the left.
Top hero card with light sage background, a leaf-flask icon on the right, headline "We analyzed ${ingTop.length || 10} ingredients" and subtext "Tap any ingredient to learn more".
Filter pills row: "All (${ingTop.length || 10})" selected (dark green), "Good (${goodCount})" green outline, "Watch Out (${watchCount})" amber outline, "Avoid (${avoidCount})" red outline.
A vertical list of ingredient rows. Each row: ingredient name on the left, a one-line role under it, a small colored pill on the right ("Good" green, "Watch Out" amber, "Avoid" red), and a chevron. Use these specific entries: ${ingTop.map((x) => `"${(x.name || '').slice(0, 36)} — ${(x.note || x.label || '').slice(0, 30)} [${x.label}]"`).join(', ') || '"Carbonated Water — Base ingredient [Good]", "Natural Flavor — flavoring [Good]", "Citric Acid — acidity regulator [Good]", "Stevia Leaf Extract — natural sweetener [Watch Out]", "Sucralose — artificial sweetener [Avoid]"'}.
Bottom info card: "Want to learn more about ingredients? Tap any ingredient above to get detailed information." with an info icon.
Polished real iOS app look. No brand logos other than "Purely".`;
}

module.exports = async function handler(req, res) {
  if (!(await guard(req, res, { perMinute: 12, dailyKey: 'tiktok-image', dailyMax: 600 }))) return;
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!OPENAI_API_KEY) return bad(res, 500, 'OPENAI_API_KEY not configured');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const tiktokId = String(body.tiktokId || '').trim();
    const productIdx = Number(body.productIdx);
    const screen = String(body.screen || 'scan').toLowerCase();
    if (!tiktokId || !Number.isInteger(productIdx) || !['scan', 'analysis', 'ingredients'].includes(screen)) {
      return bad(res, 400, 'tiktokId, productIdx, screen required');
    }

    const path = `tiktok-analyses/${tiktokId}/${productIdx}-${screen}.png`;
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;

    if (!body.refresh) {
      const head = await fetch(publicUrl, { method: 'HEAD' });
      if (head.ok) return res.status(200).json({ url: publicUrl, cached: true });
    }

    const analysis = await readAnalysis(tiktokId);
    if (!analysis) return bad(res, 404, 'analysis not found — run /api/tiktok-analyze first');
    const product = analysis.analysis?.products?.[productIdx];
    if (!product) return bad(res, 404, `no product at index ${productIdx}`);

    const prompt = buildPrompt(product, screen);

    const aiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        size: '1024x1536',
        n: 1,
        quality: 'high'
      })
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      return bad(res, 502, `OpenAI ${aiRes.status}: ${t.slice(0, 240)}`);
    }
    const j = await aiRes.json();
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) return bad(res, 502, 'OpenAI returned no image');

    const bytes = Buffer.from(b64, 'base64');
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: 'image/png', upsert: true, cacheControl: '604800'
    });
    if (upErr) return bad(res, 500, 'storage upload: ' + upErr.message);

    return res.status(200).json({ url: publicUrl, cached: false });
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
