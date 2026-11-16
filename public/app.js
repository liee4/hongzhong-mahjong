import { makeRack, moveTile, sortTiles, syncRack } from './rack-order.mjs';
import { tileHtml, tileLabel } from './tile-faces.mjs';
import { createTableAudio } from './table-audio.mjs';

const $ = (id) => document.getElementById(id);
const rackNode = $('rack');
const storageKey = 'hongzhong.seats.v1';
const positionNames = ['东', '南', '西', '北'];
const seatColors = ['#dbb77b', '#9dc4ac', '#a6bdde', '#daa4a1'];
const eventLabel = { concealedKong: '暗杠', addedKong: '补杠', exposedKong: '明杠', pung: '碰' };
const callDisplay = { pung: ['碰', '碰', 'pung'], hu: ['胡', '胡', 'hu'], selfHu: ['胡', '自摸胡', 'hu'] };
let session = null;
let current = null;
let lastRender = '';
let clockOffset = 0;
let selected = null;
let pending = false;
let pollTimer;
let toastTimer;
let resultShown = null;
let autoSort = prefs().autoSort !== false;
let rack = makeRack();
let lastRack = '';
let discardKey = null;
let drag = null;
let ignoreRackClickUntil = 0;
let hoveredTile = null;
let touchPreviewTile = null;
let listeningOpen = false;
const tableAudio = createTableAudio(prefs().audio);

function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function prefs() {
  try { return JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { return {}; }
}

function storePrefs(update) {
  try { localStorage.setItem(storageKey, JSON.stringify(update)); } catch { /* In a private tab, the seat lasts until the page closes. */ }
}

function remember(code, token, name) {
  const data = prefs();
  const tokens = data.tokens ?? {};
  delete tokens[code];
  tokens[code] = token;
  storePrefs({ ...data, name, last: code, tokens: Object.fromEntries(Object.entries(tokens).slice(-12)) });
}

function forget(code) {
  const data = prefs();
  if (data.tokens) delete data.tokens[code];
  if (data.last === code) delete data.last;
  storePrefs(data);
}

async function request(endpoint, payload) {
  const response = await fetch(`/api/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(6500),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '操作未完成，请重试。'), { status: response.status });
  return data;
}

function setRoomUrl(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

function inviteUrl() {
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const base = local ? (current?.inviteOrigin ?? location.origin) : location.origin;
  const url = new URL('/', base);
  url.searchParams.set('room', session.code);
  return url.href;
}

async function copy(value, label) {
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    if (!copied) { prompt(`请复制${label}`, value); return; }
  }
  toast(`已复制${label}`);
}

function toast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}

function connection(state) {
  $('connection').dataset.state = state;
  $('connection-label').textContent = { idle: '好友联机', live: '已连接', retry: '正在重连' }[state];
}

function entryError(message) {
  $('entry-error').textContent = message;
  $('entry-error').hidden = !message;
}

function renderEntry() {
  $('entry').hidden = false;
  $('entry-art').hidden = false;
  $('table').hidden = true;
  $('copy-code').hidden = true;
  $('exit-button').hidden = true;
  $('auto-sort').hidden = true;
  const { last, tokens } = prefs();
  $('resume-button').hidden = !(last && tokens?.[last]);
  $('status').textContent = '创建房间，或输入好友的房间码';
  connection('idle');
}

function relative(view, index) { return (index - view.seat + 4) % 4; }

function renderSeats(view) {
  const active = view.phase === 'turn' || view.phase === 'claim';
  const cards = view.players.map((player, index) => {
    const rel = relative(view, index);
    const wind = positionNames[(index - view.dealer + 4) % 4];
    const name = player?.name ?? '空位';
    const initials = player?.isBot ? '机' : player ? [...name][0] : wind;
    const status = player && (!player.connected ? '离线' : view.seat === index ? '你' : '');
    const dealer = player && view.handNumber > 0 && view.dealer === index;
    return `<div class="seat seat-${rel}" data-empty="${!player}" data-active="${active && view.turn === index}" style="--seat-color:${seatColors[index]}">
      <span class="avatar" aria-hidden="true">${escape(initials)}</span><div class="seat-meta"><div class="seat-name"><b title="${escape(name)}">${escape(name)}</b>${dealer ? '<small class="dealer-mark" aria-label="庄家">庄</small>' : ''}${status ? `<small>${status}</small>` : ''}</div>
      <div class="seat-money">${player ? `<span class="coin" aria-hidden="true"></span><b aria-label="${player.chips} 枚筹码">${player.chips}</b>${player.flowers ? `<span class="from-kong">花 ${player.flowers}</span>` : ''}` : '等候入座'}</div></div></div>`;
  });
  for (const [index, player] of view.players.entries()) {
    if (!player) continue;
    const rel = relative(view, index);
    if (rel !== 0 && player.handCount) cards.push(`<div class="concealed concealed-${rel}" aria-label="${escape(player.name)}手牌 ${player.handCount} 张">${tileHtml(null).repeat(player.handCount)}</div>`);
    if (player.melds.length) {
      const melds = player.melds.map(meld => `<span class="meld">${tileHtml(meld.tile).repeat(meld.type === 'pung' ? 3 : 4)}</span>`).join('');
      cards.push(`<div class="melds melds-${rel}">${melds}</div>`);
    }
  }
  $('seats').innerHTML = cards.join('');
}

function renderRivers(view) {
  $('rivers').innerHTML = view.players.map((p, index) => {
    if (!p?.river.length) return '';
    const offset = Math.max(0, Math.floor((p.river.length - 1) / 6) * 6 - 12);
    const tiles = p.river.slice(offset).map((tile, i) => tileHtml(tile, { extra: view.lastDiscard?.seat === index && view.lastDiscard.index === offset + i ? 'last' : '' })).join('');
    return `<div class="river river-${relative(view, index)}" aria-label="${escape(p.name)}的弃牌">${tiles}</div>`;
  }).join('');
}

function renderRack() {
  rackNode.dataset.canDiscard = String(Boolean(current.actions.discard));
  const signature = `${rack.tiles.map(entry => entry.key).join(',')}:${rack.drawKey}:${selected?.key}:${autoSort}`;
  if (lastRack === signature) return;
  lastRack = signature;
  const focus = rackNode.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  rackNode.innerHTML = rack.tiles.map(({ tile, key }, index) => {
    const drawn = key === rack.drawKey;
    return tileHtml(tile, { interactive: true, key, chosen: selected?.key === key, drawn,
      extra: drawn && index === rack.tiles.length - 1 ? 'fresh' : '' });
  }).join('');
  if (drag && !rack.tiles.some(entry => entry.key === drag.key)) cancelDrag();
  if (focus) rackNode.querySelector(`[data-key="${focus}"]`)?.focus({ preventScroll: true });
}

function highlightTableTiles() {
  for (const tile of document.querySelectorAll('#rivers .tile[data-tile], #seats .melds .tile[data-tile]')) {
    tile.classList.toggle('same-tile', Number(tile.dataset.tile) === hoveredTile);
  }
}

function setHoveredTile(tile) {
  if (hoveredTile === tile) return;
  hoveredTile = tile;
  highlightTableTiles();
  renderListeningPreview();
}

function renderListeningCards(element, title, waits) {
  element.hidden = !waits?.length;
  if (element.hidden) return;
  const options = waits.map(({ tile, remaining }) => `<div class="listening-option${remaining === 0 ? ' exhausted' : ''}" role="img" aria-label="${tileLabel(tile)}，剩 ${remaining} 张" title="${tileLabel(tile)}，剩 ${remaining} 张"><span aria-hidden="true">${tileHtml(tile)}<b>${remaining} 张</b></span></div>`).join('');
  const markup = `<div class="listening-label"><strong>${title}</strong><small>按已知牌计算</small></div><div class="listening-options">${options}</div>`;
  if (element.innerHTML !== markup) element.innerHTML = markup;
}

function renderListeningPreview() {
  const focused = rackNode.querySelector('button[data-tile]:focus-visible');
  const choice = hoveredTile ?? (focused ? Number(focused.dataset.tile) : touchPreviewTile);
  const waits = choice !== null && current?.actions.discard && !drag?.moving ? current.listening?.afterDiscard[choice] : null;
  renderListeningCards($('listening'), waits?.length ? `打出${tileLabel(choice)}后听` : '', waits);
}

function renderListeningStatus() {
  const waits = current?.listening?.current;
  const hasWaits = Boolean(waits?.length);
  $('listening-rail').hidden = !hasWaits;
  if (!hasWaits) listeningOpen = false;
  $('listen-toggle').setAttribute('aria-expanded', String(listeningOpen));
  renderListeningCards($('listen-detail'), '当前听牌', listeningOpen ? waits : null);
}

function callButton(action, type, tile = null, showTile = false) {
  const [glyph, name, tone] = callDisplay[type] ?? ['杠', eventLabel[type], 'kong'];
  const tileName = tile === null ? '' : tileLabel(tile);
  const label = tileName ? `${name} ${tileName}` : name;
  const detail = showTile ? `<span class="call-detail" aria-hidden="true">${tileName}</span>` : '';
  return `<button class="secondary call-button call-${tone}" data-action="${action}"${tile === null ? '' : ` data-value="${tile}"`} type="button" aria-label="${label}" title="${label}"${pending ? ' disabled' : ''}><span class="call-glyph" aria-hidden="true">${glyph}</span>${detail}</button>`;
}

function renderActions() {
  const view = current;
  const actions = [];
  if (view.phase === 'result') actions.push('<button class="primary" data-action="result" type="button">查看结算</button>');
  else if (view.actions.claims?.length) {
    actions.push('<span class="action-hint">可接牌 <b data-clock></b></span>');
    for (const type of view.actions.claims) actions.push(callButton(type, type));
    actions.push(`<button class="secondary" data-action="pass" type="button"${pending ? ' disabled' : ''}>过</button>`);
  } else if (view.actions.discard) {
    actions.push('<span class="action-hint turn-hint"><strong>你的回合</strong><b data-clock></b></span>');
    for (const option of view.actions.kongs) {
      actions.push(callButton('kong', option.type, option.tile, view.actions.kongs.length > 1));
    }
    if (view.actions.hu) actions.push(callButton('hu', 'selfHu'));
    actions.push(`<button class="${view.actions.hu ? 'secondary' : 'primary'}" data-action="discard" type="button"${!selected || pending ? ' disabled' : ''}>${selected ? `打出 ${tileLabel(selected.tile)}` : '打出'}</button>`);
  }
  $('action-zone').innerHTML = actions.join('');
  renderListeningPreview();
  renderListeningStatus();
  updateClock();
}

function statusLine(view) {
  if (view.phase === 'lobby') return `已入座 ${view.players.filter(Boolean).length} / 4`;
  if (view.phase === 'result') return '本局已结算';
  if (view.actions.claims?.length) return `${view.players[view.discard.seat].name} 打出 ${tileLabel(view.discard.tile)}，请选择操作`;
  if (view.phase === 'claim') return '等待其他牌友回应';
  if (view.actions.discard) return '点击手牌选中后打出';
  const event = view.event;
  if (event?.type === 'discard') return `${view.players[event.seat].name}${event.automatic ? '（超时）' : ''}打出 ${tileLabel(event.tile)}`;
  if (eventLabel[event?.type]) return `${view.players[event.seat].name}${eventLabel[event.type]}${event.tile === null ? '' : ` ${tileLabel(event.tile)}`}`;
  return `轮到 ${view.players[view.turn].name}`;
}

function renderLobby() {
  const view = current;
  const waiting = $('waiting');
  waiting.hidden = view.phase !== 'lobby';
  if (waiting.hidden) return;
  const seated = view.players.filter(Boolean).length;
  const bots = view.players.map((player, index) => player?.isBot ? index : null).filter(index => index !== null);
  const remove = view.isHost && bots.length ? `<div class="bot-list" aria-label="已入座的人机">${bots.map(index => `<button class="quiet" data-bot="remove" data-index="${index}" type="button" aria-label="移除${view.players[index].name}"${pending ? ' disabled' : ''}>人机 ${index + 1}<span aria-hidden="true"> ×</span></button>`).join('')}</div>` : '';
  const add = view.isHost && seated < 4 ? `<button class="secondary" type="button" data-bot="add"${pending ? ' disabled' : ''}>添加人机</button>${seated < 3 ? `<button class="secondary" type="button" data-bot="fill"${pending ? ' disabled' : ''}>人机补满</button>` : ''}` : '';
  const start = view.isHost && seated === 4 ? `<button class="primary" type="button" data-action="start"${pending || view.players.some(p => !p.connected) ? ' disabled' : ''}>开始对局</button>` : '';
  waiting.innerHTML = `<h2>${seated < 4 ? '等待牌友入座' : '座位已齐'}</h2><strong class="invite-code">${view.code}</strong><p>${seated} / 4 个座位${bots.length ? ` · ${bots.length} 位人机` : ''}</p>${remove}<div class="lobby-actions"><button class="${start ? 'quiet' : 'primary'}" type="button" data-invite>复制邀请链接</button>${add}${start}</div>`;
}

function renderTable(view) {
  $('entry').hidden = true;
  $('entry-art').hidden = true;
  $('table').hidden = false;
  $('copy-code').hidden = false;
  $('exit-button').hidden = false;
  $('auto-sort').hidden = view.phase === 'lobby';
  $('auto-sort').setAttribute('aria-pressed', String(autoSort));
  $('code-label').textContent = view.code;
  renderSeats(view);
  renderRivers(view);
  highlightTableTiles();
  const isLobby = view.phase === 'lobby';
  const isTurn = view.phase === 'turn';
  const counter = $('table-display');
  counter.hidden = isLobby;
  counter.classList.toggle('own-turn', isTurn && view.seat === view.turn);
  const footer = isTurn ? (view.turn === view.seat ? '' : view.players[view.turn].name + '的回合') : view.phase === 'claim' ? '等待回应' : '结算';
  counter.innerHTML = isLobby ? '' : `<div><span class="counter-top">第 ${view.handNumber} 局 · 余牌</span><div class="counter-main"><b>${view.left}</b><span>张</span></div>${footer ? `<div class="counter-foot">${escape(footer)}</div>` : ''}</div>`;
  renderLobby();
  $('status').textContent = statusLine(view);
  renderRack();
  renderActions();
  showResult();
}

function showResult(force = false) {
  const view = current;
  const dialog = $('result-dialog');
  if (view.phase !== 'result') { if (dialog.open) dialog.close(); return; }
  const { result } = view;
  const canShow = !$('rules-dialog').open && !$('exit-dialog').open && !$('sound-dialog').open;
  const willOpen = canShow && !dialog.open && (force || resultShown !== view.phaseId);
  if (!willOpen && !dialog.open) return;
  const wins = result.wins ?? (result.winner === null ? [] : [{ ...result, seat: result.winner }]);
  const first = wins[0];
  const method = result.source === null ? (result.kongDraw ? '杠开自摸' : '自摸') : '接炮';
  let outcome = '流局';
  if (wins.length > 1) outcome = wins.length === 2 ? '一炮双响' : '一炮三响';
  else if (first) outcome = `${view.players[first.seat].name} ${method}`;
  const breakdown = wins.map(({ seat, red, flowers, kongDraw, fan, winningHand }) => {
    const name = escape(view.players[seat].name);
    const factors = [red && `红中 ${red} 番`, flowers && `花 ${flowers} 番`, kongDraw && '杠开 1 番'].filter(Boolean);
    const payout = [`${fan} 番`, ...factors, `胡牌收取 ${result.delta[seat]} 枚`].join(' · ');
    return `<section><p>${wins.length > 1 ? `${name} 接炮` : '胡牌手牌'}</p><div class="result-detail">${payout}</div>
      <div class="result-tiles">${winningHand.map(tile => tileHtml(tile)).join('')}</div></section>`;
  }).join('');
  const rows = view.players.map((p, seat) => {
    const diff = result.roundDelta[seat];
    return `<li><span>${escape(p.name)}${seat === view.seat ? '（你）' : ''}</span><span class="${diff > 0 ? 'gain' : diff < 0 ? 'loss' : ''}">${diff > 0 ? '+' : ''}${diff}</span><span>${p.chips} 枚</span></li>`;
  }).join('');
  const offline = view.players.some(p => !p.connected);
  const banker = view.nextDealer === null ? '' : `<p>下局庄家：${escape(view.players[view.nextDealer].name)}${view.nextDealer === view.dealer ? '（连庄）' : ''}</p>`;
  dialog.innerHTML = `<div class="modal-head"><h2 id="result-title">${escape(outcome)}</h2><button class="quiet close" type="button" data-close aria-label="关闭">×</button></div>
    ${first ? breakdown : '<div class="result-detail">流局结算不转移筹码，局内已经结付的暗杠照常计入。</div>'}
    <ul class="result-list" aria-label="本局变化和剩余筹码">${rows}</ul>
    ${banker}
    ${result.tableEnded ? '<p>有牌友筹码归零，本桌已结束。</p>' : offline ? '<p>等待四位牌友重新在线。</p>' : ''}
    <div class="dialog-actions"><button type="button" class="quiet" data-close>返回牌桌</button>${!result.tableEnded ? `<button class="primary" data-action="next" type="button"${offline || pending ? ' disabled' : ''}>开始下一局</button>` : ''}</div>`;
  if (willOpen) { resultShown = view.phaseId; dialog.showModal(); }
}

function receive(view) {
  if (current && (view.revision < current.revision || (view.revision === current.revision && view.serverTime < current.serverTime))) return;
  if (!current || current.phaseId !== view.phaseId) {
    selected = null;
    touchPreviewTile = null;
    if (view.drawn !== null || view.phase === 'result' || view.handNumber !== current?.handNumber) cancelDrag();
  }
  if (view.handNumber !== current?.handNumber) listeningOpen = false;
  if (!current || current.revision !== view.revision) rack = syncRack(rack, view, autoSort, discardKey);
  tableAudio.receive(view, current);
  current = view;
  clockOffset = view.serverTime - Date.now();
  const key = `${view.revision}:${view.players.map(p => p?.connected ? 1 : 0).join('')}`;
  if (key !== lastRender) { lastRender = key; renderTable(view); }
}

function updateClock() {
  if (!current?.deadline) return;
  const clock = document.querySelector('[data-clock]');
  if (clock) clock.textContent = `${Math.max(0, Math.ceil((current.deadline - Date.now() - clockOffset) / 1000))} 秒`;
}

function clearSession(message = '') {
  clearTimeout(pollTimer);
  session = null;
  tableAudio.setInRoom(false);
  current = null;
  selected = null;
  rack = makeRack();
  lastRack = '';
  discardKey = null;
  touchPreviewTile = null;
  setHoveredTile(null);
  renderListeningPreview();
  renderListeningStatus();
  cancelDrag();
  lastRender = '';
  resultShown = null;
  pending = false;
  if ($('result-dialog').open) $('result-dialog').close();
  setRoomUrl(null);
  renderEntry();
  if (message) entryError(message);
}

async function poll(active) {
  if (active !== session) return;
  let delay = 560;
  try {
    const view = await request('state', active);
    if (active !== session) return;
    receive(view);
    connection('live');
  } catch (error) {
    if (active !== session) return;
    if ([401, 404].includes(error.status)) {
      forget(active.code);
      clearSession(error.message);
      return;
    }
    connection('retry');
    delay = 1250;
  }
  pollTimer = setTimeout(() => poll(active), delay);
}

function connect(code, token, view, name) {
  clearTimeout(pollTimer);
  session = { code, token };
  tableAudio.setInRoom(true);
  pending = false;
  resultShown = null;
  remember(code, token, name || view.players[view.seat].name);
  setRoomUrl(code);
  $('code').value = code;
  lastRender = '';
  current = null;
  rack = makeRack();
  lastRack = '';
  connection('live');
  receive(view);
  const active = session;
  pollTimer = setTimeout(() => poll(active), 300);
}

async function reconnect(code) {
  const token = prefs().tokens?.[code];
  if (!token) return false;
  const active = { code, token };
  try {
    const view = await request('state', active);
    connect(code, token, view);
    return true;
  } catch (error) {
    if ([401, 404].includes(error.status)) { forget(code); renderEntry(); return false; }
    throw error;
  }
}

function errorMessage(error) { return error.status ? error.message : '暂时连不上房间服务，请重试。'; }

async function gameAction(type, tile) {
  if (type === 'result') { showResult(true); return; }
  if (pending || !session || !current) return;
  if (type === 'discard' && tile === undefined) return;
  const active = session;
  pending = true;
  tableAudio.playAction(type);
  if (type === 'discard') discardKey = selected?.key ?? null;
  renderActions();
  if (type === 'start') renderLobby();
  if (type === 'next') showResult();
  try {
    const view = await request('action', { ...active, phaseId: current.phaseId, type, tile });
    if (active === session) { selected = null; receive(view); connection('live'); }
  } catch (error) {
    if (active === session) toast(errorMessage(error));
  } finally {
    if (active === session) { pending = false; discardKey = null; renderRack(); renderActions(); renderLobby(); showResult(); }
  }
}

async function configureBots(type, seat) {
  if (pending || !current?.isHost || !session) return;
  const active = session;
  pending = true;
  renderLobby();
  try {
    const view = await request('bots', { ...active, type, seat });
    if (active === session) receive(view);
  } catch (error) {
    if (active === session) toast(errorMessage(error));
  } finally {
    if (active === session) { pending = false; renderLobby(); }
  }
}

$('entry-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending) return;
  const intent = event.submitter?.value ?? ($('code').value ? 'join' : 'create');
  const name = $('name').value.trim();
  const code = $('code').value.trim().toUpperCase();
  entryError('');
  if (!name) { entryError('请输入昵称。'); $('name').focus(); return; }
  if (intent === 'join' && !/^[2-9A-HJ-NP-Z]{6}$/.test(code)) { entryError('请输入有效的 6 位房间码。'); $('code').focus(); return; }
  pending = true;
  $('create-room').disabled = $('join-room').disabled = $('resume-button').disabled = true;
  try {
    if (intent === 'join' && await reconnect(code)) return;
    const data = await request(intent, { name, code });
    connect(data.code, data.token, data.view, name);
  } catch (error) { entryError(errorMessage(error)); }
  finally {
    pending = false;
    $('create-room').disabled = $('join-room').disabled = $('resume-button').disabled = false;
  }
});

$('resume-button').addEventListener('click', async () => {
  if (pending) return;
  pending = true;
  try { if (!await reconnect(prefs().last)) entryError('上次的房间已关闭。'); }
  catch (error) { entryError(errorMessage(error)); }
  finally { pending = false; }
});

$('code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    $('entry-form').requestSubmit($('join-room'));
  }
});

rackNode.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tile]');
  if (!button || !current?.actions.discard || pending || performance.now() < ignoreRackClickUntil) return;
  const tile = Number(button.dataset.tile);
  touchPreviewTile = event.pointerType === 'touch' || event.pointerType === 'pen' ? tile : null;
  selected = { key: button.dataset.key, tile };
  renderRack();
  renderActions();
});

rackNode.addEventListener('pointerover', (event) => {
  if (event.pointerType !== 'mouse' || drag?.moving) return;
  const tile = event.target.closest('button[data-tile]');
  if (tile) {
    touchPreviewTile = null;
    setHoveredTile(Number(tile.dataset.tile));
  }
});
rackNode.addEventListener('pointerout', (event) => {
  if (event.pointerType !== 'mouse') return;
  const next = event.relatedTarget?.closest?.('button[data-tile]');
  if (!next || !rackNode.contains(next)) setHoveredTile(null);
});
rackNode.addEventListener('focusin', () => queueMicrotask(renderListeningPreview));
rackNode.addEventListener('focusout', () => queueMicrotask(renderListeningPreview));

$('listen-toggle').addEventListener('click', () => {
  listeningOpen = !listeningOpen;
  renderListeningStatus();
});
$('listening-rail').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !listeningOpen) return;
  listeningOpen = false;
  renderListeningStatus();
  $('listen-toggle').focus();
});

function cancelDrag() {
  if (!drag) return;
  const { pointerId } = drag;
  drag = null;
  if (rackNode.hasPointerCapture(pointerId)) rackNode.releasePointerCapture(pointerId);
  rackNode.classList.remove('is-dragging');
  for (const button of rackNode.querySelectorAll('.drag-source, .drop-target')) button.classList.remove('drag-source', 'drop-target');
}

rackNode.addEventListener('pointerdown', (event) => {
  const button = event.target.closest('button[data-key]');
  if (!button || !event.isPrimary || event.button !== 0 || current?.phase === 'result' || pending) return;
  cancelDrag();
  drag = { key: button.dataset.key, pointerId: event.pointerId, x: event.clientX, moving: false, target: -1 };
});

rackNode.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!drag.moving && Math.abs(event.clientX - drag.x) < 6) return;
  if (!drag.moving) {
    drag.moving = true;
    touchPreviewTile = null;
    setHoveredTile(null);
    renderListeningPreview();
    rackNode.setPointerCapture(event.pointerId);
    rackNode.classList.add('is-dragging');
  }
  const buttons = [...rackNode.querySelectorAll('button[data-key]')];
  let distance = Infinity;
  buttons.forEach((button, index) => {
    const box = button.getBoundingClientRect();
    const delta = Math.abs(event.clientX - (box.left + box.width / 2));
    if (delta < distance) { distance = delta; drag.target = index; }
  });
  buttons.forEach((button, index) => {
    button.classList.toggle('drag-source', button.dataset.key === drag.key);
    button.classList.toggle('drop-target', index === drag.target && button.dataset.key !== drag.key);
  });
});

rackNode.addEventListener('pointerup', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const { key, moving, target } = drag;
  cancelDrag();
  if (!moving) return;
  ignoreRackClickUntil = performance.now() + 250;
  const area = rackNode.getBoundingClientRect();
  if (event.clientY < area.top - 36 || event.clientY > area.bottom + 36) return;
  rack.tiles = moveTile(rack.tiles, key, target);
  renderRack();
});
rackNode.addEventListener('pointercancel', cancelDrag);
rackNode.addEventListener('lostpointercapture', (event) => {
  if (event.target === rackNode && drag?.pointerId === event.pointerId) cancelDrag();
});
rackNode.addEventListener('keydown', (event) => {
  const key = event.target.dataset.key;
  if (!key || !event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || current?.phase === 'result') return;
  event.preventDefault();
  const from = rack.tiles.findIndex(tile => tile.key === key);
  rack.tiles = moveTile(rack.tiles, key, from + (event.key === 'ArrowLeft' ? -1 : 1));
  renderRack();
});

$('auto-sort').addEventListener('click', () => {
  autoSort = !autoSort;
  storePrefs({ ...prefs(), autoSort });
  if (autoSort) rack.tiles = sortTiles(rack.tiles, rack.drawKey);
  $('auto-sort').setAttribute('aria-pressed', String(autoSort));
  renderRack();
  toast(autoSort ? '自动理牌已开启' : '自动理牌已关闭');
});

document.addEventListener('click', () => tableAudio.unlock(), { capture: true });
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-close')) button.closest('dialog')?.close();
  if (button.hasAttribute('data-invite') && session) copy(inviteUrl(), '邀请链接');
  if (button.dataset.soundPreview) tableAudio.playAction(button.dataset.soundPreview);
  if (button.dataset.bot) configureBots(button.dataset.bot, Number(button.dataset.index));
  const type = button.dataset.action;
  if (type) gameAction(type, type === 'discard' ? selected?.tile : button.hasAttribute('data-value') ? Number(button.dataset.value) : undefined);
});
$('copy-code').addEventListener('click', () => { if (session) copy(session.code, '房间码'); });
$('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
$('rules-dialog').addEventListener('close', () => { if (current) showResult(); });
function updateMusicVolume(volume) {
  $('music-volume').value = volume;
  $('music-volume-value').value = `${volume}%`;
  $('music-volume').setAttribute('aria-valuetext', `${volume}%`);
}

function saveSoundPreference(change) {
  tableAudio.configure(change);
  storePrefs({ ...prefs(), audio: tableAudio.preferences() });
}

$('sound-button').addEventListener('click', () => {
  const preferences = tableAudio.preferences();
  for (const input of $('sound-dialog').querySelectorAll('[data-sound-setting]')) input.checked = preferences[input.dataset.soundSetting];
  updateMusicVolume(preferences.musicVolume);
  $('sound-dialog').showModal();
});
$('sound-dialog').addEventListener('change', (event) => {
  const setting = event.target.dataset.soundSetting;
  if (!setting) return;
  saveSoundPreference({ [setting]: event.target.checked });
});
$('music-volume').addEventListener('input', (event) => {
  saveSoundPreference({ musicVolume: Number(event.target.value) });
  updateMusicVolume(tableAudio.preferences().musicVolume);
});
$('sound-dialog').addEventListener('close', () => { if (current) showResult(); });
$('exit-dialog').addEventListener('close', () => { if (current) showResult(); });
$('exit-button').addEventListener('click', () => {
  $('exit-text').textContent = current.phase === 'lobby' ? '离桌后，这个座位会空出来。' : '牌局会继续。你仍可从此浏览器回到原座位。';
  $('exit-dialog').showModal();
});
$('confirm-exit').addEventListener('click', async () => {
  const active = session;
  if (!active) return;
  $('confirm-exit').disabled = true;
  try {
    await request('leave', active);
    if (current?.phase === 'lobby') forget(active.code);
    clearSession();
    $('exit-dialog').close();
  } catch (error) { $('exit-text').textContent = errorMessage(error); }
  finally { $('confirm-exit').disabled = false; }
});

setInterval(updateClock, 200);
$('entry-art').innerHTML = `<div class="sample-rail north">${tileHtml(null).repeat(12)}</div><div class="sample-rail west">${tileHtml(null).repeat(10)}</div><div class="sample-fan">${[18, 24, 25].map(tile => tileHtml(tile)).join('')}</div>`;
const initialCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
const saved = prefs();
$('name').value = saved.name ?? '';
renderEntry();
if (initialCode && /^[2-9A-HJ-NP-Z]{6}$/.test(initialCode)) {
  $('code').value = initialCode;
  if (saved.tokens?.[initialCode]) {
    pending = true;
    reconnect(initialCode).catch(error => entryError(errorMessage(error))).finally(() => { pending = false; });
  }
}
