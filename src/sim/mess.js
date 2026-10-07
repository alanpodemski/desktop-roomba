// mess.js — "the cake incident". A slice of chocolate layer cake as a physical object, the robot riding
// over it on a suspension model, frosting moving onto its tyres and brush, and printed back onto the
// desk as smear stamps. See SPEC-mess.md.
//
// Internal units are SI (m, s, kg, N, rad). State and stamps go out in CSS px like the rest of the API.
//
// ── Standing ──────────────────────────────────────────────────────────────────────────────────────
// Rapier box 0.13 × 0.07 m, 0.35 kg. It collides with icons, walls and the page edge and the robot's
// IR sees it. Its contact with the robot is a compliant bumper spring computed here, not by Rapier,
// so the push force F and its direction are known exactly every substep. Stick-slip floor: at rest
// the cake is a fixed body. Per substep the push (cake frame: F_u along the axis, F_v across) is tested:
//     tip over a long edge    |F_v| · h_c > m g · W/2
//     tip over a short edge   |F_u| · h_c > m g · L/2
//     break loose and slide   |F|         > μs · m g
// All three are linear in F, so which one is crossed first depends only on the push direction:
// pushed sideways (within ≈ ±37° of the normal) it tips; pushed along its axis it slides.
// While sliding (μk) it can tip only if F⊥ (h_c − h_cg) > m g (d/2 − μk h_cg), which is never true
// for a push below the centre of mass (the textbook result for pushing a box low down).
// ── Tipping ───────────────────────────────────────────────────────────────────────────────────────
// Rigid body pivoting about the far bottom edge:
//     I_edge φ'' = m g r sin(φ − φ0) + F(φ) · y(φ) − c φ'
//     I_edge = m (d² + H²)/3,   r = √((d/2)² + h_cg²),   φ0 = atan((d/2)/h_cg) ≈ 32°
// The robot keeps pushing the rear face through the bumper spring: lever y = h_c, or the height of
// the rear bottom corner once that rises above h_c. It must carry the slice past φ0 before gravity
// takes over. If it backs off too early the slice rocks back onto its base. It lands at 90° with a
// small bounce.
// ── Lying / crushed ───────────────────────────────────────────────────────────────────────────────
// The slice lies on a cut face: footprint 0.13 × 0.11 m, thickness ramping from the tip (6 mm) to the
// back (0.07 m). It is a 10 × 8 height field of viscoplastic sponge: each cell pushes back elastically
// (E·A/h) and flows plastically above the yield stress, dh/dt = −(σ − σy)/η.
// The robot body is a 3-DOF rigid body (heave, pitch, roll) on two spring-suspended wheels (3 cm of
// travel), a caster, and its own underside: a flat belly at 8 mm clearance, a chamfer up to 3 cm at
// r = 0.16 m, and the bumper face up to 8.5 cm at the rim. Riding onto the slice lifts the body; the
// wheel springs extend and lose load, so traction (μ·N per wheel, μ × 0.3 in frosting) drops. The
// robot high-centres and slips (the stuck detector may fire) while its weight crushes the sponge
// until the wheels bear again. squash = lost mean thickness; ≥ 0.9 -> crushed.
// The underside's slope turns cell forces into horizontal forces (the chamfer climbs, the bumper
// face ploughs). Their reaction pushes the slice, which slides on the desk only if that exceeds
// μs · (m g + the load pressing it down). A robot ramming the thick side shoves it; one meeting the
// thin side, or pinning it with its weight, rides up.
// ── Paint ─────────────────────────────────────────────────────────────────────────────────────────
// Three carriers: left tyre, right tyre, main brush. Contact with cake moves frosting onto the carrier
// in proportion to surface travel, so spinning tyres load up fast. Every metre of travel in floor
// contact gives back 1 − e^(−ds/λ) of the load as stamps plus a coarse smear grid. Rolling over older
// smear re-picks a little. The side brush flings droplets tangentially.

import RAPIER from '@dimforge/rapier2d-compat';
import { PHYS, GRP } from './physics.js';
import { DUST } from './dust.js';
import { clamp, hypot } from './util.js';

export const MESS = {
  // --- standing cake ------------------------------------------------------------------------------
  CAKE_LEN: 0.13,            // m      tip -> back (footprint long side, along cake.angle)
  CAKE_WIDTH: 0.07,          // m      back width (footprint short side)
  CAKE_HEIGHT: 0.11,         // m      standing height
  CAKE_MASS: 0.35,           // kg
  CAKE_CG_H: 0.055,          // m      centre of mass height while standing
  CAKE_MU_KINETIC: 0.5,      // -      sliding floor friction
  CAKE_MU_STATIC: 1.1,       // -      breakaway friction (the sponge base sticks to the desk). Must lie between
                             //        W/(2 h_c) = 0.875 (sideways push tips first) and L/(2 h_c) = 1.625
                             //        (axial push slides first)
  CAKE_REST_SPEED: 0.01,     // m/s    a sliding cake below this (and REST_OMEGA) sticks again
  CAKE_REST_OMEGA: 0.05,     // rad/s
  BUMPER_H: 0.04,            // m      height of the robot's push resultant (h_c)
  BUMPER_K: 3000,            // N/m    bumper compliance for robot <-> standing/tipping cake contact
  BUMPER_HC: 1.5,            // s/m    Hunt–Crossley damping: F = K·pen·(1 + HC·closing speed), no jump at touch
  CONTACT_MIN_F: 0.3,        // N      contact force that counts as touching (events, bumper)
  CAKE_IR_REFLECTANCE: 0.004,// -      dark matte chocolate in near-IR: light-touch range × √ρ ≈ 1.6 cm, so it gets rammed
  HIT_DEBOUNCE: 0.5,         // s      min spacing of 'cakeHit' events
  // --- tipping ------------------------------------------------------------------------------------
  TIP_RESTITUTION: 0.2,      // -      bounce on landing (fraction of angular speed)
  TIP_SETTLE_RATE: 0.8,      // rad/s  landing slower than this settles into 'lying'
  TIP_PIVOT_DAMP: 0.0005,    // N·m·s  damping at the pivot edge (squashing sponge)
  // --- lying / crushed: viscoplastic height field ----------------------------------------------------
  GRID_NU: 10,               // cells  along the slice axis
  GRID_NV: 8,                // cells  across (along tipDir)
  CAKE_TIP_THICK: 0.006,     // m      thickness of the lying wedge at its tip
  SHORT_EDGE_THICK: 0.06,    // m      uniform thickness if it ever falls over a short edge
  CAKE_E: 60000,             // Pa     effective compressive modulus (sponge + ganache + frosting)
  CAKE_YIELD: 600,           // Pa     plastic yield stress of the intact slice
  MUSH_YIELD: 120,           // Pa     ...and of the crushed mush (squeezes out from under the robot)
  CAKE_VISC: 7e4,            // Pa·s/m flow resistance: dh/dt = (σ − σy)/η
  CELL_DAMP: 4,              // N·s/m  per-cell contact damping
  CAKE_H_MIN: 0.003,         // m      a crushed cell cannot get thinner than this
  CRUSHED_SIZE: 0.24,        // m      footprint the crushed blob spreads to (squash 0 -> 1); volume conservation:
                             //        ≈5e-4 m³ of slice at CRUSHED_MEAN_H 1.2 cm covers Ø ≈ 0.23 m, so mush reaches both tyres
  CRUSHED_MEAN_H: 0.012,     // m      mean thickness that counts as squash = 1
  CRUSH_AT: 0.9,             // -      squash that makes it 'crushed'
  LYING_MU_STATIC: 4.0,      // -      lying slice: wet ganache cut face adheres to the desk (× normal load
                             //        incl. robot weight on it): ≈14 N to shove it unloaded, never while ridden
  LYING_MU_KINETIC: 1.5,     // -      dragging it smears (leaves a streak)
  DRAG_STREAK_W: 0.06,       // m      streak stamp width while a lying slice is dragged
  DRAG_STREAK_SPACING: 0.01, // m
  // --- robot underside and suspension (3-DOF heave/pitch/roll) ----------------------------------------
  CLEARANCE: 0.008,          // m      flat belly height above the floor at rest
  FLAT_R: 0.13,              // m      radius of the flat belly
  CHAMFER_R: 0.16,           // m      chamfer rises from FLAT_R to here...
  CHAMFER_H: 0.03,           // m      ...up to this height
  BUMPER_TOP: 0.085,         // m      bumper face rises from CHAMFER_R to the rim (R) up to this height
  CG_X: -0.018,              // m      centre of mass behind the wheel axle (gives the 85/15 wheel/caster split)
  WHEEL_TRAVEL: 0.03,        // m      wheel drop travel; beyond it the wheel hangs in the air
  WHEEL_SPRING_AT_STOP: 12,  // N      suspension spring force at the bump stop (falls to 0 at full drop)
  WHEEL_DAMP: 20,            // N·s/m
  K_STOP: 20000,             // N/m    wheel bump stop / caster / rim against the floor
  C_STOP: 150,               // N·s/m
  I_PITCH: 0.026,            // kg·m²  body pitch inertia (disc about a diameter)
  I_ROLL: 0.026,             // kg·m²
  VERT_ITERS: 2,             // -      vertical sub-iterations per physics substep (stiff cells)
  WHEEL_WELL_R: 0.03,        // m      cells this close to a wheel are under the tyre, not the belly
  CASTER_WELL_R: 0.025,      // m
  WHEEL_PATCH_AREA: 6.6e-4,  // m²     tyre contact patch (crushes ruts into the cake)
  SETTLE_EPS: 5e-4,          // m      vertical model switches off once flat and settled
  // --- traction and resistance ----------------------------------------------------------------------
  MU_FROSTING: 0.3,          // -      tyre μ multiplier on cake / frosting
  SMEAR_SLIP: 0.35,          // -      μ loss on a thick smear film (× min(1, thickness))
  MU_BELLY: 0.4,             // -      belly / chamfer sliding over frosting
  C_RR_SOFT: 0.12,           // -      extra rolling resistance of a tyre sinking into cake (× its load)
  MAX_SLOPE: 1.5,            // -      cap on height-field gradient used for slope forces
  MICROSLIP_RATE: 4,         // 1/s    random grip losses per wheel while in frosting
  MICROSLIP_MU: 0.15,        // -      μ multiplier during a micro-slip
  MICROSLIP_MIN: 0.05, MICROSLIP_MAX: 0.15, // s
  JOLT_V: 0.04,              // m/s    heave kick of a micro-slip jolt
  JOLT_W: 0.25,              // rad/s  pitch/roll kick
  // --- frosting transfer --------------------------------------------------------------------------------
  PICK_WHEEL: 4,             // load/m tyre surface travel on cake -> tyre load
  PICK_BRUSH: 4,             // load/m brush travel over cake -> brush load (the roller grinds into it)
  FROSTING_PER_LOAD: 0.12,   // -      cake frosting used per unit of load picked up
  FROSTING_MIN_AVAIL: 0.25,  // -      pick-up efficiency left when the cake's frosting is used up
  // --- smear deposition -----------------------------------------------------------------------------
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
  // --- events -----------------------------------------------------------------------------------------
  CLIMB_FRACTION: 0.15,      // -      share of robot weight carried by cake that counts as a climb
  CLIMB_DEBOUNCE: 2,         // s
  MAX_OLD_CAKES: 6,          // -      crushed blobs kept when new cakes are placed
};

const NU = MESS.GRID_NU, NV = MESS.GRID_NV, NCELL = NU * NV;

export function createMess({ phys, S, widthPx, heightPx, rng, events, cake: cakeCfg }) {
  const world = phys.world, rb = phys.robotBody, drive = phys.drive;
  const W = widthPx / S, H = heightPx / S;
  const R = PHYS.ROBOT_RADIUS, WB = PHYS.WHEEL_HALF_BASE, CX = PHYS.CASTER_OFFSET;
  const M = PHYS.ROBOT_MASS, G = PHYS.GRAVITY, MG = M * G;
  const IZ = 0.5 * M * R * R;
  let tNow = 0;

  // ── smear grid + stamp buffer ────────────────────────────────────────────────────────────────────
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

  // ── cakes ────────────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  const cakes = [];         // every cake on the floor; the last one is "the" cake
  let initialCake = null;   // config pose (px) for resetMess()

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
  function makeCake(x, y, angle) {
    const c = {
      id: `cake${++seq}`, phase: 'standing', x, y, angle,
      tipDir: angle + Math.PI / 2, phi: 0, phid: 0, squash: 0, frosting: 1,
      body: null, collider: null, resting: true, restCount: 0,
      // robot contact (standing / tipping), last substep
      F: 0, nx: 0, ny: 0, cpx: 0, cpy: 0, touching: false, wasTouching: false, peak: 0, lastHitT: -1e9,
      // tipping
      pvx: 0, pvy: 0, tx: 0, ty: 0, ex: 0, ey: 0, d: 0, edgeLen: 0, edge: 'long', landed: false,
      // lying
      grid: null, cellF: null, cx: 0, cy: 0, ux: 1, uy: 0, vx: 0, vy: 1, Lu: 0, Lv: 0, sU: 1, sV: 1,
      h0mean: 0, vX: 0, vY: 0, sliding: false, Fx: 0, Fy: 0, Nload: 0,
    };
    addBody(c);
    return c;
  }
  function placeCake(x, y, angle) {
    const cur = cakes[cakes.length - 1];
    if (cur && cur.phase !== 'crushed') { removeBody(cur); cakes.pop(); }
    const c = makeCake(x, y, angle);
    cakes.push(c);
    while (cakes.length > MESS.MAX_OLD_CAKES + 1) { removeBody(cakes[0]); cakes.shift(); }
    return c;
  }
  if (cakeCfg !== false) {
    // default: wedge axis roughly up/down the page, so a robot coming out of its dock (left edge, heading +x)
    // meets a long side and tips it; ±20° of jitter from the seed. Pushed end-on it would just slide.
    const a = cakeCfg && Number.isFinite(cakeCfg.angle) ? cakeCfg.angle
      : (rng.range(0, 1) < 0.5 ? -1 : 1) * Math.PI / 2 + rng.range(-0.35, 0.35);
    const x = cakeCfg && Number.isFinite(cakeCfg.x) ? cakeCfg.x / S : W / 2;
    const y = cakeCfg && Number.isFinite(cakeCfg.y) ? cakeCfg.y / S : H / 2;
    initialCake = { x, y, angle: a };
    placeCake(x, y, a);
  }

  // ── height field helpers (lying / crushed) ─────────────────────────────────────────────────────────
  function cellW(c) { return (c.Lu * c.sU) / NU; }
  function cellH(c) { return (c.Lv * c.sV) / NV; }
  /** bilinear thickness of cake c at world point (0 outside, ramps over half a cell at the edges) */
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
  /** ground height at a world point over all lying cakes, with gradient; fills gOut */
  const gOut = { h: 0, gx: 0, gy: 0, cake: null };
  function ground(wx, wy) {
    gOut.h = 0; gOut.gx = 0; gOut.gy = 0; gOut.cake = null;
    for (const c of cakes) {
      if (!c.grid) continue;
      const h = cakeH(c, wx, wy, false);
      if (h > gOut.h) {
        const e = 0.004;
        gOut.h = h; gOut.cake = c;
        gOut.gx = clamp((cakeH(c, wx + e, wy) - cakeH(c, wx - e, wy)) / (2 * e), -MESS.MAX_SLOPE, MESS.MAX_SLOPE);
        gOut.gy = clamp((cakeH(c, wx, wy + e) - cakeH(c, wx, wy - e)) / (2 * e), -MESS.MAX_SLOPE, MESS.MAX_SLOPE);
      }
    }
    return gOut;
  }
  /** underside height above the body reference plane at radius r, and its radial slope */
  function underside(r) {
    if (r <= MESS.FLAT_R) return [MESS.CLEARANCE, 0];
    if (r <= MESS.CHAMFER_R) {
      const k = (MESS.CHAMFER_H - MESS.CLEARANCE) / (MESS.CHAMFER_R - MESS.FLAT_R);
      return [MESS.CLEARANCE + (r - MESS.FLAT_R) * k, k];
    }
    const k = (MESS.BUMPER_TOP - MESS.CHAMFER_H) / (R - MESS.CHAMFER_R);
    return [MESS.CHAMFER_H + (r - MESS.CHAMFER_R) * k, k];
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
  }

  // ── per-substep: standing cake ─────────────────────────────────────────────────────────────────────
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
  function startTip(c, edge, sign, F) {
    const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
    if (edge === 'long') { c.tx = -sa * sign; c.ty = ca * sign; c.d = MESS.CAKE_WIDTH; c.edgeLen = MESS.CAKE_LEN; }
    else { c.tx = ca * sign; c.ty = sa * sign; c.d = MESS.CAKE_LEN; c.edgeLen = MESS.CAKE_WIDTH; }
    c.edge = edge;
    c.ex = -c.ty; c.ey = c.tx;
    c.pvx = c.x + c.tx * c.d / 2; c.pvy = c.y + c.ty * c.d / 2;
    c.tipDir = Math.atan2(c.ty, c.tx);
    c.phi = 0; c.phid = 0; c.landed = false;
    removeBody(c);
    c.phase = 'tipping';
    emit('cakeTip', { id: c.id, tipDir: c.tipDir, force: F, edge });
  }
  function standingSubstep(c, h, rp, rv) {
    const b = c.body;
    if (!c.resting) { const tr = b.translation(); c.x = tr.x; c.y = tr.y; c.angle = b.rotation(); }
    const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
    const hl = MESS.CAKE_LEN / 2, hw = MESS.CAKE_WIDTH / 2;
    const dx = rp.x - c.x, dy = rp.y - c.y;
    const lu = dx * ca + dy * sa, lv = -dx * sa + dy * ca;
    const qu = clamp(lu, -hl, hl), qv = clamp(lv, -hw, hw);
    let eu = lu - qu, ev = lv - qv, dist = hypot(eu, ev), pen;
    if (dist < 1e-6) { eu = lu; ev = lv; dist = Math.max(1e-6, hypot(lu, lv)); pen = R; } // centre inside: push out
    else pen = R - dist;
    // contact normal from the robot into the cake (world), contact point on the cake
    const nlu = -eu / dist, nlv = -ev / dist;
    const nx = nlu * ca - nlv * sa, ny = nlu * sa + nlv * ca;
    const px = c.x + qu * ca - qv * sa, py = c.y + qu * sa + qv * ca;
    let F = 0;
    if (pen > 0) {
      let cvx = 0, cvy = 0;
      if (!c.resting) { const v = b.linvel(), w = b.angvel(); cvx = v.x - w * (py - c.y); cvy = v.y + w * (px - c.x); }
      const vn = (rv.x - cvx) * nx + (rv.y - cvy) * ny;
      F = Math.max(0, MESS.BUMPER_K * pen * (1 + MESS.BUMPER_HC * vn));
    }
    c.F = F; c.nx = nx; c.ny = ny; c.cpx = px; c.cpy = py;
    if (F > 0) {
      tmpF.x = -F * nx; tmpF.y = -F * ny; tmpP.x = px; tmpP.y = py;
      rb.addForceAtPoint(tmpF, tmpP, true);
    }
    const m = MESS.CAKE_MASS, mg = m * G;
    if (c.resting) {
      // total push on the stuck cake: robot bumper + anything Rapier presses into it (pushed icons)
      const [ix, iy] = rapierPushOn(c, h);
      const fx = F * nx + ix, fy = F * ny + iy;
      const fu = fx * ca + fy * sa, fv = -fx * sa + fy * ca, f = hypot(fx, fy);
      const tipV = Math.abs(fv) * MESS.BUMPER_H / (mg * hw);
      const tipU = Math.abs(fu) * MESS.BUMPER_H / (mg * hl);
      const slide = f / (MESS.CAKE_MU_STATIC * mg);
      const top = Math.max(tipV, tipU, slide);
      if (top > 1) {
        if (top === tipV) startTip(c, 'long', Math.sign(fv), f);
        else if (top === tipU) startTip(c, 'short', Math.sign(fu), f);
        else { c.resting = false; c.restCount = 0; b.setBodyType(RAPIER.RigidBodyType.Dynamic, true); emit('cakeSlide', { id: c.id, force: f }); }
      }
      return;
    }
    // sliding: bumper force + kinetic floor friction (force and spin), stick again when slow
    b.resetForces(true); b.resetTorques(true);
    if (F > 0) { tmpF.x = F * nx; tmpF.y = F * ny; tmpP.x = px; tmpP.y = py; b.addForceAtPoint(tmpF, tmpP, true); }
    const v = b.linvel(), sp = hypot(v.x, v.y), om = b.angvel();
    if (sp > 1e-5) {
      const f = Math.min(MESS.CAKE_MU_KINETIC * mg, m * sp / h);
      tmpF.x = -f * v.x / sp; tmpF.y = -f * v.y / sp; b.addForce(tmpF, true);
    }
    if (Math.abs(om) > 1e-5) {
      const I = m * (hl * hl + hw * hw) / 3;
      const tq = Math.min(MESS.CAKE_MU_KINETIC * mg * 0.35 * hypot(hl, hw), I * Math.abs(om) / h);
      b.addTorque(-Math.sign(om) * tq, true);
    }
    // tipping while sliding (moments about the leading edge, including the inertial term)
    const fv = F * (-nx * sa + ny * ca), fu = F * (nx * ca + ny * sa);
    const hc = MESS.BUMPER_H, hg = MESS.CAKE_CG_H, mk = MESS.CAKE_MU_KINETIC;
    if (Math.abs(fv) * (hc - hg) > mg * (hw - mk * hg)) { c.resting = true; startTip(c, 'long', Math.sign(fv), F); return; }
    if (Math.abs(fu) * (hc - hg) > mg * (hl - mk * hg)) { c.resting = true; startTip(c, 'short', Math.sign(fu), F); return; }
    if (sp < MESS.CAKE_REST_SPEED && Math.abs(om) < MESS.CAKE_REST_OMEGA && F < MESS.CAKE_MU_STATIC * mg) {
      if (++c.restCount >= 3) {
        c.resting = true; b.setLinvel({ x: 0, y: 0 }, false); b.setAngvel(0, false);
        b.setBodyType(RAPIER.RigidBodyType.Fixed, false);
      }
    } else c.restCount = 0;
  }

  // ── per-substep: tipping ───────────────────────────────────────────────────────────────────────────
  function tippingSubstep(c, h, rp, rv) {
    const d = c.d, phi = c.phi, hc = MESS.BUMPER_H;
    // rear face position along tipDir relative to the pivot edge, push lever, and dx/dφ
    let xr, lever, dxr;
    const cornerH = d * Math.sin(phi);
    if (cornerH > hc) { xr = -d * Math.cos(phi); lever = cornerH; dxr = d * Math.sin(phi); }
    else {
      const cs = Math.cos(phi), sec = 1 / cs;
      xr = hc * Math.tan(phi) - d * sec; lever = hc; dxr = hc * sec * sec - d * sec * Math.tan(phi);
    }
    const ox = rp.x - c.pvx, oy = rp.y - c.pvy;
    const s = ox * c.tx + oy * c.ty, lat = ox * c.ex + oy * c.ey;
    const over = Math.abs(lat) - c.edgeLen / 2;
    let F = 0;
    if (over < R) {
      const reach = over > 0 ? Math.sqrt(R * R - over * over) : R;
      const pen = s + reach - xr;
      if (pen > 0) {
        const vn = rv.x * c.tx + rv.y * c.ty - dxr * c.phid;
        F = Math.max(0, MESS.BUMPER_K * pen * (1 + MESS.BUMPER_HC * vn));
        const px = rp.x + c.tx * reach, py = rp.y + c.ty * reach;
        c.cpx = px; c.cpy = py;
        tmpF.x = -F * c.tx; tmpF.y = -F * c.ty; tmpP.x = px; tmpP.y = py;
        rb.addForceAtPoint(tmpF, tmpP, true);
      }
    }
    c.F = F; c.nx = c.tx; c.ny = c.ty;
    const m = MESS.CAKE_MASS, hg = MESS.CAKE_CG_H, Ht = MESS.CAKE_HEIGHT;
    const r = hypot(d / 2, hg), phi0 = Math.atan2(d / 2, hg);
    const I = m * (d * d + Ht * Ht) / 3;
    const tau = m * G * r * Math.sin(phi - phi0) + F * lever - MESS.TIP_PIVOT_DAMP * c.phid;
    c.phid += (tau / I) * h;
    c.phi += c.phid * h;
    if (c.phi <= 0 && c.phid <= 0) {
      // rocked back onto its base
      c.phi = 0; c.phid = 0; c.phase = 'standing';
      addBody(c);
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
      if (c.phid > MESS.TIP_SETTLE_RATE) c.phid = -MESS.TIP_RESTITUTION * c.phid;
      else toLying(c);
    }
  }

  // ── per-substep: robot on soft cake (3-DOF vertical model) ────────────────────────────────────────────
  const V = { z: 0, zd: 0, p: 0, pd: 0, r: 0, rd: 0, engaged: false, NL: null, NR: null, NC: 0, cakeLoad: 0,
    hL: 0, hR: 0, hC: 0, onL: false, onR: false, bellyOnCake: false };
  const MAXC = 64 * NCELL;
  const cxR = new Float32Array(MAXC), cyR = new Float32Array(MAXC), crR = new Float32Array(MAXC);
  const cwx = new Float32Array(MAXC), cwy = new Float32Array(MAXC), cF = new Float32Array(MAXC);
  const cIdx = new Int32Array(MAXC), cK = new Float64Array(MAXC), cU = new Float64Array(MAXC), cS = new Float64Array(MAXC);
  const cCake = new Array(MAXC);
  const muBase = [1, 1];             // per-frame μ multipliers (smear film, micro-slips), L R
  const microT = [0, 0];

  function verticalSubstep(h, rp, th, rv, om) {
    const fx = Math.cos(th), fy = Math.sin(th), rx = -fy, ry = fx;
    // wheels and caster ground (cake height + gradient)
    const wLx = rp.x - rx * WB, wLy = rp.y - ry * WB, wRx = rp.x + rx * WB, wRy = rp.y + ry * WB;
    const caX = rp.x + fx * CX, caY = rp.y + fy * CX;
    ground(wLx, wLy); const hL = gOut.h, gLx = gOut.gx, gLy = gOut.gy, cL = gOut.cake;
    ground(wRx, wRy); const hR = gOut.h, gRx = gOut.gx, gRy = gOut.gy, cR = gOut.cake;
    ground(caX, caY); const hC = gOut.h, gCx = gOut.gx, gCy = gOut.gy, cC = gOut.cake;
    // cake cells under the body
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
          cK[n] = MESS.CAKE_E * A / Math.max(c.grid[k], 0.01);
          const us = underside(crR[n]); cU[n] = us[0]; cS[n] = us[1];
          n++;
        }
      }
    }
    const near = n > 0 || hL > 0 || hR > 0 || hC > 0;
    if (!near && V.engaged) {
      const quiet = Math.abs(V.z) < MESS.SETTLE_EPS && Math.abs(V.p) < 0.003 && Math.abs(V.r) < 0.003 &&
        Math.abs(V.zd) < 0.01 && Math.abs(V.pd) < 0.05 && Math.abs(V.rd) < 0.05;
      if (quiet) V.engaged = false;
    } else if (near) V.engaged = true;
    if (!V.engaged) {
      V.z = V.zd = V.p = V.pd = V.r = V.rd = 0; V.NL = V.NR = null; V.cakeLoad = 0;
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
        else if (e < MESS.WHEEL_TRAVEL) f = MESS.WHEEL_SPRING_AT_STOP * (1 - e / MESS.WHEEL_TRAVEL) - MESS.WHEEL_DAMP * ed;
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
        const pen = cCake[q].grid[cIdx[q]] - (V.z + x * V.p + y * V.r + cU[q]);
        let f = 0;
        if (pen > 0) f = Math.max(0, cK[q] * pen - MESS.CELL_DAMP * (V.zd + x * V.pd + y * V.rd));
        cF[q] = f;
        Qz += f; Qp += f * x; Qr += f * y;
      }
      V.zd += Qz / M * hv; V.pd += Qp / MESS.I_PITCH * hv; V.rd += Qr / MESS.I_ROLL * hv;
      V.z += V.zd * hv; V.p += V.pd * hv; V.r += V.rd * hv;
    }
    V.NL = NL; V.NR = NR; V.NC = NC;
    V.onL = hL > 0.002; V.onR = hR > 0.002;
    // plastic flow of the cells under the body, and ruts under the tyres
    let cakeLoad = 0;
    for (const c of cakes) if (c.cellF) { c.cellF.fill(0); c.Nload = 0; c.Fx = 0; c.Fy = 0; }
    let Fhx = 0, Fhy = 0, Tq = 0, belly = 0;
    for (let q = 0; q < n; q++) {
      const f = cF[q];
      if (f <= 0) continue;
      const c = cCake[q], k = cIdx[q];
      const A = cellW(c) * cellH(c);
      const slope = cS[q];
      const sigma = f * Math.sqrt(1 + slope * slope) / A;   // contact pressure (normal to the underside)
      const sy = c.phase === 'crushed' ? MESS.MUSH_YIELD : MESS.CAKE_YIELD;
      if (sigma > sy) c.grid[k] = Math.max(MESS.CAKE_H_MIN, c.grid[k] - (sigma - sy) / MESS.CAKE_VISC * h);
      c.cellF[k] += f; c.Nload += f; cakeLoad += f; belly += f;
      // underside slope -> horizontal push on the robot toward its centre (chamfer climbs, bumper ploughs)
      if (slope > 0) {
        const ux = (cwx[q] - rp.x) / crR[q], uy = (cwy[q] - rp.y) / crR[q];
        const hx = -f * slope * ux, hy = -f * slope * uy;
        Fhx += hx; Fhy += hy; c.Fx -= hx; c.Fy -= hy;
      }
      // belly sliding over frosting
      const ox = cwx[q] - rp.x, oy = cwy[q] - rp.y;
      const pvx = rv.x - om * oy - c.vX, pvy = rv.y + om * ox - c.vY, ps = hypot(pvx, pvy);
      if (ps > 1e-4) {
        const fr = MESS.MU_BELLY * f;
        const ax = -fr * pvx / ps, ay = -fr * pvy / ps;
        Fhx += ax; Fhy += ay; Tq += ox * ay - oy * ax; c.Fx -= ax; c.Fy -= ay;
      }
    }
    V.bellyOnCake = belly > 0.5;
    // tyres and caster on cake: slope forces (normal force on an incline), soft rolling resistance, ruts
    const wheelPts = [[wLx, wLy, NL, gLx, gLy, cL, hL, 0], [wRx, wRy, NR, gRx, gRy, cR, hR, 1], [caX, caY, NC, gCx, gCy, cC, hC, 2]];
    for (const [px, py, N, gx, gy, c, hh, idx] of wheelPts) {
      if (!c || hh <= 0 || N <= 0) continue;
      cakeLoad += N; c.Nload += N;
      const ox = px - rp.x, oy = py - rp.y;
      let ax = -N * gx, ay = -N * gy;
      const pvx = rv.x - om * oy - c.vX, pvy = rv.y + om * ox - c.vY, ps = hypot(pvx, pvy);
      if (ps > 1e-4 && idx < 2) { ax -= MESS.C_RR_SOFT * N * pvx / ps; ay -= MESS.C_RR_SOFT * N * pvy / ps; }
      Fhx += ax; Fhy += ay; Tq += ox * ay - oy * ax; c.Fx -= ax; c.Fy -= ay;
      // tyre traction pushes the cake material backwards
      if (idx < 2) { const fl = idx === 0 ? drive.fLongL : drive.fLongR; c.Fx -= (fl || 0) * fx; c.Fy -= (fl || 0) * fy; }
      // tyre / caster pressure crushes ruts
      const sigma = N / MESS.WHEEL_PATCH_AREA, sy = c.phase === 'crushed' ? MESS.MUSH_YIELD : MESS.CAKE_YIELD;
      if (sigma > sy) {
        const dh = (sigma - sy) / MESS.CAKE_VISC * h;
        cakeH(c, px, py, true);
        for (let k = 0; k < 4; k++) if (bi[k] >= 0) c.grid[bi[k]] = Math.max(MESS.CAKE_H_MIN, c.grid[bi[k]] - dh * bw[k]);
      }
    }
    V.cakeLoad = cakeLoad;
    // horizontal forces on the robot, capped so friction never reverses the motion within a substep
    const vs = hypot(rv.x, rv.y);
    const capF = M * Math.max(vs, 0.02) / h * 0.5;
    const fh = hypot(Fhx, Fhy);
    if (fh > capF) {
      const k = capF / fh;
      Fhx *= k; Fhy *= k;
      for (const c of cakes) if (c.grid) { c.Fx *= k; c.Fy *= k; }   // keep action = reaction
    }
    const capT = IZ * Math.max(Math.abs(om), 0.1) / h * 0.5;
    if (Math.abs(Tq) > capT) Tq = Math.sign(Tq) * capT;
    if (fh > 0) { tmpF.x = Fhx; tmpF.y = Fhy; rb.addForce(tmpF, true); }
    if (Tq !== 0) rb.addTorque(Tq, true);
    // drive: wheel loads from the suspension, μ from frosting / smear / micro-slips
    drive.loadL = NL; drive.loadR = NR;
    drive.muL = muBase[0] * (V.onL ? MESS.MU_FROSTING : 1);
    drive.muR = muBase[1] * (V.onR ? MESS.MU_FROSTING : 1);
  }

  // lying slice sliding on the desk under the reaction of the robot's horizontal forces
  function lyingSlideSubstep(c, h) {
    if (c.phase !== 'lying') { c.vX = 0; c.vY = 0; return; }
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

  function substep(h) {
    const t = rb.translation(), th = rb.rotation(), v = rb.linvel(), om = rb.angvel();
    const rp = { x: t.x, y: t.y };
    for (const c of cakes) {
      if (c.phase === 'standing') standingSubstep(c, h, rp, v);
      else if (c.phase === 'tipping') tippingSubstep(c, h, rp, v);
      else { c.F = 0; }
    }
    verticalSubstep(h, rp, th, v, om);
    for (const c of cakes) if (c.grid) lyingSlideSubstep(c, h);
  }

  // ── per-frame ───────────────────────────────────────────────────────────────────────────────────────
  const carriers = [
    { who: 1, load: 0, px: NaN, py: NaN, sx: 0, sy: 0, acc: 0, accS: 0, kind: 'wheelL' },
    { who: 2, load: 0, px: NaN, py: NaN, sx: 0, sy: 0, acc: 0, accS: 0, kind: 'wheelR' },
    { who: 3, load: 0, px: NaN, py: NaN, sx: 0, sy: 0, acc: 0, accS: 0, kind: 'brush' },
  ];
  let wasLoaded = false, climbT = -1e9, onCakePrev = false;

  function beginFrame(t) { tNow = t; }

  /** inject the standing/tipping cake contact into the bumper (call right after phys.advance) */
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
    injectBumper();
    // contact events
    for (const c of cakes) {
      if (c.touching && !c.wasTouching && t - c.lastHitT > MESS.HIT_DEBOUNCE) { emit('cakeHit', { id: c.id, force: c.F, phase: c.phase }); c.lastHitT = t; }
      c.wasTouching = c.touching;
    }
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
        emit('cakeCrush', { id: c.id, x: c.cx * S, y: c.cy * S });
        stamp('splat', c.cx, c.cy, c.tipDir, MESS.SPLAT_W, 1, 0);
        for (let k = 0; k < 9; k++) gridAdd(c.cx + ((k % 3) - 1) * GC * 0.8, c.cy + (Math.floor(k / 3) - 1) * GC * 0.8, 0.03, 4);
      }
    }
    // climbing
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
      // pick up frosting from cake under this carrier
      const gnd = ground(px, py);
      const onCake = gnd.cake && gnd.h > 0.002 && (s === 2 || contactN > 0.5);
      if (onCake) {
        const c = gnd.cake;
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

  // ── public ─────────────────────────────────────────────────────────────────────────────────────────
  function cakeState(c) {
    let floorX = c.x, floorY = c.y;
    if (c.phase === 'tipping') {
      const sp = Math.sin(c.phi), cp = Math.cos(c.phi);
      const off = (MESS.CAKE_HEIGHT * sp - c.d * cp) / 2;
      floorX = c.pvx + c.tx * off; floorY = c.pvy + c.ty * off;
    } else if (c.grid) { floorX = c.cx; floorY = c.cy; }
    const out = {
      id: c.id, x: c.x * S, y: c.y * S, angle: c.angle, phase: c.phase,
      tip: clamp(c.phi / (Math.PI / 2), 0, 1), tipDir: c.tipDir, squash: c.squash, frosting: c.frosting,
      floorX: floorX * S, floorY: floorY * S,
      pivotX: (c.phase === 'standing' ? c.x : c.pvx) * S, pivotY: (c.phase === 'standing' ? c.y : c.pvy) * S,
      edge: c.edge,
    };
    if (c.grid) {
      out.footprint = { x: c.cx * S, y: c.cy * S, angle: Math.atan2(c.uy, c.ux), w: c.Lu * c.sU * S, h: c.Lv * c.sV * S };
      let mx = 0; for (let i = 0; i < NCELL; i++) mx = Math.max(mx, c.grid[i]);
      out.height = mx * S;
    }
    return out;
  }
  return {
    substep, beginFrame, afterAdvance,
    placeCake(xPx, yPx, angle) {
      const a = Number.isFinite(angle) ? angle : rng.range(0, Math.PI * 2);
      return placeCake(xPx / S, yPx / S, a).id;
    },
    /** clear all smear and robot load; reset the cake to its configured pose (or remove all if none) */
    reset(withCake = true) {
      grid.fill(0); gridT.fill(0); gridWho.fill(0); smear = [];
      for (const cr of carriers) { cr.load = 0; cr.px = NaN; }
      wasLoaded = false;
      for (const c of cakes) removeBody(c);
      cakes.length = 0;
      if (withCake && initialCake) placeCake(initialCake.x, initialCake.y, initialCake.angle);
      V.engaged = false; V.z = V.zd = V.p = V.pd = V.r = V.rd = 0;
      drive.loadL = drive.loadR = null; drive.muL = drive.muR = 1;
    },
    drainSmear() { const out = smear; smear = []; return out; },
    smearGrid,
    cakeState() { const c = cakes[cakes.length - 1]; return c ? cakeState(c) : null; },
    cakesState() { return cakes.map(cakeState); },
    robotState() {
      const L = carriers[0].load, Rr = carriers[1].load, Bb = carriers[2].load;
      return {
        pitch: Math.atan(V.p), roll: Math.atan(V.r), lift: Math.max(0, V.z),
        load: Math.max(L, Rr, Bb), loadL: L, loadR: Rr, loadBrush: Bb,
        wheelLoadL: V.NL, wheelLoadR: V.NR, onCake: V.engaged && V.cakeLoad > MESS.CLIMB_FRACTION * MG,
      };
    },
    debug: { cakes, V, carriers, grid },
  };
}
