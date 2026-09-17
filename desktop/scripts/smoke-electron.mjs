// Run from desktop/: ./node_modules/.bin/electron scripts/smoke-electron.mjs
// Everything uses temporary state and a fake backend; no agents are contacted.
import { app, BrowserWindow, utilityProcess } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway } from '../src/gateway.mjs';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'agent-visualizer-electron-smoke-'));
for (const name of ['userData', 'sessionData']) {
  const directory = path.join(temporary, name);
  mkdirSync(directory);
  app.setPath(name, directory);
}
app.setPath('logs', path.join(temporary, 'logs'));
app.on('window-all-closed', () => {});

let window;
let gateway;
let nativeChild;
let nativeChildExited;
let finishing = false;
const sockets = new Set();
const requested = new Set();
const fatal = [];
const fake = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  requested.add(pathname);
  if (req.method !== 'GET') {
    fatal.push(`Unexpected mutating request: ${req.method} ${pathname}`);
    res.writeHead(405).end();
  } else if (pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': smoke backend connected\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pathname === '/api/health'
      ? { ok: true, tmuxRunning: false, version: '0.1.0', instanceId: 'isolated-smoke-backend' }
      : []));
  }
});
fake.on('connection', socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  const forceExit = setTimeout(() => app.exit(1), 5000);
  try {
    if (nativeChild) {
      nativeChild.kill();
      await Promise.race([
        nativeChildExited,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Utility process did not stop')), 2000)),
      ]);
    }
    if (window && !window.isDestroyed()) window.destroy();
    await gateway?.close();
    const closed = new Promise(resolve => fake.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
    await rm(temporary, { recursive: true, force: true });
  } catch (cleanupError) {
    error ||= cleanupError;
  }
  console.log(JSON.stringify({
    ok: !error,
    checks: ['built React UI renders', 'sandboxed renderer', 'fake API and SSE', 'utility-process runtime dependencies and native node-pty'],
    requested: [...requested],
    ...(error ? { error: error.stack || String(error) } : {}),
  }, null, 2));
  clearTimeout(forceExit);
  app.exit(error ? 1 : 0);
}

const deadline = setTimeout(() => void finish(new Error('Electron smoke check timed out after 30 seconds')), 30_000);
process.on('uncaughtException', error => void finish(error));
process.on('unhandledRejection', error => void finish(error));

// Electron emits ready only after evaluating its ESM entrypoint. Start this
// async task without awaiting it at module scope so ready can actually fire.
async function run() {
  console.log('Electron smoke: starting isolated checks');
  try {
    const option = process.argv.indexOf('--app-dir');
    if (option !== -1 && (!process.argv[option + 1] || process.argv[option + 1].startsWith('--'))) {
      throw new Error('--app-dir requires a desktop directory or packaged app.asar path');
    }
    const appDir = option === -1
      ? fileURLToPath(new URL('..', import.meta.url))
      : path.resolve(process.argv[option + 1]);
    console.log(`Electron smoke: testing assets and runtime dependencies in ${appDir}`);
    await app.whenReady();
    console.log('Electron smoke: app ready');
    await new Promise((resolve, reject) => {
      fake.once('error', reject);
      fake.listen(0, '127.0.0.1', resolve);
    });
    gateway = await startGateway({
      backendUrl: `http://127.0.0.1:${fake.address().port}`,
      distDir: path.join(appDir, 'build/web/dist'),
      port: 0,
    });
    console.log(`Electron smoke: fake backend and gateway ready at ${gateway.url}`);
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'electron-smoke' },
    });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: url.origin !== gateway.url && !['data:', 'blob:'].includes(url.protocol) });
    });
    console.log('Electron smoke: hidden window ready; external requests blocked');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== gateway.url) event.preventDefault();
    });
    window.webContents.on('render-process-gone', (_event, details) => fatal.push(`Renderer exited: ${details.reason}`));
    // DevTools captures exceptions from the first application script onward,
    // without adding a preload or weakening the renderer sandbox.
    window.webContents.debugger.attach('1.3');
    window.webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        fatal.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
      }
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        fatal.push(params.args.map(arg => arg.description || String(arg.value)).join(' '));
      }
    });
    // The initial renderer may not exist until navigation starts. Queue
    // Runtime.enable alongside navigation rather than blocking it on ready.
    await Promise.all([
      window.webContents.debugger.sendCommand('Runtime.enable'),
      window.loadURL(gateway.url),
    ]);
    console.log('Electron smoke: page loaded');
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const root = document.querySelector('#root');
        if (root?.querySelector('main h1')?.textContent === 'Agents') {
          if (typeof require !== 'undefined' || typeof process !== 'undefined') {
            reject(new Error('Node globals exposed in renderer'));
          } else resolve(true);
        } else if (Date.now() - started > 10000) reject(new Error('React home page did not render'));
        else setTimeout(check, 50);
      };
      check();
    })`);
    // Ensure React effects reached the fake backend, rather than just painting
    // a static shell before failing to fetch data.
    const until = Date.now() + 5000;
    while ((!requested.has('/api/tmux') || !requested.has('/api/events')) && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(requested.has('/api/tmux'), 'UI did not request fake agent data');
    assert(requested.has('/api/events'), 'UI did not connect to fake event stream');
    const health = await window.webContents.executeJavaScript("fetch('/api/health').then(response => response.json())");
    assert.equal(health.instanceId, 'isolated-smoke-backend');
    console.log('Electron smoke: UI and fake API verified; checking utility process');

    // Resolve dependencies from the selected app, including app.asar, rather
    // than accidentally accepting the development directory's native module.
    const childScript = path.join(temporary, 'native-smoke.mjs');
    await writeFile(childScript, String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
const [appDir, directory] = process.argv.slice(2);
const require = createRequire(path.join(appDir, 'package.json'));
let terminal;
let done = false;
function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timeout);
  try { terminal?.kill(); } catch {}
  process.parentPort.postMessage({ ok: !error, error: error?.stack || (error ? String(error) : undefined) });
  setTimeout(() => process.exit(error ? 1 : 0), 50);
}
const timeout = setTimeout(() => finish(new Error('Native PTY timed out')), 5000);
process.on('SIGTERM', () => finish(new Error('Native smoke interrupted')));
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
try {
  const manifest = require('./package.json');
  for (const dependency of Object.keys(manifest.dependencies)) {
    const resolved = require.resolve(dependency);
    if (!resolved.startsWith(path.join(appDir, 'node_modules') + path.sep)) {
      throw new Error('Dependency resolved outside the selected app: ' + dependency);
    }
    require(dependency);
  }
  const { spawn } = require('node-pty');
  let output = '';
  terminal = spawn('/bin/sh', ['-c', 'printf electron-native-pty-ok'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: directory,
    env: { PATH: '/usr/bin:/bin', HOME: directory, TERM: 'xterm-256color' },
  });
  terminal.onData(data => { output += data; });
  terminal.onExit(({ exitCode }) => {
    terminal = undefined;
    finish(exitCode === 0 && output.includes('electron-native-pty-ok')
      ? undefined : new Error('Native PTY failed: exit=' + exitCode + ', output=' + JSON.stringify(output)));
  });
} catch (error) { finish(error); }
`);
    await new Promise((resolve, reject) => {
      let result;
      let stderr = '';
      nativeChild = utilityProcess.fork(childScript, [appDir, temporary], {
        cwd: temporary,
        env: { ...process.env, HOME: temporary },
        stdio: 'pipe',
        serviceName: 'Agent Visualizer isolated native smoke',
      });
      nativeChild.stdout?.resume();
      nativeChild.stderr?.on('data', data => { stderr = (stderr + data).slice(-8000); });
      nativeChild.on('message', message => { result = message; });
      nativeChildExited = new Promise(exited => nativeChild.once('exit', code => {
        nativeChild = undefined;
        exited();
        if (code === 0 && result?.ok) resolve();
        else reject(new Error(result?.error || `Utility process failed: exit=${code}, stderr=${stderr}`));
      }));
    });
    assert.deepEqual(fatal, [], 'Renderer reported fatal errors');
    await finish();
  } catch (error) {
    await finish(error);
  }
}

void run();
