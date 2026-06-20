# Purely Site

The marketing/landing site for the Purely ingredient-scanner app. A static HTML/CSS/JS site with serverless API routes and Supabase integration. Deployed on Vercel.

## Tech Stack

- **Frontend:** Vanilla HTML, CSS, JavaScript (no framework, no bundler)
- **Backend:** Vercel serverless functions (Node.js) in `api/`
- **Database:** Supabase (via `@supabase/supabase-js`)
- **Static server (dev):** `npx serve`

## Setup

```bash
npm install
# Configure environment variables (Supabase URL, anon key, API keys)
# For Vercel deployment, set env vars in the Vercel dashboard
```

## Build / Run / Test

```bash
# Start local static server on port 3000
npm start
# or:
npm run dev:static

# No build step for static assets
npm run build
# (prints: "static site — no build step")
```

For local API function testing use Vercel CLI: `vercel dev`.

## Project Structure

```
index.html           # Main landing page
styles.css           # Global styles
script.js            # Main page JS
analyze.html/css/js  # Product analysis page
preview.html/css/js  # Preview/demo page
ideas.html/css/js    # Ideas page
influencer.html/css/js  # Influencer page
tiktok.html/css/js   # TikTok content page
api/                 # Vercel serverless functions (Node.js)
  analyze-product.js     # Product analysis API
  generate-lifestyle.js  # Lifestyle image generation
  _purely-prompt.js      # Shared AI prompt template
  _db-lookup.js          # Supabase lookup helper
  _security.js           # Request validation/security
  ideas.js               # Ideas generation
  img.js / product-image.js / tiktok-image.js  # Image APIs
  list.js / refresh-ideas.js / sign-upload.js  # Other endpoints
  tiktok-analyze.js      # TikTok content analysis
supabase/
  config.toml        # Supabase project config
  migrations/        # DB migrations
public/              # Static public assets
vercel.json          # Vercel routing config
```

## Architecture & Key Files

- All pages are standalone HTML files — no SPA routing
- `api/` files are Vercel serverless functions; each exports a default handler
- `api/_*.js` files (underscore prefix) are shared helpers, not exposed as routes
- `supabase/` — DB migrations; apply with Supabase CLI (`supabase db push`)
- `vercel.json` — controls routing and function configuration for Vercel

## Conventions & Notes for Agents

- This is a static site with no build step — HTML/CSS/JS changes are live immediately
- API functions in `api/` follow Vercel's serverless function signature: `(req, res) => {}`
- Shared helpers use underscore prefix (`_db-lookup.js`, etc.) — Vercel does not expose these as routes
- Supabase credentials must be set as environment variables; never hardcode them
- `sharp` is a dev dependency used for image processing scripts, not for the static site itself
- Test API routes locally with `vercel dev` (requires Vercel CLI)
