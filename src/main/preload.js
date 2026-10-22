'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function toMediaUrl(fp) {
  const p = String(fp).replace(/\\/g, '/');
  return 'pixdesk://local/' + p.split('/').map(encodeURIComponent).join('/');
}

contextBridge.exposeInMainWorld('api', {
  toMediaUrl,
  info: () => ipcRenderer.invoke('app:info'),

  openImages: () => ipcRenderer.invoke('dialog:open-images'),
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pick-folder', opts || {}),
  listImages: (dir) => ipcRenderer.invoke('fs:list-images', dir),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  writeFile: (filePath, dataUrl) => ipcRenderer.invoke('fs:write', { filePath, dataUrl }),
  backup: (filePath) => ipcRenderer.invoke('fs:backup', filePath),
  saveAs: (opts) => ipcRenderer.invoke('dialog:save-as', opts || {}),

  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openExternal: (u) => ipcRenderer.invoke('shell:open-external', u),
  copyImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
  copyText: (t) => ipcRenderer.invoke('clipboard:write-text', t),

  onCommand: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  }
});
