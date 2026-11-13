#!/usr/bin/env node
// Runs Command Center in the background, starting at logon (Windows).
//
//   node service.js install     copy the app to ~/.claude/command-center/app, register
//                               the logon task and start it now
//   node service.js restart     copy the app again (after an update) and restart it
//   node service.js status      show whether the task and the server are up
//   node service.js uninstall   stop it and remove the task (your data is kept)
//
// The task runs supervise.js, which restarts server.js whenever it exits. The task
// also fires every 5 minutes, which starts the supervisor again if it was stopped. It runs
// as you, only while you're signed in, and needs no admin rights. conhost --headless
// keeps it from opening a console window.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const TASK = 'Claude Command Center';
const DATA_DIR = process.env.CC_DATA_DIR || path.join(os.homedir(), '.claude', 'command-center');
const APP_DIR = path.join(DATA_DIR, 'app');
const PID = path.join(DATA_DIR, 'supervisor.pid');
const PORT = Number(process.env.CC_PORT || 4317);
const FILES = ['server.js', 'supervise.js', 'hook.js', 'package.json', 'public'];

const cmd = process.argv[2];

if (process.platform !== 'win32') {
  console.log(`Background mode is Windows-only for now.
On macOS, run supervise.js from a launchd agent (~/Library/LaunchAgents) with RunAtLoad and KeepAlive.
On Linux, use a systemd user service: ExecStart=${process.execPath} ${path.join(__dirname, 'supervise.js')}, Restart=always.`);
  process.exit(cmd ? 1 : 0);
}

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function copyApp() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const f of FILES) {
    const src = path.join(__dirname, f);
    const dst = path.join(APP_DIR, f);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  console.log(`Copied the app to ${APP_DIR}`);
}

function killSupervisor() {
  let pid;
  try { pid = Number(fs.readFileSync(PID, 'utf8')); } catch (_) { return; }
  if (!pid) return;
  try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  try { fs.unlinkSync(PID); } catch (_) {}
}

function register() {
  const args = `--headless "${process.execPath}" "${path.join(APP_DIR, 'supervise.js')}"`;
  ps(`
    $action   = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psq(args)} -WorkingDirectory ${psq(APP_DIR)}
    $logon    = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    # Every 5 minutes: does nothing while it runs (IgnoreNew), starts it if it has stopped.
    $check    = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $trigger  = @($logon, $check)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName ${psq(TASK)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Keeps the Claude Code Command Center dashboard running (http://localhost:${PORT}).' -Force | Out-Null
  `);
  console.log(`Registered the "${TASK}" task (starts at logon).`);
}

function startTask() {
  ps(`Start-ScheduledTask -TaskName ${psq(TASK)}`);
}

function taskState() {
  try { return ps(`(Get-ScheduledTask -TaskName ${psq(TASK)} -ErrorAction Stop).State`); } catch (_) { return null; }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForServer(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function status() {
  const state = taskState();
  const code = await ping();
  console.log(`Task:   ${state ? `${TASK} (${state})` : 'not installed'}`);
  console.log(`Server: ${code ? `up at http://localhost:${PORT}` : 'not responding'}`);
  console.log(`Log:    ${path.join(DATA_DIR, 'server.log')}`);
}

(async () => {
  switch (cmd) {
    case 'install':
    case 'restart': {
      if (cmd === 'restart' && !taskState()) { console.log('Not installed. Run: node service.js install'); process.exit(1); }
      killSupervisor();
      copyApp();
      if (cmd === 'install') register();
      startTask();
      const up = await waitForServer();
      console.log(up
        ? `Command Center is running → http://localhost:${PORT}`
        : `Started, but the server isn't answering yet. Check ${path.join(DATA_DIR, 'server.log')} (or another copy may hold port ${PORT}).`);
      break;
    }
    case 'uninstall':
      try { ps(`Stop-ScheduledTask -TaskName ${psq(TASK)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psq(TASK)} -Confirm:$false -ErrorAction Stop`); console.log(`Removed the "${TASK}" task.`); }
      catch (_) { console.log('The task was not installed.'); }
      killSupervisor();
      console.log(`Stopped. Your data in ${DATA_DIR} is kept.`);
      break;
    case 'status':
      await status();
      break;
    default:
      console.log('Usage: node service.js install | restart | status | uninstall');
      process.exit(cmd ? 1 : 0);
  }
})();
