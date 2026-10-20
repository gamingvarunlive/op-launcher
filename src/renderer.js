// Core: shared state, navigation, window controls, toast.
(function () {
  'use strict';

  const handlers = {};
  const skinCache = new Map();

  const OP = (window.OP = {
    state: null,

    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
    emit(evt, data) {
      (handlers[evt] || []).forEach((fn) => {
        try { fn(data); } catch (err) { console.error(err); }
      });
    },

    setState(s) {
      OP.state = s;
      document.body.classList.toggle('perf', !!s.settings.perfMode);
      OP.emit('state', s);
    },

    selectedProfile() {
      const s = OP.state;
      if (!s) return null;
      return s.profiles.find((p) => p.id === s.selectedId) || null;
    },

    // Skin data URL for a profile (null = default skin). Cached.
    getSkin(id) {
      const key = id || 'default';
      if (!skinCache.has(key)) skinCache.set(key, window.op.getSkin(id || null));
      return skinCache.get(key);
    },
    dropSkin(id) { skinCache.delete(id); },

    // Draws the face (+ hat layer) of a skin onto a canvas.
    drawHead(canvas, dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
          if (img.height >= 16) ctx.drawImage(img, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = dataUrl;
      });
    },

    // Draws an 8x8 face image (what friends share) onto a canvas.
    drawFace(canvas, dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, 8, 8, 0, 0, canvas.width, canvas.height);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = dataUrl;
      });
    },

    toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(OP._toastTimer);
      OP._toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
    },

    goto(page) {
      const btn = document.querySelector('.nav-btn[data-page="' + page + '"]');
      if (btn) btn.click();
    },
    showNav(page, visible) {
      const btn = document.querySelector('.nav-btn[data-page="' + page + '"]');
      if (btn) btn.hidden = !visible;
    }
  });

  // ---------- Sidebar navigation + highlight ----------
  const buttons = document.querySelectorAll('.nav-btn');
  const pages = document.querySelectorAll('.page');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      pages.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('page-' + btn.dataset.page).classList.add('active');
      document.body.classList.toggle('home-black', btn.dataset.page === 'home' || btn.dataset.page === 'mods');
      OP.emit('page', btn.dataset.page);
    });
  });

  // no dragging of images / links out of the window
  document.addEventListener('dragstart', (e) => e.preventDefault());

  // ---------- Window controls ----------
  const maxBtn = document.getElementById('btn-max');
  document.getElementById('btn-min').addEventListener('click', () => window.op.minimize());
  maxBtn.addEventListener('click', () => window.op.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.op.close());
  document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.title-right')) window.op.maximize();
  });
  window.op.onMaximized((isMax) => {
    maxBtn.classList.toggle('is-max', isMax);
    maxBtn.title = isMax ? 'Restore' : 'Maximize';
  });

  // ---------- App version under Settings ----------
  if (window.op.getVersion) {
    window.op.getVersion().then((v) => { if (v) document.getElementById('app-ver').textContent = 'v' + v; }).catch(() => {});
  }

  // ---------- Boot (after every script has registered its listeners) ----------
  window.addEventListener('load', async () => {
    try {
      OP.setState(await window.op.getState());
    } catch (err) {
      console.error('Could not load launcher state', err);
      OP.toast('Could not load launcher data');
    }
  });
})();
