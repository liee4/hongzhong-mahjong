import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createProxyServer, request as proxyRequest } from 'node:http';
import { createServer } from '../server.mjs';

test('从本机创建的房间可通过允许的外部地址加入，反代改写 Host 仍可联机', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hongzhong-proxy-'));
  let inviteOrigin;
  const gameServer = createServer({ directory, inviteOrigin: () => inviteOrigin });
  await new Promise(resolve => gameServer.listen(0, '127.0.0.1', resolve));
  const port = gameServer.address().port;
  const local = `http://127.0.0.1:${port}`;
  const proxy = createProxyServer((incoming, outgoing) => {
    const upstream = proxyRequest({ hostname: '127.0.0.1', port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: `127.0.0.1:${port}` } }, fromGame => {
      outgoing.writeHead(fromGame.statusCode, fromGame.headers);
      fromGame.pipe(outgoing);
    });
    upstream.on('error', () => { outgoing.statusCode = 502; outgoing.end(); });
    incoming.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  inviteOrigin = `http://127.0.0.1:${proxy.address().port}`;
  t.after(async () => {
    await Promise.all([proxy, gameServer].map(server => new Promise(resolve => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  });

  async function call(base, endpoint, data, origin = base) {
    return fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(data) });
  }
  const created = await call(local, 'create', { name: '房主' });
  const { code, token, view } = await created.json();
  assert.equal(view.inviteOrigin, inviteOrigin);
  assert.equal((await call(inviteOrigin, 'join', { code, name: '跨域请求' }, 'https://foreign.invalid')).status, 403);
  for (const name of ['客人一', '客人二', '客人三']) {
    const joined = await call(inviteOrigin, 'join', { code, name });
    assert.equal(joined.status, 201);
  }
  const table = await (await call(local, 'state', { code, token })).json();
  assert.equal(table.phase, 'turn');
  assert.deepEqual(table.players.map(player => player.name), ['房主', '客人一', '客人二', '客人三']);
});

test('四个客户端真实联机，服务器拒绝越权和重复操作，重启后仍可恢复席位', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hongzhong-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function launch() {
    const server = createServer({ directory });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, stop: () => new Promise(resolve => server.close(resolve)) };
  }
  let instance = await launch();
  t.after(() => instance.stop());
  async function call(endpoint, body, status = 200) {
    const response = await fetch(`${instance.origin}/api/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, status, data.error);
    return data;
  }

  assert.equal((await fetch(instance.origin)).status, 200);
  for (const asset of ['rack-order.mjs', 'tile-faces.mjs']) {
    const response = await fetch(`${instance.origin}/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
  }
  const faces = await fetch(`${instance.origin}/mahjong-faces.png`);
  assert.equal(faces.status, 200);
  assert.equal(faces.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await faces.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 476);
  assert.equal(png.readUInt32BE(20), 384);
  for (const name of ['music', 'discard', 'pung', 'kong', 'hu']) {
    const response = await fetch(`${instance.origin}/audio/${name}.wav`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    const wav = Buffer.from(await response.arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.subarray(44).some(sample => sample !== 0));
  }
  const first = await call('create', { name: '青竹' }, 201);
  const players = [first];
  assert.equal(first.view.phase, 'lobby');
  for (const name of ['远山', '海风', '归云']) players.push(await call('join', { code: first.code, name }, 201));
  const view = (player) => call('state', { code: player.code, token: player.token });
  const action = (player, phaseId, type, tile, status = 200) => call('action', { code: player.code, token: player.token, phaseId, type, tile }, status);
  const dealer = await view(first);
  assert.equal(dealer.phase, 'turn');
  assert.equal(dealer.left, 59);
  assert.equal(dealer.drawn >= 0, true);
  assert.deepEqual(dealer.players.map(p => p.chips), [400, 400, 400, 400]);
  assert.ok(dealer.players.every(p => Object.keys(p).every(key => !['hand', 'token'].includes(key))));
  assert.equal((await view(players[1])).drawn, null);
  await call('state', { code: first.code, token: 'forged' }, 401);
  await call('join', { code: first.code, name: '第五位' }, 409);
  await action(players[1], dealer.phaseId, 'discard', dealer.drawn, 409);
  await action(first, dealer.phaseId, 'discard', dealer.drawn);
  await action(first, dealer.phaseId, 'discard', dealer.drawn, 409);

  await call('leave', { code: first.code, token: players[3].token });
  assert.equal((await view(first)).players[3].connected, false);
  await instance.stop();
  instance = await launch();
  const reopened = await view(players[3]);
  assert.equal(reopened.seat, 3);
  assert.equal(reopened.players[3].connected, true);
  assert.equal(reopened.players[0].river[0], dealer.drawn);
});

test('房主可增减人机，真人可补位，开局后人机自动出牌', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hongzhong-bots-'));
  const server = createServer({ directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function call(endpoint, body, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, result.error);
    return result;
  }

  const owner = await call('create', { name: '房主' }, 201);
  const credentials = { code: owner.code, token: owner.token };
  const guest = await call('join', { code: owner.code, name: '牌友' }, 201);
  await call('bots', { code: owner.code, token: guest.token, type: 'add' }, 403);
  let table = await call('bots', { ...credentials, type: 'fill' });
  assert.equal(table.phase, 'lobby');
  assert.equal(table.players.filter(p => p.isBot).length, 2);
  table = await call('bots', { ...credentials, type: 'remove', seat: 2 });
  assert.equal(table.players[2], null);
  table = await call('bots', { ...credentials, type: 'add' });
  assert.equal(table.players[2].isBot, true);
  const newcomer = await call('join', { code: owner.code, name: '后来者' }, 201);
  assert.equal(newcomer.view.seat, 2);
  assert.equal(newcomer.view.players[2].isBot, false);
  table = await call('action', { ...credentials, phaseId: table.phaseId, type: 'start' });
  assert.equal(table.phase, 'turn');
  await call('bots', { ...credentials, type: 'add' }, 409);
  const humans = [credentials, { code: owner.code, token: guest.token }, { code: owner.code, token: newcomer.token }];
  for (let attempt = 0; attempt < 32; attempt++) {
    for (const player of humans) {
      const view = await call('state', player);
      if (view.players[3].river.length || view.players[3].melds.length || view.result?.winner === 3) return;
      if (view.actions.discard) await call('action', { ...player, phaseId: view.phaseId, type: 'discard', tile: view.drawn ?? view.hand.at(-1) });
      else if (view.actions.claims?.length) await call('action', { ...player, phaseId: view.phaseId, type: 'pass' });
    }
    await new Promise(resolve => setTimeout(resolve, 110));
  }
  assert.fail('Human turns progressed but the bot did not play');
});
