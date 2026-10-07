// minimap.js — the robot's own "Clean Map" as a small card in the bottom-left corner, styled like the
// map screen of a robot-vacuum app: cleaned area (deeper blue = more passes), walls and obstacles the
// robot has sensed (light lines), Dirt Detect spots, the dock, the robot and its planned path home,
// plus area cleaned and elapsed cleaning time. It only knows what the robot sensed, like the real one.

import { MODE_LABEL } from './overlay.js';

const DOCK_FAMILY = new Set(['docked', 'emptying', 'charging', 'off']);

export function createMiniMap({ parent = document.body, pxPerMeter = 440 } = {}) {
  const style = document.createElement('style');
  style.textContent = `
  .rb-mini { position: fixed; left: 16px; bottom: 16px; z-index: 1002; pointer-events: none;
    width: 300px; padding: 12px 12px 11px; border-radius: 22px; box-sizing: border-box;
    color: #fff; font: 500 12px/1.25 -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, sans-serif;
    letter-spacing: -0.01em; background: rgba(18, 24, 34, 0.42);
    -webkit-backdrop-filter: blur(26px) saturate(170%); backdrop-filter: blur(26px) saturate(170%);
    box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.45), inset 0 -0.5px 0 rgba(255,255,255,0.10),
      0 0 0 0.5px rgba(255,255,255,0.16), 0 14px 40px rgba(0,0,0,0.35);
    transition: opacity .25s; }
  .rb-mini.hidden { opacity: 0; }
  .rb-mini-head { display: flex; align-items: baseline; justify-content: space-between; margin: 0 2px 8px; }
  .rb-mini-title { font-weight: 650; font-size: 13.5px; }
  .rb-mini-mode { opacity: .7; font-size: 11.5px; }
  .rb-mini canvas { display: block; border-radius: 12px; background: rgba(6, 10, 16, 0.55); }
  .rb-mini-stats { display: flex; gap: 0; margin: 9px 2px 0; font-variant-numeric: tabular-nums; }
  .rb-mini-stat { flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .rb-mini-stat b { font-weight: 650; font-size: 15px; }
  .rb-mini-stat span { opacity: .6; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
  `;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.className = 'rb-mini';
  el.innerHTML = `<div class="rb-mini-head"><div class="rb-mini-title">Clean map</div><div class="rb-mini-mode">Cleaning</div></div>
    <canvas></canvas>
    <div class="rb-mini-stats">
      <div class="rb-mini-stat"><b class="rb-area">0.0 m²</b><span>Area cleaned</span></div>
      <div class="rb-mini-stat"><b class="rb-time">00:00</b><span>Elapsed</span></div>
      <div class="rb-mini-stat"><b class="rb-spots">0</b><span>Dirt detect</span></div>
    </div>`;
  parent.appendChild(el);
  const canvas = el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const modeEl = el.querySelector('.rb-mini-mode'), areaEl = el.querySelector('.rb-area');
  const timeEl = el.querySelector('.rb-time'), spotsEl = el.querySelector('.rb-spots');

  // offscreen raster of the robot's grids, one pixel per map cell, rebuilt a few times a second
  const grid = document.createElement('canvas');
  const gctx = grid.getContext('2d');
  let img = null, lastRaster = 0;
  let pageW = 1, pageH = 1, mapW = 276, mapH = 178, dpr = 1;
  let visible = true;
  let elapsed = 0, area = 0;
  const spots = [];
  let lastText = '';

  // avoid(): { dockBar: {x,y,w,h}, station: {x,y} } in page px, so the card never covers the macOS Dock
  // or the robot's charging station
  let avoid = () => ({});
  function setAvoid(fn) { avoid = fn; }
  // px kept free above the card (the controls legend stacks there)
  let reserveAbove = 0;
  function setReserve(px) { reserveAbove = Math.max(0, px || 0); }
  let cardBottom = 16;
  const CHROME_H = 92; // header + stats + padding around the canvas

  function resize(w, h) {
    pageW = w; pageH = h; dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { dockBar, station } = avoid() || {};
    const cardW = Math.round(Math.max(210, Math.min(300, w * 0.17)));
    const pad = 16;
    // sit beside the Dock if there is room, otherwise above it
    let bottom = pad;
    if (dockBar && dockBar.x < pad + cardW + 8) bottom = Math.max(pad, h - dockBar.y + 8);
    el.style.width = cardW + 'px';
    el.style.bottom = bottom + 'px';
    mapW = cardW - 24; mapH = Math.round(mapW * h / w);
    // never reach up to the charging station, and never take more than a third of the screen
    let maxH = h * 0.33 - CHROME_H;
    if (station) maxH = Math.min(maxH, h - bottom - (station.y + 90) - CHROME_H - reserveAbove);
    cardBottom = bottom;
    maxH = Math.max(60, maxH);
    if (mapH > maxH) { mapH = Math.round(maxH); mapW = Math.round(mapH * w / h); }
    canvas.width = Math.round(mapW * dpr); canvas.height = Math.round(mapH * dpr);
    canvas.style.width = mapW + 'px'; canvas.style.height = mapH + 'px';
    canvas.style.margin = '0 auto';
    lastRaster = 0;
  }

  function raster(cov, obs) {
    if (!cov || !obs || !(cov.w > 0) || !(cov.h > 0) || !cov.data || !obs.data) return;   // sim being rebuilt
    if (grid.width !== cov.w || grid.height !== cov.h) { grid.width = cov.w; grid.height = cov.h; img = null; }
    if (!img) img = gctx.createImageData(cov.w, cov.h);
    const d = img.data, c = cov.data, o = obs.data;
    let cleaned = 0;
    for (let i = 0, j = 0; i < c.length; i++, j += 4) {
      const ob = o[i], p = c[i];
      if (ob) {
        // sensed walls and obstacles: light lines, bumped ones brightest
        d[j] = 226; d[j + 1] = 234; d[j + 2] = 242; d[j + 3] = ob === 1 ? 250 : 150;
      } else if (p) {
        cleaned++;
        const k = Math.min(1, (p - 1) / 4);       // 1 pass .. 5+ passes
        d[j] = 120 - 60 * k; d[j + 1] = 196 - 40 * k; d[j + 2] = 240 - 10 * k; d[j + 3] = 150 + 90 * k;
      } else { d[j + 3] = 0; }
    }
    gctx.putImageData(img, 0, 0);
    area = cleaned * (cov.cellPx / pxPerMeter) ** 2;
  }

  function events(evs, robot) {
    for (const e of evs) {
      if (e.type === 'spot') spots.push({ x: e.x ?? robot.x, y: e.y ?? robot.y });
    }
  }

  function update(state, dock, dt) {
    const r = state.robot;
    if (dt > 0) {            // paused frames re-show the same state: do not count its events twice
      events(state.events || [], r);
      if (!DOCK_FAMILY.has(r.mode)) elapsed += dt;
    }
    if (!visible) return;
    const now = performance.now();
    if (now - lastRaster > 200) { raster(state.coverage, state.obstacleMap); lastRaster = now; }

    const sx = mapW / pageW, sy = mapH / pageH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, mapW, mapH);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (grid.width > 0 && grid.height > 0) ctx.drawImage(grid, 0, 0, state.coverage.w * state.coverage.cellPx * sx, state.coverage.h * state.coverage.cellPx * sy);

    // Dirt Detect spots
    for (const s of spots) {
      ctx.fillStyle = 'rgba(255, 159, 10, 0.95)';
      ctx.beginPath(); ctx.arc(s.x * sx, s.y * sy, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255, 159, 10, 0.35)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(s.x * sx, s.y * sy, 5, 0, Math.PI * 2); ctx.stroke();
    }
    // planned path home
    if (state.path && state.path.length > 1) {
      ctx.save();
      ctx.setLineDash([3, 3]); ctx.lineDashOffset = -(now / 60) % 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(state.path[0].x * sx, state.path[0].y * sy);
      for (let i = 1; i < state.path.length; i++) ctx.lineTo(state.path[i].x * sx, state.path[i].y * sy);
      ctx.stroke(); ctx.restore();
    }
    // dock
    if (dock) {
      ctx.save(); ctx.translate(dock.x * sx, dock.y * sy);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      roundRect(ctx, -5, -5, 10, 10, 2.5); ctx.fill();
      ctx.fillStyle = 'rgba(52, 199, 89, 1)';
      ctx.beginPath(); ctx.arc(0, 0, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // robot: white puck with a heading notch and a soft pulse while it works
    const rx = r.x * sx, ry = r.y * sy, rr = 5.5; // an app icon, not to scale
    if (!DOCK_FAMILY.has(r.mode)) {
      const ph = (now / 1200) % 1;
      ctx.strokeStyle = `rgba(120, 196, 240, ${0.5 * (1 - ph)})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(rx, ry, rr + 2 + ph * 8, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.save(); ctx.translate(rx, ry); ctx.rotate(r.angle);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(10,14,20,0.9)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = r.anger > 0.5 ? '#ff453a' : 'rgba(40, 140, 220, 1)';
    ctx.beginPath(); ctx.moveTo(rr * 0.85, 0); ctx.lineTo(rr * 0.2, -rr * 0.45); ctx.lineTo(rr * 0.2, rr * 0.45); ctx.closePath(); ctx.fill();
    ctx.restore();

    // text, only when it changes
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0'), ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    const mode = MODE_LABEL[r.mode] || r.mode;
    const txt = `${mode}|${area.toFixed(1)}|${mm}:${ss}|${spots.length}`;
    if (txt !== lastText) {
      lastText = txt;
      modeEl.textContent = mode;
      areaEl.textContent = `${area.toFixed(1)} m²`;
      timeEl.textContent = `${mm}:${ss}`;
      spotsEl.textContent = String(spots.length);
    }
  }

  function reset() { elapsed = 0; area = 0; spots.length = 0; lastRaster = 0; lastText = ''; }
  function setVisible(v) { visible = v; el.classList.toggle('hidden', !v); if (v) { lastRaster = 0; lastText = ''; } }
  function toggle() { setVisible(!visible); return visible; }

  /** card geometry in page px for stacking other cards: { left, bottom, width, height } */
  function rect() { return { left: 16, bottom: cardBottom, width: el.offsetWidth, height: visible ? el.offsetHeight : 0 }; }

  return { el, resize, setAvoid, setReserve, rect, update, reset, setVisible, toggle, get visible() { return visible; } };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
