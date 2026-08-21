import { useState } from 'react';
import { Eye } from 'lucide-react';
import { useAgents, useRecentSessions } from '../../queries';
import { encodePanelRef, type PanelRef } from '../../lib/panelRef';
import { launchAgent, LaunchConflictError } from '../../lib/api';
import { hostOf, isRemoteHost, refOf } from '../../lib/agentRef';
import { agentLabel, relTime, truncate } from '../../lib/format';
import { AgentStatusDot } from '../agents/AgentStatusDot';

/**
 * Dropdown listing everything that can go in a panel. Picking a running agent
 * opens it directly; picking a past conversation RESUMES it into a fresh
 * agent first (the eye icon opens it read-only instead).
 */
export function PanelPicker({ open, onClose, onSelect, excludeRefs = [] }: {
  open: boolean;
  onClose: () => void;
  onSelect: (panel: PanelRef) => void;
  /** Encoded panel refs already on screen — hidden from the list. */
  excludeRefs?: string[];
}) {
  const { agents } = useAgents();
  const { data: recents } = useRecentSessions(10);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  const excluded = new Set(excludeRefs);
  // recents shown below are local-machine conversations, so only local
  // agents' sessions count as "already running" for that list
  const runningSessionIds = new Set(
    agents.filter((a) => !isRemoteHost(a.host))
      .flatMap((a) => [a.sessionId, a.resumedFrom]).filter(Boolean) as string[],
  );
  const terms = agents.filter((a) => !excluded.has(encodePanelRef({ kind: 'term', name: refOf(a) })));
  const chats = (recents ?? [])
    .filter(
      (s) =>
        !excluded.has(encodePanelRef({ kind: 'chat', provider: s.provider, id: s.id })) &&
        !runningSessionIds.has(s.id), // already listed above as a running agent
    )
    .slice(0, 8);

  const pick = (panel: PanelRef) => {
    onSelect(panel);
    onClose();
  };

  const resumeAndPick = async (provider: 'claude' | 'codex', id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await launchAgent({ provider, resumeSessionId: id });
      pick({ kind: 'term', name: res.tmuxName });
    } catch (err) {
      if (err instanceof LaunchConflictError) {
        // already open in a running agent — show that agent's panel instead;
        // the server's pick may have just been killed, so prefer a live owner
        const owners = agents.filter(
          (a) => !isRemoteHost(a.host) && a.agentRunning && a.sessionId?.toLowerCase() === id.toLowerCase(),
        );
        const owner = owners.find((a) => a.name === err.liveAgent) ?? owners[0];
        pick({ kind: 'term', name: owner ? refOf(owner) : err.liveAgent });
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full z-50 mt-1.5 w-[320px] overflow-hidden rounded-md border border-edge bg-surface shadow-2xl">
        <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-widest text-faint">
          Running agents
        </div>
        {terms.length === 0 && <div className="px-3 pb-1 text-[12px] text-faint">none running</div>}
        {terms.map((a) => (
          <button
            key={refOf(a)}
            onClick={() => pick({ kind: 'term', name: refOf(a) })}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-surface2"
          >
            <AgentStatusDot status={a.status} />
            <span className="truncate font-mono text-[12px]">{agentLabel(a, agents)}</span>
            {isRemoteHost(a.host) && (
              <span className="ml-auto shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
                {hostOf(a)}
              </span>
            )}
          </button>
        ))}

        <div className="mt-1 border-t border-edge px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-faint">
          Conversations <span className="normal-case tracking-normal">· click to resume</span>
        </div>
        {chats.map((s) => (
          <div
            key={`${s.provider}-${s.id}`}
            className="group flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-surface2"
            onClick={() => void resumeAndPick(s.provider, s.id)}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.provider === 'claude' ? 'var(--color-claude)' : 'var(--color-codex)' }}
            />
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {busyId === s.id ? 'resuming…' : truncate(s.title, 44)}
            </span>
            <span className="shrink-0 text-[11px] text-faint group-hover:hidden">{relTime(s.lastActivityAt)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                pick({ kind: 'chat', provider: s.provider, id: s.id });
              }}
              className="hidden shrink-0 rounded p-0.5 text-faint hover:text-ink group-hover:block"
              title="view read-only (don't resume)"
            >
              <Eye size={13} />
            </button>
          </div>
        ))}
        {error && <div className="px-3 py-1.5 text-[11px] text-red-400">{error}</div>}
        <div className="pb-1.5" />
      </div>
    </>
  );
}
