// dock.js — loads dock.glb and places it so the docked robot (sim dock pose) sits on the ramp.
//
// Dock model frame: origin at the front-centre of the ramp, ramp opens toward -Z, tower at +Z.
// A docked robot sits at dock-local (0, 0, +0.02) with its front toward the tower (+Z local).
// The sim's dock.angle is the direction the robot drives in to dock, i.e. the dock's local +Z axis
// on screen. Ry(φ)·(0,0,1) = (sin φ, 0, cos φ) = (cos a, 0, sin a)  →  φ = π/2 - a.
// Robot docked position = dock origin + 0.02·u, so dock origin = sim dock − 0.02·u.

import * as THREE from 'three';
import { getGLTFLoader } from './robot.js';
import { PX_PER_M } from './scene.js';

export async function loadDock(scene, dockPx) {
  const gltf = await getGLTFLoader().loadAsync('/models/dock.glb');
  const model = gltf.scene;
  let led = null;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.name === 'DockLED') led = m;
    }
  });
  if (led) { led.emissive = new THREE.Color(0x19d8c8); led.emissiveIntensity = 1.2; }
  scene.add(model);
  // local-frame extent along +Z (the tower's back edge), used to keep the whole dock on the page
  const bbox = new THREE.Box3().setFromObject(model);
  const backZ = bbox.max.z, frontZ = bbox.min.z, halfW = Math.max(-bbox.min.x, bbox.max.x);

  /**
   * The desktop gives the robot's docked pose. If the dock body behind it would fall off the page,
   * slide the pose along -u (into the room) until the tower's back edge is `marginPx` inside.
   */
  function fitPose(d, widthPx, heightPx, marginPx = 10) {
    const ux = Math.cos(d.angle), uy = Math.sin(d.angle);
    // tower back edge in px: robot − 0.02·u + backZ·u
    const bx = d.x + (backZ - 0.02) * PX_PER_M * ux, by = d.y + (backZ - 0.02) * PX_PER_M * uy;
    let shift = 0;
    if (bx < marginPx && ux < 0) shift = Math.max(shift, (marginPx - bx) / -ux);
    if (bx > widthPx - marginPx && ux > 0) shift = Math.max(shift, (bx - (widthPx - marginPx)) / ux);
    if (by < marginPx && uy < 0) shift = Math.max(shift, (marginPx - by) / -uy);
    if (by > heightPx - marginPx && uy > 0) shift = Math.max(shift, (by - (heightPx - marginPx)) / uy);
    return { x: d.x - ux * shift, y: d.y - uy * shift, angle: d.angle };
  }

  function place(d) {
    const ux = Math.cos(d.angle), uy = Math.sin(d.angle);
    model.position.set((d.x / PX_PER_M) - ux * 0.02, 0, (d.y / PX_PER_M) - uy * 0.02);
    model.rotation.y = Math.PI / 2 - d.angle;
  }

  let pulse = 0;
  function update(robot, dt) {
    if (!led) return;
    pulse += dt;
    const m = robot.mode;
    if (m === 'emptying') {
      led.emissive.setRGB(1, 0.45, 0.05); led.emissiveIntensity = 1.5 + Math.sin(pulse * 14) * 0.8;
    } else if (m === 'charging') {
      led.emissive.setRGB(0.1, 0.9, 0.3); led.emissiveIntensity = 1.2 + Math.sin(pulse * 2.5) * 0.6;
    } else if (m === 'docked') {
      led.emissive.setRGB(0.1, 0.85, 0.8); led.emissiveIntensity = 1.6;
    } else if (m === 'toDock' || m === 'docking') {
      led.emissive.setRGB(0.1, 0.85, 0.8); led.emissiveIntensity = 1.0 + (Math.sin(pulse * 6) > 0 ? 1.2 : 0);
    } else {
      led.emissive.setRGB(0.1, 0.85, 0.8); led.emissiveIntensity = 0.9;
    }
  }

  return { model, place, update, fitPose, extents: { backZ, frontZ, halfW } };
}
