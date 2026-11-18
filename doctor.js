#!/usr/bin/env node
// Checks that Command Center is set up and working, and says how to fix what isn't.
//
//   node doctor.js          run every check
//   node doctor.js --json   the same, as JSON
//
// Each check runs on its own, so one failure doesn't hide the others. Exits 1 when a
// check fails (warnings don't count). It only reads: nothing is changed or installed.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const install = require('./install.js');
const service = require('./service.js');

const DATA_DIR = process.env.CC_DATA_DIR || path.join(os.homedir(), '.claude', 'command-center');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const LOG = path.join(DATA_DIR, 'server.log');
const PORT = service.PORT;
const REPO_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const BIG_EVENTS = 200 * 1024 * 1024; // the server reads the whole log at startup

const results = [];
const ok = (name, detail) => results.push({ name, level: 'ok', detail });
const warn = (name, detail, fix) => results.push({ name, level: 'warn', detail, fix });
const fail = (name, detail, fix) => results.push({ name, level: 'fail', detail, fix });

const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const ago = (ms) => (ms < 90e3 ? `${Math.round(ms / 1e3)} s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)} h` : `${Math.round(ms / 86400e3)} days`);
const size = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function listFiles(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return [p];
  return fs.readdirSync(p).flatMap((f) => listFiles(path.join(p, f)));
}

// ---------- checks ----------

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok('Node.js', `v${process.versions.node}`);
  else fail('Node.js', `v${process.versions.node} is too old`, 'Install Node.js 18 or newer.');
}

let settings = null;
function checkSettings() {
  if (!fs.existsSync(install.SETTINGS)) return fail('Claude settings', `${install.SETTINGS} doesn't exist`, 'Run: node install.js');
  try { settings = JSON.parse(fs.readFileSync(install.SETTINGS, 'utf8') || '{}'); } catch (e) {
    return fail('Claude settings', `${install.SETTINGS} isn't valid JSON: ${e.message}`, 'Fix the file by hand (install.js keeps backups next to it), then run: node install.js');
  }
  if (settings.disableAllHooks === true) return fail('Claude settings', 'disableAllHooks is true, so no hook runs', `Remove "disableAllHooks" from ${install.SETTINGS}.`);
  ok('Claude settings', install.SETTINGS);
}

function checkHooks() {
  if (!settings) return;
  const hooks = settings.hooks || {};
  const ours = (g) => (g.hooks || []).filter((h) => typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(install.MARK));
  const missing = [], dupes = [], badMatcher = [];
  let permTimeout = null, command = null;
  for (const ev of install.EVENTS) {
    const groups = (hooks[ev] || []).filter((g) => ours(g).length);
    const n = groups.reduce((s, g) => s + ours(g).length, 0);
    if (!n) { missing.push(ev); continue; }
    if (n > 1) dupes.push(ev);
    if (install.TOOL_EVENTS.has(ev) && !groups.some((g) => g.matcher === '*' || g.matcher === undefined || g.matcher === '')) badMatcher.push(ev);
    const h = ours(groups[0])[0];
    command = command || h.command;
    if (ev === 'PermissionRequest') permTimeout = h.timeout;
  }
  if (missing.length === install.EVENTS.length) return fail('Hooks', 'not installed', 'Run: node install.js');
  // Report every problem: one fix (node install.js) clears them all, but each is worth knowing.
  const before = results.length;
  if (missing.length) fail('Hooks', `missing for ${missing.join(', ')}`, 'Run: node install.js');
  if (dupes.length) warn('Hooks', `installed more than once for ${dupes.join(', ')}, so those events are logged twice`, 'Run: node install.js (it removes the old entries first)');
  if (badMatcher.length) warn('Hooks', `${badMatcher.join(', ')} only match some tools`, 'Run: node install.js');
  if (!missing.includes('PermissionRequest') && !(permTimeout >= install.HOLD_TIMEOUT_S)) {
    warn('Hooks', `the PermissionRequest hook times out after ${permTimeout || 600} s, before a request held in Away mode would`, 'Run: node install.js');
  }
  const m = /node\s+"([^"]+)"/.exec(command || '');
  if (m && path.resolve(m[1]) !== path.resolve(install.TARGET)) warn('Hooks', `they run ${m[1]}, not ${install.TARGET}`, 'Run: node install.js');
  if (results.length === before) ok('Hooks', `installed for all ${install.EVENTS.length} events`);
}

function checkHookCopy() {
  if (!fs.existsSync(install.TARGET)) return fail('Hook script', `${install.TARGET} is missing, so every hook fails`, 'Run: node install.js');
  if (hash(install.TARGET) !== hash(path.join(__dirname, 'hook.js'))) return warn('Hook script', `${install.TARGET} is older or newer than hook.js here`, 'Run: node install.js');
  ok('Hook script', 'the installed copy matches hook.js');
}

// Run the installed hook as Claude Code would, writing to a throwaway folder. With
// PermissionRequest it also asks the server, so this shows it returns quickly.
function checkHookRuns() {
  if (!fs.existsSync(install.TARGET)) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-doctor-'));
  try {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [install.TARGET], {
      input: JSON.stringify({ session_id: 'cc-doctor', cwd: tmp, hook_event_name: 'SessionStart', source: 'startup' }),
      env: { ...process.env, CC_DATA_DIR: tmp }, timeout: 10e3, encoding: 'utf8', windowsHide: true,
    });
    const ms = Date.now() - t0;
    const wrote = fs.existsSync(path.join(tmp, 'events.jsonl'));
    if (r.error) return fail('Hook run', `couldn't run it: ${r.error.message}`, 'Check that node is on the PATH Claude Code uses.');
    if (r.status !== 0) return fail('Hook run', `exited with code ${r.status}: ${String(r.stderr).trim().split('\n').pop()}`, 'Run: node install.js');
    if (r.stdout) return fail('Hook run', 'it printed output, which Claude Code would read', 'Run: node install.js');
    if (!wrote) return fail('Hook run', 'it ran but logged nothing', 'Run: node install.js');
    if (ms > 2000) return warn('Hook run', `took ${ms} ms; every session waits this long on each event`, 'Check for antivirus scanning node.exe or a slow disk.');
    ok('Hook run', `logs an event in ${ms} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function checkBackground() {
  if (process.platform !== 'win32') return ok('Background', 'not managed here on macOS or Linux (see node service.js)');
  const state = service.taskState();
  if (!state) return warn('Background task', 'not installed, so the dashboard runs only while you start it', 'Run: node service.js install');
  if (state === 'Disabled') return fail('Background task', 'the task is disabled', 'Enable "Claude Command Center" in Task Scheduler, or run: node service.js install');
  ok('Background task', `${service.TASK} (${state})`);
  if (!fs.existsSync(service.APP_DIR)) return fail('Background copy', `${service.APP_DIR} is missing`, 'Run: node service.js restart');
  const differ = [];
  for (const f of service.FILES) {
    const src = path.join(__dirname, f);
    if (!fs.existsSync(src)) continue;
    for (const file of listFiles(src)) {
      const rel = path.relative(__dirname, file);
      const dst = path.join(service.APP_DIR, rel);
      if (!fs.existsSync(dst) || hash(dst) !== hash(file)) differ.push(rel.replace(/\\/g, '/'));
    }
  }
  if (differ.length) return warn('Background copy', `differs from this folder: ${differ.slice(0, 5).join(', ')}${differ.length > 5 ? ` and ${differ.length - 5} more` : ''}`, 'Run: node service.js restart');
  ok('Background copy', `matches this folder (${service.APP_DIR})`);
}

let health = null;
async function checkServer() {
  const r = await get('/api/health');
  if (!r) return fail('Server', `nothing answers at http://localhost:${PORT}`, process.platform === 'win32' ? `Run: node service.js restart, then look at ${LOG}` : 'Start it: node server.js');
  if (r.code === 404) return warn('Server', 'an older version is running (it has no /api/health)', process.platform === 'win32' ? 'Run: node service.js restart' : 'Restart node server.js');
  try { health = JSON.parse(r.body); } catch (_) { return fail('Server', `http://localhost:${PORT} answered, but not like Command Center`, `Another program may be using port ${PORT}. Set CC_PORT to use another port.`); }
  const where = path.resolve(health.dir) === path.resolve(service.APP_DIR) ? 'the background copy' : health.dir;
  if (health.version !== REPO_VERSION) return warn('Server', `running v${health.version} from ${where}; this folder is v${REPO_VERSION}`, process.platform === 'win32' ? 'Run: node service.js restart' : 'Restart node server.js');
  if (path.resolve(health.dataDir) !== path.resolve(DATA_DIR)) warn('Server', `reads ${health.dataDir}, but the hooks write to ${DATA_DIR}`, 'Unset CC_DATA_DIR, or set it the same for both.');
  else ok('Server', `v${health.version} up ${ago(Date.now() - health.startedAt)}, from ${where} · ${health.transcripts} transcripts indexed`);
}

function checkEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return warn('Events', 'no events logged yet', 'Start a new Claude Code session (sessions started before installing need a restart).');
  const st = fs.statSync(EVENTS_FILE);
  // The last complete line should parse.
  const fd = fs.openSync(EVENTS_FILE, 'r');
  const len = Math.min(st.size, 64 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  // Only complete lines: a session may be writing the last one right now.
  const lines = buf.toString('utf8').split('\n').slice(0, -1).filter((l) => l.trim());
  let last = null;
  try { last = JSON.parse(lines[lines.length - 1]); } catch (_) {}
  const age = Date.now() - st.mtimeMs;
  if (!last) warn('Events', `the last line of ${EVENTS_FILE} isn't valid JSON`, 'Usually harmless (one bad line is skipped). If it keeps happening, check the disk.');
  if (st.size > BIG_EVENTS) warn('Events', `${EVENTS_FILE} is ${size(st.size)}; the server reads it all when it starts`, 'Stop the server, move the file aside, and start it again (only the last 48 hours are shown anyway).');
  if (age > 7 * 86400e3) return warn('Events', `nothing logged for ${ago(age)}`, 'If you have used Claude Code since then, check the Hooks lines above, and restart your sessions.');
  if (last) ok('Events', `last event ${ago(age)} ago (${last.ev || 'unknown'}) · ${size(st.size)}`);
}

function checkDataFiles() {
  const bad = [];
  for (const f of ['settings.json', 'scratchpad.json', 'projects.json', 'archived.json', 'hidden.json', 'done.json', 'usage.json']) {
    const p = path.join(DATA_DIR, f);
    if (!fs.existsSync(p)) continue;
    try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { bad.push(f); }
  }
  if (bad.length) return fail('Data files', `not valid JSON: ${bad.join(', ')}. The server starts with them empty and overwrites them on your next change`, `Copy them somewhere safe now, then fix or remove them in ${DATA_DIR}.`);
  ok('Data files', DATA_DIR);
}

function checkAway() {
  if (!health) return;
  if (health.away) warn('Away mode', `on${health.holds ? `, with ${health.holds} request${health.holds === 1 ? '' : 's'} waiting on the board` : ''}: sessions wait on the board for permission, not in their own dialog`, 'Turn it off on the board when you are back at your desk.');
  else ok('Away mode', 'off: sessions ask for permission themselves');
}

function checkLog() {
  if (!fs.existsSync(LOG)) return;
  const st = fs.statSync(LOG);
  const len = Math.min(st.size, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(LOG, 'r');
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  const since = Date.now() - 86400e3;
  let errors = 0, restarts = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    const m = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\]/.exec(line);
    if (!m || Date.parse(m[1]) < since) continue;
    if (/uncaughtException|unhandledRejection/.test(line)) errors++;
    // Code 4294967295 (-1) is the server being killed from outside, e.g. by
    // service.js restart: not a crash.
    if (/Server exited/.test(line) && !/code (4294967295|-1)\b/.test(line)) restarts++;
  }
  if (restarts) return warn('Server log', `${restarts} crash${restarts === 1 ? '' : 'es'} and ${errors} error${errors === 1 ? '' : 's'} in the last 24 h`, `Look at ${LOG}`);
  if (errors) return warn('Server log', `${errors} error${errors === 1 ? '' : 's'} in the last 24 h (the server kept running)`, `Look at ${LOG}`);
  ok('Server log', 'no errors in the last 24 h');
}

// ---------- run ----------
(async () => {
  const checks = [checkNode, checkSettings, checkHooks, checkHookCopy, checkHookRuns, checkBackground, checkServer, checkEvents, checkDataFiles, checkAway, checkLog];
  for (const c of checks) {
    try { await c(); } catch (e) { fail(c.name.replace(/^check/, ''), `the check itself failed: ${e.message}`); }
  }
  const failed = results.filter((r) => r.level === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ version: REPO_VERSION, failed, warned, results }, null, 2));
  } else {
    const color = process.stdout.isTTY && !process.env.NO_COLOR;
    const paint = (c, s) => (color ? `\x1b[${c}m${s}\x1b[0m` : s);
    const mark = { ok: paint(32, '✓'), warn: paint(33, '!'), fail: paint(31, '✗') };
    const w = Math.max(...results.map((r) => r.name.length));
    console.log(`Command Center doctor (v${REPO_VERSION})\n`);
    for (const r of results) {
      console.log(` ${mark[r.level]} ${r.name.padEnd(w)}  ${r.detail}`);
      if (r.fix) console.log(` ${' '.repeat(w + 4)}${paint(2, '→ ' + r.fix)}`);
    }
    console.log(`\n${failed ? paint(31, `${failed} problem${failed === 1 ? '' : 's'}`) : paint(32, 'All good')}${warned ? `, ${warned} warning${warned === 1 ? '' : 's'}` : ''}.`);
  }
  process.exit(failed ? 1 : 0);
})();
