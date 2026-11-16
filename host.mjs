import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';

const entryPath = fileURLToPath(import.meta.url);
const root = dirname(entryPath);

export function findTunnelUrl(output) {
  return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[^a-z0-9.\-\/@])/i)?.[0] ?? null;
}

export function localAddresses(interfaces = networkInterfaces()) {
  const addresses = new Map();
  for (const [name, details] of Object.entries(interfaces)) {
    for (const detail of details ?? []) {
      if (detail.family === 'IPv4' && !detail.internal && !detail.address.startsWith('169.254.')) {
        addresses.set(detail.address, { name, address: detail.address });
      }
    }
  }
  return [...addresses.values()].sort((a, b) => {
    const rank = name => /^(wi[ -]?fi|wlan|无线|以太网|ethernet|eth\d+)/i.test(name) ? 0 : 1;
    return rank(a.name) - rank(b.name);
  });
}

function tunnelExecutable() {
  const local = join(root, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return process.env.HONGZHONG_CLOUDFLARED || (existsSync(local) ? local : 'cloudflared');
}

async function launch(mode) {
  if (!['--lan', '--online'].includes(mode)) throw new Error('用法：node host.mjs --lan 或 node host.mjs --online');
  const online = mode === '--online';
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是 0 到 65535 之间的整数。');
  const host = online ? '127.0.0.1' : '0.0.0.0';
  const addresses = online ? [] : localAddresses();
  let shareOrigin = online ? null : process.env.HONGZHONG_INVITE_ORIGIN;
  const directory = process.env.HONGZHONG_DATA_DIR || join(root, online ? 'data-online' : 'data-lan');
  const server = createServer({ directory, inviteOrigin: () => shareOrigin });
  const listening = once(server, 'listening');
  server.listen(port, host);
  await listening;

  const actualPort = server.address().port;
  const localUrl = `http://127.0.0.1:${actualPort}`;
  let tunnel;
  let stopping = false;
  const close = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    if (tunnel && tunnel.exitCode === null && !tunnel.killed) tunnel.kill();
    server.close();
    server.closeAllConnections();
  };
  process.on('SIGINT', () => close());
  process.on('SIGTERM', () => close());

  console.log(`房主本机入口：${localUrl}`);
  if (!online) {
    for (const { address, name } of addresses) console.log(`同网牌友入口（${name}）：http://${address}:${actualPort}`);
    if (!shareOrigin && addresses.length === 1) shareOrigin = `http://${addresses[0].address}:${actualPort}`;
    if (addresses.length > 1) console.log('房主和牌友可从同一个网络对应的地址打开网页。');
    if (!addresses.length) console.log('未发现可用的网络地址，请先连接 Wi-Fi 或网线。');
    return;
  }

  console.log('正在申请临时 HTTPS 链接，请保留此窗口。');
  tunnel = spawn(tunnelExecutable(), ['tunnel', '--no-autoupdate', '--url', localUrl], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  function capture(stream, destination) {
    let recent = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      destination.write(chunk);
      if (shareOrigin) return;
      recent = (recent + chunk).slice(-4096);
      const url = findTunnelUrl(recent);
      if (url) {
        shareOrigin = url;
        console.log(`\n异地牌友入口：${shareOrigin}\n创建房间后复制邀请链接发给牌友。`);
      }
    });
  }
  capture(tunnel.stdout, process.stdout);
  capture(tunnel.stderr, process.stderr);
  tunnel.on('error', error => {
    if (error.code === 'ENOENT') {
      console.error('找不到 cloudflared。请将官网下载的 cloudflared.exe 放到游戏目录，或把 cloudflared 加到 PATH。');
      console.error('下载说明：https://developers.cloudflare.com/tunnel/downloads/');
    } else console.error(`临时隧道无法启动：${error.message}`);
    close(1);
  });
  tunnel.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`临时隧道已结束（${code ?? signal}）。`);
    close(code ?? 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(entryPath)) {
  await launch(process.argv[2]).catch(error => {
    console.error(error.code === 'EADDRINUSE' ? '端口已被占用。请关闭旧的游戏进程，或通过 PORT 选择其他端口。' : error.message);
    process.exitCode = 1;
  });
}
