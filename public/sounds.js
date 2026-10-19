// Sound effects, synthesised with the Web Audio API (no audio files).
// Browsers only allow sound after the first click/tap, so the audio context is
// created lazily on the first user gesture.

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = true;
try { enabled = localStorage.getItem('estate-sound') !== 'off'; } catch { /* ignore */ }

function audio() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    // one second of white noise, reused by the rattle/whoosh sounds
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// unlock audio on the first interaction
for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, () => { if (enabled) audio(); }, { once: true, capture: true });
}

/** A tone with a quick attack and exponential decay. */
function tone({ freq, to = freq, type = 'sine', at = 0, dur = 0.12, gain = 0.2 }) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to !== freq) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** A burst of filtered noise. */
function noise({ at = 0, dur = 0.05, gain = 0.2, freq = 2500, q = 1.5, sweepTo = null }) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

// don't stack the same sound many times in one instant
const last = new Map();
function throttle(name, ms) {
  const now = performance.now();
  if (now - (last.get(name) ?? 0) < ms) return true;
  last.set(name, now);
  return false;
}

export const sfx = {
  click() {
    if (throttle('click', 40)) return;
    tone({ freq: 1100, to: 700, type: 'sine', dur: 0.05, gain: 0.08 });
  },
  dice() {
    // a rattle of little clacks that slows down, then two final knocks
    let t = 0;
    for (let i = 0; i < 9; i++) {
      noise({ at: t, dur: 0.035, gain: 0.22 - i * 0.015, freq: 2200 + Math.random() * 1800, q: 4 });
      t += 0.045 + i * 0.012;
    }
    noise({ at: t + 0.05, dur: 0.05, gain: 0.18, freq: 1400, q: 3 });
    noise({ at: t + 0.16, dur: 0.05, gain: 0.12, freq: 1200, q: 3 });
  },
  hop() {
    if (throttle('hop', 50)) return;
    tone({ freq: 420, to: 260, type: 'triangle', dur: 0.07, gain: 0.12 });
  },
  coin() {
    if (throttle('coin', 120)) return;
    tone({ freq: 988, type: 'square', dur: 0.08, gain: 0.05 });
    tone({ freq: 1319, type: 'square', at: 0.07, dur: 0.22, gain: 0.05 });
  },
  pay() {
    if (throttle('pay', 120)) return;
    tone({ freq: 520, to: 220, type: 'triangle', dur: 0.22, gain: 0.14 });
  },
  card() {
    noise({ dur: 0.28, gain: 0.16, freq: 700, sweepTo: 3200, q: 0.9 });
    tone({ freq: 1568, type: 'sine', at: 0.18, dur: 0.18, gain: 0.05 });
  },
  build() {
    tone({ freq: 160, to: 60, type: 'sine', dur: 0.18, gain: 0.3 });
    noise({ dur: 0.04, gain: 0.12, freq: 1800, q: 2 });
  },
  sell() {
    tone({ freq: 300, to: 600, type: 'triangle', dur: 0.15, gain: 0.1 });
  },
  jail() {
    tone({ freq: 110, type: 'square', dur: 0.35, gain: 0.07 });
    tone({ freq: 104, type: 'square', at: 0.02, dur: 0.33, gain: 0.05 });
  },
  turn() {
    // your turn: a bright little arpeggio
    [523, 659, 784].forEach((f, i) => tone({ freq: f, type: 'sine', at: i * 0.09, dur: 0.22, gain: 0.12 }));
  },
  notify() {
    tone({ freq: 660, type: 'sine', dur: 0.15, gain: 0.12 });
    tone({ freq: 880, type: 'sine', at: 0.13, dur: 0.25, gain: 0.12 });
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', at: i * 0.12, dur: 0.35, gain: 0.14 }));
  },
};

export function soundOn() { return enabled; }
export function setSound(on) {
  enabled = on;
  try { localStorage.setItem('estate-sound', on ? 'on' : 'off'); } catch { /* ignore */ }
  if (on) { audio(); sfx.click(); }
}
