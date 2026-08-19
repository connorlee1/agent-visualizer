export function terminalSocketUrl(name: string, cols: number, rows: number): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/terminal/${encodeURIComponent(name)}?cols=${cols}&rows=${rows}`;
}
