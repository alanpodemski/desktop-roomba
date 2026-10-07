// Built-in fallback set so the page works before `npm run scan` has generated public/mac/.
// Generic icons are inline SVG data URIs; the layout code treats them exactly like scanned PNGs.

const svg = (body, size = 256) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`,
  )}`;

// macOS-style blue folder (dark appearance tint)
export const FOLDER_ICON = svg(`
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fcdf7"/><stop offset="1" stop-color="#3fa9e8"/></linearGradient>
    <linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fdcfb"/><stop offset="1" stop-color="#5bbdf1"/></linearGradient>
  </defs>
  <path d="M24 60c0-8 6-14 14-14h58l20 18h102c8 0 14 6 14 14v120c0 8-6 14-14 14H38c-8 0-14-6-14-14z" fill="url(#b)"/>
  <path d="M24 92c0-6 5-11 11-11h186c6 0 11 5 11 11v106c0 8-6 14-14 14H38c-8 0-14-6-14-14z" fill="url(#f)"/>
  <path d="M24 92c0-6 5-11 11-11h186c6 0 11 5 11 11v4H24z" fill="#fff" opacity=".25"/>
`);

const doc = (accent, label, extra = '') => svg(`
  <defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fdfdfd"/><stop offset="1" stop-color="#e6e6e6"/></linearGradient></defs>
  <path d="M64 20h92l48 48v160c0 6-4 10-10 10H64c-6 0-10-4-10-10V30c0-6 4-10 10-10z" fill="url(#p)"/>
  <path d="M156 20v38c0 6 4 10 10 10h38z" fill="#c9c9c9"/>
  ${extra}
  <rect x="78" y="190" width="100" height="26" rx="6" fill="${accent}"/>
  <text x="128" y="209" font-family="-apple-system, Helvetica, Arial" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>
`);

export const GENERIC_DOC_ICON = doc('#8e8e93', 'TXT', `
  <g stroke="#b5b5b5" stroke-width="5" stroke-linecap="round"><path d="M80 100h96M80 122h96M80 144h70"/></g>`);
export const IMAGE_ICON = doc('#30a7ff', 'JPEG', `
  <rect x="76" y="90" width="104" height="80" rx="6" fill="#dbe9f6"/>
  <circle cx="104" cy="114" r="10" fill="#f6c343"/>
  <path d="M76 170l36-40 24 26 20-18 24 32z" fill="#4c9f6a"/>`);
export const PDF_ICON = doc('#e2442f', 'PDF', `
  <g stroke="#c9c9c9" stroke-width="5" stroke-linecap="round"><path d="M80 100h96M80 122h96M80 144h50"/></g>`);
export const MOVIE_ICON = doc('#5e5ce6', 'MOV', `
  <rect x="76" y="90" width="104" height="76" rx="6" fill="#1c1c1e"/>
  <path d="M116 108v40l34-20z" fill="#fff"/>`);
export const HTML_ICON = doc('#ff9500', 'HTML', `
  <rect x="76" y="90" width="104" height="76" rx="6" fill="#f2f2f7"/>
  <path d="M100 118l-12 10 12 10M156 118l12 10-12 10M136 110l-16 36" stroke="#8e8e93" stroke-width="5" fill="none" stroke-linecap="round"/>`);
export const VOLUME_ICON = svg(`
  <defs><linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3e3e6"/><stop offset="1" stop-color="#a9a9ae"/></linearGradient></defs>
  <rect x="48" y="30" width="160" height="196" rx="14" fill="url(#m)"/>
  <rect x="48" y="186" width="160" height="40" rx="10" fill="#8f8f94"/>
  <path d="M136 100c6-8 14-10 20-9-1 8-5 13-11 16 6 2 10 7 11 13-2 14-9 24-17 24-5 0-7-3-12-3s-8 3-12 3c-9 0-17-13-18-25 0-10 7-18 16-18 5 0 8 3 11 3s7-4 12-4z" fill="#6e6e73"/>
`);

const app = (c1, c2, glyph) => svg(`
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
  <rect x="25" y="25" width="206" height="206" rx="46" fill="url(#g)"/>
  ${glyph}
`);
export const FINDER_ICON = app('#3ec1ff', '#1b7ff0', `
  <path d="M128 25h57c26 0 46 20 46 46v114c0 26-20 46-46 46h-57z" fill="#f2f8ff"/>
  <path d="M94 110v22M164 110v22" stroke="#1d1d1f" stroke-width="10" stroke-linecap="round"/>
  <path d="M86 168c24 22 60 22 86 0" stroke="#1d1d1f" stroke-width="10" fill="none" stroke-linecap="round"/>
  <path d="M128 90c-10 28-10 56 0 84" stroke="#1d1d1f" stroke-width="8" fill="none" stroke-linecap="round"/>`);
export const TRASH_ICON = svg(`
  <defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#cfd0d6"/><stop offset=".5" stop-color="#f3f3f6"/><stop offset="1" stop-color="#c7c8ce"/></linearGradient></defs>
  <path d="M72 70h112l-12 150c-1 8-7 14-15 14H99c-8 0-14-6-15-14z" fill="url(#t)" opacity=".92"/>
  <ellipse cx="128" cy="70" rx="56" ry="12" fill="#e9e9ee"/>
  <ellipse cx="128" cy="70" rx="46" ry="8" fill="#b9b9c2"/>
`);
export const GENERIC_APPS = [
  { label: 'Safari', icon: app('#3fb0ff', '#1a6fe8', '<circle cx="128" cy="128" r="70" fill="#fff"/><path d="M128 70l22 36-22 58-22-58z" fill="#ff3b30"/><path d="M128 70l22 36h-44z" fill="#ff3b30"/><path d="M106 106h44l-22 58z" fill="#1c1c1e" opacity=".8"/>') },
  { label: 'Messages', icon: app('#5ff068', '#1fb62a', '<path d="M128 62c-40 0-72 26-72 58 0 18 10 34 26 44l-8 26 30-14c8 2 16 2 24 2 40 0 72-26 72-58s-32-58-72-58z" fill="#fff"/>') },
  { label: 'Mail', icon: app('#3ea1ff', '#1b6ff2', '<rect x="56" y="78" width="144" height="100" rx="14" fill="#fff"/><path d="M60 88l68 52 68-52" stroke="#2a7ef5" stroke-width="10" fill="none" stroke-linecap="round"/>') },
  { label: 'Notes', icon: app('#fff9e6', '#f0efe9', '<rect x="25" y="25" width="206" height="54" fill="#f7cf3a"/><g stroke="#cfcfd2" stroke-width="7" stroke-linecap="round"><path d="M60 120h136M60 156h136M60 192h100"/></g>') },
  { label: 'Music', icon: app('#ff5e7a', '#f21d4a', '<path d="M166 62v100a22 22 0 1 1-12-20V86l-48 12v76a22 22 0 1 1-12-20V84z" fill="#fff"/>') },
  { label: 'System Settings', icon: app('#8e8e93', '#48484c', '<circle cx="128" cy="128" r="56" fill="none" stroke="#dcdce0" stroke-width="22" stroke-dasharray="26 14"/><circle cx="128" cy="128" r="24" fill="#dcdce0"/>') },
];

export const FALLBACK_SYSTEM = {
  dark: true,
  accent: 'blue',
  locale: 'en-US',
  hour12: true,
  clock: { showAMPM: true, showDate: 0, showDayOfWeek: true, showSeconds: false },
  battery: { percent: 100, charging: true, present: true },
  wifi: { ssid: null, on: true },
  user: { fullName: 'User' },
  mainDisplay: { width: 1728, height: 1117, notch: true },
  menubar: { height: 37, appName: 'Finder', menuTitles: ['File', 'Edit', 'View', 'Go', 'Window', 'Help'], status: null, symbols: {}, controlCenter: {} },
  wallpaper: null,
};

export const FALLBACK_DOCK = {
  tileSize: 51,
  magnification: false,
  apps: [
    { id: 'finder', label: 'Finder', icon: FINDER_ICON, running: true },
    ...GENERIC_APPS.map((a, i) => ({ id: 'app-' + i, label: a.label, icon: a.icon, running: i < 2 })),
  ],
  others: [],
  trash: { full: false, iconFull: TRASH_ICON, iconEmpty: TRASH_ICON },
};

export const FALLBACK_DESKTOP = {
  display: { width: 1728, height: 1117 },
  positionsFromFinder: false,
  view: { iconSize: 48, gridSpacing: 32, textSize: 10, arrangeBy: 'grid', showIconPreview: true },
  items: [
    { id: 'projects', name: 'Projects', kind: 'folder', isFolder: true, bytes: 1.4e9, icon: FOLDER_ICON },
    { id: 'screenshots', name: 'Screenshots', kind: 'folder', isFolder: true, bytes: 6e7, icon: FOLDER_ICON },
    { id: 'notes', name: 'notes.txt', kind: 'txt', ext: 'txt', bytes: 1200, icon: GENERIC_DOC_ICON },
    { id: 'photo', name: 'IMG_2041.jpeg', kind: 'jpeg', ext: 'jpeg', bytes: 2.3e6, icon: IMAGE_ICON },
    { id: 'invoice', name: 'Invoice March.pdf', kind: 'pdf', ext: 'pdf', bytes: 480000, icon: PDF_ICON },
    { id: 'clip', name: 'Screen Recording 2026-10-07 at 09.14.02.mov', kind: 'mov', ext: 'mov', bytes: 9.8e8, icon: MOVIE_ICON },
    { id: 'index', name: 'index.html', kind: 'html', ext: 'html', bytes: 0, icon: HTML_ICON },
    { id: 'hd', name: 'Macintosh HD', kind: 'volume', bytes: 4e11, icon: VOLUME_ICON },
  ],
};

// Inline SVG glyphs (white) for menu bar fallbacks
export const GLYPHS = {
  apple: `<svg viewBox="0 0 14 17" width="13" height="16"><path fill="currentColor" d="M11.6 9c0-2 1.7-3 1.8-3.1-1-1.4-2.5-1.6-3-1.7-1.3-.1-2.5.8-3.2.8-.7 0-1.7-.8-2.8-.7-1.4 0-2.7.8-3.5 2.1-1.5 2.6-.4 6.4 1.1 8.5.7 1 1.5 2.2 2.6 2.1 1.1 0 1.5-.7 2.8-.7s1.6.7 2.8.7c1.2 0 1.9-1 2.6-2.1.8-1.2 1.2-2.3 1.2-2.4 0 0-2.3-.9-2.4-3.5zM9.6 2.8c.6-.7 1-1.7.9-2.8-.9 0-2 .6-2.6 1.3-.6.6-1.1 1.7-.9 2.7 1 .1 2-.5 2.6-1.2z"/></svg>`,
  wifi: `<svg viewBox="0 0 18 13" width="16" height="12"><path fill="currentColor" d="M9 10.3a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM9 6.5c1.7 0 3.3.7 4.5 1.8l-1.3 1.4A4.6 4.6 0 0 0 9 8.4c-1.2 0-2.3.5-3.2 1.3L4.5 8.3A6.5 6.5 0 0 1 9 6.5zM9 2.7c2.8 0 5.3 1.1 7.2 2.9l-1.3 1.4A8.4 8.4 0 0 0 9 4.6c-2.3 0-4.4.9-5.9 2.4L1.8 5.6A10.3 10.3 0 0 1 9 2.7z"/></svg>`,
  search: `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="6.8" cy="6.8" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 10.5l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  controlCenter: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="0.75" y="1.75" width="14.5" height="5.5" rx="2.75" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="0.75" y="8.75" width="14.5" height="5.5" rx="2.75" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4.5" cy="4.5" r="1.9" fill="currentColor"/><circle cx="11.5" cy="11.5" r="1.9" fill="currentColor"/></svg>`,
  battery: (pct) => `<svg viewBox="0 0 28 13" width="27" height="12.5"><rect x="0.75" y="0.75" width="23.5" height="11.5" rx="3" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.2"/><rect x="2.3" y="2.3" width="${(20.4 * Math.max(0, Math.min(100, pct))) / 100}" height="8.4" rx="1.6" fill="currentColor"/><path d="M25.6 4.3v4.4c.9-.3 1.5-1.2 1.5-2.2s-.6-1.9-1.5-2.2z" fill="currentColor" fill-opacity=".5"/></svg>`,
  cloud: `<svg viewBox="0 0 16 12" width="12" height="9"><path d="M4.3 11.2a3.3 3.3 0 0 1-.6-6.5A4.4 4.4 0 0 1 12 4.1a3.2 3.2 0 0 1 .3 6.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 5.5v6M5.9 9.4L8 11.5l2.1-2.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

// A purple radial fan placeholder reminiscent of the shipped wallpaper, used only when
// /mac/wallpaper.jpg is missing.
export const FALLBACK_WALLPAPER_CSS =
  'radial-gradient(120% 160% at 100% 60%, #b78cff 0%, #6f2fd9 22%, #2a0d58 48%, #0b0414 75%, #05020a 100%)';
