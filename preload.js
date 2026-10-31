const { contextBridge, ipcRenderer, webUtils } = require('electron');
const inv = (ch) => (payload) => ipcRenderer.invoke(ch, payload);

contextBridge.exposeInMainWorld('api', {
  // running things
  run: inv('run'), stop: () => ipcRenderer.invoke('stop'), sendInput: inv('send-input'), build: inv('build'),
  // files
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  getPath: (file) => webUtils.getPathForFile(file),
  drop: inv('drop'), create404: inv('create-404'), undoDrop: inv('undo-drop'), openBackups: inv('open-backups'),
  precheck: inv('precheck'), watchSync: inv('watch-sync'),
  // opening / clipboard / dialogs
  openUrl: inv('open-url'), openPath: inv('open-path'), copy: inv('copy'),
  exportJson: inv('export-json'), importJson: () => ipcRenderer.invoke('import-json'), savePng: inv('save-png'),
  // network helpers
  ping: inv('ping'), previewStart: inv('preview-start'), previewStop: inv('preview-stop'),
  // accounts
  secretSet: inv('secret-set'), accountLogin: inv('account-login'), secretGet: inv('secret-get'), secretClear: inv('secret-clear'),
  // app settings / window
  getSettings: () => ipcRenderer.invoke('settings-get'), setSettings: inv('settings-set'),
  trayUpdate: inv('tray-update'), notify: (title, body) => ipcRenderer.invoke('notify', { title, body }), setZoom: inv('set-zoom'),
  // events from the main process
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onChange: (cb) => ipcRenderer.on('fs-change', (_e, f) => cb(f)),
  onTray: (cb) => ipcRenderer.on('tray-action', (_e, a) => cb(a)),
});
