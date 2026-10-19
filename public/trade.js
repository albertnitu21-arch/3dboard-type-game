// Trade window: build an offer with title-deed cards and cash, see it update live,
// and answer incoming offers. Rules are still enforced by the server; this file
// only builds the `propose_trade` action and shows `state.trade`.

import { BOARD, GROUP_POSITIONS } from './engine/board.js';
import { el, deedCard } from './deeds.js';

const JAIL_VALUE = 50;

const GROUP_LABEL = {
  brown: 'Brown', lightblue: 'Light blue', pink: 'Pink', orange: 'Orange',
  red: 'Red', yellow: 'Yellow', green: 'Green', darkblue: 'Dark blue',
};

const emptySide = () => ({ cash: 0, props: [], jailCards: 0 });

/**
 * @param {object} o
 * @param {HTMLElement} o.root     modal container
 * @param {HTMLElement} o.banner   small status box in the side panel
 * @param {() => {state, legal, tradeMsLeft, receivedAt}} o.getGame
 * @param {() => string} o.myId
 * @param {(id) => string} o.nameOf
 * @param {(id) => string} o.colorOf
 * @param {(action) => Promise} o.send   sends an action, rejects with Error(message)
 */
export function createTradeUI({ root, banner, getGame, myId, nameOf, colorOf, send }) {
  let mode = null;           // null | 'compose' | 'view'
  let draft = null;          // { partner, give, get }
  let error = '';
  let busy = false;
  let dismissedKey = null;   // incoming offer the player closed without answering
  let lastTradeKey = null;
  let timer = null;

  const state = () => getGame()?.state;
  const player = (id) => state()?.players.find((p) => p.id === id);
  const tradeKey = (t) => (t ? JSON.stringify(t) : null);

  // ---------------------------------------------------------------- values

  const worth = (pos) => (state().props[pos].mortgaged ? BOARD[pos].mortgage : BOARD[pos].price);
  const sideValue = (o) => o.cash + o.props.reduce((s, q) => s + worth(q), 0) + o.jailCards * JAIL_VALUE;

  function tradableProps(id) {
    const s = state();
    return Object.keys(s.props).map(Number).filter((pos) => s.props[pos].owner === id);
  }
  function blockedReason(pos) {
    const g = BOARD[pos].group;
    if (g && GROUP_POSITIONS[g].some((q) => state().props[q].houses > 0)) return 'Sell the buildings in this set first';
    return null;
  }
  /** Colour sets that `receiver` would complete by getting `gained`. */
  function setsCompleted(receiver, gained) {
    const s = state();
    return Object.entries(GROUP_POSITIONS)
      .filter(([, g]) => g.some((q) => gained.includes(q))
        && g.every((q) => s.props[q].owner === receiver || gained.includes(q)))
      .map(([name]) => name);
  }

  // ----------------------------------------------------------------- cards

  function deed(pos, opts) {
    return deedCard(state(), pos, opts);
  }

  const bill = (amount) => el('div', { class: 'bill', title: `${amount} cash` },
    el('span', { class: 'bill-c' }, '¤'), el('b', {}, amount.toLocaleString()));
  const jailCard = ({ onclick, selected } = {}) => el(onclick ? 'button' : 'div', {
    type: onclick ? 'button' : null, class: `deed jail sm${selected ? ' sel' : ''}`, onclick, 'aria-pressed': onclick ? String(selected) : null,
  },
  el('span', { class: 'deed-head' }, el('small', {}, 'CARD'), el('b', {}, 'Get out of Pușcărie free')),
  el('span', { class: 'deed-body' }, el('span', { class: 'icon' }, '🔓')),
  el('span', { class: 'deed-foot' }, `worth ~${JAIL_VALUE}`),
  selected && onclick ? el('span', { class: 'check', 'aria-hidden': 'true' }, '✓') : null);

  /** The live "on the table" view of one side of an offer. */
  function tray(side, { removable = false, emptyText = 'Nothing' } = {}) {
    const items = [];
    if (side.cash) items.push(bill(side.cash));
    for (let i = 0; i < side.jailCards; i++) items.push(jailCard());
    for (const pos of side.props) {
      items.push(deed(pos, {
        size: 'md',
        onclick: removable ? () => toggle(side === draft.give ? 'give' : 'get', pos) : null,
        title: removable ? `${BOARD[pos].name} (click to take back)` : BOARD[pos].name,
      }));
    }
    return el('div', { class: `tray${items.length ? '' : ' empty'}` }, items.length ? items : el('span', {}, emptyText));
  }

  function valueBar(giveLabel, giveVal, getLabel, getVal) {
    const total = giveVal + getVal || 1;
    const diff = getVal - giveVal;
    return el('div', { class: 'value' },
      el('div', { class: 'value-row' },
        el('span', {}, `${giveLabel} `, el('b', {}, `~${giveVal}`)),
        el('span', { class: `value-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}` },
          diff === 0 ? 'even' : diff > 0 ? `+${diff} for you` : `${diff} for you`),
        el('span', {}, `${getLabel} `, el('b', {}, `~${getVal}`))),
      el('div', { class: 'value-bar' },
        el('span', { class: 'give', style: `flex:${giveVal || 0.0001}` }),
        el('span', { class: 'get', style: `flex:${getVal || 0.0001}` })),
      el('div', { class: 'tag' }, 'Rough value: price of each property (mortgage value if mortgaged) plus cash.'));
  }

  function hints(fromId, toId, fromGives, toGives) {
    const out = [];
    for (const g of setsCompleted(toId, fromGives.props)) out.push(`${toId === myId() ? 'You complete' : `${nameOf(toId)} completes`} the ${GROUP_LABEL[g]} set`);
    for (const g of setsCompleted(fromId, toGives.props)) out.push(`${fromId === myId() ? 'You complete' : `${nameOf(fromId)} completes`} the ${GROUP_LABEL[g]} set`);
    return out.map((h) => el('div', { class: 'hint' }, el('span', { class: 'hint-dot' }, '★'), h));
  }

  // --------------------------------------------------------------- compose

  function others() {
    return state().players.filter((p) => !p.bankrupt && p.id !== myId());
  }

  function openComposer(partnerId, prefill) {
    const list = others();
    if (!list.length) return;
    const partner = list.find((p) => p.id === partnerId)?.id ?? list[0].id;
    draft = {
      partner,
      give: prefill?.give ? { ...emptySide(), ...prefill.give, props: [...prefill.give.props] } : emptySide(),
      get: prefill?.get ? { ...emptySide(), ...prefill.get, props: [...prefill.get.props] } : emptySide(),
    };
    error = '';
    mode = 'compose';
    renderModal();
  }

  function toggle(key, pos) {
    const side = draft[key];
    side.props = side.props.includes(pos) ? side.props.filter((x) => x !== pos) : [...side.props, pos].sort((a, b) => a - b);
    renderModal();
  }

  /** Drop anything from the draft that no longer belongs to the right player. */
  function cleanDraft() {
    if (!draft) return;
    const s = state();
    if (!others().some((p) => p.id === draft.partner)) draft.partner = others()[0]?.id;
    const fix = (side, owner) => {
      side.props = side.props.filter((q) => s.props[q].owner === owner && !blockedReason(q));
      side.cash = Math.max(0, Math.min(side.cash, player(owner)?.cash ?? 0));
      side.jailCards = Math.min(side.jailCards, player(owner)?.jailCards.length ?? 0);
    };
    fix(draft.give, myId());
    if (draft.partner) fix(draft.get, draft.partner);
  }

  function cashControl(key, max) {
    const side = draft[key];
    const set = (v) => {
      side.cash = Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
      renderModal(key);
    };
    const input = el('input', {
      type: 'number', min: 0, max, step: 10, value: side.cash, inputmode: 'numeric', 'aria-label': 'Cash amount',
      onchange: (e) => set(e.target.value),
    });
    const range = el('input', {
      type: 'range', min: 0, max, step: 10, value: side.cash, 'aria-label': 'Cash slider',
      oninput: (e) => { side.cash = Number(e.target.value); input.value = side.cash; renderTray(key); },
      onchange: () => renderModal(key),
    });
    return el('div', { class: 'cash-ctl' },
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'small', onclick: () => set(side.cash - 50), 'aria-label': 'Less 50' }, '−50'),
        input,
        el('button', { type: 'button', class: 'small', onclick: () => set(side.cash + 50), 'aria-label': 'More 50' }, '+50'),
        el('button', { type: 'button', class: 'small ghost', onclick: () => set(0) }, 'Clear')),
      range,
      el('div', { class: 'tag' }, `Available: ${max.toLocaleString()}`));
  }

  function column(key, ownerId, title) {
    const side = draft[key];
    const owner = player(ownerId);
    const props = tradableProps(ownerId);
    return el('section', { class: `tcol ${key}` },
      el('header', { class: 'tcol-hd' },
        el('span', { class: 'dot', style: `background:${colorOf(ownerId)}` }),
        el('h3', {}, title),
        el('span', { class: 'cash' }, `¤ ${owner.cash.toLocaleString()}`)),
      el('div', { class: 'tray-wrap', 'data-tray': key }, tray(side, { removable: true, emptyText: 'Pick cards or add cash below' })),
      el('h4', {}, 'Cash'),
      cashControl(key, owner.cash),
      el('h4', {}, `Properties (${props.length})`),
      props.length
        ? el('div', { class: 'collection' }, props.map((pos) => {
          const reason = blockedReason(pos);
          return deed(pos, {
            selected: side.props.includes(pos), disabled: !!reason, title: reason ?? undefined,
            onclick: reason ? null : () => toggle(key, pos),
          });
        }))
        : el('div', { class: 'tag' }, 'No properties.'),
      owner.jailCards.length
        ? el('div', {}, el('h4', {}, 'Cards'), el('div', { class: 'collection' },
          jailCard({ selected: side.jailCards > 0, onclick: () => { side.jailCards = side.jailCards ? 0 : 1; renderModal(); } })))
        : null);
  }

  function renderTray(key) {
    const wrap = root.querySelector(`[data-tray="${key}"]`);
    if (wrap) wrap.replaceChildren(tray(draft[key], { removable: true, emptyText: 'Pick cards or add cash below' }));
    const sum = root.querySelector('[data-summary]');
    if (sum) sum.replaceChildren(...summary());
  }

  function summary() {
    const give = sideValue(draft.give);
    const get = sideValue(draft.get);
    return [valueBar('You give', give, 'You get', get), ...hints(myId(), draft.partner, draft.give, draft.get)];
  }

  async function submit() {
    if (busy) return;
    busy = true;
    error = '';
    renderModal();
    try {
      await send({ type: 'propose_trade', to: draft.partner, give: draft.give, get: draft.get });
      mode = 'view';
      draft = null;
    } catch (e) {
      error = e.message;
    }
    busy = false;
    renderModal();
  }

  function composeView() {
    cleanDraft();
    const g = getGame();
    const canSend = g.legal.some((a) => a.type === 'propose_trade') && !state().trade;
    const empty = !sideValue(draft.give) && !sideValue(draft.get);
    let why = '';
    if (state().trade) why = 'Another trade is waiting for an answer.';
    else if (!canSend) why = 'You can send once the current move has finished.';
    else if (empty) why = 'Add something to the offer.';
    const partners = others();
    return [
      el('header', { class: 'modal-hd' },
        el('h2', { id: 'trade-title' }, 'Make a trade'),
        el('button', { type: 'button', class: 'small ghost close', 'aria-label': 'Close', onclick: close }, '✕')),
      el('div', { class: 'partners', role: 'radiogroup', 'aria-label': 'Trade with' },
        el('span', { class: 'tag' }, 'With'),
        partners.map((p) => el('button', {
          type: 'button', role: 'radio', 'aria-checked': String(p.id === draft.partner),
          class: `chip${p.id === draft.partner ? ' on' : ''}`,
          onclick: () => { if (p.id !== draft.partner) { draft.partner = p.id; draft.get = emptySide(); renderModal(); } },
        }, el('span', { class: 'dot', style: `background:${colorOf(p.id)}` }), p.name))),
      el('div', { class: 'modal-body' },
        el('div', { class: 'tcols' },
          column('give', myId(), 'You give'),
          el('div', { class: 'swap', 'aria-hidden': 'true' }, '⇄'),
          column('get', draft.partner, `You get from ${nameOf(draft.partner)}`))),
      el('footer', { class: 'modal-ft' },
        el('div', { class: 'summary', 'data-summary': '' }, summary()),
        el('div', { class: 'ft-actions' },
          error ? el('span', { class: 'error' }, error) : why ? el('span', { class: 'tag' }, why) : null,
          el('button', { type: 'button', onclick: close }, 'Cancel'),
          el('button', { type: 'button', class: 'primary', disabled: !canSend || empty || busy || null, onclick: submit },
            busy ? 'Sending…' : 'Send offer'))),
    ];
  }

  // ------------------------------------------------------------ view offer

  function msLeft() {
    const g = getGame();
    if (g.tradeMsLeft == null) return null;
    return Math.max(0, g.tradeMsLeft - (Date.now() - g.receivedAt));
  }

  async function answer(type) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await send({ type });
    } catch (e) {
      error = e.message;
    }
    busy = false;
    renderModal();
  }

  function offerView() {
    const t = state().trade;
    const me = myId();
    const iAmTo = t.to === me, iAmFrom = t.from === me;
    // Show it from the viewer's side when they're involved.
    const left = iAmTo ? { who: t.to, side: t.get, label: 'You give' } : { who: t.from, side: t.give, label: `${iAmFrom ? 'You give' : `${nameOf(t.from)} gives`}` };
    const right = iAmTo ? { who: t.from, side: t.give, label: `You get from ${nameOf(t.from)}` } : { who: t.to, side: t.get, label: iAmFrom ? `You get from ${nameOf(t.to)}` : `${nameOf(t.to)} gives` };
    const title = iAmTo ? `${nameOf(t.from)} offers you a trade` : iAmFrom ? `Waiting for ${nameOf(t.to)}…` : `${nameOf(t.from)} ⇄ ${nameOf(t.to)}`;
    const col = (c) => el('section', { class: 'tcol' },
      el('header', { class: 'tcol-hd' },
        el('span', { class: 'dot', style: `background:${colorOf(c.who)}` }),
        el('h3', {}, c.label)),
      tray(c.side, { emptyText: 'Nothing' }));
    const left$ = sideValue(left.side), right$ = sideValue(right.side);
    const involved = iAmTo || iAmFrom;
    const actions = [];
    if (error) actions.push(el('span', { class: 'error' }, error));
    if (iAmTo) {
      actions.push(
        el('button', { type: 'button', onclick: () => answer('decline_trade'), disabled: busy || null }, 'Decline'),
        el('button', {
          type: 'button',
          disabled: busy || null,
          onclick: async () => {
            const prefill = { give: { ...t.get }, get: { ...t.give } };
            const partner = t.from;
            await answer('decline_trade');
            openComposer(partner, prefill);
          },
        }, 'Counter-offer'),
        el('button', { type: 'button', class: 'primary', onclick: () => answer('accept_trade'), disabled: busy || null }, 'Accept'));
    } else if (iAmFrom) {
      actions.push(el('button', { type: 'button', onclick: () => answer('cancel_trade'), disabled: busy || null }, 'Withdraw offer'));
    }
    actions.push(el('button', { type: 'button', class: 'ghost', onclick: close }, involved ? 'Hide' : 'Close'));
    const left0 = msLeft();
    return [
      el('header', { class: 'modal-hd' },
        el('h2', { id: 'trade-title' }, title),
        el('button', { type: 'button', class: 'small ghost close', 'aria-label': 'Close', onclick: close }, '✕')),
      left0 != null ? el('div', { class: 'countdown', 'data-countdown': '' },
        el('span', { class: 'cd-bar', style: `width:${(left0 / 60000) * 100}%` }),
        el('span', { class: 'cd-txt' }, `${Math.ceil(left0 / 1000)}s to answer`)) : null,
      el('div', { class: 'modal-body' },
        el('div', { class: 'tcols view' }, col(left), el('div', { class: 'swap', 'aria-hidden': 'true' }, '⇄'), col(right))),
      el('footer', { class: 'modal-ft' },
        el('div', { class: 'summary' },
          valueBar(iAmTo || iAmFrom ? 'You give' : `${nameOf(left.who)} gives`, left$,
            iAmTo || iAmFrom ? 'You get' : `${nameOf(right.who)} gives`, right$),
          hints(t.from, t.to, t.give, t.get)),
        el('div', { class: 'ft-actions' }, actions)),
    ];
  }

  // ---------------------------------------------------------------- modal

  let lastFocus = null;
  function renderModal(focusKey) {
    if (!mode || !state()) { hide(); return; }
    if (mode === 'view' && !state().trade) { hide(); return; }
    const active = document.activeElement;
    const keepFocus = active && root.contains(active) && active.getAttribute('aria-label');
    const scrollTop = root.querySelector('.modal-body')?.scrollTop ?? 0;
    const content = mode === 'compose' ? composeView() : offerView();
    root.replaceChildren(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'trade-title', tabindex: '-1' }, content));
    const body = root.querySelector('.modal-body');
    if (body) body.scrollTop = scrollTop;
    if (root.hidden) {
      lastFocus = document.activeElement;
      root.hidden = false;
      root.querySelector('.modal')?.focus?.();
    }
    if (keepFocus) {
      const sel = focusKey ? `[data-tray="${focusKey}"] ~ .cash-ctl [aria-label="${keepFocus}"]` : `[aria-label="${keepFocus}"]`;
      (root.querySelector(sel) ?? root.querySelector(`[aria-label="${keepFocus}"]`))?.focus?.();
    }
    clearInterval(timer);
    if (mode === 'view' && msLeft() != null) {
      timer = setInterval(() => {
        const left = msLeft();
        const cd = root.querySelector('[data-countdown]');
        if (!cd || left == null) return;
        cd.querySelector('.cd-bar').style.width = `${(left / 60000) * 100}%`;
        cd.querySelector('.cd-txt').textContent = `${Math.ceil(left / 1000)}s to answer`;
      }, 250);
    }
  }

  function hide() {
    clearInterval(timer);
    if (!root.hidden) {
      root.hidden = true;
      root.replaceChildren();
      lastFocus?.focus?.();
    }
  }

  function close() {
    const t = state()?.trade;
    if (mode === 'view' && t) dismissedKey = tradeKey(t);
    mode = null;
    draft = null;
    error = '';
    hide();
    renderBanner();
  }

  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });

  // --------------------------------------------------------------- banner

  function renderBanner() {
    const s = state();
    const t = s?.trade;
    const me = myId();
    const meP = player(me);
    const items = [];
    if (t) {
      const txt = t.to === me ? `${nameOf(t.from)} offers you a trade`
        : t.from === me ? `Your offer to ${nameOf(t.to)} is waiting`
          : `${nameOf(t.from)} is offering ${nameOf(t.to)} a trade`;
      items.push(el('span', { class: 'grow' }, el('span', { class: 'dot', style: `background:${colorOf(t.from)}` }), ' ⇄ ',
        el('span', { class: 'dot', style: `background:${colorOf(t.to)}` }), ` ${txt}`));
      items.push(el('button', { type: 'button', class: `small${t.to === me ? ' primary' : ''}`, onclick: () => { mode = 'view'; renderModal(); } },
        t.to === me ? 'Respond' : 'View'));
    } else if (s && !s.winner && meP && !meP.bankrupt && others().length) {
      items.push(el('span', { class: 'grow tag' }, 'Swap properties, cards or cash with anyone.'));
      items.push(el('button', { type: 'button', class: 'small', onclick: () => openComposer() }, 'Trade…'));
    }
    banner.replaceChildren(...items);
    banner.hidden = !items.length;
  }

  // ---------------------------------------------------------------- update

  /** Call whenever a new game state has been applied. */
  function update() {
    const s = state();
    if (!s) return;
    const t = s.trade;
    const key = tradeKey(t);
    if (key !== lastTradeKey) {
      lastTradeKey = key;
      error = '';
      // A new offer for me pops up by itself; the proposer sees the waiting view.
      if (t && (t.to === myId() || t.from === myId()) && key !== dismissedKey && mode !== 'compose') mode = 'view';
    }
    if (mode === 'view' && !t) mode = null;
    if (s.winner) { mode = null; draft = null; }
    renderBanner();
    if (mode) renderModal(); else hide();
  }

  return { update, openComposer, close, isOpen: () => !!mode };
}
