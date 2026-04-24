const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);

const BUCKET = 'influencer-uploads';
const PATH = 'ideas/ideas.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(PATH);
    if (error) {
      if (error.statusCode === '404' || /not found/i.test(error.message)) {
        return res.status(200).json({ ideas: [], scrapedAt: null, status: 'empty' });
      }
      throw error;
    }
    const text = await data.text();
    const payload = JSON.parse(text);
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'failed to load ideas' });
  }
};
