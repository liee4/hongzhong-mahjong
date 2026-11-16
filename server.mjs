import { createServer as httpServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { START_CHIPS, applyAction, expireTurn, playBots, startRound, viewGame } from './game.mjs';

const base = fileURLToPath(new URL('.', import.meta.url));
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const onlineMs = 12_000;
const roomLifetime = 24 * 60 * 60 * 1000;
const codeFormat = /^[2-9A-HJ-NP-Z]{6}$/;
const routes = new Set(['create', 'join', 'state', 'action', 'leave', 'bots']);
const assetFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/rack-order.mjs': ['rack-order.mjs', 'text/javascript; charset=utf-8'],
  '/tile-faces.mjs': ['tile-faces.mjs', 'text/javascript; charset=utf-8'],
  '/mahjong-faces.png': ['mahjong-faces.png', 'image/png'],
  '/table-audio.mjs': ['table-audio.mjs', 'text/javascript; charset=utf-8'],
  ...Object.fromEntries(['music', 'discard', 'pung', 'kong', 'hu'].map(name => [`/audio/${name}.wav`, [`audio/${name}.wav`, 'audio/wav']])),
};

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > 12 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new RequestError(400, '请输入 1 到 12 个字符的昵称。');
  }
  return name;
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RequestError(415, '请求需要使用 JSON。');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length <= 4096) chunks.push(chunk);
    else throw new RequestError(413, '请求内容过长。');
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw new RequestError(400, '请求格式错误。'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, '请求格式错误。');
  return body;
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function blankPlayer(name) {
  return { name, token: randomBytes(24).toString('hex'), chips: START_CHIPS, hand: [], melds: [], river: [], flowers: 0 };
}

function hostSeat(room) {
  return room.hostSeat ?? room.players.findIndex(player => player && !player.isBot);
}

function normalizeInviteOrigin(candidate) {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch { /* Ignore an invalid optional invite address. */ }
  return null;
}

export function createServer({ directory = join(base, 'data'), inviteOrigin = null } = {}) {
  mkdirSync(directory, { recursive: true });
  const sharedOrigin = () => normalizeInviteOrigin(typeof inviteOrigin === 'function' ? inviteOrigin() : inviteOrigin);
  const rooms = new Map();
  const connectedAt = new Map();
  for (const file of readdirSync(directory)) {
    const code = file.slice(0, -5);
    if (!file.endsWith('.json') || !codeFormat.test(code)) continue;
    try {
      const room = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      if (room.code === code && Array.isArray(room.players)) rooms.set(code, room);
    } catch (error) { console.error(`无法读取房间文件 ${file}`, error.message); }
  }

  function save(room, now) {
    room.updatedAt = now;
    room.revision++;
    const target = join(directory, `${room.code}.json`);
    writeFileSync(`${target}.tmp`, JSON.stringify(room), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
    rooms.set(room.code, room);
    return room;
  }

  function online(player, now) {
    return player && (player.isBot || now - (connectedAt.get(player.token) ?? 0) < onlineMs);
  }

  function sync(room, now) {
    if (!room.deadline) return room;
    if (now < room.deadline && !room.players.some(player => player?.isBot)) return room;
    const draft = structuredClone(room);
    return expireTurn(draft, now) || playBots(draft, now) ? save(draft, now) : room;
  }

  function snapshot(room, seat, now) {
    const view = viewGame(room, seat);
    view.players.forEach((player, index) => { if (player) player.connected = online(room.players[index], now); });
    return { ...view, code: room.code, revision: room.revision, serverTime: now, isHost: hostSeat(room) === seat, inviteOrigin: sharedOrigin() };
  }

  function api(endpoint, body, now) {
    if (endpoint === 'create') {
      const player = blankPlayer(readName(body.name));
      if (rooms.size >= 500) throw new RequestError(503, '当前房间较多，请稍后再试。');
      let code;
      do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
      const room = save({ code, revision: 0, players: [player, null, null, null], hostSeat: 0, phase: 'lobby', phaseId: 0,
        handNumber: 0, dealer: 0, turn: 0, wall: [], deadline: null, drawn: null, claims: {}, discard: null,
        event: null, result: null, lastDiscard: null }, now);
      connectedAt.set(player.token, now);
      return [201, { code, token: player.token, view: snapshot(room, 0, now) }];
    }

    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    let room = rooms.get(code);
    if (!room) throw new RequestError(404, '找不到这个房间，请检查房间码。');
    if (endpoint === 'join') {
      const player = blankPlayer(readName(body.name));
      const vacant = room.players.indexOf(null);
      const seat = vacant >= 0 ? vacant : room.players.findIndex(player => player?.isBot);
      if (room.phase !== 'lobby' || seat < 0) throw new RequestError(409, '这桌已经开局，只有原座位可以重连。');
      const draft = structuredClone(room);
      draft.players[seat] = player;
      draft.hostSeat = hostSeat(room) >= 0 ? hostSeat(room) : seat;
      if (draft.players.every(p => p && !p.isBot)) startRound(draft, now);
      room = save(draft, now);
      connectedAt.set(player.token, now);
      return [201, { code, token: player.token, view: snapshot(room, seat, now) }];
    }

    const seat = typeof body.token === 'string' ? room.players.findIndex(player => player && !player.isBot && player.token === body.token) : -1;
    if (seat < 0) throw new RequestError(401, '座位凭证失效，请重新加入。');
    if (endpoint === 'bots') {
      if (room.phase !== 'lobby') throw new RequestError(409, '开局后座位已锁定。');
      if (hostSeat(room) !== seat) throw new RequestError(403, '只有房主可以调整人机。');
      const draft = structuredClone(room);
      if (body.type === 'remove' && Number.isInteger(body.seat) && draft.players[body.seat]?.isBot) {
        draft.players[body.seat] = null;
      } else if (body.type === 'add' || body.type === 'fill') {
        const empty = draft.players.indexOf(null);
        if (empty < 0) throw new RequestError(409, '当前没有空位。');
        draft.players = draft.players.map((player, index) => {
          if (player || (body.type === 'add' && index !== empty)) return player;
          return { name: `牌友人机 ${index + 1}`, isBot: true, chips: START_CHIPS, hand: [], melds: [], river: [], flowers: 0 };
        });
      } else throw new RequestError(400, '无法调整这个席位。');
      connectedAt.set(body.token, now);
      return [200, snapshot(save(draft, now), seat, now)];
    }
    if (endpoint === 'leave') {
      if (room.phase === 'lobby') {
        const draft = structuredClone(room);
        draft.players[seat] = null;
        if (hostSeat(room) === seat) {
          draft.hostSeat = draft.players.findIndex(player => player && !player.isBot);
          if (draft.hostSeat < 0) draft.players.fill(null);
        }
        save(draft, now);
      }
      connectedAt.delete(body.token);
      return [200, { left: true }];
    }
    connectedAt.set(body.token, now);
    room = sync(room, now);
    if (endpoint === 'state') return [200, snapshot(room, seat, now)];

    if (body.phaseId !== room.phaseId) throw new RequestError(409, '牌局已更新，请重新选择。');
    const draft = structuredClone(room);
    try {
      if (body.type === 'start' && draft.phase === 'lobby') {
        if (hostSeat(draft) !== seat) throw new Error('只有房主可以开局。');
        if (draft.players.some(player => !online(player, now))) throw new Error('请等四个座位都到齐再开局。');
        startRound(draft, now);
      } else if (body.type === 'next' && draft.phase === 'result') {
        if (draft.players.some(player => !online(player, now))) throw new Error('请等待四位牌友都回到房间。');
        startRound(draft, now);
      } else {
        applyAction(draft, seat, { type: body.type, tile: body.tile }, now);
      }
    } catch (error) { throw new RequestError(409, error.message); }
    return [200, snapshot(save(draft, now), seat, now)];
  }

  let lastSweep = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const sweep = now - lastSweep > 60_000;
    if (sweep) lastSweep = now;
    for (const room of rooms.values()) {
      try {
        if (room.players.some(player => player && !player.isBot && online(player, now))) sync(room, now);
        else if (sweep && now - room.updatedAt > roomLifetime) {
          unlinkSync(join(directory, `${room.code}.json`));
          for (const player of room.players) if (player) connectedAt.delete(player.token);
          rooms.delete(room.code);
        }
      } catch (error) { console.error('房间定时同步失败', error.message); }
    }
  }, 500);
  timer.unref();

  const server = httpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'");
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const endpoint = pathname.slice(5);
      if (request.method === 'POST' && pathname.startsWith('/api/') && routes.has(endpoint)) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}` && origin !== sharedOrigin()) {
          throw new RequestError(403, '请在本游戏页面中操作。');
        }
        const body = await readBody(request);
        const [status, data] = api(endpoint, body, Date.now());
        return json(response, status, data);
      }
      if (request.method === 'GET' && pathname === '/healthz') return json(response, 200, { ready: true });
      const asset = Object.hasOwn(assetFiles, pathname) ? assetFiles[pathname] : null;
      if (asset && ['GET', 'HEAD'].includes(request.method)) {
        const file = join(base, 'public', asset[0]);
        if (existsSync(file)) {
          response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
          return response.end(request.method === 'HEAD' ? undefined : readFileSync(file));
        }
      }
      json(response, 404, { error: '页面不存在。' });
    } catch (error) {
      if (!(error instanceof RequestError)) console.error(error);
      if (!response.destroyed) json(response, error.status ?? 500, { error: error.status ? error.message : '房间服务暂时不可用，请重试。' });
    }
  });
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createServer({ directory: process.env.HONGZHONG_DATA_DIR, inviteOrigin: process.env.HONGZHONG_INVITE_ORIGIN });
  server.listen(port, host, () => console.log(`红中麻将已启动  http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`));
}
