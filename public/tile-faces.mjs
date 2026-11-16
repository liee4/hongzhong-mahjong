const numbers = '一二三四五六七八九';
const red = 27;
const columns = 7;
const rows = 4;

export function tileLabel(tile) {
  if (tile === null) return '牌背';
  if (tile === red) return '红中';
  return `${numbers[tile % 9]}${['万', '筒', '条'][Math.floor(tile / 9)]}`;
}

export function tileHtml(tile, { extra = '', interactive = false, key = '', chosen = false, drawn = false } = {}) {
  const back = tile === null;
  const css = `tile ${back ? 'back' : 'reference-face'}${extra ? ` ${extra}` : ''}${chosen ? ' selected' : ''}${drawn ? ' drawn' : ''}`;
  const label = tileLabel(tile);
  const x = (tile % columns) * 100 / (columns - 1);
  const y = Math.floor(tile / columns) * 100 / (rows - 1);
  const face = back ? '' : `<span class="tile-face" aria-hidden="true" style="--face-x:${x}%;--face-y:${y}%"></span>`;
  if (interactive) return `<button type="button" class="${css}" data-tile="${tile}" data-key="${key}" aria-label="${label}${drawn ? '，新摸' : ''}" aria-pressed="${chosen}" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight">${face}</button>`;
  return `<span class="${css}" role="img" aria-label="${label}"${back ? '' : ` data-tile="${tile}"`}>${face}</span>`;
}
