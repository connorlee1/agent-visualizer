import { useMemo } from 'react';
import { AnsiUp } from 'ansi_up';

const ansiUp = new AnsiUp();
// emit palette classes (styled in index.css) so previews share the terminal theme
ansiUp.use_classes = true;

export function PanePreview({ ansi, lines = 10 }: { ansi: string; lines?: number }) {
  const html = useMemo(() => {
    const tail = ansi.replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
    return ansiUp.ansi_to_html(tail);
  }, [ansi, lines]);

  return (
    <pre
      className="h-[150px] overflow-hidden rounded-md border border-edge bg-bg p-2 font-mono text-[10.5px] leading-[1.45] text-mut opacity-90"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
