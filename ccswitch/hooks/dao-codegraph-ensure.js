#!/usr/bin/env node
// dao-codegraph-ensure.js — SessionStart hook
// 缺了就补：codegraph CLI 不在就装，项目没 .codegraph/ 就 init。
// 已就绪时 <10ms 退出，不阻塞会话启动。
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

if (os.platform() !== 'win32') process.exit(0);

const INSTALL_DIR = path.join(os.homedir(), 'AppData', 'Local', 'codegraph', 'current');
const BIN = path.join(INSTALL_DIR, 'bin', 'codegraph.exe');

if (!fs.existsSync(BIN)) {
  try {
    execSync(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex"',
      { stdio: 'ignore', timeout: 90000 }
    );
  } catch {
    process.exit(0); // 装失败不阻塞，下次重试
  }
}

// 2. 当前项目没 .codegraph/ 且是 git 仓库 → init
let cwd = process.cwd();
try {
  const raw = fs.readFileSync(0, 'utf8');
  const data = JSON.parse(raw || '{}');
  if (data.cwd) cwd = data.cwd;
} catch {}

const hasGit = fs.existsSync(path.join(cwd, '.git'));
const hasIndex = fs.existsSync(path.join(cwd, '.codegraph'));

if (fs.existsSync(BIN) && hasGit && !hasIndex) {
  try {
    execFileSync(BIN, ['init', cwd], { stdio: 'ignore', timeout: 90000 });
  } catch {
    // init 失败不阻塞
  }
}

process.exit(0);
