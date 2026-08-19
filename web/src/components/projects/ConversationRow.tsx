import { useNavigate } from 'react-router';
import { Play } from 'lucide-react';
import type { SessionSummary } from '@shared/types';
import { basename, relTime } from '../../lib/format';
import { useResume } from '../../lib/useResume';

/** One conversation: provider dot, title, one muted meta line. Everything else lives in the reader. */
export function ConversationRow({ session, showProject = true, onError }: {
  session: SessionSummary;
  showProject?: boolean;
  onError?: (msg: string) => void;
}) {
  const navigate = useNavigate();
  const { resume, busyId } = useResume();
  const untitled = session.title === 'Untitled conversation';
  const dotColor = session.provider === 'claude' ? 'var(--color-claude)' : 'var(--color-codex)';

  return (
    <div
      onClick={() => navigate(`/s/${session.provider}/${session.id}`)}
      className="group flex cursor-pointer items-center gap-3.5 px-4 py-3 hover:bg-surface2"
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
        title={session.provider}
      />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[14px] ${untitled ? 'text-faint' : 'font-medium text-ink'}`}>
          {session.title}
        </div>
        <div className="truncate pt-0.5 text-[12px] text-faint">
          {showProject && <>{basename(session.projectPath)} · </>}
          {session.agentName && <>named <span className="text-mut">“{session.agentName}”</span> · </>}
          {relTime(session.lastActivityAt)}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void resume(session.provider, session.id).then((msg) => msg && onError?.(msg));
        }}
        disabled={busyId === session.id}
        className="invisible flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[12px] text-mut hover:text-ink group-hover:visible disabled:opacity-50"
      >
        <Play size={11} /> {busyId === session.id ? '…' : 'Resume'}
      </button>
    </div>
  );
}
