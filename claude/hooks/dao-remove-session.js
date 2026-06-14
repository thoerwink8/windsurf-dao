#!/usr/bin/env node
// dao-remove-session.js - SessionStart hook for the /dao-remove flow.
// When a new session starts (e.g. after /clear), if a previous session was marked for deletion
// by /dao-remove, delete that (now non-live) transcript. Safe: never deletes the current live
// session, and no-ops if nothing is marked. Wired into settings.json by dao-ensure-hooks.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const marker = path.join(configDir, '.remove-pending');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin */ }
let currentTranscript = '';
try { currentTranscript = (JSON.parse(raw || '{}').transcript_path) || ''; } catch (e) { /* ignore */ }
const norm = p => path.resolve(String(p || '')).toLowerCase();

function cleanup() {
  if (!fs.existsSync(marker)) return;            // nothing marked
  let target = '';
  try { target = fs.readFileSync(marker, 'utf8').trim(); } catch (e) {}
  try { fs.unlinkSync(marker); } catch (e) {}    // consume marker so it never fires twice
  if (!target) return;
  if (currentTranscript && norm(target) === norm(currentTranscript)) return;  // never delete the live session
  try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (e) {}
}

cleanup();
process.exit(0);
