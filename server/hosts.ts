import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { HOSTS_FILE } from './config';
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
  child?: ChildProcess;
  sseAbort?: AbortController;
  retries: number;
  removed: boolean;
}

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
  rt.child = undefined;
}

async function healthOk(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Bring the tunnel up (or verify a direct url) and wait until the remote answers. */
async function establish(rt: HostRuntime): Promise<void> {
  const { entry } = rt;
  if (entry.url) {
    rt.baseUrl = entry.url.replace(/\/$/, '');
    for (let i = 0; i < 5 && !rt.removed; i++) {
      if (await healthOk(rt.baseUrl)) return;
      await sleep(1000);
    }
    throw new Error('remote server not answering');
  }

  const port = await freePort();
  rt.baseUrl = `http://127.0.0.1:${port}`;
  const args = [
    '-N',
    // BatchMode: fail fast instead of hanging on a password prompt this
    // headless process could never answer
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    '-L', `${port}:127.0.0.1:${entry.remotePort ?? DEFAULT_REMOTE_PORT}`,
    ...userSshArgs(entry.ssh!),
  ];
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  rt.child = child;
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

  // The tunnel opening isn't enough — wait for the remote *server* to answer.
  for (let i = 0; i < 30 && !rt.removed; i++) {
    if (exited) throw new Error(await exitInfo);
    if (await healthOk(rt.baseUrl)) return;
    await sleep(1000);
  }
  killChild(rt);
  throw new Error(exited ? await exitInfo : 'tunnel up but remote server not answering (is it running on the machine?)');
}

/**
 * Relay the remote server's SSE stream. Doubles as the liveness probe: the
 * remote heartbeats every 25s, so a dead tunnel surfaces here within ~35s
 * and the host loop reconnects. Resolves/throws when the stream ends.
 */
async function watchEvents(rt: HostRuntime): Promise<void> {
  const abort = new AbortController();
  rt.sseAbort = abort;
  const res = await fetch(`${rt.baseUrl}/api/events`, { signal: abort.signal });
  if (!res.ok || !res.body) throw new Error(`events stream failed (${res.status})`);
  let event = '';
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
      if (!rt.removed) setStatus(rt, 'down', err instanceof Error ? err.message : String(err));
    }
    killChild(rt);
    rt.sseAbort?.abort();
    rt.sseAbort = undefined;
    if (rt.removed) break;
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
  // a server restart must never leave zombie ssh tunnels behind
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      for (const rt of runtimes.values()) killChild(rt);
      process.exit(0);
    });
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
