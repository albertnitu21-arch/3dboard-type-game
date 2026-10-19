// Plays full bot-vs-bot games and prints summary stats.
//   node src/simulate.js [games=50] [players=4]

import { createGame, applyAction } from './engine.js';
import { chooseAction } from './bot.js';
import { makeRng } from './rng.js';

export function playGame({ seed, numPlayers = 4, maxActions = 20000, onStep } = {}) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i + 1}`, name: `Bot ${i + 1}` }));
  let state = createGame({ players, seed });
  const botRand = makeRng(seed + 1);
  let actions = 0;
  while (!state.winner && actions < maxActions) {
    const actor = state.phase === 'auction' ? state.auction.order[state.auction.idx]
      : state.phase === 'trade' ? state.trade.to
      : state.players[state.current].id;
    const action = chooseAction(state, actor, botRand);
    if (!action) throw new Error(`Bot stuck in phase ${state.phase}`);
    state = applyAction(state, action).state;
    actions += 1;
    onStep?.(state, action);
  }
  return { state, actions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const games = Number(process.argv[2] ?? 50);
  const numPlayers = Number(process.argv[3] ?? 4);
  let finished = 0, turns = 0;
  const wins = {};
  for (let g = 0; g < games; g++) {
    const { state } = playGame({ seed: 1000 + g, numPlayers });
    if (state.winner) {
      finished += 1;
      turns += state.turn;
      wins[state.winner] = (wins[state.winner] ?? 0) + 1;
    }
  }
  console.log(`${finished}/${games} games finished; avg ${Math.round(turns / Math.max(finished, 1))} turns`);
  console.log('wins by seat:', wins);
}
