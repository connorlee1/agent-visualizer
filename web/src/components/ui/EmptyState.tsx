import type { ReactNode } from 'react';

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-edge py-10 text-center">
      {icon && <div className="text-claude/80">{icon}</div>}
      <div className="text-[13px] text-mut">{title}</div>
      {hint && <div className="text-[12px] text-faint">{hint}</div>}
    </div>
  );
}
