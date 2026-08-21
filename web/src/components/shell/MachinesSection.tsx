import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Laptop, Plus, Server, X } from 'lucide-react';
import type { HostInfo, HostStatus } from '@shared/types';
import { addHost, removeHost } from '../../lib/api';
import { hostOf } from '../../lib/agentRef';
import { useAgents, useHosts } from '../../queries';
import { Modal } from '../ui/Modal';

const STATUS_DOT: Record<HostStatus, string> = {
  connected: 'var(--color-ok, #4ade80)',
  connecting: 'var(--ansi-yellow, #eab308)',
  down: '#ef4444',
};

const inputClass =
  'w-full rounded-md border border-edge bg-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-faint';

function AddMachineModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [ssh, setSsh] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSsh('');
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!name.trim() || !ssh.trim()) {
      setError('Name and ssh command are both required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // direct URLs (tailscale etc.) work too — pasted into the same box
      const isUrl = /^https?:\/\//.test(ssh.trim());
      await addHost(isUrl ? { name: name.trim(), url: ssh.trim() } : { name: name.trim(), ssh: ssh.trim() });
      await queryClient.invalidateQueries({ queryKey: ['hosts'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Machine">
      <div
        className="flex flex-col gap-3"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] text-mut">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="runpod-a"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-mut">
          SSH command <span className="text-faint">(pasted as-is; a base URL also works)</span>
          <input
            value={ssh}
            onChange={(e) => setSsh(e.target.value)}
            placeholder="ssh root@203.0.113.7 -p 22023 -i ~/.ssh/id_ed25519"
            className={`${inputClass} font-mono`}
          />
        </label>
        <div className="text-[11px] leading-snug text-faint">
          The machine must be running the visualizer server (see scripts/remote-setup.sh).
          The dashboard keeps an ssh tunnel to it and shows its agents beside local ones.
        </div>
        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-mut hover:text-ink">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            title="⌘⏎"
            className="rounded-md bg-claude/90 px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-claude disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Sidebar block: every connected machine, its status, and the add/remove flow. */
export function MachinesSection() {
  const { data: hosts } = useHosts();
  const { agents } = useAgents();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (id: string) => removeHost(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['hosts'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const countFor = (host: string) => agents.filter((a) => hostOf(a) === host).length;

  return (
    <div className="mt-6 px-3">
      <div className="flex items-center px-3 pb-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-faint">Machines</span>
        <button
          onClick={() => setAdding(true)}
          title="add a machine over ssh"
          className="ml-auto rounded p-0.5 text-faint hover:bg-surface2 hover:text-ink"
        >
          <Plus size={12} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2.5 rounded-md px-3 py-1.5 font-mono text-[12px] text-mut">
          <Laptop size={13} className="shrink-0 text-faint" />
          <span className="truncate">this mac</span>
          <span className="ml-auto text-[11px] text-faint">{countFor('local')}</span>
        </div>
        {(hosts ?? []).map((h: HostInfo) => (
          <div
            key={h.id}
            className="group flex items-center gap-2.5 rounded-md px-3 py-1.5 font-mono text-[12px] text-mut hover:bg-surface2"
            title={h.status === 'connected' ? h.ssh ?? h.url : `${h.status}${h.lastError ? ` — ${h.lastError}` : ''}`}
          >
            <Server size={13} className="shrink-0 text-faint" />
            <span className="truncate">{h.name}</span>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: STATUS_DOT[h.status] }}
            />
            <span className="ml-auto text-[11px] text-faint group-hover:hidden">
              {h.status === 'connected' ? countFor(h.id) : h.status === 'connecting' ? '…' : 'down'}
            </span>
            <button
              onClick={() => remove.mutate(h.id)}
              title="remove machine (agents keep running on it)"
              className="hidden shrink-0 rounded p-0.5 text-faint hover:text-ink group-hover:block"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <AddMachineModal open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
