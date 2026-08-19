import type { WebSocket, RawData } from 'ws';
import os from 'node:os';
import { spawn } from 'node-pty';
import { TMUX_BIN } from './config';
import { assertSessionName, capturePane } from './tmux';

const toBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

// Attach clients we spawned. Killed on shutdown so a server restart never
// leaves zombie tmux clients holding stale window sizes.
const livePtys = new Set<ReturnType<typeof spawn>>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const pty of livePtys) {
      try { pty.kill(); } catch { /* already gone */ }
    }
    process.exit(0);
  });
}

export async function handleTerminalConnection(ws: WebSocket, name: string, cols: number, rows: number): Promise<void> {
  try {
    assertSessionName(name);
  } catch {
    ws.close(4002, 'bad session name');
    return;
  }

  // Seed xterm's scrollback with pane history (lines above the visible screen);
  // the attach below repaints the visible screen itself, so nothing is duplicated.
  try {
    const history = await capturePane(name, { history: true });
    if (history.trim()) ws.send(Buffer.from(history.replace(/\n/g, '\r\n') + '\r\n'));
  } catch { /* no history yet, or session gone — attach will surface real errors */ }

  const env = { ...process.env };
  delete env.TMUX; // allow attaching even when this server itself runs inside tmux

  let term: ReturnType<typeof spawn>;
  try {
    term = spawn(TMUX_BIN, ['attach-session', '-t', name], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: env as Record<string, string>,
    });
  } catch {
    ws.close(4002, 'attach failed');
    return;
  }

  livePtys.add(term);
  const dataSub = term.onData((chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(chunk, 'utf8'));
  });
  term.onExit(() => {
    livePtys.delete(term);
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify({ type: 'exit' })); } catch { /* closing anyway */ }
      ws.close(4001, 'session ended');
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      term.write(toBuffer(data).toString('utf8'));
      return;
    }
    try {
      const msg = JSON.parse(toBuffer(data).toString('utf8'));
      if (msg?.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        term.resize(Math.min(500, Math.max(2, msg.cols)), Math.min(300, Math.max(2, msg.rows)));
      }
    } catch { /* ignore malformed control frames */ }
  });

  // closing the socket detaches this client only — the tmux session lives on
  ws.on('close', () => {
    livePtys.delete(term);
    dataSub.dispose();
    try { term.kill(); } catch { /* already exited */ }
  });
}
