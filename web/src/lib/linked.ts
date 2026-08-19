import type { Provider, SessionSummary, TmuxAgent } from '@shared/types';

const ms = (iso: string) => new Date(iso).getTime();

/**
 * The conversation an agent is talking in RIGHT NOW.
 *
 * The id stamped at launch goes stale whenever the conversation is replaced
 * inside the same tmux session — quitting and rerunning the CLI, `/clear`,
 * or codex starting fresh — so a newer session file in the agent's directory
 * wins over the stamped id. Directory correlation is only safe when this is
 * the sole agent working there; otherwise we trust the stamped id.
 */
export function linkedSessionFor(
  agent: TmuxAgent | undefined,
  recents: SessionSummary[],
  allAgents: TmuxAgent[] = [],
): { provider: Provider; id: string } | null {
  if (!agent?.provider) return null;
  const stamped = agent.sessionId ?? agent.resumedFrom;
  if (!agent.cwd) return stamped ? { provider: agent.provider, id: stamped } : null;

  const soleAgentHere =
    allAgents.filter((a) => a.cwd === agent.cwd && a.provider === agent.provider).length <= 1;
  if (stamped && !soleAgentHere) return { provider: agent.provider, id: stamped };

  // a conversation started in this directory since the agent launched
  const launchedAt = ms(agent.createdAt) - 120_000;
  const newest = recents
    .filter(
      (s) => s.provider === agent.provider && s.projectPath === agent.cwd && ms(s.createdAt) >= launchedAt,
    )
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];

  if (!newest) return stamped ? { provider: agent.provider, id: stamped } : null;
  if (!stamped || newest.id === stamped) return { provider: agent.provider, id: newest.id };

  // both exist and differ: the stamped conversation was superseded if the
  // newer one has actually been written to more recently
  const stampedSession = recents.find((s) => s.provider === agent.provider && s.id === stamped);
  if (!stampedSession || ms(newest.lastActivityAt) >= ms(stampedSession.lastActivityAt)) {
    return { provider: agent.provider, id: newest.id };
  }
  return { provider: agent.provider, id: stamped };
}
