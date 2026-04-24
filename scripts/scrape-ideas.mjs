#!/usr/bin/env node
/**
 * Scrapes @oasis.app TikTok via Apify, parses transcripts,
 * and writes the normalized JSON to Supabase Storage.
 *
 * Usage:
 *   APIFY_TOKEN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-ideas.mjs
 *   (or pass --run-id=<id> to fetch an existing run instead of starting a new one)
 */
import { createClient } from '@supabase/supabase-js';

const APIFY_TOKEN = (process.env.APIFY_TOKEN || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
if (!APIFY_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env: APIFY_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const PROFILE = process.env.PROFILE || 'oasis.app';
const RESULTS = Number(process.env.RESULTS || 10);
const ACTOR = 'clockworks~tiktok-scraper';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function arg(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split('=')[1] : null;
}

async function startRun() {
  const res = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profiles: [PROFILE],
      resultsPerPage: RESULTS,
      shouldDownloadSubtitles: true,
      shouldDownloadVideos: false,
      shouldDownloadCovers: true,
      proxyCountryCode: 'None'
    })
  });
  const j = await res.json();
  if (!res.ok) throw new Error('Apify run start failed: ' + JSON.stringify(j));
  return j.data;
}

async function waitForRun(runId) {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const j = await res.json();
    const { status, defaultDatasetId } = j.data;
    process.stdout.write(`\r[apify] ${status} (${i * 5}s)`.padEnd(40));
    if (status === 'SUCCEEDED') {
      process.stdout.write('\n');
      return defaultDatasetId;
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error('Run ended with status: ' + status);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Run timed out after 10min');
}

async function fetchDataset(datasetId) {
  const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json&clean=true&token=${APIFY_TOKEN}`);
  if (!res.ok) throw new Error('Dataset fetch failed: ' + res.status);
  return res.json();
}

function parseVTT(text) {
  const out = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/(\d{2}:)?(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}:)?(\d{2}):(\d{2})\.(\d{3})/);
    if (m) {
      const start = (parseInt(m[1] || '00:', 10) * 3600 || 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      const content = [];
      i++;
      while (i < lines.length && lines[i].trim() && !lines[i].includes('-->')) {
        content.push(lines[i].replace(/<[^>]+>/g, '').trim());
        i++;
      }
      if (content.length) out.push({ time: start, text: content.join(' ').trim() });
    } else {
      i++;
    }
  }
  return out;
}

function parseSRT(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    const tsLine = lines.find((l) => l.includes('-->'));
    if (!tsLine) continue;
    const m = tsLine.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
    if (!m) continue;
    const start = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    const content = lines.slice(lines.indexOf(tsLine) + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (content) out.push({ time: start, text: content });
  }
  return out;
}

async function fetchTranscript(subtitleLinks) {
  if (!Array.isArray(subtitleLinks) || subtitleLinks.length === 0) return [];
  // Prefer English
  const preferred = subtitleLinks.find((s) => /en/i.test(s.language || '')) || subtitleLinks[0];
  const url = preferred.downloadLink || preferred.url;
  if (!url) return [];
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const txt = await res.text();
    if (txt.trim().startsWith('WEBVTT')) return parseVTT(txt);
    return parseSRT(txt);
  } catch { return []; }
}

/* ---------- tag extraction ---------- */
const TAG_KEYWORDS = {
  'Protein': /\bprotein\b/i,
  'Sugar': /\b(sugar|sucrose|fructose|glucose|sweeten)/i,
  'Label Reading': /\b(label|ingredient|nutrition facts)\b/i,
  'Healthy Eating': /\b(healthy|wellness|clean eating|whole food)/i,
  'Gut Health': /\b(gut|probiotic|digest|bloat)/i,
  'Wellness Tips': /\b(tip|tips|hack|trick)/i,
  'Snacks': /\b(snack|bar|chip|cookie)\b/i,
  'Breakfast': /\b(breakfast|oat|smoothie|cereal|yogurt)\b/i,
  'Drinks': /\b(drink|soda|beverage|water|juice|coffee)\b/i,
  'Ultra-Processed': /\b(ultra.?processed|preservative|additive|seed oil)/i,
  'Kids': /\b(kid|child|baby|toddler|parent)\b/i,
  'Grocery': /\b(grocery|store|shop|aisle|brand)\b/i
};
function extractTags(text, hashtags = []) {
  const set = new Set();
  for (const [tag, re] of Object.entries(TAG_KEYWORDS)) if (re.test(text)) set.add(tag);
  for (const h of hashtags) {
    const name = (typeof h === 'string' ? h : h.name || '').toLowerCase();
    if (/protein/.test(name)) set.add('Protein');
    if (/sugar/.test(name)) set.add('Sugar');
    if (/label|read/.test(name)) set.add('Label Reading');
    if (/clean|wellness|healthy/.test(name)) set.add('Healthy Eating');
    if (/gut|probiotic/.test(name)) set.add('Gut Health');
  }
  if (set.size === 0) set.add('Wellness Tips');
  return Array.from(set).slice(0, 6);
}

function firstSentence(s) {
  if (!s) return '';
  const m = s.match(/^[^.!?\n]{4,160}[.!?]?/);
  return (m ? m[0] : s.slice(0, 140)).trim();
}

function scoreVideo(v) {
  const plays = v.playCount || 0;
  const engage = (v.diggCount || 0) + (v.commentCount || 0) + (v.shareCount || 0) + (v.collectCount || 0);
  const rate = plays > 0 ? engage / plays : 0;
  const raw = Math.min(100, Math.round(Math.log10(Math.max(plays, 1)) * 14 + rate * 400));
  return Math.max(50, Math.min(100, raw));
}

function generateInsights(caption, transcript, tags) {
  const transcriptText = transcript.map((t) => t.text).join(' ');
  const all = [caption || '', transcriptText].join(' ');
  const hook = firstSentence(transcript[0]?.text || caption || '');
  const reelIdea = `Educate your audience on ${tags[0] ? tags[0].toLowerCase() : 'wellness'} with a short, punchy reel. Lead with a bold claim, back it with a simple breakdown, end with a clear recommendation.`;
  const talkingPoints = [];
  for (const t of transcript.slice(0, 5)) {
    const clean = t.text.trim();
    if (clean.length > 10 && clean.length < 140) talkingPoints.push(clean);
  }
  while (talkingPoints.length < 3) {
    talkingPoints.push('Speak to one clear insight per point — don\'t cram.');
  }
  const steps = [
    'Open with a strong hook (first 2 seconds decide it)',
    'Show the product or problem visually',
    'Explain the single idea in plain language',
    'Give a clean, specific recommendation',
    'Close with a call-to-action — save, share, or follow'
  ];
  const suggestedCaption = (caption || '').slice(0, 240) +
    (tags.length ? '\n\n' + tags.map((t) => '#' + t.replace(/\s+/g, '').toLowerCase()).join(' ') : '');
  return { hook, reelIdea, talkingPoints: talkingPoints.slice(0, 5), steps, suggestedCaption };
}

function normalize(items) {
  return items.map((v) => {
    const subtitleLinks = v.videoMeta?.subtitleLinks || [];
    return { __raw: v, subtitleLinks };
  });
}

async function enrich(items) {
  const out = [];
  for (const { __raw: v, subtitleLinks } of items) {
    const transcript = await fetchTranscript(subtitleLinks);
    const hashtags = (v.hashtags || []).map((h) => (typeof h === 'string' ? h : h.name)).filter(Boolean);
    const fullText = [v.text, transcript.map((t) => t.text).join(' ')].join(' ');
    const tags = extractTags(fullText, v.hashtags || []);
    const insights = generateInsights(v.text, transcript, tags);
    out.push({
      id: v.id || v.tiktokId,
      url: v.webVideoUrl,
      createdAt: v.createTimeISO || v.createTime || null,
      author: {
        name: v.authorMeta?.name || '',
        nickname: v.authorMeta?.nickName || v.authorMeta?.nickname || '',
        avatar: v.authorMeta?.avatar || '',
        verified: !!v.authorMeta?.verified
      },
      cover: v.videoMeta?.coverUrl || v.videoMeta?.originalCoverUrl || v.cover || null,
      videoUrl: v.videoMeta?.downloadAddr || v.mediaUrls?.[0] || null,
      duration: v.videoMeta?.duration || 0,
      caption: v.text || '',
      hashtags,
      stats: {
        plays: v.playCount || 0,
        likes: v.diggCount || 0,
        comments: v.commentCount || 0,
        shares: v.shareCount || 0,
        saves: v.collectCount || 0
      },
      transcript,
      ...insights,
      tags,
      score: scoreVideo(v)
    });
  }
  return out;
}

/* ---------- Supabase Storage write ---------- */
async function saveToStorage(payload) {
  const bucket = 'influencer-uploads';
  const path = 'ideas/ideas.json';
  const { error } = await supabase.storage.from(bucket).upload(path, JSON.stringify(payload, null, 2), {
    contentType: 'application/json',
    upsert: true,
    cacheControl: '60'
  });
  if (error) throw error;
  console.log(`Saved ${payload.ideas.length} ideas → ${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`);
}

/* ---------- main ---------- */
(async () => {
  try {
    let datasetId = arg('dataset-id');
    if (!datasetId) {
      const runId = arg('run-id');
      if (runId) {
        console.log('Using existing run id:', runId);
        datasetId = await waitForRun(runId);
      } else {
        console.log('Starting Apify run for', PROFILE);
        const run = await startRun();
        console.log('Run id:', run.id);
        datasetId = await waitForRun(run.id);
      }
    }
    console.log('Dataset:', datasetId);
    const items = await fetchDataset(datasetId);
    console.log('Fetched', items.length, 'items');
    const normalized = normalize(items);
    const ideas = await enrich(normalized);
    const payload = {
      scrapedAt: new Date().toISOString(),
      profile: PROFILE,
      ideas: ideas.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    };
    await saveToStorage(payload);
  } catch (e) {
    console.error('Scrape failed:', e);
    process.exit(1);
  }
})();
