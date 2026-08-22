import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { HOSTS_FILE, INSTANCE_ID } from './config';
import type { AddHostRequest, HostInfo, HostStatus } from '../shared/types';

/**
 * Remote machines: each runs its own visualizer server next to its agents
 * (that's what keeps file watching, lsof linkage, hook callbacks and sqlite
 * reads working — none of them survive being done over ssh call-by-call).
 * This module's whole job is reachability: keep one `ssh -N -L` tunnel per
 * machine alive so the remote server answers on a local port, and relay its
 * SSE events so the UI refreshes for remote changes as fast as local ones.
 */

const DEFAULT_REMOTE_PORT = 5175;

interface HostEntry {
  id: string;
  name: string;
  ssh?: string;
  url?: string;
  remotePort?: number;
}

interface HostRuntime {
  entry: HostEntry;
  status: HostStatus;
  lastError?: string;
  baseUrl?: string;
  /**
   * Separate tunnel for interactive terminal traffic. Keystrokes sharing one
   * ssh TCP stream with the 2s poll queue behind its preview bursts (measured:
   * ~170ms flat echo on a quiet tunnel vs 250-310ms median on the shared one).
   */
  termUrl?: string;
  child?: ChildProcess;
  termChild?: ChildProcess;
  sseAbort?: AbortController;
  retries: number;
  removed: boolean;
  /** Misconfiguration that retrying can never fix (e.g. host is this server itself). */
  permanent?: boolean;
}

/** An error reconnecting will never fix — the host loop stops instead of retrying. */
class PermanentHostError extends Error {}

/**
 * Emits:
 *  - 'changed' when any host's status flips (UI refresh)
 *  - 'remote-event' (hostId, event, dataJson) for relayed SSE events
 */
export const hostEvents = new EventEmitter();

const runtimes = new Map<string, HostRuntime>();

// ---- registry ------------------------------------------------------------

function loadEntries(): HostEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((e) => e?.id && e?.name) : [];
  } catch {
    return []; // first run or corrupt file
  }
}

let saving: Promise<unknown> = Promise.resolve();
function saveEntries(): void {
  const data = JSON.stringify([...runtimes.values()].map((r) => r.entry), null, 2);
  saving = saving.then(async () => {
    await fsp.mkdir(path.dirname(HOSTS_FILE), { recursive: true });
    await fsp.writeFile(HOSTS_FILE, data);
  }).catch((err) => console.error('hosts save failed:', err));
}

const RESERVED_IDS = new Set(['local', 'closed']);

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
  let id = base;
  for (let n = 2; RESERVED_IDS.has(id) || runtimes.has(id); n++) id = `${base}-${n}`;
  return id;
}

// ---- ssh command parsing -------------------------------------------------

/** Quote-aware tokenizer for the pasted ssh command. */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** User args for spawn: the pasted command minus a leading "ssh". */
function userSshArgs(ssh: string): string[] {
  const tokens = tokenize(ssh.trim());
  if (tokens[0] === 'ssh') tokens.shift();
  if (!tokens.length) throw new Error('empty ssh command');
  return tokens;
}

export function validateHostRequest(body: AddHostRequest): string | null {
  if (!body?.name?.trim()) return 'name required';
  if (!body.ssh?.trim() && !body.url?.trim()) return 'ssh command (or url) required';
  if (body.ssh) {
    try {
      userSshArgs(body.ssh);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (body.url && !/^https?:\/\//.test(body.url)) return 'url must start with http:// or https://';
  if (body.remotePort != null && !(Number.isInteger(body.remotePort) && body.remotePort > 0 && body.remotePort < 65536)) {
    return 'invalid remote port';
  }
  return null;
}

// ---- tunnel lifecycle ----------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function killChild(rt: HostRuntime): void {
  try { rt.child?.kill(); } catch { /* already gone */ }
  try { rt.termChild?.kill(); } catch { /* already gone */ }
  rt.child = undefined;
  rt.termChild = undefined;
}

interface Tunnel {
  child: ChildProcess;
  hasExited: () => boolean;
  exitInfo: Promise<string>;
}

function spawnTunnel(entry: HostEntry, localPort: number): Tunnel {
  const args = [
    '-N',
    // BatchMode: fail fast instead of hanging on a password prompt this
    // headless process could never answer
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    // ~10s dead-peer detection: while ssh still thinks the tunnel is up,
    // requests are forwarded into it and hang — keep that window short
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ConnectTimeout=10',
    '-L', `${localPort}:127.0.0.1:${entry.remotePort ?? DEFAULT_REMOTE_PORT}`,
    ...userSshArgs(entry.ssh!),
  ];
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  let exited = false;
  const exitInfo = new Promise<string>((resolve) => {
    child.on('exit', (code) => {
      exited = true;
      resolve(stderr.trim().split('\n').pop() || `ssh exited (${code})`);
    });
    child.on('error', (err) => {
      exited = true;
      resolve(err.message);
    });
  });
  return { child, hasExited: () => exited, exitInfo };
}

async function healthOk(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { instanceId?: string } | null;
    // answering with OUR instance id means the "remote" is this very server —
    // merging it into itself would double every agent and stall each poll
    if (body?.instanceId === INSTANCE_ID) {
      throw new PermanentHostError('this address points back at this dashboard itself');
    }
    return true;
  } catch (err) {
    if (err instanceof PermanentHostError) throw err;
    return false;
  }
}

/** Bring the tunnels up (or verify a direct url) and wait until the remote answers. */
async function establish(rt: HostRuntime): Promise<void> {
  const { entry } = rt;
  if (entry.url) {
    rt.baseUrl = entry.url.replace(/\/$/, '');
    rt.termUrl = rt.baseUrl;
    for (let i = 0; i < 5 && !rt.removed; i++) {
      if (await healthOk(rt.baseUrl)) return;
      await sleep(1000);
    }
    throw new Error('remote server not answering');
  }

  const portA = await freePort();
  const portB = await freePort();
  let a = { port: portA, tunnel: spawnTunnel(entry, portA) };
  let b = { port: portB, tunnel: spawnTunnel(entry, portB) };
  rt.child = a.tunnel.child;
  rt.termChild = b.tunnel.child;
  rt.baseUrl = `http://127.0.0.1:${a.port}`;
  rt.termUrl = `http://127.0.0.1:${b.port}`;

  // The tunnel opening isn't enough — wait for the remote *server* to answer.
  let up = false;
  for (let i = 0; i < 30 && !rt.removed; i++) {
    if (a.tunnel.hasExited()) throw new Error(await a.tunnel.exitInfo);
    if (b.tunnel.hasExited()) throw new Error(await b.tunnel.exitInfo);
    if (await healthOk(rt.baseUrl)) {
      up = true;
      break;
    }
    await sleep(1000);
  }
  if (!up) {
    killChild(rt);
    throw new Error(a.tunnel.hasExited() ? await a.tunnel.exitInfo : 'tunnel up but remote server not answering (is it running on the machine?)');
  }

  // Each ssh connection is its own TCP flow, and flows to the same machine
  // can land on paths differing by 100ms+ (measured 168 vs 308ms to the same
  // OCI host — ECMP flow-hash lottery). Probe both tunnels, re-roll an
  // egregiously slow flow once, and give the FASTEST flow to the terminal —
  // keystroke echo is where latency is actually felt; polling takes the rest.
  let aMs = await probeMs(a.port);
  let bMs = await probeMs(b.port);
  const slowest = () => (aMs > bMs ? a : b);
  if (Math.max(aMs, bMs) > Math.min(aMs, bMs) * 1.5 + 30 && !rt.removed) {
    const loser = slowest();
    const rerollPort = await freePort();
    const reroll = { port: rerollPort, tunnel: spawnTunnel(entry, rerollPort) };
    const deadline = Date.now() + 15_000;
    let rerollMs = Infinity;
    while (Date.now() < deadline && !reroll.tunnel.hasExited()) {
      if (await healthOk(`http://127.0.0.1:${reroll.port}`)) {
        rerollMs = await probeMs(reroll.port);
        break;
      }
      await sleep(500);
    }
    if (rerollMs < (loser === a ? aMs : bMs)) {
      try { loser.tunnel.child.kill(); } catch { /* already gone */ }
      if (loser === a) { a = reroll; aMs = rerollMs; } else { b = reroll; bMs = rerollMs; }
    } else {
      try { reroll.tunnel.child.kill(); } catch { /* already gone */ }
    }
  }
  const [term, api] = aMs <= bMs ? [a, b] : [b, a];
  rt.child = api.tunnel.child;
  rt.termChild = term.tunnel.child;
  rt.baseUrl = `http://127.0.0.1:${api.port}`;
  rt.termUrl = `http://127.0.0.1:${term.port}`;
  console.log(`[${entry.id}] tunnels up · term ${Math.min(aMs, bMs).toFixed(0)}ms · api ${Math.max(aMs, bMs).toFixed(0)}ms`);
  // if the interactive tunnel dies later while the api one lives, tear the
  // host down so the loop rebuilds both — a silently dead terminal path
  // would look like every remote terminal "not connecting"
  term.tunnel.child.on('exit', () => {
    if (!rt.removed && rt.termChild === term.tunnel.child) rt.sseAbort?.abort();
  });
}

/** Median round-trip of a few health pings through a tunnel port. */
async function probeMs(port: number, n = 4): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
      times.push(Date.now() - t);
    } catch {
      times.push(4000);
    }
    await sleep(60);
  }
  times.sort((x, y) => x - y);
  return times[Math.floor(times.length / 2)];
}

/**
 * Relay the remote server's SSE stream. Doubles as the liveness probe: the
 * remote heartbeats every 25s, so a dead tunnel surfaces here within ~35s
 * and the host loop reconnects. Resolves/throws when the stream ends.
 */
async function watchEvents(rt: HostRuntime): Promise<void> {
  const abort = new AbortController();
  rt.sseAbort = abort;
  // Watchdog: the remote heartbeats every 25s, but a half-open socket (NAT
  // drop on url-mode hosts, ssh keepalive not yet fired) delivers nothing
  // and never errors — treat 40s of silence as dead so the loop reconnects.
  let lastData = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastData > 40_000) abort.abort();
  }, 5_000);
  try {
    const res = await fetch(`${rt.baseUrl}/api/events`, { signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`events stream failed (${res.status})`);
    let event = '';
    let buffer = '';
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastData = Date.now();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ') && event) {
          hostEvents.emit('remote-event', rt.entry.id, event, line.slice(6));
          event = '';
        }
      }
    }
  } catch (err) {
    if (abort.signal.aborted && !rt.removed) throw new Error('events stream stalled (no heartbeat)');
    throw err;
  } finally {
    clearInterval(watchdog);
  }
  throw new Error('events stream ended');
}

function setStatus(rt: HostRuntime, status: HostStatus, error?: string): void {
  const changed = rt.status !== status || rt.lastError !== error;
  rt.status = status;
  rt.lastError = error;
  if (changed) hostEvents.emit('changed');
}

/** Per-host supervision loop: connect, relay events, back off, repeat. */
async function runHost(rt: HostRuntime): Promise<void> {
  while (!rt.removed) {
    setStatus(rt, 'connecting', rt.lastError);
    try {
      await establish(rt);
      if (rt.removed) break;
      rt.retries = 0;
      setStatus(rt, 'connected');
      await watchEvents(rt);
    } catch (err) {
      if (err instanceof PermanentHostError) rt.permanent = true;
      if (!rt.removed) setStatus(rt, 'down', err instanceof Error ? err.message : String(err));
    }
    killChild(rt);
    rt.sseAbort?.abort();
    rt.sseAbort = undefined;
    if (rt.removed || rt.permanent) break;
    await sleep(Math.min(1000 * 2 ** rt.retries++, 30_000));
  }
  killChild(rt);
}

function startHost(entry: HostEntry): HostRuntime {
  const rt: HostRuntime = { entry, status: 'connecting', retries: 0, removed: false };
  runtimes.set(entry.id, rt);
  void runHost(rt).catch((err) => console.error(`host loop died (${entry.id}):`, err));
  return rt;
}

// ---- public API ----------------------------------------------------------

export function initHosts(): void {
  for (const entry of loadEntries()) {
    if (!runtimes.has(entry.id)) startHost(entry);
  }
  // A server restart must never leave zombie ssh tunnels behind. This hangs
  // on 'exit' (not the signals): another module's signal handler calling
  // process.exit() first would skip later signal handlers — and did, leaking
  // a tunnel pair per restart — but 'exit' always runs, and child.kill() is
  // synchronous so it's legal here.
  process.on('exit', () => {
    for (const rt of runtimes.values()) killChild(rt);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => process.exit(0));
  }
}

export function getHostsInfo(): HostInfo[] {
  return [...runtimes.values()].map((rt) => ({
    id: rt.entry.id,
    name: rt.entry.name,
    ssh: rt.entry.ssh,
    url: rt.entry.url,
    remotePort: rt.entry.remotePort,
    status: rt.status,
    lastError: rt.status === 'connected' ? undefined : rt.lastError,
  }));
}

export function addHost(body: AddHostRequest): HostInfo | { error: string } {
  const invalid = validateHostRequest(body);
  if (invalid) return { error: invalid };
  const entry: HostEntry = {
    id: slugify(body.name),
    name: body.name.trim().slice(0, 40),
    ssh: body.ssh?.trim() || undefined,
    url: body.url?.trim() || undefined,
    remotePort: body.remotePort || undefined,
  };
  const rt = startHost(entry);
  saveEntries();
  hostEvents.emit('changed');
  return { id: entry.id, name: entry.name, ssh: entry.ssh, url: entry.url, remotePort: entry.remotePort, status: rt.status };
}

export function removeHost(id: string): boolean {
  const rt = runtimes.get(id);
  if (!rt) return false;
  rt.removed = true;
  killChild(rt);
  rt.sseAbort?.abort();
  runtimes.delete(id);
  saveEntries();
  hostEvents.emit('changed');
  return true;
}

/** Machines currently reachable: id -> base URL of their server. */
export function connectedHosts(): Array<{ id: string; baseUrl: string }> {
  return [...runtimes.values()]
    .filter((rt) => rt.status === 'connected' && rt.baseUrl)
    .map((rt) => ({ id: rt.entry.id, baseUrl: rt.baseUrl! }));
}

export function hostBaseUrl(id: string): string | undefined {
  const rt = runtimes.get(id);
  return rt?.status === 'connected' ? rt.baseUrl : undefined;
}

/** Base URL of the machine's dedicated interactive tunnel (terminal bridge). */
export function hostTermUrl(id: string): string | undefined {
  const rt = runtimes.get(id);
  return rt?.status === 'connected' ? (rt.termUrl ?? rt.baseUrl) : undefined;
}
