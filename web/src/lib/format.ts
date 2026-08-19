export function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function uptime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTokens(n: number | undefined): string {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

type Labelable = { name: string; cwd?: string; title?: string };

/** Display label: custom title first, else directory name; duplicates get the session id tail. */
export function agentLabel(agent: Labelable, all: Labelable[]): string {
  const labelOf = (a: Labelable) => a.title || (a.cwd ? basename(a.cwd) : a.name);
  const base = labelOf(agent);
  const dup = all.some((o) => o.name !== agent.name && labelOf(o) === base);
  return dup ? `${base}·${agent.name.slice(-4)}` : base;
}

export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

export const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function encodeProjectId(path: string): string {
  return btoa(path).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeProjectId(id: string): string {
  const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

export function timeRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return `${start.toLocaleString(undefined, opts)} → ${end.toLocaleString(undefined, opts)}`;
}
