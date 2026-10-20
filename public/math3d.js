// Small 3D math helpers shared by the board renderer and the scenery.
// Matrices are column-major arrays of 16 numbers (the WebGL layout).

export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

export const quat = {
  id: () => [0, 0, 0, 1],
  axis(ax, ang) {
    const [x, y, z] = v3.norm(ax);
    const s = Math.sin(ang / 2);
    return [x * s, y * s, z * s, Math.cos(ang / 2)];
  },
  mul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  },
  /** Rotation from Euler angles (radians), applied as yaw (y), then pitch (x), then roll (z). */
  euler(x = 0, y = 0, z = 0) {
    return quat.mul(quat.mul(quat.axis([0, 1, 0], y), quat.axis([1, 0, 0], x)), quat.axis([0, 0, 1], z));
  },
};

/** Column-major model matrix from translation, rotation quaternion and scale. */
export function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const sc = typeof s === 'number' ? [s, s, s] : s;
  return [
    (1 - 2 * (y * y + z * z)) * sc[0], 2 * (x * y + z * w) * sc[0], 2 * (x * z - y * w) * sc[0], 0,
    2 * (x * y - z * w) * sc[1], (1 - 2 * (x * x + z * z)) * sc[1], 2 * (y * z + x * w) * sc[1], 0,
    2 * (x * z + y * w) * sc[2], 2 * (y * z - x * w) * sc[2], (1 - 2 * (x * x + y * y)) * sc[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

export function ortho(l, r, b, t, n, f) {
  return [
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ];
}

export function lookAt(eye, target, up = [0, 1, 0]) {
  const z = v3.norm(v3.sub(eye, target));
  let x = v3.cross(up, z);
  if (Math.hypot(...x) < 1e-6) x = v3.cross([0, 0, 1], z);
  x = v3.norm(x);
  const y = v3.cross(z, x);
  return {
    m: [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1],
    x, y, z,
  };
}

/** Apply a 4x4 matrix to a point. */
export function xformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Apply a 4x4 matrix to a normal (good enough for rotations and gentle non-uniform scales). */
export function xformNormal(m, n) {
  // inverse-transpose of the 3x3 part, without the determinant (we normalise afterwards)
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  return v3.norm([A * n[0] + D * n[1] + G * n[2], B * n[0] + E * n[1] + H * n[2], C * n[0] + F * n[1] + I * n[2]]);
}

/** Normal matrix (column-major mat3) for a model matrix: the cofactors of its 3x3 part. */
export function normalMat(m) {
  const a00 = m[0], a10 = m[1], a20 = m[2], a01 = m[4], a11 = m[5], a21 = m[6], a02 = m[8], a12 = m[9], a22 = m[10];
  const c00 = a11 * a22 - a12 * a21, c01 = -(a10 * a22 - a12 * a20), c02 = a10 * a21 - a11 * a20;
  const c10 = -(a01 * a22 - a02 * a21), c11 = a00 * a22 - a02 * a20, c12 = -(a00 * a21 - a01 * a20);
  const c20 = a01 * a12 - a02 * a11, c21 = -(a00 * a12 - a02 * a10), c22 = a00 * a11 - a01 * a10;
  const sg = a00 * c00 + a01 * c01 + a02 * c02 < 0 ? -1 : 1;
  return [c00 * sg, c10 * sg, c20 * sg, c01 * sg, c11 * sg, c21 * sg, c02 * sg, c12 * sg, c22 * sg];
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
export const easeOut = (t) => 1 - (1 - t) ** 3;
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Small seeded random generator so scenes look the same every time. */
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
