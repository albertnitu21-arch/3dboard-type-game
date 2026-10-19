// Two card decks with original wording. Effects are data, interpreted by engine.js.
//
// Effect types:
//   cash          { amount }            +gain / -pay (to the bank)
//   move_to       { pos }               advance forward to pos (collect salary if passing Start)
//   move_back     { steps }             move backwards (no salary)
//   nearest       { kind }              'station' (pay double rent) | 'utility' (roll, pay 10x)
//   goto_jail     {}
//   jail_free     {}                    kept by the player until used
//   repairs       { house, hotel }      pay per building
//   pay_each      { amount }            pay every other active player
//   collect_each  { amount }            every other active player pays you (up to what they hold)

const C = (id, deck, text, effect) => [id, { id, deck, text, effect }];

export const CARDS = Object.fromEntries([
  // ---- Fortune ----
  C('f1', 'fortune', 'Advance to Start. Collect 200.', { type: 'move_to', pos: 0 }),
  C('f2', 'fortune', 'Advance to Negra Arroyo Lane. If you pass Start, collect 200.', { type: 'move_to', pos: 11 }),
  C('f3', 'fortune', "Advance to Trade Center. If you pass Start, collect 200.", { type: 'move_to', pos: 24 }),
  C('f4', 'fortune', 'Advance to Catalina Heights.', { type: 'move_to', pos: 39 }),
  C('f5', 'fortune', 'Take the train to North Station. If you pass Start, collect 200.', { type: 'move_to', pos: 5 }),
  C('f6', 'fortune', 'Advance to the nearest station. If unowned you may buy it; otherwise pay the owner double rent.', { type: 'nearest', kind: 'station' }),
  C('f7', 'fortune', 'Advance to the nearest station. If unowned you may buy it; otherwise pay the owner double rent.', { type: 'nearest', kind: 'station' }),
  C('f8', 'fortune', 'Advance to the nearest utility. If unowned you may buy it; otherwise roll and pay the owner 10 times the amount.', { type: 'nearest', kind: 'utility' }),
  C('f9', 'fortune', 'Get out of Pușcărie free. Keep this card until you need it.', { type: 'jail_free' }),
  C('f10', 'fortune', 'Go back 3 spaces.', { type: 'move_back', steps: 3 }),
  C('f11', 'fortune', 'Go directly to Pușcărie. Do not pass Start.', { type: 'goto_jail' }),
  C('f12', 'fortune', 'Street repairs: pay 25 per house and 100 per hotel you own.', { type: 'repairs', house: 25, hotel: 100 }),
  C('f13', 'fortune', 'Speeding fine. Pay 15.', { type: 'cash', amount: -15 }),
  C('f14', 'fortune', 'You are elected chairperson. Pay each player 50.', { type: 'pay_each', amount: 50 }),
  C('f15', 'fortune', 'The bank pays you a dividend of 50.', { type: 'cash', amount: 50 }),
  C('f16', 'fortune', 'Your building loan matures. Collect 150.', { type: 'cash', amount: 150 }),
  // ---- Community Fund ----
  C('c1', 'community', 'Bank error in your favour. Collect 200.', { type: 'cash', amount: 200 }),
  C('c2', 'community', "Doctor's fee. Pay 50.", { type: 'cash', amount: -50 }),
  C('c3', 'community', 'Sale of stock. Collect 50.', { type: 'cash', amount: 50 }),
  C('c4', 'community', 'Get out of Pușcărie free. Keep this card until you need it.', { type: 'jail_free' }),
  C('c5', 'community', 'Go directly to Pușcărie. Do not pass Start.', { type: 'goto_jail' }),
  C('c6', 'community', "It's your birthday. Collect 50 from every player.", { type: 'collect_each', amount: 50 }),
  C('c7', 'community', 'Insurance matures. Collect 100.', { type: 'cash', amount: 100 }),
  C('c8', 'community', 'Hospital fees. Pay 100.', { type: 'cash', amount: -100 }),
  C('c9', 'community', 'Consultancy fee. Collect 25.', { type: 'cash', amount: 25 }),
  C('c10', 'community', 'Building repairs: pay 40 per house and 115 per hotel you own.', { type: 'repairs', house: 40, hotel: 115 }),
  C('c11', 'community', 'Second prize in a baking contest. Collect 10.', { type: 'cash', amount: 10 }),
  C('c12', 'community', 'You inherit 100.', { type: 'cash', amount: 100 }),
  C('c13', 'community', 'School fees. Pay 50.', { type: 'cash', amount: -50 }),
  C('c14', 'community', 'Tax refund. Collect 20.', { type: 'cash', amount: 20 }),
  C('c15', 'community', 'Holiday fund matures. Collect 100.', { type: 'cash', amount: 100 }),
  C('c16', 'community', 'Advance to Start. Collect 200.', { type: 'move_to', pos: 0 }),
]);

export const DECK_IDS = {
  fortune: Object.values(CARDS).filter((c) => c.deck === 'fortune').map((c) => c.id),
  community: Object.values(CARDS).filter((c) => c.deck === 'community').map((c) => c.id),
};
