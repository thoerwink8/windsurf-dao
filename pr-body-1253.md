署名 issue #1133。关单交给 `scripts/close-issues.mjs`。

#1142 落后地基已换，不 rebase，在现行 master 重做。本 PR 从当前 master 落地幽灵回收，并补上交卷停会话后差集误派工人的洞。

## 目标

短命会话热路只杀名单里的 `incomplete`。2026-09-08 实咬：三只 Codex 审官挂了 7 小时，名单里对应树 0 条记录，`/proc` 还占着树，再派报租约被占。指挥官对照 `/proc` 与名单，没有活会话就 SIGTERM。

返工 1：cwd 复核不能把「没查成」冒充成「进程已消失」。

返工 2：工人交卷停会话之后，差集不能把 `mergeable=UNKNOWN` 当成「工人死了」再派一个。

本轮：GitHub 报 `CONFLICTING`。合入 origin/master（#1265 收尾名额按核数、#1270 draft 跳过留痕）。冲突只在 `commander-core` 收尾：两边都留——幽灵回收 + 名额用尽通知。新 head 让看门狗再推复审。幽灵回收 / cwd 三态 / 差集 UNKNOWN 修法都还在。

本轮（#1133 计划第 2 节）：42 条 `rejected` 无 vendor sessionKey、`cleanupVerified=true` 被投影丢掉证据后，每轮对 `launch:` 键 `stop-session` 失败空转。复用本 PR，不新开。不改预算与渠道规则，不杀健康会话。

## 验收标准

- [x] `planOrphanReaps`：名单 completed/空 + 树上有 pid → 产 `reap-orphan`；running 在这棵树 → 不产；名单没查成 → 不杀
- [x] 活会话保护整棵工作树（树根 running、进程在 `packages/api` → 0 条 reap）；形似前缀 `dao-live-old` 仍 reap
- [x] 根外四类 cwd（主仓 / 家目录 /tmp / 形似根）→ 0 条 reap
- [x] 执行前复核 `/proc/<pid>/cwd`，对不上规划 cwd 不杀
- [x] `incomplete` 是终态，不护树；活会话缺 cwd 整轮不杀
- [x] cwd 复核：只有 ENOENT/ESRCH 才 `gone`；EACCES/EIO 返回 `unscanned`、跳过 SIGTERM、总结果不报成功；日志区分「cwd 没查成」与「已 SIGTERM」
- [x] 差集 `reworkRequired` 只认 `CONFLICTING` 或当前 head 真红；UNKNOWN / 审查没查成不当返工
- [x] 认输 PR 也写入 mergeable map，差集不再读到列表上的 UNKNOWN 就再派工人
- [x] 夹具：CI 绿 + UNKNOWN + 旧 head 的红 + 已停工人 + 卡死标 → 0 条 dispatch/rework
- [x] 新增检查器接线有拦截证据：故意摘掉幽灵回收三接线 + `cleanupVerified` 投影/消费后，检查器当场报红 5 处；恢复后绿。见「上线证据（故意违规被当场拦下）」
- [x] `{sessionKey:null, key:'launch:test', state:'rejected', cleanupVerified:true}` 经 `normalizeExecutionSession` 再进 `decide` → 0 条 `stop-session`；旧实现会红
- [x] 正控：已确认 vendor session 的 done/incomplete 仍回收；running/streaming/waiting_user/unknown 不误杀
- [x] `uncertain`/`pending` 且 `cleanupVerified` 缺失不当成功清退；不按 `launch:` 前缀过滤；不删历史账
- [x] 42 条法国 VPS 同形回放不再重复 stop；名单没查成不拿残留 items 去 stop
- [x] 分支含最新 origin/master；相关套绿；`node scripts/dao-check.mjs`；`node scripts/handoff-check.mjs` 通

## 进展

- [x] 空提交撑分支，draft PR #1253
- [x] `planOrphanReaps` 走 `classifySessionState` 正典（不另造活/死表）
- [x] 指挥官 `scanLease` + `decide` 产 `reap-orphan` + `execReapOrphan` 杀前核 cwd
- [x] 短命会话闸钉 `planOrphanReaps` / `execReapOrphan`；去掉翻红
- [x] #1142 三轮红夹具原样收下：根外不杀、子目录不杀、形似前缀仍杀
- [x] 返工红 1：`execReapOrphan` 复用 `linkErrorKind`；EACCES 判别实验不再 `ok:true/gone:true`
- [x] 返工 2：差集 UNKNOWN 不当死人；认输 PR 也写入 mergeable map
- [x] 合入 origin/master（#1261 认输解冻等）；三处修法冲突 0，都还在
- [x] 本轮解 CONFLICTING：合入 origin/master（#1265 / #1270）。`commander-core` 收尾两边都留。HEAD `c5194eed`
- [x] 返工红 1（检查器拦截证据）：正文补可复跑故意违规样本；摘接线当场红、恢复后绿
- [x] #1133 计划第 2 节：投影带上 `cleanupVerified`，`decide` 已清退不再 stop；TDD 整链反例先红后绿
- [x] 合入 origin/master：投影同时保留 master 的 issue/pr 字段与本分支的 cleanupVerified；认输 mergeable map 与票头过期例外都留

相关套：

```
$ node --test tests/lease.test.js tests/commander.test.js tests/ephemeral-lifecycle.test.js tests/ephemeral-reap.test.js tests/commander-verbs.test.js tests/session-reconcile.test.js tests/exhausted.test.js tests/execution-session-view.test.js
# tests 421
# pass 421
# fail 0
```

判别实验（审官原文 EACCES）：

```
execReapOrphan({cwd:'.../dao-1',pids:[4242]}, {
  readlink: () => { throw Object.assign(new Error('permission denied'), {code:'EACCES'}) },
  kill: () => { throw new Error('must not kill') }
})
→ {"ok":false,"unscanned":true,"error":"有 1 个 pid 的 cwd 没查成","results":[{"pid":4242,"ok":false,"unscanned":true,"error":"cwd 没查成：EACCES"}]}
```

判别实验（差集 UNKNOWN，本轮实咬）：CI 绿、列表 UNKNOWN、重查仍 UNKNOWN、旧 head CHANGES_REQUESTED、工人已 stopped、PR 带「卡死/自动化认输」→ `decide` 对 #1133 零 `dispatch` / `rework`。MERGEABLE 同形也是零。CONFLICTING 才重派。

判别实验（#1133 计划第 2 节，TDD 整链反例）：

```
normalizeExecutionSession({sessionKey:null, key:'launch:test', state:'rejected', cleanupVerified:true})
→ cleanupVerified === true，再进 decide → 0 条 stop-session
42 条同形 + done/incomplete/vendor-from-launch 仍回收；running/streaming/waiting_user/unknown/pending/uncertain 0 条 stop
旧实现：投影丢掉 cleanupVerified，42 条全部对 launch:test-N 产 stop-session
```

`node scripts/dao-check.mjs` 本机末行（恢复后的绿，本轮返工实测）：

```
ok  短命会话：交卷停会话+入队、独立钟已删、审官书不合、指挥官并进盘面推进量
dao check: 好的（263 项，3 条可见，15 项跳过，358.9s）
```

`node scripts/handoff-check.mjs` 本机判定：

```
判定：通（3 通 / 0 红 / 0 没查成）——可以交卷
⑤ 自证基线＝审官所见 —— 工作区干净，本地与 origin/dao-1133 同点
① 基底含最新 master —— 只报不判（#1117）
```

## 上线证据（故意违规被当场拦下）

本 PR 改了自动检查器：`scripts/dao-check.mjs` 的 `checkEphemeralLifecycle` 读 `lease.mjs` 与 `execution-sessions.mjs`，`scripts/lib/ephemeral-lifecycle-check.mjs` 钉五处接线（`planOrphanReaps` / `execReapOrphan` / `export function planOrphanReaps` / 投影 `cleanupVerified` / `decide` 认 `cleanupVerified === true`）。合并证据是「故意违规被当场拦下」，不是「dao-check 通过」。`tests/ephemeral-lifecycle.test.js` 的变异单测是代码内证据，不能替代本段。

可复跑（仓库根）：把本 PR 新增五处接线从源码摘掉，走 dao-check 同一条 `inspectEphemeralLifecycleSources`；`finally` 写回原文。`X` / `ok` 两行与 `dao-check.mjs` 的 `fail()` / `green()` 原文同一句。

```bash
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectEphemeralLifecycleSources } from './scripts/lib/ephemeral-lifecycle-check.mjs';
const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(join(ROOT, rel));
const filesOf = () => ({
  dao: read('scripts/dao.mjs'),
  commander: read('scripts/commander.mjs'),
  handoff: read('scripts/lib/handoff-check.mjs'),
  miraReviewer: read('host/skills/dispatch/templates/reviewer-book-mirasim.md'),
  miraSoldier: read('host/skills/dispatch/templates/soldier-book-mirasim.md'),
  agents: read('AGENTS.md'),
  nudgeInstall: read('scripts/install-nudge-stalled.sh'),
  progressInstall: read('scripts/install-progress-watch.sh'),
  core: read('scripts/lib/commander-core.mjs'),
  admit: read('scripts/lib/admission.mjs'),
  reap: read('scripts/lib/ephemeral-reap.mjs'),
  lease: read('scripts/lib/dispatch/lease.mjs'),
  sessions: read('scripts/execution-sessions.mjs'),
});
const inspectNow = () => inspectEphemeralLifecycleSources({ files: filesOf(), exists });
const print = (label, problems) => {
  console.log('=== ' + label + ' ===');
  if (problems.length) {
    console.log('  X  短命会话闸红 ' + problems.length + ' 处');
    console.log('     修：done_when 是机器可算的事实，红了就还没完');
    console.log('     ' + problems.slice(0, 6).join('；'));
    return;
  }
  console.log('  ok  短命会话：交卷停会话+入队、独立钟已删、审官书不合、指挥官并进盘面推进量');
};
const targets = [
  ['scripts/lib/commander-core.mjs', 'planOrphanReaps', 'planGoneReaps'],
  ['scripts/commander.mjs', 'execReapOrphan', 'execGoneOrphan'],
  ['scripts/lib/dispatch/lease.mjs', 'export function planOrphanReaps', 'export function planGoneReaps'],
  ['scripts/execution-sessions.mjs', 'cleanupVerified', 'cleanupGone'],
  ['scripts/lib/commander-core.mjs', 'cleanupVerified === true', 'cleanupGone === true'],
];
const originals = [...new Set(targets.map(([rel]) => rel))].map((rel) => [rel, read(rel)]);
try {
  print('恢复前/绿（现行源码）', inspectNow());
  for (const [rel, from, to] of targets) {
    writeFileSync(join(ROOT, rel), read(rel).split(from).join(to));
  }
  print('故意违规（摘掉幽灵回收三接线 + cleanupVerified 投影/消费）', inspectNow());
} finally {
  for (const [rel, text] of originals) writeFileSync(join(ROOT, rel), text);
}
print('恢复后/绿', inspectNow());
NODE
```

本机实跑输出（2026-09-16，故意违规被当场拦下）：

```
=== 恢复前/绿（现行源码） ===
  ok  短命会话：交卷停会话+入队、独立钟已删、审官书不合、指挥官并进盘面推进量
=== 故意违规（摘掉幽灵回收三接线 + cleanupVerified 投影/消费） ===
  X  短命会话闸红 5 处
     修：done_when 是机器可算的事实，红了就还没完
     指挥官没产幽灵进程回收；指挥官没执行幽灵进程回收；租约闸没有幽灵回收纯函数；会话投影没把 cleanupVerified 带到消费端；指挥官 stop 候选没认已确认清退证据
=== 恢复后/绿 ===
  ok  短命会话：交卷停会话+入队、独立钟已删、审官书不合、指挥官并进盘面推进量
```

摘接线当场红 5 处，恢复后绿。完整 `node scripts/dao-check.mjs` 恢复后末行见上节。

## 机制判定

幽灵回收：这错在制度生效前还会再犯吗？**会。** 热路只杀名单里 incomplete；凡是名单缺席而进程还在的形态——刮名单超时、字段对不上、mirasim 重启丢名单、会话结算后进程没退——租约就握在死人手里。机制改在现行 `planOrphanReaps` + 每轮 `reap-orphan`。

cwd 复核：还会再犯吗？**会——如果把非 ENOENT/ESRCH 当 gone。** 机制：复用 `linkErrorKind`，只把 ENOENT/ESRCH 当 gone，其余返回可见 `unscanned` 且 `ok:false`。

差集误派：还会再犯吗？**会——如果 `reworkRequired` 写成 `mergeable !== MERGEABLE`。** 列表 GraphQL 常 UNKNOWN；认输 PR 以前 `continue` 还不写 map，差集读到 UNKNOWN，把交卷停会话当成工人死了再派。机制：差集只认 `CONFLICTING` 与当前 head 真红；UNKNOWN / 审查没查成按 #1056「没查成当有人在做」。认输 PR 也写入 mergeable map。本会话就是那次误派的现场：修法在本 PR、master 还没有，指挥官又派了一个工人。合入 master 之后这条才生效。

清退空转：还会再犯吗？**会——如果投影丢掉 `cleanupVerified`。** 42 条 `rejected` 无 vendor sessionKey、清理已核过，名单投影只留 `key=launch:…`，`decide` 当终态再 `stop-session`，执行口没有真会话就失败，下一轮原样再来。机制：`normalizeExecutionSession` 把 `cleanupVerified` 带到消费端；`decide` 只在 `cleanupVerified === true` 时跳过 stop。不按 `launch:` 前缀过滤，不把缺失字段当成已清退，不删历史账。

## 同类扫描

形状 1：「已知 pid 复核 `/proc/<pid>/cwd` 时，把非 gone 的 readlink 错误当成进程已消失并报成功」。

```
scripts/commander.mjs:57,942-977  execReapOrphan 已走 linkErrorKind
scripts/lib/commander-inventory.mjs:57  catch { continue } 全量扫描，不报已 SIGTERM
scripts/lib/now-collect.mjs:354  采集脚本 continue
scripts/lib/proc-cwds.mjs:21,76,83,101  已按 gone vs denied 分类
scripts/lib/dispatch/worktree.mjs:393-394  全量扫描
scripts/lib/dispatch/lease.mjs:76  走 scanProcCwds
scripts/lib/skill-link-check.mjs:160  不是 /proc cwd
scripts/lib/onboard-check.mjs:67  不是 /proc cwd
```

**结论：只此一处。** `execReapOrphan` 已改成 `linkErrorKind`。其余 `/proc` cwd 是全量扫描：别人的进程 EACCES 是预期，`catch { continue }` 不会把没查成报成「已 SIGTERM」。

形状 2：「把非 MERGEABLE（含 UNKNOWN）当成工人必须回来」。

```
scripts/lib/commander-core.mjs:1715  mergeable === 'CONFLICTING' || (review.scanned === true && review.latestRed === true)
scripts/lib/session-reconcile.mjs:255  消费 reworkRequired，不自己算 mergeable
tests/session-reconcile.test.js  夹具
```

**结论：只此一处生产映射。** 本轮已改。

形状 3：「已确认清退后仍对登记键重复 stop（投影丢掉 cleanupVerified）」。

```
scripts/execution-sessions.mjs:4,12,18  生产投影，已带 cleanupVerified
scripts/lib/commander-core.mjs:1841      decide 认 cleanupVerified === true
scripts/lib/execution-runtime.mjs        写 cleanupVerified，不投影给指挥官
scripts/lib/lease-gc.mjs:81              注释
scripts/lib/execution-states.mjs:111     注释
```

**结论：只此一处生产投影 + 只此一处 stop 候选消费。** 本轮已改。不重复 #1288（测试后代回收）/ #1292（租约占用与死票）。

## 回流

- 产物：`planOrphanReaps` + `execReapOrphan`（三态 cwd）+ 差集 `reworkRequired` 只认冲突/当前 head 真红 + 投影带 `cleanupVerified`、已清退不再 stop。
- 为什么通用：① 记账说没人、内核说有人，回收要用同一把尺；② 「没查成当成没有 / 当成已经消失 / 当成工人死了 / 当成还没清退」是这仓反复咬过的病。
- 建议落点：已落 `lease.mjs` / `proc-cwds.mjs` / `commander-core.mjs` / `execution-sessions.mjs`。
