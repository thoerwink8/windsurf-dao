// dao glob-gate hook — 补 Windsurf glob trigger 缺口
//
// Claude Code 无原生 "编辑某类文件时注入规则" 机制(Windsurf glob trigger 的对应缺口)。
// 本 hook 在 Edit/Write/MultiEdit 后,按目标文件类型注入 dao 提醒:
//   - 代码文件(.ts/.py/...) → 提醒过 dao-quality 质量门
//   - dao 元层文件(ccswitch/dao.md / dao-* skill·command·agent) → 提醒过 dao-meta 三关
//   - **被 mutation 守护的源文件 → 提醒先读写守卫判据**(2026-08-07,issue #122,见下)
//
// 配在 PostToolUse(改完即提醒,语义比 PreToolUse 更贴"收尾前验证")。
// 始终 exit 0,只注入不阻断。
//
// ── 守卫指针分支(issue #122 · 用户 2026-08-07 拍板的 hybrid 投递)─────────────
// 「改守卫前先读写守卫判据」此前只有**读触发**一条通道(ccswitch/rules/scoped/ 的
// paths: glob,宿主在 Read 到匹配文件时注入)。回测实测:那份 glob 恰好漏掉 issue #103
// 例 2 的当事文件 ccswitch/templates/check-token-drift.mjs,而那个文件近 11 天
// **Read 0 次 / Edit·Write 7 次** —— 读触发对它结构性失明。
// ⇒ 本分支挂 Edit/Write,判据清单 ccswitch/guarded-files.json 由
//   ccswitch/scripts/gen-guarded-files.mjs 从 mutation 测试实况**自动算**(手维护必滞后)。
//
// 三条设计约束,都是刻意的:
//   ① **只加一行指针,不复制判据正文** —— 副本会漂移,而这条规则还在演进
//      (同 ccswitch/rules/scoped/dao-scope-guard-writing.md 的取舍)。
//   ② **advisory,不拦截** —— 本 hook 在 PostToolUse 上,改动已经发生;它是提醒不是闸。
//   ③ **fail-open** —— 清单读不到/解析坏了 ⇒ 静默跳过本分支,其余分支照常。
//      「清单坏了」因此**不会**在正常运行时出声,故它必须在别处看得见:
//      `node ccswitch/hooks/dao-glob-gate.js --selfcheck` 会把清单状态打出来并给出退出码。
//      (为什么不做成运行时报错:一个每次编辑都可能打噪音的 hook 会被静音,
//       而被静音的 hook 与不存在的 hook 等价。)
//      🔴 **已知格:`--selfcheck` 的 exit 0 单独看不够,必须核 `GLOB_GATE_SELFCHECK` 那一行在不在**
//      (2026-08-07 对抗验证官实测,本 PR 返修补记)。**本分支落地之前**的这个文件不认识
//      `--selfcheck`:未知参数被忽略、`readFileSync(0)` 在无管道输入时读到空串、JSON 解析失败
//      吞掉、toolName 为空 ⇒ **静默 exit 0、零输出**。于是「自检通过」与「你跑的是一份还没有
//      自检的旧副本」在退出码这个唯一的机器通道上**逐字节相同** —— 那正是本仓那句
//      「数到 0 和没看到样本,输出一模一样」。射程:凡是**部署副本可能滞后于仓内版本**的时刻都成立
//      (~/.claude/ 的链接指向别处、别的 worktree、别的机器还没拉),不限于本 PR 的过渡期。
//      ⇒ 消费方(人或脚本)判「自检过了」的判据是 **`GLOB_GATE_SELFCHECK exit=0 manifest=ok`
//      这一行出现过**,不是 `$?` 等于 0。回归网 tests/guarded-files.tests.js §⑥ 的
//      selfcheck 断言正是这么写的(正态断言那一行的正则,不只断言退出码)。
//
// 🔴 **本分支是叠加的,不是替换的**:它接在既有四条分支算出的 context **后面**,
//    所以既有分支的行为一个字节都没变(那批断言原样全绿即是证明)。
//
// 真相源:windsurf-dao/ccswitch/hooks/dao-glob-gate.js
// 由 settings.json 的 PostToolUse hook 调用。
// 回归网**两份,改这个文件时都要跑**:
//   · tests/glob-gate.tests.js       前四条分支(正控 + 误伤负控 + settings.json 文案逐条钉死
//                                    + 三向 mutation 判别力 + 真文件字节恒等 canary)
//   · tests/guarded-files.tests.js   守卫指针分支(正控/负控/fail-open/--selfcheck
//                                    + 三形态&反向 mutation) 与清单生成器的口径

const fs = require("fs");
const path = require("path");

// ── 守卫清单:加载与匹配 ─────────────────────────────────────────────────────
// 清单路径按**本文件位置**算(hooks/ 的上一级),不按 cwd —— hook 的 cwd 是被编辑项目的
// 根目录,按 cwd 找会在任何非 dao 仓的项目里静默落空。
const GUARDED_MANIFEST = path.join(__dirname, "..", "guarded-files.json");

function loadGuarded() {
  let text;
  try { text = fs.readFileSync(GUARDED_MANIFEST, "utf8"); }
  catch (e) { return { ok: false, why: "读不到(" + (e && e.code ? e.code : "unknown") + ")", files: [] }; }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { return { ok: false, why: "不是合法 JSON(" + (e && e.message ? e.message.slice(0, 60) : "") + ")", files: [] }; }
  const files = Array.isArray(doc && doc.files)
    ? doc.files.map((x) => (x && typeof x.file === "string" ? x.file : null)).filter(Boolean)
    : [];
  if (!files.length) return { ok: false, why: "清单里一个文件都没有(files 缺席或为空)", files: [] };
  return { ok: true, why: "", files };
}

// 匹配用**后缀**:清单记的是仓相对路径,而 tool_input.file_path 可能是绝对路径、
// worktree 里的路径、或相对路径。
// ⚠ 近似,照直写:另一个仓里同名同相对路径的文件也会命中(如别人 fork 了 ccswitch/)。
//   往误报一侧偏是刻意的 —— 这是一行 advisory 指针,多提醒一次的代价远小于漏提醒。
//   反过来,**经 ~/.claude/ 的 symlink 路径编辑同一个文件不会命中**(那条路径里没有
//   `ccswitch/`),那是已知漏报面。
function matchGuarded(normPath, files) {
  for (const rel of files) {
    if (normPath === rel || normPath.endsWith("/" + rel)) return rel;
  }
  return null;
}

// ── --selfcheck:让 fail-open 的失败态在别处看得见 ────────────────────────────
// 必须在读 stdin 之前处理:本 hook 的正常入口是 `readFileSync(0)`,在没有管道输入的
// 终端里那会一直等下去。
if (process.argv.includes("--selfcheck")) {
  const g = loadGuarded();
  const w = (s) => process.stdout.write(s + "\n");
  w("== dao-glob-gate --selfcheck ==");
  w("  守卫清单：" + GUARDED_MANIFEST);
  if (g.ok) {
    w("  状态：可用 · " + g.files.length + " 个被守护源文件");
    w("  抽样：" + g.files.slice(0, 3).join(" / ") + (g.files.length > 3 ? " …" : ""));
    w("  ⓘ 它证不了的：清单**内容对不对**归 `node ccswitch/scripts/gen-guarded-files.mjs --check`；");
    w("     本自检只答「这个 hook 此刻读得到一份非空清单吗」。");
    w("GLOB_GATE_SELFCHECK exit=0 manifest=ok files=" + g.files.length);
    process.exit(0);
  }
  w("  状态：**不可用** —— " + g.why);
  w("  后果：守卫指针分支静默不触发（fail-open），其余分支不受影响。");
  w("  修法：node ccswitch/scripts/gen-guarded-files.mjs");
  w("GLOB_GATE_SELFCHECK exit=1 manifest=bad files=0");
  process.exit(1);
}

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const toolName = input.tool_name || "";
const filePath = (input.tool_input && input.tool_input.file_path) || "";

if (!/^(Edit|Write|MultiEdit)$/.test(toolName) || !filePath) {
  process.exit(0);
}

const norm = filePath.replace(/\\/g, "/");

// 代码文件扩展名(对齐原 quality.md globs)
const isCode = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|swift|kt|scala|vue|svelte|sql)$/i.test(norm);

// 前端/UI 文件:除代码型组件外,纯样式文件(.css/.scss/.less)也算 —— 触发 dao-design（open.md）
const isFrontend = /\.(tsx|jsx|vue|svelte|css|scss|less)$/i.test(norm);

// dao 元层文件:ccswitch/dao.md 或 ccswitch/{skills,commands,agents}/dao-*
// 路径可能是绝对(D:/.../ccswitch/dao.md)或相对(ccswitch/dao.md),故用 (^|/) 兼容两者
const isDaoMeta = /(^|\/)ccswitch\/dao\.md$/.test(norm) ||
                  /(^|\/)ccswitch\/(skills|commands|agents)\/dao-/.test(norm) ||
                  /(^|\/)\.windsurf\/(rules|skills|workflows)\//.test(norm);

// settings.json / windsurf-dao 文件改动 → 提醒同步
const isSettingsJson = /[\\/]\.claude[\\/]settings\.json$/.test(norm) || /[\\/]\.claude[\\/]mcp_servers\.json$/.test(norm);
const isWindsurfDaoFile = /[\\/]windsurf-dao[\\/]/.test(norm) && !/(node_modules|_tmp|\.git)[\\/]/.test(norm);

let context = "";
if (isDaoMeta) {
  context = "【dao-meta 守卫】本次改动涉及 dao 元层文件。收尾前过三关:① 通用性(换项目还成立吗) ② 内容边界(只许思维/流程/准则,禁技术选型/API/配置) ③ 影响评估(会让其他 dao 项目变差吗)。不通过 → 路由到项目 AGENT.md/CLAUDE.md。双栈共存:ccswitch/ 与 .windsurf/ 哲学需一致。";
} else if (isSettingsJson) {
  // live settings.json 是 cc-switch 下发的**投影**:改它立即生效但不持久,下次切 provider 即被整体覆盖。
  // 真实下发源 = cc-switch DB `providers` 表**各 provider 自带**的 `settings_config`(用户在 GUI 编辑
  // provider 配置或执行 SQL),下发只挂在「切换 provider」那一个动作上。
  // ⚠ 2026-08-02 改文案(issue #67):本分支原文教的正路是「同步改 git 快照层
  // config-sync/common/settings.json + 跑 dao.bat --direction=down」—— #49 的下发链实测证明,快照层与 DB 的
  // common_config_* 镜像层**都不在下发路径上**,照它做改动永不生效(PR #43 就是照旧文案做的:注册写满这两层
  // 而 live 始终未注册)。**一道提醒给出走不通的合法路径,比不给更糟**:照做的人会以为自己已经做完了。
  // 同型修复见 PR #68(硬闸 G2 的 stderr),~~两处口径刻意保持一致~~ **两处口径在「源与投影」那一格
  // 仍然一致,但 2026-08-08 起本分支多了一句 G2 那侧没有的**:「动过任一层 ⇒ 同一动作内跑漂移检测
  // 收尾」(用户点名固化进 dao.md `[#Shell-源与投影]`,commit 49f4a4d;issue #190 认领它的机器投递
  // 半件)。G2 的 stderr **本批未同批加** —— 那侧的文案被 hard-gates 测试以逐字锚点钉着,加一句要
  // 连锚一起改,属另一个批次;差异照直记在这里,免得下一个人读到「刻意保持一致」而据此推断 G2 也有。
  // 本分支的投递面比 G2 更宽 —— G2 只在有人
  // 写 live 那一份时才打,本分支是任何 settings.json/mcp_servers.json 改动后**自动注入 additionalContext**,
  // 不必等谁去读;而下面 isWindsurfDaoFile 分支的注释记着「错误提醒连续误导三名 subagent」,那正是这个
  // 投递面的实测后果。
  // 措辞刻意仍点名 `dao.bat --direction=down/up`,但把它从「正路」改成「别拿它来让配置生效」:旧说法散在
  // 历史文档与 PR body 里,光删不说等于让下一个人再试一次(同 PR #68 的取舍,故回归断言不写成反向的 !/direction/)。
  // ⚠ 文案里的「若这是 live 那一份」不是客套 —— isSettingsJson 正则对**项目级** .claude/settings.json 同样
  // 命中(它分不出 live 与项目级),所以这段话必须是条件式的,不能写成无条件断言。
  // **判定逻辑(isSettingsJson 正则、分支次序)一个字符未动,改的只有这段打给人看的话。**
  context = "【dao 同步提醒】你刚修改了 " + norm.split("/").pop() + "。⚠ 若这是 live `~/.claude/` 下的那份,它是 cc-switch 下发的**投影**——改它立即生效但不持久,下次切 provider 即被目标 provider 的配置整体覆盖。**真实下发源是 cc-switch DB `providers` 表各 provider 自带的 `settings_config`**:请用户在 cc-switch GUI 里编辑 provider 配置(或由用户执行 SQL)写进那一列,**且每个 provider 都要改**——切 provider 时 live 会被目标 provider 的配置整体覆盖,只改一个等于没改(per-provider 漂移,长期对齐机制挂 issue #50)。写 DB 属**用户动作**:AI 侧被权限分类器全路径拦截。⚠ **改 git 快照层 `config-sync/common/settings.json` 或 DB 的 `common_config_*` 镜像层都不会生效**——两层都不在下发路径上(#49 实测;PR #43 曾把 hooks 注册写满这两层而 live 始终未注册),所以也**不要建议跑 `dao.bat --direction=down/up` 来让它生效**。⚠ **动过任一层(live / DB providers / git 快照)就在同一动作内跑漂移检测收尾并贴真退出码**:dao 侧 = `node ccswitch/lib/settings-drift.js` 裸跑 + 加 `--providers` 两面都跑 —— SessionStart 那条提醒是**下一个窗口才响的兜底,不算收尾**。判据见 dao.md「改配置先认源与投影」。";
} else if (isWindsurfDaoFile) {
  // 2026-07-27 修:本分支原文无条件建议跑 `--direction=up`,而 up 走 config-sync/lib/export.mjs 的
  // `selectRows('settings', "WHERE key LIKE 'common_config_%'")` —— 只从 SQLite DB 读,**看不见 ccswitch/ 下的
  // git 源文件**。故对 ccswitch/ 的改动,up 不仅无必要,还会用旧 DB 状态覆盖快照。该错误提醒已连续误导三名
  // subagent 照抄进交付报告(刀C/备案官/沉淀官,2026-07-26~27),属「每次都在误导」形态,优先级高于一次性错误。
  context = "【dao 同步提醒】你刚修改了 windsurf-dao 仓库文件。收尾提醒用户:① 提交并 `git push`(这是 ccswitch/ 下改动**唯一**需要的动作——hooks 现注册仓库路径、skills/commands/agents 走 symlink,改文件即生效,零部署步骤) ② **不要建议 `dao.bat --direction=up`**:up 只从 cc-switch DB 读并覆盖 git 快照,看不见 ccswitch/ 下的源文件;只有当你改了 `config-sync/common/*.json` 快照层、需要写回 DB 时,用的也是 `--direction=down` 而非 up ③ 若新建了 hook 文件,确认 settings.json 已注册(改既有 hook 文件不需要)。";
} else {
  // 非元层文件:按文件性质叠加提示(代码型→质量门;前端/UI→design-taste,二者可同时命中如 .tsx)
  const parts = [];
  if (isCode) {
    parts.push("【dao-quality 质量门】本次改动涉及代码文件。收尾前按任务领域过检查清单:安全(输入验证/认证/无硬编码密钥)· 数据库(N+1/索引/migration 可逆)· 测试(核心路径+边界)· 错误处理(不吞异常)· 性能(分页/无重复计算)。匹配领域而非全扫;发现问题当场修;改完跑构建/测试再声明完成。");
  }
  if (isFrontend) {
    parts.push("【dao-design】UI/前端改动:有 design/ 目录时以 Open Design 原型为视觉真相源 · 三维对齐(结构/视觉/交互) · a11y · 表单/控件走项目 ui/* 体系勿用原生 element。改完截图对比 design/*.html 再声明完成。");
  }
  context = parts.join(" ");
}

// ── 守卫指针(叠加在上面任何一条分支之后,不替换它们)──────────────────────────
// 措辞刻意只有一句 + 一个路径:它的职责是**把人送到判据正文**,不是复述判据。
// 长度量级 ~0.3 KB —— 回测里 hybrid 那一档按「一行指针」估的日均代价就是这个量级,
// 写成一段说明会把这条通道最便宜的那个属性弄丢。
{
  const g = loadGuarded();
  const hit = g.ok ? matchGuarded(norm, g.files) : null;
  if (hit) {
    const note = "【dao 守卫判据】你正在改一个**被 mutation 守护**的文件(" + hit + ")。" +
      "改判据/护栏前先 Read `ccswitch/rules/dao-guard-writing.md`(全域分布 / 自检不复用被守对象的解析 / " +
      "输出不落在自己扫描面内 / 给退役造触发器)。改完记得让守它的那些 mutation 仍然红得起来。";
    context = context ? context + " " + note : note;
  }
}

if (context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context
    }
  }));
}

process.exit(0);
