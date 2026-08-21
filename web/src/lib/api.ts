import type {
  AddHostRequest,
  ClosedAgent,
  HostInfo,
  LaunchAgentRequest,
  LaunchAgentResponse,
  Project,
  Provider,
  SessionSummary,
  TmuxAgent,
  TranscriptResponse,
} from '@shared/types';
import { isRemoteHost, parseRef } from './agentRef';

/** Resume refused: the conversation is already open in a running agent. */
export class LaunchConflictError extends Error {
  constructor(message: string, readonly liveAgent: string) {
    super(message);
  }
}

/** API prefix for a machine: remote machines route through the forwarder. */
const apiBase = (host?: string) => (isRemoteHost(host) ? `/api/h/${host}` : '/api');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = res.statusText;
    let liveAgent: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
      if (typeof body?.liveAgent === 'string') liveAgent = body.liveAgent;
    } catch { /* non-JSON error body */ }
    if (res.status === 409 && liveAgent) throw new LaunchConflictError(detail, liveAgent);
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const fetchAgents = () => request<TmuxAgent[]>('/api/tmux');
export const fetchClosedAgents = () => request<ClosedAgent[]>('/api/tmux/closed');
export const dismissClosedAgent = (id: string, host?: string) =>
  request<void>(`${apiBase(host)}/tmux/closed/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const fetchProjects = (host?: string) => request<Project[]>(`${apiBase(host)}/projects`);
export const fetchSessions = (projectPath: string, host?: string) =>
  request<SessionSummary[]>(`${apiBase(host)}/sessions?project=${encodeURIComponent(projectPath)}`);
export const fetchRecentSessions = (limit = 12, host?: string) =>
  request<SessionSummary[]>(`${apiBase(host)}/sessions/recent?limit=${limit}`);

export const fetchHosts = () => request<HostInfo[]>('/api/hosts');
export const addHost = (body: AddHostRequest) =>
  request<HostInfo>('/api/hosts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
export const removeHost = (id: string) =>
  request<void>(`/api/hosts/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * Returns null when the session isn't found — a freshly launched agent's
 * transcript file may not exist yet, and live polling should pick it up
 * once it appears rather than sticking in an error state.
 */
export const fetchTranscript = async (
  provider: Provider,
  id: string,
  opts: { tail?: number; offset?: number; limit?: number; host?: string } = {},
): Promise<TranscriptResponse | null> => {
  const params = new URLSearchParams();
  if (opts.tail != null) params.set('tail', String(opts.tail));
  if (opts.offset != null) params.set('offset', String(opts.offset));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const res = await fetch(`${apiBase(opts.host)}/sessions/${provider}/${id}/transcript?${params}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch { /* non-JSON error body */ }
    throw new Error(detail);
  }
  return res.json() as Promise<TranscriptResponse>;
};

export const launchAgent = (body: LaunchAgentRequest, host?: string) =>
  request<LaunchAgentResponse>(`${apiBase(host)}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// Agent-scoped calls take a REF ("host:name" or bare local name) so callers
// never juggle host + name pairs.

export const killAgent = (ref: string) => {
  const { host, name } = parseRef(ref);
  return request<void>(`${apiBase(host)}/tmux/${encodeURIComponent(name)}`, { method: 'DELETE' });
};

/** Set the agent's custom display name; an empty string clears it. */
export const renameAgent = (ref: string, title: string) => {
  const { host, name } = parseRef(ref);
  return request<void>(`${apiBase(host)}/tmux/${encodeURIComponent(name)}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
};

/** Type a prompt (text) or press a key in the agent's tmux pane. */
export const sendAgentInput = (ref: string, input: { text?: string; key?: string }) => {
  const { host, name } = parseRef(ref);
  return request<void>(`${apiBase(host)}/tmux/${encodeURIComponent(name)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
};

/** Change a codex agent's model/effort by driving its /model picker. */
export const driveModelPicker = (ref: string, body: { model?: string; effort?: string }) => {
  const { host, name } = parseRef(ref);
  return request<{ model?: string; effort?: string }>(`${apiBase(host)}/tmux/${encodeURIComponent(name)}/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};
