import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { createKimiTranscriptParser, kimiIdleSummary, kimiSessionIdForFile, kimiTurnState, listKimiSessions, parseKimiTranscript } from '../server/sessions/kimi';
import { withKimiHooks } from '../server/kimihooks';
import { buildAgentCommand } from '../server/tmux';
import { kimiHookSignal, noteKimiHookEvent } from '../server/hooksignals';
import { deriveStatus, isKimiApproval } from '../web/src/lib/status';
import { parseApprovalDialog } from '../web/src/lib/approval';
import { linkedSessionFor } from '../web/src/lib/linked';
import { decodePanelRef, encodePanelRef } from '../web/src/lib/panelRef';
import type { TmuxAgent } from '../shared/types';

const fixture = path.join(import.meta.dirname, 'fixtures/kimi');
const records = (await fs.readFile(path.join(fixture, 'wire.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const baseAgent: TmuxAgent = { name: 'agent-kimi-aabbcc', managed: true, provider: 'kimi',
  cwd: '/tmp/kimi-test-project', sessionId: 'session_example', createdAt: new Date().toISOString(),
  attachedClients: 0, currentCommand: 'kimi', agentRunning: true, preview: '', paneWidth: 100, paneHeight: 30 };

test('published Node wire records render prompt, thinking, tool input/result, reply and usage', async () => {
  const messages = await parseKimiTranscript(path.join(fixture, 'wire.jsonl'));
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0].content, [{ kind: 'text', text: 'Run the local fixture command, then reply.' }]);
  assert.equal(messages[1].content[0].kind, 'thinking');
  assert.deepEqual(messages[1].content[1], { kind: 'tool_use', toolId: 'call-test', name: 'Bash', input: { command: 'printf kimi-fixture', description: 'Print a local test marker' } });
  assert.deepEqual(messages[2].content, [{ kind: 'tool_result', toolId: 'call-test', text: 'kimi-fixture', isError: undefined }]);
  assert.equal(messages[3].model, 'test');
  assert.equal(messages[3].content[0].kind, 'text');
  assert.equal(messages[3].usage?.outputTokens, 0);
  assert.equal(kimiIdleSummary(records).lastPrompt, 'Run the local fixture command, then reply.');
  assert.equal(kimiIdleSummary(records).lastAgentMessage, 'Kimi integration fixture complete.');
});

test('turn completion, interruption, queued cancellation, and bookkeeping', () => {
  assert.equal(kimiTurnState(records), 'idle');
  assert.equal(kimiTurnState(records.slice(0, -1)), 'working');
  assert.equal(kimiTurnState([...records, { type: 'usage.record' }]), 'idle');
  assert.equal(kimiTurnState([{ type: 'turn.prompt' }, { type: 'turn.cancel', target: 'active' }]), 'idle');
  assert.equal(kimiTurnState([{ type: 'turn.prompt' }, { type: 'turn.cancel', target: 'queued' }]), 'working');
  assert.equal(kimiTurnState([{ type: 'turn.prompt' }, { type: 'turn.ended', agentId: 'child' }]), 'working');
});

test('undo retracts a full user turn; compaction retains history and blocks undo across the boundary', () => {
  const parser = createKimiTranscriptParser();
  records.forEach(parser.accept);
  parser.accept({ type: 'context.undo', count: 1 });
  assert.equal(parser.messages.length, 0);
  records.forEach(parser.accept);
  parser.accept({ type: 'context.apply_compaction', summary: 'Summary' });
  parser.accept({ type: 'context.undo', count: 1 });
  assert.equal(parser.messages.length, 5);
  assert.equal(parser.messages.at(-1)?.role, 'system');
  parser.accept({ type: 'context.clear' });
  assert.equal(parser.messages.length, 0);
});

test('discovery reads metadata, isolates corrupt sessions, ignores subagents, and refreshes titles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-parser-'));
  try {
    const dir = path.join(root, 'workspace', 'session_example');
    const main = path.join(dir, 'agents/main');
    await fs.mkdir(main, { recursive: true });
    await fs.copyFile(path.join(fixture, 'wire.jsonl'), path.join(main, 'wire.jsonl'));
    const meta = JSON.parse(await fs.readFile(path.join(fixture, 'state.json'), 'utf8'));
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(meta));
    await fs.mkdir(path.join(dir, 'agents/child'), { recursive: true });
    await fs.writeFile(path.join(dir, 'agents/child/wire.jsonl'), '{}\n');
    await fs.mkdir(path.join(root, 'workspace/broken/agents/main'), { recursive: true });
    await fs.writeFile(path.join(root, 'workspace/broken/state.json'), 'bad json');
    let sessions = await listKimiSessions(root);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].provider, 'kimi');
    assert.equal(sessions[0].projectPath, '/tmp/kimi-test-project');
    assert.equal(sessions[0].titleIsFallback, true);
    assert.equal(sessions[0].model, 'test');
    assert.equal(kimiSessionIdForFile(sessions[0].filePath, root), 'session_example');
    assert.equal(kimiSessionIdForFile(path.join(dir, 'agents/child/wire.jsonl'), root), undefined);
    assert.equal(kimiSessionIdForFile(path.join(root, '../escape/id/agents/main/wire.jsonl'), root), undefined);
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...meta, title: 'Updated title', titleKind: 'custom' }));
    sessions = await listKimiSessions(root);
    assert.equal(sessions[0].title, 'Updated title');
    assert.equal(sessions[0].titleIsFallback, false);
    await fs.appendFile(path.join(main, 'wire.jsonl'), '{"type":');
    assert.equal((await parseKimiTranscript(path.join(main, 'wire.jsonl'))).length, 4);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Kimi launch preserves interactive mode and accepts prefixed session IDs safely', () => {
  const opts = { provider: 'kimi' as const, cwd: '/tmp' };
  assert.equal(buildAgentCommand(opts).command, 'kimi');
  const result = buildAgentCommand({ ...opts, resumeSessionId: 'session_123', model: 'kimi-code/model' });
  assert.equal(result.sessionId, 'session_123');
  assert.match(result.command, /^kimi --session 'session_123' --model 'kimi-code\/model'$/);
  for (const id of ['../escape', 'x; touch /tmp/no', '$(id)', '-option', 'x\nfoo']) {
    assert.throws(() => buildAgentCommand({ ...opts, resumeSessionId: id }));
  }
  assert.throws(() => buildAgentCommand({ ...opts, initialPrompt: 'hello' }), /non-interactive/);
  assert.throws(() => buildAgentCommand({ ...opts, fork: true }), /Fork Kimi/);
  assert.throws(() => buildAgentCommand({ ...opts, permissionMode: 'bypassPermissions' }), /Kimi permissions/);
});

test('hook installation preserves settings and existing hooks, is idempotent after Kimi rewrites TOML', () => {
  const original = '# keep me\ndefault_model = "mine"\n[[hooks]]\nevent = "Stop"\ncommand = "echo custom"\n[providers.mine]\ntype = "openai"\napi_key = "test-only"\n';
  const result = withKimiHooks(original);
  assert.ok(result.startsWith(original));
  const parsed = parse(result);
  assert.deepEqual(parsed.providers, parse(original).providers);
  assert.equal((parsed.hooks as any[]).length, 5);
  assert.equal(withKimiHooks(result), result);
  const rewritten = stringify(parsed);
  assert.equal(withKimiHooks(rewritten), rewritten);
  assert.equal((parse(withKimiHooks('hooks = []\n')).hooks as any[]).length, 4);
  assert.throws(() => withKimiHooks('# BEGIN agent-visualizer hooks\n'), /Incomplete/);
  assert.throws(() => withKimiHooks('hooks = [{event = "Stop", command = "echo hello"}]\n'), /safely/);
  for (const hook of parsed.hooks as any[]) if (hook.event !== 'Stop') {
    assert.match(hook.command, /AGENT_VISUALIZER_SESSION/);
    assert.match(hook.command, /exit 0$/);
  }
});

test('multiple Kimi approvals do not clear each other', () => {
  noteKimiHookEvent('test-approval', 'PermissionRequest', 'a');
  noteKimiHookEvent('test-approval', 'PermissionRequest', 'b');
  noteKimiHookEvent('test-approval', 'PermissionResult', 'a');
  assert.equal(kimiHookSignal('test-approval')?.pending.size, 1);
  noteKimiHookEvent('test-approval', 'PermissionResult', 'b');
  assert.equal(kimiHookSignal('test-approval')?.pending.size, 0);
});

test('Kimi approval footer and selected numeric options; ordinary prose is not an approval', () => {
  const preview = '▶ Run command\n$ printf hello\n  ▶ 1. Approve once\n    2. Approve for this session\n    3. Reject\n\n  ↑/↓ select · 1/2/3 choose · ↵ confirm\n────────';
  assert.equal(isKimiApproval(preview), true);
  assert.equal(deriveStatus({ ...baseAgent, preview, turnState: 'working' }, { changedRecently: false }), 'needs-approval');
  const dialog = parseApprovalDialog(preview);
  assert.equal(dialog?.options[0].label, 'Approve once');
  assert.equal(dialog?.options[0].selected, true);
  assert.equal(isKimiApproval('Please Approve once, then Reject. Do you want to proceed?'), false);
  assert.equal(deriveStatus({ ...baseAgent, turnState: 'idle' }, { changedRecently: true }), 'waiting');
});

test('Kimi panel references round-trip and exact hook identity wins over directory recency', () => {
  const ref = { kind: 'chat' as const, provider: 'kimi' as const, id: 'session_123', host: 'remote1' };
  assert.deepEqual(decodePanelRef(encodePanelRef(ref)), ref);
  assert.equal(decodePanelRef('chat:unknown:123'), null);
  assert.deepEqual(linkedSessionFor(baseAgent, [{ provider: 'kimi', id: 'other', projectPath: baseAgent.cwd, createdAt: baseAgent.createdAt } as any]), { provider: 'kimi', id: 'session_example' });
});
