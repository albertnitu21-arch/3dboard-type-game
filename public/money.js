// Money that moves: balances count up or down to their new value, and every change
// floats up as a green "+200" or red "−60" next to the player (and over their
// token on the 3D board).

import { BOARD } from './engine/board.js';
import { sfx } from './sounds.js';

const fmt = (n) => Math.round(n).toLocaleString();

/** Who gained or lost how much because of one engine event. */
export function eventDeltas(ev) {
  switch (ev.type) {
    case 'pay': {
      const why = { rent: 'rent', tax: 'tax', card: 'card', jail_fine: 'fine', repairs: 'repairs' }[ev.reason] ?? '';
      const out = [{ id: ev.from, amount: -ev.amount, why }];
      if (ev.to !== 'bank') out.push({ id: ev.to, amount: ev.amount, why });
      return out;
    }
    case 'pass_start': return [{ id: ev.player, amount: ev.amount, why: 'Start' }];
    case 'gain': return [{ id: ev.player, amount: ev.amount, why: 'card' }];
    case 'bought': return [{ id: ev.player, amount: -ev.price, why: BOARD[ev.pos].name }];
    case 'auction_won': return [{ id: ev.player, amount: -ev.amount, why: BOARD[ev.pos].name }];
    case 'built': return [{ id: ev.player, amount: -BOARD[ev.pos].houseCost, why: ev.level === 5 ? 'hotel' : 'house' }];
    case 'sold_building': return [{ id: ev.player, amount: ev.amount ?? BOARD[ev.pos].houseCost / 2, why: 'sold' }];
    case 'mortgaged': return [{ id: ev.player, amount: ev.amount, why: 'mortgage' }];
    case 'unmortgaged': return [{ id: ev.player, amount: -ev.amount, why: 'paid off' }];
    case 'trade_done': {
      const net = ev.get.cash - ev.give.cash; // for the proposer
      return net ? [{ id: ev.from, amount: net, why: 'trade' }, { id: ev.to, amount: -net, why: 'trade' }] : [];
    }
    default: return [];
  }
}

/**
 * @param {object} o
 * @param {() => object|null} o.getState   the state currently on screen
 * @param {(id) => {x, y}|null} o.tokenPos  token position in px inside `o.boardEl`, if shown
 * @param {HTMLElement} o.boardEl
 */
export function createMoneyUI({ getState, tokenPos, boardEl }) {
  const shown = new Map();  // id -> number on screen right now
  const anims = new Map();  // id -> { from, to, start, dur }
  let running = false;

  const actual = (id) => getState()?.players.find((p) => p.id === id)?.cash ?? 0;
  const target = (id) => anims.get(id)?.to ?? shown.get(id) ?? actual(id);

  /** The number to print for a player (used when the panel re-renders). */
  function value(id) {
    return fmt(shown.has(id) ? shown.get(id) : actual(id));
  }
  function direction(id) {
    const a = anims.get(id);
    return a ? (a.to > a.from ? 'up' : 'down') : '';
  }

  function paint(id, v, dir) {
    for (const el of document.querySelectorAll(`[data-cash="${CSS.escape(id)}"]`)) {
      el.textContent = fmt(v);
      el.classList.toggle('up', dir === 'up');
      el.classList.toggle('down', dir === 'down');
    }
  }

  function tick(now) {
    for (const [id, a] of anims) {
      const t = Math.min(1, (now - a.start) / a.dur);
      const e = 1 - (1 - t) ** 3;
      const v = a.from + (a.to - a.from) * e;
      shown.set(id, v);
      if (t >= 1) {
        anims.delete(id);
        shown.set(id, a.to);
        paint(id, a.to, '');
      } else {
        paint(id, v, a.to > a.from ? 'up' : 'down');
      }
    }
    if (anims.size) requestAnimationFrame(tick);
    else running = false;
  }

  function float(text, cls, x, y, big = false) {
    const n = document.createElement('div');
    n.className = `money-float ${cls}${big ? ' big' : ''}`;
    n.textContent = text;
    n.style.left = `${x}px`;
    n.style.top = `${y}px`;
    n.setAttribute('aria-hidden', 'true');
    document.body.append(n);
    n.addEventListener('animationend', () => n.remove());
    setTimeout(() => n.remove(), 2500);
  }

  /** Show a change of `amount` for player `id`, counting from the current value. */
  function change(id, amount, why = '') {
    if (!amount) return;
    const from = shown.has(id) ? shown.get(id) : target(id);
    const to = target(id) + amount;
    if (document.hidden) {
      anims.delete(id);
      shown.set(id, to);
      paint(id, to, '');
      return;
    }
    anims.set(id, { from, to, start: performance.now(), dur: Math.min(1400, 500 + Math.abs(amount) * 1.2) });
    if (amount > 0) sfx.coin(); else sfx.pay();
    if (!running) { running = true; requestAnimationFrame(tick); }

    const up = amount > 0;
    const text = `${up ? '+' : '−'}${fmt(Math.abs(amount))}`;
    const cls = up ? 'up' : 'down';
    // next to every place this balance is shown (players list, your wallet)
    for (const el of document.querySelectorAll(`[data-cash="${CSS.escape(id)}"]`)) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      float(why ? `${text} ${why}` : text, cls, r.right - 8, r.top - 4);
      const row = el.closest('[data-flash]');
      if (row) {
        row.classList.remove('flash-up', 'flash-down');
        void row.offsetWidth; // restart the animation
        row.classList.add(up ? 'flash-up' : 'flash-down');
      }
    }
    // over the player's token on the 3D board
    const p = tokenPos?.(id);
    if (p && boardEl && !boardEl.hidden) {
      const r = boardEl.getBoundingClientRect();
      if (p.x >= 0 && p.y >= 0 && p.x <= r.width && p.y <= r.height) float(text, cls, r.left + p.x, r.top + p.y, true);
    }
  }

  /** Animate the money effects of one event. */
  function apply(ev) {
    for (const d of eventDeltas(ev)) change(d.id, d.amount, d.why);
  }

  /** After a state is applied: make sure every balance ends at its true value. */
  function reconcile() {
    const s = getState();
    if (!s) return;
    for (const p of s.players) {
      if (!shown.has(p.id) && !anims.has(p.id)) { shown.set(p.id, p.cash); continue; }
      const diff = p.cash - target(p.id);
      if (diff) change(p.id, diff); // e.g. money handed over in a bankruptcy
    }
  }

  function reset() {
    shown.clear();
    anims.clear();
  }

  return { apply, reconcile, value, direction, reset };
}
