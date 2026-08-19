import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentStatus, Provider, TmuxAgent } from '@shared/types';
import { fetchAgents, fetchClosedAgents, fetchProjects, fetchRecentSessions, fetchSessions, fetchTranscript, killAgent } from './lib/api';
import { deriveStatus } from './lib/status';
import { linkedSessionFor } from './lib/linked';

export interface AgentWithStatus extends TmuxAgent {
  status: AgentStatus;
}

export function useAgents(): { agents: AgentWithStatus[]; isLoading: boolean } {
  const query = useQuery({ queryKey: ['agents'], queryFn: fetchAgents, refetchInterval: 2000 });
  const recentsQuery = useQuery({
    // interval as belt-and-suspenders: SSE invalidation drops events whenever
    // the :5175 server restarts (which agents do while landing features)
    refetchInterval: 15_000,
    queryKey: ['sessions', 'recent', 100],
    queryFn: () => fetchRecentSessions(100),
  });
  const recents = recentsQuery.data ?? [];
  const raw = query.data ?? [];
  const seen = useRef(new Map<string, { preview: string; changedAt: number }>());
  const now = Date.now();
  const agents = raw.map((a) => {
    const prev = seen.current.get(a.name);
    let changedAt = prev?.changedAt ?? 0;
    if (!prev || prev.preview !== a.preview) {
      changedAt = now;
      seen.current.set(a.name, { preview: a.preview, changedAt });
    }
    const linked = linkedSessionFor(a, recents, raw);
    const session = linked
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
  return { agents, isLoading: query.isLoading };
}

/**
 * Kill an agent with optimistic removal: the tile/card/sidebar entry vanishes
 * the instant the kill is confirmed — a lingering pane reads as "didn't work"
 * and invites a second, misdirected kill. If the server kill fails, the next
 * poll (or the error-path invalidate) brings the agent back. Resolves true on
 * success.
 */
export function useKillAgent(): (name: string) => Promise<boolean> {
  const queryClient = useQueryClient();
  return useCallback(async (name: string) => {
    await queryClient.cancelQueries({ queryKey: ['agents'] });
    queryClient.setQueryData<TmuxAgent[]>(['agents'], (old) => old?.filter((a) => a.name !== name));
    try {
      await killAgent(name);
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

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: fetchProjects });

export const useSessions = (projectPath: string) =>
  useQuery({
    queryKey: ['sessions', projectPath],
    queryFn: () => fetchSessions(projectPath),
    enabled: !!projectPath,
  });

export const useRecentSessions = (limit = 12) =>
  useQuery({ queryKey: ['sessions', 'recent', limit], queryFn: () => fetchRecentSessions(limit) });

export const useTranscript = (provider: Provider | undefined, id: string | undefined, live = false) =>
  useQuery({
    queryKey: ['transcript', provider, id],
    queryFn: () => fetchTranscript(provider!, id!, { tail: 200 }),
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
    es.addEventListener('session-updated', () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['transcript'] });
    });
    return () => es.close();
  }, [queryClient]);
}
