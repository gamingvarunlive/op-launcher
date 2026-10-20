'use strict';
// Minimal Discord Rich Presence client (no dependencies).
// Talks to the local Discord app over its IPC pipe and shows "Playing Op Launcher" on the user's profile.
// Nothing is sent anywhere except the Discord app running on the same PC.

const net = require('net');
const path = require('path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function defaultPipePaths() {
  const out = [];
  for (let i = 0; i < 10; i++) {
    if (process.platform === 'win32') out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    else {
      const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
      out.push(path.join(base, `discord-ipc-${i}`));
    }
  }
  return out;
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function createPresence({ clientId, pipePaths, retryMs = 15000, pid = process.pid } = {}) {
  let sock = null;
  let ready = false;
  let wanted = null;        // activity we want shown (null = nothing)
  let closed = false;
  let retryTimer = null;
  let connecting = false;
  let buf = Buffer.alloc(0);
  let nonce = 0;

  const paths = () => pipePaths || defaultPipePaths();

  function send(op, data) { try { if (sock && !sock.destroyed) sock.write(encode(op, data)); } catch (_) { /* socket gone */ } }

  function push() {
    if (!ready) return;
    send(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid, activity: wanted || null }, nonce: String(++nonce) });
  }

  function handleFrame(op, payload) {
    if (op === OP.PING) return send(OP.PONG, payload);
    if (op === OP.CLOSE) return drop();
    if (op === OP.FRAME && payload && payload.evt === 'READY') { ready = true; push(); }
  }

  function drop() {
    ready = false;
    if (sock) { try { sock.destroy(); } catch (_) { /* ignore */ } sock = null; }
    connecting = false;
    schedule();
  }

  function schedule() {
    if (closed || !wanted || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryMs);
    if (retryTimer.unref) retryTimer.unref();
  }

  function tryPath(list, i) {
    if (closed || i >= list.length) { connecting = false; schedule(); return; }
    const s = net.createConnection(list[i]);
    let opened = false;
    s.once('connect', () => {
      opened = true;
      sock = s;
      connecting = false;
      buf = Buffer.alloc(0);
      s.write(encode(OP.HANDSHAKE, { v: 1, client_id: String(clientId) }));
    });
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (len < 0 || len > 1 << 20) { drop(); return; }
        if (buf.length < 8 + len) break;
        let payload = null;
        try { payload = JSON.parse(buf.subarray(8, 8 + len).toString('utf8')); } catch (_) { payload = null; }
        buf = buf.subarray(8 + len);
        handleFrame(op, payload);
      }
    });
    s.on('error', () => { if (!opened) tryPath(list, i + 1); });
    s.on('close', () => { if (opened && sock === s) drop(); });
  }

  function connect() {
    if (closed || connecting || sock || !clientId) return;
    connecting = true;
    tryPath(paths(), 0);
  }

  return {
    // activity: { details, state, largeImage, largeText, smallImage, smallText, startedAt (ms) }
    setActivity(a) {
      if (!clientId) return;
      wanted = {
        details: a.details, state: a.state,
        timestamps: a.startedAt ? { start: Math.floor(a.startedAt / 1000) } : undefined,
        assets: {
          large_image: a.largeImage, large_text: a.largeText,
          ...(a.smallImage ? { small_image: a.smallImage, small_text: a.smallText } : {})
        },
        instance: false
      };
      if (ready) push(); else connect();
    },
    clear() {
      wanted = null;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (ready) push();
    },
    close() {
      closed = true;
      wanted = null;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (sock) { try { sock.destroy(); } catch (_) { /* ignore */ } sock = null; }
      ready = false;
    },
    isReady: () => ready
  };
}

module.exports = { createPresence, encode, OP };
