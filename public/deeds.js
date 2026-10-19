// Title-deed cards shared by the trade window and the My properties panel.

import { BOARD, GROUPS, GROUP_POSITIONS, STATION_RENTS } from './engine/board.js';

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

const SVG = 'http://www.w3.org/2000/svg';
function icon(path, fill, label) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('class', 'bi');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', fill);
  p.setAttribute('stroke', 'rgba(0,0,0,0.45)');
  p.setAttribute('stroke-width', '0.8');
  svg.append(p);
  if (label) svg.setAttribute('data-label', label);
  return svg;
}
const HOUSE_PATH = 'M6 1.2 L11 5.6 L9.6 5.6 L9.6 10.8 L2.4 10.8 L2.4 5.6 L1 5.6 Z';
const HOTEL_PATH = 'M3.5 1.5 L8.5 1.5 L11.4 4.8 L10.4 4.8 L10.4 10.8 L1.6 10.8 L1.6 4.8 L0.6 4.8 Z';
/** `n` little green houses, as on the board. */
export function houseIcons(n) {
  return el('span', { class: 'hi', title: `${n} house${n > 1 ? 's' : ''}`, 'aria-label': `${n} house${n > 1 ? 's' : ''}` },
    Array.from({ length: n }, () => icon(HOUSE_PATH, '#2f9e55')));
}
export function hotelIcon() {
  return icon(HOTEL_PATH, '#cf3b2c', 'hotel');
}

/** A title-deed card for an ownable space. `extra` is appended inside the card. */
export function deedCard(state, pos, { size = 'sm', selected = false, disabled = false, title, onclick, pressed = true, extra = null } = {}) {
  const sp = BOARD[pos];
  const st = state.props[pos];
  const band = sp.group ? GROUPS[sp.group].color : '#ffffff';
  const body = [];
  if (sp.type === 'property') {
    const [base, h1, h2, h3, h4, hotel] = sp.rents;
    const owner = st.owner;
    const fullSet = !!owner && GROUP_POSITIONS[sp.group].every((q) => state.props[q].owner === owner);
    // Which line of the rent ladder applies right now.
    const level = !owner || st.mortgaged ? -1 : st.houses > 0 ? st.houses + 1 : fullSet ? 1 : 0;
    const row = (i, label, value) => el('span', { class: `r${i === level ? ' now' : ''}` },
      el('span', { class: 'r-l' }, label), el('b', {}, value));
    body.push(
      row(0, 'Rent', base),
      row(1, 'With full set', base * 2),
      row(2, houseIcons(1), h1),
      row(3, houseIcons(2), h2),
      row(4, houseIcons(3), h3),
      row(5, houseIcons(4), h4),
      row(6, el('span', { class: 'hl' }, hotelIcon(), 'Hotel'), hotel),
      el('span', { class: 'r cost' }, el('span', { class: 'r-l' }, houseIcons(1), 'each'), el('b', {}, sp.houseCost)),
    );
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
