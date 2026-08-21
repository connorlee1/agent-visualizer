import { LOCAL_HOST } from '@shared/types';

export { LOCAL_HOST };

/**
 * Agent identity across machines. A ref is "host:name" for remote agents and
 * the bare tmux name for local ones — tmux names can't contain ":", so the
 * encoding is unambiguous, and local refs match what pre-multihost
 * localStorage (wall order, panels, mute list) already stored.
 */
export const hostOf = (a: { host?: string }): string => a.host ?? LOCAL_HOST;

export const isRemoteHost = (host?: string): boolean => !!host && host !== LOCAL_HOST;

export const makeRef = (host: string, name: string): string =>
  isRemoteHost(host) ? `${host}:${name}` : name;

export const refOf = (a: { host?: string; name: string }): string => makeRef(hostOf(a), a.name);

export function parseRef(ref: string): { host: string; name: string } {
  const i = ref.indexOf(':');
  return i > 0 ? { host: ref.slice(0, i), name: ref.slice(i + 1) } : { host: LOCAL_HOST, name: ref };
}
