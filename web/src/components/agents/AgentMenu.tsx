import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Pencil } from 'lucide-react';
import type { TmuxAgent } from '@shared/types';
import { renameAgent } from '../../lib/api';
import { hostOf, isRemoteHost, refOf } from '../../lib/agentRef';
import { basename, shortPath, truncate } from '../../lib/format';
import { useLinkedSession, useLinkedSummary } from '../../lib/useLinkedSession';

function MenuRow({ label, value, hint, onClick }: {
  label: string;
  value: ReactNode;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-surface2"
    >
      <span className="text-[9px] font-semibold uppercase tracking-widest text-faint">{label}</span>
      <span className="w-full truncate font-mono text-[11px] text-mut">{value}</span>
    </button>
  );
}

/**
 * Kebab menu on an agent: rename it, and the details a custom name hides —
 * working directory, linked conversation, raw tmux session name.
 */
export function AgentMenu({ agent }: { agent: TmuxAgent }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const linked = useLinkedSession(agent);
  const summary = useLinkedSummary(agent);

  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setRenaming(false);
    setError(null);
  };

  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };

  const startRename = () => {
    setDraft(agent.title ?? '');
    setRenaming(true);
  };

  const saveRename = async () => {
    try {
      await renameAgent(refOf(agent), draft.trim());
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const defaultLabel = agent.cwd ? basename(agent.cwd) : agent.name;

  return (
    // stopPropagation: this menu lives inside clickable cards/headers
    <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => (open ? close() : setOpen(true))}
        className="rounded p-1 text-mut hover:bg-surface2 hover:text-ink"
        title="agent options"
      >
        <MoreVertical size={13} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute right-0 top-full z-50 mt-1 w-[264px] rounded-md border border-edge bg-surface py-1 text-left shadow-2xl">
            {renaming ? (
              <form
                className="px-2 py-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveRename();
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') close();
                  }}
                  maxLength={60}
                  placeholder={defaultLabel}
                  className="w-full rounded border border-edge bg-bg px-2 py-1 text-[12px] text-ink outline-none placeholder:text-faint focus:border-claude/70"
                />
                <div className="flex items-center justify-between pt-1.5">
                  <span className="text-[10px] text-faint">enter to save · empty resets</span>
                  <button type="submit" className="rounded border border-edge px-2 py-0.5 text-[11px] text-mut hover:text-ink">
                    Save
                  </button>
                </div>
                {error && <div className="pt-1 text-[11px] text-red-400">{error}</div>}
              </form>
            ) : (
              <>
                <button
                  onClick={startRename}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface2"
                >
                  <Pencil size={12} /> Rename…
                </button>
                <div className="my-1 border-t border-edge" />
                {agent.cwd && (
                  <MenuRow
                    label={copied === 'dir' ? 'directory · copied' : 'directory'}
                    value={shortPath(agent.cwd)}
                    hint="click to copy path"
                    onClick={() => copy('dir', agent.cwd!)}
                  />
                )}
                {linked && (
                  <MenuRow
                    label={`conversation · ${linked.provider}`}
                    value={
                      <>
                        {summary?.title ? `${truncate(summary.title, 28)} ` : ''}
                        <span className="text-faint">#{linked.id.slice(0, 8)}</span>
                      </>
                    }
                    hint={`open transcript (${linked.id})`}
                    onClick={() => {
                      close();
                      navigate(`/s/${linked.provider}/${linked.id}${isRemoteHost(agent.host) ? `?host=${agent.host}` : ''}`);
                    }}
                  />
                )}
                {isRemoteHost(agent.host) && (
                  <MenuRow
                    label="machine"
                    value={hostOf(agent)}
                    hint="this agent runs on a remote machine (via ssh tunnel)"
                    onClick={() => {}}
                  />
                )}
                <MenuRow
                  label={copied === 'tmux' ? 'tmux session · copied' : 'tmux session'}
                  value={agent.name}
                  hint={
                    isRemoteHost(agent.host)
                      ? `click to copy — attach on ${hostOf(agent)} with: tmux attach -t ${agent.name}`
                      : `click to copy — attach with: tmux attach -t ${agent.name}`
                  }
                  onClick={() => copy('tmux', agent.name)}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
