// Update dialog: "Update available - Update now / Remind me later", download progress, restart.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const modal = $('update-modal'), title = $('up-title'), ver = $('up-ver'), notes = $('up-notes');
  const bar = $('up-bar'), fill = $('up-fill'), status = $('up-status');
  const later = $('up-later'), now = $('up-now');
  const checkBtn = $('btn-update-check'), desc = $('upd-desc');

  let mode = 'available';     // available | downloading | blocked | restarting

  function show(m) {
    mode = m;
    modal.hidden = false;
    const dl = m === 'downloading', rs = m === 'restarting';
    bar.hidden = !(dl || rs);
    notes.hidden = !notes.textContent || dl || rs || m === 'blocked';
    later.hidden = m === 'available' ? false : true;
    now.hidden = m === 'downloading' || m === 'restarting';
    now.textContent = m === 'blocked' ? 'Restart now' : 'Update now';
    now.disabled = false;
    if (m === 'available') { title.textContent = 'Update available'; status.textContent = ''; }
    else if (dl) { title.textContent = 'Downloading update'; status.textContent = 'Please keep the launcher open...'; }
    else if (m === 'blocked') { title.textContent = 'Update ready'; status.textContent = 'Close the game first, then press Restart now to install it.'; later.hidden = false; later.textContent = 'Later'; }
    else { title.textContent = 'Installing update'; status.textContent = 'Op Launcher is restarting...'; fill.style.width = '100%'; }
    if (m === 'available') later.textContent = 'Remind me later';
  }
  const hide = () => { modal.hidden = true; };

  window.op.onUpdateEvent((ev) => {
    if (!ev) return;
    if (ev.type === 'available') {
      ver.textContent = 'Op Launcher v' + ev.version + ' is ready to install.';
      notes.textContent = ev.notes || '';
      fill.style.width = '0%';
      show('available');
    } else if (ev.type === 'progress') {
      if (mode !== 'downloading') show('downloading');
      fill.style.width = ev.percent + '%';
      status.textContent = 'Downloading... ' + ev.percent + '%';
    } else if (ev.type === 'ready') {
      show(ev.blocked ? 'blocked' : 'restarting');
    } else if (ev.type === 'none') {
      OP.toast("You're on the latest version");
      resetCheck();
    } else if (ev.type === 'error') {
      OP.toast(ev.message || 'Update failed');
      if (mode === 'downloading') show('available');
      resetCheck();
    }
  });

  now.addEventListener('click', async () => {
    if (mode === 'blocked') {
      const r = await window.op.installUpdate();
      if (r && r.blocked) OP.toast('Close the game first');
      return;
    }
    now.disabled = true;
    show('downloading');
    const r = await window.op.downloadUpdate();
    if (!r || !r.ok) show('available');
  });
  later.addEventListener('click', () => { window.op.updateLater(); hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && (mode === 'available' || mode === 'blocked')) later.click(); });

  // Settings: manual check
  function resetCheck() { checkBtn.disabled = false; checkBtn.textContent = 'Check for updates'; }
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true; checkBtn.textContent = 'Checking...';
    let r; try { r = await window.op.checkForUpdates(); } catch (_) { r = null; }
    if (!r || !r.ok) { OP.toast('Updates work in the installed version of Op Launcher'); resetCheck(); return; }
    setTimeout(resetCheck, 15000);   // a result (dialog, "latest version" or error) arrives as an event
  });
  if (window.op.getVersion) window.op.getVersion().then((v) => { if (v) desc.textContent = 'You have v' + v + '. Op Launcher checks for new versions by itself.'; }).catch(() => {});
})();
