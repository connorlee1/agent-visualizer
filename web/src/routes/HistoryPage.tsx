import { useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { Play, Search } from 'lucide-react';
import type { Provider } from '@shared/types';
import { useProjects, useRecentSessions, useSessions } from '../queries';
import { useOpenLaunch } from '../components/shell/AppShell';
import { ConversationRow } from '../components/projects/ConversationRow';
import { ActivitySparkbars } from '../components/projects/ActivitySparkbars';
import { EmptyState } from '../components/ui/EmptyState';
import { shortPath } from '../lib/format';

type ProviderFilter = 'all' | Provider;

const railClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] ${
    isActive
      ? 'bg-claude/12 text-ink shadow-[inset_2px_0_0_var(--color-claude)]'
      : 'text-mut hover:bg-surface2 hover:text-ink'
  }`;

export function HistoryPage() {
  const { projectId } = useParams();
  const { data: projects } = useProjects();
  const selected = projects?.find((p) => p.id === projectId);
  const openLaunch = useOpenLaunch();

  const allQuery = useRecentSessions(500);
  const projectQuery = useSessions(selected?.path ?? '');
  const sessions = selected ? projectQuery.data : allQuery.data;

  const [filter, setFilter] = useState<ProviderFilter>('all');
  const [search, setSearch] = useState('');
  const [resumeError, setResumeError] = useState<string | null>(null);

  const shown = useMemo(() => {
    let list = sessions ?? [];
    if (filter !== 'all') list = list.filter((s) => s.provider === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        s.title.toLowerCase().includes(q)
        || s.projectPath.toLowerCase().includes(q)
        || s.agentName?.toLowerCase().includes(q)
        || s.id.toLowerCase().includes(q));
    }
    return list;
  }, [sessions, filter, search]);

  return (
    <div className="flex h-full">
      <div className="w-[224px] shrink-0 overflow-y-auto border-r border-edge px-3 py-5">
        <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-faint">Projects</div>
        <NavLink to="/history" end className={railClass}>
          All projects
        </NavLink>
        {projects?.map((p) => (
          <NavLink key={p.id} to={`/history/${p.id}`} className={railClass}>
            <span className="truncate">{p.name}</span>
            <span className="ml-auto text-[11px] text-faint">{p.sessionCount}</span>
          </NavLink>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 py-8">
          <div className="flex items-center gap-3 pb-1">
            <span className="h-[16px] w-[3px] shrink-0 self-center rounded-full bg-claude" />
            <h1 className="truncate text-[18px] font-semibold">{selected ? selected.name : 'All conversations'}</h1>
            {selected && (
              <button
                onClick={() => openLaunch({ cwd: selected.path })}
                className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-[12px] text-mut hover:text-ink"
              >
                <Play size={11} /> New agent here
              </button>
            )}
          </div>
          {selected && (
            <div className="flex items-center gap-4 pb-2">
              <span className="truncate font-mono text-[11px] text-faint">{shortPath(selected.path)}</span>
              <ActivitySparkbars weeks={selected.weeklyActivity} />
            </div>
          )}

          <div className="flex items-center gap-2 pb-4 pt-3">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search conversations…"
                className="w-full rounded-md border border-edge bg-surface py-1.5 pl-8 pr-3 text-[13px] outline-none placeholder:text-faint focus:border-faint"
              />
            </div>
            <div className="flex shrink-0 overflow-hidden rounded-md border border-edge">
              {(['all', 'claude', 'codex'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 text-[12px] ${
                    filter === f
                      ? `bg-surface2 ${f === 'claude' ? 'text-claude' : f === 'codex' ? 'text-codex' : 'text-ink'}`
                      : 'text-mut hover:text-ink'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {resumeError && (
            <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
              {resumeError}
            </div>
          )}

          {shown.length === 0 ? (
            <EmptyState title="No conversations match" />
          ) : (
            <div className="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-surface">
              {shown.map((s) => (
                <ConversationRow
                  key={`${s.provider}-${s.id}`}
                  session={s}
                  showProject={!selected}
                  onError={setResumeError}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
