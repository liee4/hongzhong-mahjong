import test from 'node:test';
import assert from 'node:assert/strict';
import { RED, claimActions, applyAction, startRound, winningHand, viewGame, expireTurn } from '../game.mjs';

const plain = [0, 1, 2, 3, 4, 5, 9, 10, 11, 15, 16, 17, 25, 25];
const player = (seat) => ({ name: `牌友${seat + 1}`, chips: 400, hand: [], melds: [], river: [], flowers: 0 });
function game() {
  return { players: Array.from({ length: 4 }, (_, i) => player(i)), phase: 'turn', phaseId: 1,
    turn: 0, deadline: 100, handNumber: 1, dealer: 0, wall: [5, 25], drawn: 0,
    afterKong: false, discard: null, claims: {}, event: null, result: null, roundStart: [400, 400, 400, 400] };
}

test('112 张牌，庄家 14 张，其他玩家 13 张，客户端只能看自己的手牌', () => {
  const g = game();
  g.phase = 'lobby';
  g.handNumber = 0;
  startRound(g, 100);
  const all = [...g.wall, ...g.players.flatMap(p => p.hand)];
  assert.equal(all.length, 112);
  for (let tile = 0; tile <= RED; tile++) assert.equal(all.filter(t => t === tile).length, 4);
  assert.deepEqual(g.players.map(p => p.hand.length), [14, 13, 13, 13]);
  const view = viewGame(g, 2);
  assert.equal(view.hand.length, 13);
  assert.equal(view.wall, undefined);
  assert.ok(view.players.every(p => p.hand === undefined));
});

test('红中可补将、两张红中可作将，七小对不独立成立', () => {
  assert.ok(winningHand([...plain.slice(0, 13), RED]));
  assert.ok(winningHand([...plain.slice(0, 12), RED, RED]));
  assert.ok(winningHand([0, RED, 2, 3, 4, 5, 9, 10, 11, 17, 17, RED, 25, 25]));
  assert.equal(winningHand([0, 0, 1, 1, 4, 4, 5, 5, 9, 9, 12, 12, 25, 25]), false);
});

test('四红中直接胡，三家各付 160', () => {
  const g = game();
  g.players[0].hand = [0, 3, 6, 9, 12, 15, 18, 21, 24, 25, RED, RED, RED, RED];
  applyAction(g, 0, { type: 'hu' }, 10);
  assert.equal(g.result.fan, 4);
  assert.deepEqual(g.players.map(p => p.chips), [880, 240, 240, 240]);
});

test('有红中不能接炮，无红中接炮只从出牌者收筹码', () => {
  const g = game();
  g.players[0].hand = [25];
  g.players[1].hand = plain.slice(0, 13);
  g.players[2].hand = [...plain.slice(0, 12), RED];
  applyAction(g, 0, { type: 'discard', tile: 25 }, 10);
  assert.ok(claimActions(g, 1).includes('hu'));
  assert.ok(!claimActions(g, 2).includes('hu'));
  applyAction(g, 1, { type: 'hu' }, 20);
  assert.deepEqual(g.players.map(p => p.chips), [390, 410, 400, 400]);
});

test('暗杠先收筹码，杠开和手牌红中叠加，暗杠记录不重复收费', () => {
  const g = game();
  g.players[0].hand = [0, 0, 0, 0, 3, 4, 5, 9, 10, 11, 15, 16, 17, RED];
  applyAction(g, 0, { type: 'kong', tile: 0 }, 10);
  assert.deepEqual(g.players.map(p => p.chips), [430, 390, 390, 390]);
  assert.equal(viewGame(g, 1).players[0].melds[0].tile, null);
  applyAction(g, 0, { type: 'hu' }, 20);
  assert.equal(g.result.fan, 2);
  assert.deepEqual(g.players.map(p => p.chips), [550, 350, 350, 350]);
});

test('点杠只记花，明杠杠开、花番、红中共 3 番', () => {
  const g = game();
  g.players[0].hand = [0];
  g.players[1].hand = [0, 0, 0, 3, 4, 5, 9, 10, 11, 15, 16, 17, RED];
  applyAction(g, 0, { type: 'discard', tile: 0 }, 10);
  applyAction(g, 1, { type: 'exposedKong' }, 20);
  assert.deepEqual(g.players.map(p => p.chips), [400, 400, 400, 400]);
  applyAction(g, 1, { type: 'hu' }, 30);
  assert.equal(g.result.fan, 3);
  assert.deepEqual(g.players.map(p => p.chips), [320, 640, 320, 320]);
});

test('补杠记一番花，胡牌赔付封在余额内', () => {
  const g = game();
  g.players[0].melds = [{ tile: 0, type: 'pung' }];
  g.players[0].hand = [0, 3, 4, 5, 9, 10, 11, 15, 16, 17, RED];
  g.players[1].chips = 20;
  applyAction(g, 0, { type: 'kong', tile: 0 }, 10);
  assert.equal(g.players[0].flowers, 1);
  applyAction(g, 0, { type: 'hu' }, 20);
  assert.deepEqual(g.players.map(p => p.chips), [580, 0, 320, 320]);
  assert.equal(g.result.tableEnded, true);
});

test('胡牌优先于碰，多家胡按出牌者之后的座位顺序', () => {
  const g = game();
  g.players[0].hand = [25];
  g.players[1].hand = plain.slice(0, 13);
  g.players[2].hand = [25, 25];
  g.players[3].hand = [0, 1, 2, 3, 4, 5, 9, 10, 11, 24, 26, 20, 20];
  applyAction(g, 0, { type: 'discard', tile: 25 }, 10);
  applyAction(g, 2, { type: 'pung' }, 20);
  applyAction(g, 3, { type: 'hu' }, 30);
  assert.equal(g.phase, 'claim');
  applyAction(g, 1, { type: 'hu' }, 40);
  assert.equal(g.result.winner, 1);
});

test('超时自动出牌，牌墙用尽判流局，既有暗杠收支保留', () => {
  const g = game();
  g.wall = [];
  g.players[0].hand = [0];
  g.players[0].chips = 430;
  for (const p of g.players.slice(1)) p.chips = 390;
  assert.equal(expireTurn(g, 99), false);
  assert.equal(expireTurn(g, 101), true);
  assert.equal(g.result.winner, null);
  assert.deepEqual(g.players.map(p => p.chips), [430, 390, 390, 390]);
});

test('庄家自摸留庄，闲家自摸或接炮胡的人接庄，流局顺位', () => {
  const outcomes = [
    { dealer: 2, winner: 2, source: null, next: 2 },
    { dealer: 2, winner: 3, source: null, next: 3 },
    { dealer: 2, winner: 1, source: 0, next: 1 },
    { dealer: 3, winner: null, source: null, next: 0 },
  ];
  for (const { dealer, winner, source, next } of outcomes) {
    const g = game();
    Object.assign(g, { dealer, phase: 'result', result: { winner, source, tableEnded: false } });
    assert.equal(viewGame(g, 0).nextDealer, next);
    startRound(g, 200);
    assert.equal(g.dealer, next);
    assert.equal(g.turn, next);
    assert.equal(g.players[next].hand.length, 14);
  }
});

test('听牌余数只依据自己的手牌和亮出的牌，暗杠和牌墙不泄露', () => {
  const g = game();
  g.turn = 1;
  g.players[0].hand = [0, 1, 2, 3, 4, 5, 9, 10, 11, 24, 26, 20, 20];
  g.players[1].melds = [{ tile: 25, type: 'concealedKong' }];
  g.wall = [RED, RED, 2];
  assert.deepEqual(viewGame(g, 0).listening.current, [{ tile: 25, remaining: 4 }, { tile: RED, remaining: 4 }]);
  g.players[1].melds = [{ tile: 25, type: 'pung' }];
  g.players[2].river = [25];
  g.players[3].river = [RED];
  assert.deepEqual(viewGame(g, 0).listening.current, [{ tile: 25, remaining: 0 }, { tile: RED, remaining: 3 }]);
});

test('选牌时提供打出后的听牌和余数，自己的牌计入已知数量', () => {
  const g = game();
  g.players[0].hand = [...plain.slice(0, 13), 8];
  g.drawn = 8;
  g.players[2].river = [25];
  const { listening } = viewGame(g, 0);
  assert.deepEqual(listening.afterDiscard[8], [{ tile: 25, remaining: 2 }, { tile: RED, remaining: 4 }]);
  assert.deepEqual(listening.current, listening.afterDiscard[8]);
  assert.equal(listening.afterDiscard[20], undefined);
});

test('落牌和胡牌各有独立的声音事件，重复读取不变', () => {
  const g = game();
  g.players[0].hand = [25];
  g.players[1].hand = plain.slice(0, 13);
  applyAction(g, 0, { type: 'discard', tile: 25 }, 10);
  const discard = viewGame(g, 2).event;
  assert.equal(discard.type, 'discard');
  assert.ok(Number.isInteger(discard.id));
  assert.deepEqual(viewGame(g, 2).event, discard);
  applyAction(g, 1, { type: 'hu' }, 20);
  const hu = viewGame(g, 2).event;
  assert.equal(hu.type, 'hu');
  assert.equal(hu.seat, 1);
  assert.ok(hu.id > discard.id);
  assert.deepEqual(viewGame(g, 3).event, hu);
});
