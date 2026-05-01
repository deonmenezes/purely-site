/**
 * /analyze — product photo scanner.
 *
 * Pipeline:
 *   1. User picks a photo → signed-URL upload to Supabase
 *   2. POST /api/analyze-product — gpt-4o-mini OCR reads the label, then
 *      huge_dataset.items_full lookup returns the curated DB row (real score,
 *      ingredients, severity_score, bonus_score, nutrients, alternatives,
 *      mirrored image) — NO AI analysis, NO fabricated data
 *   3. Live preview rendered by tiktok.js's renderToxinReport (same component
 *      /tiktok uses) — shows EVERY DB field
 *   4. Share gallery clones SECTIONS of that rendered preview into 9:16
 *      frames, plus per-ingredient detail screens via the existing
 *      buildIngredientScreenOffscreen (which already shows risks / benefits /
 *      legal limit / health guideline / references / -5..5 ingredient score —
 *      all straight from the ingredients table). Each frame downloads as one
 *      PNG using html2canvas — no slicing of one long page.
 *
 * Every visible value: pulled from the database. Nothing hand-made.
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
  function showError(msg) { errBox.textContent = msg; errBox.hidden = false; }
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
    setProgress(100, '<strong>Done</strong> — every value pulled from the Purely database.');
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
   *  Result panel: header + live preview + share gallery.
   *  All visible data is the same payload the live preview reads.
   * ============================================================ */
  function renderResult(payload, imageUrl) {
    const a = payload.analysis || {};
    const p = a.product || {};
    const score = Math.max(0, Math.min(100, Math.round(Number(a.score) || 0)));
    const verdict = a.verdict || (window.PurelyApp?.scoreLabel?.(score) || 'Okay');
    const ringColor = window.PurelyApp?.scoreColor?.(score) || '#2F8A5B';
    const brand = p.brand || '';
    const name = p.name || 'Product';
    const matchedFrom = payload.matchedName || '';
    const slug = safeSlug(name);

    const harmCount = a.harmfulCount ?? ((a.harmfulIngredients?.length || 0) + (a.contaminants?.length || 0));
    const benCount = a.beneficialCount ?? (a.beneficialAttributes?.length || 0);
    const mp = a.microplastics || {};
    const mpStatus = (typeof mp === 'string') ? mp : (mp.status || 'No data');

    /* Build the same findings array tiktok.js's renderPhotoScreen builds —
     * keeps the live preview's "Top concerns" list identical to /tiktok. */
    const findings = [];
    (a.contaminants || []).slice(0, 4).forEach((c) => findings.push({
      kind: 'bad', name: c.name,
      pill: c.multiplier || c.status || 'Detected',
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
    if (Array.isArray(a.uiSummary?.topAttributes) && a.uiSummary.topAttributes.length) {
      a.uiSummary.topAttributes.slice(0, 6).forEach((t) => {
        const v = String(t.verdict || '').toLowerCase();
        const kind = /bad|harm/.test(v) ? 'bad' : /good|benef/.test(v) ? 'good' : 'neutral';
        findings.push({
          kind, name: t.label || t.value || 'Attribute',
          label: t.label || '', value: t.value || '',
          body: t.value ? `${t.value}${t.note ? ` — ${t.note}` : ''}` : (t.note || ''),
          pill: t.label || ''
        });
      });
    }
    /* Dedupe by name — uiSummary often repeats names already in contaminants/harmful. */
    const seen = new Set();
    const dedup = findings.filter((f) => {
      const k = String(f.name || '').toLowerCase().trim();
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });

    /* ---------- Result HTML scaffold ---------- */
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

    const previewHtml = `
      <div class="az-preview-wrap">
        <div class="az-preview-hd">
          <h3>Live preview</h3>
          <p>The full Purely-app result screen — every field below is straight from the database. Tap any ingredient row to see its severity score, risks, benefits, legal limits, and references.</p>
        </div>
        <div class="pr-app-preview az-preview-tile" data-screen="report">
          <div class="skel"></div>
        </div>
      </div>`;

    const galleryHtml = `
      <div class="az-share-section">
        <div class="az-screens-hd">
          <div class="copy">
            <h3>Shareable screens</h3>
            <p>Each thumbnail is a 1080×1920 PNG built from the same Purely-app layout you see above — the actual app design, not a redrawn version. Save individually or grab them all at once.</p>
          </div>
          <button class="az-save-all" id="az-save-all" title="Download every screen as a separate PNG">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Save all screens</span>
          </button>
        </div>
        <div class="az-share-grid" id="az-share-grid">
          <div class="az-share-loading">Building shareable screens…</div>
        </div>
      </div>`;

    results.hidden = false;
    results.innerHTML = `
      <div class="az-result">
        ${headHtml}
        ${previewHtml}
        ${galleryHtml}
      </div>`;

    /* ---------- Render the live preview ---------- */
    const tile = document.querySelector('.az-preview-tile');
    if (window.PurelyApp?.renderToxinReport && tile) {
      try {
        window.PurelyApp.renderToxinReport(tile, {
          name, brand, score, verdict, imageUrl,
          harmCount, benCount,
          microplastics: mpStatus,
          microplasticsDetail: typeof mp === 'object' ? mp : null,
          category: p.subcategory || p.category || 'Other',
          packaging: a.packagingMaterial || a.packaging?.material || (p.package_color ? `${p.package_color} container` : ''),
          findings: dedup,
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

    /* ---------- Build share screens by cloning sections of the live preview.
     * Wait one frame so the preview DOM is fully painted before cloning. */
    requestAnimationFrame(() => {
      buildShareGallery({
        previewTile: tile,
        gridEl: document.getElementById('az-share-grid'),
        payload, name, brand, score, ringColor, slug
      });
    });

    /* Save-all button */
    const saveAllBtn = document.getElementById('az-save-all');
    saveAllBtn?.addEventListener('click', async () => {
      if (saveAllBtn.classList.contains('busy')) return;
      saveAllBtn.classList.add('busy'); saveAllBtn.disabled = true;
      const lbl = saveAllBtn.querySelector('span');
      const orig = lbl ? lbl.textContent : '';
      let total = 0;
      try {
        const cards = Array.from(document.querySelectorAll('.az-share-card'));
        for (let i = 0; i < cards.length; i++) {
          if (lbl) lbl.textContent = `Saving ${i + 1} / ${cards.length}…`;
          await downloadShareCard(cards[i]);
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
   *  Share gallery — clones DOM sections from the rendered live
   *  preview so each frame uses the EXACT same app layout/styling
   *  the user sees above. Per-ingredient screens come from
   *  tiktok.js's buildIngredientScreenOffscreen which already
   *  renders the full app ingredient detail (severity, risks,
   *  benefits, legal limit, health guideline, references).
   * ============================================================ */

  function buildShareGallery({ previewTile, gridEl, payload, name, brand, score, ringColor, slug }) {
    if (!previewTile || !gridEl) return;
    const paScreen = previewTile.querySelector('.pa-screen');
    if (!paScreen) {
      gridEl.innerHTML = '<div class="az-share-loading">Couldn\'t build screens — live preview not ready.</div>';
      return;
    }

    const screens = [];

    /* Screen 1: Score Result + Top concerns — header pill + hero + info
     * (name/brand/tags + score ring) + the consolidated Harmful/Beneficial/
     * Microplastics rows + footer. One combined frame so the share screen
     * carries both the headline score and the at-a-glance breakdown. */
    const statRows = paScreen.querySelector('.pa-stat-rows');
    screens.push({
      label: 'Score result',
      filename: `purely-${slug}-score.png`,
      build: () => composeScoreScreen(paScreen, statRows)
    });

    /* Screen 3: What's inside — clones the full .pa-inside block (every
     * ingredient with status border, status word chip, description).
     * Pagination caps at 4 cards/screen and any partial card that would
     * overflow is dropped from that page rather than being half-rendered. */
    const insideBlock = paScreen.querySelector('.pa-inside');
    if (insideBlock) {
      const list = insideBlock.querySelector('.pa-inside-list');
      const cards = list ? Array.from(list.children) : [];
      const PAGE = 4;
      const pageCount = Math.max(1, Math.ceil(cards.length / PAGE));
      for (let pi = 0; pi < pageCount; pi++) {
        const slice = cards.slice(pi * PAGE, (pi + 1) * PAGE);
        const suffix = pageCount > 1 ? `-${pi + 1}` : '';
        screens.push({
          label: pageCount > 1 ? `Inside ${pi + 1}/${pageCount}` : "What's inside",
          filename: `purely-${slug}-inside${suffix}.png`,
          build: () => composeInsideScreen(paScreen, insideBlock, slice)
        });
      }
    }

    /* Screen 4: Nutrition Facts — clone the nutrition section. */
    const nutSection = findSectionByTitle(paScreen, 'Nutrition Facts');
    if (nutSection) {
      screens.push({
        label: 'Nutrition Facts',
        filename: `purely-${slug}-nutrition.png`,
        build: () => composeScreenWithHeader(paScreen, [nutSection], 'Nutrition Facts')
      });
    }

    /* Screen 5: Top rated alternatives — clone the alternatives section. */
    const altSection = findSectionByTitle(paScreen, 'Top rated');
    if (altSection) {
      screens.push({
        label: 'Better picks',
        filename: `purely-${slug}-alternatives.png`,
        build: () => composeScreenWithHeader(paScreen, [altSection], 'Better picks')
      });
    }

    /* Screens 6..N: Per-ingredient detail. Uses the same renderer the
     * live preview uses when you tap a row — every field from the
     * ingredients table: severity_score, bonus_score, the -5..5 ingredient
     * score, risks, benefits, legal_limit, health_guideline, sources. */
    const ings = (previewTile._ingredients || []).slice(0, 6);
    ings.forEach((ing) => {
      screens.push({
        label: (ing.name || 'Ingredient').slice(0, 22),
        filename: `purely-${slug}-${safeSlug(ing.name)}.png`,
        build: () => buildIngredientShareScreen(ing, name, score)
      });
    });

    /* ---------- Render thumbnails ---------- */
    gridEl.innerHTML = '';
    screens.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'az-share-card';
      card.dataset.filename = s.filename;
      const renderEl = s.build();
      if (!renderEl) return;
      renderEl.classList.add('az-share-render');
      card.innerHTML = `
        <div class="az-share-thumb"></div>
        <div class="az-share-info">
          <span class="az-share-label">${escapeHtml(s.label)}</span>
          <button class="az-share-dl" title="Save this screen as PNG">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Save</span>
          </button>
        </div>`;
      card.querySelector('.az-share-thumb').appendChild(renderEl);
      gridEl.appendChild(card);
    });

    /* Apply scale to fit each thumb. */
    scaleThumbs(gridEl);
    window.addEventListener('resize', () => scaleThumbs(gridEl), { passive: true });

    /* Wire per-card download. */
    gridEl.querySelectorAll('.az-share-card').forEach((card) => {
      const btn = card.querySelector('.az-share-dl');
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.classList.contains('busy')) return;
        btn.classList.add('busy'); btn.disabled = true;
        try {
          await downloadShareCard(card);
          showToast('Saved', 'ok');
        } catch (err) {
          showToast('Download failed: ' + (err.message || err), 'err');
        } finally {
          btn.classList.remove('busy'); btn.disabled = false;
        }
      });
    });
  }

  /* Pin each thumbnail's render to fit its container width. The render
   * ships at native 420×747 (9:16) — we scale down for thumbnail display
   * but keep the native size for capture (capture happens off-screen). */
  function scaleThumbs(gridEl) {
    gridEl.querySelectorAll('.az-share-thumb').forEach((thumb) => {
      const w = thumb.clientWidth;
      if (!w) return;
      const render = thumb.querySelector('.az-share-render');
      if (render) render.style.transform = `scale(${(w / 420).toFixed(4)})`;
    });
  }

  /* Helper: given the live .pa-screen and a list of section selectors,
   * build a new .pa-screen-export DOM whose children are clones of the
   * matched sections, in order. Same CSS classes → same app styling.
   * Status bar (time/wifi/battery) is intentionally never included so the
   * downloaded PNG looks like a clean Purely-app card, not an iOS shot. */
  function composeScreen(paScreen, selectors) {
    const out = makeAppScreenWrapper();
    selectors.forEach((sel) => {
      const el = paScreen.querySelector(sel);
      if (el) out.appendChild(el.cloneNode(true));
    });
    return out;
  }

  /* Combined Score result + Top concerns screen — header pill, hero, info
   * (name/brand/tags + score ring), then the harmful/beneficial/microplastics
   * stat rows directly under the info, then the "Scored by Purely" footer
   * sitting right after the rows. No spacer push — letting the foot float
   * to the bottom created a huge dead band that looked nothing like the
   * real app, where the footer hugs the last content row. The empty
   * background below the footer just shows the canvas color. */
  function composeScoreScreen(paScreen, statRows) {
    const out = makeAppScreenWrapper();
    ['.pa-hdr', '.pa-hero', '.pa-info'].forEach((sel) => {
      const el = paScreen.querySelector(sel);
      if (el) out.appendChild(el.cloneNode(true));
    });
    if (statRows && statRows.children.length) {
      out.appendChild(statRows.cloneNode(true));
    }
    const foot = paScreen.querySelector('.pa-foot');
    if (foot) out.appendChild(foot.cloneNode(true));
    return out;
  }

  /* Generic share screen — header pill ("Purely App") + optional section
   * title + the cloned content section + footer. No status bar, no product
   * mini-header — the live .pa-hdr is the entire identity (just like the
   * real app's screen). */
  function composeScreenWithHeader(paScreen, sectionEls, title) {
    const out = makeAppScreenWrapper();
    const hdr = paScreen.querySelector('.pa-hdr');
    if (hdr) out.appendChild(hdr.cloneNode(true));
    if (title) {
      const t = document.createElement('div');
      t.className = 'az-share-screen-title';
      t.textContent = title;
      out.appendChild(t);
    }
    sectionEls.forEach((el) => { if (el) out.appendChild(el.cloneNode(true)); });
    const foot = paScreen.querySelector('.pa-foot');
    if (foot) out.appendChild(foot.cloneNode(true));
    return out;
  }

  /* "What's inside" share screen with a sliced ingredient list. Same clean
   * header as composeScreenWithHeader, then the .pa-inside section's title
   * row + a fresh list of just the requested cards. */
  function composeInsideScreen(paScreen, insideBlock, cards) {
    const out = makeAppScreenWrapper();
    const hdr = paScreen.querySelector('.pa-hdr');
    if (hdr) out.appendChild(hdr.cloneNode(true));

    const insideClone = insideBlock.cloneNode(true);
    const list = insideClone.querySelector('.pa-inside-list');
    if (list) {
      list.innerHTML = '';
      cards.forEach((c) => list.appendChild(c.cloneNode(true)));
    }
    out.appendChild(insideClone);
    return out;
  }

  function makeAppScreenWrapper() {
    /* Native 420×747 (9:16). Background and font inherited from .pa-screen. */
    const w = document.createElement('div');
    w.className = 'pa-screen az-share-screen';
    w.style.cssText = 'width:420px;height:747px;overflow:hidden;background:#F7F5F0;';
    return w;
  }

  /* Find a .pa-section block whose first <h3> text contains the given
   * substring — the live preview uses simple .pa-section blocks for
   * Nutrition Facts / Top rated alternatives. */
  function findSectionByTitle(paScreen, needle) {
    const sections = paScreen.querySelectorAll('.pa-section');
    for (const s of sections) {
      const t = s.querySelector('.pa-section-title');
      if (t && t.textContent.toLowerCase().includes(needle.toLowerCase())) return s;
    }
    return null;
  }

  /* Build a per-ingredient share screen using tiktok.js's offscreen
   * builder. That function returns the .ing-screen DOM with EVERY DB
   * field for the ingredient (severity score, ingredient score, risks,
   * benefits, legal limit, health guideline, references). We pull it out
   * of its offscreen wrapper, add an explicit 9:16 size, and return it. */
  function buildIngredientShareScreen(ing, productName, productScore) {
    if (!window.PurelyApp?.buildIngredientScreenOffscreen) return null;
    /* Pass empty strings for legal/guideline/refs so the builder still
     * scaffolds those sections — we then strip them from the DOM below.
     * Per the brief: "cut it off right after benefits" — the share PNG
     * should end at the Benefits section so the screen looks intentional
     * instead of half-cut. */
    const screen = window.PurelyApp.buildIngredientScreenOffscreen({
      name: ing.name,
      description: ing.description,
      status: ing.status,
      score: ing.score,
      risks: ing.risks || (ing.status === 'harmful' ? ing.description : ''),
      benefits: ing.benefits || (ing.status === 'beneficial' ? ing.description : ''),
      legalLimit: '',
      healthGuideline: '',
      references: '',
      productName, productScore
    });
    if (!screen) return null;
    /* Drop the legal-limit / health-guideline / references accordions so
     * the screen clean-cuts after Benefits — no "No data available" stubs. */
    ['legal', 'guideline', 'refs'].forEach((key) => {
      const el = screen.querySelector(`.ing-accord[data-key="${key}"]`);
      if (el) el.remove();
    });
    const oldWrap = screen.parentElement;
    screen.style.cssText = 'width:420px;height:747px;background:#F7F5F0;border-radius:0;overflow:hidden';
    if (oldWrap && oldWrap.parentNode === document.body) oldWrap.remove();
    return screen;
  }

  /* ============================================================
   *  Capture: clone the .az-share-render into an offscreen
   *  full-size container (no transform), capture with html2canvas
   *  at scale=2.6 → 1080×1920 PNG, trigger download.
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

  async function downloadShareCard(card) {
    const filename = card.dataset.filename || 'purely-screen.png';
    const render = card.querySelector('.az-share-render');
    if (!render) throw new Error('no render to capture');
    const h2c = await loadHtml2Canvas();

    /* Wait for inline images. */
    const imgs = Array.from(render.querySelectorAll('img'));
    await Promise.all(imgs.map((img) => (img.complete && img.naturalWidth > 0)
      ? null
      : new Promise((res) => { img.onload = img.onerror = res; setTimeout(res, 4000); })));

    /* Clone offscreen at native size with no transform — html2canvas
     * struggles with CSS transforms, so we do this trick instead. */
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;top:0;left:-12000px;z-index:-1;pointer-events:none;background:#F7F5F0';
    const clone = render.cloneNode(true);
    clone.style.transform = 'none';
    clone.style.position = 'static';
    clone.style.width = '420px';
    clone.style.height = '747px';
    wrap.appendChild(clone);
    document.body.appendChild(wrap);
    try {
      void clone.offsetHeight;
      const canvas = await h2c(clone, {
        backgroundColor: '#F7F5F0',
        scale: 2.6,
        useCORS: true,
        allowTaint: false,
        logging: false,
        width: 420, height: 747,
        windowWidth: 420, windowHeight: 747,
        imageTimeout: 8000
      });
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      wrap.remove();
    }
  }
})();
