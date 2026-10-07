// Tiny built-in set so the phone home screen renders before scripts/ios-icons.mjs has run:
// flat iOS-coloured tiles with a simple white glyph, same ids/slots as the generated apps.json.

const tile = (c1, c2, glyph) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="180" height="180" fill="url(#g)"/>${glyph}</svg>`,
  )}`;
const W = '#fff';
const circle = (r, fill = W) => `<circle cx="90" cy="90" r="${r}" fill="${fill}"/>`;

const A = (id, label, c1, c2, glyph, slot, bytes) => ({
  id, label, icon: tile(c1, c2, glyph), bytes, slot: slot === 'dock' ? null : { row: slot[0], col: slot[1] }, dock: slot === 'dock',
});

export const FALLBACK_APPS = {
  apps: [
    A('facetime', 'FaceTime', '#5bf675', '#0bbd2a', `<rect x="38" y="62" width="70" height="56" rx="14" fill="${W}"/><path d="M112 82l30-18v52l-30-18z" fill="${W}"/>`, [0, 0], 3e6),
    A('calendar', 'Calendar', '#ffffff', '#f2f2f2', '', [0, 1], 6e6),
    A('photos', 'Photos', '#ffffff', '#f4f4f4', ['#ff9f0a', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2', '#ff375f'].map((c, i) => `<ellipse cx="90" cy="58" rx="16" ry="32" fill="${c}" opacity=".85" transform="rotate(${i * 60} 90 90)"/>`).join(''), [0, 2], 22e6),
    A('camera', 'Camera', '#f2f2f4', '#b8b8bd', `<rect x="32" y="52" width="116" height="84" rx="14" fill="#222"/>${circle(30, '#d6d6da')}${circle(22, '#1f2b3d')}`, [0, 3], 30e6),
    A('clock', 'Clock', '#1c1c1e', '#000000', `${circle(62)}<path d="M90 50v40l26 14" stroke="#000" stroke-width="7" fill="none" stroke-linecap="round"/>`, [1, 0], 6e6),
    A('maps', 'Maps', '#c9f2c7', '#86d4f5', `<path d="M90 50l26 70-26-14-26 14z" fill="#0a84ff"/>`, [1, 1], 50e6),
    A('weather', 'Weather', '#4aa3ff', '#1d5fd6', `${circle(22, '#ffd60a').replace('cx="90" cy="90"', 'cx="112" cy="70"')}<ellipse cx="82" cy="104" rx="46" ry="24" fill="${W}"/>`, [1, 2], 19e6),
    A('settings', 'Settings', '#a4a4aa', '#6e6e74', `${circle(52, '#d6d6da')}${circle(30, '#8e8e93')}${circle(12, '#d6d6da')}`, [1, 3], 3e6),
    A('phone', 'Phone', '#5bf675', '#0bbd2a', `<path d="M60 48c8-4 16 10 20 18 3 7-6 10-6 16 6 12 16 22 28 28 6 0 9-9 16-6 8 4 22 12 18 20-6 12-20 18-36 10-28-14-46-32-58-58-6-14 4-26 18-28z" fill="${W}"/>`, 'dock', 1.5e6),
    A('safari', 'Safari', '#ffffff', '#ececec', `${circle(62, '#1e8cf5')}<path d="M90 40l14 50-14 50-14-50z" fill="#ff3b30" transform="rotate(45 90 90)"/>`, 'dock', 36e6),
    A('messages', 'Messages', '#5bf675', '#0bbd2a', `<ellipse cx="90" cy="86" rx="58" ry="48" fill="${W}"/><path d="M52 120l-8 22 28-12z" fill="${W}"/>`, 'dock', 1.4e6),
    A('music', 'Music', '#ff6280', '#f2234a', `<path d="M116 46v70a16 16 0 1 1-10-15V68l-36 8v52a16 16 0 1 1-10-15V64z" fill="${W}"/>`, 'dock', 68e6),
  ],
  symbols: {},
};

export const PHONE_GLYPHS = {
  cellular: `<svg viewBox="0 0 18 12" width="17" height="11.5"><g fill="currentColor"><rect x="0" y="7.5" width="3.2" height="4.5" rx="1"/><rect x="4.9" y="5.2" width="3.2" height="6.8" rx="1"/><rect x="9.8" y="2.7" width="3.2" height="9.3" rx="1"/><rect x="14.7" y="0" width="3.2" height="12" rx="1"/></g></svg>`,
  wifi: `<svg viewBox="0 0 16 12" width="15.5" height="11"><path fill="currentColor" d="M8 9.2a1.4 1.4 0 0 1 1 .4L8 11 7 9.6a1.4 1.4 0 0 1 1-.4zm0-3.6c1.5 0 2.9.6 3.9 1.5l-1.2 1.4A4.1 4.1 0 0 0 8 7.5c-1 0-2 .4-2.7 1L4.1 7.1A5.9 5.9 0 0 1 8 5.6zM8 2c2.6 0 4.9 1 6.6 2.6L13.4 6A7.8 7.8 0 0 0 8 3.9 7.8 7.8 0 0 0 2.6 6L1.4 4.6A9.7 9.7 0 0 1 8 2z"/></svg>`,
  battery: (pct) => `<svg viewBox="0 0 28 13" width="27.3" height="13"><rect x=".5" y=".5" width="24" height="12" rx="3.8" fill="none" stroke="currentColor" stroke-opacity=".35"/><rect x="2" y="2" width="${(21 * Math.max(0, Math.min(100, pct))) / 100}" height="9" rx="2.5" fill="currentColor"/><path d="M26 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" fill-opacity=".4"/></svg>`,
  search: `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="6.8" cy="6.8" r="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 10.5l4 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
};

export const FALLBACK_WALLPAPER_CSS =
  'radial-gradient(140% 90% at 80% 45%, #b78cff 0%, #6f2fd9 25%, #2a0d58 55%, #0b0414 80%, #05020a 100%)';
