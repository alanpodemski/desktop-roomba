// index.js — public Sim API (see SPEC.md "Sim API"). Wires physics, behaviour, mapping and dust.
//
// Public units: CSS px, px/s, rad, s. Internally physics + behaviour run in metres.
// No DOM access anywhere in src/sim. Deterministic for a given seed.

import { createPhysics, PHYS, massFromBytes } from './physics.js';
import { createBehaviour, BEH } from './behaviour.js';
import { createMapping, MAP } from './mapping.js';
import { createDust, DUST } from './dust.js';
import { createMess, MESS } from './mess.js';
import { createRng, clamp, isFiniteNumber } from './util.js';

export const SIM = {
  DEFAULT_PX_PER_M: 440,     // px/m
  BATTERY_MINUTES: 4,        // min   full battery -> empty while cleaning (config.batteryMinutes overrides)
  STUCK_DRAIN_FACTOR: 0.2,   // -     battery drain multiplier while sitting stuck (motors off, electronics on)
  BIN_PARTICLES_FULL: 520,   // -     dust particles that fill the bin (≈ 2–3 min of cleaning at default density)
  MANUAL_SPEED: 0.3,         // m/s   manual cruise (same as the autonomous top speed)
  MANUAL_TURBO: 0.42,        // m/s   manual turbo = motor no-load speed; anything faster is not physical
  MANUAL_ACCEL: 1.2,         // m/s²  manual controller ramp (traction still limits what reaches the floor)
  MANUAL_OMEGA: 2.5,         // rad/s manual turn rate
  MANUAL_ANGER_RATE: 0.35,   // 1/s   anger while the user rams it into something it cannot move
  MANUAL_ANGER_DECAY: 0.12,  // 1/s   anger decay under remote control when nothing is resisting
  MOTOR_SPINUP: 2.5,         // 1/s   brush / suction ramp rate (0 -> 1 in 0.4 s)
  PUSHED_EVENT_INTERVAL: 0.5,// s     min spacing of 'pushed' events per icon
  FRONT_MARK_RANGE_M: 0.10,  // m     front-sensor hits closer than this are added to the obstacle map
};

export { PHYS, BEH, MAP, DUST, MESS, massFromBytes };

/**
 * @param {object} config
 * @param {number} config.width   page width px
 * @param {number} config.height  page height px
 * @param {number} [config.pxPerMeter=440]
 * @param {number} [config.seed=1]
 * @param {{x:number,y:number,angle:number}} config.dock  dock centre (px) and docking direction (rad)
 * @param {Array<{x,y,w,h}>} [config.walls]      static rects, top-left + size in px
 * @param {Array<{id,x,y,w,h,massKg}>} [config.obstacles] icons: centre + size px
 * @param {number} [config.batteryMinutes=4]
 * @param {{x,y,angle}} [config.start]  robot start pose (px); default: on the dock, backing out
 * @param {{x,y,angle}|false} [config.cake]  cake slice (px, rad: wedge axis back -> tip); default: page
 *        centre with a random angle from the seed; false = no cake
 */
export async function createSim(config) {
  const width = config.width, height = config.height;
  const S = config.pxPerMeter || SIM.DEFAULT_PX_PER_M;
  const seed = config.seed ?? 1;
  const rng = createRng(seed * 7919 + 17);
  const dustRng = createRng(seed * 104729 + 3);
  const batteryMinutes = config.batteryMinutes || SIM.BATTERY_MINUTES;
  const dockPx = config.dock || { x: width * 0.08, y: height - 120, angle: Math.PI / 2 };
  const dock = { x: dockPx.x / S, y: dockPx.y / S, angle: dockPx.angle };
  const toM = (v) => v / S;
  const wallsPx = (config.walls || []).map((w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2, w: w.w, h: w.h })); // centre form
  const wallsM = wallsPx.map((w) => ({ x: toM(w.x), y: toM(w.y), w: toM(w.w), h: toM(w.h) }));
  const iconsM = (list) => list.map((o) => ({ id: o.id, x: toM(o.x), y: toM(o.y), w: toM(o.w), h: toM(o.h), angle: o.angle || 0, massKg: o.massKg ?? (o.bytes !== undefined ? massFromBytes(o.bytes) : 0.2) }));

  const startPx = config.start || { x: dockPx.x, y: dockPx.y, angle: dockPx.angle };
  const phys = await createPhysics({
    widthM: toM(width), heightM: toM(height),
    start: { x: toM(startPx.x), y: toM(startPx.y), angle: startPx.angle },
    walls: wallsM,
    obstacles: iconsM(config.obstacles || []),
  });
  const mapping = createMapping({ widthPx: width, heightPx: height, pxPerMeter: S, robotRadiusM: PHYS.ROBOT_RADIUS });
  const dust = createDust({ widthPx: width, heightPx: height, pxPerMeter: S, rng: dustRng, walls: wallsPx });
  dust.seed();

  const events = [];
  const mess = createMess({ phys, S, widthPx: width, heightPx: height, rng: createRng(seed * 15485863 + 29), events, cake: config.cake });
  phys.substepHooks.push(mess.substep);
  const beh = createBehaviour({ rng, dock, robotR: PHYS.ROBOT_RADIUS, pxPerMeter: S, planPathPx: mapping.planPath, events });
  if (!config.start) beh.startUndocked(); // start on the dock -> back out, turn, begin cleaning
  else beh.state.mode = 'spiral';

  // state
  let t = 0;
  let prevBump = false, prevCliff = false;
  const motors = { brush: 0, sideBrush: 0, suction: 0 };
  const pushedAt = new Map();
  let lastGood = phys.pose();
  const sense = {
    x: 0, y: 0, angle: 0, vFwd: 0, omega: 0, speed: 0,
    bumpL: false, bumpR: false, bumpNew: false, bumpKind: 'icon', bumpBearing: 0,
    cliffs: [], cliffNew: false,
    sideL: null, sideR: null, front: null,
    slipL: 0, slipR: 0, strain: 0,
    pickRate: 0,
  };
  let sideHitL = null, sideHitR = null, frontHit = null;

  function readSensors() {
    const p = phys.pose();
    const v = phys.velocity();
    sense.x = p.x; sense.y = p.y; sense.angle = p.angle;
    sense.vFwd = phys.forwardSpeed(); sense.omega = v.omega; sense.speed = Math.hypot(v.vx, v.vy);
    const b = phys.bumper;
    sense.bumpL = b.left; sense.bumpR = b.right;
    const pressed = b.left || b.right;
    sense.bumpNew = pressed && !prevBump;
    prevBump = pressed;
    // dominant kind among front contacts
    if (pressed) {
      let best = null;
      for (const c of b.contacts) if (c.front && (!best || c.force > best.force)) best = c;
      sense.bumpKind = best ? best.kind : 'icon';
      sense.bumpBearing = best ? best.bearing : 0;
    }
    sense.cliffs = phys.readCliffs();
    const anyCliff = sense.cliffs.some((c) => c.tripped);
    sense.cliffNew = anyCliff && !prevCliff;
    prevCliff = anyCliff;
    sideHitL = phys.castSide(-1); sideHitR = phys.castSide(1); frontHit = phys.castFront();
    sense.sideL = sideHitL ? sideHitL.dist : null;
    sense.sideR = sideHitR ? sideHitR.dist : null;
    sense.front = frontHit ? frontHit.dist : null;
    sense.slipL = phys.drive.slipL; sense.slipR = phys.drive.slipR; sense.strain = phys.drive.strain;
    sense.pickRate = dust.pickRate();
  }

  let manual = null;

  function step(dtIn) {
    let dt = isFiniteNumber(dtIn) ? dtIn : 1 / 60;
    dt = clamp(dt, 0, PHYS.MAX_FRAME_DT);
    if (dt <= 0) return;

    readSensors();
    let cmd;
    if (manual) {
      // the user drives the motors; physics (traction, slip, pushing) is unchanged
      const vMax = manual.turbo ? SIM.MANUAL_TURBO : SIM.MANUAL_SPEED;
      let v = clamp(manual.throttle, -1, 1) * vMax;
      const w = clamp(manual.steer, -1, 1) * SIM.MANUAL_OMEGA * (v < 0 ? -1 : 1);
      // a real robot refuses to drive forward over a cliff even under remote control
      const frontCliff = sense.cliffs.some((c) => c.tripped && c.front !== false);
      if (frontCliff && v > 0) v = 0;
      cmd = { v, w, vMax, brush: 1, sideBrush: 1, suction: 1 };
      if (phys.drive.strain > 0.6 || phys.drive.slipL > 0.6 || phys.drive.slipR > 0.6) beh.anger = Math.min(1, beh.anger + SIM.MANUAL_ANGER_RATE * dt);
      else beh.anger = Math.max(0, beh.anger - SIM.MANUAL_ANGER_DECAY * dt);
    } else {
      cmd = beh.update(dt, t, sense);
    }

    // motor ramps
    const k = SIM.MOTOR_SPINUP * dt;
    motors.brush += clamp(cmd.brush - motors.brush, -k, k);
    motors.sideBrush += clamp(cmd.sideBrush - motors.sideBrush, -k, k);
    motors.suction += clamp(cmd.suction - motors.suction, -k, k);
    if (manual) phys.command(cmd.v, cmd.w, dt, cmd.vMax, SIM.MANUAL_ACCEL);
    else if (beh.motorsOn) phys.command(cmd.v, cmd.w, dt); else phys.halt();

    const prev = { x: sense.x, y: sense.y };
    mess.beginFrame(t);
    phys.advance(dt);
    const evBefore = events.length;
    mess.afterAdvance(dt, t, motors);   // cake contact -> bumper, crush, frosting transfer, smear
    // a robot high-centred on a slice gives up ('stuck'); once its weight has crushed the slice flat it is
    // standing on its wheels again, so it gets another go, exactly like when the user moves a blocking icon
    if (beh.mode === 'stuck') for (let i = evBefore; i < events.length; i++) if (events[i].type === 'cakeCrush') { beh.iconMoved(phys.pose()); break; }

    // never explode: if anything went non-finite, put the robot back
    const p = phys.pose();
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.angle)) {
      phys.setPose(lastGood.x, lastGood.y, lastGood.angle);
      phys.halt();
    } else lastGood = p;

    // --- mapping: what the robot sensed this frame -----------------------------------------------
    const b = phys.bumper;
    if (b.left || b.right) {
      let best = null;
      for (const c of b.contacts) {
        if (!c.front) continue;
        mapping.markObstacle(c.x * S, c.y * S, 1);
        if (!best || c.force > best.force) best = c;
      }
      if (!prevBump && best) {
        events.push({ t, type: 'bump', side: b.left && b.right ? 'both' : b.left ? 'left' : 'right', x: best.x * S, y: best.y * S, kind: best.kind, id: best.id, force: best.force });
      }
    }
    if (sideHitL) mapping.markObstacle(sideHitL.x * S, sideHitL.y * S, 2);
    if (sideHitR) mapping.markObstacle(sideHitR.x * S, sideHitR.y * S, 2);
    if (frontHit && frontHit.dist < SIM.FRONT_MARK_RANGE_M) mapping.markObstacle(frontHit.x * S, frontHit.y * S, 2);
    for (const c of sense.cliffs) if (c.tripped) mapping.markObstacle(c.x * S, c.y * S, 2);

    // coverage: the main brush sweeps under the centre
    if (motors.brush > 0.1) mapping.stampCoverage(prev.x * S, prev.y * S, p.x * S, p.y * S, p.angle, t);

    // --- pushed icons ----------------------------------------------------------------------------------
    if (phys.pushed.size) {
      for (const id of phys.pushed) {
        const last = pushedAt.get(id) ?? -Infinity;
        const rec = phys.icons.get(id);
        if (!rec) continue;
        const it = rec.body.translation();
        dust.shed(t, { id, x: it.x * S, y: it.y * S, hw: rec.hw * S, hh: rec.hh * S, angle: rec.body.rotation() });
        if (t - last >= SIM.PUSHED_EVENT_INTERVAL) {
          pushedAt.set(id, t);
          events.push({ t, type: 'pushed', id, x: it.x * S, y: it.y * S, massKg: rec.mass });
        }
      }
    }

    // --- dust --------------------------------------------------------------------------------------------
    const picked = dust.update(dt, t, { x: p.x * S, y: p.y * S, angle: p.angle }, motors.suction, motors.sideBrush);
    if (picked > 0) {
      beh.bin = beh.bin + picked / SIM.BIN_PARTICLES_FULL;
      events.push({ t, type: 'dustPicked', n: picked });
    }

    // --- battery ---------------------------------------------------------------------------------------
    const mode = manual ? 'manual' : beh.mode;
    if (mode !== 'docked' && mode !== 'emptying' && mode !== 'charging' && mode !== 'off') {
      const f = mode === 'stuck' ? SIM.STUCK_DRAIN_FACTOR : 1;
      beh.battery = beh.battery - f * dt / (batteryMinutes * 60);
    }
    t += dt;
  }

  function getState() {
    const p = phys.pose();
    const v = phys.velocity();
    const d = phys.drive;
    const obstacles = phys.iconStates().map((o) => ({ id: o.id, x: o.x * S, y: o.y * S, angle: o.angle, asleep: o.asleep }));
    const drained = events.splice(0, events.length);
    const ms = mess.robotState();
    return {
      t,
      robot: {
        x: p.x * S, y: p.y * S, angle: p.angle,
        vx: v.vx * S, vy: v.vy * S, omega: v.omega,
        wheelL: d.wheelL * S, wheelR: d.wheelR * S, cmdL: d.cmdL * S, cmdR: d.cmdR * S,
        slipL: d.slipL, slipR: d.slipR, strain: d.strain,
        bumper: { left: phys.bumper.left, right: phys.bumper.right },
        mode: manual ? 'manual' : beh.mode, sub: manual ? (manual.turbo ? 'turbo' : 'drive') : beh.state.sub,
        anger: beh.anger,
        bin: beh.bin, battery: beh.battery,
        brushRpm: motors.brush, sideBrushRpm: motors.sideBrush, suction: motors.suction,
        pitch: ms.pitch, roll: ms.roll,          // rad: + pitch = nose up, + roll = right side up
        lift: ms.lift,                            // m: body raised by what it is driving over
        load: ms.load,                            // 0..1 frosting on the dirtiest carrier (tyres, brush)
        loadL: ms.loadL, loadR: ms.loadR, loadBrush: ms.loadBrush,
        wheelLoadL: ms.wheelLoadL, wheelLoadR: ms.wheelLoadR, // N from the suspension model (null = nominal)
        onCake: ms.onCake,
      },
      obstacles,
      dust: dust.state,
      coverage: mapping.coverage,
      obstacleMap: mapping.obstacleMap,
      path: manual ? null : beh.path,
      events: drained,
      cake: mess.cakeState(),                     // the newest cake (or null)
      cakes: mess.cakesState(),                   // every cake on the floor, incl. old crushed blobs
      smear: mess.drainSmear(),                   // stamps since the last getState()
      smearGrid: mess.smearGrid,                  // coarse paint thickness grid (sim's own record)
    };
  }

  return {
    step,
    getState,
    setObstacleKinematic(id, x, y) { phys.setIconKinematic(id, toM(x), toM(y)); },
    releaseObstacle(id) { phys.releaseIcon(id); beh.iconMoved(phys.pose()); },
    setObstacles(list) { if (phys.syncIcons(iconsM(list))) beh.iconMoved(phys.pose()); },
    addDust(x, y, count) { dust.addDust(x, y, count); },
    emptyBinNow() { beh.emptyBinNow(); },
    sendToDock() { beh.sendToDock(phys.pose()); },
    resume() { beh.resume(phys.pose()); },
    /** Remote control: {throttle -1..1, steer -1..1 (positive = clockwise), turbo} or null to hand back. */
    setManual(input) {
      if (input) {
        if (!manual) events.push({ t, type: 'modeChange', from: beh.mode, to: 'manual' });
        manual = { throttle: +input.throttle || 0, steer: +input.steer || 0, turbo: !!input.turbo };
      } else if (manual) {
        manual = null;
        events.push({ t, type: 'modeChange', from: 'manual', to: 'auto' });
        beh.takeBack();
      }
    },
    get manual() { return !!manual; },
    /** new cake slice standing at (x, y) px; the previous one stays only if it was crushed */
    placeCake(x, y, angle) { return mess.placeCake(x, y, angle); },
    /** clear every smear and the robot's load; the cake goes back to its configured pose */
    resetMess() { mess.reset(true); },
    /** diagnostics (not part of the spec contract) */
    debug: { phys, beh, mapping, dust, mess, dock: dockPx, approachPx: { x: beh.approachPoint.x * S, y: beh.approachPoint.y * S } },
  };
}
