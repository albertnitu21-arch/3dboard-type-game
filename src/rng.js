// Seeded random numbers (mulberry32).
//
// The generator's state lives inside the game state (`state.rng`), so a game is
// fully reproducible from its seed and can be serialized/resumed at any point.
// The server is the only place that should ever roll dice.

/** Returns a float in [0, 1) and advances `state.rng`. */
export function rand(state) {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = Math.imul(state.rng ^ (state.rng >>> 15), 1 | state.rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [0, n). */
export function randInt(state, n) {
  return Math.floor(rand(state) * n);
}

/** Fisher-Yates shuffle; returns a new array. */
export function shuffle(state, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(state, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Standalone seeded generator (for bots/tests): returns a () => [0,1) function. */
export function makeRng(seed) {
  const st = { rng: seed | 0 };
  return () => rand(st);
}
