/* 在渲染进程内执行的冒烟测试主体（由 scripts/smoke.js 注入） */

const S = PD.state;
const IM = PD.imaging;
const V = PD.view;
const A = PD.app();
const out = { ok: false, steps: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name, fn) => {
  try {
    const v = fn();
    out.steps.push({ name, ok: true, value: v === undefined ? null : v });
  } catch (err) {
    out.steps.push({ name, ok: false, error: String(err && err.message || err) });
  }
};

/* 1. 打开文件夹 */
A.loadFolder(DIR, '');
await wait(900);
step('loadFolder', () => ({ files: S.files.length, loaded: !!(S.img && S.natural.w > 0), natural: S.natural }));

/* 2. 调整项 + 滤镜 + 裁剪 + 标注 + 水印 全开一遍 */
step('applyEdits', () => {
  S.edit.adjust.brightness = 128;
  S.edit.adjust.contrast = 118;
  S.edit.adjust.saturation = 130;
  S.edit.adjust.temperature = 45;
  S.edit.adjust.sharpen = 35;
  S.edit.adjust.vignette = 25;
  S.edit.adjust.blur = 0;
  S.edit.preset = 'warm';
  S.edit.crop = { x: 0.08, y: 0.1, w: 0.66, h: 0.7 };
  S.edit.annotations.push({ type: 'arrow', color: '#ff3b30', width: 22, points: [[0.15, 0.2], [0.6, 0.55]] });
  S.edit.annotations.push({ type: 'rect', color: '#0a84ff', width: 10, points: [[0.3, 0.3], [0.85, 0.8]] });
  S.edit.annotations.push({ type: 'ellipse', color: '#ffd60a', width: 10, points: [[0.2, 0.5], [0.5, 0.9]] });
  S.edit.annotations.push({ type: 'text', color: '#ffffff', width: 10, size: 7, text: 'PixDesk 测试', points: [[0.2, 0.15]] });
  S.edit.annotations.push({ type: 'mosaic', color: '#000000', width: 10, points: [[0.55, 0.55], [0.9, 0.9]] });
  S.edit.annotations.push({ type: 'brush', color: '#34c759', width: 24, points: [[0.1, 0.85], [0.2, 0.7], [0.35, 0.8]] });
  S.edit.watermark.enabled = true;
  S.edit.watermark.text = '© PixDesk Smoke';
  S.edit.watermark.tile = true;
  A.render(true);
  return true;
});
await wait(500);

step('previewCore', () => ({ w: V.core && V.core.width, h: V.core && V.core.height, keyLen: V.coreKey.length }));

step('fullRender', () => {
  const c = IM.renderFull(S.img, S.edit, null);
  const png = c.toDataURL('image/png');
  return { w: c.width, h: c.height, pngBytes: IM.dataUrlBytes(png), jpegBytes: IM.dataUrlBytes(c.toDataURL('image/jpeg', 0.9)) };
});

/* 3. 旋转 / 微调 / 翻转 */
step('rotate90', () => {
  S.edit.rotate = 90;
  A.render(true);
  return { core: [V.core.width, V.core.height] };
});
await wait(200);
step('fineAngle', () => {
  S.edit.fine = 12;
  A.render(true);
  return { core: [V.core.width, V.core.height] };
});
await wait(300);
step('flip', () => {
  S.edit.flipH = true;
  S.edit.flipV = true;
  A.render(true);
  return { ok: true };
});
await wait(200);

/* 4. 撤销 / 重做 */
step('undoRedo', () => {
  PD.snapshot();
  const before = S.edit.annotations.length;
  S.edit.annotations.push({ type: 'rect', color: '#111111', width: 10, points: [[0.1, 0.1], [0.2, 0.2]] });
  const added = S.edit.annotations.length;
  A.undo();
  const afterUndo = S.edit.annotations.length;
  A.redo();
  const afterRedo = S.edit.annotations.length;
  return { before, added, afterUndo, afterRedo };
});

/* 5. 缩放 */
step('zoom', () => {
  V.zoomBy(1.6);
  const z1 = S.view.scale;
  V.actualSize();
  const z2 = S.view.scale;
  V.fit();
  return { zoomed: Number(z1.toFixed(3)), actual: z2, fit: Number(S.view.scale.toFixed(3)) };
});

/* 6. 写盘（走真实 IPC）+ 回读（走 media:// 协议） */
try {
  const c = IM.renderFull(S.img, S.edit, null);
  const dataUrl = c.toDataURL('image/png');
  const target = DIR.replace(/[\\/]$/, '') + '/__smoke_out.png';
  const r = await window.api.writeFile(target, dataUrl);
  const st = await window.api.stat(target);
  const img = await new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = window.api.toMediaUrl(target) + '?v=' + Date.now();
  });
  out.steps.push({
    name: 'writeAndReload',
    ok: !!r.ok && st.ok && !!img,
    value: { write: r.ok, bytes: r.bytes, statOk: st.ok, reloaded: !!img, reloadDims: img ? [img.naturalWidth, img.naturalHeight] : null }
  });
} catch (err) {
  out.steps.push({ name: 'writeAndReload', ok: false, error: String(err && err.message || err) });
}

/* 7. 切换图片 */
step('switchImage', () => {
  A.openIndex(1);
  return { index: S.index };
});
await wait(700);
step('afterSwitch', () => ({ index: S.index, natural: S.natural, dirty: PD.isDirty() }));

out.ok = out.steps.every((s) => s.ok !== false);
return out;
