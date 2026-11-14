#!/usr/bin/env node
// Adds (or with --uninstall removes) the Command Center hook in ~/.claude/settings.json.
// The hook script is copied to ~/.claude/command-center/hook.js so it runs from a
// local, space-free path rather than from a synced or temporary folder. Settings are backed up first.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const TARGET_DIR = path.join(CLAUDE_DIR, 'command-center');
const TARGET = path.join(TARGET_DIR, 'hook.js');
const MARK = 'command-center/hook.js';
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStop', 'PreCompact',
];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const HOLD_TIMEOUT_S = 1900;
// doctor.js reads these to check what's installed.
module.exports = { CLAUDE_DIR, SETTINGS, TARGET, MARK, EVENTS, TOOL_EVENTS, HOLD_TIMEOUT_S };
if (require.main === module) main();

function main() {
const uninstall = process.argv.includes('--uninstall');

let settings = {};
if (fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
    console.error(`Could not parse ${SETTINGS}: ${e.message}\nFix it by hand, then run this again.`);
    process.exit(1);
  }
  const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SETTINGS, backup);
  console.log(`Backed up settings → ${backup}`);
}

const isOurs = (group) => (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(MARK));
settings.hooks = settings.hooks || {};
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = (settings.hooks[ev] || []).filter((g) => !isOurs(g));
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}

if (!uninstall) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'hook.js'), TARGET);
  const command = `node "${TARGET.replace(/\\/g, '/')}"`;
  for (const ev of EVENTS) {
    // PermissionRequest can wait on the board in Away mode (the server gives up after
    // 30 minutes), so it gets a longer timeout than the others.
    const group = { hooks: [{ type: 'command', command, timeout: ev === 'PermissionRequest' ? HOLD_TIMEOUT_S : 5 }] };
    if (TOOL_EVENTS.has(ev)) group.matcher = '*';
    (settings.hooks[ev] = settings.hooks[ev] || []).push(group);
  }
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.mkdirSync(CLAUDE_DIR, { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(uninstall
  ? 'Command Center hooks removed. Restart Claude Code sessions to stop logging.'
  : `Command Center hooks installed for ${EVENTS.length} events.\nNew Claude Code sessions will report to ${path.join(TARGET_DIR, 'events.jsonl')}.\nRunning sessions pick it up after a restart.`);
}
