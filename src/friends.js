// Friends tab. Online mode (friend server configured): requests, accept/decline, heads, online dots.
// Offline mode: a simple list kept on this PC.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('fr-form'), nameIn = $('fr-name'), noteIn = $('fr-note'), submit = $('fr-submit');
  const errEl = $('fr-error'), banner = $('fr-banner'), hint = $('fr-hint');
  const list = $('fr-list'), reqList = $('fr-req'), sentList = $('fr-sent');
  const reqHead = $('fr-req-head'), sentHead = $('fr-sent-head');
  const empty = $('fr-empty'), tools = $('fr-tools'), search = $('fr-search'), count = $('fr-count');
  const mini = $('friends-mini'), miniEmpty = $('friends-empty');
  const navBtn = document.querySelector('.nav-btn[data-page="friends"]');

  const I = {
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8 6.9 19.5l1-5.7-4.1-4 5.7-.8z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="10" height="10" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14"/><path d="M9.5 7V5h5v2"/><path d="M7 7l1 12h8l1-12"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  let online = false;                       // friend server configured?
  let net = { friends: [], incoming: [], outgoing: [], ok: false, error: '' };
  let netUser = '';                         // username the data belongs to

  // ---------- helpers ----------
  const showError = (msg) => { errEl.hidden = !msg; errEl.textContent = msg || ''; };

  function head(f, cls) {
    const c = document.createElement('canvas');
    c.className = cls; c.width = 64; c.height = 64;
    if (f.head) OP.drawFace(c, f.head);
    else OP.getSkin(null).then((u) => OP.drawHead(c, u));
    return c;
  }

  function iconBtn(cls, html, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fr-btn ' + cls;
    b.innerHTML = html; b.title = label; b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function confirmBtn(cls, label, run) {
    const b = iconBtn(cls, I.trash, label, () => {
      if (!b.classList.contains('confirm')) {
        b.classList.add('confirm');
        setTimeout(() => b.classList.remove('confirm'), 2500);
        return;
      }
      run();
    });
    return b;
  }

  function copyBtn(name) {
    return iconBtn('', I.copy, 'Copy username', () => {
      (navigator.clipboard ? navigator.clipboard.writeText(name) : Promise.reject()).then(
        () => OP.toast('Copied ' + name), () => OP.toast('Could not copy'));
    });
  }

  function rowShell(f, sub, subClass) {
    const el = document.createElement('div');
    el.className = 'fr-row';
    const av = document.createElement('div');
    av.className = 'fr-avwrap';
    av.append(head(f, 'fr-av'));
    if (f.online) { const d = document.createElement('i'); d.className = 'fr-dot'; d.title = 'Online'; av.append(d); }
    const info = document.createElement('div');
    info.className = 'fr-info';
    const n = document.createElement('div');
    n.className = 'fr-name'; n.textContent = f.name;
    const s = document.createElement('div');
    s.className = 'fr-note' + (subClass ? ' ' + subClass : ''); s.textContent = sub;
    info.append(n, s);
    const acts = document.createElement('div');
    acts.className = 'fr-acts';
    el.append(av, info, acts);
    return { el, acts, sub: s };
  }

  // ---------- online actions ----------
  async function doAction(kind, name, okMsg) {
    let r;
    try { r = await window.op.socialDo(kind, name); } catch (_) { r = { ok: false, error: 'Something went wrong.' }; }
    if (!r || !r.ok) { OP.toast((r && r.error) || 'Something went wrong.'); return r; }
    applyNet(r.data, true);
    OP.toast(r.accepted ? 'You are now friends with ' + name : okMsg);
    return r;
  }

  function onlineFriendRow(f) {
    const r = rowShell(f, f.online ? 'Online' : 'Offline', f.online ? 'on' : 'dim');
    r.acts.append(copyBtn(f.name), confirmBtn('del', 'Remove friend', () => doAction('remove', f.name, f.name + ' removed')));
    return r.el;
  }
  function incomingRow(f) {
    const r = rowShell(f, 'wants to be your friend');
    r.acts.append(
      iconBtn('ok', I.check, 'Accept', () => doAction('accept', f.name, 'You are now friends with ' + f.name)),
      iconBtn('no', I.x, 'Decline', () => doAction('decline', f.name, 'Request declined'))
    );
    return r.el;
  }
  function outgoingRow(f) {
    const r = rowShell(f, 'Waiting for them to accept', 'dim');
    r.acts.append(iconBtn('no', I.x, 'Cancel request', () => doAction('cancel', f.name, 'Request cancelled')));
    return r.el;
  }

  // ---------- offline (local) rows ----------
  function localRow(f) {
    const r = rowShell({ name: f.name, head: null }, f.note || 'No note', f.note ? '' : 'dim');
    const note = r.sub;
    note.title = 'Click to edit note'; note.tabIndex = 0;
    const edit = () => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.maxLength = 60; inp.value = f.note; inp.className = 'fr-note-edit';
      inp.setAttribute('aria-label', 'Note');
      note.replaceWith(inp); inp.focus();
      let done = false;
      const finish = (save) => {
        if (done) return; done = true;
        if (save && inp.value.trim() !== f.note) window.op.updateFriend(f.id, { note: inp.value }).then((x) => { if (x && x.ok) OP.setState(x.state); });
        else inp.replaceWith(note);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
      inp.addEventListener('blur', () => finish(true));
    };
    note.addEventListener('click', edit);
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') edit(); });
    r.acts.append(
      iconBtn('fav' + (f.fav ? ' on' : ''), I.star, f.fav ? 'Remove favorite' : 'Mark as favorite', () => {
        window.op.updateFriend(f.id, { fav: !f.fav }).then((x) => { if (x && x.ok) OP.setState(x.state); });
      }),
      copyBtn(f.name),
      confirmBtn('del', 'Remove friend', () => window.op.removeFriend(f.id).then((s) => { OP.setState(s); OP.toast(f.name + ' removed'); }))
    );
    return r.el;
  }

  // ---------- render ----------
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  let lastSig = '';

  function model() {
    if (online) return { friends: net.friends, incoming: net.incoming, outgoing: net.outgoing };
    const loc = ((OP.state && OP.state.friends) || []).slice().sort((a, b) => (b.fav - a.fav) || byName(a, b));
    return { friends: loc, incoming: [], outgoing: [] };
  }

  function render() {
    const m = model();
    const q = search.value.trim().toLowerCase();
    const shown = q ? m.friends.filter((f) => f.name.toLowerCase().includes(q) || (f.note || '').toLowerCase().includes(q)) : m.friends;
    const p = OP.selectedProfile();

    // banner + form
    let msg = '';
    if (!online) msg = 'Online friend requests are not connected yet. This list is saved on this PC only.';
    else if (!p) msg = 'Select a profile first. Friends use the username of your selected profile.';
    else if (!net.ok && net.error) msg = net.error;
    banner.hidden = !msg; banner.textContent = msg;
    banner.classList.toggle('bad', online && !!msg);
    noteIn.hidden = online;
    hint.hidden = !online;
    submit.textContent = online ? 'Send Request' : '+ Add Friend';
    form.classList.toggle('online', online);
    nameIn.disabled = online && !p; submit.disabled = online && !p;

    reqHead.hidden = !m.incoming.length;
    sentHead.hidden = !m.outgoing.length;
    empty.hidden = m.friends.length > 0 || m.incoming.length > 0 || m.outgoing.length > 0;
    tools.hidden = m.friends.length === 0;
    count.textContent = m.friends.length + (m.friends.length === 1 ? ' friend' : ' friends');
    if (navBtn) navBtn.classList.toggle('badge-dot', m.incoming.length > 0);

    const sig = JSON.stringify([online, q, m.friends, m.incoming, m.outgoing]);
    if (sig !== lastSig) {
      lastSig = sig;
      reqList.replaceChildren(...m.incoming.map(incomingRow));
      sentList.replaceChildren(...m.outgoing.map(outgoingRow));
      list.replaceChildren(...shown.map(online ? onlineFriendRow : localRow));
      if (m.friends.length && !shown.length) {
        const none = document.createElement('div');
        none.className = 'fr-none'; none.textContent = 'No friends match your search.';
        list.append(none);
      }
    }

    // Home panel preview
    miniEmpty.hidden = m.friends.length > 0 || m.incoming.length > 0;
    mini.hidden = miniEmpty.hidden;
    const rows = [];
    if (m.incoming.length) {
      const r = document.createElement('button');
      r.type = 'button'; r.className = 'fm-req';
      r.textContent = m.incoming.length + (m.incoming.length === 1 ? ' friend request' : ' friend requests');
      r.addEventListener('click', () => OP.goto('friends'));
      rows.push(r);
    }
    for (const f of m.friends.slice(0, 5)) {
      const r = document.createElement('div');
      r.className = 'fm-row';
      const nm = document.createElement('span'); nm.textContent = f.name;
      r.append(head(f, 'fm-av'), nm);
      if (online && f.online) { const d = document.createElement('i'); d.className = 'fr-dot inline'; r.append(d); }
      else if (!online && f.fav) { const s = document.createElement('i'); s.className = 'fm-star'; s.innerHTML = I.star; r.append(s); }
      rows.push(r);
    }
    if (m.friends.length > 5) {
      const more = document.createElement('div');
      more.className = 'fm-more'; more.textContent = '+' + (m.friends.length - 5) + ' more';
      rows.push(more);
    }
    mini.replaceChildren(...rows);
  }

  // ---------- online sync ----------
  function applyNet(data, ok) {
    net = { friends: data.friends, incoming: data.incoming, outgoing: data.outgoing, ok, error: '' };
    netUser = data.me;
    render();
  }

  let syncing = false;
  async function sync() {
    if (!online || syncing) return;
    const p = OP.selectedProfile();
    if (!p) { net = { friends: [], incoming: [], outgoing: [], ok: false, error: '' }; netUser = ''; render(); return; }
    syncing = true;
    try {
      const r = await window.op.socialSync();
      if (r && r.ok) applyNet(r.data, true);
      else { net.ok = false; net.error = (r && r.error) || 'Could not load friends.'; if (netUser.toLowerCase() !== p.username.toLowerCase()) { net.friends = []; net.incoming = []; net.outgoing = []; } render(); }
    } catch (_) { net.ok = false; net.error = 'Could not load friends.'; render(); }
    syncing = false;
  }

  // ---------- form ----------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const name = nameIn.value.trim();
    if (online) {
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) { showError('Enter a valid Minecraft username (3-16 letters, numbers or _).'); nameIn.focus(); return; }
      submit.disabled = true;
      const r = await doAction('request', name, 'Friend request sent to ' + name);
      submit.disabled = false;
      if (!r || !r.ok) { showError((r && r.error) || 'Could not send the request.'); nameIn.focus(); return; }
      nameIn.value = ''; nameIn.focus();
      return;
    }
    let r;
    try { r = await window.op.addFriend({ name, note: noteIn.value }); } catch (_) { r = { ok: false, error: 'Could not add friend.' }; }
    if (!r || !r.ok) { showError((r && r.error) || 'Could not add friend.'); nameIn.focus(); return; }
    OP.setState(r.state);
    OP.toast(name + ' added');
    nameIn.value = ''; noteIn.value = ''; search.value = '';
    nameIn.focus();
  });
  nameIn.addEventListener('input', () => showError(''));
  search.addEventListener('input', render);

  let lastUser = null;
  OP.on('state', () => {
    const p = OP.selectedProfile();
    const u = p ? p.username.toLowerCase() : null;
    if (online && u !== lastUser) { lastUser = u; sync(); } else render();
  });
  OP.on('page', (pg) => { if (pg === 'friends') sync(); });

  window.op.socialInfo().then((i) => {
    online = !!(i && i.configured);
    render();
    if (online) { sync(); setInterval(() => { if (!document.hidden) sync(); }, 20000); }
  }).catch(() => render());
})();
