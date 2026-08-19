import type { Provider } from '@shared/types';

/** What a secondary panel shows: a running agent's terminal, or a conversation. */
export type PanelRef =
  | { kind: 'term'; name: string }
  | { kind: 'chat'; provider: Provider; id: string };

export const encodePanelRef = (p: PanelRef): string =>
  p.kind === 'term' ? `term:${p.name}` : `chat:${p.provider}:${p.id}`;

export function decodePanelRef(s: string | null): PanelRef | null {
  if (!s) return null;
  const parts = s.split(':');
  if (parts[0] === 'term' && parts[1]) return { kind: 'term', name: parts[1] };
  if (parts[0] === 'chat' && (parts[1] === 'claude' || parts[1] === 'codex') && parts[2]) {
    return { kind: 'chat', provider: parts[1], id: parts[2] };
  }
  return null;
}
