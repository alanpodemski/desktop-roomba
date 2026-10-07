// Fake iPhone home screen (iOS 26, Liquid Glass) — the phone counterpart of src/desktop.
// See docs/notes/SPEC-mobile.md "Phone home screen module".
//
//   const phone = await createPhone(stageEl, { stage: true });
//   phone.getWalls() phone.getIcons() phone.getDock() phone.setIconPosition(id, x, y, angle)
//   phone.onIconDragStart(cb) phone.onIconDrag(cb) phone.onIconDragEnd(cb) phone.onResize(cb)
//   phone.setClock(date) phone.getFloorLayer() phone.getSize() phone.getPxPerMeter() phone.data
//
// Coordinates are CSS px relative to the root element (the phone "stage"), origin top-left, +y down —
// identical to the desktop when the stage is the full viewport. Geometry follows a 393×852 pt iPhone
// (iPhone 16/17) and scales with the stage width.
//
// Assets: public/ios/apps.json + icons from scripts/ios-icons.mjs; wallpaper from public/mac/wallpaper.jpg.
// Without them the built-in fallback set in ./fallback.js is used.

import './phone.css';
import { FALLBACK_APPS, PHONE_GLYPHS, FALLBACK_WALLPAPER_CSS } from './fallback.js';

const REF_W = 393;            // iPhone 16/17 width in pt
const PX_PER_M_REF = 210;     // physical scale at 393 px wide: robot Ø 0.34 m ≈ 71 px ≈ an app icon
const LONG_PRESS_MS = 450;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};
async function fetchJSON(url) {
  try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; }
}
function loadImage(src, timeout = 6000) {
  return new Promise((resolve) => {
    if (!src) return resolve(false);
    const img = new Image();
    const t = setTimeout(() => resolve(false), timeout);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = src;
  });
}

// Same idea as the desktop's massFromBytes: log scale, 20 g (empty) … 320 g (≥ 1 GB).
export function massFromBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  const t = clamp(Math.log10(b + 1) / 9, 0, 1);
  return clamp(0.02 * Math.pow(16, t), 0.02, 0.32);
}

// ================================================================== createPhone
export async function createPhone(root, opts = {}) {
  root.innerHTML = '';
  root.classList.add('ph-root');
  if (opts.stage) root.classList.add('ph-staged');
  const query = new URLSearchParams(location.search);

  // ------------------------------------------------------------ data
  const useFallback = query.has('fallback');
  const [appsJSON, sysJSON] = useFallback ? [null, null] : await Promise.all([fetchJSON('/ios/apps.json'), fetchJSON('/mac/system.json')]);
  const scanned = !!(appsJSON && Array.isArray(appsJSON.apps) && appsJSON.apps.length);
  const appData = scanned ? appsJSON : FALLBACK_APPS;
  const symbols = (scanned && appData.symbols) || {};
  const batteryPct = Math.round((sysJSON && sysJSON.battery && sysJSON.battery.percent) ?? 100);

  // ------------------------------------------------------------ geometry
  let W = 0, H = 0, s = 1;
  let L = null; // current layout
  const safe = { top: 0, bottom: 0 };
  const probe = el('div', '', root);
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' });

  function measure() {
    W = root.clientWidth || window.innerWidth;
    H = root.clientHeight || window.innerHeight;
    s = clamp(W / REF_W, 0.8, 1.25);
    const cs = getComputedStyle(probe);
    safe.top = parseFloat(cs.paddingTop) || 0;
    safe.bottom = parseFloat(cs.paddingBottom) || 0;
    root.style.setProperty('--ph-s', String(s));
  }
  function layout() {
    // When the page runs edge-to-edge under the real iOS status bar / home indicator (viewport-fit=cover),
    // the system draws those itself: keep their space but do not draw fakes on top.
    const realTop = safe.top > 20, realBottom = safe.bottom > 10;
    const statusH = realTop ? safe.top : 54 * s;
    const icon = 60 * s;
    const side = 27 * s;                                     // screen edge → first icon
    const pitchX = (W - 2 * side - icon) / 3;
    const colX = (c) => side + icon / 2 + c * pitchX;
    const firstTop = statusH + 18 * s;                       // first row icon top (72 pt)
    const pitchY = 99 * s;
    const rowY = (r) => firstTop + icon / 2 + r * pitchY;
    const dockBottom = H - (realBottom ? safe.bottom + 2 * s : 18 * s);
    const dockH = 88 * s;
    const dock = { x: 12 * s, y: dockBottom - dockH, w: W - 24 * s, h: dockH };
    const searchH = 30 * s;
    const searchTop = dock.y - 14 * s - searchH;
    const homeBarTop = H - 8 * s - 5 * s;
    const earX = (W / 2 - 63 * s) / 2;                       // centre of the space beside the island
    return { statusH, icon, side, pitchX, pitchY, colX, rowY, dock, searchH, searchTop, homeBarTop, earX, realTop, realBottom };
  }
  measure();
  L = layout();
  const pxPerMeter = () => PX_PER_M_REF * (W / REF_W);

  // ------------------------------------------------------------ layers
  const wallpaper = el('div', 'ph-wallpaper', root);
  {
    const src = '/mac/wallpaper.jpg';
    wallpaper.style.backgroundImage = (!useFallback && await loadImage(src, 8000)) ? `url(${src})` : FALLBACK_WALLPAPER_CSS;
  }
  const floorLayer = el('div', 'ph-floor', root);
  const iconsLayer = el('div', 'ph-icons', root);

  // ------------------------------------------------------------ status bar
  const status = el('div', 'ph-status', root);
  const island = el('div', 'ph-island', status);
  const timeEl = el('div', 'ph-time', status);
  const indicators = el('div', 'ph-indicators', status);
  const symImg = (name, svg) => {
    const sym = symbols[name];
    if (sym) {
      const img = el('img', '', indicators); img.src = sym.src; img.alt = '';
      img.style.width = `${sym.w * s}px`; img.style.height = `${sym.h * s}px`;
    } else { const w = el('span', '', indicators); w.innerHTML = svg; }
  };
  symImg('cellularbars', PHONE_GLYPHS.cellular);
  symImg('wifi', PHONE_GLYPHS.wifi);
  { const b = el('span', '', indicators); b.innerHTML = PHONE_GLYPHS.battery(batteryPct); b.firstChild.style.width = `${27.3 * s}px`; b.firstChild.style.height = `${13 * s}px`; }
  const editBtn = el('div', 'ph-pill-btn ph-glass', root); editBtn.textContent = 'Edit';
  const doneBtn = el('div', 'ph-pill-btn ph-glass', root); doneBtn.textContent = 'Done';

  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const calendarFaces = [];
  const setClock = (date = new Date()) => {
    timeEl.textContent = timeFmt.format(date).replace(/\s?[AP]M$/i, ''); // iOS: "10:16", no AM/PM
    for (const f of calendarFaces) {
      f.firstChild.textContent = date.toLocaleDateString('en-US', { weekday: 'long' });
      f.lastChild.textContent = String(date.getDate());
    }
  };

  // ------------------------------------------------------------ search pill, dock, home bar
  const search = el('div', 'ph-search ph-glass', root);
  {
    const sym = symbols.magnifyingglass;
    if (sym) { const img = el('img', '', search); img.src = sym.src; img.alt = ''; img.style.width = `${sym.w * 0.85 * s}px`; img.style.height = `${sym.h * 0.85 * s}px`; }
    else { const g = el('span', '', search); g.innerHTML = PHONE_GLYPHS.search; }
    el('span', '', search).textContent = 'Search';
  }
  const dockEl = el('div', 'ph-dock ph-glass ph-glass-dock', root);
  const homeBar = el('div', 'ph-home-bar', root);

  // ------------------------------------------------------------ icons
  const icons = new Map(); // grid icons (furniture): id -> rec
  const dockIcons = [];
  let jdelay = 0;
  function buildTile(app, parent) {
    const jiggle = el('div', 'ph-jiggle', parent);
    jiggle.style.setProperty('--jdelay', `${-((jdelay += 0.083) % 0.27).toFixed(3)}s`);
    jiggle.style.setProperty('--jd', `${(0.25 + ((jdelay * 7.3) % 0.05)).toFixed(3)}s`);
    const lift = el('div', 'ph-lift', jiggle);
    const tileEl = el('div', 'ph-tile', lift);
    const img = el('img', '', tileEl);
    img.alt = ''; img.draggable = false;
    const fb = FALLBACK_APPS.apps.find((a) => a.id === app.id);
    img.src = app.icon || (fb && fb.icon) || '';
    img.onerror = () => { img.onerror = null; if (fb) img.src = fb.icon; };
    if (app.id === 'calendar') {
      const face = el('div', 'ph-cal', tileEl);
      el('div', 'ph-cal-wd', face); el('div', 'ph-cal-day', face);
      calendarFaces.push(face);
    }
    return lift;
  }
  for (const app of appData.apps) {
    if (app.dock) {
      const node = el('div', 'ph-icon ph-dock-icon', dockEl);
      node.dataset.id = app.id;
      buildTile(app, node);
      dockIcons.push({ app, node });
      continue;
    }
    if (!app.slot) continue;
    const node = el('div', 'ph-icon', iconsLayer);
    node.dataset.id = app.id;
    const lift = buildTile(app, node);
    el('div', 'ph-badge', lift).appendChild(document.createElement('i'));
    el('div', 'ph-label', lift).textContent = app.label;
    icons.set(app.id, {
      id: app.id, name: app.label, kind: 'app', bytes: app.bytes || 0, massKg: massFromBytes(app.bytes),
      slot: app.slot, node, x: 0, y: 0, angle: 0, w: 0, h: 0, moved: false,
    });
  }

  function applyTransform(rec) {
    rec.node.style.transform = `translate3d(${rec.x - rec.w / 2}px, ${rec.y - rec.h / 2}px, 0) rotate(${rec.angle}rad)`;
  }
  function place(resetIcons = true) {
    const { statusH, icon, colX, rowY, dock, searchH, searchTop, homeBarTop, earX, realTop, realBottom } = L;
    status.style.height = `${statusH}px`;
    status.style.display = realTop ? 'none' : '';
    timeEl.style.left = `${earX}px`;
    indicators.style.left = `${W - earX}px`;
    editBtn.style.left = `${earX}px`; editBtn.style.marginLeft = `${-editBtn.offsetWidth / 2}px`;
    doneBtn.style.left = `${W - earX}px`; doneBtn.style.marginLeft = `${-doneBtn.offsetWidth / 2}px`;
    for (const b of [editBtn, doneBtn]) b.style.top = `${realTop ? statusH + 22 * s : 30 * s}px`;
    Object.assign(search.style, { left: `${W / 2}px`, top: `${searchTop}px`, height: `${searchH}px` });
    Object.assign(dockEl.style, { left: `${dock.x}px`, top: `${dock.y}px`, width: `${dock.w}px`, height: `${dock.h}px` });
    dockIcons.forEach(({ node }, i) => {
      node.style.transform = `translate3d(${colX(i) - dock.x - icon / 2}px, ${(dock.h - icon) / 2}px, 0)`;
    });
    homeBar.style.top = `${homeBarTop}px`;
    homeBar.style.display = realBottom ? 'none' : '';
    for (const rec of icons.values()) {
      rec.w = icon; rec.h = icon;
      if (resetIcons) {
        rec.x = colX(rec.slot.col); rec.y = rowY(rec.slot.row); rec.angle = 0; rec.moved = false;
        rec.node.classList.remove('ph-moved');
      } else {
        // height-only change (mobile Safari's toolbar collapsing): furniture stays where it is,
        // only pulled back onto the floor if the floor got shorter
        rec.x = clamp(rec.x, icon / 2, W - icon / 2);
        rec.y = clamp(rec.y, statusH + icon / 2, searchTop - icon / 2);
      }
      applyTransform(rec);
    }
  }
  setClock(new Date());
  place();

  // ------------------------------------------------------------ interaction: tap, long-press → jiggle, drag
  const cbs = { dragStart: [], drag: [], dragEnd: [], resize: [] };
  let jiggling = false;
  const setJiggle = (on) => {
    if (jiggling === on) return;
    jiggling = on;
    root.classList.toggle('ph-jiggling', on);
  };
  const local = (e) => {
    const r = root.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / (r.width || W)), y: (e.clientY - r.top) * (H / (r.height || H)) };
  };
  let gesture = null;
  const endGesture = () => {
    if (!gesture) return;
    clearTimeout(gesture.timer);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    if (gesture.rec) gesture.rec.node.classList.remove('ph-pressed');
    gesture = null;
  };
  function startDrag(g, p) {
    const rec = g.rec;
    g.dragging = true;
    rec.node.classList.remove('ph-pressed');
    rec.node.classList.add('ph-dragging');
    g.grabDX = rec.x - p.x; g.grabDY = rec.y - p.y;
    for (const cb of cbs.dragStart) cb(rec.id);
  }
  function onMove(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.pid) return;
    const p = local(e);
    const dist = Math.hypot(p.x - g.start.x, p.y - g.start.y);
    if (!g.rec) { if (dist > 10) g.moved = true; return; }
    if (!g.dragging) {
      if (!jiggling) {
        // finger moved before the long-press fired: not a press on the icon any more (iOS: page swipe)
        if (dist > 10) { clearTimeout(g.timer); g.rec.node.classList.remove('ph-pressed'); g.cancelled = true; }
        return;
      }
      if (dist < 4 || g.cancelled) return;
      startDrag(g, g.start);
    }
    const rec = g.rec;
    const half = rec.w / 2;
    rec.x = clamp(p.x + g.grabDX, half, W - half);
    rec.y = clamp(p.y + g.grabDY, L.statusH + half, L.searchTop - half);
    applyTransform(rec);
    for (const cb of cbs.drag) cb(rec.id, rec.x, rec.y);
  }
  function onUp(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.pid) return;
    if (g.dragging) {
      g.rec.node.classList.remove('ph-dragging');
      for (const cb of cbs.dragEnd) cb(g.rec.id);
    } else if (!g.rec && !g.onButton && jiggling && !g.moved && performance.now() - g.t0 < 500) {
      setJiggle(false); // tap on empty space leaves jiggle mode
    }
    endGesture();
  }
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (gesture) endGesture();
    if (e.target.closest('.ph-pill-btn')) {
      if (e.target.closest('.ph-pill-btn') === doneBtn) setJiggle(false);
      e.preventDefault();
      return;
    }
    const node = e.target.closest('.ph-icons .ph-icon');
    const dockNode = !node && e.target.closest('.ph-dock-icon');
    const rec = node ? icons.get(node.dataset.id) : null;
    const p = local(e);
    gesture = { pid: e.pointerId, start: p, t0: performance.now(), rec, dragging: false, moved: false, cancelled: false, timer: 0 };
    if (rec || dockNode) e.preventDefault();
    if (rec) {
      try { node.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      if (!jiggling) {
        rec.node.classList.add('ph-pressed');
        gesture.timer = setTimeout(() => {
          if (!gesture || gesture.rec !== rec || gesture.cancelled) return;
          rec.node.classList.remove('ph-pressed');
          setJiggle(true);
          if (navigator.vibrate) try { navigator.vibrate(8); } catch { /* ignore */ }
          // the same finger can now drag the icon without lifting, like iOS
        }, LONG_PRESS_MS);
      }
    } else if (dockNode && !jiggling) {
      const t = setTimeout(() => { if (gesture && !gesture.moved) setJiggle(true); }, LONG_PRESS_MS);
      gesture.timer = t;
      gesture.onButton = true; // dock icons are part of the wall: never dragged
    }
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  });
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  // no page scroll / zoom / rubber-banding while touching the home screen
  root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  root.addEventListener('gesturestart', (e) => e.preventDefault());

  // ------------------------------------------------------------ walls, station
  const getWalls = () => [
    { x: 0, y: 0, w: W, h: L.statusH },
    // search pill + dock + home indicator: one band the width of the dock down to the bottom edge
    { x: L.dock.x, y: L.searchTop, w: L.dock.w, h: H - L.searchTop },
  ];
  const getDock = () => {
    // left edge at ~58 % of the height, facing into the screen (angle π, like the desktop), kept
    // below the icon rows and above the search pill
    const ppm = pxPerMeter();
    const robotR = 0.17 * ppm;
    const lastRow = Math.max(...[...icons.values()].map((r) => r.slot.row), 0);
    const belowIcons = L.rowY(lastRow) + L.icon / 2 + 22 * s + robotR + 6 * s;
    const y = clamp(Math.max(0.58 * H, belowIcons), L.statusH + robotR, L.searchTop - robotR - 8 * s);
    return { x: Math.round(0.18 * ppm), y: Math.round(y), angle: Math.PI };
  };

  // ------------------------------------------------------------ resize
  let resizeTimer = null;
  const relayout = () => {
    const pw = W, prevH = H;
    measure();
    L = layout();
    place(W !== pw); // only a width change re-flows the grid
    if (W !== pw || H !== prevH) for (const cb of cbs.resize) cb({ width: W, height: H });
  };
  const schedule = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 60); };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(root);
  // pills have their width once fonts are in; rAF never fires in hidden tabs, so do not wait on it alone
  await new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
  place(false);

  // ------------------------------------------------------------ public API (same as createDesktop + getPxPerMeter)
  return {
    getWalls,
    getIcons() {
      return [...icons.values()].map((r) => ({
        id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, massKg: r.massKg, name: r.name, kind: r.kind, angle: r.angle, bytes: r.bytes,
      }));
    },
    getDock,
    setIconPosition(id, x, y, angle = 0) {
      const rec = icons.get(id);
      if (!rec || rec.node.classList.contains('ph-dragging')) return; // the user's finger wins
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      rec.x = x; rec.y = y; rec.angle = angle || 0;
      if (!rec.moved && Math.abs(rec.angle) > 1e-3) { rec.moved = true; rec.node.classList.add('ph-moved'); }
      applyTransform(rec);
    },
    onIconDragStart(cb) { cbs.dragStart.push(cb); return () => cbs.dragStart.splice(cbs.dragStart.indexOf(cb), 1); },
    onIconDrag(cb) { cbs.drag.push(cb); return () => cbs.drag.splice(cbs.drag.indexOf(cb), 1); },
    onIconDragEnd(cb) { cbs.dragEnd.push(cb); return () => cbs.dragEnd.splice(cbs.dragEnd.indexOf(cb), 1); },
    onResize(cb) { cbs.resize.push(cb); return () => cbs.resize.splice(cbs.resize.indexOf(cb), 1); },
    setClock,
    getFloorLayer() { return floorLayer; },
    getSize() { return { width: W, height: H, menubarHeight: L.statusH, statusBarHeight: L.statusH, scale: s, pxPerMeter: pxPerMeter() }; },
    getPxPerMeter: pxPerMeter,
    /** extras: jiggle mode control (e.g. leave it when the HUD is used) */
    setJiggle,
    isJiggling: () => jiggling,
    data: { apps: appData.apps, scanned, kind: 'phone' },
    relayout,
  };
}

export default createPhone;
