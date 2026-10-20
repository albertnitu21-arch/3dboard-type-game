// The View menu: one button on the board opens it. Three sections:
//   Camera  - Overview / Top-down / Follow / Free cam, and reset
//   Scene   - picture cards for every background
//   Screen  - Fill window, Fullscreen, Side panel, Sounds, 3D board
// On phones it slides up from the bottom; on bigger screens it drops down
// under the button.

const ICONS = {
  overview: '<path d="M3 15.5 12 20l9-4.5L12 11z"/><path d="M3 15.5V12l9-4.5 9 4.5v3.5"/><circle cx="12" cy="4.5" r="1.6"/>',
  top: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><path d="M4.5 12h15M12 4.5v15"/>',
  follow: '<circle cx="12" cy="5.5" r="2.3"/><path d="M12 8.5v6M12 14.5l-3.5 5M12 14.5l3.5 5M8 11h8"/>',
  free: '<path d="M12 3v18M3 12h18"/><path d="M9.5 5.5 12 3l2.5 2.5M9.5 18.5 12 21l2.5-2.5M5.5 9.5 3 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><circle cx="6" cy="6.2" r=".6"/><circle cx="8.2" cy="6.2" r=".6"/>',
  screen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M17.3 8h1.7M17.3 11h1.7"/>',
  soundOn: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  soundOff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const CAMERAS = [
  ['overview', 'Overview', 'The whole board'],
  ['top', 'Top-down', 'Straight down, like a map'],
  ['follow', 'Follow', 'Behind whoever is playing'],
  ['free', 'Free cam', 'Fly around with mouse, touch or WASD'],
];

export function createViewMenu({ root, backdrop, button, backgrounds, thumb, get, act }) {
  let built = false;
  let lastFocus = null;

  function h(tag, attrs = {}, html = '') {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
    if (html) e.innerHTML = html;
    return e;
  }

  function build() {
    built = true;
    root.replaceChildren();
    root.append(h('div', { class: 'vm-grab', 'aria-hidden': 'true' }));
    const head = h('header', { class: 'vm-head' });
    head.append(h('strong', { id: 'vm-title' }, 'View'));
    const x = h('button', { type: 'button', class: 'vm-x', 'aria-label': 'Close' }, icon('close'));
    x.onclick = () => close();
    head.append(x);
    root.append(head);

    // camera
    const cam = h('section', { class: 'vm-sec', 'data-sec': 'camera' });
    const camHead = h('div', { class: 'vm-sec-head' });
    camHead.append(h('h4', {}, 'Camera'));
    const reset = h('button', { type: 'button', class: 'vm-link', title: 'Put the camera back' }, `${icon('reset')}<span>Reset</span>`);
    reset.onclick = () => act.resetCam();
    camHead.append(reset);
    cam.append(camHead);
    const seg = h('div', { class: 'vm-seg', role: 'radiogroup', 'aria-label': 'Camera' });
    for (const [key, label, title] of CAMERAS) {
      const b = h('button', { type: 'button', role: 'radio', 'data-cam': key, title }, `${icon(key)}<span>${label}</span>`);
      b.onclick = () => { act.setCam(key); sync(); };
      seg.append(b);
    }
    cam.append(seg);
    root.append(cam);

    // scene
    const scene = h('section', { class: 'vm-sec', 'data-sec': 'scene' });
    scene.append(h('h4', {}, 'Scene'));
    const grid = h('div', { class: 'vm-scenes', role: 'radiogroup', 'aria-label': 'Scene' });
    for (const bg of backgrounds) {
      const card = h('button', { type: 'button', role: 'radio', class: 'vm-scene', 'data-bg': bg.key, title: bg.name });
      const pic = h('span', { class: 'vm-pic', 'aria-hidden': 'true' });
      if (bg.scene) {
        pic.style.background = bg.sky;
        pic.append(h('span', { class: 'vm-emoji' }, bg.emoji));
        pic.append(h('span', { class: 'vm-3d' }, '3D'));
      } else {
        try { pic.style.backgroundImage = `url(${thumb(bg)})`; } catch { pic.style.background = bg.sky; }
        pic.append(h('span', { class: 'vm-emoji' }, bg.emoji));
      }
      card.append(pic, h('span', { class: 'vm-name' }, bg.name));
      card.onclick = () => { act.setBg(bg.key); sync(); };
      grid.append(card);
    }
    scene.append(grid);
    root.append(scene);

    // screen
    const scr = h('section', { class: 'vm-sec', 'data-sec': 'screen' });
    scr.append(h('h4', {}, 'Screen'));
    const tiles = h('div', { class: 'vm-tiles' });
    const tile = (key, label, sub) => {
      const b = h('button', { type: 'button', class: 'vm-tile', 'data-tile': key, 'aria-pressed': 'false' }, `<span class="vm-ico"></span><span class="vm-tl">${label}</span><small>${sub}</small>`);
      tiles.append(b);
      return b;
    };
    tile('window', 'Fill window', 'Keep the tabs').onclick = () => { act.setFull(get().full === 'window' ? null : 'window'); sync(); };
    tile('screen', 'Fullscreen', 'Whole screen').onclick = () => { act.setFull(get().full === 'screen' ? null : 'screen'); sync(); };
    tile('panel', 'Side panel', 'Players & chat').onclick = () => { act.setPanel(get().panelHidden); sync(); };
    tile('sound', 'Sounds', '').onclick = () => { act.setSound(!get().sound); sync(); };
    tile('3d', '3D board', '').onclick = () => { act.set3d(!get().use3d); sync(); };
    scr.append(tiles);
    root.append(scr);
  }

  function sync() {
    const s = get();
    button.setAttribute('aria-expanded', String(!root.hidden));
    button.classList.toggle('on', !root.hidden);
    if (!built) return;
    root.querySelector('[data-sec=camera]').hidden = !s.use3d;
    root.querySelector('[data-sec=scene]').hidden = !s.use3d;
    for (const b of root.querySelectorAll('[data-cam]')) b.setAttribute('aria-checked', String(b.dataset.cam === s.camMode));
    for (const b of root.querySelectorAll('[data-bg]')) b.setAttribute('aria-checked', String(b.dataset.bg === s.bg));
    const t = (k) => root.querySelector(`[data-tile="${k}"]`);
    const set = (k, on, ico, sub) => {
      const b = t(k);
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('.vm-ico').innerHTML = icon(ico);
      if (sub !== undefined) b.querySelector('small').textContent = sub;
    };
    set('window', s.full === 'window', 'window');
    set('screen', s.full === 'screen', 'screen');
    set('panel', !!s.full && !s.panelHidden, 'panel', s.full ? (s.panelHidden ? 'Hidden' : 'Shown') : 'In fill / fullscreen');
    t('panel').disabled = !s.full;
    set('sound', s.sound, s.sound ? 'soundOn' : 'soundOff', s.sound ? 'On' : 'Muted');
    set('3d', s.use3d, 'cube', s.use3d ? '3D' : 'Flat 2D');
    t('3d').hidden = !s.has3d;
  }

  const mobile = () => matchMedia('(max-width: 600px)').matches;
  function place() {
    if (root.hidden) return;
    if (mobile()) {
      root.style.top = root.style.left = root.style.maxHeight = root.style.width = '';
      return;
    }
    const r = button.getBoundingClientRect();
    const top = Math.round(r.bottom + 8);
    const width = Math.min(410, innerWidth - 24);
    const left = Math.round(Math.min(Math.max(12, r.left), innerWidth - width - 12));
    root.style.top = `${top}px`;
    root.style.left = `${left}px`;
    root.style.width = `${width}px`;
    root.style.maxHeight = `${Math.max(240, innerHeight - top - 14)}px`;
  }

  function open() {
    if (!built) build();
    lastFocus = document.activeElement;
    root.hidden = false;
    backdrop.hidden = false;
    root.classList.remove('vm-in');
    void root.offsetWidth;
    root.classList.add('vm-in');
    sync();
    place();
    (root.querySelector('[aria-checked=true]') ?? root.querySelector('button'))?.focus({ preventScroll: true });
  }
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    backdrop.hidden = true;
    sync();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    else button.focus({ preventScroll: true });
  }

  button.onclick = () => (root.hidden ? open() : close());
  backdrop.onclick = close;
  addEventListener('resize', place);
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) { e.stopImmediatePropagation(); close(); }
  }, true);

  return { open, close, sync, isOpen: () => !root.hidden };
}
