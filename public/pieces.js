// Player pieces: sixteen original, slightly silly characters, modelled with smooth
// shapes (surfaces of revolution, tubes along curves, rounded boxes...).
//
// Each piece: { key, name, emoji, build(), scale?, thumbYaw? } where build() returns parts:
//   { geo, m (4x4 model matrix), color: [r,g,b] | 'P' (player colour) | 'D' (darker), spec, emit }
// board3d.js merges the parts into one mesh per colour group, so a whole piece is
// only a few draw calls. Pieces face +z (their direction of travel) and stand on y = 0,
// about 0.6 units tall (a board square is 0.89 wide).
//
// This file is also imported by the server (for the list of keys), so it must not
// touch the DOM; geometry is only built when build() is called.

import {
  latheGeo, sphereGeo, cylGeo, coneGeo, torusGeo, rboxGeo, leafGeo, paramGeo, tubeGeo, curve,
} from './geometry.js';
import { trs, quat, hexToRgb } from './math3d.js';

const PI = Math.PI;
const cache = {};
const once = (key, make) => (cache[key] ??= make());
const SPH = () => once('sph', () => sphereGeo(32, 20));
const CYL = () => once('cyl', () => cylGeo(32));
const CONE = () => once('cone', () => coneGeo(32));

/** One part. rot: [rx, ry, rz] Euler angles (yaw, then pitch, then roll) or a quaternion. */
function part(geo, at = [0, 0, 0], scale = 1, color = '#ffffff', rot = null, { spec = 0.5, emit = 0 } = {}) {
  const q = !rot ? undefined : rot.length === 4 ? rot : quat.euler(rot[0], rot[1], rot[2]);
  const c = color === 'P' || color === 'D' ? color : typeof color === 'string' ? hexToRgb(color) : color;
  return { geo, m: trs(at, q, scale), color: c, spec, emit };
}
const sph = (at, size, color, rot, o) => part(SPH(), at, size, color, rot, o);

/** A glossy cartoon eye looking forward (+z): white, pupil, tiny highlight. */
function eye(x, y, z, r, { pupil = '#16181c', white = '#ffffff', squash = 1 } = {}) {
  return [
    sph([x, y, z], [r * 2, r * 2 * squash, r * 1.6], white, null, { spec: 0.9 }),
    sph([x, y, z + r * 0.62], [r * 1.15, r * 1.25 * squash, r * 0.6], pupil, null, { spec: 1 }),
    sph([x + r * 0.28, y + r * 0.35, z + r * 0.86], r * 0.42, '#ffffff', null, { spec: 0, emit: 0.4 }),
  ];
}
const eyes = (dx, y, z, r, o) => [...eye(-dx, y, z, r, o), ...eye(dx, y, z, r, o)];
const blush = (dx, y, z, r = 0.022) => [
  sph([-dx, y, z], [r * 2, r * 1.2, r * 0.6], '#ff8fa3', [0, -0.5, 0], { spec: 0 }),
  sph([dx, y, z], [r * 2, r * 1.2, r * 0.6], '#ff8fa3', [0, 0.5, 0], { spec: 0 }),
];
/** Small beads along an arc, for smiles. */
function smile(y, z, w, r = 0.007, color = '#2a1e1a', n = 7, depth = 0.6) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1) - 0.5;
    return sph([t * w, y - (0.25 - t * t) * w * depth * 0.5, z - Math.abs(t) * w * 0.25], r * 2, color, null, { spec: 0.3 });
  });
}
const lathe = (key, profile, seg = 40) => once(`lathe:${key}`, () => latheGeo(profile, seg));
const ring = (key, R, r) => once(key, () => torusGeo(R, r, 40, 14));

// ---------------------------------------------------------------- the pieces

function duck() {
  const Y = '#ffd02a', Y2 = '#f5bd16';
  return [
    sph([0, 0.13, -0.02], [0.34, 0.25, 0.42], Y, null, { spec: 0.7 }),
    sph([0, 0.15, 0.08], [0.27, 0.22, 0.24], Y, null, { spec: 0.7 }),
    part(CONE(), [0, 0.17, -0.19], [0.13, 0.15, 0.08], Y, [-1.0, 0, 0], { spec: 0.7 }),
    sph([-0.155, 0.17, -0.03], [0.07, 0.13, 0.21], Y2, [0, 0, 0.25], { spec: 0.6 }),
    sph([0.155, 0.17, -0.03], [0.07, 0.13, 0.21], Y2, [0, 0, -0.25], { spec: 0.6 }),
    sph([0, 0.36, 0.07], 0.23, Y, null, { spec: 0.7 }),
    sph([0, 0.347, 0.19], [0.13, 0.05, 0.13], '#ff8a1f', null, { spec: 0.8 }),
    sph([0, 0.322, 0.18], [0.11, 0.035, 0.1], '#f2701a', null, { spec: 0.6 }),
    ...eyes(0.052, 0.395, 0.15, 0.027),
    ...blush(0.085, 0.35, 0.15, 0.02),
    // a woolly beanie in the player's colour, with a pompom
    part(lathe('beanie', [[0.105, 0], [0.11, 0.02], [0.1, 0.05], [0.08, 0.08], [0.045, 0.1], [0, 0.105]]), [0, 0.425, 0.06], 1, 'P', [-0.15, 0, 0], { spec: 0.15 }),
    part(ring('beanieRim', 0.104, 0.016), [0, 0.43, 0.06], 1, 'D', [-0.15, 0, 0], { spec: 0.15 }),
    sph([0, 0.535, 0.045], 0.055, '#ffffff', null, { spec: 0.1 }),
  ];
}

function rocket() {
  const body = lathe('rocketBody', [[0, 0.07], [0.07, 0.07], [0.088, 0.11], [0.096, 0.18], [0.096, 0.3], [0.088, 0.38], [0.072, 0.44], [0, 0.44]]);
  const nose = lathe('rocketNose', [[0, 0.438], [0.073, 0.438], [0.066, 0.47], [0.052, 0.51], [0.034, 0.55], [0.016, 0.585], [0, 0.6]]);
  const nozzle = lathe('rocketNozzle', [[0, 0.075], [0.05, 0.075], [0.056, 0.05], [0.068, 0.02], [0.062, 0.018], [0.045, 0.045], [0, 0.05]]);
  const parts = [
    part(body, [0, 0, 0], 1, '#f3efe6', null, { spec: 0.7 }),
    part(nose, [0, 0, 0], 1, 'P', null, { spec: 0.8 }),
    part(nozzle, [0, 0, 0], 1, '#4a4f57', null, { spec: 0.9 }),
    part(ring('rocketBand', 0.094, 0.012), [0, 0.13, 0], 1, 'P', null, { spec: 0.7 }),
    part(ring('rocketPort', 0.042, 0.011), [0, 0.3, 0.09], 1, '#c9ccd2', [PI / 2, 0, 0], { spec: 1 }),
    sph([0, 0.3, 0.088], [0.075, 0.075, 0.03], '#8fd8ff', null, { spec: 1, emit: 0.15 }),
  ];
  for (let k = 0; k < 3; k++) {
    const a = PI + (k * 2 * PI) / 3;
    parts.push(part(once('fin', () => rboxGeo(0.014, 0.17, 0.085, 0.006)), [Math.sin(a) * 0.115, 0.085, Math.cos(a) * 0.115], 1, 'D', [0.12, a, 0], { spec: 0.6 }));
  }
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * PI * 2;
    parts.push(sph([Math.sin(a) * 0.094, 0.37, Math.cos(a) * 0.094], 0.012, '#c9ccd2', null, { spec: 1 }));
  }
  return parts;
}

function snowman() {
  const W = '#fbfdff', K = '#24272c';
  const twig = (s) => tubeGeo(curve([[0.085 * s, 0.35, 0], [0.15 * s, 0.39, 0.01], [0.2 * s, 0.44, 0.02]], 6), (t) => 0.009 * (1 - t * 0.5), 8);
  return [
    sph([0, 0.135, 0], 0.27, W, null, { spec: 0.25 }),
    sph([0, 0.33, 0], 0.21, W, null, { spec: 0.25 }),
    sph([0, 0.48, 0], 0.165, W, null, { spec: 0.25 }),
    ...[0.37, 0.32, 0.27].map((y) => sph([0, y, 0.1 - (0.37 - y) * 0.12], 0.024, K, null, { spec: 0.6 })),
    ...eyes(0.032, 0.505, 0.065, 0.016, { white: K, pupil: K }),
    ...smile(0.462, 0.075, 0.06, 0.006, K, 6),
    part(lathe('carrot', [[0, 0], [0.022, 0], [0.021, 0.025], [0.015, 0.065], [0.007, 0.095], [0, 0.11]], 20), [0, 0.48, 0.075], 1, '#ff7a1a', [PI / 2, 0, 0], { spec: 0.4 }),
    part(once('twigL', () => twig(-1)), [0, 0, 0], 1, '#6b4a2b', null, { spec: 0.1 }),
    part(once('twigR', () => twig(1)), [0, 0, 0], 1, '#6b4a2b', null, { spec: 0.1 }),
    // top hat with a band, and a scarf, in the player's colour
    part(CYL(), [0, 0.55, 0], [0.19, 0.012, 0.19], K, null, { spec: 0.5 }),
    part(lathe('hatCrown', [[0, 0], [0.056, 0], [0.06, 0.09], [0.064, 0.105], [0, 0.105]]), [0, 0.558, 0], 1, K, null, { spec: 0.5 }),
    part(CYL(), [0, 0.564, 0], [0.123, 0.026, 0.123], 'P', null, { spec: 0.4 }),
    part(ring('scarf', 0.078, 0.024), [0, 0.415, 0], 1, 'P', null, { spec: 0.15 }),
    part(once('scarfTail', () => rboxGeo(0.045, 0.12, 0.018, 0.008)), [0.045, 0.36, 0.085], 1, 'P', [0.2, 0, 0.18], { spec: 0.15 }),
    part(once('scarfTail', () => rboxGeo(0.045, 0.12, 0.018, 0.008)), [0.045, 0.31, 0.093], [1, 0.12, 1.05], 'D', [0.2, 0, 0.18], { spec: 0.15 }),
  ];
}

function mushroom() {
  const capProfile = [[0.22, 0.27], [0.245, 0.282], [0.252, 0.31], [0.238, 0.37], [0.205, 0.43], [0.155, 0.48], [0.085, 0.512], [0, 0.522]];
  const capY = (r) => {
    for (let i = capProfile.length - 1; i > 0; i--) {
      const [r0, y0] = capProfile[i], [r1, y1] = capProfile[i - 1];
      if (r >= r0 && r <= r1) return y0 + ((r - r0) / (r1 - r0 || 1)) * (y1 - y0);
    }
    return 0.31;
  };
  const spots = [[0, 0], [0.12, 0.4], [0.15, 1.9], [0.13, 3.3], [0.17, 4.6], [0.19, 5.6], [0.08, 2.6]].map(([r, a]) => {
    const y = capY(r);
    const slope = Math.atan2(capY(Math.max(r - 0.02, 0)) - capY(r + 0.02), 0.04);
    return sph([Math.sin(a) * r, y - 0.004, Math.cos(a) * r], [0.07 - r * 0.12, 0.03, 0.07 - r * 0.12], '#ffffff', [slope, a, 0], { spec: 0.4 });
  });
  return [
    part(lathe('stem', [[0, 0], [0.1, 0], [0.112, 0.015], [0.108, 0.06], [0.098, 0.14], [0.092, 0.22], [0.1, 0.27], [0, 0.27]]), [0, 0, 0], 1, '#f6ead2', null, { spec: 0.3 }),
    part(ring('mushSkirt', 0.098, 0.014), [0, 0.215, 0], 1, '#efe0c4', null, { spec: 0.3 }),
    part(lathe('gills', [[0, 0.292], [0.1, 0.286], [0.17, 0.275], [0.222, 0.27]]), [0, 0, 0], 1, '#ead6b8', null, { spec: 0.2 }),
    part(lathe('cap', capProfile, 48), [0, 0, 0], 1, 'P', null, { spec: 0.6 }),
    ...spots,
    ...eyes(0.034, 0.165, 0.092, 0.019),
    ...blush(0.06, 0.135, 0.09, 0.017),
    ...smile(0.12, 0.103, 0.035, 0.005, '#4a2a1a', 5),
  ];
}

function robot() {
  const G = '#5b616b', S = '#c4cad3';
  const arm = (s) => tubeGeo(curve([[0.118 * s, 0.25, 0], [0.14 * s, 0.2, 0.02], [0.15 * s, 0.15, 0.05]], 6), 0.021, 12);
  return [
    ...[-1, 1].flatMap((s) => [
      part(once('rleg', () => rboxGeo(0.055, 0.1, 0.07, 0.015)), [0.05 * s, 0.075, 0], 1, G, null, { spec: 0.7 }),
      part(once('rfoot', () => rboxGeo(0.078, 0.032, 0.105, 0.012)), [0.05 * s, 0.016, 0.012], 1, '#3e434b', null, { spec: 0.7 }),
      sph([0.118 * s, 0.252, 0], 0.05, S, null, { spec: 0.9 }),
      part(once(`rarm${s}`, () => arm(s)), [0, 0, 0], 1, G, null, { spec: 0.8 }),
      part(ring('claw', 0.022, 0.008), [0.152 * s, 0.13, 0.055], 1, S, [0, 0, PI / 2], { spec: 0.9 }),
      part(CYL(), [0.093 * s, 0.38, 0], [0.04, 0.03, 0.04], G, [0, 0, PI / 2], { spec: 0.8 }),
    ]),
    part(once('rbody', () => rboxGeo(0.2, 0.17, 0.15, 0.035)), [0, 0.205, 0], 1, 'P', null, { spec: 0.75 }),
    part(once('rpanel', () => rboxGeo(0.12, 0.07, 0.012, 0.006)), [0, 0.215, 0.076], 1, '#e9edf2', null, { spec: 0.6 }),
    sph([-0.035, 0.215, 0.083], 0.02, '#ff4a3d', null, { emit: 0.4 }),
    sph([0, 0.215, 0.083], 0.02, '#ffd23a', null, { emit: 0.4 }),
    sph([0.035, 0.215, 0.083], 0.02, '#3ed17a', null, { emit: 0.4 }),
    part(CYL(), [0, 0.29, 0], [0.05, 0.04, 0.05], G, null, { spec: 0.8 }),
    part(once('rhead', () => rboxGeo(0.17, 0.13, 0.14, 0.04)), [0, 0.38, 0], 1, S, null, { spec: 0.95 }),
    part(once('rvisor', () => rboxGeo(0.135, 0.062, 0.012, 0.012)), [0, 0.388, 0.068], 1, '#1c2430', null, { spec: 1 }),
    sph([-0.032, 0.388, 0.075], [0.034, 0.03, 0.012], '#3ef0ff', null, { emit: 0.9 }),
    sph([0.032, 0.388, 0.075], [0.034, 0.03, 0.012], '#3ef0ff', null, { emit: 0.9 }),
    part(CYL(), [0, 0.44, 0], [0.012, 0.075, 0.012], G, null, { spec: 0.8 }),
    sph([0, 0.525, 0], 0.045, '#ff4a3d', null, { spec: 0.9, emit: 0.35 }),
  ];
}

function icecream() {
  const parts = [
    part(lathe('cone', [[0, 0], [0.012, 0.02], [0.1, 0.3], [0.112, 0.312], [0.106, 0.322], [0, 0.322]]), [0, 0, 0], 1, '#dda463', null, { spec: 0.25 }),
  ];
  // waffle pattern: spirals both ways around the cone
  for (let k = 0; k < 6; k++) {
    for (const dir of [1, -1]) {
      const g = once(`waffle${k}${dir}`, () => tubeGeo(Array.from({ length: 16 }, (_, i) => {
        const t = 0.07 + (i / 15) * 0.9;
        const a = (k / 6) * PI * 2 + dir * t * 2.2;
        const r = 0.012 + t * 0.29 * (0.088 / 0.29) * 1.0 + 0.003;
        return [Math.sin(a) * r, 0.02 + t * 0.28, Math.cos(a) * r];
      }), 0.0045, 6));
      parts.push(part(g, [0, 0, 0], 1, '#b67a3a', null, { spec: 0.2 }));
    }
  }
  parts.push(
    sph([0, 0.37, 0], [0.25, 0.19, 0.25], '#ffc6d9', null, { spec: 0.35 }),
    part(ring('scoopRim1', 0.108, 0.03), [0, 0.32, 0], 1, '#ffc6d9', null, { spec: 0.35 }),
    sph([0, 0.495, 0], [0.22, 0.17, 0.22], 'P', null, { spec: 0.35 }),
    part(ring('scoopRim2', 0.094, 0.026), [0, 0.45, 0], 1, 'P', null, { spec: 0.35 }),
  );
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * PI * 2 + 0.4;
    parts.push(sph([Math.sin(a) * 0.112, 0.3 - (k % 2) * 0.02, Math.cos(a) * 0.112], [0.045, 0.08, 0.045], '#ffc6d9', null, { spec: 0.35 }));
  }
  const cols = ['#ff4d6d', '#ffd23a', '#3a86ff', '#3ed17a', '#ffffff', '#b16cff'];
  for (let k = 0; k < 16; k++) {
    const a = k * 2.4, h = 0.25 + (k % 4) * 0.17;
    const r = Math.sqrt(1 - h * h) * 0.11;
    parts.push(part(once('sprinkle', () => rboxGeo(0.024, 0.008, 0.008, 0.004)), [Math.sin(a) * r, 0.495 + h * 0.085, Math.cos(a) * r], 1, cols[k % cols.length], [0.3, a + 1, 0.2], { spec: 0.5 }));
  }
  parts.push(
    sph([0, 0.6, 0.01], 0.07, '#d81e3a', null, { spec: 1 }),
    part(once('cherryStem', () => tubeGeo(curve([[0, 0.62, 0.01], [0.015, 0.66, 0.0], [0.035, 0.69, -0.01]], 5), 0.004, 6)), [0, 0, 0], 1, '#3b6b2a', null, { spec: 0.3 }),
  );
  return parts;
}

function cactus() {
  const body = once('cactusBody', () => paramGeo(48, 16, (u, v) => {
    const a = u * PI * 2;
    const top = 0.75;
    let R = 0.085, y = 0.13 + v * 0.36;
    if (v > top) { const t = (v - top) / (1 - top); R = 0.085 * Math.sqrt(Math.max(0, 1 - t * t)); y = 0.13 + top * 0.36 + Math.sin((t * PI) / 2) * 0.06; }
    const rib = 1 + 0.07 * Math.cos(a * 8);
    return [Math.sin(a) * R * rib, y, Math.cos(a) * R * rib];
  }));
  const armR = once('cactusArmR', () => tubeGeo(curve([[0.06, 0.27, 0], [0.13, 0.27, 0], [0.16, 0.3, 0], [0.165, 0.38, 0]], 6), 0.038, 16));
  const armL = once('cactusArmL', () => tubeGeo(curve([[-0.06, 0.22, 0], [-0.12, 0.22, 0], [-0.145, 0.25, 0], [-0.148, 0.31, 0]], 6), 0.034, 16));
  const G = '#4f9f45';
  const parts = [
    part(lathe('pot', [[0, 0], [0.12, 0], [0.13, 0.01], [0.15, 0.125], [0.172, 0.13], [0.172, 0.165], [0.148, 0.165], [0.146, 0.14], [0, 0.14]]), [0, 0, 0], 1, 'P', null, { spec: 0.45 }),
    part(CYL(), [0, 0.13, 0], [0.29, 0.012, 0.29], '#5a3d26', null, { spec: 0.05 }),
    part(body, [0, 0, 0], 1, G, null, { spec: 0.35 }),
    part(armR, [0, 0, 0], 1, G, null, { spec: 0.35 }), sph([0.165, 0.38, 0], 0.076, G, null, { spec: 0.35 }),
    part(armL, [0, 0, 0], 1, G, null, { spec: 0.35 }), sph([-0.148, 0.31, 0], 0.068, G, null, { spec: 0.35 }),
  ];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * PI * 2;
    parts.push(sph([Math.sin(a) * 0.028, 0.468, Math.cos(a) * 0.028], [0.05, 0.022, 0.03], '#ff6fb1', [0.4, a, 0], { spec: 0.4 }));
  }
  parts.push(sph([0, 0.474, 0], 0.03, '#ffd23a', null, { spec: 0.3 }));
  for (let k = 0; k < 14; k++) {
    const a = (k % 8) * (PI / 4) + 0.2, y = 0.18 + ((k * 7) % 10) * 0.028;
    parts.push(part(CONE(), [Math.sin(a) * 0.093, y, Math.cos(a) * 0.093], [0.008, 0.022, 0.008], '#fff8e0', [PI / 2 - 0.2, a, 0], { spec: 0.2 }));
  }
  parts.push(...eyes(0.03, 0.34, 0.085, 0.016), ...blush(0.05, 0.31, 0.083, 0.014), ...smile(0.305, 0.093, 0.03, 0.005, '#1e3a1a', 5));
  return parts;
}

function ufo() {
  const parts = [
    part(lathe('saucer', [[0, 0.13], [0.08, 0.13], [0.16, 0.15], [0.2, 0.18], [0.208, 0.2], [0.19, 0.222], [0.14, 0.24], [0.1, 0.245], [0, 0.245]], 48), [0, 0, 0], 1, '#c7ccd4', null, { spec: 1 }),
    part(ring('ufoBand', 0.203, 0.018), [0, 0.198, 0], 1, 'P', null, { spec: 0.9 }),
    part(ring('cockpit', 0.088, 0.016), [0, 0.248, 0], 1, 'D', null, { spec: 0.9 }),
    sph([0, 0.13, 0], [0.16, 0.06, 0.16], '#9ef3ff', null, { emit: 0.6 }),
  ];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * PI * 2;
    parts.push(sph([Math.sin(a) * 0.205, 0.2, Math.cos(a) * 0.205], 0.026, k % 2 ? '#ffe45c' : '#ff7ad9', null, { emit: 0.7 }));
  }
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * PI * 2 + PI / 3;
    parts.push(part(once(`ufoLeg${k}`, () => tubeGeo([[Math.sin(a) * 0.09, 0.15, Math.cos(a) * 0.09], [Math.sin(a) * 0.15, 0.02, Math.cos(a) * 0.15]], 0.01, 8)), [0, 0, 0], 1, '#8a9099', null, { spec: 0.8 }));
    parts.push(part(CYL(), [Math.sin(a) * 0.15, 0, Math.cos(a) * 0.15], [0.05, 0.012, 0.05], '#8a9099', null, { spec: 0.8 }));
  }
  // the little green pilot
  const AL = '#7ad95a';
  parts.push(
    sph([0, 0.27, 0], [0.12, 0.1, 0.11], AL, null, { spec: 0.5 }),
    sph([0, 0.35, 0.005], [0.15, 0.13, 0.13], AL, null, { spec: 0.5 }),
    sph([-0.035, 0.355, 0.055], [0.05, 0.06, 0.025], '#101214', [0, 0, 0.35], { spec: 1 }),
    sph([0.035, 0.355, 0.055], [0.05, 0.06, 0.025], '#101214', [0, 0, -0.35], { spec: 1 }),
    sph([-0.028, 0.37, 0.068], 0.012, '#ffffff', null, { emit: 0.5 }),
    sph([0.042, 0.37, 0.068], 0.012, '#ffffff', null, { emit: 0.5 }),
    ...[-1, 1].map((s) => part(once(`antenna${s}`, () => tubeGeo(curve([[0.03 * s, 0.4, 0], [0.05 * s, 0.45, -0.01], [0.075 * s, 0.48, 0]], 5), 0.005, 6)), [0, 0, 0], 1, AL, null, { spec: 0.4 })),
    sph([-0.075, 0.485, 0], 0.025, '#ffe45c', null, { emit: 0.5 }),
    sph([0.075, 0.485, 0], 0.025, '#ffe45c', null, { emit: 0.5 }),
  );
  return parts;
}

function octopus() {
  const parts = [
    part(lathe('octoHead', [[0, 0.16], [0.08, 0.165], [0.118, 0.2], [0.136, 0.27], [0.132, 0.35], [0.112, 0.42], [0.075, 0.47], [0.035, 0.493], [0, 0.498]], 48), [0, 0, 0], 1, 'P', null, { spec: 0.6 }),
  ];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * PI * 2 + PI / 8;
    const curl = k % 2 ? 1 : -1;
    const pts = [[0.06, 0.2, 0], [0.12, 0.1, 0], [0.19, 0.03, 0], [0.25, 0.03, 0.02 * curl], [0.28, 0.07, 0.04 * curl], [0.255, 0.1, 0.05 * curl]];
    const g = once(`tentacle${k % 2}`, () => tubeGeo(curve(pts, 5), (t) => 0.042 * (1 - t) + 0.006, 14));
    parts.push(part(g, [0, 0, 0], 1, 'P', [0, a, 0], { spec: 0.6 }));
    // suckers along the underside
    for (let i = 1; i < 4; i++) {
      const p = [0.1 + i * 0.045, 0.06 - i * 0.012 + (i > 2 ? 0.02 : 0)];
      parts.push(sph([Math.sin(a) * p[0], p[1] - 0.012, Math.cos(a) * p[0]], 0.022, '#ffd9e0', null, { spec: 0.3 }));
    }
  }
  parts.push(...eyes(0.05, 0.3, 0.1, 0.034), ...blush(0.085, 0.25, 0.105, 0.02), ...smile(0.235, 0.123, 0.05, 0.006, '#3a1a2a', 6));
  return parts;
}

function frog() {
  const G = '#5cbf4a', L = '#c9ec9a', Dk = '#3f9a36';
  const mouth = once('frogMouth', () => tubeGeo(curve([[-0.09, 0.245, 0.09], [-0.05, 0.22, 0.12], [0, 0.212, 0.128], [0.05, 0.22, 0.12], [0.09, 0.245, 0.09]], 6), 0.006, 6));
  const arm = (s) => tubeGeo(curve([[0.08 * s, 0.13, 0.07], [0.1 * s, 0.07, 0.11], [0.105 * s, 0.015, 0.13]], 5), 0.022, 10);
  return [
    sph([0, 0.12, -0.01], [0.3, 0.22, 0.3], G, null, { spec: 0.6 }),
    sph([0, 0.115, 0.09], [0.2, 0.15, 0.12], L, null, { spec: 0.4 }),
    sph([0, 0.235, 0.04], [0.27, 0.17, 0.23], G, null, { spec: 0.6 }),
    ...[-1, 1].flatMap((s) => [
      sph([0.068 * s, 0.315, 0.06], 0.105, G, null, { spec: 0.6 }),
      sph([0.13 * s, 0.065, -0.05], [0.11, 0.09, 0.19], G, null, { spec: 0.6 }),
      sph([0.145 * s, 0.012, 0.075], [0.085, 0.025, 0.11], Dk, [0, 0.3 * s, 0], { spec: 0.5 }),
      part(once(`frogArm${s}`, () => arm(s)), [0, 0, 0], 1, G, null, { spec: 0.6 }),
      ...[-1, 0, 1].map((k) => sph([0.105 * s + k * 0.018, 0.01, 0.145 + Math.abs(k) * -0.005], [0.024, 0.016, 0.03], Dk, null, { spec: 0.5 })),
      ...blush(0.1, 0.25, 0.13, 0.018),
    ]),
    ...eyes(0.068, 0.335, 0.095, 0.034, { squash: 0.85 }),
    part(mouth, [0, 0, 0], 1, '#2e6b2a', null, { spec: 0.3 }),
    // a bow tie in the player's colour
    part(CONE(), [-0.03, 0.175, 0.125], [0.05, 0.055, 0.035], 'P', [0, 0, PI / 2], { spec: 0.5 }),
    part(CONE(), [0.03, 0.175, 0.125], [0.05, 0.055, 0.035], 'P', [0, 0, -PI / 2], { spec: 0.5 }),
    sph([0, 0.175, 0.128], 0.03, 'D', null, { spec: 0.5 }),
  ];
}

function burger() {
  const lettuce = once('lettuce', () => paramGeo(72, 3, (u, v) => {
    const a = u * PI * 2, r = 0.13 + v * 0.075;
    return [Math.sin(a) * r, 0.132 + Math.sin(a * 18) * 0.012 * v - v * 0.012, Math.cos(a) * r];
  }));
  const cheese = once('cheese', () => paramGeo(10, 10, (u, v) => {
    const x = (u - 0.5) * 0.34, z = (v - 0.5) * 0.34;
    const d = Math.max(0, Math.hypot(x, z) - 0.15);
    return [x * Math.SQRT1_2 - z * Math.SQRT1_2, 0.125 - d * d * 4, x * Math.SQRT1_2 + z * Math.SQRT1_2];
  }));
  const parts = [
    part(lathe('bunLow', [[0, 0], [0.15, 0], [0.165, 0.012], [0.172, 0.04], [0.164, 0.062], [0, 0.062]], 48), [0, 0, 0], 1, '#e0a85a', null, { spec: 0.3 }),
    part(lathe('patty', [[0, 0.06], [0.17, 0.06], [0.182, 0.075], [0.184, 0.1], [0.172, 0.118], [0, 0.118]], 48), [0, 0, 0], 1, '#6b3a1f', null, { spec: 0.35 }),
    part(cheese, [0, 0, 0], 1, '#ffc72c', null, { spec: 0.5 }),
    part(lettuce, [0, 0, 0], 1, '#7ccf3a', null, { spec: 0.4 }),
    part(CYL(), [0.06, 0.135, 0.04], [0.15, 0.022, 0.15], '#e8392f', null, { spec: 0.7 }),
    part(CYL(), [-0.06, 0.137, -0.03], [0.15, 0.022, 0.15], '#e8392f', null, { spec: 0.7 }),
    part(lathe('bunTop', [[0, 0.15], [0.165, 0.15], [0.178, 0.165], [0.174, 0.205], [0.155, 0.255], [0.115, 0.295], [0.06, 0.318], [0, 0.324]], 48), [0, 0, 0], 1, '#e8b062', null, { spec: 0.45 }),
  ];
  for (let k = 0; k < 18; k++) {
    const a = k * 2.4, r = 0.03 + ((k * 37) % 11) / 11 * 0.12;
    const y = 0.322 - (r / 0.17) ** 2 * 0.11;
    parts.push(sph([Math.sin(a) * r, y, Math.cos(a) * r], [0.022, 0.01, 0.012], '#fff3d6', [0.3, a, 0], { spec: 0.4 }));
  }
  parts.push(
    part(CYL(), [0.02, 0.2, 0.02], [0.012, 0.3, 0.012], '#d9b27a', null, { spec: 0.2 }),
    part(once('flag', () => paramGeo(6, 3, (u, v) => [u * 0.11, -v * 0.07, Math.sin(u * PI) * 0.01])), [0.026, 0.495, 0.02], 1, 'P', null, { spec: 0.3 }),
  );
  return parts;
}

function ghost() {
  const ctrl = [[0.165, 0], [0.152, 0.08], [0.138, 0.2], [0.136, 0.3], [0.124, 0.38], [0.098, 0.45], [0.058, 0.49], [0, 0.505]];
  const prof = (v) => {
    const f = v * (ctrl.length - 1), i = Math.min(ctrl.length - 2, Math.floor(f)), t = f - i;
    return [ctrl[i][0] + (ctrl[i + 1][0] - ctrl[i][0]) * t, ctrl[i][1] + (ctrl[i + 1][1] - ctrl[i][1]) * t];
  };
  const body = once('ghostBody', () => paramGeo(64, 28, (u, v) => {
    const a = u * PI * 2;
    let [r, y] = prof(v);
    const hem = Math.max(0, 1 - v / 0.18);
    y += hem * (0.035 + 0.035 * Math.sin(a * 6)) + (1 - hem) * 0;
    r *= 1 + hem * 0.04 * Math.cos(a * 6);
    return [Math.sin(a) * r, y + 0.02, Math.cos(a) * r];
  }));
  return [
    part(body, [0, 0, 0], 1, '#f4f6ff', null, { spec: 0.35, emit: 0.12 }),
    sph([-0.045, 0.37, 0.124], [0.045, 0.068, 0.02], '#14161c', [0, -0.3, 0], { spec: 1 }),
    sph([0.045, 0.37, 0.124], [0.045, 0.068, 0.02], '#14161c', [0, 0.3, 0], { spec: 1 }),
    sph([-0.036, 0.385, 0.132], 0.012, '#ffffff', null, { emit: 0.4 }),
    sph([0.054, 0.385, 0.132], 0.012, '#ffffff', null, { emit: 0.4 }),
    sph([0, 0.29, 0.135], [0.04, 0.05, 0.02], '#3a1a24', null, { spec: 0.6 }),
    ...blush(0.075, 0.32, 0.12, 0.018),
    sph([-0.14, 0.27, 0.02], [0.06, 0.11, 0.06], '#f4f6ff', [0, 0, 0.7], { spec: 0.35, emit: 0.12 }),
    sph([0.14, 0.27, 0.02], [0.06, 0.11, 0.06], '#f4f6ff', [0, 0, -0.7], { spec: 0.35, emit: 0.12 }),
    // a party hat in the player's colour
    part(CONE(), [0.02, 0.475, -0.005], [0.11, 0.15, 0.11], 'P', [0, 0, -0.2], { spec: 0.5 }),
    part(ring('hatBrim', 0.052, 0.008), [0.02, 0.48, -0.005], 1, '#ffffff', [0, 0, -0.2], { spec: 0.3 }),
    sph([0.05, 0.622, -0.005], 0.04, '#ffffff', null, { spec: 0.1 }),
  ];
}

function cupcake() {
  const wrapper = once('wrapper', () => paramGeo(80, 4, (u, v) => {
    const a = u * PI * 2, r = (0.11 + v * 0.045) * (1 + 0.04 * Math.cos(a * 20));
    return [Math.sin(a) * r, v * 0.17, Math.cos(a) * r];
  }));
  const swirl = once('swirl', () => tubeGeo(Array.from({ length: 70 }, (_, i) => {
    const t = i / 69, a = t * PI * 2 * 2.6;
    const r = 0.12 * (1 - t) + 0.008;
    return [Math.sin(a) * r, 0.225 + t * 0.2, Math.cos(a) * r];
  }), (t) => 0.05 * (1 - t * 0.55), 16));
  const parts = [
    part(wrapper, [0, 0, 0], 1, 'P', null, { spec: 0.5 }),
    part(CYL(), [0, 0, 0], [0.22, 0.01, 0.22], 'P', null, { spec: 0.5 }),
    part(lathe('muffin', [[0.152, 0.165], [0.165, 0.185], [0.158, 0.215], [0.1, 0.235], [0, 0.24]]), [0, 0, 0], 1, '#c98c4e', null, { spec: 0.25 }),
    part(swirl, [0, 0, 0], 1, '#ffd1e3', null, { spec: 0.45 }),
  ];
  const cols = ['#ff4d6d', '#ffd23a', '#3a86ff', '#3ed17a', '#ffffff', '#b16cff'];
  for (let k = 0; k < 22; k++) {
    const t = ((k * 0.37) % 1) * 0.85, a = t * PI * 2 * 2.6 + 0.5;
    const r = (0.12 * (1 - t) + 0.008) + 0.045 * (1 - t * 0.55);
    parts.push(part(once('sprinkle', () => rboxGeo(0.024, 0.008, 0.008, 0.004)), [Math.sin(a) * r * 0.9, 0.24 + t * 0.2, Math.cos(a) * r * 0.9], 1, cols[k % cols.length], [0.4, a + 1, 0.3], { spec: 0.5 }));
  }
  parts.push(
    sph([0, 0.475, 0], 0.075, '#d81e3a', null, { spec: 1 }),
    part(once('cherryStem2', () => tubeGeo(curve([[0, 0.5, 0], [0.012, 0.545, 0], [0.035, 0.575, -0.01]], 5), 0.004, 6)), [0, 0, 0], 1, '#3b6b2a', null, { spec: 0.3 }),
  );
  return parts;
}

function moneybag() {
  const ctrl = [[0, 0], [0.13, 0.012], [0.178, 0.08], [0.182, 0.17], [0.15, 0.26], [0.09, 0.33], [0.055, 0.37]];
  const prof = (v) => {
    const f = v * (ctrl.length - 1), i = Math.min(ctrl.length - 2, Math.floor(f)), t = f - i;
    return [ctrl[i][0] + (ctrl[i + 1][0] - ctrl[i][0]) * t, ctrl[i][1] + (ctrl[i + 1][1] - ctrl[i][1]) * t];
  };
  const sack = once('sack', () => paramGeo(56, 24, (u, v) => {
    const a = u * PI * 2;
    const [r, y] = prof(v);
    const lump = 1 + 0.045 * Math.sin(a * 5 + v * 4) * Math.sin(PI * v);
    return [Math.sin(a) * r * lump, y, Math.cos(a) * r * lump];
  }));
  const ruffle = once('ruffle', () => paramGeo(64, 4, (u, v) => {
    const a = u * PI * 2, r = (0.05 + v * 0.065) * (1 + 0.18 * Math.sin(a * 9) * v);
    return [Math.sin(a) * r, 0.37 + v * 0.09, Math.cos(a) * r];
  }));
  const dollar = once('dollar', () => tubeGeo(curve([[0.035, 0.05, 0], [0, 0.07, 0], [-0.035, 0.045, 0], [0.03, -0.01, 0], [0.035, -0.045, 0], [0, -0.07, 0], [-0.035, -0.05, 0]], 6), 0.0085, 8));
  const B = '#c9a46a', Au = '#ffd34d';
  const coin = (x, z, y, tilt) => [
    part(CYL(), [x, y, z], [0.1, 0.018, 0.1], Au, tilt, { spec: 1 }),
    part(ring('coinRim', 0.048, 0.006), [x, y + 0.018, z], 1, '#e8b52e', tilt, { spec: 1 }),
  ];
  return [
    part(sack, [0, 0, 0], 1, B, null, { spec: 0.15 }),
    part(ruffle, [0, 0, 0], 1, B, null, { spec: 0.15 }),
    part(ring('rope', 0.058, 0.017), [0, 0.37, 0], 1, '#7a4e2a', null, { spec: 0.2 }),
    sph([0.04, 0.35, 0.05], [0.035, 0.07, 0.035], '#7a4e2a', [0.3, 0, 0.4], { spec: 0.2 }),
    // a badge in the player's colour with a gold dollar sign
    part(CYL(), [0, 0.17, 0.168], [0.14, 0.014, 0.14], 'P', [PI / 2 - 0.12, 0, 0], { spec: 0.6 }),
    part(dollar, [0, 0.17, 0.18], 1, Au, [-0.12, 0, 0], { spec: 1 }),
    part(CYL(), [0, 0.098, 0.178], [0.012, 0.145, 0.012], Au, [-0.12, 0, 0], { spec: 1 }),
    ...coin(0.15, 0.13, 0, null), ...coin(0.155, 0.125, 0.018, [0, 0.4, 0.05]), ...coin(-0.16, 0.1, 0, [0, 0, 0.12]),
  ];
}

function teapot() {
  const spout = once('spout', () => tubeGeo(curve([[0, 0.09, 0.13], [0, 0.13, 0.2], [0, 0.2, 0.25], [0, 0.25, 0.29]], 6), (t) => 0.038 - t * 0.02, 14));
  const handle = once('handle', () => tubeGeo(curve([[0, 0.2, -0.14], [0, 0.22, -0.21], [0, 0.17, -0.25], [0, 0.1, -0.22], [0, 0.07, -0.16]], 6), 0.017, 12));
  const Au = '#e8c15a';
  const parts = [
    part(lathe('potBody', [[0, 0], [0.1, 0], [0.128, 0.018], [0.162, 0.07], [0.172, 0.13], [0.158, 0.2], [0.12, 0.245], [0, 0.248]], 48), [0, 0, 0], 1, 'P', null, { spec: 0.9 }),
    part(lathe('potLid', [[0, 0.244], [0.108, 0.244], [0.1, 0.262], [0.072, 0.285], [0.03, 0.298], [0, 0.3]]), [0, 0, 0], 1, 'P', null, { spec: 0.9 }),
    sph([0, 0.318, 0], [0.055, 0.045, 0.055], Au, null, { spec: 1 }),
    part(ring('potFoot', 0.11, 0.013), [0, 0.012, 0], 1, Au, null, { spec: 1 }),
    part(ring('potLidRim', 0.107, 0.008), [0, 0.247, 0], 1, Au, null, { spec: 1 }),
    part(spout, [0, 0, 0], 1, 'P', null, { spec: 0.9 }),
    part(ring('spoutTip', 0.018, 0.006), [0, 0.25, 0.29], 1, Au, [-0.75, 0, 0], { spec: 1 }),
    part(handle, [0, 0, 0], 1, 'P', null, { spec: 0.9 }),
  ];
  // white polka dots
  for (let k = 0; k < 14; k++) {
    const a = k * 2.4 + 0.3, y = 0.06 + ((k * 5) % 7) * 0.022;
    const r = y < 0.07 ? 0.15 : y > 0.18 ? 0.16 : 0.17;
    if (Math.abs(Math.sin(a)) < 0.25) continue; // keep the spout and handle sides clear
    parts.push(sph([Math.sin(a) * r, y, Math.cos(a) * r], [0.03, 0.03, 0.012], '#ffffff', [0, a, 0], { spec: 0.6 }));
  }
  return parts;
}

function balloon() {
  const profile = [[0.05, 0.25], [0.09, 0.285], [0.145, 0.36], [0.178, 0.45], [0.182, 0.54], [0.158, 0.62], [0.1, 0.682], [0.04, 0.704], [0, 0.708]];
  const parts = [];
  const n = 12;
  for (let k = 0; k < n; k++) {
    const g = once(`gore${k}`, () => latheGeo(profile, 4, 1, (k / n) * PI * 2, ((k + 1) / n) * PI * 2));
    parts.push(part(g, [0, 0, 0], 1, k % 2 ? 'P' : '#fbf7ee', null, { spec: 0.45 }));
  }
  parts.push(part(ring('skirt', 0.052, 0.01), [0, 0.252, 0], 1, 'D', null, { spec: 0.4 }));
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    parts.push(part(once(`rope${x}${z}`, () => tubeGeo([[0.035 * x, 0.25, 0.035 * z], [0.052 * x, 0.1, 0.052 * z]], 0.0035, 5)), [0, 0, 0], 1, '#6b5a44', null, { spec: 0.1 }));
  }
  parts.push(
    part(CYL(), [0, 0.135, 0], [0.04, 0.05, 0.04], '#6b6f76', null, { spec: 0.9 }),
    part(CONE(), [0, 0.185, 0], [0.03, 0.05, 0.03], '#ffb03a', null, { emit: 0.8 }),
    part(once('basket', () => rboxGeo(0.12, 0.095, 0.12, 0.014)), [0, 0.048, 0], 1, '#a8743e', null, { spec: 0.15 }),
    part(once('basketRim', () => rboxGeo(0.132, 0.016, 0.132, 0.007)), [0, 0.098, 0], 1, '#7a4e2a', null, { spec: 0.2 }),
  );
  for (let k = 0; k < 3; k++) parts.push(part(CYL(), [0, 0.022 + k * 0.03, 0], [0.122, 0.006, 0.122], '#8a5a2c', null, { spec: 0.1 }));
  for (const [x, z] of [[0.068, 0.02], [-0.068, -0.02]]) parts.push(sph([x, 0.06, z], [0.03, 0.04, 0.03], '#cfb98a', null, { spec: 0.1 }));
  return parts;
}

export const PIECES = [
  { key: 'duck', name: 'Rubber duck', emoji: '🦆', build: duck },
  { key: 'rocket', name: 'Rocket', emoji: '🚀', build: rocket },
  { key: 'snowman', name: 'Snowman', emoji: '⛄', build: snowman },
  { key: 'mushroom', name: 'Mushroom', emoji: '🍄', build: mushroom },
  { key: 'robot', name: 'Robot', emoji: '🤖', build: robot },
  { key: 'icecream', name: 'Ice cream', emoji: '🍦', build: icecream },
  { key: 'cactus', name: 'Cactus', emoji: '🌵', build: cactus },
  { key: 'ufo', name: 'UFO', emoji: '🛸', build: ufo },
  { key: 'octopus', name: 'Octopus', emoji: '🐙', build: octopus },
  { key: 'frog', name: 'Frog', emoji: '🐸', build: frog },
  { key: 'burger', name: 'Burger', emoji: '🍔', build: burger },
  { key: 'ghost', name: 'Ghost', emoji: '👻', build: ghost },
  { key: 'cupcake', name: 'Cupcake', emoji: '🧁', build: cupcake },
  { key: 'moneybag', name: 'Money bag', emoji: '💰', build: moneybag },
  { key: 'teapot', name: 'Teapot', emoji: '🫖', build: teapot, thumbYaw: 1.25 },
  { key: 'balloon', name: 'Hot-air balloon', emoji: '🎈', build: balloon, scale: 0.88 },
];

export const PIECE_KEYS = PIECES.map((p) => p.key);
export const pieceByKey = (key) => PIECES.find((p) => p.key === key) ?? null;

/** Fallback when no piece was chosen: seat ids are p1, p2, ... */
export function pieceFor(id) {
  const n = Number(String(id).replace(/\D/g, '')) || 1;
  return PIECES[(n - 1) % PIECES.length];
}
