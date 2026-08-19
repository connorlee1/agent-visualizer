import type { Provider, SessionSummary, TmuxAgent } from '@shared/types';
import { useAgents, useRecentSessions } from '../queries';
import { linkedSessionFor } from './linked';

/** Hook form of linkedSessionFor, fed by the shared queries. */
export function useLinkedSession(agent: TmuxAgent | undefined): { provider: Provider; id: string } | null {
  const { data: recents } = useRecentSessions(100);
  const { agents } = useAgents();
  return linkedSessionFor(agent, recents ?? [], agents);
}

/** Full summary (title, model, effort, …) of an agent's live conversation. */
export function useLinkedSummary(agent: TmuxAgent | undefined): SessionSummary | null {
  const { data: recents } = useRecentSessions(100);
  const { agents } = useAgents();
  const linked = linkedSessionFor(agent, recents ?? [], agents);
  if (!linked) return null;
  return recents?.find((s) => s.provider === linked.provider && s.id === linked.id) ?? null;
}
