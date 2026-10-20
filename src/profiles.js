// Profiles tab: list, select, delete, create dialog.
(function () {
  'use strict';

  const grid = document.getElementById('profile-grid');
  const emptyBox = document.getElementById('profile-empty');

  const TRASH = '<svg viewBox="0 0 24 24"><path d="M5 7h14"/><path d="M9.5 7V5h5v2"/><path d="M7 7l1 12h8l1-12"/></svg>';

  function line(label, value) {
    const d = document.createElement('div');
    d.className = 'p-line';
    d.append(label + ' ');
    const b = document.createElement('b');
    b.textContent = value;
    d.append(b);
    return d;
  }

  function card(p, selected) {
    const el = document.createElement('div');
    el.className = 'profile-card' + (selected ? ' selected' : '');
    el.tabIndex = 0;

    const head = document.createElement('canvas');
    head.className = 'head-canvas';
    head.width = 64; head.height = 64;
    OP.getSkin(p.hasSkin ? p.id : null).then((url) => OP.drawHead(head, url));

    const info = document.createElement('div');
    info.className = 'p-info';
    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = p.name;
    info.append(name, line('Version', 'Fabric ' + p.version), line('Username', p.username));

    const side = document.createElement('div');
    side.className = 'p-side';
    if (selected) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'SELECTED';
      side.append(b);
    }
    const del = document.createElement('button');
    del.className = 'p-del';
    del.innerHTML = TRASH + '<span>Delete</span>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (OP.launchActive && OP.launchProfileId === p.id) { OP.toast('Close the game before deleting this profile'); return; }
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.querySelector('span').textContent = 'Sure?';
        setTimeout(() => {
          del.classList.remove('confirm');
          del.querySelector('span').textContent = 'Delete';
        }, 2500);
        return;
      }
      window.op.deleteProfile(p.id).then((s) => {
        OP.dropSkin(p.id);
        OP.setState(s);
        OP.toast('Profile deleted');
      });
    });
    side.append(del);

    const select = () => {
      if (selected) return;
      window.op.selectProfile(p.id).then((s) => OP.setState(s));
    };
    el.addEventListener('click', select);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });

    el.append(head, info, side);
    return el;
  }

  let lastSig = '';
  function render() {
    const s = OP.state;
    // settings changes (RAM slider etc.) also fire 'state': only rebuild the cards when profiles changed
    const sig = JSON.stringify([s.profiles, s.selectedId]);
    if (sig === lastSig) return;
    lastSig = sig;
    grid.textContent = '';
    emptyBox.hidden = s.profiles.length > 0;
    s.profiles.forEach((p) => grid.append(card(p, p.id === s.selectedId)));
  }
  OP.on('state', render);

  // ---------------- Title bar chip (selected profile) ----------------
  const chip = document.getElementById('user-chip');
  const chipName = document.getElementById('chip-name');
  const chipHead = document.getElementById('chip-head');
  chip.addEventListener('click', () => OP.goto('profile'));

  function updateChip() {
    const p = OP.selectedProfile();
    chip.classList.toggle('none', !p);
    chipName.textContent = p ? p.username : 'No profile';
    chip.title = p ? p.name + ' (selected profile)' : 'No profile selected';
    chipHead.getContext('2d').clearRect(0, 0, chipHead.width, chipHead.height);
    if (p) {
      OP.getSkin(p.hasSkin ? p.id : null).then((url) => {
        const cur = OP.selectedProfile();
        if (cur && cur.id === p.id) OP.drawHead(chipHead, url);
      });
    }
  }
  OP.on('state', updateChip);

  // ---------------- Create dialog ----------------
  const modal = document.getElementById('modal');
  const fName = document.getElementById('f-name');
  const fVersion = document.getElementById('f-version');
  const fUser = document.getElementById('f-user');
  const fHead = document.getElementById('f-head');
  const fSkinName = document.getElementById('f-skinname');
  const fChoose = document.getElementById('f-skin-choose');
  const fReset = document.getElementById('f-skin-reset');
  const fError = document.getElementById('f-error');
  const fCreate = document.getElementById('f-create');
  let pickedSkin = null;

  function showError(msg) {
    fError.textContent = msg || '';
    fError.hidden = !msg;
  }

  function setPicked(skin) {
    pickedSkin = skin;
    fSkinName.textContent = skin ? skin.name : 'Default skin';
    fReset.hidden = !skin;
    const p = skin ? Promise.resolve(skin.dataUrl) : OP.getSkin(null);
    p.then((url) => OP.drawHead(fHead, url));
  }

  function openModal() {
    const s = OP.state;
    fVersion.textContent = '';
    s.system.versions.forEach((v) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      fVersion.append(o);
    });
    fName.value = '';
    fUser.value = '';
    showError('');
    setPicked(null);
    modal.hidden = false;
    fName.focus();
  }
  function closeModal() { modal.hidden = true; }

  document.getElementById('btn-new-profile').addEventListener('click', openModal);
  document.getElementById('btn-empty-create').addEventListener('click', () => { OP.goto('profile'); openModal(); });
  document.getElementById('f-cancel').addEventListener('click', closeModal);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (modal.hidden) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') fCreate.click();
  });

  fChoose.addEventListener('click', async () => {
    showError('');
    const r = await window.op.chooseSkin();
    if (r.ok) setPicked({ dataUrl: r.dataUrl, name: r.name });
    else if (!r.canceled) showError(r.error || 'Could not use that skin.');
  });
  fReset.addEventListener('click', () => setPicked(null));

  fCreate.addEventListener('click', async () => {
    showError('');
    const name = fName.value.trim();
    const username = fUser.value.trim();
    if (!name) return showError('Enter a profile name.');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return showError('Username must be 3-16 letters, numbers or _ only.');

    fCreate.disabled = true;
    try {
      const r = await window.op.createProfile({
        name, version: fVersion.value, username,
        skinDataUrl: pickedSkin ? pickedSkin.dataUrl : ''
      });
      if (!r.ok) return showError(r.error || 'Could not create the profile.');
      OP.setState(r.state);
      closeModal();
      OP.toast('Profile created and selected');
    } finally {
      fCreate.disabled = false;
    }
  });
})();
