import { capturePanePlain, paneSize, resetWindowSize, resizeWindow, sendKeyToSession, typeIntoSession } from './tmux';

/**
 * Drive codex's interactive /model picker — its only mid-session way to change
 * model or reasoning effort. There is no /effort command, and /model with an
 * argument is sent as a chat message (it starts a turn), so the flow has to be
 * the TUI's own: /model opens a numbered model list where pressing a row's
 * digit selects it immediately, then a "Select Reasoning Level" step (with an
 * "Advanced Reasoning" submenu holding max/ultra). Every step is verified
 * against a pane capture before a key is pressed, approval-dialog style.
 */

const POLL_MS = 250;
const STEP_TIMEOUT_MS = 6000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  key: string;
  label: string;
}

/**
 * An OPEN picker parks its "Press enter to confirm" footer just above the
 * status line; the same text higher up is stale history from an earlier
 * drive, still visible because the TUI renders inline, not on an alt screen.
 */
function pickerOpen(pane: string): boolean {
  const tail = pane.split('\n').filter((l) => l.trim()).slice(-5).join('\n');
  return /Press enter to confirm/.test(tail);
}

/** Step headers sit a dozen rows above the footer — search just the tail. */
function headerNear(pane: string, re: RegExp): boolean {
  const tail = pane.split('\n').filter((l) => l.trim()).slice(-16).join('\n');
  return re.test(tail);
}

/** The last "Model changed to <model> <effort>" confirmation on screen. */
function lastModelChanged(pane: string): { text: string; model?: string; effort?: string } | null {
  const matches = [...pane.matchAll(/Model changed to\s+(\S+)(?:\s+(\S+))?/g)];
  const last = matches[matches.length - 1];
  return last ? { text: last[0], model: last[1], effort: last[2] } : null;
}

/**
 * The last run of consecutively-numbered rows starting at 1 — the open picker.
 * Indented continuation lines (wrapped descriptions) don't break a run;
 * numbered lists higher up in the transcript are superseded by later runs.
 */
function lastNumberedRun(pane: string): Row[] {
  const runs: Row[][] = [];
  let cur: Row[] | null = null;
  for (const line of pane.split('\n')) {
    const m = /^\s*[›>]?\s*(\d)\.\s+(.+?)(?:\s{2,}.*)?$/.exec(line);
    if (m) {
      const row: Row = {
        key: m[1],
        label: m[2].replace(/\s*\((?:current|default)\)\s*$/i, '').trim(),
      };
      if (cur && Number(row.key) === Number(cur[cur.length - 1].key) + 1) cur.push(row);
      else runs.push((cur = [row]));
    } else if (cur && line.trim() && !/^\s{4,}/.test(line)) {
      cur = null;
    }
  }
  return [...runs].reverse().find((r) => r[0].key === '1') ?? [];
}

async function waitFor(name: string, test: (pane: string) => boolean): Promise<string> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pane = await capturePanePlain(name);
    if (test(pane)) return pane;
    await sleep(POLL_MS);
  }
  throw new Error('the model picker did not respond as expected');
}

/** Close any picker screen we may have left open — never a blind Escape,
    which would interrupt a running turn. */
async function dismissPicker(name: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const pane = await capturePanePlain(name).catch(() => '');
    if (!pickerOpen(pane)) return;
    await sendKeyToSession(name, 'Escape').catch(() => {});
    await sleep(300);
  }
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

const inFlight = new Set<string>();

export interface PickerResult {
  model?: string;
  effort?: string;
}

export async function driveCodexModelPicker(
  name: string,
  want: { model?: string; effort?: string },
): Promise<PickerResult> {
  if (inFlight.has(name)) throw new Error('a model change is already running for this agent');
  inFlight.add(name);
  // a short pane (grid attaches leave ~9 rows) draws only the picker's footer —
  // the numbered rows never hit the screen, so capture can't verify anything.
  // Grow the window for the drive, then drop the override so attached clients
  // snap it right back.
  const size = await paneSize(name);
  const grew = size.height < 24;
  if (grew) await resizeWindow(name, Math.max(size.width, 100), 32);
  try {
    return await drive(name, want);
  } catch (err) {
    await dismissPicker(name);
    throw err;
  } finally {
    if (grew) await resetWindowSize(name).catch(() => {});
    inFlight.delete(name);
  }
}

async function drive(name: string, want: { model?: string; effort?: string }): Promise<PickerResult> {
  const pane0 = await capturePanePlain(name);
  // typed input while codex is mid-turn queues as a chat message, not a command
  if (/esc to interrupt/i.test(pane0)) {
    throw new Error('the agent is mid-turn — wait for it to finish');
  }
  // completion = a "Model changed to" line that differs from the one already
  // on screen (counting lines breaks: the resize changes how much history the
  // pane shows, so counts move without anything new happening)
  const before = lastModelChanged(pane0);

  await typeIntoSession(name, '/model');
  await sleep(200);
  await sendKeyToSession(name, 'Enter');

  const isModelList = (p: string) => {
    if (!pickerOpen(p)) return false;
    const run = lastNumberedRun(p);
    return run.length >= 2 && run[0].label.toLowerCase().startsWith('gpt');
  };
  // the first Enter sometimes only completes the slash-command popup — nudge
  // once more, but never when a picker is already up (Enter would select)
  let modelPane: string;
  try {
    modelPane = await waitFor(name, isModelList);
  } catch (err) {
    if (pickerOpen(await capturePanePlain(name))) throw err;
    await sendKeyToSession(name, 'Enter');
    modelPane = await waitFor(name, isModelList);
  }

  const models = lastNumberedRun(modelPane);
  const wantModel = want.model?.toLowerCase();
  if (wantModel) {
    const modelRow =
      models.find((r) => r.label.toLowerCase() === wantModel)
      ?? models.find((r) => r.label.toLowerCase().startsWith(wantModel));
    if (!modelRow) {
      throw new Error(
        `model "${want.model}" is not in the picker (offers: ${models.map((r) => r.label).join(', ')})`,
      );
    }
    await sendKeyToSession(name, modelRow.key);
  } else {
    // effort-only: the cursor sits on the session's current model — never pick
    // by marker; "(default)" on another row is easy to mistake for it
    await sendKeyToSession(name, 'Enter');
  }

  const effortPane = await waitFor(
    name,
    (p) => pickerOpen(p) && headerNear(p, /Select Reasoning Level/) && lastNumberedRun(p).length >= 2,
  );
  const efforts = lastNumberedRun(effortPane);
  const wantEffort = want.effort?.toLowerCase();
  const label = wantEffort ? EFFORT_LABELS[wantEffort] : undefined;
  let effortRow = label
    ? efforts.find((r) => r.label.toLowerCase() === label.toLowerCase())
    : undefined;
  if (!effortRow && (wantEffort === 'max' || wantEffort === 'ultra')) {
    const more = efforts.find((r) => /^More reasoning/i.test(r.label));
    if (more) {
      await sendKeyToSession(name, more.key);
      const advPane = await waitFor(
        name,
        (p) => pickerOpen(p) && headerNear(p, /Advanced Reasoning/) && lastNumberedRun(p).length >= 1,
      );
      const adv = lastNumberedRun(advPane);
      // a model that lacks the asked-for tier gets the closest it offers
      // (e.g. ultra on a max-only model) — escaping back instead would leave
      // the cursor on "More reasoning…" where Enter just reopens this submenu
      effortRow = adv.find((r) => r.label.toLowerCase() === wantEffort) ?? adv[adv.length - 1];
    }
  }
  if (effortRow) await sendKeyToSession(name, effortRow.key);
  else await sendKeyToSession(name, 'Enter');

  try {
    const done = await waitFor(name, (p) => {
      if (pickerOpen(p)) return false;
      const last = lastModelChanged(p);
      return !!last && last.text !== before?.text;
    });
    const last = lastModelChanged(done)!;
    return { model: last.model, effort: last.effort };
  } catch (err) {
    // re-picking the current settings prints a line identical to the previous
    // one — with the picker closed, that line IS the result
    const pane = await capturePanePlain(name);
    const last = lastModelChanged(pane);
    if (pickerOpen(pane) || !last) throw err;
    return { model: last.model, effort: last.effort };
  }
}
