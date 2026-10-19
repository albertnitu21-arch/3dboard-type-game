// End-to-end tests: a real server on a random port, real HTTP clients and event streams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../server/game-server.js';

async function startServer(opts = {}) {
  const { server, lobby } = createGameServer({ botDelay: 5, ...opts });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const streams = [];
  const stop = async () => {
    streams.forEach((s) => s.close());
    lobby.close();
    server.closeAllConnections?.();
    await new Promise((ok) => server.close(ok));
  };
  return { base, lobby, streams, stop };
}

async function post(base, path, body) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json() };
}

/** Minimal SSE client: collects events and lets tests wait for a matching one. */
function connect(ctx, code, token) {
  const ac = new AbortController();
  const events = [];
  const waiters = [];
  const s = {
    events,
    latest: {},
    close: () => ac.abort(),
    wait(pred, ms = 3000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((ok, fail) => {
        const w = { pred, ok };
        waiters.push(w);
        setTimeout(() => fail(new Error('timed out waiting for event')), ms).unref();
      });
    },
    /** Wait for an event that arrives after this call. */
    next(pred, ms) {
      const start = events.length;
      return s.wait((e) => events.indexOf(e) >= start && pred(e), ms);
    },
  };
  ctx.streams.push(s);
  s.ready = (async () => {
    const r = await fetch(`${ctx.base}/api/rooms/${code}/events?token=${token}`, { signal: ac.signal });
    s.status = r.status;
    if (r.status !== 200) return;
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const type = raw.match(/^event: (.*)$/m)?.[1];
            const data = raw.match(/^data: (.*)$/m)?.[1];
            if (!type || data === undefined) continue;
            const ev = { type, data: JSON.parse(data) };
            events.push(ev);
            s.latest[type] = ev.data;
            for (const w of [...waiters]) {
              if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.ok(ev); }
            }
          }
        }
      } catch { /* aborted */ }
      s.ended = true;
    })();
  })();
  return s;
}

test('create a room, join, start, and play a turn over HTTP', async () => {
  const ctx = await startServer();
  try {
    const host = (await post(ctx.base, '/api/rooms', { name: 'Ana' })).body;
    assert.match(host.code, /^[A-Z2-9]{4}$/);
    const guest = (await post(ctx.base, `/api/rooms/${host.code.toLowerCase()}/join`, { name: 'Bob' })).body;
    assert.equal(guest.code, host.code);
    assert.notEqual(guest.token, host.token);

    const hs = connect(ctx, host.code, host.token);
    const gs = connect(ctx, host.code, guest.token);
    await Promise.all([hs.ready, gs.ready]);
    const lobby = await hs.wait((e) => e.type === 'lobby' && e.data.members.length === 2 && e.data.members.every((m) => m.connected));
    assert.equal(lobby.data.hostId, host.id);

    // Only the host may start.
    assert.equal((await post(ctx.base, `/api/rooms/${host.code}/host`, { token: guest.token, op: 'start' })).status, 403);
    assert.equal((await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'start' })).status, 200);

    const st = (await gs.wait((e) => e.type === 'state')).data;
    assert.equal(st.state.players.length, 2);
    assert.equal(st.state.rng, undefined, 'RNG state must not leak');
    assert.equal(st.state.decks, undefined, 'card order must not leak');
    assert.deepEqual(st.state.deckSizes, { fortune: 16, community: 16 });

    const first = st.state.players[st.state.current].id;
    const [mover, other] = first === host.id ? [host, guest] : [guest, host];
    const moverStream = first === host.id ? hs : gs;
    const latestLegal = moverStream.latest.state.legal.map((a) => a.type);
    assert.ok(latestLegal.includes('roll'));

    // Out of turn: rejected.
    const wrong = await post(ctx.base, `/api/rooms/${host.code}/action`, { token: other.token, action: { type: 'roll' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'not_your_turn');

    // Spoofing the player field does nothing: the server uses the token's seat.
    const spoof = await post(ctx.base, `/api/rooms/${host.code}/action`, {
      token: other.token, action: { type: 'roll', player: mover.id },
    });
    assert.equal(spoof.status, 403);

    const pending = gs.next((e) => e.type === 'state' && e.data.events.some((x) => x.type === 'roll'));
    const ok = await post(ctx.base, `/api/rooms/${host.code}/action`, { token: mover.token, action: { type: 'roll' } });
    assert.equal(ok.status, 200);
    const after = (await pending).data;
    assert.ok(after.events.some((x) => x.type === 'move' || x.type === 'go_to_jail'));
    assert.equal(after.state.turn >= 1, true);
  } finally {
    await ctx.stop();
  }
});

test('bad requests get clear errors', async () => {
  const ctx = await startServer();
  try {
    assert.equal((await post(ctx.base, '/api/rooms/ZZZZ/join', { name: 'x' })).status, 404);
    const host = (await post(ctx.base, '/api/rooms', { name: 'Ana' })).body;
    const r = (p, b) => post(ctx.base, `/api/rooms/${host.code}/${p}`, b);
    assert.equal((await r('action', { token: 'nope', action: { type: 'roll' } })).status, 403);
    assert.equal((await r('action', { token: host.token, action: { type: 'roll' } })).body.error, 'not_started');
    assert.equal((await r('host', { token: host.token, op: 'start' })).body.error, 'not_enough_players');
    assert.equal((await r('host', { token: host.token, op: 'explode' })).status, 400);
    assert.equal((await r('join', { token: 'bogus' })).status, 403);

    const raw = await fetch(`${ctx.base}/api/rooms/${host.code}/action`, { method: 'POST', body: '[1,2' });
    assert.equal(raw.status, 400);
    const huge = await fetch(`${ctx.base}/api/rooms`, { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(40000) }) });
    assert.equal(huge.status, 413);

    const ev = await fetch(`${ctx.base}/api/rooms/${host.code}/events?token=wrong`);
    assert.equal(ev.status, 403);
    assert.equal((await fetch(`${ctx.base}/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/engine/..%2f..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/health`)).status, 200);
  } finally {
    await ctx.stop();
  }
});

test('lobby rules: names are cleaned and unique, max 8 seats, no joining mid-game', async () => {
  const ctx = await startServer();
  try {
    const host = (await post(ctx.base, '/api/rooms', { name: '  <b>Ana</b>  ' })).body;
    const room = ctx.lobby.get(host.code);
    assert.equal(room.members[0].name, 'bAna/b');
    await post(ctx.base, `/api/rooms/${host.code}/join`, { name: 'bAna/b' });
    assert.equal(room.members[1].name, 'bAna/b 2');
    for (let i = 0; i < 6; i++) await post(ctx.base, `/api/rooms/${host.code}/join`, { name: `P${i}` });
    const full = await post(ctx.base, `/api/rooms/${host.code}/join`, { name: 'Late' });
    assert.equal(full.status, 409);
    assert.equal(full.body.error, 'room_full');
    assert.equal((await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'add_bot' })).body.error, 'room_full');

    await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'kick', target: 'p8' });
    assert.equal(room.members.length, 7);
    await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'start' });
    const late = await post(ctx.base, `/api/rooms/${host.code}/join`, { name: 'Late' });
    assert.equal(late.body.error, 'game_started');
    // But an existing seat can come back with its token.
    const back = await post(ctx.base, `/api/rooms/${host.code}/join`, { token: host.token });
    assert.equal(back.body.id, host.id);
  } finally {
    await ctx.stop();
  }
});

test('a human vs bots game plays itself to the end when the human is on autoplay', async () => {
  const ctx = await startServer({ botDelay: 0 });
  try {
    const host = (await post(ctx.base, '/api/rooms', { name: 'Ana' })).body;
    for (let i = 0; i < 3; i++) {
      await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'add_bot' });
    }
    const s = connect(ctx, host.code, host.token);
    await s.ready;
    await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'start' });
    await s.wait((e) => e.type === 'state');

    // Takeover is refused while connected, allowed once the human leaves.
    const refused = await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'takeover', target: host.id });
    assert.equal(refused.body.error, 'still_connected');
    await post(ctx.base, `/api/rooms/${host.code}/leave`, { token: host.token });

    const room = ctx.lobby.get(host.code);
    const deadline = Date.now() + 20000;
    while (!room.state.winner && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(room.state.winner, `game did not finish (turn ${room.state.turn})`);
  } finally {
    await ctx.stop();
  }
});

test('reconnecting with the same token replaces the old stream and resends state', async () => {
  const ctx = await startServer();
  try {
    const host = (await post(ctx.base, '/api/rooms', { name: 'Ana' })).body;
    await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'add_bot' });
    const a = connect(ctx, host.code, host.token);
    await a.ready;
    await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'start' });
    await a.wait((e) => e.type === 'state');

    const b = connect(ctx, host.code, host.token);
    await b.ready;
    const st = await b.wait((e) => e.type === 'state');
    assert.equal(st.data.state.players.length, 2);
    const deadline = Date.now() + 2000;
    while (!a.ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(a.ended, 'old stream should be closed');

    const chat = b.next((e) => e.type === 'chat');
    await post(ctx.base, `/api/rooms/${host.code}/chat`, { token: host.token, text: '  hello\nthere  ' });
    assert.equal((await chat).data.text, 'hello there');
  } finally {
    await ctx.stop();
  }
});

test('any player can offer a trade; unanswered offers expire', async () => {
  const ctx = await startServer({ tradeTimeout: 300 });
  try {
    const host = (await post(ctx.base, '/api/rooms', { name: 'Ana' })).body;
    const bob = (await post(ctx.base, `/api/rooms/${host.code}/join`, { name: 'Bob' })).body;
    const cat = (await post(ctx.base, `/api/rooms/${host.code}/join`, { name: 'Cat' })).body;
    const bs = connect(ctx, host.code, bob.token);
    await bs.ready;
    await post(ctx.base, `/api/rooms/${host.code}/host`, { token: host.token, op: 'start' });
    const first = (await bs.wait((e) => e.type === 'state')).data.state;
    // Pick two players who are NOT on turn.
    const seats = { [host.id]: host, [bob.id]: bob, [cat.id]: cat };
    const waiting = first.players.map((p) => p.id).filter((id) => id !== first.players[first.current].id);
    const [from, to] = waiting.map((id) => seats[id]);
    const offer = await post(ctx.base, `/api/rooms/${host.code}/action`, {
      token: from.token, action: { type: 'propose_trade', to: to.id, give: { cash: 100 }, get: {} },
    });
    assert.equal(offer.status, 200, JSON.stringify(offer.body));
    const pending = await bs.wait((e) => e.type === 'state' && e.data.state.phase === 'trade');
    assert.ok(pending.data.tradeMsLeft > 0 && pending.data.tradeMsLeft <= 300);
    const expired = await bs.next((e) => e.type === 'state' && e.data.events.some((x) => x.type === 'trade_declined'), 3000);
    assert.equal(expired.data.state.phase, 'roll');
    assert.equal(expired.data.tradeMsLeft, null);
  } finally {
    await ctx.stop();
  }
});

test('the web client and the engine modules are served', async () => {
  const ctx = await startServer();
  try {
    const page = await fetch(`${ctx.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const board = await fetch(`${ctx.base}/engine/board.js`);
    assert.equal(board.status, 200);
    assert.match(board.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${ctx.base}/engine/missing.js`)).status, 404);
  } finally {
    await ctx.stop();
  }
});

test('idle and empty rooms are swept', async () => {
  const ctx = await startServer({ idleMs: 1000 });
  try {
    const a = (await post(ctx.base, '/api/rooms', { name: 'A' })).body;
    const b = (await post(ctx.base, '/api/rooms', { name: 'B' })).body;
    await post(ctx.base, `/api/rooms/${b.code}/leave`, { token: b.token });
    ctx.lobby.sweep();
    assert.ok(ctx.lobby.rooms.has(a.code));
    assert.ok(!ctx.lobby.rooms.has(b.code), 'empty room removed');
    ctx.lobby.sweep(Date.now() + 5000);
    assert.equal(ctx.lobby.rooms.size, 0);
  } finally {
    await ctx.stop();
  }
});
