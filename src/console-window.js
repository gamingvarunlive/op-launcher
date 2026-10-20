// Console window: live launcher + game log, session card, search.
(function () {
  'use strict';

  const logEl = document.getElementById('con-log');
  const searchEl = document.getElementById('con-search');
  const dot = document.getElementById('cs-dot');
  const titleEl = document.getElementById('cs-title');
  const statusEl = document.getElementById('cs-status');
  const sessionEl = document.getElementById('cs-session');
  const accountEl = document.getElementById('cs-account');
  const actionBtn = document.getElementById('cs-action');

  const MAX_DOM = 4000;
  let rows = [];            // { el, text }
  let query = '';
  let state = 'idle';       // idle | busy | running | done | bad
  let startedAt = 0;

  const pad = (n) => String(n).padStart(2, '0');
  const clock = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };

  function classify(text) {
    if (/^\[Op Launcher\]/.test(text)) return /ERROR|Could not/.test(text) ? 'sys err' : 'sys';
    if (/\b(ERROR|FATAL)\b|Exception|Caused by:|^\s+at [\w$.]+\(/.test(text)) return 'err';
    if (/\bWARN\b/.test(text)) return 'warn';
    if (/\bDEBUG\b|\bTRACE\b/.test(text)) return 'dim';
    return '';
  }

  function matches(text) { return !query || text.toLowerCase().includes(query); }

  function addLines(texts) {
    if (!texts || !texts.length) return;
    const near = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const frag = document.createDocumentFragment();
    const t = clock();
    for (const text of texts) {
      const el = document.createElement('div');
      el.className = ('ln ' + classify(text)).trim();
      const ts = document.createElement('span'); ts.className = 't'; ts.textContent = t;
      const m = document.createElement('span'); m.className = 'm'; m.textContent = text;
      el.append(ts, m);
      if (!matches(text)) el.classList.add('hide');
      rows.push({ el, text });
      frag.append(el);
    }
    logEl.append(frag);
    if (rows.length > MAX_DOM) {
      const drop = rows.splice(0, rows.length - MAX_DOM);
      drop.forEach((r) => r.el.remove());
    }
    if (near) logEl.scrollTop = logEl.scrollHeight;
  }

  function reset() {
    rows = [];
    logEl.textContent = '';
  }

  // ---- session card ----
  const STATUS = {
    idle: ['Idle', ''], busy: ['Preparing', 'busy'], running: ['Running', 'run'],
    done: ['Closed', ''], bad: ['Failed', 'bad']
  };
  function setState(next, label) {
    state = next;
    const [text, cls] = STATUS[next];
    statusEl.textContent = label || text;
    dot.className = 'cs-dot' + (cls ? ' ' + cls : '');
    actionBtn.hidden = !(next === 'busy' || next === 'running');
    actionBtn.textContent = next === 'running' ? 'Close Game' : 'Cancel Launch';
    actionBtn.disabled = false;
    tickSession();
  }
  function tickSession() {
    if (state === 'running' && startedAt) {
      const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      sessionEl.textContent = s >= 3600
        ? Math.floor(s / 3600) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60)
        : Math.floor(s / 60) + ':' + pad(s % 60);
    } else if (state !== 'running' && state !== 'done') sessionEl.textContent = '-';
  }
  setInterval(tickSession, 1000);

  function setProfile(p) {
    titleEl.textContent = p ? 'Minecraft ' + p.version + ' with Fabric' : 'Minecraft';
    accountEl.textContent = p ? p.username : '-';
  }

  let applied = -1;          // seq of the last log line shown (-1 until the first sync)
  let pending = [];          // events that arrive while the first sync is running

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2000);
  }

  function applyLog(ev) {
    const n = ev.lines.length;
    if (ev.seq <= applied) return;
    const skip = Math.max(0, applied - (ev.seq - n));
    addLines(skip ? ev.lines.slice(skip) : ev.lines);
    applied = ev.seq;
  }

  function onEvent(ev) {
    if (!ev) return;
    if (ev.type === 'log') applyLog(ev);
    else if (ev.type === 'progress') setState('busy', ev.stage === 'launching' ? 'Starting' : (ev.stage === 'prepare' ? 'Preparing' : 'Downloading'));
    else if (ev.type === 'running') { startedAt = Date.now(); setState('running'); }
    else if (ev.type === 'exit') setState(ev.crashed ? 'bad' : 'done', ev.crashed ? 'Crashed' : 'Closed');
    else if (ev.type === 'error') setState('bad');
    else if (ev.type === 'cancelled') setState('done', 'Cancelled');
  }

  // Full sync with the launcher: used when this window opens and when a new launch starts
  async function sync(profile) {
    pending = [];
    applied = -1;
    reset();
    searchEl.value = ''; query = '';
    startedAt = 0;
    sessionEl.textContent = '-';
    const [st, snap, sess] = await Promise.all([window.op.getLaunchStatus(), window.op.getLaunchLog(), profile ? Promise.resolve({ profile }) : window.op.getSession()]);
    setProfile(sess && sess.profile);
    addLines(snap.lines);
    applied = snap.seq;
    if (st.state === 'running') { startedAt = Date.now(); setState('running'); }
    else if (st.state === 'busy') setState('busy', st.lastEvent && st.lastEvent.stage === 'launching' ? 'Starting' : 'Preparing');
    else setState('done', st.lastEvent && st.lastEvent.type === 'cancelled' ? 'Cancelled' : (st.lastEvent && st.lastEvent.type === 'error' ? 'Failed' : 'Closed'));
    const queued = pending; pending = null;
    queued.forEach(onEvent);
  }

  window.op.onLaunchEvent((ev) => { if (pending) pending.push(ev); else onEvent(ev); });
  window.op.onConsoleReset((s) => { pending = []; sync(s && s.profile); });

  actionBtn.addEventListener('click', async () => {
    actionBtn.disabled = true;
    if (state === 'running') await window.op.stopGame();
    else await window.op.cancelLaunch();
  });

  // ---- toolbar ----
  searchEl.addEventListener('input', () => {
    query = searchEl.value.trim().toLowerCase();
    for (const r of rows) r.el.classList.toggle('hide', !matches(r.text));
  });
  document.getElementById('con-clear').addEventListener('click', reset);
  document.getElementById('con-folder').addEventListener('click', () => window.op.openLogs());
  document.getElementById('con-copy').addEventListener('click', async () => {
    const text = rows.map((r) => r.text).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Log copied'); }
    catch (_) { toast('Could not copy the log'); }
  });

  // window controls
  const maxBtn = document.getElementById('btn-max');
  document.getElementById('btn-min').addEventListener('click', () => window.op.minimize());
  maxBtn.addEventListener('click', () => window.op.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.op.close());
  document.querySelector('.titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('.title-right')) window.op.maximize(); });
  window.op.onMaximized((isMax) => { maxBtn.classList.toggle('is-max', isMax); maxBtn.title = isMax ? 'Restore' : 'Maximize'; });

  pending = [];
  sync(null).catch(() => { pending = null; });
})();
