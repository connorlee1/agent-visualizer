import { Moon } from 'lucide-react';
import { toggleDoneFlashMute } from '../../lib/useDoneFlash';

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
      onClick={(e) => {
        toggleDoneFlashMute(name);
        // drop focus so the pane's focus-within doesn't hold a freshly
        // slept pane at full brightness — the dim must engage visibly
        e.currentTarget.blur();
      }}
      className={`rounded p-1 hover:bg-surface2 ${muted ? 'text-warn' : 'text-mut hover:text-ink'}`}
      title={muted ? 'sleeping — reminder strobe every 10m; click to wake (⌥S)' : 'sleep: silence the done-flash (a reminder still strobes every 10m) (⌥S)'}
    >
      <Moon size={13} fill={muted ? 'currentColor' : 'none'} />
    </button>
  );
}
