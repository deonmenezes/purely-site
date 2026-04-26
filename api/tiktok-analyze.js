/**
 * POST /api/tiktok-analyze { url }
 * Pipeline: validate → Apify scrape (sync) → fetch transcript → OpenAI extract products
 *           → cache to Supabase Storage. Returns the analysis (no images yet).
 */
const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');
const { PURELY_RULES } = require('./_purely-prompt');

const APIFY_TOKEN = (process.env.APIFY_TOKEN || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);

const BUCKET = 'influencer-uploads';
// Match both /video/ (regular reels) and /photo/ (carousel image posts).
// Photo posts have no playable audio so transcript stays empty, but the
// caption + image still feeds the analyzer.
const TIKTOK_RE = /tiktok\.com\/@([^/?#]+)\/(?:video|photo)\/(\d+)/i;
const SHORT_HOST_RE = /(?:vm|vt|m)\.tiktok\.com\/([A-Za-z0-9]+)/i;
const T_PATH_RE = /(?:www\.)?tiktok\.com\/t\/([A-Za-z0-9]+)/i;

function bad(res, code, msg) { return res.status(code).json({ error: msg }); }

function cleanInput(s) {
  let v = String(s || '').trim();
  // If extra text was pasted, isolate the URL
  const m = v.match(/https?:\/\/[^\s]+/i);
  if (m) v = m[0];
  v = v.replace(/[)\].,;:'"!?]+$/, '');
  if (!/^https?:\/\//i.test(v) && /tiktok\.com/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  return v;
}

async function followRedirect(url) {
  try {
    // Some short hosts only redirect when given a real UA
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
    });
    return r.url || null;
  } catch { return null; }
}

async function resolveUrl(rawInput) {
  const input = cleanInput(rawInput);
  if (!input) return null;

  const direct = TIKTOK_RE.exec(input);
  if (direct) return { url: input, id: direct[2], handle: direct[1] };

  // Short hosts: vm./vt./m.tiktok.com/<code>
  const shortHost = SHORT_HOST_RE.exec(input);
  if (shortHost) {
    const finalUrl = await followRedirect(`https://${shortHost[0]}`);
    if (finalUrl) {
      const m = TIKTOK_RE.exec(finalUrl);
      if (m) return { url: finalUrl, id: m[2], handle: m[1] };
    }
  }

  // Path-based shortlink: tiktok.com/t/<code>
  const tPath = T_PATH_RE.exec(input);
  if (tPath) {
    const finalUrl = await followRedirect(`https://www.tiktok.com/t/${tPath[1]}`);
    if (finalUrl) {
      const m = TIKTOK_RE.exec(finalUrl);
      if (m) return { url: finalUrl, id: m[2], handle: m[1] };
    }
  }

  // Last-ditch: any URL containing tiktok.com — let HTTP follow find the canonical
  if (/tiktok\.com/i.test(input)) {
    const finalUrl = await followRedirect(input);
    if (finalUrl) {
      const m = TIKTOK_RE.exec(finalUrl);
      if (m) return { url: finalUrl, id: m[2], handle: m[1] };
    }
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

/**
 * Direct TikTok page scrape — no third-party API key needed.
 * Fetches the canonical video URL, extracts the embedded
 * __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON blob, and returns an
 * Apify-shaped item so the rest of the pipeline doesn't care which
 * source produced the data. TikTok occasionally rotates the JSON
 * envelope; if the parse fails the caller falls back to Apify.
 */
async function scrapeTikTokDirect(url, resolved) {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache'
    }
  });
  if (!res.ok) throw new Error(`TikTok page fetch ${res.status}`);
  const html = await res.text();

  let item = null;
  // Try the modern envelope first. TikTok rotates the scope name —
  // currently `webapp.reflow.video.detail` for shared video pages, but
  // older traffic still sees `webapp.video-detail` and `seo.abtest`.
  const universal = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (universal) {
    try {
      const data = JSON.parse(universal[1]);
      const scope = data?.__DEFAULT_SCOPE__ || {};
      item = scope['webapp.reflow.video.detail']?.itemInfo?.itemStruct
        || scope['webapp.video-detail']?.itemInfo?.itemStruct
        || scope['webapp.reflow.photo.detail']?.itemInfo?.itemStruct
        || scope['webapp.photo-detail']?.itemInfo?.itemStruct
        || scope['seo.abtest']?.itemInfo?.itemStruct;
    } catch { /* fall through to SIGI */ }
  }
  // Older envelope, still seen on some traffic.
  if (!item) {
    const sigi = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (sigi) {
      try {
        const data = JSON.parse(sigi[1]);
        const id = resolved.id;
        item = data?.ItemModule?.[id] || Object.values(data?.ItemModule || {})[0];
      } catch { /* nothing else to try */ }
    }
  }
  if (!item) throw new Error('TikTok page has no embedded video JSON (likely rate-limited or geo-blocked)');

  const author = item.author || item.authorInfo || {};
  // Some envelopes put stats under "stats", others "statsV2".
  const stats = item.statsV2 || item.stats || {};
  const video = item.video || {};
  // Photo carousel posts have item.imagePost.images[] instead of video.
  // Pull the first image URL so the cover/photo still has something useful.
  const photoImages = item.imagePost?.images || [];
  const firstPhotoUrl = photoImages[0]?.imageURL?.urlList?.[0]
    || photoImages[0]?.imageUrl?.urlList?.[0]
    || photoImages[0]?.url
    || null;

  // Subtitles: the page exposes downloadable VTT/SRT URLs per language
  // in video.subtitleInfos[]. These are short-lived signed URLs but
  // valid for a few minutes after the page is fetched.
  const subs = video.subtitleInfos || video.subtitles || [];
  const subtitleLinks = subs
    .map((s) => ({
      language: s.LanguageCodeName || s.LanguageCodeIETF || s.language || 'en',
      downloadLink: s.Url || s.url || s.UrlExpire,
      format: (s.Format || s.format || 'vtt').toLowerCase()
    }))
    .filter((s) => s.downloadLink);

  // Map to the Apify item shape so callers don't branch.
  return [{
    text: item.desc || item.contents?.[0]?.desc || '',
    authorMeta: {
      name: author.uniqueId || author.unique_id || resolved.handle,
      nickName: author.nickname || author.nickName || '',
      avatar: author.avatarMedium || author.avatarThumb || author.avatar_medium || null,
      verified: !!(author.verified || author.isVerified)
    },
    videoMeta: {
      coverUrl: video.cover || video.originCover || firstPhotoUrl || null,
      originalCoverUrl: video.originCover || firstPhotoUrl || null,
      dynamicCoverUrl: video.dynamicCover || null,
      duration: Number(video.duration || 0),
      // playAddr/downloadAddr are short-lived signed mp4 URLs from TikTok.
      // Used by transcribeWithWhisper as the Whisper fallback when no
      // subtitle track is shipped in the page. Empty for photo posts.
      downloadAddr: video.playAddr || video.downloadAddr || null,
      subtitleLinks
    },
    playCount: Number(stats.playCount || stats.viewCount || 0),
    diggCount: Number(stats.diggCount || stats.likeCount || 0),
    commentCount: Number(stats.commentCount || 0),
    shareCount: Number(stats.shareCount || 0),
    collectCount: Number(stats.collectCount || stats.collectedCount || 0),
    createTimeISO: item.createTime ? new Date(Number(item.createTime) * 1000).toISOString() : null,
    hashtags: (item.textExtra || [])
      .map((t) => (t.hashtagName ? { name: t.hashtagName } : null))
      .filter(Boolean)
  }];
}

/**
 * If the TikTok page didn't ship subtitles, transcribe the video's
 * audio with OpenAI Whisper. Uses the same OPENAI_API_KEY the rest
 * of the pipeline uses, so no new env var. Cost is ~$0.006/minute.
 */
async function transcribeWithWhisper(videoUrl) {
  if (!OPENAI_API_KEY || !videoUrl) return [];
  try {
    const vRes = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.tiktok.com/'
      }
    });
    if (!vRes.ok) return [];
    const buf = Buffer.from(await vRes.arrayBuffer());
    if (buf.length > 24 * 1024 * 1024) return []; // Whisper limit is 25 MB
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'video/mp4' }), 'video.mp4');
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'verbose_json');
    const wRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: fd
    });
    if (!wRes.ok) return [];
    const j = await wRes.json();
    const segs = j.segments || [];
    if (segs.length) return segs.map((s) => ({ time: Math.floor(s.start || 0), text: (s.text || '').trim() }));
    if (j.text) return [{ time: 0, text: j.text }];
    return [];
  } catch { return []; }
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
  const prompt = `${PURELY_RULES}

CONTEXT: You're analyzing a TikTok post for "Purely". You receive ${frameDataUrls.length} visual frame(s) sampled from the post, plus the caption and a time-stamped transcript (may be empty for photo carousel posts). Use ALL of this combined data — what you SEE in the frames is the source of truth for product visuals.

CAPTION: ${caption || '(none)'}

TRANSCRIPT:
${transcriptText || '(no transcript)'}

TASK: Identify the food/drink/personal-care products specifically named or visible. Skip generic mentions ("water", "snacks") that aren't a specific item. For each identified product, apply the FULL Purely rubric above — your real-world product knowledge, contaminant data, and scoring deductions/additions. Cap at 3 products per post; pick the most prominent.

Return STRICT JSON in this exact shape — no prose, no markdown fences. Every field must be populated. Microplastics MUST have a real status (use rules above; never default to "No data" for well-studied categories like bottled water).
{
  "summary": "2-3 sentence neutral summary of what the creator is saying",
  "purelyTakeaway": "1-2 sentences positioning the message in Purely's voice (find what's healthy, choose what's pure)",
  "products": [
    {
      "name": "string",
      "brand": "string or empty",
      "category": "water|food|beverage|supplement|snack|breakfast|protein|skincare|clothing|other",
      "subcategory": "short string e.g. 'Bottled Water', 'Protein Bar'",
      "score": 0-100 integer applying the full rubric,
      "verdict": "Excellent | Good | Okay | Poor | Avoid",
      "summary": "1 sentence why this score",
      "headline": "1 sentence ruthless one-liner (e.g. 'Detected at 9× EPA THM guideline — Kirkland-grade')",
      "harmfulCount": integer (count of harmfulIngredients + contaminants entries),
      "beneficialCount": integer (count of beneficialAttributes entries),
      "microplastics": {
        "status": "Detected | Likely | Not Detected | No published data",
        "level": "string or empty",
        "context": "1 sentence",
        "source": "named source"
      },
      "contaminants": [
        {
          "name": "string",
          "amount": "string with units or 'Trace' or 'Detected'",
          "limit": "string with regulatory/health guideline",
          "limitSource": "EPA|WHO|California Prop 65|EWG|...",
          "status": "ABOVE | AT LIMIT | TRACE | NON-DETECT",
          "multiplier": "string e.g. '9× above EPA' or 'Below limit'",
          "concern": "1 sentence — what this does to the body",
          "source": "Named source (e.g. 'EWG Tap Water Database', 'Lead Safe Mama')"
        }
      ],
      "harmfulIngredients": [
        { "name": "string", "reason": "1-2 sentence specific mechanism, not vague concern", "source": "named source if applicable" }
      ],
      "beneficialAttributes": [
        { "attribute": "string", "why": "1 sentence", "source": "named cert/source" }
      ],
      "ingredients": [
        { "name": "string", "label": "Good|Watch Out|Avoid", "note": "short reason" }
      ],
      "good": ["short positive points, 0-3"],
      "watchOut": ["short concerns, 0-3"],
      "sources": [
        { "name": "string", "description": "string", "url": "string or empty" }
      ],
      "image_subject": "detailed real-world visual description: container shape/size, dominant colors, brand's actual typography and wordmark, label motifs",
      "image_color": "dominant package color, one word"
    }
  ]
}

If no specific products, return products: [].`;

  const userContent = [{ type: 'text', text: prompt }];
  for (const dataUrl of frameDataUrls) {
    userContent.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o',
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

    // Try the keyless direct scrape first; only fall back to Apify if that
    // fails AND a token is configured. This means the endpoint works out of
    // the box with just OPENAI_API_KEY + Supabase.
    let items = null;
    let scrapeError = null;
    try {
      items = await scrapeTikTokDirect(resolved.url, resolved);
    } catch (e) {
      scrapeError = e;
      if (APIFY_TOKEN) {
        try { items = await runApify(resolved.url); }
        catch (apifyErr) { scrapeError = apifyErr; }
      }
    }
    if (!items?.length) {
      return bad(res, 502, `Could not load TikTok video: ${scrapeError?.message || 'unknown error'}`);
    }
    const item = items[0];
    let transcript = await fetchTranscript(item);
    // No subtitles on the page? Whisper-transcribe the video audio.
    // Reuses the OpenAI key already in the env — no extra config needed.
    if (!transcript.length && item.videoMeta?.downloadAddr) {
      transcript = await transcribeWithWhisper(item.videoMeta.downloadAddr);
    }
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
    // Only cache if we actually got useful data (avoid persisting empty failure)
    const hasData = (payload.transcript?.length || 0) > 0 ||
                    (payload.analysis?.products?.length || 0) > 0 ||
                    (payload.tiktok?.caption || '').length > 5;
    if (hasData) await saveAnalysis(payload);
    return res.status(200).json(payload);
  } catch (e) {
    return bad(res, 500, e.message || 'Failed');
  }
};
