import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUpRight, MessageSquare, SquareTerminal, X } from 'lucide-react';
import { useAgents, useKillAgent, useTranscript } from '../../queries';
import type { PanelRef } from '../../lib/panelRef';
import { agentLabel, truncate } from '../../lib/format';
import { useDirColor } from '../../lib/useDirColor';
import { useLinkedSession, useLinkedSummary } from '../../lib/useLinkedSession';
import { useDoneFlash } from '../../lib/useDoneFlash';
import { STATUS_COLOR, STATUS_LABEL } from '../../lib/status';
import { AgentStatusDot } from '../agents/AgentStatusDot';
import { AgentMenu } from '../agents/AgentMenu';
import { ModelEffortMenu } from '../agents/ModelEffortMenu';
import { SnoozeButton } from '../agents/SnoozeButton';
import { XtermPane } from '../terminal/XtermPane';
import { TranscriptView } from '../transcript/TranscriptView';
import { ChatPane } from '../chat/ChatPane';
import { Pane } from '../ui/Pane';
import { ConfirmButton } from '../ui/ConfirmButton';

/**
 * Secondary pane: a running agent (as a chat with composer, flippable to its
 * raw terminal) or a past conversation transcript.
 */
export function SidePanel({ panel, onClose }: { panel: PanelRef; onClose?: () => void }) {
  const navigate = useNavigate();
  const { agents } = useAgents();
  const killNow = useKillAgent();
  const [view, setView] = useState<'chat' | 'term'>('chat');

  const chat = panel.kind === 'chat' ? panel : null;
  const transcript = useTranscript(chat?.provider, chat?.id, true);

  const agent = panel.kind === 'term' ? agents.find((a) => a.name === panel.name) : undefined;
  const linked = useLinkedSession(agent);
  const summary = useLinkedSummary(agent);
  // any managed agent is chattable — the composer relays through tmux, no
  // conversation needed. A fresh codex has NO session file until its first
  // message, so gating on `linked` would strand it as a bare terminal.
  const chattable = !!agent?.provider;
  const tint = useDirColor(agent?.cwd ?? transcript.data?.session.projectPath);
  const doneFlash = useDoneFlash(agent?.name);
  const showChat = panel.kind === 'term' && chattable && view === 'chat';

  const title =
    panel.kind === 'term' ? (
      <>
        {agent ? agentLabel(agent, agents) : panel.name}
        {agent && (
          <span className="ml-2" style={{ color: STATUS_COLOR[agent.status] }}>
            {STATUS_LABEL[agent.status]}
          </span>
        )}
        {agent && <ModelEffortMenu agent={agent} summary={summary} className="ml-2 text-faint" />}
      </>
    ) : (
      truncate(transcript.data?.session.title ?? 'conversation', 60)
    );
  const fullHref = panel.kind === 'term' ? `/agents/${panel.name}` : `/s/${panel.provider}/${panel.id}`;
  const dotColor = chat ? (chat.provider === 'claude' ? 'var(--color-claude)' : 'var(--color-codex)') : undefined;

  const actions = (
    <>
      {agent && <SnoozeButton name={agent.name} muted={doneFlash.muted} />}
      {agent && (
        <ConfirmButton
          label="Kill"
          confirmLabel="Really kill this agent?"
          description={agent.name}
          onConfirm={() => void killNow(agent.name)}
          className="mr-1"
        />
      )}
      {panel.kind === 'term' && chattable && (
        <button
          data-flip-view
          onClick={() => setView((v) => (v === 'chat' ? 'term' : 'chat'))}
          className="rounded p-1 text-mut hover:bg-surface2 hover:text-ink"
          title={view === 'chat' ? 'show raw terminal (⌥T)' : 'show chat (⌥T)'}
        >
          {view === 'chat' ? <SquareTerminal size={13} /> : <MessageSquare size={13} />}
        </button>
      )}
      <button
        onClick={() => navigate(fullHref)}
        className="rounded p-1 text-mut hover:bg-surface2 hover:text-ink"
        title="open full view"
      >
        <ArrowUpRight size={13} />
      </button>
      {onClose && (
        <button
          onClick={onClose}
          className="rounded p-1 text-mut hover:bg-surface2 hover:text-ink"
          title="close panel"
        >
          <X size={13} />
        </button>
      )}
      {agent && <AgentMenu agent={agent} />}
    </>
  );

  return (
    <Pane
      agentName={agent?.name}
      icon={
        agent ? (
          <AgentStatusDot status={agent.status} />
        ) : dotColor ? (
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
        ) : undefined
      }
      title={title}
      alert={agent?.status === 'needs-approval'}
      flash={doneFlash.flash}
      remind={doneFlash.remind}
      dim={!!agent && doneFlash.muted}
      tint={tint}
      actions={actions}
    >
      {panel.kind === 'term' ? (
        agent ? (
          showChat ? (
            <ChatPane agent={agent} />
          ) : (
            <XtermPane key={panel.name} name={panel.name} />
          )
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-faint">
            agent is no longer running
          </div>
        )
      ) : (
        <TranscriptView
          messages={transcript.data?.messages ?? []}
          provider={panel.provider}
          live
          narrow
        />
      )}
    </Pane>
  );
}
