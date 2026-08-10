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

// ── 未预期崩溃的最后一张网（2026-08-06 · issue #147 账 3 的另一半）─────────────
// 对本 hook 唯一的消费方（agent 的上下文）而言，**`exit 1` + stdout 0 字节与「全绿静默」
// 逐字节相同** —— 那是 issue #127 的原话，也是这一整批在治的病。而「哪一句会抛」穷举不完：
// PR #130 两轮对抗各自实测「今天找不到能让它抛的入参」，那句话的射程只到当天那组入参。
// ⇒ 兜底：任何没被局部 catch 接住的异常，**转成一行报文 + exit 0**，而不是无声消失。
//
// **这不是「吞掉错误」，方向恰好相反**：吞掉是让人看不见；这里是把一个连 stderr 都没人读
// 的崩溃**变成 agent 上下文里的一行字**。判据一句话：**崩溃可以发生，但不许静默。**
// 射程照直写：它接不住 `process.exit()` 之后的事，也接不住写 stdout 那一刻的失败本身。
//
// ⚠ 双写守卫（`emitted`）是必须的：正常路径由 `inject()` 一次性写出 stdout；崩溃若发生在
//   那次写之后，再写一次会拼出**非法 JSON** —— 消费方连解析都失败，等于又回到「什么都没有」，
//   比崩溃本身更糟。故所有 stdout 写入都必须经过 `emitOnce`。
//   **2026-08-08 补上它的断言**（issue #152 账 1 的第二半）：这一行此前**零断言覆盖**
//   （PR #150 对抗 M1 实测），而它恰恰是承重的 —— 实测「写完之后才崩」两态：守卫在 ⇒
//   stdout 一段合法 JSON（2184 B）；摘掉守卫 ⇒ **两段拼在一起、非法 JSON**（2844 B）。
//   回归网见 tests/dao-scaffold-check.tests.js「双写守卫」那一组。
//
// 🔴 **`stdout.write` 自己抛出时，这张网新长出过一条更静默的路**（issue #152 账 1，2026-08-08 修）：
//   `emitOnce` 先置 `emitted = true` 再写，写抛出 ⇒ 异常冒到 uncaughtException ⇒ 网调 `emitOnce`
//   ⇒ 撞上 `if (emitted) return;` ⇒ 原先 `process.exit(0)`。**实测结果：exit 0 + stdout 0 字节**，
//   与合法的「无事可报」（同样 exit 0 + 0 字节）**逐字节不可区分**；而 master 那一态是
//   exit 1 + 一段栈。⇒ 这条路上，网让消费方看到的东西**比没有网时更少**。
//   **修法**：写失败时记下来，另外两个通道（stderr + 退出码）各出一份声音。
//   为什么退非 0 是安全的、也是唯一还剩的可区分信号：`command` 型 hook 的失效态是 fail-open，
//   **只有 `exit 2` 才 block**，其余非 0 一律 non-blocking、动作照常进行，宿主只多显示一行
//   `Failed with non-blocking status code:` + stderr 首行（判据与出处见
//   `ccswitch/rules/dao-guard-writing.md` 的 `[#守-宿主失效态]`）。⇒ 退 1 换来的是「用户看得见一行」，
//   代价为零；退 0 换来的是「与全绿静默一模一样」。
//   ⚠ **照直写没验到的那一格**：上面那条判据是**官方文档证据，不是本机实测**（真跑一次
//   `claude -p` 观察宿主拿这个退出码做什么，issue #152 自己点名的最大空白，本批仍未做）。
//   本条不依赖它成立的那一半是：**这条路上 master 本来就是非 0**，本批只是把它退回去。
let emitted = false;
let emitFailure = null;   // stdout 写失败时留下的那个异常（null = 没失败过）
function emitOnce(context) {
  if (emitted) return;
  emitted = true;
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context }
    }));
  } catch (e) {
    // stdout 这条路自己断了 ⇒ 报文**永远送不出去**，重试也没用（重试还会把半截字节留在管道里）。
    emitFailure = e;
    try {
      process.stderr.write("✗ dao 脚手架检查：stdout 写不出去（" +
        ((e && e.message) || String(e)) + "）⇒ 本次报文**整个丢失**，" +
        "**这不是「全部通过」**（issue #152 账 1；退出码非 0 是这条路上唯一还剩的可区分信号）\n");
    } catch (_) { /* stderr 也断了就真没有通道了，此时只剩退出码 */ }
  }
}
// 退出码的**唯一出口**：报文送出去了退 0，送不出去退 1。刻意不用 2 —— 2 是 block 语义，
// 一个 SessionStart 自检没有资格拦住会话。
function emitExitCode() { return emitFailure ? 1 : 0; }
process.on("uncaughtException", (e) => {
  const why = e && e.stack ? String(e.stack).split(/\r?\n/).slice(0, 3).join(" ⏎ ") : String(e);
  emitOnce("✗ dao 脚手架检查未预期崩溃：" + why +
    "（ccswitch/hooks/dao-scaffold-check.js）—— 本次检查**结果不完整**，" +
    "**这不是「全部通过」**（issue #147：exit 1 + 零字节与全绿静默不可区分）");
  if (emitFailure) {
    // 报文没送出去 ⇒ 崩溃原因也跟着没了。补进 stderr：这是它此刻唯一到得了的地方。
    try { process.stderr.write("✗ dao 脚手架检查未预期崩溃（报文送不出去，原文只能落这里）：" + why + "\n"); } catch (_) {}
  }
  process.exit(emitExitCode());
});

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
// 故这里给一个最小预算：按本仓当前注册的 10 s 算、起点取进程启动时刻。
// **它是真模块的一份笨副本，这个重复是刻意的**：它只需要够安全，不需要准确。
//
// 🔴 **「落后 = 更保守」这句话是假的，别再照它推**（2026-08-06 · issue #147 账 2 订正）。
// 这里原先写着「真模块将来更聪明了而这份没跟上，后果只是这条路更保守一点，方向仍在安全侧」
// —— 那是一句**方向性安全断言**，而 PR #130 二轮对抗当场构造出反例，**且不用等将来**：
//
//     宿主注册里 `timeout` = 3（秒） ⇒ 真模块从 settings.json 读出 3000 ms（对）
//                                    ⇒ 这份副本硬编码   10000 ms（**高估 3.3 倍**）
// （这两行刻意不写成 `timeout` 紧跟冒号那个形态：本文件的源码级守卫按那个 token 数
//  「子进程 timeout 站点」，注释里出现一次就会被当成一个没夹 capFor 的站点而误报 ——
//  检查器的扫描面覆盖注释，这是它已知的射程边界，不是本条要修的东西。）
//
// 副本把「注册是 10 秒」这个**外部事实**焊死在了代码里 —— 那正是 issue #127 本身的形态
// （两个文件里互不知情的两个数），只不过这次它长在**为了治那个病而加的这条路**上。
//
// **它什么时候保守、什么时候激进，照直写**（判据是注册值与下面 FALLBACK_MS 的大小关系）：
//   · 注册 ≥ 10 s（本仓现状 10 s，且 docs/USER-ACTIONS.md 还在建议往 30 抬）⇒ 副本**估小**，
//     保守，方向在安全侧 —— 这是本 hook 今天的实况，也是本条不阻断的唯一理由；
//   · 注册 < 10 s ⇒ 副本**估大**，激进：它会以为还有余量、把五道 spawn 检查全跑一遍，
//     然后被宿主按真实注册值杀掉 ⇒ **整批静默消失**，正是这条路本来要防的那件事。
// 🔴 **「注册 < 10 s」不是一个假想的将来态，本机此刻就有实例**（issue #152 账 3，
//   2026-08-08 复测）：同一份 `~/.claude/settings.json` 里 17 个 hook 注册中，
//   **5 个的 timeout 那一栏写的是 5 秒**（本条入库时 PR #150 对抗官数到的是 3 个，
//   两天里又多了两个；此处刻意不写成 `timeout` 紧跟冒号那个形态 —— 本文件的源码级守卫
//   按那个 token 数「子进程 timeout 站点」，注释里出现一次就会被当成一个没夹 capFor 的站点），
//   落在那一侧时这份副本**高估 2.00 倍**。它们目前都不是本 hook，所以今天误差仍为零 ——
//   **但这个反例的可达性是「同一份配置里已经有五个现役实例」，不是「等哪天有人改小」**。
//   ⇒ 谁把本 hook 的注册调到 10 s 以下，这条退化路当场从保守翻成激进，而它不会出声。
//
// **仍然不改成「自己去读注册」是刻意的**，但**理由不是原先写的那一条**
// （issue #152 账 2，2026-08-08 订正）：原文写的是「走到这条路的前提就是那份 I/O 与解析的
// 正主已经坏了」—— **对抗官 3/3 实测把它证伪了：`require` 坏 ≠ `settings.json` 读不动**，
// 三次实测同一时刻 settings 都读得动。**决定是对的，理由是错的**，而错的理由会让下一个人
// 照着它做同类决定。真正的两条理由是：
//   ㈠ 在退化副本里复制那 60 行注册匹配逻辑，本身就是**一个新的漂移面**（真模块改了、副本
//      没跟上，而这两份的差别只在故障时才显形 —— 最不可能有人去看的时刻）；
//   ㈡ 退化副本被调用的第二个位置（下面 catch 里那次 `initBudget(budgetLib)` 重来）
//      **不在任何 try 里**：它只要抛一次，就直接落到文件顶部那张 uncaughtException 网上。
//      副本现在只用 Number / Date.now / process.uptime，抛出面小到可以不再套一层；
//      给它加 I/O 与 JSON 解析，等于把一个真实的抛出面搬进那个没有保护的位置。
// **代价换一种方式付**：加载失败那一行会把这份副本假设的总预算（`BUDGET.totalMs`）
// 原样印进报文，读者看得见、复核得了。剩余风险与解冻条件记在 issue #147 / #152。
//
// 回归网见 tests/dao-scaffold-check.tests.js「lib 坏掉」那几臂。其中「退化副本 ≡ 真模块」
// 那一组是**行为级**对照（把这个函数从源码里取出来真的执行，再与真模块逐项比），
// 故对「注释掉」不失明 —— 它旁边那几条源码级断言仍然是失明的，两种一起放着是有意的。
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
        skip(what, minMs, extra) {
          // 第三参 `extra` 是 issue #140 加的（真模块同名参数逐字同一签名，见 hook-budget.js）；
          // 这份笨副本没有逐文件循环、也不采样耗时，故永远不会被真的传非空值——
          // 保留这个形参只是不让「调用方传了但这份镜像吃掉」的调用方式在退化路上报 TypeError。
          skipped.push(what);
          return "⏱ " + what + " **没跑**：宿主预算只剩 " + api.left() + " ms，起它至少要 " +
            minMs + " ms —— **这不是「通过」，是「没测」**（issue #127）" +
            (extra ? " ⟨" + extra + "⟩" : "");
        },
        unreachableConstants(pairs) {
          const bad = [];
          for (const [name, ms] of pairs || []) if (Number(ms) > api.effectiveMs) bad.push(name + "=" + ms + "ms");
          return bad;
        },
      };
      return api;
    },
    // 与真模块 `isBudgetKill` 逐字同一判据。**这份镜像不是可选项**：`gitOut` 的 catch
    // 会调 `budgetLib.isBudgetKill(e)`，副本少了它就是 `TypeError`，而那一抛正好落在
    // 「lib 已经坏掉」的路上 ⇒ exit 1 + 零字节，账 3 的形态原地复发。
    // 回归网：tests 里有一条**独立第二遍普查**，从 hook 源码数出所有 `budgetLib.<name>(`
    // 调用，逐个要求这份副本也有 —— 将来往 lib 加方法而忘了镜像，那条会红。
    isBudgetKill(e) {
      if (!e) return false;
      return e.code === "ETIMEDOUT" || e.signal === "SIGTERM";
    },
  };
}
let budgetLib, BUDGET_LIB_ERROR = "", BUDGET_INIT_ERROR = "";
try {
  budgetLib = require("../lib/hook-budget");
} catch (e) {
  BUDGET_LIB_ERROR = e && e.message ? e.message : String(e);
  budgetLib = degradedBudgetLib();
}
// 测试用的收窄阀：只允许**调小**（取 min）。刻意不做成「想设多大设多大」——
// 那样它就成了一个能让 hook 谎报余量的后门，而谎报余量正是本批要治的病。
const BUDGET_OVERRIDE_MS = Number(process.env.DAO_HOOK_BUDGET_MS) > 0
  ? Number(process.env.DAO_HOOK_BUDGET_MS) : null;

// 🔴 **这两句顶层调用必须与上面的 require 同受保护**（2026-08-06 · issue #147 账 3）。
// 上面那道 try/catch 是 PR #130 的阻断 1 修的，但它**只包住了 `require`**：紧跟着的
// `resolveRegisteredTimeoutMs()` 与 `createBudget()` 落在 catch 之外，而全文件没有任何
// 兜底。二轮对抗往这两个函数里注入 throw 实测：**exit 1 + stdout 0 字节 + 七项检查一起
// 消失** —— 与那次阻断的现象逐格相同，等于阻断只修好了一半。
// **「今天没有入参能让它抛」不构成保护**：两轮攻击各自都没找到那样的入参，而那句话的
// 射程只到今天的入参集合；保护的是**形态**，不是当下这一组输入。
// 失败即整体退到那份笨副本，并**另起一行**报文说明（不与「加载失败」那行合流：两件事的
// 处置不同 —— 一个是模块没进来，一个是模块进来了但算不出数）。
function initBudget(lib) {
  const host = lib.resolveRegisteredTimeoutMs({
    hookFile: __filename,
    home: homeDir,
    // issue #142：不传 settingsPath ⇒ hook-budget 现在会**同时**查用户级与项目级
    // `.claude/settings.json`（判据见 ccswitch/lib/hook-budget.js 头注）；这里把本 hook
    // 自己已经算好的 cwd 传进去，别让它退回 process.cwd()（两者在本 hook 里通常相同，
    // 但 `input.cwd` 才是宿主告诉我们的那个「这次调用的项目根」，更值得信）。
    cwd,
    hookEventName: input && input.hook_event_name ? String(input.hook_event_name) : "SessionStart",
  });
  const budget = lib.createBudget({
    totalMs: BUDGET_OVERRIDE_MS ? Math.min(BUDGET_OVERRIDE_MS, host.ms) : host.ms,
  });
  return { host, budget };
}
let budgetInit;
try {
  budgetInit = initBudget(budgetLib);
} catch (e) {
  BUDGET_INIT_ERROR = e && e.message ? e.message : String(e);
  // 退到笨副本重来一次。它**不做任何 I/O、不解析任何外部数据**（只有 Number / Date.now /
  // process.uptime），故这一次的抛出面已经小到可以不再套一层；真抛了也不会静默 ——
  // 下面那张 uncaughtException 网会把它变成报文里的一行。照直写：**这一格没有专门的断言**。
  budgetLib = degradedBudgetLib();
  budgetInit = initBudget(budgetLib);
}
const HOST_BUDGET = budgetInit.host;
const BUDGET = budgetInit.budget;

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

// ── 测试缝：把 git 的超时压小（2026-08-06 · issue #147 账 1）──────────────────
// **只允许调小（取 min）**，与上面 `DAO_HOOK_BUDGET_MS` 同源：能调大的旋钮迟早会被当成
// 「让它别烦我」的开关。方向上它只会让 hook **更早说「没跑」**，不会让它多跑。
// ⚠ **照直写这个 min 的实际份量**：`capFor()` 本来就把上限夹在剩余预算之内，所以把它换成
// `Math.max` 在行为上几乎观察不到 —— 它是纵深防御，不是唯一防线。本批 mutation 实测：
// 杀死 `min→max` 那个变异体的是端到端的 TIGHT 正控，**不是**那条名为「只准调小」的断言。
//
// **它存在的唯一理由是那条 catch 分支端到端造不出来**。PR #130 未尽处 1 写着「余量要恰好
// 落在 `[1,200)`」，二轮对抗实测那个判断是**反的**：`[1,200)` 恰恰是 `canAfford(200)` 分流、
// `execFileSync` 根本不发出的区间。真条件是 `left() >= 200` **且** git 自己比
// `min(GIT_TIMEOUT_MS, left())` 还慢 —— 本机 `git status --porcelain` ≈28 ms，而守门保证
// 它至少拿到 ~200 ms ⇒ **靠调预算这个旋钮永远造不出来**（6 档端到端实测：1750 走前置守门，
// 1800–2600 全部正常跑完）。它只在 git 自己卡住（锁文件 / 网络盘 / 慢仓）时才活。
//
// **为什么开这个缝、而不是注入一个假的慢 git**：后者要从环境变量取一个**可执行文件路径**，
// 给一个每次会话开场都跑的 hook 开这种口子，代价远大于收益。而两种造法喂给 catch 的
// error 对象是**同一个**（都是 node 按 `timeout` 选项杀子进程），被测那条路径逐字相同 ——
// 缝开在数字上，不开在「跑哪个二进制」上。
const GIT_TIMEOUT_OVERRIDE_MS = Number(process.env.DAO_HOOK_GIT_TIMEOUT_MS) > 0
  ? Number(process.env.DAO_HOOK_GIT_TIMEOUT_MS) : null;
const GIT_TIMEOUT_EFFECTIVE_MS = GIT_TIMEOUT_OVERRIDE_MS
  ? Math.min(GIT_TIMEOUT_OVERRIDE_MS, GIT_TIMEOUT_MS) : GIT_TIMEOUT_MS;

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
// 🔴 **两条路分开记，不合成一个数组**（2026-08-06 · issue #147 账 1 顺带修）：
//   · `gitSkips`  —— **压根没起**：前置守门 `canAfford` 说余量不够；
//   · `gitKilled` —— **起了又被杀**：余量够，但 git 自己比 capFor 夹出来的上限还慢。
// 原先两者共用一个数组、共用 `BUDGET.skip()` 那一句话，于是第二条路会打印出
// **自相矛盾的报文**：「宿主预算只剩 8406 ms，起它至少要 200 ms」—— 8406 远大于 200，
// 读者只会问「那为什么没跑」。这个矛盾此前观察不到，正因为那条路端到端造不出来；
// 本批开了测试缝之后它第一次现形（本机实测原文即上面那句）。
// **一个读者看不懂的「没跑」，与没有那一行的差距，比它与「跑过了」的差距小。**
const gitSkips = [];
const gitKilled = [];
function gitOut(args, what) {
  if (!BUDGET.canAfford(GIT_MIN_SLICE_MS)) { gitSkips.push(what); return null; }
  try {
    return execFileSync("git", args, {
      encoding: "utf8", timeout: BUDGET.capFor(GIT_TIMEOUT_EFFECTIVE_MS), windowsHide: true,
    }).trim();
  } catch (e) {
    // 判据搬进 hook-budget（`isBudgetKill`），**语义逐字未改**。搬家的理由写在那个函数的
    // JSDoc 里：内联时它的两半各自被删都没有断言会红（B1/B2 双双存活），而端到端结构上
    // 分不开那两半 —— 只有拿合成 error 逐半喂一个纯函数才分得开。
    if (budgetLib.isBudgetKill(e)) gitKilled.push(what);
    return null;
  }
}
function gitSkipLines() {
  const out = [];
  if (gitSkips.length) {
    out.push(BUDGET.skip("git 状态查询（" + gitSkips.join("、") + "）", GIT_MIN_SLICE_MS));
  }
  if (gitKilled.length) {
    // 记进 `BUDGET.skipped` 是为了让汇总行的「本次跳过 N 项」把这一路也算上 ——
    // 它是 api 上公开的那个数组（`budgetSummaryLines` 一直在读它的 length）。
    // 不走 `BUDGET.skip()` 是因为那句话的模板（「只剩 X ms，起它至少要 Y ms」）对这条路
    // 不成立：这里 X 远大于 Y，照它印出来就是上面注释里那句自相矛盾的报文。
    for (const w of gitKilled) BUDGET.skipped.push(w);
    out.push("⏱ git 状态查询（" + gitKilled.join("、") + "） **没跑**：子进程起来了，" +
      "但比我们夹给它的上限还慢，被 SIGTERM 掉了（上限 = min(GIT_TIMEOUT " +
      GIT_TIMEOUT_EFFECTIVE_MS + " ms, 剩余预算)）—— 常见成因是 git 自己卡住（锁文件 / 网络盘 / 慢仓）。" +
      "**这不是「通过」，是「没测」**（issue #127）");
  }
  return out;
}

// 墙钟预算模块加载失败时的那一行。**报文里必须有它**，否则「退化跑了」与「正常跑了」
// 在唯一的消费方（agent 的上下文）里又一次不可区分 —— 那就是本批在治的病本身。
// ⚠ **两件事各占一行，刻意不合流**（2026-08-06 · issue #147 账 3）：「模块没进来」与
// 「模块进来了但算不出数」是两种故障、两种处置（前者查文件与语法，后者查入参与 settings），
// 合成一行会让读者拿着错误的方向去查。两行的措辞也刻意不同 —— 同一句话出现在两个地方，
// 就等于给夹住其中一个的断言发了免死金牌（PR #130 第一轮 M5/M6/M7 三个变异体因此存活）。
function budgetLibErrorLines() {
  const out = [];
  if (BUDGET_LIB_ERROR) {
    out.push("✗ 墙钟预算模块加载失败：" + BUDGET_LIB_ERROR + "（ccswitch/lib/hook-budget.js）" +
      " —— 已退化为保守内置预算（" + BUDGET.totalMs + " ms），其余检查照跑");
  }
  if (BUDGET_INIT_ERROR) {
    out.push("✗ 墙钟预算初始化抛错：" + BUDGET_INIT_ERROR + "（ccswitch/lib/hook-budget.js 已加载但算不出预算）" +
      " —— 已退化为保守内置预算（" + BUDGET.totalMs + " ms），其余检查照跑");
  }
  return out;
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
// ── J3：外部项目常驻提醒抑制阈（2026-08-09 · 用户拍板 issue #70 评论 5230277293 第一组）──
// 治的是什么：manifestIssueLines() 每次 SessionStart 都重新求值一遍共性 rule 清单，
// 同一条未修的缺项逐字不改地反复出现——外部项目常年挂着同一条提醒，越提醒越没人看，
// 「常驻提醒」这个词本身就是在描述这个病。
// 判据：同一个 (项目根, finding.id) 视为「同一条」提醒。前 REMINDER_SHOW_FULL_TIMES 次
// （缺省 3）原样全文显示；报满 3 次后，第 4 次起压缩成一行标题——标题取 msg 首行，
// 若含 "→"（诊断→修法的既有书写惯例，见 claude-md / tmp-gitignored 等条目）只保留箭头前
// 半句，去掉修法指引；换行之后的内容（含 template 字段追加的「↳ 零编辑复制 canonical」
// 可粘贴命令，那条命令在 scaffold-manifest.js::evaluate() 里永远是单独一行拼接）随首行
// 截断天然被丢弃——不需要单独识别命令行。
// 计数落盘复用 hbScaffold 已算好的状态目录（<dao 根>/_tmp/scaffold-check/，测试环境下
// 由 DAO_SCAFFOLD_CHECK_STATE_SUBDIR 重定向到沙箱），新增一个同族文件
// reminder-counts.json，与 fired.log/last.json/errors.log 同域、不新开目录。
// fail-open（拍板原句）：计数文件不存在 / 损坏 / 读不动 —— 一律当空表，每条按 0 次算，
// 本轮仍显示全文。宁可多提醒一次，也不能让状态文件本身的问题变成悄悄少提醒。
const REMINDER_STATE_FILE = "reminder-counts.json";
const REMINDER_SHOW_FULL_TIMES = 3;

function reminderStateDir() {
  // 优先复用 hbScaffold 已经算好的目录。hbScaffold 加载失败时退化自己算一次——理由与
  // checkDaoDrift() 里那个 daoRoot 逐字相同：本文件 __dirname 是 ccswitch/hooks/，
  // 上两级即 dao 根。
  if (hbScaffold && hbScaffold.stateDir) return hbScaffold.stateDir;
  return path.join(path.resolve(__dirname, "..", ".."), "_tmp",
    process.env.DAO_SCAFFOLD_CHECK_STATE_SUBDIR || "scaffold-check");
}
function reminderCountsPath() {
  return path.join(reminderStateDir(), REMINDER_STATE_FILE);
}
// 读不出（文件不存在 / JSON 损坏 / I/O 异常）一律返回空表——调用方据此把每条都当 0 次，
// 这就是拍板要求的 fail-open。
function readReminderCounts() {
  try {
    const j = JSON.parse(fs.readFileSync(reminderCountsPath(), "utf8"));
    return (j && typeof j === "object" && !Array.isArray(j)) ? j : {};
  } catch (_) { return {}; }
}
// 写失败不该拖垮主产物（与本文件其余状态写入同一惯例）：下次仍按旧计数走，只是这一轮
// 没能推进计数——不算错误，方向仍是 fail-open（宁可多提醒，不悄悄少提醒）。
function writeReminderCounts(data) {
  try {
    const p = reminderCountsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data), "utf8");
  } catch (_) {}
}
// 项目键：绝对路径 + 统一分隔符 + 小写，避免 Windows 上大小写/斜杠写法差异把同一个项目
// 拆成两个桶（近似判据：换路径写法即失配，失配的后果只是「多算一条新提醒」而不是误伤，
// 失败方向与 scaffold-manifest.js::repoNameOf 的取舍同型）。
function reminderProjectKey(root) {
  try { return path.resolve(String(root || "")).split(path.sep).join("/").toLowerCase(); }
  catch (_) { return String(root || ""); }
}
// 标题化：只取第一行——天然去掉 template 字段追加的「↳ 可粘贴命令」（那条命令在
// scaffold-manifest.js::evaluate() 里是另起一行拼接的 "\n   ↳ 零编辑复制 canonical: ..."）；
// 首行若含 "→" 只保留箭头前半句（去掉修法指引）。没有 "→" 的 msg 本身已经很短
// （如「缺少 .claude/rules/ 目录（领域规范存放处）」），原样当标题即可，没有可再削的
// 「修法段」——两种情况都不需要额外判断，是同一条规则的两种自然结果。
function reminderTitle(fullText) {
  const firstLine = String(fullText).split(/\r?\n/)[0];
  const arrowIdx = firstLine.indexOf("→");
  return arrowIdx === -1 ? firstLine : firstLine.slice(0, arrowIdx).trim();
}
// 每条 finding 各走一次：读计数 → 按阈值决定全文/压缩 → 计数 +1 落盘。
// **先渲染后计数**：本轮显示形态取决于「写入前」的计数（prev）——前 3 次 prev=0/1/2
// （全文，即拍板说的「报满 3 次」），第 4 次起 prev>=3（压缩）。
function reminderLine(projectRoot, findingId, fullText) {
  const counts = readReminderCounts();
  const pk = reminderProjectKey(projectRoot);
  const bucket = (counts[pk] && typeof counts[pk] === "object" && !Array.isArray(counts[pk])) ? counts[pk] : {};
  const rec = bucket[findingId];
  const prev = (rec && typeof rec === "object" && Number.isFinite(rec.count)) ? rec.count : 0;
  const compressed = prev >= REMINDER_SHOW_FULL_TIMES;
  bucket[findingId] = { count: prev + 1, lastAt: new Date().toISOString() };
  counts[pk] = bucket;
  writeReminderCounts(counts);
  if (!compressed) return fullText;
  return reminderTitle(fullText) + "（同条提醒已连续 " + prev + " 次，本次起压缩为标题；" +
    "完整文本见更早的报文，或跑 `node <dao 根>/ccswitch/scripts/dao-scaffold-report.mjs` 复核）";
}

// 返回本项目缺失的共性 rule 报文行（含加载/校验错误行）。severity=info 的近似判据
// 加「（建议）」前缀，与确定性缺项区分开——近似判据不该和存在性判据同等语气。
function manifestIssueLines(projectRoot) {
  let res;
  try { res = manifestCheck(projectRoot, process.env.DAO_SCAFFOLD_MANIFEST || null); }
  catch (e) { return ["✗ 共性 rule 备案清单抛错：" + (e && e.message ? e.message : String(e))]; }
  const lines = [];
  // errors（加载/校验失败）永不压缩——那是基础设施故障，不是「同一条提醒」，必须每次都
  // 完整现形；只有 findings（真缺项）走 J3 抑制阈。
  for (const err of res.errors || []) lines.push("✗ " + err);
  for (const f of res.findings || []) {
    const full = f.severity === "info" ? "（建议）" + f.message : f.message;
    lines.push(reminderLine(projectRoot, f.id, full));
  }
  return lines;
}

// ── 心跳自证（2026-08-09 · 机制体检报告 `_tmp/mechanism-audit-20260809.md` §二 🟡①）───
// 治的是什么病：本 hook 是审计一切的挂载总线（30 天 34 次维护，全仓维护热点断层第一），
// 却自己从不写触发日志——更要命的是**循环依赖**：唯一能发现「它死了」的死闸检测 /
// always-on 预算闸 / 条款库结构闸 / per-provider 漂移检测，全部**跑在它自己里面**，
// 它一停，这些检查跟着一起停，而它的输出与「本轮无事可报」（`done()`）在盘上逐字节相同。
//
// 复用既有形态，不新造：与 dao-rule-echo / dao-compact-log / dao-rate-limit-sentinel /
// dao-probe-gate 同一套脚手架（`ccswitch/lib/hook-selfcheck.js`），fired.log/last.json
// 落 `<dao 根>/_tmp/scaffold-check/`。`stateSubdir` 可用 `DAO_SCAFFOLD_CHECK_STATE_SUBDIR`
// 改道（测试专用，别覆盖生产那份 fired.log——理由同 dao-probe-gate.js 头注那一条）。
//
// **谁在读它，读心跳的人必须在另一个事件上**：见 `dao-compact-log.js`（PostCompact）的
// 「scaffold-check 死闸检测的挂载点」——本 hook 自己若真的停摆，靠本 hook 自己去发现
// 自己停摆就是原地保留循环依赖，只是换了个身位（机制体检报告原话）。
//
// **写入时机只有 `done()` / `inject()` 两个正常退出口**（本文件全部非崩溃路径都经这两个
// 函数，见文件末尾）。**刻意不覆盖 `uncaughtException` 那条路**：一个持续崩溃的
// scaffold-check 不该被心跳判成「活着」——陈旧判定要回答的是「它还在正常完成工作吗」，
// 不是「宿主还在调用它吗」；把崩溃也算进心跳，会让「它一直在崩」与「它很健康」在陈旧检测
// 眼里长得一样。崩溃本身已经由文件顶部那张 uncaughtException 网，通过 stdout 报文在
// 当次会话内可见——心跳服务的是跨会话/跨天的「它是不是已经沉默了很久」这个不同的问题。
let hbScaffold = null, HB_LIB_ERROR = "";
try {
  hbScaffold = require("../lib/hook-selfcheck.js").createHookScaffold({
    name: "dao-scaffold-check",
    stateSubdir: process.env.DAO_SCAFFOLD_CHECK_STATE_SUBDIR || "scaffold-check",
    failTail: "本次心跳未记录；hook 不阻断（心跳是旁证，不是主产物）",
    forceErrorEnv: "DAO_SCAFFOLD_CHECK_HEARTBEAT_FORCE_ERROR",
    selfTestEnv: "DAO_SCAFFOLD_CHECK_SELFTEST",
  });
} catch (e) {
  HB_LIB_ERROR = e && e.message ? e.message : String(e);
}
// 结果摘要字段刻意精简（字段量级呼应 dao-probe-gate 的心跳）：`result` 是本轮走的是哪条
// 退出路径（`skip-not-git` / `clean` / `reported`），三个计数只在 `result==="reported"`
// 时非零。陈旧判定只需要「最后一次真实心跳是什么时候」，字段堆多了只会多一处要维护的口径。
function writeHeartbeat(result, counts) {
  if (!hbScaffold) return;
  // `mode` 求值挪到 try **外**（2026-08-09，PR #223 对抗验证评论 5230508080 挂账㈢）：
  // `isMetaRepo` 是文件下方「模式 B」大注里才声明的 TDZ `const`，若留在 try 内部引用，
  // 一旦真的撞上 TDZ（今天不可达，见 inject()/done() 那段大注新增的说明），会被这个函数
  // 自己「心跳失败不该拖垮主产物」的 catch 悄悄吞掉——退出码依旧 0、stdout/stderr 都不
  // 出声，心跳静默丢失，正是本节要治的病本身。挪出来后 TDZ 会直接抛出，与 daoSync/issues/
  // activeWork 那三个统一成同一种失败形态：真撞上会被文件顶部 uncaughtException 网接住、
  // 当次会话内可见，不再是无声消失。
  const mode = isMetaRepo ? "A" : "B";
  try {
    hbScaffold.heartbeat({
      at: new Date().toISOString(),
      synthetic: hbScaffold.isSynthetic(input),
      session_id: (input && input.session_id) || null,
      mode,
      result,
      dao_sync: (counts && counts.daoSync) || 0,
      issues: (counts && counts.issues) || 0,
      active_work: (counts && counts.activeWork) || 0,
    });
  } catch (_) { /* 心跳失败不该拖垮主产物（与 heartbeat() 自身的吞异常语义一致） */ }
}
// 心跳基建自己加载失败必须出声——这恰是本节要治的循环依赖的又一实例：一个「证明我还
// 活着」的机制若自己悄悄坏掉，比没有它更危险（会让人误以为已经有人在盯）。写法与本文件
// 其余 4 处 lib 加载失败（settings-drift / scaffold-manifest / hook-budget / clause-parser）
// 同一套：加载失败就报一行，不静默吞。
function heartbeatLibErrorLines() {
  return HB_LIB_ERROR
    ? ["✗ 心跳基建加载失败：" + HB_LIB_ERROR + "（ccswitch/lib/hook-selfcheck.js）—— " +
       "本轮心跳未写出，scaffold-check 的陈旧判定这次会失真（其余检查照跑）"]
    : [];
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
// 「有条款签名才扫」这个前置筛选的两面，照直写：
//   · 好处：dao-longwindow.md 那类**纯流程文件本来就零条款**，直接扫它会恒报 zero-sample 红
//     （闸说的是实话，但对那个文件不是缺陷）⇒ 生下来就吵的检查一定会被静音。
//   · 代价：若某个文件的条款被整体删光，它会从被检清单里消失而不是变红。故**必须**把
//     「几个文件 / 其中几个含条款」当成一行普查数打印出来 —— 静默跳过才是那个病，
//     打印出来的跳过不是（同 verify-all 的 SKIPPED 教训：文案骗不到读数的人）。
//   · **2026-08-08 起筛选判据不再是本文件自己的正则**，改为直连 clause-parser 的遮罩判据
//     （issue #169①，见下方 loadClauseParser 那段）。于是「独立于闸的第二套实现」这句
//     **不再成立**：判据现在是同一套。换来的是「提及 vs 使用」判得准；让出的是那一点
//     冗余判别力 —— 而那点冗余此前的实际表现是**两套口径分歧**（#169③），不是纵深。
// ── 扫描面在本 hook 与 PS 缺省全量模式之间是**两条路**，别读成重复 ──────────────
//   · 本 hook：**扫目录**（ccswitch/rules/*.md 全量）再按签名筛 ⇒ 抓得到「带条款但没登记进
//     defaultSources() 的新文件」，那一格 node 侧与 PS 全量模式都看不见（会打一行 ⓘ）。
//   · PS 缺省全量模式：按 defaultSources() 那份**声明清单**逐份检。
//   两条各有盲区（前者不查登记、后者不查未登记），合起来仍不是全覆盖 —— 照直写，别当兜底。
// 成本：每个被检文件一次 `-NoProfile` 冷起 PowerShell（本机实测单次 ~350ms）。
const CLAUSE_CHECK_TIMEOUT_MS = 20000;

// ── 判据归一：裸正则 → 真遮罩（2026-08-08 · issue #169① 清偿）────────────────
// 本函数此前是全仓三个「条款元字段」消费方里**唯一用裸文本正则**的那个，于是
// 「散文里**提到** `[自定@…]` 这个语法」与「真的打了一个标记」分不开。
// 上一版修法（`\[自定@` → `\[自定@\d`）**键在占位符的形状、不在容器**，对抗验证实测只关了
// 五分之一：行内代码里举一个带日期的例（`` `[自定@08-02]` ``），或 `[n=` / `[基线:` / slug
// 任一支的行内代码举例，照样把纯流程文件拉进扫描面 ⇒ Marked 下零选中 ⇒ zero-sample 恒红。
// 当时接不上的**真实障碍是 hook 是 CJS 而判据在 ESM**（对抗官验证过是真约束，不是懒）。
// Node ≥22.12 的 `require(esm)` 把那道缝填上了 ⇒ 现在直连
// `ccswitch/lib/clause-parser.mjs::hasClauseSignature`（逐行 + 围栏 + 代码 span 遮罩，
// 与 PS 侧 `Get-MaskedLine`/`Get-MaskedLineAlt` 同一套判据）。
// **逐行**这一格是关键：整份文件一次性遮罩会让反引号跨行配对，把中间几十行连同真标记
// 一起吃掉 —— 那不是修好，是换成更隐蔽的一种错。判据住在 parser 里，本文件不复述。
//
// 🔴 **降级路径必须出声**：宿主 Node 太老 / 文件坏了 ⇒ 回落到旧正则，并**打一行**说明
// 「本轮用的是近似判据、它有已知误纳形态」。静默回落等于把 #169 那个洞原样装回来，
// 而且这一次连「洞还在不在」都看不出来 —— 那比洞本身更贵。
let CLAUSE_PARSER = null;      // 缓存：成功加载的 ESM 模块
let CLAUSE_PARSER_WHY = null;  // 缓存：加载失败的原因（**留着，要打出来**）
function loadClauseParser() {
  if (CLAUSE_PARSER || CLAUSE_PARSER_WHY) return CLAUSE_PARSER;
  try {
    // 相对**本文件**解析，不相对被检项目 —— 被检的可以是任何一个 fixture 仓，
    // 而判据必须永远来自 dao 自己那一份。
    CLAUSE_PARSER = require("../lib/clause-parser.mjs");
    if (typeof CLAUSE_PARSER.hasClauseSignature !== "function") {
      CLAUSE_PARSER_WHY = "clause-parser.mjs 没有导出 hasClauseSignature（版本对不上）";
      CLAUSE_PARSER = null;
    }
  } catch (e) {
    CLAUSE_PARSER_WHY = (e && e.message ? e.message : String(e)).split("\n")[0];
  }
  return CLAUSE_PARSER;
}

// 降级用的近似判据（**只在 require(esm) 走不通时才用**）。它就是上一版那个正则，
// 已知误纳形态见上面那段 —— 保留是为了「判不了」时仍有一个偏宽的筛子（宁可多送一份去检），
// 不是因为它够用。
const CLAUSE_SIGNATURE_FALLBACK_RE = /\[n=|\[基线:|\[自定@\d|\[#[^\]\s]+\]/;

function clauseTargets(daoRoot) {
  const parser = loadClauseParser();
  const notes = [];
  // 「这份文件该用哪个 `-ClauseSelector`」的真相源同样在 parser 里（`defaultSources()` 的投影）。
  // 此前 hook 一律不传 ⇒ 全按缺省 Marked 检，而 node 侧对 dao-officer-clauses.md 用的是
  // all-top-level ⇒ **同一份文件被两套东西按两种口径检**，那正是 #169③ 记的口径分歧。
  //
  // 🔴 **拿不到这份清单也必须出声**（2026-08-08 · PR #183 对抗🟡①）。这里原先是
  // 「是函数才调，抛了就回落空对象」一句话，于是 `parser` **加载成功**、而
  // `defaultPsSelectorMap` 取不到（导出没了 / 版本对不上 / 它抛了 / 返回空清单）时：
  // `selectorMap` 为空 ⇒ 下面 `mk()` 里那句 `&& Object.keys(selectorMap).length` 让
  // **ⓘ 一行都不打**，而 `loadClauseParser()` 只在 `hasClauseSignature` 缺失时才设
  // `CLAUSE_PARSER_WHY` ⇒ **⚠ 降级行也不打**，全部悄悄回落 Marked。
  // 对抗实测（把那句 `typeof` 的名字换成一个不存在的导出）：真仓 `additionalContext` 与基线
  // **逐字相同**、回归网全绿 —— **本文件通篇在治的那个病，长在了为治它而铺的这条路上。**
  // ⚠ 措辞刻意**不与**下面那条「条款筛选器降级」重复：同一句话出现在两处，等于给夹住其中
  // 一个的断言发免死金牌（本文件 `budgetLibErrorLines` 那里踩过，三个变异体因此存活）。
  let selectorMap = {};
  let selectorMapWhy = null;
  if (parser) {
    if (typeof parser.defaultPsSelectorMap !== "function") {
      selectorMapWhy = "clause-parser.mjs 没有导出 defaultPsSelectorMap（版本对不上）";
    } else {
      try {
        const m = parser.defaultPsSelectorMap();
        // 空清单与「取不到」在后果上**逐格相同**（ⓘ 那道守卫同样被关掉），故同报一行。
        if (m && typeof m === "object" && Object.keys(m).length) selectorMap = m;
        else selectorMapWhy = "defaultPsSelectorMap() 返回空清单（源清单里一份文件都没有）";
      } catch (e) {
        selectorMapWhy = "defaultPsSelectorMap() 抛错：" +
          (e && e.message ? String(e.message) : String(e)).split("\n")[0];
      }
    }
  }
  if (selectorMapWhy) {
    notes.push("⚠ 选择器清单降级：clause-parser.mjs 进来了，但要不到 defaultPsSelectorMap（" +
      selectorMapWhy + "）⇒ 本轮**全部按缺省 Marked 检**（dao-officer-clauses.md 那份的 " +
      "AllTopLevel 口径丢了，退回 #169③ 那个两套口径分歧），且「带条款却没登记进 " +
      "defaultSources()」那条 ⓘ 本轮**结构上出不来**（它的守卫要这份清单非空）—— " +
      "**这不是「都登记好了」，是「没查」**（PR #183 对抗🟡①）");
  }
  const toPosix = (p) => p.split(path.sep).join("/");
  const mk = (rel) => {
    const key = toPosix(rel);
    const sel = selectorMap[key] || null;
    if (!sel && Object.keys(selectorMap).length) {
      // **带条款却不在 defaultSources() 里**：clause-index、`--reconcile`、PS 全量模式
      // **三样都看不见它**。这里只报不拦 —— 登记与否是判断（观察线），而「没人看着」
      // 这件事本身必须每次都在人眼前过一遍。
      notes.push("ⓘ 条款文件未登记进 defaultSources()：" + key +
        "（带条款签名，却不在 clause-parser.mjs 的源清单里 ⇒ clause-index / --reconcile / " +
        "PS 缺省全量模式都看不见它；本 hook 仍按缺省 Marked 检了它）");
    }
    return { rel, selector: sel || "Marked" };
  };

  const targets = [mk(path.join("ccswitch", "dao.md"))];
  if (!parser) {
    notes.push("⚠ 条款筛选器降级：读不到 clause-parser.mjs 的遮罩判据（" + CLAUSE_PARSER_WHY +
      "）⇒ 本轮用的是近似正则，已知会把**行内代码里举的例子**误当成真标记（issue #169②）。" +
      "宿主 Node 需 ≥22.12（require(esm)）；本机 " + process.version);
  }
  const dir = path.join(daoRoot, "ccswitch", "rules");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md"));
  } catch {
    return { targets, total: 0, withClauses: 0, notes };   // rules/ 不存在 ⇒ 老形态，只检 dao.md
  }
  let withClauses = 0;
  for (const n of names.sort()) {
    let hit = false;
    try {
      const text = fs.readFileSync(path.join(dir, n), "utf8");
      hit = parser ? parser.hasClauseSignature(text) : CLAUSE_SIGNATURE_FALLBACK_RE.test(text);
    } catch { hit = false; }
    if (hit) { targets.push(mk(path.join("ccswitch", "rules", n))); withClauses++; }
  }
  return { targets, total: names.length, withClauses, notes };
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
  const runOne = ({ rel, selector }) => {
    let out = "", code = 0;
    // **一律显式传 `-TargetFile`，dao.md 也不例外**（2026-08-08 · issue #176）：
    // 那个闸的**缺省语义已经变了** —— 不传 = 全量模式（去 node 要源清单、逐份自调子进程）。
    // 本 hook 是逐份跑的，靠「不传 = dao.md」那条旧默认会让 dao.md 那一份走成整批全量，
    // 既重复劳动又让「哪一份红了」对不上号。**依赖别人的缺省值是一种隐式契约**，
    // 而这次它被改了正好证明了那句话。
    // `-ClauseSelector` 同批补上：取值来自 clause-parser 的 `defaultPsSelectorMap()`
    // （dao-officer-clauses.md 是 AllTopLevel，其余 Marked）—— 此前一律不传 ⇒ 全按 Marked，
    // 与 node 侧口径分歧（issue #169③）。
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-TargetFile", rel, "-ClauseSelector", selector];
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

  const { targets, total, withClauses, notes } = clauseTargets(daoRoot);
  const lines = [];
  let clauses = 0, retire = 0, promote = 0;
  // 这道闸是整个 hook 里最贵的一项，而它的成本**随被检文件数线性长**（每个文件一次
  // PowerShell 冷起）。预算见底时逐个记名跳过，**绝不并进下面那句绿** —— 一份只扫了
  // 一半的扫描面报「零违例」，正是 dao-guard-writing.md「零检出 ≠ 零存在」那条病。
  const notRun = [];
  // ── 本次实测单次耗时(2026-08-08 · issue #140)────────────────────────────────
  // 对抗验证官量过：4 次降级里 3 次是**假降级**——`PS_MIN_SLICE_MS`(1200ms) 是按本机
  // 实测最坏值(603ms)的 2 倍保守取的，而降级报文原先只说得出「只剩多少 ms、门槛多少 ms」，
  // 说不出「本次这一份实际花了多少 ms」⇒ 读者判断不了「这次不够，是阈值太保守，还是真的
  // 快见底了」。这里记下**本轮同一次运行里、真的跑成过的那些文件**各花了多少 ms——
  // 它们与被跳过的那些文件在同一台机器、同一次调用里产生，是这次降级最贴身的参照系
  // （比头注里写死的历史实测数字更新鲜，且不需要另起一次采样）。
  const durationsMs = [];
  for (const t of targets) {
    if (!BUDGET.canAfford(PS_MIN_SLICE_MS)) { notRun.push(t.rel); continue; }
    const startedAt = Date.now();
    const r = runOne(t);
    durationsMs.push(Date.now() - startedAt);
    if (r.err) { lines.push(r.err); continue; }
    if (r.fail) { lines.push(r.fail); continue; }
    clauses += r.clauses; retire += r.retire; promote += r.promote;
  }
  if (notRun.length) {
    // 零样本 vs 有样本必须分得开：零样本时「假/真降级」这个问题**答不出**，
    // 明说「零样本」比含糊带过更诚实(对抗验证官原话："第一次降级发生在任何样本之前时，
    // 仍然分不开——但那时至少能明说「零样本」，而不是把两种情况混成同一句话")。
    let sampleNote;
    if (!durationsMs.length) {
      sampleNote = "本次零样本：一次都没跑成，无从判断真假";
    } else {
      const minD = Math.min(...durationsMs), maxD = Math.max(...durationsMs);
      const range = minD === maxD ? String(minD) : minD + "–" + maxD;
      const leftMs = BUDGET.left();
      // 判据：余量若**大于**本轮已实测的最坏单次耗时，说明理论上还够跑一份——
      // 这次没跑纯粹是阈值(PS_MIN_SLICE_MS)比实测保守，是**假降级**；
      // 余量若不大于实测最坏值，降级至少与实测吻合，**不能排除是真降级**
      // （仍不是"证明为真"——机器负载会抖动，这里只回答"有没有证据反对它"）。
      sampleNote = "本次实测单次 " + range + " ms ×" + durationsMs.length + "；余量 " + leftMs + " ms " +
        (leftMs > maxD
          ? "**大于**实测最坏值 ⇒ 这是阈值保守导致的**假降级**"
          : "不大于实测最坏值，无法排除真降级");
    }
    lines.push(BUDGET.skip("条款库结构闸的 " + notRun.length + "/" + targets.length +
      " 个被检文件（" + notRun.join("、") + "）", PS_MIN_SLICE_MS, sampleNote));
  }
  // `notes` 是**观察线**（判据降级 / 有条款文件没登记进源清单）：三条返回路径都要带上它 ——
  // 只挂在其中一条，另外两条走到时它就静默消失了，而那正是这道闸自己在治的病。
  const withNotes = (arr) => (notes && notes.length ? arr.concat(notes) : arr);
  if (lines.length) {
    lines.push("  → 详情：powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1 [-TargetFile <上面那个文件>]");
    return withNotes(lines);
  }
  if (retire > 0 || promote > 0) {
    return withNotes(["ⓘ 条款库观察线（dao.md + rules/ 合计 " + clauses + " 条）：有 " + retire +
            " 条够老了、该问一句「还有用吗」，" + promote +
            " 条观察区候选够格升格 → powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1 看清单" +
            "（**观察线不是硬闸**：它只把判断端到你眼前，不替你决定退役/升格）"]);
  }
  // 绿且无待办 ⇒ 常路只留一行普查数。**刻意不做成零输出**：被检文件从 1 个变成多个之后，
  // 「哪些被检了、哪些因零条款没检」必须是可见的，否则下一次有人把条款迁走时又是静默缩面。
  return withNotes(["ⓘ 条款库结构闸绿：dao.md + ccswitch/rules/ 含条款的 " + withClauses + "/" + total +
          " 个 .md，合计 " + clauses + " 条，零违例（零条款的纯流程文件不检，故意不报红）"]);
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

// 走 emitOnce 而非直接 write：与文件顶部那张 uncaughtException 网共用同一个「只写一次」
// 闸门。两处各写各的会拼出非法 JSON（理由见那里的双写守卫注释）。
//
// `done()` / `inject()` 是本文件**全部正常退出口**（uncaughtException 那条崩溃路不经过
// 这里，理由见「心跳自证」大注）——把心跳写在这两个函数里，而不是分散在每个调用点，
// 保证只要走的是正常路径，心跳就一定被写过一次（`daoSync`/`issues`/`activeWork` 这三个
// `const` 在文件靠后才声明，`inject()` 只在它们都已赋值后才会被调用，故此处引用它们不撞
// 暂时性死区；`done()` 早于它们声明就可能被调用，故不在函数体内直接引用这三个数组，
// 只接受调用方显式传入的 `result` 字符串）。
//
// ⚠️ **`isMetaRepo`（下方「模式 B」大注、本文件更靠后才声明）是同一类缝的另一个变量**
// （2026-08-09，PR #223 对抗验证评论 5230508080 挂账㈢ 实测坐实）：`writeHeartbeat()`
// 也引用它（求值 `mode`），且**今天不可达**——本文件没有任何 `done()` 调用早于
// `isMetaRepo` 的声明行。已把 `mode` 的求值挪到 `writeHeartbeat()` 的 try **外**（见该
// 函数），让它撞 TDZ 时的失败形态与这三个变量统一（直接抛出、当次会话内可见），而不是
// 被那层「心跳失败不该拖垮主产物」的 catch 悄悄吞掉——后者会让「一个持续崩溃/早退的
// scaffold-check」在陈旧检测眼里长得像「很健康」，正是本节开篇要治的病本身。
function inject(context) {
  writeHeartbeat("reported", { daoSync: daoSync.length, issues: issues.length, activeWork: activeWork.length });
  emitOnce(context);
  // 退出码走同一个出口（issue #152 账 1）：**这里原先写死 `exit(0)`**，于是即使
  // `emitOnce` 里的写失败已经被记下来，这一行也会把它抹平成「一切正常」。
  process.exit(emitExitCode());
}
function done(result) {
  writeHeartbeat(result || "clean");
  process.exit(0);
}

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

  // ── 7~11 的降级顺序：按性价比排，不按历史挂载序（2026-08-08 · issue #141）───────
  // 2026-08-01 起这五道是按「挂载先后」摆的，条款结构闸（当时最先挂）排在最前。对抗验证官
  // 11 档预算扫描量出的真实代价：条款闸**一份文件** ~600ms（且随 ccswitch/rules/ 的条款文件
  // 数只增不减），而后四道**合计** ~368ms（139+48+116+65，均为原子项、要么整道跑完要么整道
  // 跳过）。旧顺序下预算见底时，条款闸排第一、先吃掉大头，逼得后四道一起被 `runWithinBudget`
  // 的 `NODE_MIN_SLICE_MS`(600ms) 拦下 ⇒ **用 368ms 换 600ms，代价是「四项检查全部消失」**——
  // 这不是四舍五入的误差，是拿相同预算换回明显更少的检查覆盖面。
  //
  // 改法：把四道便宜的**原子项**整项挪到条款闸之前，条款闸本身排到最后。三个开放问题各自答案：
  //   ① 条款闸排第一是不是有语义理由（它守的是 dao.md 本身）？——**没有顺序依赖**：五道各自
  //      独立求值、互不依赖彼此的结果，「谁先跑」不影响任何一道的判据正确性，只影响预算耗尽时
  //      「谁被牺牲」。「最重要的先看」不成立于此处——预算见底时最该保住的是「检查数量」，
  //      不是「哪一道排在报文最前面」。
  //   ② 报文里「本次跳过 N 项」的含义要不要跟着改？——不用。`BUDGET.skipped` 是运行期累加的
  //      数组，语义是「这次真跳过了几项/几个文件」，与摆放顺序无关；变的只是**分布**（旧序偏向
  //      「四项全跳、条款闸部分完成」，新序偏向「条款闸多跳几个文件、四项全跑完」），汇总行的
  //      文字本身不用改。
  //   ③ 混排要按「项」还是按「文件」排？——按**项**：四道各自是不可再分的原子项，整项排在
  //      条款闸这个「可再分」的多文件项之前。条款闸本身仍保留它原有的逐文件降级（每份文件各自
  //      判一次 `canAfford(PS_MIN_SLICE_MS)`），排最后反而让它成为**吸收预算波动的那一道**——
  //      预算宽裕时五道全跑完，预算收紧时先牺牲的是「条款闸少扫几份文件」而不是「后四道消失」。
  //
  // 两态断言（回归网 tests/dao-scaffold-check.tests.js）：同一预算下，重排前后「被跳过的项数」
  // 与「被跳过的总成本」都可比较——旧序在预算收紧到 ~6s 附近时跳 4 项/省 368ms，
  // 新序在同一预算下跳 0~1 个条款闸文件/省 ~600ms 一份，检查覆盖面更高。

  // 7. 死闸检测（2026-08-01 挂载 · 架构优化 P3，判据见 deadGateLines 头注；本仓最便宜的原子项之一）。
  for (const line of runWithinBudget("死闸检测", NODE_MIN_SLICE_MS, () => deadGateLines(daoRoot))) drifts.push(line);

  // 8. always-on 字节预算（2026-08-01 挂载 · 架构优化 P4，判据见 budgetLines 头注）。
  //    这一项守**总量**——它是这几道里唯一每次都打印一个数字的，因为减法没有天然触发器。
  for (const line of runWithinBudget("always-on 字节预算闸", NODE_MIN_SLICE_MS, () => budgetLines(daoRoot))) drifts.push(line);

  // 9. per-provider 漂移（2026-08-02 挂载 · hooks=#50 / permissions.deny=#56，
  //    判据见 providerHookLines 头注）。第 6 项比的是 live ↔ git 快照，而 #49 实测证明
  //    **真正的下发源是 `providers.settings_config`**，那一层此前无人看着。
  for (const line of runWithinBudget("per-provider 漂移检查", NODE_MIN_SLICE_MS, () => providerHookLines(daoRoot))) drifts.push(line);

  // 10. memory 指针一致性（2026-08-02 挂载 · 自上而下审计第 12 件，判据见 memoryRefLines 头注）。
  //     前九项守的都是**仓里的东西**；这一项是唯一一个守仓外的 —— memory 每次会话注入、
  //     却不受任何 git 管，此前只有某个项目的 verify-all 才会碰它。
  for (const line of runWithinBudget("memory 指针扫描", NODE_MIN_SLICE_MS, () => memoryRefLines(daoRoot))) drifts.push(line);

  // 11. 条款库结构闸（2026-08-01 挂载，判据与三态输出策略见 clauseStructureLines 头注）。
  //     只在元仓库跑；它守的是 ccswitch/dao.md 自己，而 dao.md 此前从未被任何闸守过。
  //     **排在这里而不是最前**是本次(issue #141)的改动本身：它是本文件成本最高、且
  //     唯一自带逐文件降级的一项，放最后能让它成为吸收预算波动的那一道（理由见上方大注）。
  for (const line of clauseStructureLines(daoRoot)) drifts.push(line);

  // 12. 预算余量本身（2026-08-04 · issue #127）。**每次都打印一行数字**，理由与第 8 项
  //     的 always-on 字节预算逐条相同：这里的成本也是**只增不减**（rules/ 每长出一份
  //     带条款的 .md 就多一次 PowerShell 冷起），而增长是无声的 —— 没人看得见「又慢了
  //     600 ms」，直到某天整个 hook 连同全部检查一起被宿主静默杀掉。
  //     **刻意不设「余量低于 X 才提醒」的阈值**：那个 X 会变成又一个没人记得依据的魔数。
  //     ⚠ 三行的次序是有意的：**先报「谁没跑」，再报余量数字**（gitSkipLines 必须排在
  //     budgetSummaryLines 之前 —— 后者要打印 `BUDGET.skipped.length`，而 git 那一笔
  //     是在前面记进去的，顺序颠倒会让汇总行少数一项）。
  for (const line of budgetLibErrorLines()) drifts.push(line);
  for (const line of heartbeatLibErrorLines()) drifts.push(line);
  for (const line of gitSkipLines()) drifts.push(line);
  for (const line of budgetSummaryLines()) drifts.push(line);

  return drifts;
}

// ── J2：全绿行聚合（2026-08-09 · 用户拍板 issue #70 评论 5230277293 第一组）──────
// 治的是什么：daoSyncLines() 无论有没有真发现都会跑满上面 12 步，常路（无漂移）下仍会
// 输出好几行 "ⓘ ...绿" 状态播报，字节占比不小却零决策价值——机制体检实测基线：
// 一份 14 行报文里有 6 行属于这一类，占报文总字节数 62.8%。
// 判据两层（第二层是 2026-08-09 · PR #237 对抗验证 5230986835 F1 返修，帅裁定「这一格
// 按行为修，不只改文字」）：
//   ① 一行算「候选绿」当且仅当它以 "ⓘ" 开头、且**不含任何嵌入的 "⚠"**。不是装饰——
//      budgetLines() 的「过渡期」分支、providerHookLines() 的 deny 面缺字段分支都会把
//      一段 "⚠ ..." 拼进同一个以 "ⓘ" 开头的字符串里：那不是「通过」，是「带着保留
//      意见通过」，必须算非绿，否则聚合会把这些警示一并吞掉。
//   ② 候选绿还要不命中 NON_PASS_PATTERNS 才算真绿——①拦不住的是「整句仍以 ⓘ 开头、
//      正文却明写着这不算通过」的形态：~~对抗官全域摸底揪出本文件已知五处~~ 判词原话
//      口径（PR #237 对抗验证 5231324695 订正）：「有 6 种 ⓘ 行不是语义上的绿，其中
//      5 处的行内文字或函数头注自己写着相反的话」——上一轮（F1）只覆盖了那 5 处，
//      误记成「已知五处」；遗漏的第 6 处——clauseStructureLines() 的条款库退役观察线
//      ——由本轮（F5）补齐，见下方 NON_PASS_PATTERNS⑥。这 5 处里，memoryRefLines()
//      的 skipped 分支**生产环境当场坐实**——本机实测 memory 指针扫描 dead=24 时，
//      整条汇总行仍以 ⓘ 开头、不含 ⚠，①会把它判成候选绿、聚合时连同 24 条死指针
//      一起吞掉。**这不是通用判据**：只覆盖这~~六~~**七**处已知形态各自的稳定锚点（含各自的
//      姊妹分支——deadGateLines() 的 orphan 与 unverifiable 共享同一条返回语句、
//      memoryRefLines() 的 dead/ambiguous/skipped 共享同一条返回语句、
//      clauseStructureLines() 的 retire/promote 共享同一条返回语句，任一非零都要
//      命中，不只是对抗官原话点名的那一个子项），不是把「ⓘ 但有保留」这整类形态
//      结构化——让每个子检查各自返回类型化 status 是更彻底但更贵的重构，本批不做
//      （未尽处①）。新增的同类形态需要新增一条 pattern，这是选「文本锚点」而不是
//      「结构化状态」必须承受的已知代价。
// ✗/⚠/⬆/⬇/⏱ 开头的行天然过不了「以 ⓘ 开头」这一关，不需要单独判。
// 聚合判据是**整段**（对 lines 数组作为一个整体求值），不是逐行各自决定要不要露面：
// 只要有一行不绿，**整段原样展开**——避免「5 行绿 + 1 行真问题」被误读成「大体没事」。
const NON_PASS_PATTERNS = [
  // ①providerHookLines()：denySampled===false（deny 面零样本，"没比到"不是"已对齐"）
  /deny 面零样本/,
  // ②clauseTargets()：带条款签名却不在 clause-parser.mjs 的源清单里
  /条款文件未登记进 defaultSources\(\)/,
  // ③deadGateLines()：todo 非空分支——孤儿 hook 与命令串无法核验共用同一条返回语句，
  //   锚在分支专属前缀上，两个子项谁非零都命中，不必分别匹配
  /零死闸），另有：/,
  // ④clauseStructureLines()：非 Windows 平台未跑（本闸是 PowerShell 实现，无法验证）
  /条款库结构闸未跑（非 Windows/,
  // ⑤memoryRefLines()：parts 非空分支——dead/ambiguous/skipped 三个子项共用同一条
  //   拼接语句，任一非零都命中其一（对抗官原话点名的是 skipped 那一项，这里连带把
  //   dead/ambiguous 两个姊妹子项也钉住，理由同③）
  /处指向空气|处相对路径没写清相对于谁|处因项目根不可解析未判/,
  // ⑥clauseStructureLines()：retire/promote 非零分支——条款库到期该退役 / 候选该升格的
  //   观察线（PR #237 对抗验证 5231324695 F5 返修：判词原话数的是 6 种，上一轮（F1）
  //   只覆盖了 5 处，这是遗漏的第 6 处；e2e 实测该行仍以 ⓘ 开头、不含 ⚠，被①判成候选绿、
  //   聚合时连同待退役条款一起吞掉。`RetireAgeDays` 缺省 21 天，判词实测当前 21 条台账
  //   记录年龄落在 16–20 天，预计 2026-08-11 起在生产里从 0 变活）。锚在 retire/promote
  //   两个子项共用的固定短语上，谁非零都命中，~~同③⑤同一手法（不必分别匹配两个数字）~~
  //   **PR #237 三轮复看 5231769847 改真**：这不是③⑤那种姊妹覆盖——`:899-902` 那条 return
  //   把两个子项的文字无条件拼接、只有数字变，不存在「锚点收窄会漏掉某个姊妹」的风险
  //   （③⑤是条件 push，文本随之增减，收窄才真的会漏）；M-R1b 实测坐实：同型收窄下 ⑥ 零红、
  //   ③ 的孤儿子项 ③b 仍单红。⑥b 保留为同谓词冗余断言，不宣称它守着 ⑥a 之外的东西
  /条款库观察线/,
  // ⑦budgetSummaryLines()：「本次跳过 N 项」的 N>0 分支（issue #256 账 3，出处 PR #237
  //   对抗验证 5231324695 §八 观察项 1）。它是判词穷举读码时点名的**同族第七个候选**
  //   ——不在判词数的那 6 种里（那 6 种「行内文字或函数头注自己写着相反的话」，这一条
  //   没有那句话，它只是一个数字），此前**没有任何断言在守**，靠一条隐式耦合兜住：
  //   `BUDGET.skip()` 与 `gitKilled` 两条路各自都会往报文里另塞一行 `⏱ … **没跑**`，
  //   而 `⏱` 开头的行过不了「以 ⓘ 开头」那一关 ⇒ 只要有跳过就必然存在非绿行 ⇒ 整段
  //   不聚合。**这条耦合从来没被写下来过，也没有任何东西在钉它**：哪天有人重构成
  //   「只计数不打印独立的 ⏱ 行」（比如把计数并进别的汇总行），「跳过了 3 项」就会
  //   跟着「N 行全绿」一起被吞掉，而红灯一个都不会亮。本条把它从**隐式耦合**转成
  //   **显式判据**，与①～⑥同构 —— 转完之后那条耦合不再承重（它仍然成立，只是不再是
  //   唯一的防线）。锚点刻意写成 `[1-9]\d*` 而不是 `\d+`：**N=0 是真绿**（这道汇总行
  //   每次都打印，恒非零就等于让元仓库永不聚合，把 J2 整个废掉），误伤反例见
  //   tests 侧「负控⑦」。
  /本次跳过 [1-9]\d* 项/,
];
function isGreenSyncLine(line) {
  const s = String(line);
  return /^ⓘ/.test(s) && s.indexOf("⚠") === -1 &&
    !NON_PASS_PATTERNS.some((re) => re.test(s));
}
function aggregateGreenSync(lines) {
  if (lines.length && lines.every(isGreenSyncLine)) {
    // 措辞用「行」不用「项检查」（2026-08-09 · PR #237 对抗验证 5230986835 F2 返修）：
    // lines.length 数的是数组元素条数，不是逻辑检查项数——条款闸单个文件观察线一次能
    // 吐好几行（实测：多放一份带签名却未登记的 rules/*.md，六道检查能吐出 7 个数组
    // 元素）。「N 项检查」这个措辞会让读者读成「N 个检查项」，与实况不符；「N 行
    // 全绿」只陈述数组长度，不代入语义。
    return { lines: ["ⓘ " + lines.length + " 行全绿"], aggregated: true };
  }
  return { lines, aggregated: false };
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
    if (!fs.existsSync(path.join(cwd, ".git"))) done("skip-not-git");
  } catch (_) { done("skip-not-git"); }
}

const issues = [];
// J2：daoSyncLines() 的原始行先经 aggregateGreenSync 判「整段是否全绿」——全绿则聚合成
// ~~一行「N 项检查全绿」~~ 一行「N 行全绿」（F2 已把报文措辞改真，本行是 38 行外的引用，
// PR #237 对抗验证 5231324695 R3 同批订正：改一条陈述时 Grep 面要含该对象自己的源文件与
// 头注 [#官通-同批查引用]），否则原样透传（daoSyncAgg.aggregated 供下面拼报文头时判断措辞）。
const daoSyncAgg = isMetaRepo ? aggregateGreenSync(daoSyncLines()) : { lines: [], aggregated: false };
const daoSync = daoSyncAgg.lines;

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

if (issues.length === 0 && activeWork.length === 0 && daoSync.length === 0) done("clean");

const parts = [];
if (daoSync.length > 0) {
  // J2 聚合态下头部换一句不自相矛盾的措辞——聚合后的内容是「全绿播报」，
  // 原头部「存在以下同步差异」在这一态下是假话（没有差异，只有健康度播报）。
  // 非聚合路径**字面不改一个字**（旧行为原样保留，回归面只在聚合态这一支）。
  const openLine = daoSyncAgg.aggregated
    ? "【dao 同步漂移检测】windsurf-dao 本轮同步/配置自检结果：\n"
    : "【dao 同步漂移检测】windsurf-dao 存在以下同步差异：\n";
  const tail = daoSyncAgg.aggregated
    ? "\n请在回答末尾简洁提醒用户。"
    : "\n⬇=远程/快照领先本地（需下行） ⬆=本地领先远程/快照（需上行）。请在回答末尾简洁提醒用户。";
  parts.push(openLine + daoSync.join("\n") + tail);
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
  for (const line of heartbeatLibErrorLines()) issues.push(line);
  for (const line of gitSkipLines()) issues.push(line);
}
