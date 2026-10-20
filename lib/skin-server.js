'use strict';
// Local "skin server" for offline accounts.
// Minecraft only shows custom skins when a Yggdrasil-style session server tells it where the skin is.
// authlib-injector (a java agent) points the game at this tiny server on 127.0.0.1 instead of Mojang,
// and this server answers with the player's skin. It only listens on the loopback interface, only while the game runs.

const http = require('http');
const crypto = require('crypto');

function createSkinServer({ uuid, name, skin, slim, host = '127.0.0.1' }) {
  const id = String(uuid).replace(/-/g, '').toLowerCase();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const hash = crypto.createHash('sha256').update(skin).digest('hex');
  let base = '';

  function profile(signed) {
    const textures = {
      timestamp: Date.now(),
      profileId: id,
      profileName: name,
      textures: { SKIN: { url: `${base}/textures/${hash}.png`, ...(slim ? { metadata: { model: 'slim' } } : {}) } }
    };
    const value = Buffer.from(JSON.stringify(textures)).toString('base64');
    const prop = { name: 'textures', value };
    if (signed) prop.signature = crypto.sign('RSA-SHA1', Buffer.from(value), privateKey).toString('base64');
    return { id, name, properties: [prop] };
  }

  function send(res, status, body, type) {
    const buf = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    res.writeHead(status, buf ? { 'content-type': type || 'application/json; charset=utf-8', 'content-length': buf.length } : {});
    res.end(buf);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    req.resume();
    if (req.method === 'GET' && p === '/') {
      return send(res, 200, {
        meta: { serverName: 'Op Launcher', implementationName: 'op-launcher', implementationVersion: '1', 'feature.no_mojang_namespace': true },
        skinDomains: [host],
        signaturePublickey: publicPem
      });
    }
    let m = /^\/sessionserver\/session\/minecraft\/profile\/([0-9a-fA-F-]+)$/.exec(p);
    if (req.method === 'GET' && m) {
      if (m[1].replace(/-/g, '').toLowerCase() !== id) return send(res, 204, null);
      return send(res, 200, profile(url.searchParams.get('unsigned') === 'false'));
    }
    m = /^\/textures\/([0-9a-f]{64})\.png$/.exec(p);
    if (req.method === 'GET' && m) {
      if (m[1] !== hash) return send(res, 404, { error: 'Not found' });
      return send(res, 200, skin, 'image/png');
    }
    if (p === '/sessionserver/session/minecraft/join' || p === '/sessionserver/session/minecraft/hasJoined') return send(res, 204, null);
    if (p === '/api/profiles/minecraft') return send(res, 200, []);
    if (p.startsWith('/minecraftservices/')) return send(res, 401, { error: 'Unauthorized' });
    return send(res, 404, { error: 'Not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      base = `http://${host}:${server.address().port}`;
      resolve({
        url: base,
        publicKey: publicPem,
        close() {
          try { server.close(); } catch (_) { /* already closed */ }
          if (server.closeAllConnections) server.closeAllConnections();
        }
      });
    });
  });
}

module.exports = { createSkinServer };
