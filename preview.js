/**
 * Site-preview gallery: renders one card per page on the site, each with a
 * thum.io-generated thumbnail and a Download PNG button. The download path
 * fetches the PNG via blob so it actually saves to the user's disk instead
 * of opening in a new tab (which would happen with a plain <a download> on
 * a cross-origin URL without Content-Disposition).
 */
(() => {
  const SITE = window.location.origin || 'https://purely-site.vercel.app';
  const THUMB_W = 800;          // grid thumb resolution
  const FULL_W = 1920;          // download resolution
  const WAIT_S = 4;             // thum.io render wait — gives JS time to render
  const VP_W = 1440, VP_H = 900;

  // Each page gets its own card. `path` is the route on the site, `viewport`
  // determines what the screenshot service captures.
  const PAGES = [
    {
      key: 'home',
      name: 'Home',
      path: '/',
      desc: 'Hero, ingredient scanner pitch, app-store CTA, trust bar, FAQ, footer.'
    },
    {
      key: 'features',
      name: 'How It Works',
      path: '/#how',
      desc: '3-step flow: scan → analyze → choose better. Screenshot anchored to the section.'
    },
    {
      key: 'know',
      name: 'Know Your Ingredients',
      path: '/#features',
      desc: 'Feature highlight section with strawberry yogurt iPhone mockup.'
    },
    {
      key: 'about',
      name: 'About',
      path: '/#about',
      desc: 'Why Purely exists — backed by science, private by design, always learning.'
    },
    {
      key: 'faq',
      name: 'FAQ',
      path: '/#faq',
      desc: 'Pricing, accuracy, supported products, privacy, devices.'
    },
    {
      key: 'ideas',
      name: 'Content Ideas',
      path: '/ideas',
      desc: 'TikTok content idea grid with transcripts, hooks, suggested captions.'
    },
    {
      key: 'tiktok',
      name: 'TikTok AI Analyzer',
      path: '/tiktok',
      desc: 'Paste any TikTok or upload a product photo — get the Purely DB result.'
    },
    {
      key: 'influencer',
      name: 'Influencers',
      path: '/influencer',
      desc: 'Community uploads gallery — screen recordings + screenshots, drag/drop.'
    },
    {
      key: 'preview',
      name: 'Site Preview',
      path: '/preview',
      desc: 'This page — every page screenshotted and downloadable.'
    }
  ];

  const row = document.getElementById('ss-row');
  const toast = document.getElementById('toast');

  function showToast(msg, type = '') {
    toast.textContent = msg;
    toast.className = 'toast show ' + type;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => (toast.hidden = true), 250);
    }, 2800);
  }

  // thum.io URL format. /get/width/<w>/png/wait/<s>/viewportWidth/<vw>/viewportHeight/<vh>/<url>
  function thumbUrl(path, width) {
    const target = SITE + path;
    return `https://image.thum.io/get/width/${width}/png/wait/${WAIT_S}/viewportWidth/${VP_W}/viewportHeight/${VP_H}/${target}`;
  }

  async function downloadPng(path, name) {
    try {
      const res = await fetch(thumbUrl(path, FULL_W), { cache: 'no-store' });
      if (!res.ok) throw new Error('Screenshot service returned ' + res.status);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1500);
      showToast(name + ' saved', 'ok');
    } catch (e) {
      showToast('Download failed — ' + (e.message || 'try again'), 'err');
    }
  }

  function makeCard(p) {
    const card = document.createElement('article');
    card.className = 'ss-card';
    card.dataset.key = p.key;
    card.innerHTML = `
      <a href="${p.path}" class="ss-thumb" target="_blank" rel="noopener" title="Open ${p.name} in new tab">
        <div class="ss-thumb-spinner">Capturing</div>
        <img class="loading" alt="${p.name} screenshot" loading="lazy" src="${thumbUrl(p.path, THUMB_W)}">
      </a>
      <div class="ss-meta">
        <span class="ss-name">${p.name}</span>
        <span class="ss-path">${p.path}</span>
      </div>
      <p class="ss-desc">${p.desc}</p>
      <div class="ss-actions">
        <button class="ss-btn primary" data-action="download" data-path="${p.path}" data-name="purely-${p.key}.png">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Download PNG
        </button>
        <a class="ss-btn secondary" href="${p.path}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Open page
        </a>
      </div>
    `;

    const img = card.querySelector('img');
    const spinner = card.querySelector('.ss-thumb-spinner');
    img.addEventListener('load', () => {
      img.classList.remove('loading');
      spinner.classList.add('hidden');
    });
    img.addEventListener('error', () => {
      spinner.textContent = 'Preview unavailable';
    });

    card.querySelector('[data-action="download"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('busy');
      const lbl = btn.innerHTML;
      btn.innerHTML = 'Capturing…';
      try {
        await downloadPng(btn.dataset.path, btn.dataset.name);
      } finally {
        btn.classList.remove('busy');
        btn.innerHTML = lbl;
      }
    });

    return card;
  }

  PAGES.forEach((p) => row.appendChild(makeCard(p)));
})();
