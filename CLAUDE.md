# Claude Code Command Center

A local dashboard of every Claude Code session. It's public on GitHub at
github.com/dennis897/claude-command-center (MIT). The README is the user guide; keep
it accurate when behaviour changes.

## How it fits together

- `hook.js` is a Claude Code hook. It appends one JSON line per event to
  `~/.claude/command-center/events.jsonl`. It must stay fast, print nothing and always
  exit 0, because it runs inside every session. The one exception: on
  `PermissionRequest` it asks the server whether to hold the request (Away mode) and,
  if so, waits for the board's decision and prints it. With Away mode off or the
  server down it must still return at once with no output.
- `install.js` adds or removes the hooks in `~/.claude/settings.json` (it backs that
  file up first) and copies `hook.js` to `~/.claude/command-center/`.
- `server.js` tails the events and transcripts (`~/.claude/projects`) and the desktop
  app's session records (`%APPDATA%\Claude\claude-code-sessions`). It serves
  `public/index.html` and sends live updates over SSE, on 127.0.0.1:4317 only.
- `supervise.js` restarts `server.js` whenever it exits. Exit code 3 means the port is
  taken: another copy is running, not a crash.
- `service.js` (Windows) copies the app to `~/.claude/command-center/app` and registers
  the "Claude Command Center" scheduled task (at logon, plus every 5 min).
- `demo.js` runs the server on a temp data folder with simulated sessions.

## Rules

- No npm dependencies. Node 18+ built-ins only.
- Every request that changes data must require the `X-CC` header (CSRF guard).
- Don't put personal details in the code, demo data or docs. The repo is public, so
  use generic examples (web-app, api-service, infra, mobile-app).
- User data stays in `~/.claude/command-center/` and is never committed.

## Workflow

- Check a change with `node --check <file>`, then `node demo.js` (port 4317; stop the
  background copy first, or set `CC_PORT=4318`).
- **The background copy runs from `~/.claude/command-center/app`, not this folder.**
  After editing, run `node service.js restart` to update it, and
  `node service.js status` to confirm.
- If `hook.js` changes, run `node install.js` again so the hook copy is updated.
- When asked to ship: commit with a clear message, then `git push` to `origin main`.
  Bump `version` in package.json for user-visible changes. Never force-push.
