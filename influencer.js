import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const SUPABASE_URL = 'https://ewjwgsrockzgcmpdzyai.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3andnc3JvY2t6Z2NtcGR6eWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3ODA4MzcsImV4cCI6MjA5MjM1NjgzN30.pQwDjOT3TXXiRaNE5qE-oxpc7VdDnU3J-hEkimTOhzI';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
const BUCKET = 'influencer-uploads';
const MAX_SIZE = 50 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpe?g|webp|gif)|video\/(mp4|quicktime|webm))$/;

/* ---------- DOM ---------- */
const $ = (s) => document.querySelector(s);
const fileInput = $('#file-input');
const pickBtn = $('#pick-btn');
const queue = $('#queue');
const submitBtn = $('#submit-btn');
const sbCount = $('#sb-count');
const toast = $('#toast');
const recentGrid = $('#recent-grid');
const videoGrid = $('#video-grid');
const shotGrid = $('#shot-grid');
const lightbox = $('#lightbox');
const lbBody = $('#lb-body');
const refreshBtn = $('#refresh-btn');

/* ---------- State ---------- */
let files = []; // { file, id, progress, state: 'pending'|'uploading'|'done'|'err', error }

/* ---------- Helpers ---------- */
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
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
function timeAgo(iso) {
  if (!iso) return '';
  const t = Date.now() - new Date(iso).getTime();
  const m = Math.round(t / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
function updateSubmit() {
  const pending = files.filter((f) => f.state === 'pending').length;
  submitBtn.disabled = pending === 0;
  sbCount.textContent = pending > 0 ? `(${pending})` : '';
}

/* ---------- Queue rendering ---------- */
function renderQueue() {
  if (files.length === 0) {
    queue.hidden = true;
    queue.innerHTML = '';
    updateSubmit();
    return;
  }
  queue.hidden = false;
  queue.innerHTML = '';
  files.forEach((f) => {
    const item = document.createElement('div');
    item.className = 'q-item';
    const isVideo = f.file.type.startsWith('video/');
    const thumb = document.createElement('div');
    thumb.className = 'q-thumb';
    if (isVideo) {
      thumb.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5l12 7-12 7V5z" fill="currentColor"/></svg>`;
    } else {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f.file);
      thumb.appendChild(img);
    }

    const meta = document.createElement('div');
    meta.className = 'q-meta';
    meta.innerHTML = `
      <div class="q-name">${f.file.name}</div>
      <div class="q-size">${fmtSize(f.file.size)} · ${isVideo ? 'video' : 'image'}</div>
      <div class="q-prog"><div class="q-bar" style="width:${f.progress || 0}%"></div></div>
    `;

    const state = document.createElement('div');
    state.className = 'q-state ' + (f.state === 'done' ? 'ok' : f.state === 'err' ? 'err' : '');
    state.textContent =
      f.state === 'uploading' ? `${f.progress}%` :
      f.state === 'done' ? 'Uploaded' :
      f.state === 'err' ? (f.error || 'Failed') : 'Ready';

    item.appendChild(thumb);
    item.appendChild(meta);
    item.appendChild(state);

    if (f.state === 'pending' || f.state === 'err') {
      const rm = document.createElement('button');
      rm.className = 'q-remove';
      rm.innerHTML = '×';
      rm.title = 'Remove';
      rm.onclick = () => {
        files = files.filter((x) => x.id !== f.id);
        renderQueue();
      };
      item.appendChild(rm);
    }
    queue.appendChild(item);
  });
  updateSubmit();
}

/* ---------- File intake ---------- */
function addFiles(list) {
  const arr = Array.from(list);
  for (const file of arr) {
    if (!ALLOWED.test(file.type)) {
      showToast(`"${file.name}" type not supported`, 'err');
      continue;
    }
    if (file.size > MAX_SIZE) {
      showToast(`"${file.name}" is over 50MB`, 'err');
      continue;
    }
    files.push({
      file, id: Math.random().toString(36).slice(2), progress: 0, state: 'pending'
    });
  }
  renderQueue();
}

pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  addFiles(e.target.files);
  fileInput.value = '';
});

// Page-level drag/drop
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragCounter++;
  document.body.classList.add('drag-over');
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) document.body.classList.remove('drag-over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.body.classList.remove('drag-over');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* ---------- Upload ---------- */
async function uploadOne(entry) {
  entry.state = 'uploading';
  entry.progress = 0;
  renderQueue();

  // 1) Get signed upload URL
  const handle = $('#u-handle').value.trim().replace(/^@/, '');
  const signRes = await fetch('/api/sign-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: entry.file.name,
      contentType: entry.file.type,
      size: entry.file.size,
      handle
    })
  });
  if (!signRes.ok) {
    const err = await signRes.json().catch(() => ({}));
    throw new Error(err.error || 'Could not get upload URL');
  }
  const sign = await signRes.json();

  // 2) Upload with XHR for progress
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sign.signedUrl, true);
    xhr.setRequestHeader('Content-Type', entry.file.type);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        entry.progress = Math.round((e.loaded / e.total) * 100);
        renderQueue();
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('Upload failed (' + xhr.status + ')'));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(entry.file);
  });

  entry.state = 'done';
  entry.progress = 100;
  entry.publicUrl = sign.publicUrl;
  entry.folder = sign.folder;
  renderQueue();
}

submitBtn.addEventListener('click', async () => {
  const name = $('#u-name').value.trim();
  if (!name) {
    showToast('Please enter your name first', 'err');
    $('#u-name').focus();
    return;
  }
  const pending = files.filter((f) => f.state === 'pending');
  if (pending.length === 0) return;

  submitBtn.classList.add('uploading');
  submitBtn.disabled = true;
  let ok = 0, fail = 0;

  for (const entry of pending) {
    try {
      await uploadOne(entry);
      ok++;
    } catch (e) {
      entry.state = 'err';
      entry.error = e.message || 'Failed';
      fail++;
      renderQueue();
    }
  }

  submitBtn.classList.remove('uploading');
  updateSubmit();

  if (ok > 0) {
    showToast(`${ok} upload${ok === 1 ? '' : 's'} live 🎉`, 'ok');
    setTimeout(() => {
      files = files.filter((f) => f.state !== 'done');
      renderQueue();
    }, 1500);
    loadGallery();
  }
  if (fail > 0 && ok === 0) showToast('Upload failed. Try again.', 'err');
});

/* ---------- Gallery ---------- */
async function loadGallery() {
  refreshBtn.classList.add('spinning');
  try {
    const res = await fetch('/api/list', { cache: 'no-store' });
    const data = await res.json();
    renderRecent(data.recent || []);
    renderVideos(data.videos || []);
    renderShots(data.screenshots || []);
  } catch (e) {
    recentGrid.innerHTML = `<div class="loader-card">Couldn't load uploads.</div>`;
  } finally {
    setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
  }
}

function openLightbox(item) {
  const isVideo = item.folder === 'videos' || /^video\//.test(item.type || '');
  const media = isVideo
    ? `<video src="${item.url}" controls autoplay playsinline></video>`
    : `<img src="${item.url}" alt="" />`;
  lbBody.innerHTML = `
    ${media}
    <button class="lb-download" id="lb-dl" title="Download">
      ${downloadSvg}<span>Download</span>
    </button>
  `;
  lightbox.hidden = false;
  const dl = document.getElementById('lb-dl');
  if (dl) {
    dl.addEventListener('click', (e) => {
      e.stopPropagation();
      dl.classList.add('busy');
      downloadFile(item.url, item.name).finally(() => dl.classList.remove('busy'));
    });
  }
}
$('#lb-close').addEventListener('click', () => {
  lightbox.hidden = true; lbBody.innerHTML = '';
});
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) { lightbox.hidden = true; lbBody.innerHTML = ''; }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.hidden) {
    lightbox.hidden = true; lbBody.innerHTML = '';
  }
});

const downloadSvg = `<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

async function downloadFile(url, filename) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename || 'purely-upload';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch (e) {
    // fallback: direct link in new tab
    window.open(url, '_blank', 'noopener');
  }
}

function wireDownload(card, url, name) {
  const btn = card.querySelector('.dl-btn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    btn.classList.add('busy');
    downloadFile(url, name).finally(() => btn.classList.remove('busy'));
  });
}

function renderRecent(items) {
  if (items.length === 0) {
    recentGrid.innerHTML = `<div class="loader-card">No uploads yet. Be the first!</div>`;
    return;
  }
  recentGrid.innerHTML = '';
  items.forEach((i) => {
    const card = document.createElement('div');
    card.className = 'recent-card';
    const isVideo = i.folder === 'videos';
    card.innerHTML = `
      <div class="rc-media">
        <span class="rc-type">${isVideo ? 'Video' : 'Photo'}</span>
        <button class="dl-btn" title="Download">${downloadSvg}</button>
        ${isVideo
          ? `<video src="${i.url}" muted playsinline preload="metadata"></video>
             <div class="rc-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l12 7-12 7V5z"/></svg></div>`
          : `<img src="${i.url}" alt="" loading="lazy" />`}
      </div>
      <div class="rc-meta">
        <div class="rc-name">${niceName(i.name)}</div>
        <div class="rc-time">${timeAgo(i.createdAt)}</div>
      </div>
    `;
    card.onclick = () => {
      if (isVideo) {
        openLightbox(i);
      } else {
        openLightbox(i);
      }
    };
    wireDownload(card, i.url, i.name);
    recentGrid.appendChild(card);
  });
}

function renderVideos(items) {
  if (items.length === 0) {
    videoGrid.innerHTML = `<div class="empty-state">No videos yet. Be the first to share!</div>`;
    return;
  }
  videoGrid.innerHTML = '';
  items.forEach((i) => {
    const card = document.createElement('div');
    card.className = 'v-card';
    card.innerHTML = `
      <div class="v-media">
        <button class="dl-btn" title="Download">${downloadSvg}</button>
        <video src="${i.url}" muted playsinline preload="metadata"></video>
        <div class="rc-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l12 7-12 7V5z"/></svg></div>
      </div>
      <div class="v-meta">
        <strong>${niceName(i.name)}</strong>
        <span>${timeAgo(i.createdAt)} · ${fmtSize(i.size)}</span>
      </div>
    `;
    card.onclick = () => openLightbox(i);
    wireDownload(card, i.url, i.name);
    videoGrid.appendChild(card);
  });
}

function renderShots(items) {
  if (items.length === 0) {
    shotGrid.innerHTML = `<div class="empty-state">No screenshots yet. Be the first to share!</div>`;
    return;
  }
  shotGrid.innerHTML = '';
  items.forEach((i) => {
    const card = document.createElement('div');
    card.className = 's-card';
    card.innerHTML = `
      <div class="s-media">
        <button class="dl-btn" title="Download">${downloadSvg}</button>
        <img src="${i.url}" alt="" loading="lazy" />
      </div>
      <div class="s-meta">
        <strong>${niceName(i.name)}</strong>
        <span>${timeAgo(i.createdAt)}</span>
      </div>
    `;
    card.onclick = () => openLightbox(i);
    wireDownload(card, i.url, i.name);
    shotGrid.appendChild(card);
  });
}

function niceName(filename) {
  // strip timestamp prefix + random suffix: 17xxxxx-handle-xxxxx.ext
  const parts = filename.replace(/\.[^.]+$/, '').split('-');
  if (parts.length >= 3 && /^\d{13}$/.test(parts[0])) {
    return '@' + parts.slice(1, -1).join('-');
  }
  return filename;
}

refreshBtn.addEventListener('click', loadGallery);
loadGallery();
