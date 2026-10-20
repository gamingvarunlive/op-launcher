// Settings tab: game directory, RAM allocation, options.
(function () {
  'use strict';

  const pathBox = document.getElementById('gamedir');
  const slider = document.getElementById('ram-slider');
  const ramVal = document.getElementById('ram-val');
  const ramMax = document.getElementById('ram-max');
  const ramNote = document.getElementById('ram-note');
  const swPerf = document.getElementById('sw-perf');
  const swClose = document.getElementById('sw-close');
  const swDiscord = document.getElementById('sw-discord');
  const swOwn = document.getElementById('sw-ownname');

  const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1)) + ' GB';

  function paintSlider(v) {
    const min = +slider.min, max = +slider.max;
    slider.style.setProperty('--fill', (max > min ? ((v - min) / (max - min)) * 100 : 0) + '%');
    ramVal.textContent = fmt(v);

    const total = max;
    if (v > total * 0.75) {
      ramNote.textContent = 'That is a lot of your PC\'s memory (' + total + ' GB total). Your PC or the game may start to lag.';
      ramNote.classList.add('warn');
    } else {
      ramNote.textContent = 'Your PC has ' + total + ' GB of RAM. 3-4 GB is a good range for PvP.';
      ramNote.classList.remove('warn');
    }
  }

  function setSwitch(el, on) { el.setAttribute('aria-checked', on ? 'true' : 'false'); }

  OP.on('state', (s) => {
    pathBox.textContent = s.settings.gameDir;
    pathBox.title = s.settings.gameDir;

    const total = s.system.totalRamGB;
    slider.max = String(total);
    ramMax.textContent = total + ' GB';
    // don't fight the user while they are dragging the slider
    if (document.activeElement !== slider) slider.value = String(s.settings.ramGB);
    paintSlider(+slider.value);

    setSwitch(swPerf, s.settings.perfMode);
    setSwitch(swClose, s.settings.closeOnLaunch);
    setSwitch(swDiscord, s.settings.discordRpc);
    setSwitch(swOwn, s.settings.showOwnName);
  });

  // ---- RAM ----
  let saveTimer;
  function saveRam() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      OP.setState(await window.op.setSettings({ ramGB: +slider.value }));
    }, 250);
  }
  slider.addEventListener('input', () => { paintSlider(+slider.value); saveRam(); });

  function nudge(dir) {
    const v = Math.min(+slider.max, Math.max(+slider.min, +slider.value + dir * 0.5));
    slider.value = String(v);
    paintSlider(v);
    saveRam();
  }
  document.getElementById('ram-minus').addEventListener('click', () => nudge(-1));
  document.getElementById('ram-plus').addEventListener('click', () => nudge(1));

  // ---- directory ----
  document.getElementById('btn-browse').addEventListener('click', async () => {
    const r = await window.op.chooseDir();
    if (r.ok) { OP.setState(r.state); OP.toast('Game directory updated'); }
    else if (!r.canceled) OP.toast(r.error || 'Could not use that folder');
  });
  document.getElementById('btn-opendir').addEventListener('click', async () => {
    const r = await window.op.openDir();
    if (!r.ok) OP.toast('Could not open the folder');
  });

  // ---- toggles ----
  swPerf.addEventListener('click', async () => {
    const on = swPerf.getAttribute('aria-checked') !== 'true';
    OP.setState(await window.op.setSettings({ perfMode: on }));
    OP.toast(on ? 'Performance Mode on' : 'Performance Mode off');
  });
  swClose.addEventListener('click', async () => {
    const on = swClose.getAttribute('aria-checked') !== 'true';
    OP.setState(await window.op.setSettings({ closeOnLaunch: on }));
  });
  swDiscord.addEventListener('click', async () => {
    const on = swDiscord.getAttribute('aria-checked') !== 'true';
    OP.setState(await window.op.setSettings({ discordRpc: on }));
  });
  swOwn.addEventListener('click', async () => {
    const on = swOwn.getAttribute('aria-checked') !== 'true';
    OP.setState(await window.op.setSettings({ showOwnName: on }));
  });
})();
