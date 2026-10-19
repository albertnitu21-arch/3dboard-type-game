import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, getLegalActions, computeRent, GameError, unmortgageCost,
  getActor, ACTION_TYPES,
} from '../src/engine.js';
import { BOARD, GROUP_POSITIONS, GROUPS } from '../src/board.js';
import { CARDS, DECK_IDS } from '../src/cards.js';

// ------------------------------------------------------------ test helpers

const mk = (n = 3, seed = 7, rules) =>
  createGame({ players: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` })), seed, rules });
const cur = (s) => s.players[s.current];
const P = (s, id) => s.players.find((p) => p.id === id);
const edit = (s, fn) => { const c = structuredClone(s); fn(c); return c; };
const act = (s, type, extra = {}, player) =>
  applyAction(s, { type, player: player ?? cur(s).id, ...extra });
const roll = (s, d1, d2, more = []) =>
  applyAction(edit(s, (c) => { c.forcedDice = [[d1, d2], ...more]; }), { type: 'roll', player: cur(s).id });
const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof GameError && e.code === code, `expected GameError ${code}`);
const own = (s, id, ...positions) => positions.forEach((pos) => { s.props[pos].owner = id; });
const stack = (s, cardId) => {
  const deck = CARDS[cardId].deck;
  s.decks[deck] = [cardId, ...s.decks[deck].filter((x) => x !== cardId)];
};

// ------------------------------------------------------------------- data

test('board data is consistent', () => {
  assert.equal(BOARD.length, 40);
  BOARD.forEach((sp, i) => assert.equal(sp.pos, i));
  const ownable = BOARD.filter((s) => ['property', 'station', 'utility'].includes(s.type));
  assert.equal(ownable.length, 28);
  assert.deepEqual(Object.keys(GROUP_POSITIONS).sort(), Object.keys(GROUPS).sort());
  assert.equal(Object.values(GROUP_POSITIONS).flat().length, 22);
  for (const sp of BOARD.filter((s) => s.type === 'property')) {
    assert.equal(sp.rents.length, 6);
    assert.ok(sp.rents.every((r, i) => i === 0 || r > sp.rents[i - 1] || sp.rents[0] === r));
  }
  assert.equal(DECK_IDS.fortune.length, 16);
  assert.equal(DECK_IDS.community.length, 16);
});

test('createGame validates players and sets up a fresh game', () => {
  throwsCode(() => createGame({ players: [{ id: 'a' }] }), 'bad_players');
  throwsCode(() => createGame({ players: Array.from({ length: 9 }, (_, i) => ({ id: `x${i}` })) }), 'bad_players');
  throwsCode(() => createGame({ players: [{ id: 'a' }, { id: 'a' }] }), 'bad_players');
  throwsCode(() => createGame({ players: [{ id: 'a' }, { id: 'bank' }] }), 'bad_players');
  const s = mk(4);
  assert.equal(s.players.length, 4);
  assert.ok(s.players.every((p) => p.cash === 1500 && p.pos === 0 && !p.inJail));
  assert.equal(s.phase, 'roll');
  assert.deepEqual(s.bank, { houses: 32, hotels: 12 });
});

// --------------------------------------------------------------- movement

test('rolling moves the player and offers an unowned property', () => {
  const { state, events } = roll(mk(), 1, 2);
  assert.equal(P(state, 'p1').pos, 3);
  assert.equal(state.phase, 'buy');
  assert.equal(state.buy.pos, 3);
  assert.deepEqual(events.map((e) => e.type), ['roll', 'move', 'buy_offer']);
});

test('passing Start pays the salary', () => {
  const s = edit(mk(), (c) => { c.players[0].pos = 38; });
  const { state } = roll(s, 1, 2);
  assert.equal(P(state, 'p1').pos, 1);
  assert.equal(P(state, 'p1').cash, 1700);
});

test('buying a property, then ending the turn', () => {
  let { state } = roll(mk(), 1, 2);
  state = act(state, 'buy').state;
  assert.equal(state.props[3].owner, 'p1');
  assert.equal(P(state, 'p1').cash, 1440);
  assert.equal(state.phase, 'post_roll');
  state = act(state, 'end_turn').state;
  assert.equal(cur(state).id, 'p2');
  assert.equal(state.phase, 'roll');
});

test('cannot buy without enough cash', () => {
  const s = edit(mk(), (c) => { c.players[0].cash = 10; });
  const { state } = roll(s, 1, 2);
  assert.ok(!getLegalActions(state, 'p1').some((a) => a.type === 'buy'));
  throwsCode(() => act(state, 'buy'), 'insufficient_cash');
});

// --------------------------------------------------------------- auctions

test('declining starts an auction that the highest bidder wins', () => {
  let { state } = roll(mk(), 1, 2);
  state = act(state, 'decline').state;
  assert.equal(state.phase, 'auction');
  assert.deepEqual(state.auction.order, ['p2', 'p3', 'p1']);
  state = act(state, 'bid', { amount: 10 }, 'p2').state;
  state = act(state, 'bid', { amount: 20 }, 'p3').state;
  state = act(state, 'pass', {}, 'p1').state;
  state = act(state, 'pass', {}, 'p2').state;
  assert.equal(state.props[3].owner, 'p3');
  assert.equal(P(state, 'p3').cash, 1480);
  assert.equal(state.phase, 'post_roll');
  assert.equal(cur(state).id, 'p1');
  assert.equal(state.auction, null);
});

test('an auction where everyone passes leaves the property unowned', () => {
  let { state } = roll(mk(), 1, 2);
  state = act(state, 'decline').state;
  for (const id of ['p2', 'p3', 'p1']) state = act(state, 'pass', {}, id).state;
  assert.equal(state.props[3].owner, null);
  assert.equal(state.phase, 'post_roll');
});

test('auction bids are validated and only the expected player may act', () => {
  let { state } = roll(mk(), 1, 2);
  state = act(state, 'decline').state;
  throwsCode(() => act(state, 'bid', { amount: 10 }, 'p3'), 'not_your_turn');
  throwsCode(() => act(state, 'bid', { amount: 0 }, 'p2'), 'bid_too_low');
  throwsCode(() => act(state, 'bid', { amount: 5000 }, 'p2'), 'insufficient_cash');
  state = act(state, 'bid', { amount: 30 }, 'p2').state;
  throwsCode(() => act(state, 'bid', { amount: 30 }, 'p3'), 'bid_too_low');
});

test('with auctions disabled, declining just ends the move', () => {
  const s = mk(3, 7, { auctions: false });
  let { state } = roll(s, 1, 2);
  state = act(state, 'decline').state;
  assert.equal(state.phase, 'post_roll');
  assert.equal(state.props[3].owner, null);
});

// ------------------------------------------------------------------- rent

test('landing on an owned property pays rent', () => {
  const s = edit(mk(), (c) => own(c, 'p2', 3));
  const { state } = roll(s, 1, 2);
  assert.equal(P(state, 'p1').cash, 1496);
  assert.equal(P(state, 'p2').cash, 1504);
  assert.equal(state.phase, 'post_roll');
});

test('rent doubles with a full unimproved set, and follows building levels', () => {
  const s = edit(mk(), (c) => own(c, 'p2', 1, 3));
  assert.equal(computeRent(s, 3), 8);
  const withHouses = edit(s, (c) => { c.props[3].houses = 2; c.props[1].houses = 2; });
  assert.equal(computeRent(withHouses, 3), 60);
  const hotel = edit(s, (c) => { c.props[3].houses = 5; });
  assert.equal(computeRent(hotel, 3), 450);
});

test('station rent scales with how many stations the owner holds', () => {
  const one = edit(mk(), (c) => own(c, 'p2', 5));
  assert.equal(P(roll(one, 2, 3).state, 'p1').cash, 1475);
  const two = edit(mk(), (c) => own(c, 'p2', 5, 15));
  assert.equal(P(roll(two, 2, 3).state, 'p1').cash, 1450);
});

test('utility rent is 4x the roll, or 10x with both utilities', () => {
  const one = edit(mk(), (c) => own(c, 'p2', 12));
  assert.equal(P(roll(one, 5, 7).state, 'p1').cash, 1500 - 48);
  const both = edit(mk(), (c) => own(c, 'p2', 12, 28));
  assert.equal(P(roll(both, 5, 7).state, 'p1').cash, 1500 - 120);
});

test('mortgaged properties collect no rent', () => {
  const s = edit(mk(), (c) => { own(c, 'p2', 3); c.props[3].mortgaged = true; });
  const { state } = roll(s, 1, 2);
  assert.equal(P(state, 'p1').cash, 1500);
  assert.equal(state.phase, 'post_roll');
});

test('tax spaces charge the bank', () => {
  const { state } = roll(mk(), 1, 3);
  assert.equal(P(state, 'p1').cash, 1300);
});

// ------------------------------------------------------- doubles and jail

test('doubles grant another roll', () => {
  const { state } = roll(mk(), 5, 5);
  assert.equal(P(state, 'p1').pos, 10);
  assert.equal(state.phase, 'roll');
  assert.equal(cur(state).id, 'p1');
});

test('three doubles in a row go to jail', () => {
  const s = edit(mk(), (c) => { c.doublesCount = 2; });
  const { state } = roll(s, 2, 2);
  assert.equal(P(state, 'p1').inJail, true);
  assert.equal(P(state, 'p1').pos, 10);
  assert.equal(state.phase, 'post_roll');
});

test('landing on Go to Lockup jails you, even on doubles', () => {
  const s = edit(mk(), (c) => { c.players[0].pos = 26; });
  const { state } = roll(s, 2, 2);
  assert.equal(P(state, 'p1').inJail, true);
  assert.equal(state.phase, 'post_roll');
});

const jailed = (extra = {}) => edit(mk(), (c) => {
  Object.assign(c.players[0], { inJail: true, pos: 10, jailTurns: 0 }, extra);
});

test('a failed jail roll keeps you in; doubles free you without an extra turn', () => {
  const stay = roll(jailed(), 1, 2).state;
  assert.equal(P(stay, 'p1').inJail, true);
  assert.equal(P(stay, 'p1').jailTurns, 1);
  assert.equal(stay.phase, 'post_roll');

  const out = roll(jailed(), 2, 2).state;
  assert.equal(P(out, 'p1').inJail, false);
  assert.equal(P(out, 'p1').pos, 14);
  assert.equal(out.extraTurn, false);
  assert.equal(out.phase, 'buy');
});

test('the third failed attempt forces the fine and moves you', () => {
  const { state } = roll(jailed({ jailTurns: 2 }), 1, 2);
  assert.equal(P(state, 'p1').inJail, false);
  assert.equal(P(state, 'p1').cash, 1450);
  assert.equal(P(state, 'p1').pos, 13);
  assert.equal(state.phase, 'buy');
});

test('a forced jail fine you cannot afford becomes debt, then you move', () => {
  let s = edit(jailed({ jailTurns: 2, cash: 20 }), (c) => own(c, 'p1', 1));
  s = roll(s, 1, 2).state;
  assert.equal(s.phase, 'debt');
  assert.equal(s.debt.total, 50);
  s = act(s, 'mortgage', { pos: 1 }).state;
  s = act(s, 'pay_debt').state;
  assert.equal(P(s, 'p1').pos, 13);
  assert.equal(s.phase, 'buy');
  assert.equal(P(s, 'p1').cash, 0);
});

test('paying the fine or using a card gets you out before rolling', () => {
  const paid = act(jailed(), 'pay_jail_fine').state;
  assert.equal(P(paid, 'p1').inJail, false);
  assert.equal(P(paid, 'p1').cash, 1450);
  assert.equal(paid.phase, 'roll');
  throwsCode(() => act(mk(), 'pay_jail_fine'), 'not_in_jail');

  const s = edit(jailed({ jailCards: [{ deck: 'fortune', id: 'f9' }] }), (c) => {
    c.decks.fortune = c.decks.fortune.filter((x) => x !== 'f9');
  });
  const used = act(s, 'use_jail_card').state;
  assert.equal(P(used, 'p1').inJail, false);
  assert.equal(P(used, 'p1').jailCards.length, 0);
  assert.equal(used.decks.fortune.at(-1), 'f9');
});

test('jailed players still collect rent', () => {
  const s = edit(mk(), (c) => {
    own(c, 'p1', 3);
    Object.assign(c.players[0], { inJail: true, pos: 10 });
    c.current = 1; // p2 to move
  });
  const { state } = roll(s, 1, 2);
  assert.equal(P(state, 'p1').cash, 1504);
});

// --------------------------------------------------------------- building

const setOwner = (id, ...positions) => edit(mk(), (c) => own(c, id, ...positions));

test('building needs the full set and must be even', () => {
  throwsCode(() => act(setOwner('p1', 1), 'build', { pos: 1 }), 'need_full_set');
  let s = setOwner('p1', 1, 3);
  s = act(s, 'build', { pos: 1 }).state;
  assert.equal(s.props[1].houses, 1);
  assert.equal(P(s, 'p1').cash, 1450);
  assert.equal(s.bank.houses, 31);
  throwsCode(() => act(s, 'build', { pos: 1 }), 'build_evenly');
  s = act(s, 'build', { pos: 3 }).state;
  s = act(s, 'build', { pos: 1 }).state;
  assert.equal(s.props[1].houses, 2);
});

test('building is blocked by mortgages, supply, cash and turn order', () => {
  const mortgaged = edit(setOwner('p1', 1, 3), (c) => { c.props[3].mortgaged = true; });
  throwsCode(() => act(mortgaged, 'build', { pos: 1 }), 'group_mortgaged');
  const noSupply = edit(setOwner('p1', 1, 3), (c) => { c.bank.houses = 0; });
  throwsCode(() => act(noSupply, 'build', { pos: 1 }), 'bank_supply');
  const poor = edit(setOwner('p1', 1, 3), (c) => { c.players[0].cash = 49; });
  throwsCode(() => act(poor, 'build', { pos: 1 }), 'insufficient_cash');
  throwsCode(() => act(setOwner('p1', 1, 3), 'build', { pos: 1 }, 'p2'), 'not_your_turn');
  throwsCode(() => act(setOwner('p1', 1, 3), 'build', { pos: 4 }), 'bad_position');
  throwsCode(() => act(setOwner('p1', 5), 'build', { pos: 5 }), 'not_buildable');
});

test('four houses become a hotel and return houses to the bank', () => {
  const s = edit(setOwner('p1', 1, 3), (c) => {
    c.props[1].houses = 4; c.props[3].houses = 4; c.bank.houses = 24;
  });
  const hotel = act(s, 'build', { pos: 1 }).state;
  assert.equal(hotel.props[1].houses, 5);
  assert.equal(hotel.bank.hotels, 11);
  assert.equal(hotel.bank.houses, 28);
  throwsCode(() => act(hotel, 'build', { pos: 1 }), 'max_built');
});

test('selling buildings is even, refunds half, and respects house supply', () => {
  const s = edit(setOwner('p1', 1, 3), (c) => {
    c.props[1].houses = 2; c.props[3].houses = 1; c.bank.houses = 29;
  });
  throwsCode(() => act(s, 'sell_building', { pos: 3 }), 'sell_evenly');
  const sold = act(s, 'sell_building', { pos: 1 }).state;
  assert.equal(sold.props[1].houses, 1);
  assert.equal(P(sold, 'p1').cash, 1525);
  assert.equal(sold.bank.houses, 30);

  const stuck = edit(setOwner('p1', 1, 3), (c) => {
    c.props[1].houses = 5; c.props[3].houses = 4; c.bank.houses = 2; c.bank.hotels = 11;
  });
  throwsCode(() => act(stuck, 'sell_building', { pos: 1 }), 'bank_supply');
  const ok = act(edit(stuck, (c) => { c.bank.houses = 4; }), 'sell_building', { pos: 1 }).state;
  assert.equal(ok.props[1].houses, 4);
  assert.equal(ok.bank.houses, 0);
  assert.equal(ok.bank.hotels, 12);
});

// --------------------------------------------------------------- mortgage

test('mortgaging pays half the price; unmortgaging costs 10% more', () => {
  let s = setOwner('p1', 1);
  s = act(s, 'mortgage', { pos: 1 }).state;
  assert.equal(P(s, 'p1').cash, 1530);
  assert.equal(s.props[1].mortgaged, true);
  throwsCode(() => act(s, 'mortgage', { pos: 1 }), 'already_mortgaged');
  assert.equal(unmortgageCost(1), 33);
  s = act(s, 'unmortgage', { pos: 1 }).state;
  assert.equal(P(s, 'p1').cash, 1497);
  throwsCode(() => act(s, 'unmortgage', { pos: 1 }), 'not_mortgaged');
});

test('a group with buildings cannot be mortgaged', () => {
  const s = edit(setOwner('p1', 1, 3), (c) => { c.props[1].houses = 1; });
  throwsCode(() => act(s, 'mortgage', { pos: 3 }), 'has_buildings');
  throwsCode(() => act(setOwner('p2', 1), 'mortgage', { pos: 1 }), 'not_owner');
});

// ------------------------------------------------------------ debt & ruin

const stationDebt = () => edit(mk(), (c) => {
  own(c, 'p2', 5, 15, 25, 35);
  own(c, 'p1', 6, 8, 9);
  c.players[0].cash = 50;
});

test('unaffordable rent starts a debt that can be paid after raising cash', () => {
  let s = roll(stationDebt(), 2, 3).state;
  assert.equal(s.phase, 'debt');
  assert.equal(s.debt.total, 200);
  throwsCode(() => act(s, 'pay_debt'), 'insufficient_cash');
  throwsCode(() => act(s, 'end_turn'), 'wrong_phase');
  for (const pos of [6, 8, 9]) s = act(s, 'mortgage', { pos }).state;
  s = act(s, 'pay_debt').state;
  assert.equal(P(s, 'p1').cash, 10);
  assert.equal(P(s, 'p2').cash, 1700);
  assert.equal(s.phase, 'post_roll');
});

test('trading can raise the money to clear a debt', () => {
  let s = roll(stationDebt(), 2, 3).state;
  s = act(s, 'propose_trade', { to: 'p2', give: { props: [6] }, get: { cash: 300 } }).state;
  assert.equal(s.phase, 'trade');
  s = act(s, 'accept_trade', {}, 'p2').state;
  assert.equal(s.phase, 'debt');
  assert.equal(P(s, 'p1').cash, 350);
  s = act(s, 'pay_debt').state;
  assert.equal(P(s, 'p1').cash, 150);
});

test('bankruptcy to a player transfers everything and play continues', () => {
  const s0 = edit(mk(), (c) => {
    own(c, 'p2', 5, 15, 25, 35);
    own(c, 'p1', 1, 3);
    c.props[1].houses = 1; c.props[3].houses = 1; c.bank.houses = 30;
    Object.assign(c.players[0], { cash: 50, jailCards: [{ deck: 'community', id: 'c4' }] });
    c.decks.community = c.decks.community.filter((x) => x !== 'c4');
  });
  let s = roll(s0, 2, 3).state;
  assert.equal(s.phase, 'debt');
  s = act(s, 'declare_bankruptcy').state;
  assert.equal(P(s, 'p1').bankrupt, true);
  assert.equal(s.props[1].owner, 'p2');
  assert.equal(s.props[3].owner, 'p2');
  assert.equal(s.props[1].houses, 0);
  assert.equal(s.bank.houses, 32);
  assert.equal(P(s, 'p2').cash, 1500 + 100);
  assert.equal(P(s, 'p2').jailCards.length, 1);
  assert.equal(cur(s).id, 'p2');
  assert.equal(s.phase, 'roll');
  assert.equal(s.winner, null);
});

test('bankruptcy to the bank frees properties and returns jail cards', () => {
  const s0 = edit(mk(), (c) => {
    own(c, 'p1', 1);
    c.props[1].mortgaged = true;
    Object.assign(c.players[0], { cash: 10, jailCards: [{ deck: 'fortune', id: 'f9' }] });
    c.decks.fortune = c.decks.fortune.filter((x) => x !== 'f9');
  });
  let s = roll(s0, 1, 3).state; // City Tax: 200
  assert.equal(s.phase, 'debt');
  s = act(s, 'declare_bankruptcy').state;
  assert.equal(s.props[1].owner, null);
  assert.equal(s.props[1].mortgaged, false);
  assert.ok(s.decks.fortune.includes('f9'));
});

test('the last player standing wins and the game stops', () => {
  const s0 = edit(mk(2), (c) => { own(c, 'p2', 5, 15, 25, 35); c.players[0].cash = 10; });
  let s = roll(s0, 2, 3).state;
  s = act(s, 'declare_bankruptcy').state;
  assert.equal(s.winner, 'p2');
  assert.equal(s.phase, 'game_over');
  throwsCode(() => act(s, 'roll', {}, 'p2'), 'game_over');
  assert.deepEqual(getLegalActions(s, 'p2'), []);
});

// ---------------------------------------------------------------- trading

test('trade: propose, accept swaps property and cash', () => {
  let s = edit(mk(), (c) => { own(c, 'p1', 1); own(c, 'p2', 3); });
  s = act(s, 'propose_trade', { to: 'p2', give: { props: [1] }, get: { props: [3], cash: 50 } }).state;
  assert.equal(s.phase, 'trade');
  assert.ok(getLegalActions(s, 'p2').some((a) => a.type === 'accept_trade'));
  assert.ok(getLegalActions(s, 'p1').some((a) => a.type === 'cancel_trade'));
  throwsCode(() => act(s, 'accept_trade', {}, 'p1'), 'not_your_turn');
  throwsCode(() => act(s, 'roll', {}, 'p1'), 'wrong_phase');
  s = act(s, 'accept_trade', {}, 'p2').state;
  assert.equal(s.props[1].owner, 'p2');
  assert.equal(s.props[3].owner, 'p1');
  assert.equal(P(s, 'p1').cash, 1550);
  assert.equal(P(s, 'p2').cash, 1450);
  assert.equal(s.phase, 'roll');
});

test('trade: declining or cancelling changes nothing', () => {
  const base = edit(mk(), (c) => { own(c, 'p1', 1); });
  const offer = { to: 'p2', give: { props: [1] }, get: { cash: 100 } };
  const declined = act(act(base, 'propose_trade', offer).state, 'decline_trade', {}, 'p2').state;
  assert.equal(declined.props[1].owner, 'p1');
  assert.equal(declined.phase, 'roll');
  const cancelled = act(act(base, 'propose_trade', offer).state, 'cancel_trade').state;
  assert.equal(cancelled.phase, 'roll');
  assert.equal(P(cancelled, 'p2').cash, 1500);
});

test('trade: invalid offers are rejected', () => {
  const s = edit(mk(), (c) => { own(c, 'p1', 1, 3); c.props[1].houses = 1; c.props[3].houses = 1; own(c, 'p2', 6); });
  throwsCode(() => act(s, 'propose_trade', { to: 'p2', give: { props: [1] }, get: {} }), 'has_buildings');
  throwsCode(() => act(s, 'propose_trade', { to: 'p2', give: { props: [6] }, get: {} }), 'not_owner');
  throwsCode(() => act(s, 'propose_trade', { to: 'p2', give: { cash: 5000 }, get: {} }), 'insufficient_cash');
  throwsCode(() => act(s, 'propose_trade', { to: 'p2', give: {}, get: {} }), 'bad_trade');
  throwsCode(() => act(s, 'propose_trade', { to: 'p1', give: { cash: 1 }, get: {} }), 'bad_trade');
  throwsCode(() => act(s, 'propose_trade', { to: 'p2', give: { cash: -5 }, get: {} }), 'bad_trade');
});

test('trade: jail cards can change hands', () => {
  const s = edit(mk(), (c) => { c.players[0].jailCards = [{ deck: 'fortune', id: 'f9' }]; });
  let t = act(s, 'propose_trade', { to: 'p2', give: { jailCards: 1 }, get: { cash: 100 } }).state;
  t = act(t, 'accept_trade', {}, 'p2').state;
  assert.equal(P(t, 'p1').jailCards.length, 0);
  assert.equal(P(t, 'p2').jailCards.length, 1);
  assert.equal(P(t, 'p1').cash, 1600);
});

// ------------------------------------------------------------------ cards

// From Start, a (3,4) roll lands on the first Fortune space (7).
function fortune(cardId, tweak, dice = [[3, 4]]) {
  const s = edit(mk(), (c) => { stack(c, cardId); tweak?.(c); });
  const [first, ...more] = dice;
  return roll(s, first[0], first[1], more);
}
// From the Lockup (10), a (3,4) roll lands on a Community Fund space (17).
function community(cardId, tweak) {
  const s = edit(mk(), (c) => { c.players[0].pos = 10; stack(c, cardId); tweak?.(c); });
  return roll(s, 3, 4);
}

test('cash cards pay out or charge the bank, and go to the bottom of the deck', () => {
  let { state, events } = fortune('f15');
  assert.equal(P(state, 'p1').cash, 1550);
  assert.equal(state.phase, 'post_roll');
  assert.equal(state.decks.fortune.at(-1), 'f15');
  assert.ok(events.some((e) => e.type === 'card' && e.id === 'f15'));
  ({ state } = fortune('f13'));
  assert.equal(P(state, 'p1').cash, 1485);
});

test('movement cards: advance, wrap past Start, go back', () => {
  let { state } = fortune('f1');
  assert.equal(P(state, 'p1').pos, 0);
  assert.equal(P(state, 'p1').cash, 1700);
  assert.equal(state.phase, 'post_roll');

  ({ state } = fortune('f2'));
  assert.equal(P(state, 'p1').pos, 11);
  assert.equal(P(state, 'p1').cash, 1500);
  assert.equal(state.phase, 'buy');

  ({ state } = fortune('f5'));
  assert.equal(P(state, 'p1').pos, 5);
  assert.equal(P(state, 'p1').cash, 1700);

  ({ state } = fortune('f10')); // back 3 from 7 -> City Tax at 4
  assert.equal(P(state, 'p1').pos, 4);
  assert.equal(P(state, 'p1').cash, 1300);
});

test('nearest-station and nearest-utility cards charge special rent', () => {
  let { state } = fortune('f6', (c) => own(c, 'p2', 15));
  assert.equal(P(state, 'p1').pos, 15);
  assert.equal(P(state, 'p1').cash, 1450);

  ({ state } = fortune('f6'));
  assert.equal(state.phase, 'buy');
  assert.equal(state.buy.pos, 15);

  ({ state } = fortune('f8', (c) => own(c, 'p2', 12), [[3, 4], [2, 3]]));
  assert.equal(P(state, 'p1').pos, 12);
  assert.equal(P(state, 'p1').cash, 1450); // 10 x (2+3)
  assert.equal(P(state, 'p2').cash, 1550);
});

test('jail cards: go-to-jail, and keeping a get-out-free card', () => {
  let { state } = fortune('f11');
  assert.equal(P(state, 'p1').inJail, true);
  assert.equal(state.phase, 'post_roll');

  ({ state } = fortune('f9'));
  assert.equal(P(state, 'p1').jailCards.length, 1);
  assert.ok(!state.decks.fortune.includes('f9'));
});

test('repair and pay-each cards', () => {
  let { state } = fortune('f12', (c) => {
    own(c, 'p1', 1, 3); c.props[1].houses = 2; c.props[3].houses = 5;
  });
  assert.equal(P(state, 'p1').cash, 1500 - (2 * 25 + 100));

  ({ state } = fortune('f14'));
  assert.equal(P(state, 'p1').cash, 1400);
  assert.equal(P(state, 'p2').cash, 1550);
  assert.equal(P(state, 'p3').cash, 1550);
});

test('community cards: birthday collects from everyone (up to what they hold)', () => {
  let { state } = community('c6');
  assert.equal(P(state, 'p1').cash, 1600);
  assert.equal(P(state, 'p2').cash, 1450);

  ({ state } = community('c6', (c) => { c.players[1].cash = 20; }));
  assert.equal(P(state, 'p1').cash, 1570);
  assert.equal(P(state, 'p2').cash, 0);

  ({ state } = community('c1'));
  assert.equal(P(state, 'p1').cash, 1700);
  ({ state } = community('c5'));
  assert.equal(P(state, 'p1').inJail, true);
});

test('a card charge you cannot afford becomes debt', () => {
  const { state } = fortune('f13', (c) => { c.players[0].cash = 5; });
  assert.equal(state.phase, 'debt');
  assert.equal(state.debt.total, 15);
});

// ------------------------------------------------------------- turn flow

test('turn order skips bankrupt players and wraps around', () => {
  let s = edit(mk(), (c) => { c.players[1].bankrupt = true; });
  s = roll(s, 1, 2).state;
  s = act(s, 'decline').state;
  for (const id of ['p3', 'p1']) s = act(s, 'pass', {}, id).state;
  s = act(s, 'end_turn').state;
  assert.equal(cur(s).id, 'p3');
  s = roll(s, 1, 2).state;
  assert.ok(['buy', 'post_roll'].includes(s.phase));
});

test('actions are rejected out of turn, out of phase, or unknown', () => {
  const s = mk();
  throwsCode(() => act(s, 'roll', {}, 'p2'), 'not_your_turn');
  throwsCode(() => act(s, 'end_turn'), 'wrong_phase');
  throwsCode(() => act(s, 'teleport'), 'unknown_action');
  throwsCode(() => applyAction(s, null), 'bad_action');
  const after = roll(s, 1, 2).state;
  throwsCode(() => act(after, 'roll'), 'wrong_phase');
});

test('applyAction never mutates its input, and failures leave no trace', () => {
  const s = mk();
  const snapshot = JSON.stringify(s);
  roll(s, 3, 4);
  assert.equal(JSON.stringify(s), snapshot);
  assert.throws(() => act(s, 'end_turn'));
  assert.equal(JSON.stringify(s), snapshot);
});

test('getLegalActions reflects phase and player', () => {
  const s = mk();
  assert.deepEqual(getLegalActions(s, 'p2'), []);
  assert.ok(getLegalActions(s, 'p1').some((a) => a.type === 'roll'));
  const j = jailed();
  const types = getLegalActions(j, 'p1').map((a) => a.type);
  assert.ok(types.includes('pay_jail_fine'));
  const builder = setOwner('p1', 1, 3);
  assert.ok(getLegalActions(builder, 'p1').some((a) => a.type === 'build' && a.pos === 1));
  assert.ok(getLegalActions(builder, 'p1').some((a) => a.type === 'mortgage' && a.pos === 3));
});

// ------------------------------------------------------- determinism / IO

test('same seed gives the same game; state survives JSON round-trips', () => {
  const a = mk(4, 99);
  const b = mk(4, 99);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.decks, mk(4, 100).decks);
  const revived = JSON.parse(JSON.stringify(a));
  assert.deepEqual(revived, a);
  const r1 = applyAction(a, { type: 'roll', player: 'p1' }).state;
  const r2 = applyAction(revived, { type: 'roll', player: 'p1' }).state;
  assert.deepEqual(r1, r2);
});

// ------------------------------------------------- hostile / malformed input

test('hostile or malformed input is rejected with a GameError, never a crash', () => {
  const s = mk();
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    throwsCode(() => act(s, type), 'unknown_action');
  }
  throwsCode(() => applyAction(s, 'roll'), 'bad_action');
  throwsCode(() => applyAction(s, { type: 5, player: 'p1' }), 'bad_action');
  const trade = (give, to = 'p2') => act(s, 'propose_trade', { to, give, get: {} });
  throwsCode(() => trade({ props: 5 }), 'bad_trade');
  throwsCode(() => trade({ props: 'abc' }), 'bad_trade');
  throwsCode(() => trade(5), 'bad_trade');
  throwsCode(() => trade(null), 'bad_trade');
  throwsCode(() => trade([1]), 'bad_trade');
  throwsCode(() => trade({ cash: '10' }), 'bad_trade');
  throwsCode(() => trade({ cash: 1.5 }), 'bad_trade');
  throwsCode(() => trade({ cash: 1 }, { x: 1 }), 'bad_trade');
  const owned = setOwner('p1', 1, 3);
  throwsCode(() => act(owned, 'build', { pos: '1' }), 'bad_position');
  throwsCode(() => act(owned, 'mortgage', { pos: '__proto__' }), 'bad_position');
  throwsCode(() => act(owned, 'mortgage', { pos: -1 }), 'bad_position');
});

test('getActor names the one player the game is waiting on', () => {
  let s = mk();
  assert.equal(getActor(s), 'p1');
  s = roll(s, 1, 2).state;
  s = act(s, 'decline').state;
  assert.equal(getActor(s), 'p2'); // first bidder
  const t = act(edit(mk(), (c) => own(c, 'p1', 1)), 'propose_trade', { to: 'p3', give: { props: [1] }, get: {} }).state;
  assert.equal(getActor(t), 'p3');
  assert.ok(ACTION_TYPES.includes('roll') && !ACTION_TYPES.includes('constructor'));
  assert.equal(getActor({ ...s, winner: 'p1' }), null);
});
