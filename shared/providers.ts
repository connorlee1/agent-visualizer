import type { Provider } from './types';

export const PROVIDERS = ['claude', 'codex', 'kimi'] as const;
export const isProvider = (value: unknown): value is Provider =>
  typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);

export const providerColor: Record<Provider, string> = {
  claude: 'var(--color-claude)',
  codex: 'var(--color-codex)',
  kimi: 'var(--color-kimi, #a78bfa)',
};

export const providerClasses: Record<Provider, string> = {
  claude: 'border-claude/40 bg-claude/10 text-claude',
  codex: 'border-codex/40 bg-codex/10 text-codex',
  kimi: 'border-violet-400/40 bg-violet-400/10 text-violet-400',
};
