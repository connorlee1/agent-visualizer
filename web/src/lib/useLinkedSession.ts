import type { Provider, SessionSummary, TmuxAgent } from '@shared/types';
import { useAgents, useRecentSessions } from '../queries';
import { hostOf } from './agentRef';
import { linkedSessionFor } from './linked';

/**
 * Hook form of linkedSessionFor, fed by the shared queries. Recents come from
 * the agent's own machine, and only same-machine agents feed the sole-agent
 * check — cross-machine correlation would link a remote agent to an
 * identically-pathed local conversation.
 */
export function useLinkedSession(agent: TmuxAgent | undefined): { provider: Provider; id: string } | null {
  const host = agent ? hostOf(agent) : undefined;
  const { data: recents } = useRecentSessions(100, host);
  const { agents } = useAgents();
  return linkedSessionFor(agent, recents ?? [], agents.filter((a) => hostOf(a) === host));
}

/** Full summary (title, model, effort, …) of an agent's live conversation. */
export function useLinkedSummary(agent: TmuxAgent | undefined): SessionSummary | null {
  const host = agent ? hostOf(agent) : undefined;
  const { data: recents } = useRecentSessions(100, host);
  const { agents } = useAgents();
  const linked = linkedSessionFor(agent, recents ?? [], agents.filter((a) => hostOf(a) === host));
  if (!linked) return null;
  return recents?.find((s) => s.provider === linked.provider && s.id === linked.id) ?? null;
}
