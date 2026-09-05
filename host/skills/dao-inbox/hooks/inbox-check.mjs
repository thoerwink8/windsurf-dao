#!/usr/bin/env node
// host/skills/dao-inbox/hooks/inbox-check.mjs —— UserPromptSubmit 钩子：收件箱有没有人给我留东西
//
// 装在**全局** settings.json 的 UserPromptSubmit，所以每个项目都会跑（这就是「自上而下传导」
// 现成的运输带——不用给每个仓拷一份模板；模板拷贝改一次要改 N 份，而且「哪个仓是旧版」看不出来）。
// 判断逻辑在仓内 scripts/lib/inbox.mjs（可单测），本文件只负责取数与打印。
//
// 找仓的方式：从 cwd 往上找 .git。找不到就静默退出——不在仓里时它没有意义。
// 仓里没有 docs/observations/ 也静默：不是每个仓都有人往里写。
//
// 退出码一律 0：UserPromptSubmit 的 stdout 会被当作上下文注入，硬拦靠**注入硬性指令**实现，
// 不靠 exit 2——exit 2 会把用户的话整个挡掉，拦的是用户不是我，方向反了。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);

function findRepoRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

async function main() {
  const root = findRepoRoot(process.cwd());
  if (!root) return;

  // 判断逻辑住在被观测的那个仓里；本机全局 hook 通过 skills 链接跑到的是 windsurf-dao 的副本，
  // 但要看的是**当前仓**的收件箱。所以：优先用当前仓自己的 lib，没有就回落到本 skill 随附的那份。
  const localLib = join(root, 'scripts', 'lib', 'inbox.mjs');
  const ownLib = resolve(dirname(HERE), '..', '..', '..', '..', 'scripts', 'lib', 'inbox.mjs');
  const libPath = existsSync(localLib) ? localLib : ownLib;
  if (!existsSync(libPath)) return;
  const lib = await import('file://' + libPath.replace(/\\/g, '/'));

  const dir = join(root, ...lib.INBOX_DIR_REL.split('/'));
  if (!existsSync(dir)) return;

  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch (e) {
    process.stdout.write(lib.renderInbox(lib.assessInbox({ unscanned: `目录读不了（${e.message || e}）` })));
    return;
  }

  const docs = [];
  for (const name of names) {
    const p = join(dir, name);
    try {
      docs.push(lib.parseInboxDoc(readFileSync(p, 'utf8'), { name, mtimeMs: statSync(p).mtimeMs }));
    } catch {
      // 单份读不了不能让整轮变静默：当成未处置报出来，比假装没有强。
      docs.push({ name, status: lib.STATUS_NEW, title: '（这份读不了）', at: null, handled: false });
    }
  }

  // 未跟踪的收件箱文件：写了没提交，别的机器看不到——比「没处置」更早的一层病，
  // 也正是 2026-09-05 当天真实发生的那件事。git 查不成时**不当作没有**，报「没查成」。
  let untracked = [];
  const g = spawnSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '--', lib.INBOX_DIR_REL],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (g.error || g.status !== 0) {
    process.stdout.write(lib.renderInbox(lib.assessInbox({
      docs, untracked: [], unscanned: `git 查未跟踪文件失败（${String(g.error?.message || g.stderr || g.status).slice(0, 80)}）`,
    })));
    return;
  }
  untracked = String(g.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .map((p) => p.split('/').pop());

  const text = lib.renderInbox(lib.assessInbox({ docs, untracked }));
  if (text) process.stdout.write(text);
}

main().catch(() => { /* 钩子永不因自己出错挡住用户说话 */ });
