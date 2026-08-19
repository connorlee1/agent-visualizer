import type { AgentStatus } from '@shared/types';
import { STATUS_COLOR } from '../../lib/status';

export function AgentStatusDot({ status }: { status: AgentStatus }) {
  const pulse = status === 'working' || status === 'needs-approval';
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${pulse ? 'pulse-dot' : ''}`}
      style={{ backgroundColor: STATUS_COLOR[status] }}
    />
  );
}
