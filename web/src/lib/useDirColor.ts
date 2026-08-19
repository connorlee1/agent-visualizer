import { useMemo } from 'react';
import { useAgents } from '../queries';
import { dirColorMap } from './dirColor';

/**
 * Accent color for one directory, assigned against the set of directories
 * currently on screen (all running agents' cwds plus `dir` itself, so
 * transcript panels for non-running sessions get a color too).
 */
export function useDirColor(dir: string | undefined): string | undefined {
  const { agents } = useAgents();
  return useMemo(
    () => (dir ? dirColorMap([...agents.map((a) => a.cwd), dir]).get(dir) : undefined),
    [agents, dir],
  );
}
