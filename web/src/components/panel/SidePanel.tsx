import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUpRight, MessageSquare, SquareTerminal, X } from 'lucide-react';
import { useAgents, useKillAgent, useTranscript } from '../../queries';
import type { PanelRef } from '../../lib/panelRef';
import { isRemoteHost, refOf, LOCAL_HOST } from '../../lib/agentRef';
import { agentLabel, truncate } from '../../lib/format';
import { useDirColor } from '../../lib/useDirColor';
import { altLabel } from '../../lib/keys';
import { useLinkedSession, useLinkedSummary } from '../../lib/useLinkedSession';
import { useDoneFlash } from '../../lib/useDoneFlash';
import { STATUS_COLOR, STATUS_GLYPH, STATUS_SHORT } from '../../lib/status';
import { AgentStatusDot } from '../agents/AgentStatusDot';
import { AgentMenu } from '../agents/AgentMenu';
import { ModelEffortMenu } from '../agents/ModelEffortMenu';
import { SnoozeButton } from '../agents/SnoozeButton';
import { WorkingTimer } from '../agents/WorkingTimer';
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
  const transcript = useTranscript(chat?.provider, chat?.id, true, chat?.host ?? LOCAL_HOST);

  // term panel names are agent refs ("host:name" on remote machines)
  const agent = panel.kind === 'term' ? agents.find((a) => refOf(a) === panel.name) : undefined;
  const agentRef = agent ? refOf(agent) : undefined;
  const linked = useLinkedSession(agent);
  const summary = useLinkedSummary(agent);
  // any managed agent is chattable — the composer relays through tmux, no
  // conversation needed. A fresh codex has NO session file until its first
  // message, so gating on `linked` would strand it as a bare terminal.
  const chattable = !!agent?.provider;
  const tint = useDirColor(agent?.cwd ?? transcript.data?.session.projectPath);
  const doneFlash = useDoneFlash(agentRef);
  const showChat = panel.kind === 'term' && chattable && view === 'chat';

  const title =
    panel.kind === 'term' ? (
      <>
        {agent ? agentLabel(agent, agents) : panel.name}
        {agent && isRemoteHost(agent.host) && (
          <span className="ml-1.5 rounded-sm border border-edge bg-surface2 px-1 py-px text-[8.5px] font-semibold uppercase tracking-[0.08em] text-mut">
            {agent.host}
          </span>
        )}
        {agent && (
          <span
            className="ml-2 text-[9.5px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: STATUS_COLOR[agent.status] }}
          >
            {STATUS_GLYPH[agent.status]} {STATUS_SHORT[agent.status]}
            {agent.status === 'working' && <WorkingTimer name={agentRef!} />}
          </span>
        )}
        {agent && <ModelEffortMenu agent={agent} summary={summary} className="ml-2 text-faint" />}
      </>
    ) : (
      truncate(transcript.data?.session.title ?? 'conversation', 60)
    );
  const fullHref =
    panel.kind === 'term'
      ? `/agents/${encodeURIComponent(panel.name)}`
      : `/s/${panel.provider}/${panel.id}${isRemoteHost(panel.host) ? `?host=${panel.host}` : ''}`;
  const dotColor = chat ? (chat.provider === 'claude' ? 'var(--color-claude)' : 'var(--color-codex)') : undefined;

  const actions = (
    <>
      {agent && <SnoozeButton name={agentRef!} muted={doneFlash.muted} />}
      {agent && (
        <ConfirmButton
          label="Kill"
          confirmLabel="Really kill this agent?"
          description={agentRef}
          onConfirm={() => void killNow(agentRef!)}
          className="mr-1"
        />
      )}
      {panel.kind === 'term' && chattable && (
        <button
          data-flip-view
          onClick={() => setView((v) => (v === 'chat' ? 'term' : 'chat'))}
          className="rounded p-1 text-mut hover:bg-surface2 hover:text-ink"
          title={view === 'chat' ? `show raw terminal (${altLabel('T')})` : `show chat (${altLabel('T')})`}
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
      agentName={agentRef}
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
          host={panel.host}
          live
          narrow
        />
      )}
    </Pane>
  );
}
