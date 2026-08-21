#!/usr/bin/env bash
# Install and start the visualizer server on a remote machine (RunPod pod,
# VM, …) so the local dashboard can add it as a Machine.
#
#   ./scripts/remote-setup.sh root@203.0.113.7 -p 22023 -i ~/.ssh/id_ed25519
#
# Everything after the destination is passed to ssh/rsync verbatim. The
# server ends up running inside a tmux session named "agent-visualizer" on
# the remote, listening on 127.0.0.1:5175 (reached only through the
# dashboard's ssh tunnel — nothing is exposed publicly).
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <ssh-destination> [extra ssh args...]" >&2
  exit 1
fi

DEST="$1"; shift
SSH_ARGS=("$@")
REMOTE_DIR=".agent-visualizer-app"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run() { ssh "${SSH_ARGS[@]}" "$DEST" "$@"; }

echo "==> checking remote prerequisites"
run 'set -e
  command -v node >/dev/null || { echo "MISSING: node (install Node 20+)"; exit 1; }
  command -v npm  >/dev/null || { echo "MISSING: npm"; exit 1; }
  command -v tmux >/dev/null || { echo "MISSING: tmux (apt-get install -y tmux)"; exit 1; }
  tmux -V
  command -v lsof >/dev/null || echo "WARN: lsof missing — live pane↔conversation linkage degrades (apt-get install -y lsof)"
  command -v sqlite3 >/dev/null || echo "WARN: sqlite3 missing — live codex transcripts degrade (apt-get install -y sqlite3)"
  command -v claude >/dev/null || echo "WARN: claude CLI not on PATH — claude agents will not launch"
  command -v codex  >/dev/null || echo "WARN: codex CLI not on PATH — codex agents will not launch"'

echo "==> syncing code to $DEST:~/$REMOTE_DIR"
rsync -az --delete \
  --exclude node_modules --exclude web/dist --exclude .git \
  -e "ssh ${SSH_ARGS[*]:-}" \
  "$REPO_ROOT/" "$DEST:$REMOTE_DIR/"

echo "==> installing dependencies and building (first run takes a few minutes)"
run "cd $REMOTE_DIR && npm install --no-audit --no-fund && npm run build"

echo "==> (re)starting the server in tmux session 'agent-visualizer'"
run "tmux kill-session -t agent-visualizer 2>/dev/null || true
     cd $REMOTE_DIR && tmux new-session -d -s agent-visualizer 'npm start'"

echo "==> waiting for the server to answer"
for i in $(seq 1 15); do
  if run "curl -sf -m 2 http://127.0.0.1:5175/api/health >/dev/null"; then
    echo "==> up. Add this machine in the dashboard sidebar with:"
    echo "    ssh $DEST ${SSH_ARGS[*]:-}"
    exit 0
  fi
  sleep 2
done
echo "server did not come up — check: ssh $DEST ${SSH_ARGS[*]:-} tmux attach -t agent-visualizer" >&2
exit 1
