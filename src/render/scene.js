// scene.js — three.js renderer, top-down camera that maps CSS px 1:1 onto the floor plane, lights.
//
// World frame: metres, +Y up. World X = page x / PX_PER_M, world Z = page y / PX_PER_M (so +Z is
// screen-down). Camera looks straight down (-Y) with up = -Z, so screen-right = +X, screen-down = +Z.
// A PerspectiveCamera with a narrow FOV at height h = (H_m / 2) / tan(fov / 2) frames exactly the
// page height at the floor plane (y = 0); aspect = W / H frames the width. Objects a few cm tall see
// a parallax of (height / h) ≈ 0.7 %, i.e. visually orthographic.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const PX_PER_M = 440;
const FOV_DEG = 8;

export function createScene(canvas) {
  // Memory: on a 2× screen, 4× MSAA on a full-page canvas costs ~250 MB of GPU buffers for edges you can
  // barely see at that pixel density, so multisampling is only used on 1× screens.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: dpr < 1.5, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = null;

  // reflections
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.5, 100);
  camera.up.set(0, 0, -1);

  // key light: warm-ish, coming from the upper left like the light in the wallpaper, low elevation
  // difference so shadows are short and soft rather than "game-like"
  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);   // ~5 mm per texel over the page; the shadows are soft (PCF radius 4) anyway
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.004;
  key.shadow.radius = 4;
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.HemisphereLight(0xbcd4ff, 0x30241c, 0.35);
  scene.add(fill);

  // invisible floor that only receives shadows
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32, transparent: true }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.renderOrder = -10;
  scene.add(floor);

  const size = { w: 1, h: 1, wM: 1, hM: 1, camH: 1 };

  function resize(w, h) {
    size.w = w; size.h = h;
    size.wM = w / PX_PER_M; size.hM = h / PX_PER_M;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    size.camH = (size.hM / 2) / Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2);
    camera.position.set(size.wM / 2, size.camH, size.hM / 2);
    camera.near = size.camH * 0.5;
    camera.far = size.camH * 1.5;
    camera.lookAt(size.wM / 2, 0, size.hM / 2);
    camera.updateProjectionMatrix();

    floor.scale.set(size.wM + 1, size.hM + 1, 1);
    floor.position.set(size.wM / 2, 0, size.hM / 2);

    // light from screen upper-left, fairly high so the shadow is a short soft blob to the lower-right
    const cx = size.wM / 2, cz = size.hM / 2;
    key.target.position.set(cx, 0, cz);
    key.position.set(cx - 2.2, 6, cz - 1.6);
    const sc = key.shadow.camera;
    const half = Math.hypot(size.wM, size.hM) / 2 + 0.3;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = 1; sc.far = 12;
    sc.updateProjectionMatrix();
  }

  /** CSS px -> world (floor plane) */
  const toWorld = (px, py, out = new THREE.Vector3()) => out.set(px / PX_PER_M, 0, py / PX_PER_M);
  /** world -> CSS px (project through the actual camera; used by the debug outline) */
  const v = new THREE.Vector3();
  function worldToPx(x, y, z) {
    v.set(x, y, z).project(camera);
    return { x: (v.x + 1) / 2 * size.w, y: (1 - v.y) / 2 * size.h };
  }

  function render() { renderer.render(scene, camera); }

  return { renderer, scene, camera, key, floor, size, resize, render, toWorld, worldToPx };
}
