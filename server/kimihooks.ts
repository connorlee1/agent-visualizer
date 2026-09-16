import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, type TomlTable } from 'smol-toml';
import { KIMI_CODE_HOME } from './config';

const BEGIN = '# BEGIN agent-visualizer hooks';
const END = '# END agent-visualizer hooks';
const EVENTS = ['SessionStart', 'PermissionRequest', 'PermissionResult', 'SessionEnd'];

/** Kimi has no per-launch settings flag. Preserve user TOML and add only our
 * marked block. The command is inert outside a dashboard-launched process. */
export function withKimiHooks(config: string): string {
  const begin = config.indexOf(BEGIN);
  const end = config.indexOf(END);
  if ((begin < 0) !== (end < 0) || (begin >= 0 && end < begin)) {
    throw new Error('Incomplete agent-visualizer hook block in Kimi config.toml');
  }
  let clean = begin < 0 ? config : config.slice(0, begin) + config.slice(end + END.length);
  const command = 'if [ -n "${AGENT_VISUALIZER_SESSION:-}" ] && [ -n "${AGENT_VISUALIZER_PORT:-}" ]; then ' +
    'curl -s -m 2 -X POST -H "Content-Type: application/json" ' +
    '-H "X-Agent-Visualizer-Session: $AGENT_VISUALIZER_SESSION" --data-binary @- ' +
    '"http://127.0.0.1:$AGENT_VISUALIZER_PORT/api/hooks/kimi" >/dev/null 2>&1; fi; exit 0';
  let existing: TomlTable;
  try { existing = parse(clean); } catch {
    throw new Error('Kimi config.toml is invalid. Run kimi doctor before launching from the dashboard.');
  }
  const hooks = Array.isArray(existing.hooks) ? existing.hooks : [];
  const missing = EVENTS.filter((event) => !hooks.some((h) => typeof h === 'object' && h !== null &&
    !Array.isArray(h) && 'event' in h && 'command' in h && h.event === event && h.command === command));
  // Kimi may rewrite TOML and remove comments. Recognize our commands as well
  // as our markers, so changing a Kimi setting does not duplicate the hooks.
  if (!missing.length) return clean;
  if (Array.isArray(existing.hooks) && !hooks.length) {
    clean = clean.replace(/^hooks\s*=\s*\[\s*\]\s*(?:#[^\n]*)?$/m, '# Empty hooks array extended by agent-visualizer.');
  }
  const block = missing.map((event) => `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\ntimeout = 3`).join('\n\n');
  const result = `${clean.trimEnd()}\n\n${BEGIN}\n${block}\n${END}\n`;
  try { parse(result); } catch {
    throw new Error('Could not extend Kimi hooks safely. Use [[hooks]] tables instead of an inline hooks array in config.toml.');
  }
  return result;
}

let installing: Promise<void> | undefined;
export function ensureKimiHooks(): Promise<void> {
  installing ??= (async () => {
    const file = path.join(KIMI_CODE_HOME, 'config.toml');
    // Do not create an empty Kimi config: let Kimi initialize its defaults.
    const original = await fs.readFile(file, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') throw new Error('Run kimi and finish setup before launching it from the dashboard.');
      throw err;
    });
    const next = withKimiHooks(original);
    if (next === original) return;
    const stat = await fs.stat(file);
    const temp = `${file}.agent-visualizer-${process.pid}.tmp`;
    try {
      await fs.writeFile(temp, next, { mode: stat.mode & 0o777, flag: 'wx' });
      if (await fs.readFile(file, 'utf8') !== original) throw new Error('Kimi config changed during launch; please retry.');
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
  })().finally(() => { installing = undefined; });
  return installing;
}
