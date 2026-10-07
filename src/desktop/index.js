// Fake macOS desktop (DOM + CSS). See SPEC.md "Desktop API".
//
//   const desk = await createDesktop(document.getElementById('desktop'));
//   desk.getWalls()  desk.getIcons()  desk.getDock()  desk.setIconPosition(id, x, y, angle)
//   desk.onIconDragStart(cb)  desk.onIconDrag(cb)  desk.onIconDragEnd(cb)  desk.onResize(cb)
//   desk.setClock(date)
//
// Data comes from public/mac/*.json produced by `npm run scan`; without it the built-in
// fallback set in ./fallback.js is used so the page always renders.

import {
  FALLBACK_SYSTEM, FALLBACK_DOCK, FALLBACK_DESKTOP, FALLBACK_WALLPAPER_CSS, GLYPHS,
  FOLDER_ICON, GENERIC_DOC_ICON, IMAGE_ICON, PDF_ICON, MOVIE_ICON, HTML_ICON, VOLUME_ICON,
} from './fallback.js';

// Finder desktop grid for iconSize 48 / gridSpacing 32 on this Mac (measured): 72 × 88 cells,
// first column centred 40 px from the right edge, first row centred 69 px from the top.
const GRID = { colW: 72, rowH: 88, rightInset: 40, firstRowY: 69 };
const MENUBAR_NOTCH_ASPECT = 1728 / 1117;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

async function fetchJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
function loadImage(src, timeout = 4000) {
  return new Promise((resolve) => {
    if (!src) return resolve(false);
    const img = new Image();
    const t = setTimeout(() => resolve(false), timeout);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = src;
  });
}

// Mean luminance (0..1) of the top strip of an image, i.e. what sits behind the menu bar.
function sampleTopLuminance(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 4;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      // background-size: cover on a landscape page crops the top/bottom of a square image; the
      // menu bar covers ≈ the top 3 % of the page, which is ≈ 20 % into the image here.
      const pageAspect = (window.innerWidth || 16) / (window.innerHeight || 10);
      const visibleH = Math.min(img.height, img.width / pageAspect);
      const y0 = (img.height - visibleH) / 2;
      ctx.drawImage(img, 0, y0, img.width, visibleH * 0.035, 0, 0, 64, 4);
      const d = ctx.getImageData(0, 0, 64, 4).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      resolve(sum / (d.length / 4));
    };
    img.onerror = reject;
    img.src = src;
  });
}

// Mass from byte size: log scale, 0.05 kg for 0 bytes → 5 kg at ≥ 1 GB, clamped.
export function massFromBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  const t = clamp(Math.log10(b + 1) / 9, 0, 1);      // 0 … 1 over 0 … 1e9
  return clamp(0.05 * Math.pow(100, t), 0.05, 5);     // 0.05 × 100^t → 5 kg at 1 GB
}

function genericIconFor(item) {
  if (item.kind === 'volume') return VOLUME_ICON;
  if (item.isFolder || item.kind === 'folder') return FOLDER_ICON;
  const ext = (item.ext || item.kind || '').toLowerCase();
  if (/^(jpe?g|png|gif|heic|webp|tiff?)$/.test(ext)) return IMAGE_ICON;
  if (ext === 'pdf') return PDF_ICON;
  if (/^(mov|mp4|m4v|avi|mkv)$/.test(ext)) return MOVIE_ICON;
  if (/^(html?|css|js)$/.test(ext)) return HTML_ICON;
  return GENERIC_DOC_ICON;
}

// ------------------------------------------------------------------ clock formatting
function makeClockFormatter(system) {
  const locale = system.locale || 'en-US';
  const hour12 = system.hour12 === undefined || system.hour12 === null
    ? undefined
    : !!system.hour12;
  const prefs = system.clock || {};
  let weekdayFmt, dateFmt, timeFmt;
  try {
    weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
    timeFmt = new Intl.DateTimeFormat(locale, {
      hour: hour12 === undefined ? 'numeric' : '2-digit', minute: '2-digit',
      ...(prefs.showSeconds ? { second: '2-digit' } : {}),
      ...(hour12 === undefined ? {} : { hour12 }),
    });
  } catch {
    weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
    dateFmt = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });
    timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const cap = (s) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
  return (date, wide) => {
    const parts = [];
    const showDate = prefs.showDate === 1 || (prefs.showDate === 0 && wide) || prefs.showDate === undefined;
    if (prefs.showDayOfWeek !== false) parts.push(cap(weekdayFmt.format(date)));
    if (showDate) parts.push(dateFmt.format(date).replace(/,/g, ''));
    let time = timeFmt.format(date);
    if (hour12 && prefs.showAMPM === false) time = time.replace(/\s?[AP]M$/i, '');
    // macOS puts a wider gap between the date and the time.
    return (parts.length ? parts.join(' ') + '  ' : '') + time;
  };
}

// ------------------------------------------------------------------ label layout (Finder style)
// Two lines, word-wrapped; if the name still does not fit, the second line is middle-truncated
// with "…" keeping the last 5 characters (as Finder does: "Scre…5.mov").
const CLOUD_TOKEN = '\u2601'; // placeholder for the iCloud badge, laid out like a trailing word
const CLOUD_W = 20;             // badge width incl. its gap, px
function makeLabelLayout(font, maxWidth) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const width = (s) => {
    const clouds = (s.match(new RegExp(CLOUD_TOKEN, 'g')) || []).length;
    return ctx.measureText(s.replaceAll(CLOUD_TOKEN, '')).width + clouds * CLOUD_W;
  };
  const fits = (s) => width(s) <= maxWidth;
  const breakWord = (word) => {
    // the iCloud badge is glued to the last word; if only the badge overflows, it wraps alone
    if (word.endsWith(CLOUD_TOKEN) && fits(word.slice(0, -1))) return [word.slice(0, -1), CLOUD_TOKEN];
    // longest prefix that fits
    let lo = 1, hi = word.length, best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(word.slice(0, mid))) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return [word.slice(0, best), word.slice(best)];
  };
  const middleTruncate = (s) => {
    const tailLen = Math.min(5, s.length - 1);
    const tail = s.slice(s.length - tailLen);
    let head = s.slice(0, s.length - tailLen);
    while (head.length > 0 && !fits(head + '…' + tail)) head = head.slice(0, -1);
    return head + '…' + tail;
  };
  return (name) => {
    if (fits(name)) return [name];
    // tokens keep their separators attached so joins reproduce the original string
    const tokens = name.match(/[^\s-]+[\s-]*|[\s-]+/g) || [name];
    let line1 = '';
    let i = 0;
    for (; i < tokens.length; i++) {
      const candidate = line1 + tokens[i];
      if (fits(candidate.trimEnd())) line1 = candidate;
      else break;
    }
    let rest;
    if (line1 === '') {
      // first token alone is too long → break it mid-word
      const [a, b] = breakWord(tokens[0]);
      line1 = a; rest = b + tokens.slice(1).join('');
    } else {
      rest = tokens.slice(i).join('');
    }
    line1 = line1.trimEnd();
    rest = rest.trimStart();
    if (rest === '') return [line1];
    if (fits(rest)) return [line1, rest];
    return [line1, middleTruncate(rest)];
  };
}

// ================================================================== createDesktop
export async function createDesktop(root) {
  root.classList.add('dk-root');
  root.innerHTML = '';

  // ------------------------------------------------------------ data
  const useFallback = new URLSearchParams(location.search).has('fallback'); // ?fallback=1: ignore the scan
  const [sysJSON, dockJSON, deskJSON] = useFallback ? [null, null, null] : await Promise.all([
    fetchJSON('/mac/system.json'), fetchJSON('/mac/dock.json'), fetchJSON('/mac/desktop.json'),
  ]);
  const system = { ...FALLBACK_SYSTEM, ...(sysJSON || {}) };
  system.menubar = { ...FALLBACK_SYSTEM.menubar, ...((sysJSON && sysJSON.menubar) || {}) };
  const dock = dockJSON && Array.isArray(dockJSON.apps) && dockJSON.apps.length ? dockJSON : FALLBACK_DOCK;
  const deskData = deskJSON && Array.isArray(deskJSON.items) ? deskJSON : FALLBACK_DESKTOP;
  const dark = system.dark !== false;
  const scanned = !!sysJSON;

  // ------------------------------------------------------------ geometry helpers
  let W = root.clientWidth || window.innerWidth;
  let H = root.clientHeight || window.innerHeight;
  const hasNotch = () => {
    const q = new URLSearchParams(location.search);
    if (q.has('notch')) return q.get('notch') !== '0';
    return Math.abs(W / H - MENUBAR_NOTCH_ASPECT) < 0.012;
  };
  let menubarH = hasNotch() ? 37 : 24;
  const applyMenubarVars = () => {
    root.style.setProperty('--mb-h', `${menubarH}px`);
    root.style.setProperty('--mb-text-h', `${menubarH === 37 ? 31 : 24}px`);
  };
  applyMenubarVars();

  // ------------------------------------------------------------ wallpaper
  const wallpaper = el('div', 'dk-wallpaper', root);
  let wallpaperTopIsLight = !dark && !scanned;
  {
    const src = (system.wallpaper && system.wallpaper.src) || '/mac/wallpaper.jpg';
    const ok = await loadImage(src, 8000);
    wallpaper.style.backgroundImage = ok ? `url(${src})` : FALLBACK_WALLPAPER_CSS;
    if (ok) wallpaperTopIsLight = await sampleTopLuminance(src).then((l) => l > 0.62).catch(() => false);
  }

  // ------------------------------------------------------------ floor layer
  // Between the wallpaper and the icons: things lying on the desk surface (cake smear) go here, so
  // icons — the furniture — slide over them. Never takes pointer events.
  const floorLayer = el('div', 'dk-floor', root);

  // ------------------------------------------------------------ icons layer
  const iconsLayer = el('div', 'dk-icons', root);

  // ------------------------------------------------------------ menu bar
  const menubar = el('div', `dk-menubar${wallpaperTopIsLight ? ' dk-light' : ''}`, root);
  const glyphInvert = wallpaperTopIsLight ? 'invert(1)' : '';
  const mbLeft = el('div', 'dk-mb-left', menubar);
  const apple = el('div', 'dk-mb-item dk-mb-apple', mbLeft);
  {
    const sym = system.menubar.symbols && system.menubar.symbols['apple.logo'];
    if (sym && scanned && await loadImage(sym.src)) {
      const img = el('img', '', apple); img.src = sym.src; img.alt = '';
      img.style.height = `${(sym.h || 15) * 1.05}px`;
      img.style.filter = glyphInvert;
    } else {
      apple.innerHTML = GLYPHS.apple;
    }
  }
  const appTitle = el('div', 'dk-mb-item dk-mb-app', mbLeft);
  appTitle.textContent = system.menubar.appName || 'Finder';
  for (const t of system.menubar.menuTitles || FALLBACK_SYSTEM.menubar.menuTitles) {
    el('div', 'dk-mb-item', mbLeft).textContent = t;
  }
  const mbRight = el('div', 'dk-mb-right', menubar);
  const status = el('div', 'dk-mb-status', mbRight);
  {
    // A stock set of status items, in macOS's default order: battery with %, Wi‑Fi, Spotlight,
    // Control Center, then the clock. SF Symbols rendered by the scan; inline SVG before a scan.
    const symbols = (scanned && system.menubar.symbols) || {};
    const glyph = (name, svgFallback, cls = '') => {
      const g = el('div', `dk-mb-glyph ${cls}`.trim(), status);
      const sym = symbols[name];
      if (sym) {
        const img = el('img', '', g); img.src = sym.src; img.alt = '';
        img.style.height = `${sym.h}px`; img.style.width = `${sym.w}px`;
        img.style.filter = glyphInvert;
      } else g.innerHTML = svgFallback;
      return g;
    };
    if (!system.battery || system.battery.present !== false) {
      const pct = Math.round((system.battery && system.battery.percent) ?? 100);
      const b = el('div', 'dk-mb-glyph dk-mb-battery', status);
      el('span', 'dk-pct', b).textContent = `${pct}%`;
      const level = pct >= 88 ? 100 : pct >= 63 ? 75 : pct >= 38 ? 50 : pct >= 13 ? 25 : 0;
      const sym = symbols[`battery.${level}percent`];
      if (sym) {
        const img = el('img', '', b); img.src = sym.src; img.alt = '';
        img.style.height = `${sym.h}px`; img.style.width = `${sym.w}px`; img.style.filter = glyphInvert;
      } else el('span', '', b).innerHTML = GLYPHS.battery(pct);
    }
    glyph('wifi', GLYPHS.wifi);
    glyph('magnifyingglass', GLYPHS.search);
    glyph('switch.2', GLYPHS.controlCenter);
  }
  const clockEl = el('div', 'dk-mb-item dk-mb-clock', mbRight);
  const formatClock = makeClockFormatter(system);
  const setClock = (date = new Date()) => {
    clockEl.textContent = formatClock(date, W >= 1200);
    updateCalendar(date);
  };

  // ------------------------------------------------------------ Dock
  const dockEl = el('div', `dk-dock${dark ? '' : ' dk-light'}`, root);
  const tileSize = dock.tileSize || 51;
  root.style.setProperty('--dock-tile', `${tileSize}px`);
  const tiles = [];
  const calendarFaces = [];
  const updateCalendar = (date) => {
    for (const f of calendarFaces) {
      f.firstChild.textContent = date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      f.lastChild.textContent = String(date.getDate());
    }
  };
  const addTile = (item, src) => {
    const t = el('div', 'dk-tile', dockEl);
    t.setAttribute('aria-label', item.label || '');
    const img = el('img', '', t);
    img.src = src; img.alt = item.label || ''; img.draggable = false;
    if (item.liveDate) {
      // The Dock draws Calendar with today's date; the bundle's static icon has a dotted grid.
      const face = el('div', 'dk-cal', t);
      el('div', 'dk-cal-wd', face);
      el('div', 'dk-cal-day', face);
      calendarFaces.push(face);
    }
    if (item.running) el('div', 'dk-dot', t);
    if (item.badge) el('div', 'dk-badge', t).textContent = String(item.badge);
    tiles.push(t);
    return t;
  };
  const apps = dock.apps || [];
  for (const a of apps) addTile(a, a.icon || FALLBACK_DOCK.apps[0].icon);
  const others = dock.others || [];
  if (apps.length && (others.length || dock.trash)) el('div', 'dk-divider', dockEl);
  for (const o of others) addTile(o, o.icon || FOLDER_ICON);
  const trash = dock.trash || FALLBACK_DOCK.trash;
  addTile({ label: 'Trash' }, trash.full ? trash.iconFull : trash.iconEmpty);
  setClock(new Date());
  // Shrink the whole Dock if it would not fit (macOS does the same).
  const fitDock = () => {
    const natural = dockEl.scrollWidth;
    const scale = Math.min(1, (W - 24) / Math.max(1, natural));
    dockEl.style.transform = `translateX(-50%) scale(${scale})`;
    dockEl.style.transformOrigin = '50% 100%';
  };

  // ------------------------------------------------------------ desktop icons
  const view = deskData.view || FALLBACK_DESKTOP.view;
  const iconSize = Number(view.iconSize) || 48;
  root.style.setProperty('--icon', `${iconSize}px`);
  const labelPx = Number(view.textSize) || 10;
  root.style.setProperty('--label-size', `${labelPx}px`);
  root.style.setProperty('--label-lh', `${Math.round(labelPx * 1.25 * 2) / 2}px`);
  const labelMaxWidth = 68; // Finder wraps desktop labels at ~68 px for 72 px columns (measured)
  const layoutLabel = makeLabelLayout(`700 ${labelPx}px -apple-system, BlinkMacSystemFont, system-ui, "Helvetica Neue", sans-serif`, labelMaxWidth);

  const srcDisplay = deskData.display || { width: 1728, height: 1117 };
  const icons = new Map(); // id -> record

  // Finder grid fallback: top-right, columns from the right, fill downwards.
  function gridPositions(count) {
    const out = [];
    const rows = Math.max(1, Math.floor((H - 76 - GRID.firstRowY - 20) / GRID.rowH) + 1);
    for (let i = 0; i < count; i++) {
      const col = Math.floor(i / rows), row = i % rows;
      out.push({ x: W - GRID.rightInset - col * GRID.colW, y: GRID.firstRowY + row * GRID.rowH });
    }
    return out;
  }

  function buildIcon(item, index) {
    const node = el('div', 'dk-icon', iconsLayer);
    node.dataset.id = item.id;
    const imgWrap = el('div', 'dk-icon-img', node);
    const img = el('img', '', imgWrap);
    img.alt = ''; img.draggable = false;
    img.src = item.icon || genericIconFor(item);
    img.onerror = () => { img.onerror = null; img.src = genericIconFor(item); };
    const label = el('div', 'dk-icon-label', node);
    const lines = layoutLabel(item.icloud ? item.name + CLOUD_TOKEN : item.name);
    lines.forEach((ln) => {
      const span = el('span', 'dk-line', label);
      const hasCloud = ln.includes(CLOUD_TOKEN);
      span.textContent = ln.replaceAll(CLOUD_TOKEN, '').trimEnd();
      if (hasCloud) {
        const c = el('span', 'dk-cloud', span);
        const sym = scanned && system.menubar.symbols && system.menubar.symbols['icloud.and.arrow.down'];
        if (sym) { const im = el('img', '', c); im.src = sym.src; im.alt = ''; }
        else c.innerHTML = GLYPHS.cloud;
      }
    });
    const rec = {
      id: item.id, name: item.name, kind: item.kind || (item.isFolder ? 'folder' : 'file'),
      bytes: item.bytes || 0, massKg: massFromBytes(item.bytes),
      node, w: iconSize, h: iconSize,
      // Finder position (centre of the icon) in the scanned display's coordinates, if known.
      finderPos: item.pos && Number.isFinite(item.pos.x) ? { x: item.pos.x, y: item.pos.y } : null,
      index,
      x: 0, y: 0, angle: 0, moved: false,
    };
    icons.set(item.id, rec);
    return rec;
  }
  const items = deskData.items || [];
  items.forEach((it, i) => buildIcon(it, i));

  function applyTransform(rec) {
    rec.node.style.transform =
      `translate3d(${rec.x - rec.w / 2}px, ${rec.y - rec.h / 2}px, 0) rotate(${rec.angle}rad)`;
  }
  // ---- Finder grid + occupancy -------------------------------------------------------------
  // Cell centres: x = W − 40 − 72·col, y = 69 + 88·row. A cell is usable while the icon and its
  // two-line label stay above the Dock and the icon stays clear of the robot's station on the left.
  const LABEL_BELOW = 7 + 2 * 12.5 + 2;          // gap + two label lines + shadow
  const yMaxCentre = () => H - 76 - LABEL_BELOW - iconSize / 2;
  const xMinCentre = () => Math.min(W / 2, 260);
  const cellX = (c) => W - GRID.rightInset - c * GRID.colW;
  const cellY = (r) => GRID.firstRowY + r * GRID.rowH;
  const maxRow = () => Math.max(0, Math.floor((yMaxCentre() - GRID.firstRowY) / GRID.rowH));
  const maxCol = () => Math.max(0, Math.floor((W - GRID.rightInset - xMinCentre()) / GRID.colW));
  // two icons overlap (would hide each other's hit area) when their cells intersect
  const overlaps = (ax, ay, bx, by) => Math.abs(ax - bx) < GRID.colW - 8 && Math.abs(ay - by) < GRID.rowH - 8;
  const isFree = (x, y, others) => others.every((o) => !overlaps(x, y, o.x, o.y));
  // nearest free grid cell to (x, y); Finder-like preference for the same column, then rows nearby
  function nearestFreeCell(x, y, others) {
    const c0 = clamp(Math.round((W - GRID.rightInset - x) / GRID.colW), 0, maxCol());
    const r0 = clamp(Math.round((y - GRID.firstRowY) / GRID.rowH), 0, maxRow());
    let best = null, bestD = Infinity;
    for (let c = 0; c <= maxCol(); c++) {
      for (let r = 0; r <= maxRow(); r++) {
        const cx = cellX(c), cy = cellY(r);
        if (!isFree(cx, cy, others)) continue;
        const d = Math.hypot((c - c0) * GRID.colW, (r - r0) * GRID.rowH) + (c !== c0 ? 1 : 0);
        if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
      }
    }
    return best;
  }
  // nearest free free-floating spot (for strays and icons the robot left lying around)
  function nearestFreeSpot(x, y, others) {
    if (isFree(x, y, others)) return { x, y };
    for (let rad = 12; rad < Math.max(W, H); rad += 12) {
      const n = Math.max(8, Math.round((2 * Math.PI * rad) / 24));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
        if (px < xMinCentre() || px > W - iconSize / 2 - 4 || py < menubarH + iconSize / 2 + 8 || py > yMaxCentre()) continue;
        if (isFree(px, py, others)) return { x: px, y: py };
      }
    }
    return { x, y };
  }

  function placeFromFinder() {
    const placed = [];
    const grid = gridPositions(items.length);
    let gi = 0;
    const recs = [...icons.values()];
    // grid-anchored icons first (they own their cells), strays after
    const isStray = (rec) => rec.finderPos && srcDisplay.width - rec.finderPos.x > 320;
    for (const rec of [...recs.filter((r) => !isStray(r)), ...recs.filter(isStray)]) {
      let x, y;
      if (rec.finderPos && isStray(rec)) {
        // icons dragged out into the open floor keep their relative spot on any window size,
        // and stay clear of the robot's charging station at the left edge
        x = clamp((rec.finderPos.x / srcDisplay.width) * W, xMinCentre(), W - iconSize);
        y = clamp((rec.finderPos.y / srcDisplay.height) * H, menubarH + iconSize, yMaxCentre());
        ({ x, y } = nearestFreeSpot(x, y, placed));
      } else {
        // Finder anchors the desktop grid to the right edge; keep that when the page is wider.
        if (rec.finderPos) { x = W - (srcDisplay.width - rec.finderPos.x); y = rec.finderPos.y; }
        else ({ x, y } = grid[gi++]);
        const cell = nearestFreeCell(x, y, placed);
        if (cell) ({ x, y } = cell);
        else ({ x, y } = nearestFreeSpot(x, Math.min(y, yMaxCentre()), placed));
      }
      rec.x = x; rec.y = y; rec.angle = 0; rec.moved = false;
      rec.node.classList.remove('dk-moved');
      applyTransform(rec);
      placed.push(rec);
    }
  }
  placeFromFinder();

  // ------------------------------------------------------------ selection + drag
  const cbs = { dragStart: [], drag: [], dragEnd: [], resize: [] };
  let selected = null;
  const select = (rec) => {
    if (selected && selected !== rec) selected.node.classList.remove('dk-selected');
    selected = rec;
    if (rec) rec.node.classList.add('dk-selected');
  };
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.dk-icon')) return;
    select(null);
  });
  // Finder's "snap to grid" on drop (arrangeBy = grid): the nearest *free* cell, so a drop never
  // hides another icon (a hidden icon cannot be grabbed).
  const snap = (rec) => {
    const others = [...icons.values()].filter((o) => o !== rec);
    return nearestFreeCell(rec.x, rec.y, others) || nearestFreeSpot(rec.x, rec.y, others);
  };
  let zTop = 1;
  let activeDrag = null; // only one pointer drags at a time, like Finder

  function startPress(rec, e) {
    if (activeDrag) activeDrag.finish();
    const node = rec.node;
    const pid = e.pointerId;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    let grabDX = 0, grabDY = 0;
    // Capture keeps events coming even when the pointer outruns the icon or crosses the robot's
    // canvas. The node must not be moved in the DOM while it holds capture: re-inserting it
    // (appendChild to raise it) silently releases capture — that was why drags died after one move.
    try { node.setPointerCapture(pid); } catch { /* synthetic pointers have no capture */ }
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 3) return;
        dragging = true;
        // grab offset relative to where the icon is *now* (the robot may have shoved it meanwhile)
        grabDX = rec.x - startX; grabDY = rec.y - startY;
        node.classList.add('dk-dragging');
        node.style.zIndex = String(1000 + ++zTop); // raise without touching the DOM order
        for (const cb of cbs.dragStart) cb(rec.id);
      }
      rec.x = clamp(ev.clientX + grabDX, 0, W);
      rec.y = clamp(ev.clientY + grabDY, menubarH, H);
      applyTransform(rec);
      for (const cb of cbs.drag) cb(rec.id, rec.x, rec.y);
    };
    const up = (ev) => { if (ev.pointerId === pid) finish(); };
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      activeDrag = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', finish);
      try { if (node.hasPointerCapture(pid)) node.releasePointerCapture(pid); } catch { /* ignore */ }
      if (!dragging) return;
      node.classList.remove('dk-dragging');
      node.style.zIndex = String(++zTop); // the icon you moved last stays on top, as in Finder
      if ((view.arrangeBy || 'grid') === 'grid') {
        const s = snap(rec);
        rec.x = s.x; rec.y = s.y;
        applyTransform(rec);
        for (const cb of cbs.drag) cb(rec.id, rec.x, rec.y);
      }
      for (const cb of cbs.dragEnd) cb(rec.id);
    }
    // Window-level capture-phase listeners: they work with or without pointer capture and are not
    // affected by anything layered above the icons.
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', finish);
    activeDrag = { finish };
  }

  // One delegated listener on the icons layer: every icon — including Macintosh HD, icons the robot
  // pushed or rotated, and icons created later — is draggable through the same path.
  iconsLayer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const node = e.target.closest('.dk-icon');
    if (!node) return;
    const rec = icons.get(node.dataset.id);
    if (!rec) return;
    e.preventDefault();
    select(rec);
    startPress(rec, e);
  });

  // ------------------------------------------------------------ Dock geometry + robot dock
  const dockRect = () => {
    const r = dockEl.getBoundingClientRect();
    const rootR = root.getBoundingClientRect();
    const x = r.left - rootR.left, y = r.top - rootR.top;
    // include the bottom margin so the robot cannot slip under the bar
    return { x, y, w: r.width, h: H - y };
  };
  const robotDock = () => {
    // Left edge at mid-height, well clear of the Dock bar and of icons parked along the bottom; the
    // station faces into the room, so the robot drives in heading -x (angle = π).
    const top = menubarH;
    const x = 80;
    const y = Math.round((top + H) / 2);
    return { x, y, angle: Math.PI };
  };

  // ------------------------------------------------------------ resize
  let resizeTimer = null;
  const relayout = () => {
    W = root.clientWidth || window.innerWidth;
    H = root.clientHeight || window.innerHeight;
    const nb = hasNotch() ? 37 : 24;
    if (nb !== menubarH) { menubarH = nb; applyMenubarVars(); }
    fitDock();
    placeFromFinder();
    setClock(new Date());
    for (const cb of cbs.resize) cb({ width: W, height: H });
  };
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 60);
  });
  // first layout once the Dock images have sizes. rAF never fires in a hidden tab, so do not let
  // a page opened in the background hang the boot on it.
  await new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
  fitDock();

  // ------------------------------------------------------------ public API
  return {
    getWalls() {
      const d = dockRect();
      return [
        { x: 0, y: 0, w: W, h: menubarH },
        { x: d.x, y: d.y, w: d.w, h: d.h },
      ];
    },
    getIcons() {
      return [...icons.values()].map((r) => ({
        id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, massKg: r.massKg, name: r.name, kind: r.kind,
        angle: r.angle, bytes: r.bytes,
      }));
    },
    getDock: robotDock,
    setIconPosition(id, x, y, angle = 0) {
      const rec = icons.get(id);
      if (!rec || rec.node.classList.contains('dk-dragging')) return; // the user's hand wins
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      rec.x = x; rec.y = y; rec.angle = angle || 0;
      if (!rec.moved && (Math.abs(rec.angle) > 1e-3)) { rec.moved = true; rec.node.classList.add('dk-moved'); }
      applyTransform(rec);
    },
    onIconDragStart(cb) { cbs.dragStart.push(cb); return () => cbs.dragStart.splice(cbs.dragStart.indexOf(cb), 1); },
    onIconDrag(cb) { cbs.drag.push(cb); return () => cbs.drag.splice(cbs.drag.indexOf(cb), 1); },
    onIconDragEnd(cb) { cbs.dragEnd.push(cb); return () => cbs.dragEnd.splice(cbs.dragEnd.indexOf(cb), 1); },
    onResize(cb) { cbs.resize.push(cb); return () => cbs.resize.splice(cbs.resize.indexOf(cb), 1); },
    setClock,
    /** Element between the wallpaper and the icons for things lying on the floor (cake smear).
     *  Full-page, position:absolute, pointer-events:none; put a canvas inside it. */
    getFloorLayer() { return floorLayer; },
    // extras (not in the spec, harmless): page size, menubar height, scanned data
    getSize() { return { width: W, height: H, menubarHeight: menubarH }; },
    data: { system, dock, desktop: deskData, scanned },
    relayout,
  };
}

export default createDesktop;
