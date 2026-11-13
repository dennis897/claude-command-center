#!/usr/bin/env node
// Demo mode: starts the server on a throwaway data folder and feeds it simulated
// sessions through the real hook script, so you can see the board without
// installing anything. Ctrl+C to stop.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const DIR = path.join(os.tmpdir(), 'claude-command-center-demo');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const env = { ...process.env, CC_DATA_DIR: DIR, CLAUDE_CODE_ENTRYPOINT: 'cli' };

// Seed a few scratchpad items and project groups so those panels have something in them.
const key = (name) => { const p = path.resolve(os.homedir(), 'projects', name); return process.platform === 'win32' ? p.toLowerCase() : p; };
const cwdOf = (name) => path.join(os.homedir(), 'projects', name);
const t0 = Date.now();
fs.writeFileSync(path.join(DIR, 'scratchpad.json'), JSON.stringify([
  { id: 'demo1', text: 'Add rate limiting to the login endpoint', project: key('web-app'), createdAt: t0 - 40 * 60e3, doneAt: null },
  { id: 'demo2', text: 'Try the new image picker on Android', project: key('mobile-app'), createdAt: t0 - 3 * 3600e3, doneAt: null },
  { id: 'demo3', text: 'Compare Postgres connection poolers', project: null, createdAt: t0 - 26 * 3600e3, doneAt: null },
  { id: 'demo4', text: 'Rotate the staging deploy key', project: key('infra'), createdAt: t0 - 50 * 3600e3, doneAt: t0 - 3600e3 },
], null, 2));
fs.writeFileSync(path.join(DIR, 'projects.json'), JSON.stringify({
  [key('web-app')]: { cwd: cwdOf('web-app'), name: 'Web app', group: 'Product', pinned: true, notes: 'Customer-facing site and its API routes.' },
  [key('api-service')]: { cwd: cwdOf('api-service'), group: 'Product' },
  [key('infra')]: { cwd: cwdOf('infra'), group: 'Platform' },
  [key('mobile-app')]: { cwd: cwdOf('mobile-app'), group: 'Product', color: '#5AA9FF' },
  [key('claude-mods')]: { cwd: cwdOf('claude-mods'), group: 'Claude tooling', pinned: true },
}, null, 2));
// Run the server in this same process, so stopping the demo stops the server too.
process.env.CC_DATA_DIR = DIR;
require('./server.js');

// Send one event through hook.js exactly as Claude Code would.
function hook(sid, cwd, ev, extra = {}, entry = 'cli') {
  const payload = { session_id: sid, cwd, transcript_path: '', hook_event_name: ev, ...extra };
  spawnSync(process.execPath, [path.join(__dirname, 'hook.js')], { input: JSON.stringify(payload), env: { ...env, CLAUDE_CODE_ENTRYPOINT: entry } });
}

const P = (name) => path.join(os.homedir(), 'projects', name);
const script = [
  // [delay ms, sid, project, event, extra, entry]
  [0, 'demo-1', 'api-service', 'SessionStart', { source: 'startup' }],
  [0, 'demo-1', 'api-service', 'UserPromptSubmit', { prompt: 'Upgrade the ORM, run the migrations, then redeploy staging' }],
  [0, 'demo-2', 'web-app', 'UserPromptSubmit', { prompt: 'Add dark mode to the settings page' }, 'claude-desktop'],
  [0, 'demo-3', 'mobile-app', 'UserPromptSubmit', { prompt: 'Fix the crash on the onboarding screen' }, 'claude-desktop'],
  [0, 'demo-4', 'claude-mods', 'UserPromptSubmit', { prompt: 'Command center mod — hook bridge' }, 'claude-desktop'],
  [0, 'demo-5', 'infra', 'UserPromptSubmit', { prompt: 'Audit the Terraform state for drift' }],
  [0, 'demo-6', 'claude-mods', 'UserPromptSubmit', { prompt: 'Statusline with git branch and cost' }],
  [300, 'demo-6', 'claude-mods', 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'statusline.js' } }],
  [0, 'demo-6', 'claude-mods', 'PostToolUse', { tool_name: 'Write', tool_input: { file_path: 'statusline.js' }, tool_response: {} }],
  [0, 'demo-6', 'claude-mods', 'Stop', {}],
  [0, 'demo-7', 'mobile-app', 'SessionStart', { source: 'startup' }],
  [400, 'demo-1', 'api-service', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'docker-compose.yml' } }],
  [0, 'demo-4', 'claude-mods', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/hooks/session-events.ts' } }],
  [0, 'demo-5', 'infra', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'terraform plan' } }],
  [0, 'demo-2', 'web-app', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/settings/theme.ts' } }],
  [800, 'demo-1', 'api-service', 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'docker-compose.yml' }, tool_response: {} }],
  [0, 'demo-1', 'api-service', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'docker compose up -d --build' } }],
  [0, 'demo-1', 'api-service', 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }],
  [600, 'demo-2', 'web-app', 'PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: '5 steps · touches 3 components, adds a theme toggle to user settings' } }],
  [600, 'demo-3', 'mobile-app', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Keep the old onboarding flow behind a flag, or remove it?' }] } }],
];

(async () => {
  for (const [delay, sid, proj, ev, extra, entry] of script) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    hook(sid, P(proj), ev, extra, entry);
  }
  // Keep the running sessions busy so the board stays alive.
  const tools = [['Edit', { file_path: 'src/server.ts' }], ['Bash', { command: 'npm test' }], ['Grep', { pattern: 'TODO', path: 'src' }], ['Read', { file_path: 'README.md' }]];
  let i = 0;
  setInterval(() => {
    const [name, input] = tools[i++ % tools.length];
    const sid = i % 2 ? 'demo-4' : 'demo-5';
    const proj = i % 2 ? 'claude-mods' : 'infra';
    hook(sid, P(proj), 'PostToolUse', { tool_name: name, tool_input: input, tool_response: {} });
    hook(sid, P(proj), 'PreToolUse', { tool_name: name, tool_input: input });
  }, 2500);
})();

process.on('SIGINT', () => process.exit(0));
