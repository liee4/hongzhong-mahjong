import test from 'node:test';
import assert from 'node:assert/strict';
import { findTunnelUrl, localAddresses } from '../host.mjs';

test('临时隧道只提取官方站点链接，局域网入口排除本机回环', () => {
  assert.equal(findTunnelUrl('INF https://bright-friend.trycloudflare.com   |'), 'https://bright-friend.trycloudflare.com');
  assert.equal(findTunnelUrl('https://bright-friend.trycloudflare.com.evil.example'), null);
  assert.equal(findTunnelUrl('https://example.com'), null);
  assert.deepEqual(localAddresses({
    Tailscale: [{ family: 'IPv4', address: '100.64.1.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.0.2', internal: false }],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Ethernet: [{ family: 'IPv4', address: '169.254.2.2', internal: false }],
  }), [{ name: 'Wi-Fi', address: '192.168.0.2' }, { name: 'Tailscale', address: '100.64.1.1' }]);
});
