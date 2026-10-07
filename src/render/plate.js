// plate.js — white ceramic dessert plates at their sim poses (state.plates: [{ id, x, y, angle, cakeId, vx, vy }]).
//
// Model (public/models/plate.glb): single mesh `Plate`, origin at the centre on the floor, +Y up, metres.
// Well surface y = 0.006 (flat to r = 0.075), rolled lip crest y ≈ 0.016 at r ≈ 0.107, outer edge r = 0.109.
// Lives in the 3D canvas above the floor-smear layer, so it naturally hides the smear under it.
// A procedural lathe plate stands in if the model is missing.

import * as THREE from 'three';
import { getGLTFLoader, makeRadialTexture } from './robot.js';
import { PX_PER_M } from './scene.js';

export const PLATE_RADIUS = 0.109;

function proceduralPlate() {
  // profile (r, y): foot ring, underside, well, rim, lip
  const pts = [[0, 0.006], [0.075, 0.006], [0.09, 0.009], [0.104, 0.0145], [0.109, 0.016], [0.109, 0.013],
    [0.1, 0.009], [0.06, 0.004], [0.06, 0.0], [0.053, 0.0], [0.05, 0.003], [0, 0.003]].map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(pts, 96);
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xf6f8fb, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, mat); m.name = 'Plate';
  const g = new THREE.Group(); g.add(m);
  return g;
}

async function loadPlateModel() {
  try {
    const gltf = await getGLTFLoader().loadAsync('/models/plate.glb');
    return { scene: gltf.scene, real: true };
  } catch (err) {
    console.warn('[roomba] plate.glb not available, using a procedural plate:', err && err.message);
    return { scene: proceduralPlate(), real: false };
  }
}

export async function createPlateRenderer(scene) {
  const { scene: proto, real } = await loadPlateModel();
  proto.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const shadowTex = makeRadialTexture(64, 0.5);
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false });

  const live = new Map();   // id -> { g, shadow, last }
  const seen = new Set();
  let speedMax = 0;         // fastest plate this frame (px/s), for the slide sound

  function makeInstance() {
    const g = proto.clone(true);  // geometry and materials are shared: plates never change appearance
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    // soft contact shadow a little larger than the plate, so the glaze edge sits on the desk
    shadow.scale.set(PLATE_RADIUS * 2.5, 1, PLATE_RADIUS * 2.5);
    shadow.renderOrder = -5;
    scene.add(g, shadow);
    return { g, shadow, px: NaN, py: NaN };
  }

  function update(plates, dt) {
    seen.clear();
    speedMax = 0;
    if (Array.isArray(plates)) {
      for (const p of plates) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const id = p.id ?? '__plate';
        seen.add(id);
        let inst = live.get(id);
        if (!inst) { inst = makeInstance(); live.set(id, inst); }
        const x = p.x / PX_PER_M, z = p.y / PX_PER_M;
        inst.g.position.set(x, 0, z);
        inst.g.rotation.y = -(p.angle || 0);           // page clockwise = −Y rotation seen from above
        inst.shadow.position.set(x, 0.0005, z);
        const v = Number.isFinite(p.vx) ? Math.hypot(p.vx, p.vy) : (dt > 0 && Number.isFinite(inst.px) ? Math.hypot(p.x - inst.px, p.y - inst.py) / dt : 0);
        speedMax = Math.max(speedMax, v);
        inst.px = p.x; inst.py = p.y;
      }
    }
    for (const [id, inst] of live) if (!seen.has(id)) { inst.g.removeFromParent(); inst.shadow.removeFromParent(); live.delete(id); }
  }

  function reset() { for (const inst of live.values()) { inst.g.removeFromParent(); inst.shadow.removeFromParent(); } live.clear(); }

  return { update, reset, real, get count() { return live.size; }, /** px/s of the fastest-moving plate */ get speed() { return speedMax; } };
}
