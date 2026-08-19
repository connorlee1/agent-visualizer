import { useEffect, useState } from 'react';

/**
 * Centered confirmation dialog for destructive actions — the popped-up dialog
 * itself is the safety step; confirming takes a distinct second action.
 */
export function ConfirmDialog({ open, onClose, onConfirm, question, description, hint, actionLabel }: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Question shown as the dialog title, e.g. "Really kill?". */
  question: string;
  /** What the action applies to, e.g. the agent's name. */
  description?: string;
  /** Muted helper line, e.g. the hotkey that confirms. */
  hint?: string;
  /** Label of the destructive button, e.g. "Kill". */
  actionLabel: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-[340px] rounded-lg border border-edge bg-surface p-4 shadow-2xl">
        <div className="text-[13px] font-semibold text-ink">{question}</div>
        {description && <div className="truncate pt-1 text-[12px] text-mut">{description}</div>}
        {hint && <div className="pt-1 text-[11px] text-faint">{hint}</div>}
        <div className="flex justify-end gap-2 pt-4">
          <button
            onClick={onClose}
            className="rounded-md border border-edge px-3 py-1.5 text-[12px] text-mut hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md border border-alert/60 bg-alert/15 px-3 py-1.5 text-[12px] font-medium text-alert hover:bg-alert/25"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A destructive action button. Clicking opens the centered confirmation
 * dialog, so the confirming click can never land on the same spot as the
 * first one.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, description, title, className = '' }: {
  label: string;
  /** Question shown as the dialog title, e.g. "Really kill?". */
  confirmLabel: string;
  onConfirm: () => void;
  /** Shown under the question — what the action applies to, e.g. the agent's name. */
  description?: string;
  /** Tooltip on the trigger button. */
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={title}
        className={`rounded border border-edge px-2 py-0.5 text-[11px] text-mut hover:border-alert/40 hover:text-alert ${className}`}
      >
        {label}
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
        question={confirmLabel}
        description={description}
        actionLabel={label}
      />
    </>
  );
}
