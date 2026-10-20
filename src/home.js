// Home tab: 3D skin stage, Play button, dashboard cards.
(function () {
  'use strict';

  const canvas = document.getElementById('skin-canvas');
  const stageEmpty = document.getElementById('stage-empty');
  const nameEl = document.getElementById('stage-name');
  const metaEl = document.getElementById('stage-meta');
  const playBtn = document.getElementById('btn-play');
  const stage = document.getElementById('stage');
  const launchEl = document.getElementById('launch');
  const card = document.getElementById('progress');
  const pcTitle = document.getElementById('pc-title');
  const pcPct = document.getElementById('pc-pct');
  const pcFill = document.getElementById('pc-fill');
  const pcDetail = document.getElementById('pc-detail');
  const pcAction = document.getElementById('pc-action');

  // ---- floating particles (purely decorative) ----
  const pBox = document.getElementById('particles');
  for (let i = 0; i < 14; i++) {
    const p = document.createElement('i');
    p.style.setProperty('--x', (18 + Math.random() * 64).toFixed(1) + '%');
    p.style.setProperty('--s', (2 + Math.random() * 2.5).toFixed(1) + 'px');
    p.style.setProperty('--d', (5 + Math.random() * 5).toFixed(1) + 's');
    p.style.setProperty('--delay', (-Math.random() * 9).toFixed(1) + 's');
    p.style.setProperty('--dx', (Math.random() * 60 - 30).toFixed(0) + 'px');
    pBox.append(p);
  }

  // ---- 3D viewer ----
  const viewer = new window.Skin3D(canvas, { inputEl: stage });
  let shownKey = null;     // which skin is currently on the model
  let onHome = true;

  OP.on('page', (page) => {
    onHome = page === 'home';
    viewer.setPaused(!onHome);
  });

  async function showSkin(profile) {
    const key = profile ? profile.id : null;
    if (key === shownKey) return;
    shownKey = key;
    const url = await OP.getSkin(profile && profile.hasSkin ? profile.id : null);
    if (viewer.ok) await viewer.setSkin(url);
    else {
      // no WebGL: show the face instead
      canvas.width = 64; canvas.height = 64;
      canvas.style.imageRendering = 'pixelated';
      OP.drawHead(canvas, url);
    }
  }

  OP.on('state', (s) => {
    const p = OP.selectedProfile();
    const perf = s.settings.perfMode;
    viewer.setPerf(perf);

    stageEmpty.hidden = !!p;
    stage.classList.toggle('empty', !p);
    document.querySelector('.stage-info').hidden = !p;
    canvas.style.visibility = p ? 'visible' : 'hidden';
    playBtn.disabled = !p;
    if (!p && launchState !== 'idle') setLaunch('idle');

    if (p) {
      nameEl.textContent = p.name;
      metaEl.textContent = 'Fabric ' + p.version + '  ·  ' + p.username;
      showSkin(p);
    } else {
      nameEl.textContent = '-';
      metaEl.textContent = '';
      shownKey = null;
    }
  });

  // ---- launch area: button <-> progress card ----
  let launchState = 'idle';   // idle | busy | running | error
  const STAGE_TITLE = {
    prepare: 'Preparing game files',
    java: 'Downloading Java',
    libraries: 'Downloading libraries',
    assets: 'Downloading game assets',
    launching: 'Starting Minecraft'
  };

  function setLaunch(state, o) {
    o = o || {};
    launchState = state;
    OP.launchActive = state === 'busy' || state === 'running';
    if (state === 'idle') OP.launchProfileId = null;
    launchEl.dataset.state = state;
    if (state === 'idle') return;
    if (o.title !== undefined) pcTitle.textContent = o.title;
    if (o.detail !== undefined) pcDetail.textContent = o.detail;
    if (o.action !== undefined) pcAction.textContent = o.action;
    pcAction.hidden = !pcAction.textContent;
    if (state === 'running') pcPct.textContent = 'Running';
    else if (o.percent === null || o.percent === undefined) {
      if (state === 'busy') { pcPct.textContent = ''; }
    } else {
      pcPct.textContent = Math.round(o.percent) + '%';
    }
    const indeterminate = state === 'busy' && (o.percent === null || o.percent === undefined);
    card.classList.toggle('indeterminate', indeterminate);
    if (!indeterminate && o.percent !== undefined && o.percent !== null) {
      pcFill.style.width = Math.max(0, Math.min(100, o.percent)) + '%';
    }
  }

  function onLaunchEvent(ev) {
    if (!ev) return;
    if (ev.type === 'progress') {
      setLaunch('busy', {
        title: ev.text || STAGE_TITLE[ev.stage] || 'Working...',
        detail: ev.detail || '',
        percent: ev.percent,
        action: 'Cancel'
      });
    } else if (ev.type === 'running') {
      setLaunch('running', { title: 'Minecraft is running', detail: 'Have fun! This closes when the game does.', action: '' });
    } else if (ev.type === 'exit') {
      setLaunch('idle');
      if (ev.crashed) {
        setLaunch('error', { title: 'Minecraft crashed', detail: (ev.detail || 'Check the log for details.') + (ev.logPath ? '  Log: ' + ev.logPath : ''), action: 'Dismiss' });
      } else OP.toast('Game closed');
    } else if (ev.type === 'error') {
      setLaunch('error', { title: 'Could not launch', detail: ev.message + (ev.logPath ? '  Log: ' + ev.logPath : ''), action: 'Dismiss' });
    } else if (ev.type === 'cancelled') {
      setLaunch('idle');
      OP.toast('Launch cancelled');
    }
  }
  window.op.onLaunchEvent(onLaunchEvent);

  playBtn.addEventListener('click', async () => {
    const p = OP.selectedProfile();
    if (!p || launchState !== 'idle') return;
    OP.launchProfileId = p.id;
    setLaunch('busy', { title: 'Preparing game files', detail: 'Starting...', percent: null, action: 'Cancel' });
    let r;
    try { r = await window.op.startLaunch(p.id); } catch (_) { r = { ok: false, error: 'Could not start the launch.' }; }
    if (!r || !r.ok) setLaunch('error', { title: 'Could not launch', detail: (r && r.error) || 'Unknown error.', action: 'Dismiss' });
  });

  document.getElementById('pc-console').addEventListener('click', () => window.op.openConsole());

  pcAction.addEventListener('click', async () => {
    if (launchState === 'busy') {
      pcAction.disabled = true;
      await window.op.cancelLaunch();
      pcAction.disabled = false;
    } else if (launchState === 'error') setLaunch('idle');
  });

  // The window may have been reloaded mid-launch: pick the state back up
  window.op.getLaunchStatus().then((st) => {
    if (st && st.state === 'busy' && st.lastEvent) onLaunchEvent(st.lastEvent);
    else if (st && st.state === 'running') setLaunch('running', { title: 'Minecraft is running', detail: '', action: '' });
  }).catch(() => {});

  // ---- Latest News ----
  function newsAction(item) {
    if (item.action === 'discord') {
      window.op.openDiscord().then((ok) => { if (!ok) OP.toast('Discord link is not set yet'); });
    } else if (typeof item.action === 'string' && item.action.startsWith('https://')) {
      window.op.openExternal(item.action);
    }
  }
  const grid = document.getElementById('news-grid');
  (window.OP_NEWS || []).forEach((item) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'news-tile';
    const img = document.createElement('img');
    img.src = item.image; img.alt = ''; img.draggable = false;
    const body = document.createElement('div');
    body.className = 'nt-body';
    const tag = document.createElement('span'); tag.className = 'nt-tag'; tag.textContent = item.tag || 'NEWS';
    const t = document.createElement('div'); t.className = 'nt-title'; t.textContent = item.title;
    const d = document.createElement('div'); d.className = 'nt-desc'; d.textContent = item.desc || '';
    body.append(tag, t, d);
    b.append(img, body);
    b.addEventListener('click', () => newsAction(item));
    grid.append(b);
  });
  document.getElementById('news-all').addEventListener('click', () => OP.toast('More news coming soon'));
  document.getElementById('friends-all').addEventListener('click', () => OP.goto('friends'));
})();
