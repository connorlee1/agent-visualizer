import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

const CHUNK = 64 * 1024;

function parseLines(lines: string[]): any[] {
  const out: any[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch { /* partial or malformed line — expected at chunk edges and mid-append */ }
  }
  return out;
}

/** Parse the complete JSON lines found in the first 64KB of the file. */
export async function readHeadLines(filePath: string, fileSize: number): Promise<any[]> {
  const fh = await fs.open(filePath, 'r');
  try {
    const len = Math.min(CHUNK, fileSize);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const lines = buf.toString('utf8').split('\n');
    if (len < fileSize) lines.pop();
    return parseLines(lines);
  } finally {
    await fh.close();
  }
}

/** Parse the complete JSON lines found in the last maxBytes (default 64KB) of the file. */
export async function readTailLines(filePath: string, fileSize: number, maxBytes = CHUNK): Promise<any[]> {
  const fh = await fs.open(filePath, 'r');
  try {
    const len = Math.min(maxBytes, fileSize);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, fileSize - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < fileSize) lines.shift();
    return parseLines(lines);
  } finally {
    await fh.close();
  }
}

/**
 * Stream parseable JSON lines starting at a byte offset, returning how many
 * bytes of COMPLETE (newline-terminated) lines were consumed. A trailing
 * partial line — an agent mid-append — is not consumed, so the next call
 * picks it up whole. This is what makes incremental transcript parsing safe:
 * offsets only ever advance past fully-parsed lines.
 */
export async function streamLinesFrom(
  filePath: string,
  start: number,
  onRecord: (record: any) => void,
): Promise<number> {
  const stream = createReadStream(filePath, { start });
  let carry: Buffer = Buffer.alloc(0);
  let consumed = 0;
  for await (const chunk of stream) {
    carry = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let nl: number;
    while ((nl = carry.indexOf(0x0a)) >= 0) {
      const line = carry.subarray(0, nl).toString('utf8').trim();
      consumed += nl + 1;
      carry = carry.subarray(nl + 1);
      if (!line) continue;
      try {
        onRecord(JSON.parse(line));
      } catch { /* malformed line — skipped, but still consumed */ }
    }
  }
  return consumed;
}

/** Stream every parseable JSON line through the callback. */
export async function streamLines(filePath: string, onRecord: (record: any) => void): Promise<void> {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      onRecord(JSON.parse(line));
    } catch { /* truncated final line while the agent is mid-append — normal */ }
  }
}

export function safeIso(value: unknown, fallback: Date): string {
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback.toISOString();
}
