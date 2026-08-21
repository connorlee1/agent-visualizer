import type { Provider } from '@shared/types';
import { isRemoteHost, LOCAL_HOST } from './agentRef';

/**
 * What a secondary panel shows: a running agent's terminal (by agent ref,
 * which is "host:name" for remote machines), or a conversation (optionally
 * on a remote machine).
 */
export type PanelRef =
  | { kind: 'term'; name: string }
  | { kind: 'chat'; provider: Provider; id: string; host?: string };

export const encodePanelRef = (p: PanelRef): string =>
  p.kind === 'term'
    ? `term:${p.name}`
    : `chat:${p.provider}:${p.id}${isRemoteHost(p.host) ? `:${p.host}` : ''}`;

export function decodePanelRef(s: string | null): PanelRef | null {
  if (!s) return null;
  // term names are agent refs and may themselves contain ":" — split only the tag
  if (s.startsWith('term:') && s.length > 5) return { kind: 'term', name: s.slice(5) };
  const parts = s.split(':');
  if (parts[0] === 'chat' && (parts[1] === 'claude' || parts[1] === 'codex') && parts[2]) {
    return { kind: 'chat', provider: parts[1], id: parts[2], host: parts[3] || LOCAL_HOST };
  }
  return null;
}
