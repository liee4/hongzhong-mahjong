import { randomInt } from 'node:crypto';

export const RED = 27;
export const START_CHIPS = 400;
export const STAKE = 10;
const TURN_MS = 24_000;
const CLAIM_MS = 8_000;
const seats = [0, 1, 2, 3];
const nextSeat = (seat, offset = 1) => (seat + offset) % 4;
const count = (tiles, value) => tiles.filter(tile => tile === value).length;
const nextDealer = game => game.result.source ?? game.result.winner ?? nextSeat(game.dealer);

function recordEvent(game, event) {
  game.event = { ...event, id: (game.event?.id ?? 0) + 1 };
}

export function winningHand(hand, meldCount = 0, fourReds = true) {
  if (hand.length !== 14 - 3 * meldCount || meldCount < 0 || meldCount > 4) return false;
  const red = count(hand, RED);
  if (fourReds && red === 4) return true;
  const tiles = Array(RED).fill(0);
  for (const tile of hand) if (tile !== RED) tiles[tile]++;
  const failed = new Set();

  function groups(wild) {
    const first = tiles.findIndex(n => n > 0);
    if (first === -1) return wild % 3 === 0;
    const key = `${wild}:${tiles.join('')}`;
    if (failed.has(key)) return false;

    for (let used = Math.min(tiles[first], 3); used >= 1; used--) {
      if (3 - used > wild) break;
      tiles[first] -= used;
      const complete = groups(wild - (3 - used));
      tiles[first] += used;
      if (complete) return true;
    }

    const suit = first - first % 9;
    for (let start = Math.max(suit, first - 2); start <= Math.min(first, suit + 6); start++) {
      const other = [start, start + 1, start + 2].filter(tile => tile !== first);
      for (let mask = 0; mask < 4; mask++) {
        const useWildA = mask & 1;
        const useWildB = mask >> 1;
        const cost = useWildA + useWildB;
        if (cost > wild || (!useWildA && !tiles[other[0]]) || (!useWildB && !tiles[other[1]])) continue;
        tiles[first]--;
        if (!useWildA) tiles[other[0]]--;
        if (!useWildB) tiles[other[1]]--;
        const complete = groups(wild - cost);
        if (!useWildA) tiles[other[0]]++;
        if (!useWildB) tiles[other[1]]++;
        tiles[first]++;
        if (complete) return true;
      }
    }
    failed.add(key);
    return false;
  }

  if (red >= 2 && groups(red - 2)) return true;
  for (let tile = 0; tile < RED; tile++) {
    for (let used = Math.min(tiles[tile], 2); used >= 1; used--) {
      if (2 - used > red) continue;
      tiles[tile] -= used;
      const complete = groups(red - (2 - used));
      tiles[tile] += used;
      if (complete) return true;
    }
  }
  return false;
}

function enter(game, phase, now, duration = 0) {
  game.phase = phase;
  game.phaseId++;
  game.phaseStarted = now;
  game.deadline = duration ? now + duration : null;
}

export function startRound(game, now = Date.now()) {
  if (game.players.length !== 4 || game.players.some(player => !player)) throw new Error('需要四人到齐才能开始。');
  if (!['lobby', 'result'].includes(game.phase) || game.result?.tableEnded) throw new Error('现在不能开局。');
  game.dealer = game.handNumber === 0 ? (game.hostSeat ?? 0) : nextDealer(game);
  game.handNumber++;
  game.roundStart = game.players.map(player => player.chips);
  game.wall = Array.from({ length: 112 }, (_, index) => Math.floor(index / 4));
  for (let index = game.wall.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    [game.wall[index], game.wall[swap]] = [game.wall[swap], game.wall[index]];
  }
  for (const player of game.players) {
    player.hand = game.wall.splice(0, 13);
    player.melds = [];
    player.river = [];
    player.flowers = 0;
  }
  game.claims = {};
  game.discard = null;
  game.result = null;
  game.lastDiscard = null;
  recordEvent(game, { type: 'start', seat: game.dealer });
  draw(game, game.dealer, now);
}

function draw(game, seat, now, afterKong = false) {
  const tile = afterKong ? game.wall.pop() : game.wall.shift();
  if (tile === undefined) return finish(game, [], null, now);
  game.turn = seat;
  game.drawn = tile;
  game.afterKong = afterKong;
  game.players[seat].hand.push(tile);
  enter(game, 'turn', now, TURN_MS);
}

function payout(game, winner, payers, charge, delta = [0, 0, 0, 0]) {
  for (const seat of payers) {
    const paid = Math.min(charge, game.players[seat].chips);
    game.players[seat].chips -= paid;
    game.players[winner].chips += paid;
    delta[seat] -= paid;
    delta[winner] += paid;
  }
}

function capDiscardCharges(charges, balance) {
  const total = charges.reduce((sum, charge) => sum + charge, 0);
  if (balance >= total) return charges;

  const shares = charges.map(charge => balance * charge);
  const payments = shares.map(share => Math.floor(share / total));
  const remaining = balance - payments.reduce((sum, paid) => sum + paid, 0);
  const order = shares.map((share, index) => ({ index, remainder: share % total }));
  order.sort((a, b) => b.remainder - a.remainder);
  for (const { index } of order.slice(0, remaining)) payments[index]++;
  return payments;
}

function finish(game, winners, source, now) {
  const wins = winners.map(seat => {
    const { hand, flowers } = game.players[seat];
    const red = count(hand, RED);
    const kongDraw = source === null && game.afterKong ? 1 : 0;
    const winningHand = source === null ? [...hand] : [...hand, game.discard.tile];
    return { seat, red, flowers, kongDraw, fan: red + flowers + kongDraw, winningHand: winningHand.sort((a, b) => a - b) };
  });
  const charges = wins.map(win => STAKE * (2 ** win.fan));
  const payments = source === null ? charges : capDiscardCharges(charges, game.players[source].chips);
  const delta = [0, 0, 0, 0];
  for (const [index, { seat }] of wins.entries()) {
    const payers = source === null ? seats.filter(other => other !== seat) : [source];
    payout(game, seat, payers, payments[index], delta);
  }

  const first = wins[0];
  game.result = {
    winner: first?.seat ?? null, source, wins, delta,
    red: first?.red ?? 0, flowers: first?.flowers ?? 0, kongDraw: first?.kongDraw ?? 0, fan: first?.fan ?? 0,
    winningHand: first?.winningHand ?? [],
    roundDelta: game.players.map((p, seat) => p.chips - game.roundStart[seat]),
    tableEnded: game.players.some(p => p.chips === 0),
  };
  if (first) recordEvent(game, { type: 'hu', seat: first.seat, seats: winners });
  game.discard = null;
  game.claims = {};
  enter(game, 'result', now);
}

function removeTiles(hand, tile, amount) {
  for (let i = 0; i < amount; i++) hand.splice(hand.indexOf(tile), 1);
}

export function claimActions(game, seat) {
  if (game.phase !== 'claim' || game.discard.seat === seat || game.discard.tile === RED) return [];
  const { tile } = game.discard;
  const { hand, melds } = game.players[seat];
  const options = [];
  if (!hand.includes(RED) && winningHand([...hand, tile], melds.length, false)) options.push('hu');
  const matching = count(hand, tile);
  if (matching === 3 && game.wall.length > 0) options.push('exposedKong');
  if (matching >= 2) options.push('pung');
  return options;
}

function turnActions(game, seat) {
  const { hand, melds } = game.players[seat];
  const actions = { discard: true, hu: game.drawn !== null && winningHand(hand, melds.length), kongs: [] };
  if (game.drawn === null || game.wall.length === 0) return actions;
  for (const tile of [...new Set(hand)].sort((a, b) => a - b)) {
    if (tile === RED) continue;
    if (count(hand, tile) === 4) actions.kongs.push({ tile, type: 'concealedKong' });
    else if (melds.some(meld => meld.type === 'pung' && meld.tile === tile)) actions.kongs.push({ tile, type: 'addedKong' });
  }
  return actions;
}

function resolveClaim(game, now) {
  const { seat: source, tile } = game.discard;
  const ordered = [1, 2, 3].map(offset => nextSeat(source, offset));
  const winners = ordered.filter(seat => game.claims[seat] === 'hu');
  if (winners.length) return finish(game, winners, source, now);
  const kongSeat = ordered.find(seat => game.claims[seat] === 'exposedKong');
  const receiver = kongSeat ?? ordered.find(seat => game.claims[seat] === 'pung');
  game.claims = {};
  game.discard = null;
  if (receiver === undefined) return draw(game, nextSeat(source), now);
  const player = game.players[receiver];
  const kong = kongSeat !== undefined;
  game.players[source].river.pop();
  game.lastDiscard = null;
  removeTiles(player.hand, tile, kong ? 3 : 2);
  player.melds.push({ tile, type: kong ? 'exposedKong' : 'pung', source });
  recordEvent(game, { type: kong ? 'exposedKong' : 'pung', seat: receiver, tile });
  if (kong) {
    player.flowers++;
    return draw(game, receiver, now, true);
  }
  game.turn = receiver;
  game.drawn = null;
  game.afterKong = false;
  enter(game, 'turn', now, TURN_MS);
}

export function applyAction(game, seat, action, now = Date.now()) {
  if (game.phase === 'claim') {
    const choices = claimActions(game, seat);
    if (!choices.length || Object.hasOwn(game.claims, seat) || (action.type !== 'pass' && !choices.includes(action.type))) {
      throw new Error('当前不能进行这个操作。');
    }
    game.claims[seat] = action.type;
    if (seats.every(other => !claimActions(game, other).length || Object.hasOwn(game.claims, other))) resolveClaim(game, now);
    return;
  }
  if (game.phase !== 'turn' || game.turn !== seat) throw new Error('现在还没轮到你。');
  const player = game.players[seat];
  const actions = turnActions(game, seat);
  if (action.type === 'hu' && actions.hu) return finish(game, [seat], null, now);

  const tile = action.tile;
  if (action.type === 'kong') {
    const kong = actions.kongs.find(option => option.tile === tile);
    if (!kong) throw new Error('这张牌当前不能杠。');
    if (kong.type === 'concealedKong') {
      removeTiles(player.hand, tile, 4);
      player.melds.push({ tile, type: kong.type });
      payout(game, seat, seats.filter(other => other !== seat), STAKE);
    } else {
      removeTiles(player.hand, tile, 1);
      player.melds.find(meld => meld.tile === tile && meld.type === 'pung').type = kong.type;
      player.flowers++;
    }
    recordEvent(game, { type: kong.type, seat, tile });
    game.lastDiscard = null;
    return draw(game, seat, now, true);
  }
  if (action.type !== 'discard' || !player.hand.includes(tile)) throw new Error('这张牌当前不能打出。');
  removeTiles(player.hand, tile, 1);
  player.river.push(tile);
  game.lastDiscard = { seat, index: player.river.length - 1 };
  recordEvent(game, { type: 'discard', seat, tile, automatic: Boolean(action.automatic) });
  game.discard = { seat, tile };
  game.claims = {};
  enter(game, 'claim', now, CLAIM_MS);
  if (!seats.some(other => claimActions(game, other).length)) resolveClaim(game, now);
}

export function expireTurn(game, now = Date.now()) {
  if (!game.deadline || now < game.deadline) return false;
  if (game.phase === 'claim') resolveClaim(game, now);
  else if (game.phase === 'turn') {
    const hand = game.players[game.turn].hand;
    const fallback = hand.findLast(tile => tile !== RED) ?? hand.at(-1);
    applyAction(game, game.turn, { type: 'discard', tile: game.drawn === RED ? fallback : (game.drawn ?? fallback), automatic: true }, now);
  }
  return true;
}

function botDiscard(hand) {
  const counts = Array(RED).fill(0);
  for (const tile of hand) if (tile !== RED) counts[tile]++;
  let discard = RED;
  let lowest = Infinity;
  for (let tile = 0; tile < RED; tile++) {
    if (!counts[tile]) continue;
    const rank = tile % 9;
    let support = (counts[tile] - 1) * 5;
    for (const offset of [-2, -1, 1, 2]) {
      if (rank + offset < 0 || rank + offset > 8) continue;
      if (counts[tile + offset]) support += Math.abs(offset) === 1 ? 2 : 1;
    }
    if (support < lowest) { lowest = support; discard = tile; }
  }
  return discard;
}

export function playBots(game, now = Date.now()) {
  if (!game.deadline || now - game.phaseStarted < 750) return false;
  if (game.phase === 'turn' && game.players[game.turn].isBot) {
    const seat = game.turn;
    const actions = turnActions(game, seat);
    if (actions.hu) applyAction(game, seat, { type: 'hu' }, now);
    else if (actions.kongs.length) applyAction(game, seat, { type: 'kong', tile: actions.kongs[0].tile }, now);
    else applyAction(game, seat, { type: 'discard', tile: botDiscard(game.players[seat].hand) }, now);
    return true;
  }
  if (game.phase !== 'claim') return false;
  let changed = false;
  for (const seat of seats) {
    if (game.phase !== 'claim') break;
    if (!game.players[seat].isBot || Object.hasOwn(game.claims, seat)) continue;
    const [type] = claimActions(game, seat);
    if (type) { applyAction(game, seat, { type }, now); changed = true; }
  }
  return changed;
}

function listeningInfo(game, seat, handBeforeDraw, drawn, ownTurn) {
  const info = { current: [], afterDiscard: {} };
  if (game.phase !== 'turn' && game.phase !== 'claim') return info;

  const own = game.players[seat];
  const seen = Array(RED + 1).fill(0);
  for (const tile of own.hand) seen[tile]++;
  for (const [index, player] of game.players.entries()) {
    for (const tile of player.river) seen[tile]++;
    for (const meld of player.melds) {
      if (meld.type === 'concealedKong' && index !== seat) continue;
      seen[meld.tile] += meld.type === 'pung' ? 3 : 4;
    }
  }

  function waits(tiles) {
    if (tiles.length !== 13 - 3 * own.melds.length) return [];
    const result = [];
    for (let tile = 0; tile <= RED; tile++) {
      if (winningHand([...tiles, tile], own.melds.length)) result.push({ tile, remaining: Math.max(0, 4 - seen[tile]) });
    }
    return result;
  }

  info.current = waits(handBeforeDraw);
  if (ownTurn) {
    for (const tile of new Set(own.hand)) {
      if (tile === drawn) {
        info.afterDiscard[tile] = info.current;
      } else {
        const afterDiscard = [...own.hand];
        removeTiles(afterDiscard, tile, 1);
        info.afterDiscard[tile] = waits(afterDiscard);
      }
    }
  }
  return info;
}

export function viewGame(game, seat) {
  const own = game.players[seat];
  const ownTurn = game.phase === 'turn' && game.turn === seat;
  const canClaim = game.phase === 'claim' && !Object.hasOwn(game.claims, seat);
  const claims = canClaim ? claimActions(game, seat) : [];
  const visibleClaims = claims.includes('exposedKong') ? claims.filter(type => type !== 'pung') : claims;
  const drawn = ownTurn ? game.drawn : null;
  const hand = [...own.hand];
  if (drawn !== null) removeTiles(hand, drawn, 1);
  hand.sort((a, b) => a - b);

  return {
    seat, phase: game.phase, phaseId: game.phaseId, handNumber: game.handNumber,
    dealer: game.dealer, turn: game.turn, deadline: game.deadline, left: game.wall.length,
    nextDealer: game.result && !game.result.tableEnded ? nextDealer(game) : null,
    hand, drawn, lastDiscard: game.lastDiscard, discard: game.discard, result: game.result,
    listening: listeningInfo(game, seat, hand, drawn, ownTurn),
    actions: ownTurn ? turnActions(game, seat) : { claims: visibleClaims },
    event: game.event?.type === 'concealedKong' && game.event.seat !== seat ? { ...game.event, tile: null } : game.event,
    players: game.players.map((p, index) => p && ({
      name: p.name, isBot: Boolean(p.isBot), chips: p.chips, handCount: p.hand.length, flowers: p.flowers, river: p.river,
      melds: p.melds.map(meld => ({ ...meld, tile: meld.type === 'concealedKong' && index !== seat ? null : meld.tile })),
    })),
  };
}
