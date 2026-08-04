// dao-hard-gates 回归网 — 每闸正控 + 误伤负控 + mutation 判别力 + canary 恒等
//
// 跑法：node tests/hard-gates.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么这份测试的形态是这样 ──────────────────────────────────────────────
// 被测对象是**一道会 exit 2 拦人的闸**，它的两侧代价都是真代价：
//   · 漏报 → 那条禁令仍然只是文字，而文字禁令的实测遵守率是 0%（arxiv 2607.26819）
//   · 误报 → 合法动作被拦死，而甲类闸的逃生阀只有用户设得了 ⇒ 会话当场卡住
// 故每闸都是**双向断言**：违例必 exit 2 且 stderr 里给得出合法路径；合法输入必 exit 0。
// 只证明「能拦住」不算完成 —— 这是 dispatch-clauses 实现官节点名要求的那一条。
//
// ── mutation 为什么写进回归网而不是手工跑一次 ───────────────────────────────
// 「测试存在」不等于「测试有判别力」。手工 mutation 只发生一次，判据却会被反复编辑。
// 故本文件把 mutation 做成常驻断言：把某一闸的判定**改坏**（写进 _tmp/ 的副本，
// 从不碰真文件），断言原本 exit 2 的那条用例变成 exit 0；再断言真文件在整个过程中
// 逐字节没动过（canary 恒等）。任何一天有人把某条判据写成永假，这里会红。
//
// ── 已知不覆盖（照直写，别读成全覆盖）──────────────────────────────────────
// · matcher 覆盖面只由 `--selfcheck` 自查，本文件只断言它的**输出形态**——
//   真实注册状态取决于用户的 live settings.json，锚死会让测试随用户配置变红。
// · fail-open 路径用「注入一个必抛的判定」构造，证的是「崩了会放行且会喊」，
//   证不了「所有崩法都能被 catch 到」（catch 不住的崩法：进程级 OOM/被杀）。
// · G5 的 `--body-file` 只测真实可读文件；「文件读不到 ⇒ 放行」这个漏报面
//   有一条负控钉着，但那是**有意为之**（见 hook 内注释），不是待修的洞。
// · G6 与 dao-rhythm.js WAKEUP 信号的**跨文件判据一致性**不在本文件，在
//   `tests/dao-rhythm.tests.js` 末尾那一组（那边有现成的沙箱，能避开真实埋点日志污染）。
//   放在这里只留指针：判据有两份实现，一致性只由那一组钉着，改任一侧都要看它。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-hard-gates.js");
const NUDGE = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
const TMP = path.join(REPO, "_tmp", "hard-gates-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const HOME = process.env.USERPROFILE || process.env.HOME;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function sha(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// 喂一次 PreToolUse 输入。script 缺省=真 hook；env 用于测逃生阀。
function gate(payload, { script = HOOK, env = {} } = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, err: String(r.stderr || ""), out: String(r.stdout || "") };
}

function nudge(command, toolName = "Bash") {
  const r = spawnSync(process.execPath, [NUDGE], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: "utf8",
  });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  return String((out.hookSpecificOutput || {}).additionalContext || "");
}

const bash = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, cwd });
const edit = (file_path) => ({ tool_name: "Edit", tool_input: { file_path } });
const wake = (tool_input) => ({ tool_name: "ScheduleWakeup", tool_input });

// 每闸的一条"承重正控"，mutation 与 canary 都拿它当靶
const CANARY = {
  "G1-windows-mcp": { tool_name: "mcp__windows-mcp__Screenshot", tool_input: {} },
  "G2-live-settings": edit(path.join(HOME, ".claude", "settings.json")),
  "G3-publish": bash("npm publish --access public"),
  "G4-screenshot-path": {
    tool_name: "mcp__chrome-devtools__take_screenshot",
    tool_input: { filePath: "D:/frank/mousse-cli/shot.png" },
  },
  "G5-readonly-todo": bash('gh pr create --title x --body "做完了\n- [ ] 还没跑测试"'),
  // 取一条**真实语料形态**当承重正控：这段开头逐字抄自 ~/.claude/projects 里的历史心跳
  // （全量普查 993 次 ScheduleWakeup 调用，非 stop 的 962 次全长这样，零次带签名）。
  // 拿真实形态当靶，是为了让「闸上线后第一天会拦到什么」这件事在测试里就看得见。
  "G6-heartbeat-signature": wake({
    delaySeconds: 1500,
    prompt: "高性能目标窗心跳（不限时，目标=除蓄水池外 issue 清零）。对账：① 三路在途……",
  }),
  // 同样取**真实语料形态**：这条逐字抄自转录（`sed -n` 读文件片段是新增拦截面里第三大的一格）。
  // 注意它带 `cd … &&` 前缀 —— 真语料里 grep/sed 极少单独出现，绝大多数长这样，
  // 而这正是「段首」判据最容易写错的地方（`cd` 会把真正的命令挤到第二段去）。
  "G7-shell-search": bash("cd /d/frank/mousse-cli && sed -n 1,140p crates/mousse-app/src/commands/session.rs"),
};

const PRISTINE_SHA = sha(HOOK);
const canaryBefore = {};
for (const [id, p] of Object.entries(CANARY)) canaryBefore[id] = gate(p).code;

console.log("\n──── G1 · windows-mcp 全面禁令（一票否决，无逃生阀）────");
{
  for (const t of ["mcp__windows-mcp__Screenshot", "mcp__windows-mcp__Click", "mcp__windows_mcp__PowerShell"]) {
    const r = gate({ tool_name: t, tool_input: {} });
    check(`正控：${t} → exit 2`, r.code === 2, `code=${r.code}`);
    check(`正控：${t} stderr 给得出替代工具`, /chrome-devtools|playwright/.test(r.err), r.err.slice(0, 120));
  }
  // 无逃生阀：即便把别的闸的 env 全设上也拦
  check("无逃生阀：设了所有已知 env 仍 exit 2",
    gate(CANARY["G1-windows-mcp"], {
      env: { DAO_SETTINGS_EDIT_APPROVED: "1", DAO_PUBLISH_APPROVED: "1", DAO_ALLOW_READONLY_TODO: "1" },
    }).code === 2);

  const negatives = [
    ["chrome-devtools 截图（无路径）不该拦", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: {} }],
    ["playwright 点击不该拦", { tool_name: "mcp__playwright__browser_click", tool_input: {} }],
    ["名字里含 windows 但非 windows-mcp 服务器不该拦", { tool_name: "mcp__fs__read_windows_file", tool_input: {} }],
    ["内置 PowerShell 工具不该被当成 windows-mcp", bash("Get-Process node")],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G2 · live ~/.claude/settings.json（投影，非源）────");
{
  for (const n of ["settings.json", "settings.local.json"]) {
    const r = gate(edit(path.join(HOME, ".claude", n)));
    check(`正控：Edit ${n} → exit 2`, r.code === 2, `code=${r.code}`);
    // ⚠ 2026-08-02 issue #63 改钉：原先这两条钉的是「指出 config-sync 快照层 + direction=down 是正路」，
    // 而那条路径已被 #49 的下发链实测证伪（快照层与 common_config_* 镜像层都不在下发路径上，
    // 照它做改动永不生效，PR #43 即如此）。现在钉的是①真实下发源②那两层**被明说为不生效**。
    // **刻意不写成 `!/direction/` 那种反向断言**：新文案仍然点名 `dao.bat --direction=down/up`，
    // 只是把它从「正路」改成「别拿它来让 hook 生效」——禁令本身有价值（旧说法散在 PR body 与
    // 历史文档里，光删不说等于让人再试一次）。两条断言在文案被回退成旧版时都会红（已 mutation 实测）。
    check(`正控：${n} stderr 指出真实下发源 providers.settings_config + 每个 provider 都要改`,
      /providers/.test(r.err) && /settings_config/.test(r.err) && /每个 provider 都要改/.test(r.err), r.err.slice(0, 300));
    check(`正控：${n} stderr 明说快照层/镜像层不会生效（旧「正路」已被 #49 证伪）`,
      /镜像层/.test(r.err) && /不会生效/.test(r.err), r.err.slice(0, 300));
  }
  check("正控：Write（整份覆写）同样拦",
    gate({ tool_name: "Write", tool_input: { file_path: path.join(HOME, ".claude", "settings.json") } }).code === 2);
  check("正控：反斜杠路径同样拦（Windows 原生形态）",
    gate({ tool_name: "Write", tool_input: { file_path: `${HOME}\\.claude\\settings.json` } }).code === 2);
  check("逃生阀：DAO_SETTINGS_EDIT_APPROVED=1 → 放行",
    gate(CANARY["G2-live-settings"], { env: { DAO_SETTINGS_EDIT_APPROVED: "1" } }).code === 0);
  check("逃生阀只认 '1'，不认 'true'（免得随手设个值就等于关掉闸）",
    gate(CANARY["G2-live-settings"], { env: { DAO_SETTINGS_EDIT_APPROVED: "true" } }).code === 2);

  const negatives = [
    // 名字 2026-08-02 (#63) 改过：原写「改 git 快照层是正路」——**那句话本身已被 #49 证伪**
    // （快照层不在下发路径上）。断言不变、覆盖面不变：本闸只管 live 那一份，仓内文件本就不该拦。
    ["改仓内 config-sync 快照层不该拦（本闸只管 live 那一份；快照层能不能生效是另一回事）",
      edit(path.join(REPO, "config-sync", "common", "settings.json"))],
    ["改项目级 .claude/settings.json 不该拦（那不是 cc-switch 投影）",
      edit("D:/frank/mousse-cli/.claude/settings.json")],
    ["改 ~/.claude 下的别的文件不该拦", edit(path.join(HOME, ".claude", "CLAUDE.md"))],
    ["写 _tmp/settings-patch.json 是 dao 指定的降级路径，不该拦",
      edit(path.join(REPO, "_tmp", "settings-patch.json"))],
    ["Read 不该拦（本闸只管写）", { tool_name: "Read", tool_input: { file_path: path.join(HOME, ".claude", "settings.json") } }],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G2 · shell 写入面（issue #87 扩面）· 双向语料夹击 ────");
// ── 这一节为什么单独存在 ─────────────────────────────────────────────────────
// 2026-08-02 实测绕过：`Copy-Item "<源>" "$env:USERPROFILE\.claude\settings.json" -Force`
// 一次踩中两处失明 —— ①它是 PowerShell 工具调用，进不了 Edit/Write 分支 ②路径是变量形态。
// **承重正控用的是那条命令的原文**（下面第一条，逐字抄自 `~/.claude/projects` 转录），
// 不是自己编的近似串 —— 编出来的语料只能证明「我写的正则匹配我写的字符串」。
// **负控里标着「真语料」的 6 条同样逐字抄自转录**：它们全是**备份**（源位是 live），
// 而备份恰恰是本闸 `how` 里劝人走的那条路。判据若写成「这一段提到 live settings 就拦」，
// 这 6 条真实命令全部误伤，而逃生阀只有用户设得了 ⇒ 会话当场卡住。
{
  const ps = (command, cwd) => ({ tool_name: "PowerShell", tool_input: { command }, cwd });
  const V = "$env:USERPROFILE";           // 拼出来，免得本文件正文自己长得像一条待拦命令
  const LIVE_V = `"${V}\\.claude\\settings.json"`;
  // 本次绕过命令原文（真语料，session 9364d260 / 751b40c0 转录逐字）
  const BYPASS = `Copy-Item "D:\\frank\\windsurf-dao\\_tmp\\hook-register-202608\\03-merged.live-settings.json" ${LIVE_V} -Force; "COPY_EXIT=$LASTEXITCODE $?"`;

  const BLOCK = [
    ["#87 绕过命令原文（真语料·承重正控）", ps(BYPASS)],
    ["同一条命令走 Bash 工具送进来", bash(`Copy-Item src.json ${LIVE_V} -Force`)],
    ["${env:USERPROFILE} 花括号形态", ps(`Copy-Item src.json "\${env:USERPROFILE}\\.claude\\settings.json" -Force`)],
    ["%USERPROFILE% cmd 形态", ps(`Copy-Item src.json "%USERPROFILE%\\.claude\\settings.json"`)],
    ["$HOME + 正斜杠", bash(`cp _tmp/new.json "$HOME/.claude/settings.json"`)],
    ["~ 形态", bash("cp _tmp/new.json ~/.claude/settings.json")],
    ["Git Bash /c/ 盘符形态", bash("cp _tmp/new.json /c/Users/Administrator/.claude/settings.json")],
    ["已展开的字面绝对路径", ps(`Copy-Item src.json "${HOME}\\.claude\\settings.json" -Force`)],
    ["Move-Item 目标位", ps(`Move-Item _tmp/x.json ${LIVE_V} -Force`)],
    ["mv 目标位", bash("mv _tmp/x.json ~/.claude/settings.json")],
    ["-Destination 具名参数", ps(`Copy-Item -Path _tmp/x.json -Destination ${LIVE_V} -Force`)],
    ["-Destination: 冒号内联形态", ps(`Copy-Item _tmp/x.json -Destination:${LIVE_V}`)],
    // Out-File 几乎总在管道位 —— G7 对管道段整体豁免，G2 **刻意不豁免**（管道位正是它的目标位）
    ["Out-File 在管道位（G7 的管道豁免不适用于 G2）", ps(`$j | Out-File -FilePath ${LIVE_V} -Encoding utf8`)],
    ["Set-Content -Path", ps(`Set-Content -Path ${LIVE_V} -Value $json`)],
    ["Add-Content 位置参数", ps(`Add-Content ${LIVE_V} "x"`)],
    ["重定向 > 目标", bash('node -e "console.log(1)" > ~/.claude/settings.json')],
    ["重定向 >> 目标", bash('printf x >> "$HOME/.claude/settings.json"')],
    ["2> 也会截断（stderr 重定向同样是写）", bash("node t.js 2> ~/.claude/settings.json")],
    ["(Join-Path …) 折叠", ps(`Copy-Item _tmp/x.json (Join-Path ${V} '.claude\\settings.json') -Force`)],
    ["同命令内的字面量变量间接", ps(`$p = ${LIVE_V}; Copy-Item _tmp/x.json $p -Force`)],
    ["目标位给的是 .claude 目录（文件名由源 basename 决定）", bash("cp _tmp/settings.json ~/.claude/")],
    ["settings.local.json 同样拦", ps(`Copy-Item x.json "${V}\\.claude\\settings.local.json" -Force`)],
    ["cwd 恰是 home 时的相对路径", bash("cp new.json .claude/settings.json", HOME)],
    ["tee 目标", bash("printf x | tee ~/.claude/settings.json")],
    ["cd 前缀不影响段首判定", ps(`cd D:\\frank; Copy-Item x.json ${LIVE_V} -Force`)],
  ];
  for (const [name, p] of BLOCK) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2 && /G2-live-settings/.test(r.err), `code=${r.code}`);
  }
  check("承重正控的 stderr 指得出是哪一段命中（不是只说「被拦了」）",
    /这一段：/.test(gate(ps(BYPASS)).err));
  check("逃生阀：DAO_SETTINGS_EDIT_APPROVED=1 下同一条绕过命令放行",
    gate(ps(BYPASS), { env: { DAO_SETTINGS_EDIT_APPROVED: "1" } }).code === 0);
  check("逃生阀只认 '1'：设成 'true' 仍拦",
    gate(ps(BYPASS), { env: { DAO_SETTINGS_EDIT_APPROVED: "true" } }).code === 2);

  const ALLOW = [
    // ↓ 6 条「真语料」逐字抄自 ~/.claude/projects 转录：全是**备份**（源位是 live）。
    //   全库普查结果：shell 触到 live settings.json 的命令里，写 1 条（就是上面那条绕过），
    //   读/备份 4 条 —— 误伤面比拦截面还大，故「只看目标位」是本次最要紧的设计取舍。
    ["真语料·备份①：live → 同目录 .bak",
      ps(`Copy-Item ${LIVE_V} "${V}\\.claude\\settings.json.bak-20260801-hardgates" -Force; "备份就位"`)],
    ["真语料·备份②：cp live → .bak",
      bash('cp "C:/Users/Administrator/.claude/settings.json" "C:/Users/Administrator/.claude/settings.json.bak-20260712-marshal-scout" && echo BACKED_UP')],
    ["真语料·备份③：cp live → _tmp",
      bash('cp ~/.claude/settings.json "D:\\frank\\windsurf-dao\\_tmp\\settings-live-backup-$TS.json"')],
    ["真语料·备份④：/c/ 形态 live → .bak",
      bash("cp /c/Users/Administrator/.claude/settings.json /c/Users/Administrator/.claude/settings.json.bak-20260712-marshal-hook")],
    ["真语料·备份⑤：Copy-Item live → (Join-Path $dst 'settings.json')",
      ps(`Copy-Item '${HOME}\\.claude\\settings.json' (Join-Path 'D:\\frank\\x' 'settings.json')`)],
    ["真语料·⑥写 config-sync 快照层（本闸只管 live 那一份）",
      ps(`Copy-Item "D:\\frank\\windsurf-dao\\_tmp\\04.json" "D:\\frank\\windsurf-dao\\config-sync\\common\\settings.json" -Force; "COPIED"`)],
    // ↓ 以下为构造语料，照实标注（真语料里没有这些形态，但它们是判据两侧的边界）
    ["构造：dao 指定的降级正路 _tmp/settings-patch.json",
      ps("Set-Content -Path _tmp/settings-patch.json -Value $json -Encoding utf8")],
    ["构造：项目级 .claude/settings.json（不是 cc-switch 投影）",
      bash("cp _tmp/x.json D:/frank/mousse-cli/.claude/settings.json")],
    ["构造：~/.claude 下别的文件", bash("cp _tmp/x.md ~/.claude/CLAUDE.md")],
    ["构造：Set-Content 的 -Value 恰好是那条路径（内容不是目标）",
      ps(`Set-Content -Path _tmp/note.txt -Value ${LIVE_V}`)],
    ["构造：单个正参的 Copy-Item（没有目标位，是复制到当前目录）", ps(`Copy-Item ${LIVE_V}`)],
    ["构造：正文里提到重定向写法（引号里的 `>` 不算重定向）",
      bash('echo "别写 cp x > ~/.claude/settings.json 这种命令"')],
    ["构造：node -e require 读 live（读不是写）",
      bash(`node -e "const s=require('$HOME/.claude/settings.json');console.log(Object.keys(s))"`)],
    // `sc` 同时是 C:\windows\system32\sc.exe（本机 Get-Command sc -All 实测两个都在），
    // 故刻意不收进写入类命令表 —— 与条款「加规则/别名前必须实测该词在其他语境的含义」一致。
    ["构造：sc.exe 服务控制（`sc` 刻意不收，此条钉住这个决定）", ps(`sc query ${LIVE_V}`)],
  ];
  for (const [name, p] of ALLOW) {
    const r = gate(p);
    check(`负控：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 160)}`);
  }

  // ── mutation（锚点用正则 + 每组一条「锚点仍在」前置断言）────────────────────
  // ⚠️ **盘上是 CRLF**（本仓 2026-08-02 实测 1047 处 CRLF / 0 处裸 LF）。锚点若写死 `\n`
  //    会一处都匹配不到 ⇒ 变异体 = 原文 ⇒ 被测闸照常绿，**而那与「守卫真的没塌陷」逐字节相同**
  //    （同 issue #103 当天咬过两次的形态）。故锚点一律走正则、换行位一律写 `\r?\n`，
  //    并且**每组先断言锚点在源码里恰好命中一次**，再断言行为翻转。
  const src = fs.readFileSync(HOOK, "utf8");
  function mutate(label, re, to, payload, expectBefore, expectAfter) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const n = (src.match(g) || []).length;
    check(`mutation 锚点在源码里恰好命中 1 次（${label}）`, n === 1, `命中 ${n} 次`);
    if (n !== 1) return;
    const mp = path.join(TMP, `mutant-g2-${label.replace(/[^\w]+/g, "-")}.js`);
    fs.writeFileSync(mp, src.replace(re, () => to), "utf8");
    const before = gate(payload).code;
    const after = gate(payload, { script: mp }).code;
    check(`${label}：真文件 ${expectBefore} / 改坏后 ${expectAfter} ⇒ 这条断言真的在测那段判据`,
      before === expectBefore && after === expectAfter, `before=${before} after=${after}`);
  }

  // 正向三形态（对抗验证官节「改坏要试不止一种形态」：①移除 ②留着字面但不执行 ③结果不被消费）
  mutate("①移除·shell 分支整个不进",
    /if \(\/\^\(Bash\|PowerShell\)\$\/\.test\(tool\)\) \{/, "if (false) {",
    ps(BYPASS), 2, 0);
  mutate("②留字面不执行·目标位提取块永不进",
    /if \(destLast \|\| allTarget\) \{/, "if (false && (destLast || allTarget)) {",
    ps(BYPASS), 2, 0);
  mutate("③结果不被消费·照样算目标但裁决被丢掉",
    /if \(!g2IsLive\(hit\.path\)\) continue;/, "if (true) continue;",
    ps(BYPASS), 2, 0);
  // 变量展开这一层单独换靶：证明拦下绕过的是「$env: 被展开了」，不是别的分支顺手拦的
  mutate("$env: 展开被改坏 ⇒ 变量形态漏过（而字面绝对路径仍拦）",
    /\.replace\(\/\\\$env:\(\?:USERPROFILE\|HOME\)\(\?!\[A-Za-z0-9_\]\)\/gi, H\)/,
    ".replace(/__never_matches__/gi, H)", ps(BYPASS), 2, 0);
  check("上一条改坏后，已展开的字面绝对路径仍然被拦（证明只打掉了变量那一层）", (() => {
    const re = /\.replace\(\/\\\$env:\(\?:USERPROFILE\|HOME\)\(\?!\[A-Za-z0-9_\]\)\/gi, H\)/;
    if (!re.test(src)) return false;
    const mp = path.join(TMP, "mutant-g2-envonly.js");
    fs.writeFileSync(mp, src.replace(re, () => ".replace(/__never_matches__/gi, H)"), "utf8");
    return gate(ps(`Copy-Item x.json "${HOME}\\.claude\\settings.json" -Force`), { script: mp }).code === 2;
  })());

  // 反向三条：把**豁免**改坏，对应负控必须由 exit 0 翻成 exit 2。
  // 没有这一组，「一组永远为真的负控」与「一组真管用的负控」在全绿输出里长得一模一样。
  mutate("反向·源位豁免（末位才是目标）改坏 ⇒ 真语料备份命令被误伤",
    /out\.push\(\{ why: "末位参数（目标位）", raw: positional\[positional\.length - 1\] \}\);/,
    'for (const q of positional) out.push({ why: "末位参数（目标位）", raw: q });',
    ps(`Copy-Item ${LIVE_V} "${V}\\.claude\\settings.json.bak-20260801-hardgates" -Force; "备份就位"`), 0, 2);
  mutate("反向·引号感知改坏 ⇒ 正文里提到的 `>` 被当成真重定向",
    /if \(c === '"' \|\| c === "'"\) \{ quote = c; quoted = true; continue; \}/,
    "if (false) { quote = c; quoted = true; continue; }",
    bash('echo "别写 cp x > ~/.claude/settings.json 这种命令"'), 0, 2);
  mutate("反向·目标位参数白名单改坏 ⇒ -Value 的内容被当成目标路径",
    /const isTarget = destLast \? G2_DEST_PARAM\.test\(name\) : G2_TARGET_PARAM\.test\(name\);/,
    "const isTarget = true;",
    ps(`Set-Content -Path _tmp/note.txt -Value ${LIVE_V}`), 0, 2);
  mutate("反向·`sc` 不收这个决定改坏 ⇒ sc.exe 服务控制命令被误伤",
    /"new-item", "ni"\]\)/, '"new-item", "ni", "sc"])',
    ps(`sc query ${LIVE_V}`), 0, 2);
  mutate("反向·live 精确比对改成后缀匹配 ⇒ 项目级 .claude/settings.json 被误伤",
    /return G2_LIVE_NAMES\.some\(\(n\) => low === `\$\{G2_LIVE_DIR\}\/\$\{n\}`\);/,
    'return G2_LIVE_NAMES.some((n) => low.endsWith("/" + n));',
    bash("cp _tmp/x.json D:/frank/mousse-cli/.claude/settings.json"), 0, 2);

  check("真 hook 文件在本节全部 mutation 之后仍逐字节未改", sha(HOOK) === PRISTINE_SHA);
}

console.log("\n──── G2 · 对抗验证官夹击（PR #106 / issue #87）────");
// ── 这一节是谁加的、为什么和上一节分开 ──────────────────────────────────────
// 上一节是**实现官**写的（证明新加的判据管用）；本节是**对抗验证官**写的，目标是证伪。
// 两节刻意不合并：合并之后「这条是实现方自己挑的语料」与「这条是别人挑来打它的」
// 就分不开了，而语料**从哪来**正是近似判据唯一站得住的地方（官抗节「语料非自证」）。
//
// 本节两半：
//   ㈠ **误伤侧负控**（当前行为正确，本节把它钉住）—— 护栏两侧代价不对称：
//      漏报只是「规则退回文字」，误报是**会话当场卡死**且逃生阀只有用户设得了。
//   ㈡ **已知漏报/误伤登记表**（当前行为**不正确**，本节把它钉成"自失效"断言）——
//      清单一旦与实测不符，本节当场红，逼下一个人回来更新清单。
//      **这是退役触发器，不是"这些行为是对的"的背书**（dao-guard-writing ④：
//      规则集只增不减是结构必然，须专门给退役造触发器）。
{
  const ps = (command, cwd) => ({ tool_name: "PowerShell", tool_input: { command }, cwd });
  const V = "$env:USERPROFILE";
  const LIVE_V = `"${V}\\.claude\\settings.json"`;
  const LIVEDIR_V = `"${V}\\.claude"`;
  const g2 = (p) => { const r = gate(p); return r.code === 2 && /G2-live-settings/.test(r.err) ? 2 : 0; };

  // ── ㈠ 误伤侧负控：真语料全域扫过零误伤，这些是把那个结果钉住的桩 ──────────
  // 全域实测（2026-08-02，对抗验证官）：`~/.claude/projects/**/*.jsonl` 里 27519 条**去重后**的
  // 真实 Bash/PowerShell 命令，逐条喂改前(fa46ea6)/改后两版 G2 —— 新增拦截 **2 条**，
  // 两条都是**真阳性**（`Copy-Item <源> "$env:USERPROFILE\.claude\settings.json" -Force` 同型），
  // 误伤 **0 条**、退化 **0 条**、守卫自身抛异常 **0 条**。下面这些是构造的边界桩，
  // **照直标：全部凭空构造**（真语料里没有这些形态，它们是判据两侧的悬崖边）。
  const ALLOW_ADV = [
    // 讨论这条规则本身 —— 守卫的输出会落回它自己的扫描面（dao-guard-writing ③）
    ["构造：多行 commit message 正文里提到那条绕过命令（引号感知 ⇒ 不切段）",
      bash(`git commit -m "[cc] fix: G2 扩面\n\n修的是 Copy-Item x \\"${V}\\.claude\\settings.json\\" -Force 这条"`)],
    ["构造：gh pr comment --body 里提到那条绕过命令",
      bash(`gh pr comment 106 --body "绕过原文：Copy-Item a ${V}\\.claude\\settings.json -Force"`)],
    ["构造：printf 把那条命令写进 _tmp 笔记",
      bash(`printf '%s\\n' 'Copy-Item a "${V}\\.claude\\settings.json" -Force' > _tmp/x.md`)],
    // 读 live 的合法形态（备份/诊断/对比）—— 「只看目标位」这个取舍的整个价值所在
    ["构造：管道读 live → 落 _tmp", ps(`Get-Content ${LIVE_V} -Raw | Out-File -FilePath _tmp/live.json -Encoding utf8`)],
    ["构造：git diff --no-index 比对 live 与快照层", bash(`git diff --no-index "$HOME/.claude/settings.json" config-sync/common/settings.json`)],
    ["构造：jq 读 live → 输出重定向到 _tmp", bash(`jq '.hooks.PreToolUse' "$HOME/.claude/settings.json" > _tmp/pre.json`)],
    ["构造：--selfcheck（它自己就要读 live）", bash("node ccswitch/hooks/dao-hard-gates.js --selfcheck")],
    ["构造：Copy-Item live → _tmp 备份（真语料同型）", ps(`Copy-Item ${LIVE_V} _tmp\\live-backup.json -Force`)],
    ["构造：输入重定向读 live、写 _tmp（`<` 是读不是写）", bash(`tee _tmp/o.txt < "$HOME/.claude/settings.json"`)],
    // 相邻但不是 live 的写入
    ["构造：写 ~/.claude/settings.json.bak", ps(`Copy-Item _tmp/x.json "${V}\\.claude\\settings.json.bak" -Force`)],
    ["构造：写 ~/.claude/agents/ 下的文件", ps(`Set-Content -Path "${V}\\.claude\\agents\\x.md" -Value "y"`)],
    ["构造：写 ~/.codex/settings.json（别的工具的同名文件）", ps(`Set-Content -Path "${V}\\.codex\\settings.json" -Value "{}"`)],
    ["构造：目标目录是 ~/.claude 但源 basename 不是 settings", ps(`Copy-Item .\\CLAUDE.md ${LIVEDIR_V} -Force`)],
    ["构造：New-Item 建 ~/.claude 目录本身", ps(`New-Item -ItemType Directory -Path ${LIVEDIR_V} -Force`)],
    // 变量表污染：同一条命令里别处的赋值不该串到目标位
    ["构造：$p 指向 live 但本条命令的目标是别的文件",
      ps(`$p = ${LIVE_V}; Write-Host "live is $p"; Copy-Item a.json b.json -Force`)],
    // 重定向 token 化的边界
    ["构造：PowerShell -gt 比较不是重定向", ps('if ((Get-Item x).Length -gt 0) { "ok" }')],
    ["构造：node -e 双引号里的 `>`", bash(`node -e "if (1 > 0) console.log('a > b')"`)],
    ["构造：`2>&1` 是 dup 不是文件", bash("cargo build 2>&1")],
    ["构造：输出到 $null", ps("Copy-Item a b > $null")],
    // cwd 恰在 ~/.claude 时的日常操作 —— 本机 `~/.claude` 就是常用工作目录之一
    ["构造：cwd=~/.claude 时写 CLAUDE.md", ps("Set-Content -Path CLAUDE.md -Value \"x\"", `${HOME}\\.claude`)],
    ["构造：cwd=~/.claude 时把 live 备份去 _tmp", ps("Copy-Item settings.json D:\\frank\\_tmp\\live.json -Force", `${HOME}\\.claude`)],
  ];
  for (const [name, p] of ALLOW_ADV) {
    const r = gate(p);
    check(`负控·对抗：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 160)}`);
  }

  // ── ㈡ 已知漏报 / 已知误伤 登记表（自失效断言）────────────────────────────
  // 🔴 **下面每一条的当前行为都是错的。** 本表钉住的是「错到什么程度」，不是「这样是对的」。
  //    补上覆盖（或修掉误伤）之后，对应那条会**变红** —— 那就是让你回来更新本表的信号。
  //    形态出处：官抗节「换靶 mutation 两态」的镜像 —— 那条防「绿信号答错问题」，
  //    这张表防「**清单**答错问题」：一份写在 PR body 里的漏报面清单没有任何东西在核它。
  //    每条末尾的 PowerShell 语义都**在本机实跑验证过**（临时文件，从未触碰真 live）。
  const KNOWN_GAPS = [
    // ── ✅ 已修（issue #112 甲⑥⑦⑨，PR 见下）：原先住在本表的 6 条已迁去
    //    「issue #112 三格修复」那一节当**正控**。本表刻意留这条注释而不是静默删行 ——
    //    表本身是退役触发器（dao-guard-writing ④），删得无声无息就等于把触发器也删了。
    //    迁走的 6 条：⑥ `-Path <源> <目标>` · ⑥ `-LiteralPath <源> <目标>` ·
    //    ⑦ 具名 `-Destination <目录>` · ⑨ shell 分支 `..` 回绕 · ⑨ Edit/Write 分支 `..` 回绕 ·
    //    ⑨ 8.3 短名。**⑧ 与两处误伤刻意未动**（判断档，留给用户拍板，见 issue #112 甲⑧/乙）。
    //
    // ⚠ 下面这条是 **#112 这一批新发现**的（攻 ⑦ 的尾斜杠边界时撞出来的），不在 #106 那份清单里。
    ["漏报·双引号里的**尾反斜杠**吞掉闭引号 ⇒ 整条命令剩余部分并进一个 token（具名目标）",
      ps(`Copy-Item .\\settings.json -Destination "${V}\\.claude\\" -Force`), 0],
    ["漏报·同上，位置目标也一样（证明它是 tokenizer 层的，不是某个分支的）",
      ps(`Copy-Item .\\settings.json "${V}\\.claude\\" -Force`), 0],
    ["漏报·单个正参 + cwd 恰在 ~/.claude ⇒ 隐式目标就是 live（本机实跑确认）",
      ps("Copy-Item ..\\backup\\settings.json -Force", `${HOME}\\.claude`), 0],
    ["漏报·Rename-Item 的 NewName 相对**源目录**解析，本闸按 cwd 解析（本机实跑确认）",
      ps(`Rename-Item "${V}\\.claude\\settings.json.bak" settings.json`), 0],
    ["漏报·PowerShell 逗号数组参数 `-Path a,b`", ps(`Set-Content -Path "_tmp/a.json",${LIVE_V} -Value "{}"`), 0],
    // ↓ 以下 3 条 PR body 的「已知漏报面」里已声明，本表只是把它们变成可机检的
    ["漏报·程序化写入（PR body 已声明第 1 条）",
      bash(`node -e "require('fs').writeFileSync(process.env.USERPROFILE+'/.claude/settings.json','{}')"`), 0],
    ["漏报·表达式右值变量（PR body 已声明第 2 条）",
      ps(`$p = Join-Path ${V} '.claude\\settings.json'; Copy-Item x $p -Force`), 0],
    ["漏报·cd 不传播（PR body 已声明第 3 条）", bash("cd ~/.claude && cp /d/x/settings.json settings.json")],
    ["漏报·`cp -t <目录>`（PR body 已声明第 5 条；注意此形态下**目标目录被读成了源位**）",
      bash(`cp -t "$HOME/.claude" ./settings.json`), 0],
    ["漏报·`New-Item -Path <目录> -Name <文件名>`（PR body 已声明第 5 条）",
      ps(`New-Item -Path ${LIVEDIR_V} -Name settings.json -ItemType File -Value "{}" -Force`), 0],
    ["漏报·robocopy（PR body 已声明第 5 条）", ps(`robocopy D:\\src ${LIVEDIR_V} settings.json`), 0],
    // ↓ 命令表是闭世界的：不在 G2_DEST_LAST/G2_ALL_TARGET 里的写入命令一律看不见
    ["漏报·命令表闭世界：tar -C 解包进 ~/.claude", bash(`tar -xf backup.tar -C "$HOME/.claude"`), 0],
    ["漏报·命令表闭世界：Expand-Archive -DestinationPath", ps(`Expand-Archive -Path b.zip -DestinationPath ${LIVEDIR_V} -Force`), 0],
    ["漏报·命令表闭世界：sed -i 原地改 live", bash(`sed -i 's/a/b/' "$HOME/.claude/settings.json"`), 0],
    ["漏报·命令表闭世界：dd of=", bash(`dd if=x.json of="$HOME/.claude/settings.json"`), 0],
    ["漏报·命令替换内部的写（`$(...)` 段不再切分，整段段首是 echo）",
      bash(`echo $(cp /d/x.json "$HOME/.claude/settings.json")`), 0],
    // ⚠ 8.3 短名那条已修（#112 甲⑨），迁去下节当正控。**UNC 共享形态仍在**——
    //    `//localhost/C$/…` 的解法只有 `realpath`，而它对网络路径会把 SMB 超时（可达数十秒）
    //    拖进 PreToolUse 钩子 ⇒ 拿会话卡死换覆盖面，刻意不换。判据见 hook 里 g2LongPath 的收窄㈠。
    //    （`\\?\C:\…` 那个**扩展长度前缀**形态是纯字符串、无 I/O，已在 #112 里修掉。）
    ["漏报·UNC 本机形态（realpath 是唯一解法，但它对网络路径会把 SMB 超时拖进钩子 ⇒ 刻意不修）",
      ps(`Copy-Item x "\\\\localhost\\C$\\Users\\Administrator\\.claude\\settings.json" -Force`), 0],
    // ↓ 误伤侧的两条（当前**过度拦截**）
    ["误伤·heredoc 正文里写着那条命令 ⇒ 正文行被当成真命令（守卫输出落回自己扫描面）",
      bash(`cat > _tmp/note.md <<'EOF'\nCopy-Item x "${V}\\.claude\\settings.json" -Force\nEOF`), 2],
    ["误伤·写入类命令的 `-Value (表达式)` 吞掉取值 ⇒ 后续 token 被当成目标位",
      ps(`Set-Content -Path _tmp/backup.json -Value (Get-Content ${LIVE_V} -Raw)`), 2],
  ];
  const drift = [];
  for (const [name, p, want] of KNOWN_GAPS) {
    const got = g2(p);
    if (got !== (want === undefined ? 0 : want)) drift.push(`${name}（表里写 ${want === undefined ? 0 : want}，实测 ${got}）`);
  }
  check(
    `已知漏报/误伤登记表 ${KNOWN_GAPS.length} 条与实测逐条一致` +
    "（🔴 本条变红 = 有一格的行为变了，去更新表 + 更新 hook 头注 G2 的漏报面清单；**不是**要你把表改回去）",
    drift.length === 0, drift.join(" ; ")
  );

  // ── mutation：证明上面那批**新增负控**真有判别力 ─────────────────────────
  // 官抗节「改坏要试不止一种形态」：①移除 ②留字面但不执行 ③结果不被消费。
  // ⚠ 盘上是 CRLF，锚点一律走正则（`\r?\n`），且每组先断言**锚点恰好命中 1 次**。
  const src2 = fs.readFileSync(HOOK, "utf8");
  function mutate2(label, re, to, payload, expectBefore, expectAfter) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const n = (src2.match(g) || []).length;
    check(`mutation 锚点在源码里恰好命中 1 次（${label}）`, n === 1, `命中 ${n} 次`);
    if (n !== 1) return;
    const mp = path.join(TMP, `mutant-adv-${label.replace(/[^\w]+/g, "-")}.js`);
    fs.writeFileSync(mp, src2.replace(re, () => to), "utf8");
    // canary：变异体本身还活着（能跑到被测逻辑，只是行为被改）—— 一个把靶弄死的
    // mutation 会让每条断言都翻，而那正是「判别力满分」的表象（官抗节「变异体存活」）。
    const alive = gate({ tool_name: "Bash", tool_input: { command: "echo hi" } }, { script: mp });
    check(`变异体存活（${label}）：无关输入仍 exit 0 且无 fail-open 告警`,
      alive.code === 0 && !/守卫自身出错/.test(alive.err), `code=${alive.code} err=${alive.err.slice(0, 120)}`);
    const before = gate(payload).code;
    const after = gate(payload, { script: mp }).code;
    check(`${label}：真文件 ${expectBefore} / 改坏后 ${expectAfter}`,
      before === expectBefore && after === expectAfter, `before=${before} after=${after}`);
  }

  // ①移除：整个 live 精确比对换成后缀匹配 ⇒ 「写别的工具的同名文件」负控被误伤
  mutate2("①移除·live 精确比对 ⇒ ~/.codex/settings.json 被误伤",
    /return G2_LIVE_NAMES\.some\(\(n\) => low === `\$\{G2_LIVE_DIR\}\/\$\{n\}`\);/,
    'return G2_LIVE_NAMES.some((n) => low.endsWith("/" + n));',
    ps(`Set-Content -Path "${V}\\.codex\\settings.json" -Value "{}"`), 0, 2);
  // ②留字面但不执行：`in`（输入重定向）分支跳过被关掉 ⇒ `<` 后的路径被当成写目标。
  // 靶必须是**写入类命令**（`tee` 在 G2_ALL_TARGET 里），否则整段根本走不到参数解析
  // —— 首版靶写的是 `node t.js < live`，段首 `node` 不在两张表里，mutation 恒不翻转，
  //    而「锚点命中 1 次 + 变异体存活」两条前置**照样全绿** ⇒ 那正是本条要防的那种假绿。
  mutate2("②留字面不执行·输入重定向跳过被关掉 ⇒ 读被当成写",
    /if \(toks\[i\]\.k === "in"\) \{ i\+\+; continue; \}/,
    'if (false && toks[i].k === "in") { i++; continue; }',
    bash(`tee _tmp/o.txt < "$HOME/.claude/settings.json"`), 0, 2);
  // ③结果不被消费：目标目录 basename 展开照样算，但结果不 push ⇒ 承重正控从红变绿
  mutate2("③结果不被消费·目标目录 basename 展开算了但不入候选 ⇒ 承重正控漏过",
    /if \(base\) out\.push\(\{ why: "目标目录 \+ 源文件名", raw: `\$\{destDir\}\/\$\{base\}` \}\);/,
    'if (base) { const _ = `${destDir}/${base}`; }',
    bash("cp _tmp/settings.json ~/.claude/"), 2, 0);
  // 反向：把「源位放行」改坏 ⇒ 上面「Copy-Item live → _tmp 备份」这条负控必须翻红。
  // 没有这一组，「一条永远为真的负控」与「一条真管用的负控」在全绿输出里长得一样。
  mutate2("反向·源位豁免改坏 ⇒ 备份类负控被误伤",
    /out\.push\(\{ why: "末位参数（目标位）", raw: positional\[positional\.length - 1\] \}\);/,
    'for (const q of positional) out.push({ why: "末位参数（目标位）", raw: q });',
    ps(`Copy-Item ${LIVE_V} _tmp\\live-backup.json -Force`), 0, 2);

  // ── 调用点覆盖率（官抗节「mutation 报告需附加调用点覆盖率」）─────────────
  // 判据：本 PR 新增判据的**生产调用点**有几个、本节端到端覆盖了几个。
  {
    const callSites = (name) => (src2.match(new RegExp(`\\b${name}\\s*\\(`, "g")) || []).length - 1; // 减去定义处
    const map = { g2WriteTargets: callSites("g2WriteTargets"), g2Resolve: callSites("g2Resolve"), g2IsLive: callSites("g2IsLive"), g2IsLiveDir: callSites("g2IsLiveDir") };
    const line = Object.entries(map).map(([k, v]) => `${k}=${v}`).join(" ");
    // ⚠️ **这句话 2026-08-03（#112）订正过一个数字，订正史留着**：原文写「g2Resolve 2/2
    //   （shell 分支 + Edit/Write 分支）」，而 `g2Resolve` 的生产调用点**当时就是 3 个**
    //   （第三个是 basename 展开里解 destDir 那次，就在 g2WriteTargets 自己体内）。
    //   分母是**手写死的**，分子也是手写死的，于是它印出来的 "2/2" 看起来像满覆盖、
    //   实则连分母都不对 —— 而上面那行 `${line}` 明明已经把真值算出来印在同一句里了。
    //   现改成引用算出来的真值。**它是本节唯一一个没有断言在守的数字**（console.log 不参与红绿），
    //   正是「检查器自己描述自己那半最少被人回头看」的实例（官通节「同批查引用」第四格）。
    console.log(`  （调用点覆盖率）G2 新判据函数的生产调用点：${line}；` +
      `本节端到端覆盖：g2WriteTargets 1/1（shell 分支）· g2Resolve ${map.g2Resolve}/${map.g2Resolve}` +
      `（Edit/Write 分支 + g2WriteTargets 的候选解析 + basename 展开的 destDir）· ` +
      `g2IsLive 2/2 · g2IsLiveDir 1/1。**未覆盖 0 个** —— 但覆盖的是"这个函数被走到了"，` +
      `不是"它的每个分支都被走到了"，后者由上面那张登记表反面记录。`);
    check("调用点计数拿得到（拿不到说明函数被改名，覆盖率那句话即失效）",
      Object.values(map).every((v) => v >= 1), JSON.stringify(map));
  }

  check("真 hook 文件在本节全部 mutation 之后仍逐字节未改", sha(HOOK) === PRISTINE_SHA);
}

console.log("\n──── G2 · issue #112 三格修复（甲⑥ 具名源 / 甲⑦ 具名 -Destination / 甲⑨ 绝对路径归一）────");
// ── 这一节装什么、为什么又是单开一节 ────────────────────────────────────────
// 上面两节分别是 #87 的实现官与对抗验证官写的。本节是 **#112 的实现官**写的，
// 装的是那张登记表里**被修掉的那 6 条**（现在它们是正控，不再是漏报）。
// 三节不合并，理由同上一节：语料**从哪来**是近似判据唯一站得住的地方，
// 合并之后「谁挑的这条语料」就分不开了。
//
// 🔴 **语料来源照直标（官抗节「语料非自证」）**：
//   · **⑨ 的两类形态在真语料里是主流，不是构造的** —— 全量普查（2026-08-03，
//     `~/.claude/projects/**/*.jsonl`，1330 个 jsonl / 373865 行 / **27365 条去重命令**）：
//     `~<数字>` 8.3 短名路径 **1196 条**（本机 scratchpad 一律走 `C:\Users\ADMINI~1\AppData\…`，
//     而 `ADMINI~1` 正是 HOME 的短名）· `\\?\` / `\\localhost\C$` 等 UNC 形态 **27 条**
//     （其中一条真实命令逐字枚举了 `'C:\Users\ADMINI~1'`、`'\\?\C:\Users\Administrator'`、
//     `'\\localhost\C$\Users\Administrator'` 三种写法去探 home 的等价形态）。
//     ⇒ ⑨ **不是理论洞**：这台机器每天都在产生它需要的那种路径。
//   · **⑦ 的形态在真语料里有**（`-Destination` 具名 **107 处 / 42 文件**，其中
//     `Copy-Item -LiteralPath $src -Destination $dst -Force` 是反复出现的固定搭配），
//     但**目标位从来不是 live** ⇒ 下面正控是「真形态 + 目标位换成 live」，**不是纯真语料**。
//   · **⑥ 的混合形态（具名源 + 位置目标）在真语料里 0 条** —— 逐条人读确认那 2 条正则命中
//     全是 `Set-Content -Path` 的误匹配。**⑥ 的正控全部凭空构造**，照直标。
//     它站得住的地方不在语料，在 **PowerShell 的参数绑定语义**：`-Path` 具名之后，
//     剩下的第一个正参绑到 position 1 = `-Destination`（本机实跑确认真的会覆盖目标，
//     出处见 issue #87 对抗验证官的原始记录）。
{
  const ps = (command, cwd) => ({ tool_name: "PowerShell", tool_input: { command }, cwd });
  const V = "$env:USERPROFILE";
  const LIVE_V = `"${V}\\.claude\\settings.json"`;
  const LIVEDIR_V = `"${V}\\.claude"`;
  const HOME_FS = HOME.replace(/\\/g, "/");

  // ── 正控：这 6 条 + 扩展形态，改前**全部漏过**（原始双态输出见 PR body）────────
  const BLOCK_112 = [
    // 甲⑥ —— 具名源吃掉正参，只剩 1 个 ⇒ 撞上「单正参不算目标位」早退
    ["⑥ 构造·`Copy-Item -Path <源> <目标>`", ps(`Copy-Item -Path _tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·`-LiteralPath <源> <目标>`", ps(`Copy-Item -LiteralPath _tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·`-lp` 缩写", ps(`Copy-Item -lp _tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·`Move-Item -Path <源> <目标>`", ps(`Move-Item -Path _tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·内联冒号 `-Path:<源>`", ps(`Copy-Item -Path:_tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·具名源 + 位置目标给的是**目录**（basename 展开也要跟着走）",
      ps(`Copy-Item -Path .\\settings.json ${LIVEDIR_V} -Force`)],
    // 甲⑦ —— basename 展开原先只写在位置分支里，具名 -Destination 拿不到
    ["⑦ 真形态+换靶·正参源 + `-Destination <目录>`", ps(`Copy-Item .\\settings.json -Destination ${LIVEDIR_V} -Force`)],
    ["⑦ 真形态+换靶·`-LiteralPath <源> -Destination <目录>`（真语料固定搭配）",
      ps(`Copy-Item -LiteralPath D:\\src\\settings.json -Destination ${LIVEDIR_V} -Force`)],
    ["⑦ 构造·`-Destination:<目录>` 内联冒号", ps(`Copy-Item .\\settings.local.json -Destination:${LIVEDIR_V} -Force`)],
    // 甲⑨ —— 绝对路径此前一步归一都没有。**两个分支都要验**：shell 是新的，Edit/Write 是自诞生起就漏的那个
    ["⑨ 构造·shell 分支 `..` 回绕", ps(`Copy-Item x "${V}\\.claude\\..\\.claude\\settings.json" -Force`)],
    ["⑨ 构造·**Edit 分支** `..` 回绕（自诞生起就漏的那一格）", edit(`${HOME}\\.claude\\..\\.claude\\settings.json`)],
    ["⑨ 构造·**Write 分支** `.` 当前目录段",
      { tool_name: "Write", tool_input: { file_path: `${HOME}\\.claude\\.\\settings.json` } }],
    ["⑨ 构造·**MultiEdit 分支** `..` 回绕 + settings.local.json",
      { tool_name: "MultiEdit", tool_input: { file_path: `${HOME}\\.claude\\..\\.claude\\settings.local.json` } }],
    ["⑨ 构造·**NotebookEdit 分支**（notebook_path 走的是同一条解析）",
      { tool_name: "NotebookEdit", tool_input: { notebook_path: `${HOME}\\.claude\\..\\.claude\\settings.json` } }],
    ["⑨ 构造·Edit 分支 `//` 重复斜杠", edit(`${HOME_FS}/.claude//settings.json`)],
    ["⑨ 真语料形态·Edit 分支 8.3 短名（本机 1196 条同型路径）", edit("C:\\Users\\ADMINI~1\\.claude\\settings.json")],
    ["⑨ 真语料形态·shell 分支 8.3 短名", ps(`Copy-Item x "C:\\Users\\ADMINI~1\\.claude\\settings.json" -Force`)],
    ["⑨ 真语料形态·Win32 扩展长度前缀 `\\\\?\\C:\\…`（纯字符串前缀，剥它零 I/O）",
      edit("\\\\?\\C:\\Users\\Administrator\\.claude\\settings.json")],
    ["⑨ 构造·盘根回绕 `C:/../`（win32 在盘根处夹住 `..`）",
      bash("cp x.json C:/../Users/Administrator/.claude/settings.json")],
    ["⑨ 构造·三格叠加：具名源 + `-Destination` 目录 + `..` 回绕",
      ps(`Copy-Item -LiteralPath .\\settings.json -Destination "${V}\\.claude\\..\\.claude" -Force`)],
  ];
  for (const [name, p] of BLOCK_112) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2 && /G2-live-settings/.test(r.err), `code=${r.code}`);
  }

  // ── 负控：修完之后**不许**多拦这些（护栏两侧代价不对称，误报 = 会话当场卡死）────
  // ⚠ 这一组比正控更要紧：⑥ 把「目标位存在」的门槛从 2 个正参降到 1 个，
  //   ⑨ 让每一条绝对路径都多走一层归一（8.3 那格还会落一次 I/O）—— 两处都在**放宽**，
  //   而放宽正是误伤的来源。下面逐条钉住「放宽到哪儿为止」。
  const ALLOW_112 = [
    // ⑥ 的边界：具名源存在时，正参才是目标；源位仍然一律放行
    ["构造·具名源把 live 读走做备份（源位放行 —— 本闸最要紧的那个取舍）",
      ps(`Copy-Item -Path ${LIVE_V} -Destination "${V}\\.claude\\settings.json.bak" -Force`)],
    ["构造·具名源 live → _tmp 备份（正参目标）", ps(`Copy-Item -Path ${LIVE_V} _tmp\\live.json -Force`)],
    ["真语料形态·`-LiteralPath <源> -Destination <目标>` 两头都不是 live",
      ps("Copy-Item -LiteralPath D:/a/x.md -Destination D:/b/x.md -Force")],
    ["构造·**单个正参** Copy-Item（甲⑧ 判断档，不在本批 ⇒ 行为必须一个字节不变）", ps(`Copy-Item ${LIVE_V}`)],
    ["构造·具名源 + 无正参（没有目标位）", ps(`Copy-Item -Path ${LIVE_V} -Force`)],
    // ↓ 这两条钉住 G2_SRC_PARAM **只收源位那三个名字**这个决定。PowerShell 语义：`-Filter`/
    //   `-Encoding` 是过滤/编码，不吃源位 ⇒ 单个正参仍绑到 position 0 = `-Path`（源），
    //   拦它就是把甲⑧ 那一整类误伤进来。上面「反向⑥-b」那条 mutation 专门验这两条真会红。
    ["构造·`-Filter <值>` 不是源位 ⇒ 单正参仍是源，不许拦", ps(`Copy-Item -Filter *.json ${LIVE_V}`)],
    ["构造·`-Encoding <值>` 同上", ps(`Copy-Item -Encoding utf8 ${LIVE_V}`)],
    ["构造·`-Destination <目录>` 是 live 但源 basename 不是 settings",
      ps(`Copy-Item -Path .\\CLAUDE.md -Destination ${LIVEDIR_V} -Force`)],
    // ⑨ 的边界：归一不许把不是 live 的路径归成 live，也不许改写非盘符路径
    ["构造·`..` 回绕但终点是 ~/.codex（归一不许归到 live 上）", edit(`${HOME}\\.claude\\..\\.codex\\settings.json`)],
    ["构造·8.3 短名但终点不是 live", edit("C:\\Users\\ADMINI~1\\.claude\\CLAUDE.md")],
    ["构造·8.3 短名 + **项目级** settings.json（realpath 解开后仍不是 live）",
      edit("C:\\Users\\ADMINI~1\\AppData\\Local\\x\\.claude\\settings.json")],
    ["构造·8.3 短名指向**不存在**的路径（realpath 抛错 ⇒ 必须按原样比，不许崩也不许乱拦）",
      edit("C:\\Users\\NOSUCH~9\\.claude\\settings.json")],
    ["构造·POSIX 根回绕不许被补上当前盘符（`path.win32.resolve` 会干这事，故按根形态分派）",
      edit("/../home/x/.claude/settings.json")],
    ["构造·UNC 共享形态（覆盖面外，行为必须不变）",
      ps(`Copy-Item x "\\\\localhost\\C$\\Users\\Administrator\\.claude\\settings.json" -Force`)],
    ["构造·正文里提到 `..` 路径（引号感知仍在）", bash('echo "别写 cp x ~/.claude/../.claude/settings.json"')],
    ["构造·相对路径仍按 cwd 解析（归一不许吃掉这条老路）", bash("cp new.json _tmp/settings.json", HOME)],
  ];
  for (const [name, p] of ALLOW_112) {
    const r = gate(p);
    check(`负控：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 160)}`);
  }

  // ── mutation：三形态 + 反向。锚点一律正则（盘上 CRLF，写死 `\n` 恒不命中，见 #103）──
  const src3 = fs.readFileSync(HOOK, "utf8");
  function mutate3(label, re, to, payload, expectBefore, expectAfter) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const n = (src3.match(g) || []).length;
    check(`mutation 锚点在源码里恰好命中 1 次（${label}）`, n === 1, `命中 ${n} 次`);
    if (n !== 1) return null;
    const mp = path.join(TMP, `mutant-112-${label.replace(/[^\w]+/g, "-")}.js`);
    fs.writeFileSync(mp, src3.replace(re, () => to), "utf8");
    // 变异体存活（官抗节）：一个把靶弄死的 mutation 会让每条断言都翻，而那正是「判别力满分」的表象
    const alive = gate({ tool_name: "Bash", tool_input: { command: "echo hi" } }, { script: mp });
    check(`变异体存活（${label}）：无关输入仍 exit 0 且无 fail-open 告警`,
      alive.code === 0 && !/守卫自身出错/.test(alive.err), `code=${alive.code} err=${alive.err.slice(0, 120)}`);
    const before = gate(payload).code;
    const after = gate(payload, { script: mp }).code;
    check(`${label}：真文件 ${expectBefore} / 改坏后 ${expectAfter}`,
      before === expectBefore && after === expectAfter, `before=${before} after=${after}`);
    return mp;
  }

  const P6 = ps(`Copy-Item -Path _tmp/x.json ${LIVE_V} -Force`);
  const P7 = ps(`Copy-Item .\\settings.json -Destination ${LIVEDIR_V} -Force`);
  const P9 = edit(`${HOME}\\.claude\\..\\.claude\\settings.json`);
  const P9_83 = edit("C:\\Users\\ADMINI~1\\.claude\\settings.json");

  // 甲⑥ 三形态 —— 三条路各自独立地能让这一格重新漏掉
  mutate3("⑥①移除·门槛写死回 2（等于把本格的修复整个删掉）",
    /const needed = namedSrcs\.length \? 1 : 2;/, "const needed = 2;", P6, 2, 0);
  mutate3("⑥②留字面不执行·具名源照旧被识别但从不入 namedSrcs ⇒ 门槛恒为 2",
    /else if \(destLast && G2_SRC_PARAM\.test\(name\)\) namedSrcs\.push\(val\);/,
    "else if (false && destLast && G2_SRC_PARAM.test(name)) namedSrcs.push(val);", P6, 2, 0);
  mutate3("⑥③结果不被消费·needed 照算，但取门槛时绕过它直接用字面 2",
    /const hasDestPos = positional\.length >= needed;/,
    "const hasDestPos = positional.length >= 2;", P6, 2, 0);
  check("⑥ 的三个 mutation 都不该动到「正参源」那条老路（`Copy-Item <源> <目标>` 仍拦）", (() => {
    const mp = path.join(TMP, "mutant-112-6-sidecheck.js");
    fs.writeFileSync(mp, src3.replace(/const needed = namedSrcs\.length \? 1 : 2;/, () => "const needed = 2;"), "utf8");
    return gate(ps(`Copy-Item _tmp/x.json ${LIVE_V} -Force`), { script: mp }).code === 2;
  })());

  // 甲⑦ —— 具名目标必须进 destRaws，否则 basename 展开永远看不到它
  mutate3("⑦①移除·具名目标不再入 destRaws ⇒ 具名 -Destination 目录形态重新漏掉",
    /if \(isTarget\) \{ out\.push\(\{ why: `参数 \$\{name\}`, raw: val \}\); if \(destLast\) destRaws\.push\(val\); \}/,
    'if (isTarget) { out.push({ why: `参数 ${name}`, raw: val }); }', P7, 2, 0);
  mutate3("⑦③结果不被消费·具名目标的取值照读，但不入 destRaws",
    /if \(destLast\) destRaws\.push\(val\);/,
    "if (destLast) { const _unused = val; }", P7, 2, 0);
  check("⑦ 改坏后，**位置**目标位给目录的老路仍然拦（证明只打掉了具名那一格）", (() => {
    const mp = path.join(TMP, "mutant-112-7-sidecheck.js");
    fs.writeFileSync(mp, src3.replace(/if \(destLast\) destRaws\.push\(val\);/, () => "if (destLast) { const _unused = val; }"), "utf8");
    return gate(bash("cp _tmp/settings.json ~/.claude/"), { script: mp }).code === 2;
  })());

  // 甲⑨ 三形态 —— 归一这一层被打掉的三种方式
  mutate3("⑨①移除·g2Resolve 不再调 g2Canon（绝对路径退回一步归一都没有）",
    /  return g2Canon\(s\);/, "  return s;", P9, 2, 0);
  mutate3("⑨②留字面不执行·盘符分支整个不进（代码还在，只是永不执行）",
    /if \(\/\^\[A-Za-z\]:\\\/\/\.test\(s\)\) \{/, "if (false) {", P9, 2, 0);
  mutate3("⑨③结果不被消费·g2Canon 照调（副作用都发生了），但返回值被丢掉",
    /  return g2Canon\(s\);\r?\n\}/, "  g2Canon(s);\n  return s;\n}", P9, 2, 0);
  // 8.3 那一层单独换靶：证明拦下短名的是 realpath 那一步，不是别的分支顺手拦的
  mutate3("⑨·8.3 单独换靶·realpath 那一步被关掉 ⇒ 短名形态重新漏掉",
    /if \(\/~\\d\/\.test\(s\)\) s = g2LongPath\(s\);/, "if (false) s = g2LongPath(s);", P9_83, 2, 0);
  check("上一条改坏后，`..` 回绕仍然被拦（证明只打掉了 8.3 那一层，两层是独立的）", (() => {
    const mp = path.join(TMP, "mutant-112-9-83only.js");
    fs.writeFileSync(mp, src3.replace(/if \(\/~\\d\/\.test\(s\)\) s = g2LongPath\(s\);/, () => "if (false) s = g2LongPath(s);"), "utf8");
    return gate(P9, { script: mp }).code === 2;
  })());

  // ── 反向 mutation：把修复**改得过宽**，对应负控必须由 exit 0 翻成 exit 2 ──────────
  // 没有这一组，「一条永远为真的负控」与「一条真管用的负控」在全绿输出里长得一模一样。
  // ⚠ 官抗节点名的第四件事：检查你的 mutation 是不是全在一个方向上 —— 上面 8 条全在
  //   「让闸变松」这一侧，故这里补 3 条「让闸变紧」的，把负控也真的红一遍。
  mutate3("反向⑥·门槛恒为 1 ⇒ 甲⑧（单正参 + 隐式目标）被顺带拦下，而那一格是**判断档**",
    /const needed = namedSrcs\.length \? 1 : 2;/, "const needed = 1;",
    ps(`Copy-Item ${LIVE_V}`), 0, 2);
  mutate3("反向⑥-b·G2_SRC_PARAM 放宽成「任意具名取值参数都算源」⇒ `-Filter` 也把门槛降到 1，单正参被误伤",
    /const G2_SRC_PARAM = \/\^-\{1,2\}\(path\|literalpath\|lp\)\$\/i;/,
    "const G2_SRC_PARAM = /^-{1,2}[\\w-]+$/i;",
    ps(`Copy-Item -Filter *.json ${LIVE_V}`), 0, 2);

  // 反向⑨·g2LongPath 的 fail-open catch 是承重的 —— 8.3 那一格是本批唯一会落 I/O 的判据，
  // 而 I/O 会抛（文件不存在是常态：Write 新建、路径写错、短名指向不存在的用户）。
  // ⚠ 这一条**不能用退出码断言**：真文件与改坏后都是 exit 0（fail-open 的设计就是放行），
  //   两者的差别只在 stderr 有没有那句告警 —— 拿退出码测它会得到一条永远为真的断言。
  {
    const re = /  try \{ return norm\(fs\.realpathSync\.native\(p\)\); \} catch \(_\) \{ \/\* 文件不存在是常态 \*\/ \}/;
    const n = (src3.match(new RegExp(re.source, "g")) || []).length;
    check("mutation 锚点在源码里恰好命中 1 次（反向⑨·g2LongPath 去掉 catch）", n === 1, `命中 ${n} 次`);
    if (n === 1) {
      const mp = path.join(TMP, "mutant-112-9-nocatch.js");
      fs.writeFileSync(mp, src3.replace(re, () => "  return norm(fs.realpathSync.native(p));"), "utf8");
      const nonexistent = edit("C:\\Users\\NOSUCH~9\\.claude\\settings.json");
      const real = gate(nonexistent), mut = gate(nonexistent, { script: mp });
      check("反向⑨·去掉 g2LongPath 的 catch ⇒ 不存在的 8.3 路径把守卫打进 fail-open（真文件不会）",
        real.code === 0 && !/守卫自身出错/.test(real.err) &&
        mut.code === 0 && /守卫自身出错/.test(mut.err) && /ENOENT/.test(mut.err),
        `real=${real.code}/${/守卫自身出错/.test(real.err)} mut=${mut.code}/${/守卫自身出错/.test(mut.err)}`);
    }
  }

  // 🔴 **一条阴性结果，照直记（官抗节：差额为零也是结论）**：
  //   `if (!g2IsLiveDir(destDir)) continue;` 这道 guard **试过反向 mutation，翻不动**。
  //   实测（`_tmp/probe-reverse.mjs` B 组，3 条负控全部 0→0）：把它改成 `if (false) continue;`
  //   之后，`-Destination` 指向 `.bak` / `_tmp` / 别的仓，产出的候选是 `<那个目标>/<源basename>`，
  //   **结构上不可能等于 live** —— 因为要等于 live，destDir 就必须**恰好是** live 目录，
  //   而那种情况本来就会被拦。⇒ 它是**精度与开销**的优化（少产一堆永不命中的候选），
  //   **不是承重判据**。别因为它"看起来像个 guard"就以为有断言在守着它。

  // ── 调用点覆盖率（官抗节「mutation 报告需附加调用点覆盖率」）─────────────
  {
    const callSites = (name) => (src3.match(new RegExp(`\\b${name}\\s*\\(`, "g")) || []).length - 1; // 减去定义处
    const map = { g2Canon: callSites("g2Canon"), g2LongPath: callSites("g2LongPath"), g2Resolve: callSites("g2Resolve") };
    console.log(`  （调用点覆盖率）#112 新增/改写判据的生产调用点：` +
      Object.entries(map).map(([k, v]) => `${k}=${v}`).join(" ") +
      `；本节端到端覆盖：g2Canon ${map.g2Canon}/${map.g2Canon}（唯一调用点在 g2Resolve，` +
      `而 g2Resolve 的 3 个调用点 —— Edit/Write 分支、g2WriteTargets 的候选解析、` +
      `basename 展开的 destDir —— 上面正控逐个走到了）· g2LongPath 1/1（8.3 正控）。**未覆盖 0 个**；` +
      `但这句话说的是"函数被走到了"，不是"它每个分支都被走到了" —— 后者由登记表反面记录。`);
    check("调用点计数拿得到（拿不到说明函数被改名，上面那句覆盖率即失效）",
      Object.values(map).every((v) => v >= 1), JSON.stringify(map));
  }

  check("真 hook 文件在本节全部 mutation 之后仍逐字节未改", sha(HOOK) === PRISTINE_SHA);
}

console.log("\n──── G3 · 对外发布（⑤自主边界：不可逆 + 需用户在场）────");
{
  const positives = [
    "npm publish --access public",
    "pnpm publish",
    "yarn publish",
    "cargo publish",
    "gh release create v1.2.3 --notes x",
    "gh release delete v1.0.0",
    "cd /d/frank/mousse-cli && npm publish",
    "VERSION=1.2.3 cargo publish",
  ];
  for (const c of positives) {
    const r = gate(bash(c));
    check(`正控：${c} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
  }
  check("正控：stderr 给得出三条合法路径（说明+dry-run+用户设 env）",
    /--dry-run/.test(gate(bash("npm publish")).err) && /DAO_PUBLISH_APPROVED/.test(gate(bash("npm publish")).err));
  check("正控：PowerShell 工具同样受管", gate({ tool_name: "PowerShell", tool_input: { command: "cargo publish" } }).code === 2);
  check("逃生阀：DAO_PUBLISH_APPROVED=1 → 放行",
    gate(CANARY["G3-publish"], { env: { DAO_PUBLISH_APPROVED: "1" } }).code === 0);

  const negatives = [
    ["--dry-run 是真演练，放行", "npm publish --dry-run"],
    ["cargo publish --dry-run 放行", "cargo publish --dry-run"],
    ["gh release list 只读，放行", "gh release list"],
    ["gh release view 只读，放行", "gh release view v1.0.0"],
    ["npm run build 放行", "npm run build"],
    ["npm install 放行", "npm install"],
    ["带 publish 字样但不是发布命令，放行", "node scripts/publish-notes.mjs"],
    ["字符串字面量里的命令，放行（段首不是它）", 'echo "npm publish"'],
    ["git push 归乙类软提醒，本闸放行", "git push origin main"],
  ];
  for (const [name, c] of negatives) check(`负控：${name}`, gate(bash(c)).code === 0, `code=${gate(bash(c)).code}`);
}

console.log("\n──── G4 · 浏览器 MCP 截图落盘路径（无逃生阀，正路只是换路径）────");
{
  const positives = [
    ["chrome-devtools 落项目根", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:/frank/mousse-cli/shot.png" } }],
    ["playwright 落 _tmp 但不在 qa 下", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "_tmp/shot.png" } }],
    ["落系统 temp", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "C:/Users/x/AppData/Local/Temp/a.png" } }],
    ["反斜杠路径", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:\\frank\\mousse-cli\\qa\\a.png" } }],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code}`);
  }
  check("正控：stderr 给得出规范路径形态", /_tmp\/qa\/<context>/.test(gate(positives[0][1]).err));
  check("无逃生阀：设满 env 仍拦",
    gate(positives[0][1], { env: { DAO_SETTINGS_EDIT_APPROVED: "1", DAO_PUBLISH_APPROVED: "1", DAO_ALLOW_READONLY_TODO: "1" } }).code === 2);

  const negatives = [
    ["不给路径=内联返回不落盘，放行", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { fullPage: true } }],
    ["绝对路径落 _tmp/qa 下，放行", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:/frank/mousse-cli/_tmp/qa/pr-1/a.png" } }],
    ["相对路径落 _tmp/qa 下，放行", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "_tmp/qa/run/a.png" } }],
    ["反斜杠的 _tmp\\qa 也认，放行", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "D:\\repo\\_tmp\\qa\\c\\a.png" } }],
    ["非截图工具带路径，放行", { tool_name: "mcp__playwright__browser_navigate", tool_input: { filename: "x.png" } }],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G5 · 只读载体未勾待办（PR body / commit message）────");
{
  const bodyFile = path.join(TMP, "pr-body.md");
  fs.writeFileSync(bodyFile, "## 为什么改\n修了个洞。\n\n## 合并前自检\n- [ ] 验证跑了且过了\n", "utf8");
  const cleanFile = path.join(TMP, "pr-body-clean.md");
  fs.writeFileSync(cleanFile, "## 为什么改\n修了个洞。\n\n- [x] 验证跑了且过了（exit 0）\n", "utf8");

  const positives = [
    ["gh pr create 内联 body 含未勾框", bash('gh pr create --title x --body "- [ ] 还没跑"')],
    ["gh pr edit 内联 body 含未勾框", bash('gh pr edit 42 --body "- [ ] 待补"')],
    ["gh pr create --body-file 指向含未勾框的文件", bash(`gh pr create --title x --body-file ${bodyFile}`, TMP)],
    ["git commit -m 含未勾框", bash('git commit -m "[cc] feat: x\n- [ ] 随后补测试"')],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
    check(`正控：${name} stderr 给得出三选一`, /- \[x\]/.test(r.err) && /可编辑/.test(r.err), r.err.slice(0, 160));
  }
  check("正控：--body-file 用相对路径 + cwd 也能读到",
    gate(bash("gh pr create --title x --body-file pr-body.md", TMP)).code === 2);
  check("逃生阀：DAO_ALLOW_READONLY_TODO=1 → 放行",
    gate(CANARY["G5-readonly-todo"], { env: { DAO_ALLOW_READONLY_TODO: "1" } }).code === 0);

  const negatives = [
    ["已勾的 - [x] 是陈述过去，放行", bash('gh pr create --body "- [x] 跑过了"')],
    ["gh issue create 是可编辑载体，放行", bash('gh issue create --title x --body "- [ ] 待办"')],
    ["gh pr comment 不在本条射程内，放行", bash('gh pr comment 42 --body "- [ ] x"')],
    ["gh pr view 只读，放行", bash("gh pr view 42 --json body")],
    ["--body-file 指向干净文件，放行", bash(`gh pr create --title x --body-file ${cleanFile}`, TMP)],
    ["--body-file 指向不存在的文件 → 放行（明写的漏报面，不是洞）",
      bash("gh pr create --title x --body-file /nope/nothing.md", TMP)],
    ["普通 commit 无待办框，放行", bash('git commit -m "[cc] fix: 修一个 off-by-one"')],
    ["正文里出现减号但不是待办框，放行", bash('git commit -m "[cc] docs: a - b [ok]"')],
    // ↓ 这三条是「检查器把自己数进扫描面」的负控：讨论**本条规则**的正文必然引用那个记号，
    //   裸匹配会让每一份解释本闸的 PR body 都被本闸拦下（本批首稿实测命中）。
    ["散文里反引号引用该记号，放行（否则解释本规则的 PR 永远发不出去）",
      bash('gh pr create --title x --body "本闸拦的是只读载体里的 `- [ ]`，`- [x]` 放行"')],
    ["中文句子中间提到该记号，放行", bash('git commit -m "[cc] feat(gates): 拦未勾的 - [ ] 记号"')],
    ["--body-file 正文里只是引用该记号，放行",
      bash(`gh pr create --title x --body-file ${path.join(TMP, "pr-body-prose.md")}`, TMP)],
  ];
  fs.writeFileSync(path.join(TMP, "pr-body-prose.md"),
    "## 改了什么\n新闸拦的是只读载体里的 `- [ ]` 记号（`- [x]` 放行）。\n", "utf8");
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code} ${gate(p).err.slice(0, 80)}`);
}

console.log("\n──── G6 · 心跳 prompt 缺 [dao-heartbeat] 签名（stop:true 豁免）────");
{
  // 正控语料**全部取自真实历史形态**（~/.claude/projects/**/*.jsonl 全量普查，2026-08-02，
  // 993 次 ScheduleWakeup tool_use）。这不是形式主义：dispatch-clauses 对抗验证官节明写
  // 「近似手段的验证语料禁只来自本轮发现的形态」——自造语料只能证明「我想到的那几种被拦住了」。
  const positives = [
    ["最常见的真实形态（占语料首位）", wake({ delaySeconds: 1500, prompt: "高性能自主窗心跳。第一动作：回看上一轮是否真有面向用户的最终文本发出……" })],
    ["带方括号但不是签名（真实形态，易被误以为已签）", wake({ delaySeconds: 900, prompt: "【8h 高性能自主窗 · 心跳】第一动作：回看上一轮……" })],
    ["签名不在开头 ⇒ 不算签名（rhythm 那边也认不出）", wake({ delaySeconds: 900, prompt: "对账：① 两路在途 [dao-heartbeat]" })],
    ["大小写不符 ⇒ 不算（两边判据都大小写敏感）", wake({ delaySeconds: 900, prompt: "[DAO-HEARTBEAT] 心跳" })],
    ["空 prompt 且无 stop ⇒ 无从签名也无从对账", wake({ delaySeconds: 900, prompt: "" })],
    ["既无 prompt 也无 stop", wake({ delaySeconds: 900 })],
    ["stop 是字符串 'true' 不算豁免（免得成为 agent 够得着的旁路）", wake({ stop: "true", prompt: "心跳" })],
    ["stop:false 显式继续，仍要签名", wake({ stop: false, delaySeconds: 900, prompt: "心跳" })],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
  }
  const errText = gate(CANARY["G6-heartbeat-signature"]).err;
  check("正控：stderr 教得出**可直接照抄**的格式（含前缀本身 + 一个完整示例）",
    /\[dao-heartbeat\]/.test(errText) && /例如/.test(errText), errText.slice(0, 200));
  check("正控：stderr 说明它为什么不是装饰（指向 dao-rhythm 与留守四句的投递）",
    /dao-rhythm/.test(errText) && /dao-longwindow/.test(errText), errText.slice(0, 300));
  check("正控：stderr 点明 stop:true 是收窗的正路、不是绕签名的后门",
    /stop:true/.test(errText) && /别拿它绕开签名/.test(errText), errText.slice(0, 400));
  check("逃生阀：DAO_WAKEUP_UNSIGNED_OK=1 → 放行",
    gate(CANARY["G6-heartbeat-signature"], { env: { DAO_WAKEUP_UNSIGNED_OK: "1" } }).code === 0);
  check("逃生阀只认 '1'，不认 'true'",
    gate(CANARY["G6-heartbeat-signature"], { env: { DAO_WAKEUP_UNSIGNED_OK: "true" } }).code === 2);

  const negatives = [
    ["签名开头 → 放行", wake({ delaySeconds: 1500, prompt: "[dao-heartbeat] 高性能目标窗心跳。对账：①……" })],
    ["签名前有空白（两边都先 trim）→ 放行", wake({ delaySeconds: 900, prompt: "  \n[dao-heartbeat] 心跳" })],
    ["签名后紧跟内容无空格 → 放行（判据只管前缀）", wake({ delaySeconds: 900, prompt: "[dao-heartbeat]对账" })],
    ["只有签名没有正文 → 放行（内容够不够是人的判断，不是闸的）", wake({ prompt: "[dao-heartbeat]" })],
    ["stop:true 收窗 → 放行", wake({ stop: true })],
    ["stop:true 且带 prompt → 放行（仍是收窗调用）", wake({ stop: true, prompt: "收窗" })],
    ["别的工具带同名 prompt 参数 → 放行（本闸只认 ScheduleWakeup）",
      { tool_name: "Task", tool_input: { prompt: "高性能目标窗心跳" } }],
    ["工具名含 ScheduleWakeup 子串但不相等 → 放行（早退用全等，不用正则）",
      { tool_name: "mcp__x__ScheduleWakeupLater", tool_input: { prompt: "心跳" } }],
    ["Bash 里出现 [dao-heartbeat] 字样 → 放行（不是这道闸的事）",
      bash('echo "[dao-heartbeat] 心跳"')],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code} ${gate(p).err.slice(0, 80)}`);
}

console.log("\n──── 乙类 · dao-tool-nudge 直推主干分支（提醒不阻断，两态）────");
{
  const positives = [
    ["git push origin main", "git push origin main"],
    ["git push origin master", "git push origin master"],
    ["git push -u origin main", "git push -u origin main"],
    ["git push origin HEAD:main", "git push origin HEAD:main"],
    ["git push --force origin main", "git push --force origin main"],
    ["在 && 链后一段", "npm test && git push origin main"],
  ];
  for (const [name, c] of positives) {
    const ctx = nudge(c);
    check(`正控：${name} → 注入 PR-first 提醒`,
      /dao PR-first/.test(ctx) && /dao-pr-merge\.ps1/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
  }
  check("正控：提醒里说明它是默认节律不是禁令（免得被读成硬闸）",
    /非禁令|默认节律/.test(nudge("git push origin main")));

  const negatives = [
    ["推特性分支不该提醒", "git push origin feat/x"],
    ["裸 git push 刻意不认（目标分支看不见）", "git push"],
    ["git push -u origin feature 不该提醒", "git push -u origin feature/abc"],
    ["删远程分支不是直推，不该提醒", "git push origin --delete main"],
    ["git pull 不该提醒", "git pull origin main"],
    ["字面量里的命令不该提醒", 'echo "git push origin main"'],
    ["分支名里含 main 但不是 main，不该提醒", "git push origin domain-fix"],
  ];
  for (const [name, c] of negatives) {
    check(`负控：${name}`, !/dao PR-first/.test(nudge(c)), JSON.stringify(nudge(c).slice(0, 80)));
  }
  check("乙类只提醒不阻断：nudge hook 恒 exit 0",
    spawnSync(process.execPath, [NUDGE], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" } }), encoding: "utf8" }).status === 0);
}

console.log("\n──── G7 · shell 里跑搜索/读文件（正负控全部取自真语料）────");
{
  // ⚠ **语料来源，照实说（2026-08-02 由对抗验证官抽查 27 条回查后改口）**：本节命令
  //   **取自 `~/.claude/projects/**/*.jsonl` 的真实调用形态**，其中一部分逐字整条命中、
  //   一部分作为子串命中、**另有约 10 条是为覆盖某个分支而构造的**（如
  //   `echo "grep -n foo file"`、`git log --grep="fix" -S "foo"`），还有数条把真实路径
  //   做了脱敏改写。**首版这里写的是「一条都不是我构造的」——那句是笃定措辞且不实**，
  //   留着这行订正当实例：自证性的话最容易被后人当实证引用，所以它必须最保守。
  //   实质影响小（构造的都是低风险负控），但「禁笃定措辞」这条对作者自己同样生效。
  //   仍然成立的那一半：**判据是拿真语料的分布定的**（32721 条命令 / 26402 条唯一命令），
  //   而不是拿本轮想到的形态定的 —— 那才是 dispatch-clauses「语料从哪来」要防的病。
  const positives = [
    ["sed 读文件片段（带 cd && 前缀，真语料最常见形态）",
      "cd /d/frank/mousse-cli && sed -n 130,200p crates/mousse-core/src/prompt_store/mod.rs", /Read 的/],
    ["cat 读文件", "cat src-ui/package.json", /Read/],
    ["grep 搜内容", 'grep -n "creative.libEmpty" src-ui/src/panels/creative/EquipmentLibraryColumn.tsx', /Grep 工具/],
    ["find 找路径", "find crates/mousse-core/src/injection -type f 2>/dev/null", /Glob 工具/],
    ["tail 读日志尾", "tail -8 _tmp/verify-all.log", /Read/],
    ["head 读文件头", "head -5 _tmp/pr-316-readback.md", /Read/],
    ["rg 搜内容", `rg -n "onmessage" src-ui/src --glob '!*.test.*'`, /Grep 工具/],
    // 这一条钉的是「`2>/dev/null` 是 **stderr** 重定向，不该被当成豁免②的 stdout 落文件」。
    // 两者只差一个字符，而放错会让绝大多数真实 grep 调用（真语料里极常带 `2>/dev/null`）整批漏掉。
    ["grep 带 2>/dev/null 仍拦（stderr 重定向 ≠ stdout 落文件）",
      'grep -rl "cdn.tailwindcss.com" "$dest/pages" 2>/dev/null', /Grep 工具/],
    // ── 下面两条钉的是 2026-08-02 对抗验证官找出的两个过宽豁免（都已修）──────
    // 缺陷一：HEREDOC 原为裸 `/<</`，匹配整段任意位置 ⇒ 正文里出现 `<<` 就整条放行。
    // 这条命令是真语料（查 git 冲突标记），它**不含任何 heredoc**，必须被拦。
    ["正文里的 `<<` 不是 heredoc（真语料，查 git 冲突标记）",
      'grep -n "^<<<<<<<\\|^=======\\|^>>>>>>>" src-ui/src/components/TerminalPane.tsx', /Grep 工具/],
    // 缺陷二：`-prune` 曾被列进 find 的"动作"清单 ⇒ 整条放行。
    // 它是**谓词不是动作**，这条是纯文件搜索、100% 可 Glob 替代。
    ["find -prune 是谓词不是动作，仍要拦",
      "find . -path ./node_modules -prune -o -name '*.test.ts' -print", /Glob 工具/],
    // PowerShell 赋值式段首：`Select-String` 在词表里，却曾被 `$x = ` 挡住整批漏过。
    ["PowerShell 赋值式段首（$x = Select-String）仍要拦",
      "$hits = Select-String -Path D:\\frank\\x\\a.md -Pattern version", /Grep 工具/],
  ];
  for (const [name, c, altRe] of positives) {
    const r = gate(bash(c));
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code}`);
    check(`正控：${name} → stderr 给得出替代写法`, altRe.test(r.err), r.err.slice(0, 160));
  }
  check("正控：PowerShell 的 Select-String 同样拦",
    gate({ tool_name: "PowerShell", tool_input: { command: "Select-String -Path D:\\frank\\mousse-cli\\package.json -Pattern version" } }).code === 2);
  // 拒绝消息必须自带「什么情况下不拦」，否则读的人会以为这几个命令被禁了 —— 而它们没有。
  check("正控：stderr 同时列出合法用法（免得被读成「这些命令被禁了」）",
    /管道过滤/.test(gate(bash("cat a.md")).err) && /段首/.test(gate(bash("cat a.md")).err));

  const negatives = [
    // ① 管道过滤 —— 这 4 条全部来自「被权限拒但 G7 刻意放行」的那 31 条
    ["管道过滤 grep（真语料）", `cd /d/frank/windsurf-dao-wt-r2 && node tests/clause-index.tests.js 2>&1 | grep -n "FAIL " | head -20`],
    ["管道过滤 grep 之二（真语料）", `git ls-files ccswitch/ | grep -iE "test|clause|ledger"`],
    ["管道过滤 + head（真语料）", `gh api repos/pleaseai/claude-code-docs/git/trees/main?recursive=1 --jq '.tree[].path' 2>&1 | grep -i hook | head -20`],
    ["until 轮询（真语料）", `until grep -q "VERIFY_ALL_EXIT=" /d/frank/mousse-cli/_tmp/adv-f1/verify-all.out 2>/dev/null; do sleep 10; done; echo "DONE"`],
    // ② stdout 落真实文件
    ["head 输出落文件（真语料）", "head -25 _tmp/branches-to-delete.txt > _tmp/batch1.txt"],
    ["tail 输出追加到文件（真语料）", "tail -n +2 _tmp/pr-384-body-readback.md >> _tmp/pr-384-body-new.md"],
    // ③ heredoc / 命令替换
    ["cat 写文件 heredoc（真语料）", "cat > _tmp/qa/issue-304/probe-buttons.js <<'JS'"],
    ["命令替换里的 head", 'echo "$(head -1 _tmp/x.txt)"'],
    // ④ 不是「读」的动作
    ["sed -i 原地改（真语料）", `sed -i -E -e 's/font-size:[[:space:]]*12px/font-size:var(--text-xs)/g' a.css`],
    ["find -exec（真语料）", `find ccswitch -name "*.md" -exec wc -l {} \\;`],
    ["tail -f 流式（真语料）", "tail -f /dev/null & sleep 1"],
    ["tail -c 字节模式（Read 无字节语义，真语料 92 例）", `tail -c 3000 "C:/Users/x/tasks/out.txt"`],
    ["head -c 字节模式（真语料 22 例）", `head -c 8000 "C:/Users/x/a.jsonl"`],
    // ⑤ 段首不是这些词
    ["git log --grep 自带参数（段首是 git）", `git log --grep="fix" -S "foo" --oneline -20`],
    ["ls 刻意不收（Glob 给不出时间戳/权限位；真语料 3266 例）", `ls -la "/d/frank/TraceyU/design/" 2>/dev/null`],
    ["wc 刻意不收（Read 数不了行数；真语料 1032 例）", `wc -l "D:/frank/windsurf-dao/ccswitch/dao.md"`],
    ["字面量里的命令不该拦", `echo "grep -n foo file"`],
    ["普通命令", "node scripts/run-tests.mjs"],
  ];
  for (const [name, c] of negatives) {
    const r = gate(bash(c));
    check(`负控：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 130)}`);
  }
  check("逃生阀：设了 DAO_SHELL_SEARCH_OK=1 即放行",
    gate(CANARY["G7-shell-search"], { env: { DAO_SHELL_SEARCH_OK: "1" } }).code === 0);
}

console.log("\n──── 段切分器升级（{seg,sep} + $() 感知）后 G3/G5 行为未变 ────");
{
  // 2026-08-02 为 G7 把 shellSegments 换成了 shellSegmentsRaw + 薄包装。**这一组钉的是
  // 「G3/G5 的判定路径一个字符没动」这句自陈** —— 没有它，那句话就只是作者的声明。
  check("G5：多行 commit 正文仍被拦（原本就是靠引号感知切分才拦得住的那一条）",
    gate(bash('git commit -m "[cc] feat: x\n- [ ] 随后补测试"')).code === 2);
  check("G5：`- [x]` 仍放行", gate(bash('git commit -m "做完了\n- [x] 跑了测试"')).code === 0);
  check("G3：npm publish 仍被拦", gate(bash("npm publish --access public")).code === 2);
  check("G3：--dry-run 仍放行", gate(bash("npm publish --dry-run")).code === 0);
  check("G3：字面量 echo \"npm publish\" 仍放行", gate(bash('echo "npm publish"')).code === 0);
  // $() 感知**新**带来的一处行为差异，照直断言出来（而不是假装没有）：
  // 以前 `echo "$(ls | head -1)"` 会在 `|` 处被切成两段（第二段段首 `head`），现在是一段。
  // 对 G3/G5 无影响（段首都是 echo），对 G7 是必须的 —— 命令替换里取一行输出不是读文件。
  check("$() 内部不再切分：命令替换里的 head 不触发 G7", gate(bash('echo "$(ls | head -1)"')).code === 0);
  check("$() 内部不再切分：G3 对命令替换里的 publish 仍是已知漏报（照直钉住，不假装拦得住）",
    gate(bash('echo "$(npm publish)"')).code === 0);
  // 管道仍然要切分（$() 感知不能把 `|` 一起吃掉），且**管道后面那一段仍进 G5 射程**。
  // 判据取「G5 真的拦下了它」而不是「exit 0」—— 放行有两种成因（走到了判定但没命中 /
  // 压根没走到），两者输出一样，只有拦下来才证明那一段被读过。
  // ⚠ 初稿这里写的是 `cat body.md | git commit -F -`，**当场被自己的闸拦下**：
  //    第一段 `cat body.md` 段首正是 G7 的靶。留着这句话当实例 —— 负控写错了会
  //    伪装成「被测对象有问题」，而这次它只是我选错了命令。
  const pipeBody = path.join(TMP, "pipe-body.md");
  fs.writeFileSync(pipeBody, "做了一半\n- [ ] 剩下的随后补\n", "utf8");
  check("管道仍然切分：`echo x | git commit -F <带未勾框的文件>` 仍被 G5 拦下",
    gate(bash(`echo hi | git commit -F "${pipeBody}"`)).code === 2);
}

console.log("\n──── mutation · 判别力（改坏一处，对应正控必须从红变绿）────");
{
  // 每条：把 hook 源码里的一段判据改成永假，断言那一闸的承重正控由 exit 2 掉成 exit 0。
  // 改的是 _tmp/ 里的副本，真文件全程不碰（下面 canary 段验证这一点）。
  const src = fs.readFileSync(HOOK, "utf8");
  const MUTANTS = [
    ["G1-windows-mcp", "/^mcp__windows[-_]?mcp?[-_]*__/i", "/^__NEVER_MATCHES__/"],
    ["G2-live-settings", '["settings.json", "settings.local.json"]', '["__no-such-file.json"]'],
    ["G3-publish", "/^(npm|pnpm|yarn|bun)\\s+publish\\b/.test(seg) ? seg :", "/^__nope\\b/.test(seg) ? seg :"],
    ["G4-screenshot-path", "if (/(^|\\/)_tmp\\/qa\\//i.test(p)) return null;", "if (true) return null;"],
    // 靶点取赋值左侧而非正则字面量本身：判据被收窄过一次（见 hook 里 UNCHECKED_TODO 的注释），
    // 把整条正则抄进测试会让「判据一改、mutation 靶点失配」变成一个静默失效面。
    ["G5-readonly-todo", "const UNCHECKED_TODO = ", "const UNCHECKED_TODO = /__NEVER_MATCH_TODO__/; const _deadPattern = "],
    ["G6-heartbeat-signature", "if (HEARTBEAT_SIG.test(p)) return null;", "if (true) return null;"],
    ["G7-shell-search", "const alt = SEARCH_TOOL_ALT[head];", "const alt = undefined;"],
  ];
  for (const [id, from, to] of MUTANTS) {
    check(`mutation 靶点在源码里唯一存在（${id}）`, src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    const mutantPath = path.join(TMP, `mutant-${id}.js`);
    fs.writeFileSync(mutantPath, src.replace(from, to), "utf8");
    const before = gate(CANARY[id]).code;
    const after = gate(CANARY[id], { script: mutantPath }).code;
    check(`${id}：真文件拦（exit 2）而改坏后不拦（exit 0）⇒ 这条断言真的在测那段判据`,
      before === 2 && after === 0, `before=${before} after=${after}`);
    // 改坏一闸不该顺手把别的闸也弄哑（否则上面那条"变绿"可能是整个 hook 崩了）
    const otherId = id === "G1-windows-mcp" ? "G3-publish" : "G1-windows-mcp";
    check(`${id}：改坏它之后其他闸仍然拦（证明不是整个 hook 崩了）`,
      gate(CANARY[otherId], { script: mutantPath }).code === 2);
  }

  // ── 反向 mutation（2026-08-02 随 G6 加）：上面那批**全在「把门改松」这一侧**，
  //    于是「负控会不会红」这件事一次都没被验到 —— 一组永远为真的负控与一组真正管用的负控，
  //    在全绿的输出里长得一模一样（dispatch-clauses 对抗验证官节点名的第四件事）。
  //    故这里反着来一次：把 G6 的 stop 豁免改坏 ⇒ 原本放行的 `{stop:true}` 必须变成 exit 2。
  {
    const from = "if (ti.stop === true) return null;";
    const to = "if (ti.stop === \"__never_matches__\") return null;";
    check("反向 mutation 靶点在源码里唯一存在（G6 stop 豁免）", src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    const mutantPath = path.join(TMP, "mutant-G6-stop-exemption.js");
    fs.writeFileSync(mutantPath, src.replace(from, to), "utf8");
    const stopOnly = wake({ stop: true });
    const before = gate(stopOnly).code;
    const after = gate(stopOnly, { script: mutantPath }).code;
    check("G6：真文件放行 stop:true（exit 0）而豁免被改坏后拦（exit 2）⇒ 那条负控真的在测豁免分支",
      before === 0 && after === 2, `before=${before} after=${after}`);
    check("G6：改坏豁免不影响签名判据（带签名的仍放行）",
      gate(wake({ prompt: "[dao-heartbeat] 心跳" }), { script: mutantPath }).code === 0);
  }

  // ── G7 的反向 mutation（三条豁免分支各一条）────────────────────────────────
  //    G7 的负控有 18 条，其中一多半靠三个豁免分支放行。**一组永远为真的负控与一组
  //    真正管用的负控，在全绿的输出里长得一模一样** —— 所以每个豁免分支都必须被单独
  //    改坏一次，看着对应负控从 exit 0 翻成 exit 2，才算证明「那条负控真的走到了那个分支」。
  //    这三条同时也是 dispatch-clauses 讲的第三向 mutation：判据还在、也还在算，
  //    只是**算出来的结果不再被消费** —— 前两向验「门在不在」，这一向验「门的答案有没有人听」。
  {
    const REVERSE = [
      ["管道豁免", 'if (sep === "|") continue;', 'if (sep === "__never__") continue;',
        'cd /d/x && node t.js 2>&1 | grep -n "FAIL " | head -20'],
      ["stdout 落文件豁免", "if (STDOUT_TO_FILE.test(rest)) continue;", "if (false) continue;",
        "head -25 _tmp/branches-to-delete.txt > _tmp/batch1.txt"],
      ["-c 字节模式豁免", 'if ((head === "tail" || head === "head") && /(^|\\s)-c(\\s|=|\\d)/.test(rest)) continue;',
        "if (false) continue;", 'tail -c 3000 "C:/Users/x/out.txt"'],
      // ── 下面三条 2026-08-02 补，补它们的理由是本 PR 最贵的一课 ──────────────
      // 首版只给了上面三个分支反向 mutation；对抗验证官随后找出的两个真缺陷
      // （heredoc 裸 `<<` 匹配整段任意位置、`-prune` 被误当成动作）**恰好落在剩下这几个
      // 没配反向 mutation 的分支上**。上面那段注释写着「一组永远为真的负控与一组真管用的
      // 负控在全绿输出里长得一模一样」—— 这句话在本文件里**自己应验了一次**。
      // ⇒ 每个豁免分支都必须有一条反向 mutation。这不是形式主义，它就是那两个缺陷的成因。
      // ⚠️ **这条负控是构造的，不是真语料 —— 而这一格本身就是发现**：
      // 初版用的是真语料 `cat > _tmp/probe.js <<'JS'`，反向 mutation 当场**红**（before=0 after=0）：
      // 它根本没走 heredoc 分支，是被 `> _tmp/probe.js` 的 STDOUT_TO_FILE 分支放行的。
      // 顺着查下去，拿真 hook 对全库 **1147 条含 `<<` 的命令**跑了原版 vs 去掉 heredoc 的变异体，
      // 判决差集 **0 条** ⇒ **heredoc 在真语料上是一条死分支**，每条都被别的分支盖住了。
      // 仍然保留这个分支（`sed 's/a/b/' <<EOF` 这种"输入是内联文本"的形态是真实 shell 语义，
      // 砍掉它就是一个真误伤），但**必须用构造语料才测得到它** —— 照实标注，
      // 别让后人以为它被真实数据验证过。**没有这条反向 mutation，这一格永远不会被发现。**
      ["heredoc 豁免（构造语料·见上方注释）", "if (HEREDOC.test(rest)) continue;", "if (false) continue;",
        "sed 's/a/b/' <<'EOF'"],
      ["find 动作豁免", 'if (head === "find" && /(^|\\s)-(exec|execdir|ok|delete)(\\s|$)/.test(rest)) continue;',
        "if (false) continue;", 'find ccswitch -name "*.md" -exec wc -l {} \\;'],
      ["-f 流式豁免", 'if ((head === "tail" || head === "head") && /(^|\\s)-(f|F|-follow)(\\s|$)/.test(rest)) continue;',
        "if (false) continue;", "tail -f _tmp/dev.log"],
    ];
    for (const [name, from, to, negCmd] of REVERSE) {
      check(`反向 mutation 靶点唯一存在（G7 ${name}）`, src.split(from).length === 2,
        `出现 ${src.split(from).length - 1} 次`);
      const mp = path.join(TMP, `mutant-G7-${name}.js`);
      fs.writeFileSync(mp, src.replace(from, to), "utf8");
      const before = gate(bash(negCmd)).code;
      const after = gate(bash(negCmd), { script: mp }).code;
      check(`G7 ${name}：真文件放行（0）而豁免被改坏后拦（2）⇒ 那条负控真的在测这个分支`,
        before === 0 && after === 2, `before=${before} after=${after}`);
    }
  }

  // fail-open 路径：注入一个必抛的判定，断言"放行 + 大声喊"
  const boom = path.join(TMP, "mutant-throw.js");
  fs.writeFileSync(boom, src.replace(
    'if (!/^mcp__windows[-_]?mcp?[-_]*__/i.test(input.tool_name || "")) return null;',
    'throw new Error("injected");'
  ), "utf8");
  const r = gate(CANARY["G3-publish"], { script: boom });
  check("fail-open：守卫自身抛异常 → exit 0（放行，不砖掉会话）", r.code === 0, `code=${r.code}`);
  check("fail-open 不静默：stderr 明说「本次放行」+ 指向 --selfcheck",
    /守卫自身出错/.test(r.err) && /放行/.test(r.err) && /--selfcheck/.test(r.err), r.err.slice(0, 200));
}

console.log("\n──── canary 恒等（mutation 全程没碰过真文件）────");
{
  check("真 hook 文件 sha256 与开跑前一致", sha(HOOK) === PRISTINE_SHA);
  for (const [id, p] of Object.entries(CANARY)) {
    const after = gate(p).code;
    check(`${id}：mutation 前后真文件行为一致（before=${canaryBefore[id]} after=${after}）`,
      after === canaryBefore[id] && after === 2);
  }
}

console.log("\n──── --selfcheck（只断言形态，真实注册状态取决于用户配置）────");
{
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], { encoding: "utf8" });
  const out = String(r.stdout || "");
  const shapeOk = /^✓ 已注册于 PreToolUse，matcher=/.test(out) ||
                  /^✗ 未注册：/.test(out) ||
                  /^✗ 读不到 live settings\.json/.test(out);
  check("首行为三种既定形态之一", shapeOk, JSON.stringify(out.split("\n")[0]));
  check("逐闸都各打印一行覆盖面结论", (out.match(/· G\d-|✓ G\d-|✗ G\d-/g) || []).length >= 7, out.slice(0, 400));
  check("末行报闸数与逃生阀清单", /共 7 道闸/.test(out) && /DAO_SETTINGS_EDIT_APPROVED/.test(out), out.slice(-200));
  check("G7 出现在逐闸覆盖面清单里", /G7-shell-search/.test(out), out.slice(0, 700));
  check("G7 的逃生阀进了末行清单", /DAO_SHELL_SEARCH_OK/.test(out), out.slice(-200));
  // G6 的注册面（matcher 加 `|ScheduleWakeup`）**属用户动作，本批不改**。故此刻 selfcheck
  // 大概率会把 G6 报成零覆盖 —— 那正是设计意图：「没接上」要在机器通道上说出来。
  // 这里刻意**不断言它一定是零覆盖**（用户随时可能注册完），只断言 G6 出现在逐闸清单里，
  // 即「这道闸的覆盖面确实被独立问过一次」。锚死任一态都会让测试随用户配置变红。
  check("G6 出现在逐闸覆盖面清单里（注册与否都得有它一行）", /G6-heartbeat-signature/.test(out), out.slice(0, 600));
  // ⚠ **这一条 2026-08-02 修过一个真 bug，成因值得留着**：它的名字写着「未注册 **/ 有闸失覆盖**」，
  // 而原判据是 `/^✗/.test(out)` —— `^` 不带 `m` 标志 ⇒ **只读首行**，也就是只看得见「注册没注册」，
  // 逐闸覆盖面那几行（`  ✗ Gn-…：matcher 覆盖不到 …`）它一行都读不到。
  // 于是「有闸失覆盖但已注册」这一态会被判成「该 exit 0」，与 selfcheck 的实际 exit 1 相撞。
  // **它一直没红，是因为在 G6 之前每道闸都被 matcher 覆盖着 —— 那一格从未被走到过。**
  // 这正是本仓反复记的那种形态：一条断言的**名字**覆盖了两种情况，**判据**只覆盖一种，
  // 而在缺一种样本的那段时间里，两者的输出逐字节相同。
  const anyFail = /(^|\n)\s*✗/.test(out);
  check("未注册 / 有闸失覆盖 → 退出码非 0（不许把「没接上」报成通过）",
    anyFail ? r.status !== 0 : r.status === 0, `code=${r.status} anyFail=${anyFail}`);
}

console.log("\n──── 兜底：无关输入一律不拦 ────");
{
  const harmless = [
    ["Read", { tool_name: "Read", tool_input: { file_path: "D:/x/a.md" } }],
    ["Grep", { tool_name: "Grep", tool_input: { pattern: "npm publish" } }],
    ["空输入", {}],
    ["普通 Bash", bash("node scripts/run-tests.mjs")],
    ["普通 Edit", edit("D:/frank/windsurf-dao/ccswitch/dao.md")],
  ];
  for (const [name, p] of harmless) check(`负控：${name} → exit 0`, gate(p).code === 0, `code=${gate(p).code}`);
  const r = spawnSync(process.execPath, [HOOK], { input: "这不是 JSON{{{", encoding: "utf8" });
  check("负控：喂垃圾输入 → exit 0（放行，不因解析失败拦人）", r.status === 0, `code=${r.status}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
