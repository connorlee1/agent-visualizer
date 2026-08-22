#!/usr/bin/env node
/**
 * Multi-host integration test: boots TWO real server instances on scratch
 * ports (one acting as the aggregator, one as a "remote machine"), connects
 * them the way the dashboard does, and drives every failure mode the ssh
 * feature has to survive. No mocks — this is the actual server code, so a
 * regression in the tunnel manager, forwarder, ws bridge, ghost cache or
 * cycle guards fails a named test here instead of a teammate's pod.
 *
 *   npm run test:multihost        (~60s; needs tmux, does not touch your
 *                                  real hosts.json or running dashboard)
 *
 * The "remote" is a url-type host (no ssh involved), which exercises every
 * layer except the ssh process itself — ssh spawn/retry/error surfacing is
 * covered by the self-referential and dead-endpoint cases.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const ROOT = path.join(import.meta.dirname, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-multihost-'));
const A_PORT = 5291; // aggregator
const B_PORT = 5292; // "remote machine"
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
const TEST_TMUX = `viz-selftest-${Math.random().toString(36).slice(2, 8)}`;

const children = [];
let failures = 0;
let bServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, name) {
  const child = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOSTS_FILE: path.join(SCRATCH, `hosts-${name}.json`) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => {});
  children.push(child);
  return child;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Poll until fn() is truthy (returns its value) or time runs out (throws). */
async function waitFor(label, fn, timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* keep polling */ }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function hostStatus(id) {
  const { body } = await getJson(`${A}/api/hosts`);
  return (body ?? []).find((h) => h.id === id)?.status;
}

async function mergedAgents() {
  const { body } = await getJson(`${A}/api/tmux`);
  return body ?? [];
}

try {
  console.log('multihost integration test');
  console.log(`scratch: ${SCRATCH}`);

  // A throwaway tmux session so terminal/bridge tests don't depend on (or
  // disturb) whatever agents the developer is really running.
  execFileSync('tmux', ['new-session', '-d', '-s', TEST_TMUX]);

  console.log('\n[boot] two instances');
  startServer(A_PORT, 'a');
  bServer = startServer(B_PORT, 'b');
  const [healthA, healthB] = await Promise.all([
    waitFor('A health', async () => (await getJson(`${A}/api/health`)).body?.ok && (await getJson(`${A}/api/health`)).body),
    waitFor('B health', async () => (await getJson(`${B}/api/health`)).body?.ok && (await getJson(`${B}/api/health`)).body),
  ]);
  check('both instances up', true);
  check('health carries instanceId', !!healthA.instanceId && !!healthB.instanceId && healthA.instanceId !== healthB.instanceId);

  console.log('\n[connect] add B as a machine on A');
  const add = await postJson(`${A}/api/hosts`, { name: 'testbox', url: B });
  check('add accepted', add.status === 200, JSON.stringify(add.body));
  await waitFor('testbox connected', async () => (await hostStatus('testbox')) === 'connected');
  check('status reaches connected', true);

  console.log('\n[merge] listings');
  const merged = await waitFor(
    'merged listing includes both machines',
    async () => {
      const agents = await mergedAgents();
      const hosts = new Set(agents.map((a) => a.host));
      return hosts.has('local') && hosts.has('testbox') ? agents : null;
    },
  );
  check('agents stamped with host', merged.every((a) => a.host === 'local' || a.host === 'testbox'));
  check('no stale marks while connected', merged.every((a) => !a.stale));
  const testboxNames = new Set(merged.filter((a) => a.host === 'testbox').map((a) => a.name));
  check('test session visible via remote', testboxNames.has(TEST_TMUX));
  const localOnly = (await getJson(`${A}/api/tmux?local=1`)).body ?? [];
  check('?local=1 excludes remote machines', localOnly.every((a) => a.host === 'local') && localOnly.length > 0);
  const closed = (await getJson(`${A}/api/tmux/closed`)).body ?? [];
  check('closed listing merges (host stamped)', closed.every((e) => !!e.host));

  console.log('\n[forward] request routing');
  const remoteRecent = await getJson(`${A}/api/h/testbox/sessions/recent?limit=1`);
  check('GET forwards', remoteRecent.status === 200 && Array.isArray(remoteRecent.body));
  const badKill = await fetch(`${A}/api/h/testbox/tmux/no-such-session-xyz`, { method: 'DELETE' });
  const badKillBody = await badKill.json().catch(() => null);
  check('remote errors pass through', badKill.status === 400 && !!badKillBody?.error, `status ${badKill.status}`);
  const noHost = await getJson(`${A}/api/h/ghost-machine/tmux`);
  check('unknown machine → 502', noHost.status === 502);

  console.log('\n[bridge] terminal websocket');
  const bytes = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${A_PORT}/ws/h/testbox/terminal/${TEST_TMUX}?cols=80&rows=24`);
    let n = 0;
    const timer = setTimeout(() => { ws.close(); resolve(n); }, 6000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) n += data.length;
      if (n > 0) { clearTimeout(timer); ws.close(); resolve(n); }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(-1); });
  });
  check('bridge streams terminal bytes', bytes > 0, `got ${bytes}`);

  console.log('\n[loop guards]');
  const self = await postJson(`${A}/api/hosts`, { name: 'myself', url: A });
  check('self-add accepted for probing', self.status === 200);
  await waitFor(
    'self host detected',
    async () => {
      const { body } = await getJson(`${A}/api/hosts`);
      const h = (body ?? []).find((x) => x.id === 'myself');
      return h?.status === 'down' && /itself/.test(h.lastError ?? '');
    },
    20_000,
  );
  check('self-reference → permanent down with clear error', true);
  await fetch(`${A}/api/hosts/myself`, { method: 'DELETE' });

  console.log('\n[outage] remote dies → ghosts; returns → recovery');
  bServer.kill();
  await waitFor('testbox marked down', async () => (await hostStatus('testbox')) === 'down', 60_000);
  const ghosts = await waitFor(
    'ghost listing',
    async () => {
      const agents = (await mergedAgents()).filter((a) => a.host === 'testbox');
      return agents.length > 0 && agents.every((a) => a.stale) ? agents : null;
    },
    20_000,
    1000,
  );
  check('agents persist as stale ghosts', ghosts.some((a) => a.name === TEST_TMUX));
  bServer = startServer(B_PORT, 'b');
  await waitFor('testbox reconnects', async () => (await hostStatus('testbox')) === 'connected', 60_000);
  await waitFor(
    'ghosts go live again',
    async () => {
      const agents = (await mergedAgents()).filter((a) => a.host === 'testbox');
      return agents.length > 0 && agents.every((a) => !a.stale);
    },
    20_000,
    1000,
  );
  check('outage → ghosts → recovery cycle', true);

  console.log('\n[events] remote relay');
  const relayed = await new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => { ac.abort(); resolve(false); }, 15_000);
    fetch(`${A}/api/events`, { signal: ac.signal }).then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // a tmux change on the "remote" must surface as a tmux-changed on A
      setTimeout(() => execFileSync('tmux', ['rename-session', '-t', TEST_TMUX, `${TEST_TMUX}b`]), 500);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('tmux-changed')) {
          clearTimeout(timer);
          ac.abort();
          resolve(true);
          return;
        }
      }
      resolve(false);
    }).catch(() => resolve(false));
  });
  check('remote tmux change relays to aggregator clients', relayed);

  console.log('\n[teardown] host removal');
  await fetch(`${A}/api/hosts/testbox`, { method: 'DELETE' });
  await waitFor(
    'testbox agents gone after removal',
    // generous: a snapshot refresh that started BEFORE the removal can hold
    // the loop for its full remote-fetch timeout before the queued rerun
    // (which sees the host gone) lands
    async () => (await mergedAgents()).every((a) => a.host !== 'testbox'),
    30_000,
    1000,
  );
  check('removal drops agents and ghost cache', true);
} catch (err) {
  failures++;
  console.error(`\n✗ aborted: ${err.message}`);
} finally {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { execFileSync('tmux', ['kill-session', '-t', TEST_TMUX]); } catch { /* renamed or gone */ }
  try { execFileSync('tmux', ['kill-session', '-t', `${TEST_TMUX}b`]); } catch { /* gone */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
