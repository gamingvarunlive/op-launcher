'use strict';
// Modrinth browsing + one-click install into a profile's mods folder.
// Only Fabric mods for the profile's Minecraft version are shown. Files are downloaded over https from
// Modrinth's CDN, checked against the published SHA-512 and written atomically.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.modrinth.com/v2';
const SORTS = { relevance: 'relevance', downloads: 'downloads', follows: 'follows', newest: 'newest', updated: 'updated' };
const FILE_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,200}\.jar$/i;
const ID_RE = /^[A-Za-z0-9]{6,16}$/;
const VER_RE = /^[0-9A-Za-z.\-+_]{1,24}$/;
const MAX_FILE = 120 * 1024 * 1024;
const MAX_DEPTH = 3;

function createModrinth({ api = API, userAgent = 'OpLauncher/1.0 (Minecraft launcher)', allowedHosts = ['cdn.modrinth.com'], fetchImpl, timeoutMs = 15000, testMode = false } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const base = String(api).replace(/\/+$/, '');

  async function getJson(url) {
    let res;
    try { res = await doFetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (_) { const e = new Error('Cannot reach Modrinth. Check your internet.'); e.network = true; throw e; }
    if (res.status === 429) throw new Error('Modrinth is busy. Try again in a moment.');
    if (!res.ok) throw new Error('Modrinth error (' + res.status + ').');
    try { return await res.json(); } catch (_) { throw new Error('Modrinth sent an unexpected answer.'); }
  }

  // ---- installed record: projectId -> filename ----
  const recFile = (profileDir) => path.join(profileDir, 'op-mods.json');
  function readRec(profileDir) {
    try { const r = JSON.parse(fs.readFileSync(recFile(profileDir), 'utf8')); return r && typeof r === 'object' ? r : {}; } catch (_) { return {}; }
  }
  function writeRec(profileDir, rec) {
    try { fs.writeFileSync(recFile(profileDir) + '.tmp', JSON.stringify(rec)); fs.renameSync(recFile(profileDir) + '.tmp', recFile(profileDir)); } catch (_) { /* best effort */ }
  }
  function isInstalled(profileDir, modsDir, id, rec) {
    const f = rec[id];
    if (typeof f !== 'string' || !FILE_RE.test(f)) return false;
    return fs.existsSync(path.join(modsDir, f)) || fs.existsSync(path.join(modsDir, f + '.disabled'));
  }

  async function search({ query, sort, offset, limit, version, profileDir, modsDir }) {
    if (!VER_RE.test(String(version))) throw new Error('Select a profile first.');
    const lim = [10, 20, 50].includes(Number(limit)) ? Number(limit) : 20;
    const off = Math.max(0, Math.min(9900, Math.floor(Number(offset)) || 0));
    const facets = JSON.stringify([['project_type:mod'], ['categories:fabric'], ['versions:' + version]]);
    const q = String(query || '').slice(0, 80);
    const url = base + '/search?query=' + encodeURIComponent(q) + '&facets=' + encodeURIComponent(facets) +
      '&index=' + (SORTS[sort] || 'relevance') + '&limit=' + lim + '&offset=' + off;
    const r = await getJson(url);
    const rec = profileDir ? readRec(profileDir) : {};
    const hits = (Array.isArray(r.hits) ? r.hits : []).map((h) => {
      const pid = String(h.project_id || '');
      const cs = h.client_side, ss = h.server_side;
      const clientOk = cs !== 'unsupported', serverOk = ss !== 'unsupported';
      return {
        id: pid,
        title: String(h.title || h.slug || 'Mod').slice(0, 80),
        author: String(h.author || '').slice(0, 40),
        description: String(h.description || '').slice(0, 240),
        icon: typeof h.icon_url === 'string' && /^https:\/\//.test(h.icon_url) ? h.icon_url : null,
        downloads: Number(h.downloads) || 0,
        follows: Number(h.follows) || 0,
        updated: String(h.date_modified || ''),
        side: clientOk && serverOk ? 'Client or server' : clientOk ? 'Client' : 'Server',
        tags: (Array.isArray(h.display_categories) ? h.display_categories : (Array.isArray(h.categories) ? h.categories : []))
          .filter((c) => typeof c === 'string' && c !== 'fabric').slice(0, 3),
        installed: !!(ID_RE.test(pid) && modsDir && isInstalled(profileDir, modsDir, pid, rec))
      };
    });
    return { hits, total: Number(r.total_hits) || 0, offset: off, limit: lim };
  }

  async function pickVersion(projectId, mcVersion) {
    const url = base + '/project/' + projectId + '/version?loaders=' + encodeURIComponent('["fabric"]') +
      '&game_versions=' + encodeURIComponent(JSON.stringify([mcVersion]));
    const list = await getJson(url);
    const rank = { release: 0, beta: 1, alpha: 2 };
    const v = (Array.isArray(list) ? list : []).filter((x) => x && Array.isArray(x.files) && x.files.length)
      .sort((a, b) => (rank[a.version_type] ?? 3) - (rank[b.version_type] ?? 3))[0];   // API lists newest first; prefer stable
    return v || null;
  }

  async function download(file, dest) {
    let u;
    try { u = new URL(file.url); } catch (_) { throw new Error('Bad download link.'); }
    if (!(u.protocol === 'https:' || (testMode && u.protocol === 'http:'))) throw new Error('Refusing a non-https download.');
    if (!allowedHosts.includes(u.host)) throw new Error('Refusing a download from ' + u.host + '.');
    let res;
    try { res = await doFetch(file.url, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(120000) }); }
    catch (_) { const e = new Error('Download failed. Check your internet.'); e.network = true; throw e; }
    if (!res.ok) throw new Error('Download failed (' + res.status + ').');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE) throw new Error('That file is too large.');
    if (Number.isFinite(file.size) && file.size > 0 && buf.length !== file.size) throw new Error('Download was incomplete. Try again.');
    const want = file.hashes && file.hashes.sha512;
    if (want && crypto.createHash('sha512').update(buf).digest('hex') !== String(want).toLowerCase()) throw new Error('Download failed its safety check. Try again.');
    if (!want) throw new Error('This file has no checksum, so it was not installed.');
    const part = dest + '.part';
    fs.writeFileSync(part, buf);
    fs.renameSync(part, dest);
  }

  // Installs a project and its required dependencies. Returns the list of installed jar names.
  async function install({ projectId, version, profileDir, modsDir }) {
    if (!ID_RE.test(String(projectId))) throw new Error('Invalid mod.');
    if (!VER_RE.test(String(version))) throw new Error('Select a profile first.');
    fs.mkdirSync(modsDir, { recursive: true });
    const rec = readRec(profileDir);
    const done = [];
    const seen = new Set();

    async function one(pid, depth, isRoot) {
      if (seen.has(pid)) return;
      seen.add(pid);
      if (!isRoot && isInstalled(profileDir, modsDir, pid, rec)) return;
      const v = await pickVersion(pid, version);
      if (!v) {
        if (isRoot) throw new Error('No Fabric version of this mod for Minecraft ' + version + '.');
        return;   // a dependency we cannot resolve: the game will say so itself
      }
      const f = v.files.find((x) => x && x.primary) || v.files[0];
      const name = path.basename(String(f.filename || ''));
      if (!FILE_RE.test(name)) throw new Error('Unexpected file name from Modrinth.');
      const dest = path.join(modsDir, name);
      if (!fs.existsSync(dest) && !fs.existsSync(dest + '.disabled')) { await download(f, dest); done.push(name); }
      rec[pid] = name;
      if (depth < MAX_DEPTH) {
        for (const d of Array.isArray(v.dependencies) ? v.dependencies : []) {
          if (d && d.dependency_type === 'required' && ID_RE.test(String(d.project_id))) await one(d.project_id, depth + 1, false);
        }
      }
    }
    try { await one(projectId, 0, true); } finally { writeRec(profileDir, rec); }
    return done;
  }

  return { search, install };
}

module.exports = { createModrinth };
