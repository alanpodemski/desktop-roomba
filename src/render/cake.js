// cake.js — chocolate cake slices at their sim poses (state.cakes: every cake on the floor, incl. old
// crushed blobs; falls back to state.cake).
//
// Model (public/models/cake.glb): metres, +Y up, origin at the centre of the footprint on the floor, wedge
// axis along −Z (tip at (0,0,−0.065), back corners (±0.0336, 0, +0.0606), back arc apex (0,0,+0.065)).
// Meshes CakeSponge, CakeFilling, CakeFrosting, CakeTopping, CakeCrumbs, CakeSquashed (shown only once
// crushed). A procedural wedge stands in if the model is missing.
//
// Sim cake state (px, rad): { id, x, y, angle (back -> tip), phase, tip 0..1, tipDir, squash, frosting,
//   floorX/floorY (centre of what touches the floor), pivotX/pivotY (sim pivot edge midpoint), edge,
//   footprint { x, y, angle, w, h } once lying }.
//
// Tipping: the sim pivots a 0.13 × 0.07 box about its side edge. The real slice is a wedge whose side
// edges run tip → back corner (15° off the axis); rotating it about the box edge would leave its cut face
// tilted. So the slice rotates about its real side edge (it lands flat on the cut face, exactly like the
// sim's lying height field: 0.13 × 0.11, thin at the tip, 0.07 at the back) while a yaw and offset blend
// in with `tip` so the lying slice coincides with the sim's footprint.

import * as THREE from 'three';
import { getGLTFLoader, makeRadialTexture } from './robot.js';
import { PX_PER_M } from './scene.js';

const TIP_Z = 0.065, BACK_Z = 0.0606, BACK_X = 0.0336, HEIGHT = 0.11;
const BOX_HALF_W = 0.035;                           // sim box half-width (pivot offset for a long-edge tip)
const yawFor = (a) => -a - Math.PI / 2;             // local −Z → page angle a (same as the robot)

function proceduralCake() {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, TIP_Z); shape.lineTo(BACK_X, -BACK_Z); shape.lineTo(-BACK_X, -BACK_Z); shape.closePath();
  const layer = (y0, h, mat) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); geo.translate(0, y0, 0);
    return new THREE.Mesh(geo, mat);
  };
  const spongeMat = new THREE.MeshStandardMaterial({ color: 0x3a1f12, roughness: 0.9 });
  const fillMat = new THREE.MeshStandardMaterial({ color: 0x24110a, roughness: 0.25 });
  const sponge = new THREE.Group(); sponge.name = 'CakeSponge';
  const filling = new THREE.Group(); filling.name = 'CakeFilling';
  let y = 0;
  for (let i = 0; i < 3; i++) {
    sponge.add(layer(y, 0.026, spongeMat)); y += 0.026;
    if (i < 2) { filling.add(layer(y, 0.008, fillMat)); y += 0.008; }
  }
  const frost = layer(y, HEIGHT - y, new THREE.MeshStandardMaterial({ color: 0x1d0d06, roughness: 0.3 }));
  frost.name = 'CakeFrosting';
  g.add(sponge, filling, frost);
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.011, 16, 12), new THREE.MeshPhysicalMaterial({ color: 0x8a0a12, roughness: 0.15, clearcoat: 1 }));
  top.name = 'CakeTopping'; top.position.set(0, HEIGHT + 0.009, 0.02); g.add(top);
  const blob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 12), new THREE.MeshStandardMaterial({ color: 0x24110a, roughness: 0.35 }));
  blob.scale.set(1, 0.11, 0.85); blob.name = 'CakeSquashed'; g.add(blob);
  return g;
}

async function loadCakeModel() {
  try {
    const gltf = await getGLTFLoader().loadAsync('/models/cake.glb');
    return { scene: gltf.scene, real: true };
  } catch (err) {
    console.warn('[roomba] cake.glb not available, using a procedural slice:', err && err.message);
    return { scene: proceduralCake(), real: false };
  }
}

// scratch
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _M = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _ax = new THREE.Vector3(), _pv = new THREE.Vector3(), _Me = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
export const PLATE_SURFACE_Y = 0.006;   // m: the slice stands in the plate's well at this height (SPEC-plate)
/** M = T(p) · R · T(−p) · M  (rotation about an axis through world point p) */
function rotateAbout(M, p, q) {
  _m.makeTranslation(-p.x, -p.y, -p.z); M.premultiply(_m);
  _m.makeRotationFromQuaternion(q); M.premultiply(_m);
  _m.makeTranslation(p.x, p.y, p.z); M.premultiply(_m);
}

export async function createCakeRenderer(scene) {
  const { scene: proto, real } = await loadCakeModel();
  proto.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const shadowTex = makeRadialTexture(64, 0.35);

  function collectMats(obj) { const out = []; obj.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) out.push(m); }); return out; }

  function makeInstance() {
    const root = proto.clone(true);
    root.traverse((o) => {
      if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
    });
    // the exporter leaves CakeSquashed visible: detach it, it is shown on its own once crushed
    const squashed = root.getObjectByName('CakeSquashed');
    if (squashed) squashed.removeFromParent();
    // loose crumbs lie on the floor around the slice: they never tip or squash with it
    const crumbs = root.getObjectByName('CakeCrumbs');
    if (crumbs) crumbs.removeFromParent();
    const sliceMats = collectMats(root);

    const slice = new THREE.Group(); slice.matrixAutoUpdate = false; slice.add(root);
    const floorG = new THREE.Group(); if (crumbs) floorG.add(crumbs);
    const blobG = new THREE.Group(); if (squashed) { squashed.position.set(0, 0, 0); squashed.visible = true; blobG.add(squashed); }
    blobG.visible = false;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = -5;
    scene.add(slice, floorG, blobG, shadow);
    const sliceMeshes = []; slice.traverse((o) => { if (o.isMesh) sliceMeshes.push(o); });
    return { slice, floorG, blobG, shadow, sliceMats, sliceMeshes, blobMats: squashed ? collectMats(squashed) : [], crushFade: -1, appliedFade: -1, yOff: 0 };
  }
  function dispose(inst) { for (const o of [inst.slice, inst.floorG, inst.blobG, inst.shadow]) o.removeFromParent(); }
  /** crossfade slice -> squashed blob; touches materials only when the fade value changes */
  function applyFade(inst, f) {
    if (f === inst.appliedFade) return;
    const wasOpaque = inst.appliedFade <= 0.001, isOpaque = f <= 0.001;
    inst.appliedFade = f;
    const a = 1 - f;
    for (const m of inst.sliceMats) {
      const tr = a < 0.999; if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      m.opacity = a; m.depthWrite = a > 0.5;
    }
    inst.slice.visible = a > 0.001;
    for (const o of inst.sliceMeshes) o.castShadow = a > 0.5;
    for (const m of inst.blobMats) {
      const tr = f < 0.999; if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      m.opacity = f;
    }
    inst.blobG.visible = f > 0.001;
    void wasOpaque; void isOpaque;
  }

  /** world point (x, 0, z) for page px */
  const Wp = (px, py, out) => out.set(px / PX_PER_M, 0, py / PX_PER_M);

  function place(inst, c, dt) {
    const a = c.angle || 0;
    const A = { x: Math.cos(a), y: Math.sin(a) };             // axis back -> tip (page)
    const P = { x: -Math.sin(a), y: Math.cos(a) };            // model +X on the page
    const C = { x: c.x / PX_PER_M, y: c.y / PX_PER_M };       // standing centre (m)
    const tip = Math.max(0, Math.min(1, c.tip || 0));
    const squash = Math.max(0, Math.min(1, c.squash || 0));
    const phi = tip * Math.PI / 2;

    // base pose of the standing slice
    const M = _M.compose(_v.set(C.x, 0, C.y), _q.setFromAxisAngle(UP, yawFor(a)), ONE);

    if (tip > 0) {
      const td = c.tipDir ?? a + Math.PI / 2;
      const u = { x: Math.cos(td), y: Math.sin(td) };
      if (c.edge === 'short') {
        // over the tip or the back: rotate about the sim's pivot line (perpendicular to the axis)
        const pv = Wp(c.pivotX ?? c.x, c.pivotY ?? c.y, _pv);
        _ax.set(u.y, 0, -u.x);                                  // up × u
        rotateAbout(M, pv, _q.setFromAxisAngle(_ax, phi));
      } else {
        // over a long side: the real side edge, tip -> back corner on the falling side
        const s = Math.sign(u.x * P.x + u.y * P.y) || 1;
        const T = { x: C.x + A.x * TIP_Z, y: C.y + A.y * TIP_Z };
        const B = { x: C.x - A.x * BACK_Z + P.x * BACK_X * s, y: C.y - A.y * BACK_Z + P.y * BACK_X * s };
        let ex = B.x - T.x, ey = B.y - T.y; const el = Math.hypot(ex, ey); ex /= el; ey /= el;
        // outward normal of that edge, on the falling side
        let ox = -ey, oy = ex; if (ox * u.x + oy * u.y < 0) { ox = -ox; oy = -oy; }
        _ax.set(oy, 0, -ox);                                    // up × o
        rotateAbout(M, _v.set(T.x, 0, T.y), _q.setFromAxisAngle(_ax, phi));
        // blend the lying slice onto the sim footprint: yaw the edge onto the axis, move its midpoint to the pivot
        const Ax = -A.x, Ay = -A.y;                             // edge runs tip -> back
        const delta = Math.atan2(ex * Ay - ey * Ax, ex * Ax + ey * Ay); // page angle edge -> axis (clockwise +)
        const Me = _Me.set((T.x + B.x) / 2, 0, (T.y + B.y) / 2);
        rotateAbout(M, Me, _q.setFromAxisAngle(UP, -delta * tip));
        const pvx = (c.pivotX ?? (c.x + P.x * BOX_HALF_W * s * PX_PER_M)) / PX_PER_M;
        const pvy = (c.pivotY ?? (c.y + P.y * BOX_HALF_W * s * PX_PER_M)) / PX_PER_M;
        _m2.makeTranslation((pvx - Me.x) * tip, 0, (pvy - Me.z) * tip); M.premultiply(_m2);
      }
    }
    // squash: flatten and spread about the centre of what touches the floor
    const F = { x: (c.floorX ?? c.x) / PX_PER_M, y: (c.floorY ?? c.y) / PX_PER_M };
    if (squash > 0) {
      // height from the sim's crushed height field when lying (max thickness vs the uncrushed 0.067 m back),
      // spread from its footprint growth; otherwise a generic flatten + spread
      let sy = Math.max(0.1, 1 - 0.85 * squash), sxz = 1 + 0.45 * squash;
      if (Number.isFinite(c.height) && c.height > 0 && c.footprint) {
        sy = Math.max(0.08, Math.min(1, (c.height / PX_PER_M) / (2 * BACK_X)));
        const fpw = c.footprint.w / PX_PER_M / 0.13, fph = c.footprint.h / PX_PER_M / HEIGHT;
        if (Number.isFinite(fpw) && Number.isFinite(fph)) sxz = Math.max(1, Math.min(1.8, Math.sqrt(fpw * fph)));
      }
      _m.makeTranslation(-F.x, 0, -F.y); M.premultiply(_m);
      _m.makeScale(sxz, sy, sxz); M.premultiply(_m);
      _m.makeTranslation(F.x, 0, F.y); M.premultiply(_m);
    }
    // standing in a plate's well: lift everything by the plate surface (eased, so a slice sliding off
    // the rim drops onto the desk instead of popping)
    const yT = Number.isFinite(c.baseZ) ? c.baseZ / PX_PER_M : (c.onPlate ? PLATE_SURFACE_Y : 0);
    inst.yOff += (yT - inst.yOff) * Math.min(1, dt * 12);
    if (inst.yOff !== 0) { _m2.makeTranslation(0, inst.yOff, 0); M.premultiply(_m2); }
    inst.slice.matrix.copy(M);
    inst.slice.matrixWorldNeedsUpdate = true;

    inst.floorG.position.set(C.x, inst.yOff, C.y);
    inst.floorG.rotation.set(0, yawFor(a), 0);

    // contact shadow under the visible footprint
    const fp = c.footprint;
    inst.shadow.position.set(F.x, 0.0006 + inst.yOff, F.y);
    if (fp) { inst.shadow.scale.set(fp.w / PX_PER_M * 1.5, fp.h / PX_PER_M * 1.5, 1); inst.shadow.rotation.z = -fp.angle; }
    else { inst.shadow.scale.set(0.11, 0.17, 1); inst.shadow.rotation.z = -(a + Math.PI / 2); }

    // crushed: crossfade to the squashed blob (instant for cakes that were already crushed when first seen)
    const crushed = c.phase === 'crushed';
    if (inst.crushFade < 0) inst.crushFade = crushed ? 1 : 0;
    inst.crushFade = Math.max(0, Math.min(1, inst.crushFade + (crushed ? 1 : -1) * dt / 0.3));
    const f = inst.blobG.children.length ? inst.crushFade : 0;
    applyFade(inst, f);
    if (inst.blobG.visible) {
      const bx = fp ? fp.x / PX_PER_M : F.x, bz = fp ? fp.y / PX_PER_M : F.y;
      inst.blobG.position.set(bx, inst.yOff, bz);
      inst.blobG.rotation.y = yawFor(fp ? fp.angle : a);
      const sc = 0.75 + 0.25 * f;
      inst.blobG.scale.set(sc, 0.4 + 0.6 * f, sc);
    }
  }

  const live = new Map();   // id -> instance
  const seen = new Set();   // reused every frame

  /** @param stateCakes state.cakes (array) or a single state.cake */
  function update(stateCakes, dt) {
    const list = Array.isArray(stateCakes) ? stateCakes : stateCakes ? [stateCakes] : [];
    seen.clear();
    for (const c of list) {
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      const id = c.id ?? '__anon';
      seen.add(id);
      let inst = live.get(id);
      if (!inst) { inst = makeInstance(); live.set(id, inst); }
      place(inst, c, dt);
      inst.last = c;
    }
    for (const [id, inst] of live) if (!seen.has(id)) { dispose(inst); live.delete(id); }
  }

  function reset() { for (const inst of live.values()) dispose(inst); live.clear(); }

  return { update, reset, real, get live() { let l = null; for (const v of live.values()) l = v; return l; }, get count() { return live.size; } };
}

/** ?caketest: a fake sim cake that runs the whole sequence once (standing → tipping → lying → squash → crushed) */
export function createCakeTest(x, y, { angle = 0.6 } = {}) {
  let t = 0;
  const td = angle + Math.PI / 2;
  const S = PX_PER_M;
  return {
    step(dt) {
      t = Math.min(t + dt, 8.5);
      const ux = Math.cos(td), uy = Math.sin(td);
      const pv = { x: x + ux * BOX_HALF_W * S, y: y + uy * BOX_HALF_W * S };
      const c = { id: 'test', x, y, angle, tipDir: td, edge: 'long', pivotX: pv.x, pivotY: pv.y, phase: 'standing', tip: 0, squash: 0, frosting: 1, floorX: x, floorY: y };
      if (t < 2) return [c];
      const lyingC = { x: pv.x + ux * HEIGHT / 2 * S, y: pv.y + uy * HEIGHT / 2 * S };
      if (t < 2.7) { const s = (t - 2) / 0.7; c.phase = 'tipping'; c.tip = s * s; return [c]; }
      c.phase = 'lying'; c.tip = 1; c.floorX = lyingC.x; c.floorY = lyingC.y;
      c.footprint = { x: lyingC.x, y: lyingC.y, angle, w: 0.13 * S, h: 0.11 * S };
      if (t < 4) return [c];
      c.squash = Math.min(1, (t - 4) / 2.5);
      if (c.squash >= 0.9) c.phase = 'crushed';
      return [c];
    },
  };
}
