// Mesh data for the 3D board and its scenery: { pos, nor, uv, idx, col? } arrays.
// Everything is generated with code: boxes (sharp or rounded), surfaces of
// revolution, leaves, curtains, rocks... `merge` bakes many parts into one mesh so
// a whole flower bed or a stack of chips is a single draw call.

import { v3, lerp, xformPoint, xformNormal, rng } from './math3d.js';

export function boxGeo(w, h, d, uvRects) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0] },
  ];
  const ext = (a) => Math.abs(a[0]) * hx + Math.abs(a[1]) * hy + Math.abs(a[2]) * hz;
  const pos = [], nor = [], uv = [], idx = [];
  faces.forEach((f, fi) => {
    const c = v3.scale(f.n, ext(f.n));
    const hu = ext(f.u), hv = ext(f.v);
    const [u0, v0, u1, v1] = uvRects?.[fi] ?? [0, 0, 1, 1];
    const base = pos.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = v3.add(c, v3.add(v3.scale(f.u, s * hu), v3.scale(f.v, t * hv)));
      pos.push(...p);
      nor.push(...f.n);
      uv.push(lerp(u0, u1, (s + 1) / 2), lerp(v0, v1, (t + 1) / 2));
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { pos, nor, uv, idx };
}

/**
 * Box with rounded edges and corners (radius r), w x h x d, centred on the origin.
 * uvScale: null maps each face 0..1; a number tiles the texture that many times per unit.
 */
export function rboxGeo(w, h, d, r, seg = 4, uvScale = null) {
  const half = [w / 2, h / 2, d / 2];
  r = Math.max(0, Math.min(r, ...half.map((x) => x * 0.999)));
  if (r === 0) return boxGeo(w, h, d);
  const samples = (hh) => {
    const out = [];
    for (let k = 0; k <= seg; k++) out.push(-hh + r * (1 - Math.cos((k / seg) * Math.PI / 2)) * 1);
    for (let k = seg; k >= 0; k--) out.push(hh - r * (1 - Math.cos((k / seg) * Math.PI / 2)));
    return out;
  };
  const pos = [], nor = [], uv = [], idx = [];
  // axis triples: [normal axis, u axis, v axis]
  const faces = [[0, 2, 1, 1], [0, 2, 1, -1], [1, 0, 2, 1], [1, 0, 2, -1], [2, 0, 1, 1], [2, 0, 1, -1]];
  for (const [na, ua, va, sign] of faces) {
    const us = samples(half[ua]), vs = samples(half[va]);
    const base = pos.length / 3;
    for (let j = 0; j < vs.length; j++) {
      for (let i = 0; i < us.length; i++) {
        const p = [0, 0, 0];
        p[na] = sign * half[na]; p[ua] = us[i]; p[va] = vs[j];
        const inner = p.map((x, a) => Math.max(-(half[a] - r), Math.min(half[a] - r, x)));
        const n = v3.norm(v3.sub(p, inner));
        const q = v3.add(inner, v3.scale(n, r));
        pos.push(...q);
        nor.push(...n);
        if (uvScale) uv.push(q[ua] * uvScale, q[va] * uvScale);
        else uv.push(0.5 + us[i] / (2 * half[ua]), 0.5 - vs[j] / (2 * half[va]));
      }
    }
    const nu = us.length;
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < nu - 1; i++) {
        const a = base + j * nu + i, b = a + 1, c = a + nu, e = c + 1;
        // keep the winding consistent with the face direction (no culling, but tidy)
        if (sign > 0) idx.push(a, b, e, a, e, c); else idx.push(a, e, b, a, c, e);
      }
    }
  }
  return { pos, nor, uv, idx };
}

/** Surface of revolution from a [radius, height] profile (bottom to top). */
export function latheGeo(profile, seg = 32, uRepeat = 1, a0 = 0, a1 = Math.PI * 2) {
  const pos = [], nor = [], uv = [], idx = [];
  const n = profile.length;
  const pn = profile.map((p, k) => {
    const a = profile[Math.max(k - 1, 0)], b = profile[Math.min(k + 1, n - 1)];
    const t = [b[0] - a[0], b[1] - a[1]];
    const l = Math.hypot(t[0], t[1]) || 1;
    return [t[1] / l, -t[0] / l];
  });
  // v follows the length along the profile so textures don't stretch
  const lens = [0];
  for (let k = 1; k < n; k++) lens.push(lens[k - 1] + Math.hypot(profile[k][0] - profile[k - 1][0], profile[k][1] - profile[k - 1][1]));
  const total = lens[n - 1] || 1;
  for (let i = 0; i <= seg; i++) {
    const ang = a0 + (i / seg) * (a1 - a0);
    const c = Math.cos(ang), s = Math.sin(ang);
    profile.forEach(([r, y], k) => {
      pos.push(r * c, y, r * s);
      nor.push(pn[k][0] * c, pn[k][1], pn[k][0] * s);
      uv.push((i / seg) * uRepeat, lens[k] / total);
    });
  }
  for (let i = 0; i < seg; i++) {
    for (let k = 0; k < n - 1; k++) {
      const a = i * n + k, b = (i + 1) * n + k;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { pos, nor, uv, idx };
}

export const sphereProfile = (rings = 20) => Array.from({ length: rings + 1 }, (_, i) => {
  const a = -Math.PI / 2 + (i / rings) * Math.PI;
  return [Math.max(0, 0.5 * Math.cos(a)), 0.5 * Math.sin(a)];
});
export const sphereGeo = (seg = 36, rings = 20) => latheGeo(sphereProfile(rings), seg);
/** Cylinder of radius 0.5 from y = 0 to 1, with caps. */
export const cylGeo = (seg = 32) => latheGeo([[0, 0], [0.5, 0], [0.5, 0], [0.5, 1], [0.5, 1], [0, 1]], seg);
export const coneGeo = (seg = 32) => latheGeo([[0, 0], [0.5, 0], [0.5, 0], [0, 1]], seg);
export const torusGeo = (r = 0.35, t = 0.15, seg = 40, rings = 16) => latheGeo(Array.from({ length: rings + 1 }, (_, i) => {
  const a = (i / rings) * Math.PI * 2;
  return [r + t * Math.cos(a), t * Math.sin(a)];
}), seg);

/** Unit triangular prism: base 1 x 1 at y = 0, ridge along x at y = 1 (a roof). */
export function roofGeo() {
  const k = Math.hypot(0.5, 1);
  const fn = [0, 0.5 / k, 1 / k], bn = [0, 0.5 / k, -1 / k];
  const pos = [
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
  ];
  const nor = [...fn, ...fn, ...fn, ...fn, ...bn, ...bn, ...bn, ...bn, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0];
  const uv = new Array((pos.length / 3) * 2).fill(0);
  return { pos, nor, uv, idx: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 11, 12, 13] };
}

/** Unit square in the xz plane facing up, uv 0..1 (times `repeat`). */
export function planeGeo(repeatU = 1, repeatV = repeatU) {
  return {
    pos: [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5],
    nor: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    uv: [0, 0, repeatU, 0, repeatU, repeatV, 0, repeatV],
    idx: [0, 1, 2, 0, 2, 3],
  };
}

/** A grid in the xy plane (facing +z), w x h, with z = fn(x, y): curtains, flags, banners. */
export function sheetGeo(w, h, nx, ny, fn = () => 0) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = (i / nx - 0.5) * w, y = (j / ny) * h;
      pos.push(x, y, fn(x, y));
      uv.push(i / nx, 1 - j / ny);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = { pos, nor: [], uv, idx };
  computeNormals(g);
  return g;
}

/** Curtain: hangs from y = h down to 0, with `folds` soft pleats. */
export const curtainGeo = (w, h, folds, depth) => sheetGeo(w, h, folds * 8, 6,
  (x, y) => depth * Math.sin((x / w) * folds * Math.PI * 2) * (0.75 + 0.25 * (1 - y / h)));

/**
 * A leaf / frond / blade: a strip from z = 0 to len, `width` wide (pointed ends),
 * drooping by `droop` at the tip and cupped by `cup` across.
 */
export function leafGeo({ len = 1, width = 0.3, droop = 0.3, cup = 0.05, nl = 10, nw = 4, shape = 'leaf' } = {}) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nl; j++) {
    const t = j / nl;
    const wf = shape === 'strip' ? 1 : shape === 'blade' ? (1 - t) ** 0.8 : Math.sin(Math.PI * Math.min(1, t * 1.05)) ** 0.7;
    for (let i = 0; i <= nw; i++) {
      const s = i / nw - 0.5;
      const x = s * width * Math.max(wf, 0.02);
      const y = -droop * t * t + cup * (s * 2) ** 2;
      pos.push(x, y, t * len);
      uv.push(i / nw, t);
    }
  }
  for (let j = 0; j < nl; j++) {
    for (let i = 0; i < nw; i++) {
      const a = j * (nw + 1) + i, b = a + 1, c = a + nw + 1, d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = { pos, nor: [], uv, idx };
  computeNormals(g);
  return g;
}

/** Flat ring in the xz plane (inner..outer radius); u around, v from inner to outer. */
export function ringGeo(inner, outer, seg = 64) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.push(inner * c, 0, inner * s, outer * c, 0, outer * s);
    nor.push(0, 1, 0, 0, 1, 0);
    uv.push(i / seg, 0, i / seg, 1);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return { pos, nor, uv, idx };
}

/** Disc in the xz plane, radius 0.5, uv mapped like a square texture. */
export function discGeo(seg = 48) {
  const pos = [0, 0, 0], nor = [0, 1, 0], uv = [0.5, 0.5], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(0.5 * Math.cos(a), 0, 0.5 * Math.sin(a));
    nor.push(0, 1, 0);
    uv.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
    if (i) idx.push(0, i + 1, i);
  }
  return { pos, nor, uv, idx };
}

/** A lumpy rock: a sphere pushed in and out by smooth noise (unit size). */
export function rockGeo(seed = 1, amount = 0.28, seg = 28, rings = 18) {
  const g = latheGeo(sphereProfile(rings), seg);
  const r = rng(seed);
  const waves = Array.from({ length: 7 }, () => ({
    k: v3.scale(v3.norm([r() - 0.5, r() - 0.5, r() - 0.5]), 2 + r() * 5),
    ph: r() * 6.28, a: (0.4 + r()) / 7,
  }));
  for (let i = 0; i < g.pos.length; i += 3) {
    const p = [g.pos[i], g.pos[i + 1], g.pos[i + 2]];
    let n = 0;
    for (const w of waves) n += w.a * Math.sin(v3.dot(w.k, p) + w.ph);
    const f = 1 + amount * n;
    g.pos[i] *= f; g.pos[i + 1] *= f * 0.85; g.pos[i + 2] *= f;
  }
  computeNormals(g);
  return g;
}

/** A starfish: a puffy five-armed star in the xz plane. */
export function starfishGeo(arms = 5, R = 0.5, r = 0.2, thick = 0.12, seg = 80, rings = 6) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const rr = r + (R - r) * ((0.5 + 0.5 * Math.cos(arms * a)) ** 1.6);
    for (let k = 0; k <= rings; k++) {
      const t = k / rings;
      pos.push(Math.cos(a) * rr * t, thick * (1 - t * t) * (0.6 + 0.4 * rr / R), Math.sin(a) * rr * t);
      uv.push(0.5 + 0.5 * Math.cos(a) * t, 0.5 + 0.5 * Math.sin(a) * t);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let k = 0; k < rings; k++) {
      const a = i * (rings + 1) + k, b = (i + 1) * (rings + 1) + k;
      idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }
  const g = { pos, nor: [], uv, idx };
  computeNormals(g);
  return g;
}

/**
 * Parametric surface: fn(u, v) -> [x, y, z] with u, v in 0..1 over nu x nv cells.
 * Normals point outwards for surfaces of revolution written as [sin(a) r, y, cos(a) r]
 * with u around and v upwards.
 */
export function paramGeo(nu, nv, fn) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      pos.push(...fn(i / nu, j / nv));
      uv.push(i / nu, j / nv);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = { pos, nor: [], uv, idx };
  computeNormals(g);
  return g;
}

/**
 * A tube swept along a path of points. radius: a number or (t in 0..1) => number.
 * Ends are closed with flat caps unless the radius reaches 0 there.
 */
export function tubeGeo(path, radius, seg = 14) {
  const rad = typeof radius === 'function' ? radius : () => radius;
  const n = path.length;
  const pos = [], uv = [], idx = [];
  let N = null;
  const rings = [];
  for (let k = 0; k < n; k++) {
    const a = path[Math.max(0, k - 1)], b = path[Math.min(n - 1, k + 1)];
    const T = v3.norm(v3.sub(b, a));
    if (!N) {
      const ref = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      N = v3.norm(v3.cross(T, ref));
    } else {
      N = v3.norm(v3.sub(N, v3.scale(T, v3.dot(N, T))));
    }
    const B = v3.cross(T, N);
    rings.push({ p: path[k], N, B, r: rad(k / (n - 1)) });
  }
  for (let k = 0; k < n; k++) {
    const { p, N: nn, B, r } = rings[k];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const d = v3.add(v3.scale(nn, Math.cos(a)), v3.scale(B, Math.sin(a)));
      pos.push(...v3.add(p, v3.scale(d, r)));
      uv.push(i / seg, k / (n - 1));
    }
  }
  for (let k = 0; k < n - 1; k++) {
    for (let i = 0; i < seg; i++) {
      const a = k * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  for (const [k, dir] of [[0, -1], [n - 1, 1]]) {
    if (rings[k].r < 1e-4) continue;
    const center = pos.length / 3;
    pos.push(...rings[k].p); uv.push(0.5, k ? 1 : 0);
    for (let i = 0; i < seg; i++) {
      const a = k * (seg + 1) + i;
      if (dir < 0) idx.push(center, a + 1, a); else idx.push(center, a, a + 1);
    }
  }
  const g = { pos, nor: [], uv, idx };
  computeNormals(g);
  return g;
}

/** Points along a smooth curve through the given control points (Catmull-Rom). */
export function curve(points, steps = 8) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Smooth normals from the triangles; vertices at the same spot share a normal (no seams). */
export function computeNormals(g) {
  const n = g.pos.length / 3;
  const acc = new Float32Array(n * 3);
  for (let t = 0; t < g.idx.length; t += 3) {
    const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]];
    const pa = [g.pos[a * 3], g.pos[a * 3 + 1], g.pos[a * 3 + 2]];
    const pb = [g.pos[b * 3], g.pos[b * 3 + 1], g.pos[b * 3 + 2]];
    const pc = [g.pos[c * 3], g.pos[c * 3 + 1], g.pos[c * 3 + 2]];
    const fn = v3.cross(v3.sub(pb, pa), v3.sub(pc, pa));
    for (const v of [a, b, c]) { acc[v * 3] += fn[0]; acc[v * 3 + 1] += fn[1]; acc[v * 3 + 2] += fn[2]; }
  }
  // weld normals of vertices that sit at the same position
  const r = (x) => Math.round(x * 1e4) || 0; // (|| 0 turns -0 into 0 so seams weld)
  const key = (i) => `${r(g.pos[i * 3])},${r(g.pos[i * 3 + 1])},${r(g.pos[i * 3 + 2])}`;
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const k = key(i);
    const s = groups.get(k);
    if (s) { s[0] += acc[i * 3]; s[1] += acc[i * 3 + 1]; s[2] += acc[i * 3 + 2]; } else groups.set(k, [acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]]);
  }
  g.nor = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = v3.norm(groups.get(key(i)));
    g.nor[i * 3] = s[0]; g.nor[i * 3 + 1] = s[1]; g.nor[i * 3 + 2] = s[2];
  }
  return g;
}

/**
 * Bake many parts into one mesh. parts: [{ geo, m (4x4 model), color?: [r,g,b], uv?: [du, dv, su, sv] }].
 * The result has per-vertex colours, so one draw call can show many coloured things.
 */
export function merge(parts) {
  const pos = [], nor = [], uv = [], idx = [], col = [];
  for (const { geo, m, color = [1, 1, 1], uv: uvx } of parts) {
    const base = pos.length / 3;
    for (let i = 0; i < geo.pos.length; i += 3) {
      const p = m ? xformPoint(m, [geo.pos[i], geo.pos[i + 1], geo.pos[i + 2]]) : [geo.pos[i], geo.pos[i + 1], geo.pos[i + 2]];
      const nn = m ? xformNormal(m, [geo.nor[i], geo.nor[i + 1], geo.nor[i + 2]]) : [geo.nor[i], geo.nor[i + 1], geo.nor[i + 2]];
      pos.push(...p); nor.push(...nn);
      const c = typeof color === 'function' ? color(p) : color;
      col.push(c[0], c[1], c[2]);
    }
    for (let i = 0; i < geo.uv.length; i += 2) {
      if (uvx) uv.push(uvx[0] + geo.uv[i] * uvx[2], uvx[1] + geo.uv[i + 1] * uvx[3]);
      else uv.push(geo.uv[i], geo.uv[i + 1]);
    }
    for (const k of geo.idx) idx.push(k + base);
  }
  return { pos, nor, uv, idx, col };
}
