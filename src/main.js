// main.js — wires the fake desktop (DOM), the sim (Rapier) and the render layer (three.js).
//
// URL params: ?seed=N  ?battery=MINUTES  ?map  ?nohud  ?debug (outline the sim circle in CSS px)
//             ?smeartest (fake smear stamps from a test path)
// Drive: arrows / WASD (Shift turbo) take the remote; Enter or 4 s idle hands it back to autopilot.
// Keys: M map · I info pill · N sound · H send home to dock · E empty bin now ·
//       C crumbs under cursor · K cake at the cursor · R reset (also smear + cake) · Space pause ·
//       L controls legend
// Phone layout (SPEC-mobile): ?mobile=1 forces it, ?mobile=0 forces the desktop; auto on coarse-pointer screens
// narrower than 600 px. On a laptop with ?mobile=1 the phone runs in a centred 393×852 stage. Minimal HUD: a status
// pill, touch-and-hold on empty wallpaper drives (floating joystick), double-tap there places a cake on a plate.
// ?hint shows the one-time hint again.

import { createSim } from './sim/index.js';
import { createScene, PX_PER_M, setPxPerMeter } from './render/scene.js';
import { loadRobot } from './render/robot.js';
import { loadDock } from './render/dock.js';
import { createDust } from './render/dust.js';
import { createMapOverlay, createStatusPill } from './render/overlay.js';
import { createMiniMap } from './render/minimap.js';
import { createSound } from './render/sound.js';
import { createSmear, createSmearTest } from './render/smear.js';
import { createCakeRenderer, createCakeTest } from './render/cake.js';
import { createPlateRenderer } from './render/plate.js';
import { createLegend } from './render/legend.js';
import { createPhoneHud } from './render/phoneHud.js';

const q = new URLSearchParams(location.search);
const SEED = Number(q.get('seed')) || 1;
const BATTERY_MIN = Number(q.get('battery')) || undefined;
const NOHUD = q.has('nohud');
const DEBUG = q.has('debug');
const SMEARTEST = q.has('smeartest');
const CAKETEST = q.has('caketest');

// ---- layout mode ---------------------------------------------------------------------------------------------
const PHONE_VIEWPORT = matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 600;
const MOBILE = q.get('mobile') === '1' ? true : q.get('mobile') === '0' ? false : PHONE_VIEWPORT;
const STAGE_W = 393, STAGE_H = 852;     // iPhone 15/16 Pro in CSS px

/** Phone layout: wrap #desktop, #gl and #map in a stage. The stage is a containing block for the fixed-position
 *  layers, so they fill it instead of the window. On a real phone it is the whole viewport; on a laptop it is a
 *  centred phone-sized frame. */
function buildStage() {
  const framed = !PHONE_VIEWPORT;
  document.documentElement.classList.add('rb-phone');
  if (framed) document.documentElement.classList.add('rb-phone-framed');
  else {
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp) vp.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  }
  const stage = document.createElement('div');
  stage.id = 'stage';
  document.body.insertBefore(stage, document.body.firstChild);
  for (const id of ['desktop', 'gl', 'map']) stage.appendChild(document.getElementById(id));
  const fit = () => {
    if (!framed) return;
    // a phone-sized frame; on short windows it only gets shorter (no scaling, so pointer px stay 1:1)
    stage.style.width = STAGE_W + 'px';
    stage.style.height = Math.min(STAGE_H, Math.max(480, innerHeight - 32)) + 'px';
  };
  fit();
  addEventListener('resize', fit);
  return { stage, framed };
}

async function loadPhoneModule() {
  try {
    // import.meta.glob: empty while src/phone/ does not exist yet, a normal bundled chunk once it does
    const loaders = import.meta.glob('./phone/index.js');
    const load = loaders['./phone/index.js'];
    if (!load) throw new Error('src/phone/index.js not found');
    const mod = await load();
    if (mod && typeof mod.createPhone === 'function') return { create: mod.createPhone, kind: 'phone' };
    console.warn('[roomba] src/phone/index.js has no createPhone export; using the desktop module in the phone stage');
  } catch (err) {
    console.warn('[roomba] phone module unavailable, using the desktop module in the phone stage:', err && err.message);
  }
  return null;
}

/** the floor layer: between the wallpaper and the icons. desk.getFloorLayer() when the desktop has it,
 *  otherwise the icon container's parent (the smear canvas gets z-index 1, under the icons' 5). */
function floorLayerOf(desk, deskRoot) {
  if (typeof desk.getFloorLayer === 'function') {
    const el = desk.getFloorLayer();
    if (el) return { el, real: true };
  }
  const icons = deskRoot.querySelector('.dk-icons');
  return { el: (icons && icons.parentNode) || deskRoot, real: false };
}

async function loadDesktopModule() {
  try {
    const mod = await import('./desktop/index.js');
    if (mod && typeof mod.createDesktop === 'function') return { createDesktop: mod.createDesktop, real: true };
    console.warn('[roomba] src/desktop/index.js has no createDesktop export; using mock desktop');
  } catch (err) {
    console.warn('[roomba] real desktop module unavailable, using mock desktop:', err && err.message);
  }
  const mock = await import('./render/mockDesktop.js');
  return { createDesktop: mock.createDesktop, real: false };
}

async function boot() {
  const stageInfo = MOBILE ? buildStage() : null;
  const stage = stageInfo && stageInfo.stage;
  const deskRoot = document.getElementById('desktop');
  let desk, layoutKind;
  const phoneMod = MOBILE ? await loadPhoneModule() : null;
  if (phoneMod) {
    desk = await phoneMod.create(deskRoot, { stage });
    layoutKind = 'phone';
  } else {
    const { createDesktop, real } = await loadDesktopModule();
    desk = await createDesktop(deskRoot);
    layoutKind = real ? 'desktop' : 'mock';
  }
  window.__desktopModule = layoutKind;
  window.__mode = MOBILE ? (stageInfo.framed ? 'phone (framed stage)' : 'phone') : 'desktop';
  console.info(`[roomba] mode: ${window.__mode}, layout module: ${layoutKind}`);
  setInterval(() => desk.setClock(new Date()), 1000);

  // page size: the window on the desktop, the stage on a phone
  const pageSize = () => (stage ? { w: stage.clientWidth, h: stage.clientHeight } : { w: innerWidth, h: innerHeight });
  // physical scale: desktop 440 px/m; phone layout's own value, else ≈ 210 px/m on a 393 px wide phone
  if (MOBILE) {
    const v = typeof desk.getPxPerMeter === 'function' ? desk.getPxPerMeter() : 210 * pageSize().w / STAGE_W;
    setPxPerMeter(v);
  }
  window.__pxPerMeter = PX_PER_M;
  // stage-relative pointer coordinates (the stage is offset on a laptop)
  let stageOff = { x: 0, y: 0 };
  const updateStageOff = () => { if (stage) { const r = stage.getBoundingClientRect(); stageOff = { x: r.left, y: r.top }; } };
  updateStageOff();

  const glCanvas = document.getElementById('gl');
  const mapCanvas = document.getElementById('map');
  const view = createScene(glCanvas, MOBILE ? { dprCap: 2, shadowMapSize: 512 } : {});
  const map = createMapOverlay(mapCanvas);
  const hudParent = stage || document.body;
  let phoneHud = null;
  if (MOBILE) {
    phoneHud = createPhoneHud({
      stage,
      onGoto: (x, y) => setGoto(x, y),
      onDoubleTap: (x, y) => { if (!plateNear(x, y)) placeCake(x, y); },   // double-tap on a cake rams it, no second cake
      isFloor: (x, y) => isFloor(x, y),
      isBusy: () => typeof desk.isJiggling === 'function' && !!desk.isJiggling(),
      forceHint: q.has('hint'),
    });
  }
  const pill = phoneHud ? phoneHud.pill : createStatusPill(document.body);
  // no Clean map card on phones: a stub keeps the shared code unchanged
  const mini = MOBILE
    ? { el: document.createElement('div'), visible: false, expanded: false, resize() {}, setAvoid() {}, setReserve() {}, rect() { return { left: 0, bottom: 0, width: 0, height: 0 }; }, update() {}, reset() {}, setVisible() {}, toggle() { return false; } }
    : createMiniMap({ parent: hudParent, pxPerMeter: PX_PER_M });
  if (q.has('nominimap') || NOHUD) mini.setVisible(false);
  // no keyboard legend on phones: a stub keeps the desktop layout code unchanged
  const legend = MOBILE
    ? { el: document.createElement('div'), visible: false, toggle() { return false; }, setVisible() {}, height() { return 0; }, place() {} }
    : createLegend(document.body);
  if (NOHUD || q.has('nolegend')) legend.setVisible(false);
  if (NOHUD && phoneHud) phoneHud.setVisible(false);
  const floor = floorLayerOf(desk, deskRoot);
  window.__floorLayer = floor.real ? 'desk.getFloorLayer()' : 'fallback (icon container parent)';
  console.info(`[roomba] smear floor layer: ${window.__floorLayer}`);
  const sound = createSound();
  const dustR = createDust(view.scene, MOBILE ? 2500 : 4000);
  map.setVisible(q.has('map') && !NOHUD);
  if (NOHUD) pill.setVisible(false);

  let { w: W, h: H } = pageSize();
  view.resize(W, H); map.resize(W, H);

  const [robot, dockR, cakeR, plateR] = await Promise.all([loadRobot(view.scene), loadDock(view.scene), createCakeRenderer(view.scene), createPlateRenderer(view.scene)]);
  const keyDir = view.key.position.clone().sub(view.key.target.position);
  const smear = createSmear({ parent: floor.el, lightDir: keyDir });
  let smearOk = true;
  smear.resize(W, H);
  let cakeTest = CAKETEST ? createCakeTest(W * 0.5, H * 0.45) : null;
  let smearTest = SMEARTEST ? createSmearTest(W, H, { pxPerMeter: PX_PER_M }) : null;
  // the robot's docked pose: the desktop's suggestion, nudged so the dock body stays on the page
  const dockPose = () => dockR.fitPose(desk.getDock(), W, H);
  mini.setAvoid(() => ({ dockBar: desk.getWalls()[1], station: dockPose() }));
  mini.resize(W, H);

  // controls legend stacked on the minimap. It must never cover the minimap, the macOS Dock or the
  // charging station: stack above the minimap when there is room below the station, otherwise sit to the
  // minimap's right on the same baseline (small pages), otherwise hide.
  function layoutHud() {
    if (phoneHud) { phoneHud.layout({ W, H, walls: desk.getWalls(), icons: desk.getIcons() }); return; }
    mini.setReserve(0);
    mini.resize(W, H);
    if (!legend.visible) return;
    const m = mini.rect();
    const width = m.width || 300;
    const lh = legend.height();
    const st = dockPose();
    const stationBottom = st.y + 70;
    const stackBottom = m.bottom + (m.height ? m.height + 8 : 0);
    let pos = null;
    if (H - (stackBottom + lh) >= stationBottom) pos = { left: m.left, bottom: stackBottom, width };
    else {
      // side by side, above the Dock bar, left of the status pill
      const dockBar = desk.getWalls()[1];
      const left = m.left + width + 10;
      const bottom = Math.max(m.bottom, dockBar ? H - dockBar.y + 8 : m.bottom);
      const pillLeft = pill.el.getBoundingClientRect().left || W;
      const pillTop = pill.el.getBoundingClientRect().top || H;
      const clearsPill = left + width + 8 < pillLeft || H - bottom - lh > pillTop;
      if (left + width < W - 16 && clearsPill) pos = { left, bottom, width };
    }
    legend.el.style.opacity = pos ? '' : '0';
    if (pos) legend.place(pos);
  }
  layoutHud();

  // ---- sim -------------------------------------------------------------------------------------------
  let sim = null;
  let state = null;
  const dragging = new Set();
  const lastPushed = new Map(); // id -> {x,y,angle} last position we wrote into the DOM

  async function makeSim(prevCoverage) {
    const s = await createSim({
      width: W, height: H, pxPerMeter: PX_PER_M, seed: SEED, batteryMinutes: BATTERY_MIN,
      dock: dockPose(), walls: desk.getWalls(), obstacles: desk.getIcons(),
    });
    if (prevCoverage) {
      // keep what was cleaned: copy the overlapping cells of the old grid into the new one
      const nc = s.getState().coverage;
      const w = Math.min(nc.w, prevCoverage.w), h = Math.min(nc.h, prevCoverage.h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) nc.data[y * nc.w + x] = prevCoverage.data[y * prevCoverage.w + x];
    }
    lastPushed.clear();
    dustR.reset();
    return s;
  }
  sim = await makeSim(null);
  state = sim.getState();
  dockR.place(dockPose());

  // drag → kinematic
  desk.onIconDragStart((id) => {
    dragging.add(id);
    const ic = desk.getIcons().find((i) => i.id === id);
    if (ic && sim) sim.setObstacleKinematic(id, ic.x, ic.y);
  });
  desk.onIconDrag((id, x, y) => { if (sim) sim.setObstacleKinematic(id, x, y); });
  desk.onIconDragEnd((id) => {
    dragging.delete(id);
    if (sim) sim.releaseObstacle(id);
  });

  // resize → new sim with the same seed, coverage carried over
  let resizePending = null;
  async function onResize() {
    ({ w: W, h: H } = pageSize());
    updateStageOff();
    view.resize(W, H); map.resize(W, H); smear.resize(W, H); layoutHud();
    if (SMEARTEST) smearTest = createSmearTest(W, H, { pxPerMeter: PX_PER_M });
    const prevCov = state ? { w: state.coverage.w, h: state.coverage.h, data: state.coverage.data.slice() } : null;
    const s = await makeSim(prevCov);
    sim = s; state = sim.getState();
    dockR.place(dockPose());
  }
  const scheduleResize = () => { clearTimeout(resizePending); resizePending = setTimeout(() => onResize().catch(console.error), 250); };
  addEventListener('resize', scheduleResize);
  if (desk.onResize) desk.onResize(scheduleResize);

  // ---- input --------------------------------------------------------------------------------------------
  let paused = false;
  const mouse = { x: W / 2, y: H / 2 };
  addEventListener('pointermove', (e) => { mouse.x = e.clientX - stageOff.x; mouse.y = e.clientY - stageOff.y; }, { passive: true });
  if (stage) addEventListener('scroll', updateStageOff, { passive: true });
  /** stage px: empty wallpaper, i.e. not on an icon, the status bar, the Search pill / Dock or the HUD */
  function isFloor(x, y) {
    if (x < 0 || y < 0 || x > W || y > H) return false;
    for (const w of desk.getWalls()) if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return false;
    const obs = state ? state.obstacles : null;
    for (const ic of desk.getIcons()) {
      const o = obs && obs.find((b) => b.id === ic.id);
      const cx = o ? o.x : ic.x, cy = o ? o.y : ic.y, a = o ? o.angle : (ic.angle || 0);
      const dx = x - cx, dy = y - cy, c = Math.cos(a), s = Math.sin(a);
      if (Math.abs(dx * c + dy * s) <= ic.w / 2 + 4 && Math.abs(-dx * s + dy * c) <= ic.h / 2 + 4) return false;
    }
    return true;
  }
  const unlock = () => sound.resume();
  addEventListener('pointerdown', unlock, { passive: true });
  addEventListener('keydown', unlock);
  // ---- remote control: arrows / WASD drive, Shift = turbo, Enter (or 4 s idle) hands it back ----------------
  const DRIVE_KEYS = { ArrowUp: 'f', KeyW: 'f', ArrowDown: 'b', KeyS: 'b', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r' };
  const drive = { held: new Set(), turbo: false, lastInput: -1e9, throttle: 0, steer: 0, stick: null, goto: null };
  const HANDBACK_S = 4;
  window.__drive = drive;
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Shift') drive.turbo = true;
    const k = DRIVE_KEYS[e.code];
    if (!k) return;
    e.preventDefault();
    drive.held.add(k);
    drive.lastInput = performance.now();
  });
  addEventListener('keyup', (e) => {
    if (e.key === 'Shift') drive.turbo = false;
    const k = DRIVE_KEYS[e.code];
    if (k) { drive.held.delete(k); drive.lastInput = performance.now(); }
  });
  addEventListener('blur', () => { drive.held.clear(); drive.turbo = false; });
  // hand the robot back now: forget held keys and the idle grace period
  function dropRemote() {
    drive.held.clear(); drive.lastInput = -1e9; drive.throttle = 0; drive.steer = 0; drive.stick = null;
    if (drive.goto) { drive.goto = null; phoneHud?.clearTarget(); }
    if (sim) sim.setManual(null);
  }
  // the plate (with a cake) under a tap, if any
  function plateNear(x, y) {
    const plates = (state && state.plates) || [];
    let best = null, bd = Infinity;
    for (const p of plates) {
      const d = Math.hypot(p.x - x, p.y - y), r = (p.r || 0.11 * PX_PER_M) * 1.35;
      if (d < r && d < bd) { bd = d; best = p; }
    }
    return best;
  }
  function setGoto(x, y) {
    const r = state && state.robot;
    const plate = plateNear(x, y);
    const g = { x, y, best: Infinity, bestT: performance.now(), ram: false };
    if (plate && r) {
      // tapping the cake means "hit it": drive through the plate, aiming a robot radius beyond its centre
      const dx = plate.x - r.x, dy = plate.y - r.y, d = Math.hypot(dx, dy) || 1, Rpx = 0.17 * PX_PER_M;
      g.x = plate.x + dx / d * Rpx; g.y = plate.y + dy / d * Rpx; g.ram = true;
    }
    drive.goto = g; drive.held.clear(); drive.lastInput = performance.now();
  }
  // tap-to-go (phones): steer the real wheel motors toward the tapped spot, full speed through it, so tapping
  // the cake rams it. Turns in place when the target is behind, gives up if it makes no progress for 3 s.
  function gotoCommand() {
    const g = drive.goto, r = state && state.robot;
    if (!g || !r) return null;
    const Rpx = 0.17 * PX_PER_M;
    const dx = g.x - r.x, dy = g.y - r.y, dist = Math.hypot(dx, dy);
    const now = performance.now();
    if (dist < g.best - 4) { g.best = dist; g.bestT = now; }
    if (dist < Rpx * 0.3 || now - g.bestT > 3000) {
      if (now - g.bestT > 3000) pill.flash("Can't get there");
      drive.goto = null; phoneHud?.clearTarget(); return null;
    }
    let err = Math.atan2(dy, dx) - r.angle;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const steer = Math.max(-1, Math.min(1, err * 2.2));
    const throttle = Math.abs(err) > 1.0 ? 0 : Math.max(0.35, Math.cos(err));
    return { throttle, steer, turbo: (g.ram || dist > Rpx * 2.5) && Math.abs(err) < 0.35 };
  }
  function updateDrive(dt) {
    if (!sim) return;
    const h = drive.held;
    if (h.size && drive.goto) { drive.goto = null; phoneHud?.clearTarget(); }   // keys take over
    const go = gotoCommand();
    if (go) drive.lastInput = performance.now();
    const st = go || drive.stick;
    // the phone's joystick is analogue; the keys are on/off
    const tgtT = st ? st.throttle : (h.has('f') ? 1 : 0) - (h.has('b') ? 1 : 0);
    const tgtS = st ? st.steer : (h.has('r') ? 1 : 0) - (h.has('l') ? 1 : 0);
    // thumb-on-a-joystick smoothing so taps are gentle and holds are full power
    const a = Math.min(1, dt * 8);
    drive.throttle += (tgtT - drive.throttle) * a;
    drive.steer += (tgtS - drive.steer) * Math.min(1, dt * 12);
    const idle = (performance.now() - drive.lastInput) / 1000;
    if (h.size || st || idle < HANDBACK_S) {
      if (st) drive.lastInput = performance.now();
      sim.setManual({ throttle: drive.throttle, steer: drive.steer, turbo: st ? st.turbo : drive.turbo });
    } else if (sim.manual) {
      sim.setManual(null);
    }
  }

  async function resetAll() {
    const s = await makeSim(null); sim = s; state = sim.getState(); mini.reset();
    smear.clear(); cakeR.reset(); plateR.reset();
    if (CAKETEST) cakeTest = createCakeTest(W * 0.5, H * 0.45);
    if (SMEARTEST) smearTest = createSmearTest(W, H, { pxPerMeter: PX_PER_M });
  }
  function placeCake(x, y) {
    if (typeof sim.placeCake !== 'function') { pill.flash('No cake in this sim yet'); return; }
    sim.placeCake(x, y, Math.random() * Math.PI * 2);
    pill.flash('Cake!');
  }

  addEventListener('keydown', async (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (DRIVE_KEYS[e.code]) return;
    switch (e.key) {
      case 'm': case 'M': {
        // cycle: corner map -> full-screen map -> no map
        if (mini.visible && !map.visible) { mini.setVisible(false); map.setVisible(true); }
        else if (map.visible) { map.setVisible(false); }
        else { mini.setVisible(true); }
        layoutHud();
        break;
      }
      case 'i': case 'I': pill.toggle(); break;
      case 'n': case 'N': sound.toggle(); break;
      case 'h': case 'H': dropRemote(); sim.sendToDock(); pill.flash('Going home'); break;
      case 'e': case 'E': sim.emptyBinNow(); break;
      case 'c': case 'C': sim.addDust(mouse.x, mouse.y, 30); break;
      case 'r': case 'R': await resetAll(); break;
      case 'k': case 'K': placeCake(mouse.x, mouse.y); break;   // the cake stands where the cursor is
      case 'l': case 'L': legend.toggle(); layoutHud(); break;
      case 'Enter': dropRemote(); pill.flash('Autopilot'); break;
      case ' ': paused = !paused; e.preventDefault(); break;
    }
  });

  // ---- debug outline (verifies px ↔ world mapping) --------------------------------------------------------
  let dbg = null;
  if (DEBUG) {
    dbg = document.createElement('canvas');
    Object.assign(dbg.style, { position: 'fixed', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1003 });
    document.body.appendChild(dbg);
  }
  function drawDebug() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (dbg.width !== W * dpr) { dbg.width = W * dpr; dbg.height = H * dpr; }
    const c = dbg.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    const r = state.robot;
    c.strokeStyle = 'rgba(255,60,60,0.95)'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(r.x, r.y, 0.17 * PX_PER_M, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(r.x, r.y); c.lineTo(r.x + Math.cos(r.angle) * 75, r.y + Math.sin(r.angle) * 75); c.stroke();
    // project the model's own front point through the real camera: should land on the red line's tip
    const fp = robot.frontPoint();
    const pp = view.worldToPx(fp.x, fp.y, fp.z);
    c.strokeStyle = 'rgba(60,255,120,0.95)'; c.beginPath(); c.arc(pp.x, pp.y, 5, 0, Math.PI * 2); c.stroke();
    // the four page corners through the camera
    for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H]]) {
      const w = view.toWorld(px, py); const p = view.worldToPx(w.x, 0, w.z);
      c.fillStyle = 'rgba(60,255,120,0.9)'; c.fillRect(p.x - 3, p.y - 3, 6, 6);
    }
    c.strokeStyle = 'rgba(80,160,255,.9)';
    for (const o of state.obstacles) { const ic = desk.getIcons().find((i) => i.id === o.id); if (!ic) continue; c.save(); c.translate(o.x, o.y); c.rotate(o.angle); c.strokeRect(-ic.w / 2, -ic.h / 2, ic.w, ic.h); c.restore(); }
    c.fillStyle = '#fff'; c.font = '11px monospace';
    c.fillText(`sim (${r.x.toFixed(1)}, ${r.y.toFixed(1)}) a=${r.angle.toFixed(2)}  model front → (${pp.x.toFixed(1)}, ${pp.y.toFixed(1)})  mode=${r.mode} ${state.robot.sub || ''}`, 12, H - 60);
  }

  // ---- main loop -------------------------------------------------------------------------------------
  const recentEvents = [];
  window.__events = recentEvents;
  let last = performance.now();
  let fps = 60, fpsAcc = 0, fpsN = 0, fpsT = last;
  window.__fps = () => fps;
  // CPU/GPU: skip every other frame on fast screens (120 Hz ProMotion -> 60 fps, 144 Hz -> 72) to halve the work
  // and heat; 60 and 75 Hz screens keep every frame. The sim uses real dt anyway.
  const MIN_FRAME_MS = 12;
  function frame(now) {
    requestAnimationFrame(frame);
    tick(now);
  }
  /** one frame of the app (exposed as __roomba.tick for scripted tests while the tab is hidden) */
  function tick(now) {
    if (now - last < MIN_FRAME_MS) return;
    let dt = (now - last) / 1000; last = now;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 1 / 30);
    fpsAcc += dt; fpsN++;
    if (now - fpsT > 500) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; fpsT = now; }

    if (!paused && sim) {
      updateDrive(dt);
      sim.step(dt);
      state = sim.getState();
      // push physical icon positions back into the DOM (skip icons the user holds)
      for (const o of state.obstacles) {
        if (dragging.has(o.id)) continue;
        const lp = lastPushed.get(o.id);
        if (lp && Math.abs(lp.x - o.x) < 0.01 && Math.abs(lp.y - o.y) < 0.01 && Math.abs(lp.angle - o.angle) < 1e-4) continue;
        if (!lp) {
          // first sighting: only write if it differs from where the desktop has it (avoid marking everything "moved")
          const ic = desk.getIcons().find((i) => i.id === o.id);
          if (ic && Math.abs(ic.x - o.x) < 0.01 && Math.abs(ic.y - o.y) < 0.01 && Math.abs((ic.angle || 0) - o.angle) < 1e-4) { lastPushed.set(o.id, { x: o.x, y: o.y, angle: o.angle }); continue; }
        }
        desk.setIconPosition(o.id, o.x, o.y, o.angle);
        lastPushed.set(o.id, { x: o.x, y: o.y, angle: o.angle });
      }
      sound.handleEvents(state.events);
      if (state.smear && state.smear.length) smear.addStamps(state.smear, state.plates);
      if (smearTest) smear.addStamps(smearTest.step(dt));
      for (const ev of state.events) if (ev.type === 'binEmptied') pill.flash('Bin emptied');
      if (state.events.length) { recentEvents.push(...state.events); if (recentEvents.length > 40) recentEvents.splice(0, recentEvents.length - 40); }
    }
    if (state) {
      const r = state.robot;
      const sdt = paused ? 0 : dt;
      if (sdt > 0) {
        robot.update(r, sdt);
        dockR.update(r, sdt);
        dustR.update(state.dust);
        cakeR.update(cakeTest ? cakeTest.step(sdt) : (state.cakes ?? state.cake ?? null), sdt);
        plateR.update(state.plates, sdt);
        sound.setPlateSpeed(plateR.speed / PX_PER_M);
        sound.update(r, sdt);
      }
      map.draw(state, dockPose());
      mini.update(state, dockPose(), sdt);
      pill.update(r, fps);
      if (dbg) drawDebug();
    }
    if (smearOk) {
      try { smear.render(); } catch (err) { smearOk = false; console.error('[roomba] smear layer disabled:', err); }
    }
    view.render();
  }
  requestAnimationFrame(frame);

  // expose for debugging in the console
  window.__roomba = { tick: (now) => tick(now), get sim() { return sim; }, get state() { return state; }, desk, view, robot, sound, map, pill, mini, legend, smear, cake: cakeR, plate: plateR, layoutHud, phoneHud, drive, updateDrive, stage, mode: window.__mode };
}

boot().catch((err) => {
  console.error('[roomba] boot failed', err);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;left:12px;top:48px;color:#fff;background:rgba(200,0,0,.8);padding:8px 12px;border-radius:8px;z-index:9999;font:12px monospace';
  el.textContent = 'boot failed: ' + (err && err.stack || err);
  document.body.appendChild(el);
});
