import type {
  ClosedAgent,
  LaunchAgentRequest,
  LaunchAgentResponse,
  Project,
  Provider,
  SessionSummary,
  TmuxAgent,
  TranscriptResponse,
} from '@shared/types';

/** Resume refused: the conversation is already open in a running agent. */
export class LaunchConflictError extends Error {
  constructor(message: string, readonly liveAgent: string) {
    super(message);
  }
}

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
export const dismissClosedAgent = (id: string) =>
  request<void>(`/api/tmux/closed/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const fetchProjects = () => request<Project[]>('/api/projects');
export const fetchSessions = (projectPath: string) =>
  request<SessionSummary[]>(`/api/sessions?project=${encodeURIComponent(projectPath)}`);
export const fetchRecentSessions = (limit = 12) =>
  request<SessionSummary[]>(`/api/sessions/recent?limit=${limit}`);

/**
 * Returns null when the session isn't found — a freshly launched agent's
 * transcript file may not exist yet, and live polling should pick it up
 * once it appears rather than sticking in an error state.
 */
export const fetchTranscript = async (provider: Provider, id: string, opts: { tail?: number; offset?: number; limit?: number } = {}): Promise<TranscriptResponse | null> => {
  const params = new URLSearchParams();
  if (opts.tail != null) params.set('tail', String(opts.tail));
  if (opts.offset != null) params.set('offset', String(opts.offset));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const res = await fetch(`/api/sessions/${provider}/${id}/transcript?${params}`);
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

export const launchAgent = (body: LaunchAgentRequest) =>
  request<LaunchAgentResponse>('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const killAgent = (name: string) =>
  request<void>(`/api/tmux/${encodeURIComponent(name)}`, { method: 'DELETE' });

/** Set the agent's custom display name; an empty string clears it. */
export const renameAgent = (name: string, title: string) =>
  request<void>(`/api/tmux/${encodeURIComponent(name)}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });

/** Type a prompt (text) or press a key in the agent's tmux pane. */
export const sendAgentInput = (name: string, input: { text?: string; key?: string }) =>
  request<void>(`/api/tmux/${encodeURIComponent(name)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

/** Change a codex agent's model/effort by driving its /model picker. */
export const driveModelPicker = (name: string, body: { model?: string; effort?: string }) =>
  request<{ model?: string; effort?: string }>(`/api/tmux/${encodeURIComponent(name)}/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
