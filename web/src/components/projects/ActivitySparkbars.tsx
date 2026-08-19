/** Sessions-per-week over the last 12 weeks, as tiny bars. */
export function ActivitySparkbars({ weeks, color = 'var(--color-claude)' }: { weeks: number[]; color?: string }) {
  const max = Math.max(1, ...weeks);
  return (
    <div className="flex h-5 items-end gap-[3px]" title="sessions per week, last 12 weeks">
      {weeks.map((n, i) => (
        <div
          key={i}
          className="w-[6px] rounded-[1px]"
          title={`${n} session${n === 1 ? '' : 's'}`}
          style={{
            height: n === 0 ? 2 : `${Math.max(15, (n / max) * 100)}%`,
            background: n === 0 ? 'var(--color-edge)' : color,
            opacity: n === 0 ? 1 : 0.4 + 0.6 * (n / max),
          }}
        />
      ))}
    </div>
  );
}
