#!/usr/bin/env node
// Command Center server: tails the events.jsonl written by hook.js, turns hook
// events into per-session state, and streams that state to the dashboard (SSE).
// No dependencies. Listens on 127.0.0.1 only.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');

const DATA_DIR = process.env.CC_DATA_DIR || path.join(os.homedir(), '.claude', 'command-center');
const EVENTS = path.join(DATA_DIR, 'events.jsonl');
const HIDDEN_FILE = path.join(DATA_DIR, 'hidden.json');
const PORT = Number(process.env.CC_PORT || process.env.PORT || 4317);
const RETAIN_MS = 48 * 3600e3;       // ignore events older than this on load
const STALE_MS = 20 * 60e3;          // running/needs with no events this long → stale
const PUBLIC = path.join(__dirname, 'public');
const SCRATCH_FILE = path.join(DATA_DIR, 'scratchpad.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const CLAUDE_PROJECTS = process.env.CC_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');

const sessions = new Map();
let hidden = new Set();
try { hidden = new Set(JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8'))); } catch (_) {}

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } };
function writeJson(f, v) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
}
// Scratchpad: [{id, text, project (cwd key or null), createdAt, doneAt}]
let scratch = readJson(SCRATCH_FILE, []);
// Project settings the user adds on top of what is discovered, keyed by projectKey(cwd).
let projectMeta = readJson(PROJECTS_FILE, {});

const projectKey = (cwd) => (cwd ? (process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd)) : null);

// ---------- transcript index ----------
// Every session Claude Code has run is a transcript at ~/.claude/projects/<dir>/<id>.jsonl.
// Transcripts only ever grow, so each file is read once and after that only its new bytes.
const { StringDecoder } = require('string_decoder');
const ARCHIVE_FILE = path.join(DATA_DIR, 'archived.json');
let archived = new Set(readJson(ARCHIVE_FILE, []));
const index = new Map();      // sessionId -> transcript facts
const fileState = new Map();  // file -> {offset, carry, dec}

// Value of a "key":"string" field, taken from the end of a line without parsing it
// (lines can be megabytes of tool output; the metadata fields sit at the end).
function tailField(line, key) {
  const i = line.lastIndexOf(`"${key}":"`);
  if (i < 0) return null;
  const start = i + key.length + 4;
  let j = start;
  while (j < line.length && !(line[j] === '"' && line[j - 1] !== '\\')) j++;
  try { return JSON.parse('"' + line.slice(start, j) + '"'); } catch (_) { return null; }
}

function parseLine(r, line) {
  if (line.includes('"type":"custom-title"')) { try { r.customTitle = JSON.parse(line).customTitle || r.customTitle; } catch (_) {} return; }
  if (line.includes('"type":"ai-title"')) { try { r.aiTitle = JSON.parse(line).aiTitle || r.aiTitle; } catch (_) {} return; }
  if (line.includes('"type":"cost-state"')) {
    try {
      const j = JSON.parse(line); const c = j.state || j;
      if (c.totalCostUSD != null) r.cost = c.totalCostUSD;
      if (c.totalLinesAdded != null) r.added = c.totalLinesAdded;
      if (c.totalLinesRemoved != null) r.removed = c.totalLinesRemoved;
    } catch (_) {}
    return;
  }
  // A command started in the background: it can keep running after the turn ends.
  if (line.includes('"run_in_background":true') && line.includes('"type":"assistant"')) {
    try {
      const j = JSON.parse(line);
      const ts = Date.parse(j.timestamp) || 0;
      for (const c of (j.message && j.message.content) || []) {
        if (c.type === 'tool_use' && c.input && c.input.run_in_background && typeof c.input.command === 'string') {
          (r.bg = r.bg || []).push({ cmd: c.input.command.slice(0, 4000), ts });
          if (r.bg.length > 20) r.bg.shift();
        }
      }
    } catch (_) {}
  }
  if (!line.includes('"cwd":"')) return;
  const cwd = tailField(line, 'cwd');
  if (cwd) r.cwd = cwd;
  const br = tailField(line, 'gitBranch');
  if (br && br !== 'HEAD') r.branch = br; // "HEAD" is what's recorded outside a git repo
  if (!r.host) r.host = tailField(line, 'entrypoint');
  if (!r.startedAt) { const t = Date.parse(tailField(line, 'timestamp') || ''); if (t) r.startedAt = t; }
  // A prompt you typed (not a tool result or an injected meta message).
  if (line.startsWith('{"parentUuid"') && line.includes('"type":"user"') && !line.includes('"isMeta":true') &&
      (line.includes('"turnOrigin":"human"') || line.includes('"role":"user","content":"'))) {
    r.prompts++;
    if (!r.firstPrompt) {
      try {
        const c = JSON.parse(line).message.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
        if (text && !text.startsWith('<')) r.firstPrompt = text.slice(0, 300);
      } catch (_) {}
    }
  }
}

function scanTranscripts() {
  let dirs = [];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { return false; }
  let changed = false;
  for (const d of dirs) {
    const dir = path.join(CLAUDE_PROJECTS, d.name);
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch (_) { continue; }
      const id = name.slice(0, -6);
      let fsx = fileState.get(file);
      if (!fsx || st.size < fsx.offset) {
        fsx = { offset: 0, carry: '', dec: new StringDecoder('utf8') };
        fileState.set(file, fsx);
        index.set(id, { id, file, prompts: 0, cost: null, added: null, removed: null });
      }
      const r = index.get(id);
      if (r.lastAt !== st.mtimeMs) { r.lastAt = st.mtimeMs; changed = true; }
      if (st.size === fsx.offset) continue;
      try {
        const fd = fs.openSync(file, 'r');
        const CH = 4 << 20;
        let pos = fsx.offset;
        while (pos < st.size) {
          const len = Math.min(CH, st.size - pos);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, pos);
          pos += len;
          const lines = (fsx.carry + fsx.dec.write(buf)).split('\n');
          fsx.carry = lines.pop();
          for (const l of lines) if (l) parseLine(r, l);
        }
        fs.closeSync(fd);
        fsx.offset = st.size;
        changed = true;
      } catch (_) {}
    }
  }
  return changed;
}

// ---------- background jobs ----------
// A session's turn can end while a command it started in the background keeps
// running; the app still shows such a session as working, and no hook fires for it.
// Every 10 s the shells running Claude's Bash tool (their command line names
// Claude's shell snapshot) are listed and matched to the background commands the
// transcripts recorded, on letters and digits only: the shell's quoting adds
// nothing else. (The PowerShell tool keeps its command out of the command line, so
// its background jobs are not seen.)
const jobs = new Map(); // session id -> { count, cmd }
const alnum = (s) => String(s).replace(/[^A-Za-z0-9]/g, '');
let scanningJobs = false;
function scanJobs() {
  if (process.platform !== 'win32' || scanningJobs) return;
  const cutoff = Date.now() - 24 * 3600e3;
  const cands = [];
  for (const r of index.values()) {
    for (const b of r.bg || []) {
      const key = alnum(b.cmd).slice(0, 80);
      if (b.ts > cutoff && key.length >= 12) cands.push({ sid: r.id, key, cmd: b.cmd });
    }
  }
  if (!cands.length) { if (jobs.size) { jobs.clear(); push(); } return; }
  scanningJobs = true;
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | ForEach-Object { $_.CommandLine } | ConvertTo-Json -Compress";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20e3, maxBuffer: 32 << 20 }, (err, out) => {
    scanningJobs = false;
    if (err) return;
    let list;
    try { const v = JSON.parse(String(out).trim() || '[]'); list = Array.isArray(v) ? v : [v]; } catch (_) { return; }
    const procs = list.filter((l) => typeof l === 'string' && l.includes('shell-snapshots')).map(alnum);
    const next = new Map();
    for (const c of cands) {
      if (!procs.some((p) => p.includes(c.key))) continue;
      const j = next.get(c.sid) || { count: 0, cmd: c.cmd };
      j.count++;
      next.set(c.sid, j);
    }
    const changed = JSON.stringify([...next]) !== JSON.stringify([...jobs]);
    jobs.clear();
    for (const [k, v] of next) jobs.set(k, v);
    if (changed) push();
  });
}

// ---------- Claude desktop app sessions ----------
// The desktop app keeps one record per Code session at
// %APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_<id>.json. It links the
// app's own id (local_…, the only id its claude://code/continue?session= link accepts)
// to the transcript id, and has the sidebar title and the app's archive flag.
const DESKTOP_DIR = process.env.CC_DESKTOP_SESSIONS || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
const desktopFiles = new Map(); // file -> {mtime, rec}
const desktopByCli = new Map(); // transcript id -> {localId, title, archived}
const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/;
function scanDesktop() {
  const seen = new Set();
  let changed = false;
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        seen.add(p);
        let mt;
        try { mt = fs.statSync(p).mtimeMs; } catch (_) { continue; }
        const hit = desktopFiles.get(p);
        if (hit && hit.mtime === mt) continue;
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          desktopFiles.set(p, { mtime: mt, rec: { localId: j.sessionId, cli: [j.cliSessionId, j.lastAssistantCliSessionId].filter(Boolean), title: j.title || null, archived: !!j.isArchived } });
          changed = true;
        } catch (_) {}
      }
    }
  };
  walk(DESKTOP_DIR, 0);
  for (const p of [...desktopFiles.keys()]) if (!seen.has(p)) { desktopFiles.delete(p); changed = true; }
  if (changed) {
    desktopByCli.clear();
    for (const { rec } of desktopFiles.values()) {
      if (!rec.localId || !LOCAL_ID.test(rec.localId)) continue;
      for (const c of rec.cli) desktopByCli.set(c, rec);
    }
  }
  return changed;
}

// ---------- repos and worktrees ----------
// A worktree's ".git" is a file: "gitdir: <repo>/.git/worktrees/<name>". That is how a
// worktree is folded back into its project. A removed worktree is recognised by the
// <repo>/.claude/worktrees/<name> folder layout the Claude apps use.
const repoCache = new Map();
function resolveRepo(cwd) {
  const k = projectKey(cwd);
  const hit = repoCache.get(k);
  if (hit && Date.now() - hit.at < 60e3) return hit.v;
  let v = { root: cwd, worktree: null, exists: fs.existsSync(cwd) };
  try {
    const g = path.join(cwd, '.git');
    if (fs.statSync(g).isFile()) {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
      const gitdir = m && path.resolve(cwd, m[1].trim());
      const w = gitdir && /^(.*)[\\/]\.git[\\/]worktrees[\\/]([^\\/]+)$/.exec(gitdir);
      if (w) v = { root: path.resolve(w[1]), worktree: { name: w[2], path: cwd, gitdir }, exists: true };
    }
  } catch (_) {}
  if (!v.worktree) {
    const w = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)$/.exec(cwd);
    if (w) v = { root: w[1], worktree: { name: w[2], path: cwd, gitdir: null }, exists: v.exists };
  }
  if (!v.worktree) {
    // A session started in a subfolder belongs to the repo that contains it.
    const home = path.resolve(os.homedir());
    let dir = path.dirname(path.resolve(cwd));
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      for (let i = 0; i < 6 && dir.length > home.length; i++) {
        if (fs.existsSync(path.join(dir, '.git'))) { v = { ...v, root: dir }; break; }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }
  }
  repoCache.set(k, { at: Date.now(), v });
  return v;
}
function headBranch(gitdir) {
  try {
    const ref = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
    return ref.startsWith('ref: ') ? ref.replace('ref: refs/heads/', '') : ref.slice(0, 7);
  } catch (_) { return null; }
}

// The name the desktop app shows for a project: its git remote's repository name
// (github.com/<owner>/my-app.git -> my-app), else the folder's name.
const remoteNames = new Map();
function displayName(root) {
  const hit = remoteNames.get(root);
  if (hit && Date.now() - hit.at < 300e3) return hit.name;
  let name = path.basename(root);
  try {
    const cfg = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg) || /url\s*=\s*(\S+)/.exec(cfg);
    const repo = m && /([^/:\\]+?)(?:\.git)?\/?$/.exec(m[1].trim());
    if (repo && repo[1]) name = repo[1];
  } catch (_) {}
  remoteNames.set(root, { at: Date.now(), name });
  return name;
}

const PALETTE = ['#FFB547', '#5AA9FF', '#7FE0BC', '#C49BFF', '#FF8F8F', '#F5D76E', '#6FD3E0', '#F29BCB'];
function hashColor(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
const STALE_WT_MS = 3 * 86400e3;

// Projects (one per repo, worktrees folded in) and one row per session ever run.
function buildModel(live) {
  const now = Date.now();
  const liveById = new Map(live.map((s) => [s.id, s]));
  const projects = new Map();
  const getP = (root) => {
    const key = projectKey(root);
    let p = projects.get(key);
    if (!p) {
      const meta = projectMeta[key] || {};
      p = {
        key, cwd: root, name: meta.name || displayName(root), color: meta.color || hashColor(path.basename(root)),
        group: meta.group || '', notes: meta.notes || '', pinned: !!meta.pinned, archived: !!meta.archived,
        branch: gitBranch(root), exists: fs.existsSync(root), qual: '',
        lastActive: 0, sessions: 0, week: 0, needs: 0, running: 0, done: 0, todos: 0, cost: 0, wt: new Map(),
      };
      projects.set(key, p);
    }
    return p;
  };
  const history = [];
  const addRow = (r, l) => {
    const cwd = r.cwd || (l && l.cwd);
    if (!cwd) return;
    const repo = resolveRepo(cwd);
    const p = getP(repo.root);
    const lastAt = Math.max(r.lastAt || 0, l ? l.lastAt : 0);
    const status = l ? l.status : 'idle';
    const dk = desktopByCli.get(r.id);
    const row = {
      id: r.id, title: (dk && dk.title) || r.customTitle || r.aiTitle || firstLine(r.firstPrompt, 90) || (l && l.title) || 'Untitled session',
      desktopId: dk ? dk.localId : null, desktopArchived: dk ? dk.archived : false,
      projectKey: p.key, cwd, branch: r.branch || (l && l.branch) || null,
      worktree: repo.worktree ? repo.worktree.name : null, host: entryLabel(r.host) || (l && l.host) || null,
      prompts: r.prompts || 0, cost: r.cost, added: r.added, removed: r.removed,
      startedAt: r.startedAt || (l && l.startedAt) || lastAt, lastAt,
      archived: archived.has(r.id) || (dk ? dk.archived : false), status, kind: l ? l.kind : null, now: l ? l.now : null, detail: l ? l.detail : null,
    };
    history.push(row);
    p.sessions++;
    if (now - lastAt < 7 * 86400e3) p.week++;
    p.lastActive = Math.max(p.lastActive, lastAt);
    p.cost += r.cost || 0;
    if (repo.worktree) {
      const wk = projectKey(repo.worktree.path);
      let w = p.wt.get(wk);
      if (!w) {
        w = { name: repo.worktree.name, path: repo.worktree.path, branch: null, exists: repo.exists, lastActive: 0, sessions: 0, title: null, status: 'idle', live: false };
        p.wt.set(wk, w);
      }
      w.branch = (repo.worktree.gitdir && headBranch(repo.worktree.gitdir)) || row.branch || w.branch;
      w.sessions++;
      if (lastAt >= w.lastActive) { w.lastActive = lastAt; w.title = row.title; w.status = status; }
      if (status === 'running' || status === 'needs') { w.live = true; w.status = status; w.title = row.title; }
    }
  };
  for (const r of index.values()) addRow(r, liveById.get(r.id));
  for (const s of live) if (!index.has(s.id)) addRow({ id: s.id }, s); // brand-new session, transcript not scanned yet
  for (const s of live) { const p = projects.get(projectKey(resolveRepo(s.cwd).root)); if (p) p[s.status === 'needs' ? 'needs' : s.status === 'running' ? 'running' : 'done']++; }
  for (const key of Object.keys(projectMeta)) if (projectMeta[key].cwd && !projects.has(key)) getP(projectMeta[key].cwd);
  for (const t of scratch) if (!t.doneAt && t.project && projects.has(t.project)) projects.get(t.project).todos++;

  const list = [...projects.values()];
  // Two projects with the same folder name: label each with where it lives.
  const byName = {};
  list.forEach((p) => { (byName[p.name.toLowerCase()] = byName[p.name.toLowerCase()] || []).push(p); });
  Object.values(byName).filter((ps) => ps.length > 1).forEach((ps) => ps.forEach((p) => {
    const parts = p.cwd.split(/[\\/]/).filter(Boolean);
    p.qual = parts.slice(-3, -1).join(' · ');
  }));
  for (const p of list) {
    p.worktrees = [...p.wt.values()].map((w) => ({ ...w, stale: w.exists && !w.live && now - w.lastActive > STALE_WT_MS }))
      .sort((a, b) => (b.exists - a.exists) || (b.lastActive - a.lastActive));
    p.staleWorktrees = p.worktrees.filter((w) => w.stale).length;
    delete p.wt;
  }
  list.sort((a, b) => (b.pinned - a.pinned) || (b.lastActive - a.lastActive));
  history.sort((a, b) => b.lastAt - a.lastAt);
  return { projects: list, history };
}
let lastModel = { projects: [], history: [] };

// ---------- one session in detail (Focus page) ----------
// Read from the transcript on request, incrementally like the index: activity,
// the latest plan, context-window use and files edited.
const details = new Map(); // file -> state
const shortTool = (n) => String(n || '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^ccd_\w+?__/, '');
function toolSummary(input) {
  if (!input || typeof input !== 'object') return String(input || '');
  for (const k of ['command', 'file_path', 'url', 'pattern', 'description', 'query', 'prompt', 'text']) if (typeof input[k] === 'string') return input[k];
  if (Array.isArray(input.questions) && input.questions[0]) return input.questions[0].question;
  if (Array.isArray(input.items)) return input.items.map((i) => i.content).join(' · ');
  if (Array.isArray(input.todos)) return input.todos.map((i) => i.content).join(' · ');
  return JSON.stringify(input);
}
const lineCount = (s) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);
function applyPlan(st, name, input) {
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    st.plan = input.todos.map((t) => ({ content: t.content, status: t.status }));
  } else if (/update_plan$/.test(name)) {
    if (Array.isArray(input.items)) st.plan = input.items.map((t) => ({ content: t.content, status: t.status }));
    if (!st.plan) return;
    const idx = (n) => st.plan[n - 1];
    if (input.advance) {
      const cur = st.plan.findIndex((t) => t.status === 'in_progress');
      if (cur >= 0) st.plan[cur].status = 'completed';
      const next = st.plan.findIndex((t, i) => i > cur && t.status === 'pending');
      if (next >= 0) st.plan[next].status = 'in_progress';
    }
    for (const n of input.done || []) if (idx(n)) idx(n).status = 'completed';
    if (input.start && idx(input.start)) idx(input.start).status = 'in_progress';
  }
}
function parseDetailLine(st, line) {
  const human = line.includes('"type":"user"') && !line.includes('"isMeta":true') &&
    (line.includes('"turnOrigin":"human"') || line.includes('"role":"user","content":"'));
  const isAsst = line.includes('"type":"assistant"');
  const isErr = !human && line.includes('"type":"user"') && line.includes('"is_error":true');
  if (!human && !isAsst && !isErr) return;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  const ts = Date.parse(j.timestamp) || 0;
  const push = (kind, text) => { st.activity.push({ ts, kind, text: String(text || '').slice(0, 400) }); if (st.activity.length > 300) st.activity.splice(0, 100); };
  const c = j.message && j.message.content;
  if (human) {
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
    if (text && !text.startsWith('<')) push('You', text);
    return;
  }
  if (isErr) {
    for (const x of Array.isArray(c) ? c : []) if (x.type === 'tool_result' && x.is_error) {
      const t = typeof x.content === 'string' ? x.content : Array.isArray(x.content) ? x.content.map((y) => y.text || '').join(' ') : '';
      push('Error', t.replace(/<\/?[a-z_]+>/g, '').trim());
    }
    return;
  }
  const m = j.message || {};
  if (m.model && m.model !== '<synthetic>') st.model = m.model;
  if (m.usage) {
    const u = m.usage;
    st.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  }
  for (const x of Array.isArray(c) ? c : []) {
    if (x.type === 'text' && x.text && x.text.trim()) { push('Claude', x.text.trim()); st.lastReply = x.text.trim().slice(0, 1500); }
    if (x.type === 'tool_use') {
      const name = x.name || '';
      const input = x.input || {};
      push(shortTool(name) || 'Tool', toolSummary(input));
      applyPlan(st, name, input);
      const fp = input.file_path || input.notebook_path;
      if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) {
        const f = st.files.get(fp) || { path: fp, added: 0, removed: 0, edits: 0 };
        f.edits++;
        if (name === 'Write') f.added += lineCount(input.content);
        else if (name === 'MultiEdit' && Array.isArray(input.edits)) input.edits.forEach((e) => { f.added += lineCount(e.new_string); f.removed += lineCount(e.old_string); });
        else { f.added += lineCount(input.new_string || input.new_source); f.removed += lineCount(input.old_string); }
        st.files.set(fp, f);
      }
    }
  }
}
function sessionDetail(file) {
  let st = details.get(file);
  let size;
  try { size = fs.statSync(file).size; } catch (_) { return null; }
  if (!st || size < st.offset) {
    st = { offset: 0, carry: '', dec: new StringDecoder('utf8'), activity: [], plan: null, context: 0, model: null, lastReply: null, files: new Map() };
    details.set(file, st);
    if (details.size > 30) details.delete(details.keys().next().value); // keep a few recently viewed
  }
  if (size > st.offset) {
    const fd = fs.openSync(file, 'r');
    let pos = st.offset;
    while (pos < size) {
      const len = Math.min(4 << 20, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      const lines = (st.carry + st.dec.write(buf)).split('\n');
      st.carry = lines.pop();
      for (const l of lines) if (l) parseDetailLine(st, l);
    }
    fs.closeSync(fd);
    st.offset = size;
  }
  // The context limit isn't recorded: past 200k tokens it must be the 1M window.
  const limit = st.context > 200e3 ? 1e6 : 200e3;
  return {
    activity: st.activity.slice(-80), plan: st.plan, model: st.model, lastReply: st.lastReply,
    context: st.context, contextLimit: limit,
    files: [...st.files.values()].sort((a, b) => b.edits - a.edits).slice(0, 40), fileCount: st.files.size,
  };
}

// ---------- helpers ----------
const branchCache = new Map();
function gitBranch(cwd) {
  if (!cwd) return null;
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 30e3) return hit.branch;
  let branch = null, dir = cwd;
  for (let i = 0; i < 12 && dir; i++) {
    try {
      let head = path.join(dir, '.git');
      if (fs.statSync(head).isFile()) { // worktree: ".git" is a file pointing at the gitdir
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(head, 'utf8'));
        head = m ? path.resolve(dir, m[1].trim()) : head;
      }
      const ref = fs.readFileSync(path.join(head, 'HEAD'), 'utf8').trim();
      branch = ref.startsWith('ref: ') ? ref.replace('ref: refs/heads/', '') : ref.slice(0, 7);
      break;
    } catch (_) {
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  branchCache.set(cwd, { at: Date.now(), branch });
  return branch;
}

// Last assistant text in a transcript, used as the "recap" on finished sessions.
function lastAssistantText(tp) {
  try {
    const fd = fs.openSync(tp, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const j = JSON.parse(line);
        if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
        const t = j.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
        if (t) return t.length > 600 ? t.slice(0, 600) + '…' : t;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function entryLabel(ep) {
  if (!ep) return null;
  if (/desktop/i.test(ep)) return 'Desktop';
  if (/cli/i.test(ep)) return 'Terminal';
  if (/vscode|ide/i.test(ep)) return 'IDE';
  if (/remote|cloud|web/i.test(ep)) return 'Cloud';
  return ep;
}

function firstLine(s, n = 90) {
  const t = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function session(e) {
  let s = sessions.get(e.sid);
  if (!s) {
    s = {
      id: e.sid, cwd: e.cwd, project: e.cwd ? path.basename(e.cwd) : 'unknown',
      title: null, status: 'done', kind: 'Ready', detail: null, now: null,
      startedAt: e.ts, lastAt: e.ts, statusSince: e.ts, turnStartedAt: null,
      host: entryLabel(e.ep), model: null, transcript: e.tp,
      tools: 0, files: new Set(), errors: 0, needsMs: 0, recap: null, ended: false,
      events: [], pending: null,
    };
    sessions.set(e.sid, s);
  }
  return s;
}

function setStatus(s, status, kind, ts) {
  if (s.status === 'needs' && status !== 'needs') s.needsMs += Math.max(0, ts - s.statusSince);
  if (s.status !== status || s.kind !== kind) s.statusSince = ts;
  s.status = status;
  s.kind = kind;
}

function log(s, e, kind, text) {
  s.events.push({ ts: e.ts, kind, text: firstLine(text, 220) });
  if (s.events.length > 40) s.events.shift();
}

// ---------- the state machine ----------
function apply(e, live) {
  if (!e || !e.sid || !e.ev) return;
  const s = session(e);
  s.lastAt = Math.max(s.lastAt, e.ts);
  if (e.cwd) { s.cwd = e.cwd; s.project = path.basename(e.cwd); }
  if (e.tp) s.transcript = e.tp;
  if (e.ep && !s.host) s.host = entryLabel(e.ep);
  if (e.model) s.model = e.model;
  if (s.ended && e.ev !== 'SessionEnd') { s.ended = false; hidden.delete(s.id); }

  switch (e.ev) {
    case 'SessionStart':
      if (e.source === 'startup' || e.source === 'clear') setStatus(s, 'done', 'Ready', e.ts);
      log(s, e, 'Start', e.source || 'session started');
      break;
    case 'UserPromptSubmit':
      hidden.delete(s.id);
      if (!s.title) s.title = firstLine(e.prompt, 80);
      s.lastPrompt = firstLine(e.prompt, 200);
      s.turnStartedAt = e.ts;
      s.detail = null; s.recap = null;
      setStatus(s, 'running', 'Thinking', e.ts);
      s.now = 'Thinking…';
      log(s, e, 'You', e.prompt);
      break;
    case 'PreToolUse': {
      s.tools++;
      s.pending = { tool: e.tool, input: e.input };
      s.now = `${e.tool} ${e.input || ''}`.trim();
      if (e.tool === 'AskUserQuestion') { setStatus(s, 'needs', 'Question', e.ts); s.detail = e.input; }
      else if (e.tool === 'ExitPlanMode') { setStatus(s, 'needs', 'Plan review', e.ts); s.detail = firstLine(e.input, 300); }
      else setStatus(s, 'running', 'Working', e.ts);
      log(s, e, e.tool, e.input);
      break;
    }
    case 'PermissionRequest':
      setStatus(s, 'needs', 'Permission', e.ts);
      s.detail = `${e.tool || ''}  ${e.input || ''}`.trim();
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (EDIT_TOOLS.has(e.tool) && e.input) s.files.add(e.input);
      if (e.err || e.ev === 'PostToolUseFailure') { s.errors++; log(s, e, 'Error', `${e.tool} failed`); }
      if (s.status === 'needs') setStatus(s, 'running', 'Working', e.ts);
      s.detail = null;
      break;
    case 'Notification': {
      const t = e.ntype || (/permission/i.test(e.msg || '') ? 'permission_prompt' : /waiting for your input/i.test(e.msg || '') ? 'idle_prompt' : '');
      if (t === 'permission_prompt') {
        setStatus(s, 'needs', 'Permission', e.ts);
        s.detail = s.pending ? `${s.pending.tool}  ${s.pending.input || ''}`.trim() : e.msg;
      } else if (t === 'elicitation_dialog') {
        setStatus(s, 'needs', 'Input', e.ts);
        s.detail = e.msg;
      } else if (t === 'idle_prompt') {
        if (s.status !== 'needs') setStatus(s, 'done', s.kind === 'Ready' ? 'Ready' : 'Finished', s.status === 'done' ? s.statusSince : e.ts);
      }
      log(s, e, 'Notice', e.msg || t);
      break;
    }
    case 'Stop':
      setStatus(s, 'done', 'Finished', e.ts);
      s.now = null; s.detail = null; s.pending = null;
      if (live && s.transcript) s.recap = lastAssistantText(s.transcript);
      log(s, e, 'Claude', s.recap || 'Turn finished');
      break;
    case 'SubagentStop':
      log(s, e, 'Agent', `${e.agent || 'Subagent'} finished`);
      break;
    case 'PreCompact':
      log(s, e, 'Compact', 'Context compacted');
      break;
    case 'SessionEnd':
      if (s.status === 'needs') setStatus(s, 'done', 'Finished', e.ts);
      s.ended = true;
      log(s, e, 'End', e.reason || 'session ended');
      break;
  }
}

// ---------- tailing the log ----------
let offset = 0, carry = '';
function readNew(live) {
  let size;
  try { size = fs.statSync(EVENTS).size; } catch (_) { return false; }
  if (size < offset) { offset = 0; carry = ''; sessions.clear(); } // file was rotated
  if (size === offset) return false;
  const fd = fs.openSync(EVENTS, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  const text = carry + buf.toString('utf8');
  const lines = text.split('\n');
  carry = lines.pop();
  const cutoff = Date.now() - RETAIN_MS;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.ts >= cutoff) apply(e, live); } catch (_) {}
  }
  return true;
}

// ---------- snapshot for the UI ----------
function snapshot() {
  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const list = [];
  let waitedToday = 0;
  for (const s of sessions.values()) {
    const needsMs = s.needsMs + (s.status === 'needs' ? now - s.statusSince : 0);
    if (s.lastAt >= startOfDay.getTime()) waitedToday += needsMs;
    if (s.ended || hidden.has(s.id)) continue;
    // A finished turn with background jobs still going is running, as the app shows it.
    const job = s.status === 'done' ? jobs.get(s.id) : null;
    // Finished sessions fade off the board after 24 h of silence.
    if (!job && s.status === 'done' && now - s.lastAt > 24 * 3600e3) continue;
    // File worktree sessions under their repo, and prefer the session's real title
    // (your rename, else Claude's generated one) over its first prompt.
    const root = s.cwd ? resolveRepo(s.cwd).root : null;
    const rk = projectKey(root);
    const meta = projectMeta[rk] || {};
    const ix = index.get(s.id) || {};
    const dk = desktopByCli.get(s.id);
    list.push({
      desktopId: dk ? dk.localId : null,
      id: s.id, cwd: s.cwd, projectKey: rk, project: meta.name || (root ? displayName(root) : s.project), branch: gitBranch(s.cwd),
      title: (dk && dk.title) || ix.customTitle || ix.aiTitle || s.title || (s.kind === 'Ready' ? 'New session' : s.project),
      status: job ? 'running' : s.status, kind: job ? 'Background' : s.kind, detail: s.detail,
      now: job ? `${job.count} background job${job.count === 1 ? '' : 's'}: ${firstLine(job.cmd, 100)}` : s.now,
      background: job ? job.count : 0,
      startedAt: s.startedAt, lastAt: s.lastAt, statusSince: s.statusSince, turnStartedAt: s.turnStartedAt,
      host: s.host, model: s.model, tools: s.tools, files: [...s.files].slice(-12), fileCount: s.files.size,
      errors: s.errors, recap: s.recap, lastPrompt: s.lastPrompt,
      stale: !job && (s.status !== 'done') && now - s.lastAt > STALE_MS,
      events: s.events.slice(-25),
    });
  }
  lastModel = buildModel(list);
  return { now, waitedTodayMs: waitedToday, sessions: list, projects: lastModel.projects, history: lastModel.history, scratch };
}

// ---------- http ----------
const clients = new Set();
let pushTimer = null;
function push() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }, 120);
}

function saveHidden() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(HIDDEN_FILE, JSON.stringify([...hidden])); } catch (_) {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
function json(res, code, v) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(v === undefined ? '' : JSON.stringify(v)); }

function handleData(req, res, url, body) {
  // Scratchpad
  if (url.pathname === '/api/scratch' && req.method === 'POST') {
    const text = str(body.text, 2000);
    if (!text || !text.trim()) return json(res, 400, { error: 'text required' });
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: text.trim(), project: str(body.project, 1000) || null, createdAt: Date.now(), doneAt: null };
    scratch.unshift(item);
    writeJson(SCRATCH_FILE, scratch); push();
    return json(res, 201, item);
  }
  const sm = /^\/api\/scratch\/([\w]+)$/.exec(url.pathname);
  if (sm) {
    const i = scratch.findIndex((t) => t.id === sm[1]);
    if (i < 0) return json(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') scratch.splice(i, 1);
    else if (req.method === 'PATCH') {
      const t = scratch[i];
      if (str(body.text, 2000) !== undefined && body.text.trim()) t.text = body.text.trim();
      if ('project' in body) t.project = str(body.project, 1000) || null;
      if ('done' in body) t.doneAt = body.done ? Date.now() : null;
    } else return json(res, 405, { error: 'method' });
    writeJson(SCRATCH_FILE, scratch); push();
    return json(res, 204);
  }
  if (url.pathname === '/api/scratch/clear-done' && req.method === 'POST') {
    scratch = scratch.filter((t) => !t.doneAt);
    writeJson(SCRATCH_FILE, scratch); push();
    return json(res, 204);
  }
  // Project settings
  if (url.pathname === '/api/projects' && req.method === 'PATCH') {
    const cwd = str(body.cwd, 1000);
    const key = projectKey(cwd);
    if (!key) return json(res, 400, { error: 'cwd required' });
    const m = projectMeta[key] || { cwd };
    for (const k of ['name', 'group', 'notes']) if (k in body) m[k] = (str(body[k], k === 'notes' ? 4000 : 80) || '').trim();
    if ('color' in body && /^#[0-9a-fA-F]{6}$/.test(body.color || '')) m.color = body.color;
    for (const k of ['pinned', 'archived']) if (k in body) m[k] = !!body[k];
    projectMeta[key] = m;
    writeJson(PROJECTS_FILE, projectMeta); push();
    return json(res, 204);
  }
  // Dashboard-only archive (the desktop app's own archive isn't readable from here).
  if (url.pathname === '/api/history/archive' && req.method === 'POST') {
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
    for (const id of ids) { if (body.archived === false) archived.delete(id); else archived.add(id); }
    writeJson(ARCHIVE_FILE, [...archived]); push();
    return json(res, 204);
  }
  // Remove a worktree with `git worktree remove` (no --force): git itself refuses when
  // the worktree has uncommitted or untracked changes. The branch is kept.
  if (url.pathname === '/api/worktrees/remove' && req.method === 'POST') {
    const want = projectKey(str(body.path, 1000));
    let proj = null, wt = null;
    for (const p of lastModel.projects) for (const w of p.worktrees) if (projectKey(w.path) === want) { proj = p; wt = w; }
    if (!wt) return json(res, 404, { error: 'Not a known worktree' });
    if (!wt.exists) return json(res, 409, { error: 'Already removed' });
    if (wt.live) return json(res, 409, { error: 'A session is still working in this worktree' });
    execFile('git', ['-C', proj.cwd, 'worktree', 'remove', wt.path], { timeout: 60e3, windowsHide: true }, (err, stdout, stderr) => {
      repoCache.clear();
      if (err) return json(res, 409, { error: (stderr || err.message).trim().split('\n').slice(-2).join(' ') });
      push();
      json(res, 200, { removed: wt.path, branch: wt.branch });
    });
    return;
  }
  return json(res, 404, { error: 'not found' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const dm = /^\/api\/sessions\/([\w-]+)\/detail$/.exec(url.pathname);
  if (dm && req.method === 'GET') {
    const id = dm[1];
    const file = (index.get(id) || {}).file || (sessions.get(id) || {}).transcript;
    if (!file || !file.endsWith('.jsonl')) return json(res, 404, { error: 'No transcript for this session' });
    let d;
    try { d = sessionDetail(file); } catch (e) { return json(res, 500, { error: e.message }); }
    if (!d) return json(res, 404, { error: 'Transcript not found' });
    const r = index.get(id) || {};
    return json(res, 200, { id, ...d, cost: r.cost ?? null, added: r.added ?? null, removed: r.removed ?? null });
  }
  // A small summary for the Claude desktop pane (polled by every open session).
  if (url.pathname === '/api/pane' && req.method === 'GET') {
    const s = snapshot();
    const pick = (x) => ({ id: x.id, title: x.title, project: x.project, kind: x.kind, detail: x.detail ? String(x.detail).slice(0, 160) : null, now: x.now ? String(x.now).slice(0, 120) : null, since: x.statusSince, turnStartedAt: x.turnStartedAt, desktopId: x.desktopId || null, stale: !!x.stale });
    const by = (st) => s.sessions.filter((x) => x.status === st);
    return json(res, 200, {
      now: s.now,
      waitedTodayMs: s.waitedTodayMs,
      needs: by('needs').sort((a, b) => a.statusSince - b.statusSince).map(pick),
      running: by('running').map(pick),
      done: by('done').filter((x) => x.kind !== 'Ready').sort((a, b) => b.statusSince - a.statusSince).slice(0, 8).map(pick),
      todos: s.scratch.filter((t) => !t.doneAt).length,
    });
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (req.method !== 'GET' && url.pathname.startsWith('/api/')) {
    // Changes need a custom header. Browsers won't send one cross-site without a
    // CORS preflight, which this server never approves, so other web pages can't
    // change anything here.
    if (req.headers['x-cc'] !== '1') { res.writeHead(403); return res.end('forbidden'); }
  }
  // Open a session in the Claude desktop app. Only an id the app itself recorded can be
  // opened, and the link is fixed: claude://code/continue?session=local_<id>.
  const om = /^\/api\/sessions\/([\w-]+)\/open-in-app$/.exec(url.pathname);
  if (om && req.method === 'POST') {
    const dk = desktopByCli.get(om[1]);
    if (!dk || !LOCAL_ID.test(dk.localId)) return json(res, 404, { error: 'This session is not one of the desktop app\'s sessions' });
    const link = `claude://code/continue?session=${dk.localId}`;
    // On Windows, url.dll's FileProtocolHandler hands the link to the registered app the
    // way a click would. (explorer.exe <link> launched from a background process did not.)
    const [cmd, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
    execFile(cmd, args, { windowsHide: true }, () => {});
    return json(res, 200, { opened: dk.localId });
  }
  // Open this dashboard in the default browser (the desktop pane's buttons use this),
  // optionally at one session's Focus page.
  if (url.pathname === '/api/open-dashboard' && req.method === 'POST') {
    const focus = url.searchParams.get('focus');
    if (focus && !/^[\w-]{1,80}$/.test(focus)) return json(res, 400, { error: 'bad session id' });
    const target = `http://localhost:${PORT}/${focus ? '#focus/' + focus : ''}`;
    const [cmd, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
    execFile(cmd, args, { windowsHide: true }, () => {});
    return json(res, 200, { opened: target });
  }
  if (url.pathname.startsWith('/api/scratch') || url.pathname === '/api/projects' || url.pathname === '/api/history/archive' || url.pathname === '/api/worktrees/remove') {
    return readBody(req).then((body) => handleData(req, res, url, body)).catch(() => { res.writeHead(400); res.end('bad request'); });
  }
  const m = /^\/api\/sessions\/([\w-]+)\/(hide|unhide)$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    if (m[2] === 'hide') hidden.add(m[1]); else hidden.delete(m[1]);
    saveHidden(); push();
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/hide-done' && req.method === 'POST') {
    for (const s of sessions.values()) if (s.status === 'done') hidden.add(s.id);
    saveHidden(); push();
    res.writeHead(204); return res.end();
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

{
  const t0 = Date.now();
  scanTranscripts();
  console.log(`Indexed ${index.size} sessions from ${CLAUDE_PROJECTS} in ${Date.now() - t0} ms`);
}
scanDesktop();
console.log(`Linked ${desktopByCli.size} transcript ids to desktop app sessions`);
setInterval(() => { const a = scanTranscripts(); const b = scanDesktop(); if (a || b) push(); scanJobs(); }, 10e3);
setTimeout(scanJobs, 1500);
readNew(false);
// Recaps for sessions already finished when the server started.
for (const s of sessions.values()) if (s.status === 'done' && s.transcript && !s.recap && s.kind === 'Finished') s.recap = lastAssistantText(s.transcript);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.watchFile(EVENTS, { interval: 400 }, () => { if (readNew(true)) push(); });
setInterval(push, 15e3); // refresh timers and stale flags
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25e3);

// Exit code 3 tells supervise.js that another copy already holds the port (not a crash).
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is already in use; Command Center may already be running. Set CC_PORT to use another port.`); process.exit(3); }
  console.error('Server error:', e);
  process.exit(1);
});

// A bad transcript line or request shouldn't take the dashboard down: log it and keep
// going. If errors pile up (20 in a minute), exit so the supervisor restarts it clean.
let recentErrors = [];
function onUnexpected(kind, err) {
  console.error(`[${new Date().toISOString()}] ${kind}:`, (err && err.stack) || err);
  const now = Date.now();
  recentErrors = recentErrors.filter((t) => now - t < 60e3).concat(now);
  if (recentErrors.length >= 20) { console.error('Too many errors in a minute; exiting.'); process.exit(1); }
}
process.on('uncaughtException', (e) => onUnexpected('uncaughtException', e));
process.on('unhandledRejection', (e) => onUnexpected('unhandledRejection', e));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Command Center → http://localhost:${PORT}`);
  console.log(`Reading ${EVENTS}`);
});
