const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createStore, validateSkinBuffer } = require('./lib/store');
const { createLauncher } = require('./lib/launcher');
const { createPresence } = require('./lib/discord-rpc');
const { createSocial } = require('./lib/social');
const { createMods } = require('./lib/mods');
const { createUpdater, createFakeAutoUpdater } = require('./lib/updater');
const { ensureClientMod } = require('./lib/opclient');
const { createModrinth } = require('./lib/modrinth');

// Put your Discord invite link here (must start with https://)
const DISCORD_URL = '';
// Address of your deployed friend server (see /server). Leave empty to use the offline friends list only.
const FRIEND_SERVER_URL = process.env.OP_FRIEND_SERVER || '';

// Discord "Playing Op Launcher" activity (Rich Presence).
// 1) Go to https://discord.com/developers/applications -> New Application, name it "Op Launcher".
// 2) Paste its Application ID below.
// 3) In that application: Rich Presence -> Art Assets, upload 2 images with these exact keys:
//      logo  (your launcher logo, 512x512+)      head  (a default player head image)
const DISCORD_CLIENT_ID = '';

// Player head shown on the Discord activity. {name} is replaced with the profile's username.
// Works for any real Minecraft username (offline/custom skins cannot be hosted, so those show the default head).
// Set to '' to use the "head" art asset from your Discord application instead.

// Needed on Windows so the taskbar shows our own icon (not Electron's)
app.setAppUserModelId('com.oplauncher.app');

let win;
let store;
let launcher;
let presence;
let social;
let updater;

function baseWindowOptions(extra) {
  return Object.assign({
    frame: false,
    backgroundColor: '#0a0a0a',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true
    }
  }, extra);
}

// No pop-ups, no navigating away, and tell the page when maximize state changes
function hardenWindow(w) {
  w.setMenuBarVisibility(false);
  if (!app.isPackaged) {
    w.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') w.webContents.toggleDevTools();
    });
  }
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  const sendState = () => { if (!w.isDestroyed()) w.webContents.send('win:maximized', w.isMaximized()); };
  w.on('maximize', sendState);
  w.on('unmaximize', sendState);
}

function createWindow() {
  win = new BrowserWindow(baseWindowOptions({ width: 1000, height: 600, minWidth: 860, minHeight: 520 }));
  hardenWindow(win);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // closing the launcher closes the console window too
  win.on('closed', () => {
    win = null;
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  });
}

// ---------- Console window (its own window, like a second browser window) ----------
let consoleWin = null;
let session = null;   // { profile } of the current / last launch

function openConsole(reset) {
  if (consoleWin && !consoleWin.isDestroyed()) {
    if (consoleWin.isMinimized()) consoleWin.restore();
    consoleWin.show();
    consoleWin.focus();
    if (reset) consoleWin.webContents.send('console:reset', session);
    return;
  }
  consoleWin = new BrowserWindow(baseWindowOptions({ width: 940, height: 580, minWidth: 640, minHeight: 380, title: 'Op Launcher Console' }));
  hardenWindow(consoleWin);
  consoleWin.loadFile(path.join(__dirname, 'src', 'console.html'));
  consoleWin.on('closed', () => { consoleWin = null; });
}

// Only one launcher at a time (two would fight over the same files and settings)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
}

app.whenReady().then(() => {
  // No default menu: removes accidental Ctrl+R reloads and zoom shortcuts. F12 opens DevTools only when run from source.
  Menu.setApplicationMenu(null);
  store = createStore({
    userDataDir: app.getPath('userData'),
    defaultGameDir: path.join(app.getPath('appData'), '.oplauncher'),
    totalMemBytes: os.totalmem(),
    defaultSkinPath: path.join(__dirname, 'assets', 'default-skin.png')
  });
  social = createSocial({ baseUrl: FRIEND_SERVER_URL, store, defaultSkinPath: path.join(__dirname, 'assets', 'default-skin.png') });
  presence = createPresence({ clientId: DISCORD_CLIENT_ID });
  launcher = createLauncher({ launcherName: 'OpLauncher', launcherVersion: app.getVersion() });
  createWindow();
  setupUpdater();
});

// ---------- Auto-update (installed version only; OP_FAKE_UPDATE=1.0.1 shows the dialog when run from source) ----------
function setupUpdater() {
  const fake = !app.isPackaged && /^[0-9A-Za-z.\-]{1,20}$/.test(process.env.OP_FAKE_UPDATE || '') ? process.env.OP_FAKE_UPDATE : null;
  let autoUpdater = null;
  if (fake) autoUpdater = createFakeAutoUpdater(fake, () => app.quit());
  else if (app.isPackaged) { try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { autoUpdater = null; } }
  updater = createUpdater({
    autoUpdater: autoUpdater || new (require('events'))(),
    enabled: !!autoUpdater,
    currentVersion: app.getVersion(),
    send: (ev) => { if (win && !win.isDestroyed()) win.webContents.send('update:event', ev); },
    isBusy: () => { const st = launcher.getStatus(); return st.state === 'busy' || st.state === 'running'; },
    getSnooze: () => store.getUpdateSnooze(),
    setSnooze: (v) => store.setUpdateSnooze(v)
  });
  updater.start();
}
ipcMain.handle('updates:check', () => updater.check(true));
ipcMain.handle('updates:download', () => updater.download());
ipcMain.handle('updates:install', () => updater.install());
ipcMain.handle('updates:later', () => updater.later());

// Closing the launcher mid-download stops the download cleanly (a running game is left alone)
app.on('before-quit', () => { if (updater) updater.stop(); if (launcher) launcher.cancel(); if (presence) presence.close(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- Window controls (apply to whichever window sent them) ----------
const fromEvent = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.on('win:minimize', (e) => { const w = fromEvent(e); if (w) w.minimize(); });
ipcMain.on('win:maximize', (e) => {
  const w = fromEvent(e);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:close', (e) => { const w = fromEvent(e); if (w) w.close(); });

// ---------- Discord ----------
ipcMain.handle('open:discord', async () => {
  if (!DISCORD_URL.startsWith('https://')) return false;
  await shell.openExternal(DISCORD_URL);
  return true;
});

// ---------- State / profiles / settings ----------
ipcMain.handle('state:get', () => store.state());

ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));

ipcMain.handle('settings:choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose where Op Launcher stores its files',
    defaultPath: store.getGameDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const res = store.setGameDir(r.filePaths[0]);
  return res.ok ? { ok: true, state: store.state() } : res;
});

ipcMain.handle('settings:open-dir', async () => {
  const dir = store.getGameDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* shell.openPath reports the error */ }
  const err = await shell.openPath(dir);
  return { ok: !err, error: err || undefined };
});

ipcMain.handle('skin:choose', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a skin (64x64 or 64x32 PNG)',
    filters: [{ name: 'PNG skin', extensions: ['png'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const buf = fs.readFileSync(r.filePaths[0]);
    const v = validateSkinBuffer(buf);
    if (!v.ok) return v;
    return { ok: true, dataUrl: 'data:image/png;base64,' + buf.toString('base64'), name: path.basename(r.filePaths[0]) };
  } catch (_) {
    return { ok: false, error: 'Could not read that file.' };
  }
});

ipcMain.handle('skin:get', (_e, id) => store.skinDataUrl(id));

ipcMain.handle('profile:create', (_e, d) => {
  const r = store.createProfile(d);
  if (r.ok) {
    // every new profile starts with the Op Client mod already in its mods folder
    const st = store.state();
    const p = st.profiles[st.profiles.length - 1];
    if (p) ensureClientMod({ dir: path.join(__dirname, 'assets', 'opclient'), modsDir: path.join(st.settings.gameDir, 'profiles', p.id, 'mods'), version: p.version });
  }
  return r.ok ? { ok: true, state: store.state() } : r;
});
ipcMain.handle('profile:select', (_e, id) => store.selectProfile(id));
ipcMain.handle('profile:delete', (_e, id) => store.deleteProfile(id));

ipcMain.handle('friend:add', (_e, d) => store.addFriend(d));
ipcMain.handle('friend:update', (_e, id, patch) => store.updateFriend(id, patch));
ipcMain.handle('friend:remove', (_e, id) => store.removeFriend(id));

// Online friends (needs FRIEND_SERVER_URL)
const selectedProfile = () => { const s = store.state(); return s.profiles.find((p) => p.id === s.selectedId) || null; };
ipcMain.handle('social:info', () => ({ configured: social.configured }));
ipcMain.handle('social:sync', async () => {
  try { return { ok: true, data: await social.sync(selectedProfile()) }; } catch (e) { return { ok: false, error: e.message, network: !!e.network }; }
});
ipcMain.handle('social:do', async (_e, kind, name) => {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(name)) return { ok: false, error: 'Enter a valid Minecraft username.' };
  try { const r = await social.action(selectedProfile(), String(kind), name); return { ok: true, data: r.data, accepted: !!r.result.accepted }; }
  catch (e) { return { ok: false, error: e.message, network: !!e.network }; }
});

// ---------- Launch ----------
function sendLaunchEvent(ev) {
  for (const w of [win, consoleWin]) if (w && !w.isDestroyed()) w.webContents.send('launch:event', ev);
}

ipcMain.handle('launch:start', async (_e, id) => {
  const s = store.state();
  const profile = s.profiles.find((p) => p.id === id);
  if (!profile) return { ok: false, error: 'Profile not found.' };
  const settings = s.settings;
  session = { profile: { id: profile.id, name: profile.name, version: profile.version, username: profile.username } };
  // Settings for the in-game Op Client mod (only used when the mod is installed in this profile)
  const extraJvm = ['-Dop.ownName=' + (settings.showOwnName !== false)];
  const creds = await Promise.race([social.credentials(profile), new Promise((r) => setTimeout(() => r(null), 4000))]);
  if (creds) extraJvm.push('-Dop.server=' + creds.server, '-Dop.user=' + creds.user, '-Dop.token=' + creds.token);
  const skin = store.skinBuffer(profile.id);   // custom skin => game gets it through the local skin server
  const result = launcher.start({
    profile,
    settings,
    skin,
    extraJvm,
    clientModDir: path.join(__dirname, 'assets', 'opclient'),
    onEvent: (ev) => {
      sendLaunchEvent(ev);
      if (ev.type === 'running' && settings.discordRpc !== false) {
        presence.setActivity({
          details: 'Minecraft ' + profile.version,
          state: 'Playing as ' + profile.username,
          largeImage: 'logo', largeText: 'Op Launcher',
          startedAt: Date.now()
        });
      } else if (ev.type === 'exit' || ev.type === 'error' || ev.type === 'cancelled') {
        presence.clear();
      }
      // The skin server lives inside the launcher, so with a custom skin the launcher has to stay open
      if (ev.type === 'running' && settings.closeOnLaunch && !skin) {
        launcher.detach();
        setTimeout(() => app.quit(), 800);
      }
    }
  });
  if (result.ok) openConsole(true);
  return result;
});

ipcMain.handle('launch:cancel', () => ({ ok: launcher.cancel() }));
ipcMain.handle('launch:status', () => launcher.getStatus());
ipcMain.handle('launch:stop', () => ({ ok: launcher.stop() }));
ipcMain.handle('launch:log', () => launcher.getLog());
ipcMain.handle('launch:session', () => session);
ipcMain.handle('console:open', () => { openConsole(false); return true; });
ipcMain.handle('launch:open-logs', async () => {
  const dir = path.join(store.getGameDir(), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* openPath reports the error */ }
  const err = await shell.openPath(dir);
  return { ok: !err };
});

// ---------- Mods (selected profile) ----------
const mods = createMods();
let logoUrl = null;
function withLogo(list) {   // Op Client has no icon of its own: use the launcher logo
  if (logoUrl === null) {
    try { logoUrl = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'assets', 'logo-transparent.png')).toString('base64'); } catch (_) { logoUrl = ''; }
  }
  return list.map((m) => (m.locked && !m.icon && logoUrl ? { ...m, icon: logoUrl } : m));
}
function modsContext() {
  const s = store.state();
  const p = s.profiles.find((x) => x.id === s.selectedId);
  if (!p) return null;
  const dir = path.join(s.settings.gameDir, 'profiles', p.id, 'mods');
  return { profile: { id: p.id, name: p.name, version: p.version }, dir };
}
ipcMain.handle('mods:list', () => {
  const c = modsContext();
  if (!c) return { ok: true, profile: null, mods: [] };
  return { ok: true, profile: c.profile, mods: withLogo(mods.list(c.dir)) };
});
ipcMain.handle('mods:toggle', (_e, file) => {
  const c = modsContext();
  if (!c) return { ok: false, error: 'Select a profile first.' };
  const r = mods.toggle(c.dir, file);
  return r.ok ? { ok: true, enabled: r.enabled, mods: withLogo(mods.list(c.dir)) } : r;
});
const modrinth = createModrinth();
function browseContext() {
  const s = store.state();
  const p = s.profiles.find((x) => x.id === s.selectedId);
  if (!p) return null;
  const profileDir = path.join(s.settings.gameDir, 'profiles', p.id);
  return { version: p.version, profileDir, modsDir: path.join(profileDir, 'mods'), profile: { id: p.id, name: p.name } };
}
ipcMain.handle('modrinth:search', async (_e, o) => {
  const c = browseContext();
  if (!c) return { ok: false, error: 'Select a profile first.' };
  o = o && typeof o === 'object' ? o : {};
  try { return { ok: true, version: c.version, ...(await modrinth.search({ query: o.query, sort: o.sort, offset: o.offset, limit: o.limit, version: c.version, profileDir: c.profileDir, modsDir: c.modsDir })) }; }
  catch (e) { return { ok: false, error: e.message, network: !!e.network }; }
});
ipcMain.handle('modrinth:install', async (_e, projectId) => {
  const c = browseContext();
  if (!c) return { ok: false, error: 'Select a profile first.' };
  try { const done = await modrinth.install({ projectId, version: c.version, profileDir: c.profileDir, modsDir: c.modsDir }); return { ok: true, installed: done, profileId: c.profile.id }; }
  catch (e) { return { ok: false, error: e.message, network: !!e.network }; }
});
ipcMain.handle('mods:open-folder', async () => {
  const c = modsContext();
  if (!c) return { ok: false, error: 'Select a profile first.' };
  try {
    fs.mkdirSync(c.dir, { recursive: true });
    const err = await shell.openPath(c.dir);
    return err ? { ok: false, error: 'Could not open the folder.' } : { ok: true };
  } catch (_) { return { ok: false, error: 'Could not open the folder.' }; }
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('open:external', async (_e, url) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  await shell.openExternal(url);
  return true;
});
