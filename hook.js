#!/usr/bin/env node
// Claude Code hook: appends one compact line per hook event to events.jsonl.
// Runs for every hook event, so it must be fast, print nothing (stdout from some
// hooks is fed back to Claude) and never fail the session: it always exits 0.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.CC_DATA_DIR || path.join(os.homedir(), '.claude', 'command-center');
const MAX = 400; // max chars kept per text field

function clip(v) {
  if (v == null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX ? s.slice(0, MAX) + '…' : s;
}

// Keep only the parts of tool_input worth showing on a card.
function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return clip(input);
  if (input.command) return clip(input.command);
  if (input.file_path) return clip(input.file_path);
  if (input.pattern) return clip(input.pattern + (input.path ? '  in ' + input.path : ''));
  if (input.url) return clip(input.url);
  if (input.description) return clip(input.description);
  if (input.prompt) return clip(input.prompt);
  if (Array.isArray(input.questions) && input.questions[0]) return clip(input.questions[0].question);
  if (input.plan) return clip(input.plan);
  return clip(input);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const e = JSON.parse(raw || '{}');
    const out = {
      ts: Date.now(),
      ev: e.hook_event_name,
      sid: e.session_id,
      cwd: e.cwd,
      tp: e.transcript_path,
      pm: e.permission_mode,
      ep: process.env.CLAUDE_CODE_ENTRYPOINT,
    };
    if (e.tool_name) { out.tool = e.tool_name; out.input = toolSummary(e.tool_name, e.tool_input); }
    if (e.prompt) out.prompt = clip(e.prompt);
    if (e.message) out.msg = clip(e.message);
    if (e.notification_type) out.ntype = e.notification_type;
    if (e.source) out.source = e.source;
    if (e.reason) out.reason = e.reason;
    if (e.model) out.model = typeof e.model === 'string' ? e.model : (e.model.display_name || e.model.id);
    if (e.agent_type) out.agent = e.agent_type;
    if (e.tool_response && e.tool_response.is_error) out.err = true;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'events.jsonl'), JSON.stringify(out) + '\n');
  } catch (_) { /* never break the session */ }
  process.exit(0);
});
