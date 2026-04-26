/**
 * POST /api/generate-lifestyle
 * { productName, productBrand?, category?, count? (1-3) }
 *
 * Generates casual, realistic lifestyle photos of someone scanning the
 * specified product with a phone — for influencers to use as marketing
 * assets alongside the app-screen mockups. Uses OpenAI's gpt-image-1
 * (text-to-image). Each image costs ~$0.04 at medium quality.
 *
 * Returns { images: [dataUrl, ...] } as base64 PNG data URLs the front
 * end can render and download directly without another network round trip.
 */
const { guard } = require('./_security');

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }

module.exports = async function handler(req, res) {
  if (!(await guard(req, res, { perMinute: 4, dailyKey: 'lifestyle-gen', dailyMax: 80 }))) return;
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!OPENAI_API_KEY) return bad(res, 500, 'OPENAI_API_KEY not configured');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const productName = String(body.productName || '').trim().slice(0, 120) || 'a product';
    const productBrand = String(body.productBrand || '').trim().slice(0, 80);
    const category = String(body.category || '').trim().slice(0, 80);
    const count = Math.max(1, Math.min(3, Number(body.count) || 2));

    const subject = [productBrand, productName].filter(Boolean).join(' ') || productName;
    const categoryHint = category ? ` (a ${category})` : '';

    // Lifestyle prompt — describes the scene as a casual phone-camera moment.
    // Avoids "screen UI" so we don't get fake-looking app overlays; the real
    // app screenshot is rendered separately as the mockup tile.
    const prompt = `Authentic casual lifestyle photograph: a person's hand holding a modern smartphone (vertical orientation) about 8 inches above ${subject}${categoryHint}, scanning the product label with the phone camera. The product sits on a light wooden kitchen counter with soft morning sunlight from a side window. Warm natural tones, shallow depth of field, slight grain — looks like a candid Instagram or TikTok still, not a stock photo. The product label is clearly visible and recognizable. No text overlays, no logos other than the actual product. Photographed at 35mm focal length.`;

    const aiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        n: count,
        size: '1024x1536',  // portrait — works for both Instagram & TikTok crops
        quality: 'medium',
        output_format: 'png'
      })
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      return bad(res, 502, `OpenAI ${aiRes.status}: ${t.slice(0, 240)}`);
    }
    const j = await aiRes.json();
    const images = (j.data || [])
      .map((d) => d.b64_json ? `data:image/png;base64,${d.b64_json}` : (d.url || null))
      .filter(Boolean);
    if (!images.length) return bad(res, 502, 'No images returned by model');

    return res.status(200).json({ images, prompt });
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
