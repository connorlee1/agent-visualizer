import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { once } from 'node:events';
import { acquireBackend, isVisualizerHealth, probeBackend } from '../src/backend.mjs';

const health = { ok: true, tmuxRunning: true, version: '0.1.0', instanceId: 'd22cecd3-967c-4b70-b2d7-ec55a0d5da11' };
const url = 'http://127.0.0.1:5175';
function fakeChild() {
  const child = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills++; child.emit('exit', 0); };
  return child;
}

test('health requires the complete existing backend signature', () => {
  assert.equal(isVisualizerHealth(health), true);
  assert.equal(isVisualizerHealth({ ...health, tmuxRunning: false }), true);
  for (const value of [null, {}, { ok: true }, { ...health, instanceId: 'other-service' }, { ...health, tmuxRunning: null }]) {
    assert.equal(isVisualizerHealth(value), false);
  }
});

test('reuse never starts or stops an existing backend', async () => {
  const backend = await acquireBackend({ url, probe: async () => health, spawn: () => assert.fail('must not spawn') });
  assert.equal(backend.owned, false);
  await backend.close();
  await backend.close();
});

test('unrecognized occupied port fails without starting any process', async () => {
  await assert.rejects(acquireBackend({
    url, probe: async () => { throw new Error('unrecognized service'); }, spawn: () => assert.fail('must not spawn'),
  }), /unrecognized service/);
});

test('owned backend waits for readiness and shuts down exactly once', async () => {
  const child = fakeChild();
  let probes = 0;
  let unexpected = 0;
  const backend = await acquireBackend({
    url, probe: async () => ++probes >= 3 ? health : null, spawn: () => child, intervalMs: 1,
    onUnexpectedExit: () => unexpected++,
  });
  assert.equal(probes, 3);
  assert.equal(backend.owned, true);
  assert.equal(child.kills, 0);
  await backend.close();
  await backend.close();
  assert.equal(child.kills, 1);
  assert.equal(unexpected, 0);
});

test('readiness failure stops only the process this invocation created', async () => {
  const child = fakeChild();
  let probes = 0;
  await assert.rejects(acquireBackend({
    url, probe: async () => { if (++probes > 1) throw new Error('invalid health'); return null; }, spawn: () => child,
  }), /invalid health/);
  assert.equal(child.kills, 1);
});

test('startup timeout shuts down owned backend', async () => {
  const child = fakeChild();
  await assert.rejects(acquireBackend({ url, probe: async () => null, spawn: () => child, timeoutMs: 5, intervalMs: 1 }), /did not become ready/);
  assert.equal(child.kills, 1);
});

test('early process exit cannot adopt another process responding on the port', async () => {
  const child = fakeChild();
  let probes = 0;
  await assert.rejects(acquireBackend({
    url, spawn: () => child,
    probe: async () => { if (++probes === 1) return null; child.emit('exit', 1); return health; },
  }), /exited before it was ready/);
  assert.equal(child.kills, 0);
});

test('unexpected exit is reported and the exited process is never killed again', async () => {
  const child = fakeChild();
  let probes = 0;
  const exits = [];
  const backend = await acquireBackend({ url, spawn: () => child, probe: async () => ++probes > 1 ? health : null, onUnexpectedExit: (code) => exits.push(code) });
  child.emit('exit', 9);
  assert.deepEqual(exits, [9]);
  await backend.close();
  assert.equal(child.kills, 0);
});

async function fakeServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP probe recognizes a real health response', async (t) => {
  const fake = await fakeServer(t, (req, res) => {
    assert.equal(req.url, '/api/health');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(health));
  });
  assert.deepEqual(await probeBackend(fake.url), health);
});

test('HTTP probe rejects an unrelated service on the port', async (t) => {
  const fake = await fakeServer(t, (_req, res) => res.end('<html>another app</html>'));
  await assert.rejects(probeBackend(fake.url), /unrecognized service/);
});

test('HTTP probe treats only a refused connection as absence', async (t) => {
  const fake = await fakeServer(t, (_req, res) => res.end(''));
  await new Promise((resolve) => fake.server.close(resolve));
  assert.equal(await probeBackend(fake.url), null);
});

test('HTTP probe has an absolute deadline even when a service keeps sending bytes', async (t) => {
  const fake = await fakeServer(t, (_req, res) => {
    res.write('{');
    const interval = setInterval(() => res.write(' '), 5);
    res.on('close', () => clearInterval(interval));
  });
  await assert.rejects(probeBackend(fake.url, 50), /did not respond in time/);
});
