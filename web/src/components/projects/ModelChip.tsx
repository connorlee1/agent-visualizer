export function ModelChip({ model, effort }: { model?: string; effort?: string }) {
  if (!model && !effort) return null;
  return (
    <span className="rounded border border-edge bg-surface2 px-1.5 py-px font-mono text-[10px] text-[color:var(--ansi-cyan)]">
      {model?.replace(/^claude-/, '') ?? 'model?'}
      {effort && <span className="text-faint"> · {effort}</span>}
    </span>
  );
}
