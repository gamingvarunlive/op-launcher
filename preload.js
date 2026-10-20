const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('op', {
  // window
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, state) => cb(state)),

  // misc
  openDiscord: () => ipcRenderer.invoke('open:discord'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  // launch
  startLaunch: (id) => ipcRenderer.invoke('launch:start', id),
  cancelLaunch: () => ipcRenderer.invoke('launch:cancel'),
  getLaunchStatus: () => ipcRenderer.invoke('launch:status'),
  stopGame: () => ipcRenderer.invoke('launch:stop'),
  getLaunchLog: () => ipcRenderer.invoke('launch:log'),
  openLogs: () => ipcRenderer.invoke('launch:open-logs'),
  openConsole: () => ipcRenderer.invoke('console:open'),
  getSession: () => ipcRenderer.invoke('launch:session'),
  onConsoleReset: (cb) => ipcRenderer.on('console:reset', (_e, s) => cb(s)),
  onLaunchEvent: (cb) => ipcRenderer.on('launch:event', (_e, ev) => cb(ev)),

  // data
  getState: () => ipcRenderer.invoke('state:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDir: () => ipcRenderer.invoke('settings:choose-dir'),
  openDir: () => ipcRenderer.invoke('settings:open-dir'),
  chooseSkin: () => ipcRenderer.invoke('skin:choose'),
  getSkin: (id) => ipcRenderer.invoke('skin:get', id),
  createProfile: (data) => ipcRenderer.invoke('profile:create', data),
  selectProfile: (id) => ipcRenderer.invoke('profile:select', id),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
  addFriend: (d) => ipcRenderer.invoke('friend:add', d),
  updateFriend: (id, patch) => ipcRenderer.invoke('friend:update', id, patch),
  removeFriend: (id) => ipcRenderer.invoke('friend:remove', id),
  listMods: () => ipcRenderer.invoke('mods:list'),
  toggleMod: (file) => ipcRenderer.invoke('mods:toggle', file),
  openModsFolder: () => ipcRenderer.invoke('mods:open-folder'),
  searchModrinth: (o) => ipcRenderer.invoke('modrinth:search', o),
  installMod: (id) => ipcRenderer.invoke('modrinth:install', id),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  updateLater: () => ipcRenderer.invoke('updates:later'),
  onUpdateEvent: (cb) => { ipcRenderer.on('update:event', (_e, ev) => cb(ev)); },
  socialInfo: () => ipcRenderer.invoke('social:info'),
  socialSync: () => ipcRenderer.invoke('social:sync'),
  socialDo: (kind, name) => ipcRenderer.invoke('social:do', kind, name)
});
