'use strict';

/* =========================================================================
 * PixDesk · 图像处理引擎
 * 纯 Canvas 2D 实现，无第三方依赖。
 * 渲染顺序：旋转/翻转/微调 → 裁剪 → 调整项 + 滤镜 → 标注 → 水印
 * ========================================================================= */

(function () {
  const PD = (window.PD = window.PD || {});

  const FONT_STACK = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

  /* 滤镜预设：全部可用 ctx.filter / SVG 滤镜语法表达，性能好 */
  const PRESETS = {
    none: { name: '原图', css: '' },
    mono: { name: '黑白', css: 'grayscale(1)' },
    sepia: { name: '复古', css: 'sepia(.65) contrast(1.08) brightness(1.04)' },
    cool: { name: '冷调', css: 'hue-rotate(-12deg) saturate(1.14) brightness(1.03)' },
    warm: { name: '暖阳', css: 'hue-rotate(12deg) saturate(1.16) brightness(1.04)' },
    vivid: { name: '鲜艳', css: 'saturate(1.55) contrast(1.1) brightness(1.02)' },
    film: { name: '胶片', css: 'contrast(1.18) saturate(.86) sepia(.22) brightness(1.02)' },
    fade: { name: '褪色', css: 'contrast(.88) saturate(.88) brightness(1.07)' },
    invert: { name: '反相', css: 'invert(1)' }
  };

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /** 计算旋转 + 翻转 + 微调之后的「基准画布」尺寸（未裁剪） */
  function baseSize(w, h, edit) {
    let W = w, H = h;
    if (Math.abs(edit.rotate) % 180 !== 0) { W = h; H = w; }
    if (edit.fine) {
      const a = (Math.abs(edit.fine) * Math.PI) / 180;
      const c = Math.cos(a), s = Math.sin(a);
      const nw = W * c + H * s;
      const nh = W * s + H * c;
      W = nw; H = nh;
    }
    return { W: Math.max(1, W), H: Math.max(1, H) };
  }

  /** 生成基准画布（旋转 / 翻转 / 微调，含透明背景） */
  function renderBase(src, edit, maxDim) {
    const nw = src.naturalWidth || src.width;
    const nh = src.naturalHeight || src.height;
    const bs = baseSize(nw, nh, edit);

    let k = 1;
    if (maxDim && Math.max(bs.W, bs.H) > maxDim) k = maxDim / Math.max(bs.W, bs.H);

    const out = makeCanvas(bs.W * k, bs.H * k);
    const ctx = out.getContext('2d');
    const sx = out.width / bs.W;
    const sy = out.height / bs.H;

    ctx.save();
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(((edit.rotate + edit.fine) * Math.PI) / 180);
    ctx.scale(edit.flipH ? -sx : sx, edit.flipV ? -sy : sy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, -nw / 2, -nh / 2, nw, nh);
    ctx.restore();

    return out;
  }

  /** 按归一化矩形裁剪 */
  function cropCanvas(c, rect) {
    if (!rect) return c;
    const x = clamp(Math.round(rect.x * c.width), 0, c.width - 1);
    const y = clamp(Math.round(rect.y * c.height), 0, c.height - 1);
    const w = clamp(Math.round(rect.w * c.width), 1, c.width - x);
    const h = clamp(Math.round(rect.h * c.height), 1, c.height - y);
    if (w === c.width && h === c.height) return c;
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, x, y, w, h, 0, 0, w, h);
    return out;
  }

  /** 色温调整（像素级）*/
  function temperaturePass(canvas, amount) {
    const t = clamp(amount, -100, 100) / 100;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const dr = 46 * t;
    const dg = 8 * t;
    const db = -46 * t;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i] + dr;
      d[i + 1] = d[i + 1] + dg;
      d[i + 2] = d[i + 2] + db;
    }
    ctx.putImageData(img, 0, 0);
  }

  /** USM 锐化（3x3 卷积，像素级）*/
  function sharpenPass(canvas, amount) {
    const k = (clamp(amount, 0, 100) / 100) * 0.9;
    if (k <= 0.001) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const srcD = ctx.getImageData(0, 0, w, h);
    const s = srcD.data;
    const outImg = ctx.createImageData(w, h);
    const o = outImg.data;
    const c = 1 + 4 * k;
    const nb = -k;
    for (let y = 0; y < h; y++) {
      const yUp = (y > 0 ? y - 1 : 0) * w;
      const yDn = (y < h - 1 ? y + 1 : h - 1) * w;
      const yC = y * w;
      for (let x = 0; x < w; x++) {
        const xL = x > 0 ? x - 1 : 0;
        const xR = x < w - 1 ? x + 1 : w - 1;
        const iC = (yC + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const v =
            s[iC + ch] * c +
            nb * (s[(yC + xL) * 4 + ch] + s[(yC + xR) * 4 + ch] + s[(yUp + x) * 4 + ch] + s[(yDn + x) * 4 + ch]);
          o[iC + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        o[iC + 3] = s[iC + 3];
      }
    }
    ctx.putImageData(outImg, 0, 0);
  }

  /** 暗角 */
  function vignettePass(canvas, amount) {
    const v = clamp(amount, 0, 100) / 100;
    if (v <= 0) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.28, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,' + (v * 0.85).toFixed(3) + ')');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /** 调整项 + 滤镜预设 */
  function applyAdjust(c, adj, presetId) {
    const f = [];
    const b = (adj.brightness / 100) * (adj.exposure / 100);
    if (Math.abs(b - 1) > 0.001) f.push('brightness(' + b.toFixed(3) + ')');
    if (adj.contrast !== 100) f.push('contrast(' + (adj.contrast / 100).toFixed(3) + ')');
    if (adj.saturation !== 100) f.push('saturate(' + (adj.saturation / 100).toFixed(3) + ')');
    if (adj.blur > 0) f.push('blur(' + adj.blur.toFixed(1) + 'px)');

    const presetCss = (PRESETS[presetId] || PRESETS.none).css;
    const filterStr = [f.join(' '), presetCss].filter(Boolean).join(' ');

    const out = makeCanvas(c.width, c.height);
    const ctx = out.getContext('2d');
    if (filterStr) ctx.filter = filterStr;
    ctx.drawImage(c, 0, 0);
    ctx.filter = 'none';

    if (adj.temperature) temperaturePass(out, adj.temperature);
    if (adj.sharpen > 0) sharpenPass(out, adj.sharpen);
    if (adj.vignette > 0) vignettePass(out, adj.vignette);
    return out;
  }

  /* ------------------------------ 标注 ------------------------------ */

  function arrowPath(ctx, x1, y1, x2, y2, lw) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(lw * 3.6, 10);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 - Math.cos(ang) * head * 0.9, y2 - Math.sin(ang) * head * 0.9);
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(ang - 0.42) * head, y2 - Math.sin(ang - 0.42) * head);
    ctx.lineTo(x2 - Math.cos(ang + 0.42) * head, y2 - Math.sin(ang + 0.42) * head);
    ctx.closePath();
    ctx.fill();
  }

  function mosaicPatch(ctx, x, y, w, h) {
    if (w < 2 || h < 2) return;
    // 兼容带缩放/平移的变换：源矩形用设备像素，目标矩形用本地坐标
    const m = ctx.getTransform();
    const sx = m.a * x + m.c * y + m.e;
    const sy = m.b * x + m.d * y + m.f;
    const sw = Math.abs(m.a) * w;
    const sh = Math.abs(m.d) * h;
    if (sw < 2 || sh < 2) return;

    const block = Math.max(6, Math.round(Math.min(sw, sh) / 14));
    const tw = Math.max(1, Math.round(sw / block));
    const th = Math.max(1, Math.round(sh / block));
    const tmp = makeCanvas(tw, th);
    const tctx = tmp.getContext('2d');
    tctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, tw, th);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
    ctx.restore();
  }

  /** 在任意尺寸画布上绘制标注列表（坐标均为 0~1 归一化）*/
  function drawAnnotations(ctx, list, W, H) {
    if (!list || !list.length) return;
    ctx.save();
    for (const a of list) {
      const lw = Math.max(1, (a.width / 100) * Math.min(W, H) * 0.09);
      ctx.lineWidth = lw;
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      switch (a.type) {
        case 'brush': {
          if (!a.points || a.points.length < 2) {
            if (a.points && a.points.length === 1) {
              const p = a.points[0];
              ctx.beginPath();
              ctx.arc(p[0] * W, p[1] * H, lw / 2, 0, Math.PI * 2);
              ctx.fill();
            }
            break;
          }
          ctx.beginPath();
          ctx.moveTo(a.points[0][0] * W, a.points[0][1] * H);
          for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i][0] * W, a.points[i][1] * H);
          ctx.stroke();
          break;
        }
        case 'arrow': {
          arrowPath(ctx, a.points[0][0] * W, a.points[0][1] * H, a.points[1][0] * W, a.points[1][1] * H, lw);
          break;
        }
        case 'rect': {
          const x = a.points[0][0] * W, y = a.points[0][1] * H;
          ctx.strokeRect(x, y, (a.points[1][0] - a.points[0][0]) * W, (a.points[1][1] - a.points[0][1]) * H);
          break;
        }
        case 'ellipse': {
          const x0 = a.points[0][0] * W, y0 = a.points[0][1] * H;
          const x1 = a.points[1][0] * W, y1 = a.points[1][1] * H;
          ctx.beginPath();
          ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'text': {
          const fs = Math.max(8, (a.size / 100) * H);
          ctx.font = '700 ' + fs + 'px ' + FONT_STACK;
          ctx.textBaseline = 'top';
          const x = a.points[0][0] * W;
          const y = a.points[0][1] * H;
          // 描边保证任何底色下可读
          ctx.lineWidth = Math.max(2, fs / 9);
          ctx.strokeStyle = 'rgba(0,0,0,.55)';
          ctx.strokeText(a.text || '', x, y);
          ctx.fillStyle = a.color;
          ctx.fillText(a.text || '', x, y);
          break;
        }
        case 'mosaic': {
          const x0 = Math.min(a.points[0][0], a.points[1][0]) * W;
          const y0 = Math.min(a.points[0][1], a.points[1][1]) * H;
          const w0 = Math.abs(a.points[1][0] - a.points[0][0]) * W;
          const h0 = Math.abs(a.points[1][1] - a.points[0][1]) * H;
          mosaicPatch(ctx, Math.round(x0), Math.round(y0), Math.round(w0), Math.round(h0));
          break;
        }
        default: break;
      }
    }
    ctx.restore();
  }

  /* ------------------------------ 水印 ------------------------------ */

  function drawWatermark(ctx, wm, W, H) {
    if (!wm || !wm.enabled || !wm.text) return;
    const fs = Math.max(9, (wm.size / 100) * H);
    const font = '700 ' + fs + 'px ' + FONT_STACK;
    ctx.save();
    ctx.font = font;
    ctx.globalAlpha = clamp(wm.opacity, 0, 100) / 100;
    ctx.fillStyle = wm.color;
    ctx.textBaseline = 'alphabetic';

    if (wm.tile) {
      ctx.textBaseline = 'middle';
      const stepX = Math.max(fs * 4, W / 4);
      const stepY = Math.max(fs * 4, H / 6);
      ctx.translate(W / 2, H / 2);
      ctx.rotate(-Math.PI / 9);
      ctx.translate(-W / 2, -H / 2);
      ctx.textAlign = 'center';
      for (let y = -fs * 2; y < H + fs * 4; y += stepY) {
        for (let x = -fs * 4; x < W + fs * 4; x += stepX) {
          ctx.fillText(wm.text, x, y);
        }
      }
      ctx.restore();
      return;
    }

    const m = Math.max(12, Math.min(W, H) * 0.035);
    const tw = ctx.measureText(wm.text).width;
    const pos = wm.pos || 'br';
    let x = W - m - tw;
    let y = H - m;
    if (pos[0] === 't') y = m + fs * 0.82;
    if (pos[0] === 'm') y = H / 2 + fs * 0.35;
    if (pos[0] === 'b') y = H - m;
    if (pos[1] === 'l') x = m;
    if (pos[1] === 'c') x = (W - tw) / 2;
    if (pos[1] === 'r') x = W - m - tw;

    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = fs / 6;
    ctx.fillText(wm.text, x, y);
    ctx.restore();
  }

  /* ------------------------------ 总渲染 ------------------------------ */

  /** 核心渲染：变换 + 裁剪 + 调整 + 滤镜。不含标注、水印 */
  function renderCore(src, edit, maxDim) {
    let c = renderBase(src, edit, maxDim);
    if (edit.crop) c = cropCanvas(c, edit.crop);
    c = applyAdjust(c, edit.adjust, edit.preset);
    return c;
  }

  /** 完整渲染：核心 + 标注 + 水印，用于导出 / 另存 */
  function renderFull(src, edit, maxDim) {
    const core = renderCore(src, edit, maxDim);
    const out = makeCanvas(core.width, core.height);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(core, 0, 0);
    drawAnnotations(ctx, edit.annotations, out.width, out.height);
    drawWatermark(ctx, edit.watermark, out.width, out.height);
    return out;
  }

  /** 导出为 dataURL，flat 为 true 时先铺白底（JPEG 必须）*/
  function toDataUrl(canvas, mime, quality, flat) {
    let c = canvas;
    if (flat) {
      c = makeCanvas(canvas.width, canvas.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(canvas, 0, 0);
    }
    return c.toDataURL(mime, quality);
  }

  function dataUrlBytes(dataUrl) {
    const b64 = String(dataUrl).split(',')[1] || '';
    return Math.floor((b64.length * 3) / 4);
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  PD.imaging = {
    PRESETS,
    makeCanvas,
    baseSize,
    renderBase,
    cropCanvas,
    renderCore,
    renderFull,
    drawAnnotations,
    drawWatermark,
    toDataUrl,
    dataUrlBytes,
    formatBytes,
    clamp,
    FONT_STACK
  };
})();
