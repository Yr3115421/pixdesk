'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const url = require('url');

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.jpe', '.png', '.apng', '.gif', '.bmp', '.webp',
  '.avif', '.ico', '.svg', '.tif', '.tiff', '.jfif'
]);

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg',
  '.png': 'image/png', '.apng': 'image/apng', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.tif': 'image/tiff', '.tiff': 'image/tiff'
};

const APP_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

/* 自定义 pixdesk:// 协议：页面与图片同源，避免 canvas 被跨域污染（否则无法导出/取像素） */
const SCHEME = 'pixdesk';
const HOST = 'local';
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

let mainWindow = null;

function toUrl(fp) {
  // C:\a\b.png -> pixdesk://local/C%3A/a/b.png
  const p = String(fp).replace(/\\/g, '/');
  return SCHEME + '://' + HOST + '/' + p.split('/').map(encodeURIComponent).join('/');
}

function toAppUrl(rel) {
  // 'index.html' -> pixdesk://local/app/index.html
  return SCHEME + '://' + HOST + '/app/' + String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
}

function fromUrl(u) {
  let p = String(u).slice((SCHEME + '://').length); // local/C%3A/a/b.png?v=1
  p = p.split('#')[0].split('?')[0];
  p = p.replace(new RegExp('^' + HOST + '/'), '');
  p = decodeURIComponent(p);
  return p;
}

/** 解析请求路径：app/ 前缀映射到 renderer 目录，其余视作绝对文件路径 */
function resolveRequest(u) {
  const rel = fromUrl(u);
  if (rel === 'app' || rel === 'app/' || rel.startsWith('app/')) {
    const sub = rel.replace(/^app\/?/, '');
    const full = path.resolve(RENDERER_ROOT, sub);
    if (!full.startsWith(RENDERER_ROOT)) return null; // 防目录穿越
    return full;
  }
  return rel;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: '#f4f6f8',
    title: 'PixDesk',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadURL(toAppUrl('index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

function send(cmd, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:command', { cmd, payload });
  }
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开图片…', accelerator: 'CmdOrCtrl+O', click: () => send('open-images') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { label: '导出…', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        { type: 'separator' },
        { label: '在资源管理器中显示', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('reveal') },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', click: () => send('redo') },
        { type: 'separator' },
        { label: '重置全部修改', accelerator: 'CmdOrCtrl+Alt+R', click: () => send('reset') },
        { type: 'separator' },
        { label: '复制图片到剪贴板', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('copy-image') },
        { label: '复制文件路径', click: () => send('copy-path') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '适应窗口', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-fit') },
        { label: '实际大小 100%', accelerator: 'CmdOrCtrl+1', click: () => send('zoom-100') },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { type: 'separator' },
        { label: '缩略图栏', accelerator: 'CmdOrCtrl+B', click: () => send('toggle-sidebar') },
        { label: '编辑面板', accelerator: 'CmdOrCtrl+Alt+E', click: () => send('toggle-panel') },
        { type: 'separator' },
        { label: '幻灯片播放', accelerator: 'F5', click: () => send('slideshow') },
        { label: '全屏', accelerator: 'F11', click: () => send('fullscreen') },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => mainWindow && mainWindow.webContents.toggleDevTools() }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键说明', click: () => send('help') },
        {
          label: 'GitHub 仓库',
          click: () => shell.openExternal('https://github.com/Yr3115421/pixdesk')
        },
        { label: `版本 ${app.getVersion()}`, enabled: false }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ----------------------------- IPC ----------------------------- */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform
}));

ipcMain.handle('dialog:open-images', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '打开图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: [...IMAGE_EXT].map((e) => e.slice(1)) }]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:open-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '打开文件夹',
    properties: ['openDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('fs:list-images', async (_e, dir) => {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { error: err.message, dir, files: [] };
  }
  for (const ent of entries) {
    if (!ent.isFile() && !ent.isSymbolicLink()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const full = path.join(dir, ent.name);
    try {
      const st = await fsp.stat(full);
      out.push({ path: full, name: ent.name, size: st.size, mtime: st.mtimeMs, ext });
    } catch { /* 忽略无法访问的文件 */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return { dir, files: out };
});

ipcMain.handle('fs:stat', async (_e, p) => {
  try {
    const st = await fsp.stat(p);
    return { ok: true, size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:write', async (_e, { filePath, dataUrl }) => {
  try {
    const base64 = String(dataUrl).replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, buf);
    return { ok: true, filePath, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:backup', async (_e, filePath) => {
  // 覆盖保存前把原图复制为 .bak（仅在 .bak 不存在时创建一次）
  try {
    const bak = filePath + '.bak';
    await fsp.access(bak, fs.constants.F_OK);
    return { ok: true, created: false, path: bak };
  } catch {
    try {
      const bak = filePath + '.bak';
      await fsp.copyFile(filePath, bak, fs.constants.COPYFILE_EXCL);
      return { ok: true, created: true, path: bak };
    } catch (err) {
      return { ok: false, created: false, error: err.message };
    }
  }
});

ipcMain.handle('dialog:save-as', async (_e, { defaultPath, ext }) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '另存为',
    defaultPath,
    filters: [
      { name: 'PNG 图片', extensions: ['png'] },
      { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
      { name: 'WebP 图片', extensions: ['webp'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePath) return null;
  let p = r.filePath;
  if (!path.extname(p)) p += '.' + (ext || 'png');
  return p;
});

ipcMain.handle('dialog:pick-folder', async (_e, { title }) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: title || '选择文件夹',
    properties: ['openDirectory', 'createDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:reveal', async (_e, p) => {
  if (p) shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('shell:open-external', async (_e, u) => {
  if (/^https?:\/\//i.test(u)) await shell.openExternal(u);
  return true;
});

ipcMain.handle('clipboard:write-image', async (_e, dataUrl) => {
  const { clipboard, nativeImage } = require('electron');
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return { ok: false, error: '图片为空' };
    clipboard.writeImage(img);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('clipboard:write-text', async (_e, text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text || '');
  return true;
});

/* ----------------------------- lifecycle ----------------------------- */

app.whenReady().then(() => {
  // Electron 25+ 推荐 protocol.handle；registerFileProtocol 已在新版本移除
  protocol.handle(SCHEME, async (request) => {
    let fp;
    try {
      fp = resolveRequest(request.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (!fp) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fsp.readFile(fp);
      const ext = path.extname(fp).toLowerCase();
      const mime = MIME_BY_EXT[ext] || APP_MIME[ext] || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': mime,
          'cache-control': 'no-cache'
        }
      });
    } catch (err) {
      return new Response('Not Found: ' + err.message, { status: 404 });
    }
  });

  createWindow();
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 暴露给脚本复用
module.exports = { toUrl, APP_MIME, IMAGE_EXT, SCHEME, HOST };
