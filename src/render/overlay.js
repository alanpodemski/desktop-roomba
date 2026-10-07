// overlay.js — iRobot-app style map on #map (2D canvas) and the Liquid-Glass status pill (DOM).

const TEAL = '25, 200, 190';

export function createMapOverlay(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 1, h = 1, dpr = 1;
  let visible = false;

  // Memory: the full-screen map is off most of the time, so its backing store is only allocated while it is
  // shown, and at 1× (flat translucent cells do not need Retina resolution).
  function allocate() {
    const cw = visible ? Math.round(w * dpr) : 1, chh = visible ? Math.round(h * dpr) : 1;
    if (canvas.width !== cw || canvas.height !== chh) { canvas.width = cw; canvas.height = chh; }
  }
  function resize(cw, ch) {
    w = cw; h = ch; dpr = 1;
    allocate();
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    if (!visible) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  function setVisible(v) { visible = v; canvas.style.display = v ? 'block' : 'none'; allocate(); if (!v) ctx.clearRect(0, 0, canvas.width, canvas.height); }
  function toggle() { setVisible(!visible); return visible; }

  function draw(state, dock) {
    if (!visible) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cov = state.coverage, obs = state.obstacleMap;
    const cell = cov.cellPx;
    // dim the room slightly so the map reads like an app screen laid over the desktop
    ctx.fillStyle = 'rgba(8, 14, 20, 0.28)';
    ctx.fillRect(0, 0, w, h);

    // cleaned cells
    const data = cov.data;
    for (let cy = 0; cy < cov.h; cy++) {
      const row = cy * cov.w;
      for (let cx = 0; cx < cov.w; cx++) {
        const p = data[row + cx];
        if (!p) continue;
        const a = Math.min(0.72, 0.28 + p * 0.14);
        ctx.fillStyle = `rgba(${TEAL}, ${a})`;
        ctx.fillRect(cx * cell, cy * cell, cell, cell);
      }
    }
    // obstacle cells: dark grey outline squares (bumped = solid outline, seen = lighter)
    ctx.lineWidth = 1;
    const od = obs.data;
    for (let cy = 0; cy < obs.h; cy++) {
      const row = cy * obs.w;
      for (let cx = 0; cx < obs.w; cx++) {
        const v = od[row + cx];
        if (!v) continue;
        ctx.strokeStyle = v === 1 ? 'rgba(40, 44, 52, 0.95)' : 'rgba(60, 66, 76, 0.7)';
        ctx.fillStyle = v === 1 ? 'rgba(40, 44, 52, 0.55)' : 'rgba(60, 66, 76, 0.3)';
        ctx.fillRect(cx * cell + 0.5, cy * cell + 0.5, cell - 1, cell - 1);
        ctx.strokeRect(cx * cell + 0.5, cy * cell + 0.5, cell - 1, cell - 1);
      }
    }
    // planned path
    if (state.path && state.path.length > 1) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -(performance.now() / 40) % 12;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(state.path[0].x, state.path[0].y);
      for (let i = 1; i < state.path.length; i++) ctx.lineTo(state.path[i].x, state.path[i].y);
      ctx.stroke();
      ctx.restore();
    }
    // dock marker
    if (dock) {
      ctx.save();
      ctx.translate(dock.x, dock.y); ctx.rotate(dock.angle);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = `rgba(${TEAL}, 1)`; ctx.lineWidth = 2;
      roundRect(ctx, -14, -11, 28, 22, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = `rgba(${TEAL}, 1)`;
      ctx.beginPath(); ctx.moveTo(-4, -6); ctx.lineTo(6, 0); ctx.lineTo(-4, 6); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    // robot marker
    const r = state.robot;
    ctx.save();
    ctx.translate(r.x, r.y); ctx.rotate(r.angle);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(30,34,40,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = `rgba(${TEAL}, 1)`;
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(4, -6); ctx.lineTo(4, 6); ctx.closePath(); ctx.fill();
    ctx.restore();
    // legend (top right, under the menu bar)
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('Clean Map', w - 150, 60);
    ctx.fillStyle = `rgba(${TEAL}, 0.75)`; ctx.fillRect(w - 150, 70, 12, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('cleaned', w - 132, 81);
    ctx.fillStyle = 'rgba(40,44,52,0.9)'; ctx.fillRect(w - 150, 88, 12, 12);
    ctx.fillText('obstacles', w - 132, 99);
  }

  return { resize, setVisible, toggle, draw, get visible() { return visible; } };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

export const MODE_LABEL = {
  spiral: 'Cleaning · spiral', bounce: 'Cleaning', wall: 'Cleaning · edge', spot: 'Spot clean', escape: 'Escaping…',
  stuck: 'Stuck!', toDock: 'Returning to dock', docking: 'Docking…', docked: 'Docked', emptying: 'Emptying bin',
  charging: 'Charging', off: 'Battery dead', manual: 'Remote control',
};

/** Liquid-Glass-ish pill, bottom-right. */
export function createStatusPill(parent = document.body) {
  const style = document.createElement('style');
  style.textContent = `
  .rb-pill { position: fixed; right: 18px; bottom: 96px; z-index: 1002; pointer-events: none;
    display: flex; align-items: center; gap: 12px; padding: 9px 14px 9px 11px; border-radius: 999px;
    color: #fff; font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, sans-serif;
    letter-spacing: -0.01em; background: rgba(255,255,255,0.10);
    -webkit-backdrop-filter: blur(22px) saturate(180%); backdrop-filter: blur(22px) saturate(180%);
    box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.55), inset 0 -0.5px 0 rgba(255,255,255,0.12),
      0 0 0 0.5px rgba(255,255,255,0.18), 0 10px 30px rgba(0,0,0,0.28);
    text-shadow: 0 1px 2px rgba(0,0,0,0.3); transition: opacity .25s; }
  .rb-pill.hidden { opacity: 0; }
  .rb-face { width: 30px; height: 30px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #f6f7fa, #c8ccd4 70%, #9ea4ae);
    box-shadow: inset 0 -1px 2px rgba(0,0,0,.25); position: relative; flex: none; }
  .rb-face canvas { position: absolute; inset: 0; }
  .rb-col { display: flex; flex-direction: column; gap: 3px; }
  .rb-mode { font-weight: 600; font-size: 13px; }
  .rb-row { display: flex; gap: 10px; opacity: .85; font-variant-numeric: tabular-nums; }
  .rb-bar { display: inline-block; width: 34px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.22); vertical-align: middle; margin-left: 4px; overflow: hidden; }
  .rb-bar i { display: block; height: 100%; border-radius: 3px; background: #fff; }
  .rb-bar.bat i { background: #4cd964; } .rb-bar.bat.low i { background: #ff9f0a; }
  .rb-bar.bin i { background: #19d8c8; } .rb-bar.bin.full i { background: #ff453a; }
  .rb-fps { opacity: .6; font-size: 11px; margin-left: 4px; }
  `;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.className = 'rb-pill';
  el.innerHTML = `<div class="rb-face"><canvas width="60" height="60" style="width:30px;height:30px"></canvas></div>
    <div class="rb-col"><div class="rb-mode">Cleaning</div>
    <div class="rb-row"><span>Battery <span class="rb-bat">100%</span><span class="rb-bar bat"><i></i></span></span>
    <span>Bin <span class="rb-bin">0%</span><span class="rb-bar bin"><i></i></span></span><span class="rb-fps">60 fps</span></div></div>`;
  parent.appendChild(el);
  const face = el.querySelector('.rb-face canvas').getContext('2d');
  const modeEl = el.querySelector('.rb-mode'), batEl = el.querySelector('.rb-bat'), binEl = el.querySelector('.rb-bin');
  const batBar = el.querySelector('.rb-bar.bat'), binBar = el.querySelector('.rb-bar.bin'), fpsEl = el.querySelector('.rb-fps');
  let visible = true;
  let lastText = '';

  function drawFace(anger, mode) {
    const c = face; c.setTransform(2, 0, 0, 2, 0, 0); c.clearRect(0, 0, 30, 30);
    // eyes
    c.fillStyle = '#1a1b1f';
    const tilt = anger * 0.5;
    for (const s of [-1, 1]) {
      c.beginPath(); c.arc(15 + s * 5.5, 12.5 + anger * 0.5, 2.2, 0, Math.PI * 2); c.fill();
      if (anger > 0.08) { // brows
        c.save(); c.translate(15 + s * 5.5, 8.5); c.rotate(-s * tilt);
        c.fillRect(-3.5, -0.9, 7, 1.8); c.restore();
      }
    }
    // mouth: smile → flat → frown with anger; sleepy flat line when docked
    c.strokeStyle = '#1a1b1f'; c.lineWidth = 1.6; c.lineCap = 'round';
    c.beginPath();
    const curve = (mode === 'charging' || mode === 'docked') ? 0.6 : (1 - anger * 2.2);
    c.moveTo(10.5, 19.5); c.quadraticCurveTo(15, 19.5 + curve * 4, 19.5, 19.5); c.stroke();
    if (anger > 0.6) { c.fillStyle = `rgba(255,70,50,${(anger - 0.6) * 1.5})`; c.beginPath(); c.arc(15, 15, 15, 0, Math.PI * 2); c.fill(); }
  }

  let toastText = '', toastUntil = 0;
  function flash(text, ms = 1600) { toastText = text; toastUntil = performance.now() + ms; }
  function update(r, fps) {
    if (!visible) return;
    const bat = Math.round(r.battery * 100), bin = Math.round(Math.min(1, r.bin) * 100);
    const toast = performance.now() < toastUntil ? toastText : '';
    const txt = `${r.mode}|${r.sub}|${toast}|${bat}|${bin}|${Math.round(r.anger * 20)}|${Math.round(fps)}`;
    if (txt === lastText) return;
    lastText = txt;
    modeEl.textContent = toast || ((MODE_LABEL[r.mode] || r.mode) + (r.mode === 'manual' && r.sub === 'turbo' ? ' · turbo' : ''));
    batEl.textContent = bat + '%'; binEl.textContent = bin + '%';
    batBar.firstElementChild.style.width = bat + '%'; batBar.classList.toggle('low', bat <= 20);
    binBar.firstElementChild.style.width = bin + '%'; binBar.classList.toggle('full', bin >= 95);
    fpsEl.textContent = Math.round(fps) + ' fps';
    drawFace(r.anger, r.mode);
  }
  function setVisible(v) { visible = v; el.classList.toggle('hidden', !v); if (v) lastText = ''; }
  function toggle() { setVisible(!visible); return visible; }
  return { el, update, flash, setVisible, toggle, get visible() { return visible; } };
}
