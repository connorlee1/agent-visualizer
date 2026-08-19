# agent-visualizer

A local dashboard for keeping track of AI coding agents. Launch `claude` / `codex` agents inside tmux, watch and type to them from embedded terminals in the browser, browse every past conversation on the machine, and resume any of them with one click.

## Quickstart

```sh
git clone https://github.com/connorlee1/agent-visualizer
cd agent-visualizer
npm install
npm run dev        # server on :5175, UI on http://localhost:5173
```

Single-process mode (no Vite dev server): `npm run build && npm start`, then open http://localhost:5175.

### Requirements

- **macOS or Linux** with **tmux** installed and on PATH. If your tmux lives somewhere PATH doesn't cover, set `TMUX_BIN=/path/to/tmux`. (Developed on macOS; Linux should work but is less tested.)
- **Node 20+**. `npm install` compiles node-pty, a native module, so you need a C/C++ toolchain: Xcode Command Line Tools on macOS (`xcode-select --install`), `build-essential` + `python3` on Linux.
- The **`claude` and/or `codex` CLIs** on PATH and logged in — needed to launch and resume agents. Browsing existing transcripts works without them.
- The **`sqlite3` CLI** for live transcripts/status from newer Codex versions (0.147+ stream to `~/.codex/thread_history_1.sqlite`). Preinstalled on macOS; `apt install sqlite3` on Linux. Without it, Codex falls back to rollout files.

### Good to know

- The recap text on agent cards is written by background `claude -p --model haiku` calls (idle sessions only, max 2 concurrent, results cached) — these use your Claude quota. If you don't want that, don't run `claude` login on the machine, or rip out `server/sessions/summarizer.ts`.
- The server binds localhost only; nothing leaves your machine except those summarizer calls.
- Transcripts are read from `~/.claude/projects` and `~/.codex/sessions`; the dashboard's own state (agent names, closed-agent history, cached summaries) lives in `~/.agent-visualizer/`. Missing directories are fine — the corresponding lists are just empty.

## What it does

- **Home** — running agents as live-preview cards. Status is derived from the pane snapshot: green = working, yellow = waiting for input, **pulsing orange = needs your approval** (also badges the browser tab title). Below, the most recent conversations across all projects.
- **Terminal workspace** (`/agents/:name`) — a real `tmux attach` bridged to xterm.js over a WebSocket. Fully interactive; `tmux attach -t <name>` from a normal terminal works concurrently. The collapsible right-hand panel shows the live, readable transcript of the same conversation.
- **Projects** — every project directory found in `~/.claude/projects` and `~/.codex/sessions`, with 12-week activity sparkbars.
- **Transcript reader** — full conversation rendering: markdown, collapsed-by-default tool calls (click to expand input + result), thinking blocks, token counts, branch markers. Huge sessions open instantly (last 200 messages, "show earlier" pages back).
- **Resume** — any session row or the reader header. Launches `claude --resume <id>` / `codex resume <id>` in a fresh tmux session **in the conversation's original directory** and drops you into its terminal.
- **Rename** — the ⋮ menu on every agent card and pane header gives an agent a custom name (stored as `@agent_title` on the tmux session, so it survives server restarts). The same menu keeps the details a custom name hides: working directory (click to copy), the linked conversation tag (click to open its transcript), and the raw tmux session name.

Keyboard: `n` new agent · `1–9` jump to agent · `t` toggle transcript panel.

## How it works

```
server/            Express 5 + ws + node-pty + chokidar (port 5175, localhost-only)
  tmux.ts          execFile wrappers; sessions named agent-<provider>-<id>; metadata
                   stored as tmux user options (@agent_provider, @agent_cwd, ...) so
                   the backend is stateless across restarts
  terminal.ts      WS <-> node-pty <-> `tmux attach` bridge (binary = bytes, text = control)
  sessions/        JSONL index (head/tail 64KB chunks, never whole files) + full parse
                   with LRU cache; chokidar watch -> SSE -> UI refetch
shared/types.ts    normalized Session/Message shapes both providers map into
web/               Vite + React + TS + Tailwind v4 + TanStack Query + xterm.js
```

Notes:

- Closing a terminal in the dashboard **detaches** — only the Kill button ends a tmux session.
- New Claude agents launch with a pre-generated `--session-id`, so their transcript is linked from the first message.
- A resumed Codex conversation spans multiple rollout files with the same `session_id`; the dashboard groups them into one conversation and stitches the transcript.
- Claude `--resume` only works from the session's original cwd; the server always launches resumes there and errors clearly if the directory is gone.
