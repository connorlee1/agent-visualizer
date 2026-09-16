# Agent Visualizer desktop

The first Electron version for macOS. It uses the existing React UI and backend;
the browser and remote-server entry points remain available.

From the repository root, with its existing dependencies installed:

```sh
npm --prefix desktop install
npm --prefix desktop run dev
```

`dev` builds a snapshot of the UI and backend, then opens Electron. It does not
watch files; rebuild/relaunch to pick up edits. After building, use
`npm --prefix desktop start` to open it again.

## Coexistence with the browser app

- The desktop app checks `http://127.0.0.1:5175/api/health`. If a compatible
  backend is already running, it reuses it and **never stops it on quit**.
- If port 5175 refuses connections, Electron starts its bundled backend and
  stops only that child process on quit. Agent tmux sessions survive; their
  terminal attachments and desktop-owned SSH tunnels are cleaned up.
- If another service occupies 5175, or health checks fail, startup reports an
  error instead of replacing anything or choosing a different backend port.
  Stable callback URLs matter for agents that outlive the desktop app.
- The desktop UI uses its own loopback gateway on **5176**. That port must be
  free. The gateway serves `desktop/build/web/dist` and forwards API calls,
  live events, and terminal sockets to 5175. It never replaces `web/dist`.
- Dependencies live in `desktop/node_modules`. Electron's rebuilt `node-pty`
  never replaces the browser server's Node-native copy in root `node_modules`.
- On macOS, closing the window keeps the application alive; **Quit / Cmd+Q**
  closes it. Reopening via the Dock restores the window.

Transcript and application files stay in their existing home-directory paths.
Desktop display preferences are stored separately from browser localStorage.
Using the desktop controls still operates on the same real agents and machines.
If a reused backend is stopped externally, restart it or reopen the desktop app;
the app does not take over that process automatically.

## Requirements

`tmux` and logged-in `claude` and/or `codex` installations are still required for
local agents; `ssh`, `sqlite3`, and `lsof` retain their existing roles. Electron
bundles the dashboard's Node runtime, not the agent CLIs. Finder launches resolve
PATH from a bounded login-shell query, with common Homebrew and local-bin fallbacks.
Set `TMUX_BIN` to an absolute path if necessary.

This initial version uses backend port 5175 regardless of a shell's `PORT` setting.
Native Windows support is not implemented because the backend depends on tmux and
Unix tools. Linux packaging is configured but not yet validated.

## Build and verify

```sh
npm --prefix desktop run build          # output only in desktop/build
npm --prefix desktop test               # fake backend / ownership / proxy checks
npm --prefix desktop run test:electron  # hidden window + isolated native PTY
npm --prefix desktop run pack           # unpacked app in desktop/release
npm --prefix desktop run dist           # macOS DMG in desktop/release
```

To check the packaged UI and native dependencies after `pack` on Apple Silicon:

```sh
npm --prefix desktop run test:electron -- --app-dir "release/mac-arm64/Agent Visualizer.app/Contents/Resources/app.asar"
```

The Electron smoke check uses a temporary browser profile, a fake HTTP backend,
and a short-lived `/bin/sh` PTY inside an Electron utility process. External web
requests are blocked during this check. It does not start the real server, attach
to tmux, read transcripts, or change agent state. Run the build before the smoke
check.

Build tools use the repository's Vite setup and installed frontend dependencies.
The packaged app includes its own backend dependencies and runs independently of
the source checkout. Native binaries and node-pty's executable helper are unpacked
from ASAR. `npm --prefix desktop run rebuild` repairs the desktop native module
after an Electron version change.

The current macOS output is **unsigned**, intended for local testing. Signing,
notarization, automatic updates, and clean-machine validation
remain release work. Do not distribute this as a finished release yet.
