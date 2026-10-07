// legend.js — compact controls card, stacked directly above the Clean map card (same Liquid Glass style).
// main.js positions it (layoutHud) so it never covers the minimap, the macOS Dock or the charging station.

const ITEMS = [
  ['⇧', 'turbo'], ['↩', 'autopilot'],
  ['H', 'home'],
  ['E', 'empty bin'], ['C', 'crumbs'],
  ['K', 'cake'], ['M', 'map'],
  ['R', 'reset'], ['Space', 'pause'],
  ['N', 'sound'], ['L', 'hide keys'],
];

export function createLegend(parent = document.body) {
  const style = document.createElement('style');
  style.textContent = `
  .rb-legend { position: fixed; left: 16px; bottom: 16px; z-index: 1002; pointer-events: none;
    width: 300px; padding: 9px 11px 10px; border-radius: 18px; box-sizing: border-box;
    color: #fff; font: 500 11px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, sans-serif;
    letter-spacing: -0.005em; background: rgba(18, 24, 34, 0.42);
    -webkit-backdrop-filter: blur(26px) saturate(170%); backdrop-filter: blur(26px) saturate(170%);
    box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.45), inset 0 -0.5px 0 rgba(255,255,255,0.10),
      0 0 0 0.5px rgba(255,255,255,0.16), 0 14px 40px rgba(0,0,0,0.35);
    transition: opacity .25s; }
  .rb-legend.hidden { opacity: 0; }
  .rb-legend-title { font-weight: 650; font-size: 11.5px; margin: 0 1px 6px; opacity: .92; }
  .rb-legend-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 8px; row-gap: 3px; }
  .rb-legend-row.wide { grid-column: 1 / -1; gap: 4px; }
  .rb-legend-row.wide .sep { opacity: .4; margin: 0 3px; }
  .rb-legend-row { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; }
  .rb-legend-row span { opacity: .78; overflow: hidden; text-overflow: ellipsis; }
  .rb-legend kbd { font: 600 10px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, sans-serif;
    min-width: 12px; padding: 3px 5px; border-radius: 5px; text-align: center; color: #fff;
    background: rgba(255,255,255,0.14); box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.35), 0 0.5px 1px rgba(0,0,0,0.25); }
  `;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.className = 'rb-legend';
  el.innerHTML = `<div class="rb-legend-title">Controls</div><div class="rb-legend-grid">
    <div class="rb-legend-row wide"><kbd>↑↓←→</kbd><span style="opacity:.5">/</span><kbd>WASD</kbd><span>drive</span></div>
    ${ITEMS.map(([k, label]) => `<div class="rb-legend-row"><kbd>${k}</kbd><span>${label}</span></div>`).join('')}</div>`;
  parent.appendChild(el);
  let visible = true;

  function setVisible(v) { visible = v; el.classList.toggle('hidden', !v); el.style.display = v ? '' : 'none'; }
  function toggle() { setVisible(!visible); return visible; }
  /** measured height in px (layout must have run) */
  function height() { return visible ? el.offsetHeight : 0; }
  function place({ left, bottom, width }) {
    el.style.left = left + 'px'; el.style.bottom = bottom + 'px'; el.style.width = width + 'px';
  }
  return { el, setVisible, toggle, height, place, get visible() { return visible; } };
}
