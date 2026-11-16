export function makeRack() {
  return { tiles: [], round: null, drawPhase: null, drawKey: null, nextKey: 0 };
}

export function sortTiles(tiles, drawKey = null) {
  const sorted = [...tiles].sort((a, b) => a.tile - b.tile);
  const drawn = sorted.findIndex(entry => entry.key === drawKey);
  if (drawn >= 0) sorted.push(...sorted.splice(drawn, 1));
  return sorted;
}

export function moveTile(tiles, key, destination) {
  const index = tiles.findIndex(tile => tile.key === key);
  if (index < 0 || destination < 0 || destination >= tiles.length || index === destination) return tiles;
  const reordered = [...tiles];
  const [tile] = reordered.splice(index, 1);
  reordered.splice(destination, 0, tile);
  return reordered;
}

export function syncRack(rack, view, autoSort, discardKey = null) {
  const newRound = rack.round !== view.handNumber;
  const newDraw = view.drawn !== null && (newRound || view.phaseId !== rack.drawPhase);
  const incoming = view.drawn === null || newDraw ? view.hand : [...view.hand, view.drawn];
  const count = Array(28).fill(0);
  for (const tile of incoming) count[tile]++;
  const previous = newRound ? [] : rack.tiles;
  const discard = previous.find(entry => entry.key === discardKey);
  const removeDiscard = discard && previous.filter(entry => entry.tile === discard.tile).length > count[discard.tile];
  const next = [];
  for (const entry of previous) {
    if ((removeDiscard && entry === discard) || count[entry.tile] <= 0) continue;
    count[entry.tile]--;
    next.push(entry);
  }
  let nextKey = rack.nextKey;
  for (const tile of incoming) {
    if (count[tile] <= 0) continue;
    count[tile]--;
    next.push({ tile, key: `t${nextKey++}` });
  }
  let drawKey = view.drawn === null ? null : rack.drawKey;
  if (newDraw) {
    drawKey = `t${nextKey++}`;
    next.push({ tile: view.drawn, key: drawKey });
  }
  const drawFinished = rack.drawKey !== null && drawKey === null;
  return {
    tiles: autoSort && (newDraw || newRound || drawFinished) ? sortTiles(next, drawKey) : next,
    round: view.handNumber, drawPhase: view.drawn === null ? null : view.phaseId, drawKey, nextKey,
  };
}
