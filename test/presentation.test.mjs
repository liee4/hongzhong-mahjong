import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRack, moveTile, syncRack } from '../public/rack-order.mjs';
import { tileHtml } from '../public/tile-faces.mjs';

const view = (hand, drawn = null, phaseId = 1, handNumber = 1) => ({ hand, drawn, phaseId, handNumber });
const tiles = rack => rack.tiles.map(({ tile }) => tile);

test('新摸牌留在右侧，自动整理原手牌，同一阶段保留手动排位', () => {
  let rack = syncRack(makeRack(), view([2, 3, 9], 1), true);
  assert.deepEqual(tiles(rack), [2, 3, 9, 1]);
  assert.equal(rack.tiles.at(-1).key, rack.drawKey);
  rack.tiles = moveTile(rack.tiles, rack.tiles[2].key, 0);
  rack = syncRack(rack, view([2, 3, 9], 1), true);
  assert.deepEqual(tiles(rack), [9, 2, 3, 1]);
  rack = syncRack(rack, view([2, 3, 9], null, 2), true);
  rack = syncRack(rack, view([2, 3, 9], 0, 3), true);
  assert.deepEqual(tiles(rack), [2, 3, 9, 0]);
});

test('打出旧牌后，新摸且留在手里的牌自动归入手牌', () => {
  let rack = syncRack(makeRack(), view([2, 3, 9], 1), true);
  const drawnKey = rack.drawKey;
  rack = syncRack(rack, view([1, 2, 9], null, 2), true, rack.tiles[1].key);
  assert.deepEqual(tiles(rack), [1, 2, 9]);
  assert.equal(rack.tiles[0].key, drawnKey);
  assert.equal(rack.drawKey, null);
});

test('关掉自动理牌后新牌追加，打出两张相同中的指定副本', () => {
  let rack = syncRack(makeRack(), view([0, 5, 21]), false);
  const fiveKey = rack.tiles[1].key;
  rack.tiles = moveTile(rack.tiles, fiveKey, 0);
  rack = syncRack(rack, view([0, 5, 21], 5, 2), false);
  assert.deepEqual(tiles(rack), [5, 0, 21, 5]);
  const drawnKey = rack.drawKey;
  assert.notEqual(fiveKey, drawnKey);
  rack = syncRack(rack, view([0, 5, 21], null, 3), false, fiveKey);
  assert.deepEqual(tiles(rack), [0, 21, 5]);
  assert.equal(rack.tiles.at(-1).key, drawnKey);
  rack = syncRack(rack, view([1, 5, 8], null, 5, 2), false);
  assert.deepEqual(tiles(rack), [1, 5, 8]);
});

test('截图素材覆盖游戏内 28 种牌，手牌与公开牌面共用对应的图片位置', () => {
  const positions = new Set();
  for (let tile = 0; tile < 28; tile++) {
    const hand = tileHtml(tile, { interactive: true, key: 't0' });
    const table = tileHtml(tile);
    const position = table.match(/--face-x:[^;]+;--face-y:[^"]+/)?.[0];
    assert.ok(position, `tile ${tile} has an image position`);
    assert.ok(hand.includes(position));
    positions.add(position);
  }
  assert.equal(positions.size, 28);
  assert.match(tileHtml(18), /aria-label="一条"/);
  assert.match(tileHtml(24), /aria-label="七条"/);
  assert.match(tileHtml(25), /aria-label="八条"/);
  assert.match(tileHtml(25), /data-tile="25"/);
  assert.doesNotMatch(tileHtml(null), /--face-x:/);
});
