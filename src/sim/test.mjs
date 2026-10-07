// test.mjs — headless check of the sim: `node src/sim/test.mjs` (npm run test:sim)
// Scenario A: 1700x1100 desktop, 12 icons, dock, menu bar + Dock walls, 10 simulated minutes.
// Scenario B: corner trap with a 5 kg icon -> must produce a 'stuck' event, icon must not move.
// Scenario C: the cake incident, autonomous: the slice stands on a light plate near the menu bar. The robot
//             pushes the plate around, the slice tips from a hard hit or a pinned plate, lands, the robot rolls
//             over it with a small hop and no stall, several passes crush it, tyre/brush tracks spread, the load
//             fades. Plus determinism, placeCake() and resetMess().
// Scenario D: the same by hand (setManual): full-speed ram tips the slice, the plate is shoved into the menu
//             bar, the user drives a tyre over the slice until it is crushed, then hands back control.
// Scenario E: plate physics: pushed from four sides it slides ahead with no bumper bounce and the slice stays
//             standing; a single autonomous drive-over of a lying slice is a short hop, never a stall.

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
const NOMINAL_WHEEL_N = 0.85 * 3.6 * 9.81 / 2;
function cakeSim(seed, start, cake, obstacles = []) {
  return createSim({ width: W, height: H, pxPerMeter: 440, seed, batteryMinutes: 30, walls: CAKE_WALLS, obstacles,
    dock: { x: 130, y: H - 150, angle: Math.PI / 2 }, cake, start });
}
/** steps the sim and records the cake story; drive(t, state, rec) may call setManual */
async function runCake(sim, seconds, drive) {
  const r = { order: [], ev: {}, tip: null, stamps: {}, maxPitch: 0, maxLift: 0, climbs: [], cur: null, climbsBeforeCrush: 0,
    peakLoad: 0, smearPath: 0, firstStampT: null, nan: false, oob: 0, manualSeen: false, finalLoad: 0, times: [],
    fade: null, fadeL0: 0, fadeD: 0, prevLoad: 0, platePath: 0, ridingEscapes: 0, lastClimb: -9 };
  let px = null, py = null, ppx = null, ppy = null, s = sim.getState();
  for (let i = 0; i < seconds * HZ; i++) {
    const t = i * DT;
    if (drive) drive(t, s, r);
    const t0 = performance.now();
    sim.step(DT);
    r.times.push(performance.now() - t0);
    s = sim.getState();
    const rb = s.robot, pl = s.plates[0];
    if (![rb.x, rb.y, rb.pitch, rb.roll, rb.lift, rb.load, pl.x, pl.y].every(Number.isFinite)) r.nan = true;
    if (rb.x < 0 || rb.x > W || rb.y < 0 || rb.y > H) r.oob++;
    if (rb.mode === 'manual') r.manualSeen = true;
    if (ppx !== null) r.platePath += Math.hypot(pl.x - ppx, pl.y - ppy) / 440;
    ppx = pl.x; ppy = pl.y;
    for (const e of s.events) {
      if ((e.type === 'escape' && !['retry', 'boxedIn'].includes(e.reason)) || e.type === 'stuck') { if (e.t - r.lastClimb < 2.5) r.ridingEscapes++; }
      if (!/^(cake|plate)/.test(e.type) && e.type !== 'smearOut') continue;
      if (r.ev[e.type] === undefined) { r.ev[e.type] = e.t; r.order.push(e.type); }
      if (e.type === 'cakeTip' && !r.tip) r.tip = e;
      if (e.type === 'cakeClimb') { r.lastClimb = e.t; if (r.ev.cakeCrush === undefined) r.climbsBeforeCrush++; if (!r.cur) r.cur = { t: 0, slow: 0, maxLift: 0, maxPitch: 0, endLift: 0 }; }
    }
    // each drive-over: how long the robot is held below 60% of its commanded speed, the hop it makes
    if (r.cur) {
      const c = r.cur, cmd = Math.abs(rb.cmdL + rb.cmdR) / 2;
      c.t += DT;
      // (time with the bumper pressed against something hard is not the slice holding it back)
      if (cmd > 0.05 * 440 && Math.hypot(rb.vx, rb.vy) < 0.6 * cmd && !rb.bumper.left && !rb.bumper.right) c.slow += DT;
      c.maxLift = Math.max(c.maxLift, rb.lift); c.maxPitch = Math.max(c.maxPitch, rb.pitch);
      if (c.t >= 2.5) { r.climbs.push(c); r.cur = null; }
    }
    r.maxPitch = Math.max(r.maxPitch, rb.pitch); r.maxLift = Math.max(r.maxLift, rb.lift);
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
    if (r.fade && r.smearPath > 8) break;
  }
  r.finalLoad = s.robot.load; r.final = s;
  return r;
}
function cakeChecks(tag, r, minPasses = 2, checkPass = true) {
  const want = ['cakeTip', 'cakeLand', 'cakeClimb', 'cakeCrush'];
  const inOrder = want.every((k, i) => r.ev[k] !== undefined && (i === 0 || r.ev[k] >= r.ev[want[i - 1]]));
  const worstSlow = r.climbs.length ? Math.max(...r.climbs.map((c) => c.slow)) : NaN;
  const hops = r.climbs.map((c) => `${(c.maxLift * 1000).toFixed(0)}mm/${(c.maxPitch * 57.3).toFixed(1)}°/${c.slow.toFixed(2)}s`);
  console.log(`${tag} story: ` + r.order.map((k) => `${k}@${r.ev[k].toFixed(1)}s`).join(' -> '));
  console.log(`${tag} plate: pushed ${r.platePath.toFixed(2)} m; slice tipped by ${r.tip ? r.tip.force.toFixed(1) + ' N over a ' + r.tip.edge + ' edge' + (r.tip.onPlate ? ' on the plate' : '') : '-'}`);
  console.log(`${tag} drive-overs (lift/pitch/held-back): ${hops.join(' ')}  climbs before crush: ${r.climbsBeforeCrush}`);
  console.log(`${tag} paint: stamps=${JSON.stringify(r.stamps)} peakLoad=${r.peakLoad.toFixed(2)} smearedPath=${r.smearPath.toFixed(1)}m squash=${r.final.cake.squash.toFixed(2)} frostingLeft=${r.final.cake.frosting.toFixed(2)}`);
  const st = stats(r.times);
  console.log(`${tag} step ms: avg=${st.avg.toFixed(3)} p99=${st.p99.toFixed(3)} max=${st.max.toFixed(3)}`);
  check(!r.nan && r.oob === 0, `${tag}: no NaNs, robot in bounds`);
  check(r.ev.plateHit !== undefined && r.platePath > 0.3, `${tag}: robot hit the plate and pushed it around (${r.platePath.toFixed(2)} m)`);
  check(inOrder, `${tag}: tip -> land -> climb -> crush, in order`);
  check(r.tip && r.tip.edge === 'long', `${tag}: the slice tipped over a long edge of its wedge (${r.tip?.edge})`);
  check(r.maxPitch > 2 / 57.3 && r.maxLift > 0.004 && r.maxLift < 0.03, `${tag}: visible hop riding over it (max pitch ${(r.maxPitch * 57.3).toFixed(1)}°, lift ${(r.maxLift * 1000).toFixed(0)} mm)`);
  // (by hand the user may keep the robot straddling the plate and drag it along; that is reported, not a drive-over)
  if (checkPass) check(r.climbs.length > 0 && r.climbs[0].slow < 1 && r.ridingEscapes === 0,
    `${tag}: first drive-over is a brief slow-down (held back ${r.climbs[0]?.slow.toFixed(2)} s; worst of ${r.climbs.length}: ${worstSlow.toFixed(2)} s), no escape/stuck from riding`);
  check(r.final.cake.phase === 'crushed' && r.final.cake.squash >= 0.9 && r.climbsBeforeCrush >= minPasses, `${tag}: crushed after ${minPasses > 1 ? 'several passes' : 'the user ground a tyre over it'} (${r.climbsBeforeCrush} climbs, squash ${r.final.cake.squash.toFixed(2)})`);
  check((r.stamps.wheelL || 0) + (r.stamps.wheelR || 0) > 100 && (r.stamps.brush || 0) > 10 && (r.stamps.splat || 0) >= 1 && (r.stamps.fling || 0) >= 1,
    `${tag}: tyre, brush, splat and fling stamps emitted`);
  check(r.smearPath > 5, `${tag}: smear printed over > 5 m of driving (${r.smearPath.toFixed(1)} m)`);
  // the robot often drives back through the blob and reloads (as in real life), so test the fade law itself
  const f = r.fade;
  check(r.peakLoad > 0.3 && f && Math.abs(f.ratio / f.expect - 1) < 0.35,
    `${tag}: load fades with distance: ${f ? `${(f.ratio * 100).toFixed(0)}% left after ${f.d.toFixed(1)} m clean driving, expected ≈${(f.expect * 100).toFixed(0)}%` : 'no clean stretch found'}`);
  check(st.avg < 1.0, `${tag}: average step under 1 ms (${st.avg.toFixed(3)} ms)`);
}

// the slice on its plate under the menu bar; the robot comes from below
const CAKE_C = { x: 850, y: 150, angle: 0 };
const START_C = { x: 850, y: 420, angle: -Math.PI / 2 };
async function scenarioC() {
  console.log('\n=== Scenario C: the cake incident, autonomous (slice on a plate) ===');
  const r = await runCake(await cakeSim(5, START_C, CAKE_C), 900);
  cakeChecks('cake/auto', r);
  // determinism: same seed, same story
  const a = await cakeSim(5, START_C, CAKE_C), b = await cakeSim(5, START_C, CAKE_C);
  for (let i = 0; i < 90 * HZ; i++) { a.step(DT); b.step(DT); }
  const sa = a.getState(), sb = b.getState();
  check(sa.robot.x === sb.robot.x && sa.robot.y === sb.robot.y && sa.cake.squash === sb.cake.squash && sa.plates[0].x === sb.plates[0].x && sa.robot.load === sb.robot.load,
    'cake/auto: deterministic for a seed');
  // placeCake: crushed blob stays with its plate, a new slice stands on a new plate; resetMess restores the start
  const sim = await cakeSim(5, START_C, CAKE_C);
  for (let i = 0; i < 900 * HZ && sim.getState().cake.phase !== 'crushed'; i++) sim.step(DT);
  const before = sim.getState();
  sim.placeCake(300, 300, 1.0);
  const after = sim.getState();
  check(before.cake.phase === 'crushed' && after.cakes.length === 2 && after.cake.phase === 'standing' && after.cakes[0].phase === 'crushed' &&
    after.plates.length === 2 && after.cake.onPlate === after.plates[1].id && after.plates[1].cakeId === after.cake.id,
    'placeCake: new slice standing on a new plate, the crushed blob and its plate stay');
  sim.resetMess();
  const reset = sim.getState();
  let paint = 0; for (const v of reset.smearGrid.data) paint += v;
  const near = (a, b) => Math.abs(a - b) < 0.01;
  check(paint === 0 && reset.robot.load === 0 && reset.cakes.length === 1 && reset.cake.phase === 'standing' && reset.plates.length === 1 &&
    near(reset.plates[0].x, CAKE_C.x) && near(reset.plates[0].y, CAKE_C.y) && reset.cake.onPlate === reset.plates[0].id && near(reset.cake.x, CAKE_C.x),
    'resetMess: smear cleared, load 0, plate and slice back at their configured pose');
}

async function scenarioD() {
  console.log('\n=== Scenario D: the cake incident by hand (setManual) ===');
  // full speed at the plate's broadside, the left tyre lined up with the slice
  const sim = await cakeSim(5, { x: 800, y: 700, angle: -Math.PI / 2 }, { x: 850, y: 330, angle: 0 });
  let phase = 'fwd', tPhase = 0, handedBack = false;
  const r = await runCake(sim, 600, (t, s, rec) => {
    if (rec.ev.cakeCrush === undefined) {
      // drive at it; when the bumper meets the menu bar, back up and go again
      if (phase === 'fwd') { sim.setManual({ throttle: 1, steer: 0 }); if ((s.robot.bumper.left || s.robot.bumper.right) && t - tPhase > 0.5) { phase = 'back'; tPhase = t; } }
      else { sim.setManual({ throttle: -1, steer: 0 }); if (t - tPhase > 1.2) { phase = 'fwd'; tPhase = t; } }
    } else if (t < rec.ev.cakeCrush + 1) sim.setManual({ throttle: -1, steer: 0 });
    else if (!handedBack) { sim.setManual(null); handedBack = true; }
  });
  check(r.manualSeen && r.ev.cakeTip !== undefined && r.ev.cakeTip < 3, `cake/manual: driven by hand, a full-speed ram tipped the slice ${r.ev.cakeTip?.toFixed(2)} s after start`);
  cakeChecks('cake/manual', r, 1, false);
}

async function scenarioE() {
  console.log('\n=== Scenario E: plate pushing and a single drive-over ===');
  // 1) push the plate from four sides at 0.2 m/s: slides ahead, no bumper click, slice keeps standing
  for (const [name, x, y, a] of [['left', 550, 550, 0], ['right', 1150, 550, Math.PI], ['top', 850, 250, Math.PI / 2], ['bottom', 850, 850, -Math.PI / 2]]) {
    const sim = await cakeSim(5, { x, y, angle: a }, { x: 850, y: 550, angle: 0 });
    sim.setManual({ throttle: 0.67, steer: 0 });
    let clicks = 0, pushV = [];
    for (let i = 0; i < 6 * HZ; i++) {
      sim.step(DT);
      const s = sim.getState(), p = s.plates[0];
      if (s.robot.bumper.left || s.robot.bumper.right) clicks++;
      if (Math.hypot(p.vx, p.vy) > 0.05 * 440) pushV.push(Math.hypot(s.robot.vx, s.robot.vy) / 440);
    }
    const s = sim.getState(), moved = Math.hypot(s.plates[0].x - 850, s.plates[0].y - 550) / 440;
    const v = pushV.reduce((q, w) => q + w, 0) / Math.max(1, pushV.length);
    check(moved > 0.3 && clicks === 0 && s.cake.phase === 'standing' && v > 0.17,
      `plate pushed from the ${name}: moved ${moved.toFixed(2)} m at ${v.toFixed(2)} m/s, bumper clicks ${clicks}, slice ${s.cake.phase}`);
  }
  // 2) a slice lying on the desk, the autonomous robot driving straight across it once
  const sim = await cakeSim(5, { x: 600, y: 550, angle: 0 }, { x: 850, y: 550, angle: Math.PI / 2, plate: false });
  sim.setManual({ throttle: 1, steer: 0 });
  for (let i = 0; i < 6 * HZ && sim.getState().cake.phase !== 'lying'; i++) sim.step(DT);
  const lying = sim.getState().cake;
  sim.setManual({ throttle: -1, steer: 0 });
  for (let i = 0; i < 1.5 * HZ; i++) sim.step(DT);
  sim.setManual(null);
  const { beh, phys } = sim.debug;
  phys.setPose((lying.floorX - 220) / 440, lying.floorY / 440, 0);              // test setup: line it up ...
  beh.state.mode = 'bounce'; beh.state.sub = 'straight'; beh.state.straightDist = 0; beh.state.straightLimit = 3;   // ... in a straight run
  let slow = 0, maxLift = 0, maxPitch = 0, bad = 0, climbed = false, settled = false, crossedAt = null;
  for (let i = 0; i < 6 * HZ; i++) {
    sim.step(DT);
    const s = sim.getState(), rb = s.robot, cmd = Math.abs(rb.cmdL + rb.cmdR) / 2;
    if (cmd > 0.05 * 440 && Math.hypot(rb.vx, rb.vy) < 0.6 * cmd) slow += DT;
    maxLift = Math.max(maxLift, rb.lift); maxPitch = Math.max(maxPitch, rb.pitch);
    for (const e of s.events) { if (e.type === 'cakeClimb') climbed = true; if ((e.type === 'escape' && e.reason !== 'retry') || e.type === 'stuck') bad++; }
    if (crossedAt === null && rb.x > lying.floorX + 220) crossedAt = i * DT;
    if (crossedAt !== null && i * DT > crossedAt + 0.5 && rb.lift < 0.001 && Math.abs(rb.pitch) < 0.5 / 57.3) settled = true;
  }
  check(climbed && crossedAt !== null && slow < 1 && bad === 0,
    `single autonomous drive-over: crossed in ${crossedAt?.toFixed(2)} s, held back ${slow.toFixed(2)} s (< 1 s), no escape/stuck (${bad})`);
  check(maxLift > 0.004 && maxLift < 0.02 && maxPitch > 2 / 57.3 && settled,
    `...with a visible hop that settles (lift ${(maxLift * 1000).toFixed(0)} mm, pitch ${(maxPitch * 57.3).toFixed(1)}°)`);
}

await scenarioA();
await scenarioB();
await scenarioC();
await scenarioD();
await scenarioE();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
