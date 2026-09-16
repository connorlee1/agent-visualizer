import { app, BrowserWindow, Menu, dialog, shell, utilityProcess } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { acquireBackend } from './backend.mjs';
import { desktopEnvironment, requireTmux } from './environment.mjs';
import { startGateway } from './gateway.mjs';
import { isAppNavigation, allowPermission } from './security.mjs';

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const backendUrl = 'http://127.0.0.1:5175';
let mainWindow;
let backend;
let gateway;
let quitting = false;
let cleanupComplete = false;
let startup;
let startupReady = false;
let backendLog = '';

function reportFailure(title, error) {
  const detail = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(title, `${detail}${backendLog ? `\n\nBackend output:\n${backendLog}` : ''}`);
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      void shell.openExternal(parsed.href).catch((error) => reportFailure('Could not open link', error));
    }
  } catch { /* malformed links are ignored */ }
}

function createWindow() {
  if (quitting || !startupReady || !gateway) return;
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
    title: 'Agent Visualizer', backgroundColor: '#111827',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const window = mainWindow;
  const origin = new URL(gateway.url).origin;
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents && allowPermission(permission, details.requestingUrl || contents.getURL(), origin));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    return contents === window.webContents && allowPermission(permission, requestingOrigin, origin);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  const restrictNavigation = (event, url) => {
    if (isAppNavigation(url, origin)) return;
    event.preventDefault();
    // API responses may contain local file contents; never navigate into them.
    try { if (new URL(url).origin !== origin) openExternal(url); } catch { /* reject */ }
  };
  window.webContents.on('will-navigate', restrictNavigation);
  window.webContents.on('will-redirect', restrictNavigation);
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  void window.loadURL(gateway.url).catch((error) => {
    if (!quitting) { reportFailure('Could not load Agent Visualizer', error); app.quit(); }
  });
}

async function start() {
  const backendEntry = path.join(desktopDir, 'build/server/index.mjs');
  const distDir = path.join(desktopDir, 'build/web/dist');
  await access(path.join(distDir, 'index.html'));
  // Reserve the UI port before any backend can start or touch persisted state.
  gateway = await startGateway({ backendUrl, distDir, port: 5176 });
  if (quitting) return;
  backend = await acquireBackend({
    url: backendUrl,
    spawn: async () => {
      await access(backendEntry);
      const env = await desktopEnvironment();
      env.TMUX_BIN = await requireTmux(env);
      env.PORT = '5175';
      if (quitting) throw new Error('Application is shutting down');
      const child = utilityProcess.fork(backendEntry, [], {
        cwd: os.homedir(), env, stdio: 'pipe', serviceName: 'Agent Visualizer Backend',
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on('data', (chunk) => { backendLog = (backendLog + chunk.toString()).slice(-6000); });
      }
      return child;
    },
    onUnexpectedExit: (code) => {
      if (!quitting) {
        reportFailure('Agent Visualizer backend stopped', new Error(`The desktop backend exited (code ${code}). Your tmux agent sessions are preserved. Reopen the app to reconnect.`));
        app.quit();
      }
    },
  });
  if (quitting) return;
  startupReady = true;
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) createWindow();
    else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  app.on('activate', () => { if (!mainWindow) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    if (cleanupComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      try {
        await startup?.catch(() => {});
        await gateway?.close();
      } catch (error) {
        console.error('Could not close the desktop gateway:', error);
      } finally {
        try {
          await backend?.close();
        } catch (error) {
          console.error('Could not close the desktop backend:', error);
        } finally {
          cleanupComplete = true;
          app.quit();
        }
      }
    })();
  });
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    startup = start();
    void startup.catch((error) => {
      if (!quitting) { reportFailure('Agent Visualizer could not start', error); app.quit(); }
    });
  });
}
