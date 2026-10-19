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

/**
 * Would this bot accept the pending trade? It values properties at their price
 * (mortgage value if mortgaged), wants a premium for anything that completes the
 * other player's colour set, and a premium to break up a set of its own.
 */
export function wouldAccept(state, botId) {
  const t = state.trade;
  if (!t || t.to !== botId) return false;
  const worth = (pos) => (state.props[pos].mortgaged ? BOARD[pos].mortgage : BOARD[pos].price);
  const completesSet = (playerId, gained) => Object.values(GROUP_POSITIONS).some((g) => {
    if (!g.some((q) => gained.includes(q))) return false;
    return g.every((q) => state.props[q].owner === playerId || gained.includes(q));
  });
  const ownsSetOf = (pos) => {
    const g = BOARD[pos].group && GROUP_POSITIONS[BOARD[pos].group];
    return !!g && g.every((q) => state.props[q].owner === botId);
  };
  const jailValue = 50;
  // From the bot's side: it receives t.give and hands over t.get.
  const gets = t.give.cash + t.give.props.reduce((s, q) => s + worth(q), 0) + t.give.jailCards * jailValue;
  let gives = t.get.cash + t.get.jailCards * jailValue;
  for (const q of t.get.props) gives += worth(q) * (ownsSetOf(q) ? 2.5 : 1);
  if (completesSet(t.from, t.get.props)) gives *= 1.8;
  if (completesSet(botId, t.give.props)) gives *= 0.7;
  if (gives === 0) return gets > 0;
  const bot = state.players.find((p) => p.id === botId);
  if (bot.cash - t.get.cash < 50 && t.get.cash > 0) return false;
  return gets >= gives * 1.15;
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
      const accept = has('accept_trade');
      if (!accept) return mk(has('cancel_trade'));
      return mk(wouldAccept(state, playerId) ? accept : has('decline_trade'));
    }
    default:
      return null;
  }
}
