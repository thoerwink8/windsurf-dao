#!/usr/bin/env node
// 发布列车（issue #800）——合并只是「进列车」，版本号只由本脚本的发布动作产生。
//
//   node scripts/release-train.mjs plan               # 读现状 → 档位/下一个版本号，出 JSON，不写任何东西
//   node scripts/release-train.mjs should-run         # 到发布点（周日 or 攒够）退 0，否则非 0（给 timer 当前置）
//   node scripts/release-train.mjs release [--dry-run] [--force] # 打 tag + 写 CHANGELOG + gh release + hub-say 一句
//        未到发布点（should-run 会退非零那种）时 release 也拒发、什么都不写、退 2；--force 才强发。
//   node scripts/release-train.mjs install [--dry-run] [--unit-dir D] [--user U] [--repo P] [--at HH:MM]
//
// 触发/档位/阈值真相源：docs/release-policy.json 的 version.train 与 version.bump_by_commit_type
// （改动走 PR，见文件 _comment）。判断逻辑全在纯函数 scripts/lib/release-train-core.mjs。
//
// 与 land.mjs 的边界：land 只把默认分支已合并的东西推上去、清树，**不发版**；
// 发版只在这里，且**不 push 源码分支**（只打 tag / 建 Release / 写 CHANGELOG 提交）。
// 收工链路：合并 → land（推 master、清树）→ 之后 timer 跑 should-run && release 才切版。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  classifyTitles,
  nextVersion,
  shouldRelease,
  renderChangelog,
  normalizeWeekday,
} from './lib/release-train-core.mjs';
import { compareCarrierVersion } from './lib/version-carrier-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DEFAULT = resolve(__dirname, '..');

// ── git 探头（只读，plan 全程不写） ────────────────────────────────
function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' });
  return { status: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

/** 最近一个发布 tag（v X.Y.Z，按 SemVer 排序取最大）。没有返回 null。 */
export function lastReleaseTag(cwd) {
  const r = git(cwd, ['tag', '--list', 'v*']);
  if (r.status !== 0) return null;
  const tags = r.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => SEMVER_TAG.test(s));
  if (tags.length === 0) return null;
  tags.sort((a, b) => {
    const c = compareCarrierVersion(a.slice(1), b.slice(1));
    return c == null ? 0 : c;
  });
  return tags[tags.length - 1];
}

/** ref..HEAD 第一父线上每个落地提交的标题（squash-merge 的 %s 即 PR 标题）。ref=null → 全历史。 */
export function mergedTitlesSince(cwd, ref) {
  const range = ref ? `${ref}..HEAD` : 'HEAD';
  const r = git(cwd, ['log', range, '--first-parent', '--pretty=%s']);
  if (r.status !== 0) return [];
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 某 tag 指向提交的提交时间（ISO）。取不到返回 null。 */
export function tagCommitDate(cwd, tag) {
  if (!tag) return null;
  const r = git(cwd, ['log', '-1', '--format=%cI', `${tag}^{commit}`]);
  if (r.status !== 0 || !r.out) return null;
  return r.out;
}

// ── 策略真相源 ─────────────────────────────────────────────────────
function loadPolicy(repo) {
  const file = join(repo, 'docs', 'release-policy.json');
  if (!existsSync(file)) return { ok: false, error: `docs/release-policy.json 不在：${file}` };
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, error: `release-policy.json 坏了：${String(e.message || e).slice(0, 120)}` };
  }
}

/** 从 policy 取列车参数；缺项退回 #800 定形默认（min_merged=5，每周日）。 */
function trainConfig(policy) {
  const train = (policy && policy.doc && policy.doc.version && policy.doc.version.train) || {};
  const bumpTable = (policy && policy.doc && policy.doc.version && policy.doc.version.bump_by_commit_type) || undefined;
  return {
    minMerged: Number.isFinite(train.min_merged) ? train.min_merged : 5,
    weekday: normalizeWeekday(train.weekday != null ? train.weekday : 0),
    maxWaitH: Number.isFinite(train.max_wait_h) ? train.max_wait_h : null,
    bumpTable,
  };
}

// ── plan：读现状 → 判断，不写任何东西 ──────────────────────────────
export function computePlan(repo, { now = new Date() } = {}) {
  const policy = loadPolicy(repo);
  const cfg = trainConfig(policy);
  const tag = lastReleaseTag(repo);
  const current = tag ? tag.slice(1) : '0.0.0';
  const titles = mergedTitlesSince(repo, tag);
  const classification = classifyTitles(titles, cfg.bumpTable);
  const next = nextVersion(current, classification.level);
  const lastReleaseAtIso = tagCommitDate(repo, tag);
  const decision = shouldRelease({
    now,
    mergedSinceTag: titles.length,
    lastReleaseAt: lastReleaseAtIso ? new Date(lastReleaseAtIso) : null,
    minMerged: cfg.minMerged,
    weekday: cfg.weekday,
    maxWaitH: cfg.maxWaitH,
  });
  const nextVer = next && typeof next === 'object' ? null : next;
  return {
    repo,
    policyOk: policy.ok,
    policyError: policy.ok ? undefined : policy.error,
    lastTag: tag,
    current,
    sinceRef: tag,
    mergedCount: titles.length,
    mergedTitles: titles,
    level: classification.level,
    classification,
    next: nextVer,
    nextTag: nextVer ? `v${nextVer}` : null,
    lastReleaseAt: lastReleaseAtIso,
    train: { minMerged: cfg.minMerged, weekday: cfg.weekday, maxWaitH: cfg.maxWaitH },
    shouldRelease: decision,
  };
}

// ── release：打 tag / 写 CHANGELOG / gh release / hub-say ──────────
function prependChangelog(repo, segment, { dryRun }) {
  const file = join(repo, 'CHANGELOG.md');
  const header = '# CHANGELOG\n\n本文件由 `scripts/release-train.mjs release` 追加，别手改历史段。\n\n';
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : header;
  const body = prev.startsWith('# CHANGELOG') ? prev.slice(prev.indexOf('\n\n') + 2) : prev;
  const next = `${header}${segment.replace(/\n*$/, '\n')}\n${body.replace(/^\n+/, '')}`;
  if (dryRun) return { file, would: true };
  writeFileSync(file, next);
  return { file, written: true };
}

export function doRelease(repo, { now = new Date(), dryRun = false, force = false, say = console.log } = {}) {
  const plan = computePlan(repo, { now });
  if (!plan.policyOk) {
    say(`[发布列车] 策略没读成：${plan.policyError}`);
    return { ok: false, released: false, reason: plan.policyError };
  }
  if (!plan.level || !plan.next) {
    say(`[发布列车] 列车里没有会抬版本的提交（level=${plan.level}），不发版。`);
    return { ok: true, released: false, reason: 'no bumpable commits', plan };
  }
  // fail-closed：没到发布点（攒够 or 到周日）就不发，不写任何东西、非发布结果退出。
  // `should-run` 是 timer 的前置；这里再兜一道，防手动/脚本绕过前置直接 release。
  const gate = plan.shouldRelease || { release: false, reasons: ['没算出发布判据'] };
  if (!gate.release && !force) {
    const why = (gate.reasons || []).join('；') || '未到发布点';
    say(`[发布列车] 未到发布点，不发（${dryRun ? '拟同' : ''}——什么都不写）：${why}。要强发加 --force。`);
    return { ok: true, released: false, gated: true, plan };
  }
  if (!gate.release && force) {
    say(`[发布列车] --force：绕过发布点判定（${(gate.reasons || []).join('；')}），强发。`);
  }
  const version = plan.next;
  const tag = plan.nextTag;
  const date = now.toISOString().slice(0, 10);
  const segment = renderChangelog({ version, date, classification: plan.classification });
  const notes = segment.replace(/^## .*\n+/, '').trim() || `发布 ${tag}`;

  say(`[发布列车] ${dryRun ? '拟' : '正在'}发版 ${tag}（自 ${plan.sinceRef || '起点'} 起 ${plan.mergedCount} 个合并，档位 ${plan.level}）`);

  // ① tag（本机；真发版由合并后 timer 首触发，服务器/真仓只跑 --dry-run）
  if (dryRun) {
    say(`[发布列车] [拟] git tag -a ${tag} -m "release ${tag}"`);
  } else {
    const t = git(repo, ['tag', '-a', tag, '-m', `release ${tag}`]);
    if (t.status !== 0) {
      say(`[发布列车] 打 tag 失败：${t.err || t.out}`);
      return { ok: false, released: false, reason: 'tag failed', plan };
    }
  }

  // ② CHANGELOG 段（release: 前缀提交，才过版本号载体闸 ㉗ 的溯源）
  const cl = prependChangelog(repo, segment, { dryRun });
  if (dryRun) {
    say(`[发布列车] [拟] 追加 CHANGELOG 段到 ${cl.file}，并提交 "release: ${tag}"`);
  } else {
    git(repo, ['add', 'CHANGELOG.md']);
    const cm = git(repo, ['commit', '-m', `release: ${tag}`]);
    if (cm.status !== 0 && !/nothing to commit/.test(cm.err + cm.out)) {
      say(`[发布列车] CHANGELOG 提交失败：${cm.err || cm.out}`);
    }
  }

  // ③ GitHub Release
  if (dryRun) {
    say(`[发布列车] [拟] gh release create ${tag} --title ${tag} --notes <CHANGELOG 段>`);
  } else {
    const gh = spawnSync('gh', ['release', 'create', tag, '--title', tag, '--notes', notes], { windowsHide: true, cwd: repo, encoding: 'utf8' });
    if ((gh.status ?? 1) !== 0) {
      say(`[发布列车] gh release 失败：${String(gh.stderr || gh.stdout || '').slice(0, 200)}`);
    }
  }

  // ④ 总控群一句
  const line = `📦 发布 ${tag}：自 ${plan.sinceRef || '起点'} 起 ${plan.mergedCount} 个合并（档位 ${plan.level}）。破坏性 ${plan.classification.breaking.length} / 新功能 ${plan.classification.feats.length} / 修复维护 ${plan.classification.fixes.length}。`;
  if (dryRun) {
    say(`[发布列车] [拟] hub-say：${line}`);
  } else {
    const hub = spawnSync('/home/orca/bin/hub-say', [line], { windowsHide: true, encoding: 'utf8' });
    if ((hub.status ?? 1) !== 0) say(`[发布列车] hub-say 失败（不阻断发版）：${String(hub.stderr || hub.stdout || '').slice(0, 160)}`);
  }

  say(`[发布列车] ${dryRun ? '拟发版完成（未写任何东西）' : `发版完成 ${tag}`}`);
  return { ok: true, released: !dryRun, gated: false, dryRun, tag, version, plan, changelog: segment };
}

// ── install：幂等 systemd timer ────────────────────────────────────
function unitFiles({ repo, user, at }) {
  const node = process.execPath || '/usr/bin/node';
  const script = join(repo, 'scripts', 'release-train.mjs');
  const service = `# /etc/systemd/system/release-train.service
# 发布列车（issue #800）：每天一次跑 should-run，到发布点才 release。由 release-train.mjs install 生成。
[Unit]
Description=发布列车——到发布点（周日 or 攒够）切一版
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${user}
WorkingDirectory=${repo}
ExecStart=/bin/sh -lc '${node} ${script} should-run && ${node} ${script} release'
`;
  const timer = `# /etc/systemd/system/release-train.timer
# 每天 ${at} 触发一次；should-run 自己判到没到发布点。Persistent 补跑错过的（停机也不漏）。
[Unit]
Description=发布列车每日检查

[Timer]
OnCalendar=*-*-* ${at}:00
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

/** 幂等写单元文件：内容一致就不动。返回每个文件 changed/unchanged。 */
export function installUnits(repo, { user = 'orca', at = '04:00', unitDir = '/etc/systemd/system', dryRun = false, say = console.log } = {}) {
  const { service, timer } = unitFiles({ repo, user, at });
  const targets = [
    { path: join(unitDir, 'release-train.service'), content: service },
    { path: join(unitDir, 'release-train.timer'), content: timer },
  ];
  const results = [];
  for (const t of targets) {
    const cur = existsSync(t.path) ? readFileSync(t.path, 'utf8') : null;
    const changed = cur !== t.content;
    results.push({ path: t.path, changed });
    if (dryRun) {
      say(`[发布列车] [拟] ${changed ? '写' : '已是最新'} ${t.path}`);
      continue;
    }
    if (changed) {
      mkdirSync(dirname(t.path), { recursive: true });
      writeFileSync(t.path, t.content);
      say(`[发布列车] 写 ${t.path}`);
    } else {
      say(`[发布列车] 已是最新 ${t.path}`);
    }
  }
  const anyChanged = results.some((r) => r.changed);
  // 只有真装到系统目录、且非 dry-run 时才碰 systemctl（幂等）
  const isSystem = resolve(unitDir) === resolve('/etc/systemd/system');
  if (!dryRun && isSystem) {
    spawnSync('systemctl', ['daemon-reload'], { windowsHide: true, encoding: 'utf8' });
    spawnSync('systemctl', ['enable', '--now', 'release-train.timer'], { windowsHide: true, encoding: 'utf8' });
    say('[发布列车] systemctl daemon-reload + enable --now release-train.timer');
  } else if (!isSystem) {
    say(`[发布列车] 单元写到 ${unitDir}（非系统目录，不碰 systemctl）——装到系统：sudo cp ${unitDir}/release-train.* /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now release-train.timer`);
  }
  return { results, anyChanged };
}

// ── CLI ────────────────────────────────────────────────────────────
function flag(argv, name) {
  return argv.includes(`--${name}`);
}
function opt(argv, name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const repo = resolve(opt(argv, 'repo', REPO_DEFAULT));

  if (cmd === 'plan') {
    const plan = computePlan(repo);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.exit(0);
  }

  if (cmd === 'should-run') {
    const plan = computePlan(repo);
    const r = plan.shouldRelease;
    process.stdout.write(`${r.release ? '到发布点' : '未到发布点'}：${(r.reasons || []).join('；')}\n`);
    process.exit(r.release ? 0 : 1);
  }

  if (cmd === 'release') {
    const r = doRelease(repo, { dryRun: flag(argv, 'dry-run'), force: flag(argv, 'force') });
    if (!r.ok) process.exit(1);        // 策略/打 tag 等失败
    if (r.gated) process.exit(2);      // 未到发布点、没写任何东西（明确的非发布结果）
    process.exit(0);                   // 发了（或 dry-run 到点预演；或列车无可抬版本提交）
  }

  if (cmd === 'install') {
    installUnits(repo, {
      user: opt(argv, 'user', 'orca'),
      at: opt(argv, 'at', '04:00'),
      unitDir: opt(argv, 'unit-dir', '/etc/systemd/system'),
      dryRun: flag(argv, 'dry-run'),
    });
    process.exit(0);
  }

  process.stderr.write('usage: release-train.mjs <plan|should-run|release|install> [--dry-run] [--force] [--repo P] [--unit-dir D] [--user U] [--at HH:MM]\n');
  process.exit(2);
}

const invoked = String(process.argv[1] || '').replace(/\\/g, '/');
if (/(?:^|\/)release-train\.mjs$/i.test(invoked)) main();
