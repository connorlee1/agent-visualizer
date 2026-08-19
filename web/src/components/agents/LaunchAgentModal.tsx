import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { LaunchAgentRequest, Provider } from '@shared/types';
import { launchAgent } from '../../lib/api';
import { useProjects } from '../../queries';
import { shortPath } from '../../lib/format';
import { requestComposerFocus } from '../../lib/focusAgent';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';

const CUSTOM = '__custom__';

const inputClass =
  'w-full rounded-md border border-edge bg-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-faint';

export function LaunchAgentModal({ open, prefill, onClose }: {
  open: boolean;
  prefill?: Partial<Pick<LaunchAgentRequest, 'provider' | 'cwd'>>;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const [provider, setProvider] = useState<Provider>('claude');
  const [title, setTitle] = useState('');
  const [projectChoice, setProjectChoice] = useState<string>(CUSTOM);
  const [customPath, setCustomPath] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // grow the prompt box to fit its content; rows={3} keeps the minimum and
  // the max-height class keeps a long paste from overflowing the modal
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [prompt, open]);

  useEffect(() => {
    if (!open) return;
    setProvider(prefill?.provider ?? 'claude');
    if (prefill?.cwd) {
      setProjectChoice(prefill.cwd);
      setCustomPath(prefill.cwd);
    } else if (projects?.length) {
      setProjectChoice(projects[0].path);
    }
    setError(null);
    setTitle('');
    setPrompt('');
    // pull focus out of whatever opened the modal (e.g. a wall terminal,
    // which would otherwise keep receiving keystrokes) into the name field
    nameRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const cwd = projectChoice === CUSTOM ? customPath.trim() : projectChoice;
    if (!cwd) {
      setError('Pick a project or enter a path');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await launchAgent({
        provider,
        cwd,
        title: title.trim() || undefined,
        model: model.trim() || undefined,
        permissionMode: permissionMode || undefined,
        initialPrompt: prompt.trim() || undefined,
      });
      requestComposerFocus(res.tmuxName);
      onClose();
      navigate('/grid');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Agent">
      <div
        className="flex flex-col gap-3"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="flex gap-1.5">
          {(['claude', 'codex'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              className={`flex-1 rounded-md border py-1.5 text-[13px] font-medium ${
                provider === p
                  ? p === 'claude'
                    ? 'border-claude/60 bg-claude/15 text-claude'
                    : 'border-codex/60 bg-codex/15 text-codex'
                  : 'border-edge text-mut hover:text-ink'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1 text-[12px] text-mut">
          Name <span className="text-faint">(optional — you can rename later via ⋮)</span>
          <input
            ref={nameRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            placeholder="defaults to the directory name"
            className={inputClass}
          />
        </label>

        {/* not a <label>: it would forward clicks on the dropdown's
            click-away overlay back to the trigger button, reopening it */}
        <div className="flex flex-col gap-1 text-[12px] text-mut">
          Project
          <Select
            value={projectChoice}
            onChange={setProjectChoice}
            options={[
              ...(projects?.map((p) => ({ value: p.path, label: p.name, hint: shortPath(p.path) })) ?? []),
              { value: CUSTOM, label: 'custom path…' },
            ]}
          />
        </div>
        {projectChoice === CUSTOM && (
          <input
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder="~/Desktop/my-project"
            className={`${inputClass} font-mono`}
          />
        )}

        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[12px] text-mut">
            Model
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="default"
              list={provider === 'claude' ? 'claude-models' : undefined}
              className={`${inputClass} font-mono`}
            />
            <datalist id="claude-models">
              <option value="opus" />
              <option value="sonnet" />
              <option value="haiku" />
            </datalist>
          </label>
          {provider === 'claude' && (
            <div className="flex flex-1 flex-col gap-1 text-[12px] text-mut">
              Permissions
              <Select
                value={permissionMode}
                onChange={setPermissionMode}
                options={[
                  { value: '', label: 'default' },
                  { value: 'plan', label: 'plan' },
                  { value: 'acceptEdits', label: 'acceptEdits' },
                  { value: 'dontAsk', label: 'dontAsk' },
                  { value: 'bypassPermissions', label: 'bypassPermissions' },
                ]}
              />
            </div>
          )}
        </div>

        <label className="flex flex-col gap-1 text-[12px] text-mut">
          Initial prompt <span className="text-faint">(optional)</span>
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className={`${inputClass} max-h-[40vh] resize-none overflow-y-auto`}
            placeholder="What should the agent do?"
          />
        </label>

        {error && <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-mut hover:text-ink">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            title="⌘⏎"
            className="rounded-md bg-claude/90 px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-claude disabled:opacity-50"
          >
            {busy ? 'Launching…' : 'Launch ▶'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
