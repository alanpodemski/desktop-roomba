// smear.js — chocolate smeared on the desktop floor, under the icons.
//
// Two passes on a dedicated WebGL canvas that lives in the desktop's floor layer (between wallpaper and
// icons, so icons the robot pushes slide over the smear):
//   1. accumulate: every sim smear stamp is drawn as an instanced quad, additively, into a half-float
//      render target at page resolution. R = paint thickness, G = sponge chunks (crumbs).
//      Wheel stamps are continuous segments from the previous stamp of the same wheel (so the tread
//      pattern runs unbroken in page space), brush stamps a smudgy band, flings small droplets with a
//      tail, splats a big irregular lumpy blob.
//   2. display: full-screen shader reads the thickness, derives normals from its gradient and shades it
//      as chocolate frosting: a thin translucent brown film where it is thin, opaque glossy ganache where
//      it is thick, specular from the scene's key light, darker meniscus rims and a few crumbs.
// Thickness only ever accumulates here; the sim decides how much paint each stamp carries.

import * as THREE from 'three';

const KIND = { wheelL: 0, wheelR: 0, brush: 1, fling: 2, splat: 3 };
const MAX_STAMPS = 4096;         // per frame
const SEG_MAX_PX = 40;           // a stamp further than this from the previous one of its track starts a new segment
const AMOUNT_GAIN = 1.0;         // sim amount -> thickness units (1 = a solid coat)

const stampVS = /* glsl */`
  in vec2 corner;                // unit quad -0.5..0.5
  in vec4 iA;                    // centre x, centre y, angle, length (px)
  in vec4 iB;                    // width px, amount, kind, seed
  uniform vec2 uPage;            // page size px
  out vec2 vUV;                  // -0.5..0.5 in stamp space (x along travel, y across)
  out vec2 vPx;                  // page px of this fragment
  out vec2 vSize;                // stamp length, width px
  out float vAmount, vKind, vSeed;
  out vec2 vDir;
  out float vAlong, vLen, vH;    // px along the segment from its centre, segment length, end-ramp half-width
  void main() {
    float kind = iB.z;
    float len = iA.w, w = iB.x;
    // track segments get soft ends of half-width h beyond each end point (see stampFS)
    float h = kind < 1.5 ? min(0.5 * w, 12.0) : 0.0;
    vec2 size = vec2(len + 2.0 * h, w);
    if (kind > 1.5 && kind < 2.5) size = vec2(w * 2.4, w * 1.25);     // droplet + tail
    if (kind > 2.5) size = vec2(w * 1.35, w * 1.35);                   // splat (room for lumps)
    vec2 dir = vec2(cos(iA.z), sin(iA.z));
    vec2 nrm = vec2(-dir.y, dir.x);
    vec2 px = iA.xy + dir * corner.x * size.x + nrm * corner.y * size.y;
    vUV = corner; vPx = px; vSize = size; vAmount = iB.y; vKind = kind; vSeed = iB.w; vDir = dir;
    vAlong = corner.x * size.x; vLen = len; vH = h;
    gl_Position = vec4(px.x / uPage.x * 2.0 - 1.0, 1.0 - px.y / uPage.y * 2.0, 0.0, 1.0);
  }
`;

const NOISE = /* glsl */`
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
`;

const stampFS = /* glsl */`
  precision highp float;
  in vec2 vUV; in vec2 vPx; in vec2 vSize; in float vAmount, vKind, vSeed; in vec2 vDir;
  in float vAlong, vLen, vH;
  out vec4 outColor;
  ${NOISE}
  void main() {
    float t = 0.0, chunk = 0.0;
    float amt = vAmount;
    if (vKind < 1.5) {
      // soft segment ends: weight = ramp(start) − ramp(end), ramps 2h wide centred on the end points.
      // Consecutive segments share end points, so their weights telescope to exactly 1 along a track:
      // seamless joints (no beads where stamps overlap) and the outside of a turn is still covered.
      float hh = max(vH, 0.5);
      float wgt = clamp((vAlong + 0.5 * vLen + hh) / (2.0 * hh), 0.0, 1.0) - clamp((vAlong - 0.5 * vLen + hh) / (2.0 * hh), 0.0, 1.0);
      amt *= wgt;
      if (amt <= 0.0) discard;
    }
    if (vKind < 0.5) {
      // ---- tyre: chevron tread lugs in page space, soft shoulders, breaks up into specks when dry
      float across = vUV.y * 2.0;                          // -1..1
      float shoulder = 1.0 - smoothstep(0.7, 1.0, abs(across));
      float along = dot(vPx, vDir);
      float phase = along / 7.5 + abs(across) * 0.25;          // shallow chevron lugs, ~3.4 mm pitch
      float lug = 0.5 + 0.5 * sin(phase * 6.2831853);            // soft ridges, not a zipper
      float n = fbm(vPx * 0.3 + vSeed * 0.001);
      float cover = smoothstep(n - 0.15, n + 0.15, amt * 2.0);    // low load: patchy, dry print
      t = amt * shoulder * mix(0.75, 1.0, lug) * (0.85 + 0.3 * n) * cover;
    } else if (vKind < 1.5) {
      // ---- main brush band: lighter, streaky along travel, ragged edges
      float across = vUV.y * 2.0;
      vec2 sp = vec2(dot(vPx, vDir) * 0.03, dot(vPx, vec2(-vDir.y, vDir.x)) * 0.16);
      float streak = fbm(sp + vSeed * 0.01);
      float edge = 1.0 - smoothstep(0.45 + 0.35 * streak, 1.0, abs(across));
      float cover = smoothstep(streak - 0.2, streak + 0.2, amt * 7.0);   // faint, broken film when the brush is nearly clean
      t = amt * 1.1 * edge * (0.35 + 0.9 * streak) * cover;
    } else if (vKind < 2.5) {
      // ---- fling droplet: round head at the front, tapering tail behind
      vec2 p = vUV * vSize / max(vSize.y, 1e-3);          // in units of droplet width
      vec2 head = vec2(0.45, 0.0);
      float dh = length(p - head) / 0.42;
      float tail = (1.0 - smoothstep(0.0, 1.0, abs(p.y) / mix(0.05, 0.32, smoothstep(-1.2, 0.6, p.x)))) * smoothstep(-1.0, -0.2, p.x) * step(p.x, 0.45);
      float drop = 1.0 - smoothstep(0.6, 1.0, dh);
      t = amt * 1.8 * max(drop, tail * 0.55);
    } else {
      // ---- splat: irregular blob with lobes, lumps and sponge chunks
      vec2 p = vUV * 1.35 * 2.0;                           // radius 1 = nominal splat radius
      float r = length(p);
      float a = atan(p.y, p.x);
      float s = vSeed;
      float rim = 0.78 + 0.10 * sin(a * 3.0 + s) + 0.07 * sin(a * 5.0 + s * 2.3) + 0.06 * sin(a * 9.0 + s * 4.1)
                + 0.12 * (fbm(vec2(a * 1.6, s)) - 0.5);
      float body = 1.0 - smoothstep(rim - 0.08, rim + 0.02, r);
      float lumps = fbm(p * 2.6 + s);
      // satellite drips around the blob
      vec2 cell = floor(p * 3.0); float hs = hash12(cell + s);
      float drip = hs > 0.86 ? 1.0 - smoothstep(0.08, 0.2, length(fract(p * 3.0) - 0.5)) : 0.0;
      drip *= smoothstep(0.9, 1.15, r) * (1.0 - smoothstep(1.3, 1.45, r));
      t = amt * (body * (1.2 + 1.6 * lumps) + drip * 0.9);
      chunk = body * smoothstep(0.62, 0.8, fbm(p * 4.0 + s * 3.0)) * amt;
    }
    if (t <= 0.0 && chunk <= 0.0) discard;
    outColor = vec4(t, chunk, 0.0, 0.0);
  }
`;

const quadVS = /* glsl */`
  out vec2 vUv;
  in vec3 position;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const displayFS = /* glsl */`
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uPaint;
  uniform vec2 uTexel;           // 1 / paint texture size
  uniform float uPxPerTexel;     // page px per texel
  uniform vec3 uLight;           // direction toward the key light in page space (x right, y down, z up)
  ${NOISE}
  // thickness -> height in page px (+ crumbs as small bumps)
  float paintAt(vec2 uv) { return texture(uPaint, uv).r; }
  float heightAt(vec2 uv) {
    vec4 s = texture(uPaint, uv);
    float t = s.r;
    float h = 7.0 * (1.0 - exp(-t * 0.7));               // exaggerated relief (px); levels off, never piles up forever
    vec2 px = uv / uTexel * uPxPerTexel;
    // sponge crumbs: sparse cells, more where the splat put chunks
    vec2 cell = floor(px / 3.5);
    float hs = hash12(cell);
    float crumbP = 0.003 + s.g * 0.25;
    if (hs < crumbP && t > 0.25) {
      vec2 c = (cell + 0.5 + (vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5) * 0.6) * 3.5;
      float d = length(px - c) / (1.0 + 1.6 * hash12(cell + 1.3));
      h += 1.6 * (1.0 - smoothstep(0.4, 1.0, d));
    }
    return h;
  }
  void main() {
    vec4 s = texture(uPaint, vUv);
    float t = s.r;
    if (t < 0.004) { outColor = vec4(0.0); return; }
    // wide gradient kernel: the frosting surface flows over the tread, so relief is smooth and the tread
    // shows mostly in tone (thickness), not as beaded highlights
    const float K = 2.6;
    vec2 dx = vec2(uTexel.x, 0.0) * K, dy = vec2(0.0, uTexel.y) * K;
    float hL = heightAt(vUv - dx), hR = heightAt(vUv + dx), hD = heightAt(vUv - dy), hU = heightAt(vUv + dy);
    float h = heightAt(vUv);
    // page space: +x right, +y down (texture v grows upward), z up out of the screen
    vec2 grad = vec2((hR - hL), -(hU - hD)) / (2.0 * K * uPxPerTexel);
    vec3 n = normalize(vec3(-grad * mix(0.35, 1.0, smoothstep(0.1, 0.8, t)), 1.0));  // thin film stays flat
    vec3 L = normalize(uLight);
    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 Hh = normalize(L + V);

    float thick = smoothstep(0.15, 1.1, t);
    // colours picked in sRGB, lit in linear
    vec3 film = pow(vec3(0.29, 0.15, 0.07), vec3(2.2));      // thin smear: still clearly chocolate over a light wallpaper
    vec3 ganache = pow(vec3(0.15, 0.07, 0.032), vec3(2.2));  // thick dark frosting
    vec3 crumb = pow(vec3(0.27, 0.15, 0.08), vec3(2.2));     // sponge chunks: lighter, matte
    vec3 base = mix(film, ganache, thick);
    float chunk = smoothstep(0.05, 0.3, s.g);
    base = mix(base, crumb, chunk * 0.7);
    float ndl = max(dot(n, L), 0.0);
    float diff = 0.45 + 0.75 * ndl;
    // glossy only where it is thick and smooth; tight lobe so flat areas stay dark (no grey haze)
    float gloss = mix(0.12, 1.0, thick) * (1.0 - chunk * 0.8);
    float ndh = max(dot(n, Hh), 0.0);
    float spec = pow(ndh, 240.0) * 1.6 * gloss + pow(ndh, 24.0) * 0.035 * gloss;  // sharp wet glint + soft sheen
    // slope-facing-the-light sheen (room reflection on curved frosting edges)
    float slope = 1.0 - n.z;
    float sheen = 0.25 * slope * max(dot(normalize(n.xy + 1e-5), normalize(L.xy)), 0.0) * gloss;
    // darker meniscus where the film thins out at a track's edge
    float rim = smoothstep(0.02, 0.25, length(grad)) * (1.0 - thick) * 0.35;
    vec3 col = base * diff * (1.0 - rim) + vec3(1.0, 0.93, 0.85) * (spec + sheen);
    float alpha = clamp(1.0 - exp(-t * 5.0), 0.0, 1.0);   // a thin film of cocoa fat is fairly opaque
    alpha = max(alpha, 0.6 * thick + chunk * 0.4);
    alpha = clamp(alpha + min(spec, 1.0) * 0.6, 0.0, 1.0);
    // linear -> sRGB (no tone mapping on this canvas)
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
    outColor = vec4(col * alpha, alpha);
  }
`;

/**
 * @param {object} o
 * @param {HTMLElement} o.parent   floor layer element (between wallpaper and icons)
 * @param {THREE.Vector3} [o.lightDir] direction toward the key light in three world coords (x right, y up, z down-screen)
 */
export function createSmear({ parent, lightDir }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'rb-smear';
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '1' });
  attach(parent);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;

  // ---- accumulation target + instanced stamp mesh ----------------------------------------------------
  let rt = null;
  const stampGeo = new THREE.InstancedBufferGeometry();
  stampGeo.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
  stampGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const iA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4);
  const iB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4);
  iA.setUsage(THREE.DynamicDrawUsage); iB.setUsage(THREE.DynamicDrawUsage);
  stampGeo.setAttribute('iA', iA); stampGeo.setAttribute('iB', iB);
  stampGeo.instanceCount = 0;
  const stampMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: stampVS, fragmentShader: stampFS,
    uniforms: { uPage: { value: new THREE.Vector2(1, 1) } },
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    depthTest: false, depthWrite: false, transparent: true,
    side: THREE.DoubleSide,        // page y is flipped into NDC, which reverses the quad winding
  });
  const stampMesh = new THREE.Mesh(stampGeo, stampMat);
  stampMesh.frustumCulled = false;
  const stampScene = new THREE.Scene(); stampScene.add(stampMesh);
  const cam = new THREE.Camera();

  // ---- display ---------------------------------------------------------------------------------------
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const L = (lightDir ? lightDir.clone() : new THREE.Vector3(-2.2, 6, -1.6)).normalize();
  const dispMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: quadVS, fragmentShader: displayFS,
    uniforms: {
      uPaint: { value: null }, uTexel: { value: new THREE.Vector2() }, uPxPerTexel: { value: 1 },
      uLight: { value: new THREE.Vector3(L.x, L.z, L.y) },   // world (x, y-up, z-down) -> page (x, y-down, z-up)
    },
    blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });
  const dispMesh = new THREE.Mesh(quad, dispMat); dispMesh.frustumCulled = false;
  const dispScene = new THREE.Scene(); dispScene.add(dispMesh);

  let W = 1, H = 1, texScale = 1;
  let dirty = true;
  let pending = 0;
  const tracks = new Map(); // kind -> last {x, y}
  let seedCounter = 1;

  function attach(p) {
    if (!p) return;
    if (canvas.parentNode === p) return;
    // keep it the bottom-most thing in the floor layer
    p.insertBefore(canvas, p.firstChild);
  }

  function resize(w, h) {
    const oldRt = rt, oldW = W, oldH = H;
    W = w; H = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    texScale = Math.min(1, 2048 / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * texScale)), th = Math.max(1, Math.round(h * texScale));
    rt = new THREE.WebGLRenderTarget(tw, th, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
    // carry the old paint over (top-left anchored, like the page)
    if (oldRt) {
      copyMat.uniforms.uSrc.value = oldRt.texture;
      copyMat.uniforms.uScale.value.set(w / oldW, h / oldH);
      renderer.render(copyScene, cam);
      oldRt.dispose();
    }
    renderer.setRenderTarget(null);
    stampMat.uniforms.uPage.value.set(w, h);
    dispMat.uniforms.uPaint.value = rt.texture;
    dispMat.uniforms.uTexel.value.set(1 / tw, 1 / th);
    dispMat.uniforms.uPxPerTexel.value = 1 / texScale;
    dirty = true;
  }

  const copyMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: quadVS,
    fragmentShader: /* glsl */`precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uScale;
      void main() { vec2 uv = vec2(vUv.x * uScale.x, 1.0 - (1.0 - vUv.y) * uScale.y);
        o = (uv.x > 1.0 || uv.y < 0.0) ? vec4(0.0) : texture(uSrc, uv); }`,
    uniforms: { uSrc: { value: null }, uScale: { value: new THREE.Vector2(1, 1) } },
    blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });
  const copyScene = new THREE.Scene();
  { const m = new THREE.Mesh(quad, copyMat); m.frustumCulled = false; copyScene.add(m); }

  function push(cx, cy, angle, len, w, amount, kind, seed) {
    if (pending >= MAX_STAMPS) return;
    const i = pending++;
    iA.array[i * 4] = cx; iA.array[i * 4 + 1] = cy; iA.array[i * 4 + 2] = angle; iA.array[i * 4 + 3] = len;
    iB.array[i * 4] = w; iB.array[i * 4 + 1] = amount; iB.array[i * 4 + 2] = kind; iB.array[i * 4 + 3] = seed;
  }

  /** queue stamps from the sim: [{ kind, x, y, angle, w, amount, len? }] (len = segment length px) */
  function addStamps(list) {
    if (!list || !list.length) return;
    for (const s of list) {
      const amount = Math.max(0, (s.amount ?? 0) * AMOUNT_GAIN);
      if (!(amount > 0) || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const w = Math.max(1, s.w || 8);
      const k = KIND[s.kind] ?? 1;
      const seed = (seedCounter = (seedCounter * 16807) % 2147483647) % 1000;
      if (k <= 1 && Number.isFinite(s.len)) {
        // the sim already emits each stamp as the segment since the previous one of its carrier
        if (s.len > 0.01) push(s.x, s.y, s.angle ?? 0, s.len, w, amount, k, seed);
        else push(s.x, s.y, s.angle ?? 0, Math.min(w, 4), w, amount, k, seed);
      } else if (k <= 1) {
        // no length given: continuous tracks from the previous stamp of the same track
        const prev = tracks.get(s.kind);
        const ang = s.angle ?? 0;
        if (prev) {
          const dx = s.x - prev.x, dy = s.y - prev.y, d = Math.hypot(dx, dy);
          if (d > 0.01 && d < SEG_MAX_PX) {
            push((s.x + prev.x) / 2, (s.y + prev.y) / 2, Math.atan2(dy, dx), d, w, amount, k, seed);
            tracks.set(s.kind, { x: s.x, y: s.y, t: performance.now() });
            continue;
          }
          if (d <= 0.01) continue; // standing still: nothing to print
        }
        // first stamp of a track: a short dab along the travel direction
        push(s.x, s.y, ang, Math.min(w, 4), w, amount, k, seed);
        tracks.set(s.kind, { x: s.x, y: s.y, t: performance.now() });
      } else if (k === 2) {
        push(s.x, s.y, s.angle ?? 0, 0, w, amount, k, seed);
      } else {
        push(s.x, s.y, s.angle ?? 0, 0, w, amount, k, seed);
      }
    }
  }

  /** forget track continuity (teleport, reset, stamps stopped for a while) */
  function breakTracks() { tracks.clear(); }

  function render() {
    if (!rt) return;
    if (pending > 0) {
      iA.needsUpdate = true; iB.needsUpdate = true;
      iA.addUpdateRange(0, pending * 4); iB.addUpdateRange(0, pending * 4);
      stampGeo.instanceCount = pending;
      renderer.setRenderTarget(rt);
      renderer.render(stampScene, cam);
      renderer.setRenderTarget(null);
      pending = 0;
      dirty = true;
    }
    if (!dirty) return;
    renderer.setRenderTarget(null);
    renderer.clear(true, false, false);
    renderer.render(dispScene, cam);
    dirty = false;
  }

  function clear() {
    if (!rt) return;
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
    renderer.setRenderTarget(null);
    pending = 0; tracks.clear(); dirty = true;
  }

  return { canvas, renderer, attach, resize, addStamps, breakTracks, render, clear, get target() { return rt; } };
}

/**
 * Fake stamp source for ?smeartest: a robot-sized point driving a bounce-ish pattern over the page with a
 * decaying chocolate load, one splat at the start. Emits stamps in the sim's format.
 */
export function createSmearTest(W, H, { pxPerMeter = 440, seed = 3 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const st = { x: W * 0.5, y: H * 0.5, a: rnd() * Math.PI * 2, load: 1, t: 0, turn: 0, splatted: false, flingT: 0 };
  const half = 0.115 * pxPerMeter, brushW = 0.18 * pxPerMeter, v = 0.3 * pxPerMeter * 2.5; // 2.5x speed for the test
  return {
    get load() { return st.load; },
    step(dt) {
      const out = [];
      if (!st.splatted) { st.splatted = true; out.push({ kind: 'splat', x: st.x, y: st.y, angle: 0, w: 0.18 * pxPerMeter, amount: 1 }); }
      if (st.load < 0.01) return out;
      // wander + bounce off page edges like the bounce behaviour
      if (st.turn > 0) { const k = Math.min(st.turn, 2.2 * dt); st.a += k; st.turn -= k; }
      else st.a += Math.sin(st.t * 0.7) * 0.25 * dt;
      const nx = st.x + Math.cos(st.a) * v * dt, ny = st.y + Math.sin(st.a) * v * dt;
      const m = 0.2 * pxPerMeter;
      if (nx < m || nx > W - m || ny < 60 + m || ny > H - 90 - m) { if (st.turn <= 0) st.turn = 1.6 + rnd() * 1.6; }
      else { st.x = nx; st.y = ny; }
      const dist = v * dt / pxPerMeter;
      st.load *= Math.exp(-dist / 6);
      st.t += dt;
      const fx = Math.cos(st.a), fy = Math.sin(st.a), rx = -fy, ry = fx;
      const amt = st.load;
      out.push({ kind: 'wheelL', x: st.x - rx * half, y: st.y - ry * half, angle: st.a, w: 0.022 * pxPerMeter, amount: amt });
      out.push({ kind: 'wheelR', x: st.x + rx * half, y: st.y + ry * half, angle: st.a, w: 0.022 * pxPerMeter, amount: amt });
      out.push({ kind: 'brush', x: st.x - fx * 0.045 * pxPerMeter, y: st.y - fy * 0.045 * pxPerMeter, angle: st.a, w: brushW, amount: amt * 0.6 });
      st.flingT -= dt;
      if (st.flingT <= 0 && amt > 0.08) {
        st.flingT = 0.25 + rnd() * 0.6;
        // side brush at right-front, flung tangentially (outward-forward)
        const bx = st.x + fx * 0.095 * pxPerMeter + rx * 0.105 * pxPerMeter, by = st.y + fy * 0.095 * pxPerMeter + ry * 0.105 * pxPerMeter;
        const fa = st.a + 0.9 + rnd() * 0.8, d = 20 + rnd() * 60;
        out.push({ kind: 'fling', x: bx + Math.cos(fa) * d, y: by + Math.sin(fa) * d, angle: fa, w: 3 + rnd() * 5, amount: amt * (0.6 + rnd() * 0.6) });
      }
      return out;
    },
  };
}
