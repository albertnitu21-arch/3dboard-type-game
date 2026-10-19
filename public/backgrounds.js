// Table backgrounds for the 3D board: a repeating texture for the table the board
// sits on, and a sky (CSS) behind it. Textures are drawn with code, no images.

/** Small seeded random generator so patterns look the same every time. */
function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw `fn` so it wraps around the tile edges (seamless repeat). */
function wrapped(g, size, x, y, fn) {
  for (const dx of [-size, 0, size]) {
    for (const dy of [-size, 0, size]) {
      g.save(); g.translate(x + dx, y + dy); fn(g); g.restore();
    }
  }
}

function flower(g, r, petal, center) {
  g.fillStyle = petal;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, r * 0.75, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = center;
  g.beginPath(); g.arc(0, 0, r * 0.6, 0, Math.PI * 2); g.fill();
}

function star(g, r, color) {
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
}

export const BACKGROUNDS = [
  {
    key: 'classic', name: 'Classic', emoji: '🟫',
    sky: 'var(--table)',
    draw(g, n) {
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--table').trim() || '#d4ccba';
      g.fillRect(0, 0, n, n);
    },
  },
  {
    key: 'picnic', name: 'Picnic', emoji: '🧺',
    sky: 'radial-gradient(ellipse 120px 40px at 18% 22%, #fff 60%, transparent 62%), radial-gradient(ellipse 90px 30px at 26% 18%, #fff 60%, transparent 62%), radial-gradient(ellipse 140px 44px at 78% 14%, #fff 60%, transparent 62%), linear-gradient(#8fd0ff, #d9f1ff 60%)',
    draw(g, n) {
      g.fillStyle = '#fffaf2';
      g.fillRect(0, 0, n, n);
      const c = n / 8;
      g.fillStyle = 'rgba(214, 54, 62, 0.55)';
      for (let i = 0; i < 8; i += 2) { g.fillRect(i * c, 0, c, n); g.fillRect(0, i * c, n, c); }
      // a little woven texture
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 1;
      for (let i = 0; i < n; i += 4) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, n); g.stroke(); }
    },
  },
  {
    key: 'meadow', name: 'Meadow', emoji: '🌼',
    sky: 'radial-gradient(circle at 85% 15%, #fff7c2 0 28px, rgba(255,247,194,0.5) 29px 46px, transparent 47px), linear-gradient(#a8dcff, #eaf8ff 65%)',
    draw(g, n) {
      g.fillStyle = '#7fc56b';
      g.fillRect(0, 0, n, n);
      const r = rng(7);
      for (let i = 0; i < 900; i++) {
        g.strokeStyle = r() < 0.5 ? 'rgba(60,130,50,0.45)' : 'rgba(170,225,140,0.45)';
        g.lineWidth = 2;
        const x = r() * n, y = r() * n;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 6, y - 8 - r() * 8); g.stroke();
      }
      const colors = [['#ffffff', '#ffd23a'], ['#ffd1e8', '#ff8ac0'], ['#fff3a6', '#f4a62a'], ['#d9e8ff', '#7aa7ff']];
      for (let i = 0; i < 26; i++) {
        const [p, c] = colors[i % colors.length];
        wrapped(g, n, r() * n, r() * n, (gg) => flower(gg, 5 + r() * 3, p, c));
      }
    },
  },
  {
    key: 'night', name: 'Starry night', emoji: '🌙',
    sky: 'radial-gradient(circle at 80% 18%, #fdf6d8 0 22px, transparent 23px), radial-gradient(circle at 78% 16%, #1a2147 0 22px, transparent 23px), radial-gradient(1.5px 1.5px at 20% 30%, #fff 50%, transparent), radial-gradient(1.5px 1.5px at 40% 12%, #fff 50%, transparent), radial-gradient(1px 1px at 60% 35%, #fff 50%, transparent), radial-gradient(1.5px 1.5px at 10% 10%, #fff 50%, transparent), radial-gradient(1px 1px at 92% 40%, #fff 50%, transparent), radial-gradient(1px 1px at 55% 8%, #fff 50%, transparent), linear-gradient(#0e1330, #2a3366 70%)',
    draw(g, n) {
      const grad = g.createLinearGradient(0, 0, n, n);
      grad.addColorStop(0, '#1d2552'); grad.addColorStop(1, '#232c62');
      g.fillStyle = grad;
      g.fillRect(0, 0, n, n);
      const r = rng(11);
      for (let i = 0; i < 160; i++) {
        g.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.6})`;
        g.beginPath(); g.arc(r() * n, r() * n, r() * 1.6 + 0.4, 0, Math.PI * 2); g.fill();
      }
      for (let i = 0; i < 9; i++) {
        const col = ['#ffe680', '#ffd1f0', '#bfe9ff'][i % 3];
        wrapped(g, n, r() * n, r() * n, (gg) => star(gg, 7 + r() * 6, col));
      }
    },
  },
  {
    key: 'candy', name: 'Candy', emoji: '🍬',
    sky: 'radial-gradient(circle at 15% 25%, rgba(255,255,255,0.8) 0 14px, transparent 15px), radial-gradient(circle at 70% 12%, rgba(255,255,255,0.7) 0 10px, transparent 11px), linear-gradient(#ffd9ec, #e2ecff 70%)',
    draw(g, n) {
      g.fillStyle = '#ffd3e6';
      g.fillRect(0, 0, n, n);
      const cols = ['#ffffff', '#b8f0dc', '#fff2a8', '#c9d9ff'];
      const step = n / 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          g.fillStyle = cols[(x + y * 3) % cols.length];
          g.beginPath();
          g.arc(x * step + (y % 2 ? step / 2 : 0) + step / 4, y * step + step / 2, step * 0.18, 0, Math.PI * 2);
          g.fill();
        }
      }
    },
  },
  {
    key: 'wood', name: 'Living room', emoji: '🛋️',
    scene: 'livingroom',
    sky: 'linear-gradient(#e9dcc4, #f3e9d8 70%)',
    draw(g, n) {
      const planks = 4;
      const h = n / planks;
      const tones = ['#b9824f', '#c48d58', '#ad7745', '#bf8752'];
      const r = rng(3);
      for (let i = 0; i < planks; i++) {
        g.fillStyle = tones[i];
        g.fillRect(0, i * h, n, h);
        for (let k = 0; k < 14; k++) {
          g.strokeStyle = `rgba(90,50,20,${0.08 + r() * 0.12})`;
          g.lineWidth = 1 + r() * 2;
          const y = i * h + r() * h;
          g.beginPath();
          g.moveTo(0, y);
          for (let x = 0; x <= n; x += 32) g.lineTo(x, y + Math.sin(x / 60 + k) * 3);
          g.stroke();
        }
        g.fillStyle = 'rgba(60,30,10,0.45)';
        g.fillRect(0, i * h, n, 3);
      }
    },
  },
  {
    key: 'beach', name: 'Beach', emoji: '🏖️',
    scene: 'beach',
    sky: 'radial-gradient(circle at 82% 20%, #fff2b0 0 26px, transparent 27px), linear-gradient(#7fcfff 0%, #c9ecff 45%, #5fc4d8 46%, #a7e3ea 60%)',
    draw(g, n) {
      g.fillStyle = '#f1dcaa';
      g.fillRect(0, 0, n, n);
      const r = rng(5);
      for (let i = 0; i < 2600; i++) {
        g.fillStyle = r() < 0.5 ? 'rgba(180,140,80,0.25)' : 'rgba(255,250,235,0.4)';
        g.fillRect(r() * n, r() * n, 1.5, 1.5);
      }
      for (let i = 0; i < 7; i++) {
        wrapped(g, n, r() * n, r() * n, (gg) => star(gg, 9 + r() * 4, ['#ff9e7a', '#ffb4c6', '#ffd27a'][i % 3]));
      }
      for (let i = 0; i < 6; i++) {
        wrapped(g, n, r() * n, r() * n, (gg) => {
          gg.fillStyle = '#fff3e3'; gg.strokeStyle = 'rgba(190,140,110,0.7)'; gg.lineWidth = 1.5;
          gg.beginPath(); gg.arc(0, 0, 8, Math.PI, 0); gg.lineTo(0, 7); gg.closePath(); gg.fill(); gg.stroke();
          for (let k = -2; k <= 2; k++) { gg.beginPath(); gg.moveTo(0, 7); gg.lineTo(k * 3.5, -6); gg.stroke(); }
        });
      }
    },
  },
];

export const bgByKey = (key) => BACKGROUNDS.find((b) => b.key === key) ?? BACKGROUNDS[0];

/** Paint a background's repeating table tile. */
export function drawTableTile(bg, size = 512) {
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  bg.draw(cnv.getContext('2d'), size);
  return cnv;
}

// ------------------------------------------------------- scene textures
// Extra textures for the 3D scenery of some backgrounds (living room, beach).

function canvas(w, h, fn) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  fn(c.getContext('2d'), w, h);
  return c;
}

export const SCENE_TEXTURES = {
  parquet: () => canvas(512, 512, (g, n) => {
    const r = rng(21);
    const rows = 8, len = n / 2;
    for (let y = 0; y < rows; y++) {
      const off = (y % 2) * len / 2;
      for (let x = -1; x < 3; x++) {
        const tone = 150 + r() * 40;
        g.fillStyle = `rgb(${tone + 30}, ${tone - 15}, ${tone - 70})`;
        g.fillRect(x * len + off, y * (n / rows), len, n / rows);
        g.strokeStyle = 'rgba(60,35,15,0.45)'; g.lineWidth = 2;
        g.strokeRect(x * len + off, y * (n / rows), len, n / rows);
        for (let k = 0; k < 5; k++) {
          g.strokeStyle = 'rgba(90,50,20,0.12)'; g.lineWidth = 1;
          const yy = y * (n / rows) + r() * (n / rows);
          g.beginPath(); g.moveTo(x * len + off, yy); g.lineTo(x * len + off + len, yy + (r() - 0.5) * 4); g.stroke();
        }
      }
    }
  }),
  rug: () => canvas(512, 512, (g, n) => {
    g.fillStyle = '#b6423b'; g.fillRect(0, 0, n, n);
    g.strokeStyle = '#f3dcb2'; g.lineWidth = 14; g.strokeRect(22, 22, n - 44, n - 44);
    g.strokeStyle = '#2f4d6b'; g.lineWidth = 10; g.strokeRect(48, 48, n - 96, n - 96);
    g.fillStyle = '#e9b949';
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        g.save(); g.translate(96 + i * 80, 96 + j * 80); g.rotate(Math.PI / 4);
        g.fillRect(-14, -14, 28, 28); g.restore();
      }
    }
    g.fillStyle = '#f3dcb2';
    g.save(); g.translate(n / 2, n / 2); g.rotate(Math.PI / 4); g.fillRect(-60, -60, 120, 120); g.restore();
    g.fillStyle = '#2f4d6b';
    g.save(); g.translate(n / 2, n / 2); g.rotate(Math.PI / 4); g.fillRect(-34, -34, 68, 68); g.restore();
  }),
  wallpaper: () => canvas(256, 256, (g, n) => {
    g.fillStyle = '#f2e6cf'; g.fillRect(0, 0, n, n);
    g.fillStyle = 'rgba(160, 120, 80, 0.16)';
    for (let x = 0; x < n; x += 32) g.fillRect(x, 0, 12, n);
    g.fillStyle = 'rgba(190, 90, 90, 0.35)';
    for (let x = 16; x < n; x += 64) {
      for (let y = 16; y < n; y += 64) {
        g.save(); g.translate(x + 6, y + (x % 128 ? 32 : 0)); flower(g, 4, 'rgba(200,110,110,0.45)', 'rgba(230,180,90,0.6)'); g.restore();
      }
    }
  }),
  stripes: () => canvas(512, 64, (g, w, h) => {
    const n = 12;
    for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#ffffff' : '#e8473f'; g.fillRect((i * w) / n, 0, w / n + 1, h); }
  }),
  ball: () => canvas(512, 64, (g, w, h) => {
    const cols = ['#ff4d4d', '#ffffff', '#3a86ff', '#ffffff', '#ffd23a', '#ffffff'];
    cols.forEach((c, i) => { g.fillStyle = c; g.fillRect((i * w) / cols.length, 0, w / cols.length + 1, h); });
  }),
  towel: () => canvas(128, 256, (g, w, h) => {
    for (let i = 0; i < 8; i++) { g.fillStyle = ['#2ec4b6', '#ffffff', '#ff9f1c', '#ffffff'][i % 4]; g.fillRect(0, (i * h) / 8, w, h / 8 + 1); }
    g.fillStyle = 'rgba(255,255,255,0.5)';
    for (let x = 0; x < w; x += 8) { g.fillRect(x, 0, 3, 6); g.fillRect(x, h - 6, 3, 6); }
  }),
  water: () => canvas(512, 512, (g, n) => {
    const grad = g.createLinearGradient(0, 0, 0, n);
    grad.addColorStop(0, '#3fb8d8'); grad.addColorStop(1, '#54c7e0');
    g.fillStyle = grad; g.fillRect(0, 0, n, n);
    const r = rng(9);
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 3;
    for (let i = 0; i < 40; i++) {
      const x = r() * n, y = r() * n, l = 20 + r() * 40;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + l / 2, y - 6, x + l, y); g.stroke();
    }
  }),
};
