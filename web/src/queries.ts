import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentStatus, Provider, TmuxAgent } from '@shared/types';
import { fetchAgents, fetchClosedAgents, fetchHosts, fetchProjects, fetchRecentSessions, fetchSessions, fetchTranscript, killAgent } from './lib/api';
import { hostOf, isRemoteHost, refOf, LOCAL_HOST } from './lib/agentRef';
import { deriveStatus } from './lib/status';
import { linkedSessionFor } from './lib/linked';
import { syncDoneFlash } from './lib/useDoneFlash';

export interface AgentWithStatus extends TmuxAgent {
  status: AgentStatus;
}

export function useAgents(): { agents: AgentWithStatus[]; isLoading: boolean } {
  const query = useQuery({ queryKey: ['agents'], queryFn: fetchAgents, refetchInterval: 2000 });
  const recentsQuery = useQuery({
    // interval as belt-and-suspenders: SSE invalidation drops events whenever
    // the :5175 server restarts (which agents do while landing features)
    refetchInterval: 15_000,
    queryKey: ['sessions', LOCAL_HOST, 'recent', 100],
    queryFn: () => fetchRecentSessions(100),
  });
  const recents = recentsQuery.data ?? [];
  const raw = query.data ?? [];
  const seen = useRef(new Map<string, { preview: string; changedAt: number }>());
  const now = Date.now();
  const localAgents = raw.filter((a) => !isRemoteHost(a.host));
  const agents = raw.map((a) => {
    const ref = refOf(a);
    const prev = seen.current.get(ref);
    let changedAt = prev?.changedAt ?? 0;
    if (!prev || prev.preview !== a.preview) {
      changedAt = now;
      seen.current.set(ref, { preview: a.preview, changedAt });
    }
    // recents here are the LOCAL machine's — correlating a remote agent's cwd
    // against them would link across machines, so remote agents rely on the
    // session id their own server ground-truth-resolved (lsof / db)
    const linked = isRemoteHost(a.host)
      ? a.provider && (a.sessionId ?? a.resumedFrom)
        ? { provider: a.provider, id: (a.sessionId ?? a.resumedFrom)! }
        : null
      : linkedSessionFor(a, recents, localAgents);
    const session = linked && !isRemoteHost(a.host)
      ? recents.find((s) => s.provider === linked.provider && s.id === linked.id)
      : undefined;
    return {
      ...a,
      status: deriveStatus(a, {
        // pane repainted within the last ~3 polls — the liveness gate for open turns
        changedRecently: now - changedAt < 15_000,
        lastWriteAt: session ? new Date(session.lastActivityAt).getTime() : undefined,
      }),
    };
  });
  // Feed the done-flash store every poll (idempotent) — AppShell mounts this
  // on every page, so rings survive time spent away from wall/agent views.
  useEffect(() => {
    syncDoneFlash(agents.map((a) => ({ name: refOf(a), status: a.status })));
  });
  return { agents, isLoading: query.isLoading };
}

/**
 * Kill an agent (by ref) with optimistic removal: the tile/card/sidebar entry
 * vanishes the instant the kill is confirmed — a lingering pane reads as
 * "didn't work" and invites a second, misdirected kill. If the server kill
 * fails, the next poll (or the error-path invalidate) brings the agent back.
 * Resolves true on success.
 */
export function useKillAgent(): (ref: string) => Promise<boolean> {
  const queryClient = useQueryClient();
  return useCallback(async (ref: string) => {
    await queryClient.cancelQueries({ queryKey: ['agents'] });
    queryClient.setQueryData<TmuxAgent[]>(['agents'], (old) => old?.filter((a) => refOf(a) !== ref));
    try {
      await killAgent(ref);
      return true;
    } catch (err) {
      console.error('kill failed:', err);
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      return false;
    }
  }, [queryClient]);
}

export const useClosedAgents = () =>
  useQuery({ queryKey: ['closed-agents'], queryFn: fetchClosedAgents, refetchInterval: 5000 });

export const useHosts = () =>
  useQuery({ queryKey: ['hosts'], queryFn: fetchHosts, refetchInterval: 5000 });

export const useProjects = (host: string = LOCAL_HOST) =>
  useQuery({ queryKey: ['projects', host], queryFn: () => fetchProjects(host) });

export const useSessions = (projectPath: string, host: string = LOCAL_HOST) =>
  useQuery({
    queryKey: ['sessions', host, projectPath],
    queryFn: () => fetchSessions(projectPath, host),
    enabled: !!projectPath,
  });

export const useRecentSessions = (limit = 12, host: string = LOCAL_HOST) =>
  useQuery({ queryKey: ['sessions', host, 'recent', limit], queryFn: () => fetchRecentSessions(limit, host) });

export const useTranscript = (
  provider: Provider | undefined,
  id: string | undefined,
  live = false,
  host: string = LOCAL_HOST,
) =>
  useQuery({
    queryKey: ['transcript', host, provider, id],
    queryFn: () => fetchTranscript(provider!, id!, { tail: 200, host }),
    enabled: !!provider && !!id,
    refetchInterval: live ? 3000 : false,
  });

/** Subscribe to server-sent events and invalidate the matching query caches. */
export function useServerEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('tmux-changed', () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['closed-agents'] });
    });
    es.addEventListener('hosts-changed', () => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    });
    es.addEventListener('session-updated', (ev) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      // target the one transcript the event names — refetching every open
      // chat ~1.5×/s was a major browser + server churn source
      let payload: { provider?: string; sessionId?: string; host?: string } = {};
      try {
        payload = JSON.parse((ev as MessageEvent).data ?? '{}');
      } catch { /* old server without payload */ }
      if (payload.sessionId) {
        queryClient.invalidateQueries({
          queryKey: ['transcript', payload.host ?? LOCAL_HOST, payload.provider, payload.sessionId],
        });
      } else {
        queryClient.invalidateQueries({ queryKey: ['transcript'] });
      }
    });
    return () => es.close();
  }, [queryClient]);
}
