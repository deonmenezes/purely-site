/**
 * POST /api/tiktok-analyze { url }
 * Pipeline: validate → Apify scrape (sync) → fetch transcript → OpenAI extract products
 *           → cache to Supabase Storage. Returns the analysis (no images yet).
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');

const APIFY_TOKEN = (process.env.APIFY_TOKEN || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);

const BUCKET = 'influencer-uploads';
const TIKTOK_RE = /tiktok\.com\/@([^/?#]+)\/video\/(\d+)/i;
const SHORT_RE = /(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)/i;

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }

async function resolveUrl(input) {
  const direct = TIKTOK_RE.exec(input);
  if (direct) return { url: input, id: direct[2], handle: direct[1] };
  const short = SHORT_RE.exec(input);
  if (short) {
    try {
      const r = await fetch(`https://${short[0]}`, { redirect: 'follow' });
      const m = TIKTOK_RE.exec(r.url);
      if (m) return { url: r.url, id: m[2], handle: m[1] };
    } catch {}
  }
  return null;
}

async function runApify(url) {
  const body = {
    postURLs: [url],
    resultsPerPage: 1,
    shouldDownloadSubtitles: true,
    shouldDownloadVideos: false,
    shouldDownloadCovers: true,
    proxyCountryCode: 'None'
  };
  const res = await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=110&memory=512`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Apify ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

function parseVTT(text) {
  const out = []; const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\d{2}:)?(\d{2}):(\d{2})\.(\d{3}) --> /);
    if (!m) continue;
    const start = (parseInt(m[1] || '00:', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    const buf = []; i++;
    while (i < lines.length && lines[i].trim() && !lines[i].includes('-->')) {
      buf.push(lines[i].replace(/<[^>]+>/g, '').trim()); i++;
    }
    if (buf.length) out.push({ time: start, text: buf.join(' ').trim() });
  }
  return out;
}
function parseSRT(text) {
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n/)) {
    const ls = block.split('\n').filter(Boolean);
    const tsLine = ls.find((l) => l.includes('-->'));
    if (!tsLine) continue;
    const m = tsLine.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
    if (!m) continue;
    const start = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    const txt = ls.slice(ls.indexOf(tsLine) + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (txt) out.push({ time: start, text: txt });
  }
  return out;
}

async function fetchTranscript(item) {
  const links = item.videoMeta?.subtitleLinks || [];
  if (!links.length) return [];
  const pick = links.find((s) => /en/i.test(s.language || '')) || links[0];
  const dl = pick.downloadLink || pick.url;
  if (!dl) return [];
  try {
    const r = await fetch(dl);
    if (!r.ok) return [];
    const t = await r.text();
    return t.trim().startsWith('WEBVTT') ? parseVTT(t) : parseSRT(t);
  } catch { return []; }
}

async function fetchAsDataUrl(url, maxBytes = 3 * 1024 * 1024) {
  if (!url) return null;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' }
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) return null;
    let ct = (r.headers.get('content-type') || 'image/jpeg').toLowerCase();
    // OpenAI vision accepts png/jpeg/webp/gif. If unknown, force jpeg
    if (!/^image\/(png|jpeg|jpg|webp|gif)/.test(ct)) ct = 'image/jpeg';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

async function gpt4Extract(item, transcript) {
  if (!OPENAI_API_KEY) {
    return {
      summary: 'Add OPENAI_API_KEY to your Vercel env to enable AI product extraction.',
      purelyTakeaway: 'No takeaway generated.',
      products: []
    };
  }

  // Multi-frame visual context: cover, originalCover, and dynamicCover (TikTok's
  // animated preview which already samples multiple frames across the video).
  const frameUrls = [
    item.videoMeta?.coverUrl,
    item.videoMeta?.originalCoverUrl,
    item.videoMeta?.dynamicCoverUrl
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
  const frameDataUrls = (await Promise.all(frameUrls.map((u) => fetchAsDataUrl(u)))).filter(Boolean);

  const transcriptText = transcript.map((t) => `[${t.time}s] ${t.text}`).join('\n').slice(0, 6000);
  const caption = (item.text || '').slice(0, 800);
  const prompt = `You analyze TikTok videos for "Purely", a wellness/ingredient-scanner app. You will receive ${frameDataUrls.length} visual frame(s) sampled from the actual video, plus the caption and a time-stamped transcript. Use ALL of this combined data — what you SEE in the frames is the source of truth for product visuals.

The TikTok caption: ${caption || '(none)'}

Transcript:
${transcriptText || '(no transcript)'}

Extract the food/drink/personal-care products specifically named in the video. For each product return a Purely-style analysis. Be specific (real product names, real brands when stated). Skip generic mentions ("water", "snacks") that aren't a specific item.

Return STRICT JSON in this exact shape, no prose, no markdown fences:
{
  "summary": "2-3 sentence neutral summary of what the creator is saying",
  "purelyTakeaway": "1-2 sentences positioning the message in Purely's voice (find what's healthy, choose what's pure)",
  "products": [
    {
      "name": "product name (string)",
      "brand": "brand if stated, else empty string",
      "category": "drink|snack|breakfast|protein|supplement|skincare|other",
      "verdict": "Good Choice | Watch Out | Avoid",
      "score": 0-100 integer (Purely health score),
      "summary": "1 sentence why this score",
      "ingredients": [
        {"name":"...","label":"Good|Watch Out|Avoid","note":"short reason"}
      ],
      "good": ["short positive points, 0-3"],
      "watchOut": ["short concerns, 0-3"],
      "image_subject": "DETAILED real-world visual description of this exact product (NOT a generic version). Container shape and size (e.g. 'tall slim 16.9oz aluminum can'), exact dominant colors, the brand's actual typography style and wordmark treatment, characteristic visual motifs on the label (illustrations, icons, colors, layout), and any signature design language. If the product is a recognizable brand (Liquid Death, Olipop, Athletic Greens, RX Bar, etc.) describe its real packaging from your knowledge",
      "image_color": "dominant package color (one word, e.g. 'green', 'beige', 'black')"
    }
  ]
}

Max 3 products. Score reflects ingredient quality + processing level. If no specific products, return products: [].`;

  const userContent = [{ type: 'text', text: prompt }];
  for (const dataUrl of frameDataUrls) {
    userContent.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.4
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(content);
  } catch (e) {
    return { summary: 'Could not parse AI response', purelyTakeaway: '', products: [] };
  }
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function saveAnalysis(payload) {
  const path = `tiktok-analyses/${payload.tiktok.id}.json`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, JSON.stringify(payload, null, 2), {
    contentType: 'application/json', upsert: true, cacheControl: '60'
  });
  if (error) console.warn('Cache write failed:', error.message);
}

async function readCache(id) {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(`tiktok-analyses/${id}.json`);
    if (error) return null;
    return JSON.parse(await data.text());
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  if (!(await guard(req, res, { perMinute: 6, dailyKey: 'tiktok-analyze', dailyMax: 200 }))) return;
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!APIFY_TOKEN) return bad(res, 500, 'APIFY_TOKEN not configured');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const inputUrl = (body.url || '').trim();
    if (inputUrl.length > 500) return bad(res, 400, 'url too long');
    const refresh = !!body.refresh;
    if (!inputUrl) return bad(res, 400, 'url required');

    const resolved = await resolveUrl(inputUrl);
    if (!resolved) return bad(res, 400, 'Not a TikTok video URL');

    if (!refresh) {
      const cached = await readCache(resolved.id);
      if (cached) return res.status(200).json({ ...cached, cached: true });
    }

    const items = await runApify(resolved.url);
    if (!items?.length) return bad(res, 404, 'TikTok video not found via scraper');
    const item = items[0];
    const transcript = await fetchTranscript(item);
    const analysis = await gpt4Extract(item, transcript);
    analysis.products = (analysis.products || []).map((p, idx) => ({
      ...p,
      slug: slugify(`${p.brand || ''} ${p.name || ''}`) || `product-${idx + 1}`
    }));

    const payload = {
      tiktok: {
        id: resolved.id,
        url: resolved.url,
        handle: resolved.handle,
        caption: item.text || '',
        cover: item.videoMeta?.coverUrl || null,
        duration: item.videoMeta?.duration || 0,
        author: {
          name: item.authorMeta?.name || resolved.handle,
          nickname: item.authorMeta?.nickName || '',
          avatar: item.authorMeta?.avatar || null,
          verified: !!item.authorMeta?.verified
        },
        stats: {
          plays: item.playCount || 0, likes: item.diggCount || 0,
          comments: item.commentCount || 0, shares: item.shareCount || 0,
          saves: item.collectCount || 0
        },
        createdAt: item.createTimeISO || null,
        hashtags: (item.hashtags || []).map((h) => h.name || h).filter(Boolean)
      },
      transcript,
      analysis,
      generatedAt: new Date().toISOString()
    };
    await saveAnalysis(payload);
    return res.status(200).json(payload);
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
