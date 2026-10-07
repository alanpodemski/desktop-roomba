// physics.js — Rapier2D world, differential-drive force model, icon floor friction, sensors.
//
// Everything in this module is in SI units (metres, seconds, kg, N, rad). index.js converts
// to/from CSS px. +y is down on screen; angle 0 = +x, positive = clockwise on screen (this is
// exactly Rapier's own convention when the world is viewed with y down, so no sign flips).
//
// Drive model (per wheel, per substep):
//   1. wheel ground-contact velocity   vp = v_robot + omega x r_wheel
//   2. longitudinal speed error        e  = s_cmd - (vp . fwd)
//   3. desired traction force          F  = SPEED_GAIN * e          (speed-controller stiffness)
//   4. motor curve cap                 |F| <= STALL * max(MIN_CURVE, 1 - |s_cmd| / NO_LOAD)
//   5. traction cap (Coulomb)          |F_long,F_lat| combined <= MU * N_wheel   (friction circle)
//   6. apply at the wheel contact point -> translation and the yaw torque come out naturally
//   slip ratio = (s_cmd - ground speed) / max(|s_cmd|, 0.05), reported per wheel.
// When the robot pushes something whose floor friction exceeds what the motors/tyres can deliver,
// the wheels sit at the cap, the robot crawls or stops, slip -> 1, and behaviour.js detects stuck.

import RAPIER from '@dimforge/rapier2d-compat';
import { clamp, hypot } from './util.js';

export const PHYS = {
  // --- integration -------------------------------------------------------------------------
  SUBSTEP_DT: 1 / 240,          // s      physics substep; a 60 Hz frame runs 4 substeps
  MAX_FRAME_DT: 1 / 30,         // s      dt passed to step() is clamped to this
  LENGTH_UNIT: 0.1,             // m      Rapier's "typical object size": scales sleep & penetration thresholds
  GRAVITY: 9.81,                // m/s²   only used for normal loads (top-down world, no gravity vector)

  // --- robot body -------------------------------------------------------------------------
  ROBOT_MASS: 3.6,              // kg
  ROBOT_RADIUS: 0.17,           // m      Ø 0.34 m ≈ 150 px at 440 px/m
  WHEEL_HALF_BASE: 0.115,       // m      wheel contact points at ±this from the centre, laterally
  WHEEL_LOAD_FRACTION: 0.85,    // -      share of the robot weight carried by the two drive wheels
  CASTER_OFFSET: -0.12,         // m      caster position along the heading (negative = behind)
  CASTER_ROLLING_RES: 0.03,     // -      rolling-resistance coefficient of the caster (× its load)
  ROBOT_SHELL_FRICTION: 0.25,   // -      Rapier friction of the robot shell against icons/walls
  ROBOT_RESTITUTION: 0.0,       // -      bumper is soft: no bounce

  // --- drive motors / tyres ------------------------------------------------------------------
  WHEEL_MU: 0.8,                // -      tyre–floor friction coefficient  (traction cap = MU·N)
  MOTOR_STALL_FORCE: 16,        // N      per wheel at zero wheel speed
  MOTOR_NO_LOAD_SPEED: 0.42,    // m/s    wheel surface speed where motor force would reach 0
  MOTOR_MIN_CURVE: 0.12,        // -      floor of the motor curve so top speed still has some push
  SPEED_GAIN: 120,              // N/(m/s) speed-controller stiffness per wheel
  LATERAL_GRIP: 0.5,            // -      fraction of lateral (sideways) wheel velocity removed per substep
  MAX_SPEED: 0.3,               // m/s    commanded wheel speed limit
  MAX_ACCEL: 0.6,               // m/s²   ramp limit of the commanded wheel speed
  MAX_OMEGA: 2.5,               // rad/s  commanded yaw rate limit
  MAX_ALPHA: 8.0,               // rad/s² ramp limit of the commanded yaw rate

  // --- icons (desktop files as furniture) -----------------------------------------------------
  // Icons use a stick-slip floor model: at rest they are FIXED bodies (true static friction: no creep
  // under a sustained push). The contact force on a resting icon, low-pass filtered with the bumper's
  // compliance time, must exceed MU_STATIC·m·g to break it loose; sliding icons feel MU_KINETIC·m·g
  // and freeze again once slower than REST_SPEED.
  ICON_MU_KINETIC: 0.6,         // -      floor friction while sliding (× m·g)
  ICON_MU_STATIC: 0.75,         // -      breakaway friction while at rest (× m·g)
  ICON_BREAKAWAY_TAU: 0.04,     // s      low-pass time constant of the contact force (bumper compliance)
  ICON_SPIN_RADIUS_FACTOR: 0.35,// -      effective lever arm for rotational floor friction (× half-diagonal)
  ICON_REST_SPEED: 0.01,        // m/s    below this (and REST_OMEGA) a sliding icon freezes again
  ICON_REST_OMEGA: 0.05,        // rad/s
  ICON_REST_SUBSTEPS: 3,        // -      consecutive slow substeps before freezing
  ICON_SHELL_FRICTION: 0.3,     // -      Rapier friction of icon sides
  ICON_RESTITUTION: 0.0,
  ICON_MIN_MASS: 0.02,          // kg     lightest icon the sim accepts (an empty file)
  ICON_MAX_MASS: 5.0,           // kg     heaviest icon the sim accepts (tests use 5 kg as an immovable block)
  ICON_FILE_MASS_MAX: 0.32,     // kg     massFromBytes() at 1 GB: every file stays pushable without the bumper
                                //        clicking (μs·m·g = 0.75·0.32·9.81 ≈ 2.4 N < BUMP_FORCE_THRESHOLD)
  ICON_MAX_MASS_BYTES: 1 << 30, // bytes  file size that reaches ICON_MAX_MASS

  // --- sensors ----------------------------------------------------------------------------------
  BUMP_FORCE_THRESHOLD: 2.5,    // N      contact force at which the mechanical bumper "clicks"
  BUMP_CONTACT_DIST: 0.004,     // m      contacts further apart than this are not counted as touching
  SIDE_SENSOR_RANGE: 0.15,      // m      side IR distance sensor range, measured from the shell
  FRONT_SENSOR_RANGE: 0.25,     // m      front "light touch" proximity range
  FRONT_SENSOR_ANGLES: [-0.45, 0, 0.45], // rad  bearings of the three front proximity beams
  // IR return falls with distance², so a surface of reflectance ρ (meta.ir, default 1) is seen only
  // within range·√ρ. Dark things (chocolate, black furniture) get rammed at full speed, as on real robots.
  CLIFF_SENSOR_INSET: 0.012,    // m      cliff sensors sit this far inside the shell
  CLIFF_ANGLES: [-1.0, -0.35, 0.35, 1.0], // rad  sensor bearings from heading (front arc only, like a real Roomba): left pair then right pair
  EDGE_ROBOT_OVERHANG: 0.07,    // m      hidden rail outside the page: last resort so the robot never falls off
  PUSHED_MIN_SPEED: 0.008,      // m/s    icon speed while touching the robot that counts as "pushed"
};

// Collision groups: membership bits. Rapier packs (membership << 16) | filter.
// CAKE: the standing cake collides with icons/walls/page edge and is seen by the robot's IR rays,
// but NOT by the robot's shell: robot <-> cake contact is mess.js's compliant bumper model, so the
// push force (needed for the tipping criterion) is known exactly and continuously.
// PLATE: the dessert plate collides with icons, walls, the page edge and other plates. It is lower than the
// bumper and the IR beams, so the robot meets it with its underside (mess.js), not through Rapier.
export const GRP = { ROBOT: 1, ICON: 2, WALL: 4, EDGE_ICON: 8, EDGE_ROBOT: 16, CAKE: 32, PLATE: 64 };
export const collisionGroups = (member, filter) => (((member & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
const groups = collisionGroups;
const RAY_GROUPS = groups(GRP.ROBOT, GRP.ICON | GRP.WALL | GRP.CAKE);

/** Log-scale mass from file size in bytes (50 g empty file → 5 kg at 1 GB+). */
export function massFromBytes(bytes) {
  const b = Math.max(0, bytes || 0);
  const t = clamp(Math.log10(b + 1) / Math.log10(PHYS.ICON_MAX_MASS_BYTES), 0, 1);
  // log-spaced: 20 g for an empty file, ~0.13 kg at 1 MB, 0.32 kg at 1 GB
  return PHYS.ICON_MIN_MASS * Math.pow(PHYS.ICON_FILE_MASS_MAX / PHYS.ICON_MIN_MASS, t);
}

/**
 * @param {object} o
 * @param {number} o.widthM  page width in metres
 * @param {number} o.heightM page height in metres
 * @param {{x:number,y:number,angle:number}} o.start robot start pose (m, rad)
 * @param {Array<{x,y,w,h}>} o.walls      static rects (centre + size, m)
 * @param {Array<{id,x,y,w,h,massKg}>} o.obstacles icons (centre + size, m)
 */
export async function createPhysics(o) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0 });
  world.integrationParameters.lengthUnit = PHYS.LENGTH_UNIT;
  world.timestep = PHYS.SUBSTEP_DT;

  const W = o.widthM, H = o.heightM;
  const R = PHYS.ROBOT_RADIUS;

  // --- static geometry ---------------------------------------------------------------------
  /** collider handle -> { kind: 'wall'|'icon'|'edge', id } */
  const meta = new Map();

  function addStaticBox(cx, cy, hw, hh, kind, member, filter) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy));
    const col = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hw, hh).setFriction(0.3).setRestitution(0).setCollisionGroups(groups(member, filter)),
      body,
    );
    meta.set(col.handle, { kind, id: null });
    return body;
  }

  const wallBodies = [];
  for (const w of o.walls) {
    wallBodies.push(addStaticBox(w.x, w.y, w.w / 2, w.h / 2, 'wall', GRP.WALL, GRP.ROBOT | GRP.ICON | GRP.CAKE | GRP.PLATE));
  }
  // Page bounds: icons are fenced at the exact edge (they cannot leave the desktop); the robot
  // is fenced only by a hidden rail OVERHANG metres outside, so its cliff sensors do the real work.
  const T = 1.0; // rail thickness
  const ov = PHYS.EDGE_ROBOT_OVERHANG;
  for (const [cx, cy, hw, hh] of [
    [W / 2, -T / 2, W / 2 + T, T / 2], [W / 2, H + T / 2, W / 2 + T, T / 2],
    [-T / 2, H / 2, T / 2, H / 2 + T], [W + T / 2, H / 2, T / 2, H / 2 + T],
  ]) addStaticBox(cx, cy, hw, hh, 'edge', GRP.EDGE_ICON, GRP.ICON | GRP.CAKE | GRP.PLATE);
  for (const [cx, cy, hw, hh] of [
    [W / 2, -ov - T / 2, W / 2 + T, T / 2], [W / 2, H + ov + T / 2, W / 2 + T, T / 2],
    [-ov - T / 2, H / 2, T / 2, H / 2 + T], [W + ov + T / 2, H / 2, T / 2, H / 2 + T],
  ]) addStaticBox(cx, cy, hw, hh, 'edge', GRP.EDGE_ROBOT, GRP.ROBOT);

  // --- robot ---------------------------------------------------------------------------------
  const robotBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(o.start.x, o.start.y)
      .setRotation(o.start.angle)
      .setCanSleep(false)
      .setCcdEnabled(true),
  );
  const robotCollider = world.createCollider(
    RAPIER.ColliderDesc.ball(R)
      .setMass(PHYS.ROBOT_MASS)
      .setFriction(PHYS.ROBOT_SHELL_FRICTION)
      .setRestitution(PHYS.ROBOT_RESTITUTION)
      .setCollisionGroups(groups(GRP.ROBOT, GRP.ICON | GRP.WALL | GRP.EDGE_ROBOT)),
    robotBody,
  );

  // --- icons ---------------------------------------------------------------------------------
  /** id -> { body, collider, hw, hh, mass, inertia, kinematic, moving } */
  const icons = new Map();

  function addIcon(ic) {
    const mass = clamp(ic.massKg ?? PHYS.ICON_MIN_MASS, PHYS.ICON_MIN_MASS, PHYS.ICON_MAX_MASS);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(ic.x, ic.y).setRotation(ic.angle || 0),
    );
    const hw = Math.max(0.01, ic.w / 2), hh = Math.max(0.01, ic.h / 2);
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hw, hh)
        .setMass(mass)
        .setFriction(PHYS.ICON_SHELL_FRICTION)
        .setRestitution(PHYS.ICON_RESTITUTION)
        .setCollisionGroups(groups(GRP.ICON, GRP.ROBOT | GRP.ICON | GRP.WALL | GRP.EDGE_ICON | GRP.CAKE | GRP.PLATE)),
      body,
    );
    meta.set(collider.handle, { kind: 'icon', id: ic.id });
    const rec = { id: ic.id, body, collider, hw, hh, mass, inertia: mass * (hw * hw + hh * hh) / 3, kinematic: false, resting: true, fEma: 0, restCount: 0 };
    icons.set(ic.id, rec);
    return rec;
  }
  function removeIcon(rec) {
    meta.delete(rec.collider.handle);
    world.removeRigidBody(rec.body);
    icons.delete(rec.id);
  }
  for (const ic of o.obstacles) addIcon(ic);

  // --- per-step state --------------------------------------------------------------------------
  const drive = {
    cmdL: 0, cmdR: 0,          // current (ramped) wheel surface speed targets, m/s
    wheelL: 0, wheelR: 0,      // actual wheel surface speeds, m/s (spin at cmd when slipping)
    slipL: 0, slipR: 0,        // 0..1 slip ratio per wheel
    // set by mess.js (null / 1 = flat clean floor): per-wheel normal load from the suspension model
    // (a high-centred robot has light or hanging wheels) and tyre μ multiplier (frosting, smear)
    loadL: null, loadR: null,  // N
    muL: 1, muR: 1,            // -
    fLongL: 0, fLongR: 0,      // N      longitudinal tyre force actually transmitted (last substep)
    strain: 0,                 // 0..1 how hard the motors are working against the caps
  };
  const bumper = { left: false, right: false, forceL: 0, forceR: 0, contacts: [] };
  const substepHooks = [];
  const pushed = new Set();
  const tmpV = { x: 0, y: 0 };
  const tmpP = { x: 0, y: 0 };

  function pose() {
    const t = robotBody.translation();
    return { x: t.x, y: t.y, angle: robotBody.rotation() };
  }

  // Apply drive forces for one substep.
  function applyDrive(h) {
    robotBody.resetForces(true);
    robotBody.resetTorques(true);
    const t = robotBody.translation();
    const th = robotBody.rotation();
    const v = robotBody.linvel();
    const om = robotBody.angvel();
    const fx = Math.cos(th), fy = Math.sin(th);      // forward
    const rx = -fy, ry = fx;                           // right (clockwise from forward on screen)
    const Nnominal = PHYS.WHEEL_LOAD_FRACTION * PHYS.ROBOT_MASS * PHYS.GRAVITY * 0.5;
    const mShare = PHYS.ROBOT_MASS * 0.5;

    for (let side = 0; side < 2; side++) {
      const Nwheel = (side === 0 ? drive.loadL : drive.loadR) ?? Nnominal;
      const muN = PHYS.WHEEL_MU * (side === 0 ? drive.muL : drive.muR) * Math.max(0, Nwheel);
      // left wheel sits at -right*b, right wheel at +right*b
      const sgn = side === 0 ? -1 : 1;
      const ox = rx * PHYS.WHEEL_HALF_BASE * sgn, oy = ry * PHYS.WHEEL_HALF_BASE * sgn;
      const px = t.x + ox, py = t.y + oy;
      // point velocity: v + omega x r  (2D: (-w*ry, w*rx))
      const vpx = v.x - om * oy, vpy = v.y + om * ox;
      const vLong = vpx * fx + vpy * fy;
      const vLat = vpx * rx + vpy * ry;
      const sCmd = side === 0 ? drive.cmdL : drive.cmdR;

      let fLong = PHYS.SPEED_GAIN * (sCmd - vLong);
      const want = Math.abs(fLong);
      // motor curve evaluated at the rolling speed: force the motor can deliver without the wheel slipping
      const motorCap = PHYS.MOTOR_STALL_FORCE * Math.max(PHYS.MOTOR_MIN_CURVE, 1 - Math.abs(vLong) / PHYS.MOTOR_NO_LOAD_SPEED);
      // traction-limited: the motor could deliver more than the tyre can transmit -> wheel spins
      const tractionLimited = want > muN && muN < motorCap;
      const cap = Math.min(motorCap, muN);
      if (want > cap) fLong = Math.sign(fLong) * cap;
      // lateral grip: remove a fraction of sideways velocity per substep
      let fLat = -PHYS.LATERAL_GRIP * mShare * vLat / h;
      // friction circle
      const tot = hypot(fLong, fLat);
      if (tot > muN) {
        const sc = muN / tot;
        fLong *= sc; fLat *= sc;
      }
      // wheel surface speed: spins at the commanded speed when slipping, otherwise rolls with the ground
      const wheelSpeed = tractionLimited ? sCmd : vLong + fLong / PHYS.SPEED_GAIN;
      const slip = tractionLimited ? clamp(Math.abs(sCmd - vLong) / Math.max(Math.abs(sCmd), 0.05), 0, 1) : 0;
      if (side === 0) { drive.slipL = slip; drive.wheelL = wheelSpeed; drive.fLongL = fLong; } else { drive.slipR = slip; drive.wheelR = wheelSpeed; drive.fLongR = fLong; }

      tmpV.x = fLong * fx + fLat * rx; tmpV.y = fLong * fy + fLat * ry;
      tmpP.x = px; tmpP.y = py;
      robotBody.addForceAtPoint(tmpV, tmpP, true);
    }
    // caster rolling resistance (also opposes spinning in place a bit, like a real caster)
    {
      const ox = fx * PHYS.CASTER_OFFSET, oy = fy * PHYS.CASTER_OFFSET;
      const vpx = v.x - om * oy, vpy = v.y + om * ox;
      const sp = hypot(vpx, vpy);
      if (sp > 1e-4) {
        const Nc = (1 - PHYS.WHEEL_LOAD_FRACTION) * PHYS.ROBOT_MASS * PHYS.GRAVITY;
        const f = Math.min(PHYS.CASTER_ROLLING_RES * Nc, PHYS.ROBOT_MASS * 0.15 * sp / h);
        tmpV.x = -f * vpx / sp; tmpV.y = -f * vpy / sp;
        tmpP.x = t.x + ox; tmpP.y = t.y + oy;
        robotBody.addForceAtPoint(tmpV, tmpP, true);
      }
    }
    // strain: how close the drive is to its caps while still having a speed error
    const errL = Math.abs(drive.cmdL - (v.x * fx + v.y * fy)), errR = Math.abs(drive.cmdR - (v.x * fx + v.y * fy));
    const err = Math.max(errL, errR);
    drive.strain = clamp(err / 0.15, 0, 1) * (Math.max(Math.abs(drive.cmdL), Math.abs(drive.cmdR)) > 0.02 ? 1 : 0);
  }

  // Stick-slip floor friction for icons (see PHYS.ICON_* notes). Called once per substep, after world.step().
  function sumContactForce(rec, h) {
    let J = 0;
    world.contactPairsWith(rec.collider, (other) => {
      world.contactPair(rec.collider, other, (manifold) => {
        const n = manifold.numContacts();
        for (let i = 0; i < n; i++) J += Math.abs(manifold.contactImpulse(i));
      });
    });
    return J / h;
  }
  function freezeIcon(rec) {
    rec.resting = true; rec.fEma = 0; rec.restCount = 0;
    rec.body.setLinvel({ x: 0, y: 0 }, false);
    rec.body.setAngvel(0, false);
    rec.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
  }
  function unfreezeIcon(rec) {
    rec.resting = false; rec.restCount = 0;
    rec.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  }
  function updateIconFriction(h) {
    for (const rec of icons.values()) {
      if (rec.kinematic) continue;
      const mg = rec.mass * PHYS.GRAVITY;
      // filtered contact force: a hard impact over one substep is softened like a real bumper would
      const fInst = sumContactForce(rec, h);
      rec.fEma += (fInst - rec.fEma) * Math.min(1, h / PHYS.ICON_BREAKAWAY_TAU);
      if (rec.resting) {
        if (rec.fEma > PHYS.ICON_MU_STATIC * mg) unfreezeIcon(rec);
        continue;
      }
      const b = rec.body;
      b.resetForces(false);
      b.resetTorques(false);
      const v = b.linvel();
      const sp = hypot(v.x, v.y);
      if (sp > 1e-5) {
        const f = Math.min(PHYS.ICON_MU_KINETIC * mg, rec.mass * sp / h);
        tmpV.x = -f * v.x / sp; tmpV.y = -f * v.y / sp;
        b.addForce(tmpV, false);
      }
      const om = b.angvel();
      if (Math.abs(om) > 1e-5) {
        const lever = PHYS.ICON_SPIN_RADIUS_FACTOR * hypot(rec.hw, rec.hh);
        const tq = Math.min(PHYS.ICON_MU_KINETIC * mg * lever, rec.inertia * Math.abs(om) / h);
        b.addTorque(-Math.sign(om) * tq, false);
      }
      if (sp < PHYS.ICON_REST_SPEED && Math.abs(om) < PHYS.ICON_REST_OMEGA) {
        if (++rec.restCount >= PHYS.ICON_REST_SUBSTEPS && rec.fEma < PHYS.ICON_MU_STATIC * mg) freezeIcon(rec);
      } else rec.restCount = 0;
    }
  }

  // Read contact manifolds on the robot after the last substep -> bumper state + pushed icons.
  function collectContacts(h) {
    bumper.left = false; bumper.right = false; bumper.forceL = 0; bumper.forceR = 0;
    bumper.contacts.length = 0;
    pushed.clear();
    const t = robotBody.translation();
    const th = robotBody.rotation();
    const fx = Math.cos(th), fy = Math.sin(th);
    const rx = -fy, ry = fx;
    world.contactPairsWith(robotCollider, (other) => {
      const m = meta.get(other.handle);
      if (!m) return;
      let touching = false;
      world.contactPair(robotCollider, other, (manifold, flipped) => {
        const n = manifold.normal(); // from collider1 to collider2
        // normal pointing from the robot into the other body
        const nx = flipped ? -n.x : n.x, ny = flipped ? -n.y : n.y;
        const count = manifold.numContacts();
        for (let i = 0; i < count; i++) {
          if (manifold.contactDist(i) > PHYS.BUMP_CONTACT_DIST) continue;
          const lp = flipped ? manifold.localContactPoint2(i) : manifold.localContactPoint1(i);
          if (!lp) continue;
          // local point is in the robot body frame -> world
          const wx = t.x + lp.x * fx - lp.y * fy;
          const wy = t.y + lp.x * fy + lp.y * fx;
          const impulse = Math.abs(manifold.contactImpulse(i));
          const force = impulse / h;
          const dx = wx - t.x, dy = wy - t.y;
          const along = dx * fx + dy * fy;
          const lat = dx * rx + dy * ry;
          touching = true;
          // front 180°: contact ahead of the axle line
          const front = along > -0.01;
          if (m.kind === 'icon') {
            const rec = icons.get(m.id);
            if (rec && !rec.kinematic && !rec.resting) {
              const iv = rec.body.linvel();
              if (hypot(iv.x, iv.y) > PHYS.PUSHED_MIN_SPEED) pushed.add(m.id);
            }
          }
          bumper.contacts.push({ x: wx, y: wy, nx, ny, force, front, side: lat >= 0 ? 'right' : 'left', bearing: Math.atan2(lat, along), kind: m.kind, id: m.id });
          if (front) {
            if (lat >= 0) bumper.forceR += force; else bumper.forceL += force;
          }
        }
      });
      void touching;
    });
    bumper.right = bumper.forceR >= PHYS.BUMP_FORCE_THRESHOLD;
    bumper.left = bumper.forceL >= PHYS.BUMP_FORCE_THRESHOLD;
  }

  // --- sensors -------------------------------------------------------------------------------
  const ray = new RAPIER.Ray({ x: 0, y: 0 }, { x: 1, y: 0 });
  /**
   * Side distance sensor. side=+1 right, -1 left. Returns {dist (from shell), x, y (hit), kind} or null.
   */
  function castSide(side) {
    const t = robotBody.translation();
    const th = robotBody.rotation();
    const a = th + side * Math.PI / 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    ray.origin.x = t.x + dx * (R - 0.005); ray.origin.y = t.y + dy * (R - 0.005);
    ray.dir.x = dx; ray.dir.y = dy;
    const hit = world.castRay(ray, PHYS.SIDE_SENSOR_RANGE + 0.005, true, undefined, RAY_GROUPS, undefined, robotBody);
    if (!hit) return null;
    const d = hit.timeOfImpact - 0.005;
    const m = meta.get(hit.collider.handle);
    if (m && m.ir !== undefined && d > PHYS.SIDE_SENSOR_RANGE * Math.sqrt(m.ir)) return null;
    return { dist: Math.max(0, d), x: ray.origin.x + dx * hit.timeOfImpact, y: ray.origin.y + dy * hit.timeOfImpact, kind: m ? m.kind : 'wall', id: m ? m.id : null };
  }
  /** Front proximity (light-touch) sensors: three radial IR beams across the bumper; nearest distance from the shell or null. */
  function castFront() {
    const t = robotBody.translation();
    const th = robotBody.rotation();
    let best = null;
    for (const off of PHYS.FRONT_SENSOR_ANGLES) {
      const a = th + off;
      const dx = Math.cos(a), dy = Math.sin(a);
      ray.origin.x = t.x + dx * (R - 0.005); ray.origin.y = t.y + dy * (R - 0.005);
      ray.dir.x = dx; ray.dir.y = dy;
      const hit = world.castRay(ray, PHYS.FRONT_SENSOR_RANGE + 0.005, true, undefined, RAY_GROUPS, undefined, robotBody);
      if (!hit) continue;
      const d = Math.max(0, hit.timeOfImpact - 0.005);
      const m = meta.get(hit.collider.handle);
      if (m && m.ir !== undefined && d > PHYS.FRONT_SENSOR_RANGE * Math.sqrt(m.ir)) continue;
      if (!best || d < best.dist) {
        best = { dist: d, x: ray.origin.x + dx * hit.timeOfImpact, y: ray.origin.y + dy * hit.timeOfImpact, kind: m ? m.kind : 'wall', id: m ? m.id : null };
      }
    }
    return best;
  }
  /** Cliff sensors: returns array of {x,y,tripped} in world metres, same order as CLIFF_ANGLES. */
  const cliffOut = PHYS.CLIFF_ANGLES.map(() => ({ x: 0, y: 0, tripped: false }));
  function readCliffs() {
    const t = robotBody.translation();
    const th = robotBody.rotation();
    const r = R - PHYS.CLIFF_SENSOR_INSET;
    for (let i = 0; i < PHYS.CLIFF_ANGLES.length; i++) {
      const a = th + PHYS.CLIFF_ANGLES[i];
      const x = t.x + Math.cos(a) * r, y = t.y + Math.sin(a) * r;
      const c = cliffOut[i];
      c.x = x; c.y = y;
      c.tripped = x < 0 || x > W || y < 0 || y > H;
    }
    return cliffOut;
  }

  // --- public ----------------------------------------------------------------------------------
  return {
    RAPIER, world, robotBody, robotCollider, icons, drive, bumper, pushed,
    pose,
    velocity() {
      const v = robotBody.linvel();
      return { vx: v.x, vy: v.y, omega: robotBody.angvel() };
    },
    /** forward speed along heading (signed) */
    forwardSpeed() {
      const v = robotBody.linvel(); const th = robotBody.rotation();
      return v.x * Math.cos(th) + v.y * Math.sin(th);
    },
    /**
     * Set the desired body motion (m/s, rad/s). Converted to wheel targets with accel ramps.
     */
    command(vTarget, wTarget, dt, vMax = PHYS.MAX_SPEED, accel = PHYS.MAX_ACCEL) {
      const v = clamp(vTarget, -vMax, vMax);
      const w = clamp(wTarget, -PHYS.MAX_OMEGA, PHYS.MAX_OMEGA);
      // left wheel goes faster for positive (clockwise-on-screen) omega
      const tl = clamp(v + w * PHYS.WHEEL_HALF_BASE, -vMax, vMax);
      const tr = clamp(v - w * PHYS.WHEEL_HALF_BASE, -vMax, vMax);
      const maxD = (accel + PHYS.MAX_ALPHA * PHYS.WHEEL_HALF_BASE) * dt;
      drive.cmdL += clamp(tl - drive.cmdL, -maxD, maxD);
      drive.cmdR += clamp(tr - drive.cmdR, -maxD, maxD);
    },
    /** stop motors immediately (no ramp) */
    halt() { drive.cmdL = 0; drive.cmdR = 0; },
    /** advance physics by dt using n substeps */
    advance(dt) {
      const n = Math.max(1, Math.ceil(dt / PHYS.SUBSTEP_DT));
      const h = dt / n;
      world.timestep = h;
      for (let i = 0; i < n; i++) {
        applyDrive(h);                              // resets robot forces, adds wheel/caster forces
        for (const hook of substepHooks) hook(h);   // external forces (mess.js: cake contact, belly, slopes)
        world.step();
        updateIconFriction(h);
      }
      collectContacts(h);
    },
    /** functions (h) called every substep after the drive forces and before world.step() */
    substepHooks,
    meta, collisionGroups: groups,
    castSide, castFront, readCliffs,
    // icon management
    setIconKinematic(id, x, y) {
      const rec = icons.get(id);
      if (!rec) return;
      if (!rec.kinematic) {
        rec.kinematic = true;
        rec.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      }
      rec.body.setNextKinematicTranslation({ x, y });
      rec.kinTarget = { x, y }; // remembered: applied on release if no step happened in between
    },
    releaseIcon(id) {
      const rec = icons.get(id);
      if (!rec || !rec.kinematic) return;
      rec.kinematic = false;
      // setNextKinematicTranslation only takes effect at the next world step; a drag that ends in
      // the same frame as its last move (e.g. the desktop's grid snap) would otherwise be lost once
      // the body is frozen. Teleport to the last target first.
      if (rec.kinTarget) { rec.body.setTranslation(rec.kinTarget, false); rec.kinTarget = null; }
      freezeIcon(rec);
    },
    /** Re-sync the icon set. Returns true if anything changed. */
    syncIcons(list) {
      const seen = new Set();
      let changed = false;
      for (const ic of list) {
        seen.add(ic.id);
        const rec = icons.get(ic.id);
        if (!rec) { addIcon(ic); changed = true; continue; }
        const hw = Math.max(0.01, ic.w / 2), hh = Math.max(0.01, ic.h / 2);
        if (Math.abs(hw - rec.hw) > 1e-4 || Math.abs(hh - rec.hh) > 1e-4) {
          rec.hw = hw; rec.hh = hh;
          rec.collider.setHalfExtents({ x: hw, y: hh });
          changed = true;
        }
        const mass = clamp(ic.massKg ?? rec.mass, PHYS.ICON_MIN_MASS, PHYS.ICON_MAX_MASS);
        if (Math.abs(mass - rec.mass) > 1e-6) {
          rec.mass = mass; rec.collider.setMass(mass); changed = true;
        }
        rec.inertia = rec.mass * (rec.hw * rec.hw + rec.hh * rec.hh) / 3;
        if (!rec.kinematic) {
          const t = rec.body.translation();
          if (hypot(t.x - ic.x, t.y - ic.y) > 0.002) {
            rec.body.setTranslation({ x: ic.x, y: ic.y }, true);
            rec.body.setRotation(ic.angle || 0, true);
            if (!rec.resting) freezeIcon(rec);
            changed = true;
          }
        }
      }
      for (const rec of [...icons.values()]) {
        if (!seen.has(rec.id)) { removeIcon(rec); changed = true; }
      }
      return changed;
    },
    iconStates() {
      const out = [];
      for (const rec of icons.values()) {
        const t = rec.body.translation();
        out.push({ id: rec.id, x: t.x, y: t.y, angle: rec.body.rotation(), asleep: rec.resting || rec.body.isSleeping(), hw: rec.hw, hh: rec.hh, mass: rec.mass });
      }
      return out;
    },
    /** teleport the robot (used by resume-from-dock and tests) */
    setPose(x, y, angle) {
      robotBody.setTranslation({ x, y }, true);
      robotBody.setRotation(angle, true);
      robotBody.setLinvel({ x: 0, y: 0 }, true);
      robotBody.setAngvel(0, true);
    },
    GRP,
  };
}
