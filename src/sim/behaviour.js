// behaviour.js — iRobot-style behaviour arbitration for the robot. Pure logic, no physics.
//
// Input each frame: a `sense` packet (pose, speed, bumper, cliffs, side/front rays, slip, dirt
// rate, bin, battery) in SI units. Output: body command {v (m/s), w (rad/s), brush, sideBrush,
// suction} plus mode/anger/path for the UI and events.
//
// Modes reported (spec): 'spiral' | 'bounce' | 'wall' | 'spot' | 'escape' | 'stuck' | 'toDock' |
// 'docking' | 'docked' | 'emptying' | 'charging' | 'off'.
// 'bounce' is iRobot's bounce behaviour: straight-line travel, back-off and turn-away on bump;
// cliff reactions and the undock manoeuvre are also reported as 'bounce'.
//
// Priority (highest first): dock-cycle timers > cliff reflex > bump reflex > stuck detection >
// current behaviour. Escape ladder: each failed rung raises `anger`; the final failure is 'stuck'.

import { clamp, wrapAngle, hypot } from './util.js';

export const BEH = {
  // --- speeds -----------------------------------------------------------------------------------
  V_CRUISE: 0.30,           // m/s   straight travel between bumps
  V_SPIRAL_MAX: 0.30,       // m/s   spiral tangential speed cap
  V_WALL: 0.20,             // m/s   wall following
  V_SPOT: 0.20,             // m/s   spot spiral
  V_BACKOFF: 0.15,          // m/s   reversing after a bump
  V_CLIFF_BACK: 0.25,       // m/s   reversing from a cliff (fast)
  V_PATH: 0.26,             // m/s   following a planned path to the dock
  V_DOCK_CREEP: 0.08,       // m/s   final docking approach
  V_UNDOCK: 0.15,           // m/s   backing off the dock
  V_GENTLE: 0.10,           // m/s   "light touch": speed when the front sensor sees something close
  GENTLE_RANGE: 0.12,       // m     front-sensor distance that triggers the gentle speed
  W_TURN: 2.4,              // rad/s turning in place (≈ 0.28 m/s wheel speed)
  W_SPIRAL_MAX: 2.0,        // rad/s yaw-rate cap (sets the speed at small spiral radius)
  W_WALL_MAX: 1.4,          // rad/s wall-follow steering cap
  W_WALL_SEEK: 1.1,         // rad/s turn-in rate when the wall is lost (wraps around corners)

  // --- spiral -------------------------------------------------------------------------------------
  SPIRAL_R0: 0.06,          // m   starting radius
  SPIRAL_PITCH: 0.24,       // m   radius growth per revolution (a bit under the brush*2 for overlap)
  SPIRAL_R_MAX: 0.8,        // m   give up spiralling beyond this radius

  // --- bounce -------------------------------------------------------------------------------------
  BACKOFF_MIN: 0.03, BACKOFF_MAX: 0.05,          // m   reverse distance after a bump
  TURN_MIN: Math.PI / 2, TURN_MAX: Math.PI,      // rad random turn away from the bumped side
  P_WALL_FOLLOW: 0.3,        // -   probability that a bump leads to wall-following instead of a bounce
  STRAIGHT_MIN: 1.2, STRAIGHT_MAX: 3.0,          // m   open-floor run before considering a spiral
  P_SPIRAL: 0.4,             // -   probability of spiralling after a long open run
  BACK_TIMEOUT: 1.5,         // s   give up reversing (blocked behind)

  // --- wall follow -----------------------------------------------------------------------------------
  WALL_TARGET: 0.012,        // m   desired gap between the shell and the wall
  WALL_KP: 14,               // rad/s per m of gap error
  WALL_ALIGN_MIN: 0.6, WALL_ALIGN_MAX: 1.1,     // rad turn away from the bump before following
  WALL_DIST_MIN: 0.6, WALL_DIST_MAX: 2.0,       // m   follow length before leaving
  WALL_LOST_TIMEOUT: 1.8,    // s   turning without re-acquiring the wall -> leave
  WALL_CORNER_TURN: 1.3,     // rad turn away at an inside corner (front bump while following)

  // --- spot / dirt detect --------------------------------------------------------------------------------
  DIRT_RATE: 24,             // particles/s picked that triggers spot cleaning
  SPOT_R0: 0.05, SPOT_R_MAX: 0.40, SPOT_PITCH: 0.15, // m
  SPOT_COOLDOWN: 60,         // s   between spot cleans

  // --- cliff -----------------------------------------------------------------------------------------------
  CLIFF_BACK: 0.08,          // m   reverse distance after a cliff trip
  CLIFF_TURN_MIN: 1.4, CLIFF_TURN_MAX: 2.6,     // rad

  // --- stuck detection / escape ------------------------------------------------------------------------------
  STUCK_WINDOW: 2.0,         // s   commanded motion but displacement below STUCK_DISP for this long
  STUCK_DISP: 0.03,          // m
  STUCK_MIN_CMD: 0.05,       // m/s commanded speed that counts as "trying to move"
  SLIP_STUCK: 0.8,           // -   mean wheel slip above this ...
  SLIP_TIME: 1.5,            // s   ... for this long = stuck (wheels spinning against a heavy icon)
  BOX_BUMPS: 6,              // -   bump+cliff events within BOX_WINDOW ...
  BOX_WINDOW: 12,            // s
  BOX_EXTENT: 0.45,          // m   ... while the robot stayed inside a box this small = boxed in
  ESCAPE_ATTEMPTS: 7,        // -   rungs tried before giving up ('stuck')
  ESCAPE_WALL_TIME: 5,       // s   wall-follow rung duration
  ESCAPE_TEST_TIME: 3.5,     // s   bumper-reactive test drive after each rung
  ESCAPE_TEST_BUMPS: 2,      // -   bumps tolerated during one test drive
  ESCAPE_FREE_DISP: 0.20,    // m   distance from where the episode started that counts as free
  ESCAPE_MEMORY: 30,         // s   a new stuck episode this soon after the last continues the ladder
  ANGER_PER_ATTEMPT: 1 / 6,  // -   anger added per failed rung
  ANGER_DECAY: 0.08,         // 1/s anger decay while cleaning
  ANGER_EVENT: 0.5,          // -   'angry' event when anger crosses this upward
  ANGER_AFTER_FREED: 0.6,    // -   anger when the user frees a stuck robot

  // --- dock cycle ----------------------------------------------------------------------------------------------
  BIN_FULL: 1.0, BATTERY_LOW: 0.15, BATTERY_FULL: 0.9,
  DOCK_APPROACH_DIST: 0.38,  // m   approach point this far in front of the dock, along -dock.angle
  DOCK_ARRIVE_R: 0.12,       // m   radius around the approach point that switches to 'docking'
  DOCK_LINEUP_TOL: 0.03,     // m   how close to the approach point the line-up phase gets
  DOCK_ALIGN_TOL: 0.05,      // rad
  DOCK_AIM_AHEAD: 0.25,      // m   creep steering aims at the axis this far ahead
  DOCK_LATERAL_TOL: 0.09,    // m   abort creep beyond this lateral error
  DOCK_RETRIES: 3,
  PATH_LOOKAHEAD: 0.25,      // m   pure-pursuit lookahead
  PATH_WP_RADIUS: 0.08,      // m   waypoint reached
  PATH_KP: 3.0,              // rad/s per rad heading error
  REPLAN_INTERVAL: 4.0,      // s
  DOCKED_PAUSE: 1.0,         // s
  EMPTY_SECONDS: 8,          // s   bin -> 0
  CHARGE_SECONDS: 20,        // s   0.15 -> 0.9
  UNDOCK_REVERSE: 0.30,      // m
};

const DOCK_FAMILY = new Set(['docked', 'emptying', 'charging']);
const CLEANING = new Set(['spiral', 'bounce', 'wall', 'spot']);

export function createBehaviour({ rng, dock, robotR, pxPerMeter, planPathPx, events }) {
  const S = pxPerMeter;
  const ux = Math.cos(dock.angle), uy = Math.sin(dock.angle); // docking direction
  const approach = { x: dock.x - ux * BEH.DOCK_APPROACH_DIST, y: dock.y - uy * BEH.DOCK_APPROACH_DIST };

  const B = {
    mode: 'spiral', sub: 'run', prevMode: null,
    anger: 0,
    path: null,            // px points for the UI
    pathM: null,           // metre points for following
    pathIdx: 0,
    brushOn: true, suctionOn: true,
    bin: 0, battery: 1,
    // scratch
    t: 0,
    spiral: { dir: 1, phi: 0, r: BEH.SPIRAL_R0 },
    spot: { dir: 1, phi: 0, r: BEH.SPOT_R0, out: true, lastEnd: -Infinity },
    seg: { x0: 0, y0: 0, t0: 0, backDist: 0, backSpeed: 0, turnAngle: 0, heading0: 0, dir: 1 }, // current back/turn primitive
    odo: 0,                // travelled distance (m), for the stuck detector
    straightDist: 0, straightLimit: 2.5,
    afterTurn: 'straight', returnMode: null,
    wall: { side: 1, dist: 0, target: 1.5, lost: 0, phase: 'align' },
    escape: { attempt: 0, phase: 'rung', step: 0, timer: 0, dir: 1, ax: 0, ay: 0, testSub: 'drive', testBumps: 0, turnDir: 1, turnAngle: 1.5, lastEnd: -Infinity, wall: { side: 1, lost: 0 }, wallResume: false },
    dockSub: 'align', dockRetries: 0, dockTimer: 0, replanTimer: 0, dockReason: null, directMode: false,
    chargeFrom: 0, emptyFrom: 0,
    lastBumpSide: 'left', lastBumpKind: 'icon',
    bumpTimes: [],
    samples: [], sampleT: 0,
    slipTime: 0,
    cliffSide: 1,
    cmd: { v: 0, w: 0, brush: 1, sideBrush: 1, suction: 1 },
  };

  function emit(type, extra) {
    const e = { t: B.t, type };
    if (extra) Object.assign(e, extra);
    events.push(e);
  }
  function setMode(m, sub) {
    if (m !== B.mode) {
      emit('modeChange', { from: B.mode, to: m });
      B.prevMode = B.mode;
      B.mode = m;
    }
    if (sub !== undefined) B.sub = sub;
  }
  function addAnger(d) {
    const before = B.anger;
    B.anger = clamp(B.anger + d, 0, 1);
    if (before < BEH.ANGER_EVENT && B.anger >= BEH.ANGER_EVENT) emit('angry', { anger: B.anger });
  }

  // --- primitives -----------------------------------------------------------------------------------
  function beginBack(s, dist, speed) {
    B.seg.x0 = s.x; B.seg.y0 = s.y; B.seg.t0 = B.t; B.seg.backDist = dist; B.seg.backSpeed = speed;
  }
  function backDone(s) {
    return hypot(s.x - B.seg.x0, s.y - B.seg.y0) >= B.seg.backDist || B.t - B.seg.t0 > BEH.BACK_TIMEOUT;
  }
  function beginTurn(s, angle, dir) {
    angle = Math.min(Math.abs(angle), 3.0); // (-PI,PI] wrap: anything larger would flip direction
    B.seg.heading0 = wrapAngle(s.angle + dir * angle); B.seg.dir = dir; B.seg.t0 = B.t;
  }
  /** returns true when the turn is complete; sets cmd.w */
  function doTurn(s, cmd) {
    const rem = wrapAngle(B.seg.heading0 - s.angle);
    if (Math.abs(rem) < 0.06 || Math.sign(rem) !== B.seg.dir || B.t - B.seg.t0 > 4) { cmd.w = 0; return true; }
    cmd.v = 0;
    cmd.w = B.seg.dir * Math.min(BEH.W_TURN, 2.5 * Math.abs(rem) + 0.35);
    return false;
  }

  function startSpiral() {
    B.spiral.dir = rng.sign(); B.spiral.phi = 0; B.spiral.r = BEH.SPIRAL_R0;
    setMode('spiral', 'run');
  }
  function startStraight() {
    B.straightDist = 0; B.straightLimit = rng.range(BEH.STRAIGHT_MIN, BEH.STRAIGHT_MAX);
    setMode('bounce', 'straight');
  }
  /** bump reflex: back off, turn away, then straight / wall follow / return to the dock task */
  function startBounce(s, side, kind, allowWall, bearing) {
    B.lastBumpSide = side; B.lastBumpKind = kind;
    beginBack(s, rng.range(BEH.BACKOFF_MIN, BEH.BACKOFF_MAX), BEH.V_BACKOFF);
    const awayDir = side === 'left' ? 1 : side === 'right' ? -1 : rng.sign(); // left bump -> turn clockwise (right)
    if (B.returnMode) {
      B.afterTurn = 'return';
      B.seg.dir = awayDir; B.seg.turnAngle = rng.range(0.6, 1.4);
    } else if (allowWall && kind !== 'edge' && rng.chance(BEH.P_WALL_FOLLOW)) {
      B.afterTurn = 'wall';
      B.wall.side = side === 'left' ? -1 : 1;                   // wall ends up on the bumped side
      B.seg.dir = awayDir; B.seg.turnAngle = rng.range(BEH.WALL_ALIGN_MIN, BEH.WALL_ALIGN_MAX);
    } else {
      B.afterTurn = 'straight';
      B.seg.dir = awayDir; B.seg.turnAngle = glancingTurn(bearing ?? 0, BEH.TURN_MIN, BEH.TURN_MAX);
    }
    setMode('bounce', 'back');
  }
  function startCliff(s, cliffs) {
    // which side tripped: the first half of the sensors are on the left, the rest on the right
    let left = 0, right = 0;
    const half = cliffs.length / 2;
    cliffs.forEach((c, i) => { if (c.tripped) { if (i < half) left++; else right++; } });
    B.cliffSide = left > right ? -1 : right > left ? 1 : rng.sign();
    beginBack(s, BEH.CLIFF_BACK, BEH.V_CLIFF_BACK);
    B.seg.dir = -B.cliffSide;                                  // turn away from the edge
    B.seg.turnAngle = rng.range(BEH.CLIFF_TURN_MIN, BEH.CLIFF_TURN_MAX);
    B.afterTurn = B.returnMode ? 'return' : 'straight';
    if (B.mode === 'escape') { B.afterTurn = 'escapeTest'; }
    setMode('bounce', 'cliffBack');
    emit('cliff', { x: s.x * S, y: s.y * S });
  }
  function startWall(s) {
    B.wall.dist = 0; B.wall.target = rng.range(BEH.WALL_DIST_MIN, BEH.WALL_DIST_MAX); B.wall.lost = 0; B.wall.phase = 'follow';
    setMode('wall', 'follow');
  }
  function startSpot() {
    B.spot.dir = rng.sign(); B.spot.phi = 0; B.spot.r = BEH.SPOT_R0; B.spot.out = true;
    setMode('spot', 'run');
    emit('spot', {});
  }
  function startEscape(s, reason, testFirst) {
    // a fresh episode starts at rung 0; one that follows a recent episode keeps climbing the ladder
    if (B.t - (B.escape.lastEnd ?? -Infinity) > BEH.ESCAPE_MEMORY || testFirst) B.escape.attempt = 0;
    B.escape.step = 0; B.escape.timer = 0; B.escape.dir = rng.sign();
    B.escape.phase = testFirst ? 'test' : 'rung';
    B.escape.testSub = 'drive'; B.escape.testBumps = 0; B.escape.wallResume = false;
    B.escape.ax = s.x; B.escape.ay = s.y; // anchor: "free" means getting ESCAPE_FREE_DISP away from here
    B.slipTime = 0; B.samples.length = 0; B.bumpTimes.length = 0;
    setMode('escape', B.escape.phase);
    emit('escape', { reason, attempt: B.escape.attempt });
  }
  function becomeStuck() {
    B.anger = 1;
    setMode('stuck', 'sit');
    emit('stuck', { anger: 1 });
  }
  function startToDock(s, reason) {
    B.dockReason = reason; B.returnMode = 'toDock'; B.dockRetries = 0;
    emit('dockStart', { reason });
    replan(s);
    setMode('toDock', B.directMode ? 'direct' : 'follow');
  }
  function replan(s) {
    B.replanTimer = 0;
    const p = planPathPx(s.x * S, s.y * S, approach.x * S, approach.y * S);
    if (p && p.length >= 1) {
      B.path = p; B.pathM = p.map((q) => ({ x: q.x / S, y: q.y / S })); B.pathIdx = 0; B.directMode = false;
    } else {
      B.path = [{ x: s.x * S, y: s.y * S }, { x: approach.x * S, y: approach.y * S }];
      B.pathM = null; B.directMode = true;
    }
  }
  function startDocking(s) {
    B.dockSub = 'lineup'; B.dockTimer = 0; B.path = null; B.pathM = null;
    setMode('docking', 'lineup');
  }
  function undock() {
    B.returnMode = null;
    B.afterTurn = 'spiral';
    B.seg.dir = rng.sign(); B.seg.turnAngle = rng.range(2.4, 3.6);
    setMode('bounce', 'undock');
    B.undockStart = null;
  }

  /**
   * Side-sensor wall following. Returns 'lost' when the wall has been missing for too long.
   * wl: { side, lost }  side +1 = wall on the right, -1 = on the left.
   */
  function wallFollowCmd(s, wl, dt, cmd) {
    const d = wl.side > 0 ? s.sideR : s.sideL;
    if (d !== null) {
      wl.lost = 0;
      const err = d - BEH.WALL_TARGET;
      cmd.w = wl.side * clamp(BEH.WALL_KP * err, -BEH.W_WALL_MAX, BEH.W_WALL_MAX);
      cmd.v = BEH.V_WALL * (1 - 0.5 * Math.min(1, Math.abs(err) / 0.06));
    } else {
      wl.lost += dt;
      cmd.w = wl.side * BEH.W_WALL_SEEK;      // turn toward where the wall was: wraps around convex corners
      cmd.v = BEH.V_WALL * 0.75;
      if (wl.lost > BEH.WALL_LOST_TIMEOUT) return 'lost';
    }
    if (s.front !== null && s.front < BEH.GENTLE_RANGE) cmd.v = Math.min(cmd.v, BEH.V_GENTLE);
    return 'ok';
  }
  /** turn-away angle for a bump: glancing hits (large |bearing|) need less turning than head-on ones */
  function glancingTurn(bearing, lo, hi) {
    const headOn = 1 - Math.min(1, Math.abs(bearing) / (Math.PI / 2));
    return rng.range(lo, lo + (hi - lo) * 0.5) + (hi - lo) * 0.5 * headOn;
  }

  // --- the frame update -------------------------------------------------------------------------------------
  function update(dt, t, s) {
    B.t = t;
    const cmd = B.cmd;
    cmd.v = 0; cmd.w = 0; cmd.brush = 1; cmd.sideBrush = 1; cmd.suction = 1;
    const mode = B.mode;
    const inDock = DOCK_FAMILY.has(mode);
    const bump = s.bumpL || s.bumpR;
    const bumpSide = s.bumpL && s.bumpR ? 'both' : s.bumpL ? 'left' : 'right';
    const bumpKind = s.bumpKind || 'icon';
    const cliff = s.cliffs.some((c) => c.tripped);

    // anger decay while free
    if (CLEANING.has(mode) || mode === 'toDock' || mode === 'docking' || inDock) {
      B.anger = Math.max(0, B.anger - BEH.ANGER_DECAY * dt);
    }

    // bookkeeping for boxed-in detection
    if ((bump && s.bumpNew) || (cliff && s.cliffNew)) {
      B.bumpTimes.push(t);
      while (B.bumpTimes.length && t - B.bumpTimes[0] > BEH.BOX_WINDOW) B.bumpTimes.shift();
    }
    // odometry samples (10 Hz) for the stuck / boxed-in detectors
    B.odo += s.speed * dt;
    if (t - B.sampleT >= 0.1) {
      B.sampleT = t;
      B.samples.push({ x: s.x, y: s.y, odo: B.odo, t, cmd: Math.abs(B.lastCmdV || 0) >= BEH.STUCK_MIN_CMD });
      while (B.samples.length && t - B.samples[0].t > BEH.BOX_WINDOW + 0.05) B.samples.shift();
    }

    // --- dock-cycle triggers ----------------------------------------------------------------------
    if (CLEANING.has(mode) && !B.returnMode) {
      if (B.bin >= BEH.BIN_FULL) startToDock(s, 'binFull');
      else if (B.battery <= BEH.BATTERY_LOW) startToDock(s, 'battery');
    }
    if (B.battery <= 0 && !inDock && mode !== 'off') { setMode('off', 'dead'); B.path = null; }

    // --- reflexes -------------------------------------------------------------------------------------
    const reflexOk = !inDock && mode !== 'stuck' && mode !== 'off' && mode !== 'docking';
    if (reflexOk && cliff && B.sub !== 'cliffBack') {
      startCliff(s, s.cliffs);
    } else if (reflexOk && bump && s.bumpNew && mode !== 'escape' && !(mode === 'bounce' && (B.sub === 'back' || B.sub === 'cliffBack' || B.sub === 'undock'))) {
      if (mode === 'wall' && B.wall.phase === 'follow') {
        // inside corner: short back-off then turn away from the wall, keep following
        beginBack(s, BEH.BACKOFF_MIN, BEH.V_BACKOFF);
        B.seg.dir = -B.wall.side; B.seg.turnAngle = BEH.WALL_CORNER_TURN + rng.range(-0.2, 0.2);
        B.afterTurn = 'wallResume';
        setMode('bounce', 'back');
      } else if (mode === 'spot') {
        B.spot.lastEnd = t;
        startBounce(s, bumpSide, bumpKind, false, s.bumpBearing);
      } else {
        startBounce(s, bumpSide, bumpKind, mode !== 'toDock', s.bumpBearing);
      }
    }

    // --- stuck detection (not while escaping/stuck/docked/off) ------------------------------------------
    if (reflexOk && mode !== 'escape') {
      let reason = null;
      const slip = (s.slipL + s.slipR) * 0.5;
      if (slip > BEH.SLIP_STUCK && Math.abs(B.lastCmdV || 0) >= BEH.STUCK_MIN_CMD) B.slipTime += dt; else B.slipTime = 0;
      if (B.slipTime > BEH.SLIP_TIME) reason = 'slip';
      if (!reason && B.samples.length >= 2) {
        // commanded to move for the whole window but the body barely travelled
        let allCmd = true, k = B.samples.length - 1;
        while (k >= 0 && t - B.samples[k].t <= BEH.STUCK_WINDOW) { if (!B.samples[k].cmd) { allCmd = false; break; } k--; }
        const old = B.samples[Math.max(0, k)];
        if (allCmd && t - old.t >= BEH.STUCK_WINDOW - 0.05 && B.odo - old.odo < BEH.STUCK_DISP) reason = 'noMotion';
      }
      if (!reason && B.bumpTimes.length >= BEH.BOX_BUMPS && B.samples.length > 10) {
        // many bumps/cliffs AND the robot has not gone anywhere: boxed in
        let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
        for (const q of B.samples) { if (q.x < minx) minx = q.x; if (q.x > maxx) maxx = q.x; if (q.y < miny) miny = q.y; if (q.y > maxy) maxy = q.y; }
        if (Math.max(maxx - minx, maxy - miny) < BEH.BOX_EXTENT) reason = 'boxedIn';
      }
      if (reason) startEscape(s, reason, false);
    }

    // --- behaviours --------------------------------------------------------------------------------------
    switch (B.mode) {
      case 'spiral': {
        const sp = B.spiral;
        sp.r = BEH.SPIRAL_R0 + BEH.SPIRAL_PITCH * sp.phi / (2 * Math.PI);
        let v = Math.min(BEH.V_SPIRAL_MAX, BEH.W_SPIRAL_MAX * sp.r);
        if (s.front !== null && s.front < BEH.GENTLE_RANGE) v = Math.min(v, BEH.V_GENTLE);
        const w = sp.dir * v / sp.r;
        sp.phi += Math.abs(w) * dt;
        cmd.v = v; cmd.w = w;
        if (sp.r > BEH.SPIRAL_R_MAX) startStraight();
        break;
      }
      case 'bounce': {
        if (B.sub === 'back' || B.sub === 'cliffBack') {
          cmd.v = -B.seg.backSpeed; cmd.w = 0;
          if (backDone(s)) {
            beginTurn(s, B.seg.turnAngle, B.seg.dir);
            B.sub = 'turn';
          }
        } else if (B.sub === 'undock') {
          if (!B.undockStart) { B.undockStart = { x: s.x, y: s.y }; }
          cmd.v = -BEH.V_UNDOCK; cmd.w = 0; cmd.brush = 0; cmd.suction = 0; cmd.sideBrush = 0;
          if (hypot(s.x - B.undockStart.x, s.y - B.undockStart.y) >= BEH.UNDOCK_REVERSE || bump) {
            beginTurn(s, B.seg.turnAngle, B.seg.dir);
            B.sub = 'turn';
          }
        } else if (B.sub === 'turn') {
          if (doTurn(s, cmd)) {
            switch (B.afterTurn) {
              case 'wall': startWall(s); break;
              case 'wallResume': B.wall.lost = 0; setMode('wall', 'follow'); break;
              case 'spiral': startSpiral(); break;
              case 'return': replan(s); setMode('toDock', B.directMode ? 'direct' : 'follow'); break;
              case 'escapeTest': B.escape.phase = 'test'; B.escape.testSub = 'drive'; B.escape.testBumps++; B.escape.wallResume = false; setMode('escape', 'test'); break;
              default: startStraight();
            }
          }
        } else { // straight
          let v = BEH.V_CRUISE;
          if (s.front !== null && s.front < BEH.GENTLE_RANGE) v = BEH.V_GENTLE;
          cmd.v = v; cmd.w = 0;
          B.straightDist += Math.max(0, s.vFwd) * dt;
          if (B.straightDist > B.straightLimit) {
            if (rng.chance(BEH.P_SPIRAL)) startSpiral();
            else { B.straightDist = 0; B.straightLimit = rng.range(BEH.STRAIGHT_MIN, BEH.STRAIGHT_MAX); }
          }
        }
        break;
      }
      case 'wall': {
        const wl = B.wall;
        if (wallFollowCmd(s, wl, dt, cmd) === 'lost') { startStraight(); break; }
        wl.dist += Math.max(0, s.vFwd) * dt;
        if (wl.dist > wl.target) {
          // leave the wall: turn away a bit, then straight
          beginTurn(s, rng.range(0.5, 1.2), -wl.side);
          B.afterTurn = 'straight';
          setMode('bounce', 'turn');
        }
        break;
      }
      case 'spot': {
        const sp = B.spot;
        if (sp.out) { sp.r = BEH.SPOT_R0 + BEH.SPOT_PITCH * sp.phi / (2 * Math.PI); if (sp.r >= BEH.SPOT_R_MAX) { sp.out = false; sp.phi = 0; } }
        else { sp.r = BEH.SPOT_R_MAX - BEH.SPOT_PITCH * sp.phi / (2 * Math.PI); if (sp.r <= BEH.SPOT_R0) { sp.lastEnd = t; startStraight(); break; } }
        const v = Math.min(BEH.V_SPOT, BEH.W_SPIRAL_MAX * sp.r);
        const w = sp.dir * v / sp.r;
        sp.phi += Math.abs(w) * dt;
        cmd.v = v; cmd.w = w;
        break;
      }
      case 'escape': {
        const es = B.escape;
        es.timer += dt;
        cmd.brush = 0.4; cmd.suction = 0.3;
        // which side looks open to the side IR sensors (null = nothing in range)
        const openDir = s.sideL === null && s.sideR !== null ? -1 : s.sideR === null && s.sideL !== null ? 1 : es.dir;
        if (es.phase === 'test') {
          // bumper-reactive test drive: forward; on bump back off and turn away; free once we got
          // ESCAPE_FREE_DISP away from where the episode started
          if (es.testSub === 'back') {
            cmd.v = -BEH.V_BACKOFF; cmd.w = 0;
            if (backDone(s)) { beginTurn(s, es.turnAngle, es.turnDir); es.testSub = 'turn'; }
          } else if (es.testSub === 'turn') {
            if (doTurn(s, cmd)) es.testSub = 'drive';
          } else {
            if (es.wallResume) {
              if (wallFollowCmd(s, es.wall, dt, cmd) === 'lost') es.wallResume = false;
            } else {
              cmd.v = 0.2; cmd.w = 0;
              if (s.front !== null && s.front < BEH.GENTLE_RANGE) cmd.v = BEH.V_GENTLE;
            }
            if (bump && s.bumpNew) {
              es.testBumps++;
              beginBack(s, BEH.BACKOFF_MIN, BEH.V_BACKOFF);
              es.turnDir = bumpSide === 'left' ? 1 : bumpSide === 'right' ? -1 : openDir;
              es.turnAngle = glancingTurn(s.bumpBearing, 0.5, 2.0);
              es.testSub = 'back';
            }
          }
          const disp = hypot(s.x - es.ax, s.y - es.ay);
          if (disp >= BEH.ESCAPE_FREE_DISP) {
            es.lastEnd = t;
            emit('unstuck', { attempts: es.attempt });
            B.anger = Math.max(0, B.anger - 0.3);
            B.bumpTimes.length = 0; B.samples.length = 0; B.slipTime = 0;
            if (B.returnMode) { replan(s); setMode('toDock', B.directMode ? 'direct' : 'follow'); }
            else startStraight();
          } else if (es.timer > BEH.ESCAPE_TEST_TIME || es.testBumps > BEH.ESCAPE_TEST_BUMPS) {
            es.attempt++;
            addAnger(BEH.ANGER_PER_ATTEMPT);
            if (es.attempt >= BEH.ESCAPE_ATTEMPTS) { becomeStuck(); break; }
            es.phase = 'rung'; es.step = 0; es.timer = 0; es.dir = openDir;
            B.sub = 'rung';
            emit('escape', { reason: 'retry', attempt: es.attempt });
          }
        } else {
          // rung sequence; es.attempt selects the manoeuvre (ladder of increasing effort)
          const rung = es.attempt % 6;
          let done = false;
          switch (rung) {
            case 0: // wiggle: alternate yaw with a slight reverse
              cmd.v = -0.05; cmd.w = (Math.floor(es.timer / 0.4) % 2 === 0 ? 1 : -1) * es.dir * 2.0;
              done = es.timer > 1.6; break;
            case 1: // reverse while turning toward the open side
              cmd.v = -0.15; cmd.w = es.dir * 1.2; done = es.timer > 0.9; break;
            case 2: { // follow whatever wall the side sensor sees: walks out of slots and corners
              if (es.timer < dt * 1.5) {
                es.wall.side = s.sideR !== null && s.sideL === null ? 1 : s.sideL !== null && s.sideR === null ? -1 : rng.sign();
                es.wall.lost = 0;
              }
              const r = wallFollowCmd(s, es.wall, dt, cmd);
              if (bump && s.bumpNew) { // inside corner: short back-off, turn away from the wall, keep following
                beginBack(s, BEH.BACKOFF_MIN, BEH.V_BACKOFF);
                es.turnDir = -es.wall.side; es.turnAngle = BEH.WALL_CORNER_TURN;
                es.testSub = 'back'; es.phase = 'test'; es.timer = 0; es.testBumps = 0; B.sub = 'test';
                es.wallResume = true;
              }
              done = r === 'lost' || es.timer > BEH.ESCAPE_WALL_TIME; break;
            }
            case 3: // long reverse then a big turn
              if (es.timer < 1.5) { cmd.v = -0.15; cmd.w = 0; }
              else { cmd.v = 0; cmd.w = es.dir * BEH.W_TURN; }
              done = es.timer > 2.7; break;
            case 4: // spin 180 in place
              cmd.v = 0; cmd.w = es.dir * BEH.W_TURN; done = es.timer > Math.PI / BEH.W_TURN; break;
            default: // forward arc the other way
              cmd.v = 0.1; cmd.w = -es.dir * 1.5; done = es.timer > 1.2; break;
          }
          if (bump && s.bumpNew && cmd.v > 0 && rung !== 2) done = true; // ran into something: stop the manoeuvre, test from here
          if (done) {
            es.phase = 'test'; es.timer = 0; es.testSub = 'drive'; es.testBumps = 0; es.wallResume = false;
            B.sub = 'test';
          }
        }
        break;
      }
      case 'stuck': {
        cmd.v = 0; cmd.w = 0; cmd.brush = 0; cmd.sideBrush = 0; cmd.suction = 0;
        B.anger = 1;
        break;
      }
      case 'toDock': {
        B.replanTimer += dt;
        if (B.replanTimer > BEH.REPLAN_INTERVAL) replan(s);
        const dA = hypot(s.x - approach.x, s.y - approach.y);
        if (dA < BEH.DOCK_ARRIVE_R) { startDocking(s); break; }
        let tx = approach.x, ty = approach.y;
        if (!B.directMode && B.pathM) {
          // advance waypoints, pick lookahead target
          while (B.pathIdx < B.pathM.length - 1 && hypot(s.x - B.pathM[B.pathIdx].x, s.y - B.pathM[B.pathIdx].y) < BEH.PATH_WP_RADIUS) B.pathIdx++;
          let k = B.pathIdx;
          while (k < B.pathM.length - 1 && hypot(s.x - B.pathM[k].x, s.y - B.pathM[k].y) < BEH.PATH_LOOKAHEAD) k++;
          tx = B.pathM[k].x; ty = B.pathM[k].y;
        }
        const e = wrapAngle(Math.atan2(ty - s.y, tx - s.x) - s.angle);
        cmd.w = clamp(BEH.PATH_KP * e, -BEH.W_TURN, BEH.W_TURN);
        cmd.v = Math.abs(e) > 0.9 ? 0 : BEH.V_PATH * Math.max(0.2, Math.cos(e));
        if (dA < 0.4) cmd.v = Math.min(cmd.v, 0.15);
        if (s.front !== null && s.front < BEH.GENTLE_RANGE) cmd.v = Math.min(cmd.v, BEH.V_GENTLE);
        break;
      }
      case 'docking': {
        B.dockTimer += dt;
        const relx = s.x - dock.x, rely = s.y - dock.y;
        const along = relx * ux + rely * uy;            // < 0 before the dock
        const lateral = relx * -uy + rely * ux;         // + = clockwise side of the axis
        const headErr = wrapAngle(dock.angle - s.angle);
        cmd.brush = 0; cmd.sideBrush = 0; cmd.suction = 0.3;
        if (B.dockSub === 'lineup') {
          // get onto the dock axis at the approach point before turning to face the dock
          const dA = hypot(approach.x - s.x, approach.y - s.y);
          if (dA < BEH.DOCK_LINEUP_TOL || B.dockTimer > 8) { B.dockSub = 'align'; B.sub = 'align'; B.dockTimer = 0; break; }
          const e = wrapAngle(Math.atan2(approach.y - s.y, approach.x - s.x) - s.angle);
          if (Math.abs(e) > Math.PI / 2 && dA < 0.12) {
            // target is behind and close: reverse toward it instead of turning around
            const eb = wrapAngle(e + Math.PI);
            cmd.w = clamp(-3 * eb, -1.2, 1.2); cmd.v = -0.08;
          } else {
            cmd.w = clamp(3 * e, -BEH.W_TURN, BEH.W_TURN);
            cmd.v = Math.abs(e) > 0.6 ? 0 : Math.min(0.12, 0.5 * dA + 0.03);
          }
        } else if (B.dockSub === 'align') {
          cmd.v = 0;
          cmd.w = clamp(3 * headErr, -BEH.W_TURN, BEH.W_TURN);
          if (Math.abs(headErr) < BEH.DOCK_ALIGN_TOL) { B.dockSub = 'creep'; B.sub = 'creep'; B.dockTimer = 0; }
          else if (B.dockTimer > 6) { B.dockSub = 'lineup'; B.sub = 'lineup'; B.dockTimer = 0; }
        } else if (B.dockSub === 'creep') {
          // aim at a point on the axis DOCK_AIM_AHEAD ahead: converges onto the axis while creeping in
          const aim = wrapAngle(dock.angle - Math.atan2(lateral, BEH.DOCK_AIM_AHEAD));
          const e = wrapAngle(aim - s.angle);
          cmd.w = clamp(3 * e, -1.0, 1.0);
          cmd.v = BEH.V_DOCK_CREEP;
          if (along >= -0.01 || (bump && along > -0.08)) {
            cmd.v = 0; cmd.w = 0;
            B.dockRetries = 0;
            setMode('docked', 'pause'); B.dockTimer = 0;
            emit('docked', {});
          } else if (Math.abs(lateral) > BEH.DOCK_LATERAL_TOL || Math.abs(headErr) > 0.6 || B.dockTimer > 14 || (bump && along <= -0.08)) {
            B.dockRetries++;
            if (B.dockRetries > BEH.DOCK_RETRIES) { replan(s); setMode('toDock', B.directMode ? 'direct' : 'follow'); break; }
            B.dockSub = 'retreat'; B.sub = 'retreat'; B.dockTimer = 0;
          }
        } else { // retreat: back out past the approach point, then line up again
          cmd.v = -0.12; cmd.w = clamp(2 * headErr, -0.8, 0.8);
          if (along <= -BEH.DOCK_APPROACH_DIST - 0.05 || B.dockTimer > 6) { B.dockSub = 'lineup'; B.sub = 'lineup'; B.dockTimer = 0; }
        }
        break;
      }
      case 'docked': {
        cmd.v = 0; cmd.w = 0; cmd.brush = 0; cmd.sideBrush = 0; cmd.suction = 0;
        B.dockTimer += dt;
        if (B.dockTimer >= BEH.DOCKED_PAUSE) {
          setMode('emptying', 'empty'); B.dockTimer = 0; B.emptyFrom = B.bin;
          emit('emptyStart', { bin: B.bin });
        }
        break;
      }
      case 'emptying': {
        cmd.v = 0; cmd.w = 0; cmd.brush = 0; cmd.sideBrush = 0; cmd.suction = 0;
        B.dockTimer += dt;
        B.bin = Math.max(0, B.emptyFrom * (1 - B.dockTimer / BEH.EMPTY_SECONDS));
        if (B.dockTimer >= BEH.EMPTY_SECONDS) {
          B.bin = 0;
          emit('emptyEnd', {});
          setMode('charging', 'charge'); B.dockTimer = 0;
        }
        break;
      }
      case 'charging': {
        cmd.v = 0; cmd.w = 0; cmd.brush = 0; cmd.sideBrush = 0; cmd.suction = 0;
        B.battery = Math.min(1, B.battery + dt * (BEH.BATTERY_FULL - BEH.BATTERY_LOW) / BEH.CHARGE_SECONDS);
        if (B.battery >= BEH.BATTERY_FULL) {
          emit('chargeEnd', { battery: B.battery });
          undock();
        }
        break;
      }
      case 'off':
      default: {
        cmd.v = 0; cmd.w = 0; cmd.brush = 0; cmd.sideBrush = 0; cmd.suction = 0;
        break;
      }
    }

    // dirt detect -> spot clean (only while in plain cleaning modes)
    if ((B.mode === 'bounce' && B.sub === 'straight') || B.mode === 'spiral' || B.mode === 'wall') {
      if (s.pickRate >= BEH.DIRT_RATE && t - B.spot.lastEnd > BEH.SPOT_COOLDOWN) startSpot();
    }

    if (B.mode !== 'toDock') B.path = null; // the planned path is only shown while heading to the dock
    B.lastCmdV = cmd.v;
    return cmd;
  }

  return {
    state: B,
    update,
    get mode() { return B.mode; },
    get anger() { return B.anger; }, set anger(v) { B.anger = clamp(v, 0, 1); },
    get path() { return B.path; },
    get bin() { return B.bin; }, set bin(v) { B.bin = clamp(v, 0, 1); },
    get battery() { return B.battery; }, set battery(v) { B.battery = clamp(v, 0, 1); },
    get motorsOn() { return !DOCK_FAMILY.has(B.mode) && B.mode !== 'off' && B.mode !== 'stuck'; },
    /** start life on the dock: back out, turn, spiral */
    startUndocked() { undock(); },
    /** user API */
    sendToDock(s) { if (!DOCK_FAMILY.has(B.mode) && B.mode !== 'toDock' && B.mode !== 'docking') startToDock(s, 'user'); },
    emptyBinNow() {
      const was = B.bin;
      B.bin = 0;
      if (B.mode === 'emptying') { emit('emptyEnd', {}); setMode('charging', 'charge'); B.dockTimer = 0; }
      else emit('binEmptied', { was });   // instant empty away from the dock (works in every mode, incl. remote control)
    },
    resume(s) {
      if (DOCK_FAMILY.has(B.mode)) { emit('chargeEnd', { battery: B.battery }); undock(); }
      else if (B.mode === 'stuck' || B.mode === 'off') { B.anger = BEH.ANGER_AFTER_FREED; if (B.battery <= 0) B.battery = 0.5; startEscape(s, 'resume', true); }
    },
    /** the user handed control back after driving it by hand: start cleaning fresh from here */
    takeBack() {
      // the normal update sends it home next frame if the bin is full or the battery is low
      if (B.battery <= 0) B.battery = 0.05;
      startSpiral();
    },
    /** the user moved an icon: a stuck robot gets another go */
    iconMoved(s) {
      if (B.mode === 'stuck') { B.anger = BEH.ANGER_AFTER_FREED; startEscape(s, 'freed', true); }
    },
    approachPoint: approach,
  };
}
