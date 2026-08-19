import type { Provider } from '@shared/types';

export function ProviderBadge({ provider }: { provider: Provider }) {
  const cls =
    provider === 'claude'
      ? 'border-claude/40 bg-claude/10 text-claude'
      : 'border-codex/40 bg-codex/10 text-codex';
  return (
    <span className={`rounded border px-1.5 py-px font-mono text-[10px] ${cls}`}>{provider}</span>
  );
}
