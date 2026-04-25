const { createClient } = require('@supabase/supabase-js');
const { guard } = require('./_security');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);

const BUCKET = 'influencer-uploads';
const ALLOWED_RE = /^(image|video)\//i;

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

module.exports = async function handler(req, res) {
  if (!(await guard(req, res, { perMinute: 20, dailyKey: 'sign-upload', dailyMax: 5000 }))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { filename, contentType, size, handle } = body;

    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename and contentType required' });
    }
    if (!ALLOWED_RE.test(contentType)) {
      return res.status(400).json({ error: 'Only image and video files are allowed' });
    }
    if (size && size > 52 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (50MB max)' });
    }

    const folder = contentType.startsWith('video/') ? 'videos' : 'screenshots';
    const ext = (filename.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const tag = slugify(handle) || 'guest';
    const stamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    const path = `${folder}/${stamp}-${tag}-${rand}.${ext}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({
      path,
      folder,
      signedUrl: data.signedUrl,
      token: data.token,
      publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
