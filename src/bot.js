// A small heuristic bot. Used by the simulation/fuzz tests, and handy later for
// solo play or for filling empty seats. It only ever uses getLegalActions(), so it
// cannot make an illegal move.

import { BOARD, GROUP_POSITIONS } from './board.js';
import { getLegalActions } from './engine.js';

/** If we hold all but one property of a colour, offer a generous price for the last one. */
function findMonopolyTrade(state, p) {
  for (const positions of Object.values(GROUP_POSITIONS)) {
    const missing = positions.filter((q) => state.props[q].owner !== p.id);
    if (missing.length !== 1) continue;
    const pos = missing[0];
    const owner = state.props[pos].owner;
    if (!owner) continue;
    const offer = Math.ceil(BOARD[pos].price * 2.2);
    if (p.cash - offer < 300) continue;
    return { type: 'propose_trade', to: owner, give: { cash: offer }, get: { props: [pos] } };
  }
  return null;
}

export function chooseAction(state, playerId, rand = Math.random) {
  const legal = getLegalActions(state, playerId);
  if (!legal.length) return null;
  const p = state.players.find((x) => x.id === playerId);
  const has = (t) => legal.find((a) => a.type === t);
  const all = (t) => legal.filter((a) => a.type === t);
  const mk = (a) => ({ ...a, player: playerId });
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  switch (state.phase) {
    case 'roll': {
      const card = has('use_jail_card');
      if (card) return mk(card);
      const fine = has('pay_jail_fine');
      if (fine && p.cash > 500 && rand() < 0.7) return mk(fine);
      return mk(has('roll'));
    }
    case 'buy': {
      const price = BOARD[state.buy.pos].price;
      const buy = has('buy');
      if (buy && (p.cash - price >= 150 || rand() < 0.3)) return mk(buy);
      return mk(has('decline'));
    }
    case 'auction': {
      const a = state.auction;
      const price = BOARD[a.pos].price;
      const limit = Math.min(p.cash - 50, Math.floor(price * (0.6 + 0.5 * rand())));
      const bid = has('bid');
      const next = a.highBid + 10;
      if (bid && next <= limit && next >= bid.min && next <= bid.max) return mk({ type: 'bid', amount: next });
      return mk(has('pass'));
    }
    case 'debt': {
      const pay = has('pay_debt');
      if (pay) return mk(pay);
      const sell = all('sell_building');
      if (sell.length) return mk(pick(sell));
      const mort = all('mortgage');
      if (mort.length) return mk(pick(mort));
      return mk(has('declare_bankruptcy'));
    }
    case 'post_roll': {
      const builds = all('build');
      if (builds.length && p.cash >= 400 && rand() < 0.8) return mk(pick(builds));
      if (has('propose_trade') && rand() < 0.5) {
        const offer = findMonopolyTrade(state, p);
        if (offer) return mk(offer);
      }
      const unm = all('unmortgage');
      if (unm.length && p.cash >= 700) return mk(pick(unm));
      return mk(has('end_turn'));
    }
    case 'trade': {
      const t = state.trade;
      const accept = has('accept_trade');
      if (!accept) return mk(has('cancel_trade'));
      const value = (o) => o.cash + o.props.reduce((sum, q) => sum + BOARD[q].price, 0);
      // Sell for at least double the asking value; otherwise say no.
      return mk(value(t.give) >= 2 * value(t.get) && value(t.get) > 0 ? accept : has('decline_trade'));
    }
    default:
      return null;
  }
}
