'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../src/main/main.js');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.on('console-message', (...a) => {
    const d = a[1];
    console.log('[console]', d && typeof d === 'object' ? d.level + ' ' + d.message : a[1] + ' ' + a[2]);
  });

  const dir = process.env.PIXDESK_DIR;
  const target = dir.replace(/\\/g, '/') + '/gradient.png';
  const url = 'pixdesk://local/' + target.split('/').map(encodeURIComponent).join('/');
  console.log('URL =', url);

  const r = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    out.url = ${JSON.stringify(url)};
    try {
      const res = await fetch(${JSON.stringify(url)});
      out.fetchStatus = res.status;
      out.fetchType = res.headers.get('content-type');
      const buf = await res.arrayBuffer();
      out.bytes = buf.byteLength;
    } catch (e) { out.fetchError = String(e); }
    out.img = await new Promise((res) => {
      const i = new Image();
      i.onload = () => res({ ok: true, w: i.naturalWidth, h: i.naturalHeight });
      i.onerror = (ev) => res({ ok: false, err: String(ev && ev.message) });
      i.src = ${JSON.stringify(url)};
    });
    out.hasApi = typeof window.api;
    return out;
  })()`, true);
  console.log(JSON.stringify(r, null, 2));
  app.exit(0);
});
