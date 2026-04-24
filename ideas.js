(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const grid = $('#ideas-grid');
  const detail = $('#ideas-detail');
  const statusMsg = $('#status-msg');
  const toast = $('#toast');
  const backBtn = $('#back-grid');
  const refreshBtn = $('#refresh-ideas');
  const filterTag = $('#filter-tag');
  const filterKind = $('#filter-kind');
  const filterSort = $('#filter-sort');

  let all = [];
  let filtered = [];
  let currentId = null;

  /* ---------- helpers ---------- */
  function showToast(msg, type = '') {
    toast.textContent = msg;
    toast.className = 'toast show ' + type;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => (toast.hidden = true), 250);
    }, 3200);
  }
  function fmtCount(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function fmtDur(sec) {
    if (!sec) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function copy(text) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied to clipboard', 'ok'),
      () => showToast('Copy failed', 'err')
    );
  }

  const verifiedSvg = `<svg class="ic-verified" viewBox="0 0 24 24"><path d="M12 2l2.39 1.73 2.93-.29.88 2.82 2.46 1.6-.91 2.81.91 2.81-2.46 1.6-.88 2.82-2.93-.29L12 22l-2.39-1.73-2.93.29-.88-2.82-2.46-1.6.91-2.81-.91-2.81 2.46-1.6.88-2.82 2.93.29L12 2z" fill="#4aa7f0"/><path d="M8.5 12.5l2.5 2.5 5-5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  /* ---------- Fetch ---------- */
  async function load() {
    statusMsg.hidden = false;
    statusMsg.className = 'status-msg loading';
    statusMsg.textContent = 'Loading content ideas…';
    try {
      const res = await fetch('/api/ideas?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();
      all = data.ideas || [];
      if (all.length === 0) {
        statusMsg.className = 'status-msg';
        statusMsg.innerHTML = 'No ideas yet. Click <strong>Refresh from TikTok</strong> to pull the latest from @oasis.app.';
        return;
      }
      statusMsg.hidden = true;
      populateTagFilter();
      applyFilters();
    } catch (e) {
      statusMsg.className = 'status-msg';
      statusMsg.textContent = 'Couldn\'t load ideas: ' + e.message;
    }
  }

  function populateTagFilter() {
    const tagCounts = new Map();
    all.forEach((i) => (i.tags || []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
    const sorted = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]);
    filterTag.innerHTML = `<option value="">All Content (${all.length})</option>` +
      sorted.map(([t, c]) => `<option value="${escapeHtml(t)}">${escapeHtml(t)} (${c})</option>`).join('');
  }

  function applyFilters() {
    const tag = filterTag.value;
    const kind = filterKind.value;
    const sort = filterSort.value;
    filtered = all.filter((i) => {
      if (tag && !(i.tags || []).includes(tag)) return false;
      const d = i.duration || 0;
      if (kind === 'long' && d <= 30) return false;
      if (kind === 'short' && d > 30) return false;
      return true;
    });
    filtered.sort((a, b) => {
      if (sort === 'views') return (b.stats?.plays || 0) - (a.stats?.plays || 0);
      if (sort === 'likes') return (b.stats?.likes || 0) - (a.stats?.likes || 0);
      if (sort === 'score') return (b.score || 0) - (a.score || 0);
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    renderGrid();
  }

  /* ---------- Grid render ---------- */
  function renderGrid() {
    detail.hidden = true;
    grid.hidden = false;
    backBtn.hidden = true;
    currentId = null;
    if (filtered.length === 0) {
      grid.innerHTML = `<div class="status-msg" style="grid-column:1/-1">No ideas match your filters.</div>`;
      return;
    }
    grid.innerHTML = filtered.map((i) => `
      <article class="idea-card" data-id="${escapeHtml(i.id)}">
        <div class="ic-media">
          ${i.cover ? `<img src="/api/img?u=${encodeURIComponent(i.cover)}" alt="" loading="lazy" />` : `<div style="width:100%;height:100%;background:#eaf5ed"></div>`}
          <span class="ic-score">${i.score || 80}/100</span>
          <span class="ic-dur">${fmtDur(i.duration)}</span>
          <div class="ic-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l12 7-12 7V5z"/></svg></div>
        </div>
        <div class="ic-body">
          <div class="ic-author">
            ${i.author?.avatar ? `<img src="/api/img?u=${encodeURIComponent(i.author.avatar)}" alt="" />` : `<span style="width:26px;height:26px;border-radius:50%;background:#eaf5ed;display:inline-block"></span>`}
            <span class="ic-author-name">${escapeHtml(i.author?.nickname || i.author?.name || 'oasis.app')}${i.author?.verified ? verifiedSvg : ''}</span>
          </div>
          <div class="ic-caption">${escapeHtml(i.caption || '')}</div>
          <div class="ic-stats">
            <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 8 1 12c1.7 4 6 7.5 11 7.5s9.3-3.5 11-7.5c-1.7-4-6-7.5-11-7.5zm0 12a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>${fmtCount(i.stats?.plays)}</span>
            <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.7-7-10a4.5 4.5 0 0 1 8-3 4.5 4.5 0 0 1 8 3c0 5.3-7 10-7 10h-2z"/></svg>${fmtCount(i.stats?.likes)}</span>
            <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12a9 9 0 1 1-5-8l-3 1 1 3a6 6 0 1 0 4 7l2 1a9 9 0 0 0 1-4z"/></svg>${fmtCount(i.stats?.comments)}</span>
          </div>
          <div class="ic-tags">${(i.tags || []).slice(0, 3).map((t) => `<span class="ic-tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>
      </article>
    `).join('');
    grid.querySelectorAll('.idea-card').forEach((card) => {
      card.addEventListener('click', () => openDetail(card.dataset.id));
    });
  }

  /* ---------- Detail ---------- */
  function openDetail(id) {
    const i = all.find((x) => String(x.id) === String(id));
    if (!i) return;
    currentId = id;
    grid.hidden = true;
    detail.hidden = false;
    backBtn.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const transcript = i.transcript || [];
    const transcriptHtml = transcript.length
      ? transcript.map((t, idx) => `
          <div class="t-row" data-idx="${idx}" data-time="${t.time}">
            <div class="t-time">${String(Math.floor(t.time / 60)).padStart(2, '0')}:${String(Math.floor(t.time % 60)).padStart(2, '0')}</div>
            <div class="t-text">${escapeHtml(t.text)}</div>
          </div>
        `).join('')
      : `<div style="color:var(--ink-3);font-size:13px;text-align:center;padding:16px">No auto-transcript was available for this reel.</div>`;

    detail.innerHTML = `
      <div class="dt-left">
        <div class="dt-card">
          <div class="dt-media">
            <div class="dt-overlay-author">
              ${i.author?.avatar ? `<img src="/api/img?u=${encodeURIComponent(i.author.avatar)}" alt="" />` : ''}
              <div>
                <div class="handle">${escapeHtml(i.author?.nickname || i.author?.name || 'oasis.app')}${i.author?.verified ? verifiedSvg : ''}</div>
                <div class="audio">Original audio</div>
              </div>
              <button style="margin-left:auto;background:none;border:0;color:#fff;font-size:22px;cursor:pointer" title="More">⋯</button>
            </div>
            ${i.videoUrl
              ? `<video id="dt-video" src="${escapeHtml(i.videoUrl)}" controls playsinline preload="metadata" poster="${i.cover ? '/api/img?u=' + encodeURIComponent(i.cover) : ''}"></video>`
              : i.cover ? `<img src="/api/img?u=${encodeURIComponent(i.cover)}" alt="" />` : ''}
            <div class="dt-side-stats">
              <div><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.7-7-10a4.5 4.5 0 0 1 8-3 4.5 4.5 0 0 1 8 3c0 5.3-7 10-7 10h-2z"/></svg>${fmtCount(i.stats?.likes)}</div>
              <div><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12a9 9 0 1 1-5-8l-3 1 1 3a6 6 0 1 0 4 7l2 1a9 9 0 0 0 1-4z"/></svg>${fmtCount(i.stats?.comments)}</div>
              <div><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18l7-5 7 5V3z"/></svg>${fmtCount(i.stats?.saves)}</div>
              <div><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 12h13l-4-4m4 4l-4 4"/><path d="M4 12h13l-4-4m4 4l-4 4" stroke="currentColor" stroke-width="2" fill="none"/></svg>${fmtCount(i.stats?.shares)}</div>
            </div>
          </div>
          <div class="dt-footer">
            <div class="item">
              <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6"/></svg>
              <div><strong>${fmtDate(i.createdAt)}</strong><span>Posted</span></div>
            </div>
            <div class="item">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 7v5l3 3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
              <div><strong>${fmtDur(i.duration)}</strong><span>Duration</span></div>
            </div>
            <div class="dt-score-ring">
              <svg viewBox="0 0 60 60">
                <circle cx="30" cy="30" r="24" stroke="#e8f0ea" stroke-width="5" fill="none"/>
                <circle cx="30" cy="30" r="24" stroke="#4ea96b" stroke-width="5" fill="none" stroke-linecap="round"
                  stroke-dasharray="151" stroke-dashoffset="${151 - ((i.score || 80) / 100) * 151}" transform="rotate(-90 30 30)"/>
              </svg>
              <span>${i.score || 80}/100</span>
            </div>
          </div>
        </div>
      </div>
      <div class="dt-right">
        <div class="dt-panel">
          <div class="dt-panel-hd">
            <h3>
              <span class="icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zM4 11h16v2H4zM4 16h10v2H4z"/></svg></span>
              Transcript & Reel Idea
            </h3>
            <div class="dt-actions">
              <button class="btn-chip" id="copy-script"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M4 16V6a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>Copy Script</button>
              <button class="btn-chip" id="open-tiktok"><svg viewBox="0 0 24 24"><path d="M14 3h3a5 5 0 0 0 5 5M9 13a4 4 0 1 0 4 4V3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>Open on TikTok</button>
            </div>
          </div>
          <div class="transcript">${transcriptHtml}</div>
          <div class="transcript-footer">AI-assisted transcript. Please review for accuracy.</div>
        </div>

        <div class="dt-panel">
          <div class="insight-list">
            <div class="insight-item">
              <div class="insight-ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg></div>
              <div>
                <h4>Hook</h4>
                <p>${escapeHtml(i.hook || '')}</p>
              </div>
            </div>
            <div class="insight-item">
              <div class="insight-ico"><svg viewBox="0 0 24 24"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 13v3h8v-3a7 7 0 0 0-4-13z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg></div>
              <div>
                <h4>Reel Idea</h4>
                <p>${escapeHtml(i.reelIdea || '')}</p>
              </div>
            </div>
            <div class="insight-item">
              <div class="insight-ico"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg></div>
              <div>
                <h4>Talking Points</h4>
                <ul>${(i.talkingPoints || []).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
              </div>
            </div>
            <div class="insight-item">
              <div class="insight-ico"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
              <div>
                <h4>Steps</h4>
                <ol>${(i.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
              </div>
            </div>
          </div>
        </div>

        <div class="dt-bottom">
          <div class="dt-panel caption-panel">
            <div class="dt-panel-hd">
              <h3><span class="icon"><svg viewBox="0 0 24 24"><path d="M4 4h16v12H5l-1 4V4z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg></span>Suggested Caption</h3>
              <button class="btn-chip" id="edit-caption"><svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16v4z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg></button>
            </div>
            <p id="sc-text">${escapeHtml(i.suggestedCaption || '')}</p>
            <div class="c-footer">
              <button class="btn-chip" id="copy-caption"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M4 16V6a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>Copy</button>
            </div>
          </div>

          <div class="dt-panel tags-panel">
            <div class="dt-panel-hd">
              <h3><span class="icon"><svg viewBox="0 0 24 24"><path d="M20 12L12 4H4v8l8 8 8-8z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg></span>Content Tags</h3>
            </div>
            <div class="tags-list" id="tags-list">
              ${(i.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}<button data-tag="${escapeHtml(t)}" title="Remove">×</button></span>`).join('')}
              <button class="add-tag" id="add-tag">+ Add Tag</button>
            </div>
          </div>
        </div>
      </div>
    `;

    /* detail interactions */
    const video = detail.querySelector('#dt-video');
    if (video) {
      const rows = detail.querySelectorAll('.t-row');
      video.addEventListener('timeupdate', () => {
        const t = video.currentTime;
        let active = -1;
        transcript.forEach((item, idx) => { if (item.time <= t) active = idx; });
        rows.forEach((r, idx) => r.classList.toggle('active', idx === active));
      });
      rows.forEach((r) => r.addEventListener('click', () => {
        video.currentTime = Number(r.dataset.time) || 0;
        video.play().catch(() => {});
      }));
    }

    detail.querySelector('#copy-script')?.addEventListener('click', () => {
      const full = transcript.map((t) => t.text).join(' ');
      copy(full || i.caption || '');
    });
    detail.querySelector('#copy-caption')?.addEventListener('click', () => copy(i.suggestedCaption || ''));
    detail.querySelector('#open-tiktok')?.addEventListener('click', () => {
      if (i.url) window.open(i.url, '_blank', 'noopener');
    });
    detail.querySelector('#edit-caption')?.addEventListener('click', () => {
      const el = detail.querySelector('#sc-text');
      el.contentEditable = 'true';
      el.focus();
      el.style.outline = '2px solid #7cc892';
      el.style.borderRadius = '8px';
      el.style.padding = '6px';
      el.addEventListener('blur', () => {
        el.contentEditable = 'false';
        el.style.outline = ''; el.style.padding = '';
      }, { once: true });
    });

    // Tag interactions
    const tagsList = detail.querySelector('#tags-list');
    tagsList.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('.tag').remove());
    });
    detail.querySelector('#add-tag').addEventListener('click', () => {
      const v = prompt('New tag');
      if (!v) return;
      const el = document.createElement('span');
      el.className = 'tag';
      el.innerHTML = `${escapeHtml(v)}<button title="Remove">×</button>`;
      el.querySelector('button').addEventListener('click', () => el.remove());
      tagsList.insertBefore(el, detail.querySelector('#add-tag'));
    });
  }

  backBtn.addEventListener('click', renderGrid);
  filterTag.addEventListener('change', applyFilters);
  filterKind.addEventListener('change', applyFilters);
  filterSort.addEventListener('change', applyFilters);

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    try {
      const res = await fetch('/api/refresh-ideas', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Scrape failed');
      showToast('Refresh started — new ideas will appear shortly.', 'ok');
    } catch (e) {
      showToast('Refresh error: ' + e.message, 'err');
    } finally {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  });

  load();
})();
