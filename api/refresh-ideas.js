const { createClient } = require('@supabase/supabase-js');

const APIFY_TOKEN = (process.env.APIFY_TOKEN || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);

const BUCKET = 'influencer-uploads';
const STATE_PATH = 'ideas/state.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not configured' });

  try {
    const body = req.method === 'POST' && req.body
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)
      : {};
    const profile = (body.profile || 'oasis.app').replace(/^@/, '');
    const results = Math.min(Number(body.results || 10), 30);

    const apifyRes = await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${APIFY_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profiles: [profile],
        resultsPerPage: results,
        shouldDownloadSubtitles: true,
        shouldDownloadVideos: false,
        shouldDownloadCovers: true,
        proxyCountryCode: 'None'
      })
    });
    const apifyData = await apifyRes.json();
    if (!apifyRes.ok) {
      return res.status(502).json({ error: 'Apify failed', detail: apifyData });
    }
    const run = apifyData.data;
    const state = { runId: run.id, datasetId: run.defaultDatasetId, startedAt: run.startedAt, profile, results, status: 'RUNNING' };
    await supabase.storage.from(BUCKET).upload(STATE_PATH, JSON.stringify(state, null, 2), {
      contentType: 'application/json', upsert: true, cacheControl: '5'
    });
    return res.status(200).json(state);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'failed' });
  }
};
