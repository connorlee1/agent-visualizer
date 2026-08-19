import { NavLink } from 'react-router';
import { Plus, TerminalSquare, History, Grid2x2 } from 'lucide-react';
import { useAgents } from '../../queries';
import { useOpenLaunch } from './AppShell';
import { AgentStatusDot } from '../agents/AgentStatusDot';
import { ThemePicker } from './ThemePicker';
import { ShortcutSheet } from './ShortcutSheet';
import { agentLabel } from '../../lib/format';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium ${
    isActive
      ? 'bg-claude/12 text-ink shadow-[inset_2px_0_0_var(--color-claude)]'
      : 'text-mut hover:bg-surface2 hover:text-ink'
  }`;

export function Sidebar() {
  const { agents } = useAgents();
  const openLaunch = useOpenLaunch();

  return (
    <aside className="flex w-[224px] shrink-0 flex-col border-r border-edge bg-surface">
      <div className="flex items-center gap-2 px-5 pb-4 pt-5">
        <span className="text-claude">◆</span>
        <span className="text-[14px] font-semibold tracking-wide">agents</span>
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={() => openLaunch()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-claude/90 py-2 text-[13px] font-semibold text-on-accent hover:bg-claude"
        >
          <Plus size={15} strokeWidth={2.5} /> New Agent
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-3">
        <NavLink to="/" end className={navClass}>
          <TerminalSquare size={15} className="text-claude" />
          Agents
          {agents.length > 0 && (
            <span className="ml-auto rounded-full bg-claude/15 px-1.5 text-[11px] text-claude">{agents.length}</span>
          )}
        </NavLink>
        <NavLink to="/grid" className={navClass}>
          <Grid2x2 size={15} className="text-[color:var(--ansi-blue)]" />
          Wall
        </NavLink>
        <NavLink to="/history" className={navClass}>
          <History size={15} className="text-[color:var(--ansi-magenta)]" />
          History
        </NavLink>
      </nav>

      {agents.length > 0 && (
        <div className="mt-6 px-3">
          <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-faint">
            Running
          </div>
          <div className="flex flex-col gap-0.5">
            {agents.map((agent) => (
              <NavLink
                key={agent.name}
                to={`/agents/${agent.name}`}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] ${
                    isActive
                      ? 'bg-claude/12 text-ink shadow-[inset_2px_0_0_var(--color-claude)]'
                      : 'text-mut hover:bg-surface2 hover:text-ink'
                  }`
                }
              >
                <AgentStatusDot status={agent.status} />
                <span className="truncate">{agentLabel(agent, agents)}</span>
              </NavLink>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto flex items-center gap-1 px-3 pt-4">
        <div className="min-w-0 flex-1">
          <ThemePicker />
        </div>
        <ShortcutSheet />
      </div>
      <div className="px-6 pb-4 pt-1 text-[10px] text-faint">
        <span className="text-[color:var(--ansi-yellow)]">⌘K</span> new ·{' '}
        <span className="text-[color:var(--ansi-yellow)]">g</span> wall ·{' '}
        <span className="text-[color:var(--ansi-yellow)]">c</span> theme ·{' '}
        <span className="text-[color:var(--ansi-yellow)]">1–9</span> jump ·{' '}
        <span className="text-[color:var(--ansi-yellow)]">?</span> all keys
      </div>
    </aside>
  );
}
