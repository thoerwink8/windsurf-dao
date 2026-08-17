#!/usr/bin/env node
// scripts/watchdog.mjs —— 事故路径停摆侦测（issue #442 正式版，2026-08-15 融合改造瘦身，
// 2026-08-15 #500 换代：活性判据全面换成真实证据）
//
// 双通道监视里本脚本负责「事故路径」：协调者不再把「沉默」当「还在跑」。
// 快乐路径（工人完工自报 orchestration worker_done）不归本脚本，见 dispatch skill。
// 规格书 = issue #442 全部案例与对策 + fusion-verdict.md（2026-08-15 拍板裁定书）
//   + #500/#492/#471/#476（本版换代，活性判据换真证据）。
//
// ── 活性判据禁令（#500 实证：三种屏面探头全被转圈动画骗过）──────────────────
// 挂死 27 分钟的真实案例：工人 git rebase --continue → git 拉起 vim 等 stdin → 永远等不到。
// 当天三种探头全瞎：worker_done 门铃（挂死不发）、屏面指纹（spinner 每次重绘指纹都不同）、
// cursor 增量（spinner 重绘也算新输出，45s/21 行看着像活的）。
// 结论：**禁止用任何屏面形态判活性**——整屏哈希、cursor 增量、token 计数、tui-idle 全在列。
// 合法判据只有「该发生的事有没有发生」：
//   - 正向弱判据：非 spinner 的真实内容在增长（spinner 重绘不算——本版停摆主判据）
//   - 强判据：活着但工作树 N 分钟无 git 活动 = 空转（#471 第四类事故，4 小时实证）
//   - 该发生而没发生：flow 心跳 ts 停止更新、在途 PR 停留超 N（#471 停滞态/帅停摆）
//   - 孤儿树：还有没有活跃执行者（#492：任何「我不认识它⇒它是孤儿」的判据都必然误伤同僚）
//
// 检测矩阵（全部来自 #442 实测案例 + #500/#492/#471/#476 换代 + #569 降噪/换 provider/权限框）：
//   1. exited       —— 终端 read 状态 exited（「终端 exited 且非完工态」独立报警）
//   2. waiting      —— ps agents[].state=waiting（弹窗/等输入的官方信号，零关键字猜测）
//   3. fingerprint  —— 屏面底部当前状态窗口命中错误指纹清单，**两连同才报警**；
//                       报警前活证否决：**非 spinner 真实内容在动** → 降级日志行不唤醒
//                       （旧否决用 cursor 前进——spinner 重绘也动 cursor，#500 判死）
//                       命中后按处置矩阵（#471）执行动作 + 连败计数，连败 3 次或 10 分钟报帅
//   4. stall        —— 主判据 = **非 spinner 真实内容连续三轮不变**（spinner 重绘、cursor 前进、
//                       ps updatedAt 前进都不算活性——#500：spinner 重绘既改屏面又动 cursor）
//   5. read-failed  —— 被监视工位却读不到屏面（守卫自身失效必须显形，不能静默）
//   6. idle         —— 空转（#471 第四类事故）：进程在动（ps state=working）但工作树
//                       N 分钟无 git 活动（last commit / 未提交文件 mtime / 未推送）。
//                       #569 降噪只减假阳不减真阳，三类豁免（各自的判据，不是名单）：
//                       ① 子卡（审官/辅助，卡名带 ·）产出是 review comment 与 notify 不是
//                          commit——git 判据无意义，其停摆由 stall/指纹/selector/waiting 兜底；
//                       ② 在途 PR 等别人：本树分支上有 OPEN 非 draft 且非 CHANGES_REQUESTED 的
//                          PR = 「已交付、正在等下一环」，不算空转（PR 要返工时仍判）；
//                       ③ 活性否决（#500 一致性）：非 spinner 真实内容在动 = 活，不算空转
//                          （刚重启正在开 PR / 正在做非 commit 活都不算）。
//                       真空转（working + 屏面冻结 + 无在途 PR + 非子卡）照旧报。
//   7. orphan       —— 孤儿树（#492/#476）：无活跃执行者 + 关联 #N 已关（或 无关联且静置超 N）
//   8. naming       —— 任务卡命名不合规（#476：顶层 #N - 动宾短语 / 子卡 #N - xxx·yyy）。
//                      #569 降噪：master 卡（isMainWorktree）与「无 agent 且无 #N 前缀」的非任务卡
//                      不参与命名校验（windsurf-dao 这类 review 工作区不是任务卡，报它=假阳）
//   9. flow-stalled / flow-absent / stagnation —— 读 flow 心跳（#497 立约，#580 补写入）：
//                       三态三话：心跳新鲜 / 心跳过期 / 心跳从未存在。
//                       过期 = flow-stalled；从未存在且有待流转对象 = flow-absent
//                       （判据锚在「该发生的事有没有发生」，不锚进程名，#480 换代后仍成立）。
//                       无待流转对象时心跳缺失只记 note，不报（假阳会把守卫关掉）。
//   10. selector      —— 权限确认框停摆指纹（#569 ④）：屏面底部持续出现 N/M:select 选择器提示。
//                        进程活着、开过工、但卡在等一个永远不会来的人类输入——编排层看一切正常，
//                        只有屏面底部选择器显形。检测到就报，不自动替它选（选哪个有后果，尤其 reject）
//   12. pasted-content—— #575：终端 running + 屏面含 [Pasted Content N chars] + 非 spinner
//                        内容无增长，持续超阈轮。#574 审官 5711 字符任务书折在输入框，
//                        worker-start 全绿、一个字没审。处置：补一记回车（与 selector 不同——
//                        回车没有「选哪个」的后果，是当晚已知救活动作）。
//   13. all-idle      —— #575：盘面上有仍在途的任务卡（#N - ，非 in-review/已完成），
//                        却零 working/waiting 工位。这不是 NO_TARGETS（没样本），是全员卡死。
//                        in-review + agent=done 的待合并盘面仍报 NO_TARGETS（那是等帅，不是卡死）。
//   14. retry-loop    —— #580 追加：屏面尾部同一条 5xx/不可用 行连续 N 轮出现，即使真实
//                        内容在变也报（指纹活证否决正好把「在重试」当成活着）。有新鲜 git
//                        产出则不报。503 进指纹表是补洞，本判据不依赖认识具体错误串。
//   11. model-change  —— pi 静默换 provider（#569 ②）：扫 ~/.pi/agent/sessions/**/*.jsonl 的
//                        model_change 事件。pi 遇 provider 瞬时失败 1ms 内切「同 model id 别的
//                        provider」（og 503→deepseek 直连实证，成本跃迁账单外零信号），诱因 = 切换前
//                        最近 message 的 errorMessage；新会话开头的初始选型（无前序 message）不报
//   BLIND          —— 编排层隐形工人（#569 垫片 watch-board.mjs 并进；2026-08-17 判据订正）：
//                        树级判据 = 有活终端（>1）且**查不到 dispatch 记账**（orca orchestration
//                        worker-list 的 resource.worktreeId 里没有它）——从没走 worker-start/
//                        dispatch 的工位 = 编排层不知道有工人在跑，看门狗与流转器都监视不到，
//                        只能人工盯。订正实证（2026-08-17）：「agents=0」是假阳——reclaude/Claude
//                        起法 orca worktree ps 不报 agent，但 worker-read 读得到、token 在涨，
//                        编排层其实看得见；有 dispatch 记账的一律不报；worker-list 查不动 → 没查成
//                        note，不猜（垫片当初用 agents 凑合，就因为它长驻没绑 run 查不了记账）
//
// 两个窗口（#442 v0 首战假阳性教训的落点）：
//   --window       整屏窗口（默认 60 行）：停摆判据用。
//   --state-window 屏面底部状态窗口（默认 12 行）：错误指纹判据用。只看屏面底部当前状态，
//                  不对历史叙述做关键字匹配——v0 就是把审官叙述里的「两个样本都被拦」
//                  误判成求助等待。
//
// 结构性排除（审读红 2 落点：不能靠 displayName 黑名单）：
//   - 主工作区（isMainWorktree）：master 卡只住协调者，永远零工人（dispatch skill 拓扑）。
//   - 监视器自己的工作区（--self-worktree；live 模式自动从 `orca worktree current` 取）。
//   - --exclude-pane <paneKey>（可重复）：按稳定 pane ID **分级排除**——豁免指纹/停摆判据，
//     保留 exited/waiting 死活判据。
//
// 处置矩阵（#471，见 PARAMS / DISPOSE_MATRIX 块）：指纹→动作的确定性映射 + 连败计数，
// 矩阵是唯一账本，新事故只加一行。动作在 live 模式经 orca terminal send 真发（Node 直接
// spawnSync 传参不走 Git Bash，不会把 /branch 转成盘符路径），快照/测试模式只打印动作行。
// 斜杠命令与重启动作带上下文守卫：非 reclaude 终端不执行 reclaude 系动作，只报不动作。
//
// 仓规硬约束：
//   - 输出必须区分「扫完 0 异常」（打印一行 OK 汇总，含扫描工位数）、
//     「没扫到任何工位」（NO_TARGETS）与「有在途卡却零活工位」（ALL_IDLE，#575）——
//     数到 0、没看到样本、全员卡死，三件事不是一回事。
//   - 检测逻辑只用外部证据（orca 官方输出 / git / gh / flow 心跳文件 / 快照语料），
//     不碰工人的自报（lastAssistantMessage 一律不读）。
//   - 监视对象每轮从 ps 自动枚举 working/waiting 态 agent，无手动名单。
//   - 读不到屏面一律 fail-visible：读失败 / 成功响应缺字段 / 结构不认识都报 read-failed。
//   - 检查器输出不落在自己会读取的文件范围内（处置日志打 stdout，不回读）。
//
// 退出码：0 扫完 0 异常（活证否决的观察行不唤醒）/ 1 有报警 / 2 NO_TARGETS（本轮没查成）/ 3 基础设施失败。
//
// 用法：
//   node scripts/watchdog.mjs                    轮询模式（默认每 30s 一轮，供 Monitor 挂载）
//   node scripts/watchdog.mjs --once             跑单轮后退出（给测试用）
//   node scripts/watchdog.mjs --snapshot-dir <dir>  从录制的 ps/read JSON 快照跑检测（测试/复现用）
//   node scripts/watchdog.mjs --interval 20      轮询间隔秒数
//   node scripts/watchdog.mjs --window 80        整屏窗口行数
//   node scripts/watchdog.mjs --state-window 15  屏面底部状态窗口行数
//   node scripts/watchdog.mjs --self-worktree <id>  指定监视器自己的工作区 id（live 模式默认自动取）
//   node scripts/watchdog.mjs --exclude-pane <paneKey>  按稳定 pane ID 分级排除（可重复）
//   node scripts/watchdog.mjs --dispose-actions off  处置矩阵动作关掉（只检测不动作）
//   node scripts/watchdog.mjs --heartbeat-file <path> flow 心跳文件路径（默认 _flow/heartbeat.json）
//   node scripts/watchdog.mjs --sessions-dir <dir> pi 会话日志目录（默认 ~/.pi/agent/sessions；
//                       快照模式默认 <快照轮目录>/sessions）
//   node scripts/watchdog.mjs --now <epochMs>    固定「现在」（测试确定性用；默认 Date.now()）

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { parseOrcaStdout } from './lib/orca-stdout.mjs';
import { commentsForPendingScan, pendingFlowItems, ticketIssueNumber } from './flow.mjs';

const ORCA_TIMEOUT_MS = 30000;

// ── 屏面错误指纹清单（append-only）────────────────────────────────────
// 每条指纹对应一个真实事故案例；新增事故时在这里加一行，并在处置矩阵里登记动作
// （#471：矩阵是唯一账本，新事故只加一行）。
// 2026-08-15 裁定书：单发即唤醒的宽指纹（'Error:'/'terminated'/'Connection error'）已退役——
// 宽指纹命中正常叙述/讨论的概率高，是假阳性温床；现在一律两连同才报警 + 活证否决兜底。
// 'Remote Control disconnected 404' 是噪音（#471：忽略不阻塞），不进检测清单——处置矩阵留行记录决定。
// 元素可以是普通字符串（大小写不敏感子串匹配）或正则字面量。
const ERROR_FINGERPRINTS = [
  'Retry failed',          // 盲考·Grok：代理链路断线重试全败（Retry failed after 3 attempts）
  'no serving account',    // 盲考·GPT：pqgpt 中转池无可用账号（池竭/限流）断流
  'stream disconnected',   // 盲考·GPT：中转站断流（与 Grok 的 clash 抖动是两种不同断流）
  'login rejected',        // 登录被拒
  'timed out connecting',  // 连接超时
  /Reconnecting.*5\/5/i,   // 盲考·GPT：Reconnecting 5/5 全败停机
  'at capacity',           // GPT/codex：⚠ Selected model is at capacity
  'try a different model', // 同上，同句报错的另一半
  'temporarily limiting requests', // reclaude 链拼车限流（#471 当日实证）
  '拼车 5 小时额度已用完',  // reclaude 链拼车额度耗尽（#471 当日实证）
  'reclaude 客户端状态异常', // reclaude 客户端异常（#471 当日实证）
  'session 已绑定另外的 ai 账号', // reclaude 会话绑定错账号（#471 当日实证）
  'Set up auto mode',      // #464 遗留「弹窗自处理」授权（发 3）
  "Don't show again",      // 同上
  '503 Service Unavailable',       // #580：codex/pqapi 503，用户先于守卫发现
  'api_key_registry_unavailable',  // 同上现场原文
  /unexpected status 5\d\d/i,      // 一般 HTTP 5xx（只加 503 等于等下一次没见过的码）
];

// ── 处置矩阵（#471 v0，全部当日实证）───────────────────────────────────
// 指纹→动作确定性映射。矩阵是唯一账本：新事故只加一行。
// action：keepalive（注入续命）/ reclaude-branch（/branch→继续）/ reclaude-restart（/exit→重启→继续）
//         / send3（发 3）/ ignore（噪音不动作）；检测命中但矩阵无行 → 报帅（矩阵未命中→上报帅）。
// requireContext：'reclaude' 系动作只在屏面上下文含 reclaude/Claude 时执行（防把 /exit 打进别的终端）。
// 参数与阈值集中 PARAMS 块。注：#471/#476 原要求进 docs/model-routing.toml 参数节（#469 S3），
// 因 #502 正在改该文件且协调者边界未答，本轮集中在此块，迁移路径见 PR #505 正文。
const DISPOSE_MATRIX = [
  { fp: 'no serving account',                 action: 'keepalive', label: '注入续命' },
  { fp: 'at capacity',                        action: 'keepalive', label: '注入续命，错峰退避 120s→300s' },
  { fp: 'try a different model',              action: 'keepalive', label: '注入续命' },
  { fp: 'stream disconnected',                action: 'keepalive', label: '注入续命' },
  { fp: /Reconnecting.*5\/5/i,                action: 'keepalive', label: '注入续命' },
  { fp: 'temporarily limiting requests',      action: 'reclaude-branch', label: '发 /branch → 发「继续」（reclaude 链专属）', requireContext: 'reclaude' },
  { fp: '拼车 5 小时额度已用完',               action: 'reclaude-branch', label: '发 /branch → 发「继续」（reclaude 链专属）', requireContext: 'reclaude' },
  { fp: 'reclaude 客户端状态异常',             action: 'reclaude-restart', label: '/exit → reclaude --model opus --continue → 发「继续」', requireContext: 'reclaude' },
  { fp: 'session 已绑定另外的 ai 账号',        action: 'reclaude-restart', label: '/exit → reclaude --continue → 发「继续」', requireContext: 'reclaude' },
  { fp: 'Set up auto mode',                   action: 'send3', label: '发 3（#464 弹窗自处理授权）' },
  { fp: "Don't show again",                   action: 'send3', label: '发 3' },
  { fp: 'Remote Control disconnected 404',    action: 'ignore', label: '忽略（噪音，不阻塞）' },
  { fp: '503 Service Unavailable',            action: 'keepalive', label: '注入续命（HTTP 5xx）' },
  { fp: 'api_key_registry_unavailable',       action: 'keepalive', label: '注入续命（registry 不可用）' },
  { fp: /unexpected status 5\d\d/i,           action: 'keepalive', label: '注入续命（HTTP 5xx）' },
];

// ── 参数块（阈值集中一处；迁移路径见 PR #505）──────────────────────────
const PARAMS = {
  stallRounds: 3,           // 停摆判据：非 spinner 真实内容连续 N 轮不变才报
  idleMinutes: 20,          // 空转判据：活着但工作树 N 分钟无 git 活动（#471 起步建议 20 分钟）
  orphanStaleMinutes: 30,   // 孤儿次判据：无活跃执行者且无关联时，静置 N 分钟才报
  selectorRounds: 2,        // 权限确认框停摆（#569 ④）：屏面底部 N/M:select 持续 N 轮才报（
                            // 两连同，与指纹同口径；真阳#568 实证：卡 7 分钟没人应）
  pastedRounds: 2,          // #575 Pasted Content 停摆：屏面含 [Pasted Content N chars] 持续 N 轮才报
  namingTop: /^#\d+ - /,        // 顶层任务卡：#<PR号> - 动宾短语（SKILL 拓扑节）
  namingSub: /^#\d+ - .+·/,     // 子卡（审官/辅助）：#<PR号> - xxx·yyy
  fpLossLimit: 3,           // 同指纹连败 N 次报帅（#471）
  fpLossWindowMs: 10 * 60 * 1000, // 或跨 N 分钟报帅
  stagnationMs: 30 * 60 * 1000,   // flow 心跳里在途 PR 停留超 N → 停滞态报警（#471 处置矩阵补一行）
  heartbeatStaleMs: 5 * 60 * 1000, // flow 心跳 ts 超 N 未更新 = flow 停摆候选
  retryLoopRounds: 3,       // #580：同一错误行连续 N 轮 = 重试循环（不看屏面是否在滚）
};

// ── 参数 ─────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`用法：
  node scripts/watchdog.mjs [--once] [--interval 秒] [--window 行] [--state-window 行]
                            [--snapshot-dir 目录] [--self-worktree <id>] [--exclude-pane <paneKey>]...
                            [--dispose-actions on|off] [--heartbeat-file <path>]
                            [--sessions-dir <目录>] [--now <epochMs>]

  --once             跑单轮后退出（给测试用）
  --interval <秒>     轮询间隔（默认 30）
  --window <行>       整屏窗口行数，停摆判据用（默认 60）
  --state-window <行> 屏面底部状态窗口行数，错误指纹判据用（默认 12）
  --snapshot-dir <目录> 从录制的 ps/read JSON 快照跑检测（测试/复现用），跑完即退出
  --self-worktree <id> 监视器自己的工作区 id（live 模式默认从 orca worktree current 自动取）
  --exclude-pane <paneKey> 按稳定 pane ID 排除控制端/审官会话（可重复，不维护 displayName 名单）
  --dispose-actions off  处置矩阵动作关掉（只检测不动作；默认 on）
  --heartbeat-file <path> flow 心跳文件路径（默认 _flow/heartbeat.json）
  --sessions-dir <目录> pi 会话日志目录（默认 ~/.pi/agent/sessions；快照模式默认 <快照轮目录>/sessions）
  --now <epochMs>     固定「现在」（测试确定性用）`);
}

function parseArgs(argv) {
  const args = { once: false, interval: 30, window: 60, stateWindow: 12, snapshotDir: null, selfWorktree: null, excludePanes: [], disposeActions: true, heartbeatFile: null, sessionsDir: null, now: null };
  const take = (i, name) => {
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`参数 ${name} 需要正整数`);
      process.exit(3);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--once': args.once = true; break;
      case '--interval': args.interval = take(i++, '--interval'); break;
      case '--window': args.window = take(i++, '--window'); break;
      case '--state-window': args.stateWindow = take(i++, '--state-window'); break;
      case '--snapshot-dir': args.snapshotDir = resolve(process.cwd(), argv[++i] || ''); break;
      case '--self-worktree': args.selfWorktree = argv[++i] || ''; break;
      case '--exclude-pane': args.excludePanes.push(argv[++i] || ''); break;
      case '--dispose-actions': {
        const v = (argv[++i] || '').toLowerCase();
        if (v !== 'on' && v !== 'off') { console.error('--dispose-actions 需要 on|off'); process.exit(3); }
        args.disposeActions = v === 'on';
        break;
      }
      case '--heartbeat-file': args.heartbeatFile = argv[++i] || ''; break;
      case '--sessions-dir': args.sessionsDir = resolve(process.cwd(), argv[++i] || ''); break;
      case '--now': {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v) || v <= 0) { console.error('--now 需要正数 epochMs'); process.exit(3); }
        args.now = v;
        break;
      }
      case '--help': printUsage(); process.exit(0);
      default:
        console.error(`未知参数: ${a}`);
        printUsage();
        process.exit(3);
    }
  }
  return args;
}

// ── orca 采集（live 模式）───────────────────────────────────────────

function runOrca(cmdArgs) {
  const r = spawnSync('orca', cmdArgs, { encoding: 'utf8', timeout: ORCA_TIMEOUT_MS });
  if (r.error || r.status !== 0) {
    // orca 的非零退出把结构化错误 JSON 打在 stdout（实测：terminal_handle_stale 的
    // {ok:false, error:{code,message}} 在 stdout 上、stderr 为空）——先试解析，
    // 拿到 error 就原样透传（live 与快照同形态、错误码不丢，审读红 ② 返工）；
    // 拿不到（spawn 失败/超时/stdout 不是 JSON）再回落 stderr/exit N 字符串。
    if (r.stdout) {
      const parsed = parseOrcaStdout(r.stdout);
      if (parsed.ok && parsed.json?.error) return { ok: false, error: parsed.json.error, json: parsed.json };
      if (parsed.ok && parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
    }
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 200) };
  }
  const parsed = parseOrcaStdout(r.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
  return { ok: true, json: parsed.json };
}

// 错误详情转可读文本（runOrca 对 orca JSON 错误原样透传结构化 error）。
function errText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return e.code ? `orca 报错 ${e.code}: ${e.message}` : String(e.message || e);
  return '';
}

function unwrapPayload(json, pathKey, topKey) {
  const viaPath = json?.result?.[pathKey];
  if (Array.isArray(viaPath)) return viaPath;
  if (Array.isArray(json?.[topKey])) return json[topKey];
  return null;
}

// 终端的 paneKey（tabId:leafId）→ {handle, incarnationId}；读失败一律 fail-visible。
function buildPaneIndex(terminals) {
  const idx = new Map();
  for (const t of terminals) {
    if (t.tabId && t.leafId && t.handle) {
      idx.set(`${t.tabId}:${t.leafId}`, { handle: t.handle, incarnationId: t.incarnationId ?? null });
    }
  }
  return idx;
}

// ── 屏面 chrome 剔除（#500 换代核心）─────────────────────────────────
// 活性判据只认「非 spinner 的真实内容」。屏面 chrome（spinner 盲文帧、TUI 计时行）
// 重绘会骗过整屏哈希与 cursor 增量，必须先剔除再比。spinner 帧 = Unicode 盲文块
// （U+2800–U+28FF，⠋⠙⠹⠸⠼⠴...）；计时行 = "Elapsed 0.5s" 形态。
const BRAILLE_RE = /[\u2800-\u28FF]/g;
const TIMER_LINE_RE = /^\s*Elapsed\s+[\d:.]+s?\s*$/i;

function stripChrome(text) {
  return String(text || '')
    .replace(BRAILLE_RE, '')                       // spinner 帧
    .split('\n')
    .map(l => l.replace(TIMER_LINE_RE, ''))         // TUI 计时行
    .join('\n')
    .trim();
}

const normLines = (lines) => (Array.isArray(lines) ? lines : [])
  .map(l => String(l).replace(/\r$/, ''))
  .join('\n')
  .trim();

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ── git / gh 证据（live 模式）───────────────────────────────────────
// 活性强判据（#471 空转）：工作树「最后 git 活动」= max(HEAD commit ts, 未提交文件最新 mtime)。
// 快照模式从 git-evidence.json 读（字段契约见 loadSnapshotRound）。

function liveGitEvidence(path) {
  const log = spawnSync('git', ['-C', path, 'log', '-1', '--format=%ct'], { encoding: 'utf8', timeout: 10000 });
  if (log.error || log.status !== 0) {
    return { error: `git log 失败：${String(log.error?.message || log.stderr || `exit ${log.status}`).trim().slice(0, 160)}` };
  }
  let lastActivityTs = Number(String(log.stdout).trim()) * 1000;
  const st = spawnSync('git', ['-C', path, 'status', '--porcelain', '-z'], { encoding: 'utf8', timeout: 10000 });
  if (!st.error && st.status === 0) {
    // -z 输出 "XY <path>\0"；重命名 "XY old\0new\0" 的第二段无前缀，stat 失败会跳过（边缘可接受）
    for (const e of String(st.stdout).split('\0')) {
      if (e.length < 3) continue;
      const p = e.slice(3);
      if (p.startsWith('"') || p.startsWith('!!')) continue;
      try {
        const m = statSync(join(path, p)).mtimeMs;
        if (m > lastActivityTs) lastActivityTs = m;
      } catch { /* 文件已删/路径变化，跳过 */ }
    }
  }
  return { lastActivityTs };
}

// 关联单是否还开着（#492 v3：open PR 或 open issue 任一开着就不算孤儿）。
// 查不到 ≠ 关了：gh 失败返回 { error }，调用方跳过孤儿判定（fail-visible，不猜）。
function liveTicketOpen(n) {
  const pr = spawnSync('gh', ['pr', 'view', String(n), '--json', 'state', '-q', '.state'], { encoding: 'utf8', timeout: 15000 });
  if (!pr.error && pr.status === 0 && /OPEN/i.test(String(pr.stdout))) return { open: true, kind: 'pr' };
  const issue = spawnSync('gh', ['issue', 'view', String(n), '--json', 'state', '-q', '.state'], { encoding: 'utf8', timeout: 15000 });
  if (!issue.error && issue.status === 0 && /OPEN/i.test(String(issue.stdout))) return { open: true, kind: 'issue' };
  if (pr.error && issue.error) return { error: `gh 查 #${n} 失败（pr: ${String(pr.error.message).slice(0, 60)} / issue: ${String(issue.error.message).slice(0, 60)}）` };
  return { open: false, kind: null }; // pr/issue 都不 open（含不存在）→ 关联已收口
}

// ── terminal read 响应规整（live 与快照共用同一段逻辑）──────────────
// 返回 {handle, status, tail, nextCursor} 或 {error}；读失败一律 fail-visible（审读红 3）。
// nextCursor 保留读取（旧快照兼容），但**不再用于任何活性判据**（#500：spinner 重绘也动 cursor）。
function normalizeReadResponse(res, handle) {
  if (!res || res.ok !== true) {
    return { error: `orca terminal read 失败：${errText(res?.error) || '无错误详情'}` };
  }
  const t = res.json?.result?.terminal;
  if (!t) return { error: 'orca terminal read 成功响应但缺 result.terminal（结构畸形）' };
  if (typeof t.status !== 'string' || !Array.isArray(t.tail)) {
    return { error: 'orca terminal read 成功响应但 status/tail 字段缺失（结构畸形）' };
  }
  const nc = t.nextCursor;
  return {
    handle: t.handle || handle,
    status: t.status,
    tail: t.tail,
    nextCursor: nc == null ? null : Number(nc),
  };
}

// 返回 { ps, paneByKey, readTerminal, tlError, terminalsByPath }；ps 拉不到时返回 { infraError }
function makeLiveSource(window) {
  const psR = runOrca(['worktree', 'ps', '--json']);
  if (!psR.ok) return { infraError: `orca worktree ps --json 失败：${errText(psR.error)}` };
  const ps = unwrapPayload(psR.json, 'worktrees', 'worktrees');
  if (!Array.isArray(ps)) return { infraError: 'ps 输出结构不认识（没有 result.worktrees 数组）' };

  const tlR = runOrca(['terminal', 'list', '--json']);
  const terminals = tlR.ok ? unwrapPayload(tlR.json, 'terminals', 'terminals') : null;
  const paneByKey = Array.isArray(terminals) ? buildPaneIndex(terminals) : new Map();
  const tlError = tlR.ok
    ? (Array.isArray(terminals) ? null : 'orca terminal list 成功响应但缺 result.terminals 数组')
    : `orca terminal list --json 失败：${errText(tlR.error)}`;

  const cache = new Map();
  const readTerminal = (handle) => {
    if (cache.has(handle)) return cache.get(handle);
    const res = normalizeReadResponse(runOrca(['terminal', 'read', '--terminal', handle, '--limit', String(window), '--json']), handle);
    cache.set(handle, res);
    return res;
  };

  return {
    ps, paneByKey, readTerminal, tlError,
    terminals: Array.isArray(terminals) ? terminals : [],
    terminalsByPath: buildTerminalsByPath(terminals),
    prEvidence: livePrEvidence(),
    dispatchTracked: liveDispatchTracked(),
  };
}

function buildTerminalsByPath(terminals) {
  const byPath = new Set();
  if (Array.isArray(terminals)) {
    for (const t of terminals) {
      if (t.worktreePath) byPath.add(t.worktreePath);
      if (t.worktreeId) byPath.add(t.worktreeId);
    }
  }
  return byPath;
}

// ── 快照采集（--snapshot-dir 模式）──────────────────────────────────

function loadSnapshotRounds(dir) {
  if (!existsSync(dir)) {
    console.error(`快照目录不存在：${dir}`);
    process.exit(3);
  }
  const roundSubs = readdirSync(dir)
    .filter(d => /^round-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const dirs = roundSubs.length > 0 ? roundSubs.map(d => join(dir, d)) : [dir];
  return dirs.map(loadSnapshotRound);
}

function loadSnapshotRound(roundDir) {
  const readJson = (name) => {
    const p = join(roundDir, name);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  };

  const psJson = readJson('ps.json');
  if (!psJson) throw new Error(`${roundDir}: 缺 ps.json，快照至少要有 ps 快照`);
  const ps = unwrapPayload(psJson, 'worktrees', 'worktrees');
  if (!Array.isArray(ps)) throw new Error(`${roundDir}: ps.json 结构不认识`);

  const tlJson = readJson('terminal-list.json');
  const terminals = tlJson ? unwrapPayload(tlJson, 'terminals', 'terminals') : [];
  const paneByKey = Array.isArray(terminals) ? buildPaneIndex(terminals) : new Map();

  const reads = new Map();
  const handleFromName = (f) => f.replace(/^read-/, '').replace(/\.json$/, '');
  for (const f of readdirSync(roundDir).filter(f => /^read-.+\.json$/.test(f))) {
    const j = JSON.parse(readFileSync(join(roundDir, f), 'utf8'));
    const res = normalizeReadResponse({ ok: j?.ok !== false, json: j, error: j?.error }, handleFromName(f));
    reads.set(res.handle || handleFromName(f), res);
  }

  const readTerminal = (handle) => {
    const t = reads.get(handle);
    if (!t) return { error: `快照里没有该终端的 read 文件（句柄 ${handle}）` };
    return t.error ? { error: t.error } : t;
  };

  // 证据文件（可缺省；缺省时对应判据明确报「没查成」而不是当作查过没事）：
  //   git-evidence.json  { capturedAt: <ms>, worktrees: { <worktreeId>: { lastActivityTs: <ms> } } }
  //   gh-evidence.json   { <worktreeId>: { ticketOpen: bool, ticket: "pr 505"|"issue 483"|null } }
  //   pr-evidence.json   { <worktreeId>: { number, open: bool, isDraft: bool, reviewDecision } }（#569）
  //   heartbeat.json     见 flow.mjs 心跳契约（#497 立约）
  //   flow-signals.json  { prs: [{ number, comments, reviews }] }（#580：心跳缺失时的待流转证据）
  //   worker-list-evidence.json  { worktrees: [ <worktreeId>, ... ] }（#569 BLIND：dispatch 记账集合）
  const gitEv = readJson('git-evidence.json');
  const ghEv = readJson('gh-evidence.json');
  const prEv = readJson('pr-evidence.json');
  const hb = readJson('heartbeat.json');
  const flowSignals = readJson('flow-signals.json');
  const wlEv = readJson('worker-list-evidence.json');

  return {
    ps, paneByKey, readTerminal, tlError: null, label: basename(roundDir),
    terminals: Array.isArray(terminals) ? terminals : [],
    terminalsByPath: buildTerminalsByPath(terminals),
    gitEvidence: gitEv?.worktrees || null,
    gitCapturedAt: gitEv?.capturedAt ?? null,
    ghEvidence: ghEv || null,
    prEvidence: prEv || null,
    heartbeat: hb || null,
    flowSignals: flowSignals || null,
    sessionsDir: join(roundDir, 'sessions'),
    dispatchTracked: wlEv && Array.isArray(wlEv.worktrees) ? { tracked: new Set(wlEv.worktrees.filter(Boolean)) } : { missing: true },
  };
}

// ── 一轮扫描 ────────────────────────────────────────────────────────

function matchFingerprints(text) {
  const hits = [];
  for (const fp of ERROR_FINGERPRINTS) {
    if (fp instanceof RegExp ? fp.test(text) : text.toLowerCase().includes(String(fp).toLowerCase())) {
      hits.push(fp instanceof RegExp ? fp.source : String(fp));
    }
  }
  return hits;
}

function matrixRowFor(fpText) {
  for (const row of DISPOSE_MATRIX) {
    if (row.fp instanceof RegExp ? row.fp.test(fpText) : String(row.fp).toLowerCase() === String(fpText).toLowerCase()) {
      return row;
    }
  }
  return null;
}

// 处置动作 → 发送序列。Node spawnSync 直传 orca 参数不走 Git Bash，/branch 不会被转盘符。
function actionCommands(handle, action) {
  switch (action) {
    case 'keepalive':
      return [{ send: { handle, text: '看门狗续命：检测到连接波动，请继续当前任务', enter: true } }];
    case 'send3':
      return [{ send: { handle, text: '3', enter: true } }];
    case 'send-enter':
      return [{ send: { handle, text: '', enter: true } }];
    case 'reclaude-branch':
      return [
        { send: { handle, text: '/branch', enter: true } },
        { waitMs: 3000 },
        { send: { handle, text: '继续', enter: true } },
      ];
    case 'reclaude-restart':
      return [
        { send: { handle, text: '/exit', enter: true } },
        { waitMs: 3000 },
        { send: { handle, text: 'reclaude --model opus --continue', enter: true } },
        { waitMs: 8000 },
        { send: { handle, text: '继续', enter: true } },
      ];
    default:
      return [];
  }
}

// 执行处置动作：live 模式经 orca terminal send 真发；快照/测试模式只打印动作行。
// 日志行进 events（跟随指纹报警一起显形）。context 守卫：reclaude 系动作只在屏面
// 上下文含 reclaude/Claude 时执行——防把 /exit 或 /branch 打进非 reclaude 终端。
function executeDispose(target, row, contextText, live, events, notes) {
  const label = row.label || row.action;
  if (row.action === 'ignore') {
    notes.push({ name: target.name, type: '观察', detail: `处置矩阵命中「${label}」——忽略噪音不动作` });
    return;
  }
  if (row.requireContext && !/reclaude|claude/i.test(contextText || '')) {
    notes.push({ name: target.name, type: '观察', detail: `处置矩阵命中「${label}」但屏面上下文不含 reclaude/Claude——不执行 reclaude 系动作，只报不动作（#471 上下文守卫）` });
    return;
  }
  const cmds = actionCommands(target.handle, row.action);
  for (const c of cmds) {
    if (c.waitMs) { sleep(c.waitMs); continue; }
    if (live && target.handle) {
      const r = runOrca(['terminal', 'send', '--terminal', c.send.handle, '--text', c.send.text, ...(c.send.enter ? ['--enter'] : []), '--json']);
      const shown = (c.send.text === '' && c.send.enter) ? '回车' : c.send.text;
      events.push({ name: target.name, type: '动作', detail: `${label}：已发送「${shown}」${r.ok ? '' : '——发送失败 ' + errText(r.error)}` });
    } else {
      const shown = (c.send.text === '' && c.send.enter) ? '回车' : c.send.text;
      events.push({ name: target.name, type: '动作', detail: `${label}：将发送「${shown}」（快照/测试模式打印动作行不真发）` });
    }
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 结构性排除（按 id 判，不碰 displayName）。
function isExcluded(w, a, args) {
  if (w.isMainWorktree === true) return true;
  if (args.selfWorktree && w.worktreeId === args.selfWorktree) return true;
  return false;
}

function isGradedExcluded(a, args) {
  return !!(a.paneKey && args.excludePanes.includes(a.paneKey));
}

function isTaskCard(w) {
  return /^#\d+ - /.test(String(w.displayName || ''));
}

/** 仍在途、还该有活工人的任务卡。in-review/completed = 已交付等下一环，不算卡死。 */
function expectsLiveWorker(w, args) {
  if (!w || w.isArchived === true) return false;
  if (w.isMainWorktree === true) return false;
  if (args.selfWorktree && w.worktreeId === args.selfWorktree) return false;
  if (!isTaskCard(w)) return false;
  const st = String(w.workspaceStatus || '');
  if (st === 'in-review' || st === 'completed' || st === 'done') return false;
  return true;
}

function terminalsForWorktree(w, source) {
  const list = Array.isArray(source.terminals) ? source.terminals : [];
  return list.filter(t => t && t.handle && (t.worktreeId === w.worktreeId || t.worktreePath === w.path));
}

const PASTED_CONTENT_FP = /\[Pasted Content \d+ chars?\]/i;

function matchPastedContent(text) {
  const m = String(text || '').match(PASTED_CONTENT_FP);
  return m ? m[0] : null;
}

// git 证据：live 现查；快照读 git-evidence.json；都没有 → { missing: true }（判据显式没查成）。
function gitEvidenceFor(w, source, args) {
  if (args.snapshotDir) {
    const ev = source.gitEvidence?.[w.worktreeId] || source.gitEvidence?.[w.path];
    if (ev && ev.lastActivityTs != null) return { lastActivityTs: ev.lastActivityTs };
    return { missing: true };
  }
  return liveGitEvidence(w.path);
}

function nowMs(source, args) {
  if (args.now != null) return args.now;
  if (args.snapshotDir && source.gitCapturedAt != null) return source.gitCapturedAt;
  return Date.now();
}

// 树内关联单编号：#N 或数字开头（"500-活性判据" → 500；"#467-审官" → 467；"审官·GPT" → null）
function assocNumber(name) {
  const m = String(name || '').match(/^#?(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── 在途 PR 证据（#569 降噪 ②：已交付等下一环的工位不算空转）──────────
// 一轮一次批量 `gh pr list`（按 head 分支名匹配各工作树），不逐个查。
// 快照模式从 pr-evidence.json 读：{ <worktreeId>: { number, open, isDraft, reviewDecision } }。
function livePrEvidence() {
  const r = spawnSync('gh', ['pr', 'list', '--json', 'number,headRefName,state,isDraft,reviewDecision', '--limit', '100'], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) {
    return { error: `gh pr list 失败：${String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 160)}` };
  }
  try {
    const prs = JSON.parse(r.stdout);
    const byBranch = new Map();
    for (const p of Array.isArray(prs) ? prs : []) {
      if (!p.headRefName) continue;
      byBranch.set(`refs/heads/${p.headRefName}`, {
        number: p.number,
        open: p.state === 'OPEN',
        isDraft: p.isDraft === true,
        reviewDecision: p.reviewDecision || null, // '' / null 都归 null（未请求评审）
      });
    }
    return { byBranch };
  } catch (e) {
    return { error: `gh pr list 输出解析失败：${e.message}` };
  }
}

// 每树在途 PR 证据：{ open,isDraft,reviewDecision,number } / { none } / { missing } / { error }。
// missing/error 一律显式「没查成」——查不到不等于「没在途 PR」，不放行空转豁免（fail-visible）。
function prEvidenceFor(w, source, args) {
  if (!args.snapshotDir) {
    if (source.prEvidence?.error) return { error: source.prEvidence.error };
    if (!source.prEvidence?.byBranch) return { missing: true };
    const branch = String(w.branch || '').replace(/^refs\/heads\//, '');
    if (!branch) return { missing: true };
    const hit = source.prEvidence.byBranch.get(branch) || source.prEvidence.byBranch.get(`refs/heads/${branch}`);
    return hit || { none: true };
  }
  const ev = source.prEvidence && (source.prEvidence[w.worktreeId] || source.prEvidence[w.path]);
  return ev ? { ...ev } : { missing: true };
}

// ── dispatch 记账证据（#569 BLIND 判据订正，2026-08-17）────────────────
// 真隐形判据 = 有活终端 + **查不到 dispatch 记账**。记账集合 = orca orchestration worker-list 的
// resource.worktreeId（worker-list / worker-show 是独立查询通道，不需要绑 run——垫片当初只能拿
// agents 凑合，就是因为它长驻没绑 run，task-list 类命令报 run_required；watchdog 每次 spawn 新
// orca 进程，worker-list 直接可用）。快照模式从 worker-list-evidence.json 读：
// { worktrees: [ <worktreeId>, ... ] }。
function liveDispatchTracked() {
  const r = runOrca(['orchestration', 'worker-list', '--json']);
  if (!r.ok) return { error: `orca orchestration worker-list 失败：${errText(r.error)}` };
  const workers = r.json?.result?.workers;
  if (!Array.isArray(workers)) return { error: 'orca orchestration worker-list 返回结构不认识（缺 result.workers 数组）' };
  const tracked = new Set();
  for (const wk of workers) {
    const wt = wk?.resource?.worktreeId;
    if (wt) tracked.add(wt);
  }
  return { tracked };
}

function stationState(state, key) {
  return state.stations[key] ||= {
    epoch: null, lastHash: null, consecutive: 0, fired: new Set(), prevUpdatedAt: null, prevIncarnation: null,
    fpStreak: 0, fpLoss: { persistCount: 0, firstTs: 0, reported: false },
    selStreak: 0, pastedStreak: 0, idleExempt: null,
    retryLine: null, retryStreak: 0,
  };
}

// #580 追加：不依赖「认识这条错误」——尾部像 5xx/不可用 的行，去掉时间/ray/hex 后比同一性。
const RETRY_LINE_RE = /unexpected status\s*5\d\d|status\s*5\d\d|Service Unavailable|api_key_registry_unavailable|\b5\d\d\b.{0,60}unavailable|ECONNRESET|ETIMEDOUT|ENOTFOUND/i;

function normalizeRetryLine(line) {
  return String(line)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, 'TS')
    .replace(/cf-ray:\s*\S+/gi, 'CFRAY')
    .replace(/[0-9a-f]{8,}/gi, 'HEX')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function lastRetryLine(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = String(arr[i] || '');
    if (RETRY_LINE_RE.test(s)) return normalizeRetryLine(s);
  }
  return null;
}

function checkPastedContent(t, read, strippedHash, args, st, events, notes) {
  if (t.graded) return;
  const pasted = matchPastedContent(normLines(read.tail));
  const running = read.status === 'running';
  const realChanged = st.lastHash != null && strippedHash !== st.lastHash;
  if (pasted && running) {
    st.pastedStreak += 1;
    if (st.pastedStreak >= PARAMS.pastedRounds && !st.fired.has('pasted-content')) {
      if (realChanged) {
        notes.push({ name: t.name, type: '观察', detail: `屏面含「${pasted}」持续 ${st.pastedStreak} 轮但非 spinner 真实内容在动——活证否决，不唤醒` });
      } else {
        st.fired.add('pasted-content');
        events.push({
          name: t.name,
          type: 'pasted-content',
          detail: `终端 running 且屏面「${pasted}」持续 ${st.pastedStreak} 轮、非 spinner 内容无增长——任务书折在输入框（#575；#574 审官 5711 字符实证：全链路返回值皆绿、一个字没审）。补一记回车是已知救活动作`,
        });
        if (args.disposeActions) {
          executeDispose(t, { action: 'send-enter', label: '补一记回车（Pasted Content 停摆）' }, normLines(read.tail), !args.snapshotDir, events, notes);
        }
      }
    }
  } else {
    st.pastedStreak = 0;
    st.fired.delete('pasted-content');
  }
}

function scanIdleCardsForPasted(idleCards, source, args, state, events, notes) {
  for (const w of idleCards) {
    for (const term of terminalsForWorktree(w, source)) {
      const t = {
        key: `${w.worktreeId || w.path || '?'}|idle|${term.handle}`,
        name: w.displayName || '?',
        handle: term.handle,
        agent: { state: 'idle' },
        incarnationId: term.incarnationId ?? null,
        graded: false,
      };
      const st = stationState(state, t.key);
      const read = source.readTerminal(t.handle);
      if (read.error) continue; // 卡死报警已经打了，读屏失败不另起 read-failed 刷屏
      const strippedHash = sha256(stripChrome(normLines(read.tail)));
      checkPastedContent(t, read, strippedHash, args, st, events, notes);
      st.lastHash = strippedHash;
    }
  }
}

function runRound(source, args, state) {
  const targets = [];
  for (const w of source.ps) {
    const agents = Array.isArray(w.agents) ? w.agents : [];
    const mon = agents.filter(a => (a.state === 'working' || a.state === 'waiting') && !isExcluded(w, a, args));
    if (mon.length === 0) continue;
    const multi = mon.length > 1;
    mon.forEach((a, i) => {
      const pane = a.paneKey ? source.paneByKey.get(a.paneKey) : undefined;
      targets.push({
        key: `${w.worktreeId || w.id || w.path || '?'}|${a.paneKey || i}`,
        name: multi ? `${w.displayName || '?'}#${i + 1}` : (w.displayName || '?'),
        agent: a,
        handle: pane ? pane.handle : undefined,
        incarnationId: pane ? pane.incarnationId : null,
        graded: isGradedExcluded(a, args),
      });
    });
  }

  const events = [];
  const notes = []; // 活证否决/守卫降级的观察行：打印但不唤醒
  if (targets.length === 0) {
    const idleCards = source.ps.filter(w => expectsLiveWorker(w, args));
    if (idleCards.length === 0) {
      return { noTargets: true, targets, events, notes };
    }
    const names = idleCards.map(w => w.displayName).join('、');
    events.push({
      name: '盘面',
      type: 'all-idle',
      detail: `盘面有 ${idleCards.length} 张仍在途的任务卡（${names}）却零 working/waiting 工位——不是没查成，是全员卡死（#575；#574 当晚审官折在输入框 + 工人 idle = 零活工位，旧口径每轮把这事当成没样本）`,
    });
    scanIdleCardsForPasted(idleCards, source, args, state, events, notes);
    return { allIdle: true, noTargets: false, targets, events, notes };
  }

  const now = nowMs(source, args);
  for (const t of targets) {
    const st = stationState(state, t.key);
    const graded = t.graded === true; // 分级排除：豁免指纹/停摆/空转，保留 exited/waiting 死活判据

    // ② ps waiting 态（弹窗/等输入的官方信号）
    if (t.agent.state === 'waiting') {
      if (!st.fired.has('waiting')) {
        st.fired.add('waiting');
        events.push({ name: t.name, type: 'waiting', detail: 'ps agents[].state=waiting——有弹窗/等输入（#442 官方信号），第一动作发一记回车或读屏辨弹窗' });
      }
    } else {
      st.fired.delete('waiting');
    }

    // 读屏面（读失败一律 fail-visible，不静默放行——审读红 3）
    const read = t.handle ? source.readTerminal(t.handle) : { error: `paneKey 在 terminal list 里没有对应句柄（${source.tlError || 'terminal list 为空'}）` };
    if (read.error) {
      if (!st.fired.has('read-failed')) {
        st.fired.add('read-failed');
        events.push({ name: t.name, type: 'read-failed', detail: `读不到终端屏面：${read.error}——被监视工位却读不到屏面本身可疑` });
      }
      continue; // 屏面都读不到，下面的判据无从谈起
    }
    st.fired.delete('read-failed');

    // ① 终端 exited（独立于交卷/报错，拍板追加①：卡片被误关/非完工退场）
    if (read.status === 'exited') {
      if (!st.fired.has('exited')) {
        st.fired.add('exited');
        events.push({ name: t.name, type: 'exited', detail: '终端已退出（exited）——非完工态退场需人工分诊（#442 三分类：交卷→收卷、报错→重试、指纹两连→换人）' });
      }
    } else {
      st.fired.delete('exited');
    }

    const all = normLines(read.tail);
    const bottom = normLines(read.tail.slice(-args.stateWindow));

    // ── #500 换代：活性只认「非 spinner 真实内容」──────────────────
    // 剔除 chrome（spinner 盲文帧 + TUI 计时行）后的哈希是唯一活性信号：
    //   - 变化 = 真实内容在动 → 活（否决指纹报警的依据）
    //   - 三轮不变 = 停摆候选（spinner 重绘 / cursor 前进 / ps updatedAt 前进都不算）
    const stripped = stripChrome(all);
    const strippedHash = sha256(stripped);
    const realChanged = st.lastHash != null && strippedHash !== st.lastHash;

    // ③ 错误指纹（只看屏面底部当前状态窗口）——两连同才报警 + 活证否决（真实内容在动）。
    // 处置：首警执行矩阵动作 + 连败计数（#471：恢复即清零，连败 N 轮或跨 N 分钟报帅，报帅后不再自动动作）。
    if (!graded) {
      const matched = matchFingerprints(bottom);
      if (matched.length > 0) {
        st.fpStreak += 1;
        if (st.fpStreak >= 2 && !st.fired.has('fingerprint')) {
          if (realChanged) {
            // 活证否决：非 spinner 真实内容在动 = 讨论/输出在动——审官屏面讨论误报的止血阀，不唤醒
            notes.push({ name: t.name, type: '观察', detail: `指纹两连同「${matched.join('、')}」但非 spinner 真实内容在动——活证否决，不唤醒，仅记录（#500 换代：否决只看真实内容，spinner 重绘不算）` });
          } else {
            st.fired.add('fingerprint');
            st.fpLoss.persistCount = 0; st.fpLoss.firstTs = now; st.fpLoss.reported = false;
            events.push({ name: t.name, type: 'fingerprint', detail: `屏面底部命中错误指纹「${matched.join('、')}」两连同——报错→原地续命一次，指纹两连同→换人不救（#442 分诊三分支）` });
            // #471 处置矩阵：命中 → 动作；矩阵未命中 → 报帅（矩阵是唯一账本，新事故先在矩阵加行）
            const row = matrixRowFor(matched[0]);
            if (args.disposeActions && row) {
              executeDispose(t, row, all, !args.snapshotDir, events, notes);
            } else if (!row) {
              events.push({ name: t.name, type: '报帅', detail: `指纹「${matched[0]}」命中但处置矩阵无此行——上报帅（#471：矩阵未命中→上报帅）` });
            }
          }
        } else if (st.fpStreak >= 2 && st.fired.has('fingerprint')) {
          // 已报警后的连续命中 = 连败（#471：恢复即清零；连败 N 轮或跨 N 分钟报帅，报帅后不再自动动作）
          st.fpLoss.persistCount += 1;
          if (!st.fpLoss.reported && (st.fpLoss.persistCount >= PARAMS.fpLossLimit || (now - st.fpLoss.firstTs) > PARAMS.fpLossWindowMs)) {
            st.fpLoss.reported = true;
            events.push({ name: t.name, type: '报帅', detail: `指纹「${matched[0]}」连败（连续命中 ${st.fpStreak} 轮）——矩阵动作不再自动重复，上报帅处置（#471 连败阈值：${PARAMS.fpLossLimit} 轮或 ${Math.round(PARAMS.fpLossWindowMs / 60000)} 分钟）` });
          }
        }
      } else {
        st.fpStreak = 0;
        st.fired.delete('fingerprint');
        st.fpLoss.persistCount = 0; st.fpLoss.firstTs = 0; st.fpLoss.reported = false;
      }
    }

    // ⑩ 权限确认框停摆指纹（#569 ④）：屏面底部出现 N/M:select 选择器提示且持续超阈轮。
    // 判据很硬、可机检：进程活着（ps working/status.terminal=running）、开过工（proof.proven）、
    // 但在等一个永远不会来的人类输入——#568 实证 grok 审官卡在权限确认框 7 分钟一个字没审。
    // 检测到就报，不自动替它选（选哪个有后果，尤其 reject 那一项）。活证否决：非 spinner 真实
    // 内容在动 = 可能正在作答，不唤醒。
    if (!graded) {
      const sel = bottom.match(/(\d+)\/(\d+)\s*:select/i);
      if (sel) {
        st.selStreak += 1;
        if (st.selStreak >= PARAMS.selectorRounds && !st.fired.has('selector')) {
          if (realChanged) {
            notes.push({ name: t.name, type: '观察', detail: `屏面底部选择器「${sel[0]}」持续 ${st.selStreak} 轮但非 spinner 真实内容在动——活证否决（可能正在作答），不唤醒` });
          } else {
            st.fired.add('selector');
            events.push({ name: t.name, type: 'selector', detail: `屏面底部选择器「${sel[0]}」持续 ${st.selStreak} 轮——agent 卡在权限确认框等人类输入（#569；#568 实证：没人应就永远停在那里，编排层一切正常）。不自动替它选（选哪个有后果，尤其 reject），读屏分诊/terminal send 叫醒` });
          }
        }
      } else {
        st.selStreak = 0;
        st.fired.delete('selector');
      }
    }

    // ⑫ Pasted Content 停摆（#575）：任务书折在输入框。照 selector 两连同 + 活证否决；
    // 处置是补回车（当晚已知救活动作，没有「选哪个」的后果）。
    checkPastedContent(t, read, strippedHash, args, st, events, notes);

    // ⑭ 重试循环（#580 追加）：尾部同一条 5xx/不可用 行连续 N 轮，即使真实内容在变也报。
    // 指纹活证否决会把「在重试」当成活着；本判据不看 strippedHash。有新鲜 git 产出则不报。
    if (!graded) {
      const retryLine = lastRetryLine(read.tail);
      if (retryLine && retryLine === st.retryLine) st.retryStreak += 1;
      else if (retryLine) { st.retryLine = retryLine; st.retryStreak = 1; }
      else { st.retryLine = null; st.retryStreak = 0; st.fired.delete('retry-loop'); }
      if (retryLine && st.retryStreak >= PARAMS.retryLoopRounds && !st.fired.has('retry-loop')) {
        const w = source.ps.find(x => (Array.isArray(x.agents) ? x.agents : []).some(a => a.paneKey === t.agent.paneKey));
        const ev = w ? gitEvidenceFor(w, source, args) : { missing: true };
        const freshGit = !!(ev && ev.lastActivityTs != null && (now - ev.lastActivityTs) <= PARAMS.idleMinutes * 60000);
        if (freshGit) {
          notes.push({ name: t.name, type: '观察', detail: `重试行连续 ${st.retryStreak} 轮但 git 产出新鲜——有进展，不报` });
        } else {
          st.fired.add('retry-loop');
          events.push({ name: t.name, type: 'retry-loop', detail: `屏面尾部同一错误行连续 ${st.retryStreak} 轮（「${retryLine.slice(0, 80)}」）——疑似重试循环，真实内容在变也不算进展（#580；503 审官哑火实证）` });
        }
      }
    }

    // ④ 停摆判据（#500 换代）：
    //    主判据 = 非 spinner 真实内容连续 N 轮不变（strippedHash 不变）。
    //    生命周期键 = 终端 incarnationId（同 pane 重启重新起算）；ps updatedAt 变化不算活性——
    //    #500 实证：转圈挂死时屏面在动、cursor 在动、ps 也可能在动，只有真实内容不动。
    const incarnation = t.incarnationId ?? null;
    const epoch = `${incarnation}`;
    if (!graded) {
      if (st.epoch !== epoch || realChanged) {
        st.epoch = epoch;
        st.lastHash = strippedHash;
        st.consecutive = 1;
        st.fired.delete('stall');
      } else {
        st.consecutive += 1;
        if (st.consecutive >= PARAMS.stallRounds && !st.fired.has('stall')) {
          st.fired.add('stall');
          events.push({ name: t.name, type: 'stall', detail: `非 spinner 真实内容连续 ${PARAMS.stallRounds} 轮不变——停摆候选（#500 换代：spinner 重绘 / cursor 前进 / ps updatedAt 前进都不算活性，转圈挂死 27 分钟实证），读屏分诊` });
        }
      }
    } else {
      st.lastHash = strippedHash; // 分级排除工位仍记录哈希，回来时不串旧值
    }

    // ⑥ 空转 v2（#471 第四类事故 + #569 降噪只减假阳不减真阳）：
    //    强判据 = 进程在动（ps working）+ 工作树 N 分钟无 git 活动。三类豁免各自的判据（不是名单）：
    //      ① 子卡（审官/辅助，卡名带 ·）：产出是 review comment 与 notify 不是 commit——git 判据
    //         对它们无意义，停摆由 stall/指纹/选择器⑩/waiting 判据兜底（#568 那个卡权限框的
    //         审官就是被这组判据接住的，不是没人看）；
    //      ② 在途 PR 等别人：本树分支上有 OPEN 非 draft 且非 CHANGES_REQUESTED 的 PR =
    //         「已交付、正在等下一环」，不算空转（#565 已推 PR 等审实证）；PR 要返工时仍判；
    //      ③ 活性否决（#500 一致性）：非 spinner 真实内容在动 = 活（弱判据），不算空转——
    //         刚重启正在开 PR（#567 实证）/ 正在做非 commit 活都不算。
    //    git 证据缺失/拉不到 → 显式「没查成」note（查不到 ≠ 查过没事，不猜）。
    //    真空转（working + 屏面冻结 + 无在途 PR + 非子卡）照旧报——验收 2 的对照样本就是它。
    if (!graded && t.agent.state === 'working') {
      const w = source.ps.find(x => (Array.isArray(x.agents) ? x.agents : []).some(a => a.paneKey === t.agent.paneKey));
      const ev = w ? gitEvidenceFor(w, source, args) : { missing: true };
      if (ev.missing) {
        notes.push({ name: t.name, type: '观察', detail: 'GIT_EVIDENCE_MISSING: 本轮没有 git 证据（快照缺 git-evidence.json / live 目录不存在）——空转项没查成，不是查过没事' });
      } else if (ev.error) {
        notes.push({ name: t.name, type: '观察', detail: `git 证据拉不到：${ev.error}——空转项没查成（不猜）` });
      } else if (ev.lastActivityTs != null && (now - ev.lastActivityTs) > PARAMS.idleMinutes * 60000) {
        const mins = Math.round((now - ev.lastActivityTs) / 60000);
        // 豁免判断（按证据、按角色，不是 pane 名单）
        const roleExempt = w ? /·/.test(String(w.displayName || '')) : false;
        const prEv = w ? prEvidenceFor(w, source, args) : null;
        const prExempt = !!(prEv && prEv.open === true && prEv.isDraft !== true && prEv.reviewDecision !== 'CHANGES_REQUESTED');
        const liveVeto = realChanged === true;
        const exempt = roleExempt ? 'role' : prExempt ? 'pr' : liveVeto ? 'live' : null;
        if (exempt) {
          st.fired.delete('idle');
          const changed = st.idleExempt !== exempt;
          st.idleExempt = exempt;
          // 豁免 note 只在状态切换时打一次，不每轮刷屏（常驻状态不重复唤醒）
          if (changed && exempt === 'role') {
            notes.push({ name: t.name, type: '观察', detail: '子卡（审官/辅助，卡名带 ·）不判 git 空转——产出是 review comment 与 notify 不是 commit（#569），其停摆由 stall/指纹/选择器/waiting 判据兜底' });
          } else if (changed && exempt === 'pr') {
            const prNo = prEv.number != null ? ` #${prEv.number}` : '';
            const dec = prEv.reviewDecision || '等待评审/合并';
            notes.push({ name: t.name, type: '观察', detail: `在途 PR${prNo}（OPEN 非 draft，${dec}）等着别人——已交付的工位不算空转（#569），等待环不在本工位` });
          } else if (changed && exempt === 'live') {
            notes.push({ name: t.name, type: '观察', detail: '空转豁免：非 spinner 真实内容在动——活性否决（#500 弱判据，刚重启正在开 PR / 正在做非 commit 活），本轮不算空转' });
          }
        } else {
          st.idleExempt = null;
          if (prEv && (prEv.missing || prEv.error)) {
            notes.push({ name: t.name, type: '观察', detail: `PR_EVIDENCE_${prEv.error ? 'ERROR' : 'MISSING'}: ${prEv.error || '本轮没有在途 PR 证据（快照缺 pr-evidence.json / 无分支）'}——空转豁免没查成，不是查过没事（查不到不等于没在途 PR）` });
          }
          if (!st.fired.has('idle')) {
            st.fired.add('idle');
            events.push({ name: t.name, type: 'idle', detail: `空转候选：进程在动（ps state=working）但工作树 ${mins} 分钟无 git 活动，屏面无真实内容在动、无在途 PR、非子卡（#471：4 小时空转实证；#569 降噪后只剩这类真阳；处置：先 interrupt+催交付一次，仍无产出→换人不救）` });
          }
        }
      } else {
        st.fired.delete('idle');
        st.idleExempt = null;
      }
    }
  }

  return { noTargets: false, targets, events, notes };
}

// ── 树级扫描：孤儿树（#492/#476）+ 命名校验（#476）────────────────────
// 与工位扫描正交：孤儿树恰恰没有活跃 agent，只在这里扫得到。
// 主判据 = 还有没有活跃执行者（树内有 working/waiting agent 或 terminal list 里有该树）——
// 与「我认不认识它」无关，跨主帅通用（#492：任何「我不认识它⇒它是孤儿」的判据都必然误伤同僚）。
// 次判据（无活跃执行者才用）：关联 #N 的 PR/issue 全关 → 孤儿（产出收了就 rm）；
// 无关联 → 静置超 N 分钟才算孤儿候选。
function runWorktreePass(source, args, state) {
  const events = [];
  const notes = [];
  // 快照模式 gh 证据从 gh-evidence.json 读；缺省 → 关联单状态未知，孤儿次判据不猜（查不到≠孤儿）
  const now = nowMs(source, args);
  const selfRepo = args.selfWorktree ? String(args.selfWorktree).split('::')[0] : null;

  for (const w of source.ps) {
    if (w.isMainWorktree === true) continue;
    const id = w.worktreeId || w.path || '?';
    if (args.selfWorktree && w.worktreeId === args.selfWorktree) continue;
    const name = w.displayName || id;
    const st = state.worktrees[id] ||= { fired: new Set() };
    const agentsOf = Array.isArray(w.agents) ? w.agents : [];

    // 编排层隐形工人（#569 垫片 watch-board.mjs 并进；2026-08-17 判据订正——原「agents=0」是假阳）：
    // 真判据 = 有活终端（>1，排除单终端残留壳/浏览窗）且**查不到 dispatch 记账**（orca orchestration
    // worker-list 的 resource.worktreeId 没有它）——从没走 worker-start/dispatch 的工位 = 编排层
    // 不知道有工人在跑，看门狗工位循环与流转器都监视不到，只能人工盯。
    // 有记账的一律不报（订正实证：agents=0 的审官 worker-read 读得到、token 在涨，编排层看得见）；
    // worker-list 查不动 → 显式「没查成」note（查不到记账 ≠ 查过没事，不猜）。
    if ((w.liveTerminalCount || 0) > 1) {
      const tr = source.dispatchTracked;
      if (tr?.error) {
        notes.push({ name, type: '观察', detail: `DISPATCH_BOOKKEEPING_UNSCANNED: ${tr.error}——BLIND 判据没查成，不是查过没事` });
        st.fired.delete('blind');
      } else if (tr?.tracked && (tr.tracked.has(id) || tr.tracked.has(w.path))) {
        st.fired.delete('blind'); // 有记账 = 编排层看得见（哪怕 agents=0）
      } else if (tr?.tracked) {
        if (!st.fired.has('blind')) {
          st.fired.add('blind');
          events.push({ name, type: 'blind', detail: `编排层隐形工人：有 ${w.liveTerminalCount} 个活终端且查不到 dispatch 记账（orca orchestration worker-list 无此工作树）——从没走 worker-start/dispatch = 编排层不知道有工人在跑，看门狗与流转器都监视不到，只能人工盯（#569 垫片并进；2026-08-17 判据订正：agents=0 不算数，记账缺失才算真隐形）` });
        }
      } else {
        notes.push({ name, type: '观察', detail: 'DISPATCH_BOOKKEEPING_MISSING: 本轮没有 dispatch 记账证据（快照缺 worker-list-evidence.json）——BLIND 没查成，不是查过没事' });
        st.fired.delete('blind');
      }
    } else {
      st.fired.delete('blind');
    }

    // 命名校验（#476）：任务卡显示名格式。只查本仓（selfWorktree 的 repo 前缀），
    // 别的仓库/主帅的盘面命名约定可能不同，不越界（#492 跨主帅教训）。
    if (selfRepo && !String(w.worktreeId || '').startsWith(selfRepo)) continue;
    // #569 降噪：无 agent 且无 #N 前缀的树不是任务卡（master 已在上层按 isMainWorktree 排除；
    // review-566 这类「windsurf-dao」残留工作区按定义就不叫 #N - 动宾短语）——命名校验不适用；
    // 有 agent 的卡（含 agent 已 done 的历史卡）照查，误命名的活跃卡不丢。
    if (agentsOf.length === 0 && !/^#\d+/.test(String(name || ''))) {
      // 非任务卡，跳过
    } else if (name && !PARAMS.namingTop.test(name) && !PARAMS.namingSub.test(name)) {
      if (!st.fired.has('naming')) {
        st.fired.add('naming');
        events.push({ name, type: 'naming', detail: `任务卡命名不合规「${name}」——顶层应为「#<PR号> - 动宾短语」、子卡应为「#<PR号> - xxx·yyy」（#476 命名校验；见 dispatch SKILL 命名规矩）` });
      }
    } else if (name) {
      st.fired.delete('naming');
    }

    // 孤儿树（#492/#476）主判据：还有没有活跃执行者 = 树内有 terminal 且 agent 活着。
    // 与「我认不认识它」无关，跨主帅通用。terminal-list 拉不到 = 不知道有没有终端，不判孤儿（fail-visible）。
    const agents = agentsOf;
    const agentAlive = agents.some(a => a.state === 'working' || a.state === 'waiting');
    const hasTerminal = source.terminalsByPath.has(w.path) || source.terminalsByPath.has(id);
    const activeExecutor = agentAlive || hasTerminal;
    if (source.tlError && !args.snapshotDir) {
      notes.push({ name, type: '观察', detail: `terminal list 拉不到（${source.tlError}）——本轮孤儿判定没查成，不是查过没事` });
      continue;
    }
    if (activeExecutor) { st.fired.delete('orphan'); continue; }

    // 次判据：关联单已收口 / 无关联且静置超 N
    const assoc = assocNumber(name);
    let orphan = false;
    let why = '';
    if (assoc != null) {
      let open = null;
      if (args.snapshotDir) {
        const ev = source.ghEvidence?.[id];
        open = ev ? !!ev.ticketOpen : null; // null = 证据缺，不猜
        if (ev && ev.ticket) why = `关联 ${ev.ticket}`;
        else why = `关联 #${assoc}`;
      } else {
        const r = liveTicketOpen(assoc);
        if (r.error) { notes.push({ name, type: '观察', detail: `${r.error}——孤儿判定跳过（查不到≠孤儿，#492 查不到不当孤儿）` }); continue; }
        open = r.open;
        why = r.kind ? `关联 ${r.kind} #${assoc} 还开着` : `关联 #${assoc}（PR/issue 都未开）`;
      }
      if (open === false) { orphan = true; why = `无活跃执行者 + ${why}`; }
      // open === true → 不是孤儿；open === null（快照缺证据）→ 不猜，跳过
    } else {
      // 无 #N 关联：静置超 N 分钟才算孤儿候选（#476「创建超过 N 分钟」兜新建未开 PR 的树）
      const ev = gitEvidenceFor(w, source, args);
      if (ev.missing) { notes.push({ name, type: '观察', detail: 'GIT_EVIDENCE_MISSING: 无关联树没有 git 证据——静置项没查成，不是查过没事' }); continue; }
      if (ev.error) { notes.push({ name, type: '观察', detail: `git 证据拉不到：${ev.error}——孤儿判定跳过` }); continue; }
      const idleMins = Math.round((now - ev.lastActivityTs) / 60000);
      if (ev.lastActivityTs != null && (now - ev.lastActivityTs) > PARAMS.orphanStaleMinutes * 60000) {
        orphan = true; why = `无活跃执行者 + 无关联 + 静置 ${idleMins} 分钟`;
      } else {
        why = `无活跃执行者 + 无关联 + 静置 ${idleMins} 分钟（未超阈值，不算）`;
      }
    }
    if (orphan) {
      if (!st.fired.has('orphan')) {
        st.fired.add('orphan');
        events.push({ name, type: 'orphan', detail: `孤儿树候选：${why}——产出收了就 rm（#476 收卷即清树；判断依据如上，误报可见）` });
      }
    } else {
      st.fired.delete('orphan');
    }
  }
  return { events, notes };
}

// ── flow 心跳消费端（#471 停滞态 + #580 从未存在）──
// 三态三话：心跳新鲜 / 心跳过期 / 心跳从未存在。
// 文件缺失不再一律 note：有待流转对象（完工未起审官 / 判定行未处置）必须报。
// 待流转没查成 ≠ 没有待流转（仓规：没查成不许当查过没事）。
function loadPendingFlow(source, args) {
  if (args.snapshotDir) {
    if (!source.flowSignals) return { scanned: false, items: [], why: '快照无 flow-signals.json' };
    const raw = Array.isArray(source.flowSignals.prs) ? source.flowSignals.prs : [];
    const prs = raw.map(pr => ({
      number: pr.number,
      comments: commentsForPendingScan(pr),
      reviews: pr.reviews || [],
    }));
    return { scanned: true, items: pendingFlowItems(prs) };
  }
  return scanPendingFlowLive();
}

function mapGhComments(raw) {
  return (Array.isArray(raw) ? raw : []).map(c => ({
    id: c.id,
    body: c.body || '',
    createdAt: c.created_at || c.createdAt || '',
  }));
}

function mapGhReviews(raw) {
  return (Array.isArray(raw) ? raw : []).map(rv => ({
    id: rv.id,
    body: rv.body || '',
    submittedAt: rv.submitted_at || rv.submittedAt || '',
  }));
}

function scanPendingFlowLive() {
  const list = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,body'], { encoding: 'utf8', timeout: 20000 });
  if (list.error || list.status !== 0) {
    return { scanned: false, items: [], why: `gh pr list 失败：${String(list.error?.message || list.stderr || `exit ${list.status}`).trim().slice(0, 120)}` };
  }
  let prs;
  try { prs = JSON.parse(list.stdout || ''); }
  catch (e) { return { scanned: false, items: [], why: `gh pr list 不是 JSON：${e.message}` }; }
  if (!Array.isArray(prs)) return { scanned: false, items: [], why: 'gh pr list 不是数组' };

  const repoR = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8', timeout: 15000 });
  if (repoR.error || repoR.status !== 0) {
    return { scanned: false, items: [], why: `gh repo view 失败：${String(repoR.error?.message || repoR.stderr || `exit ${repoR.status}`).trim().slice(0, 120)}` };
  }
  let repo;
  try { repo = JSON.parse(repoR.stdout || '').nameWithOwner; }
  catch (e) { return { scanned: false, items: [], why: `gh repo view 不是 JSON：${e.message}` }; }
  if (!repo) return { scanned: false, items: [], why: 'gh repo view 缺 nameWithOwner' };

  const packed = [];
  for (const pr of prs) {
    const ticket = ticketIssueNumber(pr) || pr.number;
    const c = spawnSync('gh', ['api', `repos/${repo}/issues/${ticket}/comments`, '--paginate'], { encoding: 'utf8', timeout: 20000 });
    if (c.error || c.status !== 0) {
      return { scanned: false, items: [], why: `读 issue #${ticket} comments 失败（PR #${pr.number} 署名单）` };
    }
    const r = spawnSync('gh', ['api', `repos/${repo}/pulls/${pr.number}/reviews`, '--paginate'], { encoding: 'utf8', timeout: 20000 });
    if (r.error || r.status !== 0) {
      return { scanned: false, items: [], why: `读 PR #${pr.number} reviews 失败` };
    }
    let comments, reviews;
    try { comments = JSON.parse(c.stdout || '[]'); }
    catch (e) { return { scanned: false, items: [], why: `issue #${ticket} comments 不是 JSON：${e.message}` }; }
    try { reviews = JSON.parse(r.stdout || '[]'); }
    catch (e) { return { scanned: false, items: [], why: `PR #${pr.number} reviews 不是 JSON：${e.message}` }; }
    packed.push({ number: pr.number, comments: mapGhComments(comments), reviews: mapGhReviews(reviews) });
  }
  return { scanned: true, items: pendingFlowItems(packed) };
}

function checkHeartbeat(source, args, state) {
  const events = [];
  const notes = [];
  const st = state.heartbeat ||= { fired: new Set() };
  let hb = null;
  let absent = false;
  let absentWhy = '';
  if (args.snapshotDir) {
    hb = source.heartbeat;
    if (!hb) { absent = true; absentWhy = '快照无 heartbeat.json'; }
  } else {
    const p = args.heartbeatFile || resolve(process.cwd(), '_flow', 'heartbeat.json');
    if (!existsSync(p)) { absent = true; absentWhy = '_flow/heartbeat.json 不存在'; }
    else {
      try { hb = JSON.parse(readFileSync(p, 'utf8')); }
      catch (e) { notes.push({ name: 'flow', type: '观察', detail: `HEARTBEAT_MALFORMED: ${e.message}` }); return { events, notes }; }
    }
  }

  if (absent) {
    const pending = loadPendingFlow(source, args);
    if (!pending.scanned) {
      notes.push({ name: 'flow', type: '观察', detail: `HEARTBEAT_MISSING: ${absentWhy}；待流转没查成（${pending.why}）——不是扫完 0` });
      return { events, notes };
    }
    if (pending.items.length === 0) {
      notes.push({ name: 'flow', type: '观察', detail: `心跳从未存在（${absentWhy}）——无待流转对象，不报` });
      st.fired.delete('flow-absent');
      return { events, notes };
    }
    if (!st.fired.has('flow-absent')) {
      st.fired.add('flow-absent');
      const list = pending.items.map(i => `#${i.number} ${i.kind}`).join('、');
      events.push({ name: 'flow', type: 'flow-absent', detail: `心跳从未存在——有待流转对象却无人流转（${list}，#580），该发生的事没发生` });
    }
    return { events, notes };
  }

  const now = args.now != null ? args.now : Date.now();
  const ts = Date.parse(hb.ts);
  if (!Number.isFinite(ts)) { notes.push({ name: 'flow', type: '观察', detail: 'HEARTBEAT_MALFORMED: ts 不可解析' }); return { events, notes }; }
  const ageMin = Math.round((now - ts) / 60000);
  if (now - ts > PARAMS.heartbeatStaleMs) {
    if (!st.fired.has('flow-stalled')) {
      st.fired.add('flow-stalled');
      events.push({ name: 'flow', type: 'flow-stalled', detail: `心跳过期：流转器心跳 ${ageMin} 分钟未更新——flow 停摆候选（该发生而没发生，#471），恢复：重启 flow.mjs` });
    }
  } else {
    st.fired.delete('flow-stalled');
    notes.push({ name: 'flow', type: '观察', detail: `心跳新鲜（${Math.round((now - ts) / 1000)} 秒前更新）` });
  }
  for (const pr of Array.isArray(hb.prs) ? hb.prs : []) {
    const key = `stagnation-${pr.number}`;
    if (pr.sinceMs != null && pr.sinceMs > PARAMS.stagnationMs) {
      if (!st.fired.has(key)) {
        st.fired.add(key);
        events.push({ name: `PR#${pr.number}`, type: 'stagnation', detail: `state=${pr.state} 停留 ${Math.round(pr.sinceMs / 60000)} 分钟——该发生而没发生（下一步该帅做而帅没做，#471 停滞态：审官判绿没人合/完工没人派复核/出红没人派返工）` });
      }
    } else {
      st.fired.delete(key);
    }
  }
  return { events, notes };
}

// ── pi 静默换 provider 检测（#569 ②）──────────────────────────────────
// 扫 ~/.pi/agent/sessions/**/*.jsonl 里的 {"type":"model_change"} 事件，出现即报，附诱因。
// 为何要报：pi 遇 provider 瞬时失败会 1ms 内切到「同 model id 的别的 provider」（2026-08-16 实证：
// opencode-go 503 → deepseek 直连，成本从 ¥0.05 级跃到 $10 级，除账单外零信号）。本检测同时也是
// 本机 models-store.json 的 -direct 止血（见 NEW-MACHINE §6）的验证手段：下次真 503 是报错还是又切了。
// 判据：
//   - 会话中途的切换（model_change 前有 message 事件）→ 报；新会话开头的初始选型
//     （前无 message，即“启动选模型”）→ 不报，那是正常选型不是静默切换。
//   - 诱因 = 切换前最近 message 的 errorMessage（2026-08-16 实证形态：stdout 上 errorMessage="503
//     status code (no body)" 后 1ms 就是 model_change）；无前序报错则注明。
// live 模式首轮只记基线、不回放历史（同 watch-board「首轮只记位置」）；快照模式全量扫。
// 会话目录不存在 / 无 jsonl → 显式 PI_SESSIONS_MISSING / PI_SESSIONS_EMPTY note（没查成≠查过没事）。
function checkPiSessions(source, args, state) {
  const events = [];
  const notes = [];
  const st = state.piSessions ||= { files: new Map(), baselineDone: false };
  let dir = args.sessionsDir;
  if (!dir) {
    dir = args.snapshotDir
      ? source.sessionsDir // 快照默认 <快照轮目录>/sessions
      : join(homedir(), '.pi', 'agent', 'sessions');
  }
  if (!dir || !existsSync(dir)) {
    notes.push({ name: 'pi', type: '观察', detail: `PI_SESSIONS_MISSING: ${dir || '(未指定)'} 不存在——model_change 项没查成，不是扫完 0` });
    return { events, notes };
  }
  const jsonls = [];
  try {
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.jsonl')) jsonls.push(join(d, e.name));
      }
    })(dir);
  } catch (e) {
    notes.push({ name: 'pi', type: '观察', detail: `PI_SESSIONS_UNREADABLE: ${dir} 扫描失败（${e.message}）——model_change 项没查成` });
    return { events, notes };
  }
  if (jsonls.length === 0) {
    notes.push({ name: 'pi', type: '观察', detail: `PI_SESSIONS_EMPTY: ${dir} 下没有 jsonl——model_change 项没查成，不是扫完 0` });
    return { events, notes };
  }
  const firstRound = !args.snapshotDir && !st.baselineDone;
  st.baselineDone = true;
  for (const f of jsonls) {
    if (!st.files.has(f)) st.files.set(f, { linesSeen: 0, msgs: 0, lastErr: null, size: null, seenSwitch: new Set() });
    const rec = st.files.get(f);
    let lines = [];
    try {
      const size = statSync(f).size;
      if (!firstRound && rec.size != null && size <= rec.size) continue; // 没新增就不读，省每轮全量 IO
      rec.size = size;
      lines = readFileSync(f, 'utf8').split(/\r?\n/);
    } catch (e) {
      if (!firstRound) notes.push({ name: 'pi', type: '观察', detail: `PI_SESSION_UNREADABLE ${f}: ${e.message}——该文件本轮没查成` });
      continue;
    }
    // 上次可能读到半行（pi 边写边读）：重叠 1 行重扫，配合按事件 id 去重防重复报。
    const from = firstRound ? 0 : Math.max(0, Math.min(rec.linesSeen, lines.length) - 1);
    // 基线轮也要数 message/记 lastErr（后续增量轮才有上下文），只是不报。
    for (let i = from; i < lines.length; i++) {
      let ev;
      try { ev = JSON.parse(lines[i]); } catch { continue; }
      const t = ev && ev.type;
      if (t === 'message' && ev.message) {
        rec.msgs += 1;
        const em = ev.message.errorMessage;
        if (em) rec.lastErr = String(em);
        else if (ev.message.stopReason === 'error' && !rec.lastErr) rec.lastErr = '(stopReason=error，无 errorMessage)'; // 保底：错误轮但没带 errorMessage
      } else if (t === 'model_change') {
        if (firstRound) continue; // 基线轮不回放历史
        if (rec.seenSwitch.has(String(ev.id || i))) continue; // 半行重扫去的重，不重复报
        rec.seenSwitch.add(String(ev.id || i));
        if (rec.msgs > 0) {
          // 会话中途的切换（前有 message）→ 报；初始选型（msgs=0）不报
          const rel = relative(dir, f);
          const cause = rec.lastErr ? `，诱因：${rec.lastErr}` : '，无前序报错信息（手动切换或未留痕）';
          events.push({ name: 'pi', type: 'model-change', detail: `pi 静默换 provider：会话 ${rel} 内 model_change → provider=${ev.provider || '?'} modelId=${ev.modelId || '?'}${cause}` });
        }
      }
    }
    rec.linesSeen = lines.length;
  }
  return { events, notes };
}

function printRound(round) {
  if (round.noTargets) {
    console.log('NO_TARGETS: 本轮没有 working/waiting 工位（结构性排除后）——没查成，不是「扫完 0 异常」（数到 0 和没看到样本不是一回事）');
    return { alarm: false, noTargets: true };
  }
  for (const n of round.notes || []) console.log(`[${n.name}] ${n.type}: ${n.detail}`);
  if (round.events.length > 0) {
    for (const e of round.events) console.log(`[${e.name}] ${e.type}: ${e.detail}`);
    return { alarm: true, noTargets: false };
  }
  const names = round.targets.map(t => t.name).join('、');
  console.log(`OK 扫完 ${round.targets.length} 个工位（${names}），0 异常`);
  return { alarm: false, noTargets: false };
}

// ── 主流程 ──────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const state = { stations: new Map(), worktrees: new Map(), heartbeat: null };
let anyAlarm = false;
let anyNoTargets = false;

function executeOneRound(source) {
  const round = runRound(source, args, state);
  const r = printRound(round);
  if (r.alarm) anyAlarm = true;
  if (r.noTargets) anyNoTargets = true;

  const wt = runWorktreePass(source, args, state);
  const hb = checkHeartbeat(source, args, state);
  const ses = checkPiSessions(source, args, state);
  const extra = [...wt.events, ...hb.events, ...ses.events];
  if (extra.length > 0) {
    for (const e of extra) console.log(`[${e.name}] ${e.type}: ${e.detail}`);
    anyAlarm = true;
  }
  for (const n of [...wt.notes, ...hb.notes, ...ses.notes]) console.log(`[${n.name}] ${n.type}: ${n.detail}`);
}

function detectSelfWorktree() {
  const r = runOrca(['worktree', 'current', '--json']);
  const id = r.ok ? r.json?.result?.worktree?.id : null;
  return { id, error: r.ok ? (id ? null : 'orca worktree current 成功响应但缺 worktree.id') : `orca worktree current 失败：${errText(r.error)}` };
}

function liveLoop() {
  if (!args.selfWorktree) {
    const self = detectSelfWorktree();
    if (self.id) args.selfWorktree = self.id;
    else console.log(`[watchdog] SELF_WORKTREE_UNKNOWN: ${self.error}——本轮起不排除自己的工作区，请用 --self-worktree <id> 显式指定`);
  }
  console.log(`# watchdog live：每 ${args.interval}s 一轮（--window ${args.window} / --state-window ${args.stateWindow}${args.selfWorktree ? ' / self-worktree ' + args.selfWorktree.slice(0, 24) + '…' : ''}${args.disposeActions ? '' : ' / dispose-actions off'}）`);
  for (;;) {
    const source = makeLiveSource(args.window);
    if (source.infraError) {
      console.log(`[watchdog] PS_FETCH_FAILED: ${source.infraError}——本轮没查成`);
      if (args.once) process.exit(3);
    } else {
      executeOneRound(source);
      if (args.once) break;
    }
    sleep(args.interval * 1000);
  }
}

if (args.snapshotDir) {
  const rounds = loadSnapshotRounds(args.snapshotDir);
  const toRun = args.once ? rounds.slice(0, 1) : rounds;
  const multi = toRun.length > 1;
  toRun.forEach((source, i) => {
    if (multi) console.log(`# snapshot round ${i + 1}/${toRun.length}（${source.label}）`);
    executeOneRound(source);
  });
} else {
  liveLoop();
}

process.exit(anyAlarm ? 1 : anyNoTargets ? 2 : 0);
