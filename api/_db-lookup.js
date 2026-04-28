/**
 * Looks up a product in the huge_dataset Supabase project from OCR text
 * extracted by the client (Tesseract.js). Returns the matched items_full
 * row plus enriched ingredient details, or null if no confident match.
 *
 * Anon key + public-read RLS — no service-role secret in this path.
 */
const HUGE_URL = (process.env.HUGE_DATASET_URL || '').trim();
const HUGE_ANON = (process.env.HUGE_DATASET_ANON || '').trim();

const STOPWORDS = new Set([
  'the','and','with','for','from','that','this','will','your','net','wt','oz',
  'lbs','ml','mg','kg','tbsp','tsp','grams','gram','non','gmo','organic',
  'natural','healthy','clean','wholesome','artisan','all','new','more','less',
  'low','high','fat','free','reduced','zero','contains','may','made','best','if',
  'used','by','dist','distributed','manufactured','product','products','of',
  'usa','please','recycle','keep','refrigerated','shake','well','open','here',
  'serving','servings','calories','per','daily','value','vitamin','vitamins',
  'shop','store','www','com','net','org','code','barcode','since','est','est.'
]);

function tokenize(text) {
  return Array.from(new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  )).slice(0, 12);
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`huge_dataset ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

const COLS = [
  'id','name','type','score','image','transparent_image',
  'brand_name','company_name','packaging','barcode','price',
  'contaminant_count','is_pfas_tested','is_microplastics_tested',
  'recall_title','recall_severity','affiliate_url','data'
].join(',');

// Run a PostgREST query that ANDs every passed token against `name`. PostgREST
// repeats filter params as AND, so `?name=ilike.*a*&name=ilike.*b*` requires
// both. Tokens are sorted longest-first (more distinctive) before ANDing.
async function searchAnd(tokens, headers) {
  if (tokens.length === 0) return [];
  const params = new URLSearchParams();
  params.append('select', COLS);
  for (const t of tokens) params.append('name', `ilike.*${t}*`);
  params.append('limit', '20');
  const url = `${HUGE_URL}/rest/v1/items_full?${params.toString()}`;
  try { return await fetchJson(url, headers); }
  catch { return []; }
}

async function findItem(ocrText) {
  if (!HUGE_URL || !HUGE_ANON) return null;
  const tokens = tokenize(ocrText);
  if (tokens.length === 0) return null;

  const headers = { apikey: HUGE_ANON, Authorization: `Bearer ${HUGE_ANON}` };

  // Sort longest-first — long words ("kirkland", "signature") are far more
  // selective than short ones ("oil", "tea").
  const distinctive = [...tokens].sort((a, b) => b.length - a.length);

  // Try ANDs from most → least restrictive: 4 tokens, then 3, then 2.
  // The first non-empty result set is what we rank.
  let rows = [];
  for (const n of [4, 3, 2]) {
    if (distinctive.length < n) continue;
    rows = await searchAnd(distinctive.slice(0, n), headers);
    if (rows.length) break;
  }
  if (!rows.length) return null;

  const ranked = rows
    .map((row) => {
      const hay = `${row.name} ${row.brand_name || ''}`.toLowerCase();
      let s = 0;
      for (const t of tokens) if (hay.includes(t)) s++;
      const expected = tokens.length * 5;
      const lenPenalty = Math.min(1, Math.abs(row.name.length - expected) / 60);
      return { row, score: s - lenPenalty };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 2) return null;

  const row = best.row;

  // In parallel: fetch ingredient details + DB-hosted mirrored image + the
  // raw items row (for brand_id/company_id/serving_size that items_full hides)
  // + healthier alternatives. Same-bucket queries — no third-party CORS,
  // cached at the edge.
  const ings = (row.data?.ingredients || []).filter((i) => i && i.ingredient_id);
  const ingIds = Array.from(new Set(ings.map((i) => i.ingredient_id))).join(',');
  // The `ingredients` table stores `description/risks/benefits` inside the
  // `data` jsonb blob (not top-level columns). Pull the columns we need plus
  // `data` and read the nested fields below.
  const ingUrl = ingIds
    ? `${HUGE_URL}/rest/v1/ingredients?id=in.(${ingIds})&select=id,name,legal_limit,health_guideline,measure,severity_score,bonus_score,is_contaminant,data`
    : null;
  const itemUrl = `${HUGE_URL}/rest/v1/items?id=eq.${row.id}&select=mirrored_image,mirror_status,brand_id,company_id,serving_size,serving_unit&limit=1`;
  const altUrl  = `${HUGE_URL}/rest/v1/items?type=eq.${encodeURIComponent(row.type || '')}&score=gt.${row.score || 0}&id=neq.${row.id}&order=score.desc.nullslast&limit=8&select=id,name,score,type,mirrored_image,image,brand_id`;

  const [ingDetails, itemRows, altRows] = await Promise.all([
    ingUrl ? fetchJson(ingUrl, headers).catch(() => []) : Promise.resolve([]),
    fetchJson(itemUrl, headers).catch(() => []),
    row.type ? fetchJson(altUrl, headers).catch(() => []) : Promise.resolve([])
  ]);

  if (ings.length) {
    // Flatten data->>description/risks/benefits up to the top level so
    // downstream code can read i.details.description without juggling jsonb.
    const byId = new Map(ingDetails.map((d) => {
      const blob = (d && d.data) || {};
      return [d.id, {
        ...d,
        description: typeof blob.description === 'string' ? blob.description : '',
        risks:       typeof blob.risks       === 'string' ? blob.risks       : '',
        benefits:    typeof blob.benefits    === 'string' ? blob.benefits    : '',
        sources:     Array.isArray(blob.sources) ? blob.sources : []
      }];
    }));
    row._ingredientDetails = ings.map((i) => ({ ...i, details: byId.get(i.ingredient_id) || null }));
  } else {
    row._ingredientDetails = [];
  }

  const item0 = itemRows && itemRows[0];
  if (item0) {
    if (item0.mirror_status === 'done' && item0.mirrored_image) row.mirrored_image = item0.mirrored_image;
    if (item0.brand_id) row.brand_id = item0.brand_id;
    if (item0.company_id) row.company_id = item0.company_id;
    if (item0.serving_size != null) row.serving_size = item0.serving_size;
    if (item0.serving_unit) row.serving_unit = item0.serving_unit;
  }

  // Side-fetch company logo + brand mirrored image (best-effort, no failure).
  // Done sequentially after we know company_id/brand_id from items lookup.
  if (row.company_id || row.brand_id) {
    const subFetches = [];
    if (row.company_id) {
      subFetches.push(
        fetchJson(`${HUGE_URL}/rest/v1/companies?id=eq.${row.company_id}&select=id,name,image,wide_logo,mirrored_image&limit=1`, headers)
          .then((rows) => { if (rows && rows[0]) row._company = rows[0]; })
          .catch(() => {})
      );
    }
    if (row.brand_id) {
      subFetches.push(
        fetchJson(`${HUGE_URL}/rest/v1/brands?id=eq.${row.brand_id}&select=id,name,image,mirrored_image&limit=1`, headers)
          .then((rows) => { if (rows && rows[0]) row._brand = rows[0]; })
          .catch(() => {})
      );
    }
    await Promise.all(subFetches);
  }

  row._alternatives = Array.isArray(altRows) ? altRows : [];
  row._matchScore = best.score;
  row._matchedTokens = tokens;
  return row;
}

const TYPE_TO_CATEGORY = {
  water: 'water', sparkling_water: 'water', spring_water: 'water', mineral_water: 'water', alkaline_water: 'water',
  milk: 'food', dairy: 'food', yogurt: 'food', cheese: 'food', butter: 'food', cream: 'food',
  eggs: 'food', meat: 'food', poultry: 'food', seafood: 'food', fish: 'food',
  olive_oil: 'food', cooking_oil: 'food', vinegar: 'food', honey: 'food',
  protein_bar: 'food', cereal: 'food', bread: 'food', snack: 'food', chocolate: 'food', candy: 'food',
  fruit: 'food', vegetable: 'food', pasta: 'food', rice: 'food', flour: 'food', spice: 'food',
  juice: 'food', soda: 'food', tea: 'food', coffee: 'food', kombucha: 'food', sports_drink: 'food',
  single_vitamins: 'supplement', multivitamin: 'supplement', protein_powder: 'supplement',
  pre_workout: 'supplement', creatine: 'supplement', collagen: 'supplement',
  skincare: 'cosmetic', makeup: 'cosmetic', sunscreen: 'cosmetic',
  shampoo: 'personal-care', conditioner: 'personal-care', soap: 'personal-care', toothpaste: 'personal-care',
  deodorant: 'personal-care', lotion: 'personal-care',
  clothing: 'clothing', textile: 'clothing'
};

function verdictFromScore(s) {
  if (s >= 80) return 'Excellent';
  if (s >= 65) return 'Good';
  if (s >= 50) return 'Okay';
  if (s >= 30) return 'Poor';
  return 'Bad';
}

function buildAnalysisFromItem(item) {
  const score = Number.isFinite(item.score) ? Math.max(0, Math.min(100, item.score)) : 50;
  const verdict = verdictFromScore(score);
  const meta = item.data?.metadata || {};
  const ings = item._ingredientDetails || [];

  const harmful = ings
    .filter((i) => (i.severity_score || 0) > 0 || (i.details?.is_contaminant === true))
    .sort((a, b) => (b.severity_score || 0) - (a.severity_score || 0))
    .slice(0, 8)
    .map((i) => ({
      name: i.name || i.details?.name || 'Unknown ingredient',
      reason: i.details?.risks
        || i.details?.description
        || `Flagged with severity score ${i.severity_score} in the Purely product database.`,
      source: i.details?.is_contaminant ? 'Purely DB · contaminant' : 'Purely product database'
    }));

  const beneficial = ings
    .filter((i) => (i.bonus_score || 0) > 0)
    .sort((a, b) => (b.bonus_score || 0) - (a.bonus_score || 0))
    .slice(0, 8)
    .map((i) => ({
      attribute: i.name || i.details?.name || 'Unknown',
      why: i.details?.benefits
        || i.details?.description
        || `Adds bonus ${i.bonus_score} for ingredient quality.`,
      source: 'Purely product database'
    }));

  const contaminants = [];
  if ((item.contaminant_count || 0) > 0) {
    contaminants.push({
      name: 'Documented contaminants',
      amount: `${item.contaminant_count} flagged`,
      limit: 'See Purely lab records',
      limitSource: 'Purely DB',
      status: 'DETECTED',
      multiplier: '',
      concern: `${item.contaminant_count} contaminant${item.contaminant_count === 1 ? '' : 's'} on file for this exact product in Purely's database.`,
      source: 'Purely product database'
    });
  }
  if (item.recall_title) {
    contaminants.push({
      name: item.recall_severity ? `Recall (${item.recall_severity})` : 'Active or historical recall',
      amount: '',
      limit: '',
      limitSource: '',
      status: 'RECALL',
      multiplier: '',
      concern: item.recall_title,
      source: 'FDA / manufacturer notice'
    });
  }
  if (item.is_pfas_tested === false) {
    contaminants.push({
      name: 'PFAS testing',
      amount: 'Not tested',
      limit: '',
      limitSource: 'EPA',
      status: 'TRACE',
      multiplier: '',
      concern: 'No published PFAS lab data for this product.',
      source: 'Purely product database'
    });
  }

  let mpStatus = 'No published data';
  let mpContext = '';
  let mpSource = '';
  if (item.is_microplastics_tested === true) {
    mpStatus = 'Tested';
    mpContext = 'This product has microplastics lab records on file.';
    mpSource = 'Purely product database';
  } else if (/water/i.test(item.type || '') || /water/i.test(item.name || '')) {
    mpStatus = 'Likely';
    mpContext = 'Bottled water has been shown to contain microplastics in multiple studies (Orb Media 2018, Columbia 2024).';
    mpSource = 'Peer-reviewed studies';
  }

  const top = [];
  const meta2 = meta || {};
  if (meta2.is_organic === true)  top.push({ label: 'Organic',     value: 'Certified organic',                     verdict: 'good' });
  if (meta2.is_organic === false) top.push({ label: 'Organic',     value: 'Not certified',                         verdict: 'warn' });
  if (meta2.is_grass_fed === true) top.push({ label: 'Grass-fed', value: 'Yes',                                    verdict: 'good' });
  if (meta2.feed_type === 'majority_pasture')      top.push({ label: 'Feed', value: 'Majority pasture',            verdict: 'good' });
  if (meta2.feed_type === 'conventional_corn_soy') top.push({ label: 'Feed', value: 'Conventional corn / soy',     verdict: 'bad'  });
  if (meta2.hormone_use === 'rbst_free')   top.push({ label: 'Hormones',   value: 'rBST-free',                     verdict: 'good' });
  if (meta2.antibiotic_use === 'never')    top.push({ label: 'Antibiotics',value: 'Never used',                    verdict: 'good' });
  if (meta2.antibiotic_use === 'unknown')  top.push({ label: 'Antibiotics',value: 'Not disclosed',                 verdict: 'warn' });
  if (meta2.processing_level === 'pasteurized')        top.push({ label: 'Processing', value: 'Pasteurized',       verdict: 'warn' });
  if (meta2.processing_level === 'ultra_pasteurized')  top.push({ label: 'Processing', value: 'Ultra-pasteurized', verdict: 'bad'  });
  if (meta2.pesticide_risk === 'low')   top.push({ label: 'Pesticide risk', value: 'Low',                          verdict: 'good' });
  if (meta2.pesticide_risk === 'medium')top.push({ label: 'Pesticide risk', value: 'Medium',                       verdict: 'warn' });
  if (meta2.pesticide_risk === 'high')  top.push({ label: 'Pesticide risk', value: 'High',                         verdict: 'bad'  });
  if (item.is_pfas_tested === true)     top.push({ label: 'PFAS-tested',  value: 'Yes',                            verdict: 'good' });
  if (item.packaging)                   top.push({ label: 'Packaging',     value: String(item.packaging),          verdict: 'warn' });
  if (top.length < 4) {
    top.push({ label: 'Overall', value: `${verdict} (${score}/100)`, verdict: score >= 65 ? 'good' : score >= 40 ? 'warn' : 'bad' });
  }

  const harmfulCount = harmful.length + contaminants.length;
  const beneficialCount = beneficial.length;

  const headline =
    `${item.brand_name ? item.brand_name + ' — ' : ''}${item.name} scores ${score}/100 in the Purely database` +
    (harmfulCount ? `, with ${harmfulCount} concerning entr${harmfulCount === 1 ? 'y' : 'ies'} on file.` : '.');

  const category = TYPE_TO_CATEGORY[item.type] || 'other';
  const subcategory = (item.type || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // Full ingredient list (every ingredient on file) — drives the "What's
  // inside" cards in the mockup. Status is derived from the same severity /
  // bonus signals used by the mobile app's productDetailToAnalyzedProduct.
  const allIngredients = ings.map((i) => {
    const sev = Number(i.severity_score) || 0;
    const bon = Number(i.bonus_score) || 0;
    const status = sev >= 1 ? 'harmful' : bon >= 1 ? 'beneficial' : 'neutral';
    return {
      name: i.name || i.details?.name || 'Ingredient',
      status,
      description:
        i.details?.description
        || (status === 'harmful'  ? (i.details?.risks    || `Flagged with severity score ${sev} in the Purely database.`)
          : status === 'beneficial' ? (i.details?.benefits || `Adds bonus ${bon} for ingredient quality.`)
          : 'Common ingredient with no flagged risks or special benefits in our database.'),
      severity_score: sev,
      bonus_score: bon
    };
  });

  // Serving size string ("12 fl oz", "240 mL") for the Nutrition Facts panel.
  const servingSize = item.serving_size != null
    ? `${item.serving_size}${item.serving_unit ? ` ${item.serving_unit}` : ''}`
    : '';

  // "Owned by" parent-company info — same-bucket logos, no CORS round-trip.
  const company = item._company ? {
    id: item._company.id,
    name: item._company.name,
    logo: item._company.mirrored_image || item._company.wide_logo || item._company.image || ''
  } : null;

  // Brand link target ("Kirkland Signature" → /brand/123).
  const brandInfo = item._brand ? {
    id: item._brand.id,
    name: item._brand.name,
    logo: item._brand.mirrored_image || item._brand.image || ''
  } : (item.brand_name ? { id: item.brand_id || null, name: item.brand_name, logo: '' } : null);

  // Healthier alternatives — same `type`, higher `score`. Reuse mirrored
  // image when present, fall back to third-party `image`.
  const alternatives = (item._alternatives || []).slice(0, 6).map((alt) => ({
    id: alt.id,
    name: alt.name,
    type: alt.type,
    score: alt.score,
    image: alt.mirrored_image || alt.image || ''
  }));

  return {
    product: {
      name: item.name,
      brand: item.brand_name || '',
      category,
      subcategory,
      image_subject: item.name,
      package_color: ''
    },
    score,
    verdict,
    headline,
    harmfulCount,
    beneficialCount,
    microplastics: { status: mpStatus, level: '', context: mpContext, source: mpSource },
    contaminants,
    harmfulIngredients: harmful,
    beneficialAttributes: beneficial,
    // New fields modelled on the mobile-app AnalyzedProduct shape.
    allIngredients,
    company,
    brandInfo,
    servingSize,
    alternatives,
    packagingMaterial: item.packaging || '',
    sources: [
      { name: 'Purely product database', description: `Real product record from Purely's curated database (${item._matchedTokens?.length || 0} OCR tokens matched).`, url: '' }
    ],
    breakdown: {
      deductions: harmful.map((h) => ({ item: h.name, points: -5 })).concat(contaminants.map((c) => ({ item: c.name, points: -8 }))),
      additions: beneficial.map((b) => ({ item: b.attribute, points: 3 }))
    },
    uiSummary: { topAttributes: top.slice(0, 6) },
    nutrients: Array.isArray(item.data?.nutrients) ? item.data.nutrients : []
  };
}

module.exports = { findItem, buildAnalysisFromItem, tokenize };
