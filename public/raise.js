// "Raise money" panel: pick the houses to sell and the properties to mortgage, see
// the running total against what you owe, then do it all in one go (optionally
// paying the debt straight after). Sends one `raise_cash` action; the engine's
// previewRaise() gives the same numbers the server will use.

import { BOARD, GROUPS, GROUP_POSITIONS } from './engine/board.js';
import { previewRaise, sellOrder } from './engine/engine.js';
import { el } from './deeds.js';

const SET_NAMES = {
  brown: 'Brown', lightblue: 'Light blue', pink: 'Pink', orange: 'Orange',
  red: 'Red', yellow: 'Yellow', green: 'Green', darkblue: 'Dark blue',
};
const money = (n) => `¤${Math.round(n).toLocaleString()}`;
const SVG = 'http://www.w3.org/2000/svg';
const HOUSE = 'M6 1.2 L11 5.6 L9.6 5.6 L9.6 10.8 L2.4 10.8 L2.4 5.6 L1 5.6 Z';
const HOTEL = 'M3.5 1.5 L8.5 1.5 L11.4 4.8 L10.4 4.8 L10.4 10.8 L1.6 10.8 L1.6 4.8 L0.6 4.8 Z';
function shape(path) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

/** Positions in the order they come off, as "pos:level" -> index (0 = first to go). */
function removalIndex(state, group) {
  const lv = Object.fromEntries(GROUP_POSITIONS[group].map((q) => [q, state.props[q].houses]));
  const idx = new Map();
  sellOrder(state, group).forEach((q, k) => { idx.set(`${q}:${lv[q]}`, k); lv[q] -= 1; });
  return idx;
}

/**
 * A plan that raises at least `need` while giving up as little as possible:
 * first mortgage things without buildings (least useful first), then sell
 * buildings from the cheapest sets, then mortgage the sets that were cleared.
 */
export function suggestPlan(state, me, need) {
  const plan = { sell: {}, mortgage: [] };
  const raised = () => previewRaise(state, me, plan).raised;
  const mine = Object.keys(state.props).map(Number)
    .filter((q) => state.props[q].owner === me && !state.props[q].mortgaged);
  const built = (g) => GROUP_POSITIONS[g].some((q) => state.props[q].houses > 0);
  const ownsSet = (g) => GROUP_POSITIONS[g].every((q) => state.props[q].owner === me);
  const rank = (q) => {
    const sp = BOARD[q];
    if (sp.type === 'utility') return 1;
    if (sp.type === 'station') return 2;
    return ownsSet(sp.group) ? 3 : 0;
  };
  const free = mine.filter((q) => !(BOARD[q].group && built(BOARD[q].group)))
    .sort((a, b) => rank(a) - rank(b) || BOARD[a].mortgage - BOARD[b].mortgage);
  for (const q of free) {
    if (raised() >= need) return plan;
    plan.mortgage.push(q);
  }
  const sets = Object.keys(GROUP_POSITIONS).filter((g) => ownsSet(g) && built(g))
    .sort((a, b) => GROUPS[a].houseCost - GROUPS[b].houseCost);
  for (const g of sets) {
    const total = sellOrder(state, g).length;
    while ((plan.sell[g] ?? 0) < total) {
      const r = previewRaise(state, me, plan);
      if (r.ok && r.raised >= need) return plan;
      plan.sell[g] = (plan.sell[g] ?? 0) + 1;
    }
    for (const q of GROUP_POSITIONS[g]) {
      if (raised() >= need) return plan;
      if (!state.props[q].mortgaged) plan.mortgage.push(q);
    }
  }
  return plan;
}

export function createRaiseUI({ root, getGame, myId, send, onChange = () => {} }) {
  let open = false;
  let plan = { sell: {}, mortgage: new Set() };
  let pay = true;
  let busy = false;
  let error = '';

  const g = () => getGame();
  const state = () => g()?.state;
  const legal = () => g()?.legal ?? [];
  const available = () => legal().some((a) => a.type === 'raise_cash');
  const inDebt = () => state()?.phase === 'debt' && state().players[state().current]?.id === myId();
  const planOut = () => ({ sell: Object.fromEntries(Object.entries(plan.sell).filter(([, n]) => n > 0)), mortgage: [...plan.mortgage] });
  const preview = () => previewRaise(state(), myId(), planOut());

  /** Keep the plan valid after the game moved on (fewer buildings, things already mortgaged...). */
  function clampPlan() {
    const s = state();
    for (const grp of Object.keys(plan.sell)) {
      plan.sell[grp] = Math.min(plan.sell[grp], sellOrder(s, grp).length);
      if (!plan.sell[grp]) delete plan.sell[grp];
    }
    for (const q of [...plan.mortgage]) {
      if (s.props[q].owner !== myId() || s.props[q].mortgaged) plan.mortgage.delete(q);
    }
    dropBlockedMortgages();
  }
  /** A property can only be mortgaged once its whole set has no buildings left. */
  function dropBlockedMortgages() {
    const r = previewRaise(state(), myId(), { sell: planOut().sell, mortgage: [] });
    const level = (q) => r.levels[q] ?? state().props[q].houses;
    for (const q of [...plan.mortgage]) {
      const grp = BOARD[q].group;
      if (grp && GROUP_POSITIONS[grp].some((x) => level(x) > 0)) plan.mortgage.delete(q);
    }
  }

  function setSell(grp, n) {
    const max = sellOrder(state(), grp).length;
    plan.sell[grp] = Math.max(0, Math.min(max, n));
    if (!plan.sell[grp]) delete plan.sell[grp];
    dropBlockedMortgages();
    error = '';
    render();
  }
  function toggleMortgage(q) {
    if (plan.mortgage.has(q)) plan.mortgage.delete(q);
    else {
      const grp = BOARD[q].group;
      // tapping a property whose set still has buildings sells them too
      if (grp && GROUP_POSITIONS[grp].some((x) => state().props[x].houses > 0)) plan.sell[grp] = sellOrder(state(), grp).length;
      plan.mortgage.add(q);
    }
    error = '';
    render();
  }

  // ------------------------------------------------------------ pieces

  function summary(r) {
    const s = state();
    const cash = s.players.find((p) => p.id === myId())?.cash ?? 0;
    const after = cash + r.raised;
    const max = previewRaise(s, myId(), suggestPlan(s, myId(), Infinity)).raised;
    if (!inDebt()) {
      return el('div', { class: 'rz-sum' },
        el('div', { class: 'rz-stats' },
          stat('Cash', money(cash)),
          stat('This plan', `+${money(r.raised)}`, 'up'),
          stat('After', money(after))));
    }
    const owe = s.debt.total;
    const pct = Math.min(1, after / owe);
    const enough = after >= owe;
    return el('div', { class: `rz-sum ${enough ? 'ok' : 'short'}` },
      el('div', { class: 'rz-stats' },
        stat('You owe', money(owe), 'down'),
        stat('Cash', money(cash)),
        stat('This plan', `+${money(r.raised)}`, 'up')),
      el('div', { class: 'rz-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(owe), 'aria-valuenow': String(Math.min(after, owe)) },
        el('span', { class: 'rz-fill', style: `width:${(pct * 100).toFixed(1)}%` })),
      el('div', { class: 'rz-verdict' },
        enough
          ? el('span', {}, '✓ Enough. ', el('b', {}, `${money(after - owe)} left`), ' after paying.')
          : el('span', {}, el('b', {}, `${money(owe - after)} short`),
            cash + max < owe ? ` · even selling everything only raises ${money(max)}` : ''),
        el('span', { class: 'rz-quick' },
          !enough && cash + max >= owe ? el('button', { type: 'button', class: 'small', onclick: autoPick }, '✨ Pick for me') : null,
          Object.keys(plan.sell).length || plan.mortgage.size ? el('button', { type: 'button', class: 'small ghost', onclick: clear }, 'Clear') : null)));
  }
  const stat = (label, value, dir = '') => el('div', { class: `rz-stat ${dir}` }, el('small', {}, label), el('b', {}, value));

  function autoPick() {
    const s = state();
    const cash = s.players.find((p) => p.id === myId()).cash;
    const sug = suggestPlan(s, myId(), s.debt.total - cash);
    plan = { sell: sug.sell, mortgage: new Set(sug.mortgage) };
    error = '';
    render();
  }
  function clear() {
    plan = { sell: {}, mortgage: new Set() };
    error = '';
    render();
  }

  function buildingsSection(r) {
    const s = state();
    const sets = Object.keys(GROUP_POSITIONS).filter((grp) => GROUP_POSITIONS[grp].some((q) => s.props[q].owner === myId() && s.props[q].houses > 0));
    if (!sets.length) return null;
    return el('section', { class: 'rz-sec' },
      el('h3', {}, 'Sell buildings ', el('small', {}, 'tap a house: it and any that must go first are marked')),
      el('div', { class: 'rz-sets' }, sets.map((grp) => {
        const total = sellOrder(s, grp).length;
        const n = plan.sell[grp] ?? 0;
        const idx = removalIndex(s, grp);
        const each = GROUPS[grp].houseCost / 2;
        return el('div', { class: 'rz-set', style: `--band:${GROUPS[grp].color}` },
          el('div', { class: 'rz-set-hd' },
            el('b', {}, `${SET_NAMES[grp]} set`),
            el('small', {}, `${money(each)} each`),
            el('span', { class: 'rz-sub' }, n ? `+${money(n * each)}` : '')),
          el('div', { class: 'rz-props' }, GROUP_POSITIONS[grp].map((q) => {
            const lvl = s.props[q].houses;
            const now = r.levels[q] ?? lvl;
            const slots = [];
            for (let level = 1; level <= lvl; level++) {
              const k = idx.get(`${q}:${level}`);
              const marked = k < n;
              slots.push(el('button', {
                type: 'button', class: `rz-b ${level === 5 ? 'hotel' : 'house'}${marked ? ' sell' : ''}`,
                title: `${marked ? 'Keep' : 'Sell'} ${level === 5 ? 'the hotel' : `house ${level}`} on ${BOARD[q].name}`,
                'aria-pressed': String(marked),
                onclick: () => setSell(grp, marked ? k : k + 1),
              }, shape(level === 5 ? HOTEL : HOUSE)));
            }
            const lvName = (x) => (x === 5 ? 'hotel' : x === 0 ? 'nothing' : `${x} house${x > 1 ? 's' : ''}`);
            return el('div', { class: 'rz-prop' },
              el('div', { class: 'rz-pname' }, BOARD[q].name),
              el('div', { class: 'rz-slots' }, slots.length ? slots : el('span', { class: 'rz-none' }, '—')),
              el('div', { class: 'rz-after' }, lvl === now ? lvName(lvl) : `${lvName(lvl)} → ${lvName(now)}`));
          })),
          el('div', { class: 'rz-step' },
            el('button', { type: 'button', class: 'small', disabled: !n || null, 'aria-label': 'Sell one fewer', onclick: () => setSell(grp, n - 1) }, '−'),
            el('span', { title: 'A hotel counts as 5: the hotel, then its 4 houses' }, `Sell ${n} / ${total}`),
            el('button', { type: 'button', class: 'small', disabled: n >= total || null, 'aria-label': 'Sell one more', onclick: () => setSell(grp, n + 1) }, '+'),
            el('button', { type: 'button', class: 'small ghost', onclick: () => setSell(grp, n >= total ? 0 : total) }, n >= total ? 'None' : 'All')));
      })));
  }

  function mortgageSection(r) {
    const s = state();
    const mine = Object.keys(s.props).map(Number).filter((q) => s.props[q].owner === myId());
    const open = mine.filter((q) => !s.props[q].mortgaged);
    const already = mine.length - open.length;
    if (!open.length) return null;
    const level = (q) => r.levels[q] ?? s.props[q].houses;
    return el('section', { class: 'rz-sec' },
      el('h3', {}, 'Mortgage ', el('small', {}, already ? `${already} already mortgaged` : 'you can pay them off later')),
      el('div', { class: 'rz-morts' }, open.map((q) => {
        const sp = BOARD[q];
        const on = plan.mortgage.has(q);
        const blocked = !on && sp.group && GROUP_POSITIONS[sp.group].some((x) => level(x) > 0);
        const n = blocked ? sellOrder(s, sp.group).length - (plan.sell[sp.group] ?? 0) : 0;
        return el('button', {
          type: 'button', class: `rz-m${on ? ' on' : ''}${blocked ? ' blocked' : ''}`,
          style: `--band:${sp.group ? GROUPS[sp.group].color : '#9aa29a'}`,
          'aria-pressed': String(on),
          title: blocked ? `Its set still has buildings: tapping also sells the remaining ${n}` : on ? 'Tap to keep it' : 'Tap to mortgage it',
          onclick: () => toggleMortgage(q),
        },
        el('span', { class: 'rz-m-band' }, sp.type === 'station' ? '🚆' : sp.type === 'utility' ? '⚡' : ''),
        el('span', { class: 'rz-m-name' }, sp.name),
        el('span', { class: 'rz-m-val' }, on ? `✓ +${money(sp.mortgage)}` : `+${money(sp.mortgage)}`),
        blocked ? el('span', { class: 'rz-m-lock' }, `+ sell ${n} building${n > 1 ? 's' : ''}`) : null);
      })));
  }

  function receipt(r) {
    const lines = [];
    for (const [grp, n] of Object.entries(planOut().sell)) {
      lines.push([`${SET_NAMES[grp]} set · sell ${n} × ${money(GROUPS[grp].houseCost / 2)}`, (n * GROUPS[grp].houseCost) / 2]);
    }
    for (const q of plan.mortgage) lines.push([`Mortgage ${BOARD[q].name}`, BOARD[q].mortgage]);
    if (!lines.length) return el('div', { class: 'rz-empty tag' }, 'Tap houses to sell them, or properties to mortgage them.');
    return el('div', { class: 'rz-receipt' },
      el('ul', {}, lines.map(([t, v]) => el('li', {}, el('span', {}, t), el('b', {}, `+${money(v)}`)))),
      el('div', { class: 'rz-total' }, el('span', {}, 'Total'), el('b', {}, `+${money(r.raised)}`)));
  }

  function footer(r) {
    const s = state();
    const cash = s.players.find((p) => p.id === myId())?.cash ?? 0;
    const nothing = !Object.keys(planOut().sell).length && !plan.mortgage.size;
    const canPay = inDebt() && cash + r.raised >= s.debt.total;
    const paying = canPay && pay;
    const label = busy ? 'Working…'
      : paying ? (nothing ? `Pay ${money(s.debt.total)}` : `Raise ${money(r.raised)} & pay ${money(s.debt.total)}`)
        : `Sell & mortgage · +${money(r.raised)}`;
    const disabled = busy || !r.ok || (nothing && !paying);
    return el('footer', { class: 'modal-ft' },
      receipt(r),
      !r.ok ? el('p', { class: 'error' }, r.message) : error ? el('p', { class: 'error' }, error) : null,
      el('div', { class: 'ft-actions' },
        inDebt() ? el('label', { class: 'rz-pay', title: canPay ? '' : 'Raise enough first' },
          el('input', { type: 'checkbox', checked: paying || null, disabled: !canPay || null, onchange: (e) => { pay = e.target.checked; render(); } }),
          `Pay the ${money(s.debt.total)} debt right away`) : null,
        el('button', { type: 'button', onclick: close }, 'Cancel'),
        el('button', { type: 'button', class: 'primary', disabled: disabled || null, onclick: () => submit(paying, nothing) }, label)));
  }

  async function submit(paying, nothing) {
    busy = true;
    error = '';
    render();
    try {
      if (nothing) await send({ type: 'pay_debt' });
      else await send({ type: 'raise_cash', ...planOut(), pay: paying });
      busy = false;
      close();
    } catch (e) {
      busy = false;
      error = e.message;
      render();
    }
  }

  function render() {
    if (!open) return;
    const r = preview();
    const scroll = root.querySelector('.modal-body')?.scrollTop ?? 0;
    const body = el('div', { class: 'modal-body' }, buildingsSection(r), mortgageSection(r));
    root.replaceChildren(el('div', { class: 'modal rz', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rz-title', tabindex: '-1' },
      el('header', { class: 'modal-hd' },
        el('h2', { id: 'rz-title' }, inDebt() ? 'Raise money' : 'Sell & mortgage'),
        el('button', { type: 'button', class: 'small ghost close', 'aria-label': 'Close', onclick: close }, '✕')),
      summary(r),
      body,
      footer(r)));
    body.scrollTop = scroll;
    root.hidden = false;
  }

  function close() {
    if (!open) return;
    open = false;
    root.hidden = true;
    root.replaceChildren();
    onChange(false);
  }

  root.addEventListener('click', (e) => { if (e.target === root && !busy) close(); });
  // capture + stop: Esc closes only this panel, not fill-window / fullscreen as well
  addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape' && !busy) { e.stopImmediatePropagation(); close(); }
  }, true);

  return {
    open() {
      if (!state() || !available()) return;
      plan = { sell: {}, mortgage: new Set() };
      pay = true;
      error = '';
      busy = false;
      open = true;
      onChange(true);
      render();
      root.querySelector('.modal')?.focus({ preventScroll: true });
    },
    close,
    isOpen: () => open,
    /** Call after every state update. */
    update() {
      if (!open || busy) return;
      if (!available() && !(inDebt())) { close(); return; }
      clampPlan();
      render();
    },
  };
}
