// mockDesktop.js — temporary stand-in for src/desktop/index.js implementing the same API
// (SPEC.md "Desktop API"). Used only when the real module is missing or does not expose createDesktop.

export async function createDesktop(root) {
  root.style.background = 'linear-gradient(180deg, #2a3f6a 0%, #6a4f7c 55%, #c9775a 100%)';
  root.style.position = 'fixed'; root.style.inset = '0'; root.style.overflow = 'hidden';
  root.style.userSelect = 'none';
  let W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight;

  const menubar = document.createElement('div');
  Object.assign(menubar.style, { position: 'absolute', left: 0, top: 0, right: 0, height: '38px', background: 'rgba(255,255,255,0.12)', backdropFilter: 'blur(20px)', color: '#fff', font: '600 13px -apple-system, sans-serif', lineHeight: '38px', padding: '0 16px' });
  menubar.innerHTML = '<span style="font-weight:700">&#63743;</span>&nbsp;&nbsp;<b>Finder</b>&nbsp;&nbsp;File&nbsp;&nbsp;Edit&nbsp;&nbsp;View&nbsp;&nbsp;Go&nbsp;&nbsp;Window&nbsp;&nbsp;Help<span class="clock" style="float:right"></span>';
  root.appendChild(menubar);
  const clock = menubar.querySelector('.clock');

  const dockW = Math.min(820, W * 0.5), dockH = 70;
  const dock = document.createElement('div');
  Object.assign(dock.style, { position: 'absolute', left: `${(W - dockW) / 2}px`, bottom: '8px', width: `${dockW}px`, height: `${dockH}px`, borderRadius: '22px', background: 'rgba(255,255,255,0.18)', backdropFilter: 'blur(24px)', boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,.5)' });
  root.appendChild(dock);

  const names = ['Screenshot.png', 'Budget.xlsx', 'draft.md', 'movie.mov', 'Design', 'notes.txt', 'archive.zip', 'photo.jpg', 'app.dmg', 'README'];
  const masses = [0.08, 0.3, 0.05, 4.2, 1.1, 0.05, 2.4, 0.4, 3.6, 0.05];
  const icons = [];
  const cbs = { dragStart: [], drag: [], dragEnd: [], resize: [] };
  names.forEach((name, i) => {
    const w = 96, h = 110;
    const col = Math.floor(i / 7), row = i % 7;
    const x = W - 70 - col * 120, y = 110 + row * 130;
    const node = document.createElement('div');
    Object.assign(node.style, { position: 'absolute', left: 0, top: 0, width: `${w}px`, height: `${h}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', color: '#fff', font: '12px -apple-system, sans-serif', textShadow: '0 1px 2px rgba(0,0,0,.6)', cursor: 'default', touchAction: 'none' });
    const hue = (i * 47) % 360;
    node.innerHTML = `<div style="width:64px;height:64px;border-radius:14px;background:linear-gradient(160deg,hsl(${hue},70%,70%),hsl(${hue},60%,45%));box-shadow:0 4px 10px rgba(0,0,0,.3)"></div><div style="margin-top:6px;text-align:center">${name}</div>`;
    root.appendChild(node);
    const rec = { id: 'mock-' + i, name, kind: 'file', x, y, w, h, massKg: masses[i], angle: 0, node };
    const apply = () => { node.style.transform = `translate3d(${rec.x - w / 2}px, ${rec.y - h / 2}px, 0) rotate(${rec.angle}rad)`; };
    apply(); rec.apply = apply;
    icons.push(rec);
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault(); node.setPointerCapture(e.pointerId);
      const ox = e.clientX - rec.x, oy = e.clientY - rec.y;
      for (const cb of cbs.dragStart) cb(rec.id);
      const move = (ev) => { rec.x = ev.clientX - ox; rec.y = ev.clientY - oy; rec.angle = 0; apply(); for (const cb of cbs.drag) cb(rec.id, rec.x, rec.y); };
      const up = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); for (const cb of cbs.dragEnd) cb(rec.id); };
      node.addEventListener('pointermove', move); node.addEventListener('pointerup', up);
    });
  });

  addEventListener('resize', () => { W = root.clientWidth; H = root.clientHeight; dock.style.left = `${(W - dockW) / 2}px`; for (const cb of cbs.resize) cb(); });

  return {
    getWalls() { return [{ x: 0, y: 0, w: W, h: 38 }, { x: (W - dockW) / 2, y: H - dockH - 8, w: dockW, h: dockH + 8 }]; },
    getIcons() { return icons.map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, massKg: r.massKg, name: r.name, kind: r.kind, angle: r.angle })); },
    getDock() { return { x: 80, y: H - 100, angle: Math.PI }; },
    setIconPosition(id, x, y, angle = 0) { const r = icons.find((i) => i.id === id); if (!r) return; r.x = x; r.y = y; r.angle = angle; r.apply(); },
    onIconDragStart(cb) { cbs.dragStart.push(cb); },
    onIconDrag(cb) { cbs.drag.push(cb); },
    onIconDragEnd(cb) { cbs.dragEnd.push(cb); },
    onResize(cb) { cbs.resize.push(cb); },
    setClock(d) { clock.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); },
    isMock: true,
  };
}
