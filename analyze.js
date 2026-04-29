/**
 * /analyze — product photo scanner.
 *
 * Flow:
 *   1. User picks a photo → signed-URL upload to Supabase
 *   2. POST /api/analyze-product with the public URL
 *   3. Server runs gpt-4o-mini OCR, looks the product up in huge_dataset,
 *      returns the curated DB row (real score, ingredients, nutrients,
 *      mirrored image) — no AI analysis, no fabricated data
 *   4. We render N distinct 9:16 "screens" (Score / Snapshot / Ingredients /
 *      per-ingredient deep-dive) — each one is a self-contained iPhone-style
 *      frame at fixed 9:16 aspect ratio
 *   5. Save buttons capture each frame separately via html2canvas → one PNG
 *      per frame. NO vertical slicing of one long page.
 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const photoInput = $('#photo-input');
  const photoDrop = $('#photo-drop');
  const photoPreview = $('#photo-preview');
  const photoThumb = $('#photo-thumb');
  const ppName = $('#pp-name');
  const ppSize = $('#pp-size');
  const ppClear = $('#pp-clear');
  const ppGo = $('#pp-go');
  const refreshToggle = $('#refresh-toggle');
  const progress = $('#tt-progress');
  const progFill = $('#tp-fill');
  const progStatus = $('#tp-status');
  const errBox = $('#tt-error');
  const results = $('#tt-results');
  const toast = $('#toast');

  let pickedFile = null;
  let forceRefresh = false;

  const PURELY_LOGO_PATH = '/assets/purely-logo.png?v=3';

  /* ---------- Tiny utilities ---------- */
  function showToast(msg, type = '') {
    toast.textContent = msg;
    toast.className = 'toast show ' + type;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => (toast.hidden = true), 250);
    }, 3000);
  }
  function setStep(name, state) {
    document.querySelectorAll('.tp-step').forEach((el) => {
      if (el.dataset.step === name) {
        el.classList.remove('active', 'done');
        if (state) el.classList.add(state);
      }
    });
  }
  function setProgress(pct, msg) {
    progFill.style.width = pct + '%';
    if (msg) progStatus.innerHTML = msg;
  }
  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = false;
  }
  function hideError() { errBox.hidden = true; errBox.textContent = ''; }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function safeSlug(s) {
    return String(s || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
  }
  function proxied(u) {
    return u && /^https?:/i.test(u) ? `/api/img?u=${encodeURIComponent(u)}` : u;
  }

  /* ---------- Score color ramp (mirror of lib/scoreColor.ts) ---------- */
  const SCORE_STOPS = [
    { s: 0,   h: 0,   sat: 80, l: 48 },
    { s: 25,  h: 12,  sat: 82, l: 52 },
    { s: 50,  h: 38,  sat: 88, l: 52 },
    { s: 70,  h: 80,  sat: 70, l: 45 },
    { s: 85,  h: 130, sat: 65, l: 40 },
    { s: 100, h: 145, sat: 72, l: 36 }
  ];
  function scoreColor(score) {
    const c = Math.max(0, Math.min(100, Number(score) || 0));
    for (let i = 0; i < SCORE_STOPS.length - 1; i++) {
      const a = SCORE_STOPS[i], b = SCORE_STOPS[i + 1];
      if (c >= a.s && c <= b.s) {
        const t = (c - a.s) / (b.s - a.s || 1);
        const h = a.h + (b.h - a.h) * t;
        const sat = a.sat + (b.sat - a.sat) * t;
        const l = a.l + (b.l - a.l) * t;
        return `hsl(${h.toFixed(0)},${sat.toFixed(0)}%,${l.toFixed(0)}%)`;
      }
    }
    return 'hsl(145,72%,36%)';
  }
  function scoreLabel(s) {
    if (s >= 80) return 'Excellent';
    if (s >= 65) return 'Good';
    if (s >= 50) return 'Okay';
    if (s >= 30) return 'Poor';
    return 'Avoid';
  }

  /* ---------- Photo drop handlers ---------- */
  function setPhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { showToast('Pick an image file', 'err'); return; }
    if (file.size > 8 * 1024 * 1024) { showToast('Photo over 8MB — pick a smaller one', 'err'); return; }
    pickedFile = file;
    photoThumb.src = URL.createObjectURL(file);
    ppName.textContent = file.name;
    ppSize.textContent = fmtBytes(file.size);
    photoPreview.hidden = false;
    photoDrop.hidden = true;
  }

  photoInput.addEventListener('change', (e) => setPhoto(e.target.files[0]));
  ppClear.addEventListener('click', () => {
    pickedFile = null;
    photoPreview.hidden = true;
    photoDrop.hidden = false;
    photoInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) => photoDrop.addEventListener(ev, (e) => {
    e.preventDefault(); photoDrop.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => photoDrop.addEventListener(ev, (e) => {
    e.preventDefault(); photoDrop.classList.remove('drag');
  }));
  photoDrop.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) setPhoto(e.dataTransfer.files[0]);
  });
  ppGo.addEventListener('click', () => analyzePhoto());
  refreshToggle.addEventListener('click', () => {
    forceRefresh = !forceRefresh;
    refreshToggle.classList.toggle('active', forceRefresh);
    refreshToggle.textContent = forceRefresh ? 'Force refresh ON' : 'Force refresh';
  });

  /* ---------- Main pipeline ---------- */
  async function analyzePhoto() {
    if (!pickedFile) return;
    hideError();
    progress.hidden = false;
    results.hidden = true;
    results.innerHTML = '';
    ppGo.disabled = true; ppGo.classList.add('busy');
    setProgress(8, '<strong>Uploading photo</strong>…');
    setStep('upload', 'active');
    setStep('ocr', null); setStep('match', null); setStep('render', null);

    let imageUrl;
    try {
      const sign = await fetch('/api/sign-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: pickedFile.name,
          contentType: pickedFile.type,
          size: pickedFile.size,
          handle: 'product'
        })
      });
      const signJ = await sign.json();
      if (!sign.ok) throw new Error(signJ.error || 'upload sign failed');

      const put = await fetch(signJ.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': pickedFile.type, 'x-upsert': 'true' },
        body: pickedFile
      });
      if (!put.ok) throw new Error('upload PUT failed (' + put.status + ')');
      imageUrl = signJ.publicUrl;
    } catch (e) {
      showError('Upload error: ' + e.message);
      ppGo.disabled = false; ppGo.classList.remove('busy');
      progress.hidden = true;
      return;
    }
    setStep('upload', 'done');
    setStep('ocr', 'active');
    setProgress(30, '<strong>Reading the label</strong> with gpt-4o-mini vision…');

    let payload;
    try {
      const r = await fetch('/api/analyze-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl, refresh: forceRefresh })
      });
      payload = await r.json();
      if (!r.ok) throw new Error(payload.error || 'analysis failed');
    } catch (e) {
      showError('Analysis error: ' + e.message);
      ppGo.disabled = false; ppGo.classList.remove('busy');
      return;
    }
    setStep('ocr', 'done');
    setStep('match', 'done');

    if (payload.source === 'no_match' || !payload.analysis) {
      progress.hidden = true;
      ppGo.disabled = false; ppGo.classList.remove('busy');
      renderNoMatch(payload, imageUrl);
      return;
    }

    setProgress(85, `<strong>Score: ${payload.analysis?.score ?? '?'} / 100</strong> · matched <em>${escapeHtml(payload.matchedName || '')}</em> · rendering screens…`);
    setStep('render', 'active');
    const displayImage = payload.imageUrl || imageUrl;
    renderResult(payload, displayImage);
    setStep('render', 'done');
    setProgress(100, '<strong>Done</strong> — distinct shareable screens ready.');
    ppGo.disabled = false; ppGo.classList.remove('busy');
  }

  function renderNoMatch(payload, imageUrl) {
    const ex = payload.ocrExtracted || {};
    const labelLine = (ex.brand || ex.name)
      ? `Read from label: "${escapeHtml([ex.brand, ex.name].filter(Boolean).join(' — ').slice(0, 200))}"`
      : '';
    results.hidden = false;
    results.innerHTML = `
      <div class="az-no-match">
        <div class="photo"><img src="${escapeHtml(imageUrl)}" alt=""/></div>
        <h2>Not in our database — yet</h2>
        <p>${escapeHtml(payload.reason || 'We couldn\'t match this product.')} The Purely catalog covers 430,000+ products but doesn't have this one yet. Try a closer shot of the label, or scan a different product.</p>
        ${labelLine ? `<div class="ocr">${labelLine}</div>` : ''}
      </div>`;
  }

  /* ============================================================
   *  Build the result panel + N distinct 9:16 screens.
   *  Each screen is captured separately as one PNG (no slicing).
   * ============================================================ */
  function renderResult(payload, imageUrl) {
    const a = payload.analysis || {};
    const p = a.product || {};
    const score = Math.max(0, Math.min(100, Math.round(Number(a.score) || 0)));
    const ringColor = scoreColor(score);
    const verdict = a.verdict || scoreLabel(score);
    const brand = p.brand || '';
    const name = p.name || 'Product';
    const matchedFrom = payload.matchedName || '';
    const slug = safeSlug(name);

    const harmCount = a.harmfulCount ?? ((a.harmfulIngredients?.length || 0) + (a.contaminants?.length || 0));
    const benCount = a.beneficialCount ?? (a.beneficialAttributes?.length || 0);
    const mp = a.microplastics || {};
    const mpStatus = (typeof mp === 'string') ? mp : (mp.status || 'No data');
    const mpDetected = /Detected|Likely|High/i.test(mpStatus);

    /* Build a unified findings list (top concerns first). */
    const findings = [];
    (a.contaminants || []).slice(0, 4).forEach((c) => findings.push({
      kind: 'bad', name: c.name,
      val: c.amount || c.multiplier || c.status || 'Detected',
      body: c.concern || ''
    }));
    (a.harmfulIngredients || []).slice(0, 4).forEach((h) => findings.push({
      kind: 'bad', name: h.name, val: 'Harmful', body: h.reason || ''
    }));
    (a.beneficialAttributes || []).slice(0, 3).forEach((b) => findings.push({
      kind: 'good', name: b.attribute, val: 'Beneficial', body: b.why || ''
    }));
    if ((a.uiSummary?.topAttributes || []).length) {
      a.uiSummary.topAttributes.slice(0, 4).forEach((t) => {
        const verdict = String(t.verdict || '').toLowerCase();
        const kind = /bad|harm/.test(verdict) ? 'bad' : /good|benef/.test(verdict) ? 'good' : 'neutral';
        findings.push({
          kind,
          name: t.label || t.value || 'Attribute',
          val: t.value || '',
          body: t.note || ''
        });
      });
    }
    /* Dedup by name */
    const seen = new Set();
    const dedup = findings.filter((f) => {
      const k = String(f.name || '').toLowerCase().trim();
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });

    /* Ingredient list — prefer DB allIngredients, fall back to findings. */
    const dbIngs = Array.isArray(a.allIngredients) ? [...a.allIngredients] : [];
    dbIngs.sort((a, b) => {
      const rank = (i) => i.status === 'harmful' ? 0 : i.status === 'beneficial' ? 1 : 2;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (b.severity_score || 0) + (b.bonus_score || 0)
           - (a.severity_score || 0) - (a.bonus_score || 0);
    });

    /* Pick up to 4 ingredients for deep-dive screens (most-impactful first). */
    const deepDive = dbIngs.length
      ? dbIngs.filter((i) => i.status === 'harmful' || i.status === 'beneficial').slice(0, 4)
      : dedup.filter((f) => f.kind !== 'neutral').slice(0, 4).map((f) => ({
          name: f.name,
          description: f.body,
          status: f.kind === 'bad' ? 'harmful' : 'beneficial',
          score: f.kind === 'bad' ? -3 : 3
        }));

    /* ---------- Header block (above the screens) ---------- */
    results.hidden = false;
    const headHtml = `
      <div class="az-result-hd">
        <div class="photo"><img src="${escapeHtml(proxied(imageUrl))}" alt=""></div>
        <div>
          <h2>${escapeHtml(name)}</h2>
          ${brand ? `<div class="brand">${escapeHtml(brand)}</div>` : ''}
          ${matchedFrom ? `<div class="matched">Matched from Purely DB: "${escapeHtml(matchedFrom)}"</div>` : ''}
        </div>
        <div class="score-pill" style="border-color:${ringColor};box-shadow:inset 0 0 0 2px ${ringColor}33">
          <strong style="color:${ringColor}">${score}</strong>
          <span>${escapeHtml(verdict)}</span>
        </div>
      </div>`;

    const toolbarHtml = `
      <div class="az-screens-hd">
        <div class="copy">
          <h3>Shareable screens</h3>
          <p>Each card below is a standalone 9:16 frame — drop one straight into a TikTok or Reel. Save individually with the icon, or grab them all at once.</p>
        </div>
        <button class="az-save-all" id="az-save-all" title="Download every screen as a separate PNG">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Save all screens</span>
        </button>
      </div>`;

    /* ---------- Frame markup ---------- */
    const frames = [];

    // Frame 1: Score / Hero
    frames.push({
      key: 'score',
      filename: `purely-${slug}-score.png`,
      label: 'Score',
      html: frameScore({ name, brand, ringColor, score, verdict, imageUrl, mpDetected })
    });

    // Frame 2: Snapshot (stats + concerns)
    frames.push({
      key: 'snapshot',
      filename: `purely-${slug}-snapshot.png`,
      label: 'Snapshot',
      html: frameSnapshot({ name, brand, ringColor, score, imageUrl, harmCount, benCount, mpStatus, findings: dedup })
    });

    // Frame 3: Ingredient list (top items, fits in 9:16)
    if (dbIngs.length || dedup.length) {
      frames.push({
        key: 'inside',
        filename: `purely-${slug}-inside.png`,
        label: "What's inside",
        html: frameInside({ name, brand, ringColor, score, imageUrl, ingredients: dbIngs.slice(0, 6).length ? dbIngs.slice(0, 6) : dedup.slice(0, 6).map(toFakeIng) })
      });
    }

    // Frame 4..N: Per-ingredient deep dive
    deepDive.forEach((ing, i) => {
      const safeIng = safeSlug(ing.name);
      frames.push({
        key: `deep-${i}`,
        filename: `purely-${slug}-${safeIng}.png`,
        label: (ing.name || 'Ingredient').slice(0, 22),
        html: frameDeepDive({ ing, productName: name, productScore: score })
      });
    });

    const screensHtml = `
      <div class="az-screens" id="az-screens">
        ${frames.map((f, i) => `
          <div class="az-frame" data-frame-key="${escapeHtml(f.key)}" data-filename="${escapeHtml(f.filename)}">
            <div class="azf-controls">
              <button class="azf-dl-btn" title="Save this screen as PNG" aria-label="Save screen">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
            <div class="azf-label">${escapeHtml(f.label)}</div>
            <div class="az-frame-inner">${f.html}</div>
          </div>`).join('')}
      </div>`;

    /* Interactive iPhone preview — rendered by tiktok.js's renderToxinReport
     * (the exact same component the /tiktok page uses). The .pr-app-preview
     * class triggers the page-mode behavior in attachExpand: clicks on
     * ingredient rows open the detail modal, the slice-based "Save PNG"
     * button is hidden by analyze.css. */
    const previewHtml = `
      <div class="az-preview-wrap">
        <div class="az-preview-hd">
          <h3>Live preview</h3>
          <p>The full Purely-app result screen for this product — tap any ingredient row to open its detail panel. Pulled live from the database.</p>
        </div>
        <div class="pr-app-preview az-preview-tile" data-screen="report">
          <div class="skel"></div>
        </div>
      </div>`;

    results.innerHTML = `
      <div class="az-result">
        ${headHtml}
        ${previewHtml}
        ${toolbarHtml}
        ${screensHtml}
      </div>`;

    /* Render the live phone-UI preview using the shared renderer from
     * tiktok.js. Same data shape /tiktok's photo flow used to pass. */
    if (window.PurelyApp?.renderToxinReport) {
      const tile = document.querySelector('.az-preview-tile');
      if (tile) {
        try {
          window.PurelyApp.renderToxinReport(tile, {
            name, brand,
            score, verdict,
            imageUrl,
            harmCount, benCount,
            microplastics: mpStatus,
            microplasticsDetail: typeof mp === 'object' ? mp : null,
            category: p.subcategory || p.category || 'Other',
            packaging: a.packagingMaterial || a.packaging?.material || (p.package_color ? `${p.package_color} container` : ''),
            findings: dedup.map((f) => ({
              kind: f.kind, name: f.name, label: f.name,
              value: f.val, body: f.body || '', pill: f.val
            })),
            allIngredients: a.allIngredients || null,
            company: a.company || null,
            brandInfo: a.brandInfo || null,
            servingSize: a.servingSize || '',
            alternatives: a.alternatives || [],
            nutrients: a.nutrients || [],
            filename: `purely-${slug}.png`
          });
        } catch (e) {
          console.warn('[analyze] preview render failed:', e);
        }
      }
    }

    /* Wire per-frame download buttons */
    document.querySelectorAll('.az-frame').forEach((frame) => {
      const btn = frame.querySelector('.azf-dl-btn');
      const fname = frame.dataset.filename;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.classList.contains('busy')) return;
        btn.classList.add('busy'); btn.disabled = true;
        try {
          await downloadFrame(frame, fname);
          showToast('Saved', 'ok');
        } catch (err) {
          showToast('Download failed: ' + (err.message || err), 'err');
        } finally {
          btn.classList.remove('busy'); btn.disabled = false;
        }
      });
    });

    const saveAllBtn = document.getElementById('az-save-all');
    saveAllBtn?.addEventListener('click', async () => {
      if (saveAllBtn.classList.contains('busy')) return;
      saveAllBtn.classList.add('busy'); saveAllBtn.disabled = true;
      const lbl = saveAllBtn.querySelector('span');
      const orig = lbl ? lbl.textContent : '';
      let total = 0;
      try {
        const list = Array.from(document.querySelectorAll('.az-frame'));
        for (let i = 0; i < list.length; i++) {
          if (lbl) lbl.textContent = `Saving ${i + 1} / ${list.length}…`;
          await downloadFrame(list[i], list[i].dataset.filename);
          total++;
          await sleep(280);
        }
        showToast(`Saved ${total} screen${total === 1 ? '' : 's'}`, 'ok');
      } catch (e) {
        showToast('Save failed: ' + (e.message || e), 'err');
      } finally {
        saveAllBtn.classList.remove('busy'); saveAllBtn.disabled = false;
        if (lbl) lbl.textContent = orig;
      }
    });
  }

  /* ============================================================
   *  Frame builders — each returns ONE 9:16 screen's HTML
   * ============================================================ */

  function statusBarHtml() {
    return `
      <div class="azf-status">
        <span>9:41</span>
        <div class="right">
          <svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="0.5"/><rect x="4" y="6" width="3" height="6" rx="0.5"/><rect x="8" y="3" width="3" height="9" rx="0.5"/><rect x="12" y="0" width="3" height="12" rx="0.5"/></svg>
          <svg viewBox="0 0 18 13" fill="currentColor"><path d="M9 11l3.5-3a5 5 0 00-7 0L9 11zm0-6a8 8 0 015.5 2.2l1.3-1.3a10 10 0 00-13.6 0l1.3 1.3A8 8 0 019 5z"/></svg>
          <svg viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="22" height="11" rx="2.5" stroke="currentColor" fill="none"/><rect x="2.5" y="2.5" width="18" height="7" rx="1" fill="currentColor"/><rect x="23" y="3.5" width="2" height="5" rx="1" fill="currentColor"/></svg>
        </div>
      </div>`;
  }

  function appBarHtml() {
    return `
      <div class="azf-bar">
        <button class="azf-bar-btn" aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="azf-bar-pill">
          <img src="${PURELY_LOGO_PATH}" alt="">
          <span>Purely App</span>
        </div>
        <button class="azf-bar-btn" aria-label="Share">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8 12L16 5M8 12l8 7M8 12h12" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>`;
  }

  function miniHeaderHtml({ name, brand, ringColor, score, imageUrl }) {
    return `
      <div class="azf-mini-hd">
        <div class="azf-mini-thumb">
          ${imageUrl
            ? `<img src="${escapeHtml(proxied(imageUrl))}" alt="" crossorigin="anonymous">`
            : `<span style="font-weight:800;color:${ringColor};font-size:18px">${escapeHtml((brand || name).charAt(0).toUpperCase())}</span>`}
        </div>
        <div>
          <div class="azf-mini-name">${escapeHtml(name.slice(0, 38))}</div>
          ${brand ? `<div class="azf-mini-brand">${escapeHtml(brand.slice(0, 30))}</div>` : ''}
        </div>
        <span class="azf-mini-score" style="--ring:${ringColor};background:${ringColor}">${score}</span>
      </div>`;
  }

  function ringSvg(score, color) {
    const dash = (Math.max(0, Math.min(100, score)) / 100) * 289;
    const angleDeg = (score / 100) * 360 - 90;
    const dotX = 51 + 46 * Math.cos(angleDeg * Math.PI / 180);
    const dotY = 51 + 46 * Math.sin(angleDeg * Math.PI / 180);
    return `
      <svg viewBox="0 0 102 102">
        <circle cx="51" cy="51" r="46" stroke="#E3E0DA" stroke-width="7" fill="none"/>
        <circle cx="51" cy="51" r="46" stroke="${color}" stroke-width="7" fill="none"
          stroke-linecap="round"
          stroke-dasharray="289.03"
          stroke-dashoffset="${(289.03 * (1 - score / 100)).toFixed(2)}"
          transform="rotate(-90 51 51)"/>
        <circle cx="${dotX.toFixed(2)}" cy="${dotY.toFixed(2)}" r="5.5" fill="${color}"/>
      </svg>`;
  }

  function frameScore({ name, brand, ringColor, score, verdict, imageUrl, mpDetected }) {
    const isGood = score >= 75;
    const photoHtml = imageUrl
      ? `<img src="${escapeHtml(proxied(imageUrl))}" alt="" crossorigin="anonymous">`
      : `<div class="ph" style="background:linear-gradient(135deg,${ringColor},${ringColor}99)">${escapeHtml((brand || name).charAt(0).toUpperCase())}</div>`;
    const tagIco = isGood
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 12l4 4 10-10" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3l10 17H2L12 3zm0 6v5m0 3v.01" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `
      ${statusBarHtml()}
      ${appBarHtml()}
      <div class="azf-body" style="padding-top:10px">
        <div class="azf-hero">
          <div class="azf-hero-card">${photoHtml}</div>
          <div class="azf-name">${escapeHtml(name)}</div>
          ${brand ? `<div class="azf-brand">${escapeHtml(brand)}</div>` : ''}
          <div class="azf-tags">
            <span class="azf-tag ${isGood ? 'good' : 'warn'}">
              ${tagIco}
              ${isGood ? 'Health report' : 'Toxin report'}
            </span>
          </div>
        </div>
        <div class="azf-ring-wrap">
          <div class="azf-ring">
            ${ringSvg(score, ringColor)}
            <div class="azf-ring-text">
              <div class="num">${score}</div>
              <div class="lbl">${escapeHtml(verdict)}</div>
            </div>
          </div>
        </div>
        <div class="azf-foot">
          <span>Scored by</span>
          <img src="${PURELY_LOGO_PATH}" alt="">
          <strong>Purely</strong>
        </div>
      </div>`;
  }

  function frameSnapshot({ name, brand, ringColor, score, imageUrl, harmCount, benCount, mpStatus, findings }) {
    const mpDetected = /Detected|Likely|High/i.test(mpStatus);
    const top = (findings || []).slice(0, 5);
    return `
      ${statusBarHtml()}
      ${appBarHtml()}
      <div class="azf-body">
        ${miniHeaderHtml({ name, brand, ringColor, score, imageUrl })}
        <div class="azf-stats">
          <div class="azf-stat-card">
            <span class="v ${harmCount > 0 ? 'bad' : 'good'}">${harmCount}</span>
            <span class="l">Harmful substances</span>
          </div>
          <div class="azf-stat-card">
            <span class="v good">${benCount}</span>
            <span class="l">Beneficial</span>
          </div>
          <div class="azf-stat-card">
            <span class="v ${mpDetected ? 'bad' : ''}">${escapeHtml(String(mpStatus).slice(0, 14))}</span>
            <span class="l">Microplastics</span>
          </div>
        </div>
        ${top.length ? `<div class="azf-section-title">Top concerns</div>` : ''}
        ${top.map((f) => `
          <div class="azf-row">
            <span class="ico">${rowIcon(f.kind)}</span>
            <span class="lbl">${escapeHtml(String(f.name || '').slice(0, 32))}</span>
            <span class="val">${escapeHtml(String(f.val || '').slice(0, 18))}</span>
            <span class="dot ${f.kind === 'bad' ? 'bad' : f.kind === 'good' ? 'good' : ''}"></span>
          </div>`).join('')}
      </div>`;
  }

  function frameInside({ name, brand, ringColor, score, imageUrl, ingredients }) {
    const items = (ingredients || []).slice(0, 6);
    return `
      ${statusBarHtml()}
      ${appBarHtml()}
      <div class="azf-body">
        ${miniHeaderHtml({ name, brand, ringColor, score, imageUrl })}
        <div class="azf-section-title">What's inside</div>
        ${items.map((i) => {
          const status = i.status === 'harmful' ? 'harmful'
                       : i.status === 'beneficial' ? 'beneficial'
                       : 'neutral';
          const statusText = status.charAt(0).toUpperCase() + status.slice(1);
          return `
            <div class="azf-ing-card ${status}">
              <div class="azf-ing-name">${escapeHtml(String(i.name || '').slice(0, 36))}</div>
              <div class="azf-ing-status">${statusText}</div>
              ${i.description ? `<div class="azf-ing-snippet">${escapeHtml(String(i.description).slice(0, 110))}</div>` : ''}
            </div>`;
        }).join('')}
      </div>`;
  }

  function frameDeepDive({ ing, productName, productScore }) {
    const status = ing.status === 'harmful' ? 'bad'
                 : ing.status === 'beneficial' ? 'good' : 'neutral';
    const score = Number.isFinite(ing.score)
      ? ing.score
      : (status === 'bad' ? -3 : status === 'good' ? 3 : 0);
    const min = -5, max = 5;
    const clamped = Math.max(min, Math.min(max, score));
    const sliderPct = ((clamped - min) / (max - min)) * 100;
    const sections = [
      { key: 'risks', title: 'Risks', body: ing.risks || (status === 'bad' ? ing.description : '') },
      { key: 'benefits', title: 'Benefits', body: ing.benefits || (status === 'good' ? ing.description : '') }
    ].filter((s) => (s.body || '').trim());

    return `
      ${statusBarHtml()}
      ${appBarHtml()}
      <div class="azf-body scroll">
        <div class="azf-deep-name">${escapeHtml(String(ing.name || 'Ingredient'))}</div>
        ${ing.description ? `<div class="azf-deep-desc">${escapeHtml(String(ing.description).slice(0, 220))}</div>` : ''}
        <div class="azf-deep-score-card ${status}">
          <div class="azf-deep-score-hd">
            <span>Score</span>
            <span>−5 to 5 scale</span>
          </div>
          <div class="azf-deep-score-num">${score > 0 ? '+' : ''}${score}</div>
          <div class="azf-deep-slider">
            <div class="azf-deep-slider-thumb" style="left:${sliderPct.toFixed(1)}%"></div>
          </div>
          <div class="azf-deep-slider-labels">
            <span><strong>−5</strong>Very bad</span>
            <span><strong>0</strong>Okay</span>
            <span><strong>5</strong>Very good</span>
          </div>
        </div>
        ${sections.map((s) => `
          <div class="azf-deep-section">
            <h4>${escapeHtml(s.title)}</h4>
            <p>${escapeHtml(String(s.body).slice(0, 220))}</p>
          </div>`).join('')}
        <div class="azf-foot" style="margin-top:auto">
          <span>${escapeHtml(productName.slice(0, 30))}</span>
          <span>·</span>
          <strong>${productScore}/100</strong>
        </div>
      </div>`;
  }

  function rowIcon(kind) {
    if (kind === 'bad') return '<svg viewBox="0 0 24 24" fill="none" stroke="#B24C4C" stroke-width="2"><path d="M12 3l10 17H2L12 3zm0 6v5m0 3v.01" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (kind === 'good') return '<svg viewBox="0 0 24 24" fill="none" stroke="#2F8A5B" stroke-width="2.2"><path d="M5 12l4 4 10-10" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 19c8 0 14-6 14-14 0-1 0-1-1-1-8 0-14 6-14 14 0 1 0 1 1 1z" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function toFakeIng(f) {
    return {
      name: f.name,
      description: f.body,
      status: f.kind === 'bad' ? 'harmful' : f.kind === 'good' ? 'beneficial' : 'neutral',
      score: f.kind === 'bad' ? -3 : f.kind === 'good' ? 3 : 0
    };
  }

  /* ============================================================
   *  html2canvas frame capture — one element → one 9:16 PNG
   * ============================================================ */
  let _h2cPromise = null;
  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (_h2cPromise) return _h2cPromise;
    _h2cPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error('html2canvas failed to load'));
      document.head.appendChild(s);
    });
    return _h2cPromise;
  }

  /**
   * Capture one .az-frame element → single 9:16 PNG. The frame already has
   * a fixed 9:16 aspect via CSS, so we render it at its current size and
   * upsample with html2canvas's `scale` param to land at ~1080×1920. No
   * slicing, no padding — the PNG matches what's visible on screen.
   */
  async function downloadFrame(frame, filename) {
    const inner = frame.querySelector('.az-frame-inner');
    if (!inner) throw new Error('no frame inner');
    const h2c = await loadHtml2Canvas();

    /* Wait for inline images to load so the canvas captures them. */
    const imgs = Array.from(inner.querySelectorAll('img'));
    await Promise.all(imgs.map((img) => (img.complete && img.naturalWidth > 0)
      ? null
      : new Promise((res) => { img.onload = img.onerror = res; setTimeout(res, 4000); })));

    const rect = inner.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    /* Target ~1080px width for a crisp portrait export — clamp the scale
     * so we don't blow up tiny previews into 4k canvases. */
    const scale = Math.min(4, Math.max(2, 1080 / W));

    const canvas = await h2c(inner, {
      backgroundColor: '#F7F5F0',
      scale,
      useCORS: true,
      allowTaint: false,
      logging: false,
      width: W, height: H,
      windowWidth: W, windowHeight: H,
      imageTimeout: 8000
    });

    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
})();
