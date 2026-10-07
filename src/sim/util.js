// Shared helpers for the sim: seeded RNG and small math utilities.
// No DOM access. All functions are pure except the RNG object state.

/** Mulberry32: tiny, fast, deterministic 32-bit PRNG. */
export function createRng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** uniform [0,1) */
    next,
    /** uniform [lo,hi) */
    range: (lo, hi) => lo + (hi - lo) * next(),
    /** integer in [lo,hi] */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** true with probability p */
    chance: (p) => next() < p,
    /** -1 or +1 */
    sign: () => (next() < 0.5 ? -1 : 1),
    /** approx standard normal (sum of 4 uniforms, cheap and good enough for clumps) */
    gauss: () => (next() + next() + next() + next() - 2) * 1.7320508,
  };
}

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** wrap angle to (-PI, PI] */
export function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

export function hypot(x, y) {
  return Math.sqrt(x * x + y * y);
}

/** move value toward target by at most maxDelta */
export function approach(value, target, maxDelta) {
  if (value < target) return Math.min(value + maxDelta, target);
  if (value > target) return Math.max(value - maxDelta, target);
  return value;
}

export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
