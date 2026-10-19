// Title-deed cards shared by the trade window and the My properties panel.

import { BOARD, GROUPS, STATION_RENTS } from '/engine/board.js';

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

export function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1b1d19' : '#ffffff';
}

/** A title-deed card for an ownable space. `extra` is appended inside the card. */
export function deedCard(state, pos, { size = 'sm', selected = false, disabled = false, title, onclick, pressed = true, extra = null } = {}) {
  const sp = BOARD[pos];
  const st = state.props[pos];
  const band = sp.group ? GROUPS[sp.group].color : '#ffffff';
  const body = [];
  if (sp.type === 'property') {
    const [base, h1, h2, h3, h4, hotel] = sp.rents;
    if (size === 'md') {
      body.push(
        el('span', { class: 'r' }, el('span', {}, 'Rent'), el('b', {}, base)),
        el('span', { class: 'r' }, el('span', {}, 'Full set'), el('b', {}, base * 2)),
        el('span', { class: 'r' }, el('span', {}, '1 house'), el('b', {}, h1)),
        el('span', { class: 'r' }, el('span', {}, '2 houses'), el('b', {}, h2)),
        el('span', { class: 'r' }, el('span', {}, '3 houses'), el('b', {}, h3)),
        el('span', { class: 'r' }, el('span', {}, '4 houses'), el('b', {}, h4)),
        el('span', { class: 'r' }, el('span', {}, 'Hotel'), el('b', {}, hotel)),
        el('span', { class: 'r muted' }, el('span', {}, 'House'), el('b', {}, sp.houseCost)),
      );
    } else {
      body.push(
        el('span', { class: 'r' }, el('span', {}, 'Rent'), el('b', {}, base)),
        el('span', { class: 'r' }, el('span', {}, 'Hotel'), el('b', {}, hotel)),
      );
    }
  } else if (sp.type === 'station') {
    body.push(el('span', { class: 'icon' }, '🚆'));
    if (size === 'md') STATION_RENTS.forEach((r, i) => body.push(el('span', { class: 'r' }, el('span', {}, `${i + 1} owned`), el('b', {}, r))));
    else body.push(el('span', { class: 'r' }, el('span', {}, 'Rent'), el('b', {}, '25–200')));
  } else {
    body.push(el('span', { class: 'icon' }, /power/i.test(sp.name) ? '⚡' : '💧'));
    body.push(el('span', { class: 'r' }, el('span', {}, 'One'), el('b', {}, '4× dice')));
    if (size === 'md') body.push(el('span', { class: 'r' }, el('span', {}, 'Both'), el('b', {}, '10× dice')));
  }
  const kind = sp.type === 'property' ? 'TITLE DEED' : sp.type === 'station' ? 'STATION' : 'UTILITY';
  return el(onclick ? 'button' : 'div', {
    type: onclick ? 'button' : null,
    class: `deed ${size}${selected ? ' sel' : ''}${sp.type !== 'property' ? ' plain' : ''}`,
    style: `--band:${band};--band-ink:${inkFor(band)}`,
    disabled: disabled || null,
    title: title ?? `${sp.name}${disabled ? '' : onclick ? (selected ? ' (click to remove)' : ' (click to add)') : ''}`,
    onclick,
    'aria-pressed': onclick && pressed ? String(selected) : null,
  },
  el('span', { class: 'deed-head' }, el('small', {}, kind), el('b', {}, sp.name)),
  el('span', { class: 'deed-body' }, body),
  el('span', { class: 'deed-foot' }, st.mortgaged ? `Mortgaged · worth ${sp.mortgage}` : `Price ${sp.price}`),
  st.mortgaged ? el('span', { class: 'stamp' }, 'MORTGAGED') : null,
  selected && onclick ? el('span', { class: 'check', 'aria-hidden': 'true' }, '✓') : null,
  extra);
}
