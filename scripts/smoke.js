'use strict';

/* 冒烟测试：用真实主进程启动，注入测试脚本，验证渲染管线不抛错。
   用法：PIXDESK_DIR=<图片目录> npx electron scripts/smoke.js          */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

require('../src/main/main.js'); // 复用真实主进程（窗口、IPC、菜单）

const logs = [];

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 700));
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('SMOKE FAIL: 没有创建窗口'); process.exit(1); }

  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    if (d && typeof d === 'object') logs.push('[' + d.level + '] ' + d.message);
    else logs.push('[' + args[1] + '] ' + args[2]);
  });
  win.webContents.on('render-process-gone', (_e, det) => {
    console.error('SMOKE FAIL: 渲染进程崩溃', det);
    process.exit(1);
  });

  const dir = process.env.PIXDESK_DIR || '';
  const body = fs.readFileSync(path.join(__dirname, 'smoke-test.js'), 'utf8');

  try {
    const result = await win.webContents.executeJavaScript(
      '(async () => { const DIR = ' + JSON.stringify(dir) + ';\n' + body + '\n})()',
      true
    );
    console.log('\n=== SMOKE RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    const consoleErrors = logs.filter((l) => l.startsWith('[error') || l.startsWith('[3]'));
    if (consoleErrors.length) {
      console.log('\n=== RENDERER ERRORS ===');
      console.log(consoleErrors.join('\n'));
    }
    await new Promise((r) => setTimeout(r, 200));
    app.exit(result && result.ok && consoleErrors.length === 0 ? 0 : 2);
  } catch (err) {
    console.error('SMOKE FAIL:', err && err.message);
    if (logs.length) console.error(logs.join('\n'));
    app.exit(1);
  }
});
