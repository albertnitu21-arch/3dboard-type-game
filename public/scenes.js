// 3D scenery around the board for the backgrounds that have one (see backgrounds.js).
// Each scene has its own light (sun direction and colours, a lamp, fog) and a draw
// function that uses the toolkit `R` from board3d.js:
//   R.put(mesh | 'box' | 'sphere' | 'cyl' | 'cone' | 'torus' | 'plane' | 'disc', at, scale, colour, opts)
//   R.rbox(w, h, d, radius, uvScale)  rounded box mesh      R.mesh(key, () => geometry)  cached mesh
//   R.tex(name)  texture from textures.js                  R.blob(x, z, sx, sz, alpha, y)  soft contact shadow
//   R.glow(c, pos, size, colour, alpha)  glowing sprite      R.blend(on, additive)  R.withoutFog(fn)
// World units: the board is 11 x 11 with its top at y = 0; the camera looks from +z.

import { quat, trs, rng } from './math3d.js';
import {
  latheGeo, sphereProfile, leafGeo, rockGeo, merge, curtainGeo, ringGeo, starfishGeo, rboxGeo,
  cylGeo, sphereGeo, coneGeo, boxGeo, planeGeo, torusGeo, discGeo, roofGeo, sheetGeo,
} from './geometry.js';

/** Neutral light that matches the original look (used by the flat backgrounds). */
export const DEFAULT_LIGHT = {
  dir: [0.35, 1, 0.5], sky: [0.56, 0.56, 0.56], ground: [0.56, 0.56, 0.56], sun: [0.52, 0.52, 0.52],
};

const W1 = [1, 1, 1];
const PI = Math.PI;
const yawQ = (a) => quat.axis([0, 1, 0], a);
const rotX = (a) => quat.axis([1, 0, 0], a);
const rotZ = (a) => quat.axis([0, 0, 1], a);
const qmul = (...qs) => qs.reduce((a, b) => quat.mul(a, b));

/** Draw helper for furniture built in local coordinates, then turned and moved into place. */
function placer(R, x, y, z, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const base = yawQ(yaw);
  return (m, at, sc, color, o = {}) => {
    const [lx, ly, lz] = at;
    R.put(m, [x + lx * c + lz * s, y + ly, z - lx * s + lz * c], sc, color, { ...o, q: o.q ? quat.mul(base, o.q) : base });
  };
}

/** Lathe profile scaled to an exact height (so normals stay right). */
const profileH = (p, h, r = 1) => p.map(([a, b]) => [a * r, b * h]);

function skyDome(R, tex) {
  const m = R.mesh('dome', () => latheGeo(sphereProfile(28).slice().reverse(), 64));
  R.withoutFog(() => R.put(m, [0, 0, 0], 330, W1, { tex: R.tex(tex), lit: false, cast: false }));
}

/** Floor plus four walls; a wall is hidden when the camera is outside it (dollhouse view). */
function room(R, c, { half, F, H, wallTex, wallTint = W1, uv = 1 / 12, floorTex, floorTile, trim = '#f4eee3', floorSpec = 0.12 }) {
  const fm = R.mesh(`floor:${floorTile}:${half}`, () => planeGeo((2 * half) / floorTile));
  R.put(fm, [0, F, 0], [2 * half, 1, 2 * half], W1, { tex: R.tex(floorTex), cast: false, spec: floorSpec });
  const show = {
    back: c.eye[2] > -half, front: c.eye[2] < half, left: c.eye[0] > -half, right: c.eye[0] < half,
  };
  const t = 0.8;
  const long = R.rbox(2 * half + t * 2, H, t, 0.05, uv);
  const side = R.rbox(t, H, 2 * half + t * 2, 0.05, uv);
  const base = R.rbox(2 * half, 1.4, 0.5, 0.12);
  const baseS = R.rbox(0.5, 1.4, 2 * half, 0.12);
  const crown = R.rbox(2 * half, 0.9, 0.9, 0.3);
  const crownS = R.rbox(0.9, 0.9, 2 * half, 0.3);
  const y = F + H / 2;
  const walls = [
    [show.back, [0, y, -half - t / 2], long, [0, F + 0.7, -half + 0.25], base, [0, F + H - 0.45, -half + 0.45], crown],
    [show.front, [0, y, half + t / 2], long, [0, F + 0.7, half - 0.25], base, [0, F + H - 0.45, half - 0.45], crown],
    [show.left, [-half - t / 2, y, 0], side, [-half + 0.25, F + 0.7, 0], baseS, [-half + 0.45, F + H - 0.45, 0], crownS],
    [show.right, [half + t / 2, y, 0], side, [half - 0.25, F + 0.7, 0], baseS, [half - 0.45, F + H - 0.45, 0], crownS],
  ];
  for (const [on, at, m, bat, bm, cat, cm] of walls) {
    if (!on) continue;
    R.put(m, at, 1, wallTint, { tex: R.tex(wallTex), cast: false });
    R.put(bm, bat, 1, trim, { cast: false, spec: 0.2 });
    R.put(cm, cat, 1, trim, { cast: false, spec: 0.2 });
  }
  return show;
}

// ---------------------------------------------------------------- shared props

const LEG_PROFILE = [[0, 0], [0.3, 0], [0.33, 0.02], [0.28, 0.05], [0.22, 0.12], [0.18, 0.45], [0.22, 0.6], [0.28, 0.67],
  [0.28, 0.71], [0.34, 0.75], [0.34, 0.97], [0.3, 1], [0, 1]];

/** A table whose top surface is at y = -0.3, just bigger than the board. */
function table(R, F, { size = 13.8, thick = 0.55, top = 'tableWood', leg = 'darkWood', legStyle = 'turned', shelf = true, tint = W1 }) {
  const topM = R.rbox(size, thick, size, 0.16, 0.13);
  R.put(topM, [0, -0.3 - thick / 2, 0], 1, tint, { tex: R.tex(top), spec: 0.35 });
  const under = -0.3 - thick;
  const len = under - 0.3 - F;
  const inset = size / 2 - 0.75;
  const legM = legStyle === 'turned'
    ? R.mesh(`leg:${len.toFixed(2)}`, () => latheGeo(profileH(LEG_PROFILE, len), 28))
    : R.rbox(1.2, len, 1.2, 0.12, 0.3);
  for (const [x, z] of [[-inset, -inset], [inset, -inset], [-inset, inset], [inset, inset]]) {
    if (legStyle === 'turned') R.put(legM, [x, F, z], 1, tint, { tex: R.tex(leg), spec: 0.25 });
    else R.put(legM, [x, F + len / 2, z], 1, tint, { tex: R.tex(leg), spec: 0.2 });
  }
  const apron = R.rbox(size - 1.6, 0.9, 0.32, 0.08, 0.3);
  const apronS = R.rbox(0.32, 0.9, size - 1.6, 0.08, 0.3);
  R.put(apron, [0, under - 0.45, inset], 1, tint, { tex: R.tex(leg) });
  R.put(apron, [0, under - 0.45, -inset], 1, tint, { tex: R.tex(leg) });
  R.put(apronS, [inset, under - 0.45, 0], 1, tint, { tex: R.tex(leg) });
  R.put(apronS, [-inset, under - 0.45, 0], 1, tint, { tex: R.tex(leg) });
  if (shelf) {
    R.put(R.rbox(size - 1.4, 0.3, size - 1.4, 0.08, 0.13), [0, F + 1.6, 0], 1, tint, { tex: R.tex(top), spec: 0.2 });
  }
}

function mug(R, x, z, { color = '#f4efe6', drink = '#4a2a16', y = -0.3, s = 1, marsh = false } = {}) {
  const body = R.mesh('mug', () => latheGeo([[0, 0], [0.3, 0], [0.33, 0.02], [0.34, 0.08], [0.36, 0.6], [0.37, 0.64], [0.33, 0.64], [0.32, 0.12], [0, 0.12]], 36));
  R.put(body, [x, y, z], s, color, { spec: 0.6 });
  R.put('disc', [x, y + 0.55 * s, z], [0.64 * s, 1, 0.64 * s], drink, { spec: 0.9 });
  R.put('torus', [x + 0.38 * s, y + 0.34 * s, z], [0.42 * s, 0.42 * s, 0.6 * s], color, { q: rotX(PI / 2), spec: 0.5 });
  if (marsh) {
    for (const [dx, dz] of [[0.1, 0.05], [-0.1, 0.08], [0, -0.12]]) R.put(R.rbox(0.16, 0.12, 0.16, 0.04), [x + dx * s, y + 0.6 * s, z + dz * s], s, '#fffaf2');
  }
}

function plant(R, x, F, z, { s = 1, pot = '#c1693c', seed = 3, leaf = 'monstera' } = {}) {
  const potM = R.mesh('pot', () => latheGeo([[0, 0], [1.6, 0], [1.7, 0.1], [2.2, 3.4], [2.45, 3.5], [2.45, 3.9], [2.1, 3.9], [2.05, 3.6], [0, 3.6]], 40));
  R.put(potM, [x, F, z], s, pot, { spec: 0.25 });
  R.put('disc', [x, F + 3.6 * s, z], [4.1 * s, 1, 4.1 * s], '#3b2a1c', { cast: false });
  const m = R.mesh(`plant:${leaf}:${seed}`, () => {
    const r = rng(seed);
    const parts = [];
    const n = leaf === 'monstera' ? 13 : 22;
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * PI * 2 + r() * 0.5;
      const tilt = 0.35 + r() * 0.6;
      const h = 3.6 + r() * 3.5;
      const len = leaf === 'monstera' ? 3.4 + r() * 1.6 : 4 + r() * 2.5;
      const width = leaf === 'monstera' ? 2.6 + r() : 0.7;
      const geo = leafGeo({ len, width, droop: len * 0.35, cup: 0.25, nl: 10, nw: 6, shape: leaf === 'monstera' ? 'leaf' : 'blade' });
      const m4 = trs([Math.sin(yaw) * 0.4, h, Math.cos(yaw) * 0.4], qmul(yawQ(yaw), rotX(-tilt)), 1);
      const g = 0.75 + r() * 0.35;
      parts.push({ geo, m: m4, color: [0.2 * g, 0.48 * g, 0.2 * g] });
      // stem
      parts.push({ geo: cylGeo(8), m: trs([0, 3.4, 0], qmul(yawQ(yaw), rotX(-tilt * 0.7)), [0.12, h - 3.2, 0.12]), color: [0.3, 0.45, 0.2] });
    }
    return merge(parts);
  });
  R.put(m, [x, F, z], s, W1, { spec: 0.35 });
  R.blob(x, z, 6 * s, 6 * s, 0.45, F + 0.04);
}

function bookshelf(R, x, F, z, yaw, { w = 16, h = 26, d = 4 } = {}) {
  const p = placer(R, x, F, z, yaw);
  const wood = R.tex('darkWood');
  p(R.rbox(0.6, h, d, 0.1, 0.25), [-w / 2, h / 2, 0], 1, W1, { tex: wood });
  p(R.rbox(0.6, h, d, 0.1, 0.25), [w / 2, h / 2, 0], 1, W1, { tex: wood });
  p(R.rbox(w + 0.6, 0.6, d + 0.3, 0.12, 0.25), [0, h, 0.1], 1, W1, { tex: wood });
  p(R.rbox(w, 0.25, d, 0.04), [0, h / 2, -d / 2 + 0.1], 1, '#3b2414', { cast: false });
  p('box', [0, h / 2, -d / 2 + 0.05], [w, h, 0.1], '#3b2414', { cast: false });
  const shelves = 5;
  for (let i = 0; i < shelves; i++) {
    const y = 0.4 + (i * (h - 1)) / shelves;
    p(R.rbox(w, 0.45, d, 0.06, 0.25), [0, y, 0], 1, W1, { tex: wood });
    if (i < shelves) {
      const bh = (h - 1) / shelves - 1.2;
      p('box', [0, y + 0.25 + bh / 2, 0.2], [w - 0.6, bh, 2.6], W1, { tex: R.tex(i % 2 ? 'books2' : 'books'), alphaTest: 0.5, spec: 0.1 });
    }
  }
  // a little globe and a vase on top
  p('sphere', [-w / 4, h + 2.2, 0], 2.4, '#3d7ab8', { spec: 0.5 });
  p(R.rbox(0.3, 1.6, 0.3, 0.1), [-w / 4, h + 0.9, 0], 1, '#b88a3a');
  p(R.mesh('vase', () => latheGeo([[0, 0], [0.7, 0], [1.1, 0.8], [1.2, 1.6], [0.7, 2.6], [0.55, 3.2], [0.7, 3.5], [0, 3.5]], 36)), [w / 4, h + 0.3, 0], 1, '#2f7a74', { spec: 0.7 });
}

function lamp(R, c, x, F, z, { h = 17, shade = '#fff0cf' } = {}) {
  R.put('cyl', [x, F, z], [3, 0.35, 3], '#2b2b2b', { spec: 0.5 });
  R.put('cyl', [x, F, z], [0.32, h, 0.32], '#3a3a3a', { spec: 0.7 });
  const sm = R.mesh('shade', () => latheGeo([[2.4, 0], [2.4, 0.05], [1.6, 3.2], [1.55, 3.2]], 40));
  R.put(sm, [x, F + h - 2.4, z], 1, shade, { lit: false, emit: 0.05, cast: false });
  R.glow(c, [x, F + h - 1.2, z], 9, '#ffd59a', 0.35);
  R.blob(x, z, 4, 4, 0.4, F + 0.04);
}

// ---------------------------------------------------------------- living room

const LIVING = { F: -7.2, H: 30, half: 34 };

function sofa(R, x, F, z, yaw, { color = '#3f7f86', seats = 3, w = 40 } = {}) {
  const p = placer(R, x, F, z, yaw);
  const fab = R.tex('fabric');
  const o = { tex: fab, spec: 0.05 };
  const cw = (w - 8) / seats;
  p(R.rbox(w, 5, 18, 1.2, 0.3), [0, 3.5, 0], 1, color, o);
  p(R.rbox(w, 12, 3.4, 1.4, 0.3), [0, 9, -7.6], 1, color, o);
  for (const sx of [-1, 1]) p(R.rbox(4.2, 9.5, 18.4, 1.8, 0.3), [sx * (w / 2 - 1.8), 6.4, 0.2], 1, color, o);
  for (let i = 0; i < seats; i++) {
    const cx = -w / 2 + 4 + cw * (i + 0.5);
    p(R.rbox(cw - 0.2, 2.8, 15.2, 1.2, 0.3), [cx, 7.3, 1.2], 1, color, o);
    p(R.rbox(cw - 0.4, 8.6, 4, 1.8, 0.3), [cx, 12.2, -5.2], 1, color, { ...o, q: rotX(-0.14) });
  }
  // wooden feet
  for (const [fx, fz] of [[-w / 2 + 1.5, -7.5], [w / 2 - 1.5, -7.5], [-w / 2 + 1.5, 7.5], [w / 2 - 1.5, 7.5]]) {
    p(R.mesh('foot', () => latheGeo([[0, 0], [0.45, 0], [0.6, 1.1], [0, 1.1]], 20)), [fx, 0, fz], 1, W1, { tex: R.tex('darkWood') });
  }
  // throw pillows and a knitted blanket over one arm
  p(R.rbox(7, 7, 2.4, 1.6, 0.3), [-w / 2 + 7.5, 12.2, -2.6], 1, '#e3b04b', { ...o, q: qmul(yawQ(0.25), rotZ(0.12), rotX(-0.2)) });
  p(R.rbox(7, 7, 2.4, 1.6, 0.3), [w / 2 - 7.5, 12.2, -2.6], 1, '#e07a6b', { ...o, q: qmul(yawQ(-0.25), rotZ(-0.1), rotX(-0.2)) });
  p(R.rbox(5, 0.6, 12, 0.3, 0.3), [w / 2 - 1.8, 11.3, 2], 1, '#f0e6d6', { tex: R.tex('knit'), q: rotZ(-0.12) });
  p(R.rbox(0.6, 7, 12, 0.3, 0.3), [w / 2 + 0.6, 7.8, 2], 1, '#f0e6d6', { tex: R.tex('knit') });
  R.blob(x, z, w + 6, 22, 0.5, F + 0.04, yaw);
}

function armchair(R, x, F, z, yaw, color = '#d9a441') {
  const p = placer(R, x, F, z, yaw);
  const o = { tex: R.tex('fabric'), spec: 0.05 };
  p(R.rbox(15, 4.6, 14, 1.2, 0.3), [0, 3.4, 0], 1, color, o);
  p(R.rbox(10.6, 2.6, 11.4, 1.1, 0.3), [0, 6.8, 1], 1, color, o);
  p(R.rbox(15, 13, 3.2, 1.4, 0.3), [0, 8.5, -5.8], 1, color, { ...o, q: rotX(-0.1) });
  for (const sx of [-1, 1]) p(R.rbox(2.8, 8, 14.4, 1.3, 0.3), [sx * 6.3, 5.6, 0.2], 1, color, o);
  for (const [fx, fz] of [[-6, -5.5], [6, -5.5], [-6, 5.5], [6, 5.5]]) {
    p(R.mesh('foot', () => latheGeo([[0, 0], [0.45, 0], [0.6, 1.1], [0, 1.1]], 20)), [fx, 0, fz], 1, W1, { tex: R.tex('darkWood') });
  }
  p(R.rbox(9, 0.5, 9, 0.25, 0.3), [0.5, 8.3, 1.5], 1, '#c0d6cf', { tex: R.tex('knit'), q: yawQ(0.3) });
  R.blob(x, z, 19, 18, 0.45, F + 0.04, yaw);
}

function cat(R, x, y, z, yaw, color = '#e8944a') {
  // a cat curled up asleep: round body, head resting on the paws, tail wrapped around
  const p = placer(R, x, y, z, yaw);
  const fur = { tex: R.tex('fur'), spec: 0.1 };
  p('sphere', [0, 1.15, 0], [4.4, 2.4, 3.4], color, fur);
  p('sphere', [2.0, 1.25, 1.1], [2.3, 2.0, 2.2], color, { ...fur, q: yawQ(0.4) });
  p('sphere', [2.95, 0.9, 1.65], [0.9, 0.6, 0.8], '#fbe8d6', fur);
  for (const s of [-1, 1]) p('cone', [1.85 + s * 0.35, 2.05, 1.1 + s * 0.65], [0.75, 0.95, 0.42], color, { q: qmul(yawQ(0.4), rotX(s * 0.35)) });
  for (const s of [-1, 1]) p(R.rbox(0.42, 0.06, 0.06, 0.03), [2.95 + s * 0.05, 1.45, 1.35 + s * 0.6], 1, '#3a2a20', { q: yawQ(0.4) });
  p(R.mesh('cattail', () => latheGeo(Array.from({ length: 13 }, (_, i) => {
    const a = (i / 12) * PI * 2;
    return [2.1 + 0.36 * Math.cos(a), 0.36 * Math.sin(a)];
  }), 40)), [0.2, 0.36, 0], [1, 1, 1], color, { ...fur, q: yawQ(0.6) });
  R.blob(x, z, 8, 6.5, 0.45, y + 0.02, yaw);
}

function livingRoom(R, c) {
  const { F, H, half } = LIVING;
  const show = room(R, c, { half, F, H, wallTex: 'wallpaper', uv: 1 / 14, floorTex: 'parquet', floorTile: 18 });
  // rug and the table
  R.put('plane', [0, F + 0.03, 2], [26, 1, 34], W1, { tex: R.tex('rug'), alphaTest: 0.45, cast: false });
  R.blob(0, 0, 21, 21, 0.55, F + 0.05);
  table(R, F, {});
  // things on the table and its lower shelf
  mug(R, 6.25, 6.2, {});
  const bowl = R.mesh('bowl', () => latheGeo([[0, 0], [0.4, 0], [0.75, 0.25], [0.95, 0.65], [0.9, 0.66], [0.7, 0.3], [0, 0.3]], 36));
  R.put(bowl, [-6.2, -0.3, -6.2], 1, '#d94f4f', { spec: 0.6 });
  R.put(R.mesh('popcorn', () => {
    const r = rng(9);
    return merge(Array.from({ length: 26 }, () => ({ geo: rockGeo(Math.floor(r() * 1000), 0.4, 10, 8), m: trs([(r() - 0.5) * 1.1, 0.55 + r() * 0.25, (r() - 0.5) * 1.1], undefined, 0.3 + r() * 0.12), color: [1, 0.95 - r() * 0.1, 0.78] })));
  }), [-6.2, -0.3, -6.2], 1, W1, { spec: 0.1 });
  for (let i = 0; i < 4; i++) {
    R.put(R.rbox(1.6, 0.03, 0.85, 0.02), [-6.25 + i * 0.05, -0.28 + i * 0.03, 5.6 - i * 0.12], 1, ['#f2e6b8', '#b8e0c8', '#f6c1c1', '#c8d8f2'][i], { q: yawQ(0.3 + i * 0.25) });
  }
  // magazines and a basket on the shelf below
  for (let i = 0; i < 5; i++) R.put(R.rbox(5, 0.25, 3.6, 0.05), [-3 + i * 0.1, F + 1.9 + i * 0.26, 2.5], 1, ['#d94f4f', '#3a86ff', '#f2c14e', '#2ec4b6', '#f4efe6'][i], { q: yawQ(0.1 * i - 0.2), spec: 0.4 });
  R.put(R.rbox(5, 2.6, 3.8, 0.4, 0.4), [3.5, F + 3.05, -2.5], 1, W1, { tex: R.tex('wicker') });
  // sofa wall
  sofa(R, 0, F, -half + 11, 0);
  for (const sx of [-1, 1]) {
    const tx = sx * 26.5, tz = -half + 9;
    R.put(R.mesh('sidetable', () => latheGeo([[0, 0], [2.2, 0], [2.2, 0.4], [0.5, 0.8], [0.4, 9.6], [3.4, 9.8], [3.4, 10.4], [0, 10.4]], 36)), [tx, F, tz], 1, W1, { tex: R.tex('darkWood'), spec: 0.3 });
    R.put(R.mesh('lampbase', () => latheGeo([[0, 0], [1.2, 0], [1.6, 1.2], [1.4, 3], [0.5, 3.8], [0.25, 5.6], [0, 5.6]], 36)), [tx, F + 10.4, tz], 1, sx < 0 ? '#e7e0cf' : '#4f7d8c', { spec: 0.8 });
    R.put(R.mesh('drum', () => latheGeo([[2.6, 0], [2.0, 3.2], [1.95, 3.2], [2.55, 0]], 40)), [tx, F + 14.8, tz], 1, '#fff2d4', { lit: false, emit: 0.05, cast: false });
    R.glow(c, [tx, F + 16.4, tz], 8, '#ffd9a0', 0.3);
    R.blob(tx, tz, 7, 7, 0.4, F + 0.04);
  }
  if (show.back) {
    // painting and a clock above the sofa
    R.put(R.rbox(19, 13.4, 0.8, 0.2, 0.3), [0, F + 23, -half + 0.4], 1, W1, { tex: R.tex('darkWood'), spec: 0.3, cast: false });
    R.put(R.rbox(17.4, 11.8, 0.85, 0.05), [0, F + 23, -half + 0.45], 1, '#e8dfc9', { cast: false });
    R.put('box', [0, F + 23, -half + 0.9], [16.2, 10.6, 0.05], W1, { tex: R.tex('painting'), cast: false, spec: 0.15 });
    R.put('disc', [-23, F + 22, -half + 0.6], [6, 1, 6], W1, { tex: R.tex('clock'), q: rotX(PI / 2), cast: false });
    R.put('torus', [-23, F + 22, -half + 0.6], [8.4, 4, 8.4], '#5a3a1c', { q: rotX(PI / 2), cast: false, spec: 0.4 });
  }
  if (show.left) {
    // window with curtains
    const wx = -half + 0.05, wz = -2, wy = F + 17;
    R.put('box', [wx, wy, wz], [0.1, 15, 22], W1, { tex: R.tex('windowDay'), lit: false, cast: false });
    const frame = '#f7f3ea';
    R.put(R.rbox(1, 16.2, 1, 0.2), [wx + 0.4, wy, wz - 11.2], 1, frame);
    R.put(R.rbox(1, 16.2, 1, 0.2), [wx + 0.4, wy, wz + 11.2], 1, frame);
    R.put(R.rbox(1, 1, 23.4, 0.2), [wx + 0.4, wy + 7.8, wz], 1, frame);
    R.put(R.rbox(2.4, 0.8, 24.4, 0.25), [wx + 1, wy - 7.9, wz], 1, frame, { spec: 0.3 });
    R.put(R.rbox(0.5, 15, 0.5, 0.1), [wx + 0.4, wy, wz], 1, frame);
    R.put(R.rbox(0.5, 0.5, 22, 0.1), [wx + 0.4, wy, wz], 1, frame);
    R.put('cyl', [wx + 2.6, wy + 9.6, wz - 16], [0.45, 32, 0.45], '#b88a3a', { q: rotX(PI / 2), spec: 0.8 });
    for (const s of [-1, 1]) R.put('sphere', [wx + 2.6, wy + 9.6, wz + s * 16.4], 1.1, '#b88a3a', { spec: 0.8 });
    const curtain = R.mesh('curtain', () => curtainGeo(8, 21, 5, 0.6));
    for (const s of [-1, 1]) R.put(curtain, [wx + 2.4, F + 0.6, wz + s * 12.5], 1, '#e3a294', { tex: R.tex('fabric'), q: yawQ(PI / 2), emit: 0.15 });
    plant(R, -half + 5, F, 14, { s: 1.1 });
  }
  if (show.right) {
    bookshelf(R, half - 2.3, F, -12, -PI / 2, { w: 18, h: 26, d: 4 });
  }
  armchair(R, -23, F, 2, PI / 2 - 0.35);
  lamp(R, c, 28, F, -26, {});
  plant(R, 28, F, 22, { s: 0.9, pot: '#ece6da', seed: 5, leaf: 'snake' });
  cat(R, 12, F + 0.05, 10, -0.6);
}

// ---------------------------------------------------------------- beach

function palm(R, x, z, { seed = 1, h = 14, lean = 0.25, yaw = 0 } = {}) {
  const key = `palm:${seed}:${h}:${lean}`;
  const trunk = R.mesh(`${key}:trunk`, () => {
    // a gently curving trunk: rings stacked along a bent spine
    const parts = [];
    const n = 14;
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const ang = lean * t * t * 2.2;
      const seg = h / n;
      const r0 = 0.62 - t * 0.22;
      parts.push({ geo: latheGeo([[r0, 0], [r0 * 1.08, seg * 0.15], [r0 * 0.96, seg * 1.05]], 20), m: trs([px, py, 0], rotZ(-ang), 1) });
      px += Math.sin(ang) * seg; py += Math.cos(ang) * seg;
    }
    const g = merge(parts);
    g.top = [px, py];
    return g;
  });
  const top = (() => { let px = 0, py = 0; for (let i = 0; i < 14; i++) { const t = i / 14, ang = lean * t * t * 2.2, seg = h / 14; px += Math.sin(ang) * seg; py += Math.cos(ang) * seg; } return [px, py]; })();
  const q = yawQ(yaw);
  R.put(trunk, [x, -0.32, z], 1, W1, { tex: R.tex('palmBark'), q, spec: 0.1 });
  const tx = x + Math.cos(yaw) * top[0], tz = z - Math.sin(yaw) * top[0], ty = -0.32 + top[1];
  const fronds = R.mesh(`${key}:fronds`, () => {
    const r = rng(seed * 13);
    const parts = [];
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * PI * 2 + r() * 0.3;
      const len = 6 + r() * 2;
      const geo = leafGeo({ len, width: 2.6, droop: 2.6 + r() * 1.4, cup: -0.25, nl: 12, nw: 2, shape: 'strip' });
      parts.push({ geo, m: trs([0, 0, 0], qmul(yawQ(a), rotX(-0.35 - r() * 0.3)), 1), color: [0.9 + r() * 0.2, 0.95, 0.9] });
    }
    return merge(parts);
  });
  R.put(fronds, [tx, ty, tz], 1, W1, { tex: R.tex('frond'), alphaTest: 0.5, spec: 0.15 });
  for (const [dx, dz] of [[0.4, 0.2], [-0.3, 0.35], [0.05, -0.45]]) R.put('sphere', [tx + dx, ty - 0.55, tz + dz], 0.75, '#5a3d1e', { spec: 0.3 });
}

function umbrella(R, x, z, { tex = 'umbrella', tilt = 0.14, dir = 0.8, h = 9.5 } = {}) {
  const q = qmul(yawQ(dir), rotX(tilt));
  const up = [Math.sin(dir) * Math.sin(tilt), Math.cos(tilt), Math.cos(dir) * Math.sin(tilt)];
  const at = (k) => [x + up[0] * k, -0.6 + up[1] * k, z + up[2] * k];
  R.put('cyl', [x, -0.6, z], [0.24, h + 0.6, 0.24], '#f4f1e8', { q, spec: 0.5 });
  const canopy = R.mesh('canopy', () => latheGeo([[5.9, -1.95], [5.75, -1.75], [4.6, -1.15], [3.2, -0.6], [1.6, -0.18], [0, 0]], 64, 1));
  R.put(canopy, at(h), 1, W1, { tex: R.tex(tex), q, spec: 0.12 });
  R.put('sphere', at(h + 0.25), 0.5, '#e8473f', { spec: 0.6 });
  // ribs under the canopy
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * PI * 2;
    R.put('cyl', at(h - 0.15), [0.07, 5.8, 0.07], '#d8d4ca', { q: qmul(q, yawQ(a), rotX(PI / 2 + 0.33)) });
  }
}

function lounger(R, x, z, yaw, tex = 'lounger') {
  const p = placer(R, x, -0.3, z, yaw);
  const frame = '#f2efe8';
  p(R.rbox(3.6, 0.35, 8, 0.15), [0, 1.3, 1.5], 1, W1, { tex: R.tex(tex), spec: 0.1 });
  p(R.rbox(3.6, 0.35, 4.5, 0.15), [0, 2.6, -3.6], 1, W1, { tex: R.tex(tex), q: rotX(0.6), spec: 0.1 });
  for (const sx of [-1, 1]) {
    p(R.rbox(0.25, 0.3, 8.4, 0.1), [sx * 1.85, 1.15, 1.5], 1, frame, { spec: 0.4 });
    for (const lz of [-2.2, 5.2]) p(R.rbox(0.25, 1.2, 0.25, 0.08), [sx * 1.7, 0.55, lz], 1, frame);
  }
  R.blob(x, z, 5, 11, 0.4, -0.29, yaw);
}

function beach(R, c) {
  skyDome(R, 'sky');
  // sand, wet sand and the sea
  R.put(R.mesh('sandplane', () => planeGeo(18)), [0, -0.32, 45], [260, 1, 150], W1, { tex: R.tex('sand'), cast: false, spec: 0.03 });
  R.put('plane', [0, -0.315, -23.5], [260, 1, 6], [0.9, 0.84, 0.74], { tex: R.tex('sand'), cast: false, spec: 0.3 });
  R.put(R.mesh('seaplane', () => planeGeo(24, 12)), [0, -0.36, -110], [300, 1, 180], W1, { tex: R.tex('water'), cast: false, spec: 0.9 });
  R.blend(true);
  R.put(R.mesh('foamstrip', () => planeGeo(30, 1)), [0, -0.3, -21.6], [260, 1, 2.6], [1, 1, 1, 0.9], { tex: R.tex('foam'), lit: false, cast: false });
  R.put(R.mesh('foamstrip2', () => planeGeo(22, 1)), [0, -0.33, -26.5], [260, 1, 2], [1, 1, 1, 0.55], { tex: R.tex('foam'), lit: false, cast: false });
  R.blend(false);
  // the board lies on a beach blanket
  R.put('plane', [0, -0.295, 0], [15, 1, 15], W1, { tex: R.tex('towel'), cast: false, spec: 0.02 });
  umbrella(R, 13, -11.5, { dir: -2.4, tilt: 0.16 });
  lounger(R, 17, -3, -0.25);
  lounger(R, 22, 1, -0.4, 'lounger');
  R.put('plane', [18.5, -0.29, 10], [4, 1, 7.5], W1, { tex: R.tex('towel'), q: yawQ(0.5), cast: false });
  // surfboard stuck in the sand
  R.put('sphere', [-13.5, 3.2, -10], [2, 8, 0.4], W1, { tex: R.tex('surfboard'), q: qmul(yawQ(0.5), rotZ(0.12)), spec: 0.7 });
  // cooler box
  R.put(R.rbox(3, 2.2, 2.1, 0.3), [10.2, 0.8, 9.2], 1, '#2f7fd8', { q: yawQ(-0.3), spec: 0.4 });
  R.put(R.rbox(3.1, 0.5, 2.2, 0.2), [10.2, 2.05, 9.2], 1, '#f4f1ea', { q: yawQ(-0.3), spec: 0.4 });
  R.put('torus', [10.2, 2.35, 9.2], [1.3, 1.0, 1.3], '#e8e4da', { q: qmul(yawQ(-0.3 + PI / 2), rotZ(PI / 2)) });
  R.blob(10.2, 9.2, 5, 4, 0.4, -0.3);
  // beach ball, bucket and spade
  R.put('sphere', [-9.8, 0.75, 9], 2.2, W1, { tex: R.tex('ball'), q: quat.axis([1, 0, 0.4], 0.6), spec: 0.8 });
  R.blob(-9.8, 9, 2.6, 2.6, 0.5, -0.3);
  const bucket = R.mesh('bucket', () => latheGeo([[0, 0], [0.75, 0], [0.8, 0.05], [1.05, 1.6], [1.12, 1.7], [1.02, 1.7], [0.95, 0.2], [0, 0.2]], 40));
  R.put(bucket, [7.2, -0.3, 11.6], 1, '#ff6b4a', { spec: 0.6 });
  R.put('torus', [7.2, 1.0, 11.6], [2.1, 1.6, 2.1], '#ffd23a', { q: rotX(PI / 2 - 0.3) });
  R.put(R.rbox(0.18, 0.12, 2.2, 0.05), [5.6, 0.0, 12.5], 1, '#2ec4b6', { q: qmul(yawQ(0.8), rotX(-0.15)) });
  R.put(R.rbox(0.9, 0.08, 1.1, 0.1), [4.85, -0.18, 13.3], 1, '#2ec4b6', { q: yawQ(0.8) });
  // sandcastle with a moat and a flag
  const sx = -11.5, sz = -1.5;
  R.put('torus', [sx, -0.42, sz], [9, 0.8, 9], [0.78, 0.68, 0.52], { tex: R.tex('sand'), cast: false });
  R.put('cyl', [sx, -0.32, sz], [4.4, 1.0, 4.4], W1, { tex: R.tex('sand') });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + PI / 4;
    const tx = sx + Math.cos(a) * 1.6, tz = sz + Math.sin(a) * 1.6;
    R.put('cyl', [tx, 0.6, tz], [1.2, 1.4, 1.2], W1, { tex: R.tex('sand') });
    for (let k = 0; k < 6; k++) {
      const b = (k / 6) * PI * 2;
      R.put('box', [tx + Math.cos(b) * 0.5, 2.1, tz + Math.sin(b) * 0.5], [0.28, 0.3, 0.28], W1, { tex: R.tex('sand'), q: yawQ(-b) });
    }
  }
  R.put('cyl', [sx, 0.6, sz], [1.9, 2.4, 1.9], W1, { tex: R.tex('sand') });
  R.put('cone', [sx, 3.0, sz], [2.1, 1.4, 2.1], [0.95, 0.9, 0.8], { tex: R.tex('sand') });
  R.put('cyl', [sx, 4.2, sz], [0.08, 1.8, 0.08], '#6b4423');
  R.put(R.mesh('flag', () => sheetGeo(1, 0.6, 6, 2, (x2) => Math.sin(x2 * 5) * 0.08)), [sx + 0.5, 5.3, sz], 1, '#e8473f', { q: yawQ(0) });
  // palms
  palm(R, -19, -13, { seed: 1, h: 15, lean: 0.3, yaw: -0.6 });
  palm(R, -24, 5, { seed: 2, h: 12, lean: 0.4, yaw: 0.5 });
  palm(R, 28, -16, { seed: 3, h: 16, lean: 0.25, yaw: 2.6 });
  // rocks by the water
  const rocks = R.mesh('rocks', () => {
    const r = rng(17);
    return merge([[19, -21, 3.4], [22.5, -19.8, 2.2], [24, -22.5, 1.6], [-30, -20.5, 2.8], [-27, -21.8, 1.5]].map(([x, z, s], i) => ({
      geo: rockGeo(i + 4, 0.32, 24, 16), m: trs([x, s * 0.25 - 0.3, z], yawQ(r() * 6), [s, s * 0.9, s * 1.1]), color: [0.55 + r() * 0.1, 0.53, 0.5],
    })));
  });
  R.put(rocks, [0, 0, 0], 1, W1, { spec: 0.2 });
  // starfish and shells
  const sea = R.mesh('starfish', () => merge([
    [8.5, 3.5, '#ff7a45', 0.3], [-7.5, 12.5, '#ff5a7a', 1.1], [14, 14, '#ffa040', 2.2],
  ].map(([x, z, col, a]) => ({ geo: starfishGeo(), m: trs([x, -0.3, z], yawQ(a), 1.3), color: col.match(/\w\w/g).map((h) => parseInt(h, 16) / 255) }))));
  R.put(sea, [0, 0, 0], 1, W1, { spec: 0.2 });
  const shells = R.mesh('shells', () => {
    const r = rng(23);
    return merge(Array.from({ length: 18 }, () => {
      const x = (r() - 0.5) * 50, z = 8 + r() * 22;
      return { geo: latheGeo([[0, 0], [0.5, 0], [0.42, 0.18], [0.2, 0.32], [0, 0.36]], 14), m: trs([x, -0.31, z], yawQ(r() * 6), [0.5 + r() * 0.4, 0.4, 0.4 + r() * 0.3]), color: [1, 0.86 + r() * 0.12, 0.8 + r() * 0.15] };
    }));
  });
  R.put(shells, [0, 0, 0], 1, W1, { spec: 0.4 });
  // a crab
  const cp = placer(R, 4.5, -0.3, 15.5, 0.3);
  cp('sphere', [0, 0.45, 0], [1.6, 0.7, 1.2], '#e0452f', { spec: 0.4 });
  for (const s of [-1, 1]) {
    cp('sphere', [s * 1.2, 0.55, 0.7], [0.5, 0.35, 0.4], '#e0452f');
    cp('sphere', [s * 0.3, 0.95, 0.45], 0.18, '#1b1b1b');
    for (let k = 0; k < 3; k++) cp('cyl', [s * 0.7, 0.35, -0.3 + k * 0.3], [0.1, 0.8, 0.1], '#c93a26', { q: rotZ(s * 1.2) });
  }
  // a drink and sunglasses on the blanket
  const glass = R.mesh('glass', () => latheGeo([[0, 0], [0.32, 0], [0.34, 0.05], [0.42, 1.0], [0.4, 1.0], [0.3, 0.06], [0, 0.06]], 32));
  R.put(glass, [6.7, -0.3, 6.6], 1, '#cfeef0', { spec: 1 });
  R.put('cyl', [6.7, -0.25, 6.6], [0.7, 0.85, 0.7], '#ff9a2e', { spec: 0.6 });
  R.put('cyl', [6.6, 0.3, 6.6], [0.06, 1.2, 0.06], '#ff4fa3', { q: rotZ(0.3) });
  R.put('cone', [6.95, 0.95, 6.6], [0.7, 0.3, 0.7], '#2ec4b6', { q: rotZ(-0.4) });
  for (const s of [-1, 1]) R.put('sphere', [-6.6 + s * 0.42, -0.24, 6.8], [0.7, 0.12, 0.55], '#1d1d22', { spec: 1 });
  R.put(R.rbox(0.3, 0.08, 0.08, 0.03), [-6.6, -0.22, 6.8], 1, '#c9a227');
  // far away: a sailboat and an island
  const boat = placer(R, -40, -0.36, -95, 0.4);
  boat(R.rbox(9, 1.6, 3, 0.7), [0, 0.5, 0], 1, '#f6f6f6');
  boat('cyl', [0, 1, 0], [0.25, 11, 0.25], '#7a5a3a');
  boat(R.mesh('sail', () => sheetGeo(6, 9, 4, 6, (x2, y2) => 0.3 * Math.sin((y2 / 9) * PI))), [2.6, 2.2, 0], [1, 1, 1], '#fff8ee', { q: yawQ(PI / 2) });
  R.put('sphere', [70, -2.5, -140], [60, 9, 30], [0.86, 0.78, 0.6], { tex: R.tex('sand'), cast: false });
  R.put('sphere', [70, 1.2, -140], [40, 8, 20], [0.4, 0.62, 0.35], { tex: R.tex('leaves'), cast: false });
  // the sun
  R.withoutFog(() => R.glow(c, [-60, 70, -150], 70, '#fff3c4', 0.85));
}

// ---------------------------------------------------------------- garden picnic

function tree(R, x, z, { seed = 1, h = 12, crown = 9, tex = 'leaves', y = -0.32 } = {}) {
  const trunk = R.mesh(`trunk:${h}`, () => latheGeo([[1.5, 0], [1.1, 0.6], [0.9, h * 0.5], [0.75, h], [0, h]], 28));
  R.put(trunk, [x, y, z], 1, W1, { tex: R.tex('bark'), spec: 0.05 });
  const m = R.mesh(`crown:${seed}:${crown}`, () => {
    const r = rng(seed * 7);
    const parts = [];
    for (let i = 0; i < 11; i++) {
      const a = r() * PI * 2, d = r() * crown * 0.5;
      const s = crown * (0.45 + r() * 0.35);
      const g = 0.85 + r() * 0.3;
      parts.push({ geo: rockGeo(seed * 31 + i, 0.18, 24, 16), m: trs([Math.cos(a) * d, (r() - 0.3) * crown * 0.45, Math.sin(a) * d], yawQ(r() * 6), [s, s * 0.85, s]), color: [g, g, g] });
    }
    return merge(parts);
  });
  R.put(m, [x, y + h + crown * 0.15, z], 1, W1, { tex: R.tex(tex), spec: 0.08 });
}

function picnicGarden(R, c) {
  skyDome(R, 'sky');
  R.put(R.mesh('grassplane', () => planeGeo(22)), [0, -0.32, 0], [300, 1, 300], W1, { tex: R.tex('grass'), cast: false, spec: 0.02 });
  // far hills for depth
  for (const [x, z, sx, sy, col] of [[-90, -150, 140, 22, [0.5, 0.68, 0.42]], [80, -170, 160, 30, [0.45, 0.62, 0.4]], [160, -60, 90, 18, [0.52, 0.7, 0.44]]]) {
    R.put('sphere', [x, -2, z], [sx, sy, sx * 0.5], col, { tex: R.tex('grass'), cast: false });
  }
  // the blanket
  R.put('plane', [0, -0.3, 0], [16, 1, 16], W1, { tex: R.tex('gingham'), cast: false });
  // basket
  const bp = placer(R, 9.3, -0.3, -6.5, -0.4);
  bp(R.rbox(4.6, 3, 3.2, 0.45, 0.6), [0, 1.5, 0], 1, W1, { tex: R.tex('wicker'), spec: 0.1 });
  bp(R.rbox(2.4, 0.4, 3.4, 0.2, 0.6), [-1.2, 3.1, 0], 1, W1, { tex: R.tex('wicker'), q: rotZ(0.25) });
  bp(R.rbox(2.4, 0.4, 3.4, 0.2, 0.6), [1.2, 3.1, 0], 1, W1, { tex: R.tex('wicker'), q: rotZ(-0.25) });
  bp('torus', [0, 3.2, 0], [4.4, 3.4, 1.2], '#a8783e', { q: rotX(PI / 2) });
  bp('box', [0.4, 3.4, 1.2], [3.2, 0.06, 1.2], W1, { tex: R.tex('gingham'), q: rotZ(-0.2) });
  R.blob(9.3, -6.5, 6, 5, 0.45, -0.29);
  // lemonade jug and glasses
  const jug = R.mesh('jug', () => latheGeo([[0, 0], [0.9, 0], [1.0, 0.1], [1.1, 1.6], [0.85, 2.6], [0.8, 3.0], [0.95, 3.2], [0.9, 3.25], [0.7, 3.0], [0, 2.9]], 36));
  R.put(jug, [-6.6, -0.3, -6.4], 1, '#f6e27a', { spec: 0.9 });
  R.put('torus', [-5.65, 1.4, -6.4], [1.2, 1.6, 1.6], '#f6e27a', { q: rotX(PI / 2), spec: 0.8 });
  for (const [x, z] of [[-6.6, -4.8], [-4.9, -6.6]]) {
    R.put(R.mesh('cup', () => latheGeo([[0, 0], [0.35, 0], [0.45, 1.1], [0.4, 1.1], [0.3, 0.08], [0, 0.08]], 28)), [x, -0.3, z], 1, '#fff6c8', { spec: 0.9 });
  }
  // sandwiches and a bowl of apples
  R.put('disc', [6.6, -0.28, 6.4], [2.6, 1, 2.6], '#ffffff', { spec: 0.5 });
  const sandwich = R.mesh('sandwich', () => {
    const tri = (r, h, y, color) => ({ geo: latheGeo([[0, 0], [r, 0], [r, h], [0, h]], 3), m: trs([0, y, 0]), color });
    return merge([
      tri(0.78, 0.16, 0, [0.95, 0.85, 0.62]), tri(0.82, 0.05, 0.16, [0.45, 0.75, 0.3]), tri(0.76, 0.06, 0.21, [0.9, 0.3, 0.25]),
      tri(0.8, 0.04, 0.27, [1, 0.82, 0.3]), tri(0.78, 0.16, 0.31, [0.95, 0.85, 0.62]),
    ]);
  });
  for (const [dx, dz, a] of [[-0.45, 0.25, 0.3], [0.5, -0.1, 2.1], [0.05, 0.65, 4]]) {
    R.put(sandwich, [6.6 + dx, -0.26, 6.4 + dz], 1, W1, { q: yawQ(a), spec: 0.1 });
  }
  const fruitBowl = R.mesh('fruitbowl', () => latheGeo([[0, 0], [0.6, 0], [1.25, 0.5], [1.3, 0.75], [1.2, 0.75], [0.6, 0.12], [0, 0.12]], 36));
  R.put(fruitBowl, [-6.6, -0.3, 6.6], 1, '#7fb3d5', { spec: 0.6 });
  for (const [dx, dz, col] of [[-0.35, 0.1, '#d6262d'], [0.4, -0.2, '#8cc63f'], [0.05, 0.45, '#d6262d'], [0.1, -0.5, '#f2b632']]) {
    R.put('sphere', [-6.6 + dx, 0.55, 6.6 + dz], 0.75, col, { spec: 0.7 });
  }
  // fence and flowers behind
  const fence = R.mesh('fence', () => {
    const parts = [];
    for (let x = -60; x <= 60; x += 1.6) {
      parts.push({ geo: boxGeo(1, 6, 0.3), m: trs([x, 3, 0]) });
      parts.push({ geo: roofGeo(), m: trs([x, 6, 0], rotZ(0), [1, 0.6, 0.3]) });
    }
    for (const y of [1.6, 4.4]) parts.push({ geo: boxGeo(121, 0.5, 0.3), m: trs([0, y, -0.3]) });
    return merge(parts);
  });
  R.put(fence, [0, -0.32, -30], 1, '#f6f3ec', { spec: 0.2 });
  const flowers = R.mesh('flowers', () => {
    const r = rng(41);
    const cols = [[0.95, 0.3, 0.45], [1, 0.82, 0.25], [0.6, 0.45, 0.95], [1, 1, 1], [1, 0.55, 0.25], [0.95, 0.5, 0.75], [0.85, 0.15, 0.2]];
    const parts = [];
    const petal = sphereGeo(8, 4), stem = cylGeo(6), bud = sphereGeo(10, 6);
    const tulip = latheGeo([[0, 0], [0.3, 0.05], [0.42, 0.35], [0.4, 0.75], [0.3, 0.9], [0.34, 0.95], [0, 0.6]], 12);
    for (let i = 0; i < 150; i++) {
      const x = (r() - 0.5) * 110, z = -28.2 + r() * 4.5;
      const h = 1.6 + r() * 2.2;
      const lean = (r() - 0.5) * 0.25;
      parts.push({ geo: stem, m: trs([x, 0, z], rotZ(lean), [0.1, h, 0.1]), color: [0.3, 0.55, 0.25] });
      const tx = x - Math.sin(lean) * h, ty = Math.cos(lean) * h;
      const col = cols[Math.floor(r() * cols.length)];
      if (r() < 0.6) {
        // daisy: a ring of petals around a yellow middle, tipped towards the viewer
        const face = qmul(rotX(0.6 + r() * 0.3), yawQ(r() * 0.6 - 0.3));
        for (let k = 0; k < 7; k++) {
          const a2 = (k / 7) * PI * 2;
          parts.push({ geo: petal, m: trs([tx, ty, z], qmul(face, yawQ(a2)), 1), color: col, local: [0.42, 0, 0] });
        }
        parts.push({ geo: bud, m: trs([tx, ty + 0.05, z], face, [0.36, 0.2, 0.36]), color: [1, 0.8, 0.15] });
      } else {
        parts.push({ geo: tulip, m: trs([tx, ty - 0.15, z], undefined, [1.1, 1.3, 1.1]), color: col });
      }
      if (r() < 0.7) parts.push({ geo: leafGeo({ len: 1.3, width: 0.5, droop: 0.4 }), m: trs([x, h * 0.35, z], qmul(yawQ(r() * 6), rotX(-0.6))), color: [0.3, 0.6, 0.28] });
    }
    // petals sit away from the middle: bake the offset into each petal's matrix
    for (const p2 of parts) {
      if (!p2.local) continue;
      const m = p2.m;
      const [lx, ly, lz] = p2.local;
      p2.m = m.slice();
      p2.m[12] += m[0] * lx + m[4] * ly + m[8] * lz;
      p2.m[13] += m[1] * lx + m[5] * ly + m[9] * lz;
      p2.m[14] += m[2] * lx + m[6] * ly + m[10] * lz;
      // squash the petal into an oval
      const sc = [0.62, 0.12, 0.3];
      for (let k = 0; k < 3; k++) { p2.m[k] *= sc[0]; p2.m[4 + k] *= sc[1]; p2.m[8 + k] *= sc[2]; }
    }
    return merge(parts);
  });
  R.put(flowers, [0, -0.32, 0], 1, W1, { spec: 0.2 });
  // bushes along the fence
  for (const [x, s] of [[-40, 6], [-28, 4.5], [30, 5.5], [44, 7]]) {
    R.put(R.mesh(`bush:${s}`, () => rockGeo(Math.round(s * 10), 0.2, 28, 18)), [x, s * 0.35 - 0.3, -26], [s * 1.6, s, s * 1.2], W1, { tex: R.tex('leavesDark'), spec: 0.1 });
  }
  // trees
  tree(R, -24, -16, { seed: 1, h: 14, crown: 11 });
  tree(R, 28, -20, { seed: 2, h: 16, crown: 12, tex: 'leavesDark' });
  tree(R, 34, 8, { seed: 3, h: 12, crown: 10 });
  tree(R, -36, 14, { seed: 4, h: 15, crown: 12, tex: 'leavesDark' });
  // grass tufts
  const tufts = R.mesh('tufts', () => {
    const r = rng(51);
    const parts = [];
    for (let i = 0; i < 240; i++) {
      let x = (r() - 0.5) * 80, z = (r() - 0.5) * 60;
      if (Math.abs(x) < 10 && Math.abs(z) < 10) x += x < 0 ? -10 : 10;
      for (let k = 0; k < 5; k++) {
        const g = 0.8 + r() * 0.4;
        parts.push({ geo: leafGeo({ len: 0.9 + r() * 0.9, width: 0.2, droop: 0.3, cup: 0, nl: 3, nw: 1, shape: 'blade' }), m: trs([x, 0, z], qmul(yawQ(r() * 6.3), rotX(-PI / 2 + 0.25 + r() * 0.4))), color: [0.35 * g, 0.6 * g, 0.25 * g] });
      }
    }
    return merge(parts);
  });
  R.put(tufts, [0, -0.32, 0], 1, W1, { cast: false });
  // bench, birdhouse and a garden gnome
  const bench = placer(R, -17, -0.32, -9, 0.5);
  for (let i = 0; i < 4; i++) bench(R.rbox(9, 0.3, 0.8, 0.1, 0.2), [0, 3.3, -1.3 + i * 0.95], 1, W1, { tex: R.tex('lightWood') });
  for (let i = 0; i < 3; i++) bench(R.rbox(9, 0.8, 0.3, 0.1, 0.2), [0, 4.6 + i * 1.0, -2.0], 1, W1, { tex: R.tex('lightWood'), q: rotX(-0.15) });
  for (const sx of [-1, 1]) {
    bench(R.rbox(0.3, 3.3, 3.4, 0.1), [sx * 4, 1.6, -0.2], 1, '#2b2f2c', { spec: 0.6 });
    bench(R.rbox(0.3, 3.6, 0.3, 0.1), [sx * 4, 4.9, -2.2], 1, '#2b2f2c', { spec: 0.6 });
  }
  R.blob(-17, -9, 11, 5, 0.35, -0.3, 0.5);
  R.put('cyl', [16, -0.32, -14], [0.4, 8, 0.4], W1, { tex: R.tex('lightWood') });
  R.put(R.rbox(2.4, 2.4, 2.4, 0.15), [16, 8.6, -14], 1, '#5aa0d8');
  R.put('roof', [16, 9.8, -14], [3.2, 1.4, 3.0], '#d9534f');
  R.put('disc', [16, 8.8, -12.78], [0.9, 1, 0.9], '#1b1b1b', { q: rotX(PI / 2), cast: false });
  const g = placer(R, -5, -0.32, -21, 0.2);
  g(R.mesh('gnomebody', () => latheGeo([[0, 0], [1.1, 0], [1.2, 0.3], [1.0, 1.8], [0, 1.9]], 28)), [0, 0, 0], 1, '#2f6fb3', { spec: 0.4 });
  g('sphere', [0, 2.3, 0], 1.1, '#f2c7a5', { spec: 0.3 });
  g('cone', [0, 1.6, 0.25], [1.4, 1.6, 1.0], '#f6f3ec', { q: rotX(PI) });
  g('cone', [0, 2.6, 0], [1.3, 2.4, 1.3], '#d93b3b', { q: rotX(-0.25), spec: 0.4 });
  g('sphere', [0, 2.3, 0.55], 0.28, '#f29b8a');
  R.blob(-5, -21, 3, 3, 0.4, -0.3);
  // butterflies
  for (const [x, y, z, col, a] of [[-12, 4, -20, '#ffb02e', 0.3], [8, 5, -24, '#7ab8ff', 2], [-30, 3, -23, '#ff6fb5', 4]]) {
    const wing = R.mesh('wing', () => leafGeo({ len: 1.3, width: 1.4, droop: 0, cup: 0.1, nl: 5, nw: 4 }));
    const wing2 = R.mesh('wing2', () => leafGeo({ len: 0.9, width: 0.9, droop: 0, cup: 0.1, nl: 4, nw: 3 }));
    for (const s of [-1, 1]) {
      R.put(wing, [x, y, z], 1, col, { q: qmul(yawQ(a + s * 1.25), rotZ(s * 0.45)), cast: false, spec: 0.3 });
      R.put(wing2, [x, y - 0.05, z], 1, col, { q: qmul(yawQ(a + s * 2.1), rotZ(s * 0.45)), cast: false, spec: 0.3 });
    }
    R.put('sphere', [x, y, z], [0.18, 0.18, 1.0], '#2a2a2a', { q: yawQ(a), cast: false });
  }
  R.withoutFog(() => R.glow(c, [70, 80, -140], 60, '#fff6cf', 0.8));
}

// ---------------------------------------------------------------- casino

const CASINO = { F: -6.6, H: 26, half: 34 };

function slotMachine(R, x, F, z, yaw, i) {
  const p = placer(R, x, F, z, yaw);
  p(R.rbox(6, 11, 4.6, 0.6), [0, 5.5, 0], 1, ['#b3182c', '#6a1a8c', '#1b5fa8'][i % 3], { spec: 0.5 });
  p(R.rbox(6.4, 0.8, 5, 0.3), [0, 11.2, 0], 1, '#d4a63c', { spec: 0.9 });
  p('box', [0, 7.3, 2.32], [4.4, 5.4, 0.05], W1, { tex: R.tex(`slot${i % 3}`), lit: false, emit: 0.1, cast: false });
  p('half', [0, 11.6, 0], [3.4, 2.2, 3.4], '#ffe08a', { lit: false, emit: 0.2 });
  p(R.rbox(5.4, 1, 3, 0.3), [0, 3.6, 2.4], 1, '#d4a63c', { spec: 0.9 });
  p('cyl', [3.4, 6, 0.6], [0.25, 3.6, 0.25], '#c9c9c9', { spec: 1 });
  p('sphere', [3.4, 9.7, 0.6], 1.1, '#e01e3c', { spec: 0.9 });
  const stool = R.mesh('stool', () => latheGeo([[0, 0], [1.8, 0], [1.8, 0.3], [0.35, 0.5], [0.3, 6.4], [1.9, 6.6], [2.0, 7.3], [0, 7.4]], 32));
  p(stool, [0, 0, 6.5], 1, '#3a3a3a', { spec: 0.6 });
  p('cyl', [0, 7.0, 6.5], [3.9, 0.6, 3.9], '#a01428', { spec: 0.3 });
  R.blob(x, z, 8, 8, 0.4, F + 0.03, yaw);
}

function chips(R, color, stacks) {
  const key = `chips:${color}:${stacks.map((s) => s.join(',')).join(';')}`;
  const sides = R.mesh(`${key}:s`, () => merge(stacks.flatMap(([x, z, n]) => Array.from({ length: n }, (_, k) => ({
    geo: latheGeo([[0.42, 0], [0.42, 0.11]], 32), m: trs([x + Math.sin(k * 7) * 0.03, -0.3 + k * 0.115, z + Math.cos(k * 5) * 0.03]),
  })))));
  const tops = R.mesh(`${key}:t`, () => merge(stacks.map(([x, z, n]) => ({ geo: discGeo(32), m: trs([x, -0.3 + n * 0.115 - 0.004, z], undefined, 0.84) }))));
  R.put(sides, [0, 0, 0], 1, W1, { tex: R.tex(`chip${color}Edge`), spec: 0.5 });
  R.put(tops, [0, 0, 0], 1, W1, { tex: R.tex(`chip${color}Top`), spec: 0.5 });
}

function casino(R, c) {
  const { F, H, half } = CASINO;
  const show = room(R, c, { half, F, H, wallTex: 'fabric', wallTint: [0.45, 0.1, 0.16], uv: 1 / 10, floorTex: 'carpet', floorTile: 12, trim: '#c9a046', floorSpec: 0.02 });
  // wood panelling on the lower walls
  const panel = R.rbox(2 * half, 8, 0.5, 0.1, 0.12);
  const panelS = R.rbox(0.5, 8, 2 * half, 0.1, 0.12);
  if (show.back) R.put(panel, [0, F + 4, -half + 0.3], 1, W1, { tex: R.tex('darkWood'), cast: false, spec: 0.4 });
  if (show.left) R.put(panelS, [-half + 0.3, F + 4, 0], 1, W1, { tex: R.tex('darkWood'), cast: false, spec: 0.4 });
  if (show.right) R.put(panelS, [half - 0.3, F + 4, 0], 1, W1, { tex: R.tex('darkWood'), cast: false, spec: 0.4 });
  if (show.front) R.put(panel, [0, F + 4, half - 0.3], 1, W1, { tex: R.tex('darkWood'), cast: false, spec: 0.4 });
  // the poker table: felt, a padded rail, a wooden trim and a pedestal
  R.put(R.rbox(14, 0.4, 14, 0.15, 0.12), [0, -0.5, 0], 1, W1, { tex: R.tex('felt'), spec: 0.02 });
  for (const [x, z, w, d] of [[0, 7.55, 16.6, 1.5], [0, -7.55, 16.6, 1.5], [7.55, 0, 1.5, 13.6], [-7.55, 0, 1.5, 13.6]]) {
    R.put(R.rbox(w, 0.9, d, 0.42), [x, -0.15, z], 1, '#3a1a12', { spec: 0.55 });
  }
  R.put(R.rbox(17, 0.5, 17, 0.2, 0.2), [0, -0.85, 0], 1, W1, { tex: R.tex('darkWood'), spec: 0.4 });
  R.put(R.mesh('pedestal', () => latheGeo([[0, 0], [5, 0], [5, 0.6], [2.2, 1.2], [1.4, 2.5], [1.2, 4.6], [2.6, 5.4], [2.6, 5.75], [0, 5.75]], 40)), [0, F, 0], 1, W1, { tex: R.tex('darkWood'), spec: 0.4 });
  R.blob(0, 0, 22, 22, 0.5, F + 0.04);
  // chips and cards on the felt
  chips(R, 'Red', [[6.2, 6.2, 6], [6.2, 5.3, 4], [5.3, 6.25, 8]]);
  chips(R, 'Blue', [[-6.2, 6.2, 5], [-5.3, 6.25, 3]]);
  chips(R, 'Black', [[-6.2, -6.2, 7], [-6.2, -5.3, 4]]);
  chips(R, 'Green', [[6.2, -6.2, 5], [5.3, -6.25, 9], [6.25, -5.3, 2]]);
  ['cardAS', 'cardKH', 'cardQD'].forEach((t, i) => {
    R.put('box', [-6.15 + i * 0.12, -0.29 + i * 0.006, 3.2 - i * 0.4], [0.9, 0.01, 1.3], W1, { tex: R.tex(t), q: yawQ(0.4 - i * 0.35), spec: 0.4 });
  });
  R.put(R.rbox(0.9, 0.3, 1.3, 0.05), [-6.1, -0.15, -3.4], 1, W1, { tex: R.tex('cardBack'), q: yawQ(0.2) });
  // cocktail on the rail
  const coupe = R.mesh('coupe', () => latheGeo([[0, 0], [0.5, 0], [0.12, 0.1], [0.08, 1.0], [0.6, 1.5], [0.7, 1.7], [0.65, 1.7], [0, 1.25]], 32));
  R.put(coupe, [7.6, 0.3, 4.5], 1, '#d9f0f2', { spec: 1 });
  R.put('sphere', [7.6, 1.75, 4.5], [1.1, 0.25, 1.1], '#ff3d6e', { spec: 0.8 });
  R.put('sphere', [7.8, 1.9, 4.6], 0.22, '#c4001a');
  // roulette table on the left
  const rt = placer(R, -22, F, -4, 0.3);
  rt(R.rbox(10, 6, 16, 0.6, 0.2), [0, 3, 0], 1, W1, { tex: R.tex('darkWood'), spec: 0.3 });
  rt(R.rbox(9.2, 0.3, 15.2, 0.2, 0.12), [0, 6.1, 0], 1, W1, { tex: R.tex('felt') });
  rt(R.mesh('wheelbowl', () => latheGeo([[0, 0], [3.4, 0], [3.6, 0.8], [3.2, 0.9], [2.8, 0.7], [0, 0.6]], 48)), [0, 6.2, -4.2], 1, W1, { tex: R.tex('darkWood'), spec: 0.5 });
  rt('disc', [0, 6.86, -4.2], [5.7, 1, 5.7], W1, { tex: R.tex('roulette'), spec: 0.6 });
  rt('cyl', [0, 6.8, -4.2], [0.25, 1.4, 0.25], '#e2b450', { spec: 1 });
  rt('sphere', [1.9, 7.0, -4.6], 0.22, '#ffffff', { spec: 1 });
  for (let i = 0; i < 6; i++) rt('box', [-2.4 + (i % 3) * 2.4, 6.27, 2 + Math.floor(i / 3) * 3], [2.2, 0.02, 2.8], i % 2 ? '#b3182c' : '#1b1b1b', { cast: false });
  R.blob(-22, -4, 13, 19, 0.4, F + 0.03, 0.3);
  // slot machines along the back wall, and a neon sign
  for (let i = 0; i < 5; i++) slotMachine(R, -16 + i * 8, F, -half + 3.4, 0, i);
  if (show.back) {
    R.blend(true, true);
    R.put('box', [0, F + 19, -half + 0.6], [30, 5.6, 0.05], W1, { tex: R.tex('neonCasino'), lit: false, cast: false });
    R.blend(false);
  }
  // the bar on the right
  const bar = placer(R, half - 7, F, 4, -PI / 2);
  bar(R.rbox(30, 8, 4, 0.4, 0.15), [0, 4, 0], 1, W1, { tex: R.tex('darkWood'), spec: 0.4 });
  bar(R.rbox(31, 0.6, 5.2, 0.25, 0.15), [0, 8.2, 0], 1, '#1b1b1b', { spec: 1 });
  bar(R.rbox(30, 0.5, 0.5, 0.2), [0, 0.9, 2.2], 1, '#c9a046', { spec: 1 });
  const bottle = R.mesh('bottle', () => latheGeo([[0, 0], [0.6, 0], [0.62, 2.2], [0.25, 3.0], [0.22, 3.9], [0.26, 4.0], [0, 4.0]], 24));
  const bcols = ['#2e7d32', '#8d5524', '#c0392b', '#d9c58a', '#5d4037', '#1565c0', '#f9a825'];
  for (let i = 0; i < 16; i++) bar(bottle, [-13 + i * 1.7, 8.5, -0.8 + (i % 2) * 0.9], 1, bcols[i % bcols.length], { spec: 1 });
  for (let i = 0; i < 5; i++) {
    const stool = R.mesh('barstool', () => latheGeo([[0, 0], [1.6, 0], [1.6, 0.3], [0.3, 0.5], [0.25, 8.6], [1.7, 8.8], [1.8, 9.5], [0, 9.6]], 32));
    bar(stool, [-10 + i * 5, 0, 4.5], 1, '#2a2a2a', { spec: 0.7 });
    bar('cyl', [-10 + i * 5, 9.2, 4.5], [3.6, 0.6, 3.6], '#a01428', { spec: 0.3 });
  }
  if (show.right) {
    R.blend(true, true);
    R.put('box', [half - 0.6, F + 17, 4], [0.05, 5, 12], W1, { tex: R.tex('neonBar'), lit: false, cast: false, q: yawQ(-PI / 2) });
    R.blend(false);
  }
  // velvet rope at the front
  for (const x of [-12, -4, 4, 12]) {
    R.put(R.mesh('post', () => latheGeo([[0, 0], [1.3, 0], [1.3, 0.3], [0.25, 0.5], [0.2, 6], [0.5, 6.2], [0.45, 6.8], [0, 6.9]], 28)), [x, F, 18], 1, '#d4a63c', { spec: 1 });
  }
  const rope = R.mesh('rope2', () => {
    const parts = [];
    for (const x0 of [-12, -4, 4]) {
      for (let k = 0; k < 16; k++) {
        const t = k / 16, t2 = (k + 1) / 16;
        const p1 = [x0 + 8 * t, 6.1 - Math.sin(PI * t) * 1.6], p2 = [x0 + 8 * t2, 6.1 - Math.sin(PI * t2) * 1.6];
        const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
        parts.push({ geo: cylGeo(10), m: trs([p1[0], p1[1], 0], rotZ(ang - PI / 2), [0.32, len + 0.05, 0.32]) });
      }
    }
    return merge(parts);
  });
  R.put(rope, [0, F, 18], 1, '#8b0f22', { spec: 0.3 });
  // chandelier high above
  const ch = [0, 22, 0];
  R.put('cyl', [0, ch[1], 0], [0.2, 8, 0.2], '#c9a046', { spec: 1, cast: false });
  R.put('torus', ch, [9, 2, 9], '#d4a63c', { spec: 1, cast: false });
  R.put(R.mesh('crystals', () => merge(Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * PI * 2;
    return { geo: sphereGeo(8, 6), m: trs([Math.cos(a) * 4.2, -1 - (i % 3) * 0.6, Math.sin(a) * 4.2], undefined, [0.45, 0.8, 0.45]) };
  }))), ch, 1, '#fff6e0', { lit: false, emit: 0.3, cast: false });
  R.glow(c, [0, 21, 0], 18, '#ffd99a', 0.4);
}

// ---------------------------------------------------------------- winter cabin

const CABIN = { F: -7, H: 28, half: 32 };

function xmasTree(R, x, F, z) {
  R.put('cyl', [x, F, z], [1.2, 3, 1.2], W1, { tex: R.tex('bark') });
  R.put(R.mesh('treestand', () => latheGeo([[0, 0], [3, 0], [3.2, 1.6], [0, 1.6]], 32)), [x, F, z], 1, '#b3182c', { spec: 0.4 });
  const layers = R.mesh('firbranches', () => {
    const r = rng(77);
    const parts = [{ geo: coneGeo(24), m: trs([0, 2.5, 0], undefined, [9, 22, 9]), color: [0.55, 0.7, 0.55] }];
    const tiers = 9;
    for (let t = 0; t < tiers; t++) {
      const k = t / tiers;
      const y = 3 + k * 19;
      const len = 7.6 * (1 - k) + 1.2;
      const n = Math.round(16 - k * 8);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2 + t * 0.4 + r() * 0.2;
        const g = 0.8 + r() * 0.35;
        parts.push({
          geo: leafGeo({ len: len * (0.85 + r() * 0.3), width: 2.4 * (1 - k * 0.5) + 0.8, droop: len * 0.32, cup: -0.35, nl: 6, nw: 4 }),
          m: trs([0, y + 1.4, 0], qmul(yawQ(a), rotX(-0.18)), 1), color: [g, g, g],
        });
      }
    }
    return merge(parts);
  });
  R.put(layers, [x, F, z], 1, W1, { tex: R.tex('leavesDark'), spec: 0.08 });
  const balls = R.mesh('ornaments', () => {
    const r = rng(61);
    const cols = [[0.85, 0.1, 0.15], [0.95, 0.75, 0.15], [0.2, 0.45, 0.9], [0.9, 0.9, 0.95], [0.6, 0.15, 0.7]];
    return merge(Array.from({ length: 46 }, () => {
      const k = r() * 0.92;
      const y = 3 + k * 19;
      const rad = (7.6 * (1 - k) + 1.2) * (0.7 + r() * 0.2);
      const a = r() * PI * 2;
      return { geo: sphereGeo(14, 10), m: trs([Math.cos(a) * rad, y - 0.2, Math.sin(a) * rad], undefined, 0.75), color: cols[Math.floor(r() * cols.length)] };
    }));
  });
  R.put(balls, [x, F, z], 1, W1, { spec: 1 });
  const lights = R.mesh('treelights', () => {
    const r = rng(62);
    return merge(Array.from({ length: 70 }, (_, i) => {
      const t = i / 70;
      const y = 3 + t * 19.5;
      const rad = (7.6 * (1 - t) + 1.2) * 0.8;
      const a = t * PI * 12;
      return { geo: sphereGeo(8, 6), m: trs([Math.cos(a) * rad, y, Math.sin(a) * rad], undefined, 0.3), color: [[1, 0.85, 0.4], [1, 0.4, 0.4], [0.5, 0.8, 1], [0.6, 1, 0.6]][Math.floor(r() * 4)] };
    }));
  });
  R.put(lights, [x, F, z], 1, W1, { lit: false, emit: 0.5, cast: false });
  R.put(R.mesh('treestar', () => starfishGeo(5, 1.6, 0.7, 0.5)), [x, F + 25.8, z], 1, '#ffd34d', { q: rotX(PI / 2), lit: false, emit: 0.4 });
  // presents
  for (const [dx, dz, w, h, d, t, rib] of [[-3.5, 6, 3.6, 2.6, 3, 'giftRed', '#f2d36b'], [3, 6.5, 2.8, 3.4, 2.8, 'giftGreen', '#d9283a'], [6, 2, 4.2, 2.2, 3.4, 'giftBlue', '#f6f3ec'], [0, 7.8, 2.2, 1.8, 2.2, 'giftRed', '#ffffff']]) {
    const px = x + dx, pz = z + dz;
    R.put(R.rbox(w, h, d, 0.12), [px, F + h / 2, pz], 1, W1, { tex: R.tex(t), spec: 0.3, q: yawQ(dx * 0.1) });
    R.put('box', [px, F + h / 2, pz], [w + 0.05, h + 0.05, 0.4], rib, { q: yawQ(dx * 0.1), spec: 0.5 });
    R.put('box', [px, F + h / 2, pz], [0.4, h + 0.05, d + 0.05], rib, { q: yawQ(dx * 0.1), spec: 0.5 });
    R.put('torus', [px, F + h + 0.2, pz], [1.2, 1.2, 0.8], rib, { q: rotX(PI / 2) });
  }
  R.blob(x, z, 18, 18, 0.5, F + 0.04);
}

function fireplace(R, c, x, F, z) {
  const st = { tex: R.tex('stone'), spec: 0.08 };
  // stone surround with an opening in the middle
  for (const sx of [-1, 1]) R.put(R.rbox(4.6, 14, 5, 0.3, 0.12), [x + sx * 6.7, F + 7, z], 1, W1, st);
  R.put(R.rbox(18, 5.4, 5, 0.3, 0.12), [x, F + 11.3, z], 1, W1, st);
  R.put(R.rbox(11, 20, 3.6, 0.3, 0.12), [x, F + 24, z - 0.6], 1, W1, { ...st, cast: false });
  R.put('box', [x, F + 4.3, z - 1.9], [9, 8.6, 0.6], '#1f1612', { cast: false });
  for (const sx of [-1, 1]) R.put('box', [x + sx * 4.4, F + 4.3, z], [0.4, 8.6, 4], '#2a1d16', { cast: false });
  R.put('box', [x, F + 8.5, z], [9, 0.4, 4], '#2a1d16', { cast: false });
  R.put(R.rbox(21, 1.2, 6.4, 0.3, 0.2), [x, F + 14.4, z + 0.6], 1, W1, { tex: R.tex('darkWood'), spec: 0.4 });
  R.put(R.rbox(20, 1.0, 8, 0.3, 0.12), [x, F + 0.5, z + 2.4], 1, W1, st);
  // logs and fire
  for (const [dx, dz, a] of [[-1.2, 0.2, 0.25], [1.2, 0.4, -0.25], [0, -0.4, 0]]) R.put('cyl', [x + dx - 2.6 * Math.cos(a), F + 1.6 + (dz < 0 ? 0.9 : 0), z + dz + 2.6 * Math.sin(a)], [1.2, 5.2, 1.2], W1, { tex: R.tex('bark'), q: qmul(yawQ(a), rotZ(-PI / 2)), cast: false });
  R.put('sphere', [x, F + 1.2, z], [7, 0.8, 2.6], '#ff6a1a', { lit: false, emit: 0.4, cast: false });
  R.blend(true, true);
  const t = R.time;
  const flick = (k) => 1 + 0.07 * Math.sin(t * 9 + k) + 0.05 * Math.sin(t * 23 + k * 2);
  for (const [a, dx, s2] of [[0, 0, 1], [0.6, -1.4, 0.75], [-0.6, 1.5, 0.8], [PI / 2, 0, 0.9]]) {
    R.put('box', [x + dx, F + 1.4 + 3.1 * s2 * flick(a), z + 0.6], [5.4 * s2, 6.2 * s2 * flick(a + 1), 0.02], [1, 1, 1, 0.95], { tex: R.tex('fire'), lit: false, cast: false, q: yawQ(a) });
  }
  R.blend(false);
  R.glow(c, [x, F + 4, z + 2.4], 14 * flick(3), '#ff8a3a', 0.6);
  R.glow(c, [x, F + 1.2, z + 9], 22, '#ff7a2a', 0.25);
  // stockings and candles on the mantel
  for (const dx of [-6, 0, 6]) {
    R.put(R.rbox(1.6, 3.4, 0.6, 0.4), [x + dx, F + 11.6, z + 3.6], 1, '#c8283a', { cast: false });
    R.put(R.rbox(2.3, 1.6, 0.4, 0.5), [x + dx + 0.5, F + 10, z + 3.6], 1, '#c8283a', { cast: false });
    R.put(R.rbox(2, 0.8, 0.8, 0.35), [x + dx, F + 13.4, z + 3.6], 1, '#f6f3ec', { cast: false });
  }
  for (const dx of [-8, -6.8, 7.5]) {
    R.put('cyl', [x + dx, F + 15, z + 1.4], [0.7, 2 + (dx % 2), 0.7], '#f4ecd8', { spec: 0.3 });
    R.put('sphere', [x + dx, F + 15.6 + 2 + (dx % 2), z + 1.4], [0.3, 0.6, 0.3], '#ffb84d', { lit: false, emit: 0.6, cast: false });
    R.glow(c, [x + dx, F + 15.6 + 2 + (dx % 2), z + 1.4], 2.6, '#ffb84d', 0.55);
  }
  // a stack of firewood
  const wood = R.mesh('woodpile', () => merge([0, 1, 2, 3, 4, 5].map((i) => ({ geo: cylGeo(16), m: trs([(i % 3) * 1.25 - 1.25 + (i >= 3 ? 0.6 : 0), 0.6 + (i >= 3 ? 1.05 : 0), 0], rotX(PI / 2), [1.2, 5, 1.2]) }))));
  R.put(wood, [x + 13, F, z + 0.6], 1, W1, { tex: R.tex('bark') });
}

function cabin(R, c) {
  const { F, H, half } = CABIN;
  const show = room(R, c, { half, F, H, wallTex: 'logs', uv: 1 / 16, floorTex: 'cabinFloor', floorTile: 18, trim: '#6b4423' });
  // fur rug and the table
  R.put(R.mesh('furRug', () => latheGeo([[0, 0], [0.5, 0], [0.5, 0.01]], 64)), [0, F + 0.05, 2], [30, 1, 22], W1, { tex: R.tex('fur'), cast: false });
  R.put('disc', [0, F + 0.06, 2], [30, 1, 22], W1, { tex: R.tex('fur'), cast: false });
  R.blob(0, 0, 21, 21, 0.55, F + 0.08);
  table(R, F, { top: 'tableWood', leg: 'darkWood', legStyle: 'block', shelf: false, tint: [0.92, 0.86, 0.8] });
  mug(R, 6.2, 6.2, { color: '#b3182c', drink: '#6b3a1c', marsh: true });
  R.put('disc', [-6.2, -0.28, 6.2], [2.2, 1, 2.2], '#f6f3ec', { spec: 0.5 });
  for (const [dx, dz] of [[-0.3, 0.2], [0.35, -0.2], [0.1, 0.5]]) R.put('cyl', [-6.2 + dx, -0.27, 6.2 + dz], [0.75, 0.12, 0.75], '#c48a4a');
  R.put('cyl', [-6.2, -0.3, -6.2], [0.9, 1.6, 0.9], '#f4ecd8', { spec: 0.3 });
  R.put('sphere', [-6.2, 1.55, -6.2], [0.3, 0.6, 0.3], '#ffb84d', { lit: false, emit: 0.6, cast: false });
  R.glow(c, [-6.2, 1.6, -6.2], 3, '#ffb84d', 0.6);
  if (show.back) fireplace(R, c, 0, F, -half + 2.6);
  xmasTree(R, -21, F, -18);
  armchair(R, 21, F, -14, -PI / 4, '#7a3b2e');
  if (show.left) {
    const wx = -half + 0.05, wz = 6, wy = F + 15;
    R.put('box', [wx, wy, wz], [0.1, 12, 16], W1, { tex: R.tex('windowNight'), lit: false, cast: false });
    const fr = '#5a3a1c';
    R.put(R.rbox(1, 13, 1, 0.2), [wx + 0.4, wy, wz - 8.2], 1, fr);
    R.put(R.rbox(1, 13, 1, 0.2), [wx + 0.4, wy, wz + 8.2], 1, fr);
    R.put(R.rbox(1, 1, 17.4, 0.2), [wx + 0.4, wy + 6.4, wz], 1, fr);
    R.put(R.rbox(2.6, 0.8, 18, 0.25), [wx + 1, wy - 6.4, wz], 1, fr);
    R.put(R.rbox(2.2, 0.5, 17, 0.25), [wx + 1, wy - 5.8, wz], 1, '#f8fbff');
    R.put(R.rbox(0.5, 12, 0.5, 0.1), [wx + 0.4, wy, wz], 1, fr);
    R.put(R.rbox(0.5, 0.5, 16, 0.1), [wx + 0.4, wy, wz], 1, fr);
  }
  if (show.right) {
    // crossed skis on the wall
    for (const s of [-1, 1]) R.put(R.rbox(0.25, 18, 1.2, 0.12), [half - 0.6, F + 15, -2], 1, '#c8283a', { q: rotX(s * 0.3), spec: 0.6, cast: false });
    // antlers... no: a wreath
    R.put('torus', [half - 0.8, F + 16, 14], [6, 6, 6], '#2f6b3a', { q: rotZ(PI / 2), tex: R.tex('leavesDark') });
    R.put('sphere', [half - 1.2, F + 13.6, 14], [0.9, 0.9, 1.2], '#c8283a');
  }
  plant(R, 26, F, 18, { s: 0.8, pot: '#7a5a3a', seed: 8, leaf: 'snake' });
  cat(R, -10, F + 0.08, 11, 0.7, '#3a3a3a');
}

// ---------------------------------------------------------------- space

function space(R, c) {
  skyDome(R, 'starfield');
  const stars = R.mesh('stars', () => {
    const r = rng(83);
    const parts = [];
    const geo = sphereGeo(6, 4);
    for (let i = 0; i < 2200; i++) {
      const u = r() * 2 - 1, a = r() * PI * 2;
      const d = 150 + r() * 10;
      const sq = Math.sqrt(1 - u * u);
      const b = 0.45 + r() ** 3 * 0.55;
      const tint = r();
      parts.push({ geo, m: trs([Math.cos(a) * sq * d, u * d, Math.sin(a) * sq * d], undefined, 0.3 + r() ** 4 * 0.8), color: [b * (tint < 0.2 ? 1 : 0.9), b * 0.95, b * (tint > 0.8 ? 1 : 0.92)] });
    }
    return merge(parts);
  });
  R.withoutFog(() => R.put(stars, [0, 0, 0], 1, W1, { lit: false, cast: false }));
  // the platform: a hexagonal metal table with glowing edges
  const plat = R.mesh('platform', () => latheGeo([[0, -4.5], [2, -4.5], [3.2, -3.4], [7.4, -1.3], [9.8, -0.9], [10.1, -0.6], [10.1, -0.05], [9.8, 0], [0, 0]], 6));
  R.put(plat, [0, -0.32, 0], 1, W1, { tex: R.tex('metal'), q: yawQ(PI / 6), spec: 0.8 });
  R.put(R.mesh('hextop', () => discGeo(6)), [0, -0.31, 0], [19.6, 1, 19.6], W1, { tex: R.tex('metal'), q: yawQ(PI / 6), spec: 0.6, cast: false });
  R.put(R.mesh('platring', () => latheGeo(Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * PI * 2; return [10.15 + 0.12 * Math.cos(a), 0.12 * Math.sin(a)]; }), 6)), [0, -0.55, 0], 1, '#53e0ff', { q: yawQ(PI / 6), lit: false, emit: 0.6, cast: false });
  R.put(R.mesh('platring2', () => latheGeo(Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * PI * 2; return [3.3 + 0.1 * Math.cos(a), 0.1 * Math.sin(a)]; }), 6)), [0, -3.75, 0], 1, '#53e0ff', { q: yawQ(PI / 6), lit: false, emit: 0.6, cast: false });
  R.put('cone', [0, -8.5, 0], [3.2, 4, 3.2], '#7fe8ff', { lit: false, emit: 0.2, cast: false, q: rotX(PI) });
  R.glow(c, [0, -6.5, 0], 14, '#53e0ff', 0.55);
  // planets
  R.withoutFog(() => {
    R.put('sphere', [-95, 25, -120], 80, W1, { tex: R.tex('gasGiant'), q: rotZ(0.25), cast: false, spec: 0.05 });
    R.blend(true);
    R.put(R.mesh('ring', () => ringGeo(48, 80, 96)), [-95, 25, -120], 1, W1, { tex: R.tex('planetRing'), q: qmul(rotZ(0.25), rotX(0.32)), cast: false, lit: false });
    R.blend(false);
    R.put('sphere', [110, -15, -85], 44, W1, { tex: R.tex('earth'), q: rotZ(-0.4), cast: false, spec: 0.3 });
    R.blend(true, true);
    R.put('sphere', [110, -15, -85], 47, [0.4, 0.7, 1, 0.25], { lit: false, cast: false });
    R.blend(false);
    R.put('sphere', [40, 50, -150], 16, W1, { tex: R.tex('moon'), cast: false });
    R.glow(c, [140, 90, -60], 60, '#fff6dc', 0.9);
  });
  // asteroids drifting around
  const rocks = R.mesh('asteroids', () => {
    const r = rng(71);
    const parts = [];
    for (let i = 0; i < 16; i++) {
      const a = r() * PI * 2, d = 18 + r() * 30;
      const s = 0.8 + r() ** 2 * 4.5;
      parts.push({ geo: rockGeo(100 + i, 0.4, 22, 14), m: trs([Math.cos(a) * d, -6 + r() * 18, Math.sin(a) * d - 6], quat.axis([r(), r(), r()], r() * 6), s), color: [0.55 + r() * 0.15, 0.5 + r() * 0.1, 0.48] });
    }
    return merge(parts);
  });
  R.put(rocks, [0, 0, 0], 1, W1, { spec: 0.15, q: yawQ(R.time * 0.01) });
  // a satellite
  const sat = placer(R, 26, 9, -28, 0.6);
  sat('cyl', [0, -2, 0], [3, 4, 3], '#d9dde3', { tex: R.tex('metal'), spec: 0.8 });
  sat('half', [0, 2, 0], [3, 1.4, 3], '#d9dde3', { spec: 0.9 });
  for (const s of [-1, 1]) {
    sat('cyl', [s * 2.5, 0, 0], [0.25, 3, 0.25], '#9aa0a8', { q: rotZ(PI / 2) });
    sat(R.rbox(8, 0.15, 3.6, 0.05), [s * 7.6, 0, 0], 1, W1, { tex: R.tex('solar'), spec: 0.9 });
  }
  sat(R.mesh('dish', () => latheGeo([[0, 0], [1.6, 0.5], [2.4, 1.3], [2.3, 1.35], [1.5, 0.6], [0, 0.1]], 32)), [0, -2.4, 0], 1, '#f2f2f2', { q: rotX(PI), spec: 0.6 });
  sat('sphere', [0, 2.6, 1.4], 0.35, '#ff4040', { lit: false, emit: 0.8 });
  // a little rocket
  const rk = placer(R, -27, 9, -24, 0.3);
  const rq = rotZ(0.5);
  const body = R.mesh('rocketbody', () => latheGeo([[0, 0], [1.2, 0], [1.4, 1.5], [1.4, 4.5], [1.1, 6.2], [0.5, 7.4], [0, 7.8]], 32));
  rk(body, [0, 0, 0], 1, '#f4f4f6', { q: rq, spec: 0.8 });
  rk('sphere', [-1.15, 4.1, 0.0], [0.4, 0.9, 0.9], '#5ec8ff', { q: rq, lit: false, emit: 0.2 });
  for (let i = 0; i < 3; i++) rk(R.rbox(0.25, 2.2, 1.6, 0.1), [0, 0.8, 0], 1, '#e0453a', { q: qmul(rq, yawQ((i / 3) * PI * 2), quat.axis([0, 0, 1], 0)), spec: 0.5 });
  R.blend(true, true);
  rk('cone', [0.55, -1.0, 0], [1.6, 3.2, 1.6], [1, 0.6, 0.2, 0.8], { q: qmul(rq, rotX(PI)), lit: false, cast: false });
  R.blend(false);
  R.glow(c, [-27 + 0.9, 7.8, -24], 6, '#ffa040', 0.6);
}

// ---------------------------------------------------------------- registry

export const SCENES = {
  livingroom: {
    draw: livingRoom,
    light: {
      dir: [-0.6, 1, 0.3], sky: [0.5, 0.48, 0.45], ground: [0.33, 0.28, 0.25], sun: [0.6, 0.57, 0.5],
      point: { pos: [28, LIVING.F + 15, -26], col: [0.6, 0.45, 0.26], range: 38 },
    },
    shadow: { center: [0, LIVING.F / 2, -4], radius: 36 },
  },
  beach: {
    draw: beach,
    light: {
      dir: [0.38, 1, -0.42], sky: [0.56, 0.6, 0.68], ground: [0.6, 0.55, 0.45], sun: [0.54, 0.51, 0.45],
      fog: { col: [0.8, 0.9, 0.96], near: 50, far: 175 },
    },
    shadow: { center: [0, 0, -3], radius: 28 },
  },
  garden: {
    draw: picnicGarden,
    light: {
      dir: [0.5, 1, 0.25], sky: [0.56, 0.6, 0.66], ground: [0.42, 0.5, 0.33], sun: [0.55, 0.53, 0.46],
      fog: { col: [0.8, 0.88, 0.95], near: 60, far: 200 },
    },
    shadow: { center: [0, 0, -6], radius: 34 },
  },
  casino: {
    draw: casino,
    light: {
      dir: [0.15, 1, 0.25], sky: [0.42, 0.36, 0.4], ground: [0.26, 0.16, 0.18], sun: [0.55, 0.5, 0.42],
      point: { pos: [0, 15, 2], col: [0.5, 0.42, 0.3], range: 42 },
    },
    shadow: { center: [0, CASINO.F / 2, -4], radius: 36 },
  },
  cabin: {
    draw: cabin,
    animate: true, // the fire flickers
    light: {
      dir: [0.25, 1, 0.35], sky: [0.4, 0.4, 0.48], ground: [0.3, 0.24, 0.2], sun: [0.6, 0.52, 0.4],
      point: { pos: [0, CABIN.F + 5, -CABIN.half + 8], col: [0.9, 0.5, 0.22], range: 40 },
    },
    shadow: { center: [0, CABIN.F / 2, -6], radius: 34 },
  },
  space: {
    draw: space,
    animate: true, // asteroids drift
    light: {
      dir: [0.55, 0.85, 0.3], sky: [0.38, 0.39, 0.47], ground: [0.16, 0.14, 0.22], sun: [0.8, 0.78, 0.74],
    },
    shadow: { center: [0, -2, -4], radius: 30 },
  },
};
