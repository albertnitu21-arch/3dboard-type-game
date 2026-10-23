// Web client: lobby, side panel, animation queue and the 2D fallback board.
// The 3D board lives in board3d.js and the trade window in trade.js.

import { BOARD, GROUPS, GROUP_POSITIONS, STATION_RENTS } from './engine/board.js';
import { deedCard } from './deeds.js';
import { createBoard3D } from './board3d.js';
import { createTradeUI } from './trade.js';
import { createMoneyUI } from './money.js';
import { PIECES, pieceFor, pieceByKey } from './pieces.js';
import { BACKGROUNDS, drawTableTile } from './backgrounds.js';
import { createViewMenu } from './viewmenu.js';
import { createRaiseUI } from './raise.js';
import { sfx, soundOn, setSound } from './sounds.js';

const $ = (id) => document.getElementById(id);
const API = ''; // same origin; set to the server URL if the page is hosted elsewhere
const COLORS = ['#e4572e', '#2e86ab', '#f2c14e', '#7b2cbf', '#3bb273', '#ff7aa2', '#5c4d3c', '#00b4d8'];
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let session = null; // { code, id, token }
let source = null;
let lobby = null;
let game = null; // { state, legal }
const logLines = []; // chat messages only
let lastEvent = ''; // the latest game event, shown in the middle of the flat 2D board

// ---------------------------------------------------------------- storage

const store = {
  get() { try { return JSON.parse(localStorage.getItem('estate-session')); } catch { return null; } },
  set(v) { try { localStorage.setItem('estate-session', JSON.stringify(v)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem('estate-session'); } catch { /* ignore */ } },
  name() { try { return localStorage.getItem('estate-name') ?? ''; } catch { return ''; } },
  setName(n) { try { localStorage.setItem('estate-name', n); } catch { /* ignore */ } },
};

// -------------------------------------------------------------------- api

async function api(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message ?? 'Request failed.'), { code: data.error });
  return data;
}
const roomApi = (verb, body) => api(`/api/rooms/${session.code}/${verb}`, { token: session.token, ...body });

function dockError(msg = '') {
  $('dock-error').textContent = msg;
  $('dock-error').hidden = !msg;
}
async function act(action) {
  $('game-error').textContent = '';
  dockError();
  // Lock the buttons until the result has been animated, so nothing is sent twice.
  const buttons = document.querySelectorAll('#actions button, #mine button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await roomApi('action', { action });
  } catch (e) {
    $('game-error').textContent = e.message;
    dockError(e.message);
    buttons.forEach((b) => { b.disabled = false; });
  }
}
async function host(op, target) {
  $('lobby-error').textContent = '';
  try {
    await roomApi('host', { op, target });
  } catch (e) {
    $('lobby-error').textContent = e.message;
    $('game-error').textContent = e.message;
  }
}

// --------------------------------------------------------------- screens

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

function enterRoom(s) {
  session = s;
  store.set(s);
  history.replaceState(null, '', `?room=${s.code}`);
  connect();
}

function resetGameView() {
  game = null;
  queue.length = 0;
  logLines.length = 0;
  lastEvent = '';
  selectedSpace = null;
  tradeUI.close();
  raiseUI.close();
  closeCard?.();
  money.reset();
}

function leaveRoom(message = '') {
  viewMenu.close();
  raiseUI.close();
  fullMode = null;
  setFull(false);
  source?.close();
  source = null;
  session = null;
  lobby = null;
  game = null;
  queue.length = 0;
  selectedSpace = null;
  tradeUI.close();
  closeCard?.();
  money.reset();
  logLines.length = 0;
  lastEvent = '';
  store.clear();
  history.replaceState(null, '', location.pathname);
  show('home');
  $('home-error').textContent = message;
}

function connect() {
  source?.close();
  source = new EventSource(`${API}/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`);
  source.addEventListener('lobby', (e) => {
    lobby = JSON.parse(e.data);
    if (!lobby.started && game) resetGameView(); // the host went back to the lobby
    render();
  });
  source.addEventListener('state', (e) => enqueue(JSON.parse(e.data)));
  source.addEventListener('chat', (e) => {
    const m = JSON.parse(e.data);
    logLines.push({ name: m.name, text: m.text, chat: true });
    renderLog();
  });
  source.addEventListener('hello', (e) => checkVersion(JSON.parse(e.data).version));
  source.addEventListener('kicked', () => leaveRoom('You were removed from the room.'));
  source.addEventListener('card_closed', (e) => {
    const { seq } = JSON.parse(e.data);
    closedCards.add(seq);
    if (openCardSeq === seq) closeCard?.();
  });
  const mine = source;
  source.onerror = () => {
    // EventSource retries on its own unless the server refused the stream. Then check
    // whether our seat still exists before giving up (it won't after a server restart).
    if (unloading || mine !== source || mine.readyState !== EventSource.CLOSED) return;
    setTimeout(async () => {
      if (unloading || mine !== source || !session) return;
      try {
        await api(`/api/rooms/${session.code}/join`, { token: session.token });
        connect();
      } catch (e) {
        if (e.code === 'bad_token' || e.code === 'no_such_room') leaveRoom('That room is no longer available.');
        else setTimeout(() => mine === source && connect(), 3000); // server unreachable: keep trying
      }
    }, 1000);
  };
}
let unloading = false;
addEventListener('pagehide', () => { unloading = true; });

// Free hosts (e.g. Render) put the server to sleep after 15 minutes without
// incoming requests, which would wipe the room. While you're in a room, ping it.
function ping() {
  fetch(`${API}/health`, { cache: 'no-store' })
    .then((r) => r.json())
    .then((h) => checkVersion(h.version))
    .catch(() => {});
}
setInterval(() => { if (session && !document.hidden) ping(); }, 4 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });

// ------------------------------------------------------ new version notice

const PAGE_VERSION = document.querySelector('meta[name="app-version"]')?.content ?? null;
function checkVersion(v) {
  if (!PAGE_VERSION || !v || v === PAGE_VERSION || $('update-bar')) return;
  const bar = el('div', { id: 'update-bar', class: 'update-bar', role: 'status' },
    el('span', {}, 'A new version of the game is out.'),
    el('button', { type: 'button', class: 'primary small', onclick: () => location.reload() }, 'Reload'));
  document.body.append(bar);
}

// ------------------------------------------------------- 3D board + queue

let board3d = null;
let use3d = true;
try {
  board3d = createBoard3D($('board-canvas'), { board: BOARD, groups: GROUPS, colorOf: (id) => colorOf(id), nameOf: (id) => nameOf(id), pieceOf: (id) => pieceOf(id) });
} catch (err) {
  console.warn('3D board unavailable:', err);
}
if (!board3d) use3d = false;
if (board3d) {
  board3d.onSpace = (pos) => showSpace(pos);
  board3d.onCard = (ev, speed) => showCardPopup(ev, speed);
}

const money = createMoneyUI({
  getState: () => game?.state,
  tokenPos: (id) => (use3d && board3d ? board3d.screenPos(id) : null),
  boardEl: $('board3d'),
});
if (board3d) board3d.onEvent = (ev) => money.apply(ev);

const tradeUI = createTradeUI({
  root: $('trade-modal'),
  banner: $('trade-banner'),
  getGame: () => game,
  myId: () => session?.id,
  nameOf: (id) => nameOf(id),
  colorOf: (id) => colorOf(id),
  send: (action) => roomApi('action', { action }),
});

const raiseUI = createRaiseUI({
  root: $('raise-modal'),
  getGame: () => game,
  myId: () => session?.id,
  send: (action) => roomApi('action', { action }),
  onChange: () => { if (game) renderSide(); },
});
/** Open the Raise money panel by itself once, when a debt you can work off starts. */
let raiseAutoKey = '';
function maybeOpenRaise() {
  const s = game?.state;
  if (!s || s.phase !== 'debt' || s.players[s.current]?.id !== session?.id) return;
  if (lobby?.members.find((m) => m.id === session.id)?.autoplay) return;
  if (!game.legal.some((a) => a.type === 'raise_cash')) return;
  const key = `${s.turn}:${s.debt.total}`;
  if (key === raiseAutoKey || raiseUI.isOpen() || tradeUI.isOpen()) return;
  raiseAutoKey = key;
  raiseUI.open();
}

// --------------------------------------------------------- card pop-up

const DECK_STYLE = {
  fortune: { title: 'Fortune', icon: '?', cls: 'fortune' },
  community: { title: 'Community Fund', icon: '◆', cls: 'community' },
};
let closeCard = null;
let openCardSeq = null;
const closedCards = new Set(); // cards the drawer has already dismissed
const shownCards = new Set();
/**
 * Show a drawn card to everyone. When a person drew it (`ev.ack` set by the
 * server), only they get an OK button; everyone else's copy closes when they tap
 * it. Cards drawn by bots close by themselves. Resolves when the card closes.
 */
function showCardPopup(ev, speed = 1) {
  if (document.hidden) return Promise.resolve();
  closeCard?.();
  const box = $('card-popup');
  const d = DECK_STYLE[ev.deck] ?? DECK_STYLE.fortune;
  const mine = ev.player === session?.id;
  const ack = ev.ack ?? null;
  if (ack) shownCards.add(ack);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      box.hidden = true;
      box.replaceChildren();
      closeCard = null;
      openCardSeq = null;
      resolve();
    };
    closeCard = finish;
    openCardSeq = ack;
    let footer;
    let ms;
    if (ack && mine) {
      footer = el('button', {
        type: 'button', class: 'primary',
        onclick: () => { roomApi('card-ok', { seq: ack }).catch(() => {}); finish(); },
      }, 'OK');
      ms = 30000; // the server closes it for everyone after 30 s anyway
    } else if (ack && !closedCards.has(ack)) {
      footer = el('div', { class: 'dc-wait' }, `Waiting for ${nameOf(ev.player)} to tap OK…`);
      ms = 32000;
    } else {
      footer = null;
      ms = (ack ? 1500 : 3500) / speed; // bot card, or already dismissed by the drawer
    }
    box.replaceChildren(el('div', { class: `drawn-card ${d.cls}`, role: 'dialog', 'aria-live': 'polite', 'aria-label': `${d.title} card` },
      el('div', { class: 'dc-head' }, el('span', { class: 'dc-icon' }, d.icon), el('span', {}, d.title.toUpperCase())),
      el('div', { class: 'dc-who' },
        el('span', { class: 'dot', style: `background:${colorOf(ev.player)}` }),
        mine ? 'You drew' : `${nameOf(ev.player)} drew`),
      el('p', { class: 'dc-text' }, ev.text),
      footer));
    box.hidden = false;
    // Only cards nobody has to confirm can be clicked away.
    box.onclick = (e) => { if (e.target === box && !ack) finish(); };
    const t = setTimeout(finish, ms);
    if (footer?.tagName === 'BUTTON') footer.focus({ preventScroll: true });
  });
}

// State updates are animated one at a time. The side panel (and your buttons)
// update once the dice have landed and the tokens have moved.
const queue = [];
let draining = false;
function enqueue(d) {
  queue.push(d);
  if (!draining) drain();
}
async function drain() {
  draining = true;
  while (queue.length) {
    const d = queue.shift();
    const speed = queue.length >= 3 ? 6 : queue.length >= 1 ? 2 : 1;
    if (use3d && board3d && game) {
      try { await board3d.play(d.events, d.state, speed); } catch (err) { console.error(err); }
    }
    if (!(use3d && board3d) && game) {
      // The 3D board shows drawn cards and money changes as it animates; the flat
      // board does it here.
      for (const ev of d.events) {
        if (ev.type === 'roll') sfx.dice();
        if (ev.type === 'go_to_jail') sfx.jail();
        if (ev.type === 'built') sfx.build();
        if (ev.type === 'card') { sfx.card(); await showCardPopup(ev, speed); }
        money.apply(ev);
      }
    }
    const before = game?.state;
    game = { state: d.state, legal: d.legal, tradeMsLeft: d.tradeMsLeft ?? null, receivedAt: Date.now() };
    playStateSounds(before, d.state, d.events);
    const pc = d.pendingCard;
    if (pc && !shownCards.has(pc.seq) && !closedCards.has(pc.seq) && !d.events.some((e) => e.type === 'card')) {
      // e.g. after a reload: the card is still waiting for its OK
      showCardPopup({ ...pc, type: 'card', ack: pc.seq });
    }
    for (const ev of d.events) {
      const line = describe(ev);
      if (line) lastEvent = line; // game events are not listed in the chat
    }
    render();
    money.reconcile();
    raiseUI.update();
    maybeOpenRaise();
  }
  draining = false;
}

/** Chimes for things that need your attention. */
function playStateSounds(before, after, events) {
  if (!before || !session) return;
  if (events.some((e) => e.type === 'game_over')) { sfx.win(); return; }
  const me = session.id;
  const nowMine = after.players[after.current]?.id === me && after.phase === 'roll';
  const wasMine = before.players[before.current]?.id === me && before.phase === 'roll';
  if (nowMine && (!wasMine || before.turn !== after.turn)) sfx.turn();
  if (after.trade?.to === me && JSON.stringify(after.trade) !== JSON.stringify(before.trade)) sfx.notify();
}

function setView(three) {
  use3d = three && !!board3d;
  $('board3d').hidden = !use3d;
  $('board').hidden = use3d;
  try { localStorage.setItem('estate-view', use3d ? '3d' : '2d'); } catch { /* ignore */ }
  render();
}
let selectedSpace = null;
function showSpace(pos) {
  selectedSpace = pos;
  board3d?.select(pos);
  renderSpaceInfo();
}
function renderSpaceInfo() {
  const box = $('space-info');
  const pos = selectedSpace;
  if (pos === null || pos === undefined || !game) { box.hidden = true; return; }
  const sp = BOARD[pos];
  const st = game.state.props[pos];
  const rows = [];
  const row = (a, b) => rows.push(el('tr', {}, el('td', {}, a), el('td', {}, String(b))));
  if (sp.type === 'property') {
    const [base, ...more] = sp.rents;
    row('Rent', base);
    row('Rent with full set', base * 2);
    more.slice(0, 4).forEach((r, i) => row(`With ${i + 1} house${i ? 's' : ''}`, r));
    row('With hotel', more[4]);
    row('House cost', sp.houseCost);
  } else if (sp.type === 'station') {
    STATION_RENTS.forEach((r, i) => row(`${i + 1} station${i ? 's' : ''} owned`, r));
  } else if (sp.type === 'utility') {
    row('One utility', '4 × dice');
    row('Both utilities', '10 × dice');
  } else if (sp.type === 'tax') {
    row('Pay', sp.amount);
  }
  if (sp.price) { row('Price', sp.price); row('Mortgage value', sp.mortgage); }
  const owner = st?.owner ? `Owned by ${nameOf(st.owner)}${st.mortgaged ? ' (mortgaged)' : ''}` : sp.price ? 'For sale' : '';
  box.replaceChildren(
    el('div', { class: 'hd' },
      sp.group ? el('span', { class: 'band', style: `background:${GROUPS[sp.group].color}` }) : null,
      sp.name,
      el('button', { class: 'small ghost close', onclick: () => showSpace(null), 'aria-label': 'Close' }, '✕')),
    owner ? el('div', { class: 'tag' }, owner) : null,
    rows.length ? el('table', {}, rows) : null);
  box.hidden = false;
}

// --------------------------------------------------------------- helpers

const nameOf = (id) => game?.state.players.find((p) => p.id === id)?.name
  ?? lobby?.members.find((m) => m.id === id)?.name ?? id;
// Colours follow seat ids (p1, p2, ...) so they match between lobby and game.
const colorOf = (id) => COLORS[(Number(String(id).slice(1)) - 1 + COLORS.length) % COLORS.length] ?? COLORS[0];
const sp = (pos) => BOARD[pos].name;
/** The piece a player picked in the lobby (or a default one). */
const pieceOf = (id) => pieceByKey(lobby?.members.find((m) => m.id === id)?.piece) ?? pieceFor(id);
/** A small picture of a piece in a colour (rendered in 3D once, then cached); emoji without WebGL. */
const pieceThumbs = new Map();
function pieceIcon(piece, color, cls = 'piece') {
  if (board3d) {
    const key = `${piece.key}|${color}`;
    let src = pieceThumbs.get(key);
    if (!src) {
      try { src = board3d.pieceThumbnail(piece, color, 128); pieceThumbs.set(key, src); } catch { src = null; }
    }
    if (src) return el('img', { class: `${cls} piece-img`, src, alt: piece.name, title: piece.name, draggable: 'false' });
  }
  return el('span', { class: cls, title: piece.name }, piece.emoji);
}

function describe(e) {
  switch (e.type) {
    case 'roll': return `${nameOf(e.player)} rolled ${e.dice[0]} + ${e.dice[1]}${e.double ? ' (doubles!)' : ''}`;
    case 'pass_start': return `${nameOf(e.player)} passed Start and collected ${e.amount}`;
    case 'bought': return `${nameOf(e.player)} bought ${sp(e.pos)} for ${e.price}`;
    case 'rent': return `${nameOf(e.player)} owes ${nameOf(e.owner)} ${e.amount} rent`;
    case 'pay': return e.reason === 'rent' ? null : `${nameOf(e.from)} paid ${e.to === 'bank' ? 'the bank' : nameOf(e.to)} ${e.amount}`;
    case 'card': return `${nameOf(e.player)} drew: “${e.text}”`;
    case 'go_to_jail': return `${nameOf(e.player)} went to Pușcărie`;
    case 'jail_release': return `${nameOf(e.player)} left Pușcărie (${e.reason})`;
    case 'auction_start': return `Auction for ${sp(e.pos)}`;
    case 'bid': return `${nameOf(e.player)} bid ${e.amount}`;
    case 'auction_won': return `${nameOf(e.player)} won ${sp(e.pos)} for ${e.amount}`;
    case 'auction_none': return `Nobody bought ${sp(e.pos)}`;
    case 'built': return `${nameOf(e.player)} built on ${sp(e.pos)}`;
    case 'sold_building': return `${nameOf(e.player)} sold a building on ${sp(e.pos)}`;
    case 'mortgaged': return `${nameOf(e.player)} mortgaged ${sp(e.pos)}`;
    case 'unmortgaged': return `${nameOf(e.player)} paid off ${sp(e.pos)}`;
    case 'trade_proposed': return `${nameOf(e.from)} proposed a trade to ${nameOf(e.to)}`;
    case 'trade_done': return `Trade between ${nameOf(e.from)} and ${nameOf(e.to)} completed`;
    case 'trade_declined': return `${nameOf(e.to)} declined the trade`;
    case 'debt': return `${nameOf(e.player)} owes ${e.total} and must raise money`;
    case 'bankrupt': return `${nameOf(e.player)} went bankrupt`;
    case 'game_over': return `🏆 ${nameOf(e.winner)} wins!`;
    default: return null;
  }
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

// ---------------------------------------------------------------- render

function render() {
  if (!session || !lobby) return;
  if (!lobby.started || !game) return renderLobby();
  show('game');
  viewMenu.sync();
  if (use3d) board3d.sync(game.state);
  else renderBoard();
  renderSide();
  renderSpaceInfo();
  renderLog();
  tradeUI.update();
}

function renderLobby() {
  show('lobby');
  $('room-code').textContent = lobby.code;
  const link = `${location.origin}${location.pathname}?room=${lobby.code}`;
  $('share').textContent = link;
  $('share').href = link;
  const isHost = lobby.hostId === session.id;
  $('members').replaceChildren(...lobby.members.map((m) => el('li', {},
    el('span', { class: 'dot', style: `background:${colorOf(m.id)}` }),
    pieceIcon(pieceOf(m.id), colorOf(m.id)),
    el('span', { class: 'grow' }, m.name, m.id === session.id ? ' (you)' : ''),
    el('span', { class: 'tag' }, m.bot ? 'bot' : m.id === lobby.hostId ? 'host' : m.connected ? '' : 'offline'),
    isHost && m.id !== session.id ? el('button', { class: 'small', onclick: () => host('kick', m.id) }, 'Remove') : null,
  )));
  renderPiecePicker();
  $('host-controls').hidden = !isHost;
  $('lobby-wait').hidden = isHost;
  $('add-bot').disabled = lobby.members.length >= 8;
  $('start').disabled = lobby.members.length < 2;
}

function renderPiecePicker() {
  const mine = lobby.members.find((m) => m.id === session.id)?.piece;
  const owners = new Map(lobby.members.map((m) => [m.piece, m]));
  $('piece-picker').replaceChildren(...PIECES.map((p) => {
    const owner = owners.get(p.key);
    const isMine = p.key === mine;
    const takenByOther = owner && owner.id !== session.id;
    return el('button', {
      type: 'button',
      class: `pick${isMine ? ' on' : ''}${takenByOther ? ' taken' : ''}`,
      role: 'radio',
      'aria-checked': String(isMine),
      disabled: takenByOther || null,
      title: takenByOther ? `${p.name}: taken by ${owner.name}` : p.name,
      style: owner ? `--owner:${colorOf(owner.id)}` : '',
      onclick: async () => {
        $('lobby-error').textContent = '';
        try { await roomApi('piece', { piece: p.key }); } catch (e) { $('lobby-error').textContent = e.message; }
      },
    },
    pieceIcon(p, owner ? colorOf(owner.id) : colorOf(session.id), 'pick-emoji'),
    el('span', { class: 'pick-name' }, p.name),
    takenByOther ? el('span', { class: 'pick-owner' }, owner.name) : null,
    isMine ? el('span', { class: 'pick-owner' }, 'You') : null);
  }));
}

function gridArea(pos) {
  if (pos <= 10) return [11, 11 - pos];
  if (pos <= 20) return [11 - (pos - 10), 1];
  if (pos <= 30) return [1, 1 + (pos - 20)];
  return [1 + (pos - 30), 11];
}

function renderBoard() {
  const { state } = game;
  const last = lastEvent || null;
  const cells = BOARD.map((space) => {
    const [r, c] = gridArea(space.pos);
    const prop = state.props[space.pos];
    const corner = [0, 10, 20, 30].includes(space.pos);
    const here = state.players.filter((p) => !p.bankrupt && p.pos === space.pos);
    const h = prop?.houses ?? 0;
    return el('div', {
      class: `cell${corner ? ' corner' : ''}${prop?.mortgaged ? ' mortgaged' : ''}${cur()?.pos === space.pos ? ' last' : ''}`,
      style: `grid-row:${r};grid-column:${c}${cur()?.pos === space.pos ? `;--pc:${colorOf(cur().id)}` : ''}`,
      title: tooltip(space),
      onclick: () => showSpace(space.pos),
    },
    space.group ? el('div', { class: 'band', style: `background:${GROUPS[space.group].color}` }) : null,
    el('div', { class: 'nm' }, space.name),
    space.price && !prop?.owner ? el('div', { class: 'pr' }, String(space.price)) : null,
    h ? el('div', { class: 'bld' }, h === 5 ? '🏨' : '🏠'.repeat(h)) : null,
    el('div', { class: 'tokens' }, here.map((p) => el('span', { class: 'dot', style: `background:${colorOf(p.id)}`, title: p.name }))),
    prop?.owner ? el('span', { class: 'owner', style: `background:${colorOf(prop.owner)}`, title: `Owned by ${nameOf(prop.owner)}` }) : null);
  });
  const center = el('div', { class: 'center' },
    el('div', { class: 'title' }, 'GURTPOLY'),
    state.dice ? el('div', { class: 'dice' }, DIE[state.dice[0]] + DIE[state.dice[1]]) : null,
    el('div', { class: 'msg' }, last ?? ''));
  $('board').replaceChildren(...cells, center);
}


function tooltip(space) {
  if (space.type === 'property') {
    const [base, h1, h2, h3, h4, hotel] = space.rents;
    return `${space.name}\nPrice ${space.price} · House ${space.houseCost}\nRent ${base} (x2 with set) · ${h1}/${h2}/${h3}/${h4} · hotel ${hotel}`;
  }
  if (space.type === 'station') return `${space.name}\nPrice 200 · Rent 25/50/100/200 by stations owned`;
  if (space.type === 'utility') return `${space.name}\nPrice 150 · Rent 4x dice (10x with both)`;
  if (space.type === 'tax') return `${space.name}: pay ${space.amount}`;
  return space.name;
}

const cur = () => game?.state.players[game.state.current];
const me = () => game?.state.players.find((p) => p.id === session.id);

function statusText() {
  const s = game.state;
  if (s.winner) return `🏆 ${nameOf(s.winner)} wins!`;
  const mine = (id) => (id === session.id ? 'You' : nameOf(id));
  switch (s.phase) {
    case 'auction': return `Auction: ${sp(s.auction.pos)}. High bid ${s.auction.highBid}${s.auction.highBidder ? ` (${nameOf(s.auction.highBidder)})` : ''}. ${mine(s.auction.order[s.auction.idx])} to bid.`;
    case 'trade': return `${nameOf(s.trade.from)} is offering ${nameOf(s.trade.to)} a trade…`;
    case 'debt': return `${mine(cur().id)} owe${cur().id === session.id ? '' : 's'} ${s.debt.total}. Raise cash or go bankrupt.`;
    case 'buy': return `${mine(cur().id)} landed on ${sp(s.buy.pos)} (${BOARD[s.buy.pos].price}).`;
    default: return cur().id === session.id ? 'Your turn.' : `${nameOf(cur().id)}'s turn.`;
  }
}

// ------------------------------------------------- auto roll / auto end turn

// A button that presses itself after a short countdown (shown on the button),
// unless the player is busy with a trade or a card. Each can be switched off.
function makeAuto({ action, label, seconds, key, canRun }) {
  const auto = { timer: null, deadline: 0 };
  const btn = () => document.querySelector(`#actions button[data-action="${action}"]`);
  auto.on = () => { try { return localStorage.getItem(key) !== 'off'; } catch { return true; } };
  auto.set = (on) => { try { localStorage.setItem(key, on ? 'on' : 'off'); } catch { /* ignore */ } };
  auto.stop = () => {
    clearInterval(auto.timer);
    auto.timer = null;
    const b = btn();
    if (b) b.textContent = label;
  };
  auto.restart = () => { if (auto.timer) auto.deadline = Date.now() + seconds * 1000; };
  auto.schedule = () => {
    auto.stop();
    const busy = tradeUI.isOpen() || raiseUI.isOpen() || !$('card-popup').hidden || !$('trade-modal').hidden;
    if (!game || !canRun(game.legal) || !auto.on() || busy) return;
    auto.deadline = Date.now() + seconds * 1000;
    const tick = () => {
      const b = btn();
      if (!b || b.disabled) return auto.stop();
      if (tradeUI.isOpen() || raiseUI.isOpen() || !$('card-popup').hidden) {
        // paused while the player is busy; start over afterwards
        auto.deadline = Date.now() + seconds * 1000;
        b.textContent = label;
        return;
      }
      const left = Math.ceil((auto.deadline - Date.now()) / 1000);
      if (left <= 0) {
        auto.stop();
        act({ type: action });
        return;
      }
      b.textContent = `${label} (${left})`;
    };
    tick();
    auto.timer = setInterval(tick, 200);
  };
  return auto;
}
const has = (legal, t) => legal.some((a) => a.type === t);
const autoEnd = makeAuto({
  action: 'end_turn', label: 'End turn', seconds: 4, key: 'estate-auto-end',
  canRun: (legal) => has(legal, 'end_turn'),
});
// Auto roll only for a plain roll: in jail you get to choose (pay, use a card, or roll).
const autoRoll = makeAuto({
  action: 'roll', label: '🎲 Roll dice', seconds: 3, key: 'estate-auto-roll',
  canRun: (legal) => has(legal, 'roll') && !has(legal, 'pay_jail_fine') && !has(legal, 'use_jail_card'),
});
function scheduleAutoEnd() { autoEnd.schedule(); autoRoll.schedule(); }
function stopAutoEnd() { autoEnd.stop(); autoRoll.stop(); }
// Doing something with your properties restarts the countdowns.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest?.('#mine, #trade-banner, .view-fab, .view-menu')) { autoEnd.restart(); autoRoll.restart(); }
}, true);

function renderSide() {
  const { state, legal } = game;
  const p = me();
  $('status').textContent = statusText() + (p?.bankrupt ? " You're out, you can keep watching." : '');
  const buttons = [];
  const LABEL = {
    roll: '🎲 Roll dice', pay_jail_fine: `Pay fine (${state.rules.jailFine})`, use_jail_card: 'Use jail card',
    buy: `Buy${state.phase === 'buy' ? ` (${BOARD[state.buy.pos].price})` : ''}`, decline: 'Auction it', pass: 'Pass',
    end_turn: 'End turn', pay_debt: 'Pay debt', declare_bankruptcy: 'Go bankrupt',
  };
  if (state.phase === 'debt' && has(legal, 'raise_cash')) {
    buttons.push(el('button', {
      type: 'button', class: has(legal, 'pay_debt') ? '' : 'primary', 'data-action': 'raise',
      onclick: () => raiseUI.open(),
    }, '💰 Raise money…'));
  }
  for (const a of legal) {
    if (a.type === 'bid') {
      const input = el('input', { type: 'number', min: a.min, max: a.max, value: a.min, 'aria-label': 'Bid amount', inputmode: 'numeric' });
      buttons.push(el('div', { class: 'row bid-row' }, input,
        el('button', { class: 'primary', onclick: () => act({ type: 'bid', amount: Number(input.value) }) }, 'Bid')));
    } else if (LABEL[a.type]) {
      const danger = a.type === 'declare_bankruptcy';
      buttons.push(el('button', {
        type: 'button',
        class: ['roll', 'buy', 'end_turn', 'pay_debt'].includes(a.type) ? 'primary' : danger ? 'danger' : '',
        'data-action': a.type,
        onclick: () => (!danger || confirm('Give up and go bankrupt?')) && act({ type: a.type }),
      }, LABEL[a.type]));
    }
  }
  const toggle = (auto, text, title) => el('label', { class: 'auto-chip', title },
    el('input', { type: 'checkbox', checked: auto.on() || null, onchange: (e) => { auto.set(e.target.checked); scheduleAutoEnd(); } }),
    el('span', {}, text));
  const opts = [];
  if (has(legal, 'roll')) opts.push(toggle(autoRoll, 'Auto roll', 'Roll the dice by itself a few seconds after your turn starts (not in Pușcărie)'));
  if (has(legal, 'end_turn')) opts.push(toggle(autoEnd, 'Auto end', 'End your turn by itself a few seconds after your move'));
  $('actions').replaceChildren(...buttons);
  $('dock-opts').replaceChildren(...opts);
  $('dock-status').textContent = statusText();
  const wasHidden = $('dock').hidden;
  $('dock').hidden = !buttons.length;
  if (!buttons.length) dockError();
  if (wasHidden && buttons.length) {
    // replay the pop-in animation each time it is your move
    $('dock').classList.remove('pop');
    void $('dock').offsetWidth;
    $('dock').classList.add('pop');
  }
  scheduleAutoEnd();

  const isHost = lobby.hostId === session.id;
  $('players').replaceChildren(...state.players.map((pl) => {
    const m = lobby.members.find((x) => x.id === pl.id);
    const offline = m && !m.bot && !m.connected && !m.autoplay;
    const canHandOver = isHost && m && !m.bot && !m.autoplay && !m.left && pl.id !== session.id && !pl.bankrupt;
    return el('li', { class: `${pl.id === cur().id ? 'turn' : ''}${pl.bankrupt ? ' out' : ''}`, 'data-flash': '' },
      el('span', { class: 'dot', style: `background:${colorOf(pl.id)}` }),
      pieceIcon(pieceOf(pl.id), colorOf(pl.id)),
      el('span', { class: 'grow' }, pl.name, pl.id === session.id ? ' (you)' : '', pl.inJail ? ' 🔒' : ''),
      el('span', { class: 'tag' }, m?.bot ? 'bot' : m?.left ? 'left' : m?.autoplay ? 'bot playing' : offline ? 'offline' : ''),
      canHandOver ? el('button', {
        class: 'small',
        title: `Let a bot play for ${pl.name} (e.g. if they're away). They can take the seat back.`,
        onclick: () => confirm(`Let a bot play for ${pl.name}? They can take their seat back with "I'm back".`) && host('takeover', pl.id),
      }, 'Bot plays') : null,
      el('span', { class: `cash ${money.direction(pl.id)}`, 'data-cash': pl.id }, money.value(pl.id)));
  }));
  renderMine();

  const meM = lobby.members.find((x) => x.id === session.id);
  const away = !!meM?.autoplay && !meM.left && !me()?.bankrupt && !state.winner;
  $('away-bar').hidden = !away;
  if (away) {
    $('away-bar').replaceChildren(
      el('span', {}, '🤖 A bot is playing for you.'),
      el('button', { type: 'button', class: 'small primary', onclick: () => roomApi('back').catch((e) => { $('game-error').textContent = e.message; }) }, "I'm back"));
  }
  $('restart-game').hidden = !isHost;
}

function renderMine() {
  const { state, legal } = game;
  const owned = Object.keys(state.props).map(Number).filter((pos) => state.props[pos].owner === session.id);
  const can = (type, pos) => legal.some((a) => a.type === type && a.pos === pos);
  const myTurn = cur()?.id === session.id;
  const ownsSet = (g) => GROUP_POSITIONS[g].every((q) => state.props[q].owner === session.id);
  let raise = 0;
  const cards = owned.map((pos) => {
    const space = BOARD[pos];
    const st = state.props[pos];
    const full = space.type === 'property' && ownsSet(space.group);
    const groupBuilt = space.group && GROUP_POSITIONS[space.group].some((q) => state.props[q].houses > 0);
    if (!st.mortgaged) raise += space.mortgage + (st.houses * (space.houseCost ?? 0)) / 2;
    const why = (type) => {
      if (!myTurn) return 'Only on your turn';
      if (type === 'mortgage' && groupBuilt) return 'Sell the buildings in this set first';
      if (type === 'unmortgage') return 'Not enough cash';
      if (type === 'build') return 'Build evenly, with enough cash, and no mortgages in the set';
      return 'Not possible right now';
    };
    const btn = (type, label, cls = '') => {
      const ok = can(type, pos);
      return el('button', {
        type: 'button', class: `small ${cls}`, disabled: !ok || null, title: ok ? '' : why(type),
        onclick: () => act({ type, pos }),
      }, label);
    };
    const buttons = [];
    if (st.mortgaged) buttons.push(btn('unmortgage', `Pay off −${Math.ceil(space.mortgage * 1.1)}`, 'primary'));
    else buttons.push(btn('mortgage', `Mortgage +${space.mortgage}`));
    if (full) {
      if (st.houses < 5) buttons.push(btn('build', `${st.houses === 4 ? 'Hotel' : 'House'} −${space.houseCost}`));
      if (st.houses > 0) buttons.push(btn('sell_building', `Sell ${st.houses === 5 ? 'hotel' : 'house'} +${space.houseCost / 2}`));
    }
    const extra = [];
    if (st.houses) extra.push(el('span', { class: 'deed-bld', title: st.houses === 5 ? 'Hotel' : `${st.houses} house(s)` }, st.houses === 5 ? '🏨' : '🏠'.repeat(st.houses)));
    if (full) extra.push(el('span', { class: 'deed-set', title: 'You own the full colour set' }, 'SET'));
    return el('div', { class: 'mycard' },
      deedCard(state, pos, { onclick: () => showSpace(pos), pressed: false, title: `${space.name}: tap for full details`, extra }),
      el('div', { class: 'mycard-btns' }, buttons));
  });
  const head = owned.length
    ? el('div', { class: 'mine-head' },
      el('span', { class: 'tag' }, `${owned.length} propert${owned.length === 1 ? 'y' : 'ies'} · you could raise about ¤${raise.toLocaleString()} by mortgaging and selling buildings`),
      legal.some((a) => a.type === 'raise_cash')
        ? el('button', { type: 'button', class: 'small', onclick: () => raiseUI.open() }, 'Sell / mortgage several…') : null)
    : null;
  const supply = el('div', { class: 'tag supply' },
    'Own every street of a colour to build. Up to 4 houses each, then a hotel. ',
    el('b', {}, `Bank: ${state.bank.houses} houses, ${state.bank.hotels} hotels left.`));
  $('mine').replaceChildren(...(cards.length ? [head, el('div', { class: 'mycards' }, cards), supply] : [el('div', { class: 'tag' }, 'Nothing yet. Properties you buy show up here as cards.')]));
}

function renderLog() {
  const list = $('log');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  list.replaceChildren(...logLines.slice(-150).map((l) => el('li', { class: 'chat' }, el('b', {}, `${l.name}: `), l.text)));
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ------------------------------------------------------------------ wiring

$('name').value = store.name();
const params = new URLSearchParams(location.search);
if (params.get('room')) $('code').value = params.get('room').toUpperCase();

async function homeAction(fn) {
  $('home-error').textContent = '';
  const name = $('name').value.trim();
  if (!name) { $('home-error').textContent = 'Enter your name first.'; $('name').focus(); return; }
  store.setName(name);
  try {
    const next = await fn(name);
    const old = store.get();
    if (old && old.code !== next.code) await forgetSaved();
    enterRoom(next);
  } catch (e) {
    $('home-error').textContent = e.message;
  }
}
$('create').onclick = () => homeAction((name) => api('/api/rooms', { name }));
$('join').onclick = () => homeAction((name) => {
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) throw new Error('Room codes are 4 characters.');
  return api(`/api/rooms/${code}/join`, { name });
});
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
function setCamera(mode) {
  if (!board3d) return;
  board3d.setMode(mode);
  try { localStorage.setItem('estate-cam', mode); } catch { /* ignore */ }
}
try {
  const savedCam = localStorage.getItem('estate-cam');
  if (board3d && savedCam) board3d.setMode(savedCam);
} catch { /* ignore */ }
try { if (localStorage.getItem('estate-view') === '2d') use3d = false; } catch { /* ignore */ }
$('board3d').hidden = !use3d;
$('board').hidden = use3d;
$('leave-game').onclick = async () => {
  const over = game?.state.winner;
  if (!over && !confirm('Leave this game? A bot will finish it in your seat, and you can start or join a new game.')) return;
  try { await roomApi('leave'); } catch { /* already gone */ }
  leaveRoom(over ? '' : 'You left the game. Create a new room or join another one.');
};
$('restart-game').onclick = () => {
  if (game?.state.winner || confirm('End this game for everyone and go back to the lobby? Progress will be lost.')) host('restart');
};
// ------------------------------------------------------- background + fullscreen

function setBackground(key) {
  if (!board3d) return;
  board3d.setBackground(key);
  try { localStorage.setItem('estate-bg', board3d.background()); } catch { /* ignore */ }
}
try { setBackground(localStorage.getItem('estate-bg') || 'classic'); } catch { setBackground('classic'); }

let realFullscreen = false;
// on: show the board over the whole page; real: also ask the browser for true
// fullscreen (hides tabs and the address bar). real=false keeps the browser bars.
function setFull(on, real = true) {
  const was = document.body.classList.contains('full');
  document.body.classList.toggle('full', on);
  if (!was) document.body.classList.remove('panel-hidden');
  syncPanelButtons();
  requestAnimationFrame(updateViewInset);
  if (on && real && !document.fullscreenElement) {
    // also hide the browser's own bars where allowed (not on every phone)
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        const p = req.call(el, { navigationUI: 'hide' });
        if (p?.then) p.then(() => { realFullscreen = true; }).catch(() => {});
      } catch { /* not allowed */ }
    }
  } else if (!(on && real) && document.fullscreenElement) {
    realFullscreen = false;
    document.exitFullscreen?.().catch(() => {});
  }
  if (!on) realFullscreen = false;
}
let fullMode = null; // null | 'screen' | 'window'
/** mode: 'window' (fill the browser window), 'screen' (real fullscreen) or null. */
function setFullMode(mode) {
  fullMode = mode;
  setFull(!!fullMode, fullMode === 'screen');
  viewMenu.sync();
}
function setPanelShown(shown) {
  document.body.classList.toggle('panel-hidden', !shown);
  syncPanelButtons();
  updateViewInset();
  viewMenu.sync();
}
function syncPanelButtons() {
  const full = document.body.classList.contains('full');
  const hidden = document.body.classList.contains('panel-hidden');
  $('panel-show').hidden = !(full && hidden);
}
function updateViewInset() {
  if (!board3d) return;
  const full = document.body.classList.contains('full');
  const panelShown = full && !document.body.classList.contains('panel-hidden');
  const side = document.querySelector('#game .side');
  const wide = innerWidth > 760;
  const right = panelShown && wide && side ? side.getBoundingClientRect().width + 24 : 0;
  // room at the bottom for the floating move buttons (the dock)
  board3d.setViewInset(right, innerWidth <= 600 ? 64 : 76);
  $('game').style.setProperty('--inset-r', `${right}px`);
}
addEventListener('resize', updateViewInset);
updateViewInset();
$('panel-hide').onclick = () => setPanelShown(false);
$('panel-show').onclick = () => setPanelShown(true);
document.addEventListener('fullscreenchange', () => {
  // Esc in the browser's fullscreen also leaves our full-page view
  if (!document.fullscreenElement && realFullscreen) { realFullscreen = false; setFullMode(null); }
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('full')
    && $('trade-modal').hidden && $('card-popup').hidden) setFullMode(null);
});

// ----------------------------------------------------------------- sound

// ------------------------------------------------------------ view menu

const thumbs = new Map();
const viewMenu = createViewMenu({
  root: $('view-menu'),
  backdrop: $('view-backdrop'),
  button: $('view-btn'),
  backgrounds: BACKGROUNDS,
  thumb: (bg) => {
    if (!thumbs.has(bg.key)) thumbs.set(bg.key, drawTableTile(bg, 96).toDataURL());
    return thumbs.get(bg.key);
  },
  get: () => ({
    use3d, has3d: !!board3d, camMode: board3d?.mode() ?? 'overview', bg: board3d?.background() ?? 'classic',
    full: fullMode, panelHidden: document.body.classList.contains('panel-hidden'), sound: soundOn(),
  }),
  act: {
    setCam: setCamera,
    resetCam: () => board3d?.resetView(),
    setBg: setBackground,
    setFull: setFullMode,
    setPanel: setPanelShown,
    setSound,
    set3d: (on) => setView(on),
  },
});
// a soft click for buttons and menus
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('button, .pick, .chip, summary');
  if (b && !b.disabled && b.dataset?.tile !== 'sound') sfx.click();
}, true);
document.addEventListener('change', (e) => { if (e.target.matches?.('select, input[type=checkbox]')) sfx.click(); }, true);

$('add-bot').onclick = () => host('add_bot');
$('start').onclick = () => host('start');
$('copy').onclick = () => navigator.clipboard?.writeText($('share').href);
$('leave-lobby').onclick = async () => {
  try { await roomApi('leave'); } catch { /* already gone */ }
  leaveRoom();
};
$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  $('chat-input').value = '';
  roomApi('chat', { text }).catch(() => {});
};

// Resume a saved seat. Reloading the room's own page (?room=CODE) goes straight back
// in; opening the plain site shows the start page with a "Rejoin" offer instead of
// forcing you into the old room.
async function forgetSaved() {
  const old = store.get();
  $('resume').hidden = true;
  if (!old) return;
  store.clear();
  try { await api(`/api/rooms/${old.code}/leave`, { token: old.token }); } catch { /* already gone */ }
}
const saved = store.get();
if (saved && params.get('room')?.toUpperCase() === saved.code) {
  api(`/api/rooms/${saved.code}/join`, { token: saved.token })
    .then(enterRoom)
    .catch(() => { store.clear(); show('home'); });
} else {
  show('home');
  if (saved) {
    // only offer it if the seat still exists (rejoining with the token doesn't change anything)
    api(`/api/rooms/${saved.code}/join`, { token: saved.token })
      .then(() => {
        if (session || store.get()?.code !== saved.code) return;
        $('resume-code').textContent = saved.code;
        $('resume').hidden = false;
      })
      .catch(() => store.clear());
  }
}
$('resume-go').onclick = () => {
  const s = store.get();
  if (!s) { $('resume').hidden = true; return; }
  api(`/api/rooms/${s.code}/join`, { token: s.token })
    .then((r) => { $('resume').hidden = true; enterRoom(r); })
    .catch(() => { forgetSaved(); $('home-error').textContent = 'That room is no longer available.'; });
};
$('resume-forget').onclick = () => forgetSaved();
