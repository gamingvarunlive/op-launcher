'use strict';
// Auto-update: checks GitHub releases (through electron-updater), asks the user, downloads and restarts.
// "Remind me later" hides the same version for a day. Everything is injectable so it can be tested without Electron.

const { EventEmitter } = require('events');

const DAY = 24 * 60 * 60 * 1000;
const CHECK_EVERY = 4 * 60 * 60 * 1000;

function cleanNotes(n) {
  let t = '';
  if (typeof n === 'string') t = n;
  else if (Array.isArray(n)) t = n.map((x) => (x && x.note) || '').join('\n');
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > 600 ? t.slice(0, 600).trim() + '...' : t;
}

function createUpdater({ autoUpdater, currentVersion, send, isBusy, getSnooze, setSnooze, now = Date.now, enabled = true, firstCheckMs = 8000 }) {
  let phase = 'idle';          // idle | available | downloading | ready
  let found = null;            // { version, notes }
  let manual = false;
  let timers = [];

  if (enabled) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('update-available', (info) => {
      const version = String((info && info.version) || '');
      if (!version || version === currentVersion) return;
      found = { version, notes: cleanNotes(info && info.releaseNotes) };
      if (phase === 'downloading' || phase === 'ready') return;
      phase = 'available';
      const sn = getSnooze();
      if (!manual && sn && sn.version === version && sn.until > now()) return;   // reminded later
      manual = false;
      send({ type: 'available', ...found });
    });
    autoUpdater.on('update-not-available', () => {
      if (manual) send({ type: 'none' });
      manual = false;
    });
    autoUpdater.on('download-progress', (p) => send({ type: 'progress', percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))) }));
    autoUpdater.on('update-downloaded', () => {
      phase = 'ready';
      install();
    });
    autoUpdater.on('error', (err) => {
      const wasDownloading = phase === 'downloading';
      if (wasDownloading) phase = found ? 'available' : 'idle';
      if (manual || wasDownloading) send({ type: 'error', message: wasDownloading ? 'The update could not be downloaded. Check your internet and try again.' : 'Could not check for updates. Check your internet.' });
      manual = false;
    });
  }

  function check(isManual) {
    if (!enabled) return { ok: false, reason: 'dev' };
    if (phase === 'downloading' || phase === 'ready') return { ok: true };
    manual = !!isManual;
    Promise.resolve().then(() => autoUpdater.checkForUpdates()).catch(() => {
      if (manual) send({ type: 'error', message: 'Could not check for updates. Check your internet.' });
      manual = false;
    });
    return { ok: true };
  }

  function download() {
    if (!enabled || phase !== 'available') return { ok: false };
    phase = 'downloading';
    send({ type: 'progress', percent: 0 });
    Promise.resolve().then(() => autoUpdater.downloadUpdate()).catch(() => {
      phase = 'available';
      send({ type: 'error', message: 'The update could not be downloaded. Check your internet and try again.' });
    });
    return { ok: true };
  }

  function install() {
    if (phase !== 'ready') return { ok: false };
    if (isBusy()) { send({ type: 'ready', blocked: true }); return { ok: false, blocked: true }; }
    send({ type: 'ready', blocked: false });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 600);
    return { ok: true };
  }

  function later() {
    if (found) setSnooze({ version: found.version, until: now() + DAY });
    if (phase === 'available') phase = 'idle';
    return { ok: true };
  }

  function start() {
    if (!enabled) return;
    const first = setTimeout(() => check(false), firstCheckMs);
    const every = setInterval(() => check(false), CHECK_EVERY);
    first.unref && first.unref(); every.unref && every.unref();
    timers = [first, every];
  }
  function stop() { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); timers = []; }

  return { check, download, install, later, start, stop, get phase() { return phase; } };
}

// For trying the dialog with `npm start` (set OP_FAKE_UPDATE=1.0.1): behaves like a successful update.
function createFakeAutoUpdater(version, onQuit) {
  const a = new EventEmitter();
  a.checkForUpdates = async () => { setTimeout(() => a.emit('update-available', { version, releaseNotes: 'This is a test update.\n- New features\n- Bug fixes' }), 300); };
  a.downloadUpdate = async () => {
    let p = 0;
    const t = setInterval(() => {
      p += 20; a.emit('download-progress', { percent: p });
      if (p >= 100) { clearInterval(t); a.emit('update-downloaded', {}); }
    }, 400);
  };
  a.quitAndInstall = () => onQuit();
  return a;
}

module.exports = { createUpdater, createFakeAutoUpdater, cleanNotes };
