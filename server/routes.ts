import os from 'node:os';
import fs from 'node:fs/promises';
import { Router } from 'express';
import type { AddHostRequest, ClosedAgent, LaunchAgentRequest, TmuxAgent } from '../shared/types';
import { LOCAL_HOST } from '../shared/types';
import { sseHandler, broadcast } from './events';
import { addHost, connectedHosts, getHostsInfo, hostBaseUrl, hostEvents, removeHost } from './hosts';
import { capturePane, createAgent, getSessionOption, isServerRunning, killSession, listAgents, renameAgent, sendKeyToSession, sendTextToSession, TmuxError } from './tmux';
import { findSession, getAllSessions, getProjects, getSessionsForProject, getTranscript, livePathForSession } from './sessions/index';
import { resolveLiveSessions } from './livesessions';
import { getTurnState } from './sessions/turnstate';
import { getIdleSummary } from './sessions/idlesummary';
import { requestIdleNote } from './sessions/summarizer';
import { dismissClosed, getClosedAgents, getTrackedAgent, noteKilled, noteResumed, trackAgents } from './closedagents';
import { driveCodexModelPicker } from './codexpicker';
import { forgetAgentName, getAgentName, rememberAgentName } from './agentnames';
import { approvalPending, noteClaudeHookEvent } from './hooksignals';

export const router = Router();

const asyncRoute = (fn: (req: any, res: any) => Promise<void>) => (req: any, res: any) => {
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
};

router.get('/health', asyncRoute(async (_req, res) => {
  res.json({ ok: true, tmuxRunning: await isServerRunning(), version: '0.1.0' });
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
    // generous: codex model-picker drives can take a while
    signal: AbortSignal.timeout(60_000),
  }).then(async (r) => {
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
  const agents = await listAgents();
  // ground-truth linkage beats the stamped id, which goes stale after /clear
  await resolveLiveSessions(agents);
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
// fans out ~20 subprocesses. Coalesce: concurrent requests share one
// computation, and results stay fresh for a second — N tabs cost one
// computation per second, not N per 2s.
let tmuxListingCache: { at: number; agents: TmuxAgent[] } | null = null;
const invalidateTmuxListing = () => { tmuxListingCache = null; };
let tmuxListingInFlight: Promise<TmuxAgent[]> | null = null;

async function computeTmuxListing(): Promise<TmuxAgent[]> {
  const [local, ...remote] = await Promise.all([
    computeLocalListing(),
    ...connectedHosts().map(async ({ id, baseUrl }) => {
      // 8s: a cold remote listing fans out ~20 subprocesses and can outlast
      // a short timeout; its own cache makes every later poll fast
      const agents = await fetchRemoteJson<TmuxAgent[]>(baseUrl, '/tmux', 8000);
      return (agents ?? []).map((a) => ({ ...a, host: id }));
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
    // (an esc'd dialog ends the turn without a clearing hook event).
    if (a.agentRunning && a.turnState !== 'idle' && approvalPending(a.sessionId ?? a.resumedFrom)) {
      a.approvalPending = true;
    }
  }
  return agents;
}

router.get('/tmux', asyncRoute(async (_req, res) => {
  if (tmuxListingCache && Date.now() - tmuxListingCache.at < 2000) {
    res.json(tmuxListingCache.agents);
    return;
  }
  if (!tmuxListingInFlight) {
    tmuxListingInFlight = computeTmuxListing()
      .then((agents) => {
        tmuxListingCache = { at: Date.now(), agents };
        return agents;
      })
      .finally(() => {
        tmuxListingInFlight = null;
      });
  }
  res.json(await tmuxListingInFlight);
}));

// Receives every hook event from dashboard-launched claude agents (the hook
// command is injected at launch via --settings; see claudeHookSettings).
router.post('/hooks/claude', asyncRoute(async (req, res) => {
  const sessionId = String(req.body?.session_id ?? '');
  const event = String(req.body?.hook_event_name ?? '');
  if (sessionId && event) {
    noteClaudeHookEvent(sessionId, event);
    // approval state changes should reach the UI on the next poll, not a
    // second later from the listing cache
    invalidateTmuxListing();
    if (event === 'PermissionRequest') broadcast('tmux-changed');
  }
  res.status(204).end();
}));

router.get('/tmux/closed', asyncRoute(async (_req, res) => {
  // show what each closed agent's conversation actually is, so a custom
  // name can be cross-checked against the chat it belongs to
  const byId = new Map((await getAllSessions()).map((s) => [s.id.toLowerCase(), s]));
  // hide (not delete) entries whose conversation a running agent owns —
  // resuming one would duplicate it; the entry returns if that agent dies
  const [live, ...remote] = await Promise.all([
    liveConversations(),
    ...connectedHosts().map(async ({ id, baseUrl }) => {
      const entries = await fetchRemoteJson<ClosedAgent[]>(baseUrl, '/tmux/closed');
      // the remote server has already joined titles and filtered live owners
      return (entries ?? []).map((e) => ({ ...e, host: id }));
    }),
  ]);
  const localEntries = getClosedAgents()
    .filter((e) => !e.sessionId || !live.has(`${e.provider}:${e.sessionId.toLowerCase()}`))
    .map((e) => ({
      ...e,
      host: LOCAL_HOST,
      conversationTitle: e.sessionId ? byId.get(e.sessionId.toLowerCase())?.title : undefined,
    }));
  res.json([...localEntries, ...remote.flat()]
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt)));
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

router.get('/tmux/:name/preview', asyncRoute(async (req, res) => {
  try {
    res.json({ ansi: await capturePane(req.params.name) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

router.get('/events', sseHandler);
