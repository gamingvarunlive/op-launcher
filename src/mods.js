// Mods tab: list the selected profile's mods, enable / disable them, open the mods folder.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const listEl = $('mod-list'), emptyEl = $('mod-empty'), tools = $('mod-tools');
  const search = $('mod-search'), count = $('mod-count'), sub = $('mods-sub');
  const tabList = $('mt-list'), tabBrowse = $('mt-browse');
  const listView = $('mods-list-view'), browseView = $('mods-browse-view');

  const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const CROSS = '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
  const LOCK = '<svg viewBox="0 0 24 24"><rect x="5.5" y="11" width="13" height="9" rx="2"/><path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11"/></svg>';
  const PUZZLE = '<svg viewBox="0 0 24 24"><path d="M10 4.5a2 2 0 1 1 4 0V6h3.5A1.5 1.5 0 0 1 19 7.5V11h-1.5a2 2 0 1 0 0 4H19v3.5a1.5 1.5 0 0 1-1.5 1.5H14v-1.5a2 2 0 1 0-4 0V20H6.5A1.5 1.5 0 0 1 5 18.5V15h1.5a2 2 0 1 0 0-4H5V7.5A1.5 1.5 0 0 1 6.5 6H10z"/></svg>';

  let data = { profile: null, mods: [] };
  let sig = '';
  let loading = false;

  function row(m) {
    const el = document.createElement('div');
    el.className = 'mod-row' + (m.enabled ? '' : ' off');

    const ic = document.createElement('div');
    ic.className = 'mod-icon';
    if (m.icon) { const img = document.createElement('img'); img.src = m.icon; img.alt = ''; img.draggable = false; ic.append(img); }
    else ic.innerHTML = PUZZLE;

    const info = document.createElement('div');
    info.className = 'mod-info';
    const n = document.createElement('div');
    n.className = 'mod-name'; n.textContent = m.name;
    const by = document.createElement('div');
    by.className = 'mod-by';
    const parts = [];
    if (m.authors.length) parts.push('By ' + m.authors.join(', '));
    if (m.version) parts.push(m.version);
    if (!m.fabric) parts.push('Not a Fabric mod');
    by.textContent = parts.join('  ·  ') || m.file;
    by.title = m.file;
    if (!m.fabric) by.classList.add('warn');
    info.append(n, by);

    const side = document.createElement('div');
    side.className = 'mod-side';
    const lab = document.createElement('span');
    lab.className = 'mod-state'; lab.textContent = m.locked ? 'Required' : (m.enabled ? 'Enabled' : 'Disabled');
    if (m.locked) {
      const lock = document.createElement('span');
      lock.className = 'mod-lock'; lock.title = 'Part of Op Launcher, cannot be turned off';
      lock.innerHTML = LOCK;
      side.append(lab, lock);
      el.append(ic, info, side);
      return el;
    }
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'mod-check ' + (m.enabled ? 'on' : 'off');
    box.innerHTML = m.enabled ? CHECK : CROSS;
    box.setAttribute('role', 'switch');
    box.setAttribute('aria-checked', String(m.enabled));
    box.setAttribute('aria-label', (m.enabled ? 'Disable ' : 'Enable ') + m.name);
    box.addEventListener('click', () => toggle(m, box));
    side.append(lab, box);

    el.append(ic, info, side);
    return el;
  }

  async function toggle(m, box) {
    const p = data.profile;
    if (p && OP.launchActive && OP.launchProfileId === p.id) { OP.toast('Close the game before changing mods'); return; }
    box.disabled = true;
    let r;
    try { r = await window.op.toggleMod(m.file); } catch (_) { r = { ok: false, error: 'Could not change the mod.' }; }
    if (r && r.ok) { data.mods = r.mods; render(); }
    else { OP.toast((r && r.error) || 'Could not change the mod.'); load(); }
  }

  function render() {
    const p = data.profile;
    sub.textContent = p ? 'Mods of profile "' + p.name + '" (Fabric ' + p.version + ')' : 'Manage the mods of your selected profile.';
    const q = search.value.trim().toLowerCase();
    const all = data.mods;
    const shown = q ? all.filter((m) => (m.name + ' ' + m.authors.join(' ') + ' ' + m.file).toLowerCase().includes(q)) : all;

    tools.hidden = all.length === 0;
    count.textContent = 'Showing ' + shown.length + (shown.length === 1 ? ' mod' : ' mods');

    emptyEl.hidden = all.length > 0;
    if (!all.length) {
      emptyEl.replaceChildren();
      if (!p) emptyEl.append('Select a profile first to see its mods.');
      else {
        const b = document.createElement('b'); b.textContent = 'No mods yet';
        emptyEl.append(b, document.createElement('br'), 'Click Open Mods Folder and drop your .jar mods in there.');
      }
    }

    const s = JSON.stringify([q, shown.map((m) => [m.file, m.enabled, m.name, m.icon ? m.icon.length : 0])]);
    if (s !== sig) {
      sig = s;
      listEl.replaceChildren(...shown.map(row));
      if (all.length && !shown.length) {
        const none = document.createElement('div');
        none.className = 'fr-none'; none.textContent = 'No mods match your search.';
        listEl.append(none);
      }
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const r = await window.op.listMods();
      if (r && r.ok) data = { profile: r.profile, mods: r.mods };
    } catch (_) { /* keep the old list */ }
    loading = false;
    render();
  }

  function showTab(browse) {
    tabList.classList.toggle('active', !browse); tabBrowse.classList.toggle('active', browse);
    tabList.setAttribute('aria-selected', String(!browse)); tabBrowse.setAttribute('aria-selected', String(browse));
    listView.hidden = browse; browseView.hidden = !browse;
    if (browse) OP.emit('browse-open'); else load();
  }
  tabList.addEventListener('click', () => showTab(false));
  tabBrowse.addEventListener('click', () => showTab(true));

  $('mods-folder').addEventListener('click', async () => {
    let r;
    try { r = await window.op.openModsFolder(); } catch (_) { r = null; }
    if (!r || !r.ok) OP.toast((r && r.error) || 'Could not open the folder.');
  });
  $('mod-refresh').addEventListener('click', () => { load(); OP.toast('Mods refreshed'); });
  search.addEventListener('input', render);

  let onMods = false;
  OP.on('page', (pg) => { onMods = pg === 'mods'; if (onMods) load(); });
  OP.on('state', () => { if (onMods) load(); else { const p = OP.selectedProfile(); if (!p || !data.profile || data.profile.id !== p.id) load(); } });
  window.addEventListener('focus', () => { if (onMods) load(); });   // picks up mods dropped into the folder
})();
