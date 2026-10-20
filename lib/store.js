'use strict';
// Op Launcher data store: profiles, selected profile and settings.
// Pure Node (no Electron imports) so it can be unit tested.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// NOTE: temporary hardcoded list. When the Play feature is added, the real list
// (1.20+ with Fabric support) will be fetched from Mojang / Fabric meta instead.
const VERSIONS = [
  '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
  '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20'
];

const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const ID_RE = /^[a-f0-9]{12}$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SKIN_BYTES = 300 * 1024;
const MAX_PROFILES = 30;
const MAX_FRIENDS = 200;

function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
}

function cleanNote(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
}

function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.length > MAX_SKIN_BYTES) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function validateSkinBuffer(buf) {
  const info = pngInfo(buf);
  if (!info) return { ok: false, error: 'That file is not a valid PNG skin.' };
  if (info.w !== 64 || (info.h !== 64 && info.h !== 32)) {
    return { ok: false, error: 'Skin must be a 64x64 or 64x32 PNG.' };
  }
  return { ok: true };
}

function createStore({ userDataDir, defaultGameDir, totalMemBytes, defaultSkinPath }) {
  const storeFile = path.join(userDataDir, 'store.json');
  const skinDir = path.join(userDataDir, 'skins');
  const totalRamGB = Math.max(2, Math.round(totalMemBytes / 1024 ** 3));

  const clampRam = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return Math.min(3, totalRamGB);
    return Math.min(totalRamGB, Math.max(2, Math.round(n * 2) / 2));
  };

  const newId = () => crypto.randomBytes(6).toString('hex');

  function load() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch (_) { raw = null; }
    const first = !raw || typeof raw !== 'object';
    if (first) raw = {};

    const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    const settings = {
      gameDir: typeof s.gameDir === 'string' && path.isAbsolute(s.gameDir) ? s.gameDir : defaultGameDir,
      ramGB: clampRam(s.ramGB === undefined ? 3 : s.ramGB),
      closeOnLaunch: !!s.closeOnLaunch,
      discordRpc: s.discordRpc === undefined ? true : !!s.discordRpc,
      showOwnName: s.showOwnName === undefined ? true : !!s.showOwnName,
      perfMode: !!s.perfMode
    };

    let profiles;
    if (Array.isArray(raw.profiles)) {
      profiles = raw.profiles
        .filter((p) => p && typeof p.id === 'string' && ID_RE.test(p.id))
        .slice(0, MAX_PROFILES)
        .map((p) => ({
          id: p.id,
          name: cleanName(p.name) || 'Profile',
          version: VERSIONS.includes(p.version) ? p.version : '1.21.4',
          username: USER_RE.test(String(p.username)) ? p.username : 'Player',
          hasSkin: !!p.hasSkin
        }));
    } else {
      profiles = [{ id: newId(), name: 'PvP Profile', version: '1.21.4', username: 'Player', hasSkin: false }];
    }

    let selectedId = typeof raw.selectedId === 'string' && profiles.some((p) => p.id === raw.selectedId)
      ? raw.selectedId
      : (profiles[0] ? profiles[0].id : null);

    const seen = new Set();
    const friends = [];
    for (const f of Array.isArray(raw.friends) ? raw.friends : []) {
      if (!f || !ID_RE.test(String(f.id)) || !USER_RE.test(String(f.name))) continue;
      const k = f.name.toLowerCase();
      if (seen.has(k) || friends.length >= MAX_FRIENDS) continue;
      seen.add(k);
      friends.push({ id: f.id, name: f.name, note: cleanNote(f.note), fav: !!f.fav, added: Number(f.added) || 0 });
    }

    const friendTokens = {};
    if (raw.friendTokens && typeof raw.friendTokens === 'object') {
      for (const [k, v] of Object.entries(raw.friendTokens)) {
        if (USER_RE.test(k) && /^[a-f0-9]{16,128}$/.test(String(v))) friendTokens[k.toLowerCase()] = v;
      }
    }

    const sn = raw.updateSnooze;
    const updateSnooze = sn && typeof sn.version === 'string' && /^[0-9A-Za-z.\-+]{1,32}$/.test(sn.version) && Number.isFinite(sn.until)
      ? { version: sn.version, until: sn.until } : null;

    return { settings, profiles, selectedId, friends, friendTokens, updateSnooze };
  }

  let data = load();

  function save() {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      const tmp = storeFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, storeFile);
    } catch (err) {
      console.error('Could not save store:', err.message);
    }
  }
  save();

  const state = () => ({
    settings: { ...data.settings },
    profiles: data.profiles.map((p) => ({ ...p })),
    selectedId: data.selectedId,
    friends: data.friends.map((f) => ({ ...f })),
    system: { totalRamGB, versions: VERSIONS.slice() }
  });

  function setSettings(patch) {
    patch = patch || {};
    if ('ramGB' in patch) data.settings.ramGB = clampRam(patch.ramGB);
    if ('closeOnLaunch' in patch) data.settings.closeOnLaunch = !!patch.closeOnLaunch;
    if ('discordRpc' in patch) data.settings.discordRpc = !!patch.discordRpc;
    if ('showOwnName' in patch) data.settings.showOwnName = !!patch.showOwnName;
    if ('perfMode' in patch) data.settings.perfMode = !!patch.perfMode;
    save();
    return state();
  }

  function setGameDir(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, error: 'Invalid folder.' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (_) {
      return { ok: false, error: 'Op Launcher cannot write to that folder. Pick another one.' };
    }
    data.settings.gameDir = dir;
    save();
    return { ok: true };
  }

  function createProfile(d) {
    d = d || {};
    const name = cleanName(d.name);
    if (!name) return { ok: false, error: 'Enter a profile name.' };
    if (!VERSIONS.includes(d.version)) return { ok: false, error: 'Pick a version.' };
    const username = String(d.username == null ? '' : d.username).trim();
    if (!USER_RE.test(username)) return { ok: false, error: 'Username must be 3-16 letters, numbers or _ only.' };
    if (data.profiles.length >= MAX_PROFILES) return { ok: false, error: 'Profile limit reached.' };

    const id = newId();
    let hasSkin = false;
    if (typeof d.skinDataUrl === 'string' && d.skinDataUrl) {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(d.skinDataUrl);
      const buf = m ? Buffer.from(m[1], 'base64') : null;
      const v = validateSkinBuffer(buf);
      if (!v.ok) return v;
      try {
        fs.mkdirSync(skinDir, { recursive: true });
        fs.writeFileSync(path.join(skinDir, id + '.png'), buf);
        hasSkin = true;
      } catch (_) {
        return { ok: false, error: 'Could not save the skin file.' };
      }
    }

    data.profiles.push({ id, name, version: d.version, username, hasSkin });
    data.selectedId = id;
    save();
    return { ok: true, id };
  }

  function selectProfile(id) {
    if (data.profiles.some((p) => p.id === id)) {
      data.selectedId = id;
      save();
    }
    return state();
  }

  function deleteProfile(id) {
    const idx = data.profiles.findIndex((p) => p.id === id);
    if (idx !== -1) {
      const [gone] = data.profiles.splice(idx, 1);
      if (gone.hasSkin) {
        try { fs.unlinkSync(path.join(skinDir, gone.id + '.png')); } catch (_) { /* already gone */ }
      }
      if (data.selectedId === id) data.selectedId = data.profiles[0] ? data.profiles[0].id : null;
      save();
    }
    return state();
  }

  // Raw PNG of a profile's custom skin, or null when it uses the default skin
  function skinBuffer(id) {
    const p = data.profiles.find((x) => x.id === id);
    if (!p || !p.hasSkin) return null;
    try {
      const buf = fs.readFileSync(path.join(skinDir, p.id + '.png'));
      return validateSkinBuffer(buf).ok ? buf : null;
    } catch (_) { return null; }
  }

  function skinDataUrl(id) {
    const p = data.profiles.find((x) => x.id === id);
    let file = defaultSkinPath;
    if (p && p.hasSkin) file = path.join(skinDir, p.id + '.png');
    let buf;
    try { buf = fs.readFileSync(file); } catch (_) { buf = fs.readFileSync(defaultSkinPath); }
    return 'data:image/png;base64,' + buf.toString('base64');
  }

  function addFriend(d) {
    d = d || {};
    const name = String(d.name == null ? '' : d.name).trim();
    if (!USER_RE.test(name)) return { ok: false, error: 'Enter a valid Minecraft username (3-16 letters, numbers or _).' };
    if (data.friends.length >= MAX_FRIENDS) return { ok: false, error: 'Friend list is full.' };
    if (data.friends.some((f) => f.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: name + ' is already in your friends list.' };
    data.friends.push({ id: newId(), name, note: cleanNote(d.note), fav: false, added: Date.now() });
    save();
    return { ok: true, state: state() };
  }

  function updateFriend(id, patch) {
    const f = data.friends.find((x) => x.id === id);
    if (!f) return { ok: false, error: 'Friend not found.' };
    patch = patch || {};
    if ('fav' in patch) f.fav = !!patch.fav;
    if ('note' in patch) f.note = cleanNote(patch.note);
    save();
    return { ok: true, state: state() };
  }

  function removeFriend(id) {
    const i = data.friends.findIndex((x) => x.id === id);
    if (i >= 0) { data.friends.splice(i, 1); save(); }
    return state();
  }

  const getUpdateSnooze = () => (data.updateSnooze ? { ...data.updateSnooze } : null);
  function setUpdateSnooze(v) {
    data.updateSnooze = v && typeof v.version === 'string' && Number.isFinite(v.until) ? { version: v.version, until: v.until } : null;
    save();
  }
  const getFriendToken = (name) => data.friendTokens[String(name).toLowerCase()] || null;
  function setFriendToken(name, token) {
    if (!USER_RE.test(String(name)) || !/^[a-f0-9]{16,128}$/.test(String(token))) return;
    data.friendTokens[String(name).toLowerCase()] = token;
    save();
  }

  return { state, getUpdateSnooze, setUpdateSnooze, getFriendToken, setFriendToken, setSettings, addFriend, updateFriend, removeFriend, setGameDir, createProfile, selectProfile, deleteProfile, skinDataUrl, skinBuffer, validateSkinBuffer, getGameDir: () => data.settings.gameDir };
}

module.exports = { createStore, validateSkinBuffer, VERSIONS };
