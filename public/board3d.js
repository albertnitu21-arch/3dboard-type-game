// 3D board renderer on plain WebGL (no libraries).
//
//   const b = createBoard3D(canvas, { board, groups, colorOf, nameOf });
//   b.sync(state);                       // jump to a state instantly
//   await b.play(events, nextState, speed); // animate dice, moves, jail
//   b.onSpace = (pos) => ...;            // a space was clicked/tapped
//   b.resetView();
//
// World layout: the board is 11 x 11 units centred on the origin, top face at y = 0,
// viewed by default from +z. Space 0 (Start) is the near-right corner.

import { pieceFor } from './pieces.js';

const MONEY_EVENTS = new Set(['pay', 'pass_start', 'gain', 'bought', 'auction_won', 'built', 'sold_building', 'mortgaged', 'unmortgaged', 'trade_done']);

const L = 11;          // board size
const C = 1.5;         // corner size
const W = (L - 2 * C) / 9; // edge cell width
const BAND = 0.26;     // colour band depth
const TEX = 2048;      // board texture size (px)
const PX = TEX / L;    // px per unit
const DIE = 0.62;      // die edge length

// ---------------------------------------------------------------- math

const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

const quat = {
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
};

/** Column-major model matrix from translation, rotation quaternion and scale. */
function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const sc = typeof s === 'number' ? [s, s, s] : s;
  return [
    (1 - 2 * (y * y + z * z)) * sc[0], 2 * (x * y + z * w) * sc[0], 2 * (x * z - y * w) * sc[0], 0,
    2 * (x * y - z * w) * sc[1], (1 - 2 * (x * x + z * z)) * sc[1], 2 * (y * z + x * w) * sc[1], 0,
    2 * (x * z + y * w) * sc[2], 2 * (y * z - x * w) * sc[2], (1 - 2 * (x * x + y * y)) * sc[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul4(a, b) {
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
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, target, up = [0, 1, 0]) {
  const z = v3.norm(v3.sub(eye, target));
  const x = v3.norm(v3.cross(up, z));
  const y = v3.cross(z, x);
  return {
    m: [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1],
    x, y, z,
  };
}
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// ------------------------------------------------------------ geometry

function boxGeo(w, h, d, uvRects) {
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

/** Surface of revolution from a [radius, height] profile (bottom to top). */
function latheGeo(profile, seg = 24) {
  const pos = [], nor = [], uv = [], idx = [];
  const n = profile.length;
  const pn = profile.map((p, k) => {
    const a = profile[Math.max(k - 1, 0)], b = profile[Math.min(k + 1, n - 1)];
    const t = [b[0] - a[0], b[1] - a[1]];
    const l = Math.hypot(t[0], t[1]) || 1;
    return [t[1] / l, -t[0] / l];
  });
  for (let i = 0; i <= seg; i++) {
    const ang = (i / seg) * Math.PI * 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    profile.forEach(([r, y], k) => {
      pos.push(r * c, y, r * s);
      nor.push(pn[k][0] * c, pn[k][1], pn[k][0] * s);
      uv.push(i / seg, k / (n - 1));
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

/** Unit triangular prism: base 1 x 1 at y = 0, ridge along x at y = 1 (a roof). */
function roofGeo() {
  const k = Math.hypot(0.5, 1);
  const fn = [0, 0.5 / k, 1 / k], bn = [0, 0.5 / k, -1 / k];
  const pos = [
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,      // front slope
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,    // back slope
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,                  // right gable
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,               // left gable
  ];
  const nor = [...fn, ...fn, ...fn, ...fn, ...bn, ...bn, ...bn, ...bn, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0];
  const uv = new Array((pos.length / 3) * 2).fill(0);
  return { pos, nor, uv, idx: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 11, 12, 13] };
}

function planeGeo() {
  return {
    pos: [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5],
    nor: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    uv: [0, 0, 1, 0, 1, 1, 0, 1],
    idx: [0, 1, 2, 0, 2, 3],
  };
}

function pawnProfile() {
  const p = [[0, 0], [0.15, 0], [0.155, 0.03], [0.14, 0.06], [0.1, 0.09], [0.075, 0.16],
    [0.06, 0.26], [0.055, 0.32], [0.1, 0.345], [0.1, 0.365], [0.05, 0.38]];
  const hc = 0.45, R = 0.085;
  for (let a = -55; a <= 90; a += 15) {
    const r = (a * Math.PI) / 180;
    p.push([Math.max(R * Math.cos(r), 0), hc + R * Math.sin(r)]);
  }
  return p;
}

// --------------------------------------------------------- board layout

/** Rectangle of cell i (0 = corner) of a side, in the side's local frame (units). */
function frameRect(i) {
  if (i === 0) return [L - C, L - C, L, L];
  const x1 = L - C - (i - 1) * W;
  return [x1 - W, L - C, x1, L];
}
/** Side-frame point -> world [x, z]. Side k is the frame rotated k*90deg clockwise (seen from above). */
function frameToWorld(k, fx, fy) {
  let dx = fx - L / 2, dy = fy - L / 2;
  for (let n = 0; n < k; n++) [dx, dy] = [-dy, dx];
  return [dx, dy];
}
function worldToPos(x, z) {
  const cx = x + L / 2, cy = z + L / 2;
  if (cx < 0 || cy < 0 || cx > L || cy > L) return null;
  const hi = L - C;
  if (cx > hi && cy > hi) return 0;
  if (cx < C && cy > hi) return 10;
  if (cx < C && cy < C) return 20;
  if (cx > hi && cy < C) return 30;
  if (cy > hi) return Math.ceil((hi - cx) / W);
  if (cx < C) return 10 + Math.ceil((hi - cy) / W);
  if (cy < C) return 20 + Math.ceil((cx - C) / W);
  if (cx > hi) return 30 + Math.ceil((cy - C) / W);
  return null;
}

/** Where player slot j (0..7) stands on a space. */
function slotWorld(pos, j, inJail) {
  const k = Math.floor(pos / 10), i = pos % 10;
  const [x0, y0, x1] = frameRect(i);
  let fx, fy;
  if (i !== 0) {
    fx = (x0 + x1) / 2 + ((j % 2) - 0.5) * 0.36;
    fy = y0 + BAND + 0.2 + Math.floor(j / 2) * 0.27;
  } else if (pos === 10 && inJail) {
    fx = x0 + 0.2 + 0.31 * (j % 3);
    fy = y0 + 0.2 + 0.31 * Math.floor(j / 3);
  } else if (pos === 10) {
    const pts = [[0.18, 1.3], [0.45, 1.3], [0.72, 1.3], [0.99, 1.3], [1.28, 1.28], [1.3, 0.99], [1.3, 0.72], [1.3, 0.45]];
    [fx, fy] = [x0 + pts[j][0], y0 + pts[j][1]];
  } else {
    fx = x0 + C * (0.22 + 0.28 * (j % 3));
    fy = y0 + C * (0.22 + 0.28 * Math.floor(j / 3));
  }
  return frameToWorld(k, fx, fy);
}

// --------------------------------------------------------- 2D textures

function wrap(g, text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const INK = '#23281f';
const CELL = '#f6f1e3';

function drawIcon(g, sp, cx, cy) {
  const u = PX;
  g.save();
  g.translate(cx, cy);
  if (sp.type === 'station') {
    g.fillStyle = INK;
    g.beginPath(); g.roundRect(-0.2 * u, -0.17 * u, 0.4 * u, 0.3 * u, 0.06 * u); g.fill();
    g.fillStyle = CELL;
    g.fillRect(-0.14 * u, -0.12 * u, 0.11 * u, 0.09 * u);
    g.fillRect(0.03 * u, -0.12 * u, 0.11 * u, 0.09 * u);
    g.fillStyle = INK;
    for (const x of [-0.11, 0.11]) { g.beginPath(); g.arc(x * u, 0.17 * u, 0.045 * u, 0, Math.PI * 2); g.fill(); }
  } else if (sp.type === 'utility' && /power/i.test(sp.name)) {
    g.fillStyle = '#e8b500'; g.strokeStyle = INK; g.lineWidth = 3;
    g.beginPath();
    for (const [x, y] of [[0.05, -0.24], [-0.13, 0.03], [-0.01, 0.03], [-0.06, 0.24], [0.13, -0.05], [0.01, -0.05], [0.05, -0.24]]) g.lineTo(x * u, y * u);
    g.fill(); g.stroke();
  } else if (sp.type === 'utility') {
    g.fillStyle = '#2f86c9';
    g.beginPath(); g.moveTo(0, -0.24 * u);
    g.bezierCurveTo(0.16 * u, 0, 0.16 * u, 0.2 * u, 0, 0.2 * u);
    g.bezierCurveTo(-0.16 * u, 0.2 * u, -0.16 * u, 0, 0, -0.24 * u);
    g.fill();
  } else if (sp.type === 'fortune') {
    g.fillStyle = '#d9822b';
    g.font = `900 ${0.62 * u}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('?', 0, 0.04 * u);
  } else if (sp.type === 'community') {
    g.fillStyle = '#8a5a2b';
    g.fillRect(-0.2 * u, -0.08 * u, 0.4 * u, 0.24 * u);
    g.beginPath(); g.roundRect(-0.2 * u, -0.2 * u, 0.4 * u, 0.14 * u, [0.08 * u, 0.08 * u, 0, 0]); g.fill();
    g.fillStyle = '#e8b500'; g.fillRect(-0.035 * u, -0.1 * u, 0.07 * u, 0.09 * u);
  } else if (sp.type === 'tax') {
    g.fillStyle = '#b48a1a';
    g.beginPath(); g.arc(0, 0, 0.17 * u, 0, Math.PI * 2); g.fill();
    g.fillStyle = CELL;
    g.font = `800 ${0.18 * u}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('¤', 0, 0.01 * u);
  }
  g.restore();
}

function drawCorner(g, pos, r) {
  const [x0, y0, x1, y1] = r.map((v) => v * PX);
  const u = PX;
  const cx = (x0 + x1) / 2;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (pos === 0) {
    g.fillStyle = '#c8402f';
    g.font = `900 ${0.3 * u}px ${FONT}`;
    g.fillText('START', cx, y0 + 0.5 * u);
    g.fillStyle = INK;
    g.font = `600 ${0.11 * u}px ${FONT}`;
    g.fillText('collect 200', cx, y0 + 0.78 * u);
    g.fillText('as you pass', cx, y0 + 0.92 * u);
    g.fillStyle = '#c8402f';
    g.beginPath();
    const ay = y0 + 1.2 * u;
    g.moveTo(x0 + 0.2 * u, ay); g.lineTo(x0 + 0.5 * u, ay - 0.14 * u); g.lineTo(x0 + 0.5 * u, ay - 0.06 * u);
    g.lineTo(x1 - 0.2 * u, ay - 0.06 * u); g.lineTo(x1 - 0.2 * u, ay + 0.06 * u); g.lineTo(x0 + 0.5 * u, ay + 0.06 * u);
    g.lineTo(x0 + 0.5 * u, ay + 0.14 * u); g.closePath(); g.fill();
  } else if (pos === 10) {
    const s = 0.68 * C * u;
    g.fillStyle = '#e9a23b';
    g.fillRect(x0, y0, s, s);
    g.strokeStyle = INK; g.lineWidth = 6;
    for (let k = 1; k < 5; k++) { g.beginPath(); g.moveTo(x0 + (k * s) / 5, y0); g.lineTo(x0 + (k * s) / 5, y0 + s); g.stroke(); }
    g.strokeRect(x0, y0, s, s);
    g.fillStyle = INK;
    g.font = `900 ${0.125 * u}px ${FONT}`;
    g.fillStyle = CELL; g.fillRect(x0 + s * 0.06, y0 + s * 0.38, s * 0.88, s * 0.26);
    g.fillStyle = INK; g.fillText('PUȘCĂRIE', x0 + s / 2, y0 + s * 0.52);
    g.font = `700 ${0.12 * u}px ${FONT}`;
    g.fillText('JUST', x0 + s / 2, y1 - 0.22 * u);
    g.save(); g.translate(x1 - 0.22 * u, y0 + s / 2); g.rotate(-Math.PI / 2);
    g.fillText('VISITING', 0, 0); g.restore();
  } else if (pos === 20) {
    g.fillStyle = '#2e7d5b';
    g.font = `900 ${0.24 * u}px ${FONT}`;
    g.fillText('REST', cx, y0 + 0.55 * u);
    g.fillText('STOP', cx, y0 + 0.82 * u);
    g.fillStyle = '#8a5a2b';
    g.fillRect(cx - 0.35 * u, y0 + 1.05 * u, 0.7 * u, 0.07 * u);
    g.fillRect(cx - 0.3 * u, y0 + 1.12 * u, 0.06 * u, 0.15 * u);
    g.fillRect(cx + 0.24 * u, y0 + 1.12 * u, 0.06 * u, 0.15 * u);
  } else {
    g.fillStyle = '#c8402f';
    g.font = `900 ${0.22 * u}px ${FONT}`;
    g.fillText('GO TO', cx, y0 + 0.48 * u);
    g.font = `900 ${0.19 * u}px ${FONT}`;
    g.fillText('PUȘCĂRIE', cx, y0 + 0.76 * u);
    g.strokeStyle = INK; g.lineWidth = 6;
    g.strokeRect(cx - 0.22 * u, y0 + 0.98 * u, 0.44 * u, 0.32 * u);
    for (let k = 1; k < 4; k++) {
      g.beginPath(); g.moveTo(cx - 0.22 * u + k * 0.11 * u, y0 + 0.98 * u); g.lineTo(cx - 0.22 * u + k * 0.11 * u, y0 + 1.3 * u); g.stroke();
    }
  }
}

function drawCell(g, pos, i, ctx) {
  const { board, groups, state, colorOf } = ctx;
  const sp = board[pos];
  const r = frameRect(i);
  const [x0, y0, x1, y1] = r.map((v) => v * PX);
  const w = x1 - x0;
  const u = PX;
  g.fillStyle = CELL;
  g.fillRect(x0, y0, w, y1 - y0);
  if (i === 0) {
    drawCorner(g, pos, r);
  } else {
    let y = y0;
    if (sp.type === 'property') {
      g.fillStyle = groups[sp.group].color;
      g.fillRect(x0, y0, w, BAND * u);
      g.strokeStyle = INK; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x0, y0 + BAND * u); g.lineTo(x1, y0 + BAND * u); g.stroke();
      y = y0 + BAND * u;
    }
    g.fillStyle = INK;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.font = `700 ${0.105 * u}px ${FONT}`;
    const lines = wrap(g, sp.name.toUpperCase(), w * 0.88);
    lines.slice(0, 3).forEach((ln, n) => g.fillText(ln, (x0 + x1) / 2, y + 0.08 * u + n * 0.125 * u));
    if (sp.type !== 'property') drawIcon(g, sp, (x0 + x1) / 2, y0 + 0.82 * u);
    g.textBaseline = 'alphabetic';
    g.font = `600 ${0.11 * u}px ${FONT}`;
    if (sp.price) g.fillText(String(sp.price), (x0 + x1) / 2, y1 - 0.2 * u);
    if (sp.type === 'tax') g.fillText(`PAY ${sp.amount}`, (x0 + x1) / 2, y1 - 0.2 * u);

    const st = state?.props?.[pos];
    if (st?.owner) {
      g.fillStyle = colorOf(st.owner);
      g.fillRect(x0 + 5, y1 - 0.12 * u, w - 10, 0.12 * u - 5);
    }
    if (st?.mortgaged) {
      g.fillStyle = 'rgba(40,40,40,0.45)';
      g.fillRect(x0, y0, w, y1 - y0);
      g.save();
      g.translate((x0 + x1) / 2, (y0 + y1) / 2);
      g.rotate(-Math.PI / 2.6);
      g.fillStyle = '#fff';
      g.font = `800 ${0.1 * u}px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('MORTGAGED', 0, 0);
      g.restore();
    }
  }
  g.strokeStyle = INK;
  g.lineWidth = 4;
  g.strokeRect(x0, y0, w, y1 - y0);
}

function drawBoardTexture(cnv, ctx) {
  const g = cnv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#dfe8d6';
  g.fillRect(0, 0, TEX, TEX);
  // centre decoration
  const mid = TEX / 2;
  g.save();
  g.translate(mid, mid);
  g.rotate(-Math.PI / 4);
  g.fillStyle = 'rgba(31,111,92,0.85)';
  g.font = `900 ${1.2 * PX}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('ESTATE', 0, 0);
  for (const [dy, label, color] of [[-2.6, 'FORTUNE', '#d9822b'], [2.6, 'COMMUNITY FUND', '#8a5a2b']]) {
    g.save();
    g.translate(0, dy * PX);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.strokeStyle = color; g.lineWidth = 8; g.setLineDash([22, 14]);
    g.beginPath(); g.roundRect(-1.0 * PX, -0.6 * PX, 2.0 * PX, 1.2 * PX, 0.15 * PX); g.fill(); g.stroke();
    g.setLineDash([]);
    g.fillStyle = color;
    g.font = `800 ${0.2 * PX}px ${FONT}`;
    g.fillText(label, 0, 0);
    g.restore();
  }
  g.restore();
  for (let k = 0; k < 4; k++) {
    g.save();
    g.translate(mid, mid);
    g.rotate((k * Math.PI) / 2);
    g.translate(-mid, -mid);
    for (let i = 0; i < 10; i++) drawCell(g, k * 10 + i, i, ctx);
    g.restore();
  }
  g.strokeStyle = INK;
  g.lineWidth = 8;
  g.strokeRect(4, 4, TEX - 8, TEX - 8);
  g.strokeRect(C * PX, C * PX, (L - 2 * C) * PX, (L - 2 * C) * PX);
}

function drawDiceAtlas() {
  const cnv = document.createElement('canvas');
  cnv.width = 1024; cnv.height = 512;
  const g = cnv.getContext('2d');
  const pips = {
    1: [[0.5, 0.5]],
    2: [[0.27, 0.27], [0.73, 0.73]],
    3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
    4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
    5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
    6: [[0.27, 0.25], [0.73, 0.25], [0.27, 0.5], [0.73, 0.5], [0.27, 0.75], [0.73, 0.75]],
  };
  const rects = {};
  for (let v = 1; v <= 6; v++) {
    const cx = ((v - 1) % 4) * 256, cy = Math.floor((v - 1) / 4) * 256;
    const grad = g.createRadialGradient(cx + 128, cy + 128, 40, cx + 128, cy + 128, 190);
    grad.addColorStop(0, '#fffdf7'); grad.addColorStop(1, '#e4ddcc');
    g.fillStyle = grad;
    g.fillRect(cx, cy, 256, 256);
    g.fillStyle = v === 1 ? '#c8402f' : '#1c1f1a';
    for (const [px, py] of pips[v]) {
      g.beginPath(); g.arc(cx + px * 256, cy + py * 256, v === 1 ? 34 : 24, 0, Math.PI * 2); g.fill();
    }
    rects[v] = [(cx + 4) / 1024, (cy + 4) / 512, (cx + 252) / 1024, (cy + 252) / 512];
  }
  return { cnv, rects };
}

function drawCardBacks() {
  // Two card backs side by side: left half Fortune, right half Community Fund.
  const cnv = document.createElement('canvas');
  cnv.width = 1024; cnv.height = 512;
  const g = cnv.getContext('2d');
  const draw = (x, color, label, glyph) => {
    g.fillStyle = '#fffcf2';
    g.fillRect(x, 0, 512, 512);
    g.fillStyle = color;
    g.beginPath(); g.roundRect(x + 22, 22, 468, 468, 26); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 6;
    g.beginPath(); g.roundRect(x + 44, 44, 424, 424, 18); g.stroke();
    g.fillStyle = '#fff';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `900 210px ${FONT}`;
    g.fillText(glyph, x + 256, 215);
    g.font = `800 58px ${FONT}`;
    g.fillText(label, x + 256, 395);
  };
  draw(0, '#d9822b', 'FORTUNE', '?');
  draw(512, '#8a5a2b', 'COMMUNITY', '◆');
  return cnv;
}

/** Glowing outline for a square of the board (drawn a little larger than the square). */
function glowTexture(w, h, padU) {
  // w, h: canvas size (powers of two). padU: fraction of the plane that lies outside the square.
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const g = cnv.getContext('2d');
  const px = padU[0] * w, py = padU[1] * h;
  const r = Math.min(px, py) * 0.9;
  g.strokeStyle = '#fff';
  for (const [blur, width, alpha] of [[Math.min(px, py) * 0.9, Math.min(px, py) * 0.5, 0.9], [4, Math.min(px, py) * 0.28, 1]]) {
    g.save();
    g.shadowColor = '#fff';
    g.shadowBlur = blur;
    g.globalAlpha = alpha;
    g.lineWidth = width;
    g.beginPath(); g.roundRect(px, py, w - 2 * px, h - 2 * py, r); g.stroke();
    g.restore();
  }
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.beginPath(); g.roundRect(px, py, w - 2 * px, h - 2 * py, r); g.fill();
  return cnv;
}

function radialTexture(inner, outer, ring = false) {
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 128;
  const g = cnv.getContext('2d');
  if (ring) {
    g.strokeStyle = '#fff'; g.lineWidth = 12;
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 0.25; g.fillStyle = '#fff';
    g.beginPath(); g.arc(64, 64, 46, 0, Math.PI * 2); g.fill();
  } else {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, inner); grad.addColorStop(1, outer);
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  }
  return cnv;
}

// ------------------------------------------------------------- webgl

const VS = `
attribute vec3 aPos; attribute vec3 aNor; attribute vec2 aUv;
uniform mat4 uVP; uniform mat4 uModel;
varying vec3 vN; varying vec2 vUv; varying vec3 vW;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz;
  vN = (uModel * vec4(aNor, 0.0)).xyz;
  vUv = aUv;
  gl_Position = uVP * w;
}`;
const FS = `
precision mediump float;
varying vec3 vN; varying vec2 vUv; varying vec3 vW;
uniform sampler2D uTex; uniform float uUseTex; uniform vec4 uColor;
uniform float uLit; uniform float uSpec; uniform vec3 uLight; uniform vec3 uEye;
void main() {
  vec4 c = uColor;
  if (uUseTex > 0.5) c *= texture2D(uTex, vUv);
  if (uLit > 0.5) {
    vec3 n = normalize(vN);
    float d = max(dot(n, uLight), 0.0);
    vec3 h = normalize(uLight + normalize(uEye - vW));
    float s = pow(max(dot(n, h), 0.0), 40.0) * uSpec;
    c.rgb = c.rgb * (0.56 + 0.52 * d) + vec3(s);
  }
  gl_FragColor = c;
}`;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function createBoard3D(canvas, { board, groups, colorOf, nameOf, pieceOf = pieceFor }) {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false })
    || canvas.getContext('experimental-webgl', { antialias: true, alpha: false });
  if (!gl) return null;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const A = { pos: gl.getAttribLocation(prog, 'aPos'), nor: gl.getAttribLocation(prog, 'aNor'), uv: gl.getAttribLocation(prog, 'aUv') };
  const U = {};
  for (const n of ['uVP', 'uModel', 'uTex', 'uUseTex', 'uColor', 'uLit', 'uSpec', 'uLight', 'uEye']) U[n] = gl.getUniformLocation(prog, n);
  gl.uniform3fv(U.uLight, v3.norm([0.35, 1, 0.5]));
  gl.enable(gl.DEPTH_TEST);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const mesh = (geo) => {
    const buf = (data, T = Float32Array, target = gl.ARRAY_BUFFER) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, new T(data), gl.STATIC_DRAW);
      return b;
    };
    return {
      pos: buf(geo.pos), nor: buf(geo.nor), uv: buf(geo.uv),
      idx: buf(geo.idx, Uint16Array, gl.ELEMENT_ARRAY_BUFFER), count: geo.idx.length,
    };
  };
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  const texture = (cnv) => {
    const t = gl.createTexture();
    uploadTexture(t, cnv);
    return t;
  };
  function uploadTexture(t, cnv) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cnv);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }

  // ----- assets
  const boardCanvas = document.createElement('canvas');
  boardCanvas.width = boardCanvas.height = TEX;
  const texCtx = { board, groups, state: null, colorOf };
  drawBoardTexture(boardCanvas, texCtx);
  const boardTex = texture(boardCanvas);
  const atlas = drawDiceAtlas();
  const diceTex = texture(atlas.cnv);
  const shadowTex = texture(radialTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)'));
  const cardTex = texture(drawCardBacks());
  const GLOW_PAD = 0.14; // world units the glow spills past the square
  const glowEdgeTex = texture(glowTexture(256, 512, [GLOW_PAD / (W + 2 * GLOW_PAD), GLOW_PAD / (C + 2 * GLOW_PAD)]));
  const glowCornerTex = texture(glowTexture(512, 512, [GLOW_PAD / (C + 2 * GLOW_PAD), GLOW_PAD / (C + 2 * GLOW_PAD)]));

  const M = {
    plane: mesh(planeGeo()),
    roof: mesh(roofGeo()),
    // unit shapes for the player pieces (see pieces.js)
    sphere: mesh(latheGeo(Array.from({ length: 13 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 12) * Math.PI;
      return [0.5 * Math.cos(a), 0.5 * Math.sin(a)];
    }), 20)),
    half: mesh(latheGeo(Array.from({ length: 8 }, (_, i) => {
      const a = (i / 7) * (Math.PI / 2);
      return [0.5 * Math.cos(a), Math.sin(a)];
    }).concat([[0, 1]]).reverse().concat([[0, 0]]).reverse(), 20)),
    cyl: mesh(latheGeo([[0, 0], [0.5, 0], [0.5, 0], [0.5, 1], [0.5, 1], [0, 1]], 20)),
    cone: mesh(latheGeo([[0, 0], [0.5, 0], [0.5, 0], [0, 1]], 20)),
    torus: mesh(latheGeo(Array.from({ length: 13 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return [0.35 + 0.15 * Math.cos(a), 0.15 * Math.sin(a)];
    }), 24)),
    slab: mesh(boxGeo(L, 0.3, L)),
    box: mesh(boxGeo(1, 1, 1)),
    pawn: mesh(latheGeo(pawnProfile(), 28)),
    // face order +x,-x,+y,-y,+z,-z -> values 3,4,1,6,2,5 (opposite faces sum to 7)
    die: mesh(boxGeo(DIE, DIE, DIE, [3, 4, 1, 6, 2, 5].map((v) => atlas.rects[v]))),
  };
  // Card piles: top face shows the card back, the sides show paper edges.
  const EDGE = [0.004, 0.004, 0.012, 0.012];
  const cardMesh = (deck) => {
    const top = deck === 'fortune' ? [0.02, 0.06, 0.48, 0.94] : [0.52, 0.06, 0.98, 0.94];
    return mesh(boxGeo(1, 1, 1, [EDGE, EDGE, top, EDGE, EDGE, EDGE]));
  };
  M.card = { fortune: cardMesh('fortune'), community: cardMesh('community') };
  // Pile spots match the dashed outlines drawn in the middle of the board.
  const PILE = {
    fortune: { at: [-1.84, -1.84], yaw: Math.PI / 4 },
    community: { at: [1.84, 1.84], yaw: Math.PI / 4 },
  };
  const CARD_W = 1.7, CARD_D = 1.0, CARD_T = 0.012;
  let flying = null; // { deck, p, q }
  const FACE_UP = {
    1: quat.id(),
    6: quat.axis([1, 0, 0], Math.PI),
    3: quat.axis([0, 0, 1], Math.PI / 2),
    4: quat.axis([0, 0, 1], -Math.PI / 2),
    2: quat.axis([1, 0, 0], -Math.PI / 2),
    5: quat.axis([1, 0, 0], Math.PI / 2),
  };

  const dark = matchMedia?.('(prefers-color-scheme: dark)').matches;
  const tableColor = dark ? [0.1, 0.13, 0.115] : [0.83, 0.8, 0.73];

  // ----- scene state
  let state = null;
  let texKey = '';
  const tokens = new Map(); // id -> { x, z, lift, pos, inJail, slot, visible, color }
  const dice = [
    { p: [-0.5, DIE / 2, 0.15], q: FACE_UP[3] },
    { p: [0.5, DIE / 2, -0.15], q: quat.mul(quat.axis([0, 1, 0], 0.5), FACE_UP[4]) },
  ];
  let selected = null;
  let animating = false;
  const cam = { theta: 0, phi: 0.95, r: 16, auto: true };
  // Follow camera: rides behind the player whose turn it is.
  const follow = { on: false, id: null, focus: 'token', yaw: 0, tilt: 0, zoom: 1 };
  let lastNow = 0;
  // Squares the moving piece is about to cross: { id, cells, passed, color, alpha }
  let path = null;
  // Where the moving piece will land: { pos, color, alpha } (stays a moment after arrival)
  let landing = null;
  let landingFade = 0;
  const badge = document.createElement('div');
  badge.className = 'step-badge';
  badge.hidden = true;
  badge.setAttribute('aria-live', 'polite');
  canvas.parentElement?.append(badge);
  let dirty = true;
  const tweens = new Set();

  const api = { onSpace: null, onCard: null, onEvent: null };

  // ----- camera
  function fitRadius() {
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    const fov = (38 * Math.PI) / 180;
    const th = Math.tan(fov / 2);
    return Math.min(Math.max(6.7 / (th * aspect), 5.6 / th, 9), 34);
  }
  function camera() {
    const target = cam.target ?? [0, 0, 0.35];
    const cp = Math.cos(cam.phi);
    const eye = [
      target[0] + cam.r * Math.sin(cam.theta) * cp,
      target[1] + cam.r * Math.sin(cam.phi),
      target[2] + cam.r * Math.cos(cam.theta) * cp,
    ];
    const view = lookAt(eye, target);
    const aspect = canvas.width / Math.max(canvas.height, 1);
    const fov = (38 * Math.PI) / 180;
    return { eye, view, proj: perspective(fov, aspect, 0.5, 200), fov, aspect };
  }
  api.resetView = () => {
    if (follow.on) { follow.yaw = 0; follow.tilt = 0; follow.zoom = 1; dirty = true; return; }
    cam.theta = 0; cam.phi = 0.95; cam.r = fitRadius(); cam.auto = true; cam.target = null; dirty = true;
  };

  // ----- drawing
  function draw(m, model, color, tex = null, { lit = true, spec = 0 } = {}) {
    gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
    gl.enableVertexAttribArray(A.pos); gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.nor);
    gl.enableVertexAttribArray(A.nor); gl.vertexAttribPointer(A.nor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.uv);
    gl.enableVertexAttribArray(A.uv); gl.vertexAttribPointer(A.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx);
    gl.uniformMatrix4fv(U.uModel, false, model);
    gl.uniform4fv(U.uColor, color.length === 3 ? [...color, 1] : color);
    gl.uniform1f(U.uUseTex, tex ? 1 : 0);
    if (tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(U.uTex, 0); }
    gl.uniform1f(U.uLit, lit ? 1 : 0);
    gl.uniform1f(U.uSpec, spec);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
  }

  // Building animations: pos -> { from, to, t } while a house/hotel is being added or removed.
  const buildAnims = new Map();
  const easeOutBounce = (x) => {
    const n = 7.5625, d = 1 / 2.75;
    if (x < d) return n * x * x;
    if (x < 2 * d) return n * (x -= 1.5 * d) * x + 0.75;
    if (x < 2.5 * d) return n * (x -= 2.25 * d) * x + 0.9375;
    return n * (x -= 2.625 * d) * x + 0.984375;
  };
  const dropIn = (t) => ({ s: 0.55 + 0.45 * Math.min(1, t * 1.6), dy: (1 - easeOutBounce(t)) * 1.3 });
  const fadeOut = (t) => ({ s: Math.max(0, 1 - t), dy: t * 0.35 });

  const pieceColors = new Map();
  function drawPiece(id, t) {
    const piece = pieceOf(id);
    // pieces were designed on a 0.035-high base; without it, lower them onto the board
    const base = trs([t.x, t.lift - 0.035 * 1.15, t.z], quat.axis([0, 1, 0], t.yaw ?? 0), 1.15);
    const dark = t.color.map((c) => c * 0.62);
    for (const [shape, at, sc, col, rot] of piece.parts) {
      let c;
      if (col === 'P') c = t.color;
      else if (col === 'D') c = dark;
      else {
        c = pieceColors.get(col);
        if (!c) { c = hexToRgb(col); pieceColors.set(col, c); }
      }
      const q = rot ? quat.axis([rot[0], rot[1], rot[2]], rot[3]) : undefined;
      draw(M[shape], mul4(base, trs(at, q, sc)), c, null, { spec: 0.45 });
    }
  }

  /** Direction a piece faces on each side of the board (yaw that turns +z that way). */
  const SIDE_YAW = [-Math.PI / 2, Math.PI, Math.PI / 2, 0];
  const SIDE_DIR = [[-1, 0], [0, -1], [1, 0], [0, 1]];
  const sideOf = (pos) => Math.floor(((pos % 40) + 40) % 40 / 10);
  /** Size and height of the landing gem (a little larger when the camera is far). */
  const gemPose = (l) => {
    const s = l.alpha * Math.min(1.35, Math.max(1, cam.r / 11));
    return { s, y: 0.42 * s + 0.2 + 0.05 * Math.sin(lastNow / 380) };
  };
  const cellCenter = (pos) => {
    const [x0, y0, x1, y1] = frameRect(pos % 10);
    return frameToWorld(sideOf(pos), (x0 + x1) / 2, (y0 + y1) / 2);
  };

  function buildingList() {
    const out = [];
    if (!state) return out;
    for (const [p, st] of Object.entries(state.props)) {
      const pos = Number(p);
      const anim = buildAnims.get(pos);
      if (!st.houses && !anim) continue;
      const k = Math.floor(pos / 10), i = pos % 10;
      const [x0, y0, x1] = frameRect(i);
      const fy = y0 + BAND / 2;
      const yaw = (-k * Math.PI) / 2;
      const house = (h, fx = {}) => out.push({ hotel: false, at: frameToWorld(k, x0 + W * (0.17 + 0.22 * h), fy), yaw, s: 1, dy: 0, ...fx });
      const hotel = (fx = {}) => out.push({ hotel: true, at: frameToWorld(k, (x0 + x1) / 2, fy), yaw, s: 1, dy: 0, ...fx });
      if (!anim) {
        if (st.houses === 5) hotel();
        else for (let h = 0; h < st.houses; h++) house(h);
        continue;
      }
      const { from, to, t } = anim;
      const split = 0.4; // hotel swaps: first the old buildings go, then the new ones arrive
      if (to === 5) {
        if (t < split) for (let h = 0; h < 4; h++) house(h, fadeOut(t / split));
        else hotel(dropIn((t - split) / (1 - split)));
      } else if (from === 5) {
        if (t < split) hotel(fadeOut(t / split));
        else for (let h = 0; h < 4; h++) house(h, { s: Math.min(1, (t - split) / (1 - split) * 1.4), dy: 0 });
      } else if (to > from) {
        for (let h = 0; h < to; h++) house(h, h === to - 1 ? dropIn(t) : {});
      } else {
        for (let h = 0; h < from; h++) house(h, h === from - 1 ? fadeOut(t) : {});
      }
    }
    return out;
  }

  function render() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(...tableColor, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const c = camera();
    gl.uniformMatrix4fv(U.uVP, false, mul4(c.proj, c.view.m));
    gl.uniform3fv(U.uEye, c.eye);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    draw(M.plane, trs([0, -0.31, 0], undefined, [120, 1, 120]), tableColor, null, { lit: false });
    draw(M.slab, trs([0, -0.15, 0]), [0.16, 0.2, 0.17]);
    draw(M.plane, trs([0, 0.001, 0], undefined, [L, 1, L]), [1, 1, 1], boardTex);

    const buildings = buildingList();
    for (const b of buildings) {
      if (b.s <= 0.01) continue;
      const q = quat.axis([0, 1, 0], b.yaw);
      const sc = (v) => v.map((x) => x * b.s);
      const y = (v) => v * b.s + b.dy;
      if (b.hotel) {
        draw(M.box, trs([b.at[0], y(0.085), b.at[1]], q, sc([0.44, 0.17, 0.18])), [0.8, 0.2, 0.16], null, { spec: 0.25 });
        draw(M.roof, trs([b.at[0], y(0.17), b.at[1]], q, sc([0.47, 0.09, 0.2])), [0.58, 0.12, 0.1], null, { spec: 0.2 });
        draw(M.box, trs([b.at[0], y(0.085), b.at[1] ], q, sc([0.08, 0.1, 0.185])), [0.95, 0.88, 0.62], null, { spec: 0.1 });
      } else {
        draw(M.box, trs([b.at[0], y(0.055), b.at[1]], q, sc([0.15, 0.11, 0.15])), [0.2, 0.64, 0.34], null, { spec: 0.25 });
        draw(M.roof, trs([b.at[0], y(0.11), b.at[1]], q, sc([0.175, 0.08, 0.17])), [0.11, 0.42, 0.22], null, { spec: 0.2 });
      }
    }

    for (const [id, t] of tokens) {
      if (!t.visible) continue;
      drawPiece(id, t);
    }
    for (const d of dice) draw(M.die, trs(d.p, d.q), [1, 1, 1], diceTex, { spec: 0.35 });
    for (const deck of ['fortune', 'community']) {
      const n = Math.max(state?.deckSizes?.[deck] ?? 16, 1) - (flying?.deck === deck ? 1 : 0);
      if (n <= 0) continue;
      const h = n * CARD_T;
      const pl = PILE[deck];
      draw(M.card[deck], trs([pl.at[0], h / 2, pl.at[1]], quat.axis([0, 1, 0], pl.yaw), [CARD_W, h, CARD_D]), [1, 1, 1], cardTex, { spec: 0.15 });
    }
    if (flying) draw(M.card[flying.deck], trs(flying.p, flying.q, [CARD_W, CARD_T * 1.5, CARD_D]), [1, 1, 1], cardTex, { spec: 0.3 });
    if (landing && landing.alpha > 0.02) {
      // a small gem in the player's colour floating over the landing square
      const [cx, cz] = cellCenter(landing.pos);
      const g = gemPose(landing);
      const spin = quat.axis([0, 1, 0], lastNow / 900);
      const light = landing.color.map((c) => Math.min(1, c * 0.55 + 0.5));
      draw(M.cone, trs([cx, g.y, cz], spin, [g.s * 0.2, g.s * 0.11, g.s * 0.2]), light, null, { spec: 0.9 });
      draw(M.cone, trs([cx, g.y, cz], quat.mul(spin, quat.axis([1, 0, 0], Math.PI)), [g.s * 0.2, g.s * 0.2, g.s * 0.2]), landing.color, null, { spec: 0.9 });
    }

    // transparent: shadows, rings, selection
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    for (const [id, t] of tokens) {
      if (!t.visible) continue;
      const s = 0.42 * (1 + t.lift * 0.4);
      draw(M.plane, trs([t.x + 0.03, 0.003, t.z + 0.03], undefined, [s, 1, s]), [1, 1, 1, 1 / (1 + t.lift * 1.5)], shadowTex, { lit: false });
    }
    for (const d of dice) {
      const s = DIE * 1.6 * (1 + (d.p[1] - DIE / 2) * 0.35);
      draw(M.plane, trs([d.p[0] + 0.06, 0.003, d.p[2] + 0.06], undefined, [s, 1, s]), [1, 1, 1, 0.9 / (1 + (d.p[1] - DIE / 2) * 0.8)], shadowTex, { lit: false });
    }
    for (const b of buildings) {
      if (b.s <= 0.01) continue;
      const w = (b.hotel ? 0.62 : 0.26) * b.s * (1 + b.dy * 0.5);
      draw(M.plane, trs([b.at[0] + 0.03, 0.0025, b.at[1] + 0.03], quat.axis([0, 1, 0], b.yaw), [w, 1, w * (b.hotel ? 0.5 : 1)]), [1, 1, 1, 0.55 / (1 + b.dy * 2)], shadowTex, { lit: false });
    }
    for (const deck of ['fortune', 'community']) {
      const pl = PILE[deck];
      draw(M.plane, trs([pl.at[0] + 0.05, 0.002, pl.at[1] + 0.05], quat.axis([0, 1, 0], pl.yaw), [CARD_W * 1.25, 1, CARD_D * 1.35]), [1, 1, 1, 0.45], shadowTex, { lit: false });
    }
    if (landing && landing.alpha > 0.02) {
      const pos = landing.pos;
      const k = sideOf(pos), corner = pos % 10 === 0;
      const [x0, y0, x1, y1] = frameRect(pos % 10);
      const [cx, cz] = cellCenter(pos);
      const q = quat.axis([0, 1, 0], (-k * Math.PI) / 2);
      const pulse = 0.85 + 0.15 * Math.sin(lastNow / 160);
      const gp = gemPose(landing);
      draw(M.plane, trs([cx, 0.007, cz], undefined, [0.36 * gp.s, 1, 0.36 * gp.s]), [1, 1, 1, 0.5 * landing.alpha], shadowTex, { lit: false });
      // solid wash of the player's colour over the square
      draw(M.plane, trs([cx, 0.0055, cz], q, [x1 - x0, 1, y1 - y0]), [...landing.color, 0.55 * landing.alpha], null, { lit: false });
      // bright outline in the same colour
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      const gw = [x1 - x0 + 2 * GLOW_PAD, 1, y1 - y0 + 2 * GLOW_PAD];
      draw(M.plane, trs([cx, 0.0065, cz], q, gw), [...landing.color, landing.alpha * pulse], corner ? glowCornerTex : glowEdgeTex, { lit: false });
      draw(M.plane, trs([cx, 0.0066, cz], q, gw), [...landing.color, landing.alpha * pulse * 0.7], corner ? glowCornerTex : glowEdgeTex, { lit: false });
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    if (path && path.alpha > 0) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive: glows brighten the board
      const pulse = 0.8 + 0.2 * Math.sin(lastNow / 160);
      const tint = path.color.map((c) => Math.min(1, c * 0.75 + 0.35));
      path.cells.forEach((pos, i) => {
        if (i < path.passed) return;
        const last = i === path.cells.length - 1;
        if (last && landing) return; // the landing square has its own highlight
        const k = sideOf(pos), corner = pos % 10 === 0;
        const [x0, y0, x1, y1] = frameRect(pos % 10);
        const [cx, cz] = frameToWorld(k, (x0 + x1) / 2, (y0 + y1) / 2);
        const fw = x1 - x0 + 2 * GLOW_PAD, fd = y1 - y0 + 2 * GLOW_PAD;
        const q = quat.axis([0, 1, 0], (-k * Math.PI) / 2);
        const a = path.alpha * (last ? pulse : 0.6);
        draw(M.plane, trs([cx, 0.006, cz], q, [fw, 1, fd]), [...tint, a], corner ? glowCornerTex : glowEdgeTex, { lit: false });
        if (last) draw(M.plane, trs([cx, 0.006, cz], q, [fw, 1, fd]), [...tint, a * 0.6], corner ? glowCornerTex : glowEdgeTex, { lit: false });
      });
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    if (selected !== null) {
      const k = Math.floor(selected / 10);
      const [x0, y0, x1, y1] = frameRect(selected % 10);
      const [cx, cz] = frameToWorld(k, (x0 + x1) / 2, (y0 + y1) / 2);
      const sz = k % 2 === 0 ? [x1 - x0, 1, y1 - y0] : [y1 - y0, 1, x1 - x0];
      draw(M.plane, trs([cx, 0.005, cz], undefined, sz), [1, 0.85, 0.2, 0.35], null, { lit: false });
    }
    gl.depthMask(true);
    placeBadge();
  }

  function placeBadge() {
    if (badge.hidden || !path) return;
    const p = api.screenPos(path.id, 0.72);
    if (!p) return;
    badge.style.left = `${p.x}px`;
    badge.style.top = `${p.y}px`;
  }

  // ----- follow camera
  const lerpAngle = (a, b, k) => {
    let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return a + d * k;
  };
  function updateFollow(dt) {
    const id = follow.id ?? (state && !state.winner ? state.players[state.current]?.id : null);
    const t = id && tokens.get(id);
    if (!t || !t.visible) return false;
    const k = t.inJail ? 1 : sideOf(t.pos);
    const d = SIDE_DIR[k];
    let target, r, phi;
    if (follow.focus === 'dice') {
      target = [t.x * 0.35, 0, t.z * 0.35];
      r = 9.5 * follow.zoom;
      phi = 0.85 + follow.tilt;
    } else {
      // a little ahead of the piece and nudged towards the middle of the board
      target = [t.x + d[0] * 1.9 - t.x * 0.08, 0, t.z + d[1] * 1.9 - t.z * 0.08];
      r = 6.4 * follow.zoom;
      phi = 0.8 + follow.tilt;
    }
    // look along the direction of travel: the camera sits behind the piece
    const theta = Math.atan2(-d[0], -d[1]) + follow.yaw;
    const a = 1 - Math.exp(-dt * 3.2);
    const cur = cam.target ?? [0, 0, 0.35];
    const next = cur.map((v, i) => lerp(v, target[i], a));
    const before = [cam.theta, cam.phi, cam.r, ...cur];
    cam.target = next;
    cam.theta = lerpAngle(cam.theta, theta, a);
    cam.phi = lerp(cam.phi, Math.min(Math.max(phi, 0.25), 1.4), a);
    cam.r = lerp(cam.r, r, a);
    const after = [cam.theta, cam.phi, cam.r, ...next];
    return after.some((v, i) => Math.abs(v - before[i]) > 1e-4);
  }

  /** 'overview' (whole board) or 'follow' (third-person camera behind the active piece). */
  api.setMode = (mode) => {
    follow.on = mode === 'follow';
    follow.yaw = 0; follow.tilt = 0; follow.zoom = 1;
    if (!follow.on) api.resetView();
    cam.auto = !follow.on;
    dirty = true;
  };
  api.mode = () => (follow.on ? 'follow' : 'overview');

  let rafId = 0;
  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - (lastNow || now)) / 1000);
    lastNow = now;
    if (follow.on && updateFollow(dt)) dirty = true;
    if ((path && path.alpha > 0) || (landing && landing.alpha > 0)) dirty = true; // keep highlights pulsing
    for (const tw of [...tweens]) {
      const t = Math.min(1, (now - tw.start) / tw.dur);
      tw.fn(t);
      if (t >= 1) { tweens.delete(tw); tw.done(); }
      dirty = true;
    }
    if (dirty) { dirty = false; render(); }
  }
  rafId = requestAnimationFrame(frame);

  function tween(seconds, fn) {
    return new Promise((done) => {
      if (seconds <= 0 || document.hidden) { fn(1); dirty = true; done(); return; }
      tweens.add({ start: performance.now(), dur: seconds * 1000, fn, done });
    });
  }

  const ro = new ResizeObserver(() => { if (cam.auto) cam.r = fitRadius(); dirty = true; });
  ro.observe(canvas);

  // ----- input
  const pointers = new Map();
  let dragDist = 0, pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
    dragDist = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), r: cam.r, z: follow.zoom };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (follow.on) follow.zoom = Math.min(Math.max(pinch.z * (pinch.d / Math.max(d, 1)), 0.5), 3);
      else { cam.r = Math.min(Math.max(pinch.r * (pinch.d / Math.max(d, 1)), 6), 40); cam.auto = false; }
    } else if (pointers.size === 1) {
      if (follow.on) {
        follow.yaw -= dx * 0.008;
        if (e.pointerType === 'mouse') follow.tilt = Math.min(Math.max(follow.tilt + dy * 0.006, -0.25), 0.9);
      } else {
        cam.theta -= dx * 0.008;
        if (e.pointerType === 'mouse') cam.phi = Math.min(Math.max(cam.phi + dy * 0.006, 0.35), 1.5);
      }
    }
    dirty = true;
  });
  const up = (e) => {
    const wasClick = pointers.size === 1 && dragDist < 6;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (wasClick && e.type === 'pointerup') pick(e.clientX, e.clientY);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (follow.on) follow.zoom = Math.min(Math.max(follow.zoom * Math.exp(e.deltaY * 0.0012), 0.5), 3);
    else { cam.r = Math.min(Math.max(cam.r * Math.exp(e.deltaY * 0.0012), 6), 40); cam.auto = false; }
    dirty = true;
  }, { passive: false });

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const c = camera();
    const th = Math.tan(c.fov / 2);
    const dir = v3.norm(v3.add(v3.scale(c.view.z, -1),
      v3.add(v3.scale(c.view.x, nx * th * c.aspect), v3.scale(c.view.y, ny * th))));
    if (dir[1] >= -1e-4) return;
    const t = -c.eye[1] / dir[1];
    const pos = worldToPos(c.eye[0] + dir[0] * t, c.eye[2] + dir[2] * t);
    selected = pos === selected ? null : pos;
    dirty = true;
    api.onSpace?.(selected);
  }
  api.select = (pos) => { selected = pos; dirty = true; };
  /** Place the camera (theta = turn around the board, phi = tilt, r = distance). */
  api.setCamera = ({ theta = cam.theta, phi = cam.phi, r = cam.r, target = cam.target } = {}) => {
    Object.assign(cam, { theta, phi: Math.min(Math.max(phi, 0.35), 1.5), r, target, auto: false });
    dirty = true;
  };

  // ----- state sync & animation
  function placeToken(id, t) {
    const [x, z] = slotWorld(t.pos, t.slot, t.inJail);
    t.x = x; t.z = z; t.lift = 0;
  }

  let diceShown = false;
  api.sync = (next) => {
    state = next;
    buildAnims.clear(); // the new state now holds the finished buildings
    if (!diceShown && next.dice && !animating) {
      // first look at a game in progress: show the last roll
      next.dice.forEach((v, i) => { dice[i].q = quat.mul(quat.axis([0, 1, 0], i ? 0.5 : -0.3), FACE_UP[v]); });
      diceShown = true;
    }
    const key = JSON.stringify(next.props) + next.players.map((p) => p.id + colorOf(p.id)).join();
    if (key !== texKey) {
      texKey = key;
      texCtx.state = next;
      drawBoardTexture(boardCanvas, texCtx);
      uploadTexture(boardTex, boardCanvas);
    }
    next.players.forEach((p, j) => {
      let t = tokens.get(p.id);
      if (!t) { t = { pos: p.pos, inJail: p.inJail, slot: j, yaw: SIDE_YAW[sideOf(p.pos)] }; tokens.set(p.id, t); }
      t.color = hexToRgb(colorOf(p.id));
      t.slot = j;
      t.visible = !p.bankrupt;
      if (!animating) { t.pos = p.pos; t.inJail = p.inJail; placeToken(p.id, t); }
    });
    dirty = true;
  };

  async function hop(t, toPos, toJail, seconds, height) {
    const [ax, az] = [t.x, t.z];
    const [bx, bz] = slotWorld(toPos, t.slot, toJail);
    if (Math.hypot(bx - ax, bz - az) > 0.05) {
      const want = Math.atan2(bx - ax, bz - az);
      const from = t.yaw ?? want;
      const turn = t.yaw;
      t.yaw = turn === undefined ? want : from;
      const yaw0 = t.yaw;
      const fn = (k) => { t.yaw = lerpAngle(yaw0, want, Math.min(1, k * 2.5)); };
      t._turn = fn;
    }
    const turnFn = t._turn;
    t._turn = null;
    await tween(seconds, (k) => {
      const e = easeInOut(k);
      t.x = lerp(ax, bx, e); t.z = lerp(az, bz, e);
      t.lift = height * Math.sin(Math.PI * k);
      turnFn?.(k);
    });
    t.pos = toPos; t.inJail = toJail; t.lift = 0;
  }

  async function rollDice(values, speed) {
    const dur = 1.25 / speed;
    const throwFrom = [cam.theta, Math.random() < 0.5 ? -1 : 1];
    const plans = values.map((v, i) => {
      const side = i === 0 ? -1 : 1;
      const end = [side * (0.42 + Math.random() * 0.25), DIE / 2, (Math.random() - 0.5) * 0.7 + side * 0.15];
      // throw from the viewer's side of the table
      const back = 4.2;
      const start = [
        end[0] + Math.sin(throwFrom[0]) * back + throwFrom[1] * 0.8,
        2.4 + i * 0.3,
        end[2] + Math.cos(throwFrom[0]) * back,
      ];
      const finalQ = quat.mul(quat.axis([0, 1, 0], Math.random() * Math.PI * 2), FACE_UP[v]);
      const axis = v3.norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
      return { start, end, finalQ, axis, spin: (3 + Math.random() * 2) * Math.PI * 2 };
    });
    await tween(dur, (t) => {
      const e = easeOut(t);
      plans.forEach((pl, i) => {
        const d = dice[i];
        const bounce = 2.2 * (1 - t) ** 2 * Math.abs(Math.cos(2.6 * Math.PI * t));
        d.p = [lerp(pl.start[0], pl.end[0], e), DIE / 2 + Math.max(bounce, 0) * (t < 0.08 ? 1 : 1), lerp(pl.start[2], pl.end[2], e)];
        if (t === 1) d.p[1] = DIE / 2;
        d.q = quat.mul(pl.finalQ, quat.axis(pl.axis, pl.spin * (1 - e)));
      });
    });
    plans.forEach((pl, i) => { dice[i].p = pl.end; dice[i].q = pl.finalQ; });
    diceShown = true;
  }

  function nlerp(a, b, t) {
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = dot < 0 ? -1 : 1;
    const q = a.map((v, i) => lerp(v, b[i] * s, t));
    const l = Math.hypot(...q) || 1;
    return q.map((v) => v / l);
  }

  /** Lift the top card off its pile, hold it up to the camera, then tuck it under the pile. */
  async function drawCardAnim(ev, speed) {
    const pl = PILE[ev.deck];
    if (!pl) return api.onCard?.(ev, speed);
    const n = Math.max(state?.deckSizes?.[ev.deck] ?? 16, 1);
    const start = [pl.at[0], n * CARD_T, pl.at[1]];
    const q0 = quat.axis([0, 1, 0], pl.yaw);
    // Face the camera: yaw to the camera's side, then tilt the face up towards it.
    const q1 = quat.mul(quat.axis([0, 1, 0], cam.theta), quat.axis([1, 0, 0], Math.PI / 2 - cam.phi));
    const look = [Math.sin(cam.theta), 0, Math.cos(cam.theta)];
    const end = [look[0] * 1.6, 2.3, 0.35 + look[2] * 1.6];
    flying = { deck: ev.deck, p: start, q: q0 };
    await tween(0.7 / speed, (t) => {
      const e = easeInOut(t);
      flying.p = [lerp(start[0], end[0], e), lerp(start[1], end[1], e) + Math.sin(Math.PI * t) * 0.6, lerp(start[2], end[2], e)];
      flying.q = nlerp(q0, quat.mul(q1, quat.axis([0, 0, 1], (1 - e) * 0.4)), e);
    });
    await api.onCard?.(ev, speed);
    const back = flying.p;
    const qb = flying.q;
    await tween(0.35 / speed, (t) => {
      const e = easeInOut(t);
      flying.p = [lerp(back[0], start[0], e), lerp(back[1], 0.01, e), lerp(back[2], start[2], e)];
      flying.q = nlerp(qb, q0, e);
    });
    flying = null;
    dirty = true;
  }

  /** Animate a batch of engine events. Resolves when done. */
  api.play = async (events, next, speed = 1) => {
    if (!state || document.hidden || !events?.length) return;
    if (next?.deckSizes) state = { ...state, deckSizes: state.deckSizes ?? next.deckSizes };
    animating = true;
    try {
      for (const ev of events) {
        const t = tokens.get(ev.player);
        if (ev.type === 'roll') {
          if (follow.on) { follow.id = ev.player; follow.focus = 'dice'; }
          await rollDice(ev.dice, speed);
          await tween(0.15 / speed, () => {});
          follow.focus = 'token';
        } else if (ev.type === 'move' && t) {
          const n = Math.abs(ev.steps);
          const dir = Math.sign(ev.steps) || 1;
          const per = (n > 12 ? 0.075 : 0.17) / speed;
          let pos = ev.from;
          if (t.pos !== ev.from || t.inJail) { t.pos = ev.from; t.inJail = false; placeToken(ev.player, t); }
          if (follow.on) { follow.id = ev.player; follow.focus = 'token'; }
          // light up every square of the move, then walk it
          const cells = [];
          for (let s = 0, q = pos; s < n; s++) { q = (q + dir + 40) % 40; cells.push(q); }
          path = { id: ev.player, cells, passed: 0, color: t.color, alpha: 0 };
          landing = { pos: cells[cells.length - 1], color: t.color, alpha: 0 };
          landingFade++;
          const myLanding = landing;
          showBadge(n, t.color);
          await tween((n > 12 ? 0.25 : 0.45) / speed, (k) => { path.alpha = k; myLanding.alpha = k; });
          for (let s = 0; s < n; s++) {
            pos = (pos + dir + 40) % 40;
            await hop(t, pos, false, per, 0.42);
            path.passed = s; // the square it's standing on keeps glowing until it lands
            showBadge(n - s - 1, t.color);
          }
          path.passed = n - 1;
          badge.hidden = true;
          await tween(0.6 / speed, (k) => { path.alpha = 1 - k; });
          path = null;
          // keep the landing square lit a little longer, without holding up the game
          const fadeId = landingFade;
          tween(1.4 / speed, () => {}).then(() => tween(0.7 / speed, (k) => {
            if (landingFade === fadeId && landing === myLanding) myLanding.alpha = 1 - k;
          })).then(() => { if (landingFade === fadeId && landing === myLanding) landing = null; });
        } else if (ev.type === 'go_to_jail' && t) {
          if (follow.on) follow.id = ev.player;
          await hop(t, 10, true, 0.75 / speed, 2.2);
        } else if (ev.type === 'jail_release' && t) {
          await hop(t, 10, false, 0.3 / speed, 0.5);
        } else if (ev.type === 'built' || ev.type === 'sold_building') {
          const to = ev.level;
          const from = ev.type === 'built' ? to - 1 : to + 1;
          const anim = { from, to, t: 0 };
          buildAnims.set(ev.pos, anim);
          await tween((ev.type === 'built' ? (to === 5 ? 1.1 : 0.75) : 0.55) / speed, (t) => { anim.t = t; });
        } else if (ev.type === 'card') {
          await drawCardAnim(ev, speed);
        }
        // Let the page show what this event did (money changes etc.) as it happens.
        api.onEvent?.(ev);
        if (MONEY_EVENTS.has(ev.type)) await tween(0.5 / speed, () => {});
      }
    } finally {
      animating = false;
      path = null;
      badge.hidden = true;
      follow.id = null;
      follow.focus = 'token';
      dirty = true;
    }
  };

  function showBadge(n, color) {
    if (n <= 0) { badge.hidden = true; return; }
    badge.textContent = String(n);
    badge.style.setProperty('--c', `rgb(${color.map((c) => Math.round(c * 255)).join(',')})`);
    badge.title = `${n} step${n === 1 ? '' : 's'} to go`;
    badge.hidden = false;
    placeBadge();
  }

  /** Where a player's token is on screen (CSS px inside the canvas), or null. */
  api.screenPos = (id, height = 0.95) => {
    const t = tokens.get(id);
    if (!t || !t.visible) return null;
    const c = camera();
    const m = mul4(c.proj, c.view.m);
    const p = [t.x, t.lift + height, t.z];
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0) return null;
    return { x: (x / w * 0.5 + 0.5) * canvas.clientWidth, y: (1 - (y / w * 0.5 + 0.5)) * canvas.clientHeight };
  };

  api.destroy = () => {
    cancelAnimationFrame(rafId);
    ro.disconnect();
  };
  api.render = () => { dirty = true; };
  api.resetView();
  return api;
}

export const _internals = { worldToPos, slotWorld, frameToWorld, frameRect, L, C, W };
