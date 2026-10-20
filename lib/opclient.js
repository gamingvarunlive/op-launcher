'use strict';
// Installs the optional "Op Client" in-game mod (built from /mod) into a profile's mods folder.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// dir: folder with opclient.jar + opclient.json ({ "versions": ["1.21.11"] })
function ensureClientMod({ dir, modsDir, version }) {
  const jar = path.join(dir, 'opclient.jar');
  if (!fs.existsSync(jar)) return { installed: false, reason: 'not-built' };
  let versions = [];
  try { versions = JSON.parse(fs.readFileSync(path.join(dir, 'opclient.json'), 'utf8')).versions; } catch (_) { /* no list */ }
  if (!Array.isArray(versions) || !versions.includes(version)) return { installed: false, reason: 'unsupported-version' };
  const dest = path.join(modsDir, 'opclient.jar');
  try {
    fs.mkdirSync(modsDir, { recursive: true });
    // Op Client is part of the launcher: a disabled copy is switched back on
    try { fs.rmSync(dest + '.disabled', { force: true }); } catch (_) { /* best effort */ }
    const src = fs.readFileSync(jar);
    if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(src)) return { installed: true, reason: 'up-to-date' };
    fs.writeFileSync(dest + '.part', src);
    fs.renameSync(dest + '.part', dest);
    return { installed: true, reason: 'copied' };
  } catch (err) {
    return { installed: false, reason: 'error', error: err.message };
  }
}

module.exports = { ensureClientMod };
