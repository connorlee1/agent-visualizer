import { useState } from 'react';
import { useNavigate } from 'react-router';
import { RotateCcw, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClosedAgent } from '@shared/types';
import { dismissClosedAgent } from '../../lib/api';
import { basename, relTime, shortPath } from '../../lib/format';
import { useResume } from '../../lib/useResume';

/** One closed agent: provider dot, label, when it closed — and a one-click Resume. */
export function ClosedAgentRow({ entry, onError }: {
  entry: ClosedAgent;
  onError?: (msg: string) => void;
}) {
  const navigate = useNavigate();
  const { resume, busyId } = useResume();
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => dismissClosedAgent(entry.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['closed-agents'] }),
  });
  // without a session id there is no conversation to reopen — show it, but inert
  const resumable = !!entry.provider && !!entry.sessionId;
  const label = entry.title || (entry.cwd ? basename(entry.cwd) : entry.name);
  const dotColor = entry.provider === 'codex' ? 'var(--color-codex)' : 'var(--color-claude)';

  return (
    <div
      onClick={() => resumable && navigate(`/s/${entry.provider}/${entry.sessionId}`)}
      className={`group flex items-center gap-3.5 px-4 py-3 hover:bg-surface2 ${resumable ? 'cursor-pointer' : ''}`}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full opacity-60"
        style={{ backgroundColor: dotColor }}
        title={entry.provider}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{label}</div>
        <div className="truncate pt-0.5 text-[12px] text-faint">
          {entry.cwd && <>{shortPath(entry.cwd)} · </>}
          {entry.sessionId && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard.writeText(entry.sessionId!);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                title={`${entry.conversationTitle ? `chat “${entry.conversationTitle}” — ` : ''}click to copy id · manual resume (from the directory above): ${
                  entry.provider === 'codex' ? `codex resume ${entry.sessionId}` : `claude --resume ${entry.sessionId}`
                }`}
                className="font-mono hover:text-ink"
              >
                {copied ? 'id copied' : entry.sessionId}
              </button>
              {' · '}
            </>
          )}
          closed {relTime(entry.closedAt)}
        </div>
      </div>
      {resumable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void resume(entry.provider!, entry.sessionId!).then((msg) => msg && onError?.(msg));
          }}
          disabled={busyId === entry.sessionId}
          className="invisible flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[12px] text-mut hover:text-ink group-hover:visible disabled:opacity-50"
        >
          <RotateCcw size={11} /> {busyId === entry.sessionId ? '…' : 'Resume'}
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          dismiss.mutate();
        }}
        title="Dismiss"
        className="invisible shrink-0 rounded-md p-1 text-faint hover:bg-surface2 hover:text-ink group-hover:visible"
      >
        <X size={13} />
      </button>
    </div>
  );
}
