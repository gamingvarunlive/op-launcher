'use strict';
const { createXmlFilter } = require('./log4j');
const { ensureClientMod } = require('./opclient');
// Op Launcher launch engine.
//
// Everything is downloaded from the official sources:
//   - game files / libraries / assets / Java runtime : Mojang
//   - Fabric loader                                  : Fabric meta + maven
// Accounts are offline (username only). Pure Node (no Electron imports) so it can be tested.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { createSkinServer } = require('./skin-server');
const { isSlimSkin } = require('./png');

const DEFAULT_ENDPOINTS = {
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  fabricMeta: 'https://meta.fabricmc.net/v2',
  authlibLatest: 'https://authlib-injector.yushi.moe/artifact/latest.json',
  javaRuntimes: 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
  assetsBase: 'https://resources.download.minecraft.net'
};

// Messages in LaunchError are written for the user and shown as-is in the UI.
class LaunchError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function abortError() { const e = new Error('Aborted'); e.name = 'AbortError'; return e; }

// ---------------------------------------------------------------- platform
function detectPlatform() {
  const arch = process.arch;
  if (process.platform === 'win32') {
    return {
      os: 'windows',
      arch: arch === 'ia32' ? 'x86' : arch,
      osVersion: os.release(),
      runtimeKey: arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64',
      exe: 'bin/java.exe',
      pathSep: ';'
    };
  }
  if (process.platform === 'linux') {
    return { os: 'linux', arch, osVersion: os.release(), runtimeKey: arch === 'ia32' ? 'linux-i386' : 'linux', exe: 'bin/java', pathSep: ':' };
  }
  return { os: 'osx', arch, osVersion: os.release(), runtimeKey: '', exe: '', pathSep: ':', unsupported: true };
}

// ---------------------------------------------------------------- pure helpers
// Mojang rule evaluation: the last matching rule decides; no rules = allowed.
function rulesAllow(rules, platform, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== platform.os) match = false;
      if (r.os.arch && r.os.arch !== platform.arch) match = false;
      if (r.os.version && !new RegExp(r.os.version).test(platform.osVersion || '')) match = false;
    }
    if (r.features) {
      for (const k of Object.keys(r.features)) {
        if (!!features[k] !== !!r.features[k]) match = false;
      }
    }
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

function substitute(str, vars) {
  return String(str).replace(/\$\{([^}]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

function expandArgs(list, vars, platform, features) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') out.push(substitute(a, vars));
    else if (a && rulesAllow(a.rules, platform, features)) {
      for (const v of Array.isArray(a.value) ? a.value : [a.value]) out.push(substitute(v, vars));
    }
  }
  return out;
}

// Same UUID Java's UUID.nameUUIDFromBytes("OfflinePlayer:<name>") gives (what vanilla offline mode uses).
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// "group:artifact:version[:classifier][@ext]" -> maven repo relative path
function mavenPath(name) {
  let ext = 'jar';
  let n = String(name);
  const at = n.indexOf('@');
  if (at !== -1) { ext = n.slice(at + 1); n = n.slice(0, at); }
  const [group, artifact, version, classifier] = n.split(':');
  if (!group || !artifact || !version) throw new LaunchError('Bad library name in game data: ' + name);
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function libraryKey(lib) {
  const parts = String(lib.name || '').split('@')[0].split(':');
  return parts.length >= 3 ? [parts[0], parts[1], parts[3] || ''].join(':') : String(lib.name);
}

// Child (Fabric) libraries come first and win over the vanilla ones with the same group:artifact.
function mergeVersions(parent, child) {
  const seen = new Set();
  const libraries = [];
  for (const lib of [...(child.libraries || []), ...(parent.libraries || [])]) {
    const key = libraryKey(lib);
    if (seen.has(key)) continue;
    seen.add(key);
    libraries.push(lib);
  }
  const pa = parent.arguments || {};
  const ca = child.arguments || {};
  return {
    ...parent,
    ...child,
    id: child.id,
    mainClass: child.mainClass || parent.mainClass,
    libraries,
    arguments: pa.jvm || pa.game || ca.jvm || ca.game
      ? { jvm: [...(pa.jvm || []), ...(ca.jvm || [])], game: [...(pa.game || []), ...(ca.game || [])] }
      : undefined
  };
}

function libraryArtifact(lib) {
  const art = lib.downloads && lib.downloads.artifact;
  if (art && art.url) return { path: art.path || mavenPath(lib.name), url: art.url, sha1: art.sha1, size: art.size };
  if (lib.name && lib.url) {
    const rel = mavenPath(lib.name);
    return { path: rel, url: lib.url.replace(/\/?$/, '/') + rel, sha1: lib.sha1, size: lib.size };
  }
  return null;
}

function safeJoin(base, rel) {
  const full = path.resolve(base, String(rel));
  const root = path.resolve(base) + path.sep;
  if (!full.startsWith(root)) throw new LaunchError('Unsafe path in game data: ' + rel);
  return full;
}

function fmtMB(bytes) { return (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1) + ' MB'; }

// Builds the full java argument list. Exported for tests.
function buildLaunchArgs({ merged, vars, ramMB, platform, logArg }) {
  let jvm;
  let game;
  if (merged.arguments) {
    jvm = expandArgs(merged.arguments.jvm, vars, platform);
    game = expandArgs(merged.arguments.game, vars, platform);
  } else {
    // very old format (1.12 and below), kept for completeness
    jvm = ['-Djava.library.path=' + vars.natives_directory, '-cp', vars.classpath];
    game = String(merged.minecraftArguments || '').split(' ').filter(Boolean).map((a) => substitute(a, vars));
  }
  const tuning = [
    '-Xmx' + ramMB + 'M',
    '-Xms' + Math.min(512, ramMB) + 'M',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UseG1GC',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=50',
    '-XX:G1HeapRegionSize=32M'
  ];
  return [...tuning, ...jvm, ...(logArg ? [logArg] : []), merged.mainClass, ...game];
}

// ---------------------------------------------------------------- engine
function createLauncher(opts = {}) {
  const endpoints = { ...DEFAULT_ENDPOINTS, ...(opts.endpoints || {}) };
  const platform = opts.platform || detectPlatform();
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const spawnFn = opts.spawnFn || spawn;
  const allowInsecure = !!opts.allowInsecure; // tests only: lets the mock server use http
  const concurrency = opts.concurrency || 16;
  const launcherName = opts.launcherName || 'OpLauncher';
  const launcherVersion = opts.launcherVersion || '0.1.0';
  const startTimeoutMs = opts.startTimeoutMs || 45000;

  let state = 'idle'; // idle | busy | running
  let currentProfileId = null;
  let lastEvent = null;
  let abort = null;
  let child = null;
  let emitFn = () => {};

  // Console output (launcher steps + game log), kept so the UI can show it after a reload
  const logBuf = [];
  const MAX_LOG_LINES = 4000;
  let stopping = false;
  let logSeq = 0;   // total lines of this session; lets a freshly opened console window skip what it already has
  function logLines(lines) {
    if (!lines.length) return;
    for (const l of lines) logBuf.push(l);
    logSeq += lines.length;
    if (logBuf.length > MAX_LOG_LINES) logBuf.splice(0, logBuf.length - MAX_LOG_LINES);
    emit({ type: 'log', lines, seq: logSeq });
  }
  const sys = (text) => logLines(['[Op Launcher] ' + text]);

  function emit(ev) {
    if (ev.type !== 'log') lastEvent = ev;
    try { emitFn(ev); } catch (err) { console.error('launch event handler failed:', err); }
  }

  function assertUrl(u) {
    if (typeof u !== 'string' || !(/^https:\/\//.test(u) || (allowInsecure && /^http:\/\//.test(u)))) {
      throw new LaunchError('Refusing to download from an unsafe address.');
    }
  }

  function withTimeout(signal, ms) {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  }

  async function fetchJson(url, signal) {
    assertUrl(url);
    const res = await fetchFn(url, { signal: withTimeout(signal, 30000) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  async function readJson(file) {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  }

  async function validFile(dest, size) {
    try {
      const st = await fsp.stat(dest);
      return st.isFile() && (size == null || st.size === size);
    } catch (_) { return false; }
  }

  // Verified-size ledger: if a file passed its sha1 check but the server's declared size differs from the
  // real size, remember the real size so the file is not treated as "missing" on every launch.
  let ledger = { files: {} };
  let ledgerFile = null;
  let gameRoot = null;
  let diagFile = null;
  const relOf = (dest) => path.relative(gameRoot || '', dest);
  function diag(msg) {
    if (!diagFile) return;
    try { fs.appendFileSync(diagFile, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) { /* logging is best effort */ }
  }
  async function loadLedger(gameDir, logsDir) {
    gameRoot = gameDir;
    ledgerFile = path.join(gameDir, 'op-verified.json');
    await fsp.mkdir(logsDir, { recursive: true });
    diagFile = path.join(logsDir, 'launcher.log');
    try { fs.writeFileSync(diagFile, ''); } catch (_) { diagFile = null; }
    try {
      const j = await readJson(ledgerFile);
      ledger = j && typeof j.files === 'object' && j.files ? j : { files: {} };
    } catch (_) { ledger = { files: {} }; }
  }
  function noteDownloaded(t) {
    if (t.size == null) return;
    try {
      const real = fs.statSync(t.dest).size;
      if (real !== t.size) { ledger.files[relOf(t.dest)] = real; ledger.dirty = true; diag('size differs from server (' + real + ' vs ' + t.size + '), accepted after checksum: ' + relOf(t.dest)); }
    } catch (_) { /* file vanished: will be re-planned */ }
  }
  async function saveLedger() {
    if (!ledger.dirty || !ledgerFile) return;
    const data = { files: ledger.files };
    ledger.dirty = false;
    try { await fsp.writeFile(ledgerFile, JSON.stringify(data)); } catch (_) { /* best effort */ }
  }
  async function isGood(t) {
    try {
      const st = await fsp.stat(t.dest);
      if (!st.isFile()) return false;
      if (t.size == null || st.size === t.size) return true;
      if (ledger.files[relOf(t.dest)] === st.size) return true;
      diag('wrong size: ' + relOf(t.dest) + ' is ' + st.size + ', expected ' + t.size);
      return false;
    } catch (_) { diag('missing: ' + relOf(t.dest)); return false; }
  }

  // One file, with retries, sha1 check and a .part temp file.
  async function downloadFile(task, signal, onBytes) {
    assertUrl(task.url);
    await fsp.mkdir(path.dirname(task.dest), { recursive: true });
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal.aborted) throw abortError();
      const tmp = task.dest + '.part';
      let got = 0;
      try {
        const res = await fetchFn(task.url, { signal });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + task.url);
        const hash = crypto.createHash(task.sha256 ? 'sha256' : 'sha1');
        const meter = new Transform({
          transform(chunk, _enc, cb) { hash.update(chunk); got += chunk.length; onBytes(chunk.length); cb(null, chunk); }
        });
        await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp), { signal });
        const want = task.sha256 || task.sha1;
        if (want && hash.digest('hex') !== String(want).toLowerCase()) {
          throw new Error('Checksum mismatch for ' + path.basename(task.dest));
        }
        await fsp.rename(tmp, task.dest);
        return;
      } catch (err) {
        onBytes(-got);
        try { await fsp.unlink(tmp); } catch (_) { /* nothing to clean */ }
        if (signal.aborted) throw abortError();
        lastErr = err;
        if (attempt < 3) await sleep(300 * attempt);
      }
    }
    throw lastErr;
  }

  async function downloadAll(tasks, signal, onBytes, onFile) {
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort();
    signal.addEventListener('abort', onOuterAbort);
    let next = 0;
    let firstError = null;
    const worker = async () => {
      while (!ctrl.signal.aborted) {
        const i = next++;
        if (i >= tasks.length) return;
        try {
          await downloadFile(tasks[i], ctrl.signal, onBytes);
          onFile(tasks[i]);
        } catch (err) {
          if (!firstError) firstError = err;
          ctrl.abort();
          return;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
    }
    if (signal.aborted) throw abortError();
    if (firstError) throw firstError;
  }

  // ------------------------------------------------ version data (vanilla + Fabric)
  async function loadVersions(mc, dirs, signal) {
    const vanillaFile = path.join(dirs.versions, mc, mc + '.json');
    const recordFile = path.join(dirs.versions, mc, 'op-fabric.json');

    // Fast path: already prepared once, works fully offline.
    try {
      const rec = await readJson(recordFile);
      const vanilla = await readJson(vanillaFile);
      const fabric = await readJson(path.join(dirs.versions, rec.fabricId, rec.fabricId + '.json'));
      if (vanilla.id === mc && fabric.inheritsFrom === mc) return { vanilla, fabric };
    } catch (_) { /* not cached yet */ }

    const manifest = await fetchJson(endpoints.versionManifest, signal);
    const entry = (manifest.versions || []).find((v) => v.id === mc);
    if (!entry) throw new LaunchError(`Minecraft ${mc} was not found in Mojang's version list.`);
    const vanilla = await fetchJson(entry.url, signal);

    const loaders = await fetchJson(`${endpoints.fabricMeta}/versions/loader/${encodeURIComponent(mc)}`, signal);
    const list = Array.isArray(loaders) ? loaders : [];
    const pick = list.find((l) => l.loader && l.loader.stable) || list[0];
    if (!pick || !pick.loader) throw new LaunchError(`Fabric does not support Minecraft ${mc} yet.`);
    const fabric = await fetchJson(
      `${endpoints.fabricMeta}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(pick.loader.version)}/profile/json`,
      signal
    );
    if (!fabric.id || !/^[0-9A-Za-z._+-]+$/.test(fabric.id)) throw new LaunchError('Fabric returned an invalid version name.');

    await fsp.mkdir(path.dirname(vanillaFile), { recursive: true });
    await fsp.mkdir(path.join(dirs.versions, fabric.id), { recursive: true });
    await fsp.writeFile(vanillaFile, JSON.stringify(vanilla));
    await fsp.writeFile(path.join(dirs.versions, fabric.id, fabric.id + '.json'), JSON.stringify(fabric));
    await fsp.writeFile(recordFile, JSON.stringify({ fabricId: fabric.id, loader: pick.loader.version }));
    return { vanilla, fabric };
  }

  // ------------------------------------------------ planning
  async function planJava(component, dirs, signal) {
    const root = path.join(dirs.runtime, component, platform.runtimeKey, component);
    const javaExe = path.join(root, platform.exe);
    const marker = path.join(root, '.op-complete');
    if ((await validFile(marker)) && (await validFile(javaExe))) return { javaExe, tasks: [], finalize: async () => {} };

    const all = await fetchJson(endpoints.javaRuntimes, signal);
    const entry = all && all[platform.runtimeKey] && all[platform.runtimeKey][component] && all[platform.runtimeKey][component][0];
    if (!entry || !entry.manifest) throw new LaunchError(`The Java runtime this version needs (${component}) is not available for this PC.`);
    const manifest = await fetchJson(entry.manifest.url, signal);

    const tasks = [];
    const executables = [];
    for (const [rel, f] of Object.entries(manifest.files || {})) {
      if (f.type !== 'file' || !f.downloads || !f.downloads.raw) continue; // directories are created on demand
      const dest = safeJoin(root, rel);
      tasks.push({ url: f.downloads.raw.url, dest, sha1: f.downloads.raw.sha1, size: f.downloads.raw.size });
      if (f.executable) executables.push(dest);
    }
    return {
      javaExe,
      tasks,
      finalize: async () => {
        if (platform.os !== 'windows') for (const e of executables) { try { await fsp.chmod(e, 0o755); } catch (_) { /* best effort */ } }
        if (!(await validFile(javaExe))) throw new LaunchError('Java was downloaded but could not be found.');
        await fsp.writeFile(marker, String(entry.version && entry.version.name || component));
      }
    };
  }

  async function pending(tasks) {
    const out = [];
    const seenDest = new Set();
    for (const t of tasks) {
      if (seenDest.has(t.dest)) continue;   // never download the same file twice at once
      seenDest.add(t.dest);
      if (!(await isGood(t))) out.push(t);
    }
    return out;
  }

  async function prepare(profile, settings, signal) {
    const mc = profile.version;
    if (!/^[0-9A-Za-z._-]+$/.test(String(mc))) throw new LaunchError('Invalid Minecraft version.');
    if (!settings.gameDir || !path.isAbsolute(settings.gameDir)) throw new LaunchError('Pick a game directory in Settings first.');

    const gameDir = settings.gameDir;
    const dirs = {
      versions: path.join(gameDir, 'versions'),
      libraries: path.join(gameDir, 'libraries'),
      assets: path.join(gameDir, 'assets'),
      runtime: path.join(gameDir, 'runtime'),
      logs: path.join(gameDir, 'logs'),
      profile: safeJoin(path.join(gameDir, 'profiles'), profile.id)
    };
    await fsp.mkdir(dirs.versions, { recursive: true });
    await fsp.mkdir(path.join(dirs.profile, 'mods'), { recursive: true });
    await loadLedger(gameDir, dirs.logs);

    const { vanilla, fabric } = await loadVersions(mc, dirs, signal);
    const merged = mergeVersions(vanilla, fabric);
    if (!merged.mainClass || !merged.downloads || !merged.downloads.client || !merged.assetIndex) {
      throw new LaunchError('The game data for this version is incomplete.');
    }

    // Java
    const component = (vanilla.javaVersion && vanilla.javaVersion.component) || 'jre-legacy';
    const java = await planJava(component, dirs, signal);

    // Libraries, client jar, logging config
    const libTasks = [];
    const classpath = [];
    for (const lib of merged.libraries) {
      if (!rulesAllow(lib.rules, platform)) continue;
      const art = libraryArtifact(lib);
      if (!art) continue;
      const dest = safeJoin(dirs.libraries, art.path);
      classpath.push(dest);
      libTasks.push({ url: art.url, dest, sha1: art.sha1, size: art.size });
    }
    const client = merged.downloads.client;
    const clientJar = path.join(dirs.versions, mc, mc + '.jar');
    libTasks.push({ url: client.url, dest: clientJar, sha1: client.sha1, size: client.size });
    classpath.push(clientJar);

    let logArg = null;
    const logCfg = merged.logging && merged.logging.client;
    if (logCfg && logCfg.file && logCfg.file.url && /^[0-9A-Za-z._-]+$/.test(String(logCfg.file.id)) && logCfg.argument) {
      const dest = path.join(dirs.assets, 'log_configs', logCfg.file.id);
      libTasks.push({ url: logCfg.file.url, dest, sha1: logCfg.file.sha1, size: logCfg.file.size });
      logArg = substitute(logCfg.argument, { path: dest });
    }

    // Assets
    const ai = merged.assetIndex;
    if (!/^[0-9A-Za-z._-]+$/.test(String(ai.id))) throw new LaunchError('Invalid asset index name.');
    const idxPath = path.join(dirs.assets, 'indexes', ai.id + '.json');
    let idx;
    const idxTask = { url: ai.url, dest: idxPath, sha1: ai.sha1, size: ai.size };
    if (await isGood(idxTask)) idx = await readJson(idxPath);
    else {
      await downloadFile(idxTask, signal, () => {});
      noteDownloaded(idxTask);
      idx = await readJson(idxPath);
    }
    const assetTasks = [];
    const seen = new Set();
    for (const obj of Object.values(idx.objects || {})) {
      if (!obj || !/^[0-9a-f]{40}$/.test(String(obj.hash)) || seen.has(obj.hash)) continue;
      seen.add(obj.hash);
      const two = obj.hash.slice(0, 2);
      assetTasks.push({
        url: `${endpoints.assetsBase}/${two}/${obj.hash}`,
        dest: path.join(dirs.assets, 'objects', two, obj.hash),
        sha1: obj.hash,
        size: obj.size
      });
    }

    const groups = [
      { stage: 'java', text: 'Downloading Java runtime', tasks: await pending(java.tasks) },
      { stage: 'libraries', text: 'Downloading game libraries', tasks: await pending(libTasks) },
      { stage: 'assets', text: 'Downloading game assets', tasks: await pending(assetTasks) }
    ];

    diag('plan: java ' + groups[0].tasks.length + ' / libraries ' + groups[1].tasks.length + ' / assets ' + groups[2].tasks.length + ' files to download');

    // Launch arguments
    const nativesDir = path.join(dirs.versions, merged.id, 'natives');
    await fsp.mkdir(nativesDir, { recursive: true });
    const ramMB = Math.max(1024, Math.round((Number(settings.ramGB) || 3) * 1024));
    const vars = {
      auth_player_name: profile.username,
      version_name: merged.id,
      game_directory: dirs.profile,
      assets_root: dirs.assets,
      assets_index_name: ai.id,
      auth_uuid: offlineUuid(profile.username),
      auth_access_token: '0',
      clientid: '0',
      auth_xuid: '0',
      user_type: 'legacy',
      version_type: merged.type || 'release',
      natives_directory: nativesDir,
      launcher_name: launcherName,
      launcher_version: launcherVersion,
      classpath: classpath.join(platform.pathSep),
      classpath_separator: platform.pathSep,
      library_directory: dirs.libraries,
      user_properties: '{}',
      game_assets: dirs.assets,
      auth_session: '0'
    };
    const args = buildLaunchArgs({ merged, vars, ramMB, platform, logArg });

    return {
      groups,
      args,
      javaExe: java.javaExe,
      finalize: java.finalize,
      profileDir: dirs.profile,
      logDir: dirs.logs
    };
  }

  // ------------------------------------------------ download phase with progress
  async function download(plan, signal) {
    const groups = plan.groups.filter((g) => g.tasks.length);
    const totalFiles = groups.reduce((n, g) => n + g.tasks.length, 0);
    const totalBytes = groups.reduce((n, g) => n + g.tasks.reduce((s, t) => s + (t.size || 0), 0), 0);
    let doneFiles = 0;
    let doneBytes = 0;
    let lastEmit = 0;
    const samples = [];

    const report = (g, force) => {
      const now = Date.now();
      if (!force && now - lastEmit < 120) return;
      lastEmit = now;
      samples.push([now, doneBytes]);
      while (samples.length > 2 && now - samples[0][0] > 2500) samples.shift();
      let speed = 0;
      if (samples.length > 1) {
        const [t0, b0] = samples[0];
        const [t1, b1] = samples[samples.length - 1];
        if (t1 > t0) speed = ((b1 - b0) / (t1 - t0)) * 1000;
      }
      const frac = totalBytes > 0 ? doneBytes / totalBytes : doneFiles / Math.max(1, totalFiles);
      let detail = `${doneFiles.toLocaleString('en-US')} / ${totalFiles.toLocaleString('en-US')} files`;
      if (totalBytes > 0) detail += ` · ${fmtMB(Math.max(0, doneBytes))} / ${fmtMB(totalBytes)}`;
      if (speed > 50 * 1024) detail += ` · ${fmtMB(speed)}/s`;
      emit({
        type: 'progress', stage: g.stage, text: g.text,
        percent: Math.min(99, Math.max(0, Math.round(frac * 100))),
        detail, doneFiles, totalFiles, doneBytes, totalBytes
      });
    };

    try {
    for (const g of groups) {
      report(g, true);
      await downloadAll(
        g.tasks, signal,
        (n) => { doneBytes += n; report(g, false); },
        (t) => { noteDownloaded(t); doneFiles += 1; report(g, false); }
      );
      report(g, true);
      sys('Finished: ' + g.text.toLowerCase());
    }
    } finally { await saveLedger(); }
  }

  // ------------------------------------------------ custom skin (offline accounts)
  let skinServer = null;
  function closeSkin() {
    if (skinServer) { try { skinServer.close(); } catch (_) { /* already closed */ } skinServer = null; }
  }

  // authlib-injector is downloaded once from its official site and then reused (no network on later launches)
  async function ensureInjector(gameDir, signal) {
    const dir = path.join(gameDir, 'authlib-injector');
    const jar = path.join(dir, 'authlib-injector.jar');
    try {
      const st = await fsp.stat(jar);
      if (st.isFile() && st.size > 1024) return jar;
    } catch (_) { /* not downloaded yet */ }
    emit({ type: 'progress', stage: 'libraries', text: 'Downloading skin support', percent: null, detail: '' });
    sys('Downloading skin support (one time)...');
    const info = await fetchJson(endpoints.authlibLatest, signal);
    const sha256 = info && info.checksums && info.checksums.sha256;
    if (!info || typeof info.download_url !== 'string' || !/^[0-9a-f]{64}$/i.test(String(sha256 || ''))) {
      throw new Error('skin support download info is incomplete');
    }
    await downloadFile({ url: info.download_url, dest: jar, sha256 }, signal, () => {});
    return jar;
  }

  // Returns extra JVM arguments that make the game show the profile's custom skin. Never blocks the launch.
  async function setupSkin(profile, gameDir, skin, signal) {
    try {
      const jar = await ensureInjector(gameDir, signal);
      const slim = isSlimSkin(skin);
      closeSkin();
      skinServer = await createSkinServer({ uuid: offlineUuid(profile.username), name: profile.username, skin, slim });
      sys(`Custom skin ready (${slim ? 'slim' : 'classic'} model). Keep the launcher open while you play so the skin keeps showing.`);
      return [`-javaagent:${jar}=${skinServer.url}`, '-Dauthlibinjector.noShowServerName'];
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      closeSkin();
      sys('Could not apply your custom skin (' + ((err && err.message) || err) + '). The game will use a default skin.');
      return [];
    }
  }

  // ------------------------------------------------ game process
  function readTail(logPath) {
    try {
      const st = fs.statSync(logPath);
      const len = Math.min(st.size, 24 * 1024);
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
      const bad = [...lines].reverse().find((l) => /exception|error|could not|failed|unsupported/i.test(l));
      return (bad || lines[lines.length - 1] || '').trim().slice(0, 220);
    } catch (_) { return ''; }
  }

  function startGame(plan, profile) {
    fs.mkdirSync(plan.logDir, { recursive: true });
    const logPath = path.join(plan.logDir, 'launch-' + profile.id + '.log');
    const fd = fs.openSync(logPath, 'w');
    let proc;
    try {
      proc = spawnFn(plan.javaExe, plan.args, { cwd: plan.profileDir, stdio: ['ignore', fd, fd], windowsHide: true });
    } finally {
      fs.closeSync(fd); // the child keeps its own handle
    }
    child = proc;

    let started = false;
    let pos = 0;
    let rfd = null;
    let carry = '';
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    try { rfd = fs.openSync(logPath, 'r'); } catch (_) { rfd = null; }
    const t0 = Date.now();

    const markStarted = () => {
      if (started) return;
      started = true;
      state = 'running';
      emit({ type: 'running', pid: proc.pid, logPath });
    };
    // Reads whatever the game wrote since the last call and forwards it line by line
    const xml = createXmlFilter();
    const drain = (flush) => {
      if (rfd == null) return;
      try {
        for (let round = 0; round < 8; round++) {
          const size = fs.fstatSync(rfd).size;
          if (size <= pos) break;
          const len = Math.min(size - pos, 256 * 1024);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(rfd, buf, 0, len, pos);
          if (n <= 0) break;
          pos += n;
          const text = carry + decoder.write(buf.subarray(0, n));
          const parts = text.split('\n');
          carry = parts.pop();
          const lines = parts.map((l) => l.replace(/\r$/, ''));
          if (!started && /Backend library|OpenAL initialized|Reloading ResourceManager|Created: \d+x\d+/.test(text)) markStarted();
          logLines(lines.flatMap((l) => xml.push(l)));
        }
      } catch (_) { /* log not readable yet */ }
      if (flush && carry) { logLines(xml.push(carry.replace(/\r$/, ''))); carry = ''; }
      if (flush) logLines(xml.flush());
    };
    const stopPolling = () => {
      clearInterval(poll);
      if (rfd != null) { try { fs.closeSync(rfd); } catch (_) { /* closed */ } rfd = null; }
    };
    const poll = setInterval(() => {
      drain(false);
      if (!started && Date.now() - t0 > startTimeoutMs) markStarted();
    }, 300);

    proc.once('error', (err) => {
      closeSkin();
      stopPolling();
      child = null;
      state = 'idle';
      sys('Could not start Java: ' + err.message);
      emit({ type: 'error', message: 'Could not start Java: ' + err.message });
    });
    proc.once('exit', (code) => {
      closeSkin();
      drain(true);
      stopPolling();
      child = null;
      const line = readTail(logPath);
      const wasStarted = started;
      const userStopped = stopping;
      stopping = false;
      state = 'idle';
      sys(userStopped ? 'Game closed from the launcher.' : 'Game process ended (exit code ' + code + ').');
      if (!wasStarted && code !== 0 && !userStopped) {
        emit({ type: 'error', message: `Minecraft closed before it started (code ${code}).${line ? ' ' + line : ''}`, logPath });
      } else {
        const crashed = code !== 0 && !userStopped;
        emit({ type: 'exit', code, crashed, detail: crashed ? line : '', logPath });
      }
    });
  }

  // ------------------------------------------------ public api
  function friendly(err) {
    if (err instanceof LaunchError) return err.message;
    const code = (err && (err.code || (err.cause && err.cause.code))) || '';
    const msg = String((err && err.message) || err);
    if (/ENOSPC/.test(code)) return 'Not enough disk space in the game folder.';
    if (/EACCES|EPERM/.test(code)) return 'Op Launcher cannot write to the game folder. Pick another folder in Settings.';
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR/.test(code) || /fetch failed|timed out|timeout/i.test(msg)) {
      return 'Could not reach the download servers. Check your internet connection and try again.';
    }
    if (/Checksum mismatch/.test(msg)) return 'A downloaded file was corrupted. Please try again.';
    return 'Something went wrong: ' + msg;
  }

  async function run(profile, settings, skin, extraJvm, clientModDir) {
    const signal = abort.signal;
    try {
      logBuf.length = 0;
      logSeq = 0;
      stopping = false;
      sys(`Launching Minecraft ${profile.version} with Fabric as ${profile.username}`);
      emit({ type: 'progress', stage: 'prepare', text: 'Checking game files', percent: null, detail: '' });
      sys('Checking game files...');
      const plan = await prepare(profile, settings, signal);
      const todo = plan.groups.filter((g) => g.tasks.length);
      if (!todo.length) sys('All game files are already downloaded.');
      else for (const g of todo) sys(`${g.text}: ${g.tasks.length.toLocaleString('en-US')} file${g.tasks.length === 1 ? '' : 's'}`);
      await download(plan, signal);
      await plan.finalize();
      if (signal.aborted) throw abortError();
      if (clientModDir) {
        const r = ensureClientMod({ dir: clientModDir, modsDir: path.join(plan.profileDir, 'mods'), version: profile.version });
        if (r.reason === 'copied') sys('Installed Op Client (in-game extras).');
        else if (r.reason === 'error') sys('Could not install Op Client: ' + r.error);
        if (r.installed && extraJvm.length) plan.args.splice(2, 0, ...extraJvm);
      }
      if (skin) plan.args.splice(2, 0, ...(await setupSkin(profile, settings.gameDir, skin, signal)));
      emit({ type: 'progress', stage: 'launching', text: 'Starting Minecraft', percent: 100, detail: '' });
      sys('Starting Minecraft (' + path.basename(plan.javaExe) + ', ' + Math.round(Number(settings.ramGB) * 10) / 10 + ' GB RAM)');
      startGame(plan, profile);
    } catch (err) {
      state = 'idle';
      closeSkin();
      if (err && err.name === 'AbortError') { sys('Launch cancelled.'); emit({ type: 'cancelled' }); }
      else { const m = friendly(err); sys('ERROR: ' + m); emit({ type: 'error', message: m }); }
    }
  }

  function start({ profile, settings, skin, onEvent, extraJvm, clientModDir }) {
    if (state !== 'idle') return { ok: false, error: 'The game is already launching or running.' };
    if (platform.unsupported) return { ok: false, error: 'Op Launcher currently supports Windows only.' };
    state = 'busy';
    currentProfileId = profile.id;
    emitFn = onEvent || (() => {});
    abort = new AbortController();
    run(profile, settings, skin || null, extraJvm || [], clientModDir || null);
    return { ok: true };
  }

  return {
    start,
    cancel() {
      if (state === 'busy' && abort) { abort.abort(); return true; }
      return false;
    },
    // Closes the running game (the "Close Game" button)
    stop() {
      if (state === 'running' && child) { stopping = true; try { child.kill(); } catch (_) { /* already gone */ } return true; }
      return false;
    },
    getLog() { return { lines: logBuf.slice(), seq: logSeq }; },
    // lets the game keep running after the launcher exits
    detach() { if (child) child.unref(); },
    getStatus() { return { state, profileId: currentProfileId, lastEvent }; }
  };
}

module.exports = {
  createLauncher, LaunchError, DEFAULT_ENDPOINTS,
  // exported for tests
  rulesAllow, expandArgs, mergeVersions, buildLaunchArgs, offlineUuid, mavenPath, safeJoin, detectPlatform
};
