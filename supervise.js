#!/usr/bin/env node
// Keeps server.js running: starts it, and if it exits for any reason, starts it again.
// Restarts back off from 2 s to 60 s while it keeps crashing, and reset once it has
// stayed up for a minute. Output goes to <data dir>/server.log (rotated at 5 MB).
// If another copy already holds the port (exit code 3), it waits and checks again.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DATA_DIR = process.env.CC_DATA_DIR || path.join(os.homedir(), '.claude', 'command-center');
const LOG = path.join(DATA_DIR, 'server.log');
const PID = path.join(DATA_DIR, 'supervisor.pid');
const SERVER = path.join(__dirname, 'server.js');
const MAX_LOG = 5 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > MAX_LOG) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] [supervisor] ${msg}\n`);
  } catch (_) {}
}

// Only one supervisor at a time.
try {
  const other = Number(fs.readFileSync(PID, 'utf8'));
  if (other && other !== process.pid) { process.kill(other, 0); log(`Supervisor ${other} is already running; exiting.`); process.exit(0); }
} catch (_) { /* no pid file, or that process is gone */ }
fs.writeFileSync(PID, String(process.pid));

let child = null;
let delay = 2000;
let stopping = false;

function start() {
  if (stopping) return;
  if (fs.existsSync(LOG) && fs.statSync(LOG).size > MAX_LOG) { try { fs.renameSync(LOG, LOG + '.1'); } catch (_) {} }
  const out = fs.openSync(LOG, 'a');
  const startedAt = Date.now();
  child = spawn(process.execPath, [SERVER], { stdio: ['ignore', out, out], windowsHide: true, env: process.env });
  fs.closeSync(out);
  log(`Started server (pid ${child.pid})`);
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    const upFor = Date.now() - startedAt;
    if (code === 3) {
      log('Port in use by another copy; checking again in 30 s.');
      return setTimeout(start, 30e3);
    }
    if (upFor > 60e3) delay = 2000;
    log(`Server exited (code ${code}${signal ? `, signal ${signal}` : ''}) after ${Math.round(upFor / 1000)} s; restarting in ${delay / 1000} s.`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 60e3);
  });
}

function stop() {
  stopping = true;
  log('Stopping.');
  if (child) child.kill();
  try { if (Number(fs.readFileSync(PID, 'utf8')) === process.pid) fs.unlinkSync(PID); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

start();
