'use strict';
// Online friends: talks to the Op Launcher friend server (see /server).
// A player's account is the username of their selected profile; only the 8x8 face of their skin is shared.

const fs = require('fs');
const { headPng } = require('./png');

function createSocial({ baseUrl, store, defaultSkinPath, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const configured = /^https?:\/\/[^\s]+$/.test(base);
  const registered = new Map();      // lower name -> head hash that the server already has

  function headFor(profile) {
    let buf = store.skinBuffer(profile.id);
    if (!buf) { try { buf = fs.readFileSync(defaultSkinPath); } catch (_) { buf = null; } }
    const png = buf ? headPng(buf) : null;
    return png ? png.toString('base64') : null;
  }

  async function call(route, body, user, token) {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-user'] = user;
    if (token) headers['x-token'] = token;
    let res;
    try {
      res = await doFetch(base + '/v1/' + route, { method: 'POST', headers, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(8000) });
    } catch (_) {
      const e = new Error('Cannot reach the friend server. Check your internet.'); e.network = true; throw e;
    }
    let json = null;
    try { json = await res.json(); } catch (_) { /* not json */ }
    if (!res.ok) { const e = new Error((json && json.error) || 'Friend server error (' + res.status + ').'); e.status = res.status; throw e; }
    return json || {};
  }

  async function ensure(profile) {
    const name = profile.username, k = name.toLowerCase();
    const head = headFor(profile);
    const sig = head || 'none';
    const token = store.getFriendToken(name);
    if (token && registered.get(k) === sig) return token;
    const r = await call('register', { name, skin: head }, null, token);
    if (r.token) store.setFriendToken(name, r.token);
    registered.set(k, sig);
    return r.token || token;
  }

  async function act(profile, route, body) {
    if (!configured) throw new Error('Friend server is not set up yet.');
    if (!profile) throw new Error('Select a profile first.');
    for (let attempt = 0; ; attempt++) {
      const token = await ensure(profile);
      try {
        return await call(route, body, profile.username, token);
      } catch (e) {
        if (e.status === 401 && attempt === 0) { registered.delete(profile.username.toLowerCase()); continue; }   // server lost us: register again
        throw e;
      }
    }
  }

  const url = (b64) => (b64 ? 'data:image/png;base64,' + b64 : null);
  const shape = (d) => {
    const map = (x) => ({ name: x.name, head: url(x.skin), online: !!x.online });
    return { me: d.me, friends: (d.friends || []).map(map), incoming: (d.incoming || []).map(map), outgoing: (d.outgoing || []).map(map) };
  };

  return {
    configured,
    // What the in-game mod needs to find other Op Launcher players. null when there is no friend server.
    async credentials(profile) {
      if (!configured || !profile) return null;
      try { return { server: base, user: profile.username, token: await ensure(profile) }; } catch (_) { return null; }
    },
    async sync(profile) { return shape(await act(profile, 'sync', {})); },
    async action(profile, kind, name) {
      if (!['request', 'accept', 'decline', 'cancel', 'remove'].includes(kind)) throw new Error('Unknown action.');
      const r = await act(profile, kind, { name });
      return { result: r, data: shape(await act(profile, 'sync', {})) };
    }
  };
}

module.exports = { createSocial };
