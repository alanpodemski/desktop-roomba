// robot.js — loads roomba.glb and animates wheels / brushes / bumper / button light. Anger is
// expressed through the ButtonLight tint (teal -> red) and sound; the EyeL/EyeR discs are hidden.
//
// Model frame: metres, +Y up, front = -Z, right = +X. Sim frame: px, angle 0 = +x (screen right),
// positive = clockwise on screen. World X = screen x, world Z = screen y. For the model's front
// (-Z local) to point along (cos a, sin a) in world (X, Z) we need rotation.y = -a - π/2:
//   Ry(θ)·(0,0,-1) = (-sin θ, 0, -cos θ)  →  θ = -a - π/2 gives (cos a, 0, sin a). ✓
// Check: a = 0 (driving right) → θ = -π/2 → local +X (the side brush side) maps to (0,0,1) = screen
// down, which is the robot's right hand when it faces right on a y-down screen. ✓

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { PX_PER_M } from './scene.js';

export const simAngleToYaw = (a) => -a - Math.PI / 2;

const WHEEL_R = 0.0325;

const CHOC = new THREE.Color(0x2a1408);
const TEAL = new THREE.Color(0x19d8c8);
const RED = new THREE.Color(0xff2a14);

let sharedLoader = null;
export function getGLTFLoader() {
  if (sharedLoader) return sharedLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  draco.setDecoderConfig({ type: 'js' }); // the js decoder is robust under Vite dev; wasm also present
  sharedLoader = new GLTFLoader();
  sharedLoader.setDRACOLoader(draco);
  return sharedLoader;
}

export async function loadRobot(scene) {
  const gltf = await getGLTFLoader().loadAsync('/models/roomba.glb');
  const model = gltf.scene;
  const nodes = {};
  let buttonMat = null;
  model.traverse((o) => {
    if (o.name) nodes[o.name] = o;
    if (o.name === 'EyeL' || o.name === 'EyeR') { o.visible = false; return; }
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.name === 'ButtonLight') buttonMat = m;
    }
  });
  if (buttonMat) {
    buttonMat.emissive = TEAL.clone();
    buttonMat.emissiveIntensity = buttonMat.emissiveIntensity || 1.5;
  }

  // root group placed by the sim; model child so we can offset/yaw independently
  const root = new THREE.Group();
  root.add(model);
  scene.add(root);

  // soft contact shadow under the robot (ambient occlusion-ish), so it does not float
  const aoTex = makeRadialTexture(128, 0.55);
  const ao = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.42),
    new THREE.MeshBasicMaterial({ map: aoTex, transparent: true, opacity: 0.55, depthWrite: false, color: 0x000000 })
  );
  ao.rotation.x = -Math.PI / 2;
  ao.position.y = 0.0008;
  ao.renderOrder = -5;
  root.add(ao);

  // ---- chocolate pick-up: wheels, side brush, roller, caster tint fully; the bumper only on its
  // lower lip (shader tint by local height), so a dirty robot reads from above without looking painted
  const tinted = [];
  for (const name of ['WheelL', 'WheelR', 'SideBrush', 'Roller', 'Caster']) {
    const node = nodes[name];
    if (!node) continue;
    node.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      // which carrier's load stains this part (sim: loadL / loadR / loadBrush; falls back to load)
      const src = name === 'WheelL' ? 'loadL' : name === 'WheelR' ? 'loadR' : name === 'Caster' ? 'load' : 'loadBrush';
      tinted.push({ m: o.material, base: o.material.color.clone(), rough: o.material.roughness ?? 1, k: name === 'SideBrush' ? 0.9 : 0.8, src, s: 0 });
    });
  }
  const loadUniform = { value: 0 };
  if (nodes.Bumper) {
    nodes.Bumper.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.onBeforeCompile = (sh) => {
        sh.uniforms.uLoad = loadUniform;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vLocalY;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalY = transformed.y;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLocalY;\nuniform float uLoad;')
          .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.022, 0.008, 0.003), uLoad * (1.0 - smoothstep(0.014, 0.034, vLocalY)));');
      };
      o.material.customProgramCacheKey = () => 'bumper-choc';
    });
  }
  let loadSmooth = 0;

  // ---- animation state ------------------------------------------------------------------------
  let bumperT = 0;
  let angerSmooth = 0;

  const tmp = new THREE.Vector3();

  /**
   * @param {object} r  sim robot state (px units)
   * @param {number} dt seconds
   */
  function update(r, dt) {
    if (dt <= 0) return;
    // body pose: lift (m) when driving over something, pitch (+ = nose up) and roll (+ = right side up)
    const lift = Number.isFinite(r.lift) ? r.lift : 0;
    const pitch = Number.isFinite(r.pitch) ? r.pitch : 0;
    const roll = Number.isFinite(r.roll) ? r.roll : 0;
    root.position.set(r.x / PX_PER_M, lift, r.y / PX_PER_M);
    root.rotation.y = simAngleToYaw(r.angle);
    // model frame: front = −Z, so +X rotation lifts the nose; right = +X, so +Z rotation lifts the right side
    model.rotation.set(pitch, 0, roll, 'YXZ');
    ao.material.opacity = 0.55 * Math.max(0.25, 1 - lift / 0.04);

    // chocolate on wheels / brushes
    const load = Number.isFinite(r.load) ? Math.max(0, Math.min(1, r.load)) : 0;
    loadSmooth += (load - loadSmooth) * (1 - Math.exp(-dt * 6));
    const lt = Math.min(1, Math.sqrt(loadSmooth) * 1.4);   // even a little frosting shows on the bristles
    for (const t of tinted) {
      const v = Number.isFinite(r[t.src]) ? Math.max(0, Math.min(1, r[t.src])) : load;
      t.s += (v - t.s) * (1 - Math.exp(-dt * 6));
      const k = Math.min(1, Math.sqrt(t.s) * 1.4);
      t.m.color.copy(t.base).lerp(CHOC, k * t.k); t.m.roughness = t.rough + (0.3 - t.rough) * k * 0.8;
    }
    loadUniform.value = lt;

    // --- wheels: surface speed px/s -> rad/s about local X. Rolling forward (toward -Z) the top of
    // the wheel moves toward -Z, which is a negative rotation about +X.
    const wl = r.wheelL / PX_PER_M, wr = r.wheelR / PX_PER_M;
    if (nodes.WheelL) nodes.WheelL.rotation.x -= (wl / WHEEL_R) * dt;
    if (nodes.WheelR) nodes.WheelR.rotation.x -= (wr / WHEEL_R) * dt;
    if (nodes.Roller) nodes.Roller.rotation.x -= r.brushRpm * 95 * dt;            // ~900 rpm
    if (nodes.SideBrush) nodes.SideBrush.rotation.y += r.sideBrushRpm * 14 * dt;  // ~130 rpm, CCW from above (sweeps inward)
    if (nodes.Turret) nodes.Turret.rotation.y += (r.mode === 'docked' || r.mode === 'off' ? 0 : 5.5) * dt;

    // --- bumper compress
    const pressed = r.bumper && (r.bumper.left || r.bumper.right);
    bumperT += ((pressed ? 1 : 0) - bumperT) * (1 - Math.exp(-dt * (pressed ? 60 : 12)));
    if (nodes.Bumper) nodes.Bumper.position.z = bumperT * 0.003;

    // --- anger: button light tint teal -> red, pulsing when stuck
    angerSmooth += (r.anger - angerSmooth) * (1 - Math.exp(-dt * 4));
    const a = angerSmooth;
    if (buttonMat) {
      buttonMat.emissive.copy(TEAL).lerp(RED, a);
      buttonMat.emissiveIntensity = 1.5 + a * 1.5 + (r.mode === 'stuck' ? Math.sin(performance.now() / 180) * 0.6 : 0);
    }
  }

  /** world-space front point (for the debug outline) */
  function frontPoint(out = tmp) { return out.set(0, 0.05, -0.17).applyMatrix4(model.matrixWorld); }

  return { root, model, nodes, update, frontPoint };
}

export function makeRadialTexture(size, inner = 0.4) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(inner, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
