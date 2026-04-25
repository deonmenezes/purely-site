/**
 * POST /api/product-image { analysisId, screen }
 * screen ∈ summary | inside | detail | toxin
 * Generates one mockup screen using gpt-image-1 with the Purely product references.
 * Caches each PNG at product-analyses/{id}/{screen}.png in Supabase Storage.
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/**
 * Make the image 9:16 by PADDING (never cropping). Sample the corner pixel
 * to detect the app's background color and use it for the new top/bottom
 * margins so the padding blends in (cream/white app backgrounds).
 */
async function padTo916(buf) {
  try {
    const img = sharp(buf);
    const meta = await img.metadata();
    const w = meta.width || 1024;
    const h = meta.height || 1536;

    const targetH = Math.round(w * 16 / 9);
    if (targetH <= h) return buf; // already at or taller than 9:16

    // Sample top-left pixel for the background color so padding blends in
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
  } catch (e) {
    return buf; // never block on processing failure
  }
}
const cropTo916 = padTo916; // alias kept so callers don't change

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);
const BUCKET = 'influencer-uploads';

let _refs = null;
function getRefs() {
  if (_refs) return _refs;
  const root = process.cwd();
  const tryRead = (p) => { try { return fs.readFileSync(path.join(root, p)); } catch { return null; } };
  _refs = {
    productRef: tryRead('assets/purely-product-ref.png'),
    productRef2: tryRead('assets/purely-product-ref-2.png'),
    logo: tryRead('assets/purely-logo.webp')
  };
  return _refs;
}

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }

function buildPrompt(analysis, screen) {
  const a = analysis.analysis || {};
  const p = a.product || {};
  const score = Number.isFinite(a.score) ? a.score : 50;
  const verdict = a.verdict || 'Okay';
  const productName = (p.name || 'Product').slice(0, 80);
  const brand = (p.brand || '').slice(0, 60);
  const subcategory = (p.subcategory || p.category || '').slice(0, 30);
  const subject = (p.image_subject || `${brand} ${productName}`).slice(0, 240);

  const harm = Array.isArray(a.harmfulIngredients) ? a.harmfulIngredients : [];
  const cont = Array.isArray(a.contaminants) ? a.contaminants : [];
  const benef = Array.isArray(a.beneficialAttributes) ? a.beneficialAttributes : [];
  const ui = a.uiSummary?.topAttributes || [];

  const COMMON = `STYLE TEMPLATE — TREAT THE ATTACHED REFERENCE IMAGES AS GROUND TRUTH:
The reference images you've been given ARE Purely's exact visual language. Replicate every detail pixel-faithfully:
- Off-white / cream app background (#fdfaf5 area)
- Dark serif/semibold sans-serif title typography (e.g. "Sara Lee Artesano Baker's Bread", "Fiji Natural Artesian Water")
- Compact Purely "P" pinwheel logo + "Purely" or "Purely App" wordmark, both in dark forest green, set inside a small rounded white chip at the top of the screen
- Rounded white cards with THIN red border for harmful items, THIN green border for beneficial items
- Score shown as a circular ring badge with the score number large + verdict word small beneath (e.g. "1/100 Bad", "25/100 Very Poor")
- Top icons: back arrow on left, eye/info icon on right
- Stat rows with leaf icons, attribute name on the left, value on the right, colored DOT (red/green/amber) at the far right
- Pill chips: small rounded pills, one neutral with category, one warning with "⚠ Toxin report"
- Numeric pills like "9× limit", "300x limit", "Avoid", "Watch Out", "Good" — small rounded badges in red/amber/green
- Bottom footer: tiny centered text "Scored by  Purely" with a small Purely "P" logo

Do NOT invent a different style. Do NOT add gradients or 3D effects. Do NOT use bright colors that aren't in the references. The output must be visually indistinguishable in style from the references.

BRAND IDENTITY (REQUIRED on every screen): The Purely logo is provided as the LAST reference image. Use it EXACTLY — pinwheel of three dark-forest-green petals + the "Purely" wordmark beside or beneath it. No other brand identity.

PRODUCT FIDELITY (CRITICAL): The product is "${brand ? brand + ' ' : ''}${productName}"${subject ? ' — ' + subject : ''}. Render its real-world packaging exactly: same shape, same dominant colors, same brand wordmark style, same label motifs. Use your knowledge of the actual product if it's a known brand. Do NOT invent a generic product.

OUTPUT: ONE single 9:16 vertical phone screenshot. The phone screen content fills the canvas. NO text outside the phone screen, NO marketing border, NO drop shadows around the phone. Premium polished mobile UI rendering — NOT a sketch, NOT an illustration.`;

  if (screen === 'summary') {
    return `${COMMON}

SCREEN 1 — Product Summary
- Top: back-arrow on left, Purely logo+wordmark centered, eye icon on right.
- Hero card: a clean rounded white tile containing a photorealistic image of the actual ${productName} packaging.
- Below the hero: product title "${productName}" set large in dark sans/serif on the left; small brand name "${brand}" beneath it; a small upward-arrow "↗" link icon next to the title.
- On the right of the title block: a circular score ring showing "${score} / 100" with the word "${verdict}" beneath the number. Ring color reflects severity (red if score < 30, amber/orange if 30–60, green if 60+).
- Below: two pill chips — one neutral chip showing "${subcategory}" and one warning chip "⚠ Toxin report" outlined in red.
- Below: 3 attribute rows with leaf icons on the left, a label, and a colored dot on the right:
${ui.slice(0, 3).map((x) => `   • ${(x.label || '').slice(0, 30)} — ${(x.value || '').slice(0, 36)} — ${x.verdict === 'good' ? 'green dot' : x.verdict === 'warn' ? 'amber dot' : 'red dot'}`).join('\n') || `   • Top harmful: ${harm[0]?.name || 'N/A'} — red dot\n   • Beneficial: ${benef[0]?.attribute || 'N/A'} — green dot\n   • Microplastics: ${a.microplastics?.status || 'No data'} — ${a.microplastics?.status === 'Detected' || a.microplastics?.status === 'Likely' ? 'red dot' : 'amber dot'}`}
- Footer: thin centered text "Scored by  Purely" with the small Purely "P" logo.`;
  }

  if (screen === 'inside') {
    const items = [
      ...harm.slice(0, 4).map((h) => ({ name: h.name, body: h.reason, kind: 'bad' })),
      ...cont.slice(0, 2).map((c) => ({ name: c.name, body: `${c.amount} — ${c.multiplier || c.status}`, kind: 'bad' })),
      ...benef.slice(0, 2).map((b) => ({ name: b.attribute, body: b.why, kind: 'good' }))
    ].slice(0, 6);
    return `${COMMON}

SCREEN 2 — What's Inside
- Top header bar: "What's inside" left-aligned (dark serif/sans), Purely logo+wordmark on the right inside a small rounded chip.
- Below: a vertical stack of rounded white cards, each with a thin RED border for harmful items or a thin GREEN border for beneficial items, padded interior.
- Each card has a bold ingredient/finding name and a 1–2 line plain-language reason underneath.
Cards (in order):
${items.map((it, i) => `  ${i + 1}. [${it.kind === 'good' ? 'GREEN border' : 'RED border'}] "${(it.name || '').slice(0, 40)}" — "${(it.body || '').slice(0, 120)}"`).join('\n')}
- Spacing between cards is generous; corners rounded ~14px.`;
  }

  if (screen === 'detail') {
    const focus = harm[0] || cont[0] || { name: benef[0]?.attribute || 'Ingredient', reason: benef[0]?.why || '' };
    const focusName = (focus.name || focus.attribute || 'Ingredient').slice(0, 40);
    const focusReason = (focus.reason || focus.concern || focus.why || '').slice(0, 160);
    const detailScoreVal = harm[0] ? -10 : 5;
    return `${COMMON}

SCREEN 3 — Ingredient Detail (focused on "${focusName}")
- Top: back arrow, Purely logo+wordmark centered, info "i" icon on right.
- Top card: bold title "${focusName}" with descriptive subtitle: "${focusReason}".
- Score block: a panel with "Score" label, a big number "${detailScoreVal}" on the left, "-5 to 5 scale" small caption on the right. Below it a horizontal red→amber→green gradient bar with a small marker dot at the appropriate position. Labels under the bar: "-5 Very bad", "0 Okay", "5 Very good".
- Below: 5 collapsed accordion rows each with a "+" chevron on the right:
   1. Risks
   2. Benefits
   3. Legal limit
   4. Health guideline
   5. References
- Footer text in tiny gray: "${brand ? brand + ' ' : ''}${productName}    Product score ${score}/100".
- Small "Edit" pill button at bottom-left.`;
  }

  // toxin / score breakdown
  return `${COMMON}

SCREEN 4 — Toxin Report
- Top: back arrow, Purely logo+wordmark centered.
- Hero block: product photo of ${productName} on the left, on the right "${productName}" title + "${brand}" subtitle, and a circular score ring "${score} / 100  ${verdict}".
- Three stat chips in a row:
   ⚠ Harmful substances ${a.harmfulCount || harm.length || 0} (red dot)
   ✓ Beneficial substances ${a.beneficialCount || benef.length || 0} (green dot)
   ♻ Microplastics ${a.microplastics?.status || 'No data'} (${a.microplastics?.status === 'Detected' || a.microplastics?.status === 'Likely' ? 'red' : 'amber'} dot)
- Section heading: "What's inside".
- One detailed contaminant card with thin red border:
   ${cont[0] ? `Title "${cont[0].name}" with a red "${cont[0].multiplier || cont[0].status || 'Above limit'}" pill on the right.\n   Sub-line "${cont[0].amount}" in a smaller font.\n   Body: "${(cont[0].concern || '').slice(0, 140)}"` : `Title "${(harm[0]?.name || 'Risk').slice(0, 40)}" with a red "Detected" pill.\n   Body: "${(harm[0]?.reason || '').slice(0, 140)}"`}
- Below: "Sourced from ${(cont[0]?.source || 'EWG, ConsumerLab, Lead Safe Mama').slice(0, 60)}" small caption.`;
}

module.exports = async function handler(req, res) {
  if (!(await guard(req, res, { perMinute: 12, dailyKey: 'product-image', dailyMax: 800 }))) return;
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!OPENAI_API_KEY) return bad(res, 500, 'OPENAI_API_KEY not configured');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const analysisId = String(body.analysisId || '').trim();
    const screen = String(body.screen || 'summary').toLowerCase();
    const refresh = !!body.refresh;
    if (!analysisId || !['summary', 'inside', 'detail', 'toxin'].includes(screen)) {
      return bad(res, 400, 'analysisId, screen required');
    }

    const path_ = `product-analyses/${analysisId}/${screen}.png`;
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path_}`;
    if (!refresh) {
      const head = await fetch(publicUrl, { method: 'HEAD' });
      if (head.ok) return res.status(200).json({ url: publicUrl, cached: true });
    }

    // Load analysis
    const { data: file, error: dlErr } = await supabase.storage.from(BUCKET).download(`product-analyses/${analysisId}.json`);
    if (dlErr) return bad(res, 404, 'analysis not found');
    const analysis = JSON.parse(await file.text());

    const prompt = buildPrompt(analysis, screen);
    const refs = getRefs();

    const fd = new FormData();
    fd.append('model', 'gpt-image-1');
    fd.append('prompt', prompt);
    fd.append('size', '1024x1536');
    fd.append('n', '1');
    fd.append('quality', 'high');
    if (refs.productRef) fd.append('image[]', new Blob([refs.productRef], { type: 'image/png' }), 'ui-template-1.png');
    if (refs.productRef2) fd.append('image[]', new Blob([refs.productRef2], { type: 'image/png' }), 'ui-template-2.png');
    if (refs.logo) fd.append('image[]', new Blob([refs.logo], { type: 'image/webp' }), 'purely-logo.webp');

    const aiRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: fd
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
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path_, bytes, {
      contentType: 'image/png', upsert: true, cacheControl: '604800'
    });
    if (upErr) return bad(res, 500, 'upload: ' + upErr.message);
    return res.status(200).json({ url: publicUrl, cached: false });
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
