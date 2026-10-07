#!/usr/bin/env node
// scan-mac.mjs — reads THIS Mac's desktop (wallpaper, Dock, ~/Desktop, menu bar, system state)
// and writes everything the fake desktop needs into public/mac/.
//
//   npm run scan
//
// Output:
//   public/mac/wallpaper.jpg          current wallpaper (dark variant if the system is dark)
//   public/mac/dock.json              generic Dock (stock apps) + Trash with real icon PNGs, running dots
//   public/mac/desktop.json           ~/Desktop items with Finder positions, sizes, icon PNGs
//   public/mac/system.json            battery, appearance, clock format (English), display, menu bar
//   public/mac/icons/*.png            256px icons (apps, files, trash), SF Symbol glyphs
//
// Everything that touches AppKit goes through scripts/icon-helper.swift (compiled once into
// scripts/.bin/icon-helper): NSWorkspace icons, QuickLook thumbnails, SF Symbols, HEIC wallpaper
// conversion and the status-strip extraction.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'mac');
const ICONS = path.join(OUT, 'icons');
const HELPER_SRC = path.join(ROOT, 'scripts', 'icon-helper.swift');
const HELPER_BIN = path.join(ROOT, 'scripts', '.bin', 'icon-helper');
const HOME = os.homedir();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-mac-'));

fs.mkdirSync(ICONS, { recursive: true });

const log = (...a) => console.log('[scan]', ...a);
const warn = (...a) => console.warn('[scan] warning:', ...a);

function run(file, args = [], opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n$/, '');
}
const sh = (cmd) => run('/bin/zsh', ['-c', cmd]);
const osa = (script) => run('osascript', ['-e', script]);
const defaults = (domain, key) => run('defaults', key ? ['read', domain, key] : ['read', domain]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';

function plistExport(domain) {
  const f = path.join(TMP, `${slug(domain)}.plist`);
  return run('defaults', ['export', domain, f]) !== null ? f : null;
}
function plistExtract(file, keypath, fmt = 'raw') {
  return run('plutil', ['-extract', keypath, fmt, '-o', '-', file]);
}

// ---------------------------------------------------------------- helper binary
function ensureHelper() {
  const stale = !fs.existsSync(HELPER_BIN) ||
    fs.statSync(HELPER_BIN).mtimeMs < fs.statSync(HELPER_SRC).mtimeMs;
  if (!stale) return true;
  log('compiling icon-helper.swift …');
  fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
  const r = spawnSync('swiftc', ['-O', '-o', HELPER_BIN, HELPER_SRC], { encoding: 'utf8' });
  if (r.status !== 0) { warn('swiftc failed:\n' + r.stderr); return false; }
  return true;
}
const haveHelper = ensureHelper();
function helper(mode, px, pairs) {
  if (!haveHelper || pairs.length === 0) return null;
  // Flatten and run in chunks to keep argv reasonable.
  const out = [];
  for (let i = 0; i < pairs.length; i += 40) {
    const chunk = pairs.slice(i, i + 40).flat();
    const r = spawnSync(HELPER_BIN, [mode, String(px), ...chunk], { encoding: 'utf8', maxBuffer: 16 << 20 });
    if (r.status !== 0) warn(`icon-helper ${mode} failed:`, r.stderr.trim());
    else out.push(r.stdout);
  }
  return out.join('');
}

// ---------------------------------------------------------------- system
// Dark mode, or Automatic (which flips with the time of day): use the dark look so a recording
// does not change appearance depending on when the scan ran.
const dark = defaults('-g', 'AppleInterfaceStyle') === 'Dark' || defaults('-g', 'AppleInterfaceStyleSwitchesAutomatically') === '1';
// The page is always English (it is recorded for a video). The system locale is kept for the
// clock only when it is already an English one; otherwise en-US, 12-hour, like a stock US Mac.
const localeRaw = (defaults('-g', 'AppleLocale') || 'en_US').replace('_', '-').replace(/@.*$/, '');
const englishLocale = /^en(-|$)/i.test(localeRaw);
const locale = englishLocale ? localeRaw : 'en-US';
const languages = ['en-US'];
const force24 = englishLocale ? defaults('-g', 'AppleICUForce24HourTime') : null;
let hour12;
if (force24 === '1') hour12 = false;
else if (force24 === '0') hour12 = true;
else {
  try { hour12 = !!new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12; }
  catch { hour12 = true; }
}
const clockPrefs = {
  showAMPM: defaults('com.apple.menuextra.clock', 'ShowAMPM') !== '0',
  showDate: defaults('com.apple.menuextra.clock', 'ShowDate'),
  showDayOfWeek: defaults('com.apple.menuextra.clock', 'ShowDayOfWeek') !== '0',
  showSeconds: defaults('com.apple.menuextra.clock', 'ShowSeconds') === '1',
  isAnalog: defaults('com.apple.menuextra.clock', 'IsAnalog') === '1',
};
// ShowDate: 0 = "when space allows" (shown on wide bars), 1 = always, 2 = never.
clockPrefs.showDate = clockPrefs.showDate === null ? 0 : Number(clockPrefs.showDate);


const batt = run('pmset', ['-g', 'batt']) || '';
const battery = {
  percent: Number((batt.match(/(\d+)%/) || [])[1] ?? 100),
  charging: /charging|charged|AC Power/i.test(batt) && !/discharging/i.test(batt),
  onAC: /AC Power/i.test(batt),
  present: /InternalBattery/.test(batt),
};

const wifiOn = !!(run('ifconfig', ['en0']) || '').match(/status: active/);

// Displays: system_profiler JSON gives pixel resolution + which is main; built-in notch displays
// report "Retina" with no "UI Looks like"; external ones report "UI Looks like".
const displays = [];
try {
  const sp = JSON.parse(run('system_profiler', ['SPDisplaysDataType', '-json']) || '{}');
  for (const gpu of sp.SPDisplaysDataType || []) {
    for (const d of gpu.spdisplays_ndrvs || []) {
      // _spdisplays_pixels = device pixels, _spdisplays_resolution = points ("1728 x 1117 @ 120.00Hz")
      const px = (d._spdisplays_pixels || d.spdisplays_pixelresolution || '').match(/(\d+)\s*x\s*(\d+)/);
      const ui = (d._spdisplays_resolution || d.spdisplays_resolution || '').match(/(\d+)\s*x\s*(\d+)/);
      const builtIn = d.spdisplays_connection_type === 'spdisplays_internal' || /Color LCD|Built-in|Liquid Retina/i.test(d._name || '');
      const main = d.spdisplays_main === 'spdisplays_yes';
      const w = ui ? +ui[1] : px ? Math.round(+px[1] / 2) : 1728;
      const h = ui ? +ui[2] : px ? Math.round(+px[2] / 2) : 1117;
      displays.push({ name: d._name, pixelWidth: px ? +px[1] : null, pixelHeight: px ? +px[2] : null, width: w, height: h, main, builtIn, notch: builtIn && Math.abs(w / h - 1728 / 1117) < 0.01 });
    }
  }
} catch (e) { warn('system_profiler parse failed', e.message); }
const mainDisplay = displays.find((d) => d.main) || displays[0] || { width: 1728, height: 1117, builtIn: true, notch: true, main: true };

// Finder desktop view settings
const finderView = (() => {
  const f = plistExport('com.apple.finder');
  const g = (k) => (f ? plistExtract(f, `DesktopViewSettings.IconViewSettings.${k}`) : null);
  return {
    iconSize: Number(g('iconSize') ?? 64),
    gridSpacing: Number(g('gridSpacing') ?? 54),
    textSize: Number(g('textSize') ?? 12),
    labelOnBottom: (g('labelOnBottom') ?? 'true') !== 'false',
    arrangeBy: g('arrangeBy') ?? 'none',
    showItemInfo: g('showItemInfo') === 'true',
    showIconPreview: (g('showIconPreview') ?? 'true') !== 'false',
    showHardDrives: f ? plistExtract(f, 'ShowHardDrivesOnDesktop') === 'true' : false,
    showExternalDrives: f ? plistExtract(f, 'ShowExternalHardDrivesOnDesktop') === 'true' : false,
  };
})();

const accentRaw = defaults('-g', 'AppleAccentColor');
const ACCENTS = { '-1': 'graphite', 0: 'red', 1: 'orange', 2: 'yellow', 3: 'green', 4: 'blue', 5: 'purple', 6: 'pink' };
const accent = accentRaw === null ? 'blue' : ACCENTS[accentRaw] || 'blue';

// Finder menu titles in the system language. UI scripting needs Accessibility permission, so
// try it, then fall back to a small table.
const MENU_TITLES = {
  en: ['File', 'Edit', 'View', 'Go', 'Window', 'Help'],
  pl: ['Plik', 'Edycja', 'Widok', 'Idź', 'Okno', 'Pomoc'],
  de: ['Ablage', 'Bearbeiten', 'Darstellung', 'Gehe zu', 'Fenster', 'Hilfe'],
  fr: ['Fichier', 'Édition', 'Présentation', 'Aller', 'Fenêtre', 'Aide'],
  es: ['Archivo', 'Edición', 'Visualización', 'Ir', 'Ventana', 'Ayuda'],
  it: ['File', 'Modifica', 'Vista', 'Vai', 'Finestra', 'Aiuto'],
  nl: ['Archief', 'Wijzig', 'Weergave', 'Ga', 'Venster', 'Help'],
  pt: ['Arquivo', 'Editar', 'Visualizar', 'Ir', 'Janela', 'Ajuda'],
  sv: ['Arkiv', 'Redigera', 'Innehåll', 'Gå', 'Fönster', 'Hjälp'],
  ja: ['ファイル', '編集', '表示', '移動', 'ウインドウ', 'ヘルプ'],
};
const menuTitles = MENU_TITLES.en; // English UI regardless of the system language

// Which Control Center items are visible in the menu bar (used by the SVG fallback when the
// captured strip is unavailable).
const ccVisible = {};
{
  const raw = defaults('com.apple.controlcenter') || '';
  for (const m of raw.matchAll(/"NSStatusItem Visible ([^"]+)" = (\d);/g)) ccVisible[m[1]] = m[2] === '1';
  const host = run('defaults', ['-currentHost', 'read', 'com.apple.controlcenter']) || '';
  const bp = host.match(/BatteryShowPercentage = (\d);/);
  ccVisible.BatteryShowPercentage = bp ? bp[1] === '1' : false;
}

// ---------------------------------------------------------------- wallpaper
function findWallpaper() {
  const candidates = [];
  const fromSE = osa('tell application "System Events" to get picture of current desktop');
  if (fromSE) candidates.push(fromSE.trim());
  const store = path.join(HOME, 'Library/Application Support/com.apple.wallpaper');
  const walk = (dir, depth = 0) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(heic|jpe?g|png|tiff?)$/i.test(e.name)) candidates.push(p);
    }
  };
  walk(store);
  for (const p of candidates) if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  const sysPics = '/System/Library/Desktop Pictures';
  if (fs.existsSync(sysPics)) {
    const files = fs.readdirSync(sysPics).filter((f) => /\.(heic|jpe?g|png)$/i.test(f));
    const prefer = files.find((f) => /Tahoe|Sequoia|Sonoma|macOS/i.test(f)) || files[0];
    if (prefer) return path.join(sysPics, prefer);
  }
  return null;
}
let wallpaperSource = null;
{
  const src = findWallpaper();
  const out = path.join(OUT, 'wallpaper.jpg');
  if (src) {
    let ok = false;
    if (haveHelper) {
      const r = spawnSync(HELPER_BIN, ['wallpaper', src, out, '3840', dark ? 'dark' : 'light'], { encoding: 'utf8' });
      ok = r.status === 0;
    }
    if (!ok) {
      // sips fallback (first image of a HEIC)
      ok = run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', '-Z', '3840', src, '--out', out]) !== null;
    }
    if (ok) { wallpaperSource = src; log('wallpaper:', src); }
    else warn('could not convert wallpaper', src);
  } else warn('no wallpaper found');
}

// ---------------------------------------------------------------- Dock
const dockPlist = plistExport('com.apple.dock');
const dockPrefs = {
  tileSize: Number(defaults('com.apple.dock', 'tilesize') ?? 48),
  magnification: defaults('com.apple.dock', 'magnification') === '1',
  largeSize: Number(defaults('com.apple.dock', 'largesize') ?? 64),
  orientation: defaults('com.apple.dock', 'orientation') || 'bottom',
  autohide: defaults('com.apple.dock', 'autohide') === '1',
  showRecents: defaults('com.apple.dock', 'show-recents') === '1',
  minimizeToApp: defaults('com.apple.dock', 'minimize-to-application') === '1',
};

// Generic Dock: only the stock apps most people keep (no personal apps), in Apple's default order.
// Paths are resolved on this Mac so the icons are the real ones for this macOS version.
const POPULAR_APPS = [
  ['finder', 'Finder', ['/System/Library/CoreServices/Finder.app'], true],
  ['apps', 'Apps', ['/System/Applications/Apps.app', '/System/Applications/Launchpad.app'], false],
  ['safari', 'Safari', ['/Applications/Safari.app', '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app'], true],
  ['messages', 'Messages', ['/System/Applications/Messages.app'], true],
  ['mail', 'Mail', ['/System/Applications/Mail.app'], false],
  ['maps', 'Maps', ['/System/Applications/Maps.app'], false],
  ['photos', 'Photos', ['/System/Applications/Photos.app'], false],
  ['calendar', 'Calendar', ['/System/Applications/Calendar.app'], false],
  ['notes', 'Notes', ['/System/Applications/Notes.app'], true],
  ['music', 'Music', ['/System/Applications/Music.app'], true],
  ['app-store', 'App Store', ['/System/Applications/App Store.app'], false],
  ['system-settings', 'System Settings', ['/System/Applications/System Settings.app', '/System/Applications/System Preferences.app'], false],
];
const dockItems = [];
for (const [id, label, paths, running] of POPULAR_APPS) {
  const found = paths.find((x) => fs.existsSync(x));
  if (!found) { warn('dock app not on this Mac:', label); continue; }
  // /Applications/Safari.app is a symlink into the Safari cryptex; NSWorkspace would draw the
  // alias arrow on a symlink, so render the icon of the real bundle.
  const p = fs.realpathSync(found);
  dockItems.push({ id, label, path: p, kind: 'app', running, persistent: true, ...(id === 'calendar' ? { liveDate: true } : {}) });
}
const dockOthers = [];
// Dock icons via NSWorkspace (handles Assets.car icons, Electron apps, everything)
{
  const pairs = [];
  for (const d of [...dockItems, ...dockOthers]) {
    d.icon = `/mac/icons/dock-${d.id}.png`;
    pairs.push([d.path, path.join(ICONS, `dock-${d.id}.png`)]);
  }
  helper('icon', 256, pairs);
  for (const d of [...dockItems, ...dockOthers]) {
    if (!fs.existsSync(path.join(ICONS, `dock-${d.id}.png`))) {
      // last resort: .icns from the bundle via sips
      const plist = path.join(d.path, 'Contents', 'Info.plist');
      const iconFile = fs.existsSync(plist) ? (plistExtract(plist, 'CFBundleIconFile') || plistExtract(plist, 'CFBundleIconName')) : null;
      if (iconFile) {
        const icns = path.join(d.path, 'Contents', 'Resources', iconFile.endsWith('.icns') ? iconFile : iconFile + '.icns');
        if (fs.existsSync(icns)) run('sips', ['-s', 'format', 'png', '-z', '256', '256', icns, '--out', path.join(ICONS, `dock-${d.id}.png`)]);
      }
      if (!fs.existsSync(path.join(ICONS, `dock-${d.id}.png`))) { warn('no icon for', d.label); d.icon = null; }
    }
  }
}
// Trash
const trashCount = Number(osa('tell application "Finder" to count items of trash') ?? 0) > 0 ? 1 : 0;
{
  const res = '/System/Library/CoreServices/Dock.app/Contents/Resources';
  for (const [src, dst] of [['trashfull@2x.png', 'trash-full.png'], ['trashempty@2x.png', 'trash-empty.png']]) {
    const s = path.join(res, src);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(ICONS, dst));
    else helper('icon', 256, [[path.join(HOME, '.Trash'), path.join(ICONS, dst)]]);
  }
}
const dock = {
  ...dockPrefs,
  apps: dockItems,
  others: dockOthers,
  trash: { full: trashCount > 0, iconFull: '/mac/icons/trash-full.png', iconEmpty: '/mac/icons/trash-empty.png' },
};
fs.writeFileSync(path.join(OUT, 'dock.json'), JSON.stringify(dock, null, 2));
log(`dock: ${dockItems.length} stock apps (${dockItems.map((d) => d.label).join(', ')}), trash ${dock.trash.full ? 'full' : 'empty'}`);

// ---------------------------------------------------------------- Desktop items
// By default the desktop is FAKE (scripts/fake-desktop.py) so no personal file names end up in a video.
// Pass --real-desktop to mirror ~/Desktop instead.
if (!process.argv.includes('--real-desktop')) {
  execFileSync('python3', [path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-desktop.py')], { stdio: 'inherit' });
} else {
const DESKTOP = path.join(HOME, 'Desktop');
function finderDesktopItems() {
  const script = `
set AppleScript's text item delimiters to ""
tell application "Finder"
  set out to ""
  repeat with itm in (get every item of desktop)
    set p to desktop position of itm
    try
      set pp to POSIX path of (itm as alias)
    on error
      set pp to ""
    end try
    set out to out & (name of itm) & tab & (item 1 of p) & tab & (item 2 of p) & tab & (kind of itm) & tab & pp & linefeed
  end repeat
  return out
end tell`;
  const r = osa(script);
  if (!r) return null;
  return r.split('\n').filter(Boolean).map((line) => {
    const [name, x, y, kind, p] = line.split('\t');
    return { name, x: Number(x), y: Number(y), finderKind: kind, path: p || null };
  });
}
let items = finderDesktopItems();
let positionsFromFinder = !!items;
if (!items) {
  warn('Finder scripting unavailable; listing ~/Desktop directly');
  items = fs.readdirSync(DESKTOP).filter((n) => !n.startsWith('.') && n !== 'desktop.ini' && n !== 'Icon\r')
    .map((n) => ({ name: n, path: path.join(DESKTOP, n), x: null, y: null, finderKind: null }));
}
function duBytes(p) {
  const r = run('du', ['-sk', p]);
  if (!r) return 0;
  return Number(r.split('\t')[0]) * 1024;
}
function volumeUsedBytes(p) {
  const r = run('df', ['-k', p]);
  if (!r) return 0;
  const line = r.split('\n')[1] || '';
  const cols = line.trim().split(/\s+/);
  return Number(cols[2] || 0) * 1024;
}
function isICloudPartial(p) {
  // Finder shows the cloud badge when the item (or anything inside it) is a dataless placeholder.
  const r = run('find', [p, '-flags', '+dataless', '-print', '-quit']);
  if (r) return true;
  return fs.existsSync(p) && fs.readdirSync(path.dirname(p)).includes('.' + path.basename(p) + '.icloud');
}
const desktopItems = [];
for (const it of items) {
  const p = it.path || path.join(DESKTOP, it.name);
  let st;
  try { st = fs.statSync(p); } catch { warn('cannot stat', p); continue; }
  const isVolume = p === '/' || p.startsWith('/Volumes/');
  const isDir = st.isDirectory();
  const isApp = isDir && /\.app$/.test(p);
  const ext = isDir && !isApp ? '' : path.extname(it.name).slice(1).toLowerCase();
  const kind = isVolume ? 'volume' : isApp ? 'app' : isDir ? 'folder' : ext || 'file';
  const bytes = isVolume ? volumeUsedBytes(p) : isDir ? duBytes(p) : st.size;
  const id = slug(it.name);
  desktopItems.push({
    id, name: it.name, path: p, kind, ext, isFolder: isDir && !isApp, bytes,
    icloud: !isVolume && isICloudPartial(p),
    finderKind: it.finderKind,
    pos: it.x !== null && !Number.isNaN(it.x) ? { x: it.x, y: it.y } : null,
    icon: `/mac/icons/desk-${id}.png`,
  });
}
{
  const thumbs = desktopItems.filter((d) => !d.isFolder && d.kind !== 'volume' && d.kind !== 'app').map((d) => [d.path, path.join(ICONS, `desk-${d.id}.png`)]);
  const icons = desktopItems.filter((d) => d.isFolder || d.kind === 'volume' || d.kind === 'app').map((d) => [d.path, path.join(ICONS, `desk-${d.id}.png`)]);
  helper(finderView.showIconPreview ? 'thumb' : 'icon', 256, thumbs);
  helper('icon', 256, icons);
  for (const d of desktopItems) if (!fs.existsSync(path.join(ICONS, `desk-${d.id}.png`))) { warn('no icon for', d.name); d.icon = null; }
}
const desktop = {
  display: { width: mainDisplay.width, height: mainDisplay.height },
  positionsFromFinder,
  view: finderView,
  items: desktopItems,
};
fs.writeFileSync(path.join(OUT, 'desktop.json'), JSON.stringify(desktop, null, 2));
log(`desktop: ${desktopItems.length} items (${positionsFromFinder ? 'Finder positions' : 'grid fallback'})`);

}

// ---------------------------------------------------------------- menu bar status strip
const menubarHeight = mainDisplay.notch ? 37 : 24;
// The page draws a few standard status items (Wi-Fi, battery %, Spotlight, Control Center) from SF
// Symbols; the third-party glyphs of the real menu bar are not captured any more.
const status = null;
try { fs.rmSync(path.join(OUT, 'menubar-status.png'), { force: true }); } catch { /* ignore */ }
// SF Symbol glyphs for the status items + Apple logo.
const symbols = {};
{
  const want = [
    ['apple.logo', 14.5, 'medium'], ['wifi', 13, 'regular'], ['magnifyingglass', 13, 'regular'],
    ['switch.2', 13, 'regular'], ['battery.100percent', 13, 'regular'], ['battery.75percent', 13, 'regular'],
    ['battery.50percent', 13, 'regular'], ['battery.25percent', 13, 'regular'], ['battery.0percent', 13, 'regular'], ['battery.100percent.bolt', 13, 'regular'],
    ['speaker.wave.2.fill', 13, 'regular'], ['mic.fill', 13, 'regular'], ['moon.fill', 13, 'regular'],
    ['airplayvideo', 13, 'regular'], ['square.3.layers.3d', 13, 'regular'], ['icloud.and.arrow.down', 12, 'regular'],
  ];
  const args = want.flatMap(([n, pt, w]) => [n, String(pt), w, path.join(ICONS, `sym-${slug(n)}.png`)]);
  const r = haveHelper ? spawnSync(HELPER_BIN, ['symbol', '96', ...args], { encoding: 'utf8' }) : null;
  if (r && r.status === 0) {
    for (const line of r.stdout.split('\n')) {
      const [name, w, h] = line.trim().split(' ');
      if (name) symbols[name] = { src: `/mac/icons/sym-${slug(name)}.png`, w: Number(w), h: Number(h) };
    }
  }
}

// ---------------------------------------------------------------- system.json
const system = {
  scannedAt: new Date().toISOString(),
  macOS: { version: run('sw_vers', ['-productVersion']), build: run('sw_vers', ['-buildVersion']) },
  dark, accent, locale, languages, hour12,
  clock: clockPrefs,
  battery, wifi: { on: wifiOn },
  displays, mainDisplay,
  menubar: { height: menubarHeight, appleMenu: true, appName: 'Finder', menuTitles, status, controlCenter: ccVisible, symbols },
  wallpaper: wallpaperSource ? { name: path.basename(wallpaperSource).replace(/\.[^.]+$/, ''), src: '/mac/wallpaper.jpg' } : null,
};
fs.writeFileSync(path.join(OUT, 'system.json'), JSON.stringify(system, null, 2));
log(`system: ${dark ? 'dark' : 'light'}, ${locale}, ${hour12 ? '12h' : '24h'}, battery ${battery.percent}%, display ${mainDisplay.width}x${mainDisplay.height}${mainDisplay.notch ? ' (notch)' : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
