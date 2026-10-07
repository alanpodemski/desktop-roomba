// phoneHud.js — the phone layout's minimal HUD (SPEC-mobile, as revised by the user), all inside the phone stage:
//   • a compact Liquid Glass status pill under the status bar (mode, battery, bin) with flash() toasts
//   • a floating glass joystick spawned by touch-and-hold on empty wallpaper (drives via onStick)
//   • double-tap on empty wallpaper -> onDoubleTap(x, y) (a new cake on a plate there)
//   • a one-time hint that fades after a few seconds
// No map card and no buttons on phones: the robot docks and empties on its own. Nothing here runs on the desktop.

import { MODE_LABEL } from './overlay.js';

const HOLD_MS = 180;          // touch-and-hold before the joystick appears
const MOVE_SPAWN = 14;        // ...or this much travel (px) from the touch point
const STICK_R = 44;           // knob travel (px)
const TAP_MS = 260;           // a tap: released within this time...
const TAP_MOVE = 10;          // ...having moved less than this
const DOUBLE_TAP_MS = 320;    // second tap within this time...
const DOUBLE_TAP_PX = 36;     // ...and this close to the first
const HINT_KEY = 'rb-phone-hint-v2';

/**
 * @param {object} o
 * @param {HTMLElement} o.stage
 * @param {(stick: {throttle, steer, turbo} | null) => void} o.onStick
 * @param {(x: number, y: number) => void} o.onDoubleTap   stage px
 * @param {(x: number, y: number) => boolean} o.isFloor   stage px: empty wallpaper (no icon, wall, HUD)
 * @param {() => boolean} [o.isBusy]   the layout is in a mode that owns taps (iOS jiggle mode)
 * @param {boolean} [o.forceHint]
 */
export function createPhoneHud({ stage, onStick, onDoubleTap, isFloor, isBusy = () => false, forceHint = false }) {
  const style = document.createElement('style');
  style.textContent = `
  .rb-ph { position: absolute; z-index: 1002; color: #fff; font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, sans-serif;
    letter-spacing: -0.01em; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; pointer-events: none; }
  .rb-ph-glass { background: rgba(255,255,255,0.12); -webkit-backdrop-filter: blur(20px) saturate(180%); backdrop-filter: blur(20px) saturate(180%);
    box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.6), inset 0 -0.5px 0 rgba(255,255,255,0.14), 0 0 0 0.5px rgba(255,255,255,0.2), 0 6px 18px rgba(0,0,0,0.25); }
  .rb-ph-pill { left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; height: 16px;
    padding: 0 8px; border-radius: 999px; white-space: nowrap; font-size: 10.5px; line-height: 16px; font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 2px rgba(0,0,0,.25); transition: opacity .25s; }
  .rb-ph-pill b { font-weight: 600; }
  .rb-ph-pill .sep { opacity: .45; }
  .rb-ph-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: #4cd964; box-shadow: 0 0 5px rgba(76,217,100,.7); flex: none; }
  .rb-ph-pill .dot.warn { background: #ff9f0a; box-shadow: 0 0 5px rgba(255,159,10,.7); }
  .rb-ph-pill .dot.bad { background: #ff453a; box-shadow: 0 0 5px rgba(255,69,58,.7); }
  .rb-ph-hint { left: 50%; top: 46%; transform: translate(-50%, -50%); padding: 9px 14px; border-radius: 16px; width: max-content; max-width: 90%; white-space: nowrap;
    font-size: 12.5px; line-height: 1.35; text-align: center; transition: opacity .6s ease; }
  .rb-ph-hint.gone { opacity: 0; }
  .rb-ph-stick { width: ${STICK_R * 2 + 26}px; height: ${STICK_R * 2 + 26}px; margin: ${-(STICK_R + 13)}px 0 0 ${-(STICK_R + 13)}px;
    border-radius: 50%; opacity: 0; transform: scale(.7); transition: opacity .15s ease, transform .15s ease; }
  .rb-ph-stick.on { opacity: 1; transform: scale(1); }
  .rb-ph-stick.turbo { box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.6), 0 0 0 2px rgba(120,200,255,0.55), 0 8px 24px rgba(0,0,0,0.28); }
  .rb-ph-knob { position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%;
    background: rgba(255,255,255,0.55); box-shadow: inset 0 1px 0 rgba(255,255,255,.9), 0 4px 12px rgba(0,0,0,.3); }
  .rb-ph.hidden { opacity: 0 !important; }
  `;
  document.head.appendChild(style);
  const mk = (cls, html = '') => { const e = document.createElement('div'); e.className = cls; e.innerHTML = html; stage.appendChild(e); return e; };

  // ---- status pill --------------------------------------------------------------------------------------
  const pillEl = mk('rb-ph rb-ph-glass rb-ph-pill', '<span class="dot"></span><b class="m">Cleaning</b><span class="sep">·</span><span class="bat">100%</span><span class="sep">·</span><span class="bin">Bin 0%</span>');
  pillEl.style.visibility = 'hidden';   // until layout() has placed it under the status bar
  const mEl = pillEl.querySelector('.m'), batEl = pillEl.querySelector('.bat'), binEl = pillEl.querySelector('.bin'), dotEl = pillEl.querySelector('.dot');
  let pillVisible = true, lastText = '', toastText = '', toastUntil = 0;
  const pill = {
    el: pillEl,
    flash(text, ms = 1600) { toastText = text; toastUntil = performance.now() + ms; },
    update(r) {
      if (!pillVisible) return;
      const bat = Math.round(r.battery * 100), bin = Math.round(Math.min(1, r.bin) * 100);
      const toast = performance.now() < toastUntil ? toastText : '';
      const txt = `${r.mode}|${r.sub}|${toast}|${bat}|${bin}|${r.anger > 0.5}`;
      if (txt === lastText) return;
      lastText = txt;
      mEl.textContent = toast || ((MODE_LABEL[r.mode] || r.mode) + (r.mode === 'manual' && r.sub === 'turbo' ? ' · turbo' : ''));
      batEl.textContent = `${bat}%`; binEl.textContent = `Bin ${bin}%`;
      dotEl.className = 'dot' + (r.anger > 0.5 || r.mode === 'stuck' ? ' bad' : bat <= 20 || bin >= 95 ? ' warn' : '');
    },
    setVisible(v) { pillVisible = v; pillEl.classList.toggle('hidden', !v); if (v) lastText = ''; },
    toggle() { pill.setVisible(!pillVisible); return pillVisible; },
    get visible() { return pillVisible; },
  };

  // ---- hint ---------------------------------------------------------------------------------------------
  let hintEl = null;
  let seen = false;
  try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch { /* private mode */ }
  const fadeHint = () => { if (!hintEl) return; hintEl.classList.add('gone'); const h = hintEl; hintEl = null; setTimeout(() => h.remove(), 700); };
  if (forceHint || !seen) {
    hintEl = mk('rb-ph rb-ph-glass rb-ph-hint', 'Hold to drive · Double-tap for cake<br>Long-press an icon to move it');
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
    setTimeout(fadeHint, 6000);
  }

  // ---- joystick + double-tap ----------------------------------------------------------------------------
  const stickEl = mk('rb-ph rb-ph-glass rb-ph-stick', '<div class="rb-ph-knob"></div>');
  const knob = stickEl.querySelector('.rb-ph-knob');
  let touch = null;      // { id, x0, y0, x, y, t0, active, timer }
  let lastTap = null;    // { x, y, t }
  const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function spawn() {
    if (!touch || touch.active) return;
    if (isBusy()) { end(null); return; }
    touch.active = true; lastTap = null;
    stickEl.style.left = touch.x0 + 'px'; stickEl.style.top = touch.y0 + 'px';
    stickEl.classList.add('on');
    fadeHint();
    move(touch.x, touch.y);
  }
  function move(x, y) {
    let dx = x - touch.x0, dy = y - touch.y0;
    const d = Math.hypot(dx, dy);
    if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const turbo = d >= STICK_R * 1.15;          // pushed to (and past) the rim
    stickEl.classList.toggle('turbo', turbo);
    // tank-style like the arrow keys: up = forward, sideways = turn
    onStick({ throttle: -dy / STICK_R, steer: dx / STICK_R, turbo });
  }
  function end(e) {
    if (!touch) return;
    clearTimeout(touch.timer);
    if (touch.active) { stickEl.classList.remove('on', 'turbo'); knob.style.transform = ''; onStick(null); }
    else if (e && e.type === 'pointerup' && performance.now() - touch.t0 < TAP_MS && Math.hypot(touch.x - touch.x0, touch.y - touch.y0) < TAP_MOVE) {
      // a tap on empty wallpaper: the second one in quick succession places a cake there
      const now = performance.now();
      if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(touch.x0 - lastTap.x, touch.y0 - lastTap.y) < DOUBLE_TAP_PX) {
        lastTap = null; fadeHint(); onDoubleTap(touch.x0, touch.y0);
      } else lastTap = { x: touch.x0, y: touch.y0, t: now };
    }
    touch = null;
  }
  // sampled in the capture phase, before the layout's own handlers: the tap that ends jiggle mode must be
  // neither a joystick hold nor half of a double-tap
  let busyAtDown = false;
  stage.addEventListener('pointerdown', () => { busyAtDown = !!isBusy(); }, true);
  stage.addEventListener('pointerdown', (e) => {
    if (touch || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (busyAtDown || isBusy()) { lastTap = null; return; }
    const p = local(e);
    if (!isFloor(p.x, p.y)) { lastTap = null; return; }
    touch = { id: e.pointerId, x0: p.x, y0: p.y, x: p.x, y: p.y, t0: performance.now(), active: false, timer: setTimeout(spawn, HOLD_MS) };
  });
  addEventListener('pointermove', (e) => {
    if (!touch || e.pointerId !== touch.id) return;
    const p = local(e); touch.x = p.x; touch.y = p.y;
    if (!touch.active && isBusy()) { end(null); return; }   // the layout took this touch (e.g. entered jiggle mode)
    if (!touch.active && Math.hypot(p.x - touch.x0, p.y - touch.y0) > MOVE_SPAWN) spawn();
    if (touch.active) { e.preventDefault(); move(p.x, p.y); }
  }, { passive: false });
  addEventListener('pointerup', (e) => { if (touch && e.pointerId === touch.id) end(e); });
  addEventListener('pointercancel', (e) => { if (touch && e.pointerId === touch.id) end(e); });
  addEventListener('blur', () => end(null));
  // no browser double-tap zoom / dblclick selection on the stage
  stage.addEventListener('dblclick', (e) => e.preventDefault());

  // ---- layout -------------------------------------------------------------------------------------------
  /**
   * The pill sits under the status bar, centred in the band between the bar and the first row of icons
   * (on an iPhone that band is only ~16 px, which the compact pill fits).
   * @param {{ W, H, walls: Array<{x,y,w,h}>, icons?: Array<{x,y,w,h}> }} o  stage px
   */
  function layout({ H, walls, icons }) {
    let topY = 0;
    for (const w of walls || []) if (w.y + w.h / 2 < H / 2) topY = Math.max(topY, w.y + w.h);
    let firstIconTop = H;
    for (const ic of icons || []) if (ic.y < H / 2) firstIconTop = Math.min(firstIconTop, ic.y - ic.h / 2);
    const h = pillEl.offsetHeight || 16;
    const gap = firstIconTop - topY;
    pillEl.style.top = Math.round(topY + Math.max(0, Math.min(6, (gap - h) / 2))) + 'px';
    pillEl.style.visibility = '';
  }

  function setVisible(v) { stickEl.classList.toggle('hidden', !v); pill.setVisible(v); if (!v && hintEl) hintEl.remove(); }

  return { pill, layout, setVisible, get driving() { return !!(touch && touch.active); } };
}
