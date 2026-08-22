import os from 'node:os';
import fs from 'node:fs/promises';
import { Router } from 'express';
import { INSTANCE_ID } from './config';
import type { AddHostRequest, ClosedAgent, LaunchAgentRequest, TmuxAgent } from '../shared/types';
import { LOCAL_HOST } from '../shared/types';
import { sseHandler, broadcast, hasClients } from './events';
import { addHost, connectedHosts, getHostsInfo, hostBaseUrl, hostEvents, removeHost } from './hosts';
import { capturePane, createAgent, getSessionOption, isServerRunning, killSession, listAgents, renameAgent, sendKeyToSession, sendTextToSession, TmuxError } from './tmux';
import { findSession, getAllSessions, getProjects, getSessionsForProject, getTranscript, livePathForSession } from './sessions/index';
import { getCodexSessionFiles } from './sessions/codex';
import { resolveLiveSessions, transcriptHeldOpen } from './livesessions';
import { getTurnState } from './sessions/turnstate';
import { getIdleSummary } from './sessions/idlesummary';
import { requestIdleNote } from './sessions/summarizer';
import { dismissClosed, getClosedAgents, getTrackedAgent, noteKilled, noteResumed, trackAgents } from './closedagents';
import { driveCodexModelPicker } from './codexpicker';
import { cycleAgentMode } from './modecycle';
import { forgetAgentName, getAgentName, rememberAgentName } from './agentnames';
import { approvalPending, hookMonitored, noteClaudeHookEvent, noteCodexEvent } from './hooksignals';

export const router = Router();

const asyncRoute = (fn: (req: any, res: any) => Promise<void>) => (req: any, res: any) => {
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
};

router.get('/health', asyncRoute(async (_req, res) => {
  res.json({ ok: true, tmuxRunning: await isServerRunning(), version: '0.1.0', instanceId: INSTANCE_ID });
}));

// ---- remote machines -----------------------------------------------------

/** GET a JSON payload from a connected machine's server; null on any failure. */
async function fetchRemoteJson<T>(baseUrl: string, apiPath: string, timeoutMs = 3000): Promise<T | null> {
  try {
    const res = await fetch(`${baseUrl}/api${apiPath}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

router.get('/hosts', (_req, res) => {
  res.json(getHostsInfo());
});

router.post('/hosts', (req, res) => {
  const result = addHost(req.body as AddHostRequest);
  if ('error' in result) {
    res.status(400).json(result);
    return;
  }
  broadcast('hosts-changed');
  res.json(result);
});

router.delete('/hosts/:id', (req, res) => {
  if (!removeHost(req.params.id)) {
    res.status(404).json({ error: 'no such machine' });
    return;
  }
  remoteListingCache.delete(req.params.id);
  invalidateTmuxListing();
  broadcast('hosts-changed');
  broadcast('tmux-changed');
  res.status(204).end();
});

/**
 * Forwarder: /api/h/<hostId>/<anything> → that machine's /api/<anything>.
 * Everything agent- or session-specific on a remote machine flows through
 * here verbatim (launch, input, kill, rename, transcripts, model picker),
 * so the remote server's own logic — and its own validation — applies.
 */
router.use('/h', (req, res) => {
  const match = /^\/([A-Za-z0-9-]+)(\/.*)$/.exec(req.url);
  if (!match) {
    res.status(400).json({ error: 'bad remote path' });
    return;
  }
  const [, hostId, rest] = match;
  const baseUrl = hostBaseUrl(hostId);
  if (!baseUrl) {
    res.status(502).json({ error: `machine "${hostId}" is not connected` });
    return;
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body != null;
  fetch(`${baseUrl}/api${rest}`, {
    method: req.method,
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(req.body) : undefined,
    // reads fail fast — a half-dead tunnel otherwise freezes every polling
    // chat for the full minute; actions stay generous (codex model-picker
    // drives can take a while)
    signal: AbortSignal.timeout(req.method === 'GET' || req.method === 'HEAD' ? 10_000 : 60_000),
  }).then(async (r) => {
    // a successful forwarded kill must leave the snapshot immediately —
    // see dropFromSnapshot (stale-serve would flash the dead agent back)
    const killed = req.method === 'DELETE' && r.ok && /^\/tmux\/([^/?]+)$/.exec(rest);
    if (killed) {
      dropFromSnapshot(hostId, decodeURIComponent(killed[1]));
      invalidateTmuxListing();
      broadcast('tmux-changed');
    }
    if (r.status === 204) {
      res.status(204).end();
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status);
    res.set('Content-Type', r.headers.get('content-type') ?? 'application/json');
    res.send(buf);
  }).catch((err) => {
    res.status(502).json({ error: `machine "${hostId}": ${err instanceof Error ? err.message : String(err)}` });
  });
});

// Remote SSE relayed by hosts.ts: surface remote changes to our clients at
// the same speed as local ones, and drop the merged listing cache so the
// next poll refetches.
hostEvents.on('remote-event', (hostId: string, event: string, data: string) => {
  if (event === 'tmux-changed') {
    invalidateTmuxListing();
    broadcast('tmux-changed');
  } else if (event === 'session-updated') {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(data);
    } catch { /* old remote without payload */ }
    broadcast('session-updated', { ...payload, host: hostId });
  }
});
hostEvents.on('changed', () => broadcast('hosts-changed'));

router.get('/projects', asyncRoute(async (_req, res) => {
  res.json(await getProjects());
}));

router.get('/sessions', asyncRoute(async (req, res) => {
  const project = String(req.query.project ?? '');
  if (!project) {
    res.status(400).json({ error: 'project query param required' });
    return;
  }
  res.json(await getSessionsForProject(project));
}));

router.get('/sessions/recent', asyncRoute(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json((await getAllSessions()).slice(0, limit));
}));

router.get('/sessions/:provider/:id/transcript', asyncRoute(async (req, res) => {
  const { provider, id } = req.params;
  if (provider !== 'claude' && provider !== 'codex') {
    res.status(400).json({ error: 'unknown provider' });
    return;
  }
  const opts = {
    tail: req.query.tail != null ? Number(req.query.tail) : undefined,
    offset: req.query.offset != null ? Number(req.query.offset) : undefined,
    limit: req.query.limit != null ? Number(req.query.limit) : undefined,
  };
  const transcript = await getTranscript(provider, id, opts);
  if (!transcript) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  res.json(transcript);
}));

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? p.replace('~', os.homedir()) : p);

// Files referenced in transcripts, fetched for viewing in the UI. Text comes
// back as JSON (/file), images as raw bytes (/file/raw) for <img> tags.
// Absolute paths and a size cap; other binaries are refused, not mangled.
async function statViewableFile(path: string, res: any, maxBytes: number): Promise<import('node:fs').Stats | null> {
  if (!path.startsWith('/')) {
    res.status(400).json({ error: 'absolute path required' });
    return null;
  }
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    res.status(404).json({ error: 'file not found' });
    return null;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: 'not a file' });
    return null;
  }
  if (stat.size > maxBytes) {
    res.status(413).json({ error: `file too large to view (${Math.round(stat.size / 1024)} KB)` });
    return null;
  }
  return stat;
}

router.get('/file', asyncRoute(async (req, res) => {
  const path = expandHome(String(req.query.path ?? ''));
  if (!(await statViewableFile(path, res, 2_000_000))) return;
  const buf = await fs.readFile(path);
  if (buf.includes(0)) {
    res.status(415).json({ error: 'binary file — nothing to render' });
    return;
  }
  res.json({ path, content: buf.toString('utf8') });
}));

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
};

router.get('/file/raw', asyncRoute(async (req, res) => {
  const path = expandHome(String(req.query.path ?? ''));
  const type = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
  if (!type) {
    res.status(400).json({ error: 'raw serving is for images only' });
    return;
  }
  if (!(await statViewableFile(path, res, 20_000_000))) return;
  res.set('Content-Type', type);
  res.send(await fs.readFile(path));
}));

/** Conversations currently owned by a running agent: "provider:sessionId" -> agent. */
async function liveConversations(): Promise<Map<string, TmuxAgent>> {
  // the warm snapshot already carries live-resolved session ids — reuse it
  // rather than paying a second listing fan-out per closed-list/launch check
  const agents =
    snapshot && Date.now() - snapshot.at < 5000
      ? snapshot.agents.filter((a) => a.host === LOCAL_HOST)
      : await getLocalListing();
  const map = new Map<string, TmuxAgent>();
  for (const a of agents) {
    if (a.agentRunning && a.provider && a.sessionId) {
      const key = `${a.provider}:${a.sessionId.toLowerCase()}`;
      // duplicates share a key; keep the oldest (listing is createdAt-sorted) —
      // an accidental duplicate is always the newer copy
      if (!map.has(key)) map.set(key, a);
    }
  }
  return map;
}

router.post('/agents', asyncRoute(async (req, res) => {
  const body = req.body as LaunchAgentRequest;
  if (body?.provider !== 'claude' && body?.provider !== 'codex') {
    res.status(400).json({ error: 'provider must be claude or codex' });
    return;
  }

  let cwd: string;
  if (body.resumeSessionId) {
    const session = await findSession(body.provider, body.resumeSessionId);
    if (!session) {
      res.status(404).json({ error: `no ${body.provider} session ${body.resumeSessionId}` });
      return;
    }
    cwd = session.projectPath;
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) {
      res.status(400).json({ error: `original project directory is gone: ${cwd}` });
      return;
    }
    if (!body.fork) {
      // resuming a conversation a running agent still owns would put two
      // processes on one transcript — refuse and point at the live agent
      const owner = (await liveConversations()).get(`${body.provider}:${body.resumeSessionId.toLowerCase()}`);
      if (owner) {
        res.status(409).json({
          error: `that conversation is already live in ${owner.title || owner.name}`,
          liveAgent: owner.name,
        });
        return;
      }
      // a background agent (no tmux pane) can also own the conversation —
      // claude refuses --resume on those, and codex would silently put a
      // second writer on it — so tell the client to fork instead. A codex
      // conversation spans several rollout files and the live process may
      // hold any of them open, so check the whole group.
      const files = body.provider === 'codex'
        ? [...new Set([session.filePath, ...getCodexSessionFiles(session.id)])]
        : [session.filePath];
      if ((await Promise.all(files.map(transcriptHeldOpen))).some(Boolean)) {
        res.status(409).json({
          error: 'that conversation is live in a background agent',
          backgroundAgent: true,
        });
        return;
      }
    }
  } else {
    cwd = expandHome(String(body.cwd ?? '').trim());
    if (!cwd) {
      res.status(400).json({ error: 'cwd required' });
      return;
    }
  }

  try {
    let title = body.title?.trim() || undefined;
    if (!title && body.resumeSessionId) {
      // carry the conversation's remembered name across the resume
      const sid = body.resumeSessionId.toLowerCase();
      title = getAgentName(sid)
        ?? getClosedAgents().find((e) => e.sessionId?.toLowerCase() === sid)?.title;
    }
    const { name, sessionId } = await createAgent({
      provider: body.provider,
      cwd,
      title,
      model: body.model?.trim() || undefined,
      permissionMode: body.permissionMode || undefined,
      initialPrompt: body.initialPrompt?.trim() || undefined,
      resumeSessionId: body.resumeSessionId,
      fork: body.fork,
    });
    if (sessionId && title) rememberAgentName(sessionId, title);
    if (body.resumeSessionId) noteResumed(body.resumeSessionId);
    invalidateTmuxListing();
  broadcast('tmux-changed');
    res.json({ tmuxName: name });
  } catch (err) {
    if (err instanceof TmuxError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
}));

// GET /tmux is the hot poll (every open view hits it every 2s) and its body
// fans out ~20 subprocesses plus remote fetches — measured 600-1600ms per
// recompute on a busy machine. Clients must NEVER wait on that: a background
// loop keeps a snapshot warm while any tab is open (SSE client connected),
// and the route always answers from the snapshot instantly. Staleness is
// bounded by the refresh cadence — the same 2s the old blocking cache had,
// minus the wait. The local listing keeps its own coalescing layer because
// aggregators fetch it directly (?local=1).
let snapshot: { at: number; agents: TmuxAgent[] } | null = null;
let refreshing: Promise<void> | null = null;
let refreshQueued = false;
let localListingCache: { at: number; agents: TmuxAgent[] } | null = null;
let localListingInFlight: Promise<TmuxAgent[]> | null = null;

function refreshSnapshot(): Promise<void> {
  if (refreshing) {
    // a change arrived mid-compute — run one more pass after this one so the
    // snapshot can't miss it; N invalidations coalesce into a single rerun
    refreshQueued = true;
    return refreshing;
  }
  refreshing = computeTmuxListing()
    .then((agents) => {
      snapshot = { at: Date.now(), agents };
    })
    .catch((err) => console.error('listing refresh failed:', err))
    .finally(() => {
      refreshing = null;
      if (refreshQueued) {
        refreshQueued = false;
        void refreshSnapshot();
      }
    });
  return refreshing;
}

// keep the snapshot warm while anyone is watching; idle machines pay nothing
setInterval(() => {
  if (hasClients() && Date.now() - (snapshot?.at ?? 0) >= 2000) void refreshSnapshot();
}, 500);

const invalidateTmuxListing = () => {
  localListingCache = null;
  if (snapshot) snapshot.at = 0;
  // closed list goes stale too (kills/resumes) — marked, not eagerly
  // recomputed: hook events call this many times a second while agents work
  if (closedWarm.value) closedWarm.value.at = 0;
  void refreshSnapshot();
};

/**
 * Remove a killed agent from the snapshot IMMEDIATELY. Serving stale data
 * while the refresh runs is fine everywhere except here: a client's
 * optimistic kill removal would see the dead agent flash back for a poll or
 * two, which reads as "the kill didn't work".
 */
function dropFromSnapshot(host: string, name: string): void {
  if (snapshot) {
    snapshot.agents = snapshot.agents.filter((a) => !(a.name === name && (a.host ?? LOCAL_HOST) === host));
  }
  const cached = remoteListingCache.get(host);
  if (cached) cached.agents = cached.agents.filter((a) => a.name !== name);
}

function getLocalListing(): Promise<TmuxAgent[]> {
  if (localListingCache && Date.now() - localListingCache.at < 2000) {
    return Promise.resolve(localListingCache.agents);
  }
  localListingInFlight ??= computeLocalListing()
    .then((agents) => {
      localListingCache = { at: Date.now(), agents };
      return agents;
    })
    .finally(() => {
      localListingInFlight = null;
    });
  return localListingInFlight;
}

// An unreachable machine must not blank its agents out of every open view —
// its last good listing is served as `stale` ghosts (rendered "offline")
// until the machine reconnects or is removed. A brief fetch hiccup while the
// tunnel still looks healthy serves the cache unmarked: if the tunnel really
// died, the SSE watchdog flips the host's status shortly and the stale
// marking takes over.
const remoteListingCache = new Map<string, { at: number; agents: TmuxAgent[] }>();

async function computeTmuxListing(): Promise<TmuxAgent[]> {
  const connected = new Map(connectedHosts().map((h) => [h.id, h.baseUrl]));
  const hostIds = [...new Set([...getHostsInfo().map((h) => h.id), ...remoteListingCache.keys()])];
  const [local, ...remote] = await Promise.all([
    getLocalListing(),
    ...hostIds.map(async (id) => {
      const baseUrl = connected.get(id);
      // ?local=1 keeps a remote from merging ITS remotes into the answer —
      // no double-stamping, and no listing cycles between two dashboards.
      // 8s: a cold remote listing fans out ~20 subprocesses and can outlast
      // a short timeout; its own cache makes every later poll fast
      const agents = baseUrl ? await fetchRemoteJson<TmuxAgent[]>(baseUrl, '/tmux?local=1', 8000) : null;
      if (agents) {
        const stamped = agents.map((a) => ({ ...a, host: id, stale: undefined }));
        remoteListingCache.set(id, { at: Date.now(), agents: stamped });
        return stamped;
      }
      const cached = remoteListingCache.get(id);
      if (!cached) return [];
      if (baseUrl) return cached.agents; // transient hiccup — see above
      return cached.agents.map((a) => ({ ...a, stale: true }));
    }),
  ]);
  // one createdAt order across machines keeps 1-9 jumps and tab order stable
  return [...local, ...remote.flat()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function computeLocalListing(): Promise<TmuxAgent[]> {
  const agents = (await listAgents({ previews: true })).map((a) => ({ ...a, host: LOCAL_HOST }));
  const livePaths = await resolveLiveSessions(agents);
  // Fresh codex agents carry no stamp and don't hold their rollout open
  // (paginated mode), so lsof can't see them — correlate by directory +
  // launch time instead, oldest agent claiming the oldest unclaimed session.
  const claimed = new Set(
    agents.map((a) => (a.sessionId ?? a.resumedFrom)?.toLowerCase()).filter(Boolean) as string[],
  );
  const unlinked = agents
    .filter((a) => a.provider === 'codex' && a.agentRunning && !a.sessionId && !a.resumedFrom && a.cwd)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  if (unlinked.length) {
    const all = await getAllSessions();
    for (const agent of unlinked) {
      const launched = new Date(agent.createdAt).getTime() - 120_000;
      const match = all
        .filter((s) =>
          s.provider === 'codex' && s.projectPath === agent.cwd &&
          new Date(s.createdAt).getTime() >= launched && !claimed.has(s.id.toLowerCase()))
        .sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime())[0];
      if (match) {
        agent.sessionId = match.id;
        claimed.add(match.id.toLowerCase());
      }
    }
  }
  await Promise.all(agents.map(async (agent) => {
    if (!agent.provider || !agent.agentRunning) return;
    const id = agent.sessionId ?? agent.resumedFrom;
    const filePath = livePaths.get(agent.name) ?? (id ? await livePathForSession(agent.provider, id) : null);
    if (!filePath) return;
    const turn = await getTurnState(agent.provider, filePath);
    if (turn) {
      agent.turnState = turn.state;
      agent.lastWriteMs = turn.lastWriteMs;
    }
    // recap only once the turn has ended or stalled — while working the file
    // churns every poll and the card never shows it anyway
    if (turn && (turn.state === 'idle' || Date.now() - turn.lastWriteMs > 60_000)) {
      const recap = await getIdleSummary(agent.provider, filePath);
      if (recap) {
        agent.lastPrompt = recap.lastPrompt;
        agent.lastAgentMessage = recap.lastAgentMessage;
        if (recap.context) {
          // returns the cached note and (re)generates in the background — never blocks the poll
          agent.idleSummary = requestIdleNote(filePath, String(turn.lastWriteMs), recap.context);
        }
      }
    }
  }));
  trackAgents(agents);
  // keep the name store in sync with live agents — catches renames, forks and
  // codex sessions whose id only resolves once the transcript file is open
  for (const a of agents) {
    if (a.managed && a.sessionId && a.title) rememberAgentName(a.sessionId, a.title);
    // semantic approval signal pushed by the CLI's own hooks — separate from
    // the transcript block above, which early-returns when no live path has
    // resolved yet (fresh agents). Skipped once the turn is provably over
    // (an esc'd dialog ends the turn without a clearing hook event), and
    // cleared by any transcript write after the ask (a denial runs no tool
    // and fires no hook — the interrupt record it writes is the only signal).
    const hookId = a.sessionId ?? a.resumedFrom;
    if (a.agentRunning && a.turnState !== 'idle' && approvalPending(hookId, a.lastWriteMs)) {
      a.approvalPending = true;
    }
    // sessions with hook traffic get their input-needed state EXCLUSIVELY
    // from hooks — the client skips pane-text matching for them (prose like
    // "do you want to…" made the regex fire on ordinary conversation).
    // CLAUDE ONLY: codex has no approval hook (notify is turn-complete only),
    // so codex must keep the chrome-regex fallback even when notify-tracked.
    if (a.provider === 'claude' && hookMonitored(hookId)) a.hookMonitored = true;
  }
  return agents;
}

router.get('/tmux', asyncRoute(async (req, res) => {
  // aggregators ask for ?local=1: this machine's agents only, never a merge —
  // the cycle-breaker that makes dashboard→dashboard loops harmless
  if (req.query.local) {
    res.json(await getLocalListing());
    return;
  }
  if (snapshot) {
    // answer instantly from the warm snapshot; kick a refresh if it's aged
    // (covers the no-SSE-client case where the keep-warm loop is idle)
    if (Date.now() - snapshot.at >= 2000) void refreshSnapshot();
    res.json(snapshot.agents);
    return;
  }
  await refreshSnapshot();
  res.json(snapshot ? (snapshot as { agents: TmuxAgent[] }).agents : []);
}));

// Receives every hook event from dashboard-launched claude agents (the hook
// command is injected at launch via --settings; see claudeHookSettings).
router.post('/hooks/claude', asyncRoute(async (req, res) => {
  const sessionId = String(req.body?.session_id ?? '');
  const event = String(req.body?.hook_event_name ?? '');
  const toolName = req.body?.tool_name ? String(req.body.tool_name) : undefined;
  if (sessionId && event) {
    noteClaudeHookEvent(sessionId, event, toolName);
    // approval state changes should reach the UI on the next poll, not a
    // second later from the listing cache
    invalidateTmuxListing();
    if (event === 'PermissionRequest' || toolName === 'AskUserQuestion') broadcast('tmux-changed');
  }
  res.status(204).end();
}));

// codex `notify` events (turn-complete only — codex has no approval hook).
// Gives an instant done push instead of waiting on the sqlite poll.
router.post('/hooks/codex', asyncRoute(async (req, res) => {
  const threadId = String(req.body?.['thread-id'] ?? '');
  if (threadId && req.body?.type === 'agent-turn-complete') {
    noteCodexEvent(threadId);
    invalidateTmuxListing();
    broadcast('tmux-changed');
  }
  res.status(204).end();
}));

async function computeClosedListing(includeRemote: boolean): Promise<ClosedAgent[]> {
  // show what each closed agent's conversation actually is, so a custom
  // name can be cross-checked against the chat it belongs to
  const byId = new Map((await getAllSessions()).map((s) => [s.id.toLowerCase(), s]));
  // hide (not delete) entries whose conversation a running agent owns —
  // resuming one would duplicate it; the entry returns if that agent dies
  // ?local=1 skips the remote fan-out — the cycle-breaker aggregators use
  const remoteFetches = !includeRemote
    ? []
    : connectedHosts().map(async ({ id, baseUrl }) => {
        const entries = await fetchRemoteJson<ClosedAgent[]>(baseUrl, '/tmux/closed?local=1');
        // the remote server has already joined titles and filtered live owners
        return (entries ?? []).map((e) => ({ ...e, host: id }));
      });
  const [live, ...remote] = await Promise.all([liveConversations(), ...remoteFetches]);
  const localEntries = getClosedAgents()
    .filter((e) => !e.sessionId || !live.has(`${e.provider}:${e.sessionId.toLowerCase()}`))
    .map((e) => ({
      ...e,
      host: LOCAL_HOST,
      conversationTitle: e.sessionId ? byId.get(e.sessionId.toLowerCase())?.title : undefined,
    }));
  return [...localEntries, ...remote.flat()]
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt));
}

// Same serve-stale-while-refreshing shape as the agents snapshot: the closed
// list is polled every 5s per tab and costs a session scan plus a remote
// round trip per machine (measured ~940ms) — nobody should wait on that.
const closedWarm = { value: null as null | { at: number; entries: ClosedAgent[] }, inflight: null as null | Promise<void>, queued: false };
function refreshClosed(): Promise<void> {
  if (closedWarm.inflight) {
    closedWarm.queued = true;
    return closedWarm.inflight;
  }
  closedWarm.inflight = computeClosedListing(true)
    .then((entries) => {
      closedWarm.value = { at: Date.now(), entries };
    })
    .catch((err) => console.error('closed refresh failed:', err))
    .finally(() => {
      closedWarm.inflight = null;
      if (closedWarm.queued) {
        closedWarm.queued = false;
        void refreshClosed();
      }
    });
  return closedWarm.inflight;
}

router.get('/tmux/closed', asyncRoute(async (req, res) => {
  if (req.query.local) {
    res.json(await computeClosedListing(false));
    return;
  }
  if (closedWarm.value) {
    if (Date.now() - closedWarm.value.at >= 4000) void refreshClosed();
    res.json(closedWarm.value.entries);
    return;
  }
  await refreshClosed();
  res.json(closedWarm.value ? (closedWarm.value as { entries: ClosedAgent[] }).entries : []);
}));

router.delete('/tmux/closed/:id', asyncRoute(async (req, res) => {
  if (!dismissClosed(req.params.id)) {
    res.status(404).json({ error: 'no such entry' });
    return;
  }
  invalidateTmuxListing();
  broadcast('tmux-changed');
  res.status(204).end();
}));

router.delete('/tmux/:name', asyncRoute(async (req, res) => {
  try {
    await killSession(req.params.name);
    noteKilled(req.params.name);
  } catch (err) {
    if (err instanceof TmuxError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  dropFromSnapshot(LOCAL_HOST, req.params.name);
  invalidateTmuxListing();
  broadcast('tmux-changed');
  res.status(204).end();
}));

router.patch('/tmux/:name/title', asyncRoute(async (req, res) => {
  const { title } = (req.body ?? {}) as { title?: string };
  if (typeof title !== 'string') {
    res.status(400).json({ error: 'title required (empty string clears it)' });
    return;
  }
  try {
    const clean = await renameAgent(req.params.name, title);
    // live-resolved id first: the stamped option goes stale after /clear
    const sessionId = getTrackedAgent(req.params.name)?.sessionId
      ?? await getSessionOption(req.params.name, '@agent_session_id');
    if (sessionId) {
      if (clean) rememberAgentName(sessionId, clean);
      else forgetAgentName(sessionId);
    }
  } catch (err) {
    if (err instanceof TmuxError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  invalidateTmuxListing();
  broadcast('tmux-changed');
  res.status(204).end();
}));

router.post('/tmux/:name/input', asyncRoute(async (req, res) => {
  const { text, key } = (req.body ?? {}) as { text?: string; key?: string };
  try {
    if (typeof key === 'string') await sendKeyToSession(req.params.name, key);
    else if (typeof text === 'string' && text.trim()) await sendTextToSession(req.params.name, text);
    else {
      res.status(400).json({ error: 'text or key required' });
      return;
    }
  } catch (err) {
    if (err instanceof TmuxError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  res.status(204).end();
}));

// codex has no /effort command and /model takes no argument (it would be sent
// as a chat message) — its picker is driven key-by-key instead (codexpicker.ts)
router.post('/tmux/:name/model', asyncRoute(async (req, res) => {
  const { model, effort } = (req.body ?? {}) as { model?: string; effort?: string };
  if (typeof model !== 'string' && typeof effort !== 'string') {
    res.status(400).json({ error: 'model or effort required' });
    return;
  }
  try {
    res.json(await driveCodexModelPicker(req.params.name, { model, effort }));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

// neither CLI has a command for permission/plan mode — shift+tab is cycled
// key-by-key with pane verification (modecycle.ts)
router.post('/tmux/:name/mode', asyncRoute(async (req, res) => {
  const { mode } = (req.body ?? {}) as { mode?: string };
  if (typeof mode !== 'string' || !mode) {
    res.status(400).json({ error: 'mode required' });
    return;
  }
  const provider = await getSessionOption(req.params.name, '@agent_provider');
  if (provider !== 'claude' && provider !== 'codex') {
    res.status(400).json({ error: 'agent has no known provider' });
    return;
  }
  try {
    res.json(await cycleAgentMode(req.params.name, provider, mode));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

router.get('/tmux/:name/preview', asyncRoute(async (req, res) => {
  try {
    res.json({ ansi: await capturePane(req.params.name) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

router.get('/events', sseHandler);
