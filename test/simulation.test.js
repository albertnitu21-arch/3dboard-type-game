import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, getLegalActions } from '../src/engine.js';
import { BOARD, GROUP_POSITIONS } from '../src/board.js';
import { DECK_IDS } from '../src/cards.js';
import { playGame } from '../src/simulate.js';

const PHASES = new Set(['roll', 'post_roll', 'buy', 'auction', 'debt', 'trade', 'game_over']);

/** Rules that must hold after every single action, whatever the players do. */
function checkInvariants(s) {
  assert.ok(PHASES.has(s.phase), `bad phase ${s.phase}`);
  const ids = new Set(s.players.map((p) => p.id));

  let houses = 0, hotels = 0;
  for (const [posStr, st] of Object.entries(s.props)) {
    const pos = Number(posStr);
    if (st.owner !== null) {
      assert.ok(ids.has(st.owner), `unknown owner at ${pos}`);
      assert.ok(!s.players.find((p) => p.id === st.owner).bankrupt, `bankrupt player owns ${pos}`);
    } else {
      assert.equal(st.houses, 0, `unowned property ${pos} has buildings`);
      assert.equal(st.mortgaged, false, `unowned property ${pos} is mortgaged`);
    }
    assert.ok(st.houses >= 0 && st.houses <= 5);
    if (BOARD[pos].type !== 'property') assert.equal(st.houses, 0);
    if (st.mortgaged) assert.equal(st.houses, 0, `mortgaged property ${pos} has buildings`);
    if (st.houses === 5) hotels++; else houses += st.houses;
  }
  assert.equal(houses + s.bank.houses, s.rules.houses, 'house supply leaked');
  assert.equal(hotels + s.bank.hotels, s.rules.hotels, 'hotel supply leaked');

  // Buildings only exist on a full set held by one player, built evenly (levels differ by at most one).
  for (const positions of Object.values(GROUP_POSITIONS)) {
    const levels = positions.map((q) => s.props[q].houses);
    assert.ok(Math.max(...levels) - Math.min(...levels) <= 1, 'uneven building levels');
    if (Math.max(...levels) > 0) {
      const owners = new Set(positions.map((q) => s.props[q].owner));
      assert.equal(owners.size, 1, 'buildings on a split set');
      assert.ok(!owners.has(null));
    }
  }

  for (const p of s.players) {
    assert.ok(Number.isInteger(p.cash) && p.cash >= 0, `${p.id} has cash ${p.cash}`);
    assert.ok(p.pos >= 0 && p.pos < 40);
    if (p.bankrupt) {
      assert.equal(p.cash, 0);
      assert.equal(p.jailCards.length, 0);
    }
    if (p.inJail) assert.equal(p.pos, s.rules.jailPos);
  }

  // Every card is either in its deck or held by exactly one player.
  const held = s.players.flatMap((p) => p.jailCards.map((c) => c.id));
  for (const deck of ['fortune', 'community']) {
    const inDeck = s.decks[deck];
    const heldHere = held.filter((id) => DECK_IDS[deck].includes(id));
    assert.deepEqual([...inDeck, ...heldHere].sort(), [...DECK_IDS[deck]].sort(), `${deck} deck corrupted`);
  }

  const alive = s.players.filter((p) => !p.bankrupt);
  assert.ok(alive.length >= 1);
  if (s.winner) {
    assert.equal(alive.length, 1);
    assert.equal(s.winner, alive[0].id);
    assert.equal(s.phase, 'game_over');
  } else {
    assert.ok(!s.players[s.current].bankrupt, 'current player is bankrupt');
  }
}

test('bot-vs-bot games keep every invariant and (mostly) finish', () => {
  let finished = 0;
  const games = 30;
  for (let g = 0; g < games; g++) {
    const numPlayers = 2 + (g % 7); // 2..8 players
    const { state } = playGame({
      seed: 500 + g,
      numPlayers,
      maxActions: 6000,
      onStep: (s) => checkInvariants(s),
    });
    if (state.winner) finished++;
  }
  assert.ok(finished >= games * 0.5, `only ${finished}/${games} games finished`);
});

test('simulations are reproducible from the seed', () => {
  const a = playGame({ seed: 4242, numPlayers: 4, maxActions: 3000 });
  const b = playGame({ seed: 4242, numPlayers: 4, maxActions: 3000 });
  assert.deepEqual(a.state, b.state);
  assert.equal(a.actions, b.actions);
});

test('the bot only ever picks actions the engine accepts', () => {
  // playGame throws if applyAction rejects; this also confirms the legal list is honest.
  const { state } = playGame({ seed: 7, numPlayers: 3, maxActions: 1500 });
  if (!state.winner) {
    const actor = state.phase === 'auction' ? state.auction.order[state.auction.idx] : state.players[state.current].id;
    for (const a of getLegalActions(state, actor)) {
      if (a.type === 'bid') {
        assert.doesNotThrow(() => applyAction(state, { type: 'bid', amount: a.min, player: actor }));
      } else if (a.type !== 'propose_trade') {
        assert.doesNotThrow(() => applyAction(state, { ...a, player: actor }));
      }
    }
  }
});
