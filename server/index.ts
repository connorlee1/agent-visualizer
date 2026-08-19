import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { SERVER_PORT } from './config';
import { router } from './routes';
import { broadcast, hasClients } from './events';
import { handleTerminalConnection } from './terminal';
import { startWatcher } from './sessions/index';
import { listAgents } from './tmux';
import { trackAgents } from './closedagents';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', router);

// optional single-process mode: serve the built frontend if it exists
const dist = fileURLToPath(new URL('../web/dist', import.meta.url));
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      res.sendFile(path.join(dist, 'index.html'));
    } else next();
  });
}

const server = http.createServer(app);

const clampInt = (v: string | null, min: number, max: number, dflt: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const cols = clampInt(url.searchParams.get('cols'), 2, 500, 120);
  const rows = clampInt(url.searchParams.get('rows'), 2, 300, 32);
  wss.handleUpgrade(req, socket, head, (ws) => {
    void handleTerminalConnection(ws, decodeURIComponent(match[1]), cols, rows);
  });
});

// Name the session in the event so clients can invalidate ONE transcript
// instead of refetching every open chat on every write (~1.5 events/s here).
const SESSION_FILE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
startWatcher((filePath) => {
  const sessionId = SESSION_FILE.exec(filePath)?.[1]?.toLowerCase();
  const provider = filePath.includes('/.codex/') ? 'codex' : 'claude';
  broadcast('session-updated', { filePath, provider, sessionId });
});

// Reconcile the persisted live-agent snapshot against tmux once at boot, so
// agents that died while the server was down land in the closed list even
// before any browser client connects.
listAgents().then(trackAgents).catch(() => { /* tmux not up yet — poll retries */ });

// Nudge clients when tmux state changes (session died, agent exited, client attached).
let lastState = '';
setInterval(async () => {
  if (!hasClients()) return;
  // (interval widened 3s→5s: this listing is a spawn fan-out and the browser
  // polls /api/tmux on its own every 2s anyway)
  try {
    const agents = await listAgents();
    trackAgents(agents);
    const state = JSON.stringify(agents.map((a) => [a.name, a.agentRunning, a.attachedClients]));
    if (state !== lastState) {
      lastState = state;
      broadcast('tmux-changed');
    }
  } catch { /* transient tmux hiccup — next tick retries */ }
}, 5000);

server.listen(SERVER_PORT, '127.0.0.1', () => {
  console.log(`agent-visualizer server on http://127.0.0.1:${SERVER_PORT}`);
});
