/**
 * Lightweight defense for serverless endpoints.
 * - Origin/Referer allowlist (blocks cross-site abuse from browsers).
 * - Per-IP in-memory token bucket (best-effort across the Lambda instance).
 * - Global per-day cost ceiling stored in Supabase Storage (best-effort, never blocks the user on storage errors).
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const supabase = createClient(
  SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  { auth: { persistSession: false } }
);
const BUCKET = 'influencer-uploads';

const ALLOWED_HOSTS = new Set([
  'purely-site.vercel.app',
  'www.purely-site.vercel.app',
  'localhost:3000',
  'localhost:5173'
]);

function getHost(value) {
  if (!value) return null;
  try { return new URL(value).host.toLowerCase(); } catch { return null; }
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const host = getHost(origin);
  if (host && ALLOWED_HOSTS.has(host)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Verify the request comes from a browser tab on our own site (or curl/server).
 * Browsers always send Origin on POST. We allow:
 *  - Origin in our allowlist
 *  - Referer matching our allowlist
 *  - No Origin AND no Referer (server-to-server / curl)
 */
function checkOrigin(req) {
  const originHost = getHost(req.headers.origin);
  const refererHost = getHost(req.headers.referer);
  if (!originHost && !refererHost) return true; // server-to-server, allow
  if (originHost && ALLOWED_HOSTS.has(originHost)) return true;
  if (refererHost && ALLOWED_HOSTS.has(refererHost)) return true;
  return false;
}

/* ---------- per-IP rate limiter (in-memory) ---------- */
const buckets = new Map(); // ip -> { count, windowStart }
function rateLimit(ip, { perMinute = 10 } = {}) {
  const now = Date.now();
  const window = 60_000;
  const b = buckets.get(ip) || { count: 0, windowStart: now };
  if (now - b.windowStart > window) { b.count = 0; b.windowStart = now; }
  b.count++;
  buckets.set(ip, b);
  if (buckets.size > 5000) {
    // hard cap to avoid memory bloat
    const oldest = Array.from(buckets.entries()).sort((a, b) => a[1].windowStart - b[1].windowStart)[0];
    if (oldest) buckets.delete(oldest[0]);
  }
  return b.count <= perMinute;
}

/* ---------- daily global ceiling ---------- */
async function checkDailyCap(key, max) {
  // best-effort using Supabase Storage as a counter store
  const today = new Date().toISOString().slice(0, 10);
  const path = `rate-limit/${key}-${today}.json`;
  try {
    let count = 0;
    try {
      const { data } = await supabase.storage.from(BUCKET).download(path);
      if (data) {
        const t = await data.text();
        count = JSON.parse(t).count || 0;
      }
    } catch {}
    if (count >= max) return { ok: false, count, max };
    count += 1;
    await supabase.storage.from(BUCKET).upload(path, JSON.stringify({ count }), {
      contentType: 'application/json', upsert: true, cacheControl: '0'
    });
    return { ok: true, count, max };
  } catch {
    // Never block users on storage failures
    return { ok: true, count: -1, max };
  }
}

/* ---------- Compose middleware-style guard ---------- */
async function guard(req, res, opts = {}) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return false; }
  if (!checkOrigin(req)) { res.status(403).json({ error: 'origin not allowed' }); return false; }

  const ip = getClientIp(req);
  if (!rateLimit(ip, { perMinute: opts.perMinute || 10 })) {
    res.status(429).json({ error: 'too many requests, slow down' });
    return false;
  }
  if (opts.dailyKey && opts.dailyMax) {
    const cap = await checkDailyCap(opts.dailyKey, opts.dailyMax);
    if (!cap.ok) {
      res.status(429).json({ error: `daily ${opts.dailyKey} limit reached (${cap.max}). Try again tomorrow.` });
      return false;
    }
  }
  return true;
}

module.exports = { guard, applyCors, checkOrigin, rateLimit, checkDailyCap, getClientIp };
