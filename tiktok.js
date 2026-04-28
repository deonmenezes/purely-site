(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const form = $('#tt-form');
  const urlInput = $('#tt-url');
  const goBtn = $('#tt-go');
  const pasteBtn = $('#paste-btn');
  const progress = $('#tt-progress');
  const progFill = $('#tp-fill');
  const progStatus = $('#tp-status');
  const errBox = $('#tt-error');
  const results = $('#tt-results');
  const refreshToggle = $('#refresh-toggle');
  const sampleBtn = document.querySelector('[data-sample]');
  const toast = $('#toast');

  let forceRefresh = false;

  function showToast(msg, type = '') {
    toast.textContent = msg; toast.className = 'toast show ' + type; toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.classList.remove('show'); setTimeout(() => (toast.hidden = true), 250); }, 3000);
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
  function fmtCount(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function copy(text) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied to clipboard', 'ok'),
      () => showToast('Copy failed', 'err')
    );
  }

  // De-duplicate finding rows by ingredient name (case-insensitive). The AI
  // sometimes returns the same substance in both contaminants[] and
  // harmfulIngredients[] (e.g. Microplastics) which would otherwise render twice.
  function dedupeFindings(arr) {
    const seen = new Set();
    return (arr || []).filter((f) => {
      const k = String(f.name || '').toLowerCase().trim();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Map a microplastics status string to a numeric -5..5 score for the
  // detail-screen slider. "Detected"/"High" → very bad; "None"/"Not detected"
  // → very good; everything else clamps to the middle.
  function microplasticsScore(status) {
    const s = String(status || '').toLowerCase();
    if (/none|not detected|absent|safe/.test(s)) return 4;
    if (/low/.test(s)) return 1;
    if (/likely|moderate|possible/.test(s)) return -3;
    if (/detected|high/.test(s)) return -5;
    return 0;
  }

  // Open the ingredient/microplastic detail screen — the full-screen modal
  // that mirrors app/ingredient-detail.tsx in the real Purely app.
  // Args: { name, description, status: 'harmful'|'beneficial'|'neutral',
  //         score (-5..5), scoreScale, risks, benefits, legalLimit,
  //         healthGuideline, references, productName, productScore }
  const PURELY_LOGO_PATH = '/assets/purely-logo.png?v=3';
  function openIngredientDetail(opts) {
    closeIngredientDetail();
    const score = Number.isFinite(opts.score) ? opts.score : 0;
    const min = -5, max = 5;
    const clamped = Math.max(min, Math.min(max, score));
    const sliderPct = ((clamped - min) / (max - min)) * 100;
    const status = opts.status || 'neutral';
    const sections = [
      { key: 'risks',     title: 'Risks',           body: opts.risks },
      { key: 'benefits',  title: 'Benefits',        body: opts.benefits },
      { key: 'legal',     title: 'Legal limit',     body: opts.legalLimit },
      { key: 'guideline', title: 'Health guideline', body: opts.healthGuideline },
      { key: 'refs',      title: 'References',      body: opts.references }
    ];

    const el = document.createElement('div');
    el.className = 'ing-modal';
    el.id = 'ing-modal';
    el.innerHTML = `
      <div class="ing-screen">
        <div class="ing-status">
          <span>9:41</span>
          <div class="right">
            <svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="0.5"/><rect x="4" y="6" width="3" height="6" rx="0.5"/><rect x="8" y="3" width="3" height="9" rx="0.5"/><rect x="12" y="0" width="3" height="12" rx="0.5"/></svg>
            <svg viewBox="0 0 18 13" fill="currentColor"><path d="M9 11l3.5-3a5 5 0 00-7 0L9 11zm0-6a8 8 0 015.5 2.2l1.3-1.3a10 10 0 00-13.6 0l1.3 1.3A8 8 0 019 5z"/></svg>
            <svg viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="22" height="11" rx="2.5" stroke="currentColor" fill="none"/><rect x="2.5" y="2.5" width="18" height="7" rx="1" fill="currentColor"/><rect x="23" y="3.5" width="2" height="5" rx="1" fill="currentColor"/></svg>
          </div>
        </div>
        <div class="ing-hdr">
          <button class="ing-hdr-btn" data-close aria-label="Back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="ing-hdr-center">
            <img src="${PURELY_LOGO_PATH}" alt="" class="ing-logo" width="24" height="24" style="width:24px;height:24px;object-fit:contain;flex:0 0 auto">
            <span class="ing-wordmark">Purely App</span>
          </div>
          <button class="ing-hdr-btn" aria-label="Info">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8h0M12 11v5" stroke-linecap="round"/></svg>
          </button>
        </div>

        <div class="ing-body">
          <div class="ing-name-card">
            <div class="ing-name">${escapeHtml(opts.name || 'Ingredient')}</div>
            ${opts.description ? `<div class="ing-desc">${escapeHtml(opts.description)}</div>` : ''}
          </div>

          <div class="ing-score-card ${status === 'harmful' ? 'bad' : status === 'beneficial' ? 'good' : ''}">
            <div class="ing-score-hd">
              <span class="ing-score-lbl">Score</span>
              <span class="ing-score-scale">${escapeHtml(opts.scoreScale || '-5 to 5 scale')}</span>
            </div>
            <div class="ing-score-num">${score}</div>
            <div class="ing-slider">
              <div class="ing-slider-track"></div>
              <div class="ing-slider-thumb" style="left:${sliderPct.toFixed(1)}%"></div>
            </div>
            <div class="ing-slider-labels">
              <span><strong>−5</strong><em>Very bad</em></span>
              <span><strong>0</strong><em>Okay</em></span>
              <span><strong>5</strong><em>Very good</em></span>
            </div>
          </div>

          ${sections.map((sec) => `
            <div class="ing-accord" data-key="${sec.key}">
              <button class="ing-accord-hd">
                <span class="ing-accord-title">${sec.title}</span>
                <svg class="ing-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>
              </button>
              <div class="ing-accord-body">
                <p>${escapeHtml(sec.body || 'No data available for this section yet.')}</p>
              </div>
            </div>
          `).join('')}

          ${opts.productName ? `
            <div class="ing-foot">
              <span class="ing-foot-name">${escapeHtml(opts.productName)}</span>
              ${Number.isFinite(opts.productScore) ? `<span class="ing-foot-score">Product score ${opts.productScore}/100</span>` : ''}
            </div>` : ''}

          <button class="ing-edit-btn" data-close>Close</button>
        </div>
        <div class="ing-home-indicator"></div>
      </div>
    `;
    document.body.appendChild(el);
    document.body.classList.add('ing-modal-open');

    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-close]')) closeIngredientDetail();
    });
    el.querySelectorAll('.ing-accord-hd').forEach((btn) => {
      btn.addEventListener('click', () => btn.parentElement.classList.toggle('open'));
    });
    document.addEventListener('keydown', _ingEsc);
  }
  function _ingEsc(e) { if (e.key === 'Escape') closeIngredientDetail(); }
  function closeIngredientDetail() {
    const el = document.getElementById('ing-modal');
    if (el) el.remove();
    document.body.classList.remove('ing-modal-open');
    document.removeEventListener('keydown', _ingEsc);
  }

  pasteBtn.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) urlInput.value = t.trim();
    } catch { showToast('Paste blocked — paste manually', 'err'); }
  });
  refreshToggle.addEventListener('click', () => {
    forceRefresh = !forceRefresh;
    refreshToggle.classList.toggle('active', forceRefresh);
    refreshToggle.textContent = forceRefresh ? 'Force refresh ON' : 'Force refresh';
  });
  sampleBtn?.addEventListener('click', () => { urlInput.value = sampleBtn.dataset.sample; });

  form.addEventListener('submit', (e) => { e.preventDefault(); analyze(); });

  /* =====================================================================
   *  APP-SCREEN RENDERERS — instead of calling OpenAI to imagine the
   *  Purely UI, we render the actual app design (theme.ts tokens, score
   *  ring, ingredient rows, etc.) directly inside the iPhone .mockup
   *  frames. Output is real HTML, scaled by container queries.
   * ===================================================================== */

  // Mirror of lib/scoreColor.ts gradient stops — keeps the ring color in
  // perfect sync with what the user sees in the actual app.
  const SCORE_STOPS = [
    { s: 0,   h: 0,   sat: 80, l: 48 },
    { s: 25,  h: 12,  sat: 82, l: 52 },
    { s: 50,  h: 38,  sat: 88, l: 52 },
    { s: 70,  h: 80,  sat: 70, l: 45 },
    { s: 85,  h: 130, sat: 65, l: 40 },
    { s: 100, h: 145, sat: 72, l: 36 }
  ];
  function appScoreColor(score) {
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
  function appScoreLabel(s) {
    if (s >= 80) return 'Excellent';
    if (s >= 65) return 'Good';
    if (s >= 50) return 'Okay';
    if (s >= 30) return 'Poor';
    return 'Avoid';
  }

  const STATUS_BAR_HTML = `
    <div class="app-status">
      <span>9:41</span>
      <div class="right">
        <svg viewBox="0 0 14 10" fill="currentColor" aria-hidden="true">
          <rect x="0" y="6" width="2" height="4"/><rect x="3" y="4" width="2" height="6"/>
          <rect x="6" y="2" width="2" height="8"/><rect x="9" y="0" width="2" height="10"/>
        </svg>
        <svg viewBox="0 0 18 12" fill="currentColor" aria-hidden="true">
          <path d="M9 10.5l4.2-3.5a6 6 0 00-8.4 0L9 10.5zm0-7a9 9 0 016.4 2.7l1.5-1.5a11 11 0 00-15.7 0l1.4 1.4A9 9 0 019 3.5z"/>
        </svg>
        <svg viewBox="0 0 24 10" fill="currentColor" aria-hidden="true">
          <rect x="0" y="0" width="20" height="10" rx="2" stroke="currentColor" stroke-width="1" fill="none"/>
          <rect x="2" y="2" width="14" height="6" rx="1"/><rect x="21" y="3" width="2" height="4" rx="1"/>
        </svg>
      </div>
    </div>`;

  const BACK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const CHEV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l4 4 10-10" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const WARN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3l10 17H2L12 3zm0 6v5m0 3v.01" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const HEART_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21l-1.5-1.4C5 14.5 2 11.7 2 8.5A5.5 5.5 0 017.5 3 6 6 0 0112 5.4 6 6 0 0116.5 3 5.5 5.5 0 0122 8.5c0 3.2-3 6-8.5 11.1L12 21z"/></svg>`;
  const LEAF_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8 6 6 9 6 13a6 6 0 0012 0c0-4-2-7-6-11z"/></svg>`;
  const FLASH_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>`;
  const GALLERY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="13" rx="2"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>`;

  function ingClass(label) {
    if (/avoid|harmful/i.test(label || '')) return 'harmful';
    if (/good|beneficial/i.test(label || '')) return 'beneficial';
    return '';
  }
  function ingStatusText(cls) {
    if (cls === 'harmful') return 'Harmful';
    if (cls === 'beneficial') return 'Beneficial';
    return 'Neutral';
  }
  function shortLabel(label) {
    return /avoid/i.test(label) ? 'Avoid'
      : /watch/i.test(label) ? 'Watch'
      : /harmful/i.test(label) ? 'Harmful'
      : /good|beneficial/i.test(label) ? 'Good' : (label || 'Good');
  }

  function ingredientRowHtml(i) {
    const cls = ingClass(i.label);
    const right = (i.note || '').trim().slice(0, 40);
    return `
      <div class="ingredient-row ${cls}">
        <div class="left">
          <div class="name">${escapeHtml(i.name || 'Unknown')}</div>
          <div class="status ${cls}">${ingStatusText(cls)}</div>
        </div>
        ${right ? `<span class="badge ${cls}">${escapeHtml(shortLabel(i.label))}</span>` : `<span class="badge ${cls}">${escapeHtml(shortLabel(i.label))}</span>`}
        <span class="chev">${CHEV_ICON}</span>
      </div>`;
  }

  function placeholderPhoto(product, ringColor) {
    const initial = (product.brand || product.name || '?').trim().charAt(0).toUpperCase();
    return `<div class="ph" style="background:linear-gradient(135deg, ${ringColor}, #9b958d80)">${escapeHtml(initial)}</div>`;
  }

  function makeDownloadBtn(filename) {
    return `<button class="dl-btn" data-dl="${escapeHtml(filename)}" title="Download">
      <svg viewBox="0 0 24 24"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    </button>`;
  }

  function clearTile(tile) {
    tile.querySelector('.skel')?.remove();
    tile.querySelector('img')?.remove();
    tile.querySelector('.err-msg')?.remove();
    tile.querySelector('.dl-btn')?.remove();
    tile.querySelector('.app-screen')?.remove();
  }

  function attachDownload(tile, filename) {
    const btn = tile.querySelector('.dl-btn');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.classList.add('busy');
      try {
        await downloadAppScreen(tile, filename);
        showToast('Saved', 'ok');
      } catch (err) {
        showToast('Download failed: ' + (err.message || err), 'err');
      } finally {
        btn.classList.remove('busy');
      }
    });
  }

  // "Expand" button pinned to the top-left of the iPhone tile: tap to open
  // the rendered Purely-app screen in a full-bleed fullscreen view that's
  // properly sized for the user's actual phone (iPhone-aspect on desktop,
  // edge-to-edge on phones). Solves the "tile is too small to read" problem.
  function makeExpandBtn() {
    return `<button class="fs-btn" title="Open full screen" aria-label="Open full screen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
    </button>`;
  }
  function attachExpand(tile) {
    const btn = tile.querySelector('.fs-btn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFullScreenView(tile);
    });
    // Tapping the screen itself (anywhere not a button) also expands
    const screen = tile.querySelector('.pa-screen');
    if (screen) {
      screen.style.cursor = 'zoom-in';
      screen.addEventListener('click', (e) => {
        if (e.target.closest('.pa-stat-row')) return; // row clicks open detail modal
        if (e.target.closest('button')) return;
        openFullScreenView(tile);
      });
    }
  }
  function openFullScreenView(tile) {
    const src = tile.querySelector('.pa-screen');
    if (!src) return;
    closeFullScreenView();
    const overlay = document.createElement('div');
    overlay.className = 'pa-fs-modal';
    overlay.id = 'pa-fs-modal';
    const cloned = src.cloneNode(true);
    cloned.classList.add('pa-fs-screen');
    overlay.innerHTML = `
      <button class="pa-fs-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6l-12 12"/></svg>
      </button>
    `;
    overlay.appendChild(cloned);
    document.body.appendChild(overlay);
    document.body.classList.add('pa-fs-open');
    // Re-bind row clicks inside the cloned screen so detail modals still work
    cloned.querySelectorAll('.pa-stat-row').forEach((row, idx) => {
      const orig = src.querySelectorAll('.pa-stat-row')[idx];
      if (!orig) return;
      row.addEventListener('click', () => orig.click());
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.pa-fs-close')) closeFullScreenView();
    });
    document.addEventListener('keydown', _paFsEsc);
  }
  function _paFsEsc(e) { if (e.key === 'Escape') closeFullScreenView(); }
  function closeFullScreenView() {
    document.getElementById('pa-fs-modal')?.remove();
    document.body.classList.remove('pa-fs-open');
    document.removeEventListener('keydown', _paFsEsc);
  }

  /* ============================================================
   *  V13 — One big beautiful scrollable Toxin Report screen.
   *  Used for BOTH the TikTok flow (per product) and the photo flow.
   *  Matches the user's actual app screenshot pixel-for-pixel.
   * ============================================================ */
  function renderToxinReport(tile, opts) {
    const {
      name = 'Product', brand = '', score = 50, verdict,
      imageUrl, harmCount = 0, benCount = 0,
      microplastics = 'Unknown', microplasticsDetail = null, findings = [],
      category = '', packaging = '', otherMetrics = [],
      // New fields from the curated DB lookup (null/empty when from GPT path).
      allIngredients = null, company = null, brandInfo = null,
      servingSize = '', alternatives = [], nutrients = [],
      filename = 'purely-product.png'
    } = opts;
    const safeScore = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
    const ringColor = appScoreColor(safeScore);
    const verdictText = verdict || appScoreLabel(safeScore);
    const dash = (safeScore / 100) * 289; // C = 2π·46
    const isGoodHealth = safeScore >= 75;
    const proxied = (u) => u && /^https?:/i.test(u) ? `/api/img?u=${encodeURIComponent(u)}` : u;
    const photoSrc = proxied(imageUrl);
    const photoHtml = photoSrc
      ? `<img src="${escapeHtml(photoSrc)}" alt="" crossorigin="anonymous">`
      : `<div class="ph" style="background:linear-gradient(135deg, ${ringColor}, ${ringColor}99)">${escapeHtml((brand || name || '?').trim().charAt(0).toUpperCase())}</div>`;

    const titleCaseCategory = (category || 'Other')
      .split(/[\s_-]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    // Mirror ScanResultContent ingredient row + click-to-expand detail panel
    // (matches what app/ingredient-detail.tsx shows when you tap a row).
    const ingredientCardsHtml = findings.length ? findings.map((f) => {
      const status = f.kind === 'bad' ? 'harmful' : f.kind === 'good' ? 'beneficial' : 'neutral';
      const statusText = status.charAt(0).toUpperCase() + status.slice(1);
      const rightBadge = f.amount || f.pill || '';
      const exceeds = (f.multiplier && /×|above|exceeds/i.test(f.multiplier)) ? f.multiplier : null;
      const limitText = f.limit ? `${f.limit}${f.limitSource ? ` (${f.limitSource})` : ''}` : null;
      const hasDetail = !!(f.amount || limitText || exceeds || f.body || f.source);
      return `
        <div class="sr-ing-row ${status}">
          <div class="sr-ing-left">
            <div class="sr-ing-name">${escapeHtml((f.name || '').slice(0, 80))}</div>
            <div class="sr-ing-status ${status}">${escapeHtml(statusText)}</div>
            ${f.body ? `<div class="sr-ing-snippet">${escapeHtml(String(f.body).slice(0, 200))}</div>` : ''}
          </div>
          <div class="sr-ing-right">
            ${rightBadge ? `<span class="sr-ing-badge ${status}">${escapeHtml(rightBadge)}</span>` : ''}
            <span class="sr-ing-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          </div>
          ${hasDetail ? `
            <div class="sr-ing-detail">
              ${f.amount ? `<div class="d-row"><span class="k">Detected level</span><span class="v">${escapeHtml(f.amount)}</span></div>` : ''}
              ${limitText ? `<div class="d-row"><span class="k">Legal / health limit</span><span class="v">${escapeHtml(limitText)}</span></div>` : ''}
              ${exceeds ? `<div class="d-row exceed"><span class="k">Exceeds by</span><span class="v">${escapeHtml(exceeds)}</span></div>` : ''}
              ${f.body ? `<div class="d-row full"><span class="k">Why it matters</span><span class="v">${escapeHtml(f.body)}</span></div>` : ''}
              ${f.source ? `<div class="d-row full"><span class="k">Source</span><span class="v">${escapeHtml(f.source)}</span></div>` : ''}
            </div>` : ''}
        </div>`;
    }).join('') : `<div class="sr-empty">No ingredients available.</div>`;

    // Stats: mirror AnalyzedProduct.stats — harmful_substances, beneficial_ingredients, microplastics_risk
    const statsHtml = [
      { value: harmCount, label: 'Harmful substances' },
      { value: benCount, label: 'Beneficial ingredients' },
      { value: microplastics || 'Unknown', label: 'Microplastics' }
    ].map((s) => `
      <div class="sr-stat-card">
        <div class="sr-stat-value">${escapeHtml(String(s.value))}</div>
        <div class="sr-stat-label">${escapeHtml(s.label)}</div>
      </div>`).join('');

    // Other info — packaging + per-category metrics (matches type_metrics block)
    const otherInfoHtml = [
      { label: 'Packaging', value: packaging || 'Not specified' },
      ...(otherMetrics.length ? otherMetrics : [])
    ].map((m) => `
      <div class="sr-info-card">
        <div class="sr-info-label">${escapeHtml(m.label)}</div>
        <div class="sr-info-value">${escapeHtml(String(m.value))}</div>
      </div>`).join('');

    // Map a finding name → human-readable quality label (Flour quality,
    // Oil quality, Sugar, Sodium, Microplastics, etc.) so each substance
    // row reads like the real app's compact "Quality" rundown.
    function paQualityLabel(n) {
      const s = String(n || '').toLowerCase();
      if (/flour|wheat|grain|cereal/.test(s)) return 'Flour quality';
      if (/oil|fat|lard|tallow/.test(s)) return 'Oil quality';
      if (/sugar|fructose|syrup|sweetener|sucrose|glucose/.test(s)) return 'Sugar';
      if (/salt|sodium/.test(s)) return 'Sodium';
      if (/microplastic|plastic/.test(s)) return 'Microplastics';
      if (/preserv|sorbate|benzoate|nitrate|nitrite/.test(s)) return 'Preservatives';
      if (/color|dye|red 40|yellow 5|fd&c/.test(s)) return 'Colorants';
      if (/protein|amino/.test(s)) return 'Protein quality';
      if (/fiber|fibre/.test(s)) return 'Fiber';
      if (/vitamin|mineral/.test(s)) return 'Nutrients';
      if (/lead|cadmium|arsenic|mercury/.test(s)) return 'Heavy metals';
      return 'Quality';
    }
    const PA_LEAF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 19c8 0 14-6 14-14 0-1 0-1-1-1-8 0-14 6-14 14 0 1 0 1 1 1z" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19l9-9" stroke-linecap="round"/></svg>';
    const PA_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l10 17H2L12 3zm0 7v5m0 3v.01" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const PA_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3"/></svg>';

    // Build the compact substance rows shown under the score (top 6 findings).
    const paRowsHtml = (findings.length ? findings.slice(0, 6) : []).map((f, idx) => {
      const dotClass = f.kind === 'bad' ? 'bad' : f.kind === 'good' ? 'good' : 'neutral';
      // Prefer the AI-supplied row label (from uiSummary.topAttributes); fall
      // back to keyword-derived labels (Flour quality, Sugar, Microplastics…).
      const lbl = (f.label && String(f.label).trim()) ? f.label : paQualityLabel(f.name);
      const isWarnIcon = /sugar|salt|sodium|preserv|color|microplastic|metal|bpa|phthal/.test(String(f.name + ' ' + lbl).toLowerCase()) && f.kind === 'bad';
      const ico = isWarnIcon ? PA_WARN : PA_LEAF;
      const valExtra = f.amount ? ` (${escapeHtml(f.amount)})` : (f.pill && /top \d/i.test(f.pill) ? ` (${escapeHtml(f.pill)})` : '');
      // Row right-column priority:
      // 1. f.value (AI's pre-formatted value from uiSummary.topAttributes)
      // 2. f.name (substance name from contaminants/harmful arrays)
      // Avoid showing the same string twice when label and name match.
      const valueText = (f.value && String(f.value).trim()) ? f.value
                       : (lbl !== f.name ? f.name : (f.amount || f.pill || ''));
      return `
        <div class="pa-stat-row" data-idx="${idx}">
          <span class="pa-stat-ico">${ico}</span>
          <span class="pa-stat-lbl">${escapeHtml(lbl)}</span>
          <span class="pa-stat-val">${escapeHtml(valueText || '—')}${valExtra}</span>
          <span class="pa-stat-dot ${dotClass}"></span>
        </div>`;
    }).join('') || `<div class="pa-stat-empty">No specific concerns extracted from this product.</div>`;

    // Score ring with a small dot at the end-of-arc position. For a score
    // of 1, the dot sits just past 12 o'clock — visually matches the real
    // app's single-dot indicator on otherwise-empty ring.
    const angleDeg = (safeScore / 100) * 360 - 90;
    const dotX = 51 + 46 * Math.cos(angleDeg * Math.PI / 180);
    const dotY = 51 + 46 * Math.sin(angleDeg * Math.PI / 180);

    /* ---------- New DB-driven sections (mirror the mobile app) ---------- */

    // "Owned by" row — parent-company logo + name (e.g. Costco for Kirkland).
    const ownedByHtml = company && company.name ? `
      <div class="pa-owned">
        <span class="pa-owned-lbl">Owned by</span>
        <span class="pa-owned-right">
          ${company.logo ? `<img src="${escapeHtml(proxied(company.logo))}" alt="" class="pa-owned-logo" crossorigin="anonymous">` : ''}
          <span class="pa-owned-name">${escapeHtml(company.name)}</span>
        </span>
      </div>` : '';

    // "What's inside" — every ingredient on file with the real DB description.
    // Ordered: harmful first (severity desc), beneficial next (bonus desc),
    // neutral last. Mirrors ScanResultContent's substance card list.
    const ingsForList = Array.isArray(allIngredients) && allIngredients.length
      ? [...allIngredients].sort((a, b) => {
          const rank = (i) => i.status === 'harmful' ? 0 : i.status === 'beneficial' ? 1 : 2;
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          return (b.severity_score || 0) + (b.bonus_score || 0) - (a.severity_score || 0) - (a.bonus_score || 0);
        })
      : null;
    const insideListHtml = ingsForList && ingsForList.length
      ? ingsForList.map((i) => `
          <div class="pa-inside-card ${i.status === 'harmful' ? 'bad' : i.status === 'beneficial' ? 'good' : 'neutral'}">
            <div class="pa-inside-name">${escapeHtml((i.name || '').slice(0, 80))}</div>
            <div class="pa-inside-desc">${escapeHtml(String(i.description || '').slice(0, 260))}</div>
          </div>`).join('')
      // Fallback to legacy findings-driven list when DB had no match.
      : (findings.length ? findings.map((f, idx) => {
          const stat = f.kind === 'bad' ? 'bad' : f.kind === 'good' ? 'good' : 'neutral';
          const desc = f.body || (stat === 'bad' ? 'Flagged for review based on third-party testing.'
                                : stat === 'good' ? 'Generally regarded as safe and beneficial at typical levels.'
                                : 'Common ingredient with no notable concerns.');
          return `
            <div class="pa-inside-card ${stat}" data-finding-idx="${idx}">
              <div class="pa-inside-name">${escapeHtml((f.name || '').slice(0, 60))}</div>
              <div class="pa-inside-desc">${escapeHtml(String(desc).slice(0, 220))}</div>
            </div>`;
        }).join('') : '');

    // "Other info" card — packaging is the only field the mobile app surfaces
    // here right now. We extend if more data ships from the DB later.
    const otherInfoCardHtml = packaging ? `
      <div class="pa-section">
        <h3 class="pa-section-title">Other info</h3>
        <div class="pa-info-card">
          <div class="pa-info-key">Packaging</div>
          <div class="pa-info-val">${escapeHtml(String(packaging).replace(/\b\w/g, (c) => c.toUpperCase()))}</div>
        </div>
      </div>` : '';

    // FDA Daily Values — used to render the %DV bars on the Nutrition Facts panel.
    const DV = {
      'Calories': { dv: 2000, unit: 'kcal' }, 'Total Fat': { dv: 78, unit: 'g' },
      'Saturated Fat': { dv: 20, unit: 'g' }, 'Cholesterol': { dv: 300, unit: 'mg' },
      'Sodium': { dv: 2300, unit: 'mg' }, 'Total Carbohydrates': { dv: 275, unit: 'g' },
      'Dietary Fiber': { dv: 28, unit: 'g' }, 'Added Sugars': { dv: 50, unit: 'g' },
      'Protein': { dv: 50, unit: 'g' }, 'Vitamin D': { dv: 20, unit: 'mcg' },
      'Calcium': { dv: 1300, unit: 'mg' }, 'Iron': { dv: 18, unit: 'mg' },
      'Potassium': { dv: 4700, unit: 'mg' }
    };
    const NUT_ORDER = ['Calories','Total Fat','Saturated Fat','Trans Fat','Cholesterol','Sodium',
      'Total Carbohydrates','Dietary Fiber','Total Sugars','Added Sugars','Protein',
      'Vitamin D','Calcium','Iron','Potassium'];
    const nutByName = new Map((nutrients || []).map((n) => [n.name, n]));
    const nutritionRows = NUT_ORDER
      .map((nm) => nutByName.get(nm))
      .filter((n) => n && Number.isFinite(Number(n.amount)));
    const nutritionHtml = nutritionRows.length ? `
      <div class="pa-section">
        <h3 class="pa-section-title">Nutrition Facts</h3>
        <div class="pa-nut-card">
          ${servingSize ? `<div class="pa-nut-serving">Serving size ${escapeHtml(servingSize)}</div>` : ''}
          ${nutritionRows.map((n) => {
            const ref = DV[n.name];
            const unit = n.unit || ref?.unit || '';
            const amt = Number(n.amount);
            const pct = ref && amt > 0 ? Math.round((amt / ref.dv) * 100) : null;
            const pctClamped = pct == null ? 0 : Math.max(0, Math.min(100, pct));
            return `
              <div class="pa-nut-row">
                <div class="pa-nut-row-top">
                  <span class="pa-nut-name">${escapeHtml(n.name)}</span>
                  <span class="pa-nut-amt">${amt}${unit}</span>
                </div>
                ${pct != null ? `
                  <div class="pa-nut-row-bot">
                    <div class="pa-nut-bar"><div class="pa-nut-bar-fill" style="width:${pctClamped}%"></div></div>
                    <span class="pa-nut-pct">${pct}%</span>
                  </div>` : ''}
              </div>`;
          }).join('')}
        </div>
      </div>` : '';

    // "Top rated [category]" carousel — same-type items with higher scores.
    const altsHtml = Array.isArray(alternatives) && alternatives.length ? `
      <div class="pa-section">
        <h3 class="pa-section-title">Top rated ${escapeHtml(titleCaseCategory.toLowerCase())}</h3>
        <div class="pa-alt-row">
          ${alternatives.slice(0, 6).map((alt) => `
            <div class="pa-alt-card">
              <div class="pa-alt-img">${alt.image
                ? `<img src="${escapeHtml(proxied(alt.image))}" alt="" crossorigin="anonymous">`
                : ''}</div>
              <div class="pa-alt-name">${escapeHtml((alt.name || '').slice(0, 50))}</div>
              <div class="pa-alt-score">${alt.score}/100</div>
            </div>`).join('')}
        </div>
      </div>` : '';

    clearTile(tile);
    tile.insertAdjacentHTML('beforeend', `
      <div class="app-screen pa-screen">
        <div class="pa-status">
          <span>9:41</span>
          <div class="right">
            <svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="0.5"/><rect x="4" y="6" width="3" height="6" rx="0.5"/><rect x="8" y="3" width="3" height="9" rx="0.5"/><rect x="12" y="0" width="3" height="12" rx="0.5"/></svg>
            <svg viewBox="0 0 18 13" fill="currentColor"><path d="M9 11l3.5-3a5 5 0 00-7 0L9 11zm0-6a8 8 0 015.5 2.2l1.3-1.3a10 10 0 00-13.6 0l1.3 1.3A8 8 0 019 5z"/></svg>
            <svg viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="22" height="11" rx="2.5" stroke="currentColor" fill="none"/><rect x="2.5" y="2.5" width="18" height="7" rx="1" fill="currentColor"/><rect x="23" y="3.5" width="2" height="5" rx="1" fill="currentColor"/></svg>
          </div>
        </div>

        <div class="pa-hdr">
          <button class="pa-hdr-icon" aria-label="Back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="pa-hdr-pill">
            <img src="${PURELY_LOGO_PATH}" alt="" class="pa-hdr-logo" width="24" height="24" style="width:24px;height:24px;object-fit:contain;flex:0 0 auto">
            <span class="pa-hdr-text">Purely App</span>
          </div>
          <button class="pa-hdr-icon" aria-label="View">${PA_EYE}</button>
        </div>

        <div class="pa-hero">
          <div class="pa-hero-card">${photoHtml}</div>
        </div>

        <div class="pa-info">
          <div class="pa-info-left">
            <div class="pa-name">
              <span class="pa-name-text">${escapeHtml(name)}</span>
              <span class="pa-name-arrow">↗</span>
            </div>
            ${brand ? `<div class="pa-brand">${escapeHtml(brand)}</div>` : ''}
            <div class="pa-tags">
              <span class="pa-tag">${escapeHtml(titleCaseCategory)}</span>
              <span class="pa-tag toxin ${isGoodHealth ? 'good' : 'warn'}">
                ${isGoodHealth
                  ? '<svg viewBox="0 0 24 24" fill="none" stroke="#3F9A5D" stroke-width="2.6"><path d="M5 12l4 4 10-10" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                  : '<svg viewBox="0 0 24 24" fill="none" stroke="#D44A4A" stroke-width="2.2"><path d="M12 3l10 17H2L12 3zm0 6v5m0 3v.01" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
                ${isGoodHealth ? 'Health report' : 'Toxin report'}
              </span>
            </div>
          </div>
          <div class="pa-score" style="--ring:${ringColor}">
            <svg viewBox="0 0 102 102" class="pa-score-svg">
              <circle cx="51" cy="51" r="46" stroke="#E3E0DA" stroke-width="6" fill="none"/>
              <circle cx="${dotX.toFixed(2)}" cy="${dotY.toFixed(2)}" r="5.5" fill="${ringColor}"/>
            </svg>
            <div class="pa-score-text">
              <div class="pa-score-num">${safeScore} / 100</div>
              <div class="pa-score-lbl">${escapeHtml(verdictText)}</div>
            </div>
          </div>
        </div>

        <div class="pa-stat-rows">
          ${paRowsHtml}
        </div>

        <div class="pa-divider"></div>

        <div class="pa-foot">
          <span class="pa-foot-by">Scored by</span>
          <img src="${PURELY_LOGO_PATH}" alt="" class="pa-foot-logo" width="20" height="20" style="width:20px;height:20px;object-fit:contain;flex:0 0 auto">
          <strong class="pa-foot-name">Purely</strong>
        </div>

        ${ownedByHtml}

        ${insideListHtml ? `
          <div class="pa-inside">
            <div class="pa-inside-hd">
              <h3 class="pa-inside-title">What's inside</h3>
              <span class="pa-inside-pill">
                <img src="${PURELY_LOGO_PATH}" alt="" class="pa-inside-pill-logo" width="16" height="16" style="width:16px;height:16px;object-fit:contain;flex:0 0 auto">
                <span>Purely App</span>
              </span>
            </div>
            <div class="pa-inside-list">${insideListHtml}</div>
          </div>` : ''}

        ${otherInfoCardHtml}

        ${nutritionHtml}

        ${altsHtml}
      </div>
      ${makeDownloadBtn(filename)}
      ${makeExpandBtn()}
    `);
    attachDownload(tile, filename);
    attachExpand(tile);

    // Tap any substance row → open the ingredient-detail screen with the
    // -5..5 score slider, expandable Risks / Benefits / Legal limit / Health
    // guideline / References sections, and product attribution footer.
    tile.querySelectorAll('.pa-stat-row').forEach((row, idx) => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const f = findings[idx];
        if (!f) return;
        const status = f.kind === 'bad' ? 'harmful' : f.kind === 'good' ? 'beneficial' : 'neutral';
        const detailScore = status === 'harmful' ? -4 : status === 'beneficial' ? 4 : 0;
        // Microplastics row gets the richer microplastics-specific copy.
        if (/microplastic/i.test(f.name)) {
          const mp = microplasticsDetail || {};
          openIngredientDetail({
            name: 'Microplastics',
            description: mp.summary || 'Tiny plastic particles (<5mm) that can leach from packaging, food contact materials, or processing equipment into the product.',
            status: 'harmful',
            score: microplasticsScore(microplastics),
            risks: mp.concern || 'Emerging research links microplastic exposure to inflammation, hormone disruption, and gut-microbiome changes. Particles have been detected in human blood, lungs, and placenta.',
            benefits: null,
            legalLimit: mp.limit || 'No federal limit currently set in the US. EU has restricted intentional microplastics under REACH (2023).',
            healthGuideline: mp.guideline || 'Choose fresh, minimally-packaged foods. Avoid plastic containers when heating. Filter tap water.',
            references: (mp.sources || []).join(' · ') || 'EWG · ConsumerLab · Lead Safe',
            productName: name, productScore: safeScore
          });
          return;
        }
        openIngredientDetail({
          name: f.name,
          description: f.body || (status === 'harmful'
            ? 'Flagged in third-party testing as a substance of concern.'
            : status === 'beneficial'
              ? 'Generally regarded as a beneficial dietary contributor.'
              : 'Common ingredient with no notable concerns.'),
          status,
          score: detailScore,
          risks: status === 'harmful' ? f.body : null,
          benefits: status === 'beneficial' ? f.body : null,
          legalLimit: f.limit ? `${f.limit}${f.limitSource ? ` — ${f.limitSource}` : ''}` : null,
          healthGuideline: f.amount ? `Detected level: ${f.amount}${f.multiplier ? ` (${f.multiplier})` : ''}` : null,
          references: f.source || null,
          productName: name,
          productScore: safeScore
        });
      });
    });

    // Tapping any "What's inside" card opens the same detail modal as the
    // matching substance row — keeps the two sections behaviourally aligned.
    tile.querySelectorAll('.pa-inside-card').forEach((card) => {
      const idx = Number(card.dataset.findingIdx);
      const row = tile.querySelectorAll('.pa-stat-row')[idx];
      if (!row) return;
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => row.click());
    });
  }

  function renderTikTokScreen(tile, product, coverImage) {
    // Prefer the rich per-product fields the new gpt4Extract returns
    // (contaminants, microplastics, beneficialAttributes). Fall back to
    // ingredients[] for older cached payloads so this stays compatible.
    const contaminants = product.contaminants || [];
    const harmIng = product.harmfulIngredients || [];
    const benAttr = product.beneficialAttributes || [];
    const oldIng = product.ingredients || [];
    const oldHarm = oldIng.filter((i) => /avoid|harmful/i.test(i.label || ''));
    const oldBen = oldIng.filter((i) => /good|beneficial/i.test(i.label || ''));

    const findings = [];
    contaminants.slice(0, 4).forEach((c) => findings.push({
      kind: 'bad', name: c.name, pill: c.multiplier || c.status || 'Detected',
      amount: c.amount || null, limit: c.limit || null,
      limitSource: c.limitSource || '', multiplier: c.multiplier || '',
      body: c.concern || '', source: c.source || ''
    }));
    harmIng.slice(0, 3).forEach((h) => findings.push({
      kind: 'bad', name: h.name, pill: 'Harmful',
      body: h.reason || '', source: h.source || ''
    }));
    benAttr.slice(0, 3).forEach((b) => findings.push({
      kind: 'good', name: b.attribute, pill: 'Beneficial',
      body: b.why || '', source: b.source || ''
    }));
    // Fallback: synthesize from ingredients[] when the rich fields are absent
    if (!findings.length) {
      oldHarm.slice(0, 2).forEach((h) => findings.push({
        kind: 'bad', name: h.name, pill: 'Harmful',
        body: h.note || 'Flagged for review based on third-party testing.'
      }));
      oldBen.slice(0, 2).forEach((b) => findings.push({
        kind: 'good', name: b.name, pill: 'Beneficial',
        body: b.note || 'Generally regarded as safe and beneficial.'
      }));
    }

    const harmCount = product.harmfulCount ?? (contaminants.length + harmIng.length || oldHarm.length);
    const benCount = product.beneficialCount ?? (benAttr.length || oldBen.length);
    const mpStatus = product.microplastics?.status || product.microplastics || 'No published data';
    const dedupedFindings = dedupeFindings(findings);

    const safeName = (product.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    renderToxinReport(tile, {
      name: product.name || 'Product', brand: product.brand || '',
      score: product.score, verdict: product.verdict,
      imageUrl: coverImage,
      harmCount, benCount,
      microplastics: mpStatus,
      microplasticsDetail: typeof product.microplastics === 'object' ? product.microplastics : null,
      category: product.subcategory || product.category || 'Other',
      packaging: product.packaging || '',
      findings: dedupedFindings, filename: `purely-${safeName}.png`
    });
  }

  function renderPhotoScreen(tile, payload, imageUrl) {
    const a = payload.analysis || {}; const p = a.product || {};
    const ui = a.uiSummary || {};
    const findings = [];

    // Prefer the AI's pre-built uiSummary.topAttributes when present —
    // each entry already has a row label ("Flour quality", "Microplastics"),
    // a value ("Enriched Flour", "Detected"), and a verdict.
    if (Array.isArray(ui.topAttributes) && ui.topAttributes.length) {
      ui.topAttributes.slice(0, 6).forEach((t) => {
        const verdict = String(t.verdict || '').toLowerCase();
        const kind = /bad|harm/.test(verdict) ? 'bad'
                  : /good|benef/.test(verdict) ? 'good' : 'neutral';
        // The CARD name is the category (label) so cards read like:
        // "Protein Content" / "Sugar" / "Microplastics" — not "20g per bar"
        // or "Detected". The row right-column gets a separate `value` field.
        findings.push({
          kind,
          name: t.label || t.value || 'Concern',
          label: t.label || '',
          value: t.value || '',
          body: t.value
            ? `${t.value}${t.note ? ` — ${t.note}` : ''}`
            : (t.note || ''),
          pill: t.label || ''
        });
      });
    }

    (a.contaminants || []).slice(0, 4).forEach((c) => findings.push({
      kind: 'bad', name: c.name, pill: c.multiplier || c.status || 'Detected',
      amount: c.amount || null, limit: c.limit || null,
      limitSource: c.limitSource || '', multiplier: c.multiplier || '',
      body: c.concern || '', source: c.source || ''
    }));
    (a.harmfulIngredients || []).slice(0, 4).forEach((h) => findings.push({
      kind: 'bad', name: h.name, pill: 'Harmful',
      body: h.reason || '', source: h.source || ''
    }));
    (a.beneficialAttributes || []).slice(0, 3).forEach((b) => findings.push({
      kind: 'good', name: b.attribute, pill: 'Beneficial',
      body: b.why || '', source: b.source || ''
    }));
    const dedupedFindings = dedupeFindings(findings);
    const safeName = (p.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    renderToxinReport(tile, {
      name: p.name || 'Product', brand: p.brand || '',
      score: a.score, verdict: a.verdict, imageUrl,
      harmCount: a.harmfulCount ?? ((a.harmfulIngredients?.length || 0) + (a.contaminants?.length || 0)),
      benCount: a.beneficialCount ?? (a.beneficialAttributes?.length || 0),
      microplastics: a.microplastics?.status || 'Unknown',
      microplasticsDetail: a.microplastics || null,
      category: p.subcategory || p.category || 'Other',
      packaging: a.packagingMaterial || a.packaging?.material || (p.package_color ? `${p.package_color} container` : ''),
      findings: dedupedFindings,
      // Rich DB-sourced data for the new sections (Owned by, What's inside,
      // Nutrition Facts, Top rated). Falls back to undefined when the result
      // came from GPT instead of huge_dataset.
      allIngredients: a.allIngredients || null,
      company:        a.company        || null,
      brandInfo:      a.brandInfo      || null,
      servingSize:    a.servingSize    || '',
      alternatives:   a.alternatives   || [],
      nutrients:      a.nutrients      || [],
      filename: `purely-${safeName}.png`
    });
  }

  /* ============================================================
   *  Lifestyle photo generation — calls /api/generate-lifestyle
   *  (OpenAI gpt-image-1) to produce casual scanning photos that
   *  influencers can use as marketing assets alongside the mockup.
   * ============================================================ */
  function lifestyleSectionHtml({ scope, name, brand, category }) {
    const safeScope = String(scope).replace(/[^a-z0-9-]/gi, '');
    return `
      <div class="lifestyle-section" data-scope="${escapeHtml(safeScope)}"
           data-name="${escapeHtml(name)}"
           data-brand="${escapeHtml(brand)}"
           data-category="${escapeHtml(category)}">
        <div class="lifestyle-hd">
          <h3>
            <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="3.2"/><path d="M8 6l1.5-2h5L16 6"/></svg></span>
            Scanning photos for influencers
          </h3>
          <button class="lifestyle-go" data-action="generate" data-count="2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"/></svg>
            Generate 2 photos
          </button>
          <span class="sub">AI-generated lifestyle shots of someone scanning this product. Use them in your TikToks/Reels.</span>
        </div>
        <div class="lifestyle-grid" hidden></div>
      </div>`;
  }

  async function generateLifestylePhotos(section) {
    const btn = section.querySelector('.lifestyle-go');
    const grid = section.querySelector('.lifestyle-grid');
    const count = Math.max(1, Math.min(3, Number(btn.dataset.count) || 2));
    const productName = section.dataset.name || 'product';
    const productBrand = section.dataset.brand || '';
    const category = section.dataset.category || '';
    const safeName = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    btn.disabled = true; btn.classList.add('busy');
    grid.hidden = false;
    grid.innerHTML = Array.from({ length: count }).map(() =>
      `<div class="lifestyle-tile"><div class="skel"></div></div>`
    ).join('');

    try {
      const r = await fetch('/api/generate-lifestyle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productName, productBrand, category, count })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      grid.innerHTML = (j.images || []).map((src, i) => `
        <div class="lifestyle-tile">
          <img src="${escapeHtml(src)}" alt="" loading="eager" decoding="async">
          <button class="ll-dl" title="Download" data-src="${escapeHtml(src)}" data-name="${escapeHtml(`purely-${safeName}-scanning-${i + 1}.png`)}">
            <svg viewBox="0 0 24 24"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          </button>
        </div>
      `).join('');
      grid.querySelectorAll('.ll-dl').forEach((b) => {
        b.addEventListener('click', () => {
          const a = document.createElement('a');
          a.href = b.dataset.src; a.download = b.dataset.name;
          document.body.appendChild(a); a.click(); a.remove();
          showToast('Saved', 'ok');
        });
      });
    } catch (e) {
      grid.innerHTML = `<div class="lifestyle-tile"><div class="ll-err">${escapeHtml(e.message || 'Failed to generate')}</div></div>`;
      showToast('Generation failed: ' + (e.message || 'unknown'), 'err');
    } finally {
      btn.disabled = false; btn.classList.remove('busy');
    }
  }

  // Event delegation so this works for both TikTok product cards and the
  // photo flow's pr-section without re-binding after every render.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.lifestyle-go');
    if (!btn) return;
    const section = btn.closest('.lifestyle-section');
    if (section) generateLifestylePhotos(section);
  });

  // ---------- TikTok flow: 3 screens per product ----------
  function renderScanScreen(tile, product) {
    clearTile(tile);
    const safeName = (product.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    tile.insertAdjacentHTML('beforeend', `
      <div class="app-screen scan-screen">
        <div class="scan-bg"></div>
        ${STATUS_BAR_HTML}
        <div class="scan-title">
          <strong>Scan Product</strong>
          <span>Scan the barcode on any product</span>
        </div>
        <div class="scan-bracket"><span></span><span></span><span></span><span></span></div>
        <div class="scan-laser"></div>
        <div class="scan-bottom">
          <div class="scan-tabs"><span class="active">Barcode</span><span>Photo</span></div>
          <div class="scan-shutter-row">
            <div class="scan-side">${GALLERY_ICON}</div>
            <div class="scan-shutter"></div>
            <div class="scan-side">${FLASH_ICON}</div>
          </div>
        </div>
      </div>
      ${makeDownloadBtn(`purely-${safeName}-scan.png`)}
    `);
    attachDownload(tile, `purely-${safeName}-scan.png`);
  }

  // ----- shared bits used by the new "Purely App"-branded screens -----
  const PURELY_LOGO_URL = '/assets/purely-logo.png?v=3';
  const PINWHEEL_HTML = `<span class="pinwheel" style="width:28px;height:28px;border-radius:8px;background:#FFF;display:grid;place-items:center;flex:0 0 auto"><img src="${PURELY_LOGO_URL}" alt="" width="18" height="18" style="width:18px;height:18px;object-fit:contain;flex:0 0 auto"></span>`;
  const PURELY_HEADER = (rightHtml) => `
    <div class="purely-header">
      <button class="hdr-pill icon-only" aria-label="Back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="hdr-center">${PINWHEEL_HTML}<span class="wordmark">Purely App</span></div>
      ${rightHtml}
    </div>`;
  const HDR_HEART = (count) => `
    <button class="hdr-pill heart" aria-label="Likes">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21l-1.5-1.4C5 14.5 2 11.7 2 8.5A5.5 5.5 0 017.5 3 6 6 0 0112 5.4 6 6 0 0116.5 3 5.5 5.5 0 0122 8.5c0 3.2-3 6-8.5 11.1L12 21z"/></svg>
      <span>${count}</span>
    </button>`;
  const HDR_INFO = `
    <button class="hdr-pill icon-only" aria-label="Info">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v0M12 11v5" stroke-linecap="round"/></svg>
    </button>`;
  const STAT_TRIANGLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l10 17H2L12 3zm0 7v5m0 3v.01" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const STAT_RECYCLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 19l-3-5 3-5M17 5l3 5-3 5M9 14h12M3 10h12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function bigScoreSvg(score, color) {
    const dash = (score / 100) * 251;  // C = 2π·40 ≈ 251.3
    return `
      <svg viewBox="0 0 90 90">
        <circle cx="45" cy="45" r="40" stroke="#E3E0DA" stroke-width="6" fill="none"/>
        <circle cx="45" cy="45" r="40" stroke="${color}" stroke-width="6" fill="none"
          stroke-linecap="round" stroke-dasharray="${dash} 251" transform="rotate(-90 45 45)"/>
      </svg>`;
  }

  function renderAnalysisScreen(tile, product, opts = {}) {
    clearTile(tile);
    const score = Math.max(0, Math.min(100, Number(product.score) || 80));
    const ringColor = appScoreColor(score);
    const label = appScoreLabel(score);
    const ing = product.ingredients || [];
    const harm = ing.filter((i) => /avoid|harmful/i.test(i.label || '')).length;
    const ben = ing.filter((i) => /good|beneficial/i.test(i.label || '')).length;
    const photoEl = opts.imageUrl
      ? `<img src="${escapeHtml(opts.imageUrl)}" alt="">`
      : `<div class="ph" style="background:linear-gradient(135deg, ${ringColor}, ${ringColor}99)">${escapeHtml((product.brand || product.name || '?').trim().charAt(0).toUpperCase())}</div>`;
    const safeName = (product.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const isGood = score >= 75;
    const likes = opts.likes || Math.floor(Math.random() * 95 + 5);
    const findings = (opts.findings && opts.findings.length)
      ? opts.findings
      : (ing.length
        ? ing.slice(0, 2).map((i) => ({
            name: i.name,
            description: i.note || (/avoid/i.test(i.label) ? 'Flagged in third-party testing.' : 'Generally regarded as safe at typical levels.'),
            kind: /avoid|harmful/i.test(i.label) ? 'bad' : 'good'
          }))
        : []);

    tile.insertAdjacentHTML('beforeend', `
      <div class="app-screen">
        ${STATUS_BAR_HTML}
        ${PURELY_HEADER(HDR_HEART(likes))}
        <div class="app-body">
          <div class="hero-photo">${photoEl}</div>
          <div class="name-score">
            <div class="ns-left">
              <div class="ns-name">
                <span>${escapeHtml((product.name || 'Product').slice(0, 80))}</span>
                <span class="arrow">↗</span>
              </div>
              ${product.brand ? `<div class="ns-brand">${escapeHtml(product.brand)}</div>` : ''}
              <div class="ns-tags">
                ${product.category ? `<span class="ns-tag">${escapeHtml(String(product.category).replace(/^\w/, (c) => c.toUpperCase()))}</span>` : ''}
                <span class="ns-tag ${isGood ? 'good' : 'warn'}">
                  ${isGood ? CHECK_ICON : WARN_ICON}
                  ${isGood ? 'Health report' : 'Toxin report'}
                </span>
              </div>
            </div>
            <div class="ns-score">
              ${bigScoreSvg(score, ringColor)}
              <div class="num"><strong>${score} / 100</strong><span style="color:${ringColor}">${label}</span></div>
            </div>
          </div>
          <div class="stat-rows">
            <div class="stat-row">
              <span class="ico">${STAT_TRIANGLE}</span>
              <span class="label">Harmful substances</span>
              <span class="value">${harm}</span>
              <span class="dot ${harm > 0 ? 'bad' : ''}"></span>
            </div>
            <div class="stat-row">
              <span class="ico">${STAT_TRIANGLE}</span>
              <span class="label">Beneficial substances</span>
              <span class="value">${ben}</span>
              <span class="dot"></span>
            </div>
            <div class="stat-row">
              <span class="ico">${STAT_RECYCLE}</span>
              <span class="label">Microplastics</span>
              <span class="value">${escapeHtml(opts.microplastics || 'None')}</span>
              <span class="dot ${/Detected|Likely|High/i.test(opts.microplastics || '') ? 'bad' : ''}"></span>
            </div>
          </div>
          <div class="scored-by">
            Scored by ${PINWHEEL_HTML} <strong>Purely</strong>
          </div>
          <div class="section-head">What's inside</div>
          ${findings.length
            ? findings.map((f) => `
                <div class="find-card ${f.kind === 'bad' ? 'bad' : f.kind === 'warn' ? 'warn' : ''}">
                  <strong>${escapeHtml((f.name || '').slice(0, 60))}</strong>
                  <p>${escapeHtml((f.description || '').slice(0, 140))}</p>
                </div>`).join('')
            : `<div class="find-card"><p>No specific ingredients extracted.</p></div>`}
        </div>
      </div>
      ${makeDownloadBtn(`purely-${safeName}-result.png`)}
    `);
    attachDownload(tile, `purely-${safeName}-result.png`);
  }

  function renderIngredientsScreen(tile, product) {
    clearTile(tile);
    const ing = product.ingredients || [];
    const goodCount = ing.filter((i) => /good|beneficial/i.test(i.label || '')).length;
    const watchCount = ing.filter((i) => /watch/i.test(i.label || '')).length;
    const avoidCount = ing.filter((i) => /avoid|harmful/i.test(i.label || '')).length;
    const safeName = (product.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    tile.insertAdjacentHTML('beforeend', `
      <div class="app-screen">
        ${STATUS_BAR_HTML}
        <div class="app-bar">
          ${BACK_ICON}
          <div class="app-title">Ingredients</div>
          <div class="spacer"></div>
        </div>
        <div class="app-body">
          <div class="hero-card">
            <div class="icon">${LEAF_ICON}</div>
            <div>
              <strong>${ing.length || 'No'} ingredients analyzed</strong>
              <span>Tap any ingredient to learn more</span>
            </div>
          </div>
          <div class="filter-row">
            <span class="filter-pill active">All (${ing.length})</span>
            <span class="filter-pill good">Good (${goodCount})</span>
            <span class="filter-pill warn">Watch (${watchCount})</span>
            <span class="filter-pill bad">Avoid (${avoidCount})</span>
          </div>
          <div class="ingredient-list">
            ${(ing.length ? ing.slice(0, 6) : [{ name: 'No data extracted', label: 'Good' }]).map(ingredientRowHtml).join('')}
          </div>
        </div>
      </div>
      ${makeDownloadBtn(`purely-${safeName}-ingredients.png`)}
    `);
    attachDownload(tile, `purely-${safeName}-ingredients.png`);
  }

  // ---------- Photo flow: 4 screens (summary, inside, detail, toxin) ----------
  function adaptPhotoToProduct(analysis) {
    // Map the analyze-product schema into a "product" shape the renderers can consume.
    const a = analysis.analysis || {};
    const p = a.product || {};
    const harm = (a.harmfulIngredients || []).map((h) => ({ name: h.name, label: 'Avoid', note: h.reason }));
    const cont = (a.contaminants || []).map((c) => ({ name: c.name, label: 'Avoid', note: c.amount || c.multiplier }));
    const ben = (a.beneficialAttributes || []).map((b) => ({ name: b.attribute, label: 'Good', note: b.why }));
    return {
      name: p.name || 'Product',
      brand: p.brand || '',
      category: p.subcategory || p.category || '',
      score: a.score,
      verdict: a.verdict || appScoreLabel(a.score || 0),
      ingredients: [...harm, ...cont, ...ben]
    };
  }

  function renderPhotoSummary(tile, analysis, imageUrl) {
    renderAnalysisScreen(tile, adaptPhotoToProduct(analysis), { imageUrl });
  }

  function renderPhotoInside(tile, analysis) {
    clearTile(tile);
    const a = analysis.analysis || {};
    const harm = (a.harmfulIngredients || []).slice(0, 3).map((h) => ({ kind: 'bad', name: h.name, body: h.reason, pill: 'Harmful' }));
    const cont = (a.contaminants || []).slice(0, 2).map((c) => ({ kind: 'bad', name: c.name, body: c.concern || '', amount: c.amount, pill: c.multiplier || c.status || 'Detected' }));
    const ben = (a.beneficialAttributes || []).slice(0, 2).map((b) => ({ kind: 'good', name: b.attribute, body: b.why, pill: 'Good' }));
    const items = [...cont, ...harm, ...ben].slice(0, 6);
    const safeName = (a.product?.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    tile.insertAdjacentHTML('beforeend', `
      <div class="app-screen">
        ${STATUS_BAR_HTML}
        <div class="app-bar">
          ${BACK_ICON}
          <div class="app-title">What's inside</div>
          <div class="spacer"></div>
        </div>
        <div class="app-body">
          ${items.length ? items.map((it) => `
            <div class="finding-card ${it.kind}">
              <div class="hd">
                <strong>${escapeHtml((it.name || '').slice(0, 40))}</strong>
                <span class="pill ${it.kind === 'bad' ? 'bad' : ''}">${escapeHtml(it.pill)}</span>
              </div>
              ${it.amount ? `<div class="amount">${escapeHtml(it.amount)}</div>` : ''}
              ${it.body ? `<div class="body">${escapeHtml(String(it.body).slice(0, 140))}</div>` : ''}
            </div>
          `).join('') : `<div class="finding-card"><div class="body">No specific findings extracted from the photo.</div></div>`}
        </div>
      </div>
      ${makeDownloadBtn(`purely-${safeName}-inside.png`)}
    `);
    attachDownload(tile, `purely-${safeName}-inside.png`);
  }

  function renderPhotoDetail(tile, analysis) {
    clearTile(tile);
    const a = analysis.analysis || {};
    // Pick the most interesting beneficial ingredient if score is good,
    // otherwise the worst harmful/contaminant — matches what the actual
    // app shows when you tap a row in the ingredient list.
    const isHighScore = (a.score || 0) >= 60;
    const focus = isHighScore
      ? (a.beneficialAttributes?.[0] || a.harmfulIngredients?.[0] || a.contaminants?.[0])
      : (a.harmfulIngredients?.[0] || a.contaminants?.[0] || a.beneficialAttributes?.[0])
      || { name: 'Ingredient', reason: '' };
    const focusName = (focus.name || focus.attribute || 'Ingredient').slice(0, 60);
    const focusDesc = (focus.reason || focus.concern || focus.why || 'Common ingredient — see details below.').slice(0, 200);
    const isHarm = !!(focus.reason || focus.concern) && !focus.why;
    const detailScore = isHarm ? -3 : isHighScore ? 3 : 0;
    const markerPos = ((detailScore + 5) / 10) * 100;
    const safeName = (a.product?.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    tile.insertAdjacentHTML('beforeend', `
      <div class="app-screen">
        ${STATUS_BAR_HTML}
        ${PURELY_HEADER(HDR_INFO)}
        <div class="app-body">
          <div class="detail-hero">
            <h2>${escapeHtml(focusName)}</h2>
            <p>${escapeHtml(focusDesc)}</p>
          </div>
          <div class="score-card">
            <div class="top">
              <span class="label">Score</span>
              <span class="scale">−5 to 5 scale</span>
            </div>
            <div class="big ${isHarm ? 'bad' : ''}">${detailScore}</div>
            <div class="grad"><div class="marker" style="left:${markerPos}%"></div></div>
            <div class="grad-labels">
              <div class="col"><span class="num">−5</span><span class="lbl">Very bad</span></div>
              <div class="col"><span class="num">0</span><span class="lbl">Okay</span></div>
              <div class="col"><span class="num">5</span><span class="lbl">Very good</span></div>
            </div>
          </div>
          <div class="acc-card">Risks <span class="plus">+</span></div>
          <div class="acc-card">Benefits <span class="plus">+</span></div>
          <div class="acc-card">Legal limit <span class="plus">+</span></div>
          <div class="acc-card">Health guideline <span class="plus">+</span></div>
          <div class="acc-card">References <span class="plus">+</span></div>
          <div class="detail-foot">
            <span>${escapeHtml((a.product?.name || '').slice(0, 60))}</span>
            <span>Product score ${a.score || '—'}/100</span>
          </div>
          <button class="edit-pill">Edit</button>
        </div>
      </div>
      ${makeDownloadBtn(`purely-${safeName}-detail.png`)}
    `);
    attachDownload(tile, `purely-${safeName}-detail.png`);
  }

  function renderPhotoToxin(tile, analysis, imageUrl) {
    clearTile(tile);
    const a = analysis.analysis || {};
    const p = a.product || {};
    const score = Math.max(0, Math.min(100, Number(a.score) || 50));
    const ringColor = appScoreColor(score);
    const dash = (score / 100) * 289;
    const verdict = a.verdict || appScoreLabel(score);
    const harmCount = a.harmfulCount ?? ((a.harmfulIngredients?.length || 0) + (a.contaminants?.length || 0));
    const benCount = a.beneficialCount ?? (a.beneficialAttributes?.length || 0);
    const mp = a.microplastics || {};
    const mpDetected = /Detected|Likely/i.test(mp.status || '');
    const focus = a.contaminants?.[0] || a.harmfulIngredients?.[0] || null;
    const photoEl = imageUrl
      ? `<img src="${escapeHtml(imageUrl)}" alt="">`
      : placeholderPhoto(p, ringColor);
    const safeName = (p.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    tile.insertAdjacentHTML('beforeend', `
      <div class="app-screen">
        ${STATUS_BAR_HTML}
        <div class="app-bar">
          ${BACK_ICON}
          <div class="app-title">Toxin Report</div>
          <div class="spacer"></div>
        </div>
        <div class="app-body">
          <div style="display:flex;gap:0.6em;align-items:center">
            <div class="photo" style="width:25%;aspect-ratio:1;border-radius:0.7em;background:#FFF;display:flex;align-items:center;justify-content:center;padding:0.3em;box-shadow:0 0.3em 0.7em rgba(0,0,0,.05);overflow:hidden">${photoEl}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.85em;font-weight:700;line-height:1.2">${escapeHtml((p.name || 'Product').slice(0, 40))}</div>
              ${p.brand ? `<div style="font-size:0.6em;color:#6B6762;margin-top:0.2em">${escapeHtml(p.brand)}</div>` : ''}
            </div>
            <div class="result-score" style="width:25%">
              <svg viewBox="0 0 102 102">
                <circle cx="51" cy="51" r="46" stroke="#E3E0DA" stroke-width="7" fill="none"/>
                <circle cx="51" cy="51" r="46" stroke="${ringColor}" stroke-width="7" fill="none"
                  stroke-linecap="round" stroke-dasharray="${dash} 289" transform="rotate(-90 51 51)"/>
              </svg>
              <div class="num"><strong>${score}</strong><span>${escapeHtml(verdict)}</span></div>
            </div>
          </div>
          <div class="stat-chip-row">
            <div class="stat-chip ${harmCount > 0 ? 'bad' : 'good'}"><span class="v">${harmCount}</span><span class="l">Harmful</span></div>
            <div class="stat-chip ${benCount > 0 ? 'good' : 'warn'}"><span class="v">${benCount}</span><span class="l">Beneficial</span></div>
            <div class="stat-chip ${mpDetected ? 'bad' : 'warn'}"><span class="v">${escapeHtml((mp.status || 'No data').slice(0, 12))}</span><span class="l">Microplastics</span></div>
          </div>
          <div class="result-section">
            <h4>What's inside</h4>
            ${focus ? `
              <div class="finding-card bad">
                <div class="hd">
                  <strong>${escapeHtml((focus.name || '').slice(0, 40))}</strong>
                  <span class="pill bad">${escapeHtml(focus.multiplier || focus.status || 'Detected')}</span>
                </div>
                ${focus.amount ? `<div class="amount">${escapeHtml(focus.amount)}${focus.limit ? ' · limit ' + escapeHtml(focus.limit) : ''}</div>` : ''}
                <div class="body">${escapeHtml(String(focus.concern || focus.reason || '').slice(0, 140))}</div>
              </div>` : `<div class="finding-card good"><div class="hd"><strong>No major contaminants flagged</strong></div></div>`}
          </div>
          <div class="app-footer">Scored by Purely</div>
        </div>
      </div>
      ${makeDownloadBtn(`purely-${safeName}-toxin.png`)}
    `);
    attachDownload(tile, `purely-${safeName}-toxin.png`);
  }

  // ---------- html2canvas-based PNG download (lazy-loaded) ----------
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
  async function downloadAppScreen(tile, filename) {
    const screen = tile.querySelector('.app-screen');
    if (!screen) throw new Error('no screen to capture');
    const h2c = await loadHtml2Canvas();

    // Wait for any inline images (proxied product photo) to finish loading
    // — html2canvas snapshots half-loaded <img>s as blank otherwise.
    const imgs = Array.from(screen.querySelectorAll('img'));
    await Promise.all(imgs.map((img) => (img.complete && img.naturalWidth > 0)
      ? null
      : new Promise((res) => { img.onload = img.onerror = res; setTimeout(res, 4000); })));

    // Clone off-screen at a fixed marketing width (440px = ~iPhone Pro)
    // and let it expand to its natural scroll-height. This bypasses the
    // visible-only capture limit when the app-screen is scrollable.
    const clone = screen.cloneNode(true);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;top:0;left:-12000px;z-index:-1;pointer-events:none;background:#FFF';
    Object.assign(clone.style, {
      position: 'static', inset: 'auto', width: '440px', height: 'auto',
      maxHeight: 'none', overflow: 'visible', transform: 'none', background: '#FFF'
    });
    wrap.appendChild(clone);
    document.body.appendChild(wrap);

    try {
      // Force reflow so scrollHeight is accurate
      void clone.offsetHeight;
      const fullHeight = Math.max(clone.scrollHeight, clone.offsetHeight);

      const canvas = await h2c(clone, {
        backgroundColor: '#FFFFFF',
        scale: 3, // 440 × 3 = 1320px wide PNG — looks crisp at 2x retina
        useCORS: true,
        logging: false,
        width: 440,
        height: fullHeight,
        windowWidth: 440,
        windowHeight: fullHeight,
        imageTimeout: 8000
      });
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
    } finally {
      wrap.remove();
    }
  }

  function extractTikTokUrl(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    // Pull the first URL out — handles "Check this out https://vm.tiktok.com/abc/ 🔥"
    const urlMatch = s.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) s = urlMatch[0];
    // Strip trailing punctuation that often hitches a ride on shared links
    s = s.replace(/[)\].,;:'"!?]+$/, '');
    // Accept bare host pastes ("vm.tiktok.com/abc")
    if (!/^https?:\/\//i.test(s) && /tiktok\.com/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    return s;
  }

  async function analyze() {
    hideError();
    const url = extractTikTokUrl(urlInput.value);
    if (!url) return;
    // Accept www, vm, vt, m, t/ — anything containing tiktok.com
    if (!/(?:^|\/\/|\.)tiktok\.com\//i.test(url)) {
      showError("Doesn't look like a TikTok link. Paste a TikTok URL or the app's Share link.");
      return;
    }
    urlInput.value = url;

    progress.hidden = false;
    results.hidden = true;
    results.innerHTML = '';
    goBtn.disabled = true; goBtn.classList.add('busy');
    setStep('scrape', 'active');
    setStep('transcribe', null); setStep('extract', null); setStep('images', null);
    setProgress(8, '<strong>Scraping TikTok</strong> — this can take 30-60s for fresh reels');

    let payload;
    try {
      const res = await fetch('/api/tiktok-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, refresh: forceRefresh })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      payload = j;
    } catch (e) {
      showError('Analysis failed: ' + e.message);
      goBtn.disabled = false; goBtn.classList.remove('busy');
      setStep('scrape', null);
      progress.hidden = true;
      return;
    }
    setStep('scrape', 'done');
    setStep('transcribe', payload.transcript?.length ? 'done' : 'done');
    setStep('extract', 'done');
    setProgress(60, `<strong>Found ${payload.analysis?.products?.length || 0} product(s)</strong> · generating Purely mockups…`);

    renderResults(payload);
    setStep('images', 'active');

    // Render real Purely app UI inside each iPhone frame — no AI calls,
    // synchronous, pixel-faithful to the actual RN screens.
    const products = payload.analysis?.products || [];
    if (products.length === 0) {
      setStep('images', 'done');
      setProgress(100, '<strong>Done</strong> — no specific products mentioned in this reel');
      goBtn.disabled = false; goBtn.classList.remove('busy');
      return;
    }
    const cover = payload.tiktok?.video?.cover || payload.tiktok?.cover || null;
    products.forEach((p, productIdx) => {
      const tile = document.querySelector(`.mockup[data-product="${productIdx}"][data-screen="report"]`);
      if (tile) renderTikTokScreen(tile, p, cover);
    });
    setStep('images', 'done');
    setProgress(100, `<strong>Done</strong> — ${products.length} live Toxin Report${products.length > 1 ? 's' : ''} rendered`);
    goBtn.disabled = false; goBtn.classList.remove('busy');
  }

  /* ---------- Render ---------- */
  function renderResults(payload) {
    const tt = payload.tiktok || {};
    const an = payload.analysis || {};
    const transcript = payload.transcript || [];

    results.hidden = false;
    results.innerHTML = `
      ${renderSummary(tt, an)}
      <div class="r-grid">
        <aside class="r-side">
          <div class="r-video">
            <iframe src="https://www.tiktok.com/player/v1/${encodeURIComponent(tt.id)}?description=0&music_info=0" allow="autoplay; fullscreen; clipboard-write" allowfullscreen referrerpolicy="origin-when-cross-origin"></iframe>
          </div>
          ${an.purelyTakeaway ? `
            <div class="r-callout">
              <strong>Purely takeaway</strong>
              <p>${escapeHtml(an.purelyTakeaway)}</p>
            </div>` : ''}
          ${transcript.length ? `
            <div class="r-panel" style="padding:16px 18px">
              <div class="r-panel-hd"><h3><span class="icon"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>Transcript</h3>
                <button class="r-action" id="copy-script"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M4 16V6a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>Copy</button>
              </div>
              <div class="r-transcript">
                ${transcript.map((t) => `
                  <div class="rt-row"><div class="rt-time">${String(Math.floor(t.time/60)).padStart(2,'0')}:${String(Math.floor(t.time%60)).padStart(2,'0')}</div><div class="rt-text">${escapeHtml(t.text)}</div></div>
                `).join('')}
              </div>
            </div>` : ''}
        </aside>

        <div class="r-main">
          ${an.summary ? `
            <div class="r-panel">
              <div class="r-panel-hd"><h3><span class="icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 8v5M12 16h0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>What this reel is about</h3></div>
              <p class="r-summary-text">${escapeHtml(an.summary)}</p>
            </div>` : ''}

          ${(an.products || []).length === 0 ? `
            <div class="r-panel">
              <p class="r-summary-text">No specific products were named in this reel — try a more product-focused video.</p>
            </div>
          ` : (an.products || []).map((p, idx) => renderProduct(p, idx)).join('')}
        </div>
      </div>
    `;

    document.getElementById('copy-script')?.addEventListener('click', () => {
      copy(transcript.map((t) => t.text).join(' '));
    });
    document.querySelectorAll('.pc-regen').forEach((b) => {
      b.addEventListener('click', () => regenAll(payload.tiktok.id, Number(b.dataset.idx), b));
    });
  }

  function renderSummary(tt, an) {
    return `
      <div class="r-summary">
        <div class="author">
          ${tt.author?.avatar ? `<img src="/api/img?u=${encodeURIComponent(tt.author.avatar)}" alt="" />` : `<span style="width:46px;height:46px;border-radius:50%;background:#eaf5ed;display:inline-block"></span>`}
          <div>
            <strong>${escapeHtml(tt.author?.nickname || tt.author?.name || tt.handle || 'unknown')}</strong>
            <span>@${escapeHtml(tt.handle || '')}${tt.author?.verified ? ' · verified' : ''}</span>
          </div>
        </div>
        <div class="meta-stats">
          <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 8 1 12c1.7 4 6 7.5 11 7.5s9.3-3.5 11-7.5c-1.7-4-6-7.5-11-7.5zm0 12a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>${fmtCount(tt.stats?.plays)}</span>
          <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.7-7-10a4.5 4.5 0 0 1 8-3 4.5 4.5 0 0 1 8 3c0 5.3-7 10-7 10h-2z"/></svg>${fmtCount(tt.stats?.likes)}</span>
          <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12a9 9 0 1 1-5-8l-3 1 1 3a6 6 0 1 0 4 7l2 1a9 9 0 0 0 1-4z"/></svg>${fmtCount(tt.stats?.comments)}</span>
          <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18l7-5 7 5V3z"/></svg>${fmtCount(tt.stats?.saves)}</span>
        </div>
        <div class="meta-actions">
          <a class="r-action" href="${escapeHtml(tt.url || '#')}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24"><path d="M14 3h7v7M21 3l-9 9M5 5h6M5 12h0M5 19h14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>
            Open
          </a>
        </div>
      </div>
    `;
  }

  function ringColorFor(score) {
    if (score < 40) return '#d44a4a';
    if (score < 70) return '#e0a32a';
    return '#3f9a5d';
  }

  function renderProduct(p, idx) {
    const verdictClass = /good/i.test(p.verdict || '') ? '' : /watch/i.test(p.verdict || '') ? 'warn' : /avoid/i.test(p.verdict || '') ? 'bad' : '';
    const score = Number.isFinite(p.score) ? Math.max(0, Math.min(100, p.score)) : 80;
    const CIRC = 150.8;
    const dashOff = CIRC - (score / 100) * CIRC;
    const ringColor = ringColorFor(score);
    const ing = p.ingredients || [];

    return `
      <article class="product-card" id="product-${idx}">
        <div class="pc-head">
          <div>
            ${p.brand ? `<div class="brand">${escapeHtml(p.brand)}</div>` : ''}
            <h3>${escapeHtml(p.name || 'Product')}</h3>
          </div>
          <span class="pc-verdict ${verdictClass}">${escapeHtml(p.verdict || 'Good Choice')}</span>
        </div>
        <div class="pc-meta">
          <div class="pc-score">
            <div class="pc-score-ring">
              <svg viewBox="0 0 60 60">
                <circle cx="30" cy="30" r="24" stroke="#e2e8e4" stroke-width="5" fill="none"/>
                <circle cx="30" cy="30" r="24" stroke="${ringColor}" stroke-width="5" fill="none" stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${dashOff}" transform="rotate(-90 30 30)"/>
              </svg>
              <span>${score}</span>
            </div>
            <div>
              <div style="font-size:11px;color:var(--ink-3);font-weight:600;text-transform:uppercase;letter-spacing:.06em">Health Score</div>
              <div style="font-size:13px;color:var(--ink);font-weight:600">${score}/100</div>
            </div>
          </div>
          <p class="pc-summary">${escapeHtml(p.summary || '')}</p>
          <span class="pc-cat">${escapeHtml(p.category || 'other')}</span>
        </div>
        <div class="pc-body">
          <div class="pc-list good">
            <h4>What's good</h4>
            <ul>${(p.good || []).length ? p.good.map((x) => `<li>${escapeHtml(x)}</li>`).join('') : '<li style="color:var(--ink-3);padding-left:0">—</li>'}</ul>
          </div>
          <div class="pc-list watch">
            <h4>Watch out for</h4>
            <ul>${(p.watchOut || []).length ? p.watchOut.map((x) => `<li>${escapeHtml(x)}</li>`).join('') : '<li style="color:var(--ink-3);padding-left:0">—</li>'}</ul>
          </div>
        </div>
        ${ing.length ? `
          <div class="pc-ingredients">
            <h4>Ingredients (${ing.length})</h4>
            <div class="pc-ing-list">
              ${ing.slice(0, 12).map((i) => `
                <div class="pc-ing-row">
                  <div>
                    <div class="pc-ing-name">${escapeHtml(i.name || '')}</div>
                    ${i.note ? `<div class="pc-ing-note">${escapeHtml(i.note)}</div>` : ''}
                  </div>
                  <span class="pc-ing-tag ${/watch/i.test(i.label||'') ? 'warn' : /avoid/i.test(i.label||'') ? 'bad' : ''}">${escapeHtml(i.label || 'Good')}</span>
                </div>
              `).join('')}
            </div>
          </div>` : ''}
        <div class="pc-mockups">
          <div class="pc-mockups-hd">
            <h4>Generated Purely screens</h4>
            <button class="pc-regen" data-idx="${idx}" title="Regenerate all 3 screens">
              <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5.3M20 4v5h-5M20 12a8 8 0 0 1-14 5.3M4 20v-5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>
              Regenerate
            </button>
          </div>
          <div class="mockup-grid">
            <div class="mockup" data-product="${idx}" data-screen="report">
              <span class="mockup-label">Toxin Report</span>
              <div class="skel"></div>
            </div>
          </div>
        </div>
        ${lifestyleSectionHtml({
          scope: `tt-${idx}`,
          name: p.name || 'Product',
          brand: p.brand || '',
          category: p.subcategory || p.category || ''
        })}
      </article>
    `;
  }

  async function downloadMockup(url, filename) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const blob = await r.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = obj;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(obj), 1000);
      showToast('Saved', 'ok');
    } catch (e) {
      window.open(url, '_blank', 'noopener');
    }
  }

  function updateMockup(productIdx, screen, url, errMsg) {
    const tile = document.querySelector(`.mockup[data-product="${productIdx}"][data-screen="${screen}"]`);
    if (!tile) return;
    if (url) {
      tile.querySelector('.skel')?.remove();
      tile.querySelector('img')?.remove();
      tile.querySelector('.err-msg')?.remove();
      tile.querySelector('.dl-btn')?.remove();

      const img = document.createElement('img');
      img.src = url;
      img.alt = `${screen} mockup`;
      img.loading = 'eager'; img.decoding = 'async';
      tile.appendChild(img);

      const dl = document.createElement('button');
      dl.className = 'dl-btn';
      dl.title = 'Download';
      dl.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = tile.closest('.product-card');
        const productName = card?.querySelector('.pc-head h3')?.textContent?.trim() || 'product';
        const safeName = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        dl.classList.add('busy');
        downloadMockup(url, `purely-${safeName}-${screen}.png`).finally(() => dl.classList.remove('busy'));
      });
      tile.appendChild(dl);
    } else {
      tile.querySelector('.skel')?.remove();
      tile.querySelector('.err-msg')?.remove();
      const e = document.createElement('div');
      e.className = 'err-msg';
      e.textContent = (errMsg || 'failed').slice(0, 120);
      tile.appendChild(e);
    }
  }

  async function regenAll(_tiktokId, productIdx, btn) {
    // Re-render the 3 app screens for this product. Pulls the live product
    // data from the rendered card so we don't have to round-trip the API.
    btn.classList.add('busy'); btn.disabled = true;
    try {
      const card = document.getElementById(`product-${productIdx}`);
      if (!card) return;
      // Reconstruct a minimal product from the card's data — but the simplest
      // path is to find the in-memory analysis. Since we keep no global state,
      // re-fetch the analysis cache (this is just a JSON read, not AI).
      const tiktokId = _tiktokId;
      const r = await fetch('/api/tiktok-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `https://www.tiktok.com/video/${tiktokId}` })
      });
      const payload = r.ok ? await r.json() : null;
      const product = payload?.analysis?.products?.[productIdx];
      if (!product) throw new Error('could not reload product');
      const tile = document.querySelector(`.mockup[data-product="${productIdx}"][data-screen="report"]`);
      const cover = payload?.tiktok?.video?.cover || payload?.tiktok?.cover || null;
      if (tile) renderTikTokScreen(tile, product, cover);
    } catch (e) {
      showToast('Re-render failed: ' + e.message, 'err');
    } finally {
      btn.classList.remove('busy'); btn.disabled = false;
    }
  }

  /* ===================================================================
   *  Photo flow — Upload product photo, analyze with ruthless prompt,
   *  generate 4 Purely mockup screens.
   * =================================================================== */
  const tabs = document.querySelectorAll('.tt-tab');
  const photoSection = $('#tt-photo');
  const photoInput = $('#photo-input');
  const photoDrop = $('#photo-drop');
  const photoPreview = $('#photo-preview');
  const photoThumb = $('#photo-thumb');
  const ppName = $('#pp-name');
  const ppSize = $('#pp-size');
  const ppClear = $('#pp-clear');
  const ppGo = $('#pp-go');

  let pickedFile = null;

  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    const mode = t.dataset.mode;
    form.hidden = mode !== 'url';
    photoSection.hidden = mode !== 'photo';
  }));

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

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

  // --- Free, in-browser OCR via Tesseract.js (CDN, pre-warmed on page load) ---
  // The script + WASM + English language model are ~10MB combined and take
  // 2-3s to download. We kick that off in idle time so by the time the user
  // submits a photo, the worker is already initialized and recognize() takes
  // ~1s instead of ~4s.
  let _tesseractPromise = null;
  function ensureTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (_tesseractPromise) return _tesseractPromise;
    _tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error('Tesseract CDN load failed'));
      document.head.appendChild(s);
    });
    return _tesseractPromise;
  }

  let _workerPromise = null;
  function getOcrWorker() {
    if (_workerPromise) return _workerPromise;
    _workerPromise = (async () => {
      const T = await ensureTesseract();
      // createWorker loads core + downloads `eng.traineddata` once; subsequent
      // recognize() calls reuse the worker.
      return T.createWorker('eng');
    })();
    return _workerPromise;
  }

  // Kick off pre-warm as soon as the page is idle. Failures are silent —
  // ocrFile() will surface them when the user actually submits a photo.
  function prewarmOcr() { getOcrWorker().catch(() => { _workerPromise = null; }); }
  if ('requestIdleCallback' in window) requestIdleCallback(prewarmOcr, { timeout: 3000 });
  else setTimeout(prewarmOcr, 1200);

  async function ocrFile(file) {
    try {
      const worker = await getOcrWorker();
      // Fake-tick the progress bar so the UI doesn't feel frozen during OCR.
      let pct = 20;
      const ticker = setInterval(() => {
        pct = Math.min(pct + 2, 44);
        setProgress(pct, `<strong>Reading label</strong> — ${pct - 20}/25`);
      }, 200);
      try {
        const { data } = await worker.recognize(file);
        return (data?.text || '').trim();
      } finally {
        clearInterval(ticker);
      }
    } catch (e) {
      console.warn('[ocr] failed:', e && e.message);
      return '';
    }
  }

  async function analyzePhoto() {
    if (!pickedFile) return;
    hideError();
    progress.hidden = false;
    results.hidden = true;
    results.innerHTML = '';
    setProgress(8, '<strong>Uploading photo</strong>…');
    setStep('scrape', 'active');
    setStep('transcribe', null); setStep('extract', null); setStep('images', null);

    let imageUrl;
    try {
      // 1. Get signed URL
      const sign = await fetch('/api/sign-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: pickedFile.name, contentType: pickedFile.type, size: pickedFile.size, handle: 'product' })
      });
      const signJ = await sign.json();
      if (!sign.ok) throw new Error(signJ.error || 'upload sign failed');

      // 2. Upload via signed URL
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
    setStep('scrape', 'done');

    // 2b. OCR the label locally (free, no API key) so the server can match a
    // real product in the Purely DB before paying for a GPT vision call.
    setStep('transcribe', 'active');
    setProgress(20, '<strong>Reading label</strong> with on-device OCR…');
    const ocrText = await ocrFile(pickedFile);
    setStep('transcribe', 'done');
    setProgress(45, ocrText
      ? `<strong>Matching</strong> against 430k Purely products…`
      : `<strong>Analyzing</strong> with Purely's ruthless rubric…`);

    // 3. Analyze (DB-only — no GPT fallback)
    let payload;
    try {
      const r = await fetch('/api/analyze-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl, ocrText, refresh: forceRefresh })
      });
      payload = await r.json();
      if (!r.ok) throw new Error(payload.error || 'analysis failed');
    } catch (e) {
      showError('Analysis error: ' + e.message);
      ppGo.disabled = false; ppGo.classList.remove('busy');
      return;
    }
    setStep('extract', 'done');

    // No DB match → show a clear "not in our database" message instead of
    // fabricating an analysis with GPT.
    if (payload.source === 'no_match' || !payload.analysis) {
      progress.hidden = true;
      ppGo.disabled = false; ppGo.classList.remove('busy');
      const reason = payload.reason || "We couldn't match this product in the Purely database.";
      const ocrLine = payload.ocrText
        ? `<div style="margin-top:8px;font-size:12px;color:#9B958D;font-style:italic">Read from label: "${escapeHtml(String(payload.ocrText).slice(0, 200).replace(/\s+/g, ' ').trim())}"</div>`
        : '';
      results.hidden = false;
      results.innerHTML = `
        <div class="product-result no-match">
          <div class="pr-photo" style="margin:0 auto 18px;max-width:320px"><img src="${escapeHtml(imageUrl)}" alt="" style="width:100%;border-radius:14px"/></div>
          <h2 style="text-align:center;margin:0 0 8px;font-size:22px">Not in our database — yet</h2>
          <p style="text-align:center;color:#6B6762;max-width:520px;margin:0 auto;line-height:1.5">${escapeHtml(reason)} The Purely catalog covers 430,000+ products but doesn't have this one yet. Try a clearer photo of the label, or scan a different product.</p>
          ${ocrLine}
        </div>`;
      return;
    }

    setProgress(60, `<strong>Score: ${payload.analysis?.score ?? '?'} / 100</strong> · matched <em>${escapeHtml(payload.matchedName || '')}</em> · rendering Purely screens…`);

    // Prefer the real product image from the DB when we matched a known item.
    const displayImage = payload.imageUrl || imageUrl;

    renderProductResult(payload, displayImage);
    setStep('images', 'active');

    // 4. Render one big Toxin Report screen — scrollable on the page,
    //    captured as a full-content PNG when downloaded.
    const tile = document.querySelector('.pr-mockups .mockup[data-screen="report"]');
    if (tile) renderPhotoScreen(tile, payload, displayImage);
    setStep('images', 'done');
    setProgress(100, `<strong>Done</strong> — rendered from Purely DB.`);
  }

  function dotColor(verdict) {
    return verdict === 'good' ? '#4ea96b' : verdict === 'warn' ? '#e8b84a' : '#e26a6a';
  }

  function renderProductResult(payload, imageUrl) {
    const a = payload.analysis || {};
    const p = a.product || {};
    const score = Number.isFinite(a.score) ? Math.max(0, Math.min(100, a.score)) : 50;
    const verdict = a.verdict || 'Okay';
    const ringColor = ringColorFor(score);
    const CIRC = 150.8;
    const ringOffset = CIRC - (score / 100) * CIRC;
    const harmCount = a.harmfulCount ?? (a.harmfulIngredients?.length || 0) + (a.contaminants?.length || 0);
    const benCount = a.beneficialCount ?? (a.beneficialAttributes?.length || 0);
    const mp = a.microplastics || {};

    results.hidden = false;
    results.innerHTML = `
      <div class="product-result">
        <div class="pr-head">
          <div class="pr-photo"><img src="${escapeHtml(imageUrl)}" alt="" /></div>
          <div>
            <h2 class="pr-name">${escapeHtml(p.name || 'Product')}</h2>
            ${p.brand ? `<div class="pr-brand">${escapeHtml(p.brand)}</div>` : ''}
            <div class="pr-chips">
              ${p.subcategory ? `<span class="pr-chip">${escapeHtml(p.subcategory)}</span>` : ''}
              <span class="pr-chip warn">⚠ Toxin report</span>
            </div>
          </div>
          <div class="pr-score" style="--ring:${ringColor}">
            <svg viewBox="0 0 60 60">
              <circle cx="30" cy="30" r="24" stroke="#e2e8e4" stroke-width="5" fill="none"/>
              <circle cx="30" cy="30" r="24" stroke="${ringColor}" stroke-width="5" fill="none" stroke-linecap="round"
                stroke-dasharray="${CIRC}" stroke-dashoffset="${ringOffset}" transform="rotate(-90 30 30)"/>
            </svg>
            <div class="pr-score-text">
              <strong>${score}</strong>
              <span>${escapeHtml(verdict)}</span>
            </div>
          </div>
        </div>

        <div class="pr-stats">
          <div class="pr-stat ${harmCount > 0 ? 'bad' : ''}">
            <span class="icon"><svg viewBox="0 0 24 24"><path d="M12 2l11 19H1L12 2zm0 7v6m0 3v.01" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            <div class="pr-stat-meta"><strong>${harmCount}</strong><span>Harmful substances</span></div>
          </div>
          <div class="pr-stat">
            <span class="icon"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            <div class="pr-stat-meta"><strong>${benCount}</strong><span>Beneficial substances</span></div>
          </div>
          <div class="pr-stat ${(mp.status === 'Detected' || mp.status === 'Likely') ? 'bad' : 'warn'}">
            <span class="icon"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 12l3 3 5-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></span>
            <div class="pr-stat-meta"><strong>${escapeHtml(mp.status || 'No data')}</strong><span>Microplastics</span></div>
          </div>
        </div>

        ${a.headline ? `<div class="pr-headline">${escapeHtml(a.headline)}</div>` : ''}

        <div class="pr-section">
          <h3>What's inside</h3>
          <div class="pr-list">
            ${(a.contaminants || []).slice(0, 8).map((c) => `
              <div class="pr-card bad">
                <div class="pr-card-hd">
                  <strong>${escapeHtml(c.name)}</strong>
                  <span class="pill bad">${escapeHtml(c.multiplier || c.status || 'Detected')}</span>
                </div>
                ${c.amount ? `<div class="pr-card-amount">${escapeHtml(c.amount)}${c.limit ? ' · limit ' + escapeHtml(c.limit) : ''}${c.limitSource ? ' (' + escapeHtml(c.limitSource) + ')' : ''}</div>` : ''}
                <div class="pr-card-body">${escapeHtml(c.concern || '')}</div>
                ${c.source ? `<div class="pr-card-source">Source: ${escapeHtml(c.source)}</div>` : ''}
              </div>
            `).join('')}
            ${(a.harmfulIngredients || []).slice(0, 8).map((h) => `
              <div class="pr-card bad">
                <div class="pr-card-hd"><strong>${escapeHtml(h.name)}</strong><span class="pill bad">Harmful</span></div>
                <div class="pr-card-body">${escapeHtml(h.reason || '')}</div>
                ${h.source ? `<div class="pr-card-source">Source: ${escapeHtml(h.source)}</div>` : ''}
              </div>
            `).join('')}
            ${(a.beneficialAttributes || []).slice(0, 6).map((b) => `
              <div class="pr-card good">
                <div class="pr-card-hd"><strong>${escapeHtml(b.attribute)}</strong><span class="pill">Good</span></div>
                <div class="pr-card-body">${escapeHtml(b.why || '')}</div>
                ${b.source ? `<div class="pr-card-source">Source: ${escapeHtml(b.source)}</div>` : ''}
              </div>
            `).join('')}
            ${((a.contaminants||[]).length + (a.harmfulIngredients||[]).length + (a.beneficialAttributes||[]).length === 0)
              ? `<div class="pr-card"><div class="pr-card-body">No specific substances were extracted from the photo. Try a clearer shot of the label.</div></div>` : ''}
          </div>
        </div>

        <div class="pr-section">
          <h3>Generated Purely screens</h3>
          <div class="pr-mockups">
            <div class="mockup" data-screen="report">
              <span class="mockup-label">Toxin Report</span>
              <div class="skel"></div>
            </div>
          </div>
        </div>

        ${lifestyleSectionHtml({
          scope: 'photo',
          name: p.name || 'Product',
          brand: p.brand || '',
          category: p.subcategory || p.category || ''
        })}

        ${(a.sources || []).length ? `
          <div class="pr-section">
            <h3>Sources</h3>
            <div class="pr-list">
              ${a.sources.slice(0, 12).map((s) => `
                <div class="pr-card"><div class="pr-card-body"><strong>${escapeHtml(s.name || '')}</strong> — ${escapeHtml(s.description || '')}${s.url ? ` · <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" style="color:var(--green-700)">link</a>` : ''}</div></div>
              `).join('')}
            </div>
          </div>` : ''}
      </div>
    `;
  }

  function updateProductMockup(screen, url, errMsg) {
    const tile = document.querySelector(`.pr-mockups .mockup[data-screen="${screen}"]`);
    if (!tile) return;
    if (url) {
      tile.querySelector('.skel')?.remove();
      tile.querySelector('img')?.remove();
      tile.querySelector('.err-msg')?.remove();
      tile.querySelector('.dl-btn')?.remove();
      const img = document.createElement('img');
      img.src = url; img.loading = 'eager'; img.decoding = 'async';
      tile.appendChild(img);
      const dl = document.createElement('button');
      dl.className = 'dl-btn'; dl.title = 'Download';
      dl.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        dl.classList.add('busy');
        downloadMockup(url, `purely-${screen}.png`).finally(() => dl.classList.remove('busy'));
      });
      tile.appendChild(dl);
    } else {
      tile.querySelector('.skel')?.remove();
      const e = document.createElement('div');
      e.className = 'err-msg';
      e.textContent = (errMsg || 'failed').slice(0, 120);
      tile.appendChild(e);
    }
  }
})();
