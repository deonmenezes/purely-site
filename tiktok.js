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

  async function analyze() {
    hideError();
    const url = urlInput.value.trim();
    if (!url) return;
    if (!/tiktok\.com/i.test(url)) {
      showError('That doesn\'t look like a TikTok URL.');
      return;
    }

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

    // Generate images
    const products = payload.analysis?.products || [];
    if (products.length === 0) {
      setStep('images', 'done');
      setProgress(100, '<strong>Done</strong> — no specific products mentioned in this reel');
      goBtn.disabled = false; goBtn.classList.remove('busy');
      return;
    }
    const screens = ['scan', 'analysis', 'ingredients'];
    const total = products.length * screens.length;
    let done = 0;

    await Promise.all(products.flatMap((p, productIdx) =>
      screens.map(async (screen) => {
        try {
          const r = await fetch('/api/tiktok-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tiktokId: payload.tiktok.id, productIdx, screen, refresh: forceRefresh })
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || 'image failed');
          updateMockup(productIdx, screen, j.url);
        } catch (e) {
          updateMockup(productIdx, screen, null, e.message);
        } finally {
          done++;
          const pct = 60 + Math.round((done / total) * 40);
          setProgress(pct, `<strong>${done}/${total}</strong> mockups generated`);
        }
      })
    ));

    setStep('images', 'done');
    setProgress(100, '<strong>All done.</strong>');
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

  function renderProduct(p, idx) {
    const verdictClass = /good/i.test(p.verdict || '') ? '' : /watch/i.test(p.verdict || '') ? 'warn' : /avoid/i.test(p.verdict || '') ? 'bad' : '';
    const score = Number.isFinite(p.score) ? p.score : 80;
    const dashOff = 151 - (score / 100) * 151;
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
                <circle cx="30" cy="30" r="24" stroke="#e8f0ea" stroke-width="5" fill="none"/>
                <circle cx="30" cy="30" r="24" stroke="#4ea96b" stroke-width="5" fill="none" stroke-linecap="round" stroke-dasharray="151" stroke-dashoffset="${dashOff}" transform="rotate(-90 30 30)"/>
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
            ${['scan', 'analysis', 'ingredients'].map((s) => `
              <div class="mockup" data-product="${idx}" data-screen="${s}">
                <span class="mockup-label">${s === 'scan' ? 'Scan Product' : s === 'analysis' ? 'Analysis Report' : 'Ingredients'}</span>
                <div class="skel"></div>
              </div>
            `).join('')}
          </div>
        </div>
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
      img.loading = 'lazy';
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

  async function regenAll(tiktokId, productIdx, btn) {
    btn.classList.add('busy'); btn.disabled = true;
    ['scan', 'analysis', 'ingredients'].forEach((s) => {
      const tile = document.querySelector(`.mockup[data-product="${productIdx}"][data-screen="${s}"]`);
      if (!tile) return;
      tile.innerHTML = `<span class="mockup-label">${s === 'scan' ? 'Scan Product' : s === 'analysis' ? 'Analysis Report' : 'Ingredients'}</span><div class="skel"></div>`;
    });
    await Promise.all(['scan', 'analysis', 'ingredients'].map(async (screen) => {
      try {
        const r = await fetch('/api/tiktok-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tiktokId, productIdx, screen, refresh: true })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'image failed');
        updateMockup(productIdx, screen, j.url);
      } catch (e) {
        updateMockup(productIdx, screen, null, e.message);
      }
    }));
    btn.classList.remove('busy'); btn.disabled = false;
  }
})();
