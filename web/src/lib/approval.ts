import { stripAnsi } from './status';

export interface DialogOption {
  /** Key to press in the pane to pick this option ('1'…'9', 'y', 'n'). */
  key: string;
  label: string;
  /** Wrapped continuation / description lines under the option. */
  detail?: string;
  /** Whether the dialog's ❯ cursor is on this option. */
  selected: boolean;
}

export interface ApprovalDialog {
  /** Cleaned context lines above the options (question, command, diff…). */
  question: string[];
  options: DialogOption[];
  /** Number keys toggle checkboxes; Enter submits. */
  multiSelect?: boolean;
}

// NOTE: deriving the dialog from the transcript instead was tried and is a
// dead end — claude doesn't write the AskUserQuestion tool_use record to the
// JSONL until the user answers it, so a pending ask is never in the file.

const CURSOR = '[❯>›▸]';
const OPTION_RE = new RegExp(`^\\s*(${CURSOR})?\\s*(\\d{1,2})[.)]\\s+(\\S.*)$`);
// A line made only of box-drawing characters (dialog frame top/bottom/dividers).
const BORDER_RE = /^\s*[╭╮╰╯├┤┬┴─╌═╔╗╚╝║│┃+|]+\s*$/;

/** Strip the dialog frame's side borders from a single pane line. */
function cleanLine(line: string): string {
  return line
    .replace(/^\s*[│┃║]\s?/, '')
    .replace(/\s*[│┃║]\s*$/, '')
    .trimEnd();
}

/**
 * Parse an approval / question dialog out of a pane snapshot so the UI can
 * show real option labels instead of bare "1 2 3" keys. Returns null when no
 * recognizable dialog is found (the caller falls back to generic buttons).
 *
 * Works on the option-list shape both CLIs draw: a run of numbered lines
 * starting at 1 (`❯ 1. Yes` / `  2. No…`), with wrapped continuation lines
 * indented underneath. Also recognizes bare `(y/n)` prompts.
 */
export function parseApprovalDialog(preview: string): ApprovalDialog | null {
  const raw = stripAnsi(preview).split('\n');
  const lines = raw.map((l) => (BORDER_RE.test(l) ? null : cleanLine(l)));

  // Numbered lines with their positions; transcripts can contain numbered
  // lists too, so below we keep only the LAST run that starts at 1.
  const numbered: { idx: number; num: number; cursor: boolean; text: string }[] = [];
  lines.forEach((l, idx) => {
    if (l === null) return;
    const m = OPTION_RE.exec(l);
    if (m) numbered.push({ idx, num: Number(m[2]), cursor: !!m[1], text: m[3].trim() });
  });

  let run: typeof numbered = [];
  for (const n of numbered) {
    if (n.num === 1) run = [n];
    else if (run.length && n.num === run[run.length - 1].num + 1) run.push(n);
  }

  if (run.length >= 2) {
    const options: DialogOption[] = run.map((n, i) => {
      const next = run[i + 1];
      const detail = lines
        .slice(n.idx + 1, next ? next.idx : findDialogEnd(lines, n.idx))
        .filter((l): l is string => !!l && !!l.trim() && !OPTION_RE.test(l) && !HINT_RE.test(l))
        .map((l) => l.trim())
        .join(' ');
      return {
        key: String(n.num),
        label: n.text,
        detail: detail || undefined,
        selected: n.cursor,
      };
    });
    return {
      question: questionAbove(lines, run[0].idx),
      options,
      // multi-select asks render checkboxes in front of each label
      multiSelect: options.some((o) => /^\[[ x✓×]\]/i.test(o.label)),
    };
  }

  // y/n prompt fallback
  const ynIdx = lines.findIndex((l, i) => i >= lines.length - 6 && !!l && /\(y\/n\)/i.test(l));
  if (ynIdx >= 0) {
    return {
      question: questionAbove(lines, ynIdx + 1),
      options: [
        { key: 'y', label: 'Yes', selected: false },
        { key: 'n', label: 'No', selected: false },
      ],
    };
  }

  return null;
}

// Keyboard-hint rows ("enter to confirm · esc to cancel") — not option text.
const HINT_RE = /\b(enter|tab|esc|arrow keys?)\b.*\b(select|submit|confirm|cancel|navigate|toggle|interrupt)\b/i;

/** After the last option, stop collecting detail lines at the frame or a blank. */
function findDialogEnd(lines: (string | null)[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === null || !l.trim()) return i;
  }
  return lines.length;
}

/** Context lines above the options: question, command, diff — capped to 8. */
function questionAbove(lines: (string | null)[], firstOptionIdx: number): string[] {
  const out: string[] = [];
  for (let i = firstOptionIdx - 1; i >= 0 && out.length < 8; i--) {
    const l = lines[i];
    if (l === null) break; // hit the dialog's top frame
    out.unshift(l);
  }
  // trim leading/trailing blank lines
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}
