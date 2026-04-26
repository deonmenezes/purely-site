/**
 * POST /api/tiktok-image { tiktokId, productIdx, screen: 'scan'|'analysis'|'ingredients' }
 * Reads cached analysis, builds a detailed prompt for the requested screen, calls
 * OpenAI gpt-image-1, uploads PNG to Supabase Storage, returns public URL.
 *
 * Cache: each {tiktokId}/{productIdx}-{screen}.png is reused on repeat calls.
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');
const sharp = require('sharp');

async function cropTo916(buf) {
  try {
    const img = sharp(buf);
    const meta = await img.metadata();
    const w = meta.width || 1024;
    const h = meta.height || 1536;
    const targetH = Math.round(w * 16 / 9);
    if (targetH <= h) return buf;
    const { data } = await sharp(buf).extract({ left: 4, top: 4, width: 8, height: 8 })
      .raw().toBuffer({ resolveWithObject: true });
    const r = data[0], g = data[1], b = data[2];
    const totalPad = targetH - h;
    const top = Math.floor(totalPad / 2);
    const bottom = totalPad - top;
    return await sharp(buf).extend({
      top, bottom, left: 0, right: 0,
      background: { r, g, b, alpha: 1 }
    }).png().toBuffer();
  } catch { return buf; }
}

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
  const score = Number.isFinite(product.score) ? Math.max(0, Math.min(100, product.score)) : 70;
  const brand = (product.brand || '').trim();
  const name = (product.name || '').trim();
  const productId = brand && name && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : (name || brand || 'product');
  const visualHint = product.image_subject ? ` (visual cues: ${product.image_subject})` : '';
  const ingTop = (product.ingredients || []).slice(0, 8);

  // Match scoreColor.ts bands + label
  const scoreLabel = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 50 ? 'Okay' : score >= 30 ? 'Poor' : 'Avoid';
  const ringColor = score >= 80 ? '#1F8A4A (deep emerald)'
                  : score >= 65 ? '#5BA83A (lime green)'
                  : score >= 50 ? '#E0A52E (amber)'
                  : score >= 30 ? '#D86935 (red-orange)'
                  :               '#B24C4C (deep red)';
  const reportTag = score >= 75 ? '"Health report" with a small green check icon' : '"Toxin report" with a small red triangle warning icon';
  const category = (product.category || 'product').replace(/^./, (c) => c.toUpperCase());

  const PALETTE = `EXACT COLOR PALETTE — the entire screen MUST use these warm muted tones (do NOT use bright forest green, do NOT use pure white background):
- Canvas background: warm cream #F7F5F0 (off-white with beige cast)
- Cards/surfaces: pure white #FFFFFF
- Text primary: very dark warm-charcoal #1F1D1A (almost black)
- Text muted: warm gray #6B6762
- Text subtle: light warm gray #9B958D
- Hairline borders: warm pale gray #E3E0DA
- Accent / primary brand: DARK CHARCOAL-OLIVE #2F3A35 (deep muted green that reads almost black-green — NOT vibrant)
- Accent soft (pale pill bg): #E6ECE8
- Success green: #2F8A5B  ·  Warning amber: #C08A3E  ·  Danger red: #B24C4C
- Card shadow: extremely soft (~6% opacity, 18px blur, 8px y-offset)
- Card radius: 12px. Pill radius: 8px or full-pill. Hero card radius: 16px.`;

  const TYPOGRAPHY = `TYPOGRAPHY (Inter / SF Pro):
- Product name 24px bold  ·  Section titles 18px semibold  ·  Brand subtitle 16px medium muted
- Score number 32px bold  ·  Score label 14px medium muted  ·  Stat value 20px bold  ·  Stat label 12px medium muted
- Pills/badges 12px semibold uppercase tracked +0.4`;

  const COMMON = `${PALETTE}

${TYPOGRAPHY}

PRODUCT FIDELITY: The product is ${productId}${visualHint}. Render it EXACTLY as it looks in real life — actual packaging shape, real brand typography, real dominant colors, real characteristic motifs. If a known brand, use real-world packaging knowledge. Do NOT invent generic packaging. Do NOT change the product name or flavor.

OUTPUT: ONE photorealistic portrait iPhone screenshot at 1024x1536. iOS status bar at top with "9:41" + signal/wifi/battery in dark charcoal. Premium production iOS app. Generous vertical whitespace. NO Purely wordmark or logo header — the result screen has NO branding bar at the top. NO illustrations or sketches. Crisp pixel-faithful UI.`;

  if (screen === 'scan') {
    return `${COMMON}

SCREEN: Scan tab (camera viewfinder)
TOP ~62% of the screen is the LIVE iPhone camera feed — a candid in-aisle grocery-store capture:
- A real human hand at a natural angle gripping ${productId} casually (slight tilt, fingers visible, mild motion blur). Not staged, not centered.
- Behind: out-of-focus shelves with neighboring products, fluorescent supermarket lighting, real environmental shadows. Subtle glare on the package. NOT a studio shot.
- Product label/barcode clearly visible but framed organically.

UI overlay on the camera feed:
- Top bar: small back arrow (left) and small "?" help icon (right), each in a semi-transparent dark-charcoal rounded pill so they stay legible over the feed. Centered between them: light "Scan" title in white.
- Centered: four white corner brackets forming a rounded scan frame around the barcode. A thin pale-green horizontal scan line crosses inside.
- Below frame, white text with subtle drop shadow: "Scan the barcode on any product."

BOTTOM ~38% is the control area on warm cream #F7F5F0:
- Two pill toggle buttons centered horizontally: "Barcode" ACTIVE (filled dark charcoal-olive #2F3A35, white text) and "Photo" inactive (outlined warm-gray border, muted gray text).
- Below: a large 70px round white shutter button (thin warm-gray border + thin inner ring). To its LEFT, a small library/photo-gallery icon (rounded square outline). To its RIGHT, a small lightning/flash icon. All icons in dark charcoal #1F1D1A.

Camera feed reads as authentic iPhone capture; UI chrome is crisp and pixel-perfect on cream.`;
  }

  if (screen === 'analysis') {
    return `${COMMON}

SCREEN: Scan Result (Hero + Score)
A vertical iPhone screen on cream #F7F5F0 background. Single ScrollView, content arranged top-to-bottom EXACTLY:

1. Status bar at very top.

2. Top nav row: small back arrow (left) and small heart icon (right), both in muted warm gray #6B6762. No title text.

3. HERO IMAGE CARD — centered, 220×220 white #FFFFFF rounded card (16px radius) with very soft shadow. Inside the card: the actual ${productId} product photo, library-quality, centered with breathing room around it (NOT edge-to-edge, NOT cropped). White card sitting on cream canvas.

4. PRODUCT NAME: "${name || productId}" — 24px bold dark charcoal #1F1D1A, centered, 1-2 lines max.

5. BRAND SUBTITLE: "${brand}" — 16px medium muted #6B6762, centered, single line.

6. TAGS ROW — two pills centered horizontally with small gap:
   • Category pill: dark charcoal-olive #2F3A35 background, WHITE 12px medium text "${category}", radius 8px, padding 10x6.
   • Status pill: ${score >= 75 ? 'pale sage #E6ECE8 background' : 'soft cream #FAF8F4 background'}, with a small ${score >= 75 ? '#2F8A5B green check' : '#B24C4C red triangle'} icon at the left, then text ${reportTag.replace(/^"|"$/g, '"')} in 12px medium ${score >= 75 ? '#2F8A5B success green' : '#6B6762 muted gray'}.

7. SCORE RING — centered, generous spacing above (~24px). 102×102 SVG ring on cream:
   • Track: 7px stroke, color #E3E0DA pale warm gray, full circle.
   • Fill: 7px stroke, color ${ringColor}, rounded line caps, arc length covers exactly ${score}% of the circumference starting at 12 o'clock and going clockwise.
   • Inside: HUGE "${score}" centered in 32px bold dark charcoal #1F1D1A, then directly below "${scoreLabel}" in 14px medium muted gray.

8. STATS section: "Stats" 18px semibold left-aligned title with 20px horizontal padding. Below: a row of 3 equal-width white stat cards (12px radius, soft shadow, 16px internal padding). Each card centered: 20px bold value on top, 12px medium muted label below. Use these stats: "Score" / "${score}", "Ingredients" / "${ingTop.length || '—'}", "Status" / "${scoreLabel}".

9. Below stats, start of "Healthier alternatives" section title (18px semibold) with the top edges of 1-2 small horizontal product thumbnail cards visible (white, 12px radius, soft shadow). Cut off naturally at the bottom of the screen.

NO Purely logo. NO "Analysis Report" title. NO red→yellow→green gradient bar. NO "View Ingredients" button. The real Purely scan-result screen is a clean continuous scroll on cream with subtle warm-toned cards.`;
  }

  // ingredients screen — match the Ingredients section of ScanResultContent
  const ingItems = ingTop.length ? ingTop : [
    { name: 'Carbonated Water', label: 'Good', note: 'Base ingredient providing fizz and dilution.' },
    { name: 'Natural Flavor', label: 'Good', note: 'Plant-derived flavoring compound.' },
    { name: 'Citric Acid', label: 'Good', note: 'Common acidity regulator and preservative.' }
  ];
  const ingDescription = ingItems.map((x, i) => {
    const lbl = (x.label || '').toLowerCase();
    const status = /good/.test(lbl) ? 'BENEFICIAL (green)' : /avoid/.test(lbl) ? 'HARMFUL (red)' : 'NEUTRAL (gray)';
    return `Card ${i + 1}: name "${(x.name || '').slice(0, 40)}", status pill "${status}", snippet "${(x.note || '').slice(0, 90)}"`;
  }).join(' | ');

  return `${COMMON}

SCREEN: Scan Result (Ingredients section, scrolled into view)
A vertical iPhone screen on cream #F7F5F0 background. Top-to-bottom:

1. Status bar.

2. Top nav row: back arrow (left), heart icon (right) — small, muted warm gray.

3. Compact summary header: small thumbnail of ${productId} (40×40 rounded white card) on the left, product name "${name || productId}" 16px medium beside it, and on the far right a small score chip pill: filled with ${ringColor}, white text "${score} ${scoreLabel}".

4. Section title: "Ingredients" 18px semibold dark charcoal, left-aligned with 20px horizontal padding. Below it: small muted-gray subtitle "Tap any to learn more".

5. INGREDIENT LIST — vertical stack of full-width white cards (NOT a grid, NOT pills). Each card:
   • White #FFFFFF background, 12px corner radius, very soft shadow, 16px internal padding.
   • A 2px LEFT-EDGE colored border indicating ingredient status: green #2F8A5B for beneficial, red #B24C4C for harmful, warm pale-gray #E3E0DA for neutral. The OTHER three sides have no border.
   • LEFT column (flex 1): ingredient NAME in 16px medium dark charcoal; below it a 12px semibold UPPERCASE letter-spaced status word in the matching color (e.g., "BENEFICIAL", "HARMFUL", "NEUTRAL"); below that a 13px regular two-line snippet in muted gray #6B6762 explaining the ingredient.
   • RIGHT column (flex-end, vertically centered): an optional small soft-bg badge pill (e.g., percentage or "trace") in the matching status tint (light sage for green, faint rose for red, neutral cream for gray), then a small chevron-right icon in light gray #9B958D.

   Generate exactly ${ingItems.length} ingredient cards using this data — keep names and statuses unchanged: ${ingDescription}.

6. After the list, leave a small gap then show a single muted "Other info" subhead and the top edge of one white "Packaging" card. Cut off at screen bottom naturally.

NO Purely logo, NO filter pills row at the top, NO sage hero card with "We analyzed N ingredients". The real Purely ingredients view is a simple stack of bordered ingredient cards on cream with the running summary header above. Premium iOS production app — Apple-grade typography, generous spacing, subtle warm shadows.`;
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

    // v3 path: bumped because the prompt was rewritten to match the real
    // ScanResultContent UI exactly (cream canvas, charcoal-olive accent, no
    // Purely header). Old cached "v1/v2" images used the wrong palette.
    const path = `tiktok-analyses/${tiktokId}/${productIdx}-${screen}-v3.png`;
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

    // Text-only generation. We no longer attach the old mockup-reference.png
    // (it shows the wrong bright-green palette + Purely wordmark header which
    // do not appear in the real app). The new prompt fully describes the
    // result-screen layout from ScanResultContent.tsx.
    const aiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-image-1', prompt, size: '1024x1536', n: 1, quality: 'high'
      })
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      return bad(res, 502, `OpenAI ${aiRes.status}: ${t.slice(0, 240)}`);
    }
    const j = await aiRes.json();
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) return bad(res, 502, 'OpenAI returned no image');

    const rawBytes = Buffer.from(b64, 'base64');
    const bytes = await cropTo916(rawBytes);
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: 'image/png', upsert: true, cacheControl: '604800'
    });
    if (upErr) return bad(res, 500, 'storage upload: ' + upErr.message);

    return res.status(200).json({ url: publicUrl, cached: false });
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
