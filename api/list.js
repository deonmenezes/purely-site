const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);

const BUCKET = 'influencer-uploads';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const base = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`;

    const [v, s] = await Promise.all([
      supabase.storage.from(BUCKET).list('videos', {
        limit: 200, sortBy: { column: 'created_at', order: 'desc' }
      }),
      supabase.storage.from(BUCKET).list('screenshots', {
        limit: 200, sortBy: { column: 'created_at', order: 'desc' }
      })
    ]);

    const map = (folder, items) =>
      (items || [])
        .filter((i) => i.name && i.name !== '.emptyFolderPlaceholder')
        .map((i) => ({
          name: i.name,
          folder,
          url: `${base}/${folder}/${i.name}`,
          size: i.metadata?.size || 0,
          type: i.metadata?.mimetype || '',
          createdAt: i.created_at || i.updated_at
        }));

    const videos = map('videos', v.data);
    const screenshots = map('screenshots', s.data);
    const all = [...videos, ...screenshots].sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.status(200).json({ recent: all.slice(0, 8), videos, screenshots });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
