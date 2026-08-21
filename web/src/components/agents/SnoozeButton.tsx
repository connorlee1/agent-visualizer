import { Moon } from 'lucide-react';
import { toggleDoneFlashMute } from '../../lib/useDoneFlash';
import { altLabel } from '../../lib/keys';

/**
 * Pane-header standing mute for the done-flash: always available on a
 * running agent, so it can be silenced before it ever finishes. The moon
 * fills while muted; the choice persists until toggled off. data-snooze
 * lets the ⌥S pane chord (AppShell) trigger it on the focused pane.
 */
export function SnoozeButton({ name, muted }: { name: string; muted: boolean }) {
  return (
    <button
      data-snooze
      onClick={() => toggleDoneFlashMute(name)}
      // never take focus: keeps the user's caret where it was, and keeps a
      // freshly slept pane from staying bright via its own focus-within
      onMouseDown={(e) => e.preventDefault()}
      className={`rounded p-1 hover:bg-surface2 ${muted ? 'text-warn' : 'text-mut hover:text-ink'}`}
      title={muted ? `sleeping — reminder strobe every 10m; click to wake (${altLabel('S')})` : `sleep: silence the done-flash (a reminder still strobes every 10m) (${altLabel('S')})`}
    >
      <Moon size={13} fill={muted ? 'currentColor' : 'none'} />
    </button>
  );
}
