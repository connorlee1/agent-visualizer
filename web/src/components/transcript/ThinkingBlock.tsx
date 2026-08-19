import { useState } from 'react';
import { fmtTokens } from '../../lib/format';

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="text-[12px] italic text-faint hover:text-mut"
      >
        {open ? '▾' : '▸'} Thinking ({fmtTokens(Math.round(text.length / 4))} tok est.)
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-edge pl-3 text-[12px] italic leading-relaxed text-faint">
          {text}
        </div>
      )}
    </div>
  );
}
