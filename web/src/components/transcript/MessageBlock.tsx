import type { ContentBlock, Message, Provider } from '@shared/types';
import { fmtTokens } from '../../lib/format';
import { Markdown } from './Markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallBlock } from './ToolCallBlock';
import { ClampedBlock } from './ClampedBlock';

type ToolResult = Extract<ContentBlock, { kind: 'tool_result' }>;

const timeOf = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

export function MessageBlock({ msg, provider, toolResults, forceToolsOpen, showHeader = true }: {
  msg: Message;
  provider: Provider;
  toolResults: Map<string, ToolResult>;
  forceToolsOpen?: boolean;
  showHeader?: boolean;
}) {
  const accent = provider === 'claude' ? 'var(--color-claude)' : 'var(--color-codex)';

  if (msg.role === 'user') {
    const texts = msg.content.filter((b) => b.kind === 'text');
    if (!texts.length) return null; // tool results render under their tool call
    return (
      <div
        className="rounded-r-md py-2 pl-3 pr-3"
        style={{ borderLeft: `3px solid ${accent}`, background: `color-mix(in srgb, ${accent} 9%, transparent)` }}
      >
        <div className="mb-1 flex items-baseline gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: accent }}>
          ❯ You
          <span className="font-normal normal-case tracking-normal text-faint">{timeOf(msg.timestamp)}</span>
          {msg.hiddenSiblings ? (
            <span className="font-normal normal-case tracking-normal text-faint">⑂ {msg.hiddenSiblings} earlier attempt{msg.hiddenSiblings > 1 ? 's' : ''} hidden</span>
          ) : null}
        </div>
        <ClampedBlock text={texts.map((b) => (b.kind === 'text' ? b.text : '')).join('\n')}>
          <div className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed">
            {texts.map((b, i) => (b.kind === 'text' ? <span key={i}>{b.text}</span> : null))}
          </div>
        </ClampedBlock>
      </div>
    );
  }

  return (
    <div className="py-0.5">
      {showHeader && (
        <div className="mb-1 flex items-baseline gap-2 pt-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-mut">
          <span style={{ color: accent }}>⏺</span> Assistant
          <span className="font-normal normal-case tracking-normal text-faint">{timeOf(msg.timestamp)}</span>
          {msg.model && <span className="font-mono font-normal text-[color:var(--ansi-cyan)]">{msg.model.replace(/^claude-/, '')}</span>}
          {msg.usage?.outputTokens != null && (
            <span className="font-normal text-faint">{fmtTokens(msg.usage.outputTokens)} tok</span>
          )}
          {msg.hiddenSiblings ? (
            <span className="font-normal text-faint">⑂ {msg.hiddenSiblings} earlier attempt{msg.hiddenSiblings > 1 ? 's' : ''} hidden</span>
          ) : null}
        </div>
      )}
      {msg.content.map((block, i) => {
        switch (block.kind) {
          case 'text':
            return <Markdown key={i} text={block.text} />;
          case 'thinking':
            return <ThinkingBlock key={i} text={block.text} />;
          case 'tool_use':
            return (
              <ToolCallBlock
                key={i}
                name={block.name}
                input={block.input}
                result={toolResults.get(block.toolId)}
                forceOpen={forceToolsOpen}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
