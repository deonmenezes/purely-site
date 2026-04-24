module.exports = async function handler(req, res) {
  const u = req.query?.u || (req.url.match(/[?&]u=([^&]+)/) || [])[1];
  if (!u) return res.status(400).end('missing u');
  let target;
  try { target = decodeURIComponent(u); } catch { return res.status(400).end('bad url'); }
  if (!/^https?:\/\//i.test(target)) return res.status(400).end('bad url');
  const host = new URL(target).hostname;
  if (!/(tiktokcdn|tiktok|ibytedtos|amazonaws|cloudfront|supabase|gstatic|byteoversea|muscdn)/i.test(host)) {
    return res.status(400).end('host not allowed');
  }
  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' }
    });
    if (!upstream.ok) return res.status(upstream.status).end();
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  } catch (e) {
    return res.status(502).end('fetch failed');
  }
};
