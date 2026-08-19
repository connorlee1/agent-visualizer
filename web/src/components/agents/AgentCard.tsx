import { useNavigate } from 'react-router';
import type { Provider } from '@shared/types';
import type { AgentWithStatus } from '../../queries';
import { STATUS_LABEL, STATUS_COLOR } from '../../lib/status';
import { basename, uptime } from '../../lib/format';
import { dimmed } from '../../lib/dirColor';
import { useDirColor } from '../../lib/useDirColor';
import { AgentStatusDot } from './AgentStatusDot';
import { AgentMenu } from './AgentMenu';
import { PanePreview } from './PanePreview';

const providerColor: Record<Provider, string> = {
  claude: 'var(--color-claude)',
  codex: 'var(--color-codex)',
};

// Idle long enough that you've likely lost the thread — show the recap.
const RECAP_IDLE_MS = 60_000;

export function AgentCard({ agent }: { agent: AgentWithStatus }) {
  const navigate = useNavigate();
  const needsApproval = agent.status === 'needs-approval';
  const tint = useDirColor(agent.cwd);
  const open = () => navigate(`/agents/${agent.name}`);
  const showRecap =
    agent.status === 'waiting' &&
    agent.lastWriteMs != null &&
    Date.now() - agent.lastWriteMs > RECAP_IDLE_MS &&
    (agent.idleSummary || agent.lastPrompt || agent.lastAgentMessage);

  return (
    // div, not button: the kebab menu inside needs its own buttons
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
      }}
      className={`w-full cursor-pointer rounded-xl border bg-surface text-left transition-colors hover:bg-surface2 ${
        needsApproval ? 'pulse-alert-border border-alert' : 'border-edge'
      }`}
      style={{
        // per-directory tint on the sides/bottom; provider color keeps the top
        borderColor: tint && !needsApproval ? dimmed(tint) : undefined,
        borderTopWidth: 2,
        borderTopColor: agent.provider ? providerColor[agent.provider] : undefined,
      }}
    >
      <div className="flex items-center gap-2.5 px-4 pb-2.5 pt-3.5">
        <AgentStatusDot status={agent.status} />
        <span className="truncate text-[14px] font-semibold" title={agent.cwd}>
          {agent.title ?? (agent.cwd ? basename(agent.cwd) : agent.name)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-faint">{uptime(agent.createdAt)}</span>
        <AgentMenu agent={agent} />
      </div>
      <div className="px-3 pb-3">
        <PanePreview ansi={agent.preview} />
      </div>
      {showRecap && (
        <div className="mx-3 mb-3 rounded-lg border border-edge bg-surface2 px-3 py-2 text-[12px] leading-snug">
          {agent.idleSummary ? (
            // LLM recap of what this agent was doing; raw last-exchange shown while it generates
            <div className="line-clamp-4" title={agent.idleSummary}>
              <span className="text-faint">recap · </span>
              {agent.idleSummary}
            </div>
          ) : (
            <>
              {agent.lastPrompt && (
                <div className="line-clamp-2 text-mut" title={agent.lastPrompt}>
                  <span className="text-faint">you asked · </span>
                  {agent.lastPrompt}
                </div>
              )}
              {agent.lastAgentMessage && (
                <div className={`line-clamp-3 text-mut ${agent.lastPrompt ? 'mt-1' : ''}`} title={agent.lastAgentMessage}>
                  <span className="text-faint">it replied · </span>
                  {agent.lastAgentMessage}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div className="flex items-center border-t border-edge px-4 py-2 text-[12px]">
        <span style={{ color: STATUS_COLOR[agent.status] }}>
          {needsApproval && '⚠ '}
          {STATUS_LABEL[agent.status]}
        </span>
        {agent.provider && (
          <span className="ml-auto text-[11px]" style={{ color: providerColor[agent.provider] }}>
            {agent.provider}
          </span>
        )}
      </div>
    </div>
  );
}
