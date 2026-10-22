'use strict';

/* =========================================================================
 * PixDesk · 视口（缩放/平移/绘制）与鼠标交互
 * ========================================================================= */

(function () {
  const PD = window.PD;
  const S = PD.state;
  const IM = PD.imaging;

  const view = {
    canvas: null,
    ctx: null,
    stage: null,
    core: null,        // 核心渲染画布（不含标注/水印）
    coreKey: '',
    draft: null,       // 正在绘制的标注
    cropDraft: null,   // 裁剪框（core 归一化坐标）
    cropAspect: 'free',
    raf: 0,
    spaceDown: false,

    init(canvas, stage) {
      this.canvas = canvas;
      this.stage = stage;
      this.ctx = canvas.getContext('2d');
      this.bind();
      const ro = new ResizeObserver(() => this.layout());
      ro.observe(stage);
      this.layout();
    },

    layout() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, this.stage.clientWidth);
      const h = Math.max(1, this.stage.clientHeight);
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        if (S.view.fit) this.fit();
      }
      this.invalidate();
    },

    setCore(canvas, key) {
      this.core = canvas;
      this.coreKey = key || '';
      if (S.view.fit) this.fit();
      this.invalidate();
    },

    invalidate() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.draw();
      });
    },

    fit() {
      if (!this.core) return;
      const pad = 32;
      const w = this.stage.clientWidth - pad;
      const h = this.stage.clientHeight - pad;
      const s = Math.min(w / this.core.width, h / this.core.height, 4);
      S.view.scale = s > 0 ? s : 1;
      S.view.fit = true;
      S.view.panX = (this.stage.clientWidth - this.core.width * S.view.scale) / 2;
      S.view.panY = (this.stage.clientHeight - this.core.height * S.view.scale) / 2;
      this.invalidate();
    },

    zoomTo(scale, anchorX, anchorY) {
      if (!this.core) return;
      const old = S.view.scale;
      const ns = IM.clamp(scale, 0.02, 16);
      if (Math.abs(ns - old) < 1e-6) return;
      const ax = anchorX == null ? this.stage.clientWidth / 2 : anchorX;
      const ay = anchorY == null ? this.stage.clientHeight / 2 : anchorY;
      // 保持锚点下的图像坐标不动
      const ix = (ax - S.view.panX) / old;
      const iy = (ay - S.view.panY) / old;
      S.view.scale = ns;
      S.view.panX = ax - ix * ns;
      S.view.panY = ay - iy * ns;
      S.view.fit = false;
      this.invalidate();
    },

    zoomBy(f) {
      this.zoomTo(S.view.scale * f);
    },

    actualSize() {
      if (!this.core) return;
      S.view.scale = 1;
      S.view.fit = false;
      S.view.panX = (this.stage.clientWidth - this.core.width) / 2;
      S.view.panY = (this.stage.clientHeight - this.core.height) / 2;
      this.invalidate();
    },

    /** 屏幕坐标 → core 归一化坐标 */
    toCore(sx, sy) {
      if (!this.core) return { nx: 0, ny: 0 };
      const nx = (sx - S.view.panX) / S.view.scale / this.core.width;
      const ny = (sy - S.view.panY) / S.view.scale / this.core.height;
      return { nx: IM.clamp(nx, -0.5, 1.5), ny: IM.clamp(ny, -0.5, 1.5) };
    },

    draw() {
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.stage.clientWidth, this.stage.clientHeight);
      if (!this.core) return;

      const { scale, panX, panY } = S.view;
      const w = this.core.width * scale;
      const h = this.core.height * scale;

      // 棋盘格底，便于识别透明区域
      ctx.save();
      ctx.beginPath();
      ctx.rect(panX, panY, w, h);
      ctx.clip();
      const cell = 10;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(panX, panY, w, h);
      ctx.fillStyle = '#eceff3';
      for (let y = 0; y < h; y += cell) {
        for (let x = (Math.floor(y / cell) % 2) * cell; x < w; x += cell * 2) {
          ctx.fillRect(panX + x, panY + y, cell, cell);
        }
      }
      ctx.restore();

      ctx.save();
      ctx.imageSmoothingEnabled = scale < 3;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.core, panX, panY, w, h);
      ctx.restore();

      // 标注 + 水印（矢量，实时预览不落盘）
      ctx.save();
      ctx.translate(panX, panY);
      ctx.scale(scale, scale);
      const list = S.edit.annotations.slice();
      if (this.draft) list.push(this.draft);
      IM.drawAnnotations(ctx, list, this.core.width, this.core.height);
      IM.drawWatermark(ctx, S.edit.watermark, this.core.width, this.core.height);
      ctx.restore();

      // 裁剪框
      if (this.cropDraft) this.drawCrop(ctx);

      // 图像边界
      ctx.save();
      ctx.strokeStyle = 'rgba(15,23,42,.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(panX + 0.5, panY + 0.5, w - 1, h - 1);
      ctx.restore();
    },

    drawCrop(ctx) {
      const { scale, panX, panY } = S.view;
      const cw = this.core.width, ch = this.core.height;
      const r = this.cropDraft;
      const x = panX + r.x * cw * scale;
      const y = panY + r.y * ch * scale;
      const w = r.w * cw * scale;
      const h = r.h * ch * scale;
      const fullW = cw * scale, fullH = ch * scale;

      ctx.save();
      ctx.fillStyle = 'rgba(15,23,42,.42)';
      ctx.beginPath();
      ctx.rect(panX, panY, fullW, fullH);
      ctx.rect(x + w, y, -w, h); // 反向路径挖空
      ctx.fill('evenodd');

      ctx.strokeStyle = '#2f7bff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      ctx.strokeStyle = 'rgba(255,255,255,.6)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(x + (w / 3) * i, y);
        ctx.lineTo(x + (w / 3) * i, y + h);
        ctx.moveTo(x, y + (h / 3) * i);
        ctx.lineTo(x + w, y + (h / 3) * i);
        ctx.stroke();
      }

      // 四角把手
      ctx.fillStyle = '#2f7bff';
      const s = 7;
      [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => {
        ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
      });

      // 尺寸提示
      const pw = Math.round(r.w * cw), ph = Math.round(r.h * ch);
      ctx.font = '12px "Microsoft YaHei", system-ui, sans-serif';
      const label = pw + ' × ' + ph;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(15,23,42,.86)';
      ctx.fillRect(x, Math.max(panY + 4, y - 24), tw + 14, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 7, Math.max(panY + 19, y - 9));
      ctx.restore();
    },

    bind() {
      const c = this.canvas;
      let drag = null;

      const pos = (e) => {
        const r = c.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };

      c.addEventListener('wheel', (e) => {
        if (!this.core) return;
        e.preventDefault();
        const p = pos(e);
        const f = Math.pow(1.0015, -e.deltaY);
        this.zoomTo(S.view.scale * f, p.x, p.y);
      }, { passive: false });

      c.addEventListener('pointerdown', (e) => {
        if (!this.core) return;
        const p = pos(e);
        c.setPointerCapture(e.pointerId);

        const panning = S.tool === 'pan' || this.spaceDown || e.button === 1;
        if (panning) {
          drag = { mode: 'pan', sx: p.x, sy: p.y, px: S.view.panX, py: S.view.panY };
          c.style.cursor = 'grabbing';
          return;
        }

        if (S.tool === 'crop') {
          const n = this.toCore(p.x, p.y);
          drag = { mode: 'crop', ox: n.nx, oy: n.ny };
          this.cropDraft = { x: n.nx, y: n.ny, w: 0, h: 0 };
          this.invalidate();
          return;
        }

        if (S.tool === 'text') {
          PD.snapshot();
          const n = this.toCore(p.x, p.y);
          S.edit.annotations.push({
            type: 'text',
            color: S.brush.color,
            width: S.brush.width,
            size: S.brush.size,
            text: S.brush.text || '文字',
            points: [[n.nx, n.ny]]
          });
          PD.app().syncPanels();
          this.invalidate();
          return;
        }

        // 画笔 / 箭头 / 矩形 / 椭圆 / 马赛克
        const n = this.toCore(p.x, p.y);
        drag = { mode: 'shape' };
        this.draft = {
          type: S.tool,
          color: S.tool === 'mosaic' ? '#000' : S.brush.color,
          width: S.brush.width,
          points: [[n.nx, n.ny]]
        };
        if (S.tool === 'brush') this.draft.points.push([n.nx, n.ny]);
        else this.draft.points.push([n.nx, n.ny]);
        this.invalidate();
      });

      c.addEventListener('pointermove', (e) => {
        const p = pos(e);
        if (!drag) {
          // 悬浮十字光标提示
          return;
        }
        if (drag.mode === 'pan') {
          S.view.panX = drag.px + (p.x - drag.sx);
          S.view.panY = drag.py + (p.y - drag.sy);
          S.view.fit = false;
          this.invalidate();
          return;
        }
        const n = this.toCore(p.x, p.y);
        if (drag.mode === 'crop') {
          let r = {
            x: Math.min(drag.ox, n.nx),
            y: Math.min(drag.oy, n.ny),
            w: Math.abs(n.nx - drag.ox),
            h: Math.abs(n.ny - drag.oy)
          };
          r = this.applyAspect(r, n.nx > drag.ox ? 1 : -1, n.ny > drag.oy ? 1 : -1);
          this.cropDraft = r;
          this.invalidate();
          return;
        }
        if (drag.mode === 'shape' && this.draft) {
          if (this.draft.type === 'brush') {
            const pts = this.draft.points;
            const last = pts[pts.length - 1];
            if (Math.hypot(n.nx - last[0], n.ny - last[1]) > 0.0015) pts.push([n.nx, n.ny]);
          } else {
            this.draft.points[1] = [n.nx, n.ny];
          }
          this.invalidate();
        }
      });

      const finish = (e) => {
        if (!drag) return;
        const mode = drag.mode;
        drag = null;
        try { c.releasePointerCapture(e.pointerId); } catch { /* noop */ }

        if (mode === 'pan') {
          c.style.cursor = this.cursorForTool();
          return;
        }
        if (mode === 'crop') {
          if (this.cropDraft && (this.cropDraft.w < 0.01 || this.cropDraft.h < 0.01)) this.cropDraft = null;
          this.invalidate();
          PD.app().syncPanels();
          return;
        }
        if (this.draft) {
          const d = this.draft;
          this.draft = null;
          const p0 = d.points[0];
          const p1 = d.points[1] || p0;
          const tiny = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 0.004;
          if (!(tiny && d.type !== 'brush')) {
            PD.snapshot();
            S.edit.annotations.push(d);
            PD.app().syncPanels();
          }
          this.invalidate();
        }
      };

      c.addEventListener('pointerup', finish);
      c.addEventListener('pointercancel', finish);

      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') {
          this.spaceDown = true;
          c.style.cursor = 'grab';
        }
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
          this.spaceDown = false;
          c.style.cursor = this.cursorForTool();
        }
      });

      // 拖拽文件到窗口
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        const paths = [];
        for (const f of e.dataTransfer.files) {
          if (f.path) paths.push(f.path);
        }
        if (paths.length) PD.app().openPaths(paths);
      });
    },

    applyAspect(r, dirX, dirY) {
      const a = this.cropAspect;
      if (!a || a === 'free' || !this.core) return r;
      const [aw, ah] = a.split(':').map(Number);
      const ratio = aw / ah;
      // 在像素空间强制比例
      const px = r.w * this.core.width;
      const py = r.h * this.core.height;
      let w = px, h = py;
      if (w / h > ratio) w = h * ratio; else h = w / ratio;
      const nw = w / this.core.width;
      const nh = h / this.core.height;
      const x = dirX >= 0 ? r.x : r.x + r.w - nw;
      const y = dirY >= 0 ? r.y : r.y + r.h - nh;
      return { x, y, w: nw, h: nh };
    },

    cursorForTool() {
      if (this.spaceDown) return 'grab';
      switch (S.tool) {
        case 'pan': return 'grab';
        case 'crop': return 'crosshair';
        case 'text': return 'text';
        case 'mosaic': return 'cell';
        default: return 'crosshair';
      }
    }
  };

  PD.view = view;
})();
