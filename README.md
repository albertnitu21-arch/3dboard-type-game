# Estate

An original Monopoly-style property trading game for 2–8 players in the browser:
a rules engine, a multiplayer server, and a simple web client. **No dependencies**:
only Node.js 20 or newer is needed.

```bash
npm start            # server + web client on http://localhost:3000  (PORT=8080 npm start to change)
npm test             # 63 tests: rules, bot-vs-bot games, and real HTTP clients
npm run sim -- 50 4  # 50 bot games with 4 players, prints stats
```

The board is 3D: drag to rotate (one finger on phones), scroll or pinch to zoom,
and tap any space to see its rents and owner. Dice tumble in the middle on every
roll and tokens hop square by square; your buttons appear once the move has
played out. A **2D view** button switches to a flat board (also used
automatically on devices without WebGL).

**Pieces and camera:** in the lobby each player picks one of sixteen pieces (rubber duck,
rocket, snowman, mushroom, robot, ice cream, cactus, UFO, octopus, frog, burger, ghost,
cupcake, money bag, teapot, hot-air balloon), shown as 3D pictures in their colour; each
piece can be taken once. They are modelled in code in `public/pieces.js` (smooth shapes:
surfaces of revolution, tubes along curves, rounded boxes) and merged into a few meshes
each. On the board every piece has a pale glow in its player's colour (a little
brighter for whoever's turn it is), and pieces sharing a square shrink a little so
they don't bump into each other. The camera (in the View menu) has **Overview**, **Top-down**,
**Follow player** (third-person, behind whoever's turn it is) and **Free cam**
(drag to look, right/Shift-drag to move, scroll to zoom, WASD/arrows to fly, Q/E
to turn, R/F to tilt, double-click to glide to a spot; on phones one finger
looks, two fingers zoom and move, double-tap glides). When a piece moves, the squares it will cross glow in its colour (the
landing square pulses) and a counter above it shows the steps left.

**Trading:** anyone can press **Trade…** between moves (not only on their turn).
The trade window shows both players' properties as title-deed cards; click
cards and add cash, and the offer updates live with a rough value balance and a
note when a trade would complete a colour set. The other player gets the same
visual offer with Accept, Decline or Counter-offer. Unanswered offers expire
after 60 seconds so the game never gets stuck.

**Raising money:** when you owe more than you have, the **Raise money** panel opens
by itself (also from the move bar, or **Sell / mortgage several…** in My properties on
your turn). Tap houses and hotels to sell them; anything that has to go first to keep
the set even is marked too, and a hotel counts as the hotel plus its four houses. Tap
properties to mortgage them (a set's buildings are sold first). A running total shows
what you owe, your cash and what the plan raises; **✨ Pick for me** chooses the
cheapest way to cover the debt. One button does it all and can pay the debt right away.

**Cards:** Fortune and Community Fund cards sit in two piles in the middle of the
board. When someone draws one, the top card lifts off the pile and everyone sees
a pop-up with who drew it and what it says.

**Your moves** (Roll dice, Buy, Auction, End turn, bids, paying debts) float in a
small bar at the bottom of the board, with Auto roll / Auto end switches. The
board is framed so the bar never covers it, on computers and phones.

**The View menu:** one **View** button in the board's corner opens a menu (a drop-down on
computers, a sheet from the bottom on phones) with the camera modes, picture cards
for every scene, and switches for **Fill window** (board fills the browser window,
tabs stay), **Fullscreen**, the side panel, sounds and the 3D/flat board. In fill
window and fullscreen the side panel floats on top; the arrow on it hides it and a
**Players** button brings it back. The scenes are:

- **3D scenes** (`public/scenes.js`): Living room (a coffee table just bigger than
  the board, sofa, armchair, bookshelf, window, sleeping cat), Beach (umbrella,
  loungers, palms, sandcastle, sea), Garden picnic (blanket, basket, fence,
  flowers, trees, gnome), Casino (poker table with chips and cards, slot machines,
  roulette, bar), Winter cabin (fireplace with a flickering fire, Christmas tree,
  presents) and Space (floating platform, planets, asteroids, satellite).
- **Flat tables** (`public/backgrounds.js`): Classic, Meadow, Starry night, Candy.

Both choices are per device.

The renderer has real shadows (a shadow map from the sun), sky and ground light,
a lamp or fire light per scene, fog for outdoor scenes, rounded and smooth shapes
(`public/geometry.js`) and textures painted with noise in code
(`public/textures.js`, no image files). Textures are painted a few at a time in the
background, so a new scene appears at once and sharpens over a second or two.
Phones without high-precision shaders skip the shadows.

**Leaving and restarting:** **Leave game** hands your seat to a bot and takes
you back to the start page so you can create or join another room. The host
also has **Back to lobby**, which ends the game for everyone and returns the
room to the lobby to start again. If someone is away, the host can press
**Bot plays** next to their name; they get an **I'm back** button to take the
seat back. Bots pause while no person is connected, and abandoned rooms are
cleaned up after a few minutes.

Open the page, create a room, and share the link (or the 4-letter code). The
host can add bots, remove players and start the game. Reloading the page or
losing signal puts you back in your seat. If someone drops out mid-game, the host
can press **Bot plays** to have a bot take their turns until they return.

## Hosting it for free

The server is a plain Node process, so any Node host works:

- **Render** (free web service): build command `npm install`, start command `npm start`.
- **Fly.io**, **Railway**, or a $5/month VPS: same idea, `npm start`.

The server serves the web page too, so one deploy is all you need. Free hosts
usually sleep when idle, so the first visit can take 30–60 seconds.

Rooms live in memory: a server restart ends running games. That's fine for
friends' games. Save `room.state` (plain JSON) to a file or database if you
want games to survive restarts.

If you later host the page somewhere else (for example, a 3D client on
Cloudflare Pages), set `API` at the top of `public/app.js` to the server URL and
set `CORS_ORIGIN` on the server to your page's origin.

## How it fits together

```
src/        rules engine (pure functions, runs in Node and the browser)
  engine.js   state machine: applyAction(state, action) -> { state, events }
  board.js    spaces, colours, prices, rents: rename things here
  cards.js    both card decks as data
  bot.js      bot player (empty seats, autoplay, tests)
server/
  rooms.js        rooms, seats, host controls, bots (no networking)
  game-server.js  HTTP API + live updates + static files
public/     web client
  app.js      lobby, side panel, animation queue, card pop-up, 2D fallback board
  viewmenu.js the View menu (camera, scene, screen options)
  trade.js    trade window (title-deed cards, live offer, incoming offers)
  board3d.js  3D board on plain WebGL: board texture, tokens, houses, dice, camera, shadows
  scenes.js   3D scenery for each background (living room, beach, casino...)
  geometry.js meshes: rounded boxes, lathes, leaves, rocks, merging many parts
  textures.js procedural textures (wood, fabric, sand, water, grass, stone...)
  math3d.js   vectors, quaternions, matrices
test/       engine, simulation and server tests
```

The server is the only place the rules run. Clients send intentions ("roll",
"buy", "bid 120") and get the new state back. Each seat has a secret token; the
server decides who is acting, so players can't move for each other or fake dice.
Clients never see the dice generator or the card order.

### The 3D board

`public/board3d.js` has no dependencies. The board face is drawn onto a canvas
(names, prices, owner colours, mortgages) and used as a texture, so renaming
spaces in `src/board.js` updates the 3D board automatically. Tokens, houses,
hotels and dice are simple generated shapes. To use detailed models from Blender
later, port this file to Three.js and load `.glb` models; the rest of the client
only calls `sync(state)`, `play(events)`, `onSpace` and `resetView()`.

Bots wait 1.5 s between moves so the animations can keep up. If updates pile up
(for example, after the tab was in the background), animations speed up to
catch up.

### HTTP API

| Request | Body | Result |
|---|---|---|
| `POST /api/rooms` | `{ name }` | `{ code, id, token }` |
| `POST /api/rooms/:code/join` | `{ name }` or `{ token }` to rejoin | `{ code, id, token }` |
| `GET /api/rooms/:code/events?token=…` | | live event stream |
| `POST /api/rooms/:code/action` | `{ token, action: { type, … } }` | `{ ok }` |
| `POST /api/rooms/:code/host` | `{ token, op, target? }` (`add_bot`, `kick`, `start`, `takeover`) | `{ ok }` |
| `POST /api/rooms/:code/chat` | `{ token, text }` | `{ ok }` |
| `POST /api/rooms/:code/leave` | `{ token }` | `{ ok }` |

Errors come back as `{ error, message }` with a matching status code
(`not_your_turn`, `insufficient_cash`, `room_full`, …).

The live stream uses server-sent events (`lobby`, `state`, `chat`, `kicked`). A
`state` message carries the public game state, the actions you may take now
(`legal`), and what just happened (`events`) so a client can animate it.
`server/rooms.js` doesn't depend on the transport, so switching to WebSockets
later only means replacing `game-server.js`.

### Game actions

| Phase | Who | Actions |
|---|---|---|
| `roll` | current | `roll`, `pay_jail_fine`, `use_jail_card` |
| `buy` | current | `buy`, `decline` (starts an auction) |
| `auction` | next bidder | `bid {amount}`, `pass` |
| `debt` | current | `pay_debt`, `declare_bankruptcy` |
| `post_roll` | current | `end_turn` |
| `trade` | partner / proposer | `accept_trade`, `decline_trade` / `cancel_trade` |

Management (own turn): `build {pos}`, `sell_building {pos}`, `mortgage {pos}`,
`unmortgage {pos}`, `propose_trade {to, give: {cash, props, jailCards}, get: {…}}`,
`raise_cash {sell: {group: count}, mortgage: [pos], pay}` (many sales and mortgages
at once, all or nothing; `previewRaise()` in the engine shows the result first).

## Rules implemented

Dice and doubles (three doubles = jail), salary for passing Start, buying,
auctions, rent (set bonus, houses/hotels, stations, utilities), taxes, two card
decks (including keepable jail cards), jail (fine, card, doubles, forced fine on
the third try), even building/selling with a limited bank supply, mortgages,
debt with raise-money-then-pay, bankruptcy to a player or the bank, trading, and a
winner when one player is left.

**Deliberate simplifications:** building and mortgaging only on your own turn (trading is open to everyone between moves);
mortgaged properties change hands without the 10% fee; bankruptcy to the bank
returns properties unowned (no auction); "collect from everyone" cards take only
what each player holds; no Free Parking jackpot.
