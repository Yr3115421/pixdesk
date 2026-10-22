'use strict';

/* =========================================================================
 * PixDesk · 应用状态与历史栈
 * ========================================================================= */

(function () {
  const PD = (window.PD = window.PD || {});

  function defaultEdit() {
    return {
      crop: null,            // { x, y, w, h } 归一化（基准画布坐标系）
      rotate: 0,             // 0 / 90 / 180 / 270
      flipH: false,
      flipV: false,
      fine: 0,               // 微调角度 -45 ~ 45
      preset: 'none',
      adjust: {
        brightness: 100,
        exposure: 100,
        contrast: 100,
        saturation: 100,
        temperature: 0,
        sharpen: 0,
        blur: 0,
        vignette: 0
      },
      annotations: [],
      watermark: {
        enabled: false,
        text: '© PixDesk',
        size: 4,
        opacity: 55,
        color: '#ffffff',
        pos: 'br',
        tile: false
      }
    };
  }

  const state = {
    files: [],
    dir: null,
    index: -1,

    img: null,
    imgPath: null,
    natural: { w: 0, h: 0 },
    fileSize: 0,

    edit: defaultEdit(),
    history: [],
    future: [],

    view: { scale: 1, fit: true, panX: 0, panY: 0 },

    mode: 'view',       // view | edit
    tab: 'adjust',      // adjust | crop | preset | annotate | watermark | export
    tool: 'pan',        // pan | crop | brush | arrow | rect | ellipse | text | mosaic

    brush: {
      color: '#ff3b30',
      width: 22,        // 相对值 1~100
      text: '点此输入文字',
      size: 6          // 文字大小，相对画布高度百分比
    },

    slideshow: false,
    busy: false
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function snapshot() {
    state.history.push(clone(state.edit));
    if (state.history.length > 60) state.history.shift();
    state.future.length = 0;
  }

  function undo() {
    if (!state.history.length) return false;
    state.future.push(clone(state.edit));
    state.edit = state.history.pop();
    return true;
  }

  function redo() {
    if (!state.future.length) return false;
    state.history.push(clone(state.edit));
    state.edit = state.future.pop();
    return true;
  }

  function resetEdit() {
    state.edit = defaultEdit();
    state.history.length = 0;
    state.future.length = 0;
  }

  /** 是否存在任何修改 */
  function isDirty() {
    const e = state.edit;
    const d = defaultEdit();
    if (e.crop) return true;
    if (e.rotate % 360 !== 0) return true;
    if (e.flipH || e.flipV) return true;
    if (Math.abs(e.fine) > 0.01) return true;
    if (e.preset !== 'none') return true;
    for (const k of Object.keys(d.adjust)) {
      if (Math.abs(e.adjust[k] - d.adjust[k]) > 0.001) return true;
    }
    if (e.annotations.length) return true;
    if (e.watermark.enabled) return true;
    return false;
  }

  /** 生成渲染缓存键，避免重复计算 */
  function renderKey() {
    const e = state.edit;
    return JSON.stringify({
      p: state.imgPath,
      c: e.crop,
      r: e.rotate,
      fh: e.flipH,
      fv: e.flipV,
      fi: e.fine,
      pr: e.preset,
      a: e.adjust
    });
  }

  PD.state = state;
  PD.defaultEdit = defaultEdit;
  PD.clone = clone;
  PD.snapshot = snapshot;
  PD.undo = undo;
  PD.redo = redo;
  PD.resetEdit = resetEdit;
  PD.isDirty = isDirty;
  PD.renderKey = renderKey;
})();
