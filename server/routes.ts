import os from 'node:os';
import fs from 'node:fs/promises';
import { Router } from 'express';
import type { LaunchAgentRequest, TmuxAgent } from '../shared/types';
import { sseHandler, broadcast } from './events';
import { capturePane, createAgent, getSessionOption, isServerRunning, killSession, listAgents, renameAgent, sendKeyToSession, sendTextToSession, TmuxError } from './tmux';
import { findSession, getAllSessions, getProjects, getSessionsForProject, getTranscript, livePathForSession } from './sessions/index';
import { resolveLiveSessions } from './livesessions';
import { getTurnState } from './sessions/turnstate';
import { getIdleSummary } from './sessions/idlesummary';
import { requestIdleNote } from './sessions/summarizer';
import { dismissClosed, getClosedAgents, getTrackedAgent, noteKilled, noteResumed, trackAgents } from './closedagents';
import { driveCodexModelPicker } from './codexpicker';
import { forgetAgentName, getAgentName, rememberAgentName } from './agentnames';

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

router.get('/tmux', asyncRoute(async (_req, res) => {
  const agents = await listAgents({ previews: true });
  const livePaths = await resolveLiveSessions(agents);
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
  }
  res.json(agents);
}));

router.get('/tmux/closed', asyncRoute(async (_req, res) => {
  // show what each closed agent's conversation actually is, so a custom
  // name can be cross-checked against the chat it belongs to
  const byId = new Map((await getAllSessions()).map((s) => [s.id.toLowerCase(), s]));
  // hide (not delete) entries whose conversation a running agent owns —
  // resuming one would duplicate it; the entry returns if that agent dies
  const live = await liveConversations();
  res.json(getClosedAgents()
    .filter((e) => !e.sessionId || !live.has(`${e.provider}:${e.sessionId.toLowerCase()}`))
    .map((e) => ({
      ...e,
      conversationTitle: e.sessionId ? byId.get(e.sessionId.toLowerCase())?.title : undefined,
    })));
}));

router.delete('/tmux/closed/:id', asyncRoute(async (req, res) => {
  if (!dismissClosed(req.params.id)) {
    res.status(404).json({ error: 'no such entry' });
    return;
  }
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
