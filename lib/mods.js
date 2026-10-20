'use strict';
// Reads the mods of a profile (gameDir/profiles/<id>/mods) and enables / disables them.
// A disabled mod is the same .jar renamed to "<name>.jar.disabled": Fabric only loads *.jar, so it is skipped by the game.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_MODS = 500;
const MAX_JSON = 1024 * 1024;
const MAX_ICON = 256 * 1024;
const FILE_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,200}\.jar(\.disabled)?$/i;
const LOCKED = new Set(['opclient.jar', 'opclient.jar.disabled']);   // Op Client: part of the launcher, cannot be turned off
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---- minimal zip reader (central directory) ----
function readZipEntries(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return null;
  const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize > 8 * 1024 * 1024 || cdOff + cdSize > size) return null;
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOff);
  const map = new Map();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nlen);
    map.set(name, { method, csize, usize, off });
    p += 46 + nlen + xlen + clen;
  }
  return map;
}

function readEntry(fd, ent, limit) {
  if (!ent || ent.usize > limit || ent.csize > limit * 2) return null;
  const head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, ent.off);
  if (head.readUInt32LE(0) !== 0x04034b50) return null;
  const start = ent.off + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const raw = Buffer.alloc(ent.csize);
  fs.readSync(fd, raw, 0, ent.csize, start);
  try {
    if (ent.method === 0) return raw;
    if (ent.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: limit });
  } catch (_) { /* corrupt entry */ }
  return null;
}

function parseJson(buf) {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  try { return JSON.parse(text); } catch (_) { /* fabric tolerates raw newlines inside strings */ }
  try { return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' ')); } catch (_) { return null; }
}

function str(v, max) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : ''; }

function pickIcon(icon) {
  if (typeof icon === 'string') return icon;
  if (icon && typeof icon === 'object') {
    const keys = Object.keys(icon).filter((k) => typeof icon[k] === 'string').sort((a, b) => Number(b) - Number(a));
    if (keys.length) return icon[keys[0]];
  }
  return '';
}

function readJarInfo(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const entries = readZipEntries(fd, size);
    if (!entries) return null;
    const metaBuf = readEntry(fd, entries.get('fabric.mod.json'), MAX_JSON);
    const meta = metaBuf ? parseJson(metaBuf) : null;
    if (!meta || typeof meta !== 'object') return { fabric: false };
    const authors = (Array.isArray(meta.authors) ? meta.authors : [])
      .map((a) => (typeof a === 'string' ? a : a && a.name)).map((a) => str(a, 40)).filter(Boolean).slice(0, 4);
    let icon = null;
    const iconPath = pickIcon(meta.icon).replace(/^\/+/, '');
    if (iconPath) {
      const ib = readEntry(fd, entries.get(iconPath), MAX_ICON);
      if (ib && ib.length > 33 && ib.subarray(0, 8).equals(PNG_SIG)) icon = 'data:image/png;base64,' + ib.toString('base64');
    }
    return { fabric: true, id: str(meta.id, 64), name: str(meta.name, 60), version: str(meta.version, 40), authors, icon };
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  }
}

function createMods() {
  const cache = new Map();   // path|mtime|size -> info

  function info(full, st) {
    const k = full + '|' + st.mtimeMs + '|' + st.size;
    if (!cache.has(k)) {
      if (cache.size > 2000) cache.clear();
      cache.set(k, readJarInfo(full));
    }
    return cache.get(k);
  }

  function list(modsDir) {
    let names;
    try { names = fs.readdirSync(modsDir); } catch (_) { return []; }
    const out = [];
    for (const file of names) {
      if (!FILE_RE.test(file)) continue;
      const full = path.join(modsDir, file);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (!st.isFile()) continue;
      const locked = LOCKED.has(file.toLowerCase());
      const enabled = locked || !/\.disabled$/i.test(file);
      const base = file.replace(/\.disabled$/i, '').replace(/\.jar$/i, '');
      const i = info(full, st) || {};
      out.push({
        file, enabled, locked, size: st.size,
        name: i.name || i.id || base,
        id: i.id || '',
        version: i.version || '',
        authors: i.authors || [],
        icon: i.icon || null,
        fabric: i.fabric !== false
      });
      if (out.length >= MAX_MODS) break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return out;
  }

  function toggle(modsDir, file) {
    if (typeof file !== 'string' || !FILE_RE.test(file) || path.basename(file) !== file) return { ok: false, error: 'Invalid mod file.' };
    if (LOCKED.has(file.toLowerCase())) return { ok: false, error: 'Op Client is part of Op Launcher and cannot be turned off.' };
    const from = path.join(modsDir, file);
    const enable = /\.disabled$/i.test(file);
    const to = path.join(modsDir, enable ? file.replace(/\.disabled$/i, '') : file + '.disabled');
    if (!fs.existsSync(from)) return { ok: false, error: 'That mod file is gone. Refresh the list.' };
    if (fs.existsSync(to)) return { ok: false, error: 'A file with the same name already exists.' };
    try { fs.renameSync(from, to); } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      return { ok: false, error: busy ? 'The mod is in use. Close the game first.' : 'Could not change the mod.' };
    }
    return { ok: true, enabled: enable };
  }

  return { list, toggle };
}

module.exports = { createMods };
