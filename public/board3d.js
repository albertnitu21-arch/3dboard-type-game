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
import { bgByKey, drawTableTile } from './backgrounds.js';
import { sfx } from './sounds.js';
import { v3, quat, trs, mul4, perspective, ortho, lookAt, lerp, easeOut, easeInOut, hexToRgb, normalMat, xformPoint } from './math3d.js';
import { boxGeo, latheGeo, roofGeo, planeGeo, sphereGeo, cylGeo, coneGeo, torusGeo, rboxGeo, discGeo, merge } from './geometry.js';
import { TEXTURES } from './textures.js';
import { SCENES, DEFAULT_LIGHT } from './scenes.js';

const MONEY_EVENTS = new Set(['pay', 'pass_start', 'gain', 'bought', 'auction_won', 'built', 'sold_building', 'mortgaged', 'unmortgaged', 'trade_done']);

const L = 11;          // board size
const C = 1.5;         // corner size
const W = (L - 2 * C) / 9; // edge cell width
const BAND = 0.26;     // colour band depth
const TEX = 2048;      // board texture size (px)
const PX = TEX / L;    // px per unit
const DIE = 0.62;      // die edge length

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
    // shrink long names until every line fits (max 3 lines)
    let size = 0.105;
    let lines;
    for (;;) {
      g.font = `700 ${size * u}px ${FONT}`;
      lines = wrap(g, sp.name.toUpperCase(), w * 0.88);
      const fits = lines.length <= 3 && lines.every((ln) => g.measureText(ln).width <= w * 0.9);
      if (fits || size <= 0.07) break;
      size -= 0.005;
    }
    lines.slice(0, 3).forEach((ln, n) => g.fillText(ln, (x0 + x1) / 2, y + 0.08 * u + n * size * 1.19 * u));
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
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // the title in the middle of the board, sized to fit between the card piles
  const title = ['GURTPOLY'];
  let ts = 1.5;
  g.font = `900 ${ts * PX}px ${FONT}`;
  while (title.some((t) => g.measureText(t).width > 6.4 * PX) && ts > 0.5) {
    ts -= 0.05;
    g.font = `900 ${ts * PX}px ${FONT}`;
  }
  title.forEach((t, i) => g.fillText(t, 0, (i - (title.length - 1) / 2) * ts * 1.02 * PX));
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
attribute vec3 aPos; attribute vec3 aNor; attribute vec2 aUv; attribute vec3 aCol;
uniform mat4 uVP; uniform mat4 uModel; uniform mat3 uNormal; uniform mat4 uLVP; uniform float uShadowOn;
varying vec3 vN; varying vec2 vUv; varying vec3 vW; varying vec3 vCol; varying vec4 vL;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz;
  vN = uNormal * aNor;
  vUv = aUv;
  vCol = aCol;
  // shadow lookup position, nudged along the normal so surfaces don't shadow themselves
  vL = uShadowOn > 0.5 ? uLVP * vec4(w.xyz + normalize(vN) * 0.04, 1.0) : vec4(0.0);
  gl_Position = uVP * w;
}`;
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vN; varying vec2 vUv; varying vec3 vW; varying vec3 vCol; varying vec4 vL;
uniform sampler2D uTex; uniform float uUseTex; uniform vec4 uColor;
uniform float uLit; uniform float uSpec; uniform vec3 uLight; uniform vec3 uEye; uniform vec2 uFade;
uniform vec3 uSky; uniform vec3 uGround; uniform vec3 uSun;
uniform vec3 uPointPos; uniform vec3 uPointCol; uniform float uPointRange;
uniform sampler2D uShadow; uniform float uShadowOn; uniform float uTexel; uniform float uBias;
uniform vec3 uFogCol; uniform vec2 uFog; uniform float uAlphaTest; uniform float uEmit; uniform vec4 uRim;
float unpack(vec4 c) { return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }
float shadowAt(vec3 p, float ndl) {
  float bias = uBias * (1.0 + 3.0 * (1.0 - ndl));
  if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
  float s = 0.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      float d = unpack(texture2D(uShadow, p.xy + vec2(float(i), float(j)) * uTexel * 1.6));
      s += p.z - bias > d ? 0.0 : 1.0;
    }
  }
  return s / 9.0;
}
void main() {
  vec4 c = uColor * vec4(vCol, 1.0);
  if (uUseTex > 0.5) c *= texture2D(uTex, vUv);
  if (c.a < uAlphaTest) discard;
  if (uFade.y > 0.0) c.a *= 1.0 - smoothstep(uFade.x, uFade.y, length(vW.xz));
  if (uLit > 0.5) {
    vec3 n = normalize(vN);
    vec3 v = normalize(uEye - vW);
    if (dot(n, v) < -0.05) n = -n; // thin things (leaves, curtains) are lit on both sides
    float d = max(dot(n, uLight), 0.0);
    float sh = 1.0;
    if (uShadowOn > 0.5 && d > 0.0) sh = shadowAt(vL.xyz / vL.w * 0.5 + 0.5, d);
    vec3 light = mix(uGround, uSky, n.y * 0.5 + 0.5) + uSun * d * sh;
    if (uPointRange > 0.0) {
      vec3 L = uPointPos - vW;
      float dist = length(L);
      float att = clamp(1.0 - dist / uPointRange, 0.0, 1.0);
      light += uPointCol * att * att * (0.35 + 0.65 * max(dot(n, L / dist), 0.0));
    }
    vec3 h = normalize(uLight + v);
    float spec = pow(max(dot(n, h), 0.0), 48.0) * uSpec * sh;
    c.rgb = c.rgb * light + spec * uSun * 1.9;
    // soft glow along the edges (used for the player pieces)
    if (uRim.a > 0.0) c.rgb += uRim.rgb * pow(1.0 - max(dot(n, v), 0.0), 2.2) * uRim.a;
  }
  c.rgb *= 1.0 + uEmit;
  if (uFog.y > 0.0) c.rgb = mix(c.rgb, uFogCol, smoothstep(uFog.x, uFog.y, length(vW - uEye)) * 0.85);
  gl_FragColor = c;
}`;
// depth from the sun's point of view, packed into a colour texture
const SVS = `
attribute vec3 aPos; attribute vec2 aUv;
uniform mat4 uLVP; uniform mat4 uModel;
varying float vD; varying vec2 vUv;
void main() {
  vec4 p = uLVP * uModel * vec4(aPos, 1.0);
  vD = p.z / p.w * 0.5 + 0.5;
  vUv = aUv;
  gl_Position = p;
}`;
const SFS = `
precision highp float;
varying float vD; varying vec2 vUv;
uniform sampler2D uTex; uniform float uAlphaTest;
void main() {
  if (uAlphaTest > 0.0 && texture2D(uTex, vUv).a < uAlphaTest) discard;
  vec4 e = fract(vD * vec4(1.0, 255.0, 65025.0, 16581375.0));
  e -= e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  gl_FragColor = e;
}`;

const isPOT = (n) => (n & (n - 1)) === 0;
/** WebGL 1 can only repeat and mipmap power-of-two textures: resize others. */
function toPOT(cnv) {
  if (isPOT(cnv.width) && isPOT(cnv.height)) return cnv;
  const up = (n) => 2 ** Math.round(Math.log2(n));
  const c = document.createElement('canvas');
  c.width = Math.min(2048, up(cnv.width)); c.height = Math.min(2048, up(cnv.height));
  c.getContext('2d').drawImage(cnv, 0, 0, c.width, c.height);
  return c;
}

export function createBoard3D(canvas, { board, groups, colorOf, nameOf, pieceOf = pieceFor }) {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false })
    || canvas.getContext('experimental-webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
  if (!gl) return null;

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const link = (vs, fs, attribs) => {
    const pr = gl.createProgram();
    gl.attachShader(pr, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, fs));
    attribs.forEach((name, i) => { if (name) gl.bindAttribLocation(pr, i, name); });
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    return pr;
  };
  const A = { pos: 0, nor: 1, uv: 2, col: 3 };
  const prog = link(VS, FS, ['aPos', 'aNor', 'aUv', 'aCol']);
  gl.useProgram(prog);
  const U = {};
  for (const n of ['uVP', 'uModel', 'uNormal', 'uTex', 'uUseTex', 'uColor', 'uLit', 'uSpec', 'uLight', 'uEye', 'uFade',
    'uSky', 'uGround', 'uSun', 'uPointPos', 'uPointCol', 'uPointRange', 'uShadow', 'uShadowOn', 'uTexel', 'uLVP',
    'uFogCol', 'uFog', 'uAlphaTest', 'uEmit', 'uBias', 'uRim']) U[n] = gl.getUniformLocation(prog, n);
  gl.enable(gl.DEPTH_TEST);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const uintIdx = gl.getExtension('OES_element_index_uint');

  // Real shadows: the scene is drawn once from the sun into a depth texture.
  // Needs high precision in fragment shaders (most phones have it).
  const hp = gl.getShaderPrecisionFormat?.(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  let shadow = null;
  if (hp && hp.precision > 0) {
    try {
      const sprog = link(SVS, SFS, ['aPos', null, 'aUv']);
      const SU = {};
      for (const n of ['uLVP', 'uModel', 'uTex', 'uAlphaTest']) SU[n] = gl.getUniformLocation(sprog, n);
      const coarse = matchMedia?.('(pointer: coarse)').matches;
      const size = Math.min(coarse ? 1024 : 2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, size, size);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (ok) shadow = { prog: sprog, U: SU, tex, fbo, size, lvp: null };
    } catch (err) {
      console.warn('No shadows:', err);
    }
    gl.useProgram(prog);
  }
  gl.uniform1i(U.uTex, 0);
  gl.uniform1i(U.uShadow, 1);

  const mesh = (geo) => {
    const buf = (data, T = Float32Array, target = gl.ARRAY_BUFFER) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, new T(data), gl.STATIC_DRAW);
      return b;
    };
    const big = geo.pos.length / 3 > 65535 && uintIdx;
    return {
      pos: buf(geo.pos), nor: buf(geo.nor), uv: buf(geo.uv), col: geo.col ? buf(geo.col) : null,
      idx: buf(geo.idx, big ? Uint32Array : Uint16Array, gl.ELEMENT_ARRAY_BUFFER), count: geo.idx.length,
      type: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    };
  };
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  const texture = (cnv, repeat = false) => {
    const t = gl.createTexture();
    uploadTexture(t, cnv, repeat);
    return t;
  };
  function uploadTexture(t, cnv, repeat = false) {
    cnv = toPOT(cnv);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cnv);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
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
  const glowTex = texture(radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'));
  const haloTex = texture((() => {
    // a soft round glow that fades out smoothly (roughly a Gaussian)
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = 128;
    const g = cnv.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (let i = 0; i <= 10; i++) { const r = i / 10; grad.addColorStop(r, `rgba(255,255,255,${(Math.exp(-r * r * 4.5) - Math.exp(-4.5)).toFixed(3)})`); }
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    return cnv;
  })());
  // the table under the board: a repeating tile, one tile every 6 units
  const TABLE = 90;
  let background = bgByKey('classic');
  const tableTex = texture(drawTableTile(background), true);
  const GLOW_PAD = 0.14; // world units the glow spills past the square
  const glowEdgeTex = texture(glowTexture(256, 512, [GLOW_PAD / (W + 2 * GLOW_PAD), GLOW_PAD / (C + 2 * GLOW_PAD)]));
  const glowCornerTex = texture(glowTexture(512, 512, [GLOW_PAD / (C + 2 * GLOW_PAD), GLOW_PAD / (C + 2 * GLOW_PAD)]));

  // Scenery textures are painted on demand, one per tick, so switching scenes never
  // freezes the page; until one is ready its average colour stands in.
  const sceneTex = new Map(); // name -> { tex, ready }
  const texQueue = [];
  let texTimer = 0;
  const solid = (rgb) => { const c = document.createElement('canvas'); c.width = c.height = 4; const g = c.getContext('2d'); g.fillStyle = `rgb(${rgb.join(',')})`; g.fillRect(0, 0, 4, 4); return c; };
  function paintNextTexture() {
    texTimer = 0;
    const name = texQueue.shift();
    const e = name && sceneTex.get(name);
    if (e && !e.ready) {
      try { uploadTexture(e.tex, TEXTURES[name].make(), TEXTURES[name].tile); } catch (err) { console.warn('texture', name, err); }
      e.ready = true;
      dirty = true;
    }
    if (texQueue.length) texTimer = setTimeout(paintNextTexture, 0);
  }
  function sceneTexture(name) {
    let e = sceneTex.get(name);
    if (!e) {
      const def = TEXTURES[name];
      if (!def) throw new Error(`no texture ${name}`);
      e = { tex: texture(solid(def.avg), def.tile), ready: false };
      sceneTex.set(name, e);
      texQueue.push(name);
      if (!texTimer) texTimer = setTimeout(paintNextTexture, 0);
    }
    return e.tex;
  }
  function dropSceneTextures() {
    for (const e of sceneTex.values()) gl.deleteTexture(e.tex);
    sceneTex.clear();
    texQueue.length = 0;
  }

  const M = {
    plane: mesh(planeGeo()),
    table: mesh(planeGeo(TABLE / 6)),
    roof: mesh(roofGeo()),
    disc: mesh(discGeo(64)),
    // unit shapes for the player pieces (see pieces.js) and the scenery
    sphere: mesh(sphereGeo(40, 24)),
    half: mesh(latheGeo(Array.from({ length: 12 }, (_, i) => {
      const a = (i / 11) * (Math.PI / 2);
      return [0.5 * Math.cos(a), Math.sin(a)];
    }).concat([[0, 1]]).reverse().concat([[0, 0]]).reverse(), 40)),
    cyl: mesh(cylGeo(40)),
    cone: mesh(coneGeo(40)),
    torus: mesh(torusGeo(0.35, 0.15, 48, 18)),
    slab: mesh(rboxGeo(L, 0.3, L, 0.05, 3)),
    box: mesh(boxGeo(1, 1, 1)),
    pawn: mesh(latheGeo(pawnProfile(), 40)),
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
  // Pixels on the right covered by a floating panel: the board is centred in the rest.
  let insetRight = 0;
  let insetBottom = 0; // pixels at the bottom kept for the floating move buttons
  const lensShift = () => (canvas.clientWidth ? insetRight / canvas.clientWidth : 0);
  const lensShiftY = () => (canvas.clientHeight ? Math.min(insetBottom, canvas.clientHeight * 0.3) / canvas.clientHeight : 0);
  function fitRadius() {
    const aspect = (canvas.clientWidth - insetRight) / Math.max(canvas.clientHeight, 1);
    const fov = (38 * Math.PI) / 180;
    const th = Math.tan(fov / 2);
    const tv = th * (1 - lensShiftY()); // the part of the height not covered by the buttons
    return Math.min(Math.max((aspect < 0.8 ? 7.4 : 6.7) / (th * aspect), 5.6 / tv, 9), 40);
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
    const proj = perspective(fov, aspect, 0.5, 200);
    proj[8] = lensShift(); // shift the picture left when a panel covers the right side
    proj[9] = -lensShiftY(); // and up, clear of the move buttons at the bottom
    return { eye, view, proj, fov, aspect };
  }
  function topRadius() {
    const aspect = (canvas.clientWidth - insetRight) / Math.max(canvas.clientHeight, 1);
    const th = Math.tan((38 * Math.PI) / 360);
    return Math.min(Math.max(6.1 / (th * aspect), 6.1 / (th * (1 - lensShiftY())), 9), 40);
  }
  api.resetView = () => {
    if (follow.on) { follow.yaw = 0; follow.tilt = 0; follow.zoom = 1; dirty = true; return; }
    cam.theta = 0; cam.target = null;
    if (camMode === 'top') { cam.phi = 1.5; cam.r = topRadius(); cam.auto = true; }
    else if (camMode === 'free') { cam.phi = 0.95; cam.r = fitRadius(); cam.target = [0, 0, 0.35]; cam.auto = false; }
    else { cam.phi = 0.95; cam.r = fitRadius(); cam.auto = true; }
    dirty = true;
  };

  // ----- drawing
  let pass = 'main'; // 'shadow' while drawing the depth map from the sun
  let blending = false;
  function setBlend(on, additive = false) {
    blending = on;
    if (on) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, on && additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
  }
  /**
   * Draw a mesh. opts: lit (shading), spec (shine), cast (casts a shadow), alphaTest
   * (cut out transparent texture pixels), emit (glow brighter than the light).
   */
  function draw(m, model, color, tex = null, { lit = true, spec = 0, cast = true, alphaTest = 0, emit = 0 } = {}) {
    if (pass === 'shadow') {
      if (!cast || blending) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, m.pos); gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.uv); gl.vertexAttribPointer(A.uv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx);
      gl.uniformMatrix4fv(shadow.U.uModel, false, model);
      const at = alphaTest && tex ? alphaTest : 0;
      gl.uniform1f(shadow.U.uAlphaTest, at);
      if (at) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); }
      gl.drawElements(gl.TRIANGLES, m.count, m.type, 0);
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, m.pos); gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.nor); gl.vertexAttribPointer(A.nor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.uv); gl.vertexAttribPointer(A.uv, 2, gl.FLOAT, false, 0, 0);
    if (m.col) {
      gl.enableVertexAttribArray(A.col);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.col); gl.vertexAttribPointer(A.col, 3, gl.FLOAT, false, 0, 0);
    } else {
      gl.disableVertexAttribArray(A.col);
      gl.vertexAttrib3f(A.col, 1, 1, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx);
    gl.uniformMatrix4fv(U.uModel, false, model);
    gl.uniformMatrix3fv(U.uNormal, false, normalMat(model));
    gl.uniform4fv(U.uColor, color.length === 3 ? [color[0], color[1], color[2], 1] : color);
    gl.uniform1f(U.uUseTex, tex ? 1 : 0);
    if (tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); }
    gl.uniform1f(U.uLit, lit ? 1 : 0);
    gl.uniform1f(U.uSpec, spec);
    gl.uniform1f(U.uAlphaTest, alphaTest);
    gl.uniform1f(U.uEmit, emit);
    gl.drawElements(gl.TRIANGLES, m.count, m.type, 0);
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

  // Each piece is built once and merged into a few meshes: fixed colours, the
  // player's colour and a darker shade of it (grouped by shininess and glow).
  const PIECE_SCALE = 1.05;
  const pieceGroups = new Map();
  function pieceMesh(piece) {
    let groups = pieceGroups.get(piece.key);
    if (groups) return groups;
    const by = new Map();
    const box = { lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9] };
    for (const p of piece.build()) {
      for (let i = 0; i < p.geo.pos.length; i += 9) { // every third vertex is plenty for a bounding box
        const q = xformPoint(p.m, [p.geo.pos[i], p.geo.pos[i + 1], p.geo.pos[i + 2]]);
        for (let k = 0; k < 3; k++) { box.lo[k] = Math.min(box.lo[k], q[k]); box.hi[k] = Math.max(box.hi[k], q[k]); }
      }
      const kind = p.color === 'P' || p.color === 'D' ? p.color : 'F';
      const key = `${kind}|${p.spec}|${p.emit}`;
      if (!by.has(key)) by.set(key, { kind, spec: p.spec, emit: p.emit, parts: [] });
      by.get(key).parts.push({ geo: p.geo, m: p.m, color: kind === 'F' ? p.color : [1, 1, 1] });
    }
    groups = [...by.values()].map((g) => ({ kind: g.kind, spec: g.spec, emit: g.emit, mesh: mesh(merge(g.parts)) }));
    groups.box = box;
    pieceGroups.set(piece.key, groups);
    return groups;
  }
  const WHITE = [1, 1, 1];
  function drawPieceAt(piece, model, color, rim = 0.32) {
    const dark = color.map((c) => c * 0.62);
    if (pass === 'main') gl.uniform4f(U.uRim, color[0], color[1], color[2], rim);
    for (const g of pieceMesh(piece)) {
      // small things use soft contact shadows; the scene's shadow map is too coarse for them
      draw(g.mesh, model, g.kind === 'P' ? color : g.kind === 'D' ? dark : WHITE, null, { spec: g.spec, emit: g.emit, cast: false });
    }
    if (pass === 'main') gl.uniform4f(U.uRim, 0, 0, 0, 0);
  }
  function drawPiece(id, t) {
    const piece = pieceOf(id);
    drawPieceAt(piece, trs([t.x, t.lift, t.z], quat.axis([0, 1, 0], t.yaw ?? 0), PIECE_SCALE * (piece.scale ?? 1) * (t.cs ?? 1)), t.color);
  }
  /** A pale glow in the player's colour behind a piece, so it stands out on the board. */
  function halo(c, t, strong) {
    const size = 1.2 * PIECE_SCALE * (t.cs ?? 1);
    const z = c.view.z;
    const k = t.cs ?? 1;
    const pos = [t.x - z[0] * 0.18 * k, t.lift + 0.3 * k - z[1] * 0.18 * k, t.z - z[2] * 0.18 * k];
    const r = c.view.x, u = c.view.y;
    const m = [r[0] * size, r[1] * size, r[2] * size, 0, z[0], z[1], z[2], 0, u[0] * size, u[1] * size, u[2] * size, 0, pos[0], pos[1], pos[2], 1];
    const col = t.color.map((v) => Math.min(1, v * 0.75 + 0.3)); // lighter, so it reads as light
    draw(M.plane, m, [...col, strong ? 0.5 : 0.32], haloTex, { lit: false });
  }

  /** Direction a piece faces on each side of the board (yaw that turns +z that way). */
  const SIDE_YAW = [-Math.PI / 2, Math.PI, Math.PI / 2, 0];
  const SIDE_DIR = [[-1, 0], [0, -1], [1, 0], [0, 1]];
  const sideOf = (pos) => Math.floor(((pos % 40) + 40) % 40 / 10);
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

  // ----- scenery around the board (depends on the chosen background, see scenes.js)
  const meshCache = new Map();
  const colorCache = new Map();
  const rgb = (c) => {
    if (typeof c !== 'string') return c;
    let v = colorCache.get(c);
    if (!v) { v = hexToRgb(c); colorCache.set(c, v); }
    return v;
  };
  /** The toolkit the scenes draw with. */
  const R = {
    M, trs, quat, mul4, v3, rgb,
    yaw: (a) => quat.axis([0, 1, 0], a),
    get pass() { return pass; },
    get time() { return lastNow / 1000; },
    tex: sceneTexture,
    tableTex: () => tableTex,
    /** A mesh built once from geometry and kept. */
    mesh(key, make) {
      let m = meshCache.get(key);
      if (!m) { m = mesh(make()); meshCache.set(key, m); }
      return m;
    },
    /** Rounded box mesh of an exact size (uv: null = 0..1 per face, or tiles per unit). */
    rbox(w, h, d, r, uv = null) { return R.mesh(`rbox:${w},${h},${d},${r},${uv}`, () => rboxGeo(w, h, d, r, 4, uv)); },
    draw,
    /** put(mesh or name, position, scale, colour, { q, tex, lit, spec, cast, alphaTest, emit }) */
    put(m, at, sc, color, o = {}) {
      draw(typeof m === 'string' ? M[m] : m, trs(at, o.q, sc), rgb(color), o.tex ?? null, o);
    },
    blend: setBlend,
    glowTex,
    /** Run fn with fog switched off (sky domes, far planets). */
    withoutFog(fn) {
      const on = pass === 'main' && light.fog;
      if (on) gl.uniform2f(U.uFog, 0, 0);
      fn();
      if (on) gl.uniform2f(U.uFog, light.fog.near, light.fog.far);
    },
    /** A glowing sprite that always faces the camera (sun, lamp halos, fire). */
    glow(c, pos, size, color, alpha = 1) {
      if (pass !== 'main') return;
      const r = c.view.x, u = c.view.y, n = c.view.z;
      const m = [r[0] * size, r[1] * size, r[2] * size, 0, n[0], n[1], n[2], 0, u[0] * size, u[1] * size, u[2] * size, 0, pos[0], pos[1], pos[2], 1];
      setBlend(true, true);
      gl.depthMask(false);
      draw(M.plane, m, [...rgb(color), alpha], glowTex, { lit: false });
      gl.depthMask(true);
      setBlend(false);
    },
    fade(near = 0, far = 0) { if (pass === 'main') gl.uniform2f(U.uFade, near, far); },
    /** Soft contact shadow on the ground under something (sx x sz units). */
    blob(x, z, sx, sz = sx, alpha = 0.45, y = 0, yawA = 0) {
      if (pass !== 'main') return;
      setBlend(true);
      gl.depthMask(false);
      draw(M.plane, trs([x, y, z], quat.axis([0, 1, 0], yawA), [sx, 1, sz]), [1, 1, 1, alpha], shadowTex, { lit: false });
      gl.depthMask(true);
      setBlend(false);
    },
  };

  let light = DEFAULT_LIGHT;
  function drawBackdrop(c) {
    const scene = SCENES[background.scene];
    if (scene) { scene.draw(R, c); return; }
    // flat backgrounds: an endless table that fades into the sky
    if (pass === 'shadow') return;
    setBlend(true);
    gl.uniform2f(U.uFade, 16, 34);
    draw(M.table, trs([0, -0.31, 0], undefined, [TABLE, 1, TABLE]), [1, 1, 1], tableTex, { cast: false });
    gl.uniform2f(U.uFade, 0, 0);
    setBlend(false);
  }

  /** Pieces sharing a square shrink a little so they don't bump into each other. */
  function updateCrowding() {
    const count = new Map();
    const where = (t) => `${t.pos}|${t.inJail ? 1 : 0}`;
    for (const t of tokens.values()) if (t.visible && t.lift < 0.05) count.set(where(t), (count.get(where(t)) ?? 0) + 1);
    for (const t of tokens.values()) {
      const n = t.lift < 0.05 ? count.get(where(t)) ?? 1 : 1;
      const want = n <= 1 ? 1 : n === 2 ? 0.9 : n <= 4 ? 0.8 : 0.72;
      t.cs = t.cs ?? want;
      if (Math.abs(t.cs - want) > 0.004) { t.cs += (want - t.cs) * 0.2; dirty = true; } else t.cs = want;
    }
  }

  /** Everything solid: scenery, board, buildings, pieces, dice, card piles. */
  function drawOpaque(c) {
    drawBackdrop(c);
    draw(M.slab, trs([0, -0.15, 0]), [0.16, 0.2, 0.17], null, { spec: 0.15 });
    draw(M.plane, trs([0, 0.001, 0], undefined, [L, 1, L]), [1, 1, 1], boardTex, { cast: false, spec: 0.04 });
    const buildings = buildingList();
    for (const b of buildings) {
      if (b.s <= 0.01) continue;
      const q = quat.axis([0, 1, 0], b.yaw);
      const sc = (v) => v.map((x) => x * b.s);
      const y = (v) => v * b.s + b.dy;
      if (b.hotel) {
        draw(M.box, trs([b.at[0], y(0.085), b.at[1]], q, sc([0.44, 0.17, 0.18])), [0.8, 0.2, 0.16], null, { spec: 0.25, cast: false });
        draw(M.roof, trs([b.at[0], y(0.17), b.at[1]], q, sc([0.47, 0.09, 0.2])), [0.58, 0.12, 0.1], null, { spec: 0.2, cast: false });
        draw(M.box, trs([b.at[0], y(0.085), b.at[1]], q, sc([0.08, 0.1, 0.185])), [0.95, 0.88, 0.62], null, { spec: 0.1, cast: false });
      } else {
        draw(M.box, trs([b.at[0], y(0.055), b.at[1]], q, sc([0.15, 0.11, 0.15])), [0.2, 0.64, 0.34], null, { spec: 0.25, cast: false });
        draw(M.roof, trs([b.at[0], y(0.11), b.at[1]], q, sc([0.175, 0.08, 0.17])), [0.11, 0.42, 0.22], null, { spec: 0.2, cast: false });
      }
    }
    for (const [id, t] of tokens) {
      if (!t.visible) continue;
      drawPiece(id, t);
    }
    for (const d of dice) draw(M.die, trs(d.p, d.q), [1, 1, 1], diceTex, { spec: 0.35, cast: false });
    for (const deck of ['fortune', 'community']) {
      const n = Math.max(state?.deckSizes?.[deck] ?? 16, 1) - (flying?.deck === deck ? 1 : 0);
      if (n <= 0) continue;
      const h = n * CARD_T;
      const pl = PILE[deck];
      draw(M.card[deck], trs([pl.at[0], h / 2, pl.at[1]], quat.axis([0, 1, 0], pl.yaw), [CARD_W, h, CARD_D]), [1, 1, 1], cardTex, { spec: 0.15, cast: false });
    }
    if (flying) draw(M.card[flying.deck], trs(flying.p, flying.q, [CARD_W, CARD_T * 1.5, CARD_D]), [1, 1, 1], cardTex, { spec: 0.3, cast: false });
    return buildings;
  }

  /** Point the sun's depth camera at the scene. */
  function shadowCamera(scene) {
    const reg = scene?.shadow ?? { center: [0, 0, 0], radius: 9 };
    const Ld = v3.norm(light.dir);
    const r = reg.radius;
    const eye = v3.add(reg.center, v3.scale(Ld, r * 2));
    const lv = lookAt(eye, reg.center, Math.abs(Ld[1]) > 0.98 ? [0, 0, -1] : [0, 1, 0]);
    return { lvp: mul4(ortho(-r, r, -r, r, 0.1, r * 4), lv.m), range: r * 4 };
  }

  function render() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const c = camera();
    const scene = SCENES[background.scene];
    light = scene?.light ?? DEFAULT_LIGHT;
    const useShadow = !!shadow && light.shadows !== false;

    if (useShadow) {
      const sc = shadowCamera(scene);
      shadow.lvp = sc.lvp;
      shadow.range = sc.range;
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.fbo);
      gl.viewport(0, 0, shadow.size, shadow.size);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(shadow.prog);
      gl.uniformMatrix4fv(shadow.U.uLVP, false, shadow.lvp);
      gl.disableVertexAttribArray(A.nor);
      gl.disableVertexAttribArray(A.col);
      gl.enableVertexAttribArray(A.pos);
      gl.enableVertexAttribArray(A.uv);
      setBlend(false);
      gl.depthMask(true);
      pass = 'shadow';
      try { drawOpaque(c); } finally { pass = 'main'; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(prog);
    }

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); // the sky behind is the page's CSS background
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enableVertexAttribArray(A.pos);
    gl.enableVertexAttribArray(A.nor);
    gl.enableVertexAttribArray(A.uv);
    gl.uniformMatrix4fv(U.uVP, false, mul4(c.proj, c.view.m));
    gl.uniform3fv(U.uEye, c.eye);
    gl.uniform3fv(U.uLight, v3.norm(light.dir));
    gl.uniform3fv(U.uSky, light.sky);
    gl.uniform3fv(U.uGround, light.ground);
    gl.uniform3fv(U.uSun, light.sun);
    if (light.point) {
      gl.uniform3fv(U.uPointPos, light.point.pos);
      gl.uniform3fv(U.uPointCol, light.point.col);
      gl.uniform1f(U.uPointRange, light.point.range);
    } else gl.uniform1f(U.uPointRange, 0);
    if (light.fog) {
      gl.uniform3fv(U.uFogCol, light.fog.col);
      gl.uniform2f(U.uFog, light.fog.near, light.fog.far);
    } else gl.uniform2f(U.uFog, 0, 0);
    gl.uniform2f(U.uFade, 0, 0);
    gl.uniform1f(U.uShadowOn, useShadow ? 1 : 0);
    if (useShadow) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, shadow.tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniformMatrix4fv(U.uLVP, false, shadow.lvp);
      gl.uniform1f(U.uTexel, 1 / shadow.size);
      gl.uniform1f(U.uBias, 0.03 / shadow.range);
    }
    setBlend(false);
    gl.depthMask(true);
    updateCrowding();
    const buildings = drawOpaque(c);
    const blobK = 1; // pieces, dice and houses only have these soft contact shadows

    // transparent: shadows, rings, selection
    setBlend(true);
    gl.depthMask(false);
    for (const [id, t] of tokens) {
      if (!t.visible) continue;
      const s = 0.42 * (1 + t.lift * 0.4);
      draw(M.plane, trs([t.x + 0.03, 0.003, t.z + 0.03], undefined, [s, 1, s]), [1, 1, 1, blobK / (1 + t.lift * 1.5)], shadowTex, { lit: false });
    }
    // pale glow around each piece (a little brighter for whoever's turn it is)
    setBlend(true, true);
    const current = state && !state.winner ? state.players[state.current]?.id : null;
    for (const [id, t] of tokens) if (t.visible) halo(c, t, id === current);
    setBlend(true);
    for (const d of dice) {
      const s = DIE * 1.6 * (1 + (d.p[1] - DIE / 2) * 0.35);
      draw(M.plane, trs([d.p[0] + 0.06, 0.003, d.p[2] + 0.06], undefined, [s, 1, s]), [1, 1, 1, 0.9 * blobK / (1 + (d.p[1] - DIE / 2) * 0.8)], shadowTex, { lit: false });
    }
    for (const b of buildings) {
      if (b.s <= 0.01) continue;
      const w = (b.hotel ? 0.62 : 0.26) * b.s * (1 + b.dy * 0.5);
      draw(M.plane, trs([b.at[0] + 0.03, 0.0025, b.at[1] + 0.03], quat.axis([0, 1, 0], b.yaw), [w, 1, w * (b.hotel ? 0.5 : 1)]), [1, 1, 1, 0.55 * blobK / (1 + b.dy * 2)], shadowTex, { lit: false });
    }
    for (const deck of ['fortune', 'community']) {
      const pl = PILE[deck];
      draw(M.plane, trs([pl.at[0] + 0.05, 0.002, pl.at[1] + 0.05], quat.axis([0, 1, 0], pl.yaw), [CARD_W * 1.25, 1, CARD_D * 1.35]), [1, 1, 1, 0.45 * blobK], shadowTex, { lit: false });
    }
    if (landing && landing.alpha > 0.02) {
      const pos = landing.pos;
      const k = sideOf(pos), corner = pos % 10 === 0;
      const [x0, y0, x1, y1] = frameRect(pos % 10);
      const [cx, cz] = cellCenter(pos);
      const q = quat.axis([0, 1, 0], (-k * Math.PI) / 2);
      const pulse = 0.85 + 0.15 * Math.sin(lastNow / 160);
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
    setBlend(false);
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
  /**
   * Camera modes:
   *   overview  whole board, gentle orbit
   *   top       straight down, like a map
   *   follow    third-person camera behind the active player
   *   free      fly anywhere: orbit, pan, zoom, WASD
   */
  const MODES = ['overview', 'top', 'follow', 'free'];
  let camMode = 'overview';
  api.setMode = (mode) => {
    if (!MODES.includes(mode)) mode = 'overview';
    const from = camMode;
    camMode = mode;
    follow.on = mode === 'follow';
    follow.yaw = 0; follow.tilt = 0; follow.zoom = 1;
    canvas.style.touchAction = mode === 'free' ? 'none' : 'pan-y';
    if (mode === 'free') {
      // start flying from wherever the camera is now
      cam.target = cam.target ?? [0, 0, 0.35];
      cam.auto = false;
      if (from !== 'free') showHint();
    } else if (mode !== 'follow') {
      api.resetView();
    } else {
      cam.auto = false;
    }
    dirty = true;
  };
  api.mode = () => camMode;

  // ----- free cam controls
  const keys = new Set();
  const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'r', 'f', '+', '-', '=']);
  addEventListener('keydown', (e) => {
    if (camMode !== 'free' || typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (!FLY_KEYS.has(k) || !canvas.offsetParent) return;
    keys.add(k);
    e.preventDefault();
    dirty = true;
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());

  const clampTarget = (t) => [Math.min(Math.max(t[0], -9), 9), Math.min(Math.max(t[1], 0), 4), Math.min(Math.max(t[2], -9), 9)];
  function panBy(right, forward) {
    const t = cam.target ?? [0, 0, 0.35];
    const r = [Math.cos(cam.theta), 0, -Math.sin(cam.theta)];
    const f = [-Math.sin(cam.theta), 0, -Math.cos(cam.theta)];
    cam.target = clampTarget([t[0] + r[0] * right + f[0] * forward, t[1], t[2] + r[2] * right + f[2] * forward]);
  }
  function flyKeys(dt) {
    if (camMode !== 'free' || !keys.size) return false;
    const speed = 3.2 * Math.max(0.6, cam.r / 9) * dt;
    const has = (...k) => k.some((x) => keys.has(x));
    let fwd = 0, side = 0;
    if (has('w', 'arrowup')) fwd += speed;
    if (has('s', 'arrowdown')) fwd -= speed;
    if (has('d', 'arrowright')) side += speed;
    if (has('a', 'arrowleft')) side -= speed;
    if (fwd || side) panBy(side, fwd);
    if (has('q')) cam.theta += 1.6 * dt;
    if (has('e')) cam.theta -= 1.6 * dt;
    if (has('r')) cam.phi = Math.min(cam.phi + 0.9 * dt, 1.5);
    if (has('f')) cam.phi = Math.max(cam.phi - 0.9 * dt, 0.12);
    if (has('+', '=')) cam.r = Math.max(cam.r * (1 - 1.2 * dt), 2.5);
    if (has('-')) cam.r = Math.min(cam.r * (1 + 1.2 * dt), 40);
    return true;
  }

  // a short hint the first moments of free cam
  const hint = document.createElement('div');
  hint.className = 'cam-hint';
  hint.hidden = true;
  canvas.parentElement?.append(hint);
  let hintTimer = 0;
  function showHint() {
    const touch = matchMedia?.('(pointer: coarse)').matches;
    hint.textContent = touch
      ? '1 finger: look around · 2 fingers: zoom & move · double-tap: go there'
      : 'Drag: look · Right-drag / Shift-drag: move · Scroll: zoom · WASD/arrows: fly · Q/E: turn · R/F: tilt · Double-click: go there';
    hint.hidden = false;
    hint.classList.remove('fade');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.add('fade'), 5500);
    setTimeout(() => { if (hint.classList.contains('fade')) hint.hidden = true; }, 7000);
  }

  /** Glide the free camera's focus to a point on the board. */
  function glideTo(x, z) {
    const from = cam.target ?? [0, 0, 0.35];
    const to = clampTarget([x, 0, z]);
    const r0 = cam.r, r1 = Math.min(cam.r, 7);
    tween(0.6, (k) => {
      const e = easeInOut(k);
      cam.target = from.map((v, i) => lerp(v, to[i], e));
      cam.r = lerp(r0, r1, e);
    });
  }

  let rafId = 0;
  let lastAnim = 0;
  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - (lastNow || now)) / 1000);
    lastNow = now;
    if (follow.on && updateFollow(dt)) dirty = true;
    if (flyKeys(dt)) dirty = true;
    if ((path && path.alpha > 0) || (landing && landing.alpha > 0)) dirty = true; // keep highlights pulsing
    // scenes with moving bits (fire, drifting rocks) redraw a few times a second
    if (SCENES[background.scene]?.animate && now - lastAnim > 70 && !document.hidden) { lastAnim = now; dirty = true; }
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

  const ro = new ResizeObserver(() => { if (cam.auto) cam.r = camMode === 'top' ? topRadius() : fitRadius(); dirty = true; });
  ro.observe(canvas);

  // ----- input
  const pointers = new Map();
  let dragDist = 0, pinch = null;
  let panDrag = false;
  canvas.addEventListener('contextmenu', (e) => { if (camMode === 'free') e.preventDefault(); });
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
    dragDist = 0;
    panDrag = camMode === 'free' && (e.button === 2 || e.shiftKey);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), r: cam.r, z: follow.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
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
      else if (camMode === 'free') {
        cam.r = Math.min(Math.max(pinch.r * (pinch.d / Math.max(d, 1)), 2.5), 40);
        // two-finger drag moves the camera over the board
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const k = cam.r * 0.0022;
        panBy(-(mx - pinch.mx) * k, (my - pinch.my) * k);
        pinch.mx = mx; pinch.my = my;
      } else { cam.r = Math.min(Math.max(pinch.r * (pinch.d / Math.max(d, 1)), 6), 40); cam.auto = false; }
    } else if (pointers.size === 1) {
      if (camMode === 'free') {
        if (panDrag) {
          const k = cam.r * 0.0022;
          panBy(-dx * k, dy * k);
        } else {
          cam.theta -= dx * 0.008;
          cam.phi = Math.min(Math.max(cam.phi + dy * 0.006, 0.12), 1.5);
        }
      } else if (follow.on) {
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
    else if (camMode === 'free') cam.r = Math.min(Math.max(cam.r * Math.exp(e.deltaY * 0.0012), 2.5), 40);
    else { cam.r = Math.min(Math.max(cam.r * Math.exp(e.deltaY * 0.0012), 6), 40); cam.auto = false; }
    dirty = true;
  }, { passive: false });

  let lastTap = 0;
  canvas.addEventListener('dblclick', (e) => { if (camMode === 'free') focusAt(e.clientX, e.clientY); });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || camMode !== 'free' || dragDist > 6) return;
    const now = performance.now();
    if (now - lastTap < 320) focusAt(e.clientX, e.clientY);
    lastTap = now;
  });
  function boardPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1 + lensShift();
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2 - lensShiftY();
    const c = camera();
    const th = Math.tan(c.fov / 2);
    const dir = v3.norm(v3.add(v3.scale(c.view.z, -1),
      v3.add(v3.scale(c.view.x, nx * th * c.aspect), v3.scale(c.view.y, ny * th))));
    if (dir[1] >= -1e-4) return null;
    const t = -c.eye[1] / dir[1];
    return [c.eye[0] + dir[0] * t, c.eye[2] + dir[2] * t];
  }
  function focusAt(clientX, clientY) {
    const p = boardPoint(clientX, clientY);
    if (p) glideTo(p[0], p[1]);
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1 + lensShift();
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2 - lensShiftY();
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
  /** Keep the board clear of a panel floating over the right edge (px). */
  api.setViewInset = (right = 0, bottom = insetBottom) => {
    if (right === insetRight && bottom === insetBottom) return;
    insetRight = Math.max(0, right);
    insetBottom = Math.max(0, bottom);
    if (cam.auto) cam.r = camMode === 'top' ? topRadius() : fitRadius();
    dirty = true;
  };
  /** Place the camera (theta = turn around the board, phi = tilt, r = distance). */
  api.setCamera = ({ theta = cam.theta, phi = cam.phi, r = cam.r, target = cam.target } = {}) => {
    Object.assign(cam, { theta, phi: Math.min(Math.max(phi, 0.12), 1.5), r, target, auto: false });
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
    const quiet = document.hidden;
    await tween(seconds, (k) => {
      const e = easeInOut(k);
      t.x = lerp(ax, bx, e); t.z = lerp(az, bz, e);
      t.lift = height * Math.sin(Math.PI * k);
      turnFn?.(k);
    });
    t.pos = toPos; t.inJail = toJail; t.lift = 0;
    if (!quiet) sfx.hop();
  }

  async function rollDice(values, speed) {
    sfx.dice();
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
    sfx.card();
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
          sfx.jail();
          await hop(t, 10, true, 0.75 / speed, 2.2);
        } else if (ev.type === 'jail_release' && t) {
          await hop(t, 10, false, 0.3 / speed, 0.5);
        } else if (ev.type === 'built' || ev.type === 'sold_building') {
          const to = ev.level;
          const from = ev.type === 'built' ? to - 1 : to + 1;
          const anim = { from, to, t: 0 };
          buildAnims.set(ev.pos, anim);
          if (ev.type === 'built') setTimeout(() => sfx.build(), (to === 5 ? 650 : 280) / speed);
          else sfx.sell();
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

  /** Change the table/sky theme (see backgrounds.js). */
  api.setBackground = (key) => {
    const next = bgByKey(key);
    if (next.scene !== background.scene) dropSceneTextures();
    background = next;
    uploadTexture(tableTex, drawTableTile(background), true);
    canvas.parentElement?.style.setProperty('background', background.sky);
    canvas.parentElement?.setAttribute('data-bg', background.key);
    dirty = true;
  };
  api.background = () => background.key;
  /** How many scenery textures are still being painted (for tests). */
  api.texturesPending = () => texQueue.length + (texTimer ? 1 : 0);

  /** Render a piece as a picture (data URL) for menus, in the given colour. */
  let thumbTarget = null;
  api.pieceThumbnail = (piece, hex, size = 128) => {
    const S = size * 2; // draw at double size, then shrink for smooth edges
    if (!thumbTarget || thumbTarget.size !== S) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, S, S);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      thumbTarget = { fbo, size: S };
    }
    // the target texture must not stay bound while we draw into it
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, thumbTarget.fbo);
    gl.viewport(0, 0, S, S);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // frame the whole model: aim at its middle, back off far enough for its size
    const { lo, hi } = pieceMesh(piece).box;
    const sc = piece.scale ?? 1;
    const h = (hi[1] - Math.min(lo[1], 0)) * sc;
    const w = Math.max(hi[0] - lo[0], hi[2] - lo[2]) * sc;
    const d = Math.max(h * 1.05, w * 0.95) / Math.tan((15 * Math.PI) / 180) * 0.62 + 0.15;
    const dir = v3.norm([0.42, 0.52, 0.85]);
    const target = [0, h * 0.47, 0];
    const eye = v3.add(target, v3.scale(dir, d));
    const view = lookAt(eye, target);
    gl.uniformMatrix4fv(U.uVP, false, mul4(perspective((30 * Math.PI) / 180, 1, 0.05, 20), view.m));
    gl.uniform3fv(U.uEye, eye);
    gl.uniform3fv(U.uLight, v3.norm([0.5, 1, 0.8]));
    gl.uniform3fv(U.uSky, [0.6, 0.6, 0.62]);
    gl.uniform3fv(U.uGround, [0.42, 0.4, 0.4]);
    gl.uniform3fv(U.uSun, [0.55, 0.54, 0.52]);
    gl.uniform1f(U.uPointRange, 0);
    gl.uniform2f(U.uFog, 0, 0);
    gl.uniform2f(U.uFade, 0, 0);
    gl.uniform1f(U.uShadowOn, 0);
    gl.enableVertexAttribArray(A.pos); gl.enableVertexAttribArray(A.nor); gl.enableVertexAttribArray(A.uv);
    setBlend(false);
    gl.depthMask(true);
    drawPieceAt(piece, trs([0, 0, 0], quat.axis([0, 1, 0], piece.thumbYaw ?? 0.35), sc), hexToRgb(hex), 0.25);
    const px = new Uint8Array(S * S * 4);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dirty = true;
    const big = document.createElement('canvas');
    big.width = big.height = S;
    const bg = big.getContext('2d');
    const img = bg.createImageData(S, S);
    for (let y = 0; y < S; y++) img.data.set(px.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
    bg.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const og = out.getContext('2d');
    og.imageSmoothingQuality = 'high';
    og.drawImage(big, 0, 0, size, size);
    return out.toDataURL('image/png');
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
