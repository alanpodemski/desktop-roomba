#!/usr/bin/env node
// ios-icons.mjs — builds the iPhone home screen assets for src/phone/ from this Mac's stock apps.
//
//   node scripts/ios-icons.mjs
//
// Output (public/ios/):
//   icons/<id>.png   180×180 px (60 pt @3x), edge-to-edge iOS squircle
//   icons/camera.svg drawn Camera icon (macOS has no Camera app; Photo Booth looks nothing like it)
//   apps.json        [{ id, label, icon, bytes, slot: {row,col} | null, dock: bool }]
//
// macOS 26 app icons are already the iOS continuous-corner squircle, drawn inside a 1024 canvas with
// the shape occupying exactly 824/1024 (100 px margin for the shadow). Rendering at 224 px and
// centre-cropping 180 px therefore yields the full-bleed 60 pt iOS icon. Only stock Apple apps are used;
// `bytes` is the bundle size from `du -sk`, which drives the icon's mass in the sim (20–320 g).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'ios');
const ICONS = path.join(OUT, 'icons');
const HELPER_SRC = path.join(ROOT, 'scripts', 'icon-helper.swift');
const HELPER_BIN = path.join(ROOT, 'scripts', '.bin', 'icon-helper');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-icons-'));
fs.mkdirSync(ICONS, { recursive: true });

const log = (...a) => console.log('[ios-icons]', ...a);
const warn = (...a) => console.warn('[ios-icons] warning:', ...a);
const run = (file, args) => {
  const r = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 16 << 20 });
  return r.status === 0 ? r.stdout : null;
};

// Home screen page 1 (4 × 4, three cells left empty in the middle area as open floor for the robot),
// then the dock. Labels are the iOS names.
//   id, label, candidate bundles, slot [row, col] or 'dock'
const APPS = [
  ['facetime', 'FaceTime', ['FaceTime'], [0, 0]],
  ['calendar', 'Calendar', ['Calendar'], [0, 1]],
  ['photos', 'Photos', ['Photos'], [0, 2]],
  ['camera', 'Camera', null, [0, 3]],
  ['clock', 'Clock', ['Clock'], [1, 0]],
  ['maps', 'Maps', ['Maps'], [1, 1]],
  ['weather', 'Weather', ['Weather'], [1, 2]],
  ['reminders', 'Reminders', ['Reminders'], [1, 3]],
  ['notes', 'Notes', ['Notes'], [2, 0]],
  ['app-store', 'App Store', ['App Store'], [2, 3]],
  ['podcasts', 'Podcasts', ['Podcasts'], [3, 0]],
  ['tv', 'TV', ['TV'], [3, 2]],
  ['settings', 'Settings', ['System Settings', 'System Preferences'], [3, 3]],
  ['phone', 'Phone', ['Phone', 'FaceTime'], 'dock'],
  ['safari', 'Safari', ['Safari'], 'dock'],
  ['messages', 'Messages', ['Messages'], 'dock'],
  ['music', 'Music', ['Music'], 'dock'],
];
const APP_DIRS = ['/System/Applications', '/Applications', '/System/Volumes/Preboot/Cryptexes/App/System/Applications'];

function findBundle(names) {
  for (const n of names) {
    for (const d of APP_DIRS) {
      const p = path.join(d, `${n}.app`);
      // /Applications/Safari.app is a symlink into the Safari cryptex: resolve it, or NSWorkspace
      // draws the alias arrow on the icon.
      if (fs.existsSync(p)) return fs.realpathSync(p);
    }
  }
  return null;
}

function ensureHelper() {
  const stale = !fs.existsSync(HELPER_BIN) || fs.statSync(HELPER_BIN).mtimeMs < fs.statSync(HELPER_SRC).mtimeMs;
  if (!stale) return true;
  log('compiling icon-helper.swift …');
  fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
  const r = spawnSync('swiftc', ['-O', '-o', HELPER_BIN, HELPER_SRC], { encoding: 'utf8' });
  if (r.status !== 0) { warn('swiftc failed:\n' + r.stderr); return false; }
  return true;
}

// iOS Camera icon: light grey tile, black camera body, glass lens. Drawn at 180 px, full-bleed
// (the page clips it to the squircle like the other icons).
const CAMERA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="180" height="180">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2f2f4"/><stop offset="1" stop-color="#b8b8bd"/></linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3a3c"/><stop offset="1" stop-color="#1c1c1e"/></linearGradient>
    <radialGradient id="glass" cx=".38" cy=".34" r=".75"><stop offset="0" stop-color="#5f7fa6"/><stop offset=".35" stop-color="#22324a"/><stop offset="1" stop-color="#05070b"/></radialGradient>
  </defs>
  <rect width="180" height="180" fill="url(#bg)"/>
  <path d="M30 62c0-7 5-12 12-12h22l8-11h36l8 11h22c7 0 12 5 12 12v66c0 7-5 12-12 12H42c-7 0-12-5-12-12z" fill="url(#body)"/>
  <rect x="122" y="60" width="14" height="7" rx="3.5" fill="#f2f2f4" opacity=".85"/>
  <circle cx="90" cy="95" r="33" fill="#d6d6da"/>
  <circle cx="90" cy="95" r="29" fill="#2c2c2e"/>
  <circle cx="90" cy="95" r="23" fill="url(#glass)"/>
  <circle cx="90" cy="95" r="10" fill="#0a0d12" opacity=".85"/>
  <ellipse cx="81" cy="86" rx="6" ry="4" fill="#fff" opacity=".55" transform="rotate(-35 81 86)"/>
</svg>
`;

const haveHelper = ensureHelper();
const apps = [];
const renders = [];
for (const [id, label, names, slot] of APPS) {
  const entry = { id, label, icon: null, bytes: 0, slot: slot === 'dock' ? null : { row: slot[0], col: slot[1] }, dock: slot === 'dock' };
  if (!names) {
    fs.writeFileSync(path.join(ICONS, `${id}.svg`), CAMERA_SVG);
    entry.icon = `/ios/icons/${id}.svg`;
    // the iOS Camera app is ≈ 30 MB; mass only, nothing personal
    entry.bytes = 30_000_000;
  } else {
    const bundle = findBundle(names);
    if (!bundle) { warn(`no bundle for ${label}`); apps.push(entry); continue; }
    entry.bytes = Number((run('du', ['-sk', bundle]) || '0').split('\t')[0]) * 1024;
    renders.push([bundle, path.join(TMP, `${id}.png`), id, entry]);
  }
  apps.push(entry);
}

if (haveHelper && renders.length) {
  const r = spawnSync(HELPER_BIN, ['icon', '224', ...renders.flatMap(([b, out]) => [b, out])], { encoding: 'utf8' });
  if (r.status !== 0) warn('icon-helper failed:', r.stderr);
}
for (const [, tmp, id, entry] of renders) {
  const out = path.join(ICONS, `${id}.png`);
  if (!fs.existsSync(tmp)) { warn(`no icon rendered for ${entry.label}`); continue; }
  // 224 px canvas → the squircle is the central 180.25 px: crop it out (sips crops around the centre)
  const ok = run('sips', ['-c', '180', '180', tmp, '--out', out]);
  if (ok === null) { warn(`crop failed for ${entry.label}`); continue; }
  entry.icon = `/ios/icons/${id}.png`;
}

// Status bar / search glyphs as SF Symbols (the same symbols iOS draws), white on transparent.
// symbol mode renders a 96 px tall canvas and prints the symbol's natural size in points.
const symbols = {};
if (haveHelper) {
  const want = [
    ['cellularbars', 12, 'semibold'], ['wifi', 12.5, 'semibold'], ['battery.100percent', 17, 'regular'],
    ['magnifyingglass', 13, 'semibold'], ['minus', 12, 'bold'],
  ];
  const slug = (n) => n.replace(/[^a-z0-9]+/gi, '-');
  const args = want.flatMap(([n, pt, w]) => [n, String(pt), w, path.join(ICONS, `sym-${slug(n)}.png`)]);
  const r = spawnSync(HELPER_BIN, ['symbol', '96', ...args], { encoding: 'utf8' });
  if (r.status === 0) {
    for (const line of r.stdout.split('\n')) {
      const [name, w, h] = line.trim().split(' ');
      if (name) symbols[name] = { src: `/ios/icons/sym-${slug(name)}.png`, w: Number(w), h: Number(h) };
    }
  } else warn('symbol rendering failed:', r.stderr);
}

fs.writeFileSync(path.join(OUT, 'apps.json'), JSON.stringify({ generatedAt: new Date().toISOString(), iconPx: 180, apps, symbols }, null, 2));
fs.rmSync(TMP, { recursive: true, force: true });
log(`${apps.filter((a) => a.icon).length}/${apps.length} icons → public/ios/icons, apps.json written`);
for (const a of apps) log(`  ${a.label.padEnd(10)} ${(a.bytes / 1e6).toFixed(1).padStart(7)} MB  ${a.dock ? 'dock' : `r${a.slot.row} c${a.slot.col}`}`);
