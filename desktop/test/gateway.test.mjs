import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGateway } from '../src/gateway.mjs';

async function setup(t) {
  const temp = await mkdtemp(path.join(tmpdir(), 'desktop-gateway-'));
  const dist = path.join(temp, 'dist');
  await mkdir(dist);
  await writeFile(path.join(dist, 'index.html'), '<html>desktop</html>');
  await writeFile(path.join(dist, 'app.js'), 'console.log("desktop")');
  await writeFile(path.join(temp, 'private.txt'), 'secret');
  await symlink(path.join(temp, 'private.txt'), path.join(dist, 'escape.txt'));
  const backend = http.createServer(async (req, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ready\n\n');
      return;
    }
    let body = '';
    for await (const part of req) body += part;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, body }));
  });
  const backendSockets = new Set();
  backend.on('connection', socket => { backendSockets.add(socket); socket.once('close', () => backendSockets.delete(socket)); });
  backend.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;
  const gateway = await startGateway({ backendUrl, distDir: dist, port: 0 });
  t.after(async () => {
    await gateway.close();
    const closed = new Promise(resolve => backend.close(resolve));
    for (const socket of backendSockets) socket.destroy();
    await closed;
    await rm(temp, { recursive: true, force: true });
  });
  return { gateway, backendUrl, dist };
}

test('serves UI, SPA fallback, assets, and restrictive CSP', async t => {
  const { gateway } = await setup(t);
  const page = await fetch(gateway.url + '/sessions/example');
  assert.equal(await page.text(), '<html>desktop</html>');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self';/);
  assert.match(page.headers.get('content-security-policy'), /https:\/\/fonts.googleapis.com/);
  assert.match(page.headers.get('content-security-policy'), /https:\/\/fonts.gstatic.com/);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' data: blob:/);
  assert.equal(await (await fetch(gateway.url + '/app.js')).text(), 'console.log("desktop")');
  assert.equal((await fetch(gateway.url + '/missing.js')).status, 404);
  assert.equal((await fetch(gateway.url + '/escape.txt')).status, 403);
  assert.equal((await fetch(gateway.url + '/%2e%2e%2fprivate.txt')).status, 403);
});

test('streams POST bodies and preserves paths and query strings', async t => {
  const { gateway } = await setup(t);
  const response = await fetch(gateway.url + '/api/agents?host=remote', { method: 'POST', body: '{"name":"desktop"}', headers: { Origin: gateway.url, 'Content-Type': 'application/json' } });
  assert.match(response.headers.get('content-security-policy'), /^sandbox;.*script-src 'none'/);
  assert.deepEqual(await response.json(), { method: 'POST', url: '/api/agents?host=remote', body: '{"name":"desktop"}' });
});

test('streams SSE before backend finishes response', async t => {
  const { gateway } = await setup(t);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(gateway.url + '/api/events', { signal: controller.signal });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: ready\n\n');
    await reader.cancel();
  } finally { clearTimeout(timeout); controller.abort(); }
});

test('rejects foreign origins and DNS rebinding Host headers', async t => {
  const { gateway } = await setup(t);
  assert.equal((await fetch(gateway.url + '/api/test', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(gateway.url, { headers: { Origin: 'null' } })).status, 403);
  const response = await new Promise((resolve, reject) => {
    http.get(gateway.url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res); }).on('error', reject);
  });
  assert.equal(response.statusCode, 403);
});

function upgrade(url, origin) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: origin } });
    request.on('upgrade', (response, socket, head) => resolve({ response, socket, head }));
    request.on('response', response => { response.resume(); resolve({ response }); });
    request.on('error', reject);
  });
}

test('passes WebSocket upgrade and bytes in both directions; rejects unknown paths and origins', async t => {
  const { gateway } = await setup(t);
  const { response, socket } = await upgrade(gateway.url + '/ws/terminal/test?cols=80', gateway.url);
  assert.equal(response.statusCode, 101);
  const reply = once(socket, 'data');
  socket.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 105, 107]));
  assert.deepEqual((await reply)[0], Buffer.from([0x81, 0x82, 1, 2, 3, 4, 105, 107]));
  socket.destroy();
  assert.equal((await upgrade(gateway.url + '/ws/unrecognized', gateway.url)).response.statusCode, 404);
  assert.equal((await upgrade(gateway.url + '/ws/terminal/test', 'https://evil.example')).response.statusCode, 403);
});

test('close is idempotent, closes active connections, and leaves backend running', async t => {
  const { gateway, backendUrl } = await setup(t);
  const { socket } = await upgrade(gateway.url + '/ws/terminal/test', gateway.url);
  const closed = once(socket, 'close');
  socket.resume();
  await gateway.close();
  await gateway.close();
  await closed;
  assert.equal((await fetch(backendUrl + '/api/alive')).status, 200);
  await assert.rejects(fetch(gateway.url));
});

test('rejects non-loopback backend configuration', async t => {
  const { dist } = await setup(t);
  await assert.rejects(startGateway({ backendUrl: 'http://example.com:5175', distDir: dist, port: 0 }), /loopback/);
});

test('fails on port conflict without interfering with the existing listener', async t => {
  const { gateway, backendUrl, dist } = await setup(t);
  await assert.rejects(startGateway({ backendUrl, distDir: dist, port: Number(new URL(gateway.url).port) }), { code: 'EADDRINUSE' });
  assert.equal(await (await fetch(gateway.url)).text(), '<html>desktop</html>');
});
