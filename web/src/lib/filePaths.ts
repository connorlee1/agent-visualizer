/**
 * Extracting viewable file paths from tool call inputs.
 *
 * Lives outside the component files on purpose: these are pure helpers, and
 * exporting non-components from a component module breaks Fast Refresh —
 * a hot update then leaves the transcript rendering a stale module.
 */

/** Absolute or ~-rooted paths with a file extension, as written in a command. */
const PATH_RE = /(?:^|[\s'"=<>|;(])((?:~|\/)[\w./@+-]*\/[\w.@+-]+\.[A-Za-z0-9]{1,8})/g;

/** Keys the structured file tools (Read, Edit, Write, NotebookEdit) use. */
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

/**
 * Files a tool call names. Structured tools carry the path in a known key;
 * for shell commands the paths are only in the command text, which is where
 * an agent that *writes* a file (heredoc, redirect, generated plot) puts it.
 */
export function filePathsOf(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const o = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    if (typeof o[key] === 'string') return [o[key] as string];
  }
  if (typeof o.command !== 'string') return [];
  const out: string[] = [];
  for (const m of o.command.matchAll(PATH_RE)) {
    const p = m[1];
    // flags like /dev/null and glob-ish fragments aren't viewable files
    if (p.startsWith('/dev/') || p.includes('*') || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

/** The tool call's primary target file, openable in the in-pane viewer. */
export function filePathOf(input: unknown): string | null {
  return filePathsOf(input)[0] ?? null;
}
