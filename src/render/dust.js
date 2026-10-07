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

  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const colourSet = new Uint8Array(capacity); // tracks which instances already got a colour
  const rotCache = new Float32Array(capacity);
  for (let i = 0; i < capacity; i++) rotCache[i] = (i * 2.399963) % (Math.PI * 2);

  function update(d) {
    const n = Math.min(d.count, capacity);
    const counts = [0, 0, 0];
    let sCount = 0;
    for (let i = 0; i < n; i++) {
      if (!d.alive[i]) continue;
      const k = i % SHAPES;
      const m = meshes[k];
      const idx = counts[k]++;
      if (idx >= perShape) continue;
      const sizeM = (d.size[i] * SIZE_GAIN) / PX_PER_M;
      p.set(d.x[i] / PX_PER_M, sizeM * 0.35, d.y[i] / PX_PER_M);
      q.setFromAxisAngle(UP, rotCache[i]);
      sc.set(sizeM, sizeM, sizeM);
      mtx.compose(p, q, sc);
      m.setMatrixAt(idx, mtx);
      if (!colourSet[i]) { colourSet[i] = 1; }
      m.setColorAt(idx, COLOURS[(i * 7 + k) % 3]);
      // contact shadow
      p.y = 0.0004;
      sc.set(sizeM * 2.2, 1, sizeM * 2.2);
      mtx.compose(p, IDENTITY_Q, sc);
      shadows.setMatrixAt(sCount++, mtx);
    }
    for (let k = 0; k < SHAPES; k++) {
      meshes[k].count = counts[k];
      meshes[k].instanceMatrix.needsUpdate = true;
      if (meshes[k].instanceColor) meshes[k].instanceColor.needsUpdate = true;
    }
    shadows.count = sCount;
    shadows.instanceMatrix.needsUpdate = true;
  }

  return { update, meshes, shadows };
}

const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY_Q = new THREE.Quaternion();
