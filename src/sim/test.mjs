// test.mjs — headless check of the sim: `node src/sim/test.mjs` (npm run test:sim)
// Scenario A: 1700x1100 desktop, 12 icons, dock, menu bar + Dock walls, 10 simulated minutes.
// Scenario B: corner trap with a 5 kg icon -> must produce a 'stuck' event, icon must not move.
// Scenario C: the cake incident, autonomous: robot bumps the standing slice sideways -> tips -> lands
//             -> robot climbs onto it (hung up, wheels slipping) -> crush -> tyre/brush tracks over > 5 m
//             -> load fades ('smearOut'). Plus determinism, placeCake() and resetMess().
// Scenario D: the same by hand: setManual() drives straight into the cake, then hands back control.

import { performance } from 'node:perf_hooks';
import { createSim, MESS } from './index.js';

const W = 1700, H = 1100;
const HZ = 60, DT = 1 / HZ;
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}
const walls = [
  { x: 0, y: 0, w: W, h: 38 },                       // menu bar
  { x: W / 2 - 400, y: H - 72, w: 800, h: 72 },     // Dock, bottom centre
];
const dock = { x: 130, y: H - 150, angle: Math.PI / 2 };

// Finder-style grid from the right edge, varied masses (kg)
function makeIcons() {
  const masses = [0.05, 0.12, 0.3, 0.6, 1.0, 1.8, 0.08, 2.6, 0.2, 3.5, 5.0, 0.45];
  const icons = [];
  let k = 0;
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 4; row++) {
      const x = W - 70 - col * 130, y = 110 + row * 150;
      icons.push({ id: `icon${k}`, x, y, w: 84, h: 96, massKg: masses[k] });
      k++;
    }
  }
  // pull one heavy and a couple of light ones into the middle so they are met early
  icons[10].x = 900; icons[10].y = 420;          // 5 kg
  icons[0].x = 600; icons[0].y = 700;            // 50 g
  icons[6].x = 1100; icons[6].y = 800;           // 80 g
  icons[4].x = 500; icons[4].y = 300;            // 1 kg
  return icons;
}

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { avg, p50: q(0.5), p99: q(0.99), max: s[s.length - 1] };
}

// "Free" cells = cells the main brush can physically reach: not inside walls/icons (at their initial
// positions) and not closer to them or to the page edge than ROBOT_R - BRUSH_R (75 - 44 = 31 px).
const UNREACHABLE_PX = 31;
function freeCellMask(sim, icons) {
  const cov = sim.getState().coverage;
  const mask = new Uint8Array(cov.w * cov.h);
  let n = 0;
  const m = UNREACHABLE_PX;
  for (let cy = 0; cy < cov.h; cy++) for (let cx = 0; cx < cov.w; cx++) {
    const px = (cx + 0.5) * cov.cellPx, py = (cy + 0.5) * cov.cellPx;
    if (px < m || py < m || px > W - m || py > H - m) continue;
    let blocked = false;
    for (const w of walls) if (px >= w.x - m && px <= w.x + w.w + m && py >= w.y - m && py <= w.y + w.h + m) blocked = true;
    for (const ic of icons) if (Math.abs(px - ic.x) <= ic.w / 2 + m && Math.abs(py - ic.y) <= ic.h / 2 + m) blocked = true;
    if (!blocked) { mask[cy * cov.w + cx] = 1; n++; }
  }
  return { mask, n };
}

function renderAscii(state, icons) {
  const cov = state.coverage, obs = state.obstacleMap;
  const cw = 2, ch = 3; // cells per character
  const cols = Math.ceil(cov.w / cw), rows = Math.ceil(cov.h / ch);
  const lines = [];
  const ramp = ' .:-=+*#%@';
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      let maxCov = 0, hasObs = false;
      for (let yy = r * ch; yy < Math.min(cov.h, (r + 1) * ch); yy++) for (let xx = c * cw; xx < Math.min(cov.w, (c + 1) * cw); xx++) {
        const i = yy * cov.w + xx;
        if (cov.data[i] > maxCov) maxCov = cov.data[i];
        if (obs.data[i]) hasObs = true;
      }
      const px = (c + 0.5) * cw * cov.cellPx, py = (r + 0.5) * ch * cov.cellPx;
      let chr = ramp[Math.min(ramp.length - 1, maxCov)];
      if (hasObs) chr = 'X';
      for (const o of state.obstacles) {
        const ic = icons.find((q) => q.id === o.id);
        if (ic && Math.abs(px - o.x) <= ic.w / 2 && Math.abs(py - o.y) <= ic.h / 2) chr = 'O';
      }
      if (Math.hypot(px - state.robot.x, py - state.robot.y) < 40) chr = '@';
      if (Math.hypot(px - dock.x, py - dock.y) < 20) chr = 'D';
      line += chr;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

async function scenarioA() {
  console.log('\n=== Scenario A: 10 simulated minutes on a 1700x1100 desktop ===');
  const icons = makeIcons();
  // plain cleaning regression: no cake here (scenarios C and D cover the cake, including recovery after a hang-up)
  const sim = await createSim({ width: W, height: H, pxPerMeter: 440, seed: 1, dock, walls, obstacles: icons, cake: false });
  const steps = 10 * 60 * HZ;
  const times = [];
  let nan = false, outOfBounds = 0, bumps = 0, pushedEvents = 0, stuckEvents = 0, unstuck = 0, emptyStarts = 0, docked = 0, cliffs = 0, dockStarts = 0, spots = 0, escapes = 0;
  const modeTime = {};
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let maxSlip = 0, slipFrames = 0, maxAnger = 0;
  const timeline = [];
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    sim.step(DT);
    times.push(performance.now() - t0);
    const s = sim.getState();
    const r = s.robot;
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.angle) || !Number.isFinite(r.vx)) nan = true;
    for (const o of s.obstacles) if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) nan = true;
    if (r.x < 0 || r.x > W || r.y < 0 || r.y > H) outOfBounds++;
    minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x); minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y);
    modeTime[r.mode] = (modeTime[r.mode] || 0) + DT;
    const slip = Math.max(r.slipL, r.slipR);
    if (slip > maxSlip) maxSlip = slip;
    if (slip > 0.5) slipFrames++;
    if (r.anger > maxAnger) maxAnger = r.anger;
    for (const e of s.events) {
      if (e.type === 'bump') bumps++;
      else if (e.type === 'pushed') pushedEvents++;
      else if (e.type === 'stuck') stuckEvents++;
      else if (e.type === 'unstuck') unstuck++;
      else if (e.type === 'emptyStart') emptyStarts++;
      else if (e.type === 'docked') docked++;
      else if (e.type === 'cliff') cliffs++;
      else if (e.type === 'dockStart') dockStarts++;
      else if (e.type === 'spot') spots++;
      else if (e.type === 'escape') escapes++;
      if (['dockStart', 'docked', 'emptyStart', 'emptyEnd', 'chargeEnd', 'stuck', 'unstuck', 'spot'].includes(e.type)) timeline.push(`${e.t.toFixed(1)}s ${e.type}${e.reason ? ' (' + e.reason + ')' : ''}`);
    }
  }
  const final = sim.getState();
  const { mask, n: freeN } = freeCellMask(sim, icons);
  let covered = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] && final.coverage.data[i] > 0) covered++;
  const coveragePct = (100 * covered) / freeN;
  const st = stats(times);
  const moved = icons.map((ic) => {
    const o = final.obstacles.find((q) => q.id === ic.id);
    return { id: ic.id, mass: ic.massKg, d: Math.hypot(o.x - ic.x, o.y - ic.y) };
  });
  const heavy = moved.find((m) => m.mass === 5.0);
  const lightMoved = moved.filter((m) => m.mass < 1 && m.d > 5);
  let obsCells = 0; for (const v of final.obstacleMap.data) if (v) obsCells++;

  console.log('timeline:', timeline.join(' | '));
  console.log('mode time (s):', Object.fromEntries(Object.entries(modeTime).map(([k, v]) => [k, +v.toFixed(1)])));
  console.log(`bumps=${bumps} cliffs=${cliffs} pushedEvents=${pushedEvents} spots=${spots} escapes=${escapes} unstuck=${unstuck} stuck=${stuckEvents} dockStarts=${dockStarts} docked=${docked} emptyStarts=${emptyStarts}`);
  console.log(`robot x∈[${minX.toFixed(0)},${maxX.toFixed(0)}] y∈[${minY.toFixed(0)},${maxY.toFixed(0)}]  maxSlip=${maxSlip.toFixed(2)} slipFrames(>0.5)=${slipFrames} maxAnger=${maxAnger.toFixed(2)}`);
  console.log('icon displacement px:', moved.map((m) => `${m.id}(${m.mass}kg):${m.d.toFixed(0)}`).join(' '));
  console.log(`dust alive=${final.dust.alive.reduce((a, b) => a + b, 0)} bin=${final.robot.bin.toFixed(2)} battery=${final.robot.battery.toFixed(2)} obstacleMapCells=${obsCells}`);
  console.log(`step time ms: avg=${st.avg.toFixed(3)} p50=${st.p50.toFixed(3)} p99=${st.p99.toFixed(3)} max=${st.max.toFixed(3)}`);
  console.log(`coverage: ${covered}/${freeN} free cells = ${coveragePct.toFixed(1)}%`);

  check(!nan, 'no NaNs in robot/obstacle state');
  check(outOfBounds === 0, `robot stayed in bounds (frames out: ${outOfBounds})`);
  check(bumps > 20, `bumps happened (${bumps})`);
  check(coveragePct > 60, `coverage > 60% of free cells (${coveragePct.toFixed(1)}%)`);
  check(emptyStarts >= 1, `at least one dock cycle with emptying (${emptyStarts})`);
  check(lightMoved.length >= 1 && pushedEvents > 0, `light icons got pushed (${lightMoved.map((m) => m.id).join(',')}; pushed events ${pushedEvents})`);
  check(heavy.d < 10, `5 kg icon moved < 10 px (${heavy.d.toFixed(1)} px)`);
  check(st.avg < 1.0, `average step under 1 ms (${st.avg.toFixed(3)} ms)`);

  console.log('\nCoverage map (.:-=+*#%@ = passes, X = robot\'s obstacle map, O = icon, D = dock, @ = robot):');
  console.log(renderAscii(final, icons));
}

async function scenarioB() {
  console.log('\n=== Scenario B: corner trap with a 5 kg icon ===');
  // pocket in the top-right corner: menu bar above, page edge (cliff) to the right,
  // a 5 kg icon on the left and a 4 kg icon below. Robot starts inside, facing the heavy icon.
  const icons = [
    { id: 'heavy5', x: W - 295, y: 160, w: 200, h: 244, massKg: 5.0 },
    { id: 'heavy4', x: W - 97, y: 38 + 195 + 70, w: 195, h: 140, massKg: 4.0 },
    { id: 'light', x: 400, y: 600, w: 84, h: 96, massKg: 0.1 },
  ];
  const sim = await createSim({
    width: W, height: H, pxPerMeter: 440, seed: 3, dock, walls, obstacles: icons,
    start: { x: W - 97, y: 38 + 97, angle: Math.PI },
  });
  let stuckAt = null, firstEscape = null, bumps = 0, maxSlip = 0, slipFrames = 0, maxAnger = 0, nan = false, oob = 0;
  const modes = [];
  let lastMode = '';
  for (let i = 0; i < 120 * HZ; i++) {
    sim.step(DT);
    const s = sim.getState();
    const r = s.robot;
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) nan = true;
    if (r.x < 0 || r.x > W || r.y < 0 || r.y > H) oob++;
    if (r.mode !== lastMode) { modes.push(`${(i * DT).toFixed(1)}s:${r.mode}`); lastMode = r.mode; }
    const slip = Math.max(r.slipL, r.slipR);
    maxSlip = Math.max(maxSlip, slip); if (slip > 0.5) slipFrames++;
    maxAnger = Math.max(maxAnger, r.anger);
    for (const e of s.events) {
      if (e.type === 'bump') bumps++;
      if (e.type === 'escape' && firstEscape === null) firstEscape = e.t;
      if (e.type === 'stuck' && stuckAt === null) stuckAt = e.t;
    }
    if (stuckAt !== null && i * DT > stuckAt + 3) break;
  }
  const final = sim.getState();
  const heavy = final.obstacles.find((o) => o.id === 'heavy5');
  const d5 = Math.hypot(heavy.x - icons[0].x, heavy.y - icons[0].y);
  console.log('mode sequence:', modes.join(' '));
  console.log(`bumps=${bumps} firstEscape=${firstEscape?.toFixed(1)}s stuckAt=${stuckAt?.toFixed(1)}s maxSlip=${maxSlip.toFixed(2)} slipFrames=${slipFrames} maxAnger=${maxAnger.toFixed(2)} brush=${final.robot.brushRpm.toFixed(2)}`);
  check(!nan && oob === 0, 'trap: no NaNs, robot in bounds');
  check(stuckAt !== null, `trap: stuck event occurred (${stuckAt?.toFixed(1)} s)`);
  check(stuckAt === null || (final.robot.mode === 'stuck' && final.robot.anger >= 0.99 && final.robot.brushRpm < 0.05), 'trap: mode stuck, anger 1, brush off');
  check(d5 < 10, `trap: 5 kg icon moved < 10 px (${d5.toFixed(1)} px)`);
  check(slipFrames > 0, `trap: wheels slipped while straining (${slipFrames} frames > 0.5 slip)`);

  // freeing it: move the heavy icon away as the user would
  sim.setObstacleKinematic('heavy5', 700, 165);
  sim.step(DT);
  sim.releaseObstacle('heavy5');
  let freed = false;
  for (let i = 0; i < 20 * HZ; i++) {
    sim.step(DT);
    const s = sim.getState();
    for (const e of s.events) if (e.type === 'unstuck') freed = true;
    if (freed) break;
  }
  check(freed, 'trap: robot got unstuck after the user moved the icon');
}

// ── the cake incident ────────────────────────────────────────────────────────────────────────────────
const CAKE_WALLS = [{ x: 0, y: 0, w: W, h: 38 }, { x: W / 2 - 400, y: H - 72, w: 800, h: 72 }];
const CAKE = { x: 850, y: 560, angle: 0 };            // wedge axis horizontal: its long sides face up/down
const NOMINAL_WHEEL_N = 0.85 * 3.6 * 9.81 / 2;
function cakeSim(seed, start) {
  return createSim({ width: W, height: H, pxPerMeter: 440, seed, batteryMinutes: 30, walls: CAKE_WALLS, obstacles: [],
    dock: { x: 130, y: H - 150, angle: Math.PI / 2 }, cake: CAKE, start });
}
/** steps the sim and records the cake story; drive(t, state) may call setManual */
async function runCake(sim, seconds, drive) {
  const r = { order: [], ev: {}, tipDir: null, stamps: {}, maxPitch: 0, maxLift: 0, minWheelN: Infinity, maxSlipOnCake: 0,
    peakLoad: 0, smearPath: 0, firstStampT: null, nan: false, oob: 0, manualSeen: false, finalLoad: 0, times: [],
    fade: null, fadeL0: 0, fadeD: 0, prevLoad: 0 };
  let px = null, py = null, s = sim.getState();
  for (let i = 0; i < seconds * HZ; i++) {
    const t = i * DT;
    if (drive) drive(t, s, r);
    const t0 = performance.now();
    sim.step(DT);
    r.times.push(performance.now() - t0);
    s = sim.getState();
    const rb = s.robot;
    if (![rb.x, rb.y, rb.pitch, rb.roll, rb.lift, rb.load].every(Number.isFinite)) r.nan = true;
    if (rb.x < 0 || rb.x > W || rb.y < 0 || rb.y > H) r.oob++;
    if (rb.mode === 'manual') r.manualSeen = true;
    for (const e of s.events) {
      if (!e.type.startsWith('cake') && e.type !== 'smearOut') continue;
      if (r.ev[e.type] === undefined) { r.ev[e.type] = e.t; r.order.push(e.type); }
      if (e.type === 'smearOut' && r.ev.cakeCrush !== undefined && r.loadAtSmearOut === undefined) r.loadAtSmearOut = rb.load;
      if (e.type === 'cakeTip' && r.tipDir === null) r.tipDir = e.tipDir;
    }
    const climbing = r.ev.cakeClimb !== undefined && (r.ev.cakeCrush === undefined || t < r.ev.cakeCrush + 1);
    if (climbing) {
      r.maxPitch = Math.max(r.maxPitch, rb.pitch); r.maxLift = Math.max(r.maxLift, rb.lift);
      if (rb.wheelLoadL !== null) r.minWheelN = Math.min(r.minWheelN, rb.wheelLoadL, rb.wheelLoadR);
      if (rb.onCake) r.maxSlipOnCake = Math.max(r.maxSlipOnCake, rb.slipL, rb.slipR);
    }
    for (const st of s.smear) {
      r.stamps[st.kind] = (r.stamps[st.kind] || 0) + 1;
      if (r.firstStampT === null && st.kind.startsWith('wheel')) r.firstStampT = t;
    }
    r.peakLoad = Math.max(r.peakLoad, rb.load);
    // a stretch of floor driving with no re-pick: load must fall as exp(-d / LOAD_DECAY_M)
    if (r.ev.cakeCrush !== undefined && !r.fade && px !== null) {
      const d = Math.hypot(rb.x - px, rb.y - py) / 440;
      if (rb.load > r.prevLoad + 1e-6 || rb.onCake || r.fadeL0 === 0) { r.fadeL0 = rb.load; r.fadeD = 0; }
      else r.fadeD += d;
      if (r.fadeD >= 8 && r.fadeL0 > 0.1) r.fade = { d: r.fadeD, ratio: rb.load / r.fadeL0, expect: Math.exp(-r.fadeD / MESS.LOAD_DECAY_M) };
    }
    r.prevLoad = rb.load;
    if (px !== null && r.firstStampT !== null && rb.load >= 0.02) r.smearPath += Math.hypot(rb.x - px, rb.y - py) / 440;
    px = rb.x; py = rb.y;
    if ((r.loadAtSmearOut !== undefined && t > r.ev.smearOut + 2) || (r.fade && r.smearPath > 8)) break;
  }
  r.finalLoad = s.robot.load; r.final = s;
  return r;
}
function cakeChecks(tag, r) {
  const want = ['cakeHit', 'cakeTip', 'cakeLand', 'cakeClimb', 'cakeCrush'];
  const inOrder = want.every((k, i) => r.ev[k] !== undefined && (i === 0 || r.ev[k] >= r.ev[want[i - 1]]));
  console.log(`${tag} story: ` + r.order.map((k) => `${k}@${r.ev[k].toFixed(1)}s`).join(' -> '));
  console.log(`${tag} climb: maxPitch=${(r.maxPitch * 57.3).toFixed(1)}° maxLift=${(r.maxLift * 1000).toFixed(0)}mm minWheelLoad=${r.minWheelN.toFixed(1)}N (nominal ${NOMINAL_WHEEL_N.toFixed(1)}) maxSlipOnCake=${r.maxSlipOnCake.toFixed(2)}`);
  console.log(`${tag} paint: stamps=${JSON.stringify(r.stamps)} peakLoad=${r.peakLoad.toFixed(2)} smearedPath=${r.smearPath.toFixed(1)}m loadAtSmearOut=${r.loadAtSmearOut?.toFixed(3)} squash=${r.final.cake.squash.toFixed(2)} frostingLeft=${r.final.cake.frosting.toFixed(2)}`);
  const st = stats(r.times);
  console.log(`${tag} step ms: avg=${st.avg.toFixed(3)} p99=${st.p99.toFixed(3)} max=${st.max.toFixed(3)}`);
  check(!r.nan && r.oob === 0, `${tag}: no NaNs, robot in bounds`);
  check(inOrder, `${tag}: hit -> tip -> land -> climb -> crush, in order`);
  check(r.tipDir !== null && Math.abs(Math.cos(r.tipDir - CAKE.angle)) < 0.5, `${tag}: pushed sideways it tipped over a long edge (tipDir ${r.tipDir?.toFixed(2)} vs axis ${CAKE.angle})`);
  check(r.maxPitch > 3 / 57.3 && r.maxLift > 0.005, `${tag}: body pitched and lifted riding onto the cake`);
  check(r.minWheelN < 0.5 * NOMINAL_WHEEL_N && r.maxSlipOnCake > 0.8, `${tag}: hung up: wheel load dropped and wheels slipped`);
  check(r.final.cake.phase === 'crushed' && r.final.cake.squash >= 0.9, `${tag}: cake crushed (squash ${r.final.cake.squash.toFixed(2)})`);
  check((r.stamps.wheelL || 0) + (r.stamps.wheelR || 0) > 100 && (r.stamps.brush || 0) > 10 && (r.stamps.splat || 0) >= 1 && (r.stamps.fling || 0) >= 1,
    `${tag}: tyre, brush, splat and fling stamps emitted`);
  check(r.smearPath > 5, `${tag}: smear printed over > 5 m of driving (${r.smearPath.toFixed(1)} m)`);
  // the robot often drives back through the blob and reloads (as in real life), so test the fade law itself
  const f = r.fade;
  check(r.peakLoad > 0.3 && f && Math.abs(f.ratio / f.expect - 1) < 0.35,
    `${tag}: load fades with distance: ${f ? `${(f.ratio * 100).toFixed(0)}% left after ${f.d.toFixed(1)} m clean driving, expected ≈${(f.expect * 100).toFixed(0)}%` : 'no clean stretch found'}`);
  check(st.avg < 1.0, `${tag}: average step under 1 ms (${st.avg.toFixed(3)} ms)`);
}

async function scenarioC() {
  console.log('\n=== Scenario C: the cake incident, autonomous ===');
  const start = { x: 640, y: 560, angle: -Math.PI / 2 };   // spiral outward around a point 0.48 m from the slice
  const r = await runCake(await cakeSim(1, start), 600);
  cakeChecks('cake/auto', r);
  // determinism: same seed, same story
  const a = await cakeSim(1, start), b = await cakeSim(1, start);
  for (let i = 0; i < 50 * HZ; i++) { a.step(DT); b.step(DT); }
  const sa = a.getState(), sb = b.getState();
  check(sa.robot.x === sb.robot.x && sa.robot.y === sb.robot.y && sa.cake.squash === sb.cake.squash && sa.robot.load === sb.robot.load,
    'cake/auto: deterministic for a seed');
  // placeCake: crushed blob stays, a new slice stands; resetMess clears the floor and restores the slice
  const sim = await cakeSim(1, start);
  for (let i = 0; i < 600 * HZ && sim.getState().cake.phase !== 'crushed'; i++) sim.step(DT);
  const before = sim.getState();
  sim.placeCake(300, 300, 1.0);
  const after = sim.getState();
  check(before.cake.phase === 'crushed' && after.cakes.length === 2 && after.cake.phase === 'standing' && after.cakes[0].phase === 'crushed',
    'placeCake: new standing slice, crushed blob stays on the floor');
  sim.resetMess();
  const reset = sim.getState();
  let paint = 0; for (const v of reset.smearGrid.data) paint += v;
  check(paint === 0 && reset.robot.load === 0 && reset.cakes.length === 1 && reset.cake.phase === 'standing' && reset.cake.x === CAKE.x,
    'resetMess: smear cleared, load 0, slice standing at its configured pose');
}

async function scenarioD() {
  console.log('\n=== Scenario D: the cake incident by hand (setManual) ===');
  const sim = await cakeSim(5, { x: 850, y: 300, angle: Math.PI / 2 });   // facing the slice's long side, 0.6 m away
  let handedBack = false;
  const r = await runCake(sim, 300, (t, s, rec) => {
    if (rec.ev.cakeCrush === undefined || t < rec.ev.cakeCrush + 1.5) sim.setManual({ throttle: 1, steer: 0, turbo: false });
    else if (!handedBack) { sim.setManual(null); handedBack = true; }
  });
  check(r.manualSeen && r.ev.cakeTip !== undefined && r.ev.cakeTip < 3, `cake/manual: driven by hand, tipped ${r.ev.cakeTip?.toFixed(2)} s after start`);
  cakeChecks('cake/manual', r);
}

await scenarioA();
await scenarioB();
await scenarioC();
await scenarioD();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
