# Claude Code Command Center

A live board of every Claude Code session on this PC: **Needs you**, **Running** and **Done**.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer and Claude Code. There's nothing else to install.

```bash
git clone https://github.com/dennis897/claude-command-center.git
cd claude-command-center
node demo.js               # optional: try it with simulated sessions first
node install.js            # add the hooks to ~/.claude/settings.json
node service.js install    # Windows: run it in the background, start at logon
```

Open http://localhost:4317. Sessions you start after installing the hooks appear on the board.

Everything stays on your machine. The server listens only on `127.0.0.1` and reads your local `~/.claude` folder. Nothing is sent anywhere.

Tested on Windows 11. The board and hooks work on macOS and Linux too. The desktop-app link and background mode are Windows-first; see [Keep it running](#keep-it-running-windows).

## How it works

```
Claude Code session ──hook──▶ hook.js ──append──▶ ~/.claude/command-center/events.jsonl
                                                         │ (tailed)
                                    browser ◀──SSE── server.js (127.0.0.1:4317)
```

- `hook.js` runs on each hook event. It writes one short line and prints nothing, so it never affects the session.
- `server.js` turns those events into a status for each session:

| Event | Board status |
|---|---|
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | Running |
| `Notification` (permission_prompt), `PermissionRequest` | Needs you · Permission (in Away mode, with Allow / Deny on the card) |
| `PreToolUse` on `AskUserQuestion` / `ExitPlanMode` | Needs you · Question / Plan review |
| `Stop` | Done (with Claude's last reply as the recap) |
| `SessionStart` | Done · Ready for a prompt |
| `SessionEnd` | Removed from the board, unless its turn finished: then it stays in Done |

**Done stays until you clear it.** A session whose turn finished stays in the Done column until you press **Clear** on its card (or **Clear all**), archive it in the desktop app, or give it a new prompt. That holds when its process ends, after a day of quiet, and across restarts: finished sessions are remembered in `~/.claude/command-center/done.json` (the newest 500). Clear only changes the board's own lists; it never touches the session. A session that was only opened (Ready) still drops off as before.

The server needs no dependencies, only Node 18 or newer.

## Approve from the board (Away mode)

Turn on **Away mode** (sidebar, under Approvals) and permission requests wait on the board instead of in the session. Each one shows what Claude wants to run (the command, or the file and the lines it changes) with:
- **Allow:** this once.
- **Always allow `<rule>`:** allow it and add the rule Claude Code suggested (for example `Bash(npm test:*)`) to the project's settings, so it won't ask again. It only appears when Claude Code offers a rule.
- **Deny:** Claude is told no. On the Focus page you can add a reason, which Claude reads.
- **Hand back to session:** the session shows its own permission dialog.

How it works: the `PermissionRequest` hook asks the server whether to hold the request. With Away mode off, or the server not running, it returns at once and nothing changes. With it on, the hook waits until you decide, then prints the decision and Claude Code applies it. While a request is held, the session doesn't show its own dialog, so turn Away mode off when you're back at your desk. Turning it off hands every held request back. A request waits at most 30 minutes, then the session asks you itself.

- An **allow** here can't override a deny or ask rule in your Claude Code settings. Claude Code still checks those.
- Questions (`AskUserQuestion`) and plan reviews (`ExitPlanMode`) are never held: answer those in the session.
- Away mode is saved in `~/.claude/command-center/settings.json`.
- After updating, run `node install.js` again: it gives the `PermissionRequest` hook a 1900 s timeout so it can wait.

## Scratchpad

The panel to the right of the board holds quick to-dos that aren't ready for a session yet.
- Press `N` anywhere to add one. Type `#name` to tag a project (for example, `#web` matches web-app), or pick a project from the list.
- Click an item's text to edit it. Tick its box when it's done.
- The ▶ button copies a PowerShell command that opens Claude in that project's folder with the to-do as your first prompt.
- Items are saved in `~/.claude/command-center/scratchpad.json`.

## Usage (tokens and cache)

The **Usage** page shows how many tokens your Claude Code sessions used on this computer, read from the `usage` each reply records in its transcript:
- **Today** and **last 7 days:** total tokens, input that wasn't cached, output, cache writes, cache reads, and the cache hit rate (cache reads ÷ all input).
- **Tokens per day** for the last 14 days (hover a bar for its numbers, or show it as a table), and a split **by model**.
- **Sessions** active in the last 7 days, most recent first, with today's and the week's numbers. A subagent's tokens count toward the session that started it. Click a row for its Focus page.

Each transcript is read from where the last pass stopped, every 30 s; the offsets and running totals are kept in `~/.claude/command-center/usage.json`, so a restart reads only what's new. The first pass reads everything once, in the background (a few minutes for several GB). A reply is written as one line per content block, each repeating the same usage, so each message is counted once. Your plan's usage limits aren't shown: only Anthropic's servers know them, and the board never reads your sign-in token.

## Email (optional)

If something on your machine sorts your mail and writes a small JSON snapshot after each run, the board can show it: an **Email** strip on the Overview and an **Email** page with the Urgent and To-Do lists (grouped by thread, each with **Open in Outlook**), drafts waiting, what you promised (with Overdue / Due tags) and what you're waiting on. Click an email or a draft to see its first lines (its `preview`) without leaving the board. It's "as of the last sort"; a link goes to the sorter's own live page for anything newer. The board only reads the file: it never sends, moves or deletes mail.

Point the board at the file in `~/.claude/command-center/settings.json` (or set `CC_MAIL_SNAPSHOT`), then restart the server:

```json
{
  "mailSnapshot": "C:\\path\\to\\portal-email.json",
  "mailSchedule": { "days": [1, 2, 3, 4, 5], "times": ["08:30", "12:30", "16:30"] }
}
```

`mailSchedule` (local time; days 0 = Sunday) is optional: with it the board shows the next run and warns when one was missed (no run within 10 minutes of a run time, 20 minutes after it). The server re-reads the file whenever it changes; write it to a temp file and rename it over the old one so the board never sees half a file. If the file is missing or isn't valid JSON, the Email page says so and the rest of the board carries on. The snapshot's shape:

```json
{"generatedUtc": "2026-01-05T15:35:10Z", "runStamp": "2026-01-05-1530",
 "lastRun": {"status": "ok", "windowStartUtc": "…", "windowEndUtc": "…", "finishedUtc": "…",
             "counts": {"urgent": 1, "todo": 4, "fyi": 12, "noise": 3, "alreadyTagged": 0}, "drafts": 1, "note": ""},
 "since": "<7 days back>", "counts": {"urgent": 3, "todo": 12, "fyiToday": 40, "noiseToday": 9},
 "urgent": [{"subject": "…", "from": "Sender", "receivedUtc": "…", "webLink": "https://…", "draftReady": false,
             "preview": "the first couple of hundred characters of the email"}],
 "todo": [],
 "drafts": [{"subject": "…", "to": "Name, Name", "webLink": "https://…", "preview": "…"}],
 "waiting": {"promised": [{"who": "…", "date": "2026-01-04", "subject": "…", "what": "…", "due": "2026-01-06"}], "others": []},
 "page": "https://… (the sorter's live page)"}
```

Only `https://` links are shown, and text is shown as text, never as HTML.

**Mark read (optional).** The board can't change your mail, but it can pass a request to whatever writes the snapshot. Add `"mailRequests": "C:\\path\\to\\board-requests.json"` to `settings.json` (or set `CC_MAIL_REQUESTS`) and restart the server, and each thread with unread mail gets a **Mark read** button. It needs each message's `id` and `isRead` in the snapshot (`"urgent": [{"id": "…", "isRead": false, …}]`). Pressing it adds the message to that file; pressing **Queued ✓** takes it off again:

```json
{"updatedUtc": "…", "requests": [{"id": "r…", "action": "mark-read", "messageId": "…", "subject": "…", "at": "…"}]}
```

Your sorting job reads the file on its next run, acts on the requests (for example, tags the messages so you can mark them read in bulk), and lists the request ids it handled in the snapshot's `"requestsDone": ["r…"]`. The board then drops them from the file; only the board writes it. List message ids that are already handled in `"markRead": ["…"]` and the board shows **In Mark read** instead of the button. Requests need the `X-CC` header like every other change.

## Projects (hub)

The server reads every transcript in `~/.claude/projects`. It reads each file once at startup (about 1–2 s for 180 MB) and after that only new lines, every 10 s. From the transcripts it gets each session's title (your rename first, then Claude's generated one), branch, host, prompt count, cost and lines changed.

- **One project per repo.** A git worktree's `.git` file points back to `<repo>/.git/worktrees/<name>`, so worktree sessions are filed under their repo. Sessions started in a subfolder are filed under the repo that contains it. Two folders with the same name are labelled with where each one lives.
- **Project page:**
  - a **Branches** row (main plus each worktree, with the session working in it); a worktree is **stale** after 3 days with nothing running in it
  - **Sessions** by recency (Now / Today / This week / Earlier) or by branch
  - **To-dos** and **Notes** for the project
- **Edit** sets the display name, group, color and notes. Pin and Archive work as before. All of this is saved in `projects.json`.

## Focus (one session up close)

Clicking any session opens its Focus page: a board card, a row in the Sessions table, or a session in a project. The page has:
- **On the left:** a queue of sessions (Needs you, Running, Done, then Recent), so you can jump between them.
- **In the middle:** the session's status and, when it's waiting, what it's waiting for. Answer it in the session itself; the dashboard can't approve or reply. Below that, Claude's last reply and the activity (your prompts, Claude's messages, tool calls and errors), newest first.
- **On the right:**
  - **Plan:** the session's latest task list.
  - **Context window:** tokens used, cost, and files edited with approximate lines added and removed.
  - **Session facts:** when it started, prompts, lines changed, folder and session id.

The details come from the session's transcript (`GET /api/sessions/<id>/detail`), so they work for old sessions too. A large transcript takes a couple of seconds the first time and is quick after that. The context limit isn't recorded in transcripts, so it's assumed to be 200k, or 1M once a session has gone past 200k. `Esc` goes back to the overview.

## Open in Claude (desktop app)

The desktop app keeps a small record for each Code session in `%APPDATA%\Claude\claude-code-sessions\…\local_<id>.json`. Each record links the app's own id (`local_…`) to the transcript id, and holds the sidebar title and the app's archive flag. The server reads these every 10 s. Because of them:
- Session titles match the desktop sidebar.
- Sessions you archive in the app are treated as archived here too.
- Every desktop session gets an **Open in Claude** button: on its board card, on the Focus page, and as a ↗ icon in the Sessions table.

Clicking it asks the server to open `claude://code/continue?session=local_<id>`, the same link the app uses in its own Windows jump list. On Windows the server opens it with `rundll32 url.dll,FileProtocolHandler`. `explorer.exe <link>`, run from the background server, did nothing. The server only opens ids the app itself recorded. Sessions started in a terminal don't have one; use **Copy resume command** for those.

## Sessions (table)

Every session in every project, grouped by project, project group, status or day. You can filter by status and search titles and branches. Saved views include Needs me, Today, Stale worktrees and Untouched 2+ weeks, and you can save your own; they're stored in this browser. Click a row for its details and its resume command.

- **Archive** only hides a session in this dashboard (`archived.json`). The desktop app's own archive isn't readable from here.
- **Remove worktree** runs `git worktree remove` without `--force`. Git refuses if the worktree has uncommitted or untracked changes, and the branch is kept. It asks for confirmation first and refuses for a worktree with a session still working in it.

Every change the dashboard makes must carry an `X-CC` header, including Allow and Deny. Other websites can't add that header to a request without your server's approval, and the server never gives it, so they can't change your data.

## Use it

```bash
node demo.js                  # simulated sessions, nothing installed
node install.js               # add the hooks to ~/.claude/settings.json (backs it up first)
node server.js                # run it in the foreground, then open http://localhost:4317
node install.js --uninstall   # remove the hooks
node doctor.js                # check that everything is set up and working
```

Keyboard: `/` search · `J`/`K` move between cards · `Enter` details · `C` copy the resume command · `Esc` close.

## Check your setup (doctor)

```bash
node doctor.js
```

It checks each part and says how to fix what isn't right:
- **Node.js** version.
- **Claude settings** parse, and hooks aren't turned off.
- **Hooks** are installed for every event, once each, with the long `PermissionRequest` timeout Away mode needs.
- **Hook script:** the installed copy matches `hook.js`, and it runs. A test event is written to a throwaway folder, and it must take under 2 s and print nothing.
- **Background task** is registered and the **background copy** in `~/.claude/command-center/app` matches this folder (Windows).
- **Server** answers, and runs the same version as this folder.
- **Events** are arriving, the last line is valid, and `events.jsonl` isn't so big it slows the server's start.
- **Data files** (`scratchpad.json`, `projects.json` and the rest) are valid JSON.
- **Away mode** is on or off, and how many requests are waiting.
- **Server log:** crashes and errors in the last 24 hours.

It only reads; it changes nothing. It exits with 1 when a check fails (warnings don't count), so it works in scripts. `node doctor.js --json` prints the results as JSON.

## Keep it running (Windows)

```bash
node service.js install     # start at logon, restart if it stops
node service.js status
node service.js restart     # after pulling an update
node service.js uninstall   # stop it and remove the task; your data is kept
```

`install` copies the app to `~/.claude/command-center/app` and registers a Task Scheduler task named **Claude Command Center**. It runs as you, only while you're signed in, and needs no admin rights. The task:
- starts `supervise.js` at logon, with no console window (`conhost --headless`)
- fires again every 5 minutes. If the supervisor is still running, that does nothing; if it stopped, it starts again.

`supervise.js` restarts `server.js` whenever it exits. It waits 2 s before the first restart and longer (up to 60 s) if it keeps crashing. Server output goes to `~/.claude/command-center/server.log`. The server logs unexpected errors and keeps running; it only exits if it gets 20 in a minute.

If you run `node server.js` yourself while the task is running, the second copy finds the port taken and exits.

On macOS or Linux, `node service.js` prints a launchd / systemd recipe that runs `supervise.js` instead.

## Limits (v0.5)

- **Questions and plan reviews** are answered in the session. Permission requests can be answered on the board with [Away mode](#approve-from-the-board-away-mode).
- **Away mode is all or nothing.** While it's on, every session's permission requests wait on the board, including the one you're sitting at.
- **Cloud sessions** run their hooks on the remote machine, so they don't show up here.
- A session whose terminal is killed without a `SessionEnd` event stays on the board and is flagged **stale** after 20 minutes. You can clear it.
- **Usage** counts only what's in transcripts on this computer: not cloud sessions, other machines, or claude.ai chats.
