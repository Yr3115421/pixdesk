'use strict';

/* =========================================================================
 * PixDesk · 应用主逻辑
 * ========================================================================= */

(function () {
  const PD = window.PD;
  const S = PD.state;
  const IM = PD.imaging;
  const V = PD.view;
  const api = window.api;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SWATCHES = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#111111'];

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  const MIME = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    webp: 'image/webp'
  };

  const app = {
    fast: false,
    _renderT: 0,
    _wmSnap: false,
    _slide: 0,
    sliderRows: [],
    thumbsMap: new Map(),

    /* ------------------------------ 初始化 ------------------------------ */

    async init() {
      V.init($('#view'), $('#stage'));
      const origInvalidate = V.invalidate.bind(V);
      V.invalidate = () => { origInvalidate(); this.updateZoomLabel(); };

      this.bindTopbar();
      this.bindTabs();
      this.bindAdjust();
      this.bindCrop();
      this.bindPresets();
      this.bindAnnotate();
      this.bindWatermark();
      this.bindExport();
      this.bindThumbs();
      this.bindKeys();
      this.bindMenu();
      this.buildPresets();
      this.syncAll();

      window.addEventListener('pointerup', () => {
        if (this.fast) { this.fast = false; this.render(true); }
      });
    },

    /* ------------------------------ 顶部栏 ------------------------------ */

    bindTopbar() {
      $('#btnOpenFiles').onclick = () => this.openImages();
      $('#btnOpenFolder').onclick = () => this.openFolder();
      $('#emptyOpenFiles').onclick = () => this.openImages();
      $('#emptyOpenFolder').onclick = () => this.openFolder();
      $('#btnUndo').onclick = () => this.undo();
      $('#btnRedo').onclick = () => this.redo();
      $('#btnReset').onclick = () => this.resetAll();
      $('#btnZoomIn').onclick = () => V.zoomBy(1.25);
      $('#btnZoomOut').onclick = () => V.zoomBy(0.8);
      $('#btnFit').onclick = () => { S.view.fit = true; V.fit(); };
      $('#btnActual').onclick = () => V.actualSize();
      $('#btnMode').onclick = () => this.setMode(S.mode === 'edit' ? 'view' : 'edit');
      $('#btnSave').onclick = () => this.save();
      $('#btnExport').onclick = () => this.showTab('export');
    },

    setMode(mode) {
      S.mode = mode;
      $('#btnMode').textContent = mode === 'edit' ? '浏览' : '编辑';
      $('.bench').classList.toggle('no-panel', mode !== 'edit');
      if (mode !== 'edit' && S.tool !== 'pan') this.setTool('pan');
      setTimeout(() => V.layout(), 30);
    },

    showTab(tab) {
      this.setMode('edit');
      S.tab = tab;
      $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
      if (tab === 'crop') this.setTool('crop');
      else if (S.tool === 'crop') this.setTool('pan');
      this.syncAll();
    },

    bindTabs() {
      $$('#tabs .tab').forEach((b) => { b.onclick = () => this.showTab(b.dataset.tab); });
    },

    /* ------------------------------ 打开文件 ------------------------------ */

    async openImages() {
      const paths = await api.openImages();
      if (paths && paths.length) this.openPaths(paths);
    },

    async openFolder() {
      const dir = await api.openFolder();
      if (dir) this.loadFolder(dir);
    },

    async openPaths(paths) {
      const first = paths[0];
      const st = await api.stat(first);
      if (st.ok && st.isDir) return this.loadFolder(first);
      const dir = first.replace(/[\\/][^\\/]+$/, '');
      await this.loadFolder(dir, first);
    },

    async loadFolder(dir, selectPath) {
      const res = await api.listImages(dir);
      if (res.error) return this.toast('读取文件夹失败：' + res.error, 'error');
      S.dir = dir;
      S.files = res.files;
      $('#folderName').textContent = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
      $('#folderName').title = dir;
      $('#filterInput').value = '';
      this.renderThumbs();
      if (!S.files.length) {
        this.toast('该文件夹里没有可识别的图片', 'error');
        return;
      }
      let idx = 0;
      if (selectPath) {
        const hit = S.files.findIndex((f) => f.path.toLowerCase() === selectPath.toLowerCase());
        if (hit >= 0) idx = hit;
      }
      this.openIndex(idx);
    },

    async openIndex(i) {
      const f = S.files[i];
      if (!f) return;
      $('#empty').classList.add('hidden');
      S.index = i;
      S.imgPath = f.path;
      S.fileSize = f.size;
      const img = await loadImage(api.toMediaUrl(f.path));
      if (!img) {
        this.toast('无法打开 ' + f.name, 'error');
        return;
      }
      S.img = img;
      S.natural = { w: img.naturalWidth, h: img.naturalHeight };
      PD.resetEdit();
      V.cropDraft = null;
      V.core = null;
      S.view.fit = true;
      this.markActive();
      this.buildPresets();
      this.syncAll();
      this.updateStatus();
      this.render(true);
    },

    step(delta) {
      if (!S.files.length) return;
      const n = S.files.length;
      const next = (S.index + delta + n) % n;
      this.openIndex(next);
    },

    /* ------------------------------ 缩略图 ------------------------------ */

    bindThumbs() {
      $('#filterInput').addEventListener('input', () => this.renderThumbs());
      $('#btnReloadFolder').onclick = () => { if (S.dir) this.loadFolder(S.dir, S.imgPath); };
      $('#thumbs').addEventListener('click', (e) => {
        const t = e.target.closest('.thumb');
        if (t) this.openIndex(Number(t.dataset.index));
      });
    },

    renderThumbs() {
      const q = $('#filterInput').value.trim().toLowerCase();
      const box = $('#thumbs');
      const items = S.files
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => !q || f.name.toLowerCase().includes(q));

      if (!items.length) {
        box.innerHTML = '<div class="hint" style="grid-column:1/-1;text-align:center;padding:20px 0">没有匹配的图片</div>';
      } else {
        box.innerHTML = items.map(({ f, i }) => (
          '<div class="thumb" data-index="' + i + '" title="' + esc(f.name) + '">' +
          '<img loading="lazy" src="' + api.toMediaUrl(f.path) + '" alt="">' +
          '<span class="idx">' + (i + 1) + '</span>' +
          '</div>'
        )).join('');
      }
      $('#countLabel').textContent = items.length + ' 张' + (q ? ' / 共 ' + S.files.length : '');
      this.markActive();
    },

    markActive() {
      $$('#thumbs .thumb').forEach((t) => t.classList.toggle('active', Number(t.dataset.index) === S.index));
      const active = $('#thumbs .thumb.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    },

    /* ------------------------------ 渲染 ------------------------------ */

    previewMaxDim() {
      if (this.fast) return 1200;
      const st = V.stage;
      const dpr = window.devicePixelRatio || 1;
      const target = Math.max(st.clientWidth, st.clientHeight) * dpr * 2;
      return IM.clamp(Math.round(target), 1600, 3200);
    },

    render(immediate) {
      clearTimeout(this._renderT);
      const run = () => {
        if (!S.img) return;
        let core;
        try {
          core = IM.renderCore(S.img, S.edit, this.previewMaxDim());
        } catch (err) {
          console.error(err);
          this.toast('渲染失败：' + err.message, 'error');
          return;
        }
        V.setCore(core, PD.renderKey());
        this.updateStatus();
        this.updateExportInfo();
      };
      if (immediate) run();
      else this._renderT = setTimeout(run, 22);
    },

    /* ------------------------------ 调整滑杆 ------------------------------ */

    fmtVal(key, v) {
      if (key === 'blur') return Number(v).toFixed(1);
      if (key === 'temperature') return (v > 0 ? '+' : '') + v;
      return String(Math.round(v));
    },

    bindAdjust() {
      this.sliderRows = $$('.slider[data-adjust]').map((row) => {
        const key = row.dataset.adjust;
        const input = $('input', row);
        const out = $('output', row);
        input.addEventListener('pointerdown', () => { PD.snapshot(); this.fast = true; });
        input.addEventListener('input', () => {
          S.edit.adjust[key] = Number(input.value);
          out.textContent = this.fmtVal(key, input.value);
          this.render();
        });
        return { key, input, out };
      });

      $('#btnResetAdjust').onclick = () => {
        PD.snapshot();
        const d = PD.defaultEdit().adjust;
        S.edit.adjust = d;
        this.syncAll();
        this.render(true);
      };
    },

    /* ------------------------------ 裁剪 / 方向 ------------------------------ */

    bindCrop() {
      $('#aspectChips').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        $$('#aspectChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
        V.cropAspect = chip.dataset.aspect;
      });

      $('#btnApplyCrop').onclick = () => this.applyCrop();
      $('#btnCancelCrop').onclick = () => { V.cropDraft = null; V.invalidate(); this.syncAll(); };
      $('#btnResetCrop').onclick = () => {
        PD.snapshot();
        S.edit.crop = null;
        V.cropDraft = null;
        this.render(true);
        this.syncAll();
      };

      $('#btnRotateL').onclick = () => this.rotate(-90);
      $('#btnRotateR').onclick = () => this.rotate(90);
      $('#btnFlipH').onclick = () => { PD.snapshot(); S.edit.flipH = !S.edit.flipH; this.render(true); };
      $('#btnFlipV').onclick = () => { PD.snapshot(); S.edit.flipV = !S.edit.flipV; this.render(true); };

      const fine = $('#fineAngle');
      fine.addEventListener('pointerdown', () => { PD.snapshot(); this.fast = true; });
      fine.addEventListener('input', () => {
        S.edit.fine = Number(fine.value);
        $('#fineVal').textContent = fine.value + '°';
        this.render();
      });
      fine.addEventListener('dblclick', () => {
        PD.snapshot();
        S.edit.fine = 0;
        fine.value = 0;
        $('#fineVal').textContent = '0°';
        this.render(true);
      });
    },

    rotate(dir) {
      if (!S.img) return;
      PD.snapshot();
      S.edit.rotate = ((S.edit.rotate + dir) % 360 + 360) % 360;
      S.edit.crop = null;
      V.cropDraft = null;
      this.render(true);
      this.syncAll();
    },

    applyCrop() {
      if (!S.img) return;
      if (!V.cropDraft) return this.toast('先在画面上拖出一个裁剪框', 'error');
      const r = V.cropDraft;
      const cr = S.edit.crop || { x: 0, y: 0, w: 1, h: 1 };
      const base = {
        x: IM.clamp(cr.x + r.x * cr.w, 0, 1),
        y: IM.clamp(cr.y + r.y * cr.h, 0, 1),
        w: IM.clamp(r.w * cr.w, 0.002, 1),
        h: IM.clamp(r.h * cr.h, 0.002, 1)
      };
      PD.snapshot();
      S.edit.crop = base;
      V.cropDraft = null;
      this.render(true);
      this.syncAll();
    },

    /* ------------------------------ 滤镜 ------------------------------ */

    buildPresets() {
      const src = S.imgPath ? api.toMediaUrl(S.imgPath) : '';
      const box = $('#presets');
      box.innerHTML = Object.entries(IM.PRESETS).map(([k, p]) => (
        '<button class="preset" data-preset="' + k + '">' +
        '<span class="thumb-box">' +
        (src ? '<img src="' + src + '" style="filter:' + (p.css || 'none') + '" alt="">' : '') +
        '</span><span>' + esc(p.name) + '</span></button>'
      )).join('');
      this.syncAll();
    },

    bindPresets() {
      $('#presets').addEventListener('click', (e) => {
        const b = e.target.closest('.preset');
        if (!b) return;
        PD.snapshot();
        S.edit.preset = b.dataset.preset;
        this.syncAll();
        this.render(true);
      });
    },

    /* ------------------------------ 标注 ------------------------------ */

    bindAnnotate() {
      $('#annoTools').addEventListener('click', (e) => {
        const b = e.target.closest('.tool');
        if (b) this.setTool(b.dataset.tool);
      });

      const sw = $('#swatches');
      sw.innerHTML = SWATCHES.map((c) => '<button class="swatch" data-color="' + c + '" style="background:' + c + '"></button>').join('') +
        '<span class="swatch picker"><input type="color" id="customColor" value="#ff3b30"></span>';
      sw.addEventListener('click', (e) => {
        const b = e.target.closest('.swatch');
        if (!b || !b.dataset.color) return;
        S.brush.color = b.dataset.color;
        $('#customColor').value = S.brush.color;
        this.syncAll();
      });
      $('#customColor').addEventListener('input', (e) => {
        S.brush.color = e.target.value;
        this.syncAll();
      });

      const bw = $('#brushWidth');
      bw.addEventListener('input', () => {
        S.brush.width = Number(bw.value);
        $('#brushWidthVal').textContent = bw.value;
      });
      const bs = $('#brushSize');
      bs.addEventListener('input', () => {
        S.brush.size = Number(bs.value);
        $('#brushSizeVal').textContent = bs.value;
      });
      $('#brushText').addEventListener('input', (e) => { S.brush.text = e.target.value; });

      $('#btnClearAnno').onclick = () => {
        if (!S.edit.annotations.length) return;
        PD.snapshot();
        S.edit.annotations = [];
        this.render(true);
        this.syncAll();
      };
    },

    setTool(tool) {
      S.tool = tool;
      $$('#annoTools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
      V.canvas.style.cursor = V.cursorForTool();
    },

    /* ------------------------------ 水印 ------------------------------ */

    bindWatermark() {
      const wm = () => S.edit.watermark;
      const snap = () => { if (!this._wmSnap) { PD.snapshot(); this._wmSnap = true; } };

      $('#wmEnabled').addEventListener('change', (e) => {
        PD.snapshot();
        wm().enabled = e.target.checked;
        this.render(true);
        this.syncAll();
      });
      $('#wmText').addEventListener('focus', snap);
      $('#wmText').addEventListener('input', (e) => { snap(); wm().text = e.target.value; this.render(); });
      $('#wmSize').addEventListener('pointerdown', snap);
      $('#wmSize').addEventListener('input', (e) => {
        wm().size = Number(e.target.value);
        $('#wmSizeVal').textContent = e.target.value;
        this.render();
      });
      $('#wmOpacity').addEventListener('pointerdown', snap);
      $('#wmOpacity').addEventListener('input', (e) => {
        wm().opacity = Number(e.target.value);
        $('#wmOpacityVal').textContent = e.target.value;
        this.render();
      });
      $('#wmColor').addEventListener('focus', snap);
      $('#wmColor').addEventListener('input', (e) => { snap(); wm().color = e.target.value; this.render(); });
      $('#wmPos').addEventListener('change', (e) => { PD.snapshot(); wm().pos = e.target.value; this.render(true); });
      $('#wmTile').addEventListener('change', (e) => { PD.snapshot(); wm().tile = e.target.checked; this.render(true); });

      window.addEventListener('focusout', () => { this._wmSnap = false; });
    },

    /* ------------------------------ 导出 ------------------------------ */

    bindExport() {
      const fmt = $('#expFormat');
      fmt.addEventListener('change', () => { this.syncExportRows(); this.updateExportInfo(); });
      $('#expQuality').addEventListener('input', (e) => { $('#expQualityVal').textContent = e.target.value; });
      $('#expScale').addEventListener('input', (e) => {
        $('#expScaleVal').textContent = e.target.value + '%';
        this.updateExportInfo();
      });
      $('#btnSaveAs').onclick = () => this.saveAs();
      $('#btnBatch').onclick = () => this.batchExport();
      this.syncExportRows();
    },

    syncExportRows() {
      const f = $('#expFormat').value;
      $('#qualityRow').style.opacity = f === 'png' ? '.4' : '1';
      $('#expQuality').disabled = f === 'png';
    },

    exportOpts() {
      const fmt = $('#expFormat').value;
      return {
        fmt,
        mime: MIME[fmt],
        quality: Number($('#expQuality').value) / 100,
        scale: Number($('#expScale').value) / 100
      };
    },

    expectedDims() {
      if (!S.img) return null;
      const bs = IM.baseSize(S.natural.w, S.natural.h, S.edit);
      let w = bs.W, h = bs.H;
      if (S.edit.crop) { w *= S.edit.crop.w; h *= S.edit.crop.h; }
      const k = Number($('#expScale').value) / 100;
      return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
    },

    updateExportInfo() {
      const d = this.expectedDims();
      $('#expInfo').textContent = d ? '输出尺寸 ' + d.w + ' × ' + d.h + ' px' : '输出尺寸 —';
    },

    /** 全分辨率渲染 + 缩放 */
    renderForExport() {
      let canvas = IM.renderFull(S.img, S.edit, null);
      const k = Number($('#expScale').value) / 100;
      if (k < 0.999) {
        const w = Math.max(1, Math.round(canvas.width * k));
        const h = Math.max(1, Math.round(canvas.height * k));
        const small = IM.makeCanvas(w, h);
        const ctx = small.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, w, h);
        canvas = small;
      }
      return canvas;
    },

    async save() {
      if (!S.img) return this.toast('没有打开的图片', 'error');
      const f = S.files[S.index];
      const ext = (f ? f.ext : '').replace('.', '').toLowerCase();
      const mime = MIME[ext];
      if (!mime) return this.toast('「' + ext.toUpperCase() + '」格式不支持原地保存，请用「导出 / 另存为」', 'error');

      this.busy(true, '正在保存…');
      try {
        const canvas = IM.renderFull(S.img, S.edit, null);
        const dataUrl = IM.toDataUrl(canvas, mime, 0.94, mime === 'image/jpeg');
        const bak = await api.backup(S.imgPath);
        const res = await api.writeFile(S.imgPath, dataUrl);
        if (!res.ok) throw new Error(res.error);
        this.toast('已保存 · ' + IM.formatBytes(res.bytes) + (bak && bak.created ? '（原图已备份为 .bak）' : ''), 'ok');
        const st = await api.stat(S.imgPath);
        if (st.ok) { S.fileSize = st.size; this.updateStatus(); }
        // 重新载入磁盘上的新文件，保持数据一致
        const img = await loadImage(api.toMediaUrl(S.imgPath) + '?v=' + Date.now());
        if (img) { S.img = img; S.natural = { w: img.naturalWidth, h: img.naturalHeight }; }
        PD.resetEdit();
        this.syncAll();
        this.render(true);
      } catch (err) {
        this.toast('保存失败：' + err.message, 'error');
      } finally {
        this.busy(false);
      }
    },

    async saveAs() {
      if (!S.img) return this.toast('没有打开的图片', 'error');
      const o = this.exportOpts();
      const dir = S.imgPath ? S.imgPath.replace(/[\\/][^\\/]+$/, '') : '';
      const base = S.imgPath ? S.imgPath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') : 'image';
      const def = (dir ? dir + '\\' : '') + base + '_edited.' + o.fmt;
      const target = await api.saveAs({ defaultPath: def, ext: o.fmt });
      if (!target) return;

      const ext = (target.split('.').pop() || '').toLowerCase();
      const mime = MIME[ext] || o.mime;
      this.busy(true, '正在导出…');
      try {
        const canvas = this.renderForExport();
        const dataUrl = IM.toDataUrl(canvas, mime, o.quality, mime === 'image/jpeg');
        const res = await api.writeFile(target, dataUrl);
        if (!res.ok) throw new Error(res.error);
        this.toast('已导出 · ' + IM.formatBytes(res.bytes) + ' → ' + target.split(/[\\/]/).pop(), 'ok');
      } catch (err) {
        this.toast('导出失败：' + err.message, 'error');
      } finally {
        this.busy(false);
      }
    },

    async batchExport() {
      if (!S.files.length) return this.toast('请先打开一个文件夹', 'error');
      const outDir = await api.pickFolder({ title: '选择批量导出目录' });
      if (!outDir) return;
      const o = this.exportOpts();
      const joiner = outDir.includes('\\') ? '\\' : '/';
      let ok = 0, fail = 0;

      this.busy(true, '批量导出中…');
      for (let i = 0; i < S.files.length; i++) {
        this.busy(true, '批量导出 ' + (i + 1) + ' / ' + S.files.length);
        await new Promise((r) => setTimeout(r, 0));
        try {
          const img = await loadImage(api.toMediaUrl(S.files[i].path));
          if (!img) { fail++; continue; }
          let canvas = IM.renderFull(img, S.edit, null);
          if (o.scale < 0.999) {
            const w = Math.max(1, Math.round(canvas.width * o.scale));
            const h = Math.max(1, Math.round(canvas.height * o.scale));
            const small = IM.makeCanvas(w, h);
            const c2 = small.getContext('2d');
            c2.imageSmoothingQuality = 'high';
            c2.drawImage(canvas, 0, 0, w, h);
            canvas = small;
          }
          const dataUrl = IM.toDataUrl(canvas, o.mime, o.quality, o.mime === 'image/jpeg');
          const name = S.files[i].name.replace(/\.[^.]+$/, '') + '_edited.' + o.fmt;
          const res = await api.writeFile(outDir + joiner + name, dataUrl);
          if (res.ok) ok++; else fail++;
        } catch (err) {
          console.error(err);
          fail++;
        }
      }
      this.busy(false);
      this.toast('批量导出完成：成功 ' + ok + ' 张' + (fail ? '，失败 ' + fail + ' 张' : '') + ' → ' + outDir, fail ? 'error' : 'ok');
    },

    /* ------------------------------ 编辑命令 ------------------------------ */

    undo() {
      if (!PD.undo()) return;
      V.cropDraft = null;
      this.syncAll();
      this.render(true);
    },

    redo() {
      if (!PD.redo()) return;
      V.cropDraft = null;
      this.syncAll();
      this.render(true);
    },

    resetAll() {
      if (!S.img) return;
      PD.resetEdit();
      V.cropDraft = null;
      this.syncAll();
      this.render(true);
      this.toast('已重置全部修改', 'ok');
    },

    async copyImage() {
      if (!S.img) return;
      const canvas = IM.renderFull(S.img, S.edit, null);
      const r = await api.copyImage(canvas.toDataURL('image/png'));
      this.toast(r && r.ok ? '已复制图片到剪贴板' : '复制失败：' + (r && r.error), r && r.ok ? 'ok' : 'error');
    },

    async reveal() {
      if (S.imgPath) await api.reveal(S.imgPath);
    },

    toggleSidebar() {
      $('.bench').classList.toggle('no-sidebar');
      setTimeout(() => V.layout(), 30);
    },

    togglePanel() {
      this.setMode(S.mode === 'edit' ? 'view' : 'edit');
    },

    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    },

    toggleSlideshow() {
      S.slideshow = !S.slideshow;
      $('#slideHint').classList.toggle('show', S.slideshow);
      clearInterval(this._slide);
      if (S.slideshow) this._slide = setInterval(() => this.step(1), 3000);
    },

    help() {
      this.toast('← → 切换图片 · 滚轮缩放 · 空格拖动平移 · Ctrl+0 适应 · Ctrl+1 实际大小 · E 编辑/浏览 · Ctrl+B 缩略图栏 · F5 幻灯片 · F11 全屏 · Ctrl+Z / Ctrl+Y 撤销重做 · Ctrl+S 保存 · Ctrl+Shift+S 另存为', 'info', 7000);
    },

    /* ------------------------------ 键盘 ------------------------------ */

    bindKeys() {
      document.addEventListener('keydown', (e) => {
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
        if (e.key === 'Escape') {
          if (typing) { t.blur(); e.preventDefault(); return; }
          if (S.slideshow) { this.toggleSlideshow(); return; }
          if (S.tool !== 'pan') this.setTool('pan');
          return;
        }
        if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

        switch (e.key) {
          case 'ArrowRight': e.preventDefault(); this.step(1); break;
          case 'ArrowLeft': e.preventDefault(); this.step(-1); break;
          case '+': case '=': V.zoomBy(1.25); break;
          case '-': case '_': V.zoomBy(0.8); break;
          case '0': S.view.fit = true; V.fit(); break;
          case '1': V.actualSize(); break;
          case 'e': case 'E': this.setMode(S.mode === 'edit' ? 'view' : 'edit'); break;
          case 'b': case 'B': this.toggleSidebar(); break;
          case 'f': case 'F': this.toggleFullscreen(); break;
          default: break;
        }
      });
    },

    bindMenu() {
      api.onCommand(({ cmd }) => {
        const map = {
          'open-images': () => this.openImages(),
          'open-folder': () => this.openFolder(),
          'save': () => this.save(),
          'save-as': () => this.saveAs(),
          'export': () => this.showTab('export'),
          'reveal': () => this.reveal(),
          'undo': () => this.undo(),
          'redo': () => this.redo(),
          'reset': () => this.resetAll(),
          'copy-image': () => this.copyImage(),
          'copy-path': () => api.copyText(S.imgPath || ''),
          'zoom-fit': () => { S.view.fit = true; V.fit(); },
          'zoom-100': () => V.actualSize(),
          'zoom-in': () => V.zoomBy(1.25),
          'zoom-out': () => V.zoomBy(0.8),
          'toggle-sidebar': () => this.toggleSidebar(),
          'toggle-panel': () => this.togglePanel(),
          'slideshow': () => this.toggleSlideshow(),
          'fullscreen': () => this.toggleFullscreen(),
          'help': () => this.help()
        };
        if (map[cmd]) map[cmd]();
      });
    },

    /* ------------------------------ 状态同步 ------------------------------ */

    syncAll() {
      // 调整滑杆
      for (const row of this.sliderRows) {
        const v = S.edit.adjust[row.key];
        row.input.value = v;
        row.out.textContent = this.fmtVal(row.key, v);
      }
      // 滤镜
      $$('#presets .preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === S.edit.preset));
      // 半径/裁剪
      $('#fineAngle').value = S.edit.fine;
      $('#fineVal').textContent = S.edit.fine + '°';
      this.updateCropInfo();
      // 标注
      $$('#annoTools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === S.tool));
      $$('.swatch[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === S.brush.color));
      $('#brushWidth').value = S.brush.width;
      $('#brushWidthVal').textContent = S.brush.width;
      $('#brushSize').value = S.brush.size;
      $('#brushSizeVal').textContent = S.brush.size;
      $('#brushText').value = S.brush.text;
      $('#annoInfo').textContent = '共 ' + S.edit.annotations.length + ' 个标注';
      // 水印
      const wm = S.edit.watermark;
      $('#wmEnabled').checked = wm.enabled;
      $('#wmText').value = wm.text;
      $('#wmSize').value = wm.size;
      $('#wmSizeVal').textContent = wm.size;
      $('#wmOpacity').value = wm.opacity;
      $('#wmOpacityVal').textContent = wm.opacity;
      $('#wmColor').value = wm.color;
      $('#wmPos').value = wm.pos;
      $('#wmTile').checked = wm.tile;
      // 撤销/重做
      $('#btnUndo').disabled = !S.history.length;
      $('#btnRedo').disabled = !S.future.length;
      // 导出
      this.updateExportInfo();
      // 视口光标
      V.canvas.style.cursor = V.cursorForTool();
      V.invalidate();
    },

    updateCropInfo() {
      const box = $('#cropInfo');
      if (V.cropDraft) {
        const bs = IM.baseSize(S.natural.w, S.natural.h, S.edit);
        const cr = S.edit.crop || { w: 1, h: 1 };
        const w = Math.round(V.cropDraft.w * cr.w * bs.W);
        const h = Math.round(V.cropDraft.h * cr.h * bs.H);
        box.textContent = '待裁剪 ' + w + ' × ' + h + ' px';
        return;
      }
      if (S.edit.crop) {
        const bs = IM.baseSize(S.natural.w, S.natural.h, S.edit);
        box.textContent = '已裁剪为 ' + Math.round(S.edit.crop.w * bs.W) + ' × ' + Math.round(S.edit.crop.h * bs.H) + ' px';
        return;
      }
      box.textContent = S.img ? '未选择裁剪区域' : '未打开图片';
    },

    updateZoomLabel() {
      const el = $('#zoomLabel');
      if (el) el.textContent = Math.round(S.view.scale * 100) + '%';
      const sz = $('#statusZoom');
      if (sz) sz.textContent = '缩放 ' + Math.round(S.view.scale * 100) + '%';
    },

    updateStatus() {
      const f = S.files[S.index];
      $('#fileName').textContent = f ? f.name : '未打开文件';
      $('#fileIndex').textContent = f ? (S.index + 1) + ' / ' + S.files.length : '';
      $('#statusPath').textContent = S.imgPath || '—';
      $('#statusPath').title = S.imgPath || '';
      if (S.img) {
        const bs = IM.baseSize(S.natural.w, S.natural.h, S.edit);
        let w = bs.W, h = bs.H;
        if (S.edit.crop) { w *= S.edit.crop.w; h *= S.edit.crop.h; }
        const ext = f ? f.ext.replace('.', '').toUpperCase() : '';
        $('#statusSize').textContent = Math.round(w) + ' × ' + Math.round(h) + ' px · ' + ext + ' · ' + IM.formatBytes(S.fileSize);
      } else {
        $('#statusSize').textContent = '—';
      }
      this.updateZoomLabel();
      $('#btnUndo').disabled = !S.history.length;
      $('#btnRedo').disabled = !S.future.length;
    },

    /* ------------------------------ 通用 UI ------------------------------ */

    busy(show, text) {
      const el = $('#busy');
      el.classList.toggle('show', !!show);
      if (text) $('#busyText').textContent = text;
    },

    toast(msg, type, ms) {
      const el = $('#toast');
      el.textContent = msg;
      el.className = 'toast show ' + (type === 'error' ? 'error' : type === 'ok' ? 'ok' : '');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { el.className = 'toast'; }, ms || 2600);
    }
  };

  PD.app = () => app;

  window.addEventListener('DOMContentLoaded', () => {
    app.init().catch((e) => {
      console.error(e);
      document.body.insertAdjacentHTML('beforeend',
        '<pre style="position:fixed;left:8px;bottom:8px;background:#fff;border:1px solid #f00;color:#900;padding:8px;font-size:11px;z-index:99;max-width:90vw;overflow:auto">启动异常：' + esc(e && e.stack || e) + '</pre>');
    });
  });
})();
