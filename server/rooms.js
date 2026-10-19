// Rooms and lobby: all multiplayer logic, independent of the transport.
//
// A "stream" is anything with send(event, data) and close(). The HTTP layer
// (game-server.js) supplies server-sent-event streams, but a WebSocket wrapper
// would work the same way.
//
// Security model: every seat has a secret token. The server decides who is
// acting (never the client), validates every action through the engine, and only
// sends clients a "public" view of the state (no RNG seed, no card order).

import { randomBytes, randomInt } from 'node:crypto';
import { createGame, applyAction, getLegalActions, getActor, ACTION_TYPES } from '../src/engine.js';
import { chooseAction } from '../src/bot.js';

export class RoomError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'RoomError';
    this.code = code;
  }
}
const bad = (code, message) => { throw new RoomError(code, message); };

export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
const ALLOWED_ACTIONS = new Set(ACTION_TYPES);
const BOT_NAMES = ['Mira', 'Dan', 'Ioana', 'Vlad', 'Ana', 'Radu', 'Elena', 'Tudor'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)

/** What clients may see: everything except the RNG state and the card order. */
export function publicState(s) {
  const { rng, forcedDice, decks, ...rest } = s;
  return { ...rest, deckSizes: { fortune: decks.fortune.length, community: decks.community.length } };
}

function cleanName(raw, fallback) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return s || fallback;
}

export class Room {
  constructor(code, { botDelay = 1500 } = {}) {
    this.code = code;
    this.botDelay = botDelay;
    this.members = [];
    this.nextId = 1;
    this.hostId = null;
    this.state = null;
    this.botTimer = null;
    this.touched = Date.now();
    this.disposed = false;
  }

  get started() { return this.state !== null; }
  member(id) { return this.members.find((m) => m.id === id) ?? null; }
  memberByToken(token) {
    return typeof token === 'string' && token ? this.members.find((m) => m.token === token) ?? null : null;
  }

  // ------------------------------------------------------------ membership

  _uniqueName(base) {
    const taken = new Set(this.members.map((m) => m.name.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 17)} ${n}`;
    return name;
  }

  _add(name, { bot = false } = {}) {
    if (this.members.length >= MAX_PLAYERS) bad('room_full', 'This room is full (8 players).');
    const m = {
      id: `p${this.nextId++}`,
      name: this._uniqueName(name),
      token: bot ? null : randomBytes(16).toString('hex'),
      bot,
      autoplay: false, // a human seat temporarily played by a bot
      stream: null,
    };
    this.members.push(m);
    if (!this.hostId && !bot) this.hostId = m.id;
    return m;
  }

  /** Join as a new seat, or (with a token) reclaim an existing one. */
  join(rawName, token) {
    this.touched = Date.now();
    if (token !== undefined && token !== null && token !== '') {
      const m = this.memberByToken(token);
      if (!m) bad('bad_token', 'That seat is no longer available.');
      return m;
    }
    if (this.started) bad('game_started', 'This game has already started.');
    const m = this._add(cleanName(rawName, `Player ${this.members.length + 1}`));
    this.broadcastInfo();
    return m;
  }

  info() {
    return {
      code: this.code,
      hostId: this.hostId,
      started: this.started,
      members: this.members.map((m) => ({
        id: m.id, name: m.name, bot: m.bot, autoplay: m.autoplay, connected: m.bot || !!m.stream,
      })),
    };
  }

  attach(m, stream) {
    this.touched = Date.now();
    if (m.stream) m.stream.close();
    m.stream = stream;
    m.autoplay = false; // the human is back
    stream.send('lobby', this.info());
    if (this.started) this._sendState(m, []);
    this.broadcastInfo(m);
    this.scheduleBot();
  }

  detach(m, stream) {
    if (m.stream !== stream) return;
    m.stream = null;
    this.broadcastInfo();
  }

  broadcastInfo(except = null) {
    const info = this.info();
    for (const m of this.members) if (m.stream && m !== except) m.stream.send('lobby', info);
  }

  _sendState(m, events) {
    if (!m.stream) return;
    m.stream.send('state', {
      state: publicState(this.state),
      legal: getLegalActions(this.state, m.id),
      events,
    });
  }

  broadcastState(events) {
    for (const m of this.members) this._sendState(m, events);
  }

  // ---------------------------------------------------------- host actions

  _requireHost(by) {
    if (by !== this.hostId) bad('not_host', 'Only the host can do that.');
  }

  addBot(by) {
    this._requireHost(by);
    if (this.started) bad('game_started', 'The game has already started.');
    const used = new Set(this.members.map((m) => m.name));
    const name = BOT_NAMES.map((n) => `Bot ${n}`).find((n) => !used.has(n)) ?? 'Bot';
    this._add(name, { bot: true });
    this.touched = Date.now();
    this.broadcastInfo();
  }

  kick(by, targetId) {
    this._requireHost(by);
    if (this.started) bad('game_started', 'You cannot remove players once the game has started.');
    const m = this.member(targetId);
    if (!m) bad('no_such_player', 'No such player.');
    if (m.id === by) bad('bad_request', 'You cannot remove yourself.');
    this.members = this.members.filter((x) => x !== m);
    m.stream?.send('kicked', {});
    m.stream?.close();
    this.broadcastInfo();
  }

  start(by) {
    this._requireHost(by);
    if (this.started) bad('game_started', 'The game has already started.');
    if (this.members.length < MIN_PLAYERS) bad('not_enough_players', 'You need at least 2 players.');
    const order = [...this.members];
    for (let i = order.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    this.state = createGame({
      players: order.map((m) => ({ id: m.id, name: m.name })),
      seed: randomInt(0, 2 ** 31),
    });
    this.touched = Date.now();
    this.broadcastInfo();
    this.broadcastState([]);
    this.scheduleBot();
  }

  /** Hand a disconnected human's seat to a bot until they return. */
  takeover(by, targetId) {
    this._requireHost(by);
    if (!this.started) bad('not_started', 'The game has not started.');
    const m = this.member(targetId);
    if (!m || m.bot) bad('no_such_player', 'No such player.');
    if (m.stream) bad('still_connected', 'That player is still connected.');
    m.autoplay = true;
    this.broadcastInfo();
    this.scheduleBot();
  }

  leave(id) {
    const m = this.member(id);
    if (!m) return;
    this.touched = Date.now();
    if (!this.started) {
      this.members = this.members.filter((x) => x !== m);
      if (this.hostId === id) this.hostId = this.members.find((x) => !x.bot)?.id ?? null;
    } else {
      m.autoplay = true;
    }
    const stream = m.stream;
    m.stream = null;
    stream?.close();
    this.broadcastInfo();
    this.scheduleBot();
  }

  chat(id, text) {
    const m = this.member(id);
    const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (!m || !t) return;
    const msg = { from: id, name: m.name, text: t, at: Date.now() };
    for (const x of this.members) x.stream?.send('chat', msg);
  }

  // ------------------------------------------------------------- gameplay

  /** Apply a player's action. The acting player is always the authenticated seat. */
  act(id, action) {
    if (!this.started) bad('not_started', 'The game has not started yet.');
    if (!action || typeof action !== 'object' || typeof action.type !== 'string'
      || !ALLOWED_ACTIONS.has(action.type)) {
      bad('bad_action', 'Unknown action.');
    }
    const { state, events } = applyAction(this.state, { ...action, player: id });
    this.state = state;
    this.touched = Date.now();
    this.broadcastState(events);
    this.scheduleBot();
  }

  scheduleBot() {
    clearTimeout(this.botTimer);
    this.botTimer = null;
    if (this.disposed || !this.state || this.state.winner) return;
    const actorId = getActor(this.state);
    const m = actorId && this.member(actorId);
    if (!m || !(m.bot || m.autoplay)) return;
    this.botTimer = setTimeout(() => this._botMove(actorId), this.botDelay);
    this.botTimer.unref?.();
  }

  _botMove(actorId) {
    this.botTimer = null;
    if (this.disposed || !this.state || this.state.winner) return;
    const m = this.member(actorId);
    if (getActor(this.state) !== actorId || !m || !(m.bot || m.autoplay)) return this.scheduleBot();
    const action = chooseAction(this.state, actorId, Math.random);
    if (!action) {
      console.error(`[room ${this.code}] bot ${actorId} has no legal action in phase ${this.state.phase}`);
      return;
    }
    try {
      this.act(actorId, action);
    } catch (err) {
      console.error(`[room ${this.code}] bot move failed: ${err.message}`);
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.botTimer);
    for (const m of this.members) {
      m.stream?.close();
      m.stream = null;
    }
  }
}

export class Lobby {
  constructor({ botDelay = 1500, maxRooms = 200, idleMs = 6 * 60 * 60 * 1000 } = {}) {
    this.botDelay = botDelay;
    this.maxRooms = maxRooms;
    this.idleMs = idleMs;
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  create(hostName) {
    if (this.rooms.size >= this.maxRooms) bad('server_full', 'The server is busy. Try again later.');
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, { botDelay: this.botDelay });
    const member = room.join(hostName);
    this.rooms.set(code, room);
    return { room, member };
  }

  get(code) {
    const room = this.rooms.get(String(code ?? '').toUpperCase());
    if (!room) bad('no_such_room', 'Room not found. Check the code.');
    return room;
  }

  /** Drop empty rooms and rooms with no activity for `idleMs`. */
  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.members.length === 0 || now - room.touched > this.idleMs) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }

  close() {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }
}
