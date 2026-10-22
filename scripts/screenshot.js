'use strict';
/* 截图：加载测试目录、施加一组编辑，然后抓取窗口画面 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
require('../src/main/main.js');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(1360, 820);
  await new Promise((r) => setTimeout(r, 300));

  const dir = (process.env.PIXDESK_DIR || '').replace(/\\/g, '/');
  const shotDir = process.env.PIXDESK_SHOT || path.join(__dirname, '..', '.shots');
  fs.mkdirSync(shotDir, { recursive: true });

  await win.webContents.executeJavaScript(`(async () => {
    PD.app().loadFolder(${JSON.stringify(dir)}, '');
  })()`, true);
  await new Promise((r) => setTimeout(r, 1200));

  const capture = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shotDir, name + '.png'), img.toPNG());
    console.log('saved', path.join(shotDir, name + '.png'));
  };

  const mode = process.env.PIXDESK_MODE || 'view';
  if (mode === 'edit') {
    await win.webContents.executeJavaScript(`(async () => {
      const A = PD.app(); const S = PD.state;
      A.showTab('adjust');
      S.edit.adjust.contrast = 118; S.edit.adjust.saturation = 125;
      S.edit.preset = 'warm';
      S.edit.annotations.push({type:'arrow', color:'#ff3b30', width:24, points:[[0.18,0.2],[0.62,0.55]]});
      S.edit.annotations.push({type:'text', color:'#ffffff', width:10, size:7, text:'PixDesk', points:[[0.16,0.72]]});
      S.edit.watermark.enabled = true; S.edit.watermark.text='© PixDesk';
      A.syncAll(); A.render(true);
    })()`, true);
    await new Promise((r) => setTimeout(r, 800));
    await capture('edit');
  } else {
    await capture('view');
  }

  app.exit(0);
});
