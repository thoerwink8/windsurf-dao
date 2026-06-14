#!/usr/bin/env node
// remove-session.js — SessionStart hook. When a new session starts (e.g. after /clear),
// if a previous session was marked for deletion by /remove, delete that (now non-live)
// transcript file. Safe: never deletes the current live session, and no-ops if no marker.
const fs = require('fs');
const os = require('os');
const path = require('path');

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const marker = path.join(configDir, '.remove-pending');

// Read hook input from stdin (best-effort; used only as a safety check).
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin */ }
let currentTranscript = '';
try { currentTranscript = (JSON.parse(raw || '{}').transcript_path) || ''; } catch (e) { /* ignore */ }
const norm = p => path.resolve(String(p || '')).toLowerCase();

function cleanup() {
  if (!fs.existsSync(marker)) return;            // nothing marked
  let target = '';
  try { target = fs.readFileSync(marker, 'utf8').trim(); } catch (e) {}
  // Always consume the marker so it can't accumulate / fire repeatedly.
  try { fs.unlinkSync(marker); } catch (e) {}
  if (!target) return;
  // Safety: never delete the live session we are currently starting.
  if (currentTranscript && norm(target) === norm(currentTranscript)) return;
  try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (e) {}
}

cleanup();
process.exit(0);
