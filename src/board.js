// Board data for an ORIGINAL-themed 40-space property trading game.
// All names are invented placeholders: rename freely (just keep positions and
// group keys consistent). Nothing here is tied to any commercial game's branding.

export const BOARD_SIZE = 40;

export const RULES = {
  startingCash: 1500,
  salary: 200,        // collected when passing or landing on Start
  jailFine: 50,
  jailPos: 10,
  goToJailPos: 30,
  maxJailTurns: 3,    // failed doubles attempts before the fine is forced
  houses: 32,         // bank supply
  hotels: 12,         // bank supply
  auctions: true,     // declined properties go to auction
};

export const GROUPS = {
  brown:     { color: '#8d5a3b', houseCost: 50 },
  lightblue: { color: '#8fd3f4', houseCost: 50 },
  pink:      { color: '#e46fa8', houseCost: 100 },
  orange:    { color: '#f39c3d', houseCost: 100 },
  red:       { color: '#d8433b', houseCost: 150 },
  yellow:    { color: '#f4d03f', houseCost: 150 },
  green:     { color: '#2e9e5b', houseCost: 200 },
  darkblue:  { color: '#2b4a9b', houseCost: 200 },
};

// rents: [no houses, 1 house, 2, 3, 4, hotel]
const P = (pos, name, group, price, rents) => ({
  pos, type: 'property', name, group, price, rents,
  houseCost: GROUPS[group].houseCost, mortgage: price / 2,
});
const ST = (pos, name) => ({ pos, type: 'station', name, price: 200, mortgage: 100 });
const UT = (pos, name) => ({ pos, type: 'utility', name, price: 150, mortgage: 75 });
const T = (pos, type, name, extra = {}) => ({ pos, type, name, ...extra });

/** Rent for owning 1, 2, 3 or 4 stations. */
export const STATION_RENTS = [25, 50, 100, 200];

export const BOARD = [
  T(0, 'start', 'Start'),
  P(1, 'Cobble Alley', 'brown', 60, [2, 10, 30, 90, 160, 250]),
  T(2, 'community', 'Community Fund'),
  P(3, 'Lantern Row', 'brown', 60, [4, 20, 60, 180, 320, 450]),
  T(4, 'tax', 'City Tax', { amount: 200 }),
  ST(5, 'North Station'),
  P(6, 'Harbor Walk', 'lightblue', 100, [6, 30, 90, 270, 400, 550]),
  T(7, 'fortune', 'Fortune'),
  P(8, "Fisher's Quay", 'lightblue', 100, [6, 30, 90, 270, 400, 550]),
  P(9, 'Saltmarsh Road', 'lightblue', 120, [8, 40, 100, 300, 450, 600]),
  T(10, 'jail', 'Lockup (Just Visiting)'),
  P(11, 'Orchard Lane', 'pink', 140, [10, 50, 150, 450, 625, 750]),
  UT(12, 'Power Works'),
  P(13, 'Cider Street', 'pink', 140, [10, 50, 150, 450, 625, 750]),
  P(14, 'Vineyard Way', 'pink', 160, [12, 60, 180, 500, 700, 900]),
  ST(15, 'East Station'),
  P(16, 'Foundry Street', 'orange', 180, [14, 70, 200, 550, 750, 950]),
  T(17, 'community', 'Community Fund'),
  P(18, 'Kiln Road', 'orange', 180, [14, 70, 200, 550, 750, 950]),
  P(19, "Smith's Yard", 'orange', 200, [16, 80, 220, 600, 800, 1000]),
  T(20, 'rest', 'Rest Stop'),
  P(21, 'Market Square', 'red', 220, [18, 90, 250, 700, 875, 1050]),
  T(22, 'fortune', 'Fortune'),
  P(23, 'Guild Hall Avenue', 'red', 220, [18, 90, 250, 700, 875, 1050]),
  P(24, "Merchant's Mile", 'red', 240, [20, 100, 300, 750, 925, 1100]),
  ST(25, 'South Station'),
  P(26, 'Clocktower Plaza', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
  P(27, 'Fountain Court', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
  UT(28, 'Water Works'),
  P(29, 'Bell Street', 'yellow', 280, [24, 120, 360, 850, 1025, 1200]),
  T(30, 'gotojail', 'Go to Lockup'),
  P(31, 'Parkview Boulevard', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
  P(32, 'Linden Avenue', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
  T(33, 'community', 'Community Fund'),
  P(34, 'Willow Terrace', 'green', 320, [28, 150, 450, 1000, 1200, 1400]),
  ST(35, 'West Station'),
  T(36, 'fortune', 'Fortune'),
  P(37, 'Skyline Drive', 'darkblue', 350, [35, 175, 500, 1100, 1300, 1500]),
  T(38, 'tax', 'Luxury Levy', { amount: 100 }),
  P(39, 'Crown Heights', 'darkblue', 400, [50, 200, 600, 1400, 1700, 2000]),
];

export const GROUP_POSITIONS = {};
for (const sp of BOARD) {
  if (sp.type === 'property') (GROUP_POSITIONS[sp.group] ??= []).push(sp.pos);
}
export const STATION_POSITIONS = BOARD.filter((s) => s.type === 'station').map((s) => s.pos);
export const UTILITY_POSITIONS = BOARD.filter((s) => s.type === 'utility').map((s) => s.pos);

export const isOwnable = (sp) =>
  sp.type === 'property' || sp.type === 'station' || sp.type === 'utility';
