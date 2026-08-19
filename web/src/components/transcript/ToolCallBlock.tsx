import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import type { ContentBlock } from '@shared/types';
import { shortPath, truncate } from '../../lib/format';

type ToolResult = Extract<ContentBlock, { kind: 'tool_result' }>;

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (typeof o[key] === 'string') return shortPath(o[key] as string);
    }
    for (const key of ['command', 'pattern', 'query', 'url', 'description', 'prompt', 'skill']) {
      if (typeof o[key] === 'string') return truncate((o[key] as string).replace(/\s+/g, ' '), 90);
    }
  }
  if (typeof input === 'string') return truncate(input, 90);
  const json = input == null ? '' : JSON.stringify(input);
  return json === '{}' ? '' : truncate(json, 90);
}

export function ToolCallBlock({ name, input, result, forceOpen }: {
  name: string;
  input: unknown;
  result?: ToolResult;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (forceOpen !== undefined) setOpen(forceOpen);
  }, [forceOpen]);

  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className={`flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[12px] ${
          result?.isError ? 'text-red-400' : 'text-mut'
        } hover:bg-surface2`}
      >
        <span className="text-faint">{open ? '▾' : '▸'}</span>
        <Wrench size={11} className="shrink-0 text-faint" />
        <span className="font-medium text-[color:var(--ansi-magenta)]">{name}</span>
        <span className="truncate text-faint">{summarizeInput(input)}</span>
        {result?.isError && <span className="shrink-0">✕ error</span>}
      </button>
      {open && (
        <div className="ml-4 mt-1 flex flex-col gap-1.5">
          {input != null && (
            <pre className="max-h-64 overflow-auto rounded-md border border-edge bg-bg p-2 font-mono text-[11px] leading-relaxed text-mut">
              {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
            </pre>
          )}
          {result && (
            <pre
              className={`max-h-80 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed ${
                result.isError ? 'border-red-500/30 bg-red-500/5 text-red-300' : 'border-edge bg-bg text-mut'
              }`}
            >
              {truncate(result.text, 20_000) || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
