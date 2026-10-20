// Mods > Browse Mods: search Modrinth and install into the selected profile.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const search = $('br-search'), sortEl = $('br-sort'), viewEl = $('br-view');
  const chip = $('br-chip'), pager = $('br-pager'), listEl = $('br-list'), emptyEl = $('br-empty');

  const I = {
    dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M5 19h14"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.600-7 10-7 10z"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7.500V12l3 2"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.500"/><path d="M3.500 12h17"/><path d="M12 3.500c2.500 2.400 3.800 5.200 3.800 8.500s-1.300 6.100-3.800 8.500c-2.500-2.400-3.800-5.200-3.800-8.500S9.500 5.900 12 3.500z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.500l4.500 4.500L19 7.500"/></svg>'
  };

  let page = 0;            // 0-based page
  let total = 0;
  let seq = 0;             // ignore stale answers
  let loaded = false;
  let key = '';            // profile id + version the list was built for
  const installing = new Set();

  const compact = (n) => {
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
  };
  function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = Math.max(0, Math.floor((Date.now() - t) / 864e5));
    if (d < 1) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d < 7) return d + ' days ago';
    if (d < 14) return 'Last week';
    if (d < 30) return Math.floor(d / 7) + ' weeks ago';
    if (d < 60) return 'Last month';
    if (d < 365) return Math.floor(d / 30) + ' months ago';
    return Math.floor(d / 365) + (d < 730 ? ' year ago' : ' years ago');
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function stat(icon, text) {
    const d = document.createElement('div');
    d.className = 'br-stat';
    d.innerHTML = icon;
    d.append(text);
    return d;
  }
  function tag(text, cls) {
    const t = document.createElement('span');
    t.className = 'br-tag' + (cls ? ' ' + cls : '');
    t.textContent = text;
    return t;
  }

  function card(h) {
    const el = document.createElement('div');
    el.className = 'br-card';

    const ic = document.createElement('div');
    ic.className = 'br-icon';
    if (h.icon) {
      const img = document.createElement('img');
      img.src = h.icon; img.alt = ''; img.loading = 'lazy'; img.draggable = false;
      img.addEventListener('error', () => img.remove());
      ic.append(img);
    }

    const body = document.createElement('div');
    body.className = 'br-body';
    const head = document.createElement('div');
    head.className = 'br-head';
    const t = document.createElement('span'); t.className = 'br-title'; t.textContent = h.title;
    const by = document.createElement('span'); by.className = 'br-by'; by.textContent = 'by ' + h.author;
    head.append(t, by);
    const desc = document.createElement('div');
    desc.className = 'br-desc'; desc.textContent = h.description;
    const tags = document.createElement('div');
    tags.className = 'br-tags';
    tags.append(tag(h.side, 'side'));
    for (const c of h.tags) tags.append(tag(cap(c)));
    tags.append(tag('Fabric', 'fab'));
    body.append(head, desc, tags);

    const side = document.createElement('div');
    side.className = 'br-side';
    const stats = document.createElement('div');
    stats.className = 'br-stats';
    stats.append(stat(I.dl, compact(h.downloads)), stat(I.heart, compact(h.follows)));
    const when = ago(h.updated);
    if (when) stats.append(stat(I.clock, when));
    const btn = document.createElement('button');
    btn.type = 'button';
    setBtn(btn, h);
    btn.addEventListener('click', () => install(h, btn));
    side.append(stats, btn);

    el.append(ic, body, side);
    return el;
  }

  function setBtn(btn, h) {
    const busy = installing.has(h.id);
    btn.className = 'br-install' + (h.installed ? ' done' : '') + (busy ? ' busy' : '');
    btn.disabled = busy || h.installed;
    btn.innerHTML = '';
    if (h.installed) { btn.innerHTML = I.check; btn.append('Installed'); }
    else if (busy) btn.append('Installing...');
    else { btn.innerHTML = I.dl; btn.append('Install'); }
  }

  async function install(h, btn) {
    if (installing.has(h.id)) return;
    installing.add(h.id);
    setBtn(btn, h);
    let r;
    try { r = await window.op.installMod(h.id); } catch (_) { r = { ok: false, error: 'Install failed.' }; }
    installing.delete(h.id);
    if (r && r.ok) {
      h.installed = true;
      const extra = r.installed.length > 1 ? ' (+' + (r.installed.length - 1) + ' required)' : '';
      OP.toast(h.title + ' installed' + extra);
    } else OP.toast((r && r.error) || 'Install failed.');
    setBtn(btn, h);
  }

  function pageButtons(pages) {
    const cur = page + 1, out = [];
    const add = (n) => out.push(n);
    const set = new Set([1, pages, cur - 1, cur, cur + 1].filter((n) => n >= 1 && n <= pages));
    const nums = [...set].sort((a, b) => a - b);
    nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) add('…'); add(n); });
    return out;
  }
  function renderPager() {
    const lim = Number(viewEl.value);
    const pages = Math.max(1, Math.min(Math.ceil(total / lim), Math.floor(9900 / lim)));
    pager.replaceChildren();
    if (pages <= 1) return;
    const mk = (label, n, cls, aria) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'br-pg' + (cls ? ' ' + cls : '');
      b.textContent = label; if (aria) b.setAttribute('aria-label', aria);
      if (n === null) b.disabled = true; else b.addEventListener('click', () => { page = n; load(true); });
      return b;
    };
    pager.append(mk('‹', page > 0 ? page - 1 : null, '', 'Previous page'));
    for (const n of pageButtons(pages)) {
      if (n === '…') { const s = document.createElement('span'); s.className = 'br-dots'; s.textContent = '…'; pager.append(s); }
      else pager.append(mk(String(n), n - 1 === page ? null : n - 1, n - 1 === page ? 'cur' : ''));
    }
    pager.append(mk('›', page + 1 < pages ? page + 1 : null, '', 'Next page'));
  }

  function message(html) {
    listEl.replaceChildren();
    pager.replaceChildren();
    emptyEl.hidden = !html;
    emptyEl.replaceChildren();
    if (html) emptyEl.append(...html);
  }
  const b = (t) => { const e = document.createElement('b'); e.textContent = t; return e; };

  async function load(scrollTop) {
    const p = OP.selectedProfile();
    if (!p) { chip.textContent = ''; message([b('No profile selected'), document.createElement('br'), 'Select a profile first to browse mods for it.']); return; }
    chip.textContent = 'Fabric · ' + p.version;
    const mine = ++seq;
    listEl.classList.add('loading');
    let r;
    try {
      r = await window.op.searchModrinth({ query: search.value.trim(), sort: sortEl.value, offset: page * Number(viewEl.value), limit: Number(viewEl.value) });
    } catch (_) { r = { ok: false, error: 'Could not load mods.' }; }
    if (mine !== seq) return;
    listEl.classList.remove('loading');
    loaded = true;
    key = p.id + '|' + p.version;
    if (!r || !r.ok) {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'btn-ghost small'; retry.textContent = 'Try again';
      retry.addEventListener('click', () => load());
      message([b(r && r.network ? 'No connection' : 'Could not load mods'), document.createElement('br'), (r && r.error) || 'Something went wrong.', document.createElement('br'), document.createElement('br'), retry]);
      return;
    }
    total = r.total || 0;
    r.hits = Array.isArray(r.hits) ? r.hits : [];
    if (!r.hits.length) { message([b('No mods found'), document.createElement('br'), 'Nothing matches that search for Fabric ' + r.version + '.']); return; }
    emptyEl.hidden = true;
    listEl.replaceChildren(...r.hits.map(card));
    renderPager();
    if (scrollTop) document.getElementById('page-mods').scrollTop = 0;
  }

  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; load(); }, 350); });
  sortEl.addEventListener('change', () => { page = 0; load(); });
  viewEl.addEventListener('change', () => { page = 0; load(); });

  // Load when the tab opens, and again if the selected profile (so the version) changed
  OP.on('browse-open', () => {
    const p = OP.selectedProfile();
    if (!loaded || (p && key !== p.id + '|' + p.version) || (!p && key)) { page = 0; load(); }
  });
  OP.on('state', () => {
    const p = OP.selectedProfile();
    chip.textContent = p ? 'Fabric · ' + p.version : '';
    if (loaded && !listEl.closest('[hidden]') && ((p && key !== p.id + '|' + p.version) || (!p && key))) { page = 0; load(); }
  });
})();
