// HTTP transport for the game, with zero dependencies (Node's built-in http only).
//
//   POST /api/rooms                 { name }                 -> { code, id, token }
//   POST /api/rooms/:code/join      { name } or { token }    -> { code, id, token }
//   GET  /api/rooms/:code/events?token=...                    -> server-sent events
//   POST /api/rooms/:code/action    { token, action }        -> { ok }
//   POST /api/rooms/:code/host      { token, op, target? }   -> { ok }   op: add_bot | kick | start | takeover | restart
//   POST /api/rooms/:code/card-ok   { token, seq }           -> { ok }   drawer closes the card pop-up
//   POST /api/rooms/:code/back      { token }                -> { ok }   take your seat back from the bot
//   POST /api/rooms/:code/piece     { token, piece }         -> { ok }   choose a piece (lobby only)
//   POST /api/rooms/:code/chat      { token, text }          -> { ok }
//   POST /api/rooms/:code/leave     { token }                -> { ok }
//   GET  /health                                              -> { ok, rooms }
//   GET  /*                         static files from public/ (and /engine/* from src/)
//
// Live updates arrive as SSE events: lobby, state, chat, kicked, card_closed.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lobby, RoomError } from './rooms.js';
import { GameError } from '../src/engine.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STATIC_DIRS = [
  { prefix: '/engine/', dir: join(ROOT, 'src'), only: new Set(['.js']) },
  { prefix: '/', dir: join(ROOT, 'public') },
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 16 * 1024;
// Changes with every deploy (Render sets RENDER_GIT_COMMIT). Asset URLs include it,
// so browsers can never keep using files from an older version.
export const VERSION = (process.env.RENDER_GIT_COMMIT || '').slice(0, 12) || Date.now().toString(36);
const VERSIONED = /^\/v\/[A-Za-z0-9]{1,40}(?=\/)/;
const STATUS = {
  piece_taken: 409, no_such_room: 404, bad_token: 403, not_host: 403, not_your_turn: 403,
  room_full: 409, game_started: 409, server_full: 503, body_too_large: 413,
};

class HttpError extends Error {
  constructor(status, code, message) { super(message ?? code); this.status = status; this.code = code; }
}

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return; // keep draining so the 413 reply can still be delivered
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        fail(new HttpError(413, 'body_too_large', 'Request too large.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return ok({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        ok(v);
      } catch {
        fail(new HttpError(400, 'bad_json', 'Body must be a JSON object.'));
      }
    });
    req.on('error', fail);
  });
}

/** Wrap an SSE response as a stream the room can send to. */
function sseStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stop proxies (nginx etc.) from buffering
  });
  res.write('retry: 2000\n\n');
  let open = true;
  const ping = setInterval(() => { if (open) res.write(': ping\n\n'); }, 20_000);
  ping.unref?.();
  return {
    send(event, data) {
      if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (!open) return;
      open = false;
      clearInterval(ping);
      res.end();
    },
    _stop() { open = false; clearInterval(ping); },
  };
}

async function serveStatic(req, res, pathname) {
  const versioned = VERSIONED.test(pathname);
  if (versioned) pathname = pathname.replace(VERSIONED, '');
  for (const { prefix, dir, only } of STATIC_DIRS) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = decodeURIComponent(pathname.slice(prefix.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir + sep)) return false; // path traversal
    const ext = extname(file);
    if (only && !only.has(ext)) return false;
    try {
      const st = await stat(file);
      if (!st.isFile()) continue;
      let body = await readFile(file);
      let cache = versioned ? 'public, max-age=31536000, immutable' : 'no-cache';
      if (ext === '.html') {
        // Point the page at this version's files and tell it which version it is.
        body = Buffer.from(body.toString('utf8')
          .replace(/(href|src)="(?!https?:|\/|#)([^"]+\.(?:css|js))"/g, `$1="/v/${VERSION}/$2"`)
          .replace('<head>', `<head>\n  <meta name="app-version" content="${VERSION}">`));
        cache = 'no-store';
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': cache,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    } catch {
      // try the next directory
    }
  }
  return false;
}

export function createGameServer({ botDelay = 1500, corsOrigin = process.env.CORS_ORIGIN ?? '*', ...lobbyOpts } = {}) {
  const lobby = new Lobby({ botDelay, ...lobbyOpts });

  const auth = (room, token) => {
    const m = room.memberByToken(token);
    if (!m) throw new HttpError(403, 'bad_token', 'Unknown or expired seat.');
    return m;
  };

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', code?, verb?]
    if (parts[1] !== 'rooms') throw new HttpError(404, 'not_found', 'Not found.');

    if (parts.length === 2 && req.method === 'POST') {
      const body = await readJson(req);
      const { room, member } = lobby.create(body.name);
      return send(res, 201, { code: room.code, id: member.id, token: member.token });
    }
    if (parts.length !== 4) throw new HttpError(404, 'not_found', 'Not found.');
    const room = lobby.get(parts[2]);
    const verb = parts[3];

    if (verb === 'events' && req.method === 'GET') {
      const m = auth(room, url.searchParams.get('token'));
      const stream = sseStream(res);
      stream.send('hello', { version: VERSION });
      room.attach(m, stream);
      req.on('close', () => { stream._stop(); room.detach(m, stream); });
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
    const body = await readJson(req);

    switch (verb) {
      case 'join': {
        const m = room.join(body.name, body.token);
        return send(res, 200, { code: room.code, id: m.id, token: m.token });
      }
      case 'action': {
        const m = auth(room, body.token);
        room.act(m.id, body.action);
        return send(res, 200, { ok: true });
      }
      case 'host': {
        const m = auth(room, body.token);
        switch (body.op) {
          case 'add_bot': room.addBot(m.id); break;
          case 'kick': room.kick(m.id, body.target); break;
          case 'start': room.start(m.id); break;
          case 'takeover': room.takeover(m.id, body.target); break;
          case 'restart': room.restart(m.id); break;
          default: throw new HttpError(400, 'bad_request', 'Unknown host operation.');
        }
        return send(res, 200, { ok: true });
      }
      case 'card-ok': {
        const m = auth(room, body.token);
        room.closeCard(m.id, Number.isInteger(body.seq) ? body.seq : null);
        return send(res, 200, { ok: true });
      }
      case 'back': {
        const m = auth(room, body.token);
        room.back(m.id);
        return send(res, 200, { ok: true });
      }
      case 'piece': {
        const m = auth(room, body.token);
        room.setPiece(m.id, body.piece);
        return send(res, 200, { ok: true });
      }
      case 'chat': {
        const m = auth(room, body.token);
        room.chat(m.id, body.text);
        return send(res, 200, { ok: true });
      }
      case 'leave': {
        const m = auth(room, body.token);
        room.leave(m.id);
        return send(res, 200, { ok: true });
      }
      default:
        throw new HttpError(404, 'not_found', 'Not found.');
    }
  }

  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'bad_request', message: 'Bad URL.' });
    }
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true, rooms: lobby.rooms.size, version: VERSION });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, url.pathname)) return;
      return send(res, 404, { error: 'not_found', message: 'Not found.' });
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message });
      if (err instanceof RoomError || err instanceof GameError) {
        return send(res, STATUS[err.code] ?? 400, { error: err.code, message: err.message });
      }
      console.error(err);
      return send(res, 500, { error: 'internal', message: 'Something went wrong.' });
    }
  });

  server.on('close', () => lobby.close());
  return { server, lobby };
}

// Run directly: node server/game-server.js  (PORT env var, default 3000)
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const { server, lobby } = createGameServer();
  server.listen(port, () => console.log(`Game server on http://localhost:${port}`));
  const stop = () => {
    lobby.close(); // ends the open event streams so close() can finish
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
