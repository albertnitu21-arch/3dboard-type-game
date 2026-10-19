// Minimal web client: lobby + a flat 2D board. A stand-in until the 3D board exists;
// the 3D client can reuse everything here except render().

import { BOARD, GROUPS, STATION_RENTS } from '/engine/board.js';
import { createBoard3D } from './board3d.js';

const $ = (id) => document.getElementById(id);
const API = ''; // same origin; set to the server URL if the page is hosted elsewhere
const COLORS = ['#e4572e', '#2e86ab', '#f2c14e', '#7b2cbf', '#3bb273', '#ff7aa2', '#5c4d3c', '#00b4d8'];
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let session = null; // { code, id, token }
let source = null;
let lobby = null;
let game = null; // { state, legal }
const logLines = [];

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

async function act(action) {
  $('game-error').textContent = '';
  // Lock the buttons until the result has been animated, so nothing is sent twice.
  const buttons = document.querySelectorAll('#actions button, #mine button, #trade-form button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await roomApi('action', { action });
  } catch (e) {
    $('game-error').textContent = e.message;
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

function leaveRoom(message = '') {
  source?.close();
  source = null;
  session = null;
  lobby = null;
  game = null;
  queue.length = 0;
  selectedSpace = null;
  logLines.length = 0;
  store.clear();
  history.replaceState(null, '', location.pathname);
  show('home');
  $('home-error').textContent = message;
}

function connect() {
  source?.close();
  source = new EventSource(`${API}/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`);
  source.addEventListener('lobby', (e) => { lobby = JSON.parse(e.data); render(); });
  source.addEventListener('state', (e) => enqueue(JSON.parse(e.data)));
  source.addEventListener('chat', (e) => {
    const m = JSON.parse(e.data);
    logLines.push({ text: `${m.name}: ${m.text}`, chat: true });
    renderLog();
  });
  source.addEventListener('kicked', () => leaveRoom('You were removed from the room.'));
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
setInterval(() => {
  if (session && !document.hidden) fetch(`${API}/health`, { cache: 'no-store' }).catch(() => {});
}, 4 * 60 * 1000);

// ------------------------------------------------------- 3D board + queue

let board3d = null;
let use3d = true;
try {
  board3d = createBoard3D($('board-canvas'), { board: BOARD, groups: GROUPS, colorOf: (id) => colorOf(id), nameOf: (id) => nameOf(id) });
} catch (err) {
  console.warn('3D board unavailable:', err);
}
if (!board3d) use3d = false;
if (board3d) board3d.onSpace = (pos) => showSpace(pos);

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
    game = { state: d.state, legal: d.legal };
    for (const ev of d.events) {
      const line = describe(ev);
      if (line) logLines.push({ text: line });
    }
    render();
  }
  draining = false;
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

function describe(e) {
  switch (e.type) {
    case 'roll': return `${nameOf(e.player)} rolled ${e.dice[0]} + ${e.dice[1]}${e.double ? ' (doubles!)' : ''}`;
    case 'pass_start': return `${nameOf(e.player)} passed Start and collected ${e.amount}`;
    case 'bought': return `${nameOf(e.player)} bought ${sp(e.pos)} for ${e.price}`;
    case 'rent': return `${nameOf(e.player)} owes ${nameOf(e.owner)} ${e.amount} rent`;
    case 'pay': return e.reason === 'rent' ? null : `${nameOf(e.from)} paid ${e.to === 'bank' ? 'the bank' : nameOf(e.to)} ${e.amount}`;
    case 'card': return `${nameOf(e.player)} drew: “${e.text}”`;
    case 'go_to_jail': return `${nameOf(e.player)} went to the Lockup`;
    case 'jail_release': return `${nameOf(e.player)} left the Lockup (${e.reason})`;
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
  $('toggle-view').hidden = !board3d;
  $('toggle-view').textContent = use3d ? '2D view' : '3D view';
  $('reset-view').hidden = !use3d;
  if (use3d) board3d.sync(game.state);
  else renderBoard();
  renderSide();
  renderSpaceInfo();
  renderLog();
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
    el('span', { class: 'grow' }, m.name, m.id === session.id ? ' (you)' : ''),
    el('span', { class: 'tag' }, m.bot ? 'bot' : m.id === lobby.hostId ? 'host' : m.connected ? '' : 'offline'),
    isHost && m.id !== session.id ? el('button', { class: 'small', onclick: () => host('kick', m.id) }, 'Remove') : null,
  )));
  $('host-controls').hidden = !isHost;
  $('lobby-wait').hidden = isHost;
  $('add-bot').disabled = lobby.members.length >= 8;
  $('start').disabled = lobby.members.length < 2;
}

function gridArea(pos) {
  if (pos <= 10) return [11, 11 - pos];
  if (pos <= 20) return [11 - (pos - 10), 1];
  if (pos <= 30) return [1, 1 + (pos - 20)];
  return [1 + (pos - 30), 11];
}

function renderBoard() {
  const { state } = game;
  const last = [...logLinesEvents()].pop();
  const cells = BOARD.map((space) => {
    const [r, c] = gridArea(space.pos);
    const prop = state.props[space.pos];
    const corner = [0, 10, 20, 30].includes(space.pos);
    const here = state.players.filter((p) => !p.bankrupt && p.pos === space.pos);
    const h = prop?.houses ?? 0;
    return el('div', {
      class: `cell${corner ? ' corner' : ''}${prop?.mortgaged ? ' mortgaged' : ''}${cur()?.pos === space.pos ? ' last' : ''}`,
      style: `grid-row:${r};grid-column:${c}`,
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
    el('div', { class: 'title' }, 'Estate'),
    state.dice ? el('div', { class: 'dice' }, DIE[state.dice[0]] + DIE[state.dice[1]]) : null,
    el('div', { class: 'msg' }, last ?? ''));
  $('board').replaceChildren(...cells, center);
}

function* logLinesEvents() {
  for (const l of logLines.slice(-1)) if (!l.chat) yield l.text;
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
    case 'trade': return `${nameOf(s.trade.from)} offers ${nameOf(s.trade.to)} a trade.`;
    case 'debt': return `${mine(cur().id)} owe${cur().id === session.id ? '' : 's'} ${s.debt.total}. Raise cash or go bankrupt.`;
    case 'buy': return `${mine(cur().id)} landed on ${sp(s.buy.pos)} (${BOARD[s.buy.pos].price}).`;
    default: return cur().id === session.id ? 'Your turn.' : `${nameOf(cur().id)}'s turn.`;
  }
}

function tradeSummary(t) {
  const side = (o) => [o.cash ? `${o.cash} cash` : null, ...o.props.map(sp), o.jailCards ? `${o.jailCards} jail card(s)` : null]
    .filter(Boolean).join(', ') || 'nothing';
  return `${nameOf(t.from)} gives ${side(t.give)} for ${side(t.get)}.`;
}

function renderSide() {
  const { state, legal } = game;
  $('status').textContent = statusText();
  const buttons = [];
  const LABEL = {
    roll: 'Roll dice', pay_jail_fine: `Pay fine (${state.rules.jailFine})`, use_jail_card: 'Use jail card',
    buy: 'Buy', decline: 'Auction it', pass: 'Pass', end_turn: 'End turn', pay_debt: 'Pay debt',
    declare_bankruptcy: 'Declare bankruptcy', accept_trade: 'Accept', decline_trade: 'Decline', cancel_trade: 'Cancel trade',
  };
  if (state.phase === 'trade') buttons.push(el('div', {}, tradeSummary(state.trade)));
  for (const a of legal) {
    if (a.type === 'bid') {
      const input = el('input', { type: 'number', min: a.min, max: a.max, value: a.min, 'aria-label': 'Bid amount' });
      buttons.push(el('div', { class: 'row' }, input,
        el('button', { class: 'primary', onclick: () => act({ type: 'bid', amount: Number(input.value) }) }, 'Bid')));
    } else if (LABEL[a.type]) {
      const danger = a.type === 'declare_bankruptcy';
      buttons.push(el('button', {
        class: ['roll', 'buy', 'end_turn', 'pay_debt', 'accept_trade'].includes(a.type) ? 'primary' : '',
        onclick: () => (!danger || confirm('Give up and go bankrupt?')) && act({ type: a.type }),
      }, LABEL[a.type]));
    }
  }
  const p = me();
  if (p?.bankrupt) buttons.push(el('div', { class: 'tag' }, "You're out. You can keep watching."));
  $('actions').replaceChildren(...buttons);

  const isHost = lobby.hostId === session.id;
  $('players').replaceChildren(...state.players.map((pl) => {
    const m = lobby.members.find((x) => x.id === pl.id);
    const offline = m && !m.bot && !m.connected && !m.autoplay;
    return el('li', { class: `${pl.id === cur().id ? 'turn' : ''}${pl.bankrupt ? ' out' : ''}` },
      el('span', { class: 'dot', style: `background:${colorOf(pl.id)}` }),
      el('span', { class: 'grow' }, pl.name, pl.id === session.id ? ' (you)' : '', pl.inJail ? ' 🔒' : ''),
      el('span', { class: 'tag' }, m?.bot ? 'bot' : m?.autoplay ? 'auto' : offline ? 'offline' : ''),
      isHost && offline && !pl.bankrupt ? el('button', { class: 'small', onclick: () => host('takeover', pl.id) }, 'Bot plays') : null,
      el('span', { class: 'cash' }, String(pl.cash)));
  }));

  renderMine();
  renderTradeForm();
}

function renderMine() {
  const { state, legal } = game;
  const owned = Object.keys(state.props).map(Number).filter((pos) => state.props[pos].owner === session.id);
  const can = (type, pos) => legal.some((a) => a.type === type && a.pos === pos);
  const rows = owned.map((pos) => {
    const st = state.props[pos];
    const b = (type, label) => can(type, pos) ? el('button', { class: 'small', onclick: () => act({ type, pos }) }, label) : null;
    return el('div', { class: 'prop' },
      BOARD[pos].group ? el('span', { class: 'dot', style: `background:${GROUPS[BOARD[pos].group].color}` }) : el('span', { class: 'dot' }),
      el('span', { class: 'grow' }, sp(pos), st.mortgaged ? ' (mortgaged)' : '', st.houses ? ` · ${st.houses === 5 ? 'hotel' : `${st.houses}🏠`}` : ''),
      b('build', 'Build'), b('sell_building', 'Sell'), b('mortgage', 'Mortgage'), b('unmortgage', 'Pay off'));
  });
  $('mine').replaceChildren(...(rows.length ? rows : [el('div', { class: 'tag' }, 'Nothing yet.')]));
}

function renderTradeForm() {
  const { state, legal } = game;
  const box = $('trade-box');
  const allowed = legal.some((a) => a.type === 'propose_trade');
  box.hidden = !allowed;
  if (!allowed) return;
  const form = $('trade-form');
  const prev = form.querySelector('select')?.value;
  const others = state.players.filter((p) => !p.bankrupt && p.id !== session.id);
  const tradable = (id) => Object.keys(state.props).map(Number).filter((pos) => {
    if (state.props[pos].owner !== id) return false;
    const g = BOARD[pos].group;
    return !g || Object.keys(state.props).every((q) => BOARD[q].group !== g || state.props[q].houses === 0);
  });
  const partner = others.find((p) => p.id === prev) ?? others[0];
  if (!partner) return form.replaceChildren();
  const select = el('select', { 'aria-label': 'Trade partner', onchange: renderTradeForm },
    others.map((p) => el('option', { value: p.id, selected: p.id === partner.id }, p.name)));
  const side = (title, who, key) => el('fieldset', {}, el('legend', {}, title),
    el('label', {}, 'Cash', el('input', { type: 'number', min: 0, max: who.cash, value: 0, name: `${key}-cash` })),
    tradable(who.id).map((pos) => el('label', {}, el('input', { type: 'checkbox', name: `${key}-prop`, value: pos }), sp(pos))),
    who.jailCards.length ? el('label', {}, el('input', { type: 'checkbox', name: `${key}-jail` }), 'Jail card') : null);
  form.replaceChildren(
    el('label', {}, 'With', select),
    side('You give', me(), 'give'),
    side('You get', partner, 'get'),
    el('button', { class: 'primary' }, 'Send offer'));
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const offer = (key) => ({
      cash: Number(fd.get(`${key}-cash`)) || 0,
      props: fd.getAll(`${key}-prop`).map(Number),
      jailCards: fd.get(`${key}-jail`) ? 1 : 0,
    });
    act({ type: 'propose_trade', to: select.value, give: offer('give'), get: offer('get') });
  };
}

function renderLog() {
  const list = $('log');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  list.replaceChildren(...logLines.slice(-150).map((l) => el('li', { class: l.chat ? 'chat' : '' }, l.text)));
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
    enterRoom(await fn(name));
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
$('toggle-view').onclick = () => setView(!use3d);
$('reset-view').onclick = () => board3d?.resetView();
try { if (localStorage.getItem('estate-view') === '2d') use3d = false; } catch { /* ignore */ }
$('board3d').hidden = !use3d;
$('board').hidden = use3d;
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

// Resume a saved seat (page reload, phone locked, etc.).
const saved = store.get();
if (saved && (!params.get('room') || params.get('room').toUpperCase() === saved.code)) {
  api(`/api/rooms/${saved.code}/join`, { token: saved.token })
    .then(enterRoom)
    .catch(() => { store.clear(); show('home'); });
} else {
  show('home');
}
