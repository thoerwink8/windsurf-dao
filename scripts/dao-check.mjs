#!/usr/bin/env node

// dao check —— 仓库现在是不是好的，唯一的答案。
//
// 改这个文件前必须知道的四条规矩（来历与推理见 docs/decisions/2026-08-12-blueprint-from-zero.md 件 5）：
//   1. 退出码只有 0 和 1。加第三个态，它就变回了它替换掉的那个东西。
//   2. 每个检查都是扫描出来的，不许出现手写的清单——清单会过期，过期的清单等于没查。
//      每个检查都必须自带「零样本报红」：扫出 0 条就报红。「数到 0」和「没看到样本」输出一样，
//      不分开就等于把「这次没查成」记成了「查过没事」。
//   3. 报失败只有三个槽位：什么坏了 / 怎么修 / 机器自己给的一行证据。第四行物理上写不进去。
//      这是结构约束不是风格。
//   4. 没有任何东西检查 dao check 自己。它坏了会在使用中被看见——它的输出每次都有人读。
//      想在它之上再加一层检查之前，先读上面那份蓝图第六章第 4 条。
//
// 准入判据（想加一个检查时用它自问）：这个检查防住的失败，是不可逆的，或者是静默的吗？
// 两个都不是 ⇒ 不加，让它在使用中被发现。
//
// 2026-08-14 拆旧（issue #425）：hook 注册 / 命令表 / skill 部署三个检查连同一套旧体系退役，
// 检查项随之删除；之后按对抗审意见恢复了「跑 tests/ 下测试」的检查（脱敏回归网回来）。
// 2026-08-16 拆旧（issue #529）：memory 整体搬到独立仓 thoerwink8/windsurf-dao-memory（#518），
// ⑥ 主仓 memory 索引双向齐随检查对象删除（索引齐的价值转到新仓自己的 gen-index.mjs --check）；
// ⑨ 判据从「Junction 指向仓内 memory 真相源」改为「符号链接目标仓的 origin ==
// thoerwink8/windsurf-dao-memory」（#807：Linux 服务器形态，不再认 Windows Junction）。
// 编号不复位：⑥ 的坑位消失，⑦~⑫ 保持原号，⑨ 的引用在 NEW-MACHINE / tests / skills 里按 ⑨ 记账。
// 当前检查：①跑 tests/ 下所有测试（不采覆盖率、不裁剪——影响地图整层已删）
// ②skill 装载 ③密钥不进 git 追踪面 ④常驻文件 token 预算
// ⑤模型路由（TOML providers.launch + JSON 政策 + yml 同源 + nextLaunch 夹具）
// ⑦⑩ 已随 orca 产品面一起删（命令库 --help / extract* 真语料都是 orca CLI 的检查对象）。
// ⑧态注入 hook 装载面点得到且真跑得动（issue #488）；#807：本机未接 Claude Code
//   （无 ~/.claude/skills 且无 settings 面）SKIP 不是绿，有装载面仍必须真跑。
// ⑨本机 memory 是否指向 windsurf-dao-memory 仓的符号链接（local-only，#503/#529/#807）：
//   链接目标必须是 git 仓且 origin remote 指向 thoerwink8/windsurf-dao-memory（从 URL 抽
//   owner/repo 再比，SSH/HTTPS 两种形式都认）；普通目录/悬空/目标不是 memory 仓/无 origin/
//   origin 不对均红；本机无该项目 memory 目录（CI/新机/未接 worktree）出 SKIP 不是绿。
// ⑩ extract* 解析外部 JSON 必须有真语料存档（#499）
// ⑪ 主帅标题核对样本（一致 / 过期 各至少一份）
// ⑫ 派工卡 comment 必须有单号定界区（#495：有区 / 缺区 各至少一份）
// ⑬ 派工闸 PreToolUse 活着且 fail-closed（#546 #517 #553）：挂载面=随仓 .claude/settings.json（#553 从 plugin 换挂法），
// 装载（有 dispatch-gate 条目）→ 指向（脚本真存在）→ 行为（旁路 exit 2、逃生口放行、崩了也 exit 2）三层全验
// ⑭ open issue 数量阈值（#556）：知识网堆回工作队列要报红；gh 不可用 SKIP 不是绿；
//    #966 推迟档不进分母——夹具红/绿验判别力（快档也跑，live 仍只 --full）
// ⑮ 可立即起但没起（#577）：已消歧且无在途 PR/卡且没挂「将来某版」 → 打可见行，不报红；没查成 ≠ 0
// ⑯ 完工信号契约（#575 ⑥）：flow 读的「首行完工」与 worker-brief / dispatch skill 教的必须是同一句
//   （检查器自己持有标记文本，不 import flow/judgment 的正则）
// ⑰ 账本断流差集（#581）：GitHub 已合并带标 PR ∖ job.closed.pr_number；禁 Date.now；
//    两个反例都要过（有差集必红、无差集必绿）；基准 PR 号之后才对照
// ⑱ strikes 机械闸（#588）：基准后 memory 条目 strikes≥2 且 gate 空 → 红；
//    存量按文件名豁免；本机 memory 未接 → SKIP 不是绿；红/绿夹具都要有判别力
// ⑲ 帅操作 issue 走 marshal（#627）：dispatch skill 约定还在；host/skills 不再教裸
//    `gh issue` 写动作；0 个 skill = 没查成，不是绿
// ⑳ 仓外路径闸（#642 / #807）：独立扫描 ~/ $HOME os.homedir()（Windows 环境变量只当别名归一，
//    不再要求 conhost / EncodedCommand）；不读 INDEX 自己的解析器；发现集合必须等于 INDEX∪ignore；
//    扫到 0 条 = 没查成；夹具红/绿/空都要有判别力
// ㉑ 关单不改走 GitHub 自动关键词（#657）：扫 dispatch 任务书模板，再出现 Closes #/Fixes # 就红；
//    红/绿样本各一验判别力；live 扫 host/skills/dispatch/templates/*.md，0 个模板 = 没查成
// ㉒ 删横幅收信整层（#667）：dao.mjs 不许裸 run-use 无 --from；dispatch SKILL 不许教横幅收信；
//    soldier-book 必须写「心跳不准发」；样本红/绿各一验判别力
// ㉓ 盲考收卷纪律（#675）：design-exam 收卷节必须还在；起考轮盯产物收到完；指针失效要报警
//    红/绿/空样本各一验判别力；0 个样本 = 没查成
// ㉔ 起审官同厂硬闸（#679）：接线扫描不 import 闸自己的解析；故意 grok+grok 样本必须当场拦；
//    红/绿/空样本各一验判别力；0 个样本 = 没查成
// ㉕ 删掉审官结算后再造卡/换厂（#735）：检查器不 import flow/dao-cmd 解析；故意违规夹具必须红；
// ㉖ 孤儿测试闸（2026-08-22 Q5 拍板）：test 引用的仓内目标不存在 = 机制删了测试没同删；
//    退役靠判断不靠 CI 自动删，CI 只拦孤儿；红/绿/空样本各一验判别力；0 个测试 = 没查成
//    红/绿/空样本各一验判别力；0 个样本 = 没查成
// ㉗ 版本号载体闸（#787，#800 加溯源）：载体存在时变化必须合法、不倒退；不判该不该 bump。
//    检查器自持 semver，不 import bump.mjs；红/绿/空（无载体=SKIP 不是绿）各一验判别力；
//    无载体 live SKIP；git 探头失败 = 没查成。
//    溯源（#800 发布列车）：合并只进列车，版本号只由发布动作产生——载体的任何变化只允许
//    出现在 release: 前缀提交 / 打了 tag 的提交上；非发布提交动了版本号 = 红（新口径的「乱 bump」）。
//    夹具 nonrelease-red/release-ok/unchanged-skip 各一；本仓无载体，live 溯源随 ㉗ SKIP。
// ㉘ 飞书群有效性（#813）：仓内 host/machine/feishu-groups.json 是占位模板（缺=没查成）；
//    live 优先读 ~/.mirasim/keys/feishu-groups.json，用 lark-cli im chats get --as bot
//    逐个确认还在；查不到/已解散报红并写出群名；全都在为绿；无实机映射 / 无 lark-cli /
//    无凭据（CI）SKIP 不是绿；0 个 chat_id = 没查成。
//    检查器自持解析，不 import feishu-triage.loadGroups；红/绿/空夹具验判别力
// ㉙ 发布策略 schema（#817）：docs/release-policy.json 可解析且过 schema（四个顶层键 /
//    confirm 三级 / bump 表 / 每项目 demo）。检查器自持解析，不 import 消费方；
//    红/绿/空夹具验判别力；文件不在 / JSON 坏了 / 四个顶层键都没有 = 没查成。
// ㉚ skill 发现面符号链接（#793 / #1146）：扫 host/skills/*/ 每个目录，断言本机 ~/.claude/skills/<名>
//    存在且是指向仓内 host/skills/<名> 的符号链接；缺链/指错报红。整目录链接（mirasim 劫走）
//    报「被劫」，本机无 ~/.claude/skills 报 SKIP「没装」——两种红/跳必须分形，常红等于没有检查。
//    接回走 onboard / dao-skills-heal.timer，本项只报警。0 个 skill = 没查成
// ㉛ 派前探 + 熔断 + 指挥官策略（#842 / #843 / #849）：docs/dispatch-policy.json 的 preflight 取值范围
//    （enabled/useHealthTable 布尔、timeoutMs 500~60000、maxCandidates 整数 1~12）、breaker
//    （windowHours 1–168、failuresToTrip 1–20、cooldownHours 0.25–168、halfOpenProbes 1–5）、
//    commander（requireModelInRouting 布尔；loadThreshold / memReserveMb 是余量参数不是「派几个」；缺 commander 不拦以兼容旧夹具）。
//    检查器自持解析，不 import preflight.mjs；红/绿/空夹具验判别力；
//    文件不在 / JSON 坏 / 缺 preflight 或 hubChat 节 = 没查成（hubChat 取值见 #852）。缺 breaker / 越界 = 红。
// ㉜ 常驻 systemd 必须 Restart=always（#1037）：仓内 host/machine/systemd/*.service
//    凡不是 Type=oneshot 的必须 Restart=always。只看仓里的模板，不打机器。
//    RestartPreventExitStatus= 允许存在且不影响判定。检查器自持解析，不复用被检查对象。
//    红/绿/空夹具验判别力；0 个 .service = 没查成，不是「0 个违规」。
// ㉝ 帅位不得自合 reviews=0 的 PR（#1093）：author 与 mergedBy 同为 marshal 且 reviews=0 ⇒ 红。
//    检查器自持 marshal 登录名，不 import gh.mjs；红/绿/空夹具验判别力；0 个 PR = 没查成。
//    live 出网，只在 --full 跑；基准 PR 之后才对照（存量自合并是另一单）。
// ㉞ 合并闸形状（#999）：在管公开活仓该有 master 保护，形状必须是
//    required=["check"]、enforce_admins=false、strict=false。扫描面从 INDEX E 类 /
//    群映射 / 发布策略并出，不手写仓名单。live 只验本仓（别的公开仓如 miraquota-win
//    刻意没装闸，扫进去会永远红）。live 打 GET branches/master（CI contents:read 够）；
//    完整 /protection 要 Administration，CI/App 403 → SKIP 仍绿 = 闸不存在。
//    缺 gh / 连摘要都 403 SKIP 不是绿；空清单 / 探头失败 = 没查成。
//    strict 不在摘要里，live 盖不住「有人把 strict 拨成 true」——装闸脚本走完整 /protection。
//    不造分发器：配置动作用 scripts/apply-branch-protection.mjs，一次一个仓。
// ㉟ 在管仓 .git 属主一致性（#1149）：windsurf-dao / ai-gateway-stack 的 `.git` 里出现
//    root 属主文件即红，红项点名文件并给出 `chown -R orca:orca <repo>/.git`。
//    扫完 0 条和仓路径不在必须分开（后者没查成，不是绿）。find 任意非零 / stderr
//    （含 Permission denied）也是没查成，不许把部分扫描当干净。工作区属主闸故意
//    `-not -path './.git/*'`，本项另开一道不改那条。Windows 无 uid 跳过。
// ㉠ 测试结构性够不着真执行体（#1152）：spawn dao dispatch 必须带 --dry-run；
//    故意「执行体 env 丢失」样本必须红；ensureWorkspace/startSession/cmdDispatchMirasim
//    都要在真 IO 前过隔离闸。检查器自持括号匹配，不 import 被测测试 / runtime 解析。
//    红/绿/空夹具验判别力；0 个测试文件 = 没查成。

import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cpus, homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { checkModeHook } from './lib/dao-mode-hook-check.mjs';
import { checkMemoryLink } from './lib/dao-memory-link-check.mjs';
import { checkSkillLinks } from './lib/skill-link-check.mjs';
import { checkDispatchGate } from './lib/dispatch-gate-check.mjs';
import { inspectCauseSlugs } from './lib/cause-slug-check.mjs';
import { inspectReadyQueue } from './lib/ready-queue-check.mjs';
import { inspectOpenIssueCount, inspectOpenIssueCountFixtures } from './lib/open-issue-count-check.mjs';
import { checkCompletionSignal } from './lib/completion-signal-check.mjs';
import { checkMarshalIssueIdentity } from './lib/marshal-issue-identity-check.mjs';
import { checkIssueGatewayAlive } from './lib/issue-gateway-check.mjs';
import { checkMachinePaths } from './lib/machine-path-check.mjs';
import { validateLegs, crossCheckLegsTree, nPlusOneReport, inspectLegsFixtures } from './lib/legs.mjs';
import {
  judgeHarvest, inspectHarvestFixtures,
  harvestLiveArgs, judgeHarvestCoverage, HARVEST_LIVE_LIMIT,
} from './lib/harvest-check.mjs';
import {
  inspectDesignExamHarvestLive, inspectDesignExamHarvestFixtures,
} from './lib/design-exam-harvest-check.mjs';
import {
  inspectVendorGateWiring, inspectVendorGateFixtures,
  inspectReviewerNoForceCommand,
} from './lib/reviewer-vendor-gate-check.mjs';
import {
  inspectNoReviewerRecreate, inspectNoReviewerRecreateFixtures,
} from './lib/no-reviewer-recreate-check.mjs';
import { inspectModelLabelNames } from './lib/model-label-name-check.mjs';
import {
  inspectOrphanTests, inspectOrphanTestFixtures,
} from './lib/orphan-test-check.mjs';
import {
  inspectVersionCarrierFixtures, inspectLiveAt, inspectCarrierProvenanceFixtures,
} from './lib/version-carrier-check.mjs';
import {
  inspectFeishuGroupsFixtures, checkFeishuGroups,
} from './lib/feishu-groups-check.mjs';
import {
  inspectReleasePolicyFixtures, inspectReleasePolicyLive,
} from './lib/release-policy-check.mjs';
import {
  inspectDispatchPolicyFixtures, inspectDispatchPolicyLive,
} from './lib/dispatch-policy-check.mjs';
import {
  inspectUnitRestartDir, inspectUnitRestartFixtures,
} from './lib/unit-restart-check.mjs';
import { classifyFailedUnits, repoScriptOf, hasEverRun } from './lib/failed-units-check.mjs';
import {
  inspectBranchProtectionFixtures, inspectThisRepoProtection,
  collectManagedReposFromRoot, repoSlugFromRemote,
} from './lib/branch-protection-check.mjs';
import {
  classifyGitOwnership, scanGitRepo, inspectGitOwnershipFixtures, interpretFindRootOwned, DEFAULT_MANAGED_REPOS,
} from './lib/git-ownership-check.mjs';
import {
  inspectLedgerGap, readClosedPrNumbers, LEDGER_GAP_BASELINE_PR, LEDGER_GAP_NEWEST_BUFFER,
} from './lib/ledger-gap-check.mjs';
import { ensureLocalLedger } from './lib/ledger-home.mjs';
import { classifyChainDepth } from './lib/chain-depth-check.mjs';
import {
  inspectStrikes, listMemoryEntries, loadStrikesBaseline, resolveMemoryDir,
} from './lib/memory-strikes-check.mjs';
import { judgeCompetingPrs, collectOpenPrNewFiles } from './lib/competing-prs.mjs';
import {
  inspectMarshalSelfMerge, inspectMarshalSelfMergeFixtures,
  MARSHAL_SELFMERGE_BASELINE_PR,
} from './lib/marshal-selfmerge-check.mjs';
import { parseInboxDoc, assessInbox } from './lib/inbox.mjs';
import { defaultHome } from './lib/dao-memory-link-check.mjs';
import { scanMirasimTrees } from './lib/mirasim-trees.mjs';
import { classifySpawnBudget, countSpawnCalls } from './lib/spawn-budget.mjs';
import { classifyAssertStyle } from './lib/assert-style.mjs';
import {
  inspectTestExecutorIsolationFixtures, inspectTestExecutorIsolationLive,
  inspectIsolationWiring,
} from './lib/test-executor-isolation-check.mjs';

const require = createRequire(import.meta.url);
// 标准 TOML 解析器（smol-toml，BSD-3，TOML 1.0 兼容，vendored 进 scripts/lib/smol-toml.cjs）。
// 不自己写正则拼凑：自己解析自己的格式等于自己查自己，查不出格式错。
const { parse: parseToml } = require('./lib/smol-toml.cjs');

const ROOT = resolve(import.meta.dirname, '..');
const t0 = Date.now();

const failures = [];
const greens = [];
const skips = [];
const notes = [];

/** 报失败只有三个槽位：什么坏了 / 怎么修 / 机器自己给的一行证据。 */
function fail(what, howToFix, evidence) {
  failures.push([what, howToFix, evidence].filter(Boolean).slice(0, 3));
}
function green(line) { greens.push(line); }
function skip(line) { skips.push(line); }

/** 取测试失败行：只认 TAP 的 not ok 行（node --test 的输出形态），不按关键词匹配——
 * 测试名里带 fail/错误/红 字样的 ok 行不许冒充失败证据（#566 排查实证）。
 * 一套红多条就全列，不许只报第一条（只报头一条会让人以为修完就绿了，然后再红一轮）。
 * 退出非 0 却没标准 not ok 行 = 崩了/格式变了：返回 null，证据说「没查成」，不许拿别的行冒充。 */
function extractFailLines(output) {
  const lines = String(output || '').split(/\r?\n/);
  const fails = lines.filter(l => /^\s*not ok /.test(l));
  if (fails.length) return fails.map(l => l.trim().replace(/^not ok \d+ - /, '').slice(0, 200));
  return null;
}

function failLinesEvidence(output) {
  const fails = extractFailLines(output);
  if (fails) return `测试输出 ${fails.length} 条红：\n${fails.join('\n')}`;
  return '退出非 0 但没扫到标准 not ok 行——测试崩了或输出格式变了，本次没查成，需人工复现';
}

/** 从 node --test 的 TAP 汇总抽计数（#608：自造 check() runner 退役，改 node:test）。
 * 每个检查必须自带「零样本报红」：tests=0 就报红。「数到 0」和「没看到样本」输出一样，
 * 不分开就等于把「这次没查成」记成了「查过没事」。 */
function parseTapSummary(output) {
  const g = (re) => { const m = String(output || '').match(re); return m ? Number(m[1]) : null; };
  return {
    tests: g(/# tests (\d+)/),
    pass: g(/# pass (\d+)/),
    fail: g(/# fail (\d+)/),
    skipped: g(/# skipped (\d+)/),
  };
}

// ── ① 跑 tests/ 下所有测试 ─────────────────────────────────────────
// 测试是静默失效型部件：坏了没人知道。所以自检必须每套都跑。
// 自发现：tests/ 下的每一套都跑，没有清单可以漏登记。
// #608：26 套从自造 check() runner 迁到 node --test（node:test + node:assert），
// 文件名 *.test.js 即 node --test 默认发现规则；此处按同一规则扫文件、逐套用
// node --test 跑（目录参数在本机 Node 上不可靠，逐文件等价且保持逐套粒度）。
// #807：不再跑 .ps1 / powershell。

// 2026-08-22 并行化（Q5 拍板：速度是真优化点）：串行 46+ 套约 40s，进程池后约 10s 级。
// 池宽 6：再大收益递减且增加临时目录/端口互相踩踏的概率。输出仍按文件名序打印，与串行时代一致。
const TEST_POOL = Math.min(6, Math.max(2, (cpus() || []).length || 2));

function runOneSuite(dir, f) {
  return new Promise((resolveOne) => {
    const p = join(dir, f);
    const cmd = process.execPath;
    const args = ['--test', '--test-reporter=tap', p];
    let out = '';
    let child;
    try {
      // 测试期禁止出网（2026-09-06）：--import 预加载拦截器，NODE_OPTIONS 会继承给
      // 测试 spawn 出去的子进程——要害正在这里，偷偷出网的往往是被调起的 CLI 而不是测试本身。
      // 判据与来历见 tests/helpers/no-network.mjs 头部。
      const guard = join(ROOT, 'tests', 'helpers', 'no-network.mjs');
      const compileCache = process.env.NODE_COMPILE_CACHE || join(tmpdir(), 'dao-node-compile-cache');
      const env = {
        ...process.env,
        NODE_COMPILE_CACHE: compileCache,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${pathToFileURL(guard).href}`.trim(),
      };
      child = spawn(cmd, args, { windowsHide: true, cwd: ROOT, env });
    } catch (e) {
      resolveOne({ f, status: 1, out: String(e && e.message ? e.message : e) });
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t0 = Date.now();
    const finish = (extra) => resolveOne({ f, ...extra });
    child.on('error', (e) => finish({ status: 1, ms: Date.now() - t0, out: out + String(e && e.message ? e.message : e) }));
    child.on('close', (code) => finish({ status: code == null ? 1 : code, ms: Date.now() - t0, out }));
  });
}

// 变更集口径（断言写法闸用）：origin/<默认分支>..HEAD ∪ 工作区未提交（含未跟踪）。
function changedFilesForAffected() {
  const out = new Set();
  // 「新增」要单独记：采样那一刻不存在的文件，地图里不可能有它的依赖信息。
  // 按目录扫的测试（timer-armed 扫 host/machine/systemd/*.timer）认得新文件，地图不认 ⇒ 会漏跑。
  const added = new Set();
  const run1 = (args) => {
    const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? (r.stdout || '') : null;
  };
  const base = (() => {
    const head = run1(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const b = head ? head.trim() : null;
    if (b) return b;
    for (const cand of ['origin/master', 'origin/main']) {
      if (run1(['rev-parse', '--verify', '--quiet', cand]) != null) return cand;
    }
    return null;
  })();
  let scanned = false;
  if (base) {
    const committed = run1(['diff', '--name-only', `${base}...HEAD`]);
    if (committed != null) { scanned = true; for (const l of committed.split('\n')) if (l.trim()) out.add(l.trim()); }
    // 已提交那半里哪些是新增：--diff-filter=A
    const addedCommitted = run1(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`]);
    if (addedCommitted != null) for (const l of addedCommitted.split('\n')) if (l.trim()) added.add(l.trim());
  }
  const dirty = run1(['status', '--porcelain', '-uall']);
  if (dirty != null) {
    scanned = true;
    for (const l of dirty.split('\n')) {
      const p = l.slice(3).trim();
      if (!p) continue;
      const xy = l.slice(0, 2);
      // 重命名形态 `old -> new`：两边都算改动
      for (const seg of p.split(' -> ')) if (seg.trim()) out.add(seg.trim().replace(/^"|"$/g, ''));
      // `??` 未跟踪、`A ` 已暂存的新增：都是「采样时不存在」
      if (xy === '??' || xy[0] === 'A') {
        const last = p.split(' -> ').pop().trim().replace(/^"|"$/g, '');
        if (last) added.add(last);
      }
    }
  }
  return { scanned, files: [...out], added: [...added] };
}

async function runTests() {
  const dir = join(ROOT, 'tests');
  if (!existsSync(dir)) {
    fail('tests/ 目录不在', '恢复 tests/，或改 dao-check.mjs 的约定', dir);
    return;
  }
  // 禁网闸的账落仓外（检查器的输出不许落进自己会读的范围，否则报告变成下一轮输入）
  if (!process.env.DAO_NO_NETWORK_LOG) {
    const d = join(homedir(), '.dao', 'no-network');
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    process.env.DAO_NO_NETWORK_LOG = join(d, `${Date.now()}-${process.pid}.ndjson`);
  }
  const suites = readdirSync(dir).filter(f => /\.test\.(js|mjs|cjs)$/i.test(f)).sort();
  if (suites.length === 0) {
    fail('一套测试都没扫到', 'tests/ 空了 ⇒ 本次等于没查；补回测试', dir);
    return;
  }
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < suites.length) {
      const f = suites[cursor++];
      results.push(await runOneSuite(dir, f));
    }
  }
  await Promise.all(Array.from({ length: Math.min(TEST_POOL, suites.length) }, worker));
  results.sort((a, b) => (a.f < b.f ? -1 : 1));
  for (const { f, status, out } of results) {
    const tap = parseTapSummary(out);
    if (status === 0) {
      // 零样本报红：node --test 跑了但一条测试都没扫到 = 本次没查成，不是绿。
      if (tap.tests === 0 || tap.tests == null) {
        fail(`测试没查成：${f}`, 'node --test 跑了但 0 条测试（发现规则/文件形态变了）', out.slice(0, 200));
      } else {
        green(`测试 ${f}（${tap.pass ?? '?'} 过 / ${tap.fail ?? 0} 红 / ${tap.skipped ?? 0} 跳过 / ${tap.tests} 条）`);
      }
    } else {
      fail(`测试红：${f}`, `复现：node --test tests/${f}`, failLinesEvidence(out));
    }
  }
  reportTestDurations(results.map(({ f, ms }) => ({ file: f, ms })));
  reportNetworkViolations();
  checkSpawnBudget();
  checkAssertStyle();
}

/** 断言写法闸：新增的测试行里不许有复合 assert.ok（判据与来历见 lib/assert-style.mjs）。 */
function checkAssertStyle() {
  const { scanned, files } = changedFilesForAffected();
  if (!scanned) { skip('断言写法：算不出本次改了哪些行（git 读不到）——没查成'); return; }
  const testFiles = files.filter(f => /\.test\.(js|mjs|cjs)$/.test(f));
  if (testFiles.length === 0) { green('断言写法：本次没改测试文件'); return; }

  // 只取**新增**行：存量 1471 处复合断言不进判定面
  const base = spawnSync('git', ['-C', ROOT, 'merge-base', 'HEAD', 'origin/master'], { encoding: 'utf8', windowsHide: true });
  const ref = base.status === 0 ? (base.stdout || '').trim() : null;
  // `-M`（跟踪重命名/搬运）是硬要求，不是优化：拆文件时 git 默认把新文件的每一行
  // 都算「新增」，存量断言会整批被判成新写的（2026-09-06 实咬：拆 dao.test.js 那次
  // 一口气报 416 处，而那全是逐字搬过去的旧行）。带上 -M 后搬运不计入新增。
  const diffs = [];
  for (const f of testFiles) {
    const args = ['-C', ROOT, 'diff', '-U0', '-M', ...(ref ? [ref] : []), '--', f];
    const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) { skip(`断言写法：${f} 的 diff 没取到——没查成`); return; }
    const added = (r.stdout || '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
    diffs.push({ file: f, added });
  }
  // 基线 = 改动前**全部**测试文件的行。用来分辨「搬来的旧行」与「这次新写的」。
  // 取不到就退化成不给基线（宁可多报，不许漏报）。
  let baseline = null;
  if (ref) {
    const ls = spawnSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', ref, 'tests/'], { encoding: 'utf8', windowsHide: true });
    if (ls.status === 0) {
      baseline = [];
      for (const p of (ls.stdout || '').split('\n').filter(x => /\.test\.(js|mjs|cjs)$/.test(x))) {
        const show = spawnSync('git', ['-C', ROOT, 'show', `${ref}:${p}`], { encoding: 'utf8', windowsHide: true });
        if (show.status === 0) baseline.push(...(show.stdout || '').split('\n'));
      }
    }
  }
  const v = classifyAssertStyle(diffs, baseline);
  if (v.state === 'ok') green(`断言写法：${v.detail}`);
  else if (v.state === 'red') fail('新增了复合断言', '拆成最简条件，或改用 equal/deepEqual 让失败信息自带 diff（见 lib/assert-style.mjs）', v.detail);
  else skip(`断言写法：${v.detail}`);
}

/**
 * 测试耗时：**只报趋势，不当闸**（2026-09-06 用户拍板删掉墙钟硬闸）。
 *
 * 试过硬闸，做不到它要做的事：这台 6 核机 load average 5+，同一套两次跑差一倍
 * （agent-stall-watch 3.7s / 7.7s）。为了不误报把阈值放到 3 倍，而 3 倍的闸
 * **抓不到真正会发生的事**——新检查从 3s 慢慢爬到 8s 它一声不吭，只能抓「一次性慢 3 倍」
 * 那种本来就显眼的情况。给人「有闸在管」的错觉，实际管不住，比没有更糟。
 *
 * 行业对性能也是这个路子：趋势跟踪，硬闸留给确定性的量——我们的确定性量是 spawn 预算。
 */
function reportTestDurations(durations) {
  const measured = durations.filter(d => Number.isFinite(Number(d.ms)));
  if (measured.length === 0) return;   // 裁剪后 0 套是常态，不报
  const total = measured.reduce((s, d) => s + d.ms, 0);
  const top = [...measured].sort((a, b) => b.ms - a.ms).slice(0, 3)
    .map(d => `${d.file} ${(d.ms / 1000).toFixed(1)}s`).join('、');
  green(`测试耗时：${measured.length} 套合计 ${(total / 1000).toFixed(1)}s（墙钟，受机器负载影响；最慢：${top}）`);
}

/** 测试里起子进程的总量闸——「TIA 第二刀没做完」的报警器（scripts/lib/spawn-budget.mjs）。 */
function checkSpawnBudget() {
  const dir = join(ROOT, 'tests');
  let counts;
  try {
    counts = readdirSync(dir).filter(f => /\.test\.(js|mjs|cjs)$/i.test(f))
      .map(f => ({ file: f, count: countSpawnCalls(readFileSync(join(dir, f), 'utf8')) }));
  } catch (e) {
    fail('spawn 预算没查成', '读不到 tests/ 目录', String(e.message || e));
    return;
  }
  const r = classifySpawnBudget(counts);
  if (r.state === 'ok') green(`spawn 预算：${r.detail}`);
  else if (r.state === 'red') fail('测试起子进程超预算', '把 spawn 改成进程内调用（TIA 第二刀），或显式降/调预算并说明', r.detail);
  else fail('spawn 预算没查成', '扫描面坏了——不是「没有 spawn」', r.detail);
}

/** 读禁网闸的账：测试期有没有谁试图连外网。拦下不等于报警——调用方常把网络错吞了。 */
function reportNetworkViolations() {
  const log = process.env.DAO_NO_NETWORK_LOG;
  if (!log) { fail('禁网闸没接上', '本次等于没查：runOneSuite 应设 DAO_NO_NETWORK_LOG 并挂 --import', ''); return; }
  let lines = [];
  if (existsSync(log)) {
    try {
      lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    } catch (e) {
      fail('禁网闸的账读不了', '没查成，不是「没有违规」', String(e.message || e));
      return;
    }
  }
  if (lines.length === 0) { green('禁网闸：测试期 0 次外网连接尝试'); return; }
  const byHost = new Map();
  for (const v of lines) {
    const k = `${v.host}:${v.port}`;
    byHost.set(k, (byHost.get(k) || 0) + 1);
  }
  const who = [...byHost.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join('、');
  fail(
    `测试期有 ${lines.length} 次外网连接尝试`,
    '单元测试不许打真实网络（慢+飘+不可复现）。注入假实现，或让被调的 CLI 默认不出网',
    who + `｜首条 argv：${lines[0].argv || '未记'}`,
  );
}

// ── ② skill 装载面 ──────────────────────────────────────────────────
// frontmatter 坏掉的 skill 不会报错，它只是不加载——静默失效。
// 自发现：扫 host/skills 下所有目录，没有清单可以漏登记。

function checkSkillFrontmatter() {
  const dir = join(ROOT, 'host', 'skills');
  if (!existsSync(dir)) {
    fail('host/skills 不在', '本次没查成：确认部署源目录是否被移动', dir);
    return;
  }
  const dirs = readdirSync(dir).filter(d => statSync(join(dir, d)).isDirectory());
  if (dirs.length === 0) {
    fail('一个 skill 都没扫到', 'host/skills 空了 ⇒ 本次等于没查', dir);
    return;
  }
  const bad = [];
  for (const d of dirs) {
    const f = join(dir, d, 'SKILL.md');
    if (!existsSync(f)) { bad.push(`${d}(缺 SKILL.md)`); continue; }
    const m = readFileSync(f, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) { bad.push(`${d}(无 frontmatter)`); continue; }
    const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
    if (!name) bad.push(`${d}(无 name)`);
    else if (name !== d) bad.push(`${d}(name=${name})`);
  }
  if (bad.length === 0) green(`skill 装载面 ${dirs.length} 个 frontmatter 可解析`);
  else fail(`装载不了的 skill ${bad.length} 个`, 'SKILL.md 要有 frontmatter，且 name 必须等于目录名', bad.join(' '));
}

// ── ③ 密钥不在 git 追踪面 ───────────────────────────────────────────
// 全系统唯一真正不可逆的伤害：密钥一旦进 git，删不掉、改不回、只能换密钥。
// 自发现：扫 git 追踪面里所有「密钥形态」的文件名，不维护任何白名单。

const SECRET_SHAPED = /(?:^|[/.-])(?:secret|secrets|credential|credentials|token|password|apikey|api-key)[^/]*\.(?:json|ya?ml|txt|ini|conf|cfg|env)$|\.(?:pem|key|pfx|p12|jks|keystore)$|(?:^|\/)\.env(?:\.|$)/i;

function checkSecretsNotTracked() {
  const r = spawnSync('git', ['ls-files'], { windowsHide: true, encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) {
    fail('git 追踪面读不出来', '本次没查成，不是没问题：在 git 仓库里跑 dao check', String(r.stderr || '').trim().slice(0, 160));
    return;
  }
  const tracked = r.stdout.split(/\r?\n/).filter(Boolean);
  if (tracked.length === 0) {
    fail('追踪面扫出 0 个文件', '本次等于没查：确认 cwd 是仓库根', ROOT);
    return;
  }
  const hits = tracked.filter(f => SECRET_SHAPED.test(f));
  if (hits.length === 0) green(`密钥防线 追踪面 ${tracked.length} 个文件无密钥形态`);
  else fail(`疑似密钥进了 git ${hits.length} 个`, '立刻 git rm --cached + 补 .gitignore + 当作已泄漏换掉它', hits.join(' '));
}

// ── ④ 常驻文件 token 预算 ───────────────────────────────────────────
// 膨胀是不可感知型失效：每次只加几行，永远不会有人报警，等看见时已经是几百次提交之后。
// 所以预算类规则不等「第二次违例再升级」，立规即配闸。
// 期望集合从宿主约定推导（不是手写清单）：文件名是 CLAUDE.md / *-CLAUDE.md 的就是常驻注入面
// （CLAUDE.md 这个名字是宿主的注入机制本身），这类文件必须声明预算，缺声明即红——
// 否则删掉一行声明就能让单个文件静默逃出保护（对抗审 PR #437 抓出的绕过路径）。
// 其他 markdown 自愿声明的同样强制。
// 口径：token 按 字符数/2 估算——这是近似字符预算不是真 tokenizer 值，对以中文为主的
// 文本会低估 token（偏宽松），对英文偏严格；预算值应据此保守设定。

const BUDGET_MARK = /总量控制在\s*(\d+)\s*token/;
const RESIDENT_NAME = /(^|-)CLAUDE\.md$/;

function checkResidentBudget() {
  const found = [];
  const missing = [];
  for (const dir of [ROOT, join(ROOT, 'docs')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(x => x.endsWith('.md'))) {
      const p = join(dir, f);
      if (!statSync(p).isFile()) continue;
      const rel = dir === ROOT ? f : `docs/${f}`;
      const txt = readFileSync(p, 'utf8');
      const m = txt.match(BUDGET_MARK);
      if (m) found.push({ rel, budget: Number(m[1]), tokens: Math.round(txt.length / 2) });
      else if (RESIDENT_NAME.test(f)) missing.push(rel);
    }
  }
  if (missing.length > 0) {
    fail(`常驻注入面缺预算声明 ${missing.length} 个`, '每个 CLAUDE.md 形态的文件末尾都要有「总量控制在 N token」声明，删声明=逃出保护', missing.join(' '));
    return;
  }
  if (found.length === 0) {
    fail('一个声明了 token 预算的常驻文件都没扫到', '常驻约定文件末尾要有「总量控制在 N token」声明；0 个声明 = 本次等于没查', `${ROOT} 与 docs/`);
    return;
  }
  const over = found.filter(c => c.tokens > c.budget);
  if (over.length === 0) green(`常驻预算(字符/2 估算,中文偏宽) ${found.map(c => `${c.rel} ${c.tokens}/${c.budget}`).join(' · ')}`);
  else fail(`常驻文件超预算 ${over.length} 个`, '加行前先删行；确实要扩容需用户拍板改声明值', over.map(c => `${c.rel} ${c.tokens}>${c.budget}`).join(' '));
}

// ── ⑤ 模型路由表 ───────────────────────────────────────────────────────
// 路由真相源是静默失效型部件：字段缺失没人报错，只会让下游按空气路由。
// 两道校验：①必填字段（why/decided/status/roles）缺失即红；②值校验——路由的
// model/fallback 必须指向 models[].id（防幽灵引用），beijing 必须是
// HH:MM-HH:MM 逗号列表（防填错的时段静默不匹配）。
// 自发现：文件在不在、条目数是不是 0，都单独报红——不把「没扫到」当「扫完 0 违规」。

const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');
const ROUTING_POLICY_FILE = join(ROOT, 'docs', 'model-routing.json');

function missingKeys(entry, keys) {
  return keys.filter(k => {
    const v = entry[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
}

// beijing 时间窗格式：HH:MM-HH:MM 的逗号列表，小时 00-23、结束允许 24:00、分钟 00-59，
// 且结束必须晚于开始。
const BEIJING_WINDOW_RE = /^\d{2}:\d{2}-\d{2}:\d{2}(?:,\s*\d{2}:\d{2}-\d{2}:\d{2})*$/;

function validBeijingWindows(s) {
  if (typeof s !== 'string' || !BEIJING_WINDOW_RE.test(s.trim())) return false;
  return s.split(',').every(w => {
    const [a, b] = w.trim().split('-');
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    const hh = h => h >= 0 && h <= 23;
    if (!hh(ah) || am < 0 || am > 59) return false;
    if (!((bh === 24 && bm === 0) || hh(bh)) || bm < 0 || bm > 59) return false;
    return bh * 60 + bm > ah * 60 + am;
  });
}

function scanTomlSelectionSections(text) {
  const found = [];
  for (const name of ['models', 'routes', 'bans', 'rules']) {
    if (new RegExp(`^\\[\\[${name}\\]\\]`, 'm').test(String(text || ''))) found.push(name);
  }
  return found;
}

function checkRoutingProvidersToml() {
  if (!existsSync(ROUTING_FILE)) {
    fail('docs/model-routing.toml 不在', '路由 provider 模板缺失 ⇒ 本次等于没查；恢复文件', ROUTING_FILE);
    return;
  }
  let rawText;
  try {
    rawText = readFileSync(ROUTING_FILE, 'utf8');
  } catch (e) {
    fail('docs/model-routing.toml 读失败', '恢复文件', String(e.message || e).split(/\r?\n/)[0].slice(0, 160));
    return;
  }
  let doc;
  try {
    doc = parseToml(rawText);
  } catch (e) {
    fail('docs/model-routing.toml 不是合法 TOML', '按标准 TOML 解析器报的错修文件', String(e.message || e).split(/\r?\n/)[0].slice(0, 160));
    return;
  }

  const problems = [];
  if (!doc.updated) problems.push('顶层缺 updated');

  const straySections = scanTomlSelectionSections(rawText);
  if (straySections.length > 0) {
    problems.push(`TOML 仍含已迁 JSON 的选型段 [[${straySections.join(']]/[[')}]]`);
  }

  let launchProviders = 0;
  for (const [name, p] of Object.entries(doc.providers || {})) {
    if (!p || typeof p !== 'object') continue;
    if (!p.launch || String(p.launch).trim() === '') continue;
    launchProviders += 1;
    const start = String(p.start || '').trim();
    if (start !== 'agent' && start !== 'command') {
      problems.push(`${name} 缺 start=agent|command`);
    }
  }
  if (launchProviders === 0) {
    problems.push('没扫到任何带 launch 的 provider，start 没查成');
  }
  const gptNote = String(doc.providers?.gpt?.launch_note || '');
  if (/库默认走第二条|已存在树里只能 terminal create/.test(gptNote)) {
    problems.push('gpt launch_note 仍教已存在树默认走 command');
  }

  const strayParsed = ['models', 'routes', 'bans', 'rules'].filter(k => Array.isArray(doc[k]) && doc[k].length > 0);
  if (strayParsed.length) problems.push(`TOML 解析仍含选型数组：${strayParsed.join('/')}`);

  if (problems.length === 0) {
    green(`provider 启动模板 ${launchProviders} 个有 launch；TOML 选型段 0 条（[[models]]/[[routes]]/[[bans]]/[[rules]] 均无）`);
  } else {
    fail(`provider 模板校验不过 ${problems.length} 处`, 'launch/start 齐；选型只许 docs/model-routing.json；TOML 禁止 [[models]]/[[routes]]/[[bans]]/[[rules]]', problems.slice(0, 10).join(' '));
  }
}

function checkRoutingPolicyJson() {
  if (!existsSync(ROUTING_POLICY_FILE)) {
    fail('docs/model-routing.json 不在', '选型 JSON 缺失 ⇒ 本次等于没查；恢复文件', ROUTING_POLICY_FILE);
    return;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(ROUTING_POLICY_FILE, 'utf8'));
  } catch (e) {
    fail('docs/model-routing.json 不是合法 JSON', '按标准 JSON 修文件', String(e.message || e).split(/\r?\n/)[0].slice(0, 160));
    return;
  }

  let models;
  let bans;
  let rules;
  let reviewerOrder;
  let rankSlots;
  try {
    const {
      modelsFromJson, bansFromJson, rulesFromJson, reviewerSelectOrder, rankOrderFromTree,
    } = require('./lib/model-routing-json.mjs');
    models = modelsFromJson(doc);
    bans = bansFromJson(doc).legacy;
    rules = rulesFromJson(doc);
    reviewerOrder = reviewerSelectOrder(doc);
    rankSlots = {
      写码: rankOrderFromTree(doc, '工人', '写码'),
      审查: rankOrderFromTree(doc, '审官', '审查'),
      判断: rankOrderFromTree(doc, '帅', '判断'),
    };
  } catch (e) {
    fail('选型 JSON 转换失败', '修 JSON 结构或 model-routing-json.mjs', String(e.message || e).split(/\r?\n/)[0].slice(0, 160));
    return;
  }

  if (models.length === 0 && bans.length === 0 && rules.length === 0
    && rankSlots.写码.length === 0 && rankSlots.审查.length === 0 && rankSlots.判断.length === 0) {
    fail('选型 JSON 里职责树/禁令/规则都没扫到', '0 条 = 本次等于没查；按 schema 补条目', ROUTING_POLICY_FILE);
    return;
  }

  const problems = [];
  const modelIds = new Set(models.map(m => m.id).filter(Boolean));
  if (!doc.updated) problems.push('顶层缺 updated');
  if (!doc.帅 && !doc.工人 && !doc.审官) problems.push('顶层缺 帅/工人/审官 职责树');

  for (const duty of ['帅', '工人', '审官']) {
    const workTypes = doc[duty];
    if (!workTypes || typeof workTypes !== 'object') continue;
    for (const [workType, cfg] of Object.entries(workTypes)) {
      const list = cfg?.模型;
      if (!Array.isArray(list) || list.length === 0) {
        problems.push(`${duty}.${workType} 模型 空或未扫到`);
        continue;
      }
      list.forEach((m, i) => {
        if (!m?.id) problems.push(`${duty}.${workType}.模型[${i}] 缺 id`);
        if (m?.禁用 !== true && m?.顺位 == null) problems.push(`${duty}.${workType}.模型[${i}](${m?.id}) 未禁用但缺 顺位`);
        if (Object.prototype.hasOwnProperty.call(m || {}, '厂商')) {
          problems.push(`${duty}.${workType}.模型[${i}](${m?.id}) 仍有厂商数组（#828 落地方式必须是单值 provider）`);
        }
        if (Object.prototype.hasOwnProperty.call(m || {}, 'pipes')) {
          problems.push(`${duty}.${workType}.模型[${i}](${m?.id}) 仍有 pipes（渠道降级唯一归网关）`);
        }
        if (m?.provider == null || String(m.provider).trim() === '') {
          problems.push(`${duty}.${workType}.模型[${i}](${m?.id}) 缺 provider`);
        }
      });
    }
  }

  models.forEach((m, i) => {
    const miss = missingKeys(m, ['id', 'provider', 'roles', 'status', 'why', 'decided']);
    if (miss.length) problems.push(`registry[${i}]缺${miss.join('/')}`);
  });
  bans.forEach((b, i) => {
    const miss = missingKeys(b, ['scope', 'why', 'decided']);
    if (miss.length) problems.push(`bans[${i}]缺${miss.join('/')}`);
  });
  rules.forEach((r, i) => {
    const miss = missingKeys(r, ['rule', 'why', 'decided']);
    if (miss.length) problems.push(`rules[${i}]缺${miss.join('/')}`);
  });

  const usedProviders = new Set();
  models.forEach((m, i) => {
    if (m && m.provider) usedProviders.add(m.provider);
    if (Array.isArray(m?.pipes)) {
      problems.push(`registry[${i}](${m.id}) 仍有 pipes（#828 落地方式必须是单值）`);
    }
  });

  if (usedProviders.size === 0) {
    problems.push('没扫到任何带 provider 的模型');
  } else if (existsSync(ROUTING_FILE)) {
    let provDoc;
    try { provDoc = parseToml(readFileSync(ROUTING_FILE, 'utf8')); } catch { provDoc = null; }
    if (provDoc) {
      for (const name of usedProviders) {
        const p = provDoc.providers?.[name];
        if (!p) { problems.push(`${name} 无 TOML providers 节`); continue; }
        if (!p.launch || String(p.launch).trim() === '') { problems.push(`${name} 缺 launch`); continue; }
        if (String(p.launch).includes('{model}') && !p.launch_model && !p.default_model) {
          problems.push(`${name} 的 launch 含 {model} 但缺 launch_model/default_model`);
        }
      }
    }
  }

  if (!Array.isArray(reviewerOrder) || reviewerOrder.length === 0) {
    problems.push('审官选型序空（没查成）');
  }

  const ymlPath = join(ROOT, 'policy', 'models.yml');
  if (!existsSync(ymlPath)) {
    problems.push('policy/models.yml 不在（与 JSON 同源没查成）');
  } else {
    const ymlIds = scanYmlModelIds(readFileSync(ymlPath, 'utf8'));
    if (ymlIds.length === 0) {
      problems.push('policy/models.yml 0 个 id（没扫成，不是齐）');
    } else {
      for (const id of modelIds) {
        if (!ymlIds.includes(id)) problems.push(`JSON 模型 ${id} 不在 models.yml`);
      }
      for (const id of ymlIds) {
        if (!modelIds.has(id)) problems.push(`models.yml 模型 ${id} 不在 JSON`);
      }
    }
  }

  if (problems.length === 0) {
    green(`选型 JSON ${models.length} 模型/${bans.length} 禁令/${rules.length} 规则；写码顺位 ${rankSlots.写码.length} 审官 ${reviewerOrder.length} 判断 ${rankSlots.判断.length}；yml 同源`);
  } else {
    fail(`选型 JSON 校验不过 ${problems.length} 处`, '职责树 模型/provider/顺位 齐；落地方式单值；yml 与 JSON 模型 id 同源', problems.slice(0, 10).join(' '));
  }
}

// yml 模型 id：独立扫 `- id:`，不复用 yaml-min / 点将台解析。
function scanYmlModelIds(text) {
  const ids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s+- id:\s*(\S+)\s*$/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

// nextLaunch 夹具：检查器自己持有决策表，不 import next-launch.mjs（自己查自己查不出错）。
function oracleNextLaunch({ slate, modelId, pipeIndex, hardFailsOnThisPipe }) {
  const models = Array.isArray(slate) ? slate : [];
  const idx = models.findIndex(s => s && s.id === modelId);
  if (idx < 0) return { action: 'fail' };
  const pi = Number(pipeIndex) || 0;
  const fails = Number(hardFailsOnThisPipe) || 0;
  if (fails < 2) return { action: 'retry', modelId, pipeIndex: pi };
  const next = models[idx + 1];
  if (next && next.id) return { action: 'switch_model', modelId: next.id, pipeIndex: 0 };
  return { action: 'fail' };
}

function checkNextLaunchFixture() {
  let modelIds = new Set();
  if (existsSync(ROUTING_POLICY_FILE)) {
    try {
      const doc = JSON.parse(readFileSync(ROUTING_POLICY_FILE, 'utf8'));
      const { modelsFromJson } = require('./lib/model-routing-json.mjs');
      for (const m of modelsFromJson(doc)) {
        if (m && m.id) modelIds.add(m.id);
      }
    } catch { modelIds = new Set(); }
  }
  const file = join(ROOT, 'tests', 'fixtures', 'next-launch-cases.json');
  if (!existsSync(file)) {
    fail('nextLaunch 夹具不在', '恢复 tests/fixtures/next-launch-cases.json', file);
    return;
  }
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    fail('nextLaunch 夹具不是 JSON', '按标准 JSON 修文件', String(e.message || e).slice(0, 160));
    return;
  }
  const cases = Array.isArray(doc?.cases) ? doc.cases : [];
  if (cases.length === 0) {
    fail('nextLaunch 一套样本都没扫到', '夹具 cases 空了 ⇒ 本次等于没查', file);
    return;
  }
  const problems = [];
  for (const s of doc.slate || []) {
    if (s && s.id && modelIds && modelIds.size > 0 && !modelIds.has(s.id)) {
      problems.push(`slate id ${s.id} 不在 models`);
    }
  }
  for (const c of cases) {
    const got = oracleNextLaunch({
      slate: doc.slate,
      modelId: c.modelId,
      pipeIndex: c.pipeIndex,
      hardFailsOnThisPipe: c.hardFailsOnThisPipe,
    });
    if (got.action !== c.expect?.action) problems.push(`${c.name}: action ${got.action} ≠ ${c.expect?.action}`);
    if (c.expect?.modelId != null && got.modelId !== c.expect.modelId) {
      problems.push(`${c.name}: modelId ${got.modelId} ≠ ${c.expect.modelId}`);
    }
    if (c.expect?.pipeIndex != null && got.pipeIndex !== c.expect.pipeIndex) {
      problems.push(`${c.name}: pipeIndex ${got.pipeIndex} ≠ ${c.expect.pipeIndex}`);
    }
  }
  const names = new Set(cases.map(c => c && c.name).filter(Boolean));
  if (!names.has('two-hard-switch-model')) {
    problems.push('夹具缺 two-hard-switch-model（#828 换模型路径必须有判别样本）');
  }
  if ([...names].some(n => /switch-pipe|pipes-exhausted/.test(n))) {
    problems.push('夹具仍有换支路用例（#828 渠道降级唯一归网关）');
  }
  if (problems.length === 0) green(`nextLaunch 夹具 ${cases.length} 条（瞬时不切 / 2 次硬失败换模型 / 名单走完失败）`);
  else fail(`nextLaunch 夹具 ${problems.length} 处对不上`, '夹具 expect 与检查器自己的决策表必须一致；生产实现由 tests/next-launch.test.js 对同一份夹具核', problems.slice(0, 8).join(' '));
}

// ── ⑧ 态注入 hook 活着（issue #488）────────────────────────────────────
// 专注/值守三态的承重墙是 UserPromptSubmit hook：它每轮把当前态注入上下文。
// 它是静默失效型部件的极端例子——被覆盖/断链/坏掉之后，态标还挂在那儿，
// AI 却什么都收不到，用户以为自己锁着，实际没锁。假状态比没状态更糟。
//
// 装载面没有单一 owner：插件面（~/.claude/skills/<名>/）会随仓库搬家、worktree 删除而断链，
// settings.json 更是 cc-switch DB 下发 / Orca 写 hooks / CC 本体重置三方互相覆盖
// （见 memory claude-settings-self-heal）。所以「装过一次」不等于「现在还在」，必须每次重验。
//
// 两层验，缺一不可（静态门控拦不住运行时失效）：
//   静态：仓内每个自带 hook 的 skill（host/skills/<名>/hooks/hooks.json）声明的脚本，
//         都要能在本机某个装载面上被点到。
//   运行时：把点到的那条命令真跑四次，四种状态文件各一次——读到且常态 / 读到且非常态 /
//         文件不在 / 文件坏了——断言四种输出两两不同形，且只有非常态那次带得出哨兵焦点。
//         这是「读到了且是常态」「读到了且非常态」「压根没读到」三形不得同形那条硬规矩的常驻闸
//         （第四形「读到了但坏了」一并单列：没读到和读坏了是两件事，处置不一样）。
// 自发现：期望集合从 host/skills/ 扫出来，没有手写清单可以漏登记。
// 零样本：skills 目录不在 / 没有任何 hook 声明 / 声明了但脚本没了，全部单独报红。
// #807：本机未接 Claude Code（无插件面也无 settings 面）SKIP 不是绿。

// 实现在 scripts/lib/dao-mode-hook-check.mjs（那里能被 tests/dao-mode.tests.js 拿假 HOME 造违规
// 样本单独验，不必跑整个 dao-check——dao-check 会跑 tests/，tests 再跑 dao-check 就递归了）。

function checkModeHookAlive() {
  const r = checkModeHook({ root: ROOT, home: process.env.HOME || process.env.USERPROFILE || '' });
  if (r.green) green(r.green);
  else if (r.skip) skip(r.skip);
  else fail(...r.fail);
}

function checkDispatchGateAlive() {
  const r = checkDispatchGate({ root: ROOT });
  if (r.green) green(r.green);
  else fail(...r.fail);
}

// ── ⑨ 本机 memory 断链检查（local-only，issue #503 / 判据改写 #529 / #807）─────────────
// 正确状态（NEW-MACHINE §10）：本机 `~/.claude/projects/<编码>/memory` 是指向
// **windsurf-dao-memory 独立仓 clone** 的符号链接（memory 已自 #518 搬出主仓），
// Claude 每写一条 memory，memory 仓 git status 就多一条未提交变更。
// #529 之前的判据是「Junction 必须指向仓内 memory 真相源」，memory 搬家后本机必红——
// 判据改为：链接目标必须是一个 git 仓库，且它的 origin remote 指向
// thoerwink8/windsurf-dao-memory（从 URL 抽 owner/repo 再比，SSH/HTTPS 两种形态都认），
// 不硬编码本机路径，换机成立。
// #503 的病：本机 memory 是**普通目录**，与真相源完全漂移——今天写的每条教训
// 只在本机，换机即丢；而 dao-check 只查仓内副本（CI 没有本机 ~/.claude）……本项只验本机
// 文件系统，CI/新机/未接 worktree 无该项目目录时出 SKIP 不是绿（SKIP 与绿分不开 ⇒
// CI 永远绿、本机永远没人查）。
// 实现放 scripts/lib/dao-memory-link-check.mjs，让 tests/memory-link.tests.js 拿假 HOME 造
// 违规样本（普通目录/悬空/目标不是 git 仓/无 origin/origin 不是 memory 仓=红，
// 正确 Junction=绿，SSH/HTTPS 两种 origin 形式都验，无目录=SKIP）单独验判别力。

function checkMemoryLinkAlive() {
  const r = checkMemoryLink({ root: ROOT, home: process.env.HOME || process.env.USERPROFILE || '' });
  if (r.green) green(r.green);
  else if (r.skip) skip(r.skip);
  else fail(...r.fail);
}

// ── ㉚ skill 发现面符号链接（local-only，issue #793）────────────────────
// 仓内 host/skills/<名>/ 每个 skill，在本机宿主发现面 ~/.claude/skills/<名> 必须是指向仓内
// host/skills/<名> 的符号链接（NEW-MACHINE §11）。整目录链接 = 被劫（#1146），无发现面 = 没装。
// 接回走 onboard / dao-skills-heal.timer，本检查只报警。#789 实咬：/dao-commit 终端不可见，根因之一是链接缺失。
// 实现放 scripts/lib/skill-link-check.mjs，让 tests/skill-link.test.js 拿假 root + 假 HOME 造
// 违规样本（缺链/普通目录/悬空/指错=红，全链齐=绿，无 ~/.claude/skills=SKIP，空 host/skills=没查成）
// 单独验判别力，不必跑整个 dao-check（那会递归）。

function checkSkillLinksAlive() {
  const r = checkSkillLinks({
    root: ROOT,
    home: process.env.HOME || process.env.USERPROFILE || '',
    isCi: process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true',
  });
  if (r.green) green(r.green);
  else if (r.skip) skip(r.skip);
  else fail(...r.fail);
}

// ── ⑪ 主帅标题核对样本 ─────────────────────────────────────────────
// 检查器自己抽 ｜[#N] 定界区，不调用 master-title.mjs。
// 零样本：目录不在 / 一个样本都没有 / 只有一致没有过期（或反过来）→ 没查成。

function zoneTicketsIndependent(title) {
  const m = String(title || '').match(/｜\[([^\]]*)\]$/);
  if (!m) return { hasZone: false, tickets: [] };
  return { hasZone: true, tickets: m[1].match(/#\d+/g) || [] };
}

function checkMasterTitleSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'master-title');
  if (!existsSync(dir)) {
    fail('主帅标题样本目录不在', '本次没查成：恢复 tests/fixtures/master-title/', dir);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    fail('主帅标题一套样本都没扫到', '目录空了 ⇒ 本次等于没查', dir);
    return;
  }
  const kinds = { ok: 0, stale: 0 };
  const problems = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch (e) { problems.push(`${f} 不是 JSON`); continue; }
    if (!doc || !('title' in doc) || !('openIds' in doc) || !doc.expect) {
      problems.push(`${f} 缺 title/openIds/expect`);
      continue;
    }
    const parsed = zoneTicketsIndependent(doc.title);
    const open = new Set((doc.openIds || []).map(x => `#${String(x).replace(/^#/, '')}`));
    const stale = parsed.hasZone ? parsed.tickets.filter(t => !open.has(t)) : [];
    if (doc.expect === 'ok') {
      kinds.ok++;
      if (stale.length) problems.push(`${f} 自称一致但定界区有过期 ${stale.join(' ')}`);
    } else if (doc.expect === 'stale') {
      kinds.stale++;
      if (stale.length === 0) problems.push(`${f} 自称过期但定界区与 openIds 一致（样本没判别力）`);
    } else {
      problems.push(`${f} expect 只能是 ok|stale`);
    }
  }
  if (kinds.ok === 0 || kinds.stale === 0) {
    fail('主帅标题样本种类不够', '至少各要一份一致（expect:ok）和一份过期（expect:stale），缺一种 = 没查成', `ok=${kinds.ok} stale=${kinds.stale}`);
    return;
  }
  if (problems.length) {
    fail(`主帅标题样本对不上 ${problems.length} 处`, '样本的 expect 必须和定界区 vs openIds 的独立核对一致', problems.join(' '));
    return;
  }
  green(`主帅标题样本 ${files.length} 份（一致 ${kinds.ok} / 过期 ${kinds.stale}）`);
}

// ── ⑫ 派工卡 comment 必须有定界区 ──────────────────────────────────
// 检查器自己抽 ｜[#N]，不调用 master-title.mjs。
// 零样本：目录不在 / 一个样本都没有 / 只有 ok 没有 missing（或反过来）→ 没查成。

function checkCardCommentSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'card-comment');
  if (!existsSync(dir)) {
    fail('派工卡 comment 样本目录不在', '本次没查成：恢复 tests/fixtures/card-comment/', dir);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    fail('派工卡 comment 一套样本都没扫到', '目录空了 ⇒ 本次等于没查', dir);
    return;
  }
  const kinds = { ok: 0, missing: 0 };
  const problems = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch (e) { problems.push(`${f} 不是 JSON`); continue; }
    if (!doc || !('comment' in doc) || !('expectedTickets' in doc) || !doc.expect) {
      problems.push(`${f} 缺 comment/expectedTickets/expect`);
      continue;
    }
    const parsed = zoneTicketsIndependent(doc.comment);
    const expected = (doc.expectedTickets || []).map(x => `#${String(x).replace(/^#/, '')}`);
    const missing = expected.filter(t => !parsed.tickets.includes(t));
    if (doc.expect === 'ok') {
      kinds.ok++;
      if (!parsed.hasZone) problems.push(`${f} 自称有区但抽不到 ｜[#N]`);
      else if (missing.length) problems.push(`${f} 自称齐全但缺 ${missing.join(' ')}`);
    } else if (doc.expect === 'missing') {
      kinds.missing++;
      if (parsed.hasZone && missing.length === 0) {
        problems.push(`${f} 自称缺区但定界区与期望一致（样本没判别力）`);
      }
    } else {
      problems.push(`${f} expect 只能是 ok|missing`);
    }
  }
  if (kinds.ok === 0 || kinds.missing === 0) {
    fail('派工卡 comment 样本种类不够', '至少各要一份有区（expect:ok）和一份缺区（expect:missing），缺一种 = 没查成', `ok=${kinds.ok} missing=${kinds.missing}`);
    return;
  }
  if (problems.length) {
    fail(`派工卡 comment 样本对不上 ${problems.length} 处`, '样本的 expect 必须和定界区 vs expectedTickets 的独立核对一致', problems.join(' '));
    return;
  }
  green(`派工卡 comment 样本 ${files.length} 份（有区 ${kinds.ok} / 缺区 ${kinds.missing}）`);
}

// ── ⑭ open issue 数量阈值（#556；#564 口径改版：只数没在做的单）──────────────────
// 知识网堆回工作队列是不可感知型失效：每张单只多一条，看见时已细成一团（#556 实测：
// 四天积 45 张、缠绕度 89%）。超过阈值报红，附「过一遍 ideas 分流」。
//
// #564 阈值口径改版：原来把在途单也算进积压，开两张施工单就撞顶。改成只数**没在做的**单，
// 判据用**有无在途 PR / worktree 卡关联**（机器可见的事实），不用 label（靠自觉打标会烂）。
//   在途 PR 面：gh pr list --state open，正文/标题里 Closes/Fixes 署名的 issue 号（独立正则，
//             不调用 dao-cmd 的解析——自己查自己查不出错）。
//   在途卡面：orca worktree list，卡名 ^#N 的号（master 主树与 archived 不算）。
// 两道面缺一道 = 判不全面，不许当查过没事：缺了 orca 面会把在途卡算成积压（惩罚正在工作，
// 正是本改版要防的）；gh 面缺了本来就什么都查不了。CI 无 GH_TOKEN → SKIP 不是绿。
// 判据独立：直接 JSON.parse gh/orca 的输出。「没查成」与「查了是 0」必须分得开。
// 阈值是棘轮：只降不升，默认取当前 backlog 数 + 1。#556 分流关掉 14 张后由 44 降到 30；
// 帅批量分流后应随之下调，目标 10（一组在施 + 下一批小活）。
// 变异测试：DAO_CHECK_OPEN_ISSUE_MAX=0 必红（当前非零数据）；边界：N/N 绿、N+1/N 红。

const OPEN_ISSUE_MAX_DEFAULT = 30;

// 机器自己开的 `[待拍板]` 单堆多少张算失控（2026-09-06 实咬）。
//
// 那晚堆到 11 张，**其中 10 张是假警报**，而没有任何东西在盯这个数——是用户截了张图
// 才发现的。上面那条 OPEN_ISSUE_MAX 盯的是「未在做的单」总量（阈值 30），
// 待拍板混在里面根本顶不到线。两个量测的不是一件事：
//   backlog  —— 人还没排上队的活（涨了说明该分流）
//   待拍板   —— **机器向人求助的速率超过了人的处理速率**（涨了说明机器在刷噪音）
//
// 5 张这个数不是现拍的：CLAUDE.md 收件箱那节早就用「堆到 5 条」当硬性处置线，沿用同一个数，
// 不另立一个。
//
// 只拦数量，不拦「等了多久」：一张真的在等用户的单，用户出门两天它就超龄了，
// 那不是违规（wall-clock 当闸必然误报，本仓已有判例）。年龄只报出来给人看。
const PENDING_BOARD_MAX_DEFAULT = 5;
const PENDING_TITLE_RE = /^\s*\[待拍板\]/;

// ── 收件箱（2026-09-06 从 hook 挪到这里）──────────────────────────────────────
//
// 原设计：全局 settings.json 的 UserPromptSubmit hook 每轮提醒。**实测这台服务器上根本没装**
// ——global-CLAUDE.md 写着「每轮由全局 hook 提醒」，两个 settings.json 里一个 inbox 字样都没有，
// 所以那两条 open 的 observation 躺了一天没人管。文档说有、实际没有，又一次「上游就绪≠下游执行」。
//
// 更根本的问题是载体选错了：UserPromptSubmit 是 Claude Code 独有的，而执行体已经全在 mirasim 上
// （codex / pi 会话根本没有这种 hook）。把「会不会被读到」押在某一个客户端的钩子上，
// 换个执行体就静默失效。
//
// 所以挪到 dao-check：它是帅位每次 land 的必经之路，与客户端无关。判据复用 inbox.mjs 的
// assessInbox（不另造第二套口径）：超时 / 堆积 / 未提交 → block 判红，否则只念一遍。
function checkInbox() {
  const dir = join(ROOT, 'docs', 'observations');
  if (!existsSync(dir)) { green('收件箱：docs/observations 不在——本仓没这条通道'); return; }
  let docs = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const p = join(dir, name);
      const parsed = parseInboxDoc(readFileSync(p, 'utf8'), { name, mtimeMs: statSync(p).mtimeMs });
      if (parsed) docs.push(parsed);
    }
  } catch (e) {
    fail('收件箱没查成', '读不了 docs/observations——不是「没有新东西」', String(e.message || e).slice(0, 80));
    return;
  }
  // 未提交的最危险：落盘了但别的机器看不到，等于没写（这条通道的立身之本就是进 git）。
  const st = spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'docs/observations'], { encoding: 'utf8', windowsHide: true });
  const untracked = st.status === 0
    ? String(st.stdout || '').split(/\r?\n/).filter(l => l.startsWith('??')).map(l => l.slice(3).trim()).filter(Boolean)
    : [];
  const assessed = assessInbox({ docs, untracked });
  if (assessed.unscanned) { fail('收件箱没查成', assessed.lines.join('；'), ''); return; }
  if (assessed.mode === 'block') {
    fail(`收件箱要先处置：${assessed.pending.length} 条未处置（超时 ${assessed.overdue.length}，未提交 ${untracked.length}）`,
      '每条落成 issue、或文件里加一行「处置：<结论>」、或 status 标 wontfix 加理由；未提交的先 git add',
      assessed.lines.slice(0, 3).join('；'));
    return;
  }
  if (assessed.mode === 'notice') {
    for (const l of assessed.lines) notes.push(`收件箱：${l}`);
  }
  green(`收件箱：对照 ${docs.length} 条，未处置 ${assessed.pending.length}`);
}

// ── 西瓜清单（2026-09-06）─────────────────────────────────────────────────────
//
// 用户点破的真问题：风险不是忘了某一件事，是长期目标被日常小事挤掉，两天后彻底遗忘。
// 「再写一个文档记着」解决不了——文档会和人一起遗忘（#880 的进度表就是活证据，
// 它写着卡 C 未完成而实际早就合了，2026-09-06 连着误导两次）。
//
// 所以这条 check 做三件事，每次跑 dao-check 都做：
//   ① 把西瓜念一遍——不需要谁记得去看板上翻
//   ② 在制品超上限就红——Little's Law：同时做的越多，每件完成得越慢
//   ③ **守住 done_when 的判据指针**：check 字段指的函数必须真存在。
//      指向空气的指针比没有更糟（本仓约定），而这类指针最容易在重构里悄悄失效。
// 仓内属主：谁写的盘，谁就是属主。2026-09-06 第三次实咬——
// 前两次归因都错了。我以为坑是「用 root 跑命令」，配的对策是「仓内命令一律 sudo -u orca」；
// 可 Claude Code 的 Edit/Write **不是 bash 命令**，它由宿主进程直接写盘，而宿主跑在 root 下。
// 对策从没覆盖这条路径（memory: fix-landed-at-one-call-site-only 同款）。
//
// 后果不长得像属主问题：测试报 EACCES unlink（sandbox 删不掉旧文件）、land 报
// could not read Username for 'https://github.com'（看起来像认证坏了）。判据只能是属主本身。
//
// 只在 Linux 上查，且只有当仓的属主不是当前用户时才有意义——单用户机器上人人都是 owner。
function checkRepoOwnership() {
  if (process.platform === 'win32') { skip('仓内属主：Windows 无 uid 概念，本项跳过'); return; }
  const r = spawnSync('find', ['.', '-user', 'root', '-not', '-path', './.git/*', '-not', '-path', './node_modules/*', '-print'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.error || (r.status != null && r.status > 1)) {
    fail('仓内属主没查成', 'find 跑不起来——别据此判断干净', String(r.error?.message || r.stderr || '').slice(0, 80));
    return;
  }
  const owned = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  // 仓本身就归 root 的机器（比如个人开发机）不该被这条闸打扰：判据是「仓目录属主 ≠ root 却有 root 文件」。
  let repoOwner = null;
  try { repoOwner = statSync(ROOT).uid; } catch { repoOwner = null; }
  if (repoOwner === 0) { skip(`仓内属主：仓本身归 root（${owned.length} 个 root 文件属正常），本项跳过`); return; }
  if (owned.length) {
    fail(`仓内有 ${owned.length} 个 root 属主文件`,
      `跑 chown -R $(stat -c %U:%G .) . 修。根因多半是拿 root 身份改了文件——Claude Code 的 Edit/Write 走宿主进程，宿主是 root 时写出来的就是 root 文件，跟命令加不加 sudo 无关`,
      owned.slice(0, 5).join('、') + (owned.length > 5 ? ` …等 ${owned.length} 个` : ''));
    return;
  }
  green('仓内属主：扫完 0 个 root 属主文件');
}

function findRootOwnedInGitDir(gitDir) {
  return interpretFindRootOwned(spawnSync('find', [gitDir, '-user', 'root', '-print'], {
    encoding: 'utf8',
    windowsHide: true,
  }));
}

function checkGitOwnershipSamples() {
  const r = inspectGitOwnershipFixtures({
    exists: (rel) => existsSync(join(ROOT, rel)),
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
  });
  if (!r.ok) {
    fail(
      r.unscanned ? '.git 属主闸样本没查成' : '.git 属主闸样本对不上',
      '恢复 tests/fixtures/git-ownership/{red,ok,empty}.json：红=点名 root 文件必须拦、绿必须过、仓不在必须没查成',
      r.error || (r.problems || []).join('；'),
    );
    return;
  }
  green(`.git 属主闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkGitOwnershipLive() {
  if (process.platform === 'win32') { skip('.git 属主：Windows 无 uid 概念，本项跳过'); return; }
  const exists = (p) => existsSync(p);
  const isDir = (p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  };
  const statUid = (p) => statSync(p).uid;
  const scans = DEFAULT_MANAGED_REPOS.map((repo) => scanGitRepo({
    name: repo.name,
    path: repo.path,
    exists,
    isDir,
    statUid,
    findRootOwned: findRootOwnedInGitDir,
  }));
  // 本机一台都没有（CI / 开发机 / 云 VM）→ SKIP 不是绿。分类器对「仓不在」仍判
  // unscanned，单测钉那条；live 若因此 fail 会把 land 卡在「这台机器本来就不托管这两仓」。
  if (scans.every((s) => s.exists === false)) {
    skip('.git 属主：本机没有 /srv/projects 在管仓，本项没查成');
    return;
  }
  const r = classifyGitOwnership(scans);
  if (r.kind === 'ok') green(r.line);
  else if (r.kind === 'skip') skip(r.line);
  else fail(r.line, r.howToFix, r.evidence);
}

function checkInitiatives() {
  const file = join(ROOT, 'docs', 'initiatives.json');
  if (!existsSync(file)) { skip('西瓜清单：docs/initiatives.json 不在——本项没查成'); return; }
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { fail('西瓜清单读不了', 'initiatives.json 不是合法 JSON', String(e.message || e).slice(0, 80)); return; }
  const list = Array.isArray(doc.initiatives) ? doc.initiatives : null;
  if (!list) { fail('西瓜清单没查成', 'initiatives.json 缺 initiatives[] 数组', ''); return; }
  const active = list.filter(i => i && i.status === 'active');
  const limit = Number(doc.wip_limit) || 3;

  // 判据指针失效检查：done_when 靠 check 指的那个函数来算，函数没了就等于这条目标没人盯着。
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const dangling = active.filter(i => i.check && !src.includes(`function ${i.check}`));
  if (dangling.length) {
    fail(`西瓜清单有 ${dangling.length} 条判据指向空气`, '被指的检查函数没了——这条目标其实没人在盯，补回函数或改 check 字段',
      dangling.map(i => `${i.id} → ${i.check}()`).join('；'));
    return;
  }
  if (active.length > limit) {
    fail(`在制品超上限：${active.length} 个西瓜同时在推（上限 ${limit}）`,
      '先完成一个再开新的。别提高上限来消红——那是业界记录的头号反模式',
      active.map(i => i.id).join('；'));
    return;
  }
  // 缺 next_action 就是「不知道下一步干什么」。2026-09-06 实咬：用户问「有没有讨论过还没做的」，
  // 清单答不上——它只记了完成判据。done_when 判「完了没」，next_action 答「现在轮到干什么」，缺一不可。
  const noNext = active.filter(i => !String(i.next_action || '').trim());
  if (noNext.length) {
    fail(`西瓜清单有 ${noNext.length} 条不知道下一步干什么`,
      '给它补 next_action（和 next_action_as_of 日期）——只有完成判据的清单答不出「还剩什么没做」',
      noNext.map(i => i.id).join('；'));
    return;
  }
  const today = Date.parse(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10));
  for (const i of active) {
    const asOf = Date.parse(String(i.next_action_as_of || ''));
    const days = Number.isFinite(asOf) ? Math.floor((today - asOf) / 86400000) : null;
    const stamp = days == null ? '（没写 as_of，鲜度不明）' : days <= 0 ? '（今天更新）' : `（${days} 天前写的）`;
    notes.push(`西瓜「${i.name}」\n    完成判据：${i.done_when}\n    下一步${stamp}：${i.next_action}`);
  }
  green(`西瓜清单：${active.length}/${limit} 在推，判据指针都还活着，每条都有下一步`);
}

// ── orca 产品面残留（linux 用户名 /home/orca 不是产品，不进这条）────────────────
// 认这些才算还没退役：真 spawn orca CLI、createOrcaBinding、orca-serve 单元、
// dao.mjs 标了「整段删」的那条脊。判例档案（docs/decisions、docs/observations）不扫。
function checkEphemeralLifecycle() {
  const problems = [];
  const read = (rel) => {
    try { return readFileSync(join(ROOT, rel), 'utf8'); }
    catch (e) { problems.push(`${rel} 读不了：${String(e && e.message || e).slice(0, 60)}`); return ''; }
  };
  const gone = (rel) => existsSync(join(ROOT, rel));
  const dao = read('scripts/dao.mjs');
  const commander = read('scripts/commander.mjs');
  const handoff = read('scripts/lib/handoff-check.mjs');
  const miraReviewer = read('host/skills/dispatch/templates/reviewer-book-mirasim.md');
  const miraSoldier = read('host/skills/dispatch/templates/soldier-book-mirasim.md');
  const agents = read('AGENTS.md');
  const nudgeInstall = read('scripts/install-nudge-stalled.sh');
  const progressInstall = read('scripts/install-progress-watch.sh');
  if (dao && !/stopSessionsAtCwd/.test(dao)) problems.push('worker-done 热路没调 session-stop');
  if (dao && !(/queued-for-review/.test(dao) || /enqueueOnly:\s*true/.test(dao))) problems.push('worker-done 没入队');
  if (commander && !/\brunProgressWatch\s*\(/.test(commander)) problems.push('指挥官没并进 progress-watch');
  if (commander && !/soldier-book-mirasim\.md/.test(commander)) problems.push('指挥官派工指针还钉 orca 士兵书');
  if (agents && !/soldier-book-mirasim\.md/.test(agents.split('\n')[0] || '')) problems.push('AGENTS.md 首行还钉 orca 书');
  if (miraReviewer && /pr merge/.test(miraReviewer)) problems.push('审官 mirasim 书还在教 pr merge');
  if (miraSoldier && /按需起审官/.test(miraSoldier)) problems.push('士兵 mirasim 书还在教按需起审官');
  if (handoff && !/merge:\s*\{\s*advisory:\s*\[[^\]]*['"]①['"]/.test(handoff.replace(/\s+/g, ' '))) {
    problems.push('合并闸 ① 没标 advisory');
  }
  // 已删/退役路径：行里必须带「已删」字，否则交卷闸 ④ 把负向检查当成指向空气的指针。
  if (gone('scripts/nudge-stalled.mjs')) problems.push('已删的 nudge-stalled 垫片还在仓里');
  if (gone('scripts/lib/nudge-stalled.mjs')) problems.push('已删的 nudge-stalled 闸还在仓里');
  if (gone('host/machine/systemd/dao-nudge-stalled.timer')) problems.push('已删的 nudge timer 单元还在仓里');
  if (gone('host/machine/systemd/dao-progress-watch.timer')) problems.push('已删的 progress-watch timer 单元还在仓里');
  if (nudgeInstall && !/disable --now dao-nudge-stalled/.test(nudgeInstall)) problems.push('nudge 安装脚本没改成卸载');
  if (progressInstall && !/disable --now dao-progress-watch/.test(progressInstall)) problems.push('progress-watch 安装脚本没改成卸载');
  if (!gone('scripts/land.mjs') || !gone('scripts/close-issues.mjs')) {
    problems.push('land / close-issues 旁路脚本丢了');
  }
  if (problems.length) {
    fail(`短命会话闸红 ${problems.length} 处`, 'done_when 是机器可算的事实，红了就还没完', problems.slice(0, 6).join('；'));
    return;
  }
  green('短命会话：交卷停会话+入队、独立钟已删、审官书不合、指挥官并进盘面推进量');
}

function checkOrcaRetirement() {
  const r = spawnSync(
    'grep',
    ['-rlnE', String.raw`spawn(Sync)?\(\s*['"]orca['"]|run\(\s*['"]orca['"]|export function createOrcaBinding|orca-serve\.service|orca 退役时整段删`, 'scripts', 'tests', 'host/machine/systemd'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
  if (r.error) {
    fail('orca 产品残留没查成', 'grep 跑不了就别说退役完了', String(r.error.message || r.error).slice(0, 80));
    return;
  }
  if (r.status != null && r.status > 1) {
    fail('orca 产品残留没查成', 'grep 出错不是「扫完 0 条」', `退出码 ${r.status}：${String(r.stderr || '').slice(0, 80)}`);
    return;
  }
  const files = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((f) => !f.includes('dao-check.mjs')); // 本闸自己的模式字面量不算残留
  if (files.length) {
    fail(
      `orca 产品面还在 ${files.length} 个文件里`,
      '删 spawn orca / createOrcaBinding / orca-serve 单元 / dao.mjs「整段删」那条脊。linux 用户名 /home/orca 可以留',
      files.slice(0, 8).join('、') + (files.length > 8 ? ' …' : ''),
    );
    return;
  }
  green('orca 产品面已清（无 spawn orca / 无 orca-serve 单元 / 无整段删脊）');
}

// ── 补丁链层数闸（memory patch-stacking-is-two-strikes 的 gate）──────────────
// 规矩是「同一种办法连错两次就换路」——第 2 层就该停手从零重推。所以 ≥3 层是
// **停手没发生**的确定性证据。判据在 lib/chain-depth-check.mjs（只认锚里的最大层号，
// 不数提交条数：同一层可以有很多次提交）。
function checkChainDepth() {
  const r = spawnSync('git', ['-C', ROOT, 'log', '--all', '--grep=chain:', '--oneline'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20 });
  if (r.error || r.status !== 0) {
    // 「git 跑不了」和「扫完 0 条锚」必须分开，否则闸静默开门。
    fail('补丁链层数没查成', 'git log 跑不了就别说没有超深的链',
      String(r.error?.message || r.stderr || `退出码 ${r.status}`).slice(0, 80));
    return;
  }
  const lines = String(r.stdout || '').split('\n').filter((s) => s.trim());
  const v = classifyChainDepth({ lines });
  if (v.state === 'unknown') { fail('补丁链层数没查成', 'git log 输出读不出来', v.detail); return; }
  if (v.state === 'red') {
    fail(v.detail,
      '第 2 层就该停手：跑 grill-ai，画出补丁链，从本质需求从零重推，把「删掉整层」的备选摆出来',
      v.over.map((o) => `${o.slug}#${o.depth}`).join('、'));
    return;
  }
  green(`补丁链层数：${v.detail}`);
}

// ── 竞争 PR 闸（2026-09-06）───────────────────────────────────────────────────
// 两个开放 PR 新建同一个文件 = 两份独立实现，合并时必然作废一个。判据与来历见
// scripts/lib/competing-prs.mjs 头部（#884/#886/#986 三份实现撞在一起那次）。
function checkCompetingPrsSamples() {
  // 判别力：红样本必须红、绿样本必须绿。判据被改松（比如「同名就放行」）这里当场红。
  const red = judgeCompetingPrs({
    prs: [{ number: 1, newPaths: ['a.mjs'] }, { number: 2, newPaths: ['a.mjs'] }],
  });
  const clean = judgeCompetingPrs({
    prs: [{ number: 1, newPaths: ['a.mjs'] }, { number: 2, newPaths: ['b.mjs'] }],
  });
  const blind = judgeCompetingPrs({ prs: [{ number: 1 }] });   // 缺清单必须判没查成
  const bad = [];
  if (red.kind !== 'red') bad.push(`红样本没红（${red.kind}）`);
  if (clean.kind !== 'ok') bad.push(`绿样本没绿（${clean.kind}）`);
  if (blind.kind !== 'unscanned') bad.push(`缺文件清单没判没查成（${blind.kind}）`);
  if (bad.length) { fail('竞争 PR 闸没判别力', '判据被改松了，先修判据再谈盘面', bad.join('；')); return; }
  green('竞争 PR 闸样本红/绿/没查成各 1（有判别力）');
}

function checkCompetingPrsLive() {
  const runGh = (args) => {
    const r = spawnSync('gh', args, { windowsHide: true, encoding: 'utf8', cwd: ROOT, timeout: 60000 });
    if (r.error || r.status !== 0) return { ok: false, error: String(r.stderr || r.error?.code || '').slice(0, 100) };
    try { return { ok: true, json: JSON.parse(r.stdout) }; }
    catch (e) { return { ok: false, error: `输出不是 JSON（${String(e.message || e).slice(0, 60)}）` }; }
  };
  const got = collectOpenPrNewFiles({ runGh, mainHas: (p) => existsSync(join(ROOT, p)) });
  if (got.unscanned) { fail('竞争 PR 闸没查成', '不是「没有冲突」——gh 没取到数据', got.error); return; }
  const v = judgeCompetingPrs({ prs: got.prs });
  if (v.kind === 'unscanned') { fail('竞争 PR 闸没查成', '判定拿不到完整清单', v.error || ''); return; }
  if (v.kind === 'red') {
    fail(v.line, '两份实现只能活一个：先定谁作废（关掉或改范围），别等合并时才发现', v.collisions.map(c => `${c.path}: ${c.prs.map(n => '#' + n).join(',')}`).join('；'));
    return;
  }
  green(v.line);
}

function runGhJson(args) {
  const r = spawnSync('gh', args, { windowsHide: true, encoding: 'utf8', cwd: ROOT });
  if (r.error) return { unscanned: true, error: `gh 不可用（${r.error.code}）` };
  if (r.status !== 0) return { unscanned: true, error: String(r.stderr || r.stdout || '').trim().slice(0, 100) };
  let doc;
  try { doc = JSON.parse(r.stdout); } catch (e) { return { unscanned: true, error: `输出不是 JSON（${String(e.message || e).slice(0, 80)}）` }; }
  if (!Array.isArray(doc)) return { unscanned: true, error: `输出形态不对（要数组：${typeof doc}）` };
  return { array: doc };
}

function runMirasimWorktrees() {
  const r = scanMirasimTrees({
    readdir: readdirSync,
    stat: statSync,
    join,
  });
  if (!r.scanned) return { unscanned: true, error: r.error || 'mirasim 树面没查成' };
  return { worktrees: r.worktrees || [] };
}

function loadOpenBoard() {
  return {
    // author 是「同一起因只许一张 OPEN 单」那道检查的必需字段：用它分「机器/帅位开的」
    // 与「用户本人开的」，后者不纳入。少这个字段那道检查只能判没查成（#1063 ②）。
    // milestone 是「将来某版」推迟档（#966）的必需字段：少它 isDeferredIssue 永远 false。
    issues: runGhJson(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,body,labels,author,createdAt,milestone']),
    prs: runGhJson(['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,body']),
    worktrees: runMirasimWorktrees(),
  };
}

function checkOpenIssueCountSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'open-issue-count');
  const r = inspectOpenIssueCountFixtures(dir);
  if (r.unscanned) {
    fail('open 单数量样本没查成', '本次没查成：恢复 tests/fixtures/open-issue-count/ 超阈红 + 推迟不进分母的绿', r.error);
    return;
  }
  if (!r.ok) {
    fail(
      `open 单数量样本对不上${r.problems && r.problems.length ? ` ${r.problems.length} 处` : ''}`,
      '故意超阈必须红；同一份再加「将来某版」分母不变；推迟档顶满阈值必须绿',
      (r.problems && r.problems.join(' ')) || r.error,
    );
    return;
  }
  green(`open 单数量样本 ${r.kinds.red + r.kinds.ok} 份（超阈红 ${r.kinds.red} / 推迟不进分母绿 ${r.kinds.ok}）`);
}

// 同一起因只许一张 OPEN 单（#1063 ②）。判据是纯函数 inspectCauseSlugs，这里只取数与报形。
// 落点选 dao-check 不选 Claude Code hook：本机 ~/.claude/settings.json 一条 hook 都没有，
// hook 型载体在这台服务器上根本不装（收件箱就是因此从 hook 挪过来，commit d48ecc5d）。
function checkCauseSlugLive(board) {
  const issues = board.issues;
  if (issues.unscanned) {
    skip(`同一起因只许一张 OPEN 单：gh issue list 没查成（${issues.error}），本次没查成，不是绿`);
    return;
  }
  const got = inspectCauseSlugs({ issues: issues.array });
  if (got.kind === 'unscanned') { skip(got.line); return; }
  if (got.kind === 'red') {
    fail('同一起因有多张 OPEN 单 / 机器单缺起因行', got.line);
    return;
  }
  green(got.line);
}

function checkOpenIssueCount(board) {
  const maxRaw = process.env.DAO_CHECK_OPEN_ISSUE_MAX;
  const max = Number(maxRaw || OPEN_ISSUE_MAX_DEFAULT);
  const r = inspectOpenIssueCount({
    issues: board.issues,
    prs: board.prs,
    worktrees: board.worktrees,
    max,
    maxRaw,
  });
  if (r.kind === 'unscanned') {
    skip(r.line);
    return;
  }
  if (r.kind === 'invalid') {
    fail(r.line, r.howToFix, r.evidence);
    return;
  }
  if (r.kind === 'red') {
    fail(r.line, r.howToFix, r.evidence);
    return;
  }
  green(r.line);
}

/**
 * 机器开的 `[待拍板]` 单堆积（2026-09-06 实咬：堆到 11 张、10 张假警报、无人发现）。
 *
 * 这条盯的是**机器向人求助的速率**，跟上面的 backlog 阈值不是一件事。
 * 「没查成」与「0 张」必须分得开：gh 挂了要 skip，不许当成绿。
 */
function checkPendingBoardBacklog(board) {
  const max = Number(process.env.DAO_CHECK_PENDING_MAX ?? PENDING_BOARD_MAX_DEFAULT);
  if (!Number.isFinite(max) || max < 0) {
    fail('待拍板阈值没查成', `DAO_CHECK_PENDING_MAX 不是非负数: ${process.env.DAO_CHECK_PENDING_MAX}`);
    return;
  }
  const issues = board.issues;
  if (issues.unscanned) {
    skip(`待拍板堆积：gh issue list 没查成（${issues.error}），本次没查成，不是绿`);
    return;
  }
  if (issues.array.some((i) => !i || typeof i.title !== 'string')) {
    fail('待拍板堆积没查成', 'gh issue list 输出形态不对（要带 title 的对象数组）');
    return;
  }
  const pending = issues.array.filter((i) => PENDING_TITLE_RE.test(i.title));
  const n = pending.length;
  if (n > max) {
    const 样 = pending.slice(0, 3).map((i) => `#${i.number}`).join(' ');
    fail(
      `机器开的「待拍板」单堆了 ${n} 张，超阈值 ${max}（${样}…）`,
      '先判每张是不是假警报：假警报要去修产生它的那条判据，不是关掉了事；真要人拍的才留着',
      'gh issue list --state open --limit 500 --json number,title | grep 待拍板',
    );
    return;
  }
  green(`机器开的「待拍板」单 ${n}/${max} 张`);
}

// ── ⑮ 可立即起但没起（#577：规矩不配检查等于没有；本项只可见不报红）────────
// 已消歧 + 无在途 PR/卡 + 没挂「将来某版」→ 打「有 N 个可立即起的单没起」。帅可能有正当理由
// （并发满、真依赖），所以不翻转退出码；今晚的病是它完全不可见。
// 解析在 ready-queue-check.mjs，不复用 ⑭ 的 closesNumbers。
// 并发上限随 #576 落地，本项不发明数字。#576 的 next 接手列表后本项退役。

function checkReadyQueue(board) {
  if (board.issues.unscanned) {
    skip(`可立即起：没查成（issue 面：${board.issues.error}，≠ 扫完是 0）`);
    return;
  }
  if (board.prs.unscanned) {
    skip(`可立即起：没查成（PR 面：${board.prs.error}，≠ 扫完是 0）`);
    return;
  }
  if (board.worktrees.unscanned) {
    skip(`可立即起：没查成（卡面：${board.worktrees.error}，≠ 扫完是 0）`);
    return;
  }
  const r = inspectReadyQueue({
    issues: board.issues.array,
    prs: board.prs.array,
    worktrees: board.worktrees.worktrees,
  });
  if (r.kind === 'unscanned') skip(r.line);
  else if (r.kind === 'zero') green(r.line);
  else notes.push(r.line);
}

// ── ⑰ 账本断流差集（#581）──────────────────────────────────────────
// 判据是集合差不是时钟。样本必须两种都有：有差集必红、无差集必绿。
// 只验一种会把「永远红」或「永远绿」当生效。

function checkLedgerGapSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'ledger-gap');
  if (!existsSync(dir)) {
    fail('账本断流样本目录不在', '本次没查成：恢复 tests/fixtures/ledger-gap/', dir);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    fail('账本断流一套样本都没扫到', '目录空了 ⇒ 本次等于没查', dir);
    return;
  }
  const kinds = { gap: 0, ok: 0 };
  const problems = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch { problems.push(`${f} 不是 JSON`); continue; }
    if (!doc || !Array.isArray(doc.githubPrs) || !Array.isArray(doc.events) || !doc.expect) {
      problems.push(`${f} 缺 githubPrs/events/expect`);
      continue;
    }
    if (doc.expect !== 'gap' && doc.expect !== 'ok') {
      problems.push(`${f} expect 只能是 gap|ok`);
      continue;
    }
    const r = inspectLedgerGap({
      githubPrs: doc.githubPrs,
      closedNumbers: new Set(
        (doc.events || [])
          .filter(e => e && e.type === 'job.closed' && Number.isInteger(e.pr_number))
          .map(e => e.pr_number),
      ),
      baselinePr: doc.baselinePr ?? 0,
      newestBuffer: doc.newestBuffer ?? 0,
    });
    kinds[doc.expect] += 1;
    if (doc.expect === 'gap' && r.kind !== 'gap') {
      problems.push(`${f} 自称有差集但判成 ${r.kind}（样本没判别力）`);
    }
    if (doc.expect === 'ok' && r.kind !== 'ok') {
      problems.push(`${f} 自称无差集但判成 ${r.kind}：${r.line}`);
    }
  }
  if (kinds.gap === 0 || kinds.ok === 0) {
    fail('账本断流样本种类不够', '至少各要一份有差集（expect:gap）和一份无差集（expect:ok），缺一种 = 没查成', `gap=${kinds.gap} ok=${kinds.ok}`);
    return;
  }
  if (problems.length) {
    fail(`账本断流样本对不上 ${problems.length} 处`, '样本的 expect 必须和独立差集核对一致', problems.join(' '));
    return;
  }
  green(`账本断流样本 ${files.length} 份（有差集 ${kinds.gap} / 无差集 ${kinds.ok}）`);
}

function checkStrikesSamples() {
  const root = join(ROOT, 'tests', 'fixtures', 'memory-strikes');
  if (!existsSync(root)) {
    fail('strikes 闸样本目录不在', '本次没查成：恢复 tests/fixtures/memory-strikes/{red,ok}', root);
    return;
  }
  const kinds = { red: 0, ok: 0 };
  const problems = [];
  for (const kind of ['red', 'ok']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const listed = listMemoryEntries(dir);
    if (listed.unscanned) {
      problems.push(`${kind}: ${listed.error}`);
      continue;
    }
    if (listed.entries.length === 0) {
      problems.push(`${kind}: 0 个 md——没查成`);
      continue;
    }
    const base = loadStrikesBaseline(join(dir, 'baseline.json'));
    if (base.unscanned) {
      problems.push(`${kind} 基准: ${base.error}`);
      continue;
    }
    const r = inspectStrikes({
      entries: listed.entries,
      baselineNames: base.files,
      baselineAt: base.baselineAt,
    });
    kinds[kind] += 1;
    if (kind === 'red' && r.kind !== 'red') {
      problems.push(`red/ 自称该红但判成 ${r.kind}（样本没判别力）`);
    }
    if (kind === 'ok' && r.kind !== 'ok') {
      problems.push(`ok/ 自称该绿但判成 ${r.kind}：${r.line}`);
    }
  }
  if (kinds.red === 0 || kinds.ok === 0) {
    fail('strikes 闸样本种类不够', '至少各要一份红（≥2 无闸）和一份绿（有闸/存量豁免），缺一种 = 没查成', `red=${kinds.red} ok=${kinds.ok}`);
    return;
  }
  if (problems.length) {
    fail(`strikes 闸样本对不上 ${problems.length} 处`, '红夹具必须红、绿夹具必须绿', problems.join(' '));
    return;
  }
  green(`strikes 闸样本红/绿各 ${kinds.red}/${kinds.ok}（有判别力）`);
}

function checkStrikesLive() {
  const located = resolveMemoryDir({ root: ROOT, home: defaultHome() });
  if (located.skip) {
    skip(`strikes 闸：${located.error}——本机未接 memory，本次没查成，不是绿`);
    return;
  }
  const listed = listMemoryEntries(located.dir);
  if (listed.unscanned) {
    fail('strikes 闸没查成', 'memory 目录读失败，不是对照过没事', listed.error);
    return;
  }
  if (listed.entries.length === 0) {
    fail('strikes 闸没查成', 'memory 目录里 0 条条目，本次等于没扫', located.dir);
    return;
  }
  const base = loadStrikesBaseline(join(ROOT, 'scripts', 'lib', 'memory-strikes-baseline.json'));
  if (base.unscanned) {
    fail('strikes 闸没查成', '基准文件读失败', base.error);
    return;
  }
  const r = inspectStrikes({
    entries: listed.entries,
    baselineNames: base.files,
    baselineAt: base.baselineAt,
  });
  if (r.kind === 'unscanned') {
    fail('strikes 闸没查成', 'frontmatter 读失败，不是对照过没事', r.error);
    return;
  }
  if (r.kind === 'red') {
    const fixes = [];
    // 缺字段 ≠ 缺闸：strikes=1 的条目补两行就完了，别照着「配闸」去造它不需要的东西。
    if (r.missingFields.length) {
      fixes.push("frontmatter 的 metadata 补两行：strikes: <撞第几次> 和 gate: ''（还没配闸就留空串）");
    }
    if (r.ungated.length) {
      fixes.push('撞满 2 次的这几条要配机械闸（hook/检查器/工具改造/主动注入），把路径写进 metadata.gate');
    }
    fail(r.line, fixes.join('；'), r.violations.join('；'));
    return;
  }
  if (r.notes.length) notes.push(`strikes 存量待补闸 ${r.notes.length}：${r.notes.slice(0, 6).join('；')}`);
  green(r.line);
}

function checkLedgerGapLive() {
  const prs = runGhJson([
    'pr', 'list', '--state', 'merged', '--limit', '1000',
    '--json', 'number,labels',
  ]);
  if (prs.unscanned) {
    skip(`账本断流：gh pr list 没查成（${prs.error}），本次没查成，不是绿`);
    return;
  }
  if (prs.array.some(p => !p || typeof p.number !== 'number')) {
    fail('账本断流没查成', 'gh pr list 输出形态不对（要 number 对象数组）', `拿到 ${typeof prs.array[0]}`);
    return;
  }
  // 账本在本机 ~/.dao/ledger/events（不进 git）；ensureLocalLedger 会把仓内历史事件种子过来
  const eventsDir = ensureLocalLedger({ root: ROOT }).dir;
  const closed = readClosedPrNumbers(eventsDir);
  if (closed.unscanned) {
    fail('账本断流没查成', '本机账本目录（~/.dao/ledger/events）读失败，不是差集空', closed.error);
    return;
  }
  const r = inspectLedgerGap({
    githubPrs: prs.array,
    closedNumbers: closed.numbers,
    baselinePr: LEDGER_GAP_BASELINE_PR,
    newestBuffer: LEDGER_GAP_NEWEST_BUFFER,
  });
  if (r.historicalNote) notes.push(r.historicalNote);
  if (r.kind === 'empty-github') {
    skip(r.line);
    return;
  }
  if (r.kind === 'gap') {
    fail(r.line, '先跑 dianjiangtai-backfill 补存量，或查 flow/dao 为何没写 job.closed', `缺 ${r.missing.map(n => `#${n}`).join(' ')}`);
    return;
  }
  green(r.line);
}

// ── ㉑ 关单不改走 GitHub 自动关键词（#657）──────────────────────────
// 删掉 Closes/Fixes 自动关单：关单只走 scripts/close-issues.mjs（MERGED 且 check 绿才关）。
// 所以凡是会进 PR 正文的 dispatch 任务书模板，再出现 GitHub 关单关键词（Closes # / Fixes #…）就红。
// 自发现扫 host/skills/dispatch/templates/*.md；样本红/绿各一验判别力。

/** 扫正文里 GitHub 关单关键词带单号的形态（Closes #N / Fixes #N / Resolves #N…）。 */
function scanCloseKeyword(txt) {
  const re = /(?:(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#)\s*(\d+)/gi;
  const hits = [];
  let m;
  while ((m = re.exec(String(txt || '')))) hits.push(`#${m[1]}`);
  return hits;
}

function checkNoAutoCloseSamples() {
  const root = join(ROOT, 'tests', 'fixtures', 'close-auto');
  if (!existsSync(root)) {
    fail('关单关键词样本目录不在', '本次没查成：恢复 tests/fixtures/close-auto/{red,ok}', root);
    return;
  }
  const kinds = { red: 0, ok: 0 };
  const problems = [];
  for (const kind of ['red', 'ok']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) { problems.push(`缺 ${kind}/`); continue; }
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    if (files.length === 0) { problems.push(`${kind}: 0 个 md——没查成`); continue; }
    const anyHit = files.map(f => ({ f, hits: scanCloseKeyword(readFileSync(join(dir, f), 'utf8')) }));
    if (kind === 'red' && !anyHit.some(h => h.hits.length)) problems.push('red/ 自称该红但扫不到 Closes #/Fixes #（样本没判别力）');
    if (kind === 'ok' && anyHit.some(h => h.hits.length)) problems.push('ok/ 自称该绿但扫到关单关键词（样本没判别力）');
    kinds[kind] += 1;
  }
  if (kinds.red === 0 || kinds.ok === 0) {
    fail('关单关键词样本种类不够', '至少各要一份红（带 Closes #）和一份绿（只有「署名 issue #N」）', `red=${kinds.red} ok=${kinds.ok}`);
    return;
  }
  if (problems.length) {
    fail(`关单关键词样本对不上 ${problems.length} 处`, '红夹具必须红、绿夹具必须绿', problems[0]);
    return;
  }
  green(`关单关键词样本红/绿各 ${kinds.red}/${kinds.ok}（有判别力）`);
}

function checkNoAutoCloseLive() {
  const dir = join(ROOT, 'host', 'skills', 'dispatch', 'templates');
  if (!existsSync(dir)) {
    fail('dispatch 任务书模板目录不在', '本次没查成：恢复 host/skills/dispatch/templates/', dir);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) {
    fail('dispatch 任务书模板 0 个', '模板清了 ⇒ 本次等于没查（不是扫完 0 违规）', dir);
    return;
  }
  const hits = [];
  for (const f of files) {
    const h = scanCloseKeyword(readFileSync(join(dir, f), 'utf8'));
    if (h.length) hits.push(`${f}: ${h.join(' ')}`);
  }
  if (hits.length) {
    fail(`PR 正文任务书模板出现 GitHub 关单关键词 ${hits.length} 处`, '模板改写「署名 issue #N，关单交给 scripts/close-issues.mjs」，别再用 GitHub 自动关单关键词（关单只认脚本，见 #657）', hits.join('；'));
    return;
  }
  green(`PR 正文任务书模板无 GitHub 关单关键词（${files.length} 个模板）`);
}


// 全量档：活探类检查（gh 盘面、账本对 GitHub、跑子进程要 --help）只在 --full 跑。
//
// 2026-09-06 编排态回岗（用户拍板），原「停派工态门」的话面已删。那道门 2026-08-31 立时
// 说的是「本机不编排，这些活探只贡献网络抖动」；如今 mirasim 派工恢复、指挥官在自动派工，
// 那句话每跑一次就误导一次。**行为上它从来没挡住什么**——这几项本就在 `if (FULL)` 里，
// parked() 只是 else 分支的措辞；删的是过期的理由，不是判据（migration-half-done-breaks-checks
// 的反面教材：状态变了、检查的话面没跟上，人就照着旧话面做判断）。
//
// 离线的样本/接线检查（夹具判别力、模板扫描）一直全跑——它们不花网络，守的约定也还在仓里。
// 档位（影响地图整层已删，测试默认全跑、不采覆盖率）：
//   不带旗标      全部测试 + 不出网                         ← 人和 land.mjs、CI 走这条
//   --all-tests   与默认相同（老调用留下的别名）
//   --full        全部测试 + 打开要出网的那几项             ← 帅位本地要全查时
const FULL = process.argv.includes('--full');
// 要出网的检查只在全量档跑（2026-09-06 实测：飞书群有效性一项 11.3s，占了快检 8.6s 的大头）。
// 判据同「单元测试不许打网络」：慢、飘、不可复现。快档 skip 会如实说「没查」，不是绿。
const netParked = (name, why) => skip(`快档跳过：${name}——${why}（全量档 node scripts/dao-check.mjs --full 才跑）`);

await runTests();
checkSkillFrontmatter();
checkSkillLinksAlive();
checkSecretsNotTracked();
checkResidentBudget();
checkRoutingProvidersToml();
checkRoutingPolicyJson();
checkNextLaunchFixture();
checkModeHookAlive();
checkDispatchGateAlive();
checkMemoryLinkAlive();
checkMasterTitleSamples();
checkCardCommentSamples();
checkOpenIssueCountSamples();
if (FULL) {
  const openBoard = loadOpenBoard();
  checkOpenIssueCount(openBoard);
  checkPendingBoardBacklog(openBoard);
  checkReadyQueue(openBoard);
  checkCauseSlugLive(openBoard);
} else {
  netParked('open 单数量阈值 live', '要打 gh issue list');
  netParked('待拍板堆积', '要打 gh issue list');
  netParked('可立即起但没起', '要打 gh issue list');
  netParked('同一起因只许一张 OPEN 单', '要打 gh issue list');
}
checkCompletionSignalAlive();
checkMarshalIssueIdentityAlive();
checkIssueGatewayAliveNow();
checkLedgerGapSamples();
if (FULL) checkLedgerGapLive(); else netParked('账本断流差集 live', '要拿账本对 GitHub');
checkStrikesSamples();
checkStrikesLive();
checkMachinePathSamples();
checkMachinePathLive();
checkNoAutoCloseSamples();
checkNoAutoCloseLive();
checkDesignExamHarvestSamples();
checkDesignExamHarvestLive();
checkVendorGateSamples();
checkVendorGateLive();
checkLegsSamples();
checkLegsLive();
checkLegCaps();
if (FULL) checkModelLabelNames(); else netParked('model/* label 命名 live', '要打 gh label list');
checkHarvestSamples();
if (FULL) checkHarvestLive(); else netParked('回流段孤儿 live', '要打 gh pr list');
checkInbox();
checkRepoOwnership();
checkGitOwnershipSamples();
checkGitOwnershipLive();
checkInitiatives();
checkEphemeralLifecycle();
checkOrcaRetirement();
checkChainDepth();
checkCompetingPrsSamples();
if (FULL) checkCompetingPrsLive(); else netParked('竞争 PR 闸 live', '要打 gh pr list + 逐个 pr view');
checkNoReviewerRecreateSamples();
checkNoReviewerRecreateLive();
checkOrphanTestSamples();
checkOrphanTestLive();
checkTestExecutorIsolationSamples();
checkTestExecutorIsolationLive();
checkVersionCarrierSamples();
checkVersionCarrierProvenanceSamples();
checkVersionCarrierLive();
checkFeishuGroupsSamples();
if (FULL) checkFeishuGroupsLive();
else netParked('飞书群有效性', '要打飞书 API，实测 11.3s');
checkReleasePolicySamples();
checkReleasePolicyLive();
checkDispatchPolicySamples();
checkDispatchPolicyLive();
checkUnitRestartSamples();
checkUnitRestartLive();
checkFailedUnitsLive();
checkMarshalSelfMergeSamples();
if (FULL) checkMarshalSelfMergeLive(); else netParked('帅位 reviews=0 自合并 live', '要打 gh pr list');
checkBranchProtectionSamples();
checkBranchProtectionCatalog();
checkBranchProtectionLive();

function checkDispatchPolicySamples() {
  const r = inspectDispatchPolicyFixtures(join(ROOT, 'tests', 'fixtures', 'dispatch-policy-check'));
  if (!r.ok) {
    fail(
      r.unscanned ? '派前探策略样本没查成' : '派前探策略样本对不上',
      '恢复 tests/fixtures/dispatch-policy-check/{red,ok,empty}：红=取值越界（含 failuresToTrip:0）必须拦、绿必须过、空={} 没查成',
      r.error || (r.problems || []).join('；'),
    );
    return;
  }
  green(`派前探策略样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkDispatchPolicyLive() {
  const r = inspectDispatchPolicyLive(ROOT);
  if (r.unscanned) {
    fail(
      'dispatch-policy.json 没查成',
      '恢复 docs/dispatch-policy.json；文件不在 / JSON 坏了 / 缺 preflight/hubChat 节 = 没查成，不是过',
      (r.problems || []).join('；'),
    );
    return;
  }
  if (!r.ok) {
    fail(
      `dispatch-policy.json 取值越界 ${(r.problems || []).length} 处`,
      'preflight：enabled/useHealthTable 布尔；timeoutMs 500~60000；maxCandidates 整数 1~12。breaker：windowHours 1–168、failuresToTrip 1–20、cooldownHours 0.25–168、halfOpenProbes 1–5',
      (r.problems || []).join('；'),
    );
    return;
  }
  green('dispatch-policy.json preflight/breaker/commander/hubChat/board 取值合范围');
}

function checkUnitRestartSamples() {
  const r = inspectUnitRestartFixtures({
    exists: (rel) => existsSync(join(ROOT, rel)),
    readdir: (rel) => readdirSync(join(ROOT, rel)),
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
  });
  if (!r.ok) {
    fail(
      r.unscanned ? '常驻 Restart=always 闸样本没查成' : '常驻 Restart=always 闸样本对不上',
      '恢复 tests/fixtures/unit-restart/{red,ok,empty}：红=Type=simple+Restart=on-failure 必须拦、绿必须过、空=没查成',
      r.error || (r.problems || []).join('；'),
    );
    return;
  }
  green(`常驻 Restart=always 闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkUnitRestartLive() {
  const dir = join(ROOT, 'host', 'machine', 'systemd');
  if (!existsSync(dir)) {
    fail('常驻 Restart=always 闸 live 没查成', '恢复 host/machine/systemd/；目录不在 = 没查成，不是 0 个违规', dir);
    return;
  }
  const r = inspectUnitRestartDir({
    dirRel: 'host/machine/systemd',
    readdir: (rel) => readdirSync(join(ROOT, rel)),
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
  });
  if (r.unscanned) {
    fail(
      '常驻 Restart=always 闸 live 没查成',
      'host/machine/systemd/*.service 要扫得到；0 个 = 没查成，不是 0 个违规',
      r.error || '',
    );
    return;
  }
  if (!r.ok) {
    fail(
      `常驻 systemd 缺 Restart=always ${r.violations.length} 个`,
      '非 oneshot 必须 Restart=always（干净退出也要拉起来；RestartPreventExitStatus= 是正当豁免，不影响判定）',
      r.violations.map((v) => `${v.file}: ${v.why}`).join('；'),
    );
    return;
  }
  green(`常驻 Restart=always 闸：扫了 ${r.scanned} 个（常驻 ${r.resident}），0 个违规`);
}

function checkFailedUnitsLive() {
  // 探不到 systemd（Windows / 无 systemctl）→ unknown，不做成绿（本仓硬规矩）。
  const probe = spawnSync('systemctl', ['--failed', '--no-pager', '--plain'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  if (probe.error || probe.status !== 0) {
    skip(`本仓单元有没有挂掉没查成：systemctl --failed 探不到（无 systemd？）${String(probe.error || probe.status || '').slice(0, 120)}`);
    return;
  }
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  // 失败单元的 unit 文件在 /etc/systemd/system（要读得到才判得了归属）。
  const unitTexts = {};
  for (const m of output.matchAll(/^(\S+\.service)\s/gm)) {
    const name = m[1];
    for (const p of [join('/etc/systemd/system', name), join(ROOT, 'host', 'machine', 'systemd', name)]) {
      if (existsSync(p)) { unitTexts[name] = readFileSync(p, 'utf8'); break; }
    }
  }
  // 「跑成过吗」：问配对的 timer 有没有过触发。判不了 → 保守当「没跑成过」（红）。
  const arming = {};
  for (const name of Object.keys(unitTexts)) {
    const base = name.replace(/\.service$/, '');
    const timerPath = join('/etc/systemd/system', `${base}.timer`);
    const hasTimerFile = existsSync(timerPath);
    let timerProps = '';
    if (hasTimerFile) {
      const tp = spawnSync('systemctl', ['show', `${base}.timer`, '-p', 'LastTriggerUSec', '-p', 'LastTriggerUSecRealtime'], {
        encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      timerProps = String((tp && tp.stdout) || '');
    }
    const ever = hasEverRun({ serviceName: name, timerProps, hasTimerFile });
    arming[name] = ever === true;
  }
  const r = classifyFailedUnits({ output, repoRoot: ROOT, unitTexts, arming });
  if (r.state === 'red') {
    fail(`本仓 ${r.failed.length} 个单元挂在 systemctl --failed 里`, r.plain.impact + '；' + r.plain.plan, r.detail);
    return;
  }
  if (r.state === 'unknown') {
    skip(`本仓单元有没有挂掉没查成：${r.detail}`);
    return;
  }
  green(r.detail);
}

function checkMarshalSelfMergeSamples() {
  const r = inspectMarshalSelfMergeFixtures({
    exists: (rel) => existsSync(join(ROOT, rel)),
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
  });
  if (!r.ok) {
    fail(
      r.unscanned ? '帅位 reviews=0 自合并闸样本没查成' : '帅位 reviews=0 自合并闸样本对不上',
      '恢复 tests/fixtures/marshal-selfmerge/{red,ok,empty}.json：红=marshal 自合 reviews=0 必须拦、绿必须过、空=没查成',
      r.error || (r.problems || []).join('；'),
    );
    return;
  }
  green(`帅位 reviews=0 自合并闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkMarshalSelfMergeLive() {
  const listed = runGhJson([
    'pr', 'list', '--state', 'merged', '--limit', '100',
    '--json', 'number,author,mergedBy,reviews',
  ]);
  if (listed.unscanned) {
    skip(`帅位 reviews=0 自合并：gh pr list 没查成（${listed.error}），本次没查成，不是绿`);
    return;
  }
  const r = inspectMarshalSelfMerge({
    prs: listed.array,
    baselinePr: MARSHAL_SELFMERGE_BASELINE_PR,
  });
  if (r.unscanned) {
    skip(r.line);
    return;
  }
  if (r.kind === 'red') {
    fail(
      r.line,
      '判定权不归帅位：reviews=0 的自合并当场红。补独立跨厂审官再合，或把存量交给 marshal-selfmerged-audit',
      (r.violations || []).map((v) => `#${v.number}`).join(' '),
    );
    return;
  }
  green(r.line);
}

function checkBranchProtectionSamples() {
  const r = inspectBranchProtectionFixtures({
    exists: (rel) => existsSync(join(ROOT, rel)),
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
  });
  if (!r.ok) {
    fail(
      r.unscanned ? '合并闸形状样本没查成' : '合并闸形状样本对不上',
      '恢复 tests/fixtures/branch-protection/{red,ok,empty}：红=缺保护/contexts 不对/enforce_admins:true/strict:true 必须拦、绿必须过、空=[] 没查成',
      r.error || (r.problems || []).join('；'),
    );
    return;
  }
  green(`合并闸形状样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkBranchProtectionCatalog() {
  const origin = spawnSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8', windowsHide: true,
  });
  const originSlug = origin.status === 0 ? repoSlugFromRemote(origin.stdout) : null;
  const r = collectManagedReposFromRoot({
    root: ROOT,
    originSlug,
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
  });
  if (r.unscanned) {
    fail(
      '合并闸扫描面没查成',
      'INDEX E 类 / 群映射 / 发布策略 / origin 要扫得出在管仓；0 个 = 没查成，不是 0 个违规',
      r.error || '',
    );
    return;
  }
  if (!r.slugs.length) {
    fail('合并闸扫描面没查成', '扫出 0 个仓（没查成，不是 0 个违规）', '');
    return;
  }
  green(`合并闸扫描面：${r.slugs.length} 个在管仓（不手写名单）`);
}

function checkBranchProtectionLive() {
  const origin = spawnSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (origin.error && origin.error.code === 'ENOENT') {
    skip('合并闸 live：git 不可用（ENOENT）——本次没查成，不是绿');
    return;
  }
  const originSlug = origin.status === 0 ? repoSlugFromRemote(origin.stdout) : null;
  if (!originSlug) {
    fail(
      '合并闸 live 没查成',
      'git remote get-url origin 要能抽出 OWNER/REPO',
      String(origin.stderr || origin.stdout || origin.error || '').trim().slice(0, 160),
    );
    return;
  }
  const r = inspectThisRepoProtection({
    originSlug,
    spawnGh: (args) => {
      const g = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
      return { error: g.error || null, status: g.status, stdout: g.stdout || '', stderr: g.stderr || '' };
    },
  });
  if (r.skip) {
    skip(`合并闸 live：${r.error || '缺 gh / 无权限'}——SKIP 不是绿`);
    return;
  }
  if (r.unscanned) {
    fail(
      '合并闸 live 没查成',
      'gh api repos/.../branches/master 要能跑（contents:read）；连摘要都读不到才是没查成',
      r.error || '',
    );
    return;
  }
  if (!r.ok) {
    fail(
      `本仓 master 合并闸形状不对 ${(r.violations || []).length} 处`,
      'required=["check"]、enforcement_level=non_admins（=enforce_admins:false）；装：node scripts/apply-branch-protection.mjs --repo OWNER/REPO',
      (r.violations || []).map((v) => v.why).join('；'),
    );
    return;
  }
  green(`本仓 master 合并闸形状对（${originSlug}）`);

}

function checkReleasePolicySamples() {
  const r = inspectReleasePolicyFixtures(join(ROOT, 'tests', 'fixtures', 'release-policy-check'));
  if (!r.ok) {
    fail(
      r.unscanned ? 'release-policy 样本没查成' : 'release-policy 样本对不上',
      '恢复 tests/fixtures/release-policy-check/{red,ok,empty}：红=缺 confirm.major 必须拦、绿必须过、空={} 没查成',
      r.error || '',
    );
    return;
  }
  green(`release-policy 样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkReleasePolicyLive() {
  const r = inspectReleasePolicyLive(ROOT);
  if (r.unscanned) {
    fail(
      'release-policy.json 没查成',
      '恢复 docs/release-policy.json；文件不在 / JSON 坏了 / 四个顶层键都没有 = 没查成，不是过',
      r.error || '',
    );
    return;
  }
  if (!r.ok) {
    fail(
      `release-policy.json schema 不过 ${(r.problems || []).length} 处`,
      '四个顶层键 confirm/version/rollback/budget 齐；confirm 三级齐；bump 表覆盖 conventional 类型；每项目 demo 有 kind',
      (r.problems || []).join('；'),
    );
    return;
  }
  green(`release-policy.json 可解析且过 schema（${r.scanned} 项）`);
}

function checkFeishuGroupsSamples() {
  const r = inspectFeishuGroupsFixtures(join(ROOT, 'tests', 'fixtures', 'feishu-groups-check'));
  if (!r.ok) {
    fail(
      r.unscanned ? '飞书群有效性样本没查成' : '飞书群有效性样本对不上',
      '恢复 tests/fixtures/feishu-groups-check/{red,ok,empty}：红=查不到必须拦并点名群、绿必须过、空=0 个 chat_id 没查成',
      r.error || '',
    );
    return;
  }
  green(`飞书群有效性样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkFeishuGroupsLive() {
  const r = checkFeishuGroups({
    root: ROOT,
    home: process.env.HOME || process.env.USERPROFILE || '',
    isCi: process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true',
  });
  if (r.skip) {
    skip(r.skip);
    return;
  }
  if (r.green) {
    green(r.green);
    return;
  }
  fail(...(r.fail || ['飞书群有效性没查成', '见 scripts/lib/feishu-groups-check.mjs', '']));
}

function checkVersionCarrierSamples() {
  const r = inspectVersionCarrierFixtures(join(ROOT, 'tests', 'fixtures', 'version-carrier'));
  if (!r.ok) {
    fail(
      r.unscanned ? '版本号载体闸样本没查成' : '版本号载体闸样本对不上',
      '恢复 tests/fixtures/version-carrier/{red,ok,empty}：红=倒退必须拦、绿必须过、空=无载体 SKIP 不是绿',
      r.error || '',
    );
    return;
  }
  green(`版本号载体闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力；空=SKIP）`);
}

function checkVersionCarrierProvenanceSamples() {
  const r = inspectCarrierProvenanceFixtures(join(ROOT, 'tests', 'fixtures', 'version-carrier-provenance'));
  if (!r.ok) {
    fail(
      r.unscanned ? '版本号载体溯源样本没查成' : '版本号载体溯源样本对不上',
      '恢复 tests/fixtures/version-carrier-provenance/{nonrelease-red,release-ok,unchanged-skip}：非发布提交动版本号必须红、发布提交/tag 上动绿、未变 skip（#800 发布列车）',
      r.error || '',
    );
    return;
  }
  green(`版本号载体溯源样本红/绿/skip 各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.skip}（非发布提交动版本号被拦）`);
}

function checkVersionCarrierLive() {
  const r = inspectLiveAt(ROOT);
  if (r.unscanned) {
    fail('版本号载体闸 live 没查成', 'git merge-base / git show 要能跑；失败不是没问题', r.error || '');
    return;
  }
  if (r.skip) {
    skip('本仓无版本号载体（package.json / VERSION），本项跳过');
    return;
  }
  if (!r.ok) {
    fail(
      '版本号变化不合法或倒退',
      '载体必须是合法 SemVer（含 prerelease/build），且不得比 merge-base 上的号小（不判该不该 bump）',
      (r.problems || []).join('；'),
    );
    return;
  }
  green(`版本号载体闸：${r.scanned} 个载体变化合法、不倒退`);
}

function checkOrphanTestSamples() {
  const r = inspectOrphanTestFixtures(join(ROOT, 'tests', 'fixtures', 'orphan-test'));
  if (!r.ok) {
    fail(
      r.unscanned ? '孤儿测试闸样本没查成' : '孤儿测试闸样本对不上',
      '恢复 tests/fixtures/orphan-test/{red,ok,empty}：红夹具必须抓出孤儿、绿夹具必须绿、空=没查成',
      r.error || '',
    );
    return;
  }
  green(`孤儿测试闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkTestExecutorIsolationSamples() {
  const r = inspectTestExecutorIsolationFixtures(join(ROOT, 'tests', 'fixtures', 'test-executor-isolation'));
  if (!r.ok) {
    fail(
      r.unscanned ? '测试隔离闸样本没查成' : '测试隔离闸样本对不上',
      '恢复 tests/fixtures/test-executor-isolation/{red,ok,empty}：红夹具必须是执行体 env 丢失、绿夹具必须绿、空=没查成',
      r.error || '',
    );
    return;
  }
  green(`测试隔离闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkTestExecutorIsolationLive() {
  const dir = join(ROOT, 'tests');
  const r = inspectTestExecutorIsolationLive({
    dir,
    readdir: readdirSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    join,
  });
  if (r.unscanned) {
    fail('测试隔离闸 live 没查成', 'tests/ 下要有 *.test.js，读失败不是「没有真派工」', r.error || '');
    return;
  }
  if (!r.ok) {
    fail(
      `测试隔离闸 ${r.violations.length} 处真 spawn dispatch`,
      'spawn dao dispatch 必须带 --dry-run；真路径改注入 fake runtime / cliInProc（同进程隔离闸会拦）',
      r.violations.map((v) => `${v.file}: ${v.why}`).join('；'),
    );
    return;
  }
  const runtimeFile = join(ROOT, 'scripts', 'lib', 'mirasim-runtime.mjs');
  const daoFile = join(ROOT, 'scripts', 'dao.mjs');
  if (!existsSync(runtimeFile) || !existsSync(daoFile)) {
    fail(
      '测试隔离闸接线没查成',
      '恢复 scripts/lib/mirasim-runtime.mjs 与 scripts/dao.mjs',
      `runtime=${existsSync(runtimeFile)} dao=${existsSync(daoFile)}`,
    );
    return;
  }
  const wiring = inspectIsolationWiring({
    runtimeSrc: readFileSync(runtimeFile, 'utf8'),
    daoSrc: readFileSync(daoFile, 'utf8'),
  });
  if (wiring.unscanned) {
    fail('测试隔离闸接线没查成', '给齐 runtime/dao 正文再扫', wiring.error || '');
    return;
  }
  if (!wiring.ok) {
    fail(
      `测试隔离闸接线丢了 ${wiring.problems.length} 处`,
      'ensureWorkspace / startSession / cmdDispatchMirasim 都要在真 IO 前过 judgeTestExecutorIsolation',
      wiring.problems.join('；'),
    );
    return;
  }
  green(`测试隔离闸：${r.scanned} 套测试 0 处真 spawn dispatch；runtime/dao 接线在`);
}

function checkOrphanTestLive() {
  const testsDir = join(ROOT, 'tests');
  if (!existsSync(testsDir)) {
    fail('孤儿测试闸 live 没查成', 'tests/ 目录不在', testsDir);
    return;
  }
  const files = readdirSync(testsDir)
    .filter(f => /\.test\.(js|mjs|cjs)$/i.test(f))
    .map(f => `tests/${f}`);
  const r = inspectOrphanTests({
    files,
    readFile: (rel) => readFileSync(join(ROOT, rel), 'utf8'),
    exists: (rel) => existsSync(join(ROOT, rel)),
  });
  if (r.unscanned) {
    fail('孤儿测试闸 live 没查成', 'tests/ 里要有测试文件；读失败单独报', r.error || '');
    return;
  }
  if (!r.ok) {
    fail(
      `孤儿测试 ${r.orphans.length} 处（机制已删，测试没同删）`,
      '删掉这些测试，或把目标文件恢复——退役机制必须同 PR 删测试',
      r.orphans.map(o => `${o.test} → ${o.ref}`).join('；'),
    );
    return;
  }
  green(`孤儿测试闸：${r.scanned} 套测试 ${r.scannedRefs} 处仓内引用全健在`);
}

function checkNoReviewerRecreateSamples() {
  const r = inspectNoReviewerRecreateFixtures(join(ROOT, 'tests', 'fixtures', 'no-reviewer-recreate'));
  if (!r.ok) {
    fail(
      r.unscanned ? '再造审官闸样本没查成' : '再造审官闸样本对不上',
      '恢复 tests/fixtures/no-reviewer-recreate/{red,ok,empty}：红夹具必须红、绿夹具必须绿、空=没查成',
      r.error || '',
    );
    return;
  }
  green(`再造审官闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkNoReviewerRecreateLive() {
  const daoFile = join(ROOT, 'scripts', 'dao.mjs');
  if (!existsSync(daoFile)) {
    fail(
      '再造审官闸 live 扫描缺文件',
      '恢复 scripts/dao.mjs；缺文件 = 没查成',
      `dao=${existsSync(daoFile)}`,
    );
    return;
  }
  const r = inspectNoReviewerRecreate({
    daoSrc: readFileSync(daoFile, 'utf8'),
  });
  if (r.unscanned) {
    fail('再造审官闸 live 没查成', '给齐 dao.mjs 再扫', r.error || '');
    return;
  }
  if (!r.ok) {
    fail(
      `再造审官闸接线丢了 ${r.problems.length} 处`,
      'worker-done 不许 nextReviewerAfter 换厂再造',
      r.problems.join('；'),
    );
  } else {
    green('再造审官闸还在（结算后不造卡、失败不换厂）');
  }
}

function checkDesignExamHarvestSamples() {
  const r = inspectDesignExamHarvestFixtures(join(ROOT, 'tests', 'fixtures', 'design-exam-harvest'));
  if (!r.ok) {
    fail(
      r.unscanned ? '盲考收卷样本没查成' : '盲考收卷样本对不上',
      '恢复 tests/fixtures/design-exam-harvest/{red,ok,empty}：红夹具必须红、绿夹具必须绿、空=没查成',
      r.error || '',
    );
    return;
  }
  green(`盲考收卷样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkDesignExamHarvestLive() {
  const skillFile = join(ROOT, 'host', 'skills', 'design-exam', 'SKILL.md');
  if (!existsSync(skillFile)) {
    fail('盲考收卷 live 扫描缺文件', '恢复 host/skills/design-exam/SKILL.md；缺文件 = 没查成', skillFile);
    return;
  }
  const r = inspectDesignExamHarvestLive({ skillSrc: readFileSync(skillFile, 'utf8') });
  if (r.unscanned) {
    fail('盲考收卷 live 没查成', '给齐 design-exam SKILL 正文再扫', r.error || '');
    return;
  }
  if (!r.ok) {
    fail(
      `盲考收卷纪律丢了 ${r.problems.length} 处`,
      'design-exam 收卷节写死：起灶的这一轮盯 answer.md 收到完；禁止起完等人问；不把帅对话框当监视器',
      r.problems.join('；'),
    );
    return;
  }
  green('盲考收卷纪律还在（起考轮盯产物收到完）');
}

// #888 回流闸：样本三态 + live（近 7 天已合并 PR 里的孤儿回流段）。
function checkHarvestSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'harvest');
  const readJson = (name) => {
    try { return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')); } catch { return null; }
  };
  const r = inspectHarvestFixtures({ readJson });
  if (!r.ok) {
    fail(
      r.unscanned ? '回流闸样本没查成' : '回流闸样本失去判别力',
      '恢复 tests/fixtures/harvest/{red,ok,empty}.json：红必须判红、绿必须干净、空正文必须判没查成',
      r.error || '',
    );
    return;
  }
  green(`回流闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkHarvestLive() {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const got = runGhJson(harvestLiveArgs(since));
  if (got.unscanned) {
    fail('回流段 live 没查成', 'gh 可用再跑（没查成 ≠ 没有孤儿段）', got.error || '');
    return;
  }
  // 覆盖面先判：条数摸到取数上限 = 结果可能被截断 = 没查成。
  // 老版本硬编码 --limit 30，而近 7 天真实 merged PR 已 40 个（2026-09-04 实测），
  // 被截掉的 10 个静默漏报，话面却报「近 7 天全量通过」——把「没查成」显示成「查过没事」。
  const cov = judgeHarvestCoverage(got.array.length);
  if (!cov.ok) {
    fail(
      '回流段 live 没查成（取数可能被截断）',
      `把 HARVEST_LIVE_LIMIT（现 ${HARVEST_LIVE_LIMIT}）抬高或改分页取全；宁可报没查成，不许把部分扫描报成全量通过`,
      cov.error || '',
    );
    return;
  }
  const v = judgeHarvest(got.array);
  if (v.unscanned) {
    fail('回流段 live 没查成', got.array.length ? '取到了 PR 但正文全空——检查 --json 字段与权限' : '', v.error || '');
    return;
  }
  if (v.empty) {
    // 「没有样本」不是「查过没事」：近 7 天一个合并 PR 都没有时，这项没有判据可依。
    skip(`回流段 live：近 7 天（${since} 起）没有已合并 PR，没有样本可判`);
    return;
  }
  const problems = [...v.orphans, ...v.thin];
  if (problems.length) {
    fail(
      `回流段没人接/不合规 ${problems.length} 处`,
      '合并时收口官/帅要接单：段内回写「回流单：#N」或「已回流：<sha>」或「不回流：<原因>」；标题必须是独立的「## 回流」行（#888）',
      problems.slice(0, 6).join(' '),
    );
    return;
  }
  green(`回流段 live：近 7 天 ${v.scanned} 个已合并 PR 全扫到（取数 ${cov.count}/上限 ${cov.limit}，未截断），回流段全有受理证据（${v.accepted.length} 条）`);
}

// §73 四轴腿表：样本三态（红/绿/空=没查成）+ live（合法性 + 与职责树交叉核；单轴裸奔只报不拦）。
function checkLegsSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'legs');
  const readJson = (name) => {
    try { return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')); } catch { return null; }
  };
  const r = inspectLegsFixtures({ readJson });
  if (!r.ok) {
    fail(
      r.unscanned ? '腿表样本没查成' : '腿表样本失去判别力',
      '恢复 tests/fixtures/legs/{red,ok,empty}.json：红必须校出错、绿必须干净、缺节必须判没查成',
      r.error || '',
    );
    return;
  }
  green(`腿表样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkLegsLive() {
  let doc;
  try {
    doc = JSON.parse(readFileSync(ROUTING_POLICY_FILE, 'utf8'));
  } catch (e) {
    fail('腿表 live 没查成', '选型 JSON 读失败', String(e.message || e).split(/\r?\n/)[0].slice(0, 160));
    return;
  }
  const v = validateLegs(doc);
  if (v.unscanned) {
    fail('选型 JSON 没有 轴/腿 节', '§73：四轴腿表是选型真相源的一部分；补 轴 + 腿 节', ROUTING_POLICY_FILE);
    return;
  }
  const c = crossCheckLegsTree(doc);
  const problems = [...v.errors, ...c.errors];
  if (problems.length) {
    fail(
      `腿表校验不过 ${problems.length} 处`,
      '四轴合法组合见 §73；启用职责条目必须有对应在役腿（drop 走 dao leg，别手改一半）',
      problems.slice(0, 8).join(' '),
    );
    return;
  }
  const n = nPlusOneReport(doc);
  const warn = [...c.warnings, ...n.exposures];
  green(`腿表 ${doc.腿.length} 条四轴合法、与职责树互证${warn.length ? `；单轴裸奔 ${n.exposures.length} 处（只报不拦，补腿归 #880 卡 H/B）` : ''}`);
}

// #1145 渠道并发上限字段：在役腿的 `并发上限`。
// **待填不红**（它是故意未配置，且已按保守值 CONSERVATIVE_CAP 收紧，见 channel-concurrency.mjs），
// 但必须**显式列出来**——闸对待填渠道按保守值判满，盘面看不见就没人去填真数。
// **腿节形状坏了才红**（那是没查成，不是「扫完是 0」）。
function checkLegCaps() {
  let doc;
  try {
    doc = JSON.parse(readFileSync(ROUTING_POLICY_FILE, 'utf8'));
  } catch (e) {
    fail('并发上限没查成', '选型 JSON 读失败', String(e.message || e).split(/\r?\n/)[0].slice(0, 160));
    return;
  }
  let validateLegCaps;
  try {
    ({ validateLegCaps } = require('./lib/channel-concurrency.mjs'));
  } catch (e) {
    fail('并发上限校验器加载失败', '修 scripts/lib/channel-concurrency.mjs', String(e.message || e).split(/\r?\n/)[0].slice(0, 160));
    return;
  }
  const v = validateLegCaps(doc && doc.腿);
  if (!v.ok) {
    fail('并发上限没查成', '§#1145：腿节必须是数组；补 腿 节', v.error || ROUTING_POLICY_FILE);
    return;
  }
  if (v.inService === 0) {
    // 「扫完 0 条在役腿」与「没查成」分得开：这里是查成了但一条在役腿都没有，
    // 那样本身就没有判别力（闸没有任何腿可判），按没查成报。
    fail('并发上限失去判别力', '一条在役腿都没扫到 ⇒ 本次等于没查；确认腿节 状态=在役 的条目', ROUTING_POLICY_FILE);
    return;
  }
  if (v.bad.length) {
    fail(
      `并发上限有 ${v.bad.length} 条脏值`,
      '并发上限只许正整数 / "不限" / null（待填）；0、负数、杂串都不是合法上限',
      v.bad.map((b) => `${b.id}=${JSON.stringify(b.value)}`).slice(0, 6).join(' '),
    );
    return;
  }
  if (v.pending.length) {
    // 走 notes 而不是只 green：greens 只在**全绿那一支**才打印（见文件末尾的输出段），
    // 一旦盘面有红项，绿行整批不显示——待填清单就此隐形，没人会去填真数。
    // notes 的「见」行两支都打，这条清单才真的看得见。
    notes.push(`并发上限待填 ${v.pending.length} 条（已按保守值 ${v.conservativeCap} 收紧，**不是**放行）：${v.pending.map((p) => p.id).slice(0, 8).join('、')}${v.pending.length > 8 ? ' …' : ''}\n    填法：docs/model-routing.json 腿节该条的「并发上限」写实测并发数（已验证不限写 "不限"）`);
    green(`并发上限：在役 ${v.inService} 条腿字段齐（待填 ${v.pending.length} 条按保守值 ${v.conservativeCap} 收紧）`);
    return;
  }
  green(`并发上限：在役 ${v.inService} 条腿全部填实（无待填）`);
}

function checkVendorGateSamples() {
  const r = inspectVendorGateFixtures(join(ROOT, 'tests', 'fixtures', 'reviewer-vendor-gate'));
  if (!r.ok) {
    fail(
      r.unscanned ? '同厂硬闸样本没查成' : '同厂硬闸样本对不上',
      '恢复 tests/fixtures/reviewer-vendor-gate/{red,ok,empty}：红夹具必须红、绿夹具必须绿、空=没查成',
      r.error || '',
    );
    return;
  }
  green(`同厂硬闸样本红/绿/空各 ${r.kinds.red}/${r.kinds.ok}/${r.kinds.empty}（有判别力）`);
}

function checkVendorGateLive() {
  const daoFile = join(ROOT, 'scripts', 'dao.mjs');
  const cmdFile = join(ROOT, 'scripts', 'lib', 'dao-cmd.mjs');
  const slotFile = join(ROOT, 'scripts', 'lib', 'dianjiangtai-reviewer-slot.mjs');
  if (![daoFile, cmdFile, slotFile].every(existsSync)) {
    fail(
      '同厂硬闸 live 扫描缺文件',
      '恢复 dao.mjs / dao-cmd.mjs / dianjiangtai-reviewer-slot.mjs；缺文件 = 没查成',
      `dao=${existsSync(daoFile)} cmd=${existsSync(cmdFile)} slot=${existsSync(slotFile)}`,
    );
    return;
  }
  const daoSrc = readFileSync(daoFile, 'utf8');
  // #762 拆分：resolveDispatchConstraints 已移到 dispatch/constraints.mjs，检查器扫它的真相源。
  const constraintsFile = join(ROOT, 'scripts', 'lib', 'dispatch', 'constraints.mjs');
  const r = inspectVendorGateWiring({
    daoSrc,
    cmdSrc: readFileSync(existsSync(constraintsFile) ? constraintsFile : cmdFile, 'utf8'),
    slotSrc: readFileSync(slotFile, 'utf8'),
  });
  if (r.unscanned) {
    fail('同厂硬闸 live 没查成', '给齐源文件再扫', r.error || '');
    return;
  }
  if (!r.ok) {
    fail(
      `同厂硬闸接线丢了 ${r.problems.length} 处`,
      'create/attach/worker-done/换人都要走 assertCrossVendor 或 refuseIfSameVendor，换人跳过工人那一厂（dispatch 预检闸 2026-08-23 已删：审官不存在时查空气）',
      r.problems.join('；'),
    );
    return;
  }
  const noForce = inspectReviewerNoForceCommand({ daoSrc });
  if (noForce.unscanned) {
    fail('审官起法扫描没查成', '给齐 dao.mjs 再扫', noForce.error || '');
    return;
  }
  if (!noForce.ok) {
    fail(
      `审官路径仍写死 forceCommand ${noForce.problems.length} 处`,
      '起法只读 toml start=agent|command；reviewer-create/attach 不要 forceCommand',
      noForce.problems.join('；'),
    );
    return;
  }
  green('起审官同厂硬闸还在（create/attach/worker-done/换人接线齐；dispatch 预检闸已删；审官不写死 forceCommand）');
}

// #895：model/* label 名必须能被 vendorFamilyOf 解析。label 名和家族命名规则对不上
// （实咬：model/opus-5 缺 claude- 前缀）→ 同厂闸永远 unscanned → 那张单永远起不了审官。
// 只查 label 名字，不查有没有单在用——名字留在仓里就还会被下一张单挑上。
function checkModelLabelNames() {
  const listed = runGhJson(['label', 'list', '--limit', '500', '--json', 'name']);
  if (listed.unscanned) {
    skip(`model/* label 命名：gh label list 没查成（${listed.error}）——本次没查成，不是绿`);
    return;
  }
  const r = inspectModelLabelNames({ labelNames: listed.array });
  if (r.unscanned) {
    skip(`model/* label 命名：${r.error}`);
    return;
  }
  if (!r.ok) {
    fail(
      `model/* label 名家族查不出 ${r.bad.length} 个`,
      'label 名改成 model/<家族>-<版本>（gh label edit <旧名> --name <新名>，改名保留已挂的单）；'
      + '或删掉不该在 model/* 命名空间里的（网关/执行面不是模型家族）。家族登记在 scripts/lib/reviewer-vendor-gate.mjs 的 VENDOR_FAMILIES',
      r.bad.join('、'),
    );
    return;
  }
  green(`model/* label 命名与 vendorFamilyOf 一致（${r.scanned} 个全能查出家族）`);
}

function checkMachinePathSamples() {
  const root = join(ROOT, 'tests', 'fixtures', 'machine-paths');
  if (!existsSync(root)) {
    fail('仓外路径闸样本目录不在', '本次没查成：恢复 tests/fixtures/machine-paths/{red,ok,empty}', root);
    return;
  }
  const kinds = { red: 0, ok: 0, unscanned: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const r = checkMachinePaths({ root: dir });
    if (kind === 'red') {
      if (r.kind !== 'red') problems.push(`red/ 自称该红但判成 ${r.kind}`);
      else if (!/brand-new-cli/.test((r.fail || []).join(' '))) problems.push('red/ 没点出 ~/.brand-new-cli');
      else kinds.red += 1;
    } else if (kind === 'ok') {
      if (r.kind !== 'ok') problems.push(`ok/ 自称该绿但判成 ${r.kind}：${(r.fail || []).join(' ')}`);
      else kinds.ok += 1;
    } else if (kind === 'empty') {
      if (r.kind !== 'unscanned') problems.push(`empty/ 自称没查成但判成 ${r.kind}`);
      else kinds.unscanned += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.unscanned === 0) {
    fail('仓外路径闸样本种类不够', '至少各要一份红（漏写新品类）、一份绿、一份 0 条没查成', `red=${kinds.red} ok=${kinds.ok} empty=${kinds.unscanned}`);
    return;
  }
  if (problems.length) {
    fail(`仓外路径闸样本对不上 ${problems.length} 处`, '红夹具必须红、绿夹具必须绿、空夹具必须没查成', problems.join(' '));
    return;
  }
  green(`仓外路径闸样本红/绿/空各 ${kinds.red}/${kinds.ok}/${kinds.unscanned}（有判别力）`);
}

function checkMachinePathLive() {
  const r = checkMachinePaths({ root: ROOT });
  if (r.green) green(r.green);
  else fail(...r.fail);
}

function checkCompletionSignalAlive() {
  const r = checkCompletionSignal({ root: ROOT });
  if (r.green) green(r.green);
  else fail(...r.fail);
}

function checkMarshalIssueIdentityAlive() {
  const r = checkMarshalIssueIdentity({ root: ROOT });
  if (r.green) green(r.green);
  else fail(...r.fail);
}

function checkIssueGatewayAliveNow() {
  const r = checkIssueGatewayAlive({ root: ROOT });
  if (r.green) green(r.green);
  else fail(...r.fail);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const noteBit = notes.length ? `，${notes.length} 条可见` : '';

if (failures.length === 0) {
  for (const g of greens) console.log(`  ok  ${g}`);
  for (const n of notes) console.log(`  见  ${n}`);
  for (const s of skips) console.log(`  SKIP  ${s}`);
  const skipBit = skips.length ? `，${skips.length} 项跳过` : '';
  console.log(`\ndao check: 好的（${greens.length} 项${noteBit}${skipBit}，${secs}s）`);
  process.exit(0);
}

for (const [what, how, evidence] of failures) {
  console.log(`\n  X  ${what}`);
  if (how) console.log(`     修：${how}`);
  if (evidence) console.log(`     ${evidence}`);
}
for (const n of notes) console.log(`  见  ${n}`);
for (const s of skips) console.log(`  SKIP  ${s}`);
console.log(`\ndao check: 不好（${failures.length} 项红 / ${greens.length} 项绿 / ${skips.length} 项跳过${noteBit}，${secs}s）`);
process.exit(1);
