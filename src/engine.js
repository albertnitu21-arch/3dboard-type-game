// Game rules engine: a pure, serializable state machine.
//
//   const state0 = createGame({ players: [{ id: 'a', name: 'Ana' }, ...], seed: 123 });
//   const { state, events } = applyAction(state0, { type: 'roll', player: 'a' });
//
// - `state` is plain JSON (safe to store, send over the wire, or resume).
// - `applyAction` never mutates its input and is atomic: invalid actions throw a
//   GameError and leave the original state untouched.
// - `events` describe what happened (dice, moves, payments...) so a UI can animate.
// - `getLegalActions(state, playerId)` lists what a player may do right now.
//
// Phases: roll -> (buy | auction | debt | trade) -> post_roll -> next player's roll.
// Doubles send the same player back to `roll`. `game_over` is terminal.

import {
  BOARD, BOARD_SIZE, GROUP_POSITIONS, STATION_POSITIONS, UTILITY_POSITIONS,
  STATION_RENTS, RULES, isOwnable,
} from './board.js';
import { CARDS, DECK_IDS } from './cards.js';
import { randInt, shuffle } from './rng.js';

export class GameError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'GameError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new GameError(code, message); };

// ---------------------------------------------------------------- helpers

const cur = (s) => s.players[s.current];
const byId = (s, id) => s.players.find((p) => p.id === id);
const sumDice = (d) => d[0] + d[1];
const emit = (ctx, ev) => { ctx.events.push(ev); };

export function ownedPositions(s, id) {
  return Object.keys(s.props).map(Number).filter((pos) => s.props[pos].owner === id);
}
export function ownsGroup(s, id, group) {
  return GROUP_POSITIONS[group].every((pos) => s.props[pos].owner === id);
}
export function unmortgageCost(pos) {
  return Math.ceil(BOARD[pos].mortgage * 1.1);
}
export function netWorth(s, id) {
  const p = byId(s, id);
  let total = p.cash;
  for (const pos of ownedPositions(s, id)) {
    const sp = BOARD[pos];
    total += s.props[pos].mortgaged ? sp.mortgage : sp.price;
    total += (s.props[pos].houses || 0) * (sp.houseCost || 0);
  }
  return total;
}

/** Rent owed for landing on `pos`. `cardRent` is 'double' (station) or 'tenx' (utility). */
export function computeRent(s, pos, diceTotal = 7, cardRent = null) {
  const sp = BOARD[pos];
  const st = s.props[pos];
  if (!st || !st.owner || st.mortgaged) return 0;
  if (sp.type === 'property') {
    let rent = sp.rents[st.houses];
    if (st.houses === 0 && ownsGroup(s, st.owner, sp.group)) rent *= 2;
    return rent;
  }
  if (sp.type === 'station') {
    const n = STATION_POSITIONS.filter((q) => s.props[q].owner === st.owner).length;
    const rent = STATION_RENTS[n - 1];
    return cardRent === 'double' ? rent * 2 : rent;
  }
  // utility
  const n = UTILITY_POSITIONS.filter((q) => s.props[q].owner === st.owner).length;
  const mult = cardRent === 'tenx' ? 10 : n >= 2 ? 10 : 4;
  return mult * diceTotal;
}

// ------------------------------------------------------------ construction

export function createGame({ players, seed = Date.now(), rules = {} } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    fail('bad_players', 'A game needs between 2 and 8 players.');
  }
  const ids = new Set(players.map((p) => p?.id));
  if (ids.size !== players.length || ids.has(undefined) || ids.has(null) || ids.has('') || ids.has('bank')) {
    fail('bad_players', 'Player ids must be unique, non-empty, and not "bank".');
  }
  const s = {
    rng: seed | 0,
    rules: { ...RULES, ...rules },
    players: [],
    props: {},
    bank: null,
    decks: {},
    current: 0,
    turn: 1,
    phase: 'roll',
    dice: null,
    doublesCount: 0,
    extraTurn: false,
    buy: null,
    auction: null,
    debt: null,
    trade: null,
    resume: null,
    winner: null,
    log: [],
  };
  s.players = players.map((p) => ({
    id: p.id, name: p.name ?? String(p.id), cash: s.rules.startingCash,
    pos: 0, inJail: false, jailTurns: 0, jailCards: [], bankrupt: false,
  }));
  for (const sp of BOARD) {
    if (isOwnable(sp)) s.props[sp.pos] = { owner: null, mortgaged: false, houses: 0 };
  }
  s.bank = { houses: s.rules.houses, hotels: s.rules.hotels };
  s.decks = {
    fortune: shuffle(s, DECK_IDS.fortune),
    community: shuffle(s, DECK_IDS.community),
  };
  return s;
}

// --------------------------------------------------------- core mechanics

function rollDice(s) {
  // `forcedDice` is a testing hook; the server must never set it.
  if (s.forcedDice?.length) return s.forcedDice.shift();
  return [randInt(s, 6) + 1, randInt(s, 6) + 1];
}

function advance(ctx, p, steps) {
  const { s } = ctx;
  const from = p.pos;
  const raw = from + steps;
  p.pos = raw % BOARD_SIZE;
  emit(ctx, { type: 'move', player: p.id, from, to: p.pos, steps });
  if (raw >= BOARD_SIZE) {
    p.cash += s.rules.salary;
    emit(ctx, { type: 'pass_start', player: p.id, amount: s.rules.salary });
  }
}

function advanceTo(ctx, p, dest) {
  let steps = (dest - p.pos + BOARD_SIZE) % BOARD_SIZE;
  if (steps === 0) steps = BOARD_SIZE;
  advance(ctx, p, steps);
}

function sendToJail(ctx, p) {
  const { s } = ctx;
  const from = p.pos;
  p.pos = s.rules.jailPos;
  p.inJail = true;
  p.jailTurns = 0;
  s.extraTurn = false;
  emit(ctx, { type: 'go_to_jail', player: p.id, from });
}

/** End of a move's resolution: extra turn for doubles, otherwise wait for end_turn. */
function finishMove(ctx) {
  const { s } = ctx;
  const p = cur(s);
  s.buy = null;
  if (s.extraTurn && !p.inJail && !p.bankrupt) {
    s.extraTurn = false;
    s.phase = 'roll';
    emit(ctx, { type: 'extra_turn', player: p.id });
  } else {
    s.extraTurn = false;
    s.phase = 'post_roll';
  }
}

function runThen(ctx, then) {
  if (then?.type === 'move') {
    const p = cur(ctx.s);
    advance(ctx, p, then.steps);
    return resolveLanding(ctx, p, { diceTotal: then.steps });
  }
  return finishMove(ctx);
}

function settle(ctx, p, payments) {
  const { s } = ctx;
  for (const x of payments) {
    if (x.amount <= 0) continue;
    p.cash -= x.amount;
    if (x.to !== 'bank') byId(s, x.to).cash += x.amount;
    emit(ctx, { type: 'pay', from: p.id, to: x.to, amount: x.amount, reason: x.reason });
  }
}

/** Pay now if affordable (then continue), otherwise enter the debt phase. */
function charge(ctx, p, payments, then = null) {
  const { s } = ctx;
  const total = payments.reduce((t, x) => t + x.amount, 0);
  if (p.cash >= total) {
    settle(ctx, p, payments);
    return runThen(ctx, then);
  }
  s.phase = 'debt';
  s.debt = { payments, total, then };
  emit(ctx, { type: 'debt', player: p.id, total });
}

function resolveLanding(ctx, p, opts = {}) {
  const { s } = ctx;
  const sp = BOARD[p.pos];
  switch (sp.type) {
    case 'property':
    case 'station':
    case 'utility': {
      const st = s.props[p.pos];
      if (!st.owner) {
        s.phase = 'buy';
        s.buy = { pos: p.pos };
        emit(ctx, { type: 'buy_offer', player: p.id, pos: p.pos, price: sp.price });
        return;
      }
      if (st.owner === p.id || st.mortgaged) return finishMove(ctx);
      let diceTotal = opts.diceTotal ?? (s.dice ? sumDice(s.dice) : 7);
      if (opts.cardRent === 'tenx') {
        const d = rollDice(s);
        diceTotal = sumDice(d);
        emit(ctx, { type: 'roll', player: p.id, dice: d, double: false, purpose: 'utility_rent' });
      }
      const rent = computeRent(s, p.pos, diceTotal, opts.cardRent);
      emit(ctx, { type: 'rent', player: p.id, owner: st.owner, pos: p.pos, amount: rent });
      return charge(ctx, p, [{ to: st.owner, amount: rent, reason: 'rent' }]);
    }
    case 'tax':
      return charge(ctx, p, [{ to: 'bank', amount: sp.amount, reason: 'tax' }]);
    case 'fortune':
    case 'community':
      return drawCard(ctx, p, sp.type);
    case 'gotojail':
      sendToJail(ctx, p);
      return finishMove(ctx);
    default:
      return finishMove(ctx);
  }
}

function drawCard(ctx, p, deckName) {
  const { s } = ctx;
  const deck = s.decks[deckName];
  const id = deck.shift();
  const card = CARDS[id];
  emit(ctx, { type: 'card', player: p.id, deck: deckName, id, text: card.text });
  const e = card.effect;
  if (e.type === 'jail_free') {
    p.jailCards.push({ deck: deckName, id });
  } else {
    deck.push(id); // back to the bottom
  }
  const total = s.dice ? sumDice(s.dice) : 7;
  switch (e.type) {
    case 'cash':
      if (e.amount >= 0) {
        p.cash += e.amount;
        emit(ctx, { type: 'gain', player: p.id, amount: e.amount, reason: 'card' });
        return finishMove(ctx);
      }
      return charge(ctx, p, [{ to: 'bank', amount: -e.amount, reason: 'card' }]);
    case 'move_to':
      advanceTo(ctx, p, e.pos);
      return resolveLanding(ctx, p, { diceTotal: total });
    case 'move_back': {
      const from = p.pos;
      p.pos = (from - e.steps + BOARD_SIZE) % BOARD_SIZE;
      emit(ctx, { type: 'move', player: p.id, from, to: p.pos, steps: -e.steps });
      return resolveLanding(ctx, p, { diceTotal: total });
    }
    case 'nearest': {
      const list = e.kind === 'station' ? STATION_POSITIONS : UTILITY_POSITIONS;
      const dest = list.find((q) => q > p.pos) ?? list[0];
      advanceTo(ctx, p, dest);
      return resolveLanding(ctx, p, {
        diceTotal: total, cardRent: e.kind === 'station' ? 'double' : 'tenx',
      });
    }
    case 'goto_jail':
      sendToJail(ctx, p);
      return finishMove(ctx);
    case 'jail_free':
      return finishMove(ctx);
    case 'repairs': {
      let houses = 0, hotels = 0;
      for (const pos of ownedPositions(s, p.id)) {
        const h = s.props[pos].houses;
        if (h === 5) hotels++; else houses += h;
      }
      const amount = houses * e.house + hotels * e.hotel;
      if (amount === 0) return finishMove(ctx);
      return charge(ctx, p, [{ to: 'bank', amount, reason: 'repairs' }]);
    }
    case 'pay_each': {
      const others = s.players.filter((q) => q.id !== p.id && !q.bankrupt);
      if (!others.length) return finishMove(ctx);
      return charge(ctx, p, others.map((q) => ({ to: q.id, amount: e.amount, reason: 'card' })));
    }
    case 'collect_each': {
      for (const q of s.players) {
        if (q.id === p.id || q.bankrupt) continue;
        const amount = Math.min(q.cash, e.amount);
        if (amount <= 0) continue;
        q.cash -= amount;
        p.cash += amount;
        emit(ctx, { type: 'pay', from: q.id, to: p.id, amount, reason: 'card' });
      }
      return finishMove(ctx);
    }
    default:
      throw new Error(`Unknown card effect ${e.type}`);
  }
}

// ------------------------------------------------------------- turn flow

function advanceTurn(ctx) {
  const { s } = ctx;
  let i = s.current;
  do { i = (i + 1) % s.players.length; } while (s.players[i].bankrupt);
  s.current = i;
  s.turn += 1;
  s.phase = 'roll';
  s.dice = null;
  s.doublesCount = 0;
  s.extraTurn = false;
  emit(ctx, { type: 'turn_start', player: s.players[i].id, turn: s.turn });
}

function checkWinner(ctx) {
  const { s } = ctx;
  const alive = s.players.filter((p) => !p.bankrupt);
  if (alive.length === 1) {
    s.winner = alive[0].id;
    s.phase = 'game_over';
    emit(ctx, { type: 'game_over', winner: s.winner });
    return true;
  }
  return false;
}

function declareBankrupt(ctx, p, payments) {
  const { s } = ctx;
  const to = new Set(payments.map((x) => x.to));
  const creditor = to.size === 1 && !to.has('bank') ? byId(s, [...to][0]) : null;

  // Buildings are sold back to the bank at half price; proceeds join the estate.
  for (const pos of ownedPositions(s, p.id)) {
    const st = s.props[pos];
    if (st.houses > 0) {
      p.cash += (st.houses * BOARD[pos].houseCost) / 2;
      if (st.houses === 5) s.bank.hotels += 1; else s.bank.houses += st.houses;
      st.houses = 0;
    }
  }
  if (creditor) {
    creditor.cash += p.cash;
    for (const pos of ownedPositions(s, p.id)) s.props[pos].owner = creditor.id;
    creditor.jailCards.push(...p.jailCards);
  } else {
    for (const pos of ownedPositions(s, p.id)) {
      s.props[pos].owner = null;
      s.props[pos].mortgaged = false;
    }
    for (const c of p.jailCards) s.decks[c.deck].push(c.id);
  }
  p.cash = 0;
  p.jailCards = [];
  p.bankrupt = true;
  p.inJail = false;
  s.debt = null;
  emit(ctx, { type: 'bankrupt', player: p.id, creditor: creditor?.id ?? 'bank' });
  if (!checkWinner(ctx)) advanceTurn(ctx);
}

// ------------------------------------------------------------ auctions

function startAuction(ctx, pos) {
  const { s } = ctx;
  const n = s.players.length;
  const order = [];
  for (let k = 1; k <= n; k++) {
    const q = s.players[(s.current + k) % n];
    if (!q.bankrupt && q.cash >= 1) order.push(q.id);
  }
  if (!order.length) {
    emit(ctx, { type: 'auction_none', pos });
    return finishMove(ctx);
  }
  s.auction = { pos, order, active: [...order], idx: 0, highBid: 0, highBidder: null };
  s.phase = 'auction';
  emit(ctx, { type: 'auction_start', pos });
}

function advanceAuction(ctx) {
  const { s } = ctx;
  const a = s.auction;
  const n = a.order.length;
  for (let i = 1; i <= n; i++) {
    const j = (a.idx + i) % n;
    const id = a.order[j];
    if (a.active.includes(id) && id !== a.highBidder) { a.idx = j; return; }
  }
  // Nobody left who could raise the bid.
  if (a.highBidder) {
    const w = byId(s, a.highBidder);
    w.cash -= a.highBid;
    s.props[a.pos].owner = w.id;
    emit(ctx, { type: 'auction_won', player: w.id, pos: a.pos, amount: a.highBid });
  } else {
    emit(ctx, { type: 'auction_none', pos: a.pos });
  }
  s.auction = null;
  finishMove(ctx);
}

// ------------------------------------------------ building / mortgage checks
// Each returns null when allowed, or an error code string.

function groupOf(pos) {
  const sp = BOARD[pos];
  return sp.type === 'property' ? GROUP_POSITIONS[sp.group] : null;
}

function checkBuild(s, p, pos) {
  const st = s.props[pos];
  const grp = groupOf(pos);
  if (!st || !grp) return 'not_buildable';
  if (st.owner !== p.id) return 'not_owner';
  if (!ownsGroup(s, p.id, BOARD[pos].group)) return 'need_full_set';
  if (grp.some((q) => s.props[q].mortgaged)) return 'group_mortgaged';
  if (st.houses >= 5) return 'max_built';
  if (st.houses > Math.min(...grp.map((q) => s.props[q].houses))) return 'build_evenly';
  if (p.cash < BOARD[pos].houseCost) return 'insufficient_cash';
  if (st.houses < 4 ? s.bank.houses < 1 : s.bank.hotels < 1) return 'bank_supply';
  return null;
}

function checkSell(s, p, pos) {
  const st = s.props[pos];
  const grp = groupOf(pos);
  if (!st || !grp) return 'not_buildable';
  if (st.owner !== p.id) return 'not_owner';
  if (st.houses < 1) return 'no_buildings';
  if (st.houses < Math.max(...grp.map((q) => s.props[q].houses))) return 'sell_evenly';
  if (st.houses === 5 && s.bank.houses < 4) return 'bank_supply';
  return null;
}

function checkMortgage(s, p, pos) {
  const st = s.props[pos];
  if (!st) return 'not_ownable';
  if (st.owner !== p.id) return 'not_owner';
  if (st.mortgaged) return 'already_mortgaged';
  const grp = groupOf(pos);
  if (grp && grp.some((q) => s.props[q].houses > 0)) return 'has_buildings';
  return null;
}

function checkUnmortgage(s, p, pos) {
  const st = s.props[pos];
  if (!st) return 'not_ownable';
  if (st.owner !== p.id) return 'not_owner';
  if (!st.mortgaged) return 'not_mortgaged';
  if (p.cash < unmortgageCost(pos)) return 'insufficient_cash';
  return null;
}

// ------------------------------------------- raising cash in one go
// A plan sells buildings set by set (always evenly, tallest first) and mortgages
// properties: { sell: { [group]: count }, mortgage: [pos, ...] }. The same preview
// is used by the engine and by the "Raise money" panel, so their numbers agree.

/** Positions in the order a set's buildings come off when sold evenly (one entry per level). */
export function sellOrder(s, group) {
  const grp = GROUP_POSITIONS[group] ?? [];
  const lv = Object.fromEntries(grp.map((q) => [q, s.props[q].houses]));
  const out = [];
  for (;;) {
    let best = null;
    for (const q of grp) if (lv[q] > 0 && (best === null || lv[q] >= lv[best])) best = q;
    if (best === null) return out;
    out.push(best);
    lv[best] -= 1;
  }
}

/**
 * Work out what a plan would do, without changing anything.
 * Returns { ok, error?, message?, raised, levels: { pos: newLevel }, bank, mortgage: [pos], cashAfter }.
 * Breaking up a hotel only needs enough houses in the bank for what is left standing.
 */
export function previewRaise(s, playerId, plan = {}) {
  const p = byId(s, playerId);
  const levels = {};
  const bank = { ...s.bank };
  let raised = 0;
  const bad = (error, message) => ({ ok: false, error, message, raised, levels, bank, mortgage: [], cashAfter: p?.cash ?? 0 });
  if (!p) return bad('not_in_game', 'You are not in this game.');
  const sell = plan.sell && typeof plan.sell === 'object' ? plan.sell : {};
  const mort = Array.isArray(plan.mortgage) ? plan.mortgage : [];
  for (const [group, n] of Object.entries(sell)) {
    if (!Object.hasOwn(GROUP_POSITIONS, group) || !Number.isInteger(n) || n < 0) return bad('bad_plan', 'That is not a colour set.');
    if (!n) continue;
    const grp = GROUP_POSITIONS[group];
    if (grp.some((q) => s.props[q].owner !== p.id)) return bad('not_owner', 'You do not own that set.');
    const order = sellOrder(s, group);
    if (n > order.length) return bad('no_buildings', 'There are not that many buildings to sell there.');
    const lv = Object.fromEntries(grp.map((q) => [q, s.props[q].houses]));
    for (const q of order.slice(0, n)) lv[q] -= 1;
    for (const q of grp) {
      const was = s.props[q].houses, now = lv[q];
      if (was === now) continue;
      bank.houses += (was === 5 ? 0 : was) - (now === 5 ? 0 : now);
      bank.hotels += (was === 5 ? 1 : 0) - (now === 5 ? 1 : 0);
      raised += ((was - now) * BOARD[q].houseCost) / 2;
      levels[q] = now;
    }
  }
  if (bank.houses < 0) {
    return bad('bank_supply', `The bank only has ${s.bank.houses} houses left, not enough to break up that hotel. Sell more buildings in that set.`);
  }
  const level = (q) => levels[q] ?? s.props[q].houses;
  const seen = new Set();
  for (const pos of mort) {
    const st = Number.isInteger(pos) ? s.props[pos] : null;
    if (!st || seen.has(pos)) return bad('bad_plan', 'That property cannot be mortgaged.');
    seen.add(pos);
    if (st.owner !== p.id) return bad('not_owner', `You do not own ${BOARD[pos].name}.`);
    if (st.mortgaged) return bad('already_mortgaged', `${BOARD[pos].name} is already mortgaged.`);
    const grp = groupOf(pos);
    if (grp && grp.some((q) => level(q) > 0)) return bad('has_buildings', `Sell the buildings in ${BOARD[pos].name}'s set before mortgaging it.`);
    raised += BOARD[pos].mortgage;
  }
  return { ok: true, raised, levels, bank, mortgage: [...seen], cashAfter: p.cash + raised };
}

// ---------------------------------------------------------------- trading

function normalizeOffer(o) {
  if (o !== undefined && (o === null || typeof o !== 'object' || Array.isArray(o))) {
    fail('bad_trade', 'A trade side must be an object.');
  }
  const cash = o?.cash ?? 0;
  const jailCards = o?.jailCards ?? 0;
  if (o?.props !== undefined && !Array.isArray(o.props)) fail('bad_trade', 'Properties must be a list.');
  const props = [...(o?.props ?? [])];
  if (!Number.isInteger(cash) || cash < 0) fail('bad_trade', 'Trade cash must be a non-negative integer.');
  if (!Number.isInteger(jailCards) || jailCards < 0) fail('bad_trade', 'Bad jail card count.');
  if (props.some((x) => !Number.isInteger(x)) || new Set(props).size !== props.length) {
    fail('bad_trade', 'Bad property list.');
  }
  return { cash, props, jailCards };
}

function checkTradeSide(s, who, offer) {
  if (who.cash < offer.cash) return 'insufficient_cash';
  if (who.jailCards.length < offer.jailCards) return 'insufficient_jail_cards';
  for (const pos of offer.props) {
    const st = s.props[pos];
    if (!st) return 'not_ownable';
    if (st.owner !== who.id) return 'not_owner';
    const grp = groupOf(pos);
    if (grp && grp.some((q) => s.props[q].houses > 0)) return 'has_buildings';
  }
  return null;
}

function checkTrade(s, t) {
  const from = byId(s, t.from);
  const to = byId(s, t.to);
  return checkTradeSide(s, from, t.give) ?? checkTradeSide(s, to, t.get);
}

function executeTrade(ctx, t) {
  const { s } = ctx;
  const from = byId(s, t.from);
  const to = byId(s, t.to);
  const move = (giver, taker, offer) => {
    giver.cash -= offer.cash;
    taker.cash += offer.cash;
    for (const pos of offer.props) s.props[pos].owner = taker.id;
    taker.jailCards.push(...giver.jailCards.splice(giver.jailCards.length - offer.jailCards, offer.jailCards));
  };
  move(from, to, t.give);
  move(to, from, t.get);
  emit(ctx, { type: 'trade_done', from: t.from, to: t.to, give: t.give, get: t.get });
}

// --------------------------------------------------------------- handlers

const needPos = (s, a) => {
  if (!Number.isInteger(a.pos) || !s.props[a.pos]) fail('bad_position', 'Not an ownable space.');
  return a.pos;
};

const HANDLERS = {
  roll(ctx) {
    const { s } = ctx;
    const p = cur(s);
    const d = rollDice(s);
    const total = sumDice(d);
    const dbl = d[0] === d[1];
    s.dice = d;
    emit(ctx, { type: 'roll', player: p.id, dice: d, double: dbl });

    if (p.inJail) {
      if (dbl) {
        p.inJail = false;
        p.jailTurns = 0;
        emit(ctx, { type: 'jail_release', player: p.id, reason: 'doubles' });
        advance(ctx, p, total);
        return resolveLanding(ctx, p, { diceTotal: total });
      }
      p.jailTurns += 1;
      if (p.jailTurns >= s.rules.maxJailTurns) {
        p.inJail = false;
        p.jailTurns = 0;
        emit(ctx, { type: 'jail_release', player: p.id, reason: 'fine' });
        return charge(ctx, p, [{ to: 'bank', amount: s.rules.jailFine, reason: 'jail_fine' }],
          { type: 'move', steps: total });
      }
      emit(ctx, { type: 'jail_stay', player: p.id, attempts: p.jailTurns });
      s.phase = 'post_roll';
      return;
    }

    if (dbl) {
      s.doublesCount += 1;
      if (s.doublesCount >= 3) {
        emit(ctx, { type: 'triple_doubles', player: p.id });
        sendToJail(ctx, p);
        return finishMove(ctx);
      }
      s.extraTurn = true;
    }
    advance(ctx, p, total);
    return resolveLanding(ctx, p, { diceTotal: total });
  },

  pay_jail_fine(ctx) {
    const { s } = ctx;
    const p = cur(s);
    if (!p.inJail) fail('not_in_jail');
    if (p.cash < s.rules.jailFine) fail('insufficient_cash');
    p.cash -= s.rules.jailFine;
    p.inJail = false;
    p.jailTurns = 0;
    emit(ctx, { type: 'pay', from: p.id, to: 'bank', amount: s.rules.jailFine, reason: 'jail_fine' });
    emit(ctx, { type: 'jail_release', player: p.id, reason: 'fine' });
  },

  use_jail_card(ctx) {
    const { s } = ctx;
    const p = cur(s);
    if (!p.inJail) fail('not_in_jail');
    if (!p.jailCards.length) fail('no_jail_card');
    const card = p.jailCards.shift();
    s.decks[card.deck].push(card.id);
    p.inJail = false;
    p.jailTurns = 0;
    emit(ctx, { type: 'jail_release', player: p.id, reason: 'card' });
  },

  buy(ctx) {
    const { s } = ctx;
    const p = cur(s);
    const { pos } = s.buy;
    const price = BOARD[pos].price;
    if (p.cash < price) fail('insufficient_cash', 'Not enough cash to buy this property.');
    p.cash -= price;
    s.props[pos].owner = p.id;
    emit(ctx, { type: 'bought', player: p.id, pos, price });
    finishMove(ctx);
  },

  decline(ctx) {
    const { s } = ctx;
    const { pos } = s.buy;
    s.buy = null;
    emit(ctx, { type: 'declined', player: cur(s).id, pos });
    if (s.rules.auctions) return startAuction(ctx, pos);
    return finishMove(ctx);
  },

  bid(ctx, a) {
    const { s } = ctx;
    const au = s.auction;
    const p = byId(s, a.player);
    if (!Number.isInteger(a.amount) || a.amount <= au.highBid) {
      fail('bid_too_low', `Bid must be an integer above ${au.highBid}.`);
    }
    if (a.amount > p.cash) fail('insufficient_cash', 'You cannot bid more than you hold.');
    au.highBid = a.amount;
    au.highBidder = p.id;
    emit(ctx, { type: 'bid', player: p.id, amount: a.amount });
    advanceAuction(ctx);
  },

  pass(ctx, a) {
    const { s } = ctx;
    const au = s.auction;
    au.active = au.active.filter((id) => id !== a.player);
    emit(ctx, { type: 'auction_pass', player: a.player });
    advanceAuction(ctx);
  },

  end_turn(ctx) {
    advanceTurn(ctx);
  },

  build(ctx, a) {
    const { s } = ctx;
    const p = cur(s);
    const pos = needPos(s, a);
    const err = checkBuild(s, p, pos);
    if (err) fail(err);
    const st = s.props[pos];
    p.cash -= BOARD[pos].houseCost;
    if (st.houses < 4) {
      s.bank.houses -= 1;
    } else {
      s.bank.hotels -= 1;
      s.bank.houses += 4;
    }
    st.houses += 1;
    emit(ctx, { type: 'built', player: p.id, pos, level: st.houses });
  },

  sell_building(ctx, a) {
    const { s } = ctx;
    const p = cur(s);
    const pos = needPos(s, a);
    const err = checkSell(s, p, pos);
    if (err) fail(err);
    const st = s.props[pos];
    if (st.houses === 5) {
      s.bank.hotels += 1;
      s.bank.houses -= 4;
    } else {
      s.bank.houses += 1;
    }
    st.houses -= 1;
    p.cash += BOARD[pos].houseCost / 2;
    emit(ctx, { type: 'sold_building', player: p.id, pos, level: st.houses });
  },

  mortgage(ctx, a) {
    const { s } = ctx;
    const p = cur(s);
    const pos = needPos(s, a);
    const err = checkMortgage(s, p, pos);
    if (err) fail(err);
    s.props[pos].mortgaged = true;
    p.cash += BOARD[pos].mortgage;
    emit(ctx, { type: 'mortgaged', player: p.id, pos, amount: BOARD[pos].mortgage });
  },

  unmortgage(ctx, a) {
    const { s } = ctx;
    const p = cur(s);
    const pos = needPos(s, a);
    const err = checkUnmortgage(s, p, pos);
    if (err) fail(err);
    s.props[pos].mortgaged = false;
    p.cash -= unmortgageCost(pos);
    emit(ctx, { type: 'unmortgaged', player: p.id, pos, amount: unmortgageCost(pos) });
  },

  propose_trade(ctx, a) {
    const { s } = ctx;
    const from = byId(s, a.player);
    const to = byId(s, a.to);
    if (!to || to.bankrupt || to.id === from.id) fail('bad_trade', 'Pick another active player.');
    const t = { from: from.id, to: to.id, give: normalizeOffer(a.give), get: normalizeOffer(a.get) };
    const empty = (o) => !o.cash && !o.props.length && !o.jailCards;
    if (empty(t.give) && empty(t.get)) fail('bad_trade', 'The trade is empty.');
    const err = checkTrade(s, t);
    if (err) fail(err);
    s.trade = t;
    s.resume = s.phase;
    s.phase = 'trade';
    emit(ctx, { type: 'trade_proposed', ...t });
  },

  accept_trade(ctx) {
    const { s } = ctx;
    const t = s.trade;
    const err = checkTrade(s, t);
    if (err) fail(err, 'The trade is no longer valid.');
    executeTrade(ctx, t);
    s.phase = s.resume;
    s.resume = null;
    s.trade = null;
  },

  decline_trade(ctx) {
    const { s } = ctx;
    emit(ctx, { type: 'trade_declined', from: s.trade.from, to: s.trade.to });
    s.phase = s.resume;
    s.resume = null;
    s.trade = null;
  },

  cancel_trade(ctx) {
    const { s } = ctx;
    emit(ctx, { type: 'trade_cancelled', from: s.trade.from, to: s.trade.to });
    s.phase = s.resume;
    s.resume = null;
    s.trade = null;
  },

  /** Sell and mortgage several things at once; optionally pay the debt right after. */
  raise_cash(ctx, a) {
    const { s } = ctx;
    const p = cur(s);
    const r = previewRaise(s, p.id, a);
    if (!r.ok) fail(r.error, r.message);
    if (!Object.keys(r.levels).length && !r.mortgage.length) fail('bad_plan', 'Pick something to sell or mortgage.');
    for (const [q, now] of Object.entries(r.levels)) {
      const pos = Number(q);
      const st = s.props[pos];
      const from = st.houses;
      const amount = ((from - now) * BOARD[pos].houseCost) / 2;
      st.houses = now;
      p.cash += amount;
      emit(ctx, { type: 'sold_building', player: p.id, pos, level: now, from, amount });
    }
    s.bank = r.bank;
    for (const pos of r.mortgage) {
      s.props[pos].mortgaged = true;
      p.cash += BOARD[pos].mortgage;
      emit(ctx, { type: 'mortgaged', player: p.id, pos, amount: BOARD[pos].mortgage });
    }
    if (a.pay) {
      if (s.phase !== 'debt') fail('wrong_phase', 'There is no debt to pay.');
      HANDLERS.pay_debt(ctx);
    }
  },

  pay_debt(ctx) {
    const { s } = ctx;
    const p = cur(s);
    const d = s.debt;
    if (p.cash < d.total) fail('insufficient_cash', `You still owe ${d.total}.`);
    s.debt = null;
    settle(ctx, p, d.payments);
    runThen(ctx, d.then);
  },

  declare_bankruptcy(ctx) {
    const { s } = ctx;
    declareBankrupt(ctx, cur(s), s.debt.payments);
  },
};

const MANAGE = ['roll', 'post_roll'];
const ACTION_PHASES = {
  roll: ['roll'],
  pay_jail_fine: ['roll'],
  use_jail_card: ['roll'],
  buy: ['buy'],
  decline: ['buy'],
  bid: ['auction'],
  pass: ['auction'],
  end_turn: ['post_roll'],
  build: MANAGE,
  unmortgage: MANAGE,
  sell_building: [...MANAGE, 'buy', 'debt'],
  mortgage: [...MANAGE, 'buy', 'debt'],
  raise_cash: [...MANAGE, 'buy', 'debt'],
  propose_trade: [...MANAGE, 'debt'],
  accept_trade: ['trade'],
  decline_trade: ['trade'],
  cancel_trade: ['trade'],
  pay_debt: ['debt'],
  declare_bankruptcy: ['debt'],
};

/** Every action type the engine understands (handy for allow-listing client input). */
export const ACTION_TYPES = Object.keys(ACTION_PHASES);

/** The one player whose decision the game is waiting on (null when over). Bots use this. */
export function getActor(s) {
  if (s.winner) return null;
  if (s.phase === 'trade') return s.trade.to;
  return expectedActors(s)[0] ?? null;
}

function expectedActors(s) {
  switch (s.phase) {
    case 'roll': case 'post_roll': case 'buy': case 'debt':
      return [cur(s).id];
    case 'auction':
      return [s.auction.order[s.auction.idx]];
    case 'trade':
      return [s.trade.to, s.trade.from];
    default:
      return [];
  }
}

/**
 * Apply one action: { type, player, ...params }.
 * Returns { state, events }. Throws GameError for illegal actions.
 */
export function applyAction(state, action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    fail('bad_action', 'Missing action type.');
  }
  if (state.winner) fail('game_over', 'The game is over.');
  if (!Object.hasOwn(ACTION_PHASES, action.type)) fail('unknown_action', 'Unknown action.');
  const phases = ACTION_PHASES[action.type];
  if (!phases.includes(state.phase)) {
    fail('wrong_phase', `"${action.type}" is not allowed during ${state.phase}.`);
  }
  if (anyoneMayTrade(state, action.type)) {
    // Between moves, any player still in the game may open a trade.
    const p = state.players.find((x) => x.id === action.player);
    if (!p || p.bankrupt) fail('not_your_turn', 'You are not in this game.');
  } else if (!expectedActors(state).includes(action.player)) {
    fail('not_your_turn', 'It is not your turn to act.');
  }
  if ((action.type === 'accept_trade' || action.type === 'decline_trade') && action.player !== state.trade.to) {
    fail('not_your_turn', 'Only the trade partner can answer.');
  }
  if (action.type === 'cancel_trade' && action.player !== state.trade.from) {
    fail('not_your_turn', 'Only the proposer can cancel.');
  }
  if (state.phase === 'trade' && !['accept_trade', 'decline_trade', 'cancel_trade'].includes(action.type)) {
    fail('wrong_phase', 'A trade is pending.');
  }

  const s = structuredClone(state); // atomic: a throw discards the clone
  const ctx = { s, events: [] };
  HANDLERS[action.type](ctx, action);
  s.log.push(...ctx.events);
  if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
  return { state: s, events: ctx.events };
}

/** Trades may be opened by anyone while the game waits between moves. */
function anyoneMayTrade(s, type) {
  return type === 'propose_trade' && (s.phase === 'roll' || s.phase === 'post_roll');
}

/** Actions `playerId` may take right now (management actions listed per property). */
export function getLegalActions(s, playerId) {
  if (s.winner) return [];
  if (!expectedActors(s).includes(playerId)) {
    const p = byId(s, playerId);
    return p && !p.bankrupt && anyoneMayTrade(s, 'propose_trade') ? [{ type: 'propose_trade', free: true }] : [];
  }
  const p = byId(s, playerId);
  const out = [];
  const add = (a) => out.push(a);

  switch (s.phase) {
    case 'roll':
      add({ type: 'roll' });
      if (p.inJail) {
        if (p.cash >= s.rules.jailFine) add({ type: 'pay_jail_fine' });
        if (p.jailCards.length) add({ type: 'use_jail_card' });
      }
      break;
    case 'buy':
      if (p.cash >= BOARD[s.buy.pos].price) add({ type: 'buy' });
      add({ type: 'decline' });
      break;
    case 'auction':
      if (p.cash > s.auction.highBid) add({ type: 'bid', min: s.auction.highBid + 1, max: p.cash });
      add({ type: 'pass' });
      break;
    case 'post_roll':
      add({ type: 'end_turn' });
      break;
    case 'debt':
      if (p.cash >= s.debt.total) add({ type: 'pay_debt' });
      add({ type: 'declare_bankruptcy' });
      break;
    case 'trade':
      if (playerId === s.trade.to) { add({ type: 'accept_trade' }); add({ type: 'decline_trade' }); }
      if (playerId === s.trade.from) add({ type: 'cancel_trade' });
      return out;
    default:
      return out;
  }

  for (const pos of ownedPositions(s, playerId)) {
    for (const [type, check] of [
      ['build', checkBuild], ['sell_building', checkSell],
      ['mortgage', checkMortgage], ['unmortgage', checkUnmortgage],
    ]) {
      if (ACTION_PHASES[type].includes(s.phase) && !check(s, p, pos)) add({ type, pos });
    }
  }
  if (ACTION_PHASES.raise_cash.includes(s.phase)
    && out.some((a) => a.type === 'sell_building' || a.type === 'mortgage')) {
    add({ type: 'raise_cash', free: true }); // the "Raise money" panel builds the plan
  }
  if (ACTION_PHASES.propose_trade.includes(s.phase)) {
    // Free-form: the UI builds the offer; the engine validates it.
    add({ type: 'propose_trade', free: true });
  }
  return out;
}
