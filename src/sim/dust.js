// dust.js — crumbs on the desktop. Particles live in flat typed arrays (CSS px), so the renderer
// can upload them straight into an instanced buffer. Everything geometric about the robot's
// cleaning head is defined here in metres and converted with pxPerMeter at creation.
//
// Robot frame used below: fwd = heading, right = clockwise from heading on screen.
// Intake   : rectangle INTAKE_WIDTH wide, from INTAKE_FROM to INTAKE_TO ahead of the centre
//            (so it sits just behind the front edge at R = 0.17 m). Particles inside are pulled
//            toward the intake centre and removed when they reach it -> bin.
// Side brush: spinning disc at the right-front. Particles under it get a tangential kick that
//            sweeps the front of the brush inward (toward the intake) and the outer side forward,
//            plus random scatter — so some crumbs skitter away before being collected.

export const DUST = {
  CAPACITY: 4000,            // particles  hard cap on the arrays
  TARGET_ALIVE: 1000,        // particles  regeneration only runs while alive count is below this
  INITIAL_CLUMPS: 22,        // -          clumps seeded at start
  CLUMP_MIN: 12, CLUMP_MAX: 40, // particles per clump
  CLUMP_SPREAD_M: 0.09,      // m          gaussian radius of a clump
  INITIAL_SPRINKLE: 160,     // particles  uniform background dust at start
  REGEN_INTERVAL_S: 4.0,     // s          one new clump (REGEN_MIN..MAX particles) this often
  REGEN_MIN: 6, REGEN_MAX: 16,
  SIZE_MIN_PX: 1.5, SIZE_MAX_PX: 4.0, // px  crumb size range
  INTAKE_WIDTH_M: 0.18,      // m
  INTAKE_FROM_M: 0.01,       // m   ahead of the robot centre
  INTAKE_TO_M: 0.13,         // m
  SUCTION_SPEED_M: 1.2,      // m/s pull speed toward the intake centre at suction = 1
  CAPTURE_R_M: 0.02,         // m   particle is "in the bin" within this of the intake centre
  SIDE_BRUSH_FWD_M: 0.10,    // m   brush axis position (forward)
  SIDE_BRUSH_RIGHT_M: 0.115, // m   brush axis position (right)
  SIDE_BRUSH_R_M: 0.085,     // m   bristle reach
  SIDE_BRUSH_FLING_M: 0.45,  // m/s tangential speed given to crumbs at full rpm
  SIDE_BRUSH_SCATTER: 0.6,   // -   random component relative to the tangential kick
  SIDE_BRUSH_RADIAL: 0.25,   // -   outward component (crumbs fly off the bristle tips)
  PARTICLE_DAMPING: 7,       // 1/s velocity decay of sliding crumbs
  PARTICLE_STOP_SPEED_PX: 2, // px/s below this a crumb stops
  SHED_MIN: 1, SHED_MAX: 3,  // particles an icon drops when pushed
  SHED_COOLDOWN_S: 0.5,      // s  per icon
  DIRT_RATE_WINDOW_S: 1.0,   // s  window for the dirt-detect pick rate
};

export function createDust({ widthPx, heightPx, pxPerMeter, rng, walls }) {
  const N = DUST.CAPACITY;
  const x = new Float32Array(N), y = new Float32Array(N), size = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N);
  const alive = new Uint8Array(N);
  const free = [];
  for (let i = N - 1; i >= 0; i--) free.push(i);
  let aliveCount = 0;
  let regenTimer = 0;
  const shedCooldown = new Map();
  // dirt-detect ring of 4 buckets covering DIRT_RATE_WINDOW_S
  const buckets = new Float32Array(4);
  let bucketT = 0;
  const bucketLen = DUST.DIRT_RATE_WINDOW_S / 4;

  const S = pxPerMeter;
  const intakeHalfW = DUST.INTAKE_WIDTH_M * 0.5 * S;
  const intakeFrom = DUST.INTAKE_FROM_M * S, intakeTo = DUST.INTAKE_TO_M * S;
  const intakeMid = (intakeFrom + intakeTo) * 0.5;
  const suctionSpeed = DUST.SUCTION_SPEED_M * S;
  const captureR = DUST.CAPTURE_R_M * S;
  const brushFwd = DUST.SIDE_BRUSH_FWD_M * S, brushRight = DUST.SIDE_BRUSH_RIGHT_M * S;
  const brushR = DUST.SIDE_BRUSH_R_M * S, brushR2 = brushR * brushR;
  const fling = DUST.SIDE_BRUSH_FLING_M * S;
  // generous culling radius: anything farther than this from the robot centre is untouched
  const reach = Math.max(intakeTo + intakeHalfW, Math.hypot(brushFwd, brushRight) + brushR) + 2;
  const reach2 = reach * reach;

  function inWall(px, py) {
    for (const wl of walls) {
      if (px >= wl.x - wl.w / 2 && px <= wl.x + wl.w / 2 && py >= wl.y - wl.h / 2 && py <= wl.y + wl.h / 2) return true;
    }
    return false;
  }

  function spawn(px, py) {
    if (free.length === 0) return false;
    if (px < 1 || py < 1 || px > widthPx - 1 || py > heightPx - 1) return false;
    if (inWall(px, py)) return false;
    const i = free.pop();
    x[i] = px; y[i] = py; vx[i] = 0; vy[i] = 0;
    size[i] = rng.range(DUST.SIZE_MIN_PX, DUST.SIZE_MAX_PX);
    alive[i] = 1; aliveCount++;
    return true;
  }
  function kill(i) {
    alive[i] = 0; aliveCount--; free.push(i);
  }
  function clump(cx, cy, count, spreadPx) {
    let made = 0;
    for (let k = 0; k < count; k++) {
      if (spawn(cx + rng.gauss() * spreadPx, cy + rng.gauss() * spreadPx)) made++;
    }
    return made;
  }

  function seed() {
    for (let k = 0; k < DUST.INITIAL_SPRINKLE; k++) spawn(rng.range(0, widthPx), rng.range(0, heightPx));
    for (let c = 0; c < DUST.INITIAL_CLUMPS; c++) {
      clump(rng.range(0, widthPx), rng.range(0, heightPx), rng.int(DUST.CLUMP_MIN, DUST.CLUMP_MAX), DUST.CLUMP_SPREAD_M * S);
    }
  }

  /**
   * One frame. robot = {x, y, angle} in px/rad. suction, sideBrush in 0..1.
   * Returns number of particles picked this frame.
   */
  function update(dt, t, robot, suction, sideBrush) {
    // dirt-detect buckets
    if (t - bucketT >= bucketLen) {
      const steps = Math.min(4, Math.floor((t - bucketT) / bucketLen));
      for (let s = 0; s < steps; s++) { buckets[3] = buckets[2]; buckets[2] = buckets[1]; buckets[1] = buckets[0]; buckets[0] = 0; }
      bucketT += steps * bucketLen;
    }
    // regeneration in clumps
    regenTimer += dt;
    if (regenTimer >= DUST.REGEN_INTERVAL_S) {
      regenTimer -= DUST.REGEN_INTERVAL_S;
      if (aliveCount < DUST.TARGET_ALIVE) {
        clump(rng.range(0, widthPx), rng.range(0, heightPx), rng.int(DUST.REGEN_MIN, DUST.REGEN_MAX), DUST.CLUMP_SPREAD_M * S);
      }
    }

    const fx = Math.cos(robot.angle), fy = Math.sin(robot.angle);
    const rx = -fy, ry = fx;
    const bx = robot.x + fx * brushFwd + rx * brushRight;
    const by = robot.y + fy * brushFwd + ry * brushRight;
    const icx = robot.x + fx * intakeMid, icy = robot.y + fy * intakeMid;
    const damp = Math.exp(-DUST.PARTICLE_DAMPING * dt);
    let picked = 0;

    for (let i = 0; i < N; i++) {
      if (!alive[i]) continue;
      let px = x[i], py = y[i];
      let mvx = vx[i], mvy = vy[i];
      const dx = px - robot.x, dy = py - robot.y;
      if (dx * dx + dy * dy < reach2) {
        // robot-frame coordinates
        const along = dx * fx + dy * fy;
        const lat = dx * rx + dy * ry;
        // intake
        if (suction > 0 && along >= intakeFrom && along <= intakeTo && Math.abs(lat) <= intakeHalfW) {
          const ex = icx - px, ey = icy - py;
          const d = Math.hypot(ex, ey);
          if (d < captureR) {
            kill(i); picked++;
            continue;
          }
          const step = Math.min(d, suctionSpeed * suction * dt);
          px += ex / d * step; py += ey / d * step;
          mvx = 0; mvy = 0;
        } else if (sideBrush > 0) {
          const ex = px - bx, ey = py - by;
          const d2 = ex * ex + ey * ey;
          if (d2 < brushR2 && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const tx = ey / d, ty = -ex / d; // tangential: front of brush sweeps inward (left), outer side forward
            const k = fling * sideBrush * (0.5 + 0.5 * d / brushR);
            mvx += (tx * k + ex / d * k * DUST.SIDE_BRUSH_RADIAL + (rng.next() - 0.5) * 2 * k * DUST.SIDE_BRUSH_SCATTER) * dt * 12;
            mvy += (ty * k + ey / d * k * DUST.SIDE_BRUSH_RADIAL + (rng.next() - 0.5) * 2 * k * DUST.SIDE_BRUSH_SCATTER) * dt * 12;
            const sp = Math.hypot(mvx, mvy);
            if (sp > fling * 1.5) { mvx *= fling * 1.5 / sp; mvy *= fling * 1.5 / sp; }
          }
        }
      }
      if (mvx !== 0 || mvy !== 0) {
        const nx = px + mvx * dt, ny = py + mvy * dt;
        if (nx < 1 || nx > widthPx - 1 || ny < 1 || ny > heightPx - 1 || inWall(nx, ny)) {
          mvx = 0; mvy = 0;
        } else { px = nx; py = ny; }
        mvx *= damp; mvy *= damp;
        if (mvx * mvx + mvy * mvy < DUST.PARTICLE_STOP_SPEED_PX * DUST.PARTICLE_STOP_SPEED_PX) { mvx = 0; mvy = 0; }
      }
      x[i] = px; y[i] = py; vx[i] = mvx; vy[i] = mvy;
    }
    buckets[0] += picked;
    return picked;
  }

  /** particles picked per second over the last window (dirt detect) */
  function pickRate() {
    return (buckets[0] + buckets[1] + buckets[2] + buckets[3]) / DUST.DIRT_RATE_WINDOW_S;
  }

  /** user drops crumbs */
  function addDust(px, py, count) {
    clump(px, py, Math.max(1, count | 0), DUST.CLUMP_SPREAD_M * S * 0.6);
  }

  /** an icon was pushed: drop a few crumbs along its perimeter */
  function shed(t, icon) {
    const last = shedCooldown.get(icon.id) ?? -Infinity;
    if (t - last < DUST.SHED_COOLDOWN_S) return 0;
    shedCooldown.set(icon.id, t);
    const n = rng.int(DUST.SHED_MIN, DUST.SHED_MAX);
    const c = Math.cos(icon.angle), s = Math.sin(icon.angle);
    let made = 0;
    for (let k = 0; k < n; k++) {
      // random point just outside the box edge
      let lx, ly;
      if (rng.chance(0.5)) { lx = rng.sign() * (icon.hw + 3); ly = rng.range(-icon.hh, icon.hh); }
      else { lx = rng.range(-icon.hw, icon.hw); ly = rng.sign() * (icon.hh + 3); }
      if (spawn(icon.x + lx * c - ly * s, icon.y + lx * s + ly * c)) made++;
    }
    return made;
  }

  /** count alive particles within radius px of a point (used for spot-clean checks) */
  function countNear(px, py, radius) {
    const r2 = radius * radius;
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (!alive[i]) continue;
      const dx = x[i] - px, dy = y[i] - py;
      if (dx * dx + dy * dy < r2) n++;
    }
    return n;
  }

  return {
    state: { x, y, size, alive, count: N },
    get aliveCount() { return aliveCount; },
    seed, update, addDust, shed, pickRate, countNear,
  };
}
