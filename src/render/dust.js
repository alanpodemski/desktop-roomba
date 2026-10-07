// dust.js — crumbs as InstancedMeshes (3 low-poly shapes × 3 colours) plus a soft contact-shadow
// sprite under each so they visibly sit on the desktop. Positions come from the sim's dust arrays.

import * as THREE from 'three';
import { PX_PER_M } from './scene.js';
import { makeRadialTexture } from './robot.js';

const COLOURS = [new THREE.Color(0xb9a27f), new THREE.Color(0x6f6c68), new THREE.Color(0x26211d)];
const SHAPES = 3;
const SIZE_GAIN = 1.1; // crumbs are 1.5–4 px in the sim; render them a touch larger so they read

function crumbGeometry(seed) {
  // jittered low-poly blob: icosahedron detail 0 with vertices pushed around deterministically
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const pos = g.attributes.position;
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * (0.7 + rnd() * 0.7), pos.getY(i) * (0.45 + rnd() * 0.4), pos.getZ(i) * (0.7 + rnd() * 0.7));
  }
  g.computeVertexNormals();
  return g;
}

export function createDust(scene, capacity = 4000) {
  // Particle i of the sim owns a fixed slot: mesh i % SHAPES, instance floor(i / SHAPES), shadow i.
  // Colours are written once; per frame only slots whose particle appeared, died or moved are rewritten
  // and only that index range is uploaded (crumbs sit still most of the time).
  const perShape = Math.ceil(capacity / SHAPES);
  const mat = new THREE.MeshStandardMaterial({ roughness: 1.0, metalness: 0.0, envMapIntensity: 0.3 });
  const meshes = [];
  for (let k = 0; k < SHAPES; k++) {
    const m = new THREE.InstancedMesh(crumbGeometry(k + 1), mat, perShape);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = false; m.receiveShadow = false;
    m.frustumCulled = false;
    m.count = 0;
    scene.add(m);
    meshes.push(m);
  }
  const shadowTex = makeRadialTexture(32, 0.3);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
  const shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat, capacity);
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.frustumCulled = false;
  shadows.renderOrder = -4;
  shadows.count = 0;
  scene.add(shadows);

  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < capacity; i++) {
    const k = i % SHAPES, idx = (i / SHAPES) | 0;
    meshes[k].setMatrixAt(idx, ZERO);
    meshes[k].setColorAt(idx, COLOURS[(i * 7 + k) % 3]);
    shadows.setMatrixAt(i, ZERO);
  }
  for (const m of meshes) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
  shadows.instanceMatrix.needsUpdate = true;

  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const lastX = new Float32Array(capacity).fill(NaN), lastY = new Float32Array(capacity), lastS = new Float32Array(capacity);
  const shown = new Uint8Array(capacity);
  const lo = new Int32Array(SHAPES), hi = new Int32Array(SHAPES);
  let maxUsed = 0;   // highest particle index ever shown + 1 (instance counts)

  function update(d) {
    const n = Math.min(d.count, capacity);
    lo.fill(1 << 30); hi.fill(-1);
    let slo = 1 << 30, shi = -1;
    for (let i = 0; i < n; i++) {
      const alive = d.alive[i] === 1;
      if (!alive) {
        if (!shown[i]) continue;
        shown[i] = 0; lastX[i] = NaN;
        const k = i % SHAPES, idx = (i / SHAPES) | 0;
        meshes[k].setMatrixAt(idx, ZERO); shadows.setMatrixAt(i, ZERO);
        if (idx < lo[k]) lo[k] = idx; if (idx > hi[k]) hi[k] = idx; if (i < slo) slo = i; if (i > shi) shi = i;
        continue;
      }
      const x = d.x[i], y = d.y[i], size = d.size[i];
      if (shown[i] && x === lastX[i] && y === lastY[i] && size === lastS[i]) continue;
      shown[i] = 1; lastX[i] = x; lastY[i] = y; lastS[i] = size;
      const k = i % SHAPES, idx = (i / SHAPES) | 0;
      const sizeM = (size * SIZE_GAIN) / PX_PER_M;
      p.set(x / PX_PER_M, sizeM * 0.35, y / PX_PER_M);
      q.setFromAxisAngle(UP, (i * 2.399963) % (Math.PI * 2));
      sc.set(sizeM, sizeM, sizeM);
      mtx.compose(p, q, sc);
      meshes[k].setMatrixAt(idx, mtx);
      // contact shadow
      p.y = 0.0004;
      sc.set(sizeM * 2.2, 1, sizeM * 2.2);
      mtx.compose(p, IDENTITY_Q, sc);
      shadows.setMatrixAt(i, mtx);
      if (idx < lo[k]) lo[k] = idx; if (idx > hi[k]) hi[k] = idx; if (i < slo) slo = i; if (i > shi) shi = i;
      if (i + 1 > maxUsed) maxUsed = i + 1;
    }
    for (let k = 0; k < SHAPES; k++) {
      const m = meshes[k];
      m.count = Math.ceil(Math.max(0, maxUsed - k) / SHAPES);
      if (hi[k] >= 0) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(lo[k] * 16, (hi[k] - lo[k] + 1) * 16); m.instanceMatrix.needsUpdate = true; }
    }
    shadows.count = maxUsed;
    if (shi >= 0) { shadows.instanceMatrix.clearUpdateRanges(); shadows.instanceMatrix.addUpdateRange(slo * 16, (shi - slo + 1) * 16); shadows.instanceMatrix.needsUpdate = true; }
  }

  /** forget everything shown (new sim): every slot is rewritten on the next update */
  function reset() {
    for (let i = 0; i < capacity; i++) if (shown[i]) {
      const k = i % SHAPES, idx = (i / SHAPES) | 0;
      meshes[k].setMatrixAt(idx, ZERO); shadows.setMatrixAt(i, ZERO);
    }
    shown.fill(0); lastX.fill(NaN); maxUsed = 0;
    for (const m of meshes) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.needsUpdate = true; }
    shadows.instanceMatrix.clearUpdateRanges(); shadows.instanceMatrix.needsUpdate = true;
  }

  return { update, reset, meshes, shadows };
}

const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY_Q = new THREE.Quaternion();
