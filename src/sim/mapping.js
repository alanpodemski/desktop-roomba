// mapping.js — the robot's own picture of the room: coverage grid, obstacle map, A* planner.
//
// Grids are in CSS px (cellPx square cells), origin top-left, row-major: index = cy * w + cx.
// coverage.data : 0 = never cleaned, 1..255 = number of passes (saturating). A "pass" is one
//                 sweep over a cell: a straight run counts once no matter how many frames it took.
// obstacleMap.data : 0 unknown/free, 1 bumped here, 2 saw a wall/edge here (side ray hit or cliff).
// The obstacle map contains ONLY what the robot sensed — it never reads the icon rectangles.

export const MAP = {
  CELL_PX: 8,               // px   grid resolution of both maps
  BRUSH_WIDTH_M: 0.20,      // m    main brush width: half of this is the coverage stamp radius
  PASS_TIMEOUT_S: 1.5,      // s    a new pass id starts after this long in one place/direction
  PASS_TURN_RAD: 1.2,       // rad  ...or after the heading changed by this much
  INFLATE_EXTRA_CELLS: 1,   // cells safety margin added to the robot radius when planning
  GOAL_CLEAR_CELLS: 3,      // cells radius around the dock goal that is always considered free
  START_SEARCH_CELLS: 6,    // cells radius searched for a free start cell when boxed in
  MAX_ASTAR_NODES: 60000,   // -    give up planning beyond this many expansions
};

export function createMapping({ widthPx, heightPx, pxPerMeter, robotRadiusM }) {
  const cell = MAP.CELL_PX;
  const w = Math.ceil(widthPx / cell), h = Math.ceil(heightPx / cell);
  const n = w * h;
  const coverage = { cellPx: cell, w, h, data: new Uint8Array(n) };
  const obstacleMap = { cellPx: cell, w, h, data: new Uint8Array(n) };
  const passGrid = new Uint16Array(n);
  let passId = 1;
  let passTime = 0, passHeading = 0, havePass = false;
  const stampR = MAP.BRUSH_WIDTH_M * 0.5 * pxPerMeter; // px
  const inflateCells = Math.ceil(robotRadiusM * pxPerMeter / cell) + MAP.INFLATE_EXTRA_CELLS;
  // scratch for planning
  const inflated = new Uint8Array(n);
  const gScore = new Float32Array(n);
  const cameFrom = new Int32Array(n);
  const closed = new Uint8Array(n);
  let coveredCells = 0;

  function newPass(heading, t) {
    passId++;
    if (passId >= 65535) { passId = 1; passGrid.fill(0); }
    passTime = t; passHeading = heading; havePass = true;
  }

  /** Stamp the brush swept from (x0,y0) to (x1,y1) px. heading in rad, t sim time. */
  function stampCoverage(x0, y0, x1, y1, heading, t) {
    if (!havePass || t - passTime > MAP.PASS_TIMEOUT_S) newPass(heading, t);
    else {
      let d = heading - passHeading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > MAP.PASS_TURN_RAD) newPass(heading, t);
    }
    const minx = Math.max(0, Math.floor((Math.min(x0, x1) - stampR) / cell));
    const maxx = Math.min(w - 1, Math.floor((Math.max(x0, x1) + stampR) / cell));
    const miny = Math.max(0, Math.floor((Math.min(y0, y1) - stampR) / cell));
    const maxy = Math.min(h - 1, Math.floor((Math.max(y0, y1) + stampR) / cell));
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const r2 = stampR * stampR;
    const data = coverage.data;
    for (let cy = miny; cy <= maxy; cy++) {
      const py = (cy + 0.5) * cell;
      for (let cx = minx; cx <= maxx; cx++) {
        const i = cy * w + cx;
        if (passGrid[i] === passId) continue;
        const px = (cx + 0.5) * cell;
        // distance from cell centre to the segment
        let tt = 0;
        if (len2 > 1e-9) tt = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
        const ex = px - (x0 + dx * tt), ey = py - (y0 + dy * tt);
        if (ex * ex + ey * ey > r2) continue;
        passGrid[i] = passId;
        if (data[i] === 0) coveredCells++;
        if (data[i] < 255) data[i]++;
      }
    }
  }

  function cellIndexAt(xPx, yPx) {
    const cx = Math.floor(xPx / cell), cy = Math.floor(yPx / cell);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return -1;
    return cy * w + cx;
  }
  /** mark a sensed obstacle point. kind 1 = bump, 2 = seen (ray / cliff). */
  function markObstacle(xPx, yPx, kind) {
    const i = cellIndexAt(Math.min(Math.max(xPx, 0), widthPx - 0.01), Math.min(Math.max(yPx, 0), heightPx - 0.01));
    if (i < 0) return;
    const d = obstacleMap.data;
    if (kind === 1) d[i] = 1;
    else if (d[i] === 0) d[i] = 2;
  }

  // --- A* -----------------------------------------------------------------------------------
  function buildInflated(goalCx, goalCy) {
    inflated.fill(0);
    const src = obstacleMap.data;
    const r = inflateCells, r2 = r * r;
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (src[cy * w + cx] === 0) continue;
        const y0 = Math.max(0, cy - r), y1 = Math.min(h - 1, cy + r);
        const x0 = Math.max(0, cx - r), x1 = Math.min(w - 1, cx + r);
        for (let yy = y0; yy <= y1; yy++) {
          const ddy = yy - cy;
          for (let xx = x0; xx <= x1; xx++) {
            const ddx = xx - cx;
            if (ddx * ddx + ddy * ddy <= r2) inflated[yy * w + xx] = 1;
          }
        }
      }
    }
    // page border: the robot centre cannot be closer than its radius to the edge
    const br = Math.max(0, inflateCells - MAP.INFLATE_EXTRA_CELLS - 1);
    for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
      if (cx < br || cy < br || cx >= w - br || cy >= h - br) inflated[cy * w + cx] = 1;
    }
    // the dock itself is known territory
    const g = MAP.GOAL_CLEAR_CELLS;
    for (let yy = goalCy - g; yy <= goalCy + g; yy++) for (let xx = goalCx - g; xx <= goalCx + g; xx++) {
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) inflated[yy * w + xx] = 0;
    }
  }

  function nearestFree(cx, cy) {
    if (inflated[cy * w + cx] === 0) return [cx, cy];
    for (let r = 1; r <= MAP.START_SEARCH_CELLS; r++) {
      for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== r) continue;
        if (inflated[yy * w + xx] === 0) return [xx, yy];
      }
    }
    return null;
  }

  // binary heap keyed on f
  const heapIdx = [];
  const heapF = [];
  function heapPush(i, f) {
    heapIdx.push(i); heapF.push(f);
    let k = heapIdx.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapF[p] <= heapF[k]) break;
      [heapIdx[p], heapIdx[k]] = [heapIdx[k], heapIdx[p]];
      [heapF[p], heapF[k]] = [heapF[k], heapF[p]];
      k = p;
    }
  }
  function heapPop() {
    const top = heapIdx[0];
    const li = heapIdx.pop(), lf = heapF.pop();
    if (heapIdx.length > 0) {
      heapIdx[0] = li; heapF[0] = lf;
      let k = 0;
      for (;;) {
        const a = 2 * k + 1, b = a + 1;
        let m = k;
        if (a < heapIdx.length && heapF[a] < heapF[m]) m = a;
        if (b < heapIdx.length && heapF[b] < heapF[m]) m = b;
        if (m === k) break;
        [heapIdx[m], heapIdx[k]] = [heapIdx[k], heapIdx[m]];
        [heapF[m], heapF[k]] = [heapF[k], heapF[m]];
        k = m;
      }
    }
    return top;
  }

  function lineFree(x0, y0, x1, y1) {
    // supercover-ish DDA on the inflated grid
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      if (inflated[y * w + x]) return false;
      if (x === x1 && y === y1) return true;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; if (inflated[y * w + x]) return false; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  /**
   * Plan from (sx,sy) to (gx,gy) px on the inflated obstacle map.
   * Returns [{x,y}] in px (string-pulled), or null if no path.
   */
  function planPath(sx, sy, gx, gy) {
    const gcx = Math.max(0, Math.min(w - 1, Math.floor(gx / cell)));
    const gcy = Math.max(0, Math.min(h - 1, Math.floor(gy / cell)));
    buildInflated(gcx, gcy);
    let scx = Math.max(0, Math.min(w - 1, Math.floor(sx / cell)));
    let scy = Math.max(0, Math.min(h - 1, Math.floor(sy / cell)));
    const s = nearestFree(scx, scy);
    if (!s) return null;
    [scx, scy] = s;
    const start = scy * w + scx, goal = gcy * w + gcx;
    gScore.fill(Infinity); closed.fill(0); cameFrom.fill(-1);
    heapIdx.length = 0; heapF.length = 0;
    gScore[start] = 0;
    const hfn = (i) => {
      const cx = i % w, cy = (i / w) | 0;
      const ddx = Math.abs(cx - gcx), ddy = Math.abs(cy - gcy);
      return Math.max(ddx, ddy) + 0.41421356 * Math.min(ddx, ddy);
    };
    heapPush(start, hfn(start));
    let expansions = 0;
    let found = false;
    while (heapIdx.length > 0) {
      const cur = heapPop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) { found = true; break; }
      if (++expansions > MAP.MAX_ASTAR_NODES) break;
      const cx = cur % w, cy = (cur / w) | 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (inflated[ni] || closed[ni]) continue;
        // no corner cutting
        if (ox !== 0 && oy !== 0 && (inflated[cy * w + nx] || inflated[ny * w + cx])) continue;
        const cost = (ox !== 0 && oy !== 0) ? 1.41421356 : 1;
        const g = gScore[cur] + cost;
        if (g < gScore[ni]) {
          gScore[ni] = g; cameFrom[ni] = cur;
          heapPush(ni, g + hfn(ni));
        }
      }
    }
    if (!found) return null;
    // reconstruct
    const cells = [];
    for (let i = goal; i !== -1; i = cameFrom[i]) cells.push(i);
    cells.reverse();
    // string pulling
    const out = [];
    let a = 0;
    out.push(cells[0]);
    while (a < cells.length - 1) {
      let b = cells.length - 1;
      const ax = cells[a] % w, ay = (cells[a] / w) | 0;
      while (b > a + 1) {
        const bx = cells[b] % w, by = (cells[b] / w) | 0;
        if (lineFree(ax, ay, bx, by)) break;
        b--;
      }
      out.push(cells[b]);
      a = b;
    }
    const path = out.map((i) => ({ x: ((i % w) + 0.5) * cell, y: (((i / w) | 0) + 0.5) * cell }));
    // snap the last point to the exact goal
    path[path.length - 1] = { x: gx, y: gy };
    return path;
  }

  return {
    coverage, obstacleMap,
    stampCoverage, markObstacle, planPath,
    coveredCellCount: () => coveredCells,
    cellIndexAt,
  };
}
