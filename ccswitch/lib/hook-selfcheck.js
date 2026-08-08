// hook-selfcheck.js — dao hook 的加固脚手架公共库
//
// ── 为什么有这个库 ───────────────────────────────────────────────────────────
// dao-rule-echo.js 与 dao-compact-log.js 的**加固层**（不是业务层）曾逐行重复：
// stdout 去重写、三重留痕的 fail()、故障注入闸、synthetic 心跳判据、日志轮转、
// 两段式 --selfcheck（查注册 + 查真实触发心跳）。这些是「hook 不要变成静默死层」
// 这一条教训的固化形态，与具体 hook 干什么无关 ⇒ 属公共脚手架，抽出来一处修全处到。
//
// 抽取原则（fortify2-20260726 刀F F1）：**只抽形态，不抽判据**。
// 各 hook 的业务判据（回灌什么 / 记什么 / matcher 怎样才算覆盖 / 陈旧多少天算失联）
// 全部留在各自文件里、以参数传入——它们本就该各自演进，塞进公共库会制造错误的耦合。
//
// ── 有意保留的两处差异（不要「顺手统一」）───────────────────────────────────
// ① 日志写失败的语义不同：dao-rule-echo 的心跳是**旁证**，写不动也不该拖垮回灌
//    ⇒ heartbeat() 全程吞异常；dao-compact-log 的落盘日志是**主产物**（systemMessage
//    的模型侧可见性未被文档担保，落盘才是唯一确定生效的可见化手段）⇒ appendJsonl()
//    向上抛，由调用方 fail() 报出来。若把两者统一成「都吞」，compact-log 就退化成
//    它自己头注里点名要防的那种静默死层。
// ② 陈旧阈值 30 天 / 14 天不同：规则文件不是每天都改，compaction 却几乎每天发生
//    ⇒ 同一个数字套两个 hook 会让一边过敏、一边失灵。
//
// ── 近似说明（禁笃定措辞）─────────────────────────────────────────────────────
// `isSynthetic` 的判据是 payload 形状（显式自测环境变量，或缺 transcript_path）。
// 这是**近似**，两个方向都构造得出反例：刻意伪造带 transcript_path 的 payload 能
// 骗过它冒充「真实触发」；反之宿主若某天不再下发 transcript_path，真实调用会被误标
// synthetic 而让 --selfcheck 假报「从未生效」。它挡的是「顺手自测把自己染绿」这一类
// 无心之失，挡不住蓄意造假，也不保证宿主协议不变。
//
// ── 留痕域单点：全域分布与本批的覆盖面（issue #190 第 2 条）──────────────────
// 本库把 `errors.log` / `fired.log` / `last.json` **三样全部**放在同一个
// `<root>/_tmp/<stateSubdir>/` 域里，而 `heartbeat()` 与 `appendErrorLog()` 都吞异常
// ⇒ 那个域一旦坏掉（`_tmp` 被占成普通文件、盘满、权限变更），三样同时哑掉且退出码干净。
// **「一条都没记下来」与「本次什么都没发生」在盘上逐字节相同。** 这不是假想：#190 第 2 条
// 是对抗官把仓根 `_tmp` 换成普通文件实测出来的（限流事件四条通道全哑、exit 0）。
//
// **全域分布（建护栏前先摸分布，`[#守-全域分布]`）——本库当前 4 个消费方全部落在这一个域里**：
//   · `dao-rule-echo.js`           旁证型心跳，**本批未 opt-in**（见下）
//   · `dao-compact-log.js`         落盘日志是主产物，写不成时 `fail()` 已经出声 ⇒ 不静默
//   · `dao-rate-limit-sentinel.js` **本批 opt-in**：它的 fired.log 是「真实限流样本」的耐久
//     数据（#190 重开条件直接指着它），而它挂在 StopFailure 上 —— 输出与退出码都被宿主忽略，
//     出错时**没有任何人会看见**，是这 4 个里最需要主动探测的一个
//   · `dao-probe-gate.js`          **本批 opt-in**：验收判据要从它的 fired.log 确认 block 真发生过
// **为什么前两个没 opt-in，照直写**：它们的 `--selfcheck` 输出被 `tests/hook-selfcheck.tests.js`
// 以**逐字锚定**的方式钉着（那份断言治的是另一个病：模板文案被改坏没人红），给它们加一段
// 输出要连那批锚一起改，属另一个批次的判断。⇒ **本条是纵深不是全覆盖**，欠账照记：
// 那两个 hook 的留痕域此刻仍然只有「写不成就吞掉」这一层。
//
// 真相源：windsurf-dao/ccswitch/lib/hook-selfcheck.js
// 消费方：ccswitch/hooks/dao-rule-echo.js、ccswitch/hooks/dao-compact-log.js、
//        ccswitch/hooks/dao-rate-limit-sentinel.js、ccswitch/hooks/dao-probe-gate.js
// 自证：这两个 hook 各自的测试（tests/dao-rule-echo.tests.js / tests/dao-compact-log.tests.js）
//       原样全绿即证明本库未改变任何既有行为——「重构不改行为」的唯一证明方式。
//       本库自己的单元自证在 tests/hook-selfcheck.tests.js。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // 本文件在 <root>/ccswitch/lib/
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LIVE_SETTINGS = path.join(HOME, ".claude", "settings.json");

const DEFAULT_MAX_LINES = 2000;

// ── jsonl 读写与轮转 ────────────────────────────────────────────────────────
// 坏行跳过而非抛：日志是旁证，一行写坏了不该让整份日志不可读（否则「日志坏了」
// 会被 --selfcheck 读成「从未触发」——把一个小故障放大成误判接线已断）。
function parseJsonl(text) {
  return String(text).split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

function readJsonlRecords(p) {
  if (!fs.existsSync(p)) return [];
  return parseJsonl(fs.readFileSync(p, "utf8"));
}

// 轮转：超上限即保留后半。失败吞掉——裁剪不成功不该拖垮记录本身。
function rotateJsonl(p, maxLines) {
  const max = maxLines || DEFAULT_MAX_LINES;
  try {
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length > max) {
      fs.writeFileSync(p, lines.slice(-Math.floor(max / 2)).join("\n") + "\n", "utf8");
    }
  } catch (_) { /* 裁剪失败不该拖垮记录本身 */ }
}

// 追加一行。**向上抛**：调用方若把这份日志当主产物，需要知道它没写成。
function appendJsonl(p, rec, maxLines) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
  rotateJsonl(p, maxLines);
}

/**
 * 留痕域可写性探测（issue #190 第 2 条）。
 *
 * **判据是「真写一次再删」，不是「目录存在吗」** —— 后者对「`_tmp` 被占成普通文件」这个
 * 实测形态给出的答案是「不存在」，而那与「还没被创建过」不可区分；而**真写一次**分得开：
 * `mkdirSync` 在父路径是文件时抛 `ENOTDIR`/`EEXIST`，`writeFileSync` 在盘满/无权限时抛。
 * ⚠ **它证的是「此刻写得进去」，不是「历史上一条都没丢」** —— 后者要靠一个出 `_tmp` 域的
 * 镜像与它对账（哨兵那侧已有镜像，对账那一格照直记为未做，见 #190 交付的未尽处）。
 *
 * 探针文件名前缀 `.dao-write-probe-` + pid，写完立即 unlink；`readJsonlRecords` 只读
 * `fired.log` ⇒ **本探测的产物不落在任何人的扫描面内**（`[#守-输出面外]`）。
 *
 * @returns {{ok:boolean, why?:string}}
 */
function probeDirWritable(dir) {
  const probe = path.join(dir, ".dao-write-probe-" + process.pid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "probe", "utf8");
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: (e && e.code ? e.code + " · " : "") + String(e && e.message) };
  }
}

/**
 * 造一个 hook 的加固脚手架。
 *
 * @param {object} cfg
 * @param {string} cfg.name          hook 名（留痕前缀，如 "dao-rule-echo"）
 * @param {string} cfg.stateSubdir   留痕子目录名（落 <root>/_tmp/<stateSubdir>/）
 * @param {string} cfg.failTail      fail() 尾注：说明「本次没做什么」，各 hook 自述
 * @param {string} cfg.forceErrorEnv 故障注入环境变量名（自测「出错不静默」用）
 * @param {string} cfg.selfTestEnv   自测标记环境变量名（命中即把心跳标 synthetic）
 * @param {number} [cfg.maxLogLines] 日志轮转上限，缺省 2000
 */
function createHookScaffold(cfg) {
  const name = cfg.name;
  const stateDir = path.join(ROOT, "_tmp", cfg.stateSubdir);
  const errorLog = path.join(stateDir, "errors.log");
  const firedLog = path.join(stateDir, "fired.log");
  const lastJson = path.join(stateDir, "last.json");
  const maxLogLines = cfg.maxLogLines || DEFAULT_MAX_LINES;

  // stdout 只许写一次：hook 的 stdout 是与宿主的单帧协议，写第二次会产出
  // 两个拼在一起的 JSON，宿主解析失败 ⇒ 静默丢掉本次全部输出。
  let stdoutUsed = false;
  function emit(obj) {
    if (stdoutUsed) return;
    stdoutUsed = true;
    try { process.stdout.write(JSON.stringify(obj)); } catch (_) {}
  }

  function appendErrorLog(msg, err) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const stack = err && err.stack ? "\n" + err.stack : "";
      fs.appendFileSync(errorLog, `[${new Date().toISOString()}] ${msg}${stack}\n`, "utf8");
    } catch (_) {}
  }

  // 三重留痕（stderr + 用户可见 systemMessage + 磁盘日志）但**仍 exit 0**：
  // PostToolUse/PostCompact 阶段动作已完成，报错误态只会污染宿主对该动作的判定。
  // 「不阻断」≠「不出声」——反面教材是 hookify 的 stop.py，finally 里无条件 exit 0
  // 把一切内部错误吞成静默死层，而「已启用 + 文件存在」的检查会对它报绿。
  function fail(stage, err) {
    const detail = err && err.message ? err.message : String(err);
    const msg = `[${name}] ${stage} 失败：${detail}`;
    try { process.stderr.write(msg + "\n"); } catch (_) {}
    appendErrorLog(msg, err);
    emit({ systemMessage: msg + `（${cfg.failTail}。日志：${errorLog}）` });
    process.exit(0);
  }

  // 故障注入。**两种取值，刻意分得开**（issue #190 第 3 条）：
  //   · `=1`        ⇒ 任何相位命中（历史行为，一字不改；实际总是撞上第一个注入点）
  //   · `=<相位名>` ⇒ **只有那一个相位**命中
  // 为什么需要相位：hook 的最外层 `catch` 常常是**真空锚** —— 注入点都在 `main()` 内层
  // `try` 里，异常走不到外层，于是「把外层 catch 改成 fail-closed 也没有一条断言会红」。
  // 有了相位名，就能把异常精确投放到内层 try **之外**，让最外层那条路第一次真的被跑到。
  function maybeForceError(stage) {
    const v = process.env[cfg.forceErrorEnv];
    if (v === "1" || (v && v === stage)) {
      throw new Error(`人为注入故障（${cfg.forceErrorEnv}=${v}）@${stage}`);
    }
  }

  // 心跳只有真被宿主调用过才写得出来，是「已接线」的硬证据。自测/手工空跑也会走到
  // 这里，故标 synthetic，--selfcheck 只采信非 synthetic ——否则单元测试的心跳会让
  // 自检误报「已生效」，那正是本脚手架要治的那类假绿。判据的近似性见文件头注。
  function isSynthetic(input) {
    if (process.env[cfg.selfTestEnv] === "1") return true;
    return !(input && input.transcript_path);
  }

  // 旁证型心跳：写 last.json + 追加 fired.log，全程吞异常。
  function heartbeat(rec) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(lastJson, JSON.stringify(rec, null, 2), "utf8");
      fs.appendFileSync(firedLog, JSON.stringify(rec) + "\n", "utf8");
      rotateJsonl(firedLog, maxLogLines);
    } catch (_) { /* 心跳失败不该拖垮主产物 */ }
  }

  // 读 stdin 的 PostToolUse/PostCompact payload。真实宿主一定给合法 JSON；
  // 解析不了说明协议对不上或被手工空跑，属该报的错，不做静默降级（静默＝死层）。
  function readStdinJson() {
    let raw = "";
    try {
      raw = fs.readFileSync(0, "utf8");
    } catch (e) {
      fail("读取 stdin", e);
    }
    try {
      maybeForceError("parse");
      const input = JSON.parse(raw);
      if (!input || typeof input !== "object") throw new Error("stdin JSON 不是对象");
      return input;
    } catch (e) {
      fail("解析 stdin JSON", e);
    }
    return null; // 到不了：fail 已 exit
  }

  /**
   * 两段式自检：① 读 live settings.json 核对是否真注册 ② 读心跳日志排除 synthetic
   * 后判断是否曾被真实调用。**不看「文件是否存在」**——那是三例 55 天零生效事故的
   * 共同误判：脚本躺在盘上、检查报绿、其实从未被调用过一次。
   *
   * **③ 是 opt-in 的第三段**（`sc.probeDirs`，issue #190 第 2 条）：给了才查留痕域写得进去没有。
   * 不给 ⇒ 输出与本参数引入之前**逐字节相同**（前两个消费方因此一个字都没变）。
   *
   * @param {object} sc
   * @param {string} sc.event         宿主事件名（如 "PostToolUse"）
   * @param {string} sc.scriptName    注册串里该出现的脚本文件名
   * @param {(m:string)=>boolean} sc.covers        matcher 是否覆盖所需触发面
   * @param {(m:string)=>string}  sc.matcherLabel  matcher 的展示形态
   * @param {string} sc.coversFailNote  覆盖不足时追加的说明
   * @param {string} sc.logPath       心跳/记录日志路径
   * @param {string} sc.missNote      「注册了也可能因…而从未触发」里的那半句
   * @param {(last:object)=>string} sc.describeLast 末次记录的摘要片段
   * @param {number} sc.staleDays     陈旧告警阈值（天）
   * @param {(d:string)=>string} sc.staleNote  陈旧告警文案
   * @param {string} sc.logReadFailLabel 日志读取失败的阶段名
   * @returns {number} bad 计数（0 = 全过）
   */
  function selfcheckLines(sc) {
    const lines = [];
    let bad = 0;

    // ① 注册核验
    try {
      const j = JSON.parse(fs.readFileSync(LIVE_SETTINGS, "utf8"));
      const groups = (j.hooks && j.hooks[sc.event]) || [];
      let hit = null;
      const re = new RegExp(sc.scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      for (const g of groups) {
        for (const h of (g.hooks || [])) {
          if (typeof h.command === "string" && re.test(h.command)) hit = { g, h };
        }
      }
      if (!hit) {
        lines.push(`✗ 未注册：${LIVE_SETTINGS} 的 hooks.${sc.event} 里没有引用 ${sc.scriptName} 的 command。`);
        bad++;
      } else {
        const m = hit.g.matcher == null ? "" : String(hit.g.matcher);
        const covers = sc.covers(m);
        lines.push(`${covers ? "✓" : "✗"} 已注册于 ${sc.event}，matcher="${sc.matcherLabel(m)}"${covers ? "" : sc.coversFailNote}`);
        if (!covers) bad++;
      }
    } catch (e) {
      lines.push(`✗ 读取/解析 settings.json 失败：${e.message}`);
      bad++;
    }

    // ② 心跳核验：只采信非 synthetic 记录（自测心跳不算「已生效」）
    try {
      const all = readJsonlRecords(sc.logPath);
      const real = all.filter((r) => r.synthetic !== true);
      if (!real.length) {
        lines.push(`✗ 无真实触发记录（日志共 ${all.length} 条，其中自测/手工 ${all.length - real.length} 条）—— ` +
                   `尚未被宿主真实调用过；注册了也可能因 ${sc.missNote}不匹配而从未触发。日志：${sc.logPath}`);
        bad++;
      } else {
        const last = real[real.length - 1];
        const days = (Date.now() - Date.parse(last.at)) / 86400000;
        lines.push(`✓ 有真实触发记录：末次 ${last.at}（${days.toFixed(1)} 天前）· ${sc.describeLast(last)}；真实 ${real.length} 条 / 共 ${all.length} 条。`);
        if (days > sc.staleDays) lines.push("  " + sc.staleNote(days.toFixed(0)));
      }
    } catch (e) {
      lines.push(`✗ ${sc.logReadFailLabel}：${e.message}`);
      bad++;
    }

    // ③ 留痕域可写性（opt-in）。**写不进去时必须明说它会污染 ② 的结论** ——
    // 「无真实触发记录」与「记录写不进去」在 ② 的输出里长得一样，而处方完全不同。
    for (const d of (Array.isArray(sc.probeDirs) ? sc.probeDirs : [])) {
      const r = probeDirWritable(d.dir);
      if (r.ok) {
        lines.push(`✓ 留痕域可写：${d.label} → ${d.dir}`);
      } else {
        lines.push(`✗ 留痕域写不进去：${d.label} → ${d.dir}（${r.why}）` +
          `${d.failNote || ""} ⇒ 上面那条「无真实触发记录」可能只是写不进去，不是没触发过。`);
        bad++;
      }
    }

    return { lines, bad };
  }

  // --selfcheck 的完整 CLI 形态：跑两段核验、打印、按 bad 定退出码。
  // 顶层 try 兜住自身异常并 exit 1（自检崩了就是没过，不许静默当过）。
  function runSelfcheckCli(sc) {
    try {
      const r = selfcheckLines(sc);
      process.stdout.write(`[${name} --selfcheck]\n` + r.lines.map((s) => "  " + s).join("\n") + "\n");
      process.exit(r.bad ? 1 : 0);
    } catch (e) {
      process.stderr.write(`[${name}] selfcheck 异常：${e.message}\n`);
      process.exit(1);
    }
  }

  return {
    name, stateDir, errorLog, firedLog, lastJson, maxLogLines,
    emit, appendErrorLog, fail, maybeForceError, isSynthetic,
    heartbeat, readStdinJson, selfcheckLines, runSelfcheckCli,
    appendJsonl: (p, rec, max) => appendJsonl(p, rec, max || maxLogLines),
  };
}

module.exports = {
  createHookScaffold,
  parseJsonl, readJsonlRecords, appendJsonl, rotateJsonl, probeDirWritable,
  ROOT, HOME, LIVE_SETTINGS, DEFAULT_MAX_LINES,
};
