import { useMemo, useRef, useState } from 'react';
import { Layers, TerminalSquare } from 'lucide-react';
import type { TmuxAgent } from '@shared/types';
import { useAgents } from '../queries';
import { basename } from '../lib/format';
import { dirColorMap, dimmed } from '../lib/dirColor';
import { SidePanel } from '../components/panel/SidePanel';
import { EmptyState } from '../components/ui/EmptyState';

const dirOf = (a: TmuxAgent) => a.cwd ?? '';

function orderedNames(agents: TmuxAgent[], order: string[]): string[] {
  const rank = new Map(order.map((n, i) => [n, i]));
  return [...agents]
    .sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9))
    .map((a) => a.name);
}

/**
 * The wall: every running agent tiled on screen at once. Drag a tile's title
 * bar onto another tile to rearrange; the order persists. When more than one
 * project is running, a toolbar filters by directory (chips, colored like the
 * tile borders) and "group" clusters same-directory tiles together — groups
 * follow the drag order of their first tile.
 */
export function GridPage() {
  const { agents } = useAgents();
  const [order, setOrder] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('wallOrder') ?? '[]');
    } catch {
      return [];
    }
  });
  const [groupByDir, setGroupByDir] = useState(() => localStorage.getItem('wallGroupByDir') !== '0');
  const [dirFilter, setDirFilter] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('wallDirFilter') ?? '[]');
    } catch {
      return [];
    }
  });
  const [draggingName, setDraggingName] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const dirs = useMemo(() => [...new Set(agents.map(dirOf))].sort(), [agents]);
  const colors = useMemo(() => dirColorMap(agents.map((a) => a.cwd)), [agents]);

  const toggleDir = (d: string) =>
    setDirFilter((prev) => {
      const next = prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d];
      localStorage.setItem('wallDirFilter', JSON.stringify(next));
      return next;
    });

  const toggleGroup = () => {
    const next = !groupByDir;
    localStorage.setItem('wallGroupByDir', next ? '1' : '0');
    setGroupByDir(next);
  };

  const reorder = (src: string, dst: string) => {
    setOrder((prev) => {
      const names = orderedNames(agentsRef.current, prev);
      const from = names.indexOf(src);
      const to = names.indexOf(dst);
      if (from < 0 || to < 0 || from === to) return prev;
      names.splice(to, 0, ...names.splice(from, 1));
      localStorage.setItem('wallOrder', JSON.stringify(names));
      return names;
    });
  };

  const startDrag = (name: string, e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-pane-header]') || target.closest('button,select,input,textarea')) return;
    e.preventDefault();
    dragRef.current = name;
    setDraggingName(name);
    const onMove = (ev: PointerEvent) => {
      const tile = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)
        ?.closest('[data-tile]') as HTMLElement | null;
      const over = tile?.dataset.tile;
      if (over && dragRef.current && over !== dragRef.current) reorder(dragRef.current, over);
    };
    const onUp = () => {
      dragRef.current = null;
      setDraggingName(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-[360px]">
          <EmptyState
            icon={<TerminalSquare size={24} />}
            title="Nothing running to tile"
            hint="Press ⌘K to launch an agent"
          />
        </div>
      </div>
    );
  }

  // Stale filter entries (all of a project's agents exited) are ignored.
  const activeFilter = dirFilter.filter((d) => dirs.includes(d));
  const shown = activeFilter.length ? agents.filter((a) => activeFilter.includes(dirOf(a))) : agents;
  const cols = shown.length === 1 ? 1 : shown.length <= 4 ? 2 : 3;
  const byName = new Map(agents.map((a) => [a.name, a]));

  let names = orderedNames(shown, order);
  if (groupByDir) {
    const rank = new Map(names.map((nm, i) => [nm, i]));
    const groupRank = new Map<string, number>();
    for (const nm of names) {
      const d = dirOf(byName.get(nm)!);
      if (!groupRank.has(d)) groupRank.set(d, rank.get(nm)!);
    }
    names = [...names].sort(
      (a, b) =>
        groupRank.get(dirOf(byName.get(a)!))! - groupRank.get(dirOf(byName.get(b)!))! ||
        rank.get(a)! - rank.get(b)!,
    );
  }

  return (
    <div className="flex h-full flex-col">
      {dirs.length > 1 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-edge bg-surface px-2 py-1.5">
          {dirs.map((d) => {
            const color = colors.get(d) ?? 'var(--color-mut)';
            const active = activeFilter.includes(d);
            const count = agents.filter((a) => dirOf(a) === d).length;
            return (
              <button
                key={d}
                onClick={() => toggleDir(d)}
                title={d || 'no directory'}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors ${
                  active ? 'text-ink' : 'text-mut hover:text-ink'
                }`}
                style={{
                  borderColor: active ? color : dimmed(color),
                  backgroundColor: active ? `color-mix(in srgb, ${color} 18%, transparent)` : undefined,
                }}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {d ? basename(d) : 'other'}
                <span className="text-faint">{count}</span>
              </button>
            );
          })}
          {activeFilter.length > 0 && (
            <button
              onClick={() => {
                setDirFilter([]);
                localStorage.setItem('wallDirFilter', '[]');
              }}
              className="rounded px-1.5 py-0.5 text-[11px] text-faint hover:text-ink"
            >
              clear
            </button>
          )}
          <button
            onClick={toggleGroup}
            title="cluster tiles from the same directory together"
            className={`ml-auto flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
              groupByDir ? 'border-claude/60 bg-claude/10 text-claude' : 'border-edge text-mut hover:text-ink'
            }`}
          >
            <Layers size={12} />
            group
          </button>
        </div>
      )}
      <div
        className={`min-h-0 flex-1 p-[3px] ${draggingName ? 'select-none' : ''}`}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: 'minmax(0, 1fr)',
        }}
      >
        {names.map((name) => {
          const agent = byName.get(name);
          if (!agent) return null;
          return (
            <div
              key={name}
              data-tile={name}
              onPointerDown={(e) => startDrag(name, e)}
              className={`min-h-0 min-w-0 transition-opacity [&_[data-pane-header]]:cursor-grab ${
                draggingName === name ? 'opacity-60' : ''
              }`}
            >
              <SidePanel panel={{ kind: 'term', name }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
