import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AGENT_NAMES_FILE } from './config';

/**
 * Conversation sessionId -> user-chosen agent name. tmux user options die
 * with the session and a closed-agents entry is dropped on resume, so this
 * store is what lets a conversation keep its custom name across
 * close -> resume cycles.
 */

const MAX_ENTRIES = 500;

interface NameEntry { title: string; updatedAt: string }

function load(): Record<string, NameEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENT_NAMES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // first run or corrupt file — start fresh
    return {};
  }
}

let names = load();
// serialize writes so overlapping updates can't interleave file contents
let writing: Promise<unknown> = Promise.resolve();

function save(): void {
  const data = JSON.stringify(names, null, 2);
  writing = writing.then(async () => {
    await fsp.mkdir(path.dirname(AGENT_NAMES_FILE), { recursive: true });
    await fsp.writeFile(AGENT_NAMES_FILE, data);
  }).catch((err) => console.error('agent-names save failed:', err));
}

export function getAgentName(sessionId: string): string | undefined {
  return names[sessionId.toLowerCase()]?.title;
}

export function rememberAgentName(sessionId: string, title: string): void {
  const key = sessionId.toLowerCase();
  if (names[key]?.title === title) return;
  names[key] = { title, updatedAt: new Date().toISOString() };
  const keys = Object.keys(names);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => names[a].updatedAt.localeCompare(names[b].updatedAt));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete names[k];
  }
  save();
}

export function forgetAgentName(sessionId: string): void {
  const key = sessionId.toLowerCase();
  if (!(key in names)) return;
  delete names[key];
  save();
}
