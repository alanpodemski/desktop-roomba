// phoneHud.js — the phone layout's minimal HUD (SPEC-mobile, as revised by the user), all inside the phone stage:
//   • a compact Liquid Glass status pill under the status bar (mode, battery, bin) with flash() toasts
//   • tap (or touch and drag) on empty wallpaper: the robot drives to that spot (onGoto), with a ripple marker
//   • double-tap on empty wallpaper -> onDoubleTap(x, y) (a new cake on a plate there)
//   • a one-time hint that fades after a few seconds
// No map card and no buttons on phones: the robot docks and empties on its own. Nothing here runs on the desktop.

import { MODE_LABEL } from './overlay.js';

const TAP_MS = 260;           // a tap: released within this time...
const TAP_MOVE = 10;          // ...having moved less than this
const DOUBLE_TAP_MS = 320;    // second tap within this time...
const DOUBLE_TAP_PX = 36;     // ...and this close to the first
const HINT_KEY = 'rb-phone-hint-v3';

/**
 * @param {object} o
 * @param {HTMLElement} o.stage
 * @param {(x: number, y: number) => void} o.onGoto   stage px: drive there
 * @param {(x: number, y: number) => void} o.onDoubleTap   stage px
 * @param {(x: number, y: number) => boolean} o.isFloor   stage px: empty wallpaper (no icon, wall, HUD)
 * @param {() => boolean} [o.isBusy]   the layout is in a mode that owns taps (iOS jiggle mode)
 * @param {boolean} [o.forceHint]
 */
export function createPhoneHud({ stage, onGoto, onDoubleTap, isFloor, isBusy = () => false, forceHint = false }) {
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
  .rb-ph-target { width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; opacity: 0;
    border: 2px solid rgba(255,255,255,.9); box-shadow: 0 0 0 1px rgba(0,0,0,.15), 0 0 12px rgba(255,255,255,.35); }
  .rb-ph-target.on { animation: rb-ph-ripple .9s ease-out infinite; }
  .rb-ph-target.drop { animation: rb-ph-drop .35s ease-out forwards; }
  @keyframes rb-ph-ripple { 0% { opacity: .95; transform: scale(.45); } 100% { opacity: 0; transform: scale(1.35); } }
  @keyframes rb-ph-drop { 0% { opacity: .9; transform: scale(1); } 100% { opacity: 0; transform: scale(.4); } }
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
    hintEl = mk('rb-ph rb-ph-glass rb-ph-hint', 'Tap to send the robot · Double-tap for cake<br>Long-press an icon to move it');
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
    setTimeout(fadeHint, 6000);
  }

  // ---- tap-to-go + double-tap ----------------------------------------------------------------------------
  // Touch the wallpaper: the robot drives to that spot. Keep the finger down and move it: the target follows.
  // A second tap in the same place places a cake there (and the robot is already on its way to it).
  const targetEl = mk('rb-ph rb-ph-target');
  let touch = null;      // { id, x0, y0, x, y, t0 }
  let lastTap = null;    // { x, y, t }
  const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function showTarget(x, y) {
    targetEl.style.left = x + 'px'; targetEl.style.top = y + 'px';
    if (!targetEl.classList.contains('on')) { targetEl.classList.remove('drop'); void targetEl.offsetWidth; targetEl.classList.add('on'); }
  }
  function goto(x, y) { showTarget(x, y); onGoto(x, y); fadeHint(); }
  function end(e) {
    if (!touch) return;
    if (e && e.type === 'pointerup' && performance.now() - touch.t0 < TAP_MS && Math.hypot(touch.x - touch.x0, touch.y - touch.y0) < TAP_MOVE) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(touch.x0 - lastTap.x, touch.y0 - lastTap.y) < DOUBLE_TAP_PX) {
        lastTap = null; onDoubleTap(touch.x0, touch.y0);
      } else lastTap = { x: touch.x0, y: touch.y0, t: now };
    }
    touch = null;
  }
  // sampled in the capture phase, before the layout's own handlers: the tap that ends jiggle mode must not
  // send the robot anywhere or count as half of a double-tap
  let busyAtDown = false;
  stage.addEventListener('pointerdown', () => { busyAtDown = !!isBusy(); }, true);
  stage.addEventListener('pointerdown', (e) => {
    if (touch || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (busyAtDown || isBusy()) { lastTap = null; return; }
    const p = local(e);
    if (!isFloor(p.x, p.y)) { lastTap = null; return; }
    touch = { id: e.pointerId, x0: p.x, y0: p.y, x: p.x, y: p.y, t0: performance.now() };
    goto(p.x, p.y);
  });
  let moveRaf = 0;
  addEventListener('pointermove', (e) => {
    if (!touch || e.pointerId !== touch.id) return;
    if (isBusy()) { end(null); return; }   // the layout took this touch (e.g. entered jiggle mode)
    const p = local(e); touch.x = p.x; touch.y = p.y;
    e.preventDefault();
    if (!moveRaf) moveRaf = requestAnimationFrame(() => { moveRaf = 0; if (touch && isFloor(touch.x, touch.y)) goto(touch.x, touch.y); });
  }, { passive: false });
  addEventListener('pointerup', (e) => { if (touch && e.pointerId === touch.id) end(e); });
  addEventListener('pointercancel', (e) => { if (touch && e.pointerId === touch.id) end(e); });
  addEventListener('blur', () => end(null));
  // no browser double-tap zoom / dblclick selection on the stage
  stage.addEventListener('dblclick', (e) => e.preventDefault());
  /** the robot reached (or gave up on) the target */
  function clearTarget() { if (targetEl.classList.contains('on')) { targetEl.classList.remove('on'); targetEl.classList.add('drop'); } }

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

  function setVisible(v) { targetEl.classList.toggle('hidden', !v); pill.setVisible(v); if (!v && hintEl) hintEl.remove(); }

  return { pill, layout, setVisible, clearTarget, get driving() { return !!touch; } };
}
