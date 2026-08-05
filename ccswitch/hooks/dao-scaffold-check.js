// dao 脚手架检查 hook — SessionStart · 一条主干 + 一段元仓库专属
//
// 模式命名以本段为准（2026-07-27 统一）：代码里的分节横幅此前把 A/B 写反了——
// 头注写 A=元仓库、B=普通项目，横幅却写 模式B=元仓库、模式A=普通项目，而
// tests/dao-scaffold-check.tests.js 与 docs/specs/dao-growth-loop.md 的裁定文本都按头注这套读。
// 三处里两处一致、代码横幅是那个离群值，故本次把横幅改齐，不动语义。
//
// A) windsurf-dao 元仓库：全面同步漂移检测（双向）
//    - hook 文件 vs settings.json 注册
//    - windsurf-dao 未提交改动（本地领先 → 提醒上行）
//    - windsurf-dao 落后 origin（远程领先 → 提醒下行）
//    - live ~/.claude/settings.json ↔ config-sync 快照 双向漂移 + dao-rule-echo 接线心跳
//      （ccswitch/lib/settings-drift.js；旧版整文件 hash 比较因快照是 DB 导出格式而必然假阳性、
//        已于早前移除，本次以「结构面 + dao 归属过滤」重做，见该文件头注）
//
// B) **所有 git 项目，含元仓库自己**：共性 rule 备案清单逐条求值
//    （另含上面最后一项，从任意项目都能查）
//    ⚠ 2026-07-27 起元仓库不再整体豁免：原来 `basename === "windsurf-dao"` 走完 A 段
//    就 `done()`，B 段一行不跑 ⇒ **检查从不跑到立法者头上，所以没人发现它自己违规**。
//    实测它自身会中两条，其中「根目录无冗余 AI 入口」有个从未写下来的例外
//    （AGENT_GUIDE.md 系刻意保留，dao.md 帅节末行引用它）。现改为：A 段照跑，
//    随后与普通项目走同一条主干，例外逐条写进清单的 `exempt` 字段。
//    （裁定见本仓 `docs/specs/dao-growth-loop.md` §四.6 裁定 B——2026-08-02 由 mousse-cli
//     `docs/ops/` 迁入：一个 dao 级 hook 的裁定真相源此前住在调用方项目里）
//    - 清单在 ccswitch/scaffold-manifest.json，求值器在 ccswitch/lib/scaffold-manifest.js
//    - universal 条目（CLAUDE.md / .claude/rules/ / 无冗余入口 / _tmp 已 gitignore …）无条件查
//    - conditional 条目（桌面端调试基建 / 前端样式路线 / CI 矩阵成本 …）按 when 指纹命中才查
//    - product-type 条目（PR 真机证据三态 …，2026-07-27 加的第四类）只对在 CLAUDE.md 里
//      **自我声明**为「产品型项目」的仓库查——中间态：对所有产品型项目合理、对内部工具仓不合理
//    - 另有两项活跃工作提醒不属备案清单，仍硬编码在本文件：
//      · 活跃 loop（docs/specs/*/STATUS.json mode 非 done/abandoned/archived）
//      · 活跃 plan（docs/plans/*.md 含「待实施/进行中」状态标记）
//
// 发现问题 → 注入 additionalContext。全通过 → 静默退出。
//
// ── 2026-07-27：检查项为什么从代码里搬进 JSON ────────────────────────────────
// 原来「查什么」硬编码在本文件里，加一条共性 rule 要改代码 ⇒ 实际没人加；同期 dao.md 里
// 还并行躺着两条「首次接触项目时静默执行」的文字自检条款（前端样式路线 / 桌面端基建），
// 那是**无标记时刻的自由裁量**，本仓 2026-07-26 遵守率实测该形态携带率 9-24%。两条路都通向
// 同一个结果：共性 rule 写了但不会自然补上。清单化后，加共性项 = 往 JSON 加一条对象，
// 触发时机焊在 SessionStart 上，不依赖任何人记得。
//
// 真相源：windsurf-dao/ccswitch/hooks/dao-scaffold-check.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const cwd = String(input.cwd || process.cwd());
const homeDir = process.env.HOME || process.env.USERPROFILE || "";

// ── 墙钟预算（2026-08-04 · issue #127）──────────────────────────────────────
// 本文件下面那五道检查各自带一个内层超时常量（20s/30s/20s/30s/20s），而本 hook 在
// `~/.claude/settings.json` 里的注册是 `"timeout": 10`（秒）⇒ **每一个内层常量都比外层大**，
// 它们背后的「优雅降级」路径**结构上不可达**：宿主的刀先落下。
//
// 宿主超时会怎样、痕迹在哪不在哪，全是 2026-08-04 实测的，正文在
// `ccswitch/lib/hook-budget.js` 头注（唯一真相源，此处不重述）。只留最要命的一句：
// **被杀时整个进程树一起没、已经写出的 stdout 也作废，而在 agent 的上下文里
// 「超时全灭」与「全绿静默」逐字节相同** —— 而 agent 的上下文正是本 hook 唯一的消费方。
//
// 所以降级不能靠「等某个子进程超时」（够不着），只能靠**自己看表**：预算见底就不起
// 下一个子进程，并把「这一项没跑」明说出来 —— 那条路径在常路上，必然到得了。
//
// 🔴 **这个 require 必须包起来，理由与下面 settings-drift / scaffold-manifest 那两处逐字相同**
// （「加载失败必须响，不许静默吞」），但**代价比那两处高一个数量级**，2026-08-05 的对抗验证
// 拿同目录、同故障、一带保护一不带的两臂量过：
//   · `lib/settings-drift.js` 缺失（**有** try/catch）⇒ hook **exit 0**、送出 2208 字、
//     另外六项照跑，并明说「✗ dao 配置漂移自检器加载失败：…」；
//   · `lib/hook-budget.js` 缺失或语法错（**没有** try/catch）⇒ hook **exit 1**、
//     **stdout 0 字节**、**七项检查一起消失** —— 逐字就是 issue #127 的原话，
//     而它还是全文件**第一个** require，炸得最彻底。
// ⇒ 这个 PR 为了防「整批静默消失」，差一点新开一条通向「整批静默消失」的路。
//
// **退化实现为什么不能像那两处一样「只回一行错误」就算完**：那两处的产物是**报文行**，
// 缺了只是少几行；这一处的产物是**每个子进程的 timeout**，缺了就等于回到 issue #127 的原状
// —— 内层常量全部够不着，一次慢盘就能把七项检查连同报文一起送进宿主的刀口。
// 故这里给一个**保守到底**的最小预算：按本仓当前注册的 10 s 算、起点取进程启动时刻。
// **它是真模块的一份笨副本，这个重复是刻意的**：它只需要「安全」，不需要「准确」——
// 真模块将来更聪明了而这份没跟上，后果只是这条**只在真模块已经坏掉时才走**的路更保守一点，
// 方向仍在安全侧。回归网见 tests/dao-scaffold-check.tests.js「lib 坏掉」那三臂。
function degradedBudgetLib() {
  const FALLBACK_MS = 10000, RESERVE_MS = 1500;
  return {
    resolveRegisteredTimeoutMs() {
      // ⚠️ 措辞刻意**不与** budgetLibErrorLines() 那一行重复（2026-08-05 mutation 实测教训）：
      // 两处原本都写着「墙钟预算模块加载失败」，于是断言 `/墙钟预算模块加载失败/` 会被这一句
      // 满足 —— **三个把那条错误行整个摘掉的变异体因此全部存活**。同一句话出现在两个地方，
      // 等于给夹住其中一个的断言发了一张免死金牌。
      return { ms: FALLBACK_MS, source: "fallback", matched: 0,
        note: "退化内置预算（hook-budget 模块未加载）⇒ 按保守缺省 " + FALLBACK_MS + " ms 算" };
    },
    createBudget(o) {
      const totalMs = Number(o && o.totalMs) > 0 ? Number(o.totalMs) : FALLBACK_MS;
      const startedAt = Date.now() - Math.round(process.uptime() * 1000);
      const deadlineAt = startedAt + totalMs - RESERVE_MS;
      const skipped = [];
      const api = {
        totalMs, reserveMs: RESERVE_MS, startedAt, deadlineAt,
        effectiveMs: deadlineAt - startedAt, skipped,
        left() { return deadlineAt - Date.now(); },
        elapsed() { return Date.now() - startedAt; },
        canAfford(minMs) { return api.left() >= Number(minMs || 0); },
        capFor(wantMs) { return Math.max(1, Math.min(Number(wantMs) || 0, api.left())); },
        skip(what, minMs) {
          skipped.push(what);
          return "⏱ " + what + " **没跑**：宿主预算只剩 " + api.left() + " ms，起它至少要 " +
            minMs + " ms —— **这不是「通过」，是「没测」**（issue #127）";
        },
        unreachableConstants(pairs) {
          const bad = [];
          for (const [name, ms] of pairs || []) if (Number(ms) > api.effectiveMs) bad.push(name + "=" + ms + "ms");
          return bad;
        },
      };
      return api;
    },
  };
}
let budgetLib, BUDGET_LIB_ERROR = "";
try {
  budgetLib = require("../lib/hook-budget");
} catch (e) {
  BUDGET_LIB_ERROR = e && e.message ? e.message : String(e);
  budgetLib = degradedBudgetLib();
}
const HOST_BUDGET = budgetLib.resolveRegisteredTimeoutMs({
  hookFile: __filename,
  home: homeDir,
  hookEventName: input && input.hook_event_name ? String(input.hook_event_name) : "SessionStart",
});
// 测试用的收窄阀：只允许**调小**（取 min）。刻意不做成「想设多大设多大」——
// 那样它就成了一个能让 hook 谎报余量的后门，而谎报余量正是本批要治的病。
const BUDGET_OVERRIDE_MS = Number(process.env.DAO_HOOK_BUDGET_MS) > 0
  ? Number(process.env.DAO_HOOK_BUDGET_MS) : null;
const BUDGET = budgetLib.createBudget({
  totalMs: BUDGET_OVERRIDE_MS ? Math.min(BUDGET_OVERRIDE_MS, HOST_BUDGET.ms) : HOST_BUDGET.ms,
});

// 起一个子进程「至少」要留多少余量。低于它就别起 —— 起了也是白起，还会把余量吃光，
// 最后连报文一起被宿主杀掉（那是最坏结果：既没跑成，也没人知道没跑成）。
// 调参三问（本机 2026-08-04 实测值）：
//   ① 改小会怎样 —— 起一个必然跑不完的子进程，白吃余量，退化回「被宿主杀」那一档；
//   ② 当前值够不够 —— PowerShell 冷起单次实测 444–772 ms，1200 覆盖实测最大值 1.55×；
//      node 类子进程实测 48–139 ms，600 覆盖 4.3×（其中 provider 那道还要再 spawn 一次
//      sqlite3，故不取更小）；
//   ③ 再大一点代价是什么 —— 余量其实还够时提前放弃，制造**假的「没跑」**，
//      而假的「没跑」与真的「没跑」在报文上分不开 ⇒ 不取更大。
const PS_MIN_SLICE_MS = 1200;
const NODE_MIN_SLICE_MS = 600;

// git 子进程的超时。常路上它们只花几十毫秒，但**最坏情况会咬人**：本文件里有 5 处
// git 调用，各 5 秒 ⇒ 一个卡住的 git（锁文件 / 网络盘 / 慢仓）就能单独吃掉 25 秒，
// 是宿主 10 秒预算的两倍半。它们同样走 capFor —— **不因为「平时很快」就放过**，
// 那正是本 issue 一开始被记成「反正现在很快」的那个错。
// **顺带它是 unreachableConstants 的一个活的负控**：5000 < 8500，每次运行都在证明
// 那个自检不是「凡常量都报」。
const GIT_TIMEOUT_MS = 5000;

// 起一个 git 子进程「至少」要留多少余量。调参三问：①改小 → 起一个必然被 SIGTERM 的 git，
// 白吃余量；②当前值够不够 —— 本机 git 类调用实测几十毫秒，200 是它的数倍；
// ③再大一点代价是什么 —— 余量其实还够时提前放弃，制造假的「没跑」。
const GIT_MIN_SLICE_MS = 200;

// ── git 子进程的统一入口（2026-08-05 · 对抗验证 A3）────────────────────────────
// **它存在的唯一理由是不让「没跑」变成静默。** 本文件有 5 处 git 调用，原先各自
// `catch (_) {}`：预算见底时 capFor 会给出 1 ms、子进程立刻被 SIGTERM，而那个异常被吞掉
// ⇒ 报文里那一行（例如「⬆ windsurf-dao 领先 origin 3 个提交」）**整行消失，全文没有任何
// 一处说 git 没跑**。五道 spawn 类检查会喊，这五处不会 —— **那是本批自己新开的一个静默面，
// 与 issue #127 要治的病同型**（「零次」与「这条路不存在」必须分得开）。
//
// **只有「被预算夹死」这一类要出声**，判据取 `code === "ETIMEDOUT"`（本机实测：超时致死是
// `signal="SIGTERM" code="ETIMEDOUT"`；而命令不存在是 `code="ENOENT" signal=null`、
// 非仓库目录是 `status=128 signal=null` —— 两者都不该报）。git 本身失败在常路上是正常结果
// （沙箱里的垃圾 .git、没有 origin、裸目录），报出来只会变噪音，那正是原先 `catch (_) {}` 的本意。
const gitSkips = [];
function gitOut(args, what) {
  if (!BUDGET.canAfford(GIT_MIN_SLICE_MS)) { gitSkips.push(what); return null; }
  try {
    return execFileSync("git", args, {
      encoding: "utf8", timeout: BUDGET.capFor(GIT_TIMEOUT_MS), windowsHide: true,
    }).trim();
  } catch (e) {
    if (e && (e.code === "ETIMEDOUT" || e.signal === "SIGTERM")) gitSkips.push(what);
    return null;
  }
}
function gitSkipLines() {
  if (!gitSkips.length) return [];
  return [BUDGET.skip("git 状态查询（" + gitSkips.join("、") + "）", GIT_MIN_SLICE_MS)];
}

// 墙钟预算模块加载失败时的那一行。**报文里必须有它**，否则「退化跑了」与「正常跑了」
// 在唯一的消费方（agent 的上下文）里又一次不可区分 —— 那就是本批在治的病本身。
function budgetLibErrorLines() {
  if (!BUDGET_LIB_ERROR) return [];
  return ["✗ 墙钟预算模块加载失败：" + BUDGET_LIB_ERROR + "（ccswitch/lib/hook-budget.js）" +
    " —— 已退化为保守内置预算（" + BUDGET.totalMs + " ms），其余检查照跑"];
}

// ── dao 配置自检聚合（新增）──────────────────────────────────────────────────
// live ~/.claude/settings.json ↔ config-sync/common/settings.json 双向漂移 + dao-rule-echo 接线心跳。
// 实测 ~90ms（含一次 node spawn）。挂在本 hook 而非新建 hook：新 hook 要写 live+快照+DB 三处注册，
// 那正是本检测器要治的那笔债 —— 新检查器不该一出生就欠着自己要查的账。
// 加载失败必须响，不许静默吞（反面教材：hookify stop.py 的 finally: sys.exit(0)）。
// 「真实调用」判据取 hook_event_name + transcript_path 双条件（与 dao-rule-echo 同标准）：
// 手工/测试拼的 payload 通常不带 transcript_path ⇒ 默认落到 synthetic，不会把自检染绿。
// 实测教训：初版只看 hook_event_name，接线冒烟时自造的 payload 立刻写出 synthetic:false，
// 等于自己给自己发了「已生效」证明 —— 那正是本检测器要防的病。仍**可被刻意伪造**，见 --selfcheck 盲区。
const isRealHook = !!(input && input.hook_event_name && input.transcript_path);
let daoSelfCheckLines;
try {
  daoSelfCheckLines = require("../lib/settings-drift").hookLines;
} catch (e) {
  const why = e && e.message ? e.message : String(e);
  daoSelfCheckLines = function () { return ["✗ dao 配置漂移自检器加载失败：" + why + "（ccswitch/lib/settings-drift.js）"]; };
}
function selfCheckLines() {
  try { return daoSelfCheckLines({ real: isRealHook, cwd: cwd }) || []; }
  catch (e) { return ["✗ dao 配置漂移自检抛错：" + (e && e.message ? e.message : String(e))]; }
}

// ── 共性 rule 备案清单（数据驱动）──────────────────────────────────────────
// 与 settings-drift 同一手法：加载失败必须响，不许静默吞——一个查漏的检查器
// 自己静默失效，比没有它更糟（它会让人以为"已经有人在查了"）。
let manifestCheck;
try {
  manifestCheck = require("../lib/scaffold-manifest").check;
} catch (e) {
  const why = e && e.message ? e.message : String(e);
  manifestCheck = function () { return { findings: [], errors: ["共性 rule 备案清单求值器加载失败：" + why + "（ccswitch/lib/scaffold-manifest.js）"] }; };
}
// 返回本项目缺失的共性 rule 报文行（含加载/校验错误行）。severity=info 的近似判据
// 加「（建议）」前缀，与确定性缺项区分开——近似判据不该和存在性判据同等语气。
function manifestIssueLines(projectRoot) {
  let res;
  try { res = manifestCheck(projectRoot, process.env.DAO_SCAFFOLD_MANIFEST || null); }
  catch (e) { return ["✗ 共性 rule 备案清单抛错：" + (e && e.message ? e.message : String(e))]; }
  const lines = [];
  for (const err of res.errors || []) lines.push("✗ " + err);
  for (const f of res.findings || []) lines.push(f.severity === "info" ? "（建议）" + f.message : f.message);
  return lines;
}

// ── 条款库结构闸的挂载点（2026-08-01）────────────────────────────────────────
// 「规则集只增不减」那条自带 `触发:verify-all/check-clauses-structure`（2026-08-01 起正文迁
// ccswitch/rules/dao-guard-writing.md，dao.md 反·归留存根+条款名），
// 而那个检查器此前**只存在于 mousse-cli/scripts/** ⇒ dao.md 这个规则集从未被它守过。
// canonical 落在 ccswitch/scripts/check-clauses-structure.ps1 之后，**必须有东西真的调用它**——
// 「文件存在」不是载体，那正是本仓在治的「指向空气的指针」。
//
// 为什么挂在这里（而不是新建 hook / 挂 dao-config-sync）：
//   · 新建 hook 要在 live + 快照 + DB 三处注册，那正是本文件头注写的那笔债；
//   · dao-config-sync 只在用户主动同步时跑，频率低到约等于没挂；
//   · SessionStart 是**元仓库唯一必经**的时刻，与「退役没有触发器」这个病对症。
// 只在**模式 A（cwd 就是 windsurf-dao）**跑：普通项目的条款库路径各不相同、由各自的
// verify-all 管；在别人仓里跑元仓库的 dao.md 既没意义又白付一次 spawn。
//
// 成本照直写：本机实测 3 次 348/350/355ms（`-NoProfile` 冷起 PowerShell + 读 85KB + 正则）。
// **刻意不做 mtime 缓存**：缓存要落一个状态文件，而「状态文件不在 ⇒ 静默跳过」正是这道闸
// 自己要防的病（零检出 ≠ 零存在）。宁可每次付这 350ms。
//
// 输出策略（三态，任一态都**不静默**）：
//   ① 硬闸红 ⇒ 报 FAIL 摘要（结构坏了属「代码错了」，必须现形）
//   ② 绿 + 观察线有待办（候选退役 / 待升格 > 0）⇒ 报一行，让「该退役了吗」被端到眼前
//   ③ 绿且观察线为空 ⇒ 一行不报（常路零噪音）
// 跑不起来 / 拿不到 marker ⇒ 也报一行：**「没解析到」不等于「没问题」**。
//
// ── 扫描面随第二层存根化扩到 ccswitch/rules/（2026-08-01）──────────────────
// dao.md 把「长窗排程 / 派单契约门组 / 写守卫组」三块细则迁进 ccswitch/rules/*.md 之后，
// **8 条带元字段的条款离开了这道闸的射程**——而本闸原先只认缺省目标 dao.md。
// 那正是本闸自己在治的病的又一实例：**条款还在，守它的东西不在了，且台账上看不出来**。
// 故被检对象改为「dao.md + ccswitch/rules/ 下**含 `[n=` 的** .md」。
//
// 「含 `[n=` 才扫」这个前置筛选的两面，照直写：
//   · 好处：dao-longwindow.md 那类**纯流程文件本来就零条款**，直接扫它会恒报 zero-sample 红
//     （闸说的是实话，但对那个文件不是缺陷）⇒ 生下来就吵的检查一定会被静音。
//   · 代价：筛选器是**独立于闸的第二套实现**（这里只做一次朴素 `[n=` 存在性判断），
//     若某个文件的条款被整体删光，它会从被检清单里消失而不是变红。故**必须**把
//     「几个文件 / 其中几个含条款」当成一行普查数打印出来 —— 静默跳过才是那个病，
//     打印出来的跳过不是（同 verify-all 的 SKIPPED 教训：文案骗不到读数的人）。
// 成本：每个被检文件一次 `-NoProfile` 冷起 PowerShell（本机实测单次 ~350ms）。
const CLAUSE_CHECK_TIMEOUT_MS = 20000;

function clauseTargets(daoRoot) {
  const targets = [path.join("ccswitch", "dao.md")];
  const dir = path.join(daoRoot, "ccswitch", "rules");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md"));
  } catch {
    return { targets, total: 0, withClauses: 0 };   // rules/ 不存在 ⇒ 老形态，只检 dao.md
  }
  let withClauses = 0;
  for (const n of names.sort()) {
    let hit = false;
    // v2（批 2 · 台账搬家）：判据从 `[n=` 扩到「台账字段**或**行内 slug」。
    // 台账搬进 clause-ledger.json 之后，一条条款可以只有 `[#…]` 而没有 `[n=` ——
    // 仍按 `[n=` 筛的话，那种文件会**整份从被检清单里消失**，而消失是静默的
    // （正是本函数上面那段注释说的那个代价，只是换了触发方式）。
    try { hit = /\[n=|\[基线:|\[自定@|\[#[^\]\s]+\]/.test(fs.readFileSync(path.join(dir, n), "utf8")); }
    catch { hit = false; }
    if (hit) { targets.push(path.join("ccswitch", "rules", n)); withClauses++; }
  }
  return { targets, total: names.length, withClauses };
}

function clauseStructureLines(daoRoot) {
  const script = path.join(daoRoot, "ccswitch", "scripts", "check-clauses-structure.ps1");
  try {
    if (!fs.existsSync(script)) {
      return ["✗ 条款库结构闸脚本不在：" + script + "（dao.md 那条 `触发:…check-clauses-structure` 现在指向空气）"];
    }
  } catch (e) {
    return ["✗ 条款库结构闸探测失败：" + (e && e.message ? e.message : String(e))];
  }
  if (process.platform !== "win32") {
    // 不静默跳过：这一行让「本平台没跑」与「跑了且通过」区分得开。
    return ["ⓘ 条款库结构闸未跑（非 Windows，本闸是 PowerShell 实现）→ 手动：pwsh ccswitch/scripts/check-clauses-structure.ps1"];
  }
  // 单个被检文件跑一次闸，只解析末行契约（纯 ASCII 键值）。
  // 不去正则匹配中文正文——两个文件之间拿文案当契约，正是「被引用方一改、引用方静默失效」的温床。
  const runOne = (rel) => {
    let out = "", code = 0;
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
    if (rel !== path.join("ccswitch", "dao.md")) args.push("-TargetFile", rel);
    try {
      out = execFileSync("powershell", args, {
        // capFor：把内层常量夹进**剩余**墙钟预算。这一步就是「内层永远先于外层响」的
        // 机器保证 —— 没有它，20000 这个常量在 10 秒的注册下永远等不到（issue #127）。
        encoding: "utf8", timeout: BUDGET.capFor(CLAUSE_CHECK_TIMEOUT_MS), cwd: daoRoot, windowsHide: true,
      });
    } catch (e) {
      // 非零退出走这里（execFileSync 把它当异常抛），stdout 仍挂在 e.stdout 上。
      out = (e && typeof e.stdout === "string") ? e.stdout : "";
      code = (e && typeof e.status === "number") ? e.status : -1;
      if (!out) {
        return { err: "✗ 条款库结构闸跑不起来（" + rel + "）：" + (e && e.message ? e.message : String(e)) +
                      "（手动复核：powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1）" };
      }
    }
    const m = /CLAUSE_STRUCTURE_SUMMARY exit=(\d+) clauses=(\d+) violations=(\d+) notrigger=(\d+) retire=(\d+) promote=(\d+)/.exec(out);
    if (!m) {
      return { err: "✗ 条款库结构闸跑完但没拿到 CLAUSE_STRUCTURE_SUMMARY 末行（" + rel + "，真退出码 " + code +
                    "）→ 契约可能被改坏了，手动跑一次看输出" };
    }
    const [, sExit, sClauses, sViol, , sRetire, sPromote] = m;
    if (sExit !== "0" || code !== 0) {
      const detail = out.split(/\r?\n/).filter((l) => /^\s+- \[/.test(l)).slice(0, 5).join("\n");
      return { fail: "✗ 条款库结构闸 FAIL：" + rel + " 命中 " + sViol + " 处已知失效形态（条款 " + sClauses + " 条）" +
                     (detail ? "\n" + detail : "") };
    }
    return { clauses: Number(sClauses), retire: Number(sRetire), promote: Number(sPromote) };
  };

  const { targets, total, withClauses } = clauseTargets(daoRoot);
  const lines = [];
  let clauses = 0, retire = 0, promote = 0;
  // 这道闸是整个 hook 里最贵的一项，而它的成本**随被检文件数线性长**（每个文件一次
  // PowerShell 冷起）。预算见底时逐个记名跳过，**绝不并进下面那句绿** —— 一份只扫了
  // 一半的扫描面报「零违例」，正是 dao-guard-writing.md「零检出 ≠ 零存在」那条病。
  const notRun = [];
  for (const rel of targets) {
    if (!BUDGET.canAfford(PS_MIN_SLICE_MS)) { notRun.push(rel); continue; }
    const r = runOne(rel);
    if (r.err) { lines.push(r.err); continue; }
    if (r.fail) { lines.push(r.fail); continue; }
    clauses += r.clauses; retire += r.retire; promote += r.promote;
  }
  if (notRun.length) {
    lines.push(BUDGET.skip("条款库结构闸的 " + notRun.length + "/" + targets.length +
      " 个被检文件（" + notRun.join("、") + "）", PS_MIN_SLICE_MS));
  }
  if (lines.length) {
    lines.push("  → 详情：powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1 [-TargetFile <上面那个文件>]");
    return lines;
  }
  if (retire > 0 || promote > 0) {
    return ["ⓘ 条款库观察线（dao.md + rules/ 合计 " + clauses + " 条）：有 " + retire +
            " 条够老了、该问一句「还有用吗」，" + promote +
            " 条观察区候选够格升格 → powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1 看清单" +
            "（**观察线不是硬闸**：它只把判断端到你眼前，不替你决定退役/升格）"];
  }
  // 绿且无待办 ⇒ 常路只留一行普查数。**刻意不做成零输出**：被检文件从 1 个变成多个之后，
  // 「哪些被检了、哪些因零条款没检」必须是可见的，否则下一次有人把条款迁走时又是静默缩面。
  return ["ⓘ 条款库结构闸绿：dao.md + ccswitch/rules/ 含条款的 " + withClauses + "/" + total +
          " 个 .md，合计 " + clauses + " 条，零违例（零条款的纯流程文件不检，故意不报红）"];
}

// ── 死闸检测的挂载点（2026-08-01 · 架构优化 P3）────────────────────────────
// 治的病与上面那道条款闸同源，只是换了个身位：**一个死掉的 hook 与一个全过的 hook，
// 在机器可读通道上完全不可区分**（ctxlint 管这叫「a dead gate silently no-ops」）。
// 而 dao 正在把门控类条款整体往 hook 层迁（P1）——押注越重，这道安全网越必要：
// 迁过去的条款一旦落在死 hook 上，遵守率直接掉到 0，而台账上看起来和「已经 hook 化了」
// 一模一样。本仓同窗刚有过一次实证：`isMetaRepo` 原判据在 worktree 里恒为假，
// 模式 A 整块从未跑过，而它的输出与「跑了且没问题」完全一致。
//
// 为什么挂在这里（理由与上面那道闸逐条相同，不重述）：新建 hook 要在 live + 快照 + DB
// 三处注册，而那正是本文件头注写的那笔债 —— 一道查「谁没挂好」的闸，不该自己先欠一笔注册账。
// 只在**模式 A**跑：它扫的是 `~/.claude/settings.json` + 本仓 `config-sync/common/`
// + cc-switch DB 的 `providers` 表（issue #57 加的第三层，**那才是真正的下发源**），
// 与当前项目是谁无关，在每个项目里各跑一遍只是重复付钱。
//
// 成本：本机实测整跑 ~120ms（其中 ~50ms 是前两层：`.js` 走进程内 vm 解析、零 spawn，
// 只有 module goal 或解析失败的文件才落到权威的 `node --check`；另 ~70ms 是 providers 层
// 的一次 sqlite3 spawn）。仍比上面那道 PowerShell 闸便宜一个数量级。
//
// 输出策略与上面那道闸同构（**四态**，任一态都**不静默**）：
//   ① 红（有死闸 / 自检半边失败 / 跑不起来）⇒ 报摘要 + 前几条明细
//   ② ⚠ providers 层没查成或被显式关掉（exit 2 / providerscan=off）⇒ 报一行
//      —— 它与「查了没事」必须分得开：那一层没查成时，「零死闸」的射程少一层
//   ③ 绿 + 有待办（孤儿 hook / 无法核验条目）⇒ 报一行
//   ④ 绿且无待办 ⇒ 一行普查数（**刻意不做成零输出**：扫描面缩小必须看得见）
// 只解析末行的纯 ASCII 契约，**不去正则匹配中文正文** —— 两个文件之间拿文案当契约，
// 正是「被引用方一改、引用方静默失效」的温床。
// 末行字段是**全字段必配**，缺 providers 两字段即判「契约被改坏」而不是当它没有 ——
// 「脚本比本消费方旧」与「providers 层跑过了」在只读末行的眼里必须长得不一样。
const DEAD_GATES_TIMEOUT_MS = 30000;

// 从报文里捞失败明细：只认 `✗ ` 开头的段落头 + 紧随其后的缩进条目行。
// 不按 `· ` 前缀通吃 —— 孤儿/无法核验两节用的是同一个前缀，通吃会把提示混进红报。
function deadGateFailDetail(out, max) {
  const lines = String(out).split(/\r?\n/);
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < max; i++) {
    if (!/^✗ /.test(lines[i])) continue;
    picked.push("  " + lines[i]);
    for (let j = i + 1; j < lines.length && picked.length < max; j++) {
      if (!/^\s+· /.test(lines[j])) break;
      picked.push("  " + lines[j].trim());
    }
  }
  return picked.join("\n");
}

function deadGateLines(daoRoot) {
  const script = path.join(daoRoot, "ccswitch", "scripts", "check-dead-gates.mjs");
  try {
    if (!fs.existsSync(script)) {
      return ["✗ 死闸检测脚本不在：" + script + "（查死闸的东西自己死了 —— 这一行就是它要报的那种病）"];
    }
  } catch (e) {
    return ["✗ 死闸检测探测失败：" + (e && e.message ? e.message : String(e))];
  }
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [script], {
      encoding: "utf8", timeout: BUDGET.capFor(DEAD_GATES_TIMEOUT_MS), cwd: daoRoot, windowsHide: true,
    });
  } catch (e) {
    // 非零退出走这里（execFileSync 把它当异常抛），stdout 仍挂在 e.stdout 上
    out = (e && typeof e.stdout === "string") ? e.stdout : "";
    code = (e && typeof e.status === "number") ? e.status : -1;
    if (!out) {
      return ["✗ 死闸检测跑不起来：" + (e && e.message ? e.message : String(e)) +
              "（手动复核：node ccswitch/scripts/check-dead-gates.mjs）"];
    }
  }
  const m = /DEAD_GATES_SUMMARY exit=(\d+) hooks=(\d+) dead=(\d+) orphan=(\d+) selfcheck=(ok|fail) unverifiable=(\d+) providers=(\d+) providerscan=(ok|off|uncheckable)/.exec(out);
  if (!m) {
    return ["✗ 死闸检测跑完但没拿到 DEAD_GATES_SUMMARY 末行（真退出码 " + code +
            "）→ 契约可能被改坏了，手动跑一次看输出：node ccswitch/scripts/check-dead-gates.mjs"];
  }
  const [, sExit, sHooks, sDead, sOrphan, sSelf, sUnver, sProviders, sPScan] = m;
  const sumExit = Number(sExit);
  // 末行的 `exit=` 与真退出码**契约上恒等**。不等就是契约坏了，而不是「取一个信一个」——
  // 拿其中一个当准会静默地把另一个的失真吃掉，那正是本闸自己在治的病。
  if (sumExit !== code) {
    return ["✗ 死闸检测末行说 exit=" + sumExit + "，真退出码却是 " + code +
            " —— 两者按契约恒等，说明契约被改坏了：node ccswitch/scripts/check-dead-gates.mjs"];
  }
  // 红（1）优先于没查成（2）：真发现永远比「有一层没查成」更该被端到眼前。
  if (sumExit !== 0 && sumExit !== 2) {
    const why = sDead !== "0"
      ? "有 " + sDead + " 条 hook/permission 指向的脚本已不存在或语法坏掉 —— 它们此刻在宿主里静默 no-op"
      : "检测器自检半边失败（selfcheck=" + sSelf + "）⇒ 此时「零死闸」不可信，先修检测器";
    const detail = deadGateFailDetail(out, 6);
    return ["✗ 死闸检测 FAIL（扫了 " + sHooks + " 条闸）：" + why +
            (detail ? "\n" + detail : "") +
            "\n  → 全量：node ccswitch/scripts/check-dead-gates.mjs"];
  }
  // providers 层没查成 / 被显式关掉 —— **不是「无死闸」**。cc-switch 真正下发的就是那一层，
  // 它没查成时「零死闸」只覆盖 live+快照两层，而那正是 #57 之前的射程缺口本身。
  if (sumExit === 2 || sPScan !== "ok") {
    const head = sPScan === "off"
      ? "providers 层被 --no-providers **显式关掉**（谁改了调用点？本 hook 从不传这个参数）"
      : "providers 层**没查成**：cc-switch DB 读不到 / 无 providers 表 / 零行";
    return ["⚠ 死闸检测：前两层绿（" + sHooks + " 条闸，零死闸），但 " + head +
            " —— 这不是「零死闸」，cc-switch 真正下发的就是那一层。" +
            "看原因：node ccswitch/scripts/check-dead-gates.mjs"];
  }
  const todo = [];
  if (sOrphan !== "0") todo.push(sOrphan + " 个 hook 文件存在但没被任何一层注册（可能是刻意存货，也可能是挂漏了，机器判不出）");
  if (sUnver !== "0") todo.push(sUnver + " 条命令串无法核验（相对路径 / 靠 PATH 解析 ⇒ **不等于核验通过**）");
  if (todo.length) {
    return ["ⓘ 死闸检测绿（" + sHooks + " 条闸 / providers " + sProviders + " 行，零死闸），另有：" + todo.join("；") +
            " → node ccswitch/scripts/check-dead-gates.mjs 看清单"];
  }
  return ["ⓘ 死闸检测绿：live + config-sync 快照 + cc-switch providers（" + sProviders +
          " 行）三层合计 " + sHooks + " 条闸全部指向存在且可载的脚本，孤儿 0、无法核验 0"];
}

// ── always-on 字节预算的挂载点（2026-08-01 · 架构优化 P4）────────────────────
// 上面两道守的是「条款写得对不对」与「守条款的闸自己还活着吗」，这一道守的是**总量**：
// always-on 面只增不减，且**增长是无声的** —— 每次往 dao.md 加一条，谁都看得见那一条，
// 没人看得见「总量又涨了 1.2KB」。与「规则集只增不减是结构必然」同源：立法有天然触发器
// （刚踩坑、正在写复盘），减法没有，所以减法必须由一个每次都会打印的数字来端到眼前。
//
// 为什么挂在这里（理由与上面两道逐条相同，不重述）：新建 hook 要在 live + 快照 + DB
// 三处注册，那正是本文件头注写的那笔债。只在**模式 A** 跑：它量的是元仓库 dao.md +
// 用户级 always-on 面，与当前项目是谁无关，在每个项目里各跑一遍只是重复付钱。
//
// 成本：本机实测整跑 ~90ms（读 4 个文件 + Buffer.byteLength，一次 node spawn；
// 与死闸检测同量级，比 PowerShell 那道条款闸便宜一个数量级）。
//
// 输出策略与上面两道同构（三态，任一态都**不静默**）：
//   ① 红（超限 / 自检半边失败 / 跑不起来 / 契约拿不到）⇒ 报摘要 + **原样带出三个出口**
//   ② 绿 ⇒ 一行普查数（总字节 / 闸值 / 余量 / 作用域档份数）
//   ③ **没有第三态**：这道闸每次都打印一行余量数字。**刻意不设「余量低于 X 才提醒」的
//      阈值常量** —— 那个 X 会变成又一个没人记得依据的魔数，而余量本身就是要被看见的东西。
// 只解析末行的纯 ASCII 契约，**不去正则匹配中文正文**（两个文件之间拿文案当契约，
// 正是「被引用方一改、引用方静默失效」的温床）。
const BUDGET_TIMEOUT_MS = 20000;

function budgetLines(daoRoot) {
  const script = path.join(daoRoot, "ccswitch", "scripts", "check-alwayson-budget.mjs");
  try {
    if (!fs.existsSync(script)) {
      return ["✗ always-on 字节预算闸脚本不在：" + script +
              "（预算闸此刻不存在，而它的沉默与「没超限」在这份报文里长得一样）"];
    }
  } catch (e) {
    return ["✗ always-on 字节预算闸探测失败：" + (e && e.message ? e.message : String(e))];
  }
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [script], {
      encoding: "utf8", timeout: BUDGET.capFor(BUDGET_TIMEOUT_MS), cwd: daoRoot, windowsHide: true,
    });
  } catch (e) {
    // 非零退出走这里（execFileSync 把它当异常抛），stdout 仍挂在 e.stdout 上
    out = (e && typeof e.stdout === "string") ? e.stdout : "";
    code = (e && typeof e.status === "number") ? e.status : -1;
    if (!out) {
      return ["✗ always-on 字节预算闸跑不起来：" + (e && e.message ? e.message : String(e)) +
              "（手动复核：node ccswitch/scripts/check-alwayson-budget.mjs）"];
    }
  }
  const m = /ALWAYSON_BUDGET_SUMMARY exit=(\d+) total=(\d+) limit=(\d+) files=(\d+) headroom=(-?\d+) scoped=(\d+) missing=(\d+) selfcheck=(ok|fail)/.exec(out);
  if (!m) {
    return ["✗ always-on 字节预算闸跑完但没拿到 ALWAYSON_BUDGET_SUMMARY 末行（真退出码 " + code +
            "）→ 契约可能被改坏了，手动跑一次看输出：node ccswitch/scripts/check-alwayson-budget.mjs"];
  }
  const [, sExit, sTotal, sLimit, sFiles, sHead, sScoped, , sSelf] = m;
  // 目标闸值三格（2026-08-02 加）**单独用一条容错正则取，不并进上面那条主契约正则**：
  // 主正则一旦要求这三格存在，遇到旧版脚本就整条匹配不上 ⇒ 走进「契约被改坏了」那一支，
  // 把一个「字段还没有」误报成「契约坏了」。分开取则旧版只是拿不到目标那一行，其余照常。
  // `\btarget=` 的词界是必需的：`overtarget=` 里也含 `target=`，无词界会取错值。
  const mt = /ALWAYSON_BUDGET_SUMMARY[^\r\n]*\btarget=(\d+)[^\r\n]*\bovertarget=(\d+)/.exec(out);
  const sTarget = mt ? mt[1] : null;
  const nOverTarget = mt ? Number(mt[2]) : 0;
  if (sExit !== "0" || code !== 0) {
    const why = sSelf === "fail"
      ? "检测器自检半边失败（selfcheck=fail）⇒ 此时「未超限」不可信，先修检测器"
      : "always-on 面 " + sTotal + " B 超出闸值 " + sLimit + " B（超 " + (0 - Number(sHead)) +
        " B）—— 它涨的不是磁盘，是每一次推理的 attention budget";
    // 出口三行原样带出：一道只会骂人、不给出口的闸必被静音。
    const exits = out.split(/\r?\n/).filter((l) => /^\s{4}[①②③] /.test(l)).slice(0, 3).join("\n");
    return ["✗ always-on 字节预算闸 FAIL：" + why + (exits ? "\n" + exits : "") +
            "\n  → 全量：node ccswitch/scripts/check-alwayson-budget.mjs"];
  }
  // 绿态一行。**2026-08-02 起有两种绿**，必须分得开：
  //   · 真·达标（overtarget=0）
  //   · 过渡期（exit=0 但欠着目标闸值）—— 若与前者共用同一行文案，两档闸值就白分了，
  //     用户会以为「一片绿」而那笔 43KB 的欠账从此不在任何人眼前经过。
  const head = "ⓘ always-on 字节预算：计入 " + sFiles + " 份文件合计 " + sTotal + " B / 闸值 " + sLimit +
               " B，**余量 " + sHead + " B**（另 " + sScoped + " 份带 `paths:` 的作用域档不占配额）";
  if (nOverTarget > 0) {
    return [head +
      "\n  ⚠ **过渡期**：目标闸值 " + (sTarget || "?") + " B（用户 2026-08-02 拍板），当前**欠 " +
      nOverTarget + " B** —— 退出码暂按过渡上限 " + sLimit +
      " B 判。**这不是回归**，是 dao.md 重写批 3（docs/specs/dao-rewrite-202608.md）落地前的预期欠账；" +
      "批 3 完成后删掉 check-alwayson-budget.mjs 的 TRANSITION_CEILING_BYTES 即生效。" +
      "\n  → 现在就按目标判：node ccswitch/scripts/check-alwayson-budget.mjs --strict"];
  }
  return [head + "——目标闸值 " + (sTarget || sLimit) +
          " B 已达标（用户 2026-08-02 拍板），判据见 " +
          "ccswitch/scripts/check-alwayson-budget.mjs 的 LIMIT_BYTES 头注"];
}

// ── memory 指针一致性的挂载点（2026-08-02 · 自上而下审计第 12 件）────────────
// 上面三道守的是**仓里的东西**（条款写得对不对 / 闸活没活 / always-on 总量），
// 这一道守的是**仓外的东西**：`~/.claude/projects/<slug>/memory/*.md`。
//
// 为什么它非挂不可（核验官原话）：「**windsurf-dao 自己的 memory，目前只有在有人跑
// mousse 的 verify-all 时才真的被扫过**」。memory 每次会话自动注入、却**不在任何 git 仓内**
// ⇒ `run-tests.mjs` / 各项目的验证入口 / 本 hook 原先都不覆盖它。并轨之前盘上有两份
// 实现，能跑的那份长在一个项目里；**把判据并进 dao 而不挂投递，只是把「无人执行」搬个家。**
//
// 为什么挂在这里（理由与上面三道逐条相同，不重述）：新建 hook 要在 live + 快照 + DB
// 三处注册。只在**模式 A** 跑，而这一条比前三道更硬：它扫的是**全部项目**的 memory
// （一次跑完 7 个项目），与当前项目是谁无关 —— 在每个项目里各跑一遍是**同一份工作重复 N 遍**。
//
// 成本：本机实测 ~170ms（`--scope=all`，95 份 memory、83 个路径 token；纯 fs.existsSync）。
//
// 输出策略（**四态，任一态都不静默**）：
//   ① 红：模块自身出错 / 契约拿不到 / 末行 exit 与真退出码不等 ⇒ 报摘要
//   ② ⚠ `root=0`：本机没有 memory 根 ⇒ **零可扫，这不是「通过」是「没测」**
//   ③ ⚠ 扫到文件却零 token ⇒ 取词判据失效的信号（与「引用都健康」必须分得开）
//   ④ ⓘ 绿：一行普查数（**刻意不做成「零发现才不打印」** —— 扫描面缩小必须看得见）
// 发现数**永远不判红**：闸位是观察线，理由见被调模块头注「闸位」段（修复目标不在仓里
// ⇒ 硬闸必然永久红 ⇒ 被跳过 ⇒ 连自检那一半也废掉）。
const MEMORY_REFS_TIMEOUT_MS = 20000;

function memoryRefLines(daoRoot) {
  const script = path.join(daoRoot, "ccswitch", "lib", "memory-truth-source.js");
  try {
    if (!fs.existsSync(script)) {
      return ["✗ memory 指针扫描模块不在：" + script +
              "（它的沉默与「memory 都健康」在这份报文里长得一样）"];
    }
  } catch (e) {
    return ["✗ memory 指针扫描探测失败：" + (e && e.message ? e.message : String(e))];
  }
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [script, "--scope=all"], {
      encoding: "utf8", timeout: BUDGET.capFor(MEMORY_REFS_TIMEOUT_MS), cwd: daoRoot, windowsHide: true,
    });
  } catch (e) {
    out = (e && typeof e.stdout === "string") ? e.stdout : "";
    code = (e && typeof e.status === "number") ? e.status : -1;
    if (!out) {
      return ["✗ memory 指针扫描跑不起来：" + (e && e.message ? e.message : String(e)) +
              "（手动复核：node ccswitch/lib/memory-truth-source.js --scope=all）"];
    }
  }
  // 全字段必配：缺字段即判「契约被改坏」，不判「那一格没事」（同 DEAD_GATES_SUMMARY）。
  const m = /MEMORY_REFS_SUMMARY exit=(\d+) scope=(\w+) root=(\d) projects=(\d+) files=(\d+) checked=(\d+) dead=(\d+) declared_dead=(\d+) ambiguous=(\d+) skipped=(\d+) errors=(\d+)/.exec(out);
  if (!m) {
    return ["✗ memory 指针扫描跑完但没拿到 MEMORY_REFS_SUMMARY 末行（真退出码 " + code +
            "）→ 契约可能被改坏了：node ccswitch/lib/memory-truth-source.js --scope=all"];
  }
  const [, sExit, sScope, sRoot, sProjects, sFiles, sChecked, sDead, sDeclDead, sAmb, sSkip, sErr] = m;
  if (Number(sExit) !== code) {
    return ["✗ memory 指针扫描末行说 exit=" + sExit + "，真退出码却是 " + code +
            " —— 两者按契约恒等，说明契约被改坏了：node ccswitch/lib/memory-truth-source.js --scope=all"];
  }
  if (code !== 0 || sErr !== "0") {
    return ["✗ memory 指针扫描自身出错（errors=" + sErr + "，退出码 " + code +
            "）⇒ 此时「零发现」不可信，先修扫描器：node ccswitch/lib/memory-truth-source.js --scope=all"];
  }
  if (sRoot === "0") {
    return ["⚠ memory 指针扫描：本机没有 `~/.claude/projects/` —— **零可扫。这不是「通过」，是「没测」**"];
  }
  if (sFiles !== "0" && sChecked === "0") {
    return ["⚠ memory 指针扫描：扫到 " + sFiles + " 份 memory 却取出 0 个路径 token —— " +
            "**这是取词判据失效的信号，不是「引用都健康」**：node ccswitch/lib/memory-truth-source.js --scope=all"];
  }
  const tail = " → 明细：node ccswitch/lib/memory-truth-source.js --scope=all（观察线，发现数恒不判红）";
  const head = "ⓘ memory 指针一致性（scope=" + sScope + "，含 dao 自己的 memory）：" +
    sProjects + " 个项目 / " + sFiles + " 份 memory / 实判 " + sChecked + " 个路径 token";
  const parts = [];
  if (sDead !== "0") parts.push(sDead + " 处指向空气（其中真相源声明段内 " + sDeclDead + " 处 ⇒ 那几处该修）");
  if (sAmb !== "0") parts.push(sAmb + " 处相对路径没写清相对于谁");
  if (sSkip !== "0") parts.push(sSkip + " 处因项目根不可解析未判（不计入发现，也不算通过）");
  if (!parts.length) {
    return [head + "，零发现。**只说明路径类引用没指向空气**——计数类/行为类陈旧不在射程内。" + tail];
  }
  return [head + "；" + parts.join(" · ") + tail];
}

// ── 预算守门与余量播报（2026-08-04 · issue #127）────────────────────────────
// 判据正文在 ccswitch/lib/hook-budget.js 头注（唯一真相源），这里只放接线。

// 余量够就跑，不够就记一笔「没跑」并如实说出来。
// **刻意不做成「不够也试一试」**：起一个必然被杀的子进程比不起更糟 —— 它会把剩下的
// 余量也吃光，最后连**已经跑完那几项的报文**一起陪葬（宿主超时是整进程树杀，
// 已写出的 stdout 也作废，实测见 hook-budget.js 头注②）。
function runWithinBudget(what, minMs, fn) {
  if (!BUDGET.canAfford(minMs)) return [BUDGET.skip(what, minMs)];
  return fn();
}

function budgetSummaryLines() {
  // 内层常量自检：把「两个文件里互不知情的两个数」变成每次运行都核一遍的关系。
  const overBudget = BUDGET.unreachableConstants([
    ["CLAUSE_CHECK_TIMEOUT_MS", CLAUSE_CHECK_TIMEOUT_MS],
    ["DEAD_GATES_TIMEOUT_MS", DEAD_GATES_TIMEOUT_MS],
    ["BUDGET_TIMEOUT_MS", BUDGET_TIMEOUT_MS],
    ["PROVIDER_HOOKS_TIMEOUT_MS", PROVIDER_HOOKS_TIMEOUT_MS],
    ["MEMORY_REFS_TIMEOUT_MS", MEMORY_REFS_TIMEOUT_MS],
    ["GIT_TIMEOUT_MS", GIT_TIMEOUT_MS],   // 活的负控：它够得着，所以永远不该出现在报文里
  ]);
  const line = "ⓘ hook 墙钟预算：本次已花 " + BUDGET.elapsed() + " ms / 宿主给 " + BUDGET.totalMs +
    " ms（" + HOST_BUDGET.note + "），扣 " + BUDGET.reserveMs + " ms 收尾余量后**余量 " +
    BUDGET.left() + " ms**；本次跳过 " + BUDGET.skipped.length + " 项";
  const tail = [];
  if (HOST_BUDGET.source === "fallback") {
    tail.push("⚠ **这个总预算是猜的**（没在 settings.json 里找到本 hook 的注册）—— 真实 timeout 可能更大也可能更小，" +
      "猜小只会提前降级并明说，猜大会直接撞刀，故按小的猜");
  }
  if (HOST_BUDGET.source === "registered-invalid") {
    tail.push("⚠ **注册里的 timeout 写坏了**，已按保守缺省算（详见上面的来源说明）—— " +
      "不按宿主缺省算是刻意的：一个已知写坏的值不该落到整组假设里最乐观的那一个上");
  }
  if (overBudget.length) {
    // 门限是**有效截止线**（总预算 - 收尾余量），不是总预算本身：capFor 能给出的上限就是前者。
    // 把这个数原样打进报文，读者才复核得了「为什么 30000 在 30 秒预算下仍算够不着」。
    tail.push("内层超时常量 " + overBudget.join("、") + " 都大于**有效截止线 " + BUDGET.effectiveMs +
      " ms**（总预算 " + BUDGET.totalMs + " - 收尾余量 " + BUDGET.reserveMs + "）⇒ 它们是**上限不是承诺**，" +
      "真正生效的是 capFor() 夹出来的剩余预算（issue #127 治的就是这个错觉）");
  }
  return tail.length ? [line + "\n  " + tail.join("\n  ")] : [line];
}

function inject(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context }
  }));
  process.exit(0);
}
function done() { process.exit(0); }

// ══════════════════════════════════════════════════════════════
// 模式 A: windsurf-dao 元仓库 — 全面同步漂移检测
// ══════════════════════════════════════════════════════════════

// 返回漂移行数组（**不 inject 不 exit**）。原版直接 inject + exit(0)，那是元仓库
// 整体豁免的另一半：一旦有漂移就抢先注入并退出，后面的清单求值永远到不了。
// 改成返回值后，调用方把它与清单缺项拼在同一次注入里。
// ── per-provider 漂移的挂载点（2026-08-02 · hooks=issue #50 · deny=issue #56）───
// 治的是什么病：上面第 6 项（settings-drift）比的是 live ↔ git 快照，而 #49 的实测
// 把数据流图补上了一层——**cc-switch 真正下发的是 `providers` 表里当前 provider 那一行的
// `settings_config`，而且是整体覆盖**。于是每个 provider 各带一份自己的 hooks 段，
// 切一次 provider 就可能把一个钩子静默抹掉（#49 里 PostCompact 就是这么没的）。
// 2026-08-02 那次是**手动**把两个 provider 对齐的：新 provider 加入、或某个 provider
// 被单独改一次，漂移必然复发，而**当时没有任何机制会发现它**。
//
// **「整体覆盖」对 `settings_config` 里的每一个键都成立，不是 hooks 专有**（issue #56）：
// `permissions.deny` 同样逐 provider 各存一份，而 Grep-first 铁律的落地面就在里面。
// 它少一条的后果比少一个 hook 更隐蔽——hook 没了会有人察觉行为变了，deny 少一条只是
// 那道闸从此放行。故这道检查现在报**两个面**，本函数分面陈述、不合并成一句话。
//
// 为什么挂在这里（理由与上面三道逐条相同，不重述）：新建 hook 要在 live + 快照 + DB
// 三处注册，而那正是本文件头注写的那笔债。只在**模式 A** 跑：它读的是 cc-switch DB
// 与本仓 config-sync 快照，与当前项目是谁无关，在每个项目里各跑一遍只是重复付钱。
//
// 为什么走 spawn 而不是像第 6 项那样进程内 require：读 DB 要 `config-sync/lib/sqlite.mjs`
// （ESM + spawn sqlite3），把它拉进这条同步 CJS 路径要让整个 hook async 化。
// 与 deadGateLines 同一手法、同一理由。
//
// 成本：本机实测整跑 ~300ms（一次 node spawn + 一次 sqlite3 spawn）。是这几道里最贵的一道，
// 故超时给足并单列——超时**不静默**，报成「没查成」。
//
// 输出策略三态，任一态都不静默（与上面几道同构）：
//   ① exit 1（有漂移 / 自检半边失败）⇒ 报摘要 + 前几条明细
//   ② exit 2（没查成：DB 读不到 / 零可比对 provider / canonical 缺）⇒ 报一行 ⚠
//      —— **它与「查了没事」必须分得开**，这正是这道闸自己在治的病
//   ③ exit 0 ⇒ 一行普查数（刻意不做成零输出：扫描面缩小必须看得见）
// 只解析末行的纯 ASCII 契约，不去正则匹配中文正文。
const PROVIDER_HOOKS_TIMEOUT_MS = 30000;

function providerHookLines(daoRoot) {
  const script = path.join(daoRoot, "ccswitch", "lib", "settings-drift.js");
  try {
    if (!fs.existsSync(script)) {
      return ["✗ per-provider hooks 检查脚本不在：" + script];
    }
  } catch (e) {
    return ["✗ per-provider hooks 检查探测失败：" + (e && e.message ? e.message : String(e))];
  }
  let out = "", code = 0;
  try {
    out = execFileSync(process.execPath, [script, "--providers"], {
      encoding: "utf8", timeout: BUDGET.capFor(PROVIDER_HOOKS_TIMEOUT_MS), cwd: daoRoot, windowsHide: true,
    });
  } catch (e) {
    out = (e && typeof e.stdout === "string") ? e.stdout : "";
    code = (e && typeof e.status === "number") ? e.status : -1;
    if (!out) {
      return ["⚠ per-provider hooks 检查跑不起来：" + (e && e.message ? e.message : String(e)) +
              "（**不等于无漂移**。手动复核：node ccswitch/lib/settings-drift.js --providers）"];
    }
  }
  const m = /PROVIDER_HOOKS_SUMMARY exit=(\d+) providers=(\d+) scoped=(\d+) drift=(\d+) cross=(\d+) selfcheck=(ok|fail) uncheckable=(\d+)/.exec(out);
  if (!m) {
    return ["✗ per-provider hooks 检查跑完但没拿到 PROVIDER_HOOKS_SUMMARY 末行（真退出码 " + code +
            "）→ 契约可能被改坏了：node ccswitch/lib/settings-drift.js --providers"];
  }
  const [, sExit, , sScoped, sDrift, sCross, sSelf] = m;
  // deny 面（issue #56）单独解析：**刻意不并进上面那条必需正则**。若把它设为必需，
  // 一个比本 hook 旧的 lib 会让整条检查报「契约被改坏了」——那是一句假话（契约没坏，
  // 只是还没长出这个字段），而假的红比没有红更糟。拿不到就如实说拿不到。
  const md = /denyDrift=(\d+) denyCross=(\d+) denySampled=(\d+)/.exec(out);
  const denyDrift = md ? Number(md[1]) : null;
  const denyCross = md ? Number(md[2]) : null;
  const denySampled = md ? md[3] === "1" : null;
  // 这一条只在「本来要报绿」时才有意义，故不在这里 return，只备着往下拼。
  const denyTail = md === null
    ? "；⚠ 末行没有 deny 面字段（lib 比本 hook 旧？）⇒ **permissions.deny 这一面本次没被报出来**"
    : (denySampled === false
      ? "；ⓘ deny 面零样本：provider 与 canonical 里一条 permissions.deny 都没有 ⇒ 那一面什么都没比到（不是「已对齐」）"
      : "；deny 规则逐条一致（" + sScoped + " 个 provider 与应注册清单）");

  if (sExit === "2") {
    return ["⚠ per-provider 漂移检查**没查成**（uncheckable）：cc-switch DB 读不到 / 没有可比对的 provider / canonical 缺" +
            " —— 这不是「无漂移」（hooks 与 permissions.deny 两面都没查成）。看原因：node ccswitch/lib/settings-drift.js --providers"];
  }
  if (sExit !== "0" || code !== 0) {
    // 分面陈述：把 deny 的差异塞进「hooks 段不一致」那句话里就是**说错话**——
    // deny 全对齐而 hooks 漂了、或反过来，是两个不同的现场，处置也不同。
    const reasons = [];
    if (sSelf === "fail") reasons.push("检测器自检半边失败 ⇒ 此时「零漂移」不可信，先修检测器");
    if (Number(sDrift) > 0 || Number(sCross) > 0) {
      reasons.push("各 provider 的 **hooks** 段已经不一致了（与应注册清单差 " + sDrift + " 条、provider 互相之间差 " +
        sCross + " 个 hook）—— 切到缺的那一侧，那些 hook 当场静默消失");
    }
    if (denyDrift > 0 || denyCross > 0) {
      reasons.push("各 provider 的 **permissions.deny** 已经不一致了（与应注册清单差 " + denyDrift +
        " 条、provider 互相之间差 " + denyCross + " 条规则）—— deny 是安全护栏（Grep-first 那几条就住在这里），" +
        "切到缺的那一侧，那道闸从此放行且没有任何输出会提到它");
    }
    if (!reasons.length) reasons.push("退出码非 0 但末行未点明是哪一面（真退出码 " + code + "）");
    const detail = String(out).split(/\r?\n/).filter((l) => /^\s+· /.test(l)).slice(0, 4).map((l) => "  " + l.trim()).join("\n");
    return ["✗ per-provider 漂移：" + reasons.join("；且 ") + (detail ? "\n" + detail : "") +
            "\n  → 全量：node ccswitch/lib/settings-drift.js --providers（**只读，对齐动作归人**）"];
  }
  return ["ⓘ per-provider 漂移检查绿：" + sScoped + " 个 claude 型 provider 的 dao hook 段互相一致、且与应注册清单一致" + denyTail];
}

function daoSyncLines() {
  const daoRoot = cwd;
  const drifts = [];

  // 1. Hook 文件 vs settings.json 注册
  // fortify2-20260726 D5：原判据 `.filter(f => f.endsWith(".js"))` 只认 .js 扩展名，
  // 是「写了没挂」两案（marshal-guard.mjs 14 天 / compact-log.js 6 周）都能存活 14 天+
  // 未被本检测器发现的共同根因——.mjs 文件、无扩展名文件（如曾经的 dao-commit-msg）
  // 全部落在过滤器盲区外，从未进入过 hookFiles 数组，也就永远不会被判「未注册」。
  // 改按 dao- 前缀识别（不限扩展名），并显式列出「像 hook 却不该被当 hook 查」的白名单
  // （逐条注明原因，而不是放宽判据到失去意义）。
  try {
    const hooksDir = path.join(daoRoot, "ccswitch", "hooks");
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    // 已知非 Claude-hook 注册项的 dao-* 文件（原因见各条）。不满足「dao- 前缀」的文件
    // 本就不会进 hookFiles——本名单只处理「像 hook 却不是」的例外，不是放宽判据的后门。
    // 当前为空：D5 修复当时曾正确捕获 ccswitch/hooks/dao-commit-msg（无扩展名、确实未注册）
    // 这一真发现，随即在 D6 里删除了该死文件本身，故无需白名单条目。
    const NON_HOOK_FILES = new Set([]);
    if (fs.existsSync(hooksDir) && fs.existsSync(settingsPath)) {
      const settingsRaw = fs.readFileSync(settingsPath, "utf8");
      const hookFiles = fs.readdirSync(hooksDir)
        .filter(f => f.startsWith("dao-") && !NON_HOOK_FILES.has(f))
        .map(f => f.replace(/\.(js|mjs|cjs)$/, ""));
      const unregistered = hookFiles.filter(name => !settingsRaw.includes(name));
      if (unregistered.length > 0) {
        drifts.push("⬇ Hook 未注册：" + unregistered.join(", ") + " → 需注册到 settings.json（或若确非 hook，加入 NON_HOOK_FILES 白名单并注明原因）");
      }
    }
  } catch (_) {}

  // 2. settings.json / mcp_servers.json 快照比较已移除
  // 原因：config-sync/common/settings.json 是 cc-switch DB 导出格式（含 source/rows 结构
  // + ${HOME}/${PROJECT_ROOT} 占位符），与 ~/.claude/settings.json 结构完全不同，
  // simpleHash 比较永远不同 → 假阳性。git 状态检查已覆盖漂移检测。

  // 3. windsurf-dao 未提交改动（走 gitOut：预算夹死时会出声，不再静默少一行）
  {
    const status = gitOut(["-C", daoRoot, "status", "--porcelain"], "未提交改动");
    if (status) {
      const changedCount = status.split(/\r?\n/).length;
      drifts.push("⬆ windsurf-dao 有 " + changedCount + " 个未提交改动 → 考虑提交并上行同步");
    }
  }

  // 5. windsurf-dao 落后 origin（用 last fetch 数据，不联网）
  {
    const behind = gitOut(["-C", daoRoot, "rev-list", "--count", "HEAD..origin/master"], "落后 origin");
    if (behind !== null && parseInt(behind, 10) > 0) {
      drifts.push("⬇ windsurf-dao 落后 origin " + behind + " 个提交 → 运行 dao.bat 下行同步");
    }
    const ahead = gitOut(["-C", daoRoot, "rev-list", "--count", "origin/master..HEAD"], "领先 origin");
    if (ahead !== null && parseInt(ahead, 10) > 0) {
      drifts.push("⬆ windsurf-dao 领先 origin " + ahead + " 个提交 → 考虑 git push 或 dao.bat --direction=up");
    }
  }

  // 6. live settings ↔ git 快照 双向漂移 + dao-rule-echo 接线（新增）
  for (const line of selfCheckLines()) drifts.push(line);

  // 7. 条款库结构闸（2026-08-01 挂载，判据与三态输出策略见 clauseStructureLines 头注）。
  //    只在元仓库跑；它守的是 ccswitch/dao.md 自己，而 dao.md 此前从未被任何闸守过。
  for (const line of clauseStructureLines(daoRoot)) drifts.push(line);

  // 8. 死闸检测（2026-08-01 挂载 · 架构优化 P3，判据见 deadGateLines 头注）。
  //    上一项守「条款写得对不对」，这一项守「守条款的那些闸本身还活着吗」。
  for (const line of runWithinBudget("死闸检测", NODE_MIN_SLICE_MS, () => deadGateLines(daoRoot))) drifts.push(line);

  // 9. always-on 字节预算（2026-08-01 挂载 · 架构优化 P4，判据见 budgetLines 头注）。
  //    前两项守「写得对不对」与「闸活没活」，这一项守**总量**——它是三者里唯一
  //    每次都打印一个数字的，因为减法没有天然触发器。
  for (const line of runWithinBudget("always-on 字节预算闸", NODE_MIN_SLICE_MS, () => budgetLines(daoRoot))) drifts.push(line);

  // 10. per-provider 漂移（2026-08-02 挂载 · hooks=#50 / permissions.deny=#56，
  //     判据见 providerHookLines 头注）。第 6 项比的是 live ↔ git 快照，而 #49 实测证明
  //     **真正的下发源是 `providers.settings_config`**，那一层此前无人看着。
  for (const line of runWithinBudget("per-provider 漂移检查", NODE_MIN_SLICE_MS, () => providerHookLines(daoRoot))) drifts.push(line);

  // 11. memory 指针一致性（2026-08-02 挂载 · 自上而下审计第 12 件，判据见 memoryRefLines 头注）。
  //     前十项守的都是**仓里的东西**；这一项是唯一一个守仓外的 —— memory 每次会话注入、
  //     却不受任何 git 管，此前只有某个项目的 verify-all 才会碰它。
  for (const line of runWithinBudget("memory 指针扫描", NODE_MIN_SLICE_MS, () => memoryRefLines(daoRoot))) drifts.push(line);

  // 12. 预算余量本身（2026-08-04 · issue #127）。**每次都打印一行数字**，理由与第 9 项
  //     的 always-on 字节预算逐条相同：这里的成本也是**只增不减**（rules/ 每长出一份
  //     带条款的 .md 就多一次 PowerShell 冷起），而增长是无声的 —— 没人看得见「又慢了
  //     600 ms」，直到某天整个 hook 连同全部检查一起被宿主静默杀掉。
  //     **刻意不设「余量低于 X 才提醒」的阈值**：那个 X 会变成又一个没人记得依据的魔数。
  //     ⚠ 三行的次序是有意的：**先报「谁没跑」，再报余量数字**（gitSkipLines 必须排在
  //     budgetSummaryLines 之前 —— 后者要打印 `BUDGET.skipped.length`，而 git 那一笔
  //     是在前面记进去的，顺序颠倒会让汇总行少数一项）。
  for (const line of budgetLibErrorLines()) drifts.push(line);
  for (const line of gitSkipLines()) drifts.push(line);
  for (const line of budgetSummaryLines()) drifts.push(line);

  return drifts;
}

// ══════════════════════════════════════════════════════════════
// 模式 B: 所有 git 项目（含元仓库）— 共性 rule 备案清单
// ══════════════════════════════════════════════════════════════

// **元仓库按内容签名识别，不按目录名**（2026-08-01 修）。
// 原判据是 `path.basename(cwd) === "windsurf-dao"`，它在**任何 worktree 里都为假**
// （`windsurf-dao-wt-slim` / `windsurf-dao-wt-xxx` 之类）⇒ 模式 A 整块在 worktree 会话里
// **从未跑过**：同步漂移、live↔快照自检、以及 2026-08-01 才挂上的条款库结构闸，全部静默跳过。
// 而它的输出与「跑了且没问题」**完全一样**——正是本仓反复在治的那个病
// （「没跑的闸」与「过了的闸」在台账上长得一样）。第一次发现是因为在 worktree 里
// 给条款闸扩扫描面后，实测 hook 只花了 0.16s：PowerShell 根本没被 spawn 过。
// 签名取两个文件同时存在，比单文件稳（普通项目不会同时有这两个）。
// **两个信号取或，不是取代**：旧的 basename 判据留着——它对主仓仍然成立，去掉它等于
// 用一个新判据换掉一个已验证的判据，而本次要修的是「漏判」不是「误判」。
// 取或的方向是**更宽**，所以不可能让原先跑得起来的场景反而跑不起来。
const isMetaRepo = (() => {
  if (path.basename(cwd) === "windsurf-dao") return true;
  try {
    return fs.existsSync(path.join(cwd, "ccswitch", "dao.md")) &&
           fs.existsSync(path.join(cwd, "ccswitch", "scaffold-manifest.json"));
  } catch (_) { return false; }
})();

// 跳过非 git 项目。元仓库按上面的内容签名识别，不受此闸约束——否则「目录里没有 .git」
// 这种异常态会连同步漂移一起静默掉，而那正是最该报的时候。
if (!isMetaRepo) {
  try {
    if (!fs.existsSync(path.join(cwd, ".git"))) done();
  } catch (_) { done(); }
}

const issues = [];
const daoSync = isMetaRepo ? daoSyncLines() : [];

// 非元仓库时顺带检查 windsurf-dao 的同步状态（从任意项目都能检测）。
// 元仓库自己不走这一路：daoSyncLines() 已是同一检测的完整版，两路都跑会重复报。
if (!isMetaRepo) checkDaoDrift();

// 1. 共性 rule 备案清单逐条求值（原「CLAUDE.md / .claude/rules/ / 冗余入口 / docs 分裂 /
//    PRD 位置 / 桌面端调试基建」六组硬编码检查全部迁入 ccswitch/scaffold-manifest.json，
//    另新增 _tmp gitignore、前端样式路线、前端测试入口、CI 矩阵成本、design/CONTEXT.md）。
//    加共性项改清单不改这里。
for (const line of manifestIssueLines(cwd)) issues.push(line);

// ── 活跃工作检测（loop + plan） ──

const activeWork = [];

// 6. 活跃 loop：docs/specs/*/STATUS.json mode 非 done/abandoned/archived
try {
  const specsDir = path.join(cwd, "docs", "specs");
  if (fs.existsSync(specsDir) && fs.statSync(specsDir).isDirectory()) {
    for (const topic of fs.readdirSync(specsDir)) {
      if (topic.startsWith("_")) continue;
      const statusFile = path.join(specsDir, topic, "STATUS.json");
      try {
        if (!fs.existsSync(statusFile)) continue;
        const st = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (st.mode && st.mode !== "done" && st.mode !== "abandoned" && st.mode !== "archived") {
          const summary = st.summary || topic;
          const thread = st.thread ? "（" + st.thread + "线）" : "";
          activeWork.push("Loop [" + topic + "] " + summary + " — mode: " + st.mode + thread);
        }
      } catch (_) {}
    }
  }
} catch (_) {}

// 7. 活跃 plan：docs/plans/*.md 含待实施/进行中状态标记（跳过 _legacy/）
try {
  const plansDir = path.join(cwd, "docs", "plans");
  if (fs.existsSync(plansDir) && fs.statSync(plansDir).isDirectory()) {
    const activePatterns = /\*{0,2}状态\*{0,2}\s*[：:]\s*.*(待实施|进行中|draft|active|wip|in.?progress)/i;
    for (const f of fs.readdirSync(plansDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const head = fs.readFileSync(path.join(plansDir, f), "utf8").slice(0, 1000);
        const match = head.match(activePatterns);
        if (match) {
          const titleMatch = head.match(/^#\s+(.+)/m);
          const title = titleMatch ? titleMatch[1].trim() : f;
          activeWork.push("Plan [" + f + "] " + title + " — " + match[0].trim());
        }
      } catch (_) {}
    }
  }
} catch (_) {}

// ── 汇总输出 ──

if (issues.length === 0 && activeWork.length === 0 && daoSync.length === 0) done();

const parts = [];
if (daoSync.length > 0) {
  parts.push(
    "【dao 同步漂移检测】windsurf-dao 存在以下同步差异：\n" +
    daoSync.join("\n") +
    "\n⬇=远程/快照领先本地（需下行） ⬆=本地领先远程/快照（需上行）。" +
    "请在回答末尾简洁提醒用户。"
  );
}
if (issues.length > 0) {
  parts.push(
    "【dao 脚手架检查】本项目存在以下结构问题（共性 rule 备案清单 ccswitch/scaffold-manifest.json 逐条求值所得），" +
    "请在回答用户问题后追加提醒：\n" +
    issues.map((s, i) => (i + 1) + ". " + s).join("\n") +
    "\n「（建议）」前缀者为近似判据（子串/入口级），不当硬判定；详细模板参考 dao-project-scaffold skill。" +
    "\n补齐入口：`/dao-project-scaffold --init`——带 canonical 的缺项零编辑物化，其余给指引，" +
    "删除/搬移类只建议不代做；随时复核跑 `node <dao 根>/ccswitch/scripts/dao-scaffold-report.mjs`（0=零缺项 / 1=有缺项 / 2=没查成）。" +
    "提醒语气简洁友好，不阻塞用户当前任务。"
  );
}
if (activeWork.length > 0) {
  parts.push(
    "【活跃工作提醒】本项目有未完成的 loop/plan，请在回答用户问题后主动提醒：\n" +
    activeWork.map((s, i) => (i + 1) + ". " + s).join("\n") +
    "\n提醒用户当前进度和可能的下一步，语气简洁，不阻塞当前任务。"
  );
}
inject(parts.join("\n"));

// ── 从任意项目检测 windsurf-dao 同步漂移 ──
function checkDaoDrift() {
  try {
    // 通过 hook 自身路径定位 windsurf-dao
    const daoRoot = path.resolve(__dirname, "..", "..");
    if (!fs.existsSync(path.join(daoRoot, "ccswitch"))) return;

    const driftItems = [];

    // settings.json 快照 vs 部署比较已移除（快照是 cc-switch DB 格式，结构不同导致假阳性）

    // windsurf-dao 未提交（走 gitOut，理由同模式 A 那三处）
    const status = gitOut(["-C", daoRoot, "status", "--porcelain"], "未提交改动");
    if (status) {
      driftItems.push("⬆ windsurf-dao 有未提交改动");
    }

    // windsurf-dao 落后 origin
    const behind = gitOut(["-C", daoRoot, "rev-list", "--count", "HEAD..origin/master"], "落后 origin");
    if (behind !== null && parseInt(behind, 10) > 0) {
      driftItems.push("⬇ windsurf-dao 落后 origin " + behind + " 个提交");
    }

    if (driftItems.length > 0) {
      // 不单独 inject（会终止），而是追加到 issues 里一起报
      issues.push("windsurf-dao 同步漂移：" + driftItems.join("；"));
    }
  } catch (_) {}

  // live settings ↔ git 快照 双向漂移 + dao-rule-echo 接线（新增）。
  // 放在上面的 try/catch 之外：那个 catch 会吞掉一切，自检结果不能被它吞。
  for (const line of selfCheckLines()) issues.push("dao 配置自检：" + line);

  // 墙钟预算模块加载失败 / git 被预算夹死 —— 这两件在模式 B 同样会发生（上面那两处
  // git 调用就走预算），而模式 B **刻意不打印常态余量行**（那只是噪音）。
  // ⇒ 常态那一行不印，**出事那两行必须印**：否则模式 B 会重演本批要治的病。
  for (const line of budgetLibErrorLines()) issues.push(line);
  for (const line of gitSkipLines()) issues.push(line);
}
