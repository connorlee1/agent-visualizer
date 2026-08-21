import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { EyeOff, Search, TerminalSquare } from 'lucide-react';
import { useAgents, useClosedAgents, useRecentSessions } from '../queries';
import { refOf } from '../lib/agentRef';
import { useHiddenAgents } from '../lib/hiddenAgents';
import { AgentCard } from '../components/agents/AgentCard';
import { ClosedAgentRow } from '../components/agents/ClosedAgentRow';
import { ConversationRow } from '../components/projects/ConversationRow';
import { EmptyState } from '../components/ui/EmptyState';

export function HomePage() {
  const { agents, isLoading } = useAgents();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // searching widens from the 8 recents to the full conversation list
  const { data: recents } = useRecentSessions(q ? 500 : 8);
  const { data: closed } = useClosedAgents();
  const [resumeError, setResumeError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // hidden agents leave the grid but stay searchable (the recovery path,
  // alongside the reveal row below the grid)
  const hiddenSet = useHiddenAgents();
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = agents.filter((a) => hiddenSet.has(refOf(a))).length;

  const { shownAgents, shownClosed, shownRecents } = useMemo(() => {
    const matches = (...fields: Array<string | undefined>) =>
      fields.some((f) => f?.toLowerCase().includes(q));
    return {
      shownAgents: q
        ? agents.filter((a) => matches(a.title, a.cwd, a.name, a.sessionId))
        : agents.filter((a) => showHidden || !hiddenSet.has(refOf(a))),
      shownClosed: q
        ? (closed ?? []).filter((e) => matches(e.title, e.cwd, e.name, e.sessionId, e.conversationTitle))
        : (closed ?? []).slice(0, 8),
      shownRecents: q
        ? (recents ?? []).filter((s) => matches(s.title, s.projectPath, s.agentName, s.id)).slice(0, 20)
        : recents ?? [],
    };
  }, [q, agents, closed, recents, hiddenSet, showHidden]);

  const nothingMatches = q && !shownAgents.length && !shownClosed.length && !shownRecents.length;

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-8">
      <div className="flex items-baseline gap-3 pb-4">
        <span className="h-[16px] w-[3px] self-center rounded-full bg-claude" />
        <h1 className="font-mono text-[17px] font-semibold tracking-tight">Agents</h1>
        {agents.length > 0 && <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ok">{agents.length} running</span>}
        <div className="relative ml-auto w-[280px] self-center">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                e.currentTarget.blur();
              }
            }}
            placeholder="Search everything…  /"
            className="w-full rounded-md border border-edge bg-surface py-1.5 pl-8 pr-3 text-[13px] outline-none placeholder:text-faint focus:border-faint"
          />
        </div>
      </div>

      {resumeError && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          {resumeError}
        </div>
      )}

      {nothingMatches ? (
        <EmptyState title={`Nothing matches “${query.trim()}”`} hint="Names, directories, chat titles and session ids are searched" />
      ) : (
        <>
          {shownAgents.length === 0 && !q && !isLoading ? (
            <EmptyState
              icon={<TerminalSquare size={24} />}
              title="Nothing running right now"
              hint="Press ⌘K — or resume a conversation below"
            />
          ) : (
            shownAgents.length > 0 && (
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                {shownAgents.map((agent) => (
                  <div key={refOf(agent)} className={hiddenSet.has(refOf(agent)) ? 'opacity-50' : undefined}>
                    <AgentCard agent={agent} />
                  </div>
                ))}
              </div>
            )
          )}
          {hiddenCount > 0 && !q && (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="mt-3 flex items-center gap-1.5 text-[11px] text-faint hover:text-mut"
              title="hidden agents keep running in tmux — reveal them here to unhide via their ⋮ menu"
            >
              <EyeOff size={11} />
              {showHidden
                ? 'conceal hidden agents'
                : `${hiddenCount} hidden agent${hiddenCount === 1 ? '' : 's'} — show`}
            </button>
          )}

          {shownClosed.length > 0 && (
            <>
              <div className="flex items-baseline gap-3 pb-3 pt-10">
                <h2 className="font-mono text-[14px] font-semibold tracking-tight">Recently closed</h2>
                {!q && <span className="text-[12px] text-faint">u reopens the last one</span>}
              </div>
              <div className="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-surface">
                {shownClosed.map((entry) => (
                  <ClosedAgentRow key={entry.id} entry={entry} onError={setResumeError} />
                ))}
              </div>
            </>
          )}

          {(shownRecents.length > 0 || !q) && (
            <>
              <div className="flex items-baseline justify-between pb-3 pt-10">
                <h2 className="font-mono text-[14px] font-semibold tracking-tight">
                  {q ? 'Matching conversations' : 'Recent conversations'}
                </h2>
                <Link to="/history" className="text-[12px] text-mut hover:text-ink">
                  view all →
                </Link>
              </div>
              <div className="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-surface">
                {shownRecents.map((s) => (
                  <ConversationRow key={`${s.provider}-${s.id}`} session={s} onError={setResumeError} />
                ))}
                {shownRecents.length === 0 && (
                  <div className="px-4 py-8 text-center text-[13px] text-faint">no conversations found</div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
