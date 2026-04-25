/**
 * POST /api/tiktok-image { tiktokId, productIdx, screen: 'scan'|'analysis'|'ingredients' }
 * Reads cached analysis, builds a detailed prompt for the requested screen, calls
 * OpenAI gpt-image-1, uploads PNG to Supabase Storage, returns public URL.
 *
 * Cache: each {tiktokId}/{productIdx}-{screen}.png is reused on repeat calls.
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');
const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

// Load the reference mockup once on cold start. This image shows the exact
// Purely UI style we want every generation to match: scan / analysis / ingredients.
let _referenceBytes = null;
function getReferenceBytes() {
  if (_referenceBytes) return _referenceBytes;
  try {
    const p = path.join(process.cwd(), 'assets', 'mockup-reference.png');
    _referenceBytes = fs.readFileSync(p);
  } catch (e) {
    _referenceBytes = null;
  }
  return _referenceBytes;
}
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
  const brand = (product.brand || '').trim();
  const name = (product.name || '').trim();
  const productId = brand && name && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : (name || brand || 'product');
  const visualHint = product.image_subject ? ` (visual cues: ${product.image_subject})` : '';
  const ingTop = (product.ingredients || []).slice(0, 8);
  const goodCount = ingTop.filter((x) => /good/i.test(x.label)).length;
  const watchCount = ingTop.filter((x) => /watch/i.test(x.label)).length;
  const avoidCount = ingTop.filter((x) => /avoid/i.test(x.label)).length;

  // Strict description of the Purely logo so the model renders it consistently
  const PURELY_BRAND = `BRAND IDENTITY (REQUIRED, must appear visibly at the top-left of the phone screen):
- Logo: three identical dark forest-green (#2f7a47) curved petal/leaf shapes arranged in a 120-degree rotational pinwheel pattern that visually suggests the letter "P" or a propeller. Each petal has a subtle highlight on its rounded edge and a soft inner shadow. The logo sits inside a soft rounded-square white tile.
- Wordmark: the word "Purely" in a clean modern semibold sans-serif (similar to Inter/SF Pro), in the same dark forest green, kerned tightly, set immediately to the right of the logo.
- The logo+wordmark together should occupy roughly 22% of the screen width and sit at the very top of the screen UI (just under the status bar).
- The Purely logo must be the ONLY brand identity shown; no other app logos.`;

  const common = `STYLE TEMPLATE: The attached reference image shows the EXACT visual style of the Purely iOS app across 3 screens (Scan Product, Analysis Report, Ingredients). Match the reference EXACTLY — same typography (modern sans-serif), same forest-green primary color (#2f7a47), same light sage accents (#eaf5ed), same card shapes, same rounded-corner radii, same status bar treatment (9:41 + signal/wifi/battery), same "Purely" wordmark placement at the top of the screen, same icon style, same spacing, same shadows. Output ONE single 9:19 iPhone screenshot at 1024x1536, photorealistic premium app rendering, NOT an illustration or sketch.

${PURELY_BRAND}

PRODUCT FIDELITY (CRITICAL): The product depicted is ${productId}${visualHint}. Render the product EXACTLY as it actually looks in the real world — same packaging shape, same can/bottle/box silhouette, same brand typography style, same dominant colors, same characteristic visual motifs from real life. Do NOT invent a generic product. Do NOT change the product name or flavor. If the product is a well-known brand, use your knowledge of its real-world packaging.`;

  if (screen === 'scan') {
    return `${common}

SCREEN: Scan Product
- Below the Purely logo strip, a centered screen title "Scan Product" with a back arrow on the left and a help/question icon on the right.
- Subtitle line: "Scan the barcode on any product".
- A photorealistic hand entering from the right, holding the actual ${productId} product. The product label and barcode are clearly visible.
- Corner-bracket scan frame (white, thick) sits around the visible barcode region. A horizontal green laser scan line crosses the barcode.
- Bottom UI: two pill buttons — "Barcode" selected (dark forest green pill, white text), "Photo" outlined gray. Below, a large round white shutter button with thin border, a small image-gallery icon to its left, and a small lightning/flash icon to its right.
- Out-of-focus warm grocery-store background visible outside the phone frame.
Make it feel exactly like a polished App Store screenshot. No watermarks. No text outside the phone.`;
  }

  if (screen === 'analysis') {
    return `${common}

SCREEN: Analysis Report
- Screen title centered: "Analysis Report" with a back arrow on the left and a share icon on the right.
- Top product card: a small photorealistic thumbnail of the actual ${productId} product (matching real-life packaging) on the left, the product name "${name || productId}" set in semibold on the right, a one-line subtitle below (e.g., flavor or size). On the far right of the card, a circular ring badge showing the big number "${score}" with "${verdict}" beneath it.
- Section heading: "Health Score". Caption: "Based on ingredients and nutritional value."
- A horizontal red→yellow→green gradient bar with a small triangle pointer near the ${score >= 70 ? 'right (green) end' : score >= 40 ? 'middle (yellow)' : 'left (red) end'}. Labels: "Poor" left, "Excellent" right.
- Highlight card with leaf icon and headline: "${verdict === 'Good Choice' ? 'This product is a better choice' : verdict === 'Watch Out' ? 'Some ingredients to watch' : 'Better swaps available'}" with a one-line supporting sentence.
- "Report Summary" four rows with leading icons: Calories, Sugars, Sodium, Additives — each with a numeric value on the right and a small green/yellow/red pill labeled Good/Watch Out/Avoid.
- Bottom: a wide forest-green pill button "View Ingredients →".
Premium iOS production app look. The Purely logo+wordmark must be visible at the top of the screen.`;
  }

  // ingredients
  const fallbackIng = '"Carbonated Water — Base ingredient [Good]", "Natural Flavor — flavoring [Good]", "Citric Acid — acidity regulator [Good]", "Stevia Leaf Extract — natural sweetener [Watch Out]", "Sucralose — artificial sweetener [Avoid]"';
  return `${common}

SCREEN: Ingredients (for the product ${productId})
- Screen title centered: "Ingredients" with a back arrow on the left.
- Hero card with light sage background, a leaf-in-flask icon on the right, headline "We analyzed ${ingTop.length || 10} ingredients", subtext "Tap any ingredient to learn more".
- Filter pills row: "All (${ingTop.length || 10})" selected (filled dark forest green), "Good (${goodCount})" green outline, "Watch Out (${watchCount})" amber outline, "Avoid (${avoidCount})" red outline.
- A vertical list of ingredient rows. Each row: ingredient name (semibold) on the left, a one-line role/category subtitle below, a small colored pill on the right ("Good" green, "Watch Out" amber, "Avoid" red), and a right chevron. Use these specific ingredient entries (do not change them): ${ingTop.map((x) => `"${(x.name || '').slice(0, 40)} — ${(x.note || x.label || '').slice(0, 36)} [${x.label}]"`).join(', ') || fallbackIng}.
- Bottom info card with info icon: "Want to learn more about ingredients? Tap any ingredient above to get detailed information."
Premium iOS production app look. The Purely logo+wordmark must be visible at the top of the screen.`;
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
    const refBytes = getReferenceBytes();

    let aiRes;
    if (refBytes) {
      // Use /v1/images/edits with the reference mockup so the generated image
      // matches the exact Purely UI style (3-phone mockup template).
      const fd = new FormData();
      fd.append('model', 'gpt-image-1');
      fd.append('prompt', prompt);
      fd.append('size', '1024x1536');
      fd.append('n', '1');
      fd.append('quality', 'high');
      fd.append('image', new Blob([refBytes], { type: 'image/png' }), 'reference.png');
      aiRes = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: fd
      });
    } else {
      // Fallback: text-only generation if reference not bundled
      aiRes = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: 'gpt-image-1', prompt, size: '1024x1536', n: 1, quality: 'high'
        })
      });
    }
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
