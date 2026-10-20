// Procedural textures for the 3D scenery, painted with code (no image files).
// Tileable textures wrap seamlessly; `TEXTURES[name]` = { make: () => canvas, tile, avg }.
// `avg` is a stand-in colour used for the first frames while a texture is painted.

import { rng } from './math3d.js';

// ------------------------------------------------------------------ noise

/** Tileable value noise: noise(x, y, periodX, periodY) in 0..1. */
function makeNoise(seed) {
  const r = rng(seed);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const perm = new Uint16Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = r();
  return (x, y, px = 256, py = 256) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = vals[perm[perm[x0 & 255] + (y0 & 255)]];
    const b = vals[perm[perm[x1 & 255] + (y0 & 255)]];
    const c = vals[perm[perm[x0 & 255] + (y1 & 255)]];
    const d = vals[perm[perm[x1 & 255] + (y1 & 255)]];
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

/** Fractal noise; fx, fy = cells across the tile (integers keep it tileable). */
function fbm(n, u, v, fx, fy, oct = 4, gain = 0.5) {
  let s = 0, a = 1, norm = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    s += a * n(u * fx * f, v * fy * f, fx * f, fy * f);
    norm += a; a *= gain; f *= 2;
  }
  return s / norm;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Fill a canvas pixel by pixel: fn(u, v, out) writes rgba (0..255) into out. */
function paint(w, h, fn, cnv = canvas(w, h)) {
  const g = cnv.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  const out = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[3] = 255;
      fn((x + 0.5) / w, (y + 0.5) / h, out);
      const i = (y * w + x) * 4;
      d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3];
    }
  }
  g.putImageData(img, 0, 0);
  return cnv;
}

/** Multiply an existing canvas by a per-pixel factor (texture grain, wear, fibres). */
function grain(cnv, fn) {
  const g = cnv.getContext('2d');
  const img = g.getImageData(0, 0, cnv.width, cnv.height);
  const d = img.data;
  for (let y = 0; y < cnv.height; y++) {
    for (let x = 0; x < cnv.width; x++) {
      const i = (y * cnv.width + x) * 4;
      const k = fn((x + 0.5) / cnv.width, (y + 0.5) / cnv.height);
      d[i] = Math.min(255, d[i] * k); d[i + 1] = Math.min(255, d[i + 1] * k); d[i + 2] = Math.min(255, d[i + 2] * k);
    }
  }
  g.putImageData(img, 0, 0);
  return cnv;
}

/** Draw fn at (x, y) and at the wrapped copies, so shapes cross tile edges seamlessly. */
function wrapped(g, w, h, x, y, fn, margin = 48) {
  for (const dx of [-w, 0, w]) {
    if (x + dx < -margin || x + dx > w + margin) continue;
    for (const dy of [-h, 0, h]) {
      if (y + dy < -margin || y + dy > h + margin) continue;
      g.save(); g.translate(x + dx, y + dy); fn(g); g.restore();
    }
  }
}

// ------------------------------------------------------------------ wood

function wood({ size = 1024, planks = 5, light = '#c8955c', dark = '#8a5530', seed = 1, joints = 1, rings = 22, seams = 0.55, contrast = 0.22 }) {
  const n = makeNoise(seed), n2 = makeNoise(seed + 7);
  const r = rng(seed + 3);
  const L = hex(light), D = hex(dark);
  const pl = Array.from({ length: planks }, () => ({
    tint: 0.86 + r() * 0.24, off: r() * 10, joint: joints ? [r(), r()] : [],
  }));
  return paint(size, size, (u, v, o) => {
    const k = Math.min(planks - 1, Math.floor(v * planks));
    const p = pl[k];
    const lv = v * planks - k; // 0..1 across the plank
    // grain: rings stretched along u, wobbled by noise
    const w = fbm(n, u + p.off * 0.13, v, 3, planks * 2, 4);
    const t = lv * rings * 0.5 + w * 3.2 + Math.sin(u * Math.PI * 2 * 2 + p.off) * 0.6 + p.off;
    const ring = Math.abs((t % 1) - 0.5) * 2; // 0 at the line
    const line = smooth(0.0, 0.22, ring) * 0.7 + smooth(0.0, 0.7, ring) * 0.3;
    const fibre = n2(u * 6, v * 420, 6, 420);
    const patch = fbm(n2, u, v, 2, 4, 3);
    let f = mix(1 - contrast, 1, line) * (0.92 + fibre * 0.14) * (0.9 + 0.16 * patch) * p.tint;
    // plank seams and butt joints
    const edge = Math.min(lv, 1 - lv) * size / planks;
    if (edge < 1.6) f *= seams;
    for (const j of p.joint) { const dj = Math.abs(u - j) * size; if (dj < 1.4 || dj > size - 1.4) f *= seams; }
    const c = mix3(D, L, Math.min(1, Math.max(0, (f - 0.55) / 0.5)));
    const lum = Math.min(1.1, 0.55 + f * 0.5);
    o[0] = c[0] * lum; o[1] = c[1] * lum; o[2] = c[2] * lum;
  });
}

// ------------------------------------------------------------------ fabrics

function fabric(size = 256, seed = 3, base = 236) {
  const n = makeNoise(seed);
  return paint(size, size, (u, v, o) => {
    const wx = Math.sin(u * Math.PI * 2 * 64), wy = Math.sin(v * Math.PI * 2 * 64);
    const weave = 0.93 + 0.07 * (wx > 0 === wy > 0 ? Math.abs(wx) : Math.abs(wy));
    const blot = 0.94 + 0.06 * fbm(n, u, v, 8, 8, 3);
    const k = base * weave * blot;
    o[0] = k; o[1] = k; o[2] = k;
  });
}

function knit(size = 256, seed = 4) {
  const n = makeNoise(seed);
  return paint(size, size, (u, v, o) => {
    const cx = (u * 8) % 1, cy = (v * 10) % 1;
    const side = cx < 0.5 ? cx * 2 : (1 - cx) * 2; // two leaning halves of each stitch
    const loop = Math.sin(Math.min(1, Math.max(0, cy + (1 - side) * 0.35)) * Math.PI);
    const k = 214 + 34 * loop * smooth(0.0, 0.25, side) * (0.92 + 0.08 * n(u * 64, v * 64, 64, 64));
    o[0] = k; o[1] = k; o[2] = k;
  });
}

function gingham(size = 512, color = '#d63b3b') {
  const C = hex(color);
  const n = makeNoise(11);
  return paint(size, size, (u, v, o) => {
    const a = Math.floor(u * 12) % 2, b = Math.floor(v * 12) % 2;
    const t = a && b ? 1 : a || b ? 0.55 : 0;
    const weave = 0.92 + 0.08 * Math.abs(Math.sin(u * Math.PI * 2 * 96) * Math.sin(v * Math.PI * 2 * 96));
    const blot = 0.95 + 0.05 * n(u * 16, v * 16, 16, 16);
    o[0] = mix(250, C[0], t) * weave * blot; o[1] = mix(248, C[1], t) * weave * blot; o[2] = mix(242, C[2], t) * weave * blot;
  });
}

function wicker(size = 256) {
  const n = makeNoise(12);
  return paint(size, size, (u, v, o) => {
    const cx = u * 8, cy = v * 8;
    const ix = Math.floor(cx), iy = Math.floor(cy);
    const fx = cx - ix, fy = cy - iy;
    const horiz = (ix + iy) % 2 === 0;
    const across = horiz ? fy : fx;
    const along = horiz ? fx : fy;
    const round = Math.sin(across * Math.PI) ** 0.5;
    const shade = 0.55 + 0.45 * round * (0.85 + 0.15 * Math.sin(along * Math.PI));
    const k = shade * (0.9 + 0.1 * n(u * 40, v * 40, 40, 40));
    o[0] = 214 * k; o[1] = 168 * k; o[2] = 104 * k;
  });
}

function fur(size = 512, light = '#f4efe6', dark = '#c9bfae') {
  const n = makeNoise(13), n2 = makeNoise(14);
  const L = hex(light), D = hex(dark);
  return paint(size, size, (u, v, o) => {
    const clump = fbm(n, u, v, 12, 12, 3);
    const strands = n2(u * 180, v * 40 + clump * 6, 180, 40);
    const t = Math.min(1, Math.max(0, clump * 0.6 + strands * 0.6 - 0.1));
    const c = mix3(D, L, t);
    o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
  });
}

// ------------------------------------------------------------------ living room

function rug(size = 1024) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const s = size;
  const RED = '#8f2a2a', BLUE = '#1f3a5c', GOLD = '#d9a441', IVORY = '#efe2c4', TEAL = '#2f6f6a';
  g.fillStyle = RED; g.fillRect(0, 0, s, s);
  // fringe area at the two short ends stays transparent between the threads
  const fr = s * 0.035;
  g.clearRect(0, 0, s, fr); g.clearRect(0, s - fr, s, fr);
  g.strokeStyle = IVORY; g.lineWidth = 3;
  for (let x = 6; x < s; x += 9) {
    g.beginPath(); g.moveTo(x, fr); g.lineTo(x + Math.sin(x) * 2, 2); g.stroke();
    g.beginPath(); g.moveTo(x, s - fr); g.lineTo(x + Math.cos(x) * 2, s - 2); g.stroke();
  }
  const band = (inset, w, color) => { g.strokeStyle = color; g.lineWidth = w; g.strokeRect(inset, inset + fr, s - 2 * inset, s - 2 * inset - 2 * fr); };
  band(18, 14, BLUE);
  band(34, 6, IVORY);
  band(62, 44, BLUE);
  band(90, 6, GOLD);
  band(106, 6, IVORY);
  // border motifs (little flowers along the blue band)
  for (let i = 0; i < 26; i++) {
    const t = (i + 0.5) / 26;
    for (const [x, y] of [[62 + t * (s - 124), 62 + fr], [62 + t * (s - 124), s - 62 - fr], [62, 62 + fr + t * (s - 124 - 2 * fr)], [s - 62, 62 + fr + t * (s - 124 - 2 * fr)]]) {
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
      g.fillStyle = GOLD; g.fillRect(-9, -9, 18, 18);
      g.fillStyle = RED; g.fillRect(-4, -4, 8, 8);
      g.restore();
    }
  }
  // field: rows of small boteh-like diamonds
  for (let y = 150 + fr; y < s - 150 - fr; y += 46) {
    for (let x = 150; x < s - 150; x += 46) {
      g.save(); g.translate(x + ((y / 46) % 2 ? 23 : 0), y); g.rotate(Math.PI / 4);
      g.fillStyle = (x + y) % 3 ? '#7a2222' : TEAL; g.fillRect(-7, -7, 14, 14);
      g.restore();
    }
  }
  // central medallion: layered lobed shapes
  const lobed = (r, lobes, depth, color) => {
    g.fillStyle = color; g.beginPath();
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      const rr = r * (1 + depth * Math.cos(a * lobes));
      g.lineTo(s / 2 + Math.cos(a) * rr, s / 2 + Math.sin(a) * rr);
    }
    g.fill();
  };
  lobed(230, 8, 0.12, BLUE);
  lobed(200, 8, 0.12, GOLD);
  lobed(185, 8, 0.12, IVORY);
  lobed(160, 16, 0.06, RED);
  lobed(120, 8, 0.15, TEAL);
  lobed(80, 8, 0.15, GOLD);
  lobed(46, 6, 0.2, BLUE);
  lobed(20, 6, 0.2, IVORY);
  // corner pieces
  for (const [cx, cy] of [[130, 130 + fr], [s - 130, 130 + fr], [130, s - 130 - fr], [s - 130, s - 130 - fr]]) {
    g.fillStyle = BLUE; g.beginPath(); g.arc(cx, cy, 38, 0, Math.PI * 2); g.fill();
    g.fillStyle = GOLD; g.beginPath(); g.arc(cx, cy, 22, 0, Math.PI * 2); g.fill();
    g.fillStyle = RED; g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.fill();
  }
  // wool fibres and a little wear
  const n = makeNoise(21), n2 = makeNoise(22);
  return grain(c, (u, v) => (0.82 + 0.18 * n2(u * 300, v * 300, 300, 300)) * (0.9 + 0.12 * fbm(n, u, v, 6, 6, 3)));
}

function wallpaper(size = 512) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#efe4cc'; g.fillRect(0, 0, size, size);
  // soft vertical stripes
  for (let x = 0; x < size; x += size / 8) { g.fillStyle = 'rgba(176, 140, 96, 0.10)'; g.fillRect(x, 0, size / 16, size); }
  // little damask motifs in a half-drop repeat
  const motif = (gg) => {
    gg.fillStyle = 'rgba(150, 105, 70, 0.22)';
    for (const sx of [-1, 1]) {
      gg.save(); gg.scale(sx, 1);
      gg.beginPath(); gg.moveTo(0, -26); gg.bezierCurveTo(14, -20, 18, -6, 6, 0); gg.bezierCurveTo(18, 6, 14, 20, 0, 26); gg.closePath(); gg.fill();
      gg.beginPath(); gg.arc(12, -14, 4, 0, Math.PI * 2); gg.arc(12, 14, 4, 0, Math.PI * 2); gg.fill();
      gg.restore();
    }
    gg.fillStyle = 'rgba(190, 120, 90, 0.25)';
    gg.beginPath(); gg.arc(0, 0, 5, 0, Math.PI * 2); gg.fill();
  };
  const step = size / 4;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    wrapped(g, size, size, i * step + step / 2, j * step + (i % 2 ? step / 2 : 0) + step / 4, motif);
  }
  const n = makeNoise(23);
  return grain(c, (u, v) => 0.95 + 0.07 * fbm(n, u, v, 16, 16, 3));
}

function painting(w = 512, h = 360) {
  const n = makeNoise(31);
  const c = paint(w, h, (u, v, o) => {
    // sunset sky
    let col = mix3([255, 196, 130], [96, 140, 196], Math.min(1, v * 1.6 < 0.9 ? 1 - v * 1.6 : 0.1));
    col = mix3([86, 128, 190], col, smooth(0, 0.55, v));
    const sun = Math.hypot(u - 0.7, (v - 0.42) * 0.7);
    if (sun < 0.05) col = [255, 236, 190];
    else col = mix3(col, [255, 220, 160], Math.max(0, 0.4 - sun) * 1.4);
    // mountain ridges
    const ridge1 = 0.5 - 0.12 * fbm(n, u, 0.3, 4, 1, 4);
    const ridge2 = 0.6 - 0.08 * fbm(n, u + 0.37, 0.7, 6, 1, 4);
    if (v > ridge1) col = mix3([92, 104, 140], [70, 80, 112], (v - ridge1) * 3);
    if (v > ridge2) col = mix3([64, 110, 80], [42, 80, 56], (v - ridge2) * 3);
    // lake reflection
    if (v > 0.74) {
      const wave = Math.sin(v * 220 + fbm(n, u, v, 8, 8) * 6) * 0.5 + 0.5;
      col = mix3([70, 110, 160], [210, 170, 130], Math.max(0, 0.25 - Math.abs(u - 0.7)) * 2 * wave + 0.05);
    }
    const brush = 0.9 + 0.1 * n(u * 90, v * 30, 90, 30);
    o[0] = col[0] * brush; o[1] = col[1] * brush; o[2] = col[2] * brush;
  });
  // a few painted trees
  const g = c.getContext('2d');
  const r = rng(32);
  for (let i = 0; i < 14; i++) {
    const x = r() * w, y = h * (0.68 + r() * 0.06), s = 8 + r() * 10;
    g.fillStyle = `rgba(${30 + r() * 20}, ${60 + r() * 30}, ${40 + r() * 20}, 0.9)`;
    g.beginPath(); g.moveTo(x, y - s * 2.4); g.lineTo(x - s * 0.7, y); g.lineTo(x + s * 0.7, y); g.fill();
  }
  return c;
}

function windowView(w = 512, h = 512, { night = false } = {}) {
  const n = makeNoise(night ? 41 : 42);
  const c = paint(w, h, (u, v, o) => {
    let col;
    if (night) {
      col = mix3([18, 26, 58], [52, 70, 120], v);
      const moon = Math.hypot(u - 0.72, v - 0.2);
      if (moon < 0.06) col = [240, 238, 220];
      else col = mix3(col, [120, 140, 190], Math.max(0, 0.2 - moon));
      const hill = 0.72 - 0.06 * fbm(n, u, 0.5, 3, 1, 3);
      if (v > hill) col = mix3([200, 214, 236], [236, 242, 250], (v - hill) * 3);
    } else {
      col = mix3([120, 186, 240], [214, 236, 252], v * 1.4);
      const cloud = fbm(n, u, v * 2, 4, 4, 5);
      if (v < 0.5) col = mix3(col, [255, 255, 255], smooth(0.55, 0.75, cloud) * (1 - v * 1.6));
      const trees = 0.58 - 0.1 * fbm(n, u + 0.3, 0.5, 6, 1, 4);
      if (v > trees) col = mix3([70, 120, 60], [46, 92, 44], fbm(n, u * 3, v * 3, 12, 12, 3));
      if (v > 0.8) col = mix3([110, 170, 80], [90, 150, 64], fbm(n, u, v, 30, 6, 3));
    }
    o[0] = col[0]; o[1] = col[1]; o[2] = col[2];
  });
  const g = c.getContext('2d');
  const r = rng(43);
  if (night) {
    // snowy pines and falling snow
    for (let i = 0; i < 18; i++) {
      const x = r() * w, y = h * (0.7 + r() * 0.15), s = 14 + r() * 22;
      g.fillStyle = '#1d3a34';
      for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(x, y - s * (2.6 - k * 0.6)); g.lineTo(x - s * (0.5 + k * 0.2), y - s * (1.2 - k * 0.5)); g.lineTo(x + s * (0.5 + k * 0.2), y - s * (1.2 - k * 0.5)); g.fill(); }
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); g.moveTo(x, y - s * 2.6); g.lineTo(x - s * 0.18, y - s * 2.2); g.lineTo(x + s * 0.18, y - s * 2.2); g.fill();
    }
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(255,255,255,${0.4 + r() * 0.6})`; g.beginPath(); g.arc(r() * w, r() * h, 0.8 + r() * 2.2, 0, Math.PI * 2); g.fill(); }
  } else {
    // a picket fence
    g.fillStyle = '#f4f1ea';
    for (let x = 0; x < w; x += 28) { g.fillRect(x, h * 0.74, 14, h * 0.14); g.beginPath(); g.moveTo(x, h * 0.74); g.lineTo(x + 7, h * 0.72); g.lineTo(x + 14, h * 0.74); g.fill(); }
    g.fillRect(0, h * 0.77, w, 6); g.fillRect(0, h * 0.84, w, 6);
  }
  return c;
}

function books(w = 512, h = 256, seed = 51) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const r = rng(seed);
  const colors = ['#8c2f39', '#2d4a6b', '#e0b84e', '#2f6b4f', '#5a3d7a', '#c4623a', '#1f2a3a', '#d8cfb8', '#6b8f9c', '#a33b2b'];
  let x = 2;
  while (x < w - 10) {
    const bw = 12 + r() * 22, bh = h * (0.62 + r() * 0.36);
    const col = colors[Math.floor(r() * colors.length)];
    const lean = x > w - 60 && r() < 0.5 ? 0.12 : 0;
    g.save(); g.translate(x, h); g.rotate(lean);
    const grad = g.createLinearGradient(0, 0, bw, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0.35)'); grad.addColorStop(0.25, 'rgba(255,255,255,0.12)'); grad.addColorStop(0.75, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = col; g.fillRect(0, -bh, bw, bh);
    g.fillStyle = grad; g.fillRect(0, -bh, bw, bh);
    g.fillStyle = 'rgba(232, 196, 110, 0.85)';
    g.fillRect(2, -bh + 10, bw - 4, 3); g.fillRect(2, -bh * 0.25, bw - 4, 2);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (let k = 0; k < 3; k++) g.fillRect(bw / 2 - 1, -bh * (0.75 - k * 0.12), 2, bh * 0.08);
    g.restore();
    x += bw + 1 + (r() < 0.1 ? 8 : 0);
  }
  return c;
}

function clock(size = 256) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const m = size / 2;
  g.fillStyle = '#fbf6ea'; g.beginPath(); g.arc(m, m, m - 2, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#3a2a1a'; g.lineWidth = 10; g.stroke();
  g.fillStyle = '#2a2622'; g.font = `700 ${size * 0.11}px Georgia, serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 1; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    g.fillText(String(i), m + Math.cos(a) * m * 0.72, m + Math.sin(a) * m * 0.72);
  }
  const hand = (a, len, w) => { g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(m, m); g.lineTo(m + Math.cos(a) * len, m + Math.sin(a) * len); g.stroke(); };
  g.strokeStyle = '#1e1a16';
  hand(-Math.PI / 2 + 0.6, m * 0.45, 9);
  hand(-Math.PI / 2 + 4.1, m * 0.68, 6);
  g.fillStyle = '#b8862b'; g.beginPath(); g.arc(m, m, 8, 0, Math.PI * 2); g.fill();
  return c;
}

// ------------------------------------------------------------------ outdoors

function sand(size = 1024) {
  const n = makeNoise(61), n2 = makeNoise(62);
  const r = rng(63);
  const c = paint(size, size, (u, v, o) => {
    const macro = fbm(n, u, v, 4, 4, 4);
    const ripple = Math.sin((v * 22 + fbm(n2, u, v, 6, 6, 3) * 3) * Math.PI * 2) * 0.5 + 0.5;
    const fine = n2(u * 512, v * 512, 512, 512);
    const k = 0.86 + 0.12 * macro + 0.05 * ripple + 0.08 * (fine - 0.5);
    o[0] = 238 * k; o[1] = 214 * k; o[2] = 168 * k;
  });
  const g = c.getContext('2d');
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = r() < 0.5 ? `rgba(150,110,70,${0.15 + r() * 0.3})` : `rgba(255,252,240,${0.3 + r() * 0.5})`;
    g.fillRect(r() * size, r() * size, 1 + r() * 1.5, 1 + r() * 1.5);
  }
  return c;
}

function water(size = 1024) {
  const n = makeNoise(71), n2 = makeNoise(72);
  return paint(size, size, (u, v, o) => {
    const w1 = fbm(n, u, v, 8, 8, 5);
    const w2 = fbm(n2, u + w1 * 0.1, v, 24, 24, 3);
    const crest = smooth(0.62, 0.8, w2) * (0.6 + 0.4 * w1);
    const deep = [28, 120, 160], shallow = [72, 190, 210];
    const c = mix3(deep, shallow, w1 * 0.8 + 0.1);
    o[0] = mix(c[0], 240, crest * 0.7); o[1] = mix(c[1], 250, crest * 0.7); o[2] = mix(c[2], 252, crest * 0.7);
  });
}

function foam(w = 512, h = 64) {
  const n = makeNoise(73);
  return paint(w, h, (u, v, o) => {
    const edge = 0.35 + 0.35 * fbm(n, u, 0.5, 12, 1, 4);
    const bubbles = n(u * 80, v * 10, 80, 10);
    const a = smooth(edge + 0.15, edge - 0.05, v) * (0.6 + 0.4 * bubbles);
    o[0] = 255; o[1] = 255; o[2] = 255; o[3] = Math.min(255, a * 255);
  });
}

function grass(size = 1024) {
  const n = makeNoise(81);
  const c = paint(size, size, (u, v, o) => {
    const m = fbm(n, u, v, 6, 6, 4);
    const col = mix3([66, 118, 46], [118, 168, 70], m);
    o[0] = col[0]; o[1] = col[1]; o[2] = col[2];
  });
  const g = c.getContext('2d');
  const r = rng(82);
  g.lineCap = 'round';
  for (let i = 0; i < 26000; i++) {
    const x = r() * size, y = r() * size, l = 4 + r() * 9, a = -Math.PI / 2 + (r() - 0.5) * 0.9;
    const t = r();
    g.strokeStyle = t < 0.35 ? `rgba(44, 96, 36, ${0.35 + r() * 0.4})` : t < 0.8 ? `rgba(120, 178, 70, ${0.3 + r() * 0.4})` : `rgba(170, 210, 100, ${0.3 + r() * 0.3})`;
    g.lineWidth = 1 + r() * 1.2;
    wrapped(g, size, size, x, y, (gg) => { gg.beginPath(); gg.moveTo(0, 0); gg.lineTo(Math.cos(a) * l, Math.sin(a) * l); gg.stroke(); });
  }
  return c;
}

function leaves(size = 512, seed = 83, colors = ['#2f6b2a', '#3f8a35', '#58a443', '#7bbd52']) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#244f22'; g.fillRect(0, 0, size, size);
  const r = rng(seed);
  for (let i = 0; i < 2200; i++) {
    const x = r() * size, y = r() * size, s = 6 + r() * 10, a = r() * Math.PI * 2;
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    wrapped(g, size, size, x, y, (gg) => {
      gg.rotate(a);
      gg.beginPath(); gg.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2); gg.fill();
      gg.strokeStyle = 'rgba(20,50,20,0.35)'; gg.lineWidth = 1; gg.beginPath(); gg.moveTo(-s, 0); gg.lineTo(s, 0); gg.stroke();
    });
  }
  return c;
}

function frond(w = 256, h = 512) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const r = rng(91);
  // leaflets on both sides of a rib running from the bottom (base) to the top (tip)
  for (let i = 0; i < 46; i++) {
    const t = i / 46;
    const y = h * (1 - t * 0.98);
    const len = w * 0.48 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) ** 0.7;
    for (const s of [-1, 1]) {
      const ang = s * (0.55 + t * 0.35);
      g.save(); g.translate(w / 2, y); g.rotate(ang);
      const grad = g.createLinearGradient(0, 0, 0, -len);
      grad.addColorStop(0, '#2e6e2a'); grad.addColorStop(1, r() < 0.5 ? '#5aa646' : '#4c983c');
      g.fillStyle = grad;
      g.beginPath(); g.moveTo(-3, 0); g.quadraticCurveTo(-5, -len * 0.5, 0, -len); g.quadraticCurveTo(5, -len * 0.5, 3, 0); g.fill();
      g.restore();
    }
  }
  g.strokeStyle = '#6b8a3a'; g.lineWidth = 6; g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w / 2, 4); g.stroke();
  return c;
}

function bark(w = 256, h = 512, palm = false) {
  const n = makeNoise(palm ? 92 : 93), n2 = makeNoise(94);
  return paint(w, h, (u, v, o) => {
    let k;
    if (palm) {
      const ring = (v * 18) % 1;
      const scale = smooth(0.0, 0.25, ring) * smooth(1.0, 0.7, ring);
      k = 0.55 + 0.35 * scale + 0.15 * (fbm(n, u, v, 8, 16, 3) - 0.5);
      const fib = n2(u * 64, v * 128, 64, 128);
      k *= 0.9 + 0.15 * fib;
      o[0] = 150 * k; o[1] = 112 * k; o[2] = 72 * k;
    } else {
      const f = fbm(n, u, v, 6, 3, 5);
      const fissure = Math.abs(Math.sin((u * 10 + f * 3) * Math.PI));
      k = 0.45 + 0.55 * smooth(0.0, 0.5, fissure) * (0.85 + 0.15 * n2(u * 64, v * 64, 64, 64));
      o[0] = 116 * k; o[1] = 86 * k; o[2] = 60 * k;
    }
  });
}

function sky(w = 1024, h = 512, { seed = 101, clouds = 0.55 } = {}) {
  const n = makeNoise(seed);
  // v: 0 = top of the dome, 0.5 = horizon (the lower half is below the ground)
  return paint(w, h, (u, v, o) => {
    const t = Math.min(1, v / 0.5);
    let col = mix3([62, 132, 216], [196, 226, 246], t ** 1.6);
    if (v > 0.5) col = [214, 232, 244];
    const cl = fbm(n, u, v * 2.2, 8, 3, 5);
    const band = smooth(0.08, 0.3, v) * smooth(0.5, 0.36, v);
    const amt = smooth(clouds, clouds + 0.18, cl) * band;
    col = mix3(col, [255, 255, 255], amt * 0.95);
    col = mix3(col, [190, 205, 225], smooth(0.75, 0.95, cl) * band * 0.4);
    o[0] = col[0]; o[1] = col[1]; o[2] = col[2];
  });
}

function starfield(w = 1024, h = 512) {
  const n = makeNoise(111), n2 = makeNoise(112);
  const c = paint(w, h, (u, v, o) => {
    const neb = fbm(n, u, v, 6, 3, 6);
    const neb2 = fbm(n2, u, v, 4, 2, 5);
    const band = Math.exp(-((v - 0.45 - 0.08 * Math.sin(u * Math.PI * 2)) ** 2) / 0.02);
    let col = [6, 8, 22];
    col = mix3(col, [70, 30, 110], smooth(0.45, 0.85, neb) * (0.4 + band * 0.6));
    col = mix3(col, [20, 90, 120], smooth(0.5, 0.9, neb2) * 0.5 * (0.3 + band));
    col = mix3(col, [180, 150, 200], smooth(0.75, 1, neb) * band * 0.4);
    o[0] = col[0]; o[1] = col[1]; o[2] = col[2];
  });
  // faint dust of tiny stars (the bright ones are 3D points in the scene)
  const g = c.getContext('2d');
  const r = rng(113);
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = `rgba(220, 225, 255, ${0.04 + r() * 0.1})`;
    g.fillRect(r() * w, r() * h, 1, 1);
  }
  return c;
}

function planet(kind, w = 512, h = 256) {
  const n = makeNoise(kind === 'earth' ? 121 : kind === 'gas' ? 122 : 123), n2 = makeNoise(124);
  return paint(w, h, (u, v, o) => {
    let col;
    if (kind === 'gas') {
      const turb = fbm(n, u, v, 8, 4, 5);
      const b = Math.sin((v * 14 + turb * 2.2) * Math.PI) * 0.5 + 0.5;
      col = mix3([196, 150, 104], [238, 214, 170], b);
      col = mix3(col, [170, 90, 60], smooth(0.62, 0.8, fbm(n2, u, v, 16, 8, 3)) * 0.5);
      const spot = Math.hypot((u - 0.3) * 2, (v - 0.62) * 4);
      if (spot < 0.25) col = mix3(col, [200, 96, 64], smooth(0.25, 0.1, spot));
    } else if (kind === 'earth') {
      const land = fbm(n, u, v, 6, 3, 6);
      const lat = Math.abs(v - 0.5) * 2;
      col = land > 0.53 ? mix3([70, 130, 60], [170, 150, 100], smooth(0.53, 0.7, land)) : mix3([20, 60, 140], [40, 110, 190], land / 0.53);
      if (lat > 0.82) col = [236, 242, 248];
      const cl = fbm(n2, u, v, 8, 4, 5);
      col = mix3(col, [255, 255, 255], smooth(0.55, 0.75, cl) * 0.85);
    } else {
      const f = fbm(n, u, v, 8, 4, 5);
      col = mix3([110, 108, 104], [190, 186, 178], f);
      const cr = n2(u * 24, v * 12, 24, 12);
      if (cr > 0.8) col = mix3(col, [80, 78, 74], (cr - 0.8) * 4);
    }
    o[0] = col[0]; o[1] = col[1]; o[2] = col[2];
  });
}

function planetRing(w = 512, h = 32) {
  const n = makeNoise(125);
  return paint(w, h, (u, v, o) => {
    const b = n(v * 40, 0.5, 40, 1) * 0.6 + n(v * 120, 0.5, 120, 1) * 0.4;
    const a = smooth(0, 0.1, v) * smooth(1, 0.85, v) * (0.35 + 0.65 * b) * (Math.abs(v - 0.62) < 0.03 ? 0.15 : 1);
    o[0] = 230; o[1] = 210; o[2] = 180; o[3] = a * 255;
  });
}

// ------------------------------------------------------------------ casino

function felt(size = 512, color = '#1f7a4a') {
  const C = hex(color);
  const n = makeNoise(131), n2 = makeNoise(132);
  return paint(size, size, (u, v, o) => {
    const k = 0.9 + 0.08 * fbm(n, u, v, 8, 8, 3) + 0.06 * (n2(u * 256, v * 256, 256, 256) - 0.5);
    o[0] = C[0] * k; o[1] = C[1] * k; o[2] = C[2] * k;
  });
}

function casinoCarpet(size = 512) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#5c1020'; g.fillRect(0, 0, size, size);
  const s = size / 4;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    wrapped(g, size, size, i * s + s / 2, j * s + s / 2, (gg) => {
      gg.strokeStyle = '#d4a23c'; gg.lineWidth = 4;
      gg.beginPath(); gg.moveTo(0, -s * 0.42); gg.lineTo(s * 0.42, 0); gg.lineTo(0, s * 0.42); gg.lineTo(-s * 0.42, 0); gg.closePath(); gg.stroke();
      gg.fillStyle = '#1d5c5a'; gg.beginPath(); gg.arc(0, 0, s * 0.16, 0, Math.PI * 2); gg.fill();
      gg.fillStyle = '#e6b84a'; gg.beginPath(); gg.arc(0, 0, s * 0.07, 0, Math.PI * 2); gg.fill();
      gg.fillStyle = '#8c2234';
      for (const [x, y] of [[s / 2, 0], [-s / 2, 0], [0, s / 2], [0, -s / 2]]) { gg.beginPath(); gg.arc(x, y, s * 0.1, 0, Math.PI * 2); gg.fill(); }
    });
  }
  const n = makeNoise(133);
  return grain(c, (u, v) => 0.82 + 0.2 * n(u * 256, v * 256, 256, 256));
}

function chipEdge(color) {
  const c = canvas(256, 32);
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 256, 32);
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 8; i++) g.fillRect(i * 32 + 8, 0, 14, 32);
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, 256, 3); g.fillRect(0, 29, 256, 3);
  return c;
}

function chipTop(color) {
  const c = canvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 8; i++) { g.save(); g.translate(64, 64); g.rotate((i / 8) * Math.PI * 2); g.fillRect(-6, -64, 12, 16); g.restore(); }
  g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 3; g.beginPath(); g.arc(64, 64, 36, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.font = '900 26px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('G', 64, 66);
  return c;
}

function cardFace(rank, suit) {
  const c = canvas(180, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf6'; g.beginPath(); g.roundRect(0, 0, 180, 256, 14); g.fill();
  const red = suit === '♥' || suit === '♦';
  g.fillStyle = red ? '#c8102e' : '#16161a';
  g.font = '700 40px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(rank, 26, 34); g.font = '32px serif'; g.fillText(suit, 26, 70);
  g.save(); g.translate(154, 222); g.rotate(Math.PI); g.font = '700 40px Georgia, serif'; g.fillText(rank, 0, 0); g.restore();
  g.font = '110px serif'; g.fillText(suit, 90, 134);
  return c;
}

function cardBack() {
  const c = canvas(180, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf6'; g.beginPath(); g.roundRect(0, 0, 180, 256, 14); g.fill();
  g.fillStyle = '#9e1b2c'; g.beginPath(); g.roundRect(10, 10, 160, 236, 8); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 2;
  for (let i = -260; i < 260; i += 14) { g.beginPath(); g.moveTo(10 + i, 10); g.lineTo(10 + i + 236, 246); g.stroke(); g.beginPath(); g.moveTo(170 - i, 10); g.lineTo(170 - i - 236, 246); g.stroke(); }
  return c;
}

function slotScreen(seed = 1) {
  const c = canvas(256, 320);
  const g = c.getContext('2d');
  const r = rng(140 + seed);
  const grad = g.createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, '#2a0b3d'); grad.addColorStop(1, '#5b1660');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 320);
  g.fillStyle = '#ffd34d'; g.font = '900 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(['JACKPOT', 'LUCKY 7', 'GURT$'][seed % 3], 128, 40);
  const symbols = ['7', '🍒', '★', 'BAR', '🔔', '💎'];
  for (let i = 0; i < 3; i++) {
    g.fillStyle = '#fbf6ea'; g.fillRect(18 + i * 76, 86, 68, 150);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(18 + i * 76, 86, 68, 20); g.fillRect(18 + i * 76, 216, 68, 20);
    for (let k = 0; k < 3; k++) {
      const s = symbols[Math.floor(r() * symbols.length)];
      g.fillStyle = s === '7' ? '#d01c2c' : s === 'BAR' ? '#1b1b1b' : '#d4a020';
      g.font = s === 'BAR' ? '900 18px system-ui' : '900 34px system-ui, sans-serif';
      g.fillText(s, 52 + i * 76, 112 + k * 48);
    }
  }
  g.strokeStyle = '#ffd34d'; g.lineWidth = 3; g.beginPath(); g.moveTo(10, 160); g.lineTo(246, 160); g.stroke();
  for (let i = 0; i < 12; i++) { g.fillStyle = i % 2 ? '#ff5fa2' : '#5fe3ff'; g.beginPath(); g.arc(14 + i * 21, 272, 6, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#ffffff'; g.font = '700 16px system-ui'; g.fillText('CREDITS 1500', 128, 302);
  return c;
}

function roulette(size = 512) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const m = size / 2;
  const order = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const wood = g.createRadialGradient(m, m, m * 0.6, m, m, m);
  wood.addColorStop(0, '#6b3a1c'); wood.addColorStop(1, '#3d1e0c');
  g.fillStyle = wood; g.beginPath(); g.arc(m, m, m, 0, Math.PI * 2); g.fill();
  const n = order.length;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    g.fillStyle = order[i] === 0 ? '#138a3e' : i % 2 ? '#c41a2b' : '#151515';
    g.beginPath(); g.arc(m, m, m * 0.86, a0, a1); g.arc(m, m, m * 0.62, a1, a0, true); g.closePath(); g.fill();
    g.save(); g.translate(m, m); g.rotate((a0 + a1) / 2 + Math.PI / 2);
    g.fillStyle = '#f5ead0'; g.font = `700 ${size * 0.03}px Georgia, serif`; g.textAlign = 'center';
    g.fillText(String(order[i]), 0, -m * 0.78);
    g.restore();
    g.strokeStyle = '#d4a63c'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(m + Math.cos(a0) * m * 0.62, m + Math.sin(a0) * m * 0.62); g.lineTo(m + Math.cos(a0) * m * 0.86, m + Math.sin(a0) * m * 0.86); g.stroke();
  }
  const cone = g.createRadialGradient(m * 0.9, m * 0.9, 0, m, m, m * 0.62);
  cone.addColorStop(0, '#b97a3a'); cone.addColorStop(1, '#5a2f12');
  g.fillStyle = cone; g.beginPath(); g.arc(m, m, m * 0.6, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#e2b450'; g.lineWidth = 8;
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; g.beginPath(); g.moveTo(m, m); g.lineTo(m + Math.cos(a) * m * 0.3, m + Math.sin(a) * m * 0.3); g.stroke(); }
  g.fillStyle = '#e2b450'; g.beginPath(); g.arc(m, m, m * 0.07, 0, Math.PI * 2); g.fill();
  return c;
}

function neon(text, color = '#ff4fa3', w = 1024, h = 192) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.font = `900 ${h * 0.55}px "Trebuchet MS", system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = color; g.lineJoin = 'round';
  for (const [blur, lw, col] of [[40, 16, color], [20, 8, color], [6, 3, '#ffffff']]) {
    g.shadowBlur = blur; g.strokeStyle = col; g.lineWidth = lw; g.strokeText(text, w / 2, h / 2);
  }
  return c;
}

// ------------------------------------------------------------------ cabin

function logs(size = 1024, count = 8) {
  const n = makeNoise(151), n2 = makeNoise(152);
  return paint(size, size, (u, v, o) => {
    const k = Math.floor(v * count);
    const lv = v * count - k;
    const round = Math.sin(lv * Math.PI);
    const chink = lv < 0.06 || lv > 0.94;
    if (chink) {
      const m = 200 + 30 * n(u * 64, v * 64, 64, 64);
      o[0] = m; o[1] = m * 0.95; o[2] = m * 0.86;
      return;
    }
    const gr = fbm(n, u + k * 0.31, lv, 4, 1 * count, 4);
    const ring = Math.abs(((lv * 3 + gr * 2.5) % 1) - 0.5) * 2;
    const fib = n2(u * 6, v * 300, 6, 300);
    const f = (0.5 + 0.5 * round ** 0.6) * (0.75 + 0.25 * smooth(0, 0.4, ring)) * (0.9 + 0.15 * fib) * (0.9 + 0.2 * ((k * 37) % 7) / 7);
    o[0] = 190 * f; o[1] = 128 * f; o[2] = 74 * f;
  });
}

function stone(size = 512, seed = 161) {
  const r = rng(seed);
  const pts = Array.from({ length: 40 }, () => [r(), r(), 0.65 + r() * 0.35, r()]);
  const n = makeNoise(seed + 1);
  return paint(size, size, (u, v, o) => {
    let d1 = 9, d2 = 9, best = null;
    for (const p of pts) {
      let dx = Math.abs(u - p[0]); dx = Math.min(dx, 1 - dx);
      let dy = Math.abs(v - p[1]); dy = Math.min(dy, 1 - dy);
      const d = Math.hypot(dx * 1.0, dy * 1.5);
      if (d < d1) { d2 = d1; d1 = d; best = p; } else if (d < d2) d2 = d;
    }
    const edge = d2 - d1;
    const tex = 0.85 + 0.2 * fbm(n, u, v, 12, 12, 4);
    if (edge < 0.012) { const m = 120 * tex; o[0] = m; o[1] = m * 0.96; o[2] = m * 0.9; return; }
    const shade = best[2] * tex * (0.85 + 0.15 * smooth(0.012, 0.05, edge));
    const warm = best[3];
    o[0] = (150 + warm * 40) * shade; o[1] = (140 + warm * 20) * shade; o[2] = (128 - warm * 10) * shade;
  });
}

function fire(w = 256, h = 256) {
  const n = makeNoise(171);
  return paint(w, h, (u, v, o) => {
    const x = (u - 0.5) * 2, y = 1 - v;
    const flick = fbm(n, u * 1.5, v * 0.8, 6, 6, 4);
    const shape = 1 - Math.abs(x) / Math.max(0.05, (1 - y) * 0.9 + 0.05) - y * 0.6 + (flick - 0.5) * 1.1;
    const a = smooth(0, 0.35, shape);
    const hot = smooth(0.3, 0.9, shape);
    o[0] = 255; o[1] = mix(90, 230, hot); o[2] = mix(20, 140, hot * hot); o[3] = a * 255;
  });
}

function wrapping(color, accent, kind = 'stripes') {
  const c = canvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 256, 256);
  g.fillStyle = accent;
  if (kind === 'stripes') { g.save(); g.translate(128, 128); g.rotate(Math.PI / 4); for (let i = -200; i < 200; i += 36) g.fillRect(i, -200, 12, 400); g.restore(); }
  else if (kind === 'dots') { for (let x = 16; x < 256; x += 32) for (let y = 16; y < 256; y += 32) { g.beginPath(); g.arc(x + (y % 64 ? 16 : 0), y, 6, 0, Math.PI * 2); g.fill(); } }
  else { for (let i = 0; i < 12; i++) { const x = (i * 71) % 256, y = (i * 113) % 256; wrapped(g, 256, 256, x, y, (gg) => { gg.font = '28px serif'; gg.fillText('★', -10, 10); }); } }
  return c;
}

// ------------------------------------------------------------------ space

function metal(size = 512) {
  const n = makeNoise(181), n2 = makeNoise(182);
  return paint(size, size, (u, v, o) => {
    const pu = (u * 4) % 1, pv = (v * 4) % 1;
    const seam = pu < 0.012 || pu > 0.988 || pv < 0.012 || pv > 0.988;
    const rivet = [[0.06, 0.06], [0.94, 0.06], [0.06, 0.94], [0.94, 0.94]].some(([a, b]) => Math.hypot(pu - a, pv - b) < 0.025);
    const brushed = n2(u * 4, v * 400, 4, 400);
    let k = 0.62 + 0.12 * fbm(n, u, v, 8, 8, 3) + 0.08 * brushed;
    k *= 0.9 + 0.1 * (((Math.floor(u * 4) * 3 + Math.floor(v * 4) * 5) % 4) / 4);
    if (seam) k *= 0.45;
    if (rivet) k = 0.95;
    o[0] = 150 * k; o[1] = 160 * k; o[2] = 174 * k;
  });
}

function solarPanel(w = 256, h = 128) {
  return paint(w, h, (u, v, o) => {
    const cu = (u * 8) % 1, cv = (v * 4) % 1;
    const line = cu < 0.05 || cv < 0.08;
    const sheen = 0.8 + 0.2 * Math.sin((u + v) * 6);
    if (line) { o[0] = 200; o[1] = 205; o[2] = 214; } else { o[0] = 30 * sheen; o[1] = 60 * sheen; o[2] = 140 * sheen; }
  });
}

// ------------------------------------------------------------------ beach bits

function stripes(n = 16, a = '#e8473f', b = '#ffffff', w = 512, h = 64) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? b : a; g.fillRect((i * w) / n, 0, w / n + 1, h); }
  const nn = makeNoise(191);
  return grain(c, (u, v) => 0.94 + 0.08 * nn(u * 128, v * 16, 128, 16));
}

function towel(w = 256, h = 512) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const cols = ['#2ec4b6', '#ffffff', '#ff9f1c', '#ffffff', '#e8473f', '#ffffff'];
  for (let i = 0; i < 12; i++) { g.fillStyle = cols[i % cols.length]; g.fillRect(0, (i * h) / 12, w, h / 12 + 1); }
  const n = makeNoise(192);
  return grain(c, (u, v) => 0.86 + 0.16 * n(u * 128, v * 256, 128, 256));
}

function ballSegments() {
  const c = canvas(512, 256);
  const g = c.getContext('2d');
  const cols = ['#ff4d4d', '#ffffff', '#3a86ff', '#ffffff', '#ffd23a', '#ffffff'];
  cols.forEach((col, i) => { g.fillStyle = col; g.fillRect((i * 512) / 6, 0, 512 / 6 + 1, 256); });
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 18); g.fillRect(0, 238, 512, 18);
  return c;
}

function surfboard() {
  const c = canvas(64, 512);
  const g = c.getContext('2d');
  g.fillStyle = '#fff7e8'; g.fillRect(0, 0, 64, 512);
  g.fillStyle = '#1fa3c4'; g.fillRect(0, 140, 64, 30);
  g.fillStyle = '#ff7a45'; g.fillRect(0, 178, 64, 12);
  g.fillStyle = '#2a2a2a'; g.fillRect(30, 0, 4, 512);
  return c;
}

// ------------------------------------------------------------------ registry

const T = (make, avg, tile = true) => ({ make, avg, tile });
export const TEXTURES = {
  tableWood: T(() => wood({ planks: 5, light: '#c99560', dark: '#7a4626', seed: 2, joints: 0, seams: 0.5, rings: 26, contrast: 0.2 }), [176, 120, 76]),
  darkWood: T(() => wood({ size: 512, planks: 3, light: '#8a5530', dark: '#4a2812', seed: 5, joints: 0 }), [104, 62, 34]),
  lightWood: T(() => wood({ size: 512, planks: 3, light: '#e6c79a', dark: '#b08355', seed: 6, joints: 0 }), [214, 180, 136]),
  parquet: T(() => wood({ planks: 8, light: '#d2a574', dark: '#946238', seed: 7, joints: 1, seams: 0.55, contrast: 0.2 }), [186, 138, 92]),
  cabinFloor: T(() => wood({ planks: 6, light: '#b77a45', dark: '#6e3e1c', seed: 8, joints: 2, seams: 0.4 }), [150, 96, 56]),
  fabric: T(() => fabric(), [236, 236, 236]),
  knit: T(() => knit(), [225, 225, 225]),
  rug: T(() => rug(), [140, 52, 48], false),
  wallpaper: T(() => wallpaper(), [232, 218, 192]),
  painting: T(() => painting(), [120, 130, 150], false),
  windowDay: T(() => windowView(512, 512), [150, 190, 200], false),
  windowNight: T(() => windowView(512, 512, { night: true }), [60, 74, 110], false),
  books: T(() => books(), [120, 80, 70], false),
  books2: T(() => books(512, 256, 57), [120, 80, 70], false),
  clock: T(() => clock(), [240, 232, 214], false),
  sand: T(() => sand(), [228, 204, 160]),
  water: T(() => water(), [50, 150, 185]),
  foam: T(() => foam(), [255, 255, 255]),
  grass: T(() => grass(), [92, 146, 58]),
  leaves: T(() => leaves(), [64, 128, 52]),
  leavesDark: T(() => leaves(512, 84, ['#1f4f2a', '#2b6634', '#3a7a3c', '#4f8f44']), [44, 96, 50]),
  frond: T(() => frond(), [70, 140, 60], false),
  palmBark: T(() => bark(256, 512, true), [130, 98, 62]),
  bark: T(() => bark(256, 512, false), [92, 68, 48]),
  sky: T(() => sky(), [150, 196, 236], false),
  starfield: T(() => starfield(), [16, 14, 40], false),
  gasGiant: T(() => planet('gas'), [214, 176, 130], false),
  earth: T(() => planet('earth'), [60, 110, 170], false),
  moon: T(() => planet('moon', 256, 128), [150, 148, 142], false),
  planetRing: T(() => planetRing(), [230, 210, 180], false),
  felt: T(() => felt(), [30, 116, 72]),
  carpet: T(() => casinoCarpet(), [100, 30, 40]),
  chipRedEdge: T(() => chipEdge('#c62233'), [200, 80, 90], false),
  chipBlueEdge: T(() => chipEdge('#1f4fb5'), [80, 110, 190], false),
  chipBlackEdge: T(() => chipEdge('#1c1c1c'), [80, 80, 80], false),
  chipGreenEdge: T(() => chipEdge('#16884a'), [70, 150, 110], false),
  chipRedTop: T(() => chipTop('#c62233'), [200, 80, 90], false),
  chipBlueTop: T(() => chipTop('#1f4fb5'), [80, 110, 190], false),
  chipBlackTop: T(() => chipTop('#1c1c1c'), [80, 80, 80], false),
  chipGreenTop: T(() => chipTop('#16884a'), [70, 150, 110], false),
  cardAS: T(() => cardFace('A', '♠'), [240, 240, 236], false),
  cardKH: T(() => cardFace('K', '♥'), [240, 230, 230], false),
  cardQD: T(() => cardFace('Q', '♦'), [240, 230, 230], false),
  cardBack: T(() => cardBack(), [170, 60, 70], false),
  slot0: T(() => slotScreen(0), [90, 30, 100], false),
  slot1: T(() => slotScreen(1), [90, 30, 100], false),
  slot2: T(() => slotScreen(2), [90, 30, 100], false),
  roulette: T(() => roulette(), [90, 40, 30], false),
  neonCasino: T(() => neon('GURTPOLY CASINO'), [255, 120, 180], false),
  neonBar: T(() => neon('BAR', '#4fe3ff', 512, 192), [120, 220, 255], false),
  logs: T(() => logs(), [160, 108, 64]),
  stone: T(() => stone(), [140, 130, 118]),
  fire: T(() => fire(), [255, 160, 60], false),
  fur: T(() => fur(), [236, 228, 214]),
  giftRed: T(() => wrapping('#c8283a', '#f6e7c1', 'stripes'), [200, 60, 70], false),
  giftGreen: T(() => wrapping('#1f7a4a', '#f2d36b', 'dots'), [50, 130, 80], false),
  giftBlue: T(() => wrapping('#2b4fa8', '#ffffff', 'stars'), [70, 100, 180], false),
  metal: T(() => metal(), [100, 108, 118]),
  solar: T(() => solarPanel(), [40, 70, 140], false),
  umbrella: T(() => stripes(16), [240, 160, 150], false),
  umbrellaBlue: T(() => stripes(16, '#2e86de', '#ffffff'), [150, 190, 240], false),
  towel: T(() => towel(), [200, 200, 170], false),
  ball: T(() => ballSegments(), [240, 200, 180], false),
  surfboard: T(() => surfboard(), [230, 220, 200], false),
  lounger: T(() => stripes(10, '#1fa3c4', '#ffffff', 64, 256), [150, 210, 225], false),
  gingham: T(() => gingham(), [236, 160, 150]),
  wicker: T(() => wicker(), [190, 150, 92]),
};
