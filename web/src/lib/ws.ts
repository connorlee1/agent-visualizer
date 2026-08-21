import { isRemoteHost, parseRef } from './agentRef';

/** Terminal socket for an agent ref — remote agents route through the ws bridge. */
export function terminalSocketUrl(ref: string, cols: number, rows: number): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const { host, name } = parseRef(ref);
  const path = isRemoteHost(host)
    ? `/ws/h/${host}/terminal/${encodeURIComponent(name)}`
    : `/ws/terminal/${encodeURIComponent(name)}`;
  return `${proto}://${location.host}${path}?cols=${cols}&rows=${rows}`;
}
