// mess.js — "the cake incident". A white dessert plate, a slice of chocolate layer cake standing on it, the
// robot pushing the plate around, the slice tipping off, the robot rolling over it on its suspension, frosting
// moving onto tyres and brush and printed back onto the desk as smear stamps. See docs/notes/SPEC-mess.md and
// docs/notes/SPEC-plate.md.
//
// Internal units are SI (m, s, kg, N, rad). State and stamps go out in CSS px like the rest of the API.
//
// ── Plate ─────────────────────────────────────────────────────────────────────────────────────────────
// Dynamic Rapier disc Ø 0.22 m, 0.45 kg (+ the slice while it stands or lies on it), glazed foot on the desk
// (μs 0.25, μk 0.18). It collides with icons, walls and other plates through Rapier. It is only 16 mm high:
// below the bumper and the IR beams, so the robot meets it with its UNDERSIDE. The rim presses on the
// robot's chamfer; the chamfer's slope turns that into a horizontal push on the plate plus a small
// downward load on it. A free plate breaks loose at ≈4 N of contact and slides ahead at nearly full robot
// speed (no bumper click). A pinned plate (against an icon or wall) takes the load until the chamfer
// lifts the robot over the rim: a small hop ('plateBump'). Glancing hits spin it through underside friction.
// ── Standing slice ────────────────────────────────────────────────────────────────────────────────────
// Collision footprint: the spec's 0.13 × 0.07 m box. Tipping uses the support polygon of the real 30° wedge:
// its centroid is only 22.5 mm from either long side (43 mm from the back, 87 mm from the tip). Tipping over
// an edge starts when the overturning moment beats m g · (centroid–edge distance):
//     on the desk (rests on its sponge base, μs 1.1):  robot push at h_c  vs. sliding at μs m g
//     on a plate (the base sits in the plate's well, the rim stops it from sliding out): robot push at h_c
//         plus the inertial pseudo-force −m·a_plate at the centre of mass (h_cg)
// i.e. a > g · (edge distance)/h_cg = 4.0 m/s² sideways starts it. Whether it goes over is then integrated:
// ── Tipping ───────────────────────────────────────────────────────────────────────────────────────────
// Rigid body pivoting about that edge (which rides along with the plate):
//     I_edge φ'' = m g r sin(φ − φ0) + F(φ)·y(φ) + f_inertial · r cos(φ − φ0) − c φ'
//     I_edge = m (d² + H²)/3 with d = 2·(edge distance),  r = √((d/2)² + h_cg²),  φ0 = atan((d/2)/h_cg) ≈ 22°
// A rigid stop or start of the plate gives the slice φ' = m h_cg Δv / I_edge; it needs ≈ 4.2 rad/s to clear
// φ0, i.e. Δv ≳ 0.37 m/s: a full-speed ram or slamming the plate into something tips it, a gentle push only
// rocks it. It lands on the plate or on the desk depending on where the footprint ends up.
// ── Lying / crushed ───────────────────────────────────────────────────────────────────────────────────
// The slice lies on a cut face: footprint 0.13 × 0.11 m, thickness ramping from the tip (6 mm) to the back
// (0.07 m). It is a 10 × 8 height field of soft viscoplastic sponge (elastic E·A/h, plastic flow
// dh/dt = −(σ − σy)/η). On a plate it rides on the plate surface and moves with the plate.
// The robot body is a 3-DOF rigid body (heave, pitch, roll) on two spring-suspended wheels (3 cm of travel),
// a caster and its own underside: flat belly at 8 mm, chamfer up to 3 cm at r = 0.16 m, bumper face up to
// 8.5 cm at the rim. Tyres follow the ground with their real radius (a step is met on the tyre's curve).
// The sponge is soft and yields fast, so a pass squashes it under tyres and belly: a short hop, a brief
// slow-down, carry on. Several passes crush it (squash ≥ 0.9). The underside's slope turns contact forces
// into horizontal forces (the chamfer climbs, the bumper face ploughs); the reactions push the slice (on
// the desk it adheres: wet ganache face) or the plate it lies on.
// ── Paint ─────────────────────────────────────────────────────────────────────────────────────────────
// Three carriers: left tyre, right tyre, main brush. Contact with cake moves frosting onto the carrier in
// proportion to surface travel. Every metre of travel in floor contact gives back 1 − e^(−ds/λ) of the load
// as stamps plus a coarse smear grid. Rolling over older smear re-picks a little. The side brush flings
// droplets tangentially.

import RAPIER from '@dimforge/rapier2d-compat';
import { PHYS, GRP } from './physics.js';
import { DUST } from './dust.js';
import { clamp, hypot } from './util.js';

export const MESS = {
  // --- slice ---------------------------------------------------------------------------------------------
  CAKE_LEN: 0.13,            // m      tip -> back (collision footprint long side, along cake.angle)
  CAKE_WIDTH: 0.07,          // m      back width (collision footprint short side)
  CAKE_HEIGHT: 0.11,         // m      standing height
  CAKE_MASS: 0.35,           // kg
  CAKE_CG_H: 0.055,          // m      centre of mass height while standing
  TIP_HALF_SIDE: 0.0225,     // m      wedge centroid -> long side (30° wedge: 1/3 of the triangle's height on that side)
  TIP_HALF_BACK: 0.0433,     // m      wedge centroid -> back edge (L/3)
  TIP_HALF_TIP: 0.0867,      // m      wedge centroid -> tip (2L/3)
  CAKE_MU_KINETIC: 0.5,      // -      slice sliding on the bare desk
  CAKE_MU_STATIC: 1.1,       // -      breakaway on the desk (sponge base sticks): pushed sideways it tips (1.9 N) long
                             //        before it slides (3.8 N); pushed from the back over its tip it slides (tip needs 7.4 N)
  CAKE_REST_SPEED: 0.01,     // m/s    a sliding cake below this (and REST_OMEGA) sticks again
  CAKE_REST_OMEGA: 0.05,     // rad/s
  BUMPER_H: 0.04,            // m      height of the robot's push resultant (h_c)
  BUMPER_K: 3000,            // N/m    bumper compliance for robot <-> standing/tipping slice contact
  BUMPER_HC: 1.5,            // s/m    Hunt–Crossley damping: F = K·pen·(1 + HC·closing speed), no jump at touch
  CONTACT_MIN_F: 0.3,        // N      contact force that counts as touching (events, bumper)
  CAKE_IR_REFLECTANCE: 0.004,// -      dark matte chocolate in near-IR: light-touch range × √ρ ≈ 1.6 cm
  HIT_DEBOUNCE: 0.5,         // s      min spacing of 'cakeHit' / 'plateHit' events
  // --- tipping --------------------------------------------------------------------------------------------
  TIP_RESTITUTION: 0.2,      // -      bounce on landing (fraction of angular speed)
  TIP_SETTLE_RATE: 0.8,      // rad/s  landing slower than this settles into 'lying'
  TIP_PIVOT_DAMP: 0.0005,    // N·m·s  damping at the pivot edge (squashing sponge)
  // --- plate ----------------------------------------------------------------------------------------------
  PLATE_R: 0.11,             // m      outer radius (Ø 0.22 m dessert plate)
  PLATE_MASS: 0.45,          // kg
  PLATE_MU_STATIC: 0.25,     // -      glazed foot ring on a desk
  PLATE_MU_KINETIC: 0.18,    // -
  PLATE_FOOT_R: 0.045,       // m      foot ring radius: lever of the floor friction torque
  PLATE_RESTITUTION: 0.2,    // -      plate against icons / walls / plates
  PLATE_REST_SPEED: 0.005,   // m/s    slower than this (and REST_OMEGA) with no net push: it sticks
  PLATE_REST_OMEGA: 0.05,    // rad/s
  PLATE_WELL_R: 0.075,       // m      flat well radius ...
  PLATE_WELL_H: 0.006,       // m      ... and its surface height (where the slice stands)
  PLATE_RIM_R: 0.10,         // m      the rim rises to its crest here ...
  PLATE_RIM_H: 0.016,        // m      ... at this height
  PLATE_EDGE_H: 0.012,       // m      height of the rounded outer lip at r = PLATE_R
  PLATE_K_PT: 3000,          // N/m    ceramic against the robot underside, per contact sample
  PLATE_C_PT: 30,            // N·s/m
  PLATE_MU_GLAZE: 0.3,       // -      robot underside sliding on glaze: drags the plate along as the lip pushes it (and
                             //        spins it on glancing hits); a robot straddling a plate drags it like a sock
  PLATE_MU_TYRE: 0.75,       // -      tyre μ multiplier on glaze
  PLATE_ON_FRAC: 0.9,        // -      a falling slice stays on the plate if its footprint centre lands within this × R
  PLATE_BUMP_FRACTION: 0.12, // -      share of robot weight carried by a plate through tyres, caster or flat belly
                             //        (not the lip pushing it) that counts as riding over its rim
  PLATE_BUMP_DEBOUNCE: 1.0,  // s
  // --- lying / crushed: viscoplastic height field ----------------------------------------------------------
  GRID_NU: 10,               // cells  along the slice axis
  GRID_NV: 8,                // cells  across (along tipDir)
  CAKE_TIP_THICK: 0.006,     // m      thickness of the lying wedge at its tip
  SHORT_EDGE_THICK: 0.06,    // m      uniform thickness if it ever falls over a short edge
  CAKE_E: 2500,              // Pa     effective compressive modulus: moist sponge with mousse/ganache layers is very soft,
                             //        so the belly sinks in elastically (a ~1.5 cm hop, not a 3 cm high-centring)
  CAKE_YIELD: 500,           // Pa     plastic yield stress of the intact slice: tyre patches (≈20 kPa) cut through at once,
                             //        the broad belly (≈3 kPa) squashes it a bit per pass -> crushed after a few passes
  MUSH_YIELD: 120,           // Pa     ...and of the crushed mush (squeezes out from under the robot)
  CAKE_VISC: 2e4,            // Pa·s/m flow resistance: dh/dt = (σ − σy)/η
  CELL_DAMP: 4,              // N·s/m  per-cell contact damping
  CAKE_H_MIN: 0.003,         // m      a crushed cell cannot get thinner than this
  CRUSHED_SIZE: 0.24,        // m      footprint the crushed blob spreads to (squash 0 -> 1); volume conservation:
                             //        ≈5e-4 m³ of slice at CRUSHED_MEAN_H 1.2 cm covers Ø ≈ 0.23 m, so mush reaches both tyres
  CRUSHED_MEAN_H: 0.012,     // m      mean thickness that counts as squash = 1
  CRUSH_AT: 0.9,             // -      squash that makes it 'crushed'
  LYING_MU_STATIC: 4.0,      // -      lying slice on the desk: wet ganache cut face adheres (× normal load incl. robot
                             //        weight on it): ≈14 N to shove it unloaded, never while ridden
  LYING_MU_KINETIC: 1.5,     // -      dragging it smears (leaves a streak)
  DRAG_STREAK_W: 0.06,       // m      streak stamp width while a lying slice is dragged
  DRAG_STREAK_SPACING: 0.01, // m
  // --- robot underside and suspension (3-DOF heave/pitch/roll) ------------------------------------------------
  CLEARANCE: 0.008,          // m      flat belly height above the floor at rest
  FLAT_R: 0.14,              // m      radius of the flat belly
  CHAMFER_R: 0.163,          // m      the bumper's lower lip rises from FLAT_R to here (slope ≈ 1)...
  CHAMFER_H: 0.03,           // m      ...up to this height. A 16 mm plate rim meets it at r ≈ 0.148 m: a free plate
                             //        breaks loose at ≈2 N of rim load and slides ahead; a pinned one is climbed
  BUMPER_TOP: 0.085,         // m      bumper face rises from CHAMFER_R to the rim (R) up to this height
  CG_X: -0.018,              // m      centre of mass behind the wheel axle (gives the 85/15 wheel/caster split)
  WHEEL_R: 0.035,            // m      drive wheel radius: steps are met on the tyre's curve
  CASTER_R: 0.015,           // m
  WHEEL_TRAVEL: 0.03,        // m      wheel drop travel; beyond it the wheel hangs in the air
  WHEEL_SPRING_AT_STOP: 12,  // N      suspension spring force at the bump stop...
  WHEEL_SPRING_AT_DROP: 8,   // N      ...and at full drop: preloaded springs keep the tyres pressing (and gripping)
                             //        while the belly rides over something, as on real robot-vacuum wheel modules
  WHEEL_DAMP: 20,            // N·s/m
  K_STOP: 20000,             // N/m    wheel bump stop / caster / rim against the floor
  C_STOP: 150,               // N·s/m
  I_PITCH: 0.026,            // kg·m²  body pitch inertia (disc about a diameter)
  I_ROLL: 0.026,             // kg·m²
  VERT_ITERS: 2,             // -      vertical sub-iterations per physics substep (stiff contacts)
  WHEEL_WELL_R: 0.03,        // m      ground this close to a wheel is under the tyre, not the belly
  CASTER_WELL_R: 0.025,      // m
  WHEEL_PATCH_AREA: 6.6e-4,  // m²     tyre contact patch (crushes ruts into the cake)
  SETTLE_EPS: 5e-4,          // m      vertical model switches off once flat and settled
  // --- traction and resistance -----------------------------------------------------------------------------
  MU_FROSTING: 0.65,         // -      tyre μ multiplier on cake / frosting (tread cuts through the soft sponge)
  SMEAR_SLIP: 0.35,          // -      μ loss on a thick smear film (× min(1, thickness))
  MU_BELLY: 0.3,             // -      belly / chamfer sliding over greasy frosting
  C_RR_SOFT: 0.12,           // -      extra rolling resistance of a tyre sinking into cake (× its load)
  MAX_SLOPE: 1.5,            // -      cap on ground gradient used for slope forces
  MICROSLIP_RATE: 2,         // 1/s    random grip losses per wheel while in frosting
  MICROSLIP_MU: 0.45,        // -      μ multiplier during a micro-slip
  MICROSLIP_MIN: 0.04, MICROSLIP_MAX: 0.1, // s
  JOLT_V: 0.04,              // m/s    heave kick of a micro-slip jolt
  JOLT_W: 0.25,              // rad/s  pitch/roll kick
  // --- frosting transfer ------------------------------------------------------------------------------------
  PICK_WHEEL: 4,             // load/m tyre surface travel on cake -> tyre load
  PICK_BRUSH: 4,             // load/m brush travel over cake -> brush load (the roller grinds into it)
  FROSTING_PER_LOAD: 0.12,   // -      cake frosting used per unit of load picked up
  FROSTING_MIN_AVAIL: 0.25,  // -      pick-up efficiency left when the cake's frosting is used up
  // --- smear deposition -------------------------------------------------------------------------------------
  LOAD_DECAY_M: 14,          // m      exp length scale: sticky ganache wears off slowly, tracks fade over ~35–45 m
  STAMP_SPACING: 0.008,      // m      tyre stamp spacing
  BRUSH_STAMP_SPACING: 0.02, // m
  TYRE_W: 0.03,              // m      tyre print width (robot-vacuum drive wheels are ~3 cm wide)
  BRUSH_W: 0.18,             // m      brush band width
  BRUSH_FWD: 0.07,           // m      main brush position ahead of the centre
  BRUSH_LIFT_OFF: 0.015,     // m      body lift at which the brush leaves the floor
  INK_WHEEL: 1.0,            // -      stamp thickness per unit tyre load
  INK_BRUSH: 0.6,            // -      stamp thickness per unit brush load (smudgier than tyres)
  FLING_RATE: 10,            // 1/s    droplets at full brush load and side-brush rpm
  FLING_MIN: 0.03, FLING_MAX: 0.18, // m flight distance
  FLING_COST: 0.004,         // -      fraction of brush load per droplet
  SPLAT_W: 0.20,             // m      crush splat diameter
  LAND_SPLAT_W: 0.10,        // m      smudge where the slice lands
  LAND_SPLAT_AMOUNT: 0.35,   // -
  SMEAR_CELL: 0.04,          // m      coarse smear grid cell (re-pick + slippery film)
  THICK_PER_LOAD_AREA: 0.12, // m²     grid thickness = deposited load / area × this
  REPICK_WHEEL: 0.25,        // -      fraction of the smear under a tyre's footprint picked up per pass
  REPICK_BRUSH: 0.1,         // -
  REPICK_SELF_T: 1.0,        // s      a carrier does not re-pick its own paint this fresh
  SMEAR_OUT: 0.02,           // -      'smearOut' when every carrier's load is below this
  SMEAR_ARM: 0.05,           // -      ...after having been above this (hysteresis)
  SMEAR_BUFFER_MAX: 6000,    // stamps kept between getState() calls
  // --- events -------------------------------------------------------------------------------------------------
  CLIMB_FRACTION: 0.15,      // -      share of robot weight carried by cake that counts as a climb
  CLIMB_DEBOUNCE: 2,         // s
  MAX_OLD_CAKES: 6,          // -      crushed blobs (and their plates) kept when new cakes are placed
};

const NU = MESS.GRID_NU, NV = MESS.GRID_NV, NCELL = NU * NV;

// robot-frame sample points of the underside used against plates: rings dense in the chamfer and bumper band
const UPTS = (() => {
  const rings = [[0, 1], [0.045, 8], [0.09, 12], [0.12, 16], [0.135, 24], [0.145, 24], [0.155, 24], [0.163, 24], [0.168, 24]];
  const x = [], y = [];
  for (const [r, n] of rings) for (let i = 0; i < n; i++) { const a = (i + 0.5) / n * Math.PI * 2; x.push(r * Math.cos(a)); y.push(r * Math.sin(a)); }
  return { x: Float64Array.from(x), y: Float64Array.from(y), n: x.length };
})();

export function createMess({ phys, S, widthPx, heightPx, rng, events, cake: cakeCfg }) {
  const world = phys.world, rb = phys.robotBody, drive = phys.drive;
  const W = widthPx / S, H = heightPx / S;
  const R = PHYS.ROBOT_RADIUS, WB = PHYS.WHEEL_HALF_BASE, CX = PHYS.CASTER_OFFSET;
  const M = PHYS.ROBOT_MASS, G = PHYS.GRAVITY, MG = M * G;
  const IZ = 0.5 * M * R * R;
  let tNow = 0;

  /** underside height above the body reference plane at radius r, and its radial slope */
  function underside(r) {
    if (r <= MESS.FLAT_R) return [MESS.CLEARANCE, 0];
    if (r <= MESS.CHAMFER_R) {
      const k = (MESS.CHAMFER_H - MESS.CLEARANCE) / (MESS.CHAMFER_R - MESS.FLAT_R);
      return [MESS.CLEARANCE + (r - MESS.FLAT_R) * k, k];
    }
    const k = (MESS.BUMPER_TOP - MESS.CHAMFER_H) / (R - MESS.CHAMFER_R);
    return [MESS.CHAMFER_H + (Math.min(r, R) - MESS.CHAMFER_R) * k, k];
  }
  // precomputed underside at the plate sample points; points inside wheel / caster wells are dropped
  const UP = (() => {
    const keep = [];
    for (let i = 0; i < UPTS.n; i++) {
      const x = UPTS.x[i], y = UPTS.y[i];
      if (x * x + (y + WB) ** 2 < MESS.WHEEL_WELL_R ** 2 || x * x + (y - WB) ** 2 < MESS.WHEEL_WELL_R ** 2) continue;
      if ((x - CX) ** 2 + y * y < MESS.CASTER_WELL_R ** 2) continue;
      keep.push(i);
    }
    const n = keep.length;
    const o = { n, x: new Float64Array(n), y: new Float64Array(n), r: new Float64Array(n), u: new Float64Array(n), s: new Float64Array(n) };
    keep.forEach((i, k) => {
      o.x[k] = UPTS.x[i]; o.y[k] = UPTS.y[i]; o.r[k] = hypot(o.x[k], o.y[k]);
      const [u, s] = underside(o.r[k]); o.u[k] = u; o.s[k] = s;
    });
    return o;
  })();

  // ── smear grid + stamp buffer ─────────────────────────────────────────────────────────────────────────
  const GC = MESS.SMEAR_CELL, gw = Math.ceil(W / GC), gh = Math.ceil(H / GC);
  const grid = new Float32Array(gw * gh);   // paint thickness (same scale as stamp.amount)
  const gridT = new Float32Array(gw * gh);  // time of the last deposit
  const gridWho = new Uint8Array(gw * gh);  // carrier of the last deposit (1 L, 2 R, 3 brush, 4 other)
  const massToThick = MESS.THICK_PER_LOAD_AREA / (GC * GC);
  const smearGrid = { cellPx: GC * S, w: gw, h: gh, data: grid };
  let smear = [];
  const gridIndex = (x, y) => {
    const cx = Math.floor(x / GC), cy = Math.floor(y / GC);
    return cx < 0 || cy < 0 || cx >= gw || cy >= gh ? -1 : cy * gw + cx;
  };
  function gridAdd(x, y, mass, who) {
    const i = gridIndex(x, y);
    if (i < 0) return;
    grid[i] += mass * massToThick; gridT[i] = tNow; gridWho[i] = who;
  }
  const gridThick = (x, y) => { const i = gridIndex(x, y); return i < 0 ? 0 : grid[i]; };
  function stamp(kind, x, y, angle, w, amount, len) {
    if (smear.length >= MESS.SMEAR_BUFFER_MAX) smear.splice(0, smear.length - MESS.SMEAR_BUFFER_MAX + 1);
    smear.push({ kind, x: x * S, y: y * S, angle, w: w * S, amount: clamp(amount, 0, 1), len: len * S });
  }
  function emit(type, extra) { events.push(Object.assign({ t: tNow, type }, extra)); }

  // ── plates ────────────────────────────────────────────────────────────────────────────────────────────
  let plateSeq = 0;
  const plates = [];
  function makePlate(x, y) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).setCanSleep(false));
    const col = world.createCollider(
      RAPIER.ColliderDesc.ball(MESS.PLATE_R).setMass(MESS.PLATE_MASS).setFriction(0.2).setRestitution(MESS.PLATE_RESTITUTION)
        .setCollisionGroups(phys.collisionGroups(GRP.PLATE, GRP.ICON | GRP.WALL | GRP.EDGE_ICON | GRP.PLATE)),
      body,
    );
    const p = { id: `plate${++plateSeq}`, body, col, cakeId: null, extraMass: 0, stuck: true,
      x, y, angle: 0, vx: 0, vy: 0, om: 0, pvx: 0, pvy: 0, ax: 0, ay: 0, fresh: true,
      Fx: 0, Fy: 0, Tq: 0, Nrobot: 0, hitF: 0, touching: false, wasTouching: false, lastHitT: -1e9 };
    phys.meta.set(col.handle, { kind: 'plate', id: p.id });
    plates.push(p);
    return p;
  }
  function removePlate(p) {
    phys.meta.delete(p.col.handle);
    world.removeRigidBody(p.body);
    plates.splice(plates.indexOf(p), 1);
  }
  function setPlateCake(p, c) {
    p.cakeId = c ? c.id : null;
    p.extraMass = c ? MESS.CAKE_MASS : 0;
    p.body.setAdditionalMass(p.extraMass, true);
  }
  /** plate surface height at distance rho from its centre (0 off the plate) */
  function plateH(rho) {
    if (rho >= MESS.PLATE_R) return 0;
    if (rho <= MESS.PLATE_WELL_R) return MESS.PLATE_WELL_H;
    if (rho <= MESS.PLATE_RIM_R) {
      const t = (rho - MESS.PLATE_WELL_R) / (MESS.PLATE_RIM_R - MESS.PLATE_WELL_R);
      return MESS.PLATE_WELL_H + (MESS.PLATE_RIM_H - MESS.PLATE_WELL_H) * t * t * (3 - 2 * t);
    }
    const t = (rho - MESS.PLATE_RIM_R) / (MESS.PLATE_R - MESS.PLATE_RIM_R);
    return MESS.PLATE_RIM_H - (MESS.PLATE_RIM_H - MESS.PLATE_EDGE_H) * t * t;
  }
  const plateAt = (p, wx, wy) => plateH(hypot(wx - p.x, wy - p.y));
  /** read pose and velocity; plate acceleration from the velocity change since the last substep */
  function syncPlate(p, h) {
    const t = p.body.translation(), v = p.body.linvel();
    p.x = t.x; p.y = t.y; p.angle = p.body.rotation(); p.om = p.body.angvel();
    if (p.fresh) { p.pvx = v.x; p.pvy = v.y; p.fresh = false; }
    p.ax = (v.x - p.pvx) / h; p.ay = (v.y - p.pvy) / h;
    p.vx = v.x; p.vy = v.y; p.pvx = v.x; p.pvy = v.y;
    p.Fx = 0; p.Fy = 0; p.Tq = 0; p.Nrobot = 0; p.hitF = 0;
  }
  function readPlatePose(p) {
    const t = p.body.translation(), v = p.body.linvel();
    p.x = t.x; p.y = t.y; p.angle = p.body.rotation(); p.om = p.body.angvel(); p.vx = v.x; p.vy = v.y;
  }
  function plateForce(p, fx, fy, wx, wy) {
    p.Fx += fx; p.Fy += fy; p.Tq += (wx - p.x) * fy - (wy - p.y) * fx;
  }
  // plate-local <-> world transforms (cakes riding on plates are stored in plate coordinates)
  function locPt(p, wx, wy) { const c = Math.cos(p.angle), s = Math.sin(p.angle), dx = wx - p.x, dy = wy - p.y; return [dx * c + dy * s, -dx * s + dy * c]; }
  function wldPt(p, lx, ly) { const c = Math.cos(p.angle), s = Math.sin(p.angle); return [p.x + lx * c - ly * s, p.y + lx * s + ly * c]; }
  function locVec(p, vx, vy) { const c = Math.cos(p.angle), s = Math.sin(p.angle); return [vx * c + vy * s, -vx * s + vy * c]; }
  function wldVec(p, lx, ly) { const c = Math.cos(p.angle), s = Math.sin(p.angle); return [lx * c - ly * s, lx * s + ly * c]; }

  // ── cakes ─────────────────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  const cakes = [];         // every cake on the floor; the last one is "the" cake
  let initialCake = null;   // config pose for resetMess()

  function addBody(c) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c.x, c.y).setRotation(c.angle));
    const col = world.createCollider(
      RAPIER.ColliderDesc.cuboid(MESS.CAKE_LEN / 2, MESS.CAKE_WIDTH / 2)
        .setMass(MESS.CAKE_MASS).setFriction(0.3).setRestitution(0)
        .setCollisionGroups(phys.collisionGroups(GRP.CAKE, GRP.ROBOT | GRP.ICON | GRP.WALL | GRP.EDGE_ICON)),
      body,
    );
    phys.meta.set(col.handle, { kind: 'cake', id: c.id, ir: MESS.CAKE_IR_REFLECTANCE });
    c.body = body; c.collider = col; c.resting = true; c.restCount = 0;
  }
  function removeBody(c) {
    if (!c.body) return;
    phys.meta.delete(c.collider.handle);
    world.removeRigidBody(c.body);
    c.body = null; c.collider = null;
  }
  function makeCake(x, y, angle, plate) {
    const c = {
      id: `cake${++seq}`, phase: 'standing', x, y, angle, plate: plate || null, loc: null,
      tipDir: angle + Math.PI / 2, phi: 0, phid: 0, squash: 0, frosting: 1,
      body: null, collider: null, resting: true, restCount: 0,
      // robot contact (standing / tipping), last substep
      F: 0, nx: 0, ny: 0, cpx: 0, cpy: 0, touching: false, wasTouching: false, lastHitT: -1e9,
      // tipping
      pvx: 0, pvy: 0, tx: 0, ty: 0, ex: 0, ey: 0, half: 0, dFace: 0, edgeLen: 0, edge: 'long', landed: false,
      // lying
      grid: null, cellF: null, cx: 0, cy: 0, ux: 1, uy: 0, vx: 0, vy: 1, Lu: 0, Lv: 0, sU: 1, sV: 1,
      h0mean: 0, vX: 0, vY: 0, sliding: false, Fx: 0, Fy: 0, Nload: 0,
    };
    if (plate) { setPlateCake(plate, c); capture(c); } else addBody(c);
    return c;
  }
  /** store a plate-borne cake's world fields in plate coordinates */
  function capture(c) {
    const p = c.plate;
    if (!p) return;
    const L = c.loc || (c.loc = {});
    [L.x, L.y] = locPt(p, c.x, c.y); L.angle = c.angle - p.angle;
    if (c.phase === 'tipping' || c.phase === 'lying' || c.phase === 'crushed') {
      [L.pvx, L.pvy] = locPt(p, c.pvx, c.pvy); [L.tx, L.ty] = locVec(p, c.tx, c.ty); [L.ex, L.ey] = locVec(p, c.ex, c.ey);
      L.tipDir = c.tipDir - p.angle;
    }
    if (c.grid) { [L.cx, L.cy] = locPt(p, c.cx, c.cy); [L.ux, L.uy] = locVec(p, c.ux, c.uy); [L.vx, L.vy] = locVec(p, c.vx, c.vy); }
  }
  /** world fields of a plate-borne cake from its plate's current pose */
  function syncCake(c) {
    const p = c.plate, L = c.loc;
    if (!p || !L) return;
    [c.x, c.y] = wldPt(p, L.x, L.y); c.angle = p.angle + L.angle;
    if (L.pvx !== undefined) {
      [c.pvx, c.pvy] = wldPt(p, L.pvx, L.pvy); [c.tx, c.ty] = wldVec(p, L.tx, L.ty); [c.ex, c.ey] = wldVec(p, L.ex, L.ey);
      c.tipDir = p.angle + L.tipDir;
    }
    if (c.grid && L.cx !== undefined) { [c.cx, c.cy] = wldPt(p, L.cx, L.cy); [c.ux, c.uy] = wldVec(p, L.ux, L.uy); [c.vx, c.vy] = wldVec(p, L.vx, L.vy); }
  }
  function removeCake(c) {
    removeBody(c);
    if (c.plate && plates.includes(c.plate)) removePlate(c.plate);
    cakes.splice(cakes.indexOf(c), 1);
  }
  function placeCake(x, y, angle, withPlate = true) {
    const cur = cakes[cakes.length - 1];
    if (cur && cur.phase !== 'crushed') removeCake(cur);
    const plate = withPlate ? makePlate(x, y) : null;
    if (plate) readPlatePose(plate);
    const c = makeCake(x, y, angle, plate);
    cakes.push(c);
    while (cakes.length > MESS.MAX_OLD_CAKES + 1) removeCake(cakes[0]);
    return c;
  }
  if (cakeCfg !== false) {
    // default: wedge axis roughly up/down the page, so a robot coming out of its dock (left edge, heading +x)
    // meets a long side; ±20° of jitter from the seed
    const a = cakeCfg && Number.isFinite(cakeCfg.angle) ? cakeCfg.angle
      : (rng.range(0, 1) < 0.5 ? -1 : 1) * Math.PI / 2 + rng.range(-0.35, 0.35);
    const x = cakeCfg && Number.isFinite(cakeCfg.x) ? cakeCfg.x / S : W / 2;
    const y = cakeCfg && Number.isFinite(cakeCfg.y) ? cakeCfg.y / S : H / 2;
    const withPlate = !(cakeCfg && cakeCfg.plate === false);
    initialCake = { x, y, angle: a, withPlate };
    placeCake(x, y, a, withPlate);
  }

  // ── height field helpers ───────────────────────────────────────────────────────────────────────────────
  function cellW(c) { return (c.Lu * c.sU) / NU; }
  function cellH(c) { return (c.Lv * c.sV) / NV; }
  /** bilinear thickness of a lying cake at a world point (0 outside, ramps over half a cell at the edges) */
  const bw = [0, 0, 0, 0], bi = [0, 0, 0, 0];
  function cakeH(c, wx, wy, keepWeights) {
    const dx = wx - c.cx, dy = wy - c.cy;
    const du = cellW(c), dv = cellH(c);
    const fi = (dx * c.ux + dy * c.uy) / du + NU / 2 - 0.5;
    const fj = (dx * c.vx + dy * c.vy) / dv + NV / 2 - 0.5;
    if (fi < -1 || fj < -1 || fi > NU || fj > NV) return 0;
    const i0 = Math.floor(fi), j0 = Math.floor(fj), ai = fi - i0, aj = fj - j0;
    let h = 0;
    for (let k = 0; k < 4; k++) {
      const i = i0 + (k & 1), j = j0 + (k >> 1);
      const w = (k & 1 ? ai : 1 - ai) * (k >> 1 ? aj : 1 - aj);
      const inside = i >= 0 && j >= 0 && i < NU && j < NV;
      if (inside) h += w * c.grid[j * NU + i];
      if (keepWeights) { bw[k] = inside ? w : 0; bi[k] = inside ? j * NU + i : -1; }
    }
    return h;
  }
  /** top surface height at a world point over plates and lying cakes; fills hit = {h, src} */
  const hit = { h: 0, src: null };
  function groundAt(wx, wy) {
    let h = 0, src = null;
    for (const p of plates) {
      const hp = plateAt(p, wx, wy);
      if (hp > h) { h = hp; src = p; }
    }
    for (const c of cakes) {
      if (!c.grid) continue;
      const th = cakeH(c, wx, wy, false);
      if (th <= 0.0005) continue;
      const base = c.plate ? plateAt(c.plate, wx, wy) : 0;
      if (base + th > h) { h = base + th; src = c; }
    }
    hit.h = h; hit.src = src;
    return h;
  }
  /**
   * Ground under a wheel of radius rw rolling along (fx, fy): the highest point the tyre's circle touches
   * within ±0.85 rw, and the incline it feels (contact normal on the tyre's curve, or the surface gradient).
   */
  const gOut = { h: 0, gx: 0, gy: 0, src: null, cx: 0, cy: 0 };
  const CONTOUR = [-0.85, -0.45, 0, 0.45, 0.85];
  function contour(px, py, fx, fy, rw) {
    let best = -1, bestD = 0, src = null;
    for (const k of CONTOUR) {
      const d = k * rw;
      const h = groundAt(px + fx * d, py + fy * d) - (rw - Math.sqrt(rw * rw - d * d));
      if (h > best) { best = h; bestD = d; src = hit.src; }
    }
    gOut.h = Math.max(0, best); gOut.src = gOut.h > 0 ? src : null;
    gOut.gx = 0; gOut.gy = 0; gOut.cx = px + fx * bestD; gOut.cy = py + fy * bestD;   // where the tyre presses
    if (gOut.h <= 0) return gOut;
    // along the heading: the tyre meets the ground at angle asin(d / rw) on its curve
    const along = Math.abs(bestD) > 1e-6 ? bestD / Math.sqrt(rw * rw - bestD * bestD) : 0;
    // across the heading and on the flat part: surface gradient at the contact
    const e = 0.004, cx = px + fx * bestD, cy = py + fy * bestD;
    const gx = (groundAt(cx + e, cy) - groundAt(cx - e, cy)) / (2 * e);
    const gy = (groundAt(cx, cy + e) - groundAt(cx, cy - e)) / (2 * e);
    const gAlong = gx * fx + gy * fy, gLat = -gx * fy + gy * fx;
    const a = clamp(Math.abs(bestD) > 1e-6 ? along : gAlong, -MESS.MAX_SLOPE, MESS.MAX_SLOPE);
    const l = clamp(gLat, -MESS.MAX_SLOPE, MESS.MAX_SLOPE);
    gOut.gx = a * fx - l * fy; gOut.gy = a * fy + l * fx;
    return gOut;
  }

  function toLying(c) {
    c.phase = 'lying';
    c.phi = Math.PI / 2; c.phid = 0;
    // footprint: from the pivot edge out along tipDir by the standing height
    c.cx = c.pvx + c.tx * MESS.CAKE_HEIGHT / 2;
    c.cy = c.pvy + c.ty * MESS.CAKE_HEIGHT / 2;
    c.vx = c.tx; c.vy = c.ty; c.Lv = MESS.CAKE_HEIGHT;
    c.grid = new Float32Array(NCELL); c.cellF = new Float32Array(NCELL);
    if (c.edge === 'long') {
      // lying on a cut face: thickness ramps from the tip (u = +L/2) to the back (u = −L/2)
      c.ux = Math.cos(c.angle); c.uy = Math.sin(c.angle); c.Lu = MESS.CAKE_LEN;
      for (let i = 0; i < NU; i++) {
        const u = (i + 0.5) / NU * c.Lu - c.Lu / 2;
        const th = Math.max(MESS.CAKE_TIP_THICK, MESS.CAKE_WIDTH * (c.Lu / 2 - u) / c.Lu);
        for (let j = 0; j < NV; j++) c.grid[j * NU + i] = th;
      }
    } else {
      c.ux = c.ex; c.uy = c.ey; c.Lu = MESS.CAKE_WIDTH;
      c.grid.fill(MESS.SHORT_EDGE_THICK);
    }
    let s = 0; for (let i = 0; i < NCELL; i++) s += c.grid[i];
    c.h0mean = s / NCELL;
    // stays on its plate only if it came down mostly on it
    const p = c.plate;
    if (p && hypot(c.cx - p.x, c.cy - p.y) > MESS.PLATE_ON_FRAC * MESS.PLATE_R) {
      setPlateCake(p, null); c.plate = null; c.loc = null;
      emit('cakeOffPlate', { id: c.id, plate: p.id });
    }
    capture(c);
  }

  // ── per-substep: robot <-> standing slice (bumper spring) ─────────────────────────────────────────────────
  const tmpF = { x: 0, y: 0 }, tmpP = { x: 0, y: 0 };
  function rapierPushOn(c, h) {
    let fx = 0, fy = 0;
    world.contactPairsWith(c.collider, (other) => {
      world.contactPair(c.collider, other, (m, flipped) => {
        const n = m.normal();
        const nx = flipped ? -n.x : n.x, ny = flipped ? -n.y : n.y; // from the cake into the other body
        let J = 0; const k = m.numContacts();
        for (let i = 0; i < k; i++) J += m.contactImpulse(i);
        fx -= nx * J / h; fy -= ny * J / h;
      });
    });
    return [fx, fy];
  }
  /** support-edge distance for a push along cake-local (su, sv): ±v long sides, +u over the tip, −u over the back */
  function startTip(c, edge, sign, F) {
    const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
    if (edge === 'long') {
      c.tx = -sa * sign; c.ty = ca * sign; c.half = MESS.TIP_HALF_SIDE; c.dFace = MESS.TIP_HALF_SIDE + MESS.CAKE_WIDTH / 2; c.edgeLen = MESS.CAKE_LEN;
    } else {
      c.tx = ca * sign; c.ty = sa * sign; c.half = sign > 0 ? MESS.TIP_HALF_TIP : MESS.TIP_HALF_BACK;
      c.dFace = c.half + MESS.CAKE_LEN / 2; c.edgeLen = MESS.CAKE_WIDTH;
    }
    c.edge = edge;
    c.ex = -c.ty; c.ey = c.tx;
    c.pvx = c.x + c.tx * c.half; c.pvy = c.y + c.ty * c.half;
    c.tipDir = Math.atan2(c.ty, c.tx);
    c.phi = 0; c.phid = 0; c.landed = false;
    removeBody(c);
    c.phase = 'tipping';
    capture(c);
    emit('cakeTip', { id: c.id, tipDir: c.tipDir, force: F, edge, onPlate: c.plate ? c.plate.id : null });
  }
  /** bumper spring between the robot disc and the slice's box footprint; returns the force on the cake */
  function boxContact(c, rp, rv, cvx, cvy) {
    const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
    const hl = MESS.CAKE_LEN / 2, hw = MESS.CAKE_WIDTH / 2;
    const dx = rp.x - c.x, dy = rp.y - c.y;
    const lu = dx * ca + dy * sa, lv = -dx * sa + dy * ca;
    const qu = clamp(lu, -hl, hl), qv = clamp(lv, -hw, hw);
    let eu = lu - qu, ev = lv - qv, dist = hypot(eu, ev), pen;
    if (dist < 1e-6) { eu = lu; ev = lv; dist = Math.max(1e-6, hypot(lu, lv)); pen = R; } // centre inside: push out
    else pen = R - dist;
    const nlu = -eu / dist, nlv = -ev / dist;
    const nx = nlu * ca - nlv * sa, ny = nlu * sa + nlv * ca;
    const px = c.x + qu * ca - qv * sa, py = c.y + qu * sa + qv * ca;
    let F = 0;
    if (pen > 0) {
      const vn = (rv.x - cvx) * nx + (rv.y - cvy) * ny;
      F = Math.max(0, MESS.BUMPER_K * pen * (1 + MESS.BUMPER_HC * vn));
    }
    c.F = F; c.nx = nx; c.ny = ny; c.cpx = px; c.cpy = py;
    if (F > 0) { tmpF.x = -F * nx; tmpF.y = -F * ny; tmpP.x = px; tmpP.y = py; rb.addForceAtPoint(tmpF, tmpP, true); }
    return F;
  }
  /** largest overturning ratio over the wedge's support edges; moments from (fu, fv) at h_c and (pu, pv) at h_cg */
  function tipRatios(c, fu, fv, pu, pv) {
    const mg = MESS.CAKE_MASS * G, hc = MESS.BUMPER_H, hg = MESS.CAKE_CG_H;
    const mv = fv * hc + pv * hg, mu = fu * hc + pu * hg;
    const rV = Math.abs(mv) / (mg * MESS.TIP_HALF_SIDE);
    const rU = Math.abs(mu) / (mg * (mu > 0 ? MESS.TIP_HALF_TIP : MESS.TIP_HALF_BACK));
    return rV >= rU ? ['long', Math.sign(mv) || 1, rV] : ['short', Math.sign(mu) || 1, rU];
  }
  function standingSubstep(c, h, rp, rv) {
    const m = MESS.CAKE_MASS, mg = m * G;
    const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
    if (c.plate) {
      // in the plate's well: moves with the plate, pushed by the robot (once it is over the rim) and by inertia
      const p = c.plate;
      const cvx = p.vx - p.om * (c.y - p.y), cvy = p.vy + p.om * (c.x - p.x);
      const F = boxContact(c, rp, rv, cvx, cvy);
      if (F > 0) plateForce(p, F * c.nx, F * c.ny, c.cpx, c.cpy);
      const fx = F * c.nx, fy = F * c.ny, ix = -m * p.ax, iy = -m * p.ay;
      const [edge, sign, ratio] = tipRatios(c, fx * ca + fy * sa, -fx * sa + fy * ca, ix * ca + iy * sa, -ix * sa + iy * ca);
      if (ratio > 1) startTip(c, edge, sign, hypot(fx + ix, fy + iy));
      return;
    }
    const b = c.body;
    if (!c.resting) { const tr = b.translation(); c.x = tr.x; c.y = tr.y; c.angle = b.rotation(); }
    let cvx = 0, cvy = 0;
    if (!c.resting) { const v = b.linvel(), w = b.angvel(); cvx = v.x - w * (c.cpy - c.y); cvy = v.y + w * (c.cpx - c.x); }
    const F = boxContact(c, rp, rv, cvx, cvy);
    const nx = c.nx, ny = c.ny, px = c.cpx, py = c.cpy;
    if (c.resting) {
      // total push on the stuck cake: robot bumper + anything Rapier presses into it (pushed icons)
      const [ix, iy] = rapierPushOn(c, h);
      const fx = F * nx + ix, fy = F * ny + iy, f = hypot(fx, fy);
      const [edge, sign, ratio] = tipRatios(c, fx * ca + fy * sa, -fx * sa + fy * ca, 0, 0);
      const slide = f / (MESS.CAKE_MU_STATIC * mg);
      if (ratio > 1 && ratio >= slide) startTip(c, edge, sign, f);
      else if (slide > 1) { c.resting = false; c.restCount = 0; b.setBodyType(RAPIER.RigidBodyType.Dynamic, true); emit('cakeSlide', { id: c.id, force: f }); }
      return;
    }
    // sliding: bumper force + kinetic floor friction (force and spin), stick again when slow
    b.resetForces(true); b.resetTorques(true);
    if (F > 0) { tmpF.x = F * nx; tmpF.y = F * ny; tmpP.x = px; tmpP.y = py; b.addForceAtPoint(tmpF, tmpP, true); }
    const v = b.linvel(), sp = hypot(v.x, v.y), om = b.angvel();
    const hl = MESS.CAKE_LEN / 2, hw = MESS.CAKE_WIDTH / 2;
    if (sp > 1e-5) {
      const f = Math.min(MESS.CAKE_MU_KINETIC * mg, m * sp / h);
      tmpF.x = -f * v.x / sp; tmpF.y = -f * v.y / sp; b.addForce(tmpF, true);
    }
    if (Math.abs(om) > 1e-5) {
      const I = m * (hl * hl + hw * hw) / 3;
      const tq = Math.min(MESS.CAKE_MU_KINETIC * mg * 0.35 * hypot(hl, hw), I * Math.abs(om) / h);
      b.addTorque(-Math.sign(om) * tq, true);
    }
    // tipping while sliding: moments about the leading edge incl. the inertial term,
    // F⊥ (h_c − h_cg) > m g (d/2 − μk h_cg); never true for a push below the centre of mass
    const fv = F * (-nx * sa + ny * ca), fu = F * (nx * ca + ny * sa);
    const hc = MESS.BUMPER_H, hg = MESS.CAKE_CG_H, mk = MESS.CAKE_MU_KINETIC;
    if (Math.abs(fv) * (hc - hg) > mg * (MESS.TIP_HALF_SIDE - mk * hg)) { c.resting = true; startTip(c, 'long', Math.sign(fv), F); return; }
    const hu = fu > 0 ? MESS.TIP_HALF_TIP : MESS.TIP_HALF_BACK;
    if (Math.abs(fu) * (hc - hg) > mg * (hu - mk * hg)) { c.resting = true; startTip(c, 'short', Math.sign(fu), F); return; }
    if (sp < MESS.CAKE_REST_SPEED && Math.abs(om) < MESS.CAKE_REST_OMEGA && F < MESS.CAKE_MU_STATIC * mg) {
      if (++c.restCount >= 3) {
        c.resting = true; b.setLinvel({ x: 0, y: 0 }, false); b.setAngvel(0, false);
        b.setBodyType(RAPIER.RigidBodyType.Fixed, false);
      }
    } else c.restCount = 0;
  }

  // ── per-substep: tipping ────────────────────────────────────────────────────────────────────────────────
  function tippingSubstep(c, h, rp, rv) {
    const d = c.dFace, phi = c.phi, hc = MESS.BUMPER_H;
    // rear face position along tipDir relative to the pivot edge, push lever, and dx/dφ
    let xr, lever, dxr;
    const cornerH = d * Math.sin(phi);
    if (cornerH > hc) { xr = -d * Math.cos(phi); lever = cornerH; dxr = d * Math.sin(phi); }
    else {
      const cs = Math.cos(phi), sec = 1 / cs;
      xr = hc * Math.tan(phi) - d * sec; lever = hc; dxr = hc * sec * sec - d * sec * Math.tan(phi);
    }
    const p = c.plate;
    const ox = rp.x - c.pvx, oy = rp.y - c.pvy;
    const s = ox * c.tx + oy * c.ty, lat = ox * c.ex + oy * c.ey;
    const over = Math.abs(lat) - c.edgeLen / 2;
    let F = 0, phiStop = Math.PI / 2;
    if (over < R) {
      const reach = over > 0 ? Math.sqrt(R * R - over * over) : R;
      // the robot is either behind the slice (pushing its rear face) or where its top is falling (a stop)
      const pen = s < xr ? s + reach - xr : 0;
      if (s > 0) phiStop = Math.asin(clamp((s - reach) / MESS.CAKE_HEIGHT, 0, 1));
      if (pen > 0) {
        const pivotV = p ? p.vx * c.tx + p.vy * c.ty : 0;
        const vn = rv.x * c.tx + rv.y * c.ty - pivotV - dxr * c.phid;
        F = Math.max(0, MESS.BUMPER_K * pen * (1 + MESS.BUMPER_HC * vn));
        const px = rp.x + c.tx * reach, py = rp.y + c.ty * reach;
        c.cpx = px; c.cpy = py;
        tmpF.x = -F * c.tx; tmpF.y = -F * c.ty; tmpP.x = px; tmpP.y = py;
        rb.addForceAtPoint(tmpF, tmpP, true);
        if (p) plateForce(p, F * c.tx, F * c.ty, c.pvx, c.pvy);
      }
    }
    c.F = F; c.nx = c.tx; c.ny = c.ty;
    const m = MESS.CAKE_MASS, hg = MESS.CAKE_CG_H, Ht = MESS.CAKE_HEIGHT, half = c.half;
    const r = hypot(half, hg), phi0 = Math.atan2(half, hg);
    const I = m * (4 * half * half + Ht * Ht) / 3;
    // on a plate the pivot accelerates with it: inertial pseudo-force −m·a at the centre of mass
    const fi = p ? -m * (p.ax * c.tx + p.ay * c.ty) : 0;
    const tau = m * G * r * Math.sin(phi - phi0) + F * lever + fi * r * Math.cos(phi - phi0) - MESS.TIP_PIVOT_DAMP * c.phid;
    c.phid += (tau / I) * h;
    c.phi += c.phid * h;
    if (c.phi > phiStop && phiStop < Math.PI / 2) { c.phi = phiStop; c.phid = Math.min(0, c.phid); }  // leaning on the robot
    if (c.phi <= 0 && c.phid <= 0) {
      // rocked back onto its base
      c.phi = 0; c.phid = 0; c.phase = 'standing';
      if (!p) addBody(c); else capture(c);
      emit('cakeRockBack', { id: c.id });
      return;
    }
    if (c.phi >= Math.PI / 2) {
      c.phi = Math.PI / 2;
      if (!c.landed) {
        c.landed = true;
        emit('cakeLand', { id: c.id, speed: c.phid * Ht });
        const cx = c.pvx + c.tx * Ht / 2, cy = c.pvy + c.ty * Ht / 2;
        stamp('splat', cx, cy, c.tipDir, MESS.LAND_SPLAT_W, MESS.LAND_SPLAT_AMOUNT, 0);
        gridAdd(cx, cy, MESS.LAND_SPLAT_AMOUNT * 0.02, 4);
      }
      // bounce only when it falls freely; with the robot still pressing on it, it has landed
      if (c.phid > MESS.TIP_SETTLE_RATE && F === 0) c.phid = -MESS.TIP_RESTITUTION * c.phid;
      else toLying(c);
    }
  }

  // ── per-substep: robot underside on plates and soft cake (3-DOF vertical model) ──────────────────────────
  const V = { z: 0, zd: 0, p: 0, pd: 0, r: 0, rd: 0, engaged: false, NL: null, NR: null, NC: 0, cakeLoad: 0, plateLoad: 0,
    hL: 0, hR: 0, hC: 0, onL: false, onR: false, bellyOnCake: false };
  const MAXC = 64 * NCELL;
  const cxR = new Float64Array(MAXC), cyR = new Float64Array(MAXC), crR = new Float64Array(MAXC), cB = new Float64Array(MAXC);
  const cwx = new Float64Array(MAXC), cwy = new Float64Array(MAXC), cF = new Float64Array(MAXC);
  const cIdx = new Int32Array(MAXC), cK = new Float64Array(MAXC), cU = new Float64Array(MAXC), cS = new Float64Array(MAXC);
  const cCake = new Array(MAXC);
  const MAXP = 8 * UP.n;
  const qI = new Int32Array(MAXP), qH = new Float64Array(MAXP), qF = new Float64Array(MAXP), qwx = new Float64Array(MAXP), qwy = new Float64Array(MAXP);
  const qPlate = new Array(MAXP);
  const muBase = [1, 1];             // per-frame μ multipliers (smear film, micro-slips), L R
  const microT = [0, 0];

  function verticalSubstep(h, rp, th, rv, om) {
    const fx = Math.cos(th), fy = Math.sin(th), rx = -fy, ry = fx;
    // wheels and caster: ground under the tyre's curve
    const wLx = rp.x - rx * WB, wLy = rp.y - ry * WB, wRx = rp.x + rx * WB, wRy = rp.y + ry * WB;
    const caX = rp.x + fx * CX, caY = rp.y + fy * CX;
    contour(wLx, wLy, fx, fy, MESS.WHEEL_R); const hL = gOut.h, gLx = gOut.gx, gLy = gOut.gy, sL = gOut.src, kLx = gOut.cx, kLy = gOut.cy;
    contour(wRx, wRy, fx, fy, MESS.WHEEL_R); const hR = gOut.h, gRx = gOut.gx, gRy = gOut.gy, sR = gOut.src, kRx = gOut.cx, kRy = gOut.cy;
    contour(caX, caY, fx, fy, MESS.CASTER_R); const hC = gOut.h, gCx = gOut.gx, gCy = gOut.gy, sC = gOut.src, kCx = gOut.cx, kCy = gOut.cy;
    // lying cake cells under the body
    let n = 0;
    for (const c of cakes) {
      if (!c.grid) continue;
      const ext = 0.5 * hypot(c.Lu * c.sU, c.Lv * c.sV);
      if (hypot(rp.x - c.cx, rp.y - c.cy) > R + ext) continue;
      const du = cellW(c), dv = cellH(c), A = du * dv;
      for (let j = 0; j < NV; j++) {
        const v = (j + 0.5 - NV / 2) * dv;
        for (let i = 0; i < NU; i++) {
          const u = (i + 0.5 - NU / 2) * du;
          const wx = c.cx + c.ux * u + c.vx * v, wy = c.cy + c.uy * u + c.vy * v;
          const ddx = wx - rp.x, ddy = wy - rp.y;
          const x = ddx * fx + ddy * fy, y = ddx * rx + ddy * ry;
          const r2 = x * x + y * y;
          if (r2 >= R * R) continue;
          if (x * x + (y + WB) * (y + WB) < MESS.WHEEL_WELL_R ** 2 || x * x + (y - WB) * (y - WB) < MESS.WHEEL_WELL_R ** 2) continue;
          if ((x - CX) * (x - CX) + y * y < MESS.CASTER_WELL_R ** 2) continue;
          if (n >= MAXC) break;
          const k = j * NU + i;
          cxR[n] = x; cyR[n] = y; crR[n] = Math.sqrt(r2); cwx[n] = wx; cwy[n] = wy; cIdx[n] = k; cCake[n] = c;
          cB[n] = c.plate ? plateAt(c.plate, wx, wy) : 0;
          cK[n] = MESS.CAKE_E * A / Math.max(c.grid[k], 0.01);
          const us = underside(crR[n]); cU[n] = us[0]; cS[n] = us[1];
          n++;
        }
      }
    }
    // plate surface under the underside sample points
    let np = 0;
    for (const p of plates) {
      if (hypot(rp.x - p.x, rp.y - p.y) > R + MESS.PLATE_R) continue;
      for (let k = 0; k < UP.n && np < MAXP; k++) {
        const wx = rp.x + fx * UP.x[k] + rx * UP.y[k], wy = rp.y + fy * UP.x[k] + ry * UP.y[k];
        const hp = plateAt(p, wx, wy);
        if (hp <= 0) continue;
        qI[np] = k; qH[np] = hp; qwx[np] = wx; qwy[np] = wy; qPlate[np] = p; np++;
      }
    }
    const near = n > 0 || np > 0 || hL > 0 || hR > 0 || hC > 0;
    if (!near && V.engaged) {
      const quiet = Math.abs(V.z) < MESS.SETTLE_EPS && Math.abs(V.p) < 0.003 && Math.abs(V.r) < 0.003 &&
        Math.abs(V.zd) < 0.01 && Math.abs(V.pd) < 0.05 && Math.abs(V.rd) < 0.05;
      if (quiet) V.engaged = false;
    } else if (near) V.engaged = true;
    if (!V.engaged) {
      V.z = V.zd = V.p = V.pd = V.r = V.rd = 0; V.NL = V.NR = null; V.cakeLoad = 0; V.plateLoad = 0; V.plateRide = 0;
      V.hL = V.hR = V.hC = 0; V.onL = V.onR = false; V.bellyOnCake = false;
      drive.loadL = null; drive.loadR = null; drive.muL = muBase[0]; drive.muR = muBase[1];
      return;
    }
    V.hL = hL; V.hR = hR; V.hC = hC;
    // integrate heave / pitch / roll.  body plane: z(x, y) = z + x·p + y·r  (x fwd, y right)
    const hv = h / MESS.VERT_ITERS;
    let NL = 0, NR = 0, NC = 0;
    for (let it = 0; it < MESS.VERT_ITERS; it++) {
      let Qz = -MG, Qp = -MG * MESS.CG_X, Qr = 0;
      // wheels: spring-loaded, bump stop at e = 0, hanging beyond WHEEL_TRAVEL
      for (let s = 0; s < 2; s++) {
        const y = s === 0 ? -WB : WB, hw = s === 0 ? hL : hR;
        const e = V.z + y * V.r - hw, ed = V.zd + y * V.rd;
        let f = 0;
        if (e < 0) f = MESS.WHEEL_SPRING_AT_STOP - MESS.K_STOP * e - MESS.C_STOP * ed;
        else if (e < MESS.WHEEL_TRAVEL) f = MESS.WHEEL_SPRING_AT_STOP - (MESS.WHEEL_SPRING_AT_STOP - MESS.WHEEL_SPRING_AT_DROP) * e / MESS.WHEEL_TRAVEL - MESS.WHEEL_DAMP * ed;
        f = Math.max(0, f);
        if (s === 0) NL = f; else NR = f;
        Qz += f; Qr += f * y;
      }
      // caster
      {
        const e = V.z + CX * V.p - hC, ed = V.zd + CX * V.pd;
        NC = e < 0 ? Math.max(0, -MESS.K_STOP * e - MESS.C_STOP * ed) : 0;
        Qz += NC; Qp += NC * CX;
      }
      // rim against the floor (only matters at big tilts)
      for (let q = 0; q < 4; q++) {
        const x = q === 0 ? R : q === 1 ? -R : 0, y = q === 2 ? R : q === 3 ? -R : 0;
        const e = V.z + x * V.p + y * V.r + MESS.CHAMFER_H;
        if (e < 0) {
          const f = Math.max(0, -MESS.K_STOP * e - MESS.C_STOP * (V.zd + x * V.pd + y * V.rd));
          Qz += f; Qp += f * x; Qr += f * y;
        }
      }
      // cake cells against the underside
      for (let q = 0; q < n; q++) {
        const x = cxR[q], y = cyR[q];
        const pen = cB[q] + cCake[q].grid[cIdx[q]] - (V.z + x * V.p + y * V.r + cU[q]);
        let f = 0;
        if (pen > 0) f = Math.max(0, cK[q] * pen - MESS.CELL_DAMP * (V.zd + x * V.pd + y * V.rd));
        cF[q] = f;
        Qz += f; Qp += f * x; Qr += f * y;
      }
      // plate (rigid ceramic) against the underside
      for (let q = 0; q < np; q++) {
        const k = qI[q], x = UP.x[k], y = UP.y[k];
        const pen = qH[q] - (V.z + x * V.p + y * V.r + UP.u[k]);
        let f = 0;
        if (pen > 0) f = Math.max(0, MESS.PLATE_K_PT * pen - MESS.PLATE_C_PT * (V.zd + x * V.pd + y * V.rd));
        qF[q] = f;
        Qz += f; Qp += f * x; Qr += f * y;
      }
      V.zd += Qz / M * hv; V.pd += Qp / MESS.I_PITCH * hv; V.rd += Qr / MESS.I_ROLL * hv;
      V.z += V.zd * hv; V.p += V.pd * hv; V.r += V.rd * hv;
    }
    V.NL = NL; V.NR = NR; V.NC = NC;
    V.onL = sL !== null && hL > 0.002; V.onR = sR !== null && hR > 0.002;
    // horizontal forces. Contact parts (underside slopes, inclines) are not capped; friction parts are capped
    // so they never reverse the motion within a substep. Reactions go to the cake / plate that was touched.
    for (const c of cakes) if (c.cellF) { c.cellF.fill(0); c.Nload = 0; c.Fx = 0; c.Fy = 0; c.FfX = 0; c.FfY = 0; }
    for (const p of plates) { p.FfX = 0; p.FfY = 0; p.TfZ = 0; }
    let Fcx = 0, Fcy = 0, Tc = 0, Ffx = 0, Ffy = 0, Tf = 0, cakeLoad = 0, plateLoad = 0, plateRide = 0, belly = 0;
    const react = (src, fxv, fyv, wx, wy, isFric) => {   // force (fxv, fyv) acted on the ROBOT; reaction on src
      if (!src) return;
      if (src.cellF) {                                    // a lying cake
        if (src.plate) { if (isFric) { src.plate.FfX -= fxv; src.plate.FfY -= fyv; src.plate.TfZ -= (wx - src.plate.x) * fyv - (wy - src.plate.y) * fxv; } else plateForce(src.plate, -fxv, -fyv, wx, wy); }
        else if (isFric) { src.FfX -= fxv; src.FfY -= fyv; } else { src.Fx -= fxv; src.Fy -= fyv; }
      } else if (isFric) { src.FfX -= fxv; src.FfY -= fyv; src.TfZ -= (wx - src.x) * fyv - (wy - src.y) * fxv; }
      else { plateForce(src, -fxv, -fyv, wx, wy); src.hitF += hypot(fxv, fyv); }
    };
    const load = (src, N) => {
      if (!src) return;
      if (src.cellF) { src.Nload += N; cakeLoad += N; if (src.plate) src.plate.Nrobot += N; }
      else { src.Nrobot += N; plateLoad += N; }
    };
    // cake cells: plastic flow, chamfer / bumper slope, belly friction
    for (let q = 0; q < n; q++) {
      const f = cF[q];
      if (f <= 0) continue;
      const c = cCake[q], k = cIdx[q];
      const A = cellW(c) * cellH(c);
      const slope = cS[q];
      const sigma = f * Math.sqrt(1 + slope * slope) / A;   // contact pressure (normal to the underside)
      const sy = c.phase === 'crushed' ? MESS.MUSH_YIELD : MESS.CAKE_YIELD;
      if (sigma > sy) c.grid[k] = Math.max(MESS.CAKE_H_MIN, c.grid[k] - (sigma - sy) / MESS.CAKE_VISC * h);
      c.cellF[k] += f; load(c, f); belly += f;
      if (slope > 0) {
        const ux = (cwx[q] - rp.x) / crR[q], uy = (cwy[q] - rp.y) / crR[q];
        const hx = -f * slope * ux, hy = -f * slope * uy;
        Fcx += hx; Fcy += hy; react(c, hx, hy, cwx[q], cwy[q], false);
      }
      const ox = cwx[q] - rp.x, oy = cwy[q] - rp.y;
      const svx = c.plate ? c.plate.vx - c.plate.om * (cwy[q] - c.plate.y) : c.vX;
      const svy = c.plate ? c.plate.vy + c.plate.om * (cwx[q] - c.plate.x) : c.vY;
      const pvx = rv.x - om * oy - svx, pvy = rv.y + om * ox - svy, ps = hypot(pvx, pvy);
      if (ps > 1e-4) {
        const fr = MESS.MU_BELLY * f, ax = -fr * pvx / ps, ay = -fr * pvy / ps;
        Ffx += ax; Ffy += ay; Tf += ox * ay - oy * ax; react(c, ax, ay, cwx[q], cwy[q], true);
      }
    }
    V.bellyOnCake = belly > 0.5;
    // plate samples: chamfer slope pushes the plate, glaze friction drags / spins it
    for (let q = 0; q < np; q++) {
      const f = qF[q];
      if (f <= 0) continue;
      const k = qI[q], p = qPlate[q];
      load(p, f);
      if (UP.r[k] <= MESS.FLAT_R) plateRide += f;
      const slope = UP.s[k];
      if (slope > 0) {
        const ux = (qwx[q] - rp.x) / UP.r[k], uy = (qwy[q] - rp.y) / UP.r[k];
        const hx = -f * slope * ux, hy = -f * slope * uy;
        Fcx += hx; Fcy += hy; react(p, hx, hy, qwx[q], qwy[q], false);
      }
      const ox = qwx[q] - rp.x, oy = qwy[q] - rp.y;
      const pvx = rv.x - om * oy - (p.vx - p.om * (qwy[q] - p.y)), pvy = rv.y + om * ox - (p.vy + p.om * (qwx[q] - p.x)), ps = hypot(pvx, pvy);
      if (ps > 1e-4) {
        const fr = MESS.PLATE_MU_GLAZE * f, ax = -fr * pvx / ps, ay = -fr * pvy / ps;
        Ffx += ax; Ffy += ay; Tf += ox * ay - oy * ax; react(p, ax, ay, qwx[q], qwy[q], true);
      }
    }
    // tyres and caster on cake or plate: incline forces, soft rolling resistance, traction reaction, ruts
    const pts = [[kLx, kLy, NL, gLx, gLy, sL, hL, 0], [kRx, kRy, NR, gRx, gRy, sR, hR, 1], [kCx, kCy, NC, gCx, gCy, sC, hC, 2]];
    for (const [px, py, N, gx, gy, src, hh, idx] of pts) {   // (px, py) = where the tyre / caster presses
      if (!src || hh <= 0 || N <= 0) continue;
      load(src, N);
      if (!src.cellF) plateRide += N;
      const ox = px - rp.x, oy = py - rp.y;
      const ax = -N * gx, ay = -N * gy;
      Fcx += ax; Fcy += ay; Tc += ox * ay - oy * ax; react(src, ax, ay, px, py, false);
      if (idx < 2) {
        // the tyre's drive force pushes the surface it stands on backwards
        const fl = (idx === 0 ? drive.fLongL : drive.fLongR) || 0;
        react(src, fl * fx, fl * fy, px, py, true);
      }
      if (!src.cellF) continue;
      const c = src;
      const sp = c.plate ? hypot(rv.x - c.plate.vx, rv.y - c.plate.vy) : hypot(rv.x - c.vX, rv.y - c.vY);
      if (sp > 1e-4 && idx < 2) {
        const rx2 = -MESS.C_RR_SOFT * N * (rv.x - (c.plate ? c.plate.vx : c.vX)) / sp, ry2 = -MESS.C_RR_SOFT * N * (rv.y - (c.plate ? c.plate.vy : c.vY)) / sp;
        Ffx += rx2; Ffy += ry2; Tf += ox * ry2 - oy * rx2; react(c, rx2, ry2, px, py, true);
      }
      const sigma = N / MESS.WHEEL_PATCH_AREA, sy = c.phase === 'crushed' ? MESS.MUSH_YIELD : MESS.CAKE_YIELD;
      if (sigma > sy) {
        const dh = (sigma - sy) / MESS.CAKE_VISC * h;
        cakeH(c, px, py, true);
        for (let k = 0; k < 4; k++) if (bi[k] >= 0) c.grid[bi[k]] = Math.max(MESS.CAKE_H_MIN, c.grid[bi[k]] - dh * bw[k]);
      }
    }
    V.cakeLoad = cakeLoad; V.plateLoad = plateLoad; V.plateRide = plateRide;
    const vs = hypot(rv.x, rv.y);
    const capF = M * Math.max(vs, 0.02) / h * 0.5, ff = hypot(Ffx, Ffy);
    const kf = ff > capF ? capF / ff : 1;
    const capT = IZ * Math.max(Math.abs(om), 0.1) / h * 0.5;
    if (Math.abs(Tf) > capT) Tf = Math.sign(Tf) * capT;
    // friction reactions scaled by the same factor (action = reaction)
    for (const c of cakes) if (c.cellF) { c.Fx += kf * c.FfX; c.Fy += kf * c.FfY; }
    for (const p of plates) { p.Fx += kf * p.FfX; p.Fy += kf * p.FfY; p.Tq += kf * p.TfZ; }
    tmpF.x = Fcx + kf * Ffx; tmpF.y = Fcy + kf * Ffy;
    if (tmpF.x !== 0 || tmpF.y !== 0) rb.addForce(tmpF, true);
    if (Tc + Tf !== 0) rb.addTorque(Tc + Tf, true);
    // drive: wheel loads from the suspension, μ from frosting / glaze / smear / micro-slips
    drive.loadL = NL; drive.loadR = NR;
    const muOn = (src, hh) => !src || hh <= 0.002 ? 1 : src.cellF ? MESS.MU_FROSTING : MESS.PLATE_MU_TYRE;
    drive.muL = muBase[0] * muOn(sL, hL);
    drive.muR = muBase[1] * muOn(sR, hR);
  }

  // lying slice on the bare desk sliding under the reaction of the robot's horizontal forces
  function lyingSlideSubstep(c, h) {
    if (c.phase !== 'lying' || c.plate) { c.vX = 0; c.vY = 0; return; }
    const m = MESS.CAKE_MASS;
    const N = m * G + c.Nload;
    const f = hypot(c.Fx, c.Fy);
    if (!c.sliding) {
      if (f > MESS.LYING_MU_STATIC * N) c.sliding = true;
      else { c.vX = 0; c.vY = 0; return; }
    }
    const sp = hypot(c.vX, c.vY);
    let ax = c.Fx / m, ay = c.Fy / m;
    const fr = MESS.LYING_MU_KINETIC * N / m;
    if (sp > 1e-5) { const k = Math.min(fr, sp / h); ax -= k * c.vX / sp; ay -= k * c.vY / sp; }
    c.vX += ax * h; c.vY += ay * h;
    const ns = hypot(c.vX, c.vY);
    if (ns < MESS.CAKE_REST_SPEED && f < MESS.LYING_MU_STATIC * N) { c.vX = 0; c.vY = 0; c.sliding = false; return; }
    const ext = 0.5 * Math.max(c.Lu * c.sU, c.Lv * c.sV);
    c.cx = clamp(c.cx + c.vX * h, ext, W - ext); c.cy = clamp(c.cy + c.vY * h, ext, H - ext);
    // the dragged cut face leaves a chocolate streak
    c.dragAcc = (c.dragAcc || 0) + ns * h;
    if (c.dragAcc >= MESS.DRAG_STREAK_SPACING) {
      const a = Math.min(0.6, 0.25 + 0.35 * c.frosting);
      stamp('splat', c.cx, c.cy, Math.atan2(c.vY, c.vX), MESS.DRAG_STREAK_W, a, c.dragAcc);
      gridAdd(c.cx, c.cy, 0.01 * a, 4);
      c.frosting = Math.max(0, c.frosting - 0.002);
      c.dragAcc = 0;
    }
  }

  // plate on the desk: applied pushes + Coulomb foot friction (stick-slip), Rapier does the collisions
  function plateSubstep(p, h) {
    const b = p.body, mTot = MESS.PLATE_MASS + p.extraMass;
    const N = mTot * G + p.Nrobot;
    const fe = hypot(p.Fx, p.Fy);
    b.resetForces(true); b.resetTorques(true);
    const sp = hypot(p.vx, p.vy);
    if (p.stuck) {
      // static: only a push beating μs·N, or a Rapier collision that already set it moving, breaks it loose
      if (fe > MESS.PLATE_MU_STATIC * N || sp > MESS.PLATE_REST_SPEED * 2 || Math.abs(p.om) > MESS.PLATE_REST_OMEGA * 2) p.stuck = false;
      else { if (sp > 0 || p.om !== 0) { b.setLinvel({ x: 0, y: 0 }, true); b.setAngvel(0, true); } return; }
    }
    // a contact can only push or drag, never throw: neither the stiff penalty springs between the robot's underside
    // and the rim nor belly friction can give the plate more speed than the robot has, plus the restitution
    // bounce. (Explicit integration of ~30 kN/m on a 0.45 kg plate injected energy: plates left a ram at 2× the
    // robot's speed.) Applies only while the robot is touching the plate.
    {
      const bt = b.translation(), rt = rb.translation();
      if (hypot(bt.x - rt.x, bt.y - rt.y) < R + MESS.PLATE_R + 0.006) {
        const pv = b.linvel(), rv = rb.linvel();
        const vmax = hypot(rv.x, rv.y) * (1 + MESS.PLATE_RESTITUTION) + 0.01;
        let vx = pv.x, vy = pv.y, v0 = hypot(vx, vy);
        if (v0 > vmax) { vx *= vmax / v0; vy *= vmax / v0; b.setLinvel({ x: vx, y: vy }, true); p.vx = vx; p.vy = vy; }
        // limit this substep's contact force so it cannot carry the plate past vmax either
        const nvx = vx + p.Fx / mTot * h, nvy = vy + p.Fy / mTot * h, nv = hypot(nvx, nvy);
        if (nv > vmax) { const k = vmax / nv; p.Fx = (nvx * k - vx) * mTot / h; p.Fy = (nvy * k - vy) * mTot / h; }
      }
    }
    tmpF.x = p.Fx; tmpF.y = p.Fy; b.addForce(tmpF, true); b.addTorque(p.Tq, true);
    if (sp > 1e-6) {
      const f = Math.min(MESS.PLATE_MU_KINETIC * N, mTot * sp / h);
      tmpF.x = -f * p.vx / sp; tmpF.y = -f * p.vy / sp; b.addForce(tmpF, true);
    }
    if (Math.abs(p.om) > 1e-6) {
      const I = 0.5 * mTot * MESS.PLATE_R * MESS.PLATE_R;
      b.addTorque(-Math.sign(p.om) * Math.min(MESS.PLATE_MU_KINETIC * N * MESS.PLATE_FOOT_R, I * Math.abs(p.om) / h), true);
    }
    // never re-freeze while the robot is pressing on it: freezing a pushed plate makes the robot sink into a
    // fixed body, and the contact solver then shoots the plate out at several times the robot's speed
    // (stick-slip chatter). Real ceramic under a steady push just slides.
    const bt = b.translation(), rt = rb.translation();
    const touching = hypot(bt.x - rt.x, bt.y - rt.y) < R + MESS.PLATE_R + 0.006;
    if (!touching && sp < MESS.PLATE_REST_SPEED && Math.abs(p.om) < MESS.PLATE_REST_OMEGA && fe < MESS.PLATE_MU_STATIC * N) {
      p.stuck = true; b.setLinvel({ x: 0, y: 0 }, true); b.setAngvel(0, true);
    }
  }

  function substep(h) {
    const t = rb.translation(), th = rb.rotation(), v = rb.linvel(), om = rb.angvel();
    const rp = { x: t.x, y: t.y };
    for (const p of plates) syncPlate(p, h);
    for (const c of cakes) syncCake(c);
    for (const c of cakes) {
      if (c.phase === 'standing') standingSubstep(c, h, rp, v);
      else if (c.phase === 'tipping') tippingSubstep(c, h, rp, v);
      else c.F = 0;
    }
    verticalSubstep(h, rp, th, v, om);
    for (const c of cakes) if (c.grid) lyingSlideSubstep(c, h);
    for (const p of plates) plateSubstep(p, h);
  }

  // ── per-frame ─────────────────────────────────────────────────────────────────────────────────────────
  const carriers = [
    { who: 1, load: 0, px: NaN, py: NaN, sx: 0, sy: 0, acc: 0, accS: 0, kind: 'wheelL' },
    { who: 2, load: 0, px: NaN, py: NaN, sx: 0, sy: 0, acc: 0, accS: 0, kind: 'wheelR' },
    { who: 3, load: 0, px: NaN, py: NaN, sx: 0, sy: 0, acc: 0, accS: 0, kind: 'brush' },
  ];
  let wasLoaded = false, climbT = -1e9, onCakePrev = false, bumpT = -1e9, onPlatePrev = false;

  function beginFrame(t) { tNow = t; }

  /** inject the standing/tipping slice contact into the bumper (call right after phys.advance) */
  function injectBumper() {
    const b = phys.bumper;
    const tr = rb.translation(), th = rb.rotation();
    const fx = Math.cos(th), fy = Math.sin(th), rx = -fy, ry = fx;
    let changed = false;
    for (const c of cakes) {
      if (c.phase !== 'standing' && c.phase !== 'tipping') { c.touching = false; continue; }
      c.touching = c.F > MESS.CONTACT_MIN_F;
      if (!c.touching) continue;
      const dx = c.cpx - tr.x, dy = c.cpy - tr.y;
      const along = dx * fx + dy * fy, lat = dx * rx + dy * ry;
      const front = along > -0.01;
      b.contacts.push({ x: c.cpx, y: c.cpy, nx: c.nx, ny: c.ny, force: c.F, front, side: lat >= 0 ? 'right' : 'left',
        bearing: Math.atan2(lat, along), kind: 'cake', id: c.id });
      if (front) { if (lat >= 0) b.forceR += c.F; else b.forceL += c.F; changed = true; }
    }
    if (changed) {
      b.right = b.forceR >= PHYS.BUMP_FORCE_THRESHOLD;
      b.left = b.forceL >= PHYS.BUMP_FORCE_THRESHOLD;
    }
  }

  function afterAdvance(dt, t, motors) {
    tNow = t;
    for (const p of plates) readPlatePose(p);   // pose for state / paint (velocity history untouched)
    for (const c of cakes) syncCake(c);
    injectBumper();
    // contact events
    for (const c of cakes) {
      if (c.touching && !c.wasTouching && t - c.lastHitT > MESS.HIT_DEBOUNCE) { emit('cakeHit', { id: c.id, force: c.F, phase: c.phase }); c.lastHitT = t; }
      c.wasTouching = c.touching;
    }
    for (const p of plates) {
      p.touching = p.lastHitF > MESS.CONTACT_MIN_F;
      if (p.touching && !p.wasTouching && t - p.lastHitT > MESS.HIT_DEBOUNCE) { emit('plateHit', { id: p.id, force: p.lastHitF }); p.lastHitT = t; }
      p.wasTouching = p.touching;
    }
    // riding over a plate rim
    const onPlate = V.engaged && V.plateRide > MESS.PLATE_BUMP_FRACTION * MG;
    if (onPlate && !onPlatePrev && t - bumpT > MESS.PLATE_BUMP_DEBOUNCE) {
      bumpT = t;
      emit('plateBump', { lift: Math.max(0, V.z), pitch: Math.atan(V.p) });
    }
    onPlatePrev = onPlate;
    // squash, crush, spread
    for (const c of cakes) {
      if (!c.grid) continue;
      let s = 0; for (let i = 0; i < NCELL; i++) s += c.grid[i];
      const mean = s / NCELL;
      c.squash = Math.max(c.squash, clamp((c.h0mean - mean) / (c.h0mean - MESS.CRUSHED_MEAN_H), 0, 1));
      c.sU = 1 + (MESS.CRUSHED_SIZE / c.Lu - 1) * c.squash;
      c.sV = 1 + (MESS.CRUSHED_SIZE / c.Lv - 1) * c.squash;
      if (c.phase === 'lying' && c.squash >= MESS.CRUSH_AT) {
        c.phase = 'crushed'; c.vX = 0; c.vY = 0; c.sliding = false;
        emit('cakeCrush', { id: c.id, x: c.cx * S, y: c.cy * S, onPlate: c.plate ? c.plate.id : null });
        stamp('splat', c.cx, c.cy, c.tipDir, MESS.SPLAT_W, 1, 0);
        for (let k = 0; k < 9; k++) gridAdd(c.cx + ((k % 3) - 1) * GC * 0.8, c.cy + (Math.floor(k / 3) - 1) * GC * 0.8, 0.03, 4);
      }
    }
    // climbing onto cake
    const onCake = V.engaged && V.cakeLoad > MESS.CLIMB_FRACTION * MG;
    if (onCake && !onCakePrev && t - climbT > MESS.CLIMB_DEBOUNCE) {
      climbT = t;
      const c = cakes.find((q) => q.grid && q.Nload > 0) || cakes[cakes.length - 1];
      emit('cakeClimb', { id: c ? c.id : null, load: V.cakeLoad / MG });
    }
    onCakePrev = onCake;

    paint(dt, motors);

    // per-frame μ: smear film under each tyre, random micro-slips while in frosting
    const tr = rb.translation(), th = rb.rotation();
    const rx = -Math.sin(th), ry = Math.cos(th);
    for (let s = 0; s < 2; s++) {
      const sg = s === 0 ? -1 : 1;
      const wx = tr.x + rx * WB * sg, wy = tr.y + ry * WB * sg;
      const film = Math.min(1, gridThick(wx, wy));
      const inFrosting = (s === 0 ? V.onL : V.onR) || film > 0.3;
      if (microT[s] > 0) microT[s] -= dt;
      else if (inFrosting && rng.chance(MESS.MICROSLIP_RATE * dt)) {
        microT[s] = rng.range(MESS.MICROSLIP_MIN, MESS.MICROSLIP_MAX);
        if (V.engaged) { V.zd += rng.range(-1, 1) * MESS.JOLT_V; V.pd += rng.range(-1, 1) * MESS.JOLT_W; V.rd += rng.range(-1, 1) * MESS.JOLT_W; }
      }
      muBase[s] = (1 - MESS.SMEAR_SLIP * film) * (microT[s] > 0 ? MESS.MICROSLIP_MU : 1);
    }
    if (!V.engaged) { drive.muL = muBase[0]; drive.muR = muBase[1]; }
  }

  // frosting pick-up, deposition, re-pick, fling
  function paint(dt, motors) {
    const tr = rb.translation(), th = rb.rotation();
    const fx = Math.cos(th), fy = Math.sin(th), rx = -fy, ry = fx;
    const lift = Math.max(0, V.z);
    for (let s = 0; s < 3; s++) {
      const cr = carriers[s];
      let px, py, surf, contactN;
      if (s < 2) {
        const sg = s === 0 ? -1 : 1;
        px = tr.x + rx * WB * sg; py = tr.y + ry * WB * sg;
        surf = Math.abs(s === 0 ? drive.wheelL : drive.wheelR) * dt;   // tyre surface travel (incl. slip)
        const N = s === 0 ? V.NL : V.NR;
        contactN = N === null ? 1 : N;                                  // null = nominal floor contact
      } else {
        px = tr.x + fx * MESS.BRUSH_FWD; py = tr.y + fy * MESS.BRUSH_FWD;
        surf = 0;
        contactN = lift < MESS.BRUSH_LIFT_OFF ? 1 : 0;
      }
      if (Number.isNaN(cr.px)) { cr.px = px; cr.py = py; cr.sx = px; cr.sy = py; continue; }
      const ds = hypot(px - cr.px, py - cr.py);
      cr.px = px; cr.py = py;
      const travel = s < 2 ? Math.max(ds, surf) : ds * (0.5 + 0.5 * motors.brush);
      if (travel <= 0) continue;
      // pick up frosting from the cake under this carrier
      groundAt(px, py);
      const c = hit.src && hit.src.cellF ? hit.src : null;
      const onCake = c && (s === 2 || contactN > 0.5);
      if (onCake) {
        const avail = MESS.FROSTING_MIN_AVAIL + (1 - MESS.FROSTING_MIN_AVAIL) * c.frosting;
        const rate = s < 2 ? MESS.PICK_WHEEL : MESS.PICK_BRUSH * (0.4 + 0.6 * motors.brush);
        const a = Math.min(1 - cr.load, rate * travel * avail * (1 - cr.load));
        if (a > 0) { cr.load += a; c.frosting = Math.max(0, c.frosting - a * MESS.FROSTING_PER_LOAD); }
        cr.sx = px; cr.sy = py; cr.acc = 0; cr.accS = 0;
        continue;   // on the cake: paint goes back onto cake, not the desk
      }
      if (contactN <= 0.5) { cr.sx = px; cr.sy = py; cr.acc = 0; cr.accS = 0; continue; } // in the air: keeps its paint
      // re-pick older smear from the desk
      const gi = gridIndex(px, py);
      if (gi >= 0 && grid[gi] > 0 && (gridWho[gi] !== cr.who || tNow - gridT[gi] > MESS.REPICK_SELF_T)) {
        const width = s < 2 ? MESS.TYRE_W : MESS.BRUSH_W;
        const frac = Math.min(1, travel * width / (GC * GC)) * (s < 2 ? MESS.REPICK_WHEEL : MESS.REPICK_BRUSH);
        const mass = grid[gi] / massToThick * frac;
        const take = Math.min(mass, 1 - cr.load);
        if (take > 0) { cr.load += take; grid[gi] -= take * massToThick; }
      }
      if (cr.load < 1e-4) { cr.sx = px; cr.sy = py; cr.acc = 0; cr.accS = 0; continue; }
      // deposit
      const dep = cr.load * (1 - Math.exp(-travel / MESS.LOAD_DECAY_M));
      cr.load -= dep;
      if (s < 2) gridAdd(px, py, dep, cr.who);
      else for (let k = -2; k <= 2; k++) gridAdd(px + rx * k * MESS.BRUSH_W / 5, py + ry * k * MESS.BRUSH_W / 5, dep / 5, cr.who);
      cr.acc += ds; cr.accS += travel;
      const spacing = s < 2 ? MESS.STAMP_SPACING : MESS.BRUSH_STAMP_SPACING;
      if (cr.accS >= spacing) {
        const len = hypot(px - cr.sx, py - cr.sy);
        const ang = len > 1e-4 ? Math.atan2(py - cr.sy, px - cr.sx) : th;
        const w = s < 2 ? MESS.TYRE_W : MESS.BRUSH_W;
        const thick = s < 2
          ? MESS.INK_WHEEL * cr.load * Math.min(3, cr.accS / Math.max(cr.acc, 0.3 * MESS.TYRE_W))
          : MESS.INK_BRUSH * cr.load;
        stamp(cr.kind, (px + cr.sx) / 2, (py + cr.sy) / 2, ang, w, thick, len);
        cr.sx = px; cr.sy = py; cr.acc = 0; cr.accS = 0;
      }
    }
    // side brush fling (droplets thrown tangentially off the bristle tips)
    const bl = carriers[2];
    if (bl.load > 0.01 && motors.sideBrush > 0.1 && lift < MESS.BRUSH_LIFT_OFF && rng.chance(Math.min(1, MESS.FLING_RATE * bl.load * motors.sideBrush * dt))) {
      const ax = tr.x + fx * DUST.SIDE_BRUSH_FWD_M + rx * DUST.SIDE_BRUSH_RIGHT_M;
      const ay = tr.y + fy * DUST.SIDE_BRUSH_FWD_M + ry * DUST.SIDE_BRUSH_RIGHT_M;
      const a = rng.range(0, Math.PI * 2);
      const ex = Math.cos(a), ey = Math.sin(a);
      const tipX = ax + ex * DUST.SIDE_BRUSH_R_M, tipY = ay + ey * DUST.SIDE_BRUSH_R_M;
      const tx = ey, ty = -ex;                   // same spin sense as dust.js
      const dist = rng.range(MESS.FLING_MIN, MESS.FLING_MAX);
      const lx = tipX + (tx + rng.range(-0.3, 0.3)) * dist, ly = tipY + (ty + rng.range(-0.3, 0.3)) * dist;
      if (lx > 0 && ly > 0 && lx < W && ly < H) {
        const amt = bl.load * rng.range(0.4, 0.9);
        const dm = bl.load * MESS.FLING_COST;
        bl.load -= dm;
        stamp('fling', lx, ly, Math.atan2(ty, tx), rng.range(0.007, 0.018), amt, 0);
        gridAdd(lx, ly, dm, 4);
      }
    }
    const maxLoad = Math.max(carriers[0].load, carriers[1].load, carriers[2].load);
    if (maxLoad >= MESS.SMEAR_ARM) wasLoaded = true;
    else if (wasLoaded && maxLoad < MESS.SMEAR_OUT) { wasLoaded = false; emit('smearOut', {}); }
  }

  // ── public ──────────────────────────────────────────────────────────────────────────────────────────────
  function cakeState(c) {
    let floorX = c.x, floorY = c.y;
    if (c.phase === 'tipping') {
      const sp = Math.sin(c.phi), cp = Math.cos(c.phi);
      const off = (MESS.CAKE_HEIGHT * sp - 2 * c.half * cp) / 2;
      floorX = c.pvx + c.tx * off; floorY = c.pvy + c.ty * off;
    } else if (c.grid) { floorX = c.cx; floorY = c.cy; }
    const base = c.plate ? plateAt(c.plate, floorX, floorY) : 0;
    const out = {
      id: c.id, x: c.x * S, y: c.y * S, angle: c.angle, phase: c.phase,
      tip: clamp(c.phi / (Math.PI / 2), 0, 1), tipDir: c.tipDir, squash: c.squash, frosting: c.frosting,
      floorX: floorX * S, floorY: floorY * S,
      pivotX: (c.phase === 'standing' ? c.x : c.pvx) * S, pivotY: (c.phase === 'standing' ? c.y : c.pvy) * S,
      edge: c.edge,
      onPlate: c.plate ? c.plate.id : null,
      baseZ: base * S,                            // px: height of what it stands / lies on (plate surface or 0)
    };
    if (c.grid) {
      out.footprint = { x: c.cx * S, y: c.cy * S, angle: Math.atan2(c.uy, c.ux), w: c.Lu * c.sU * S, h: c.Lv * c.sV * S };
      let mx = 0; for (let i = 0; i < NCELL; i++) mx = Math.max(mx, c.grid[i]);
      out.height = mx * S;
    }
    return out;
  }
  return {
    substep(h) {
      substep(h);
      // plate contact force: keep this frame's peak for the 'plateHit' event
      for (const p of plates) p.lastHitF = Math.max(p.lastHitF || 0, p.hitF);
    },
    beginFrame(t) { beginFrame(t); for (const p of plates) p.lastHitF = 0; },
    afterAdvance,
    placeCake(xPx, yPx, angle, opts) {
      const a = Number.isFinite(angle) ? angle : rng.range(0, Math.PI * 2);
      return placeCake(xPx / S, yPx / S, a, !(opts && opts.plate === false)).id;
    },
    /** clear all smear and robot load; put the plate and cake back to their configured pose */
    reset(withCake = true) {
      grid.fill(0); gridT.fill(0); gridWho.fill(0); smear = [];
      for (const cr of carriers) { cr.load = 0; cr.px = NaN; }
      wasLoaded = false;
      while (cakes.length) removeCake(cakes[0]);
      while (plates.length) removePlate(plates[0]);
      if (withCake && initialCake) placeCake(initialCake.x, initialCake.y, initialCake.angle, initialCake.withPlate);
      V.engaged = false; V.z = V.zd = V.p = V.pd = V.r = V.rd = 0;
      drive.loadL = drive.loadR = null; drive.muL = drive.muR = 1;
    },
    drainSmear() { const out = smear; smear = []; return out; },
    smearGrid,
    cakeState() { const c = cakes[cakes.length - 1]; return c ? cakeState(c) : null; },
    cakesState() { return cakes.map(cakeState); },
    platesState() {
      return plates.map((p) => ({ id: p.id, x: p.x * S, y: p.y * S, angle: p.angle, cakeId: p.cakeId,
        vx: p.vx * S, vy: p.vy * S, omega: p.om, r: MESS.PLATE_R * S }));
    },
    robotState() {
      const L = carriers[0].load, Rr = carriers[1].load, Bb = carriers[2].load;
      return {
        pitch: Math.atan(V.p), roll: Math.atan(V.r), lift: Math.max(0, V.z),
        load: Math.max(L, Rr, Bb), loadL: L, loadR: Rr, loadBrush: Bb,
        wheelLoadL: V.NL, wheelLoadR: V.NR, onCake: V.engaged && V.cakeLoad > MESS.CLIMB_FRACTION * MG,
        onPlate: V.engaged && V.plateRide > MESS.PLATE_BUMP_FRACTION * MG,
      };
    },
    debug: { cakes, plates, V, carriers, grid },
  };
}
