#!/usr/bin/env node
// dao-worktree-create.mjs — 建树备注硬闸：包住 `orca worktree create`，强制 --comment
//   （issue #360 拍板点 5-A 用户选 B「直接上硬闸」；备注格式按件五 5.2 + 拍板 5-B 固定枚举）
//
// 为什么存在：板列只答四态（todo/in-progress/in-review/completed），答不出「in-progress 里
//   具体到哪一步」。树备注补这一格——但写在文档里的要求没有任何东西会为它变红（本仓 #292 实证），
//   所以做成机器闸：没备注 ⇒ 非零退出、不建树；格式不合 ⇒ 非零退出、不建树。
//
// ⚠ 绕过面（照直写，用户拍板原话）：直接敲 `orca worktree create` 仍然绕得过去——
//   本闸管的是正路（帅按规矩走这个入口），不是「已彻底防住」。
//
// 备注格式（真相源：_tmp/2026-08-13-issue360-label-design.md 件五 5.2）：
//   <编排形态> · <当前棒次> · <等什么>     —— 三格用「空格·空格」分隔，全串 ≤40 字符
//   编排形态 ∈ {轻装单兵, 树帅制, 多树并行}（三值枚举）
//   当前棒次 ∈ {派单中, 实现官在写, 对抗官在跑, 待终审, 等用户}（五值枚举）
//   第三格自由文本非空，无阻塞写「无阻」。加新枚举值走一次拍板（5-B），不许就地扩。
//   第三格自由文本内不许再出现「 · 」——split 后不是恰好三格即判分隔符错（40 字符内
//   真实语料没有这种形态，收严换来判定可预测）。
//
// 用法：node scripts/dao-worktree-create.mjs --comment "<备注>" [--dry-run] [其余参数原样透传]
//   --dry-run  校验通过后只打印将执行的 orca 命令，不真建树（自测用）。
//
// 退出码（机器判定只认摘要行 WORKTREE_CREATE_SUMMARY）：
//   0 = 校验过且建树成功（或 --dry-run 校验过）
//   1 = 校验过但 orca 自己失败（真实退出码在摘要行 orcaExit= 里）
//   2 = 缺 --comment
//   3 = 备注格式不合（哪一格错在输出里点名）
//   4 = 环境 / 用法错（orca 命令找不到等）
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORMS = ["轻装单兵", "树帅制", "多树并行"];
export const BATONS = ["派单中", "实现官在写", "对抗官在跑", "待终审", "等用户"];
export const MAX_LEN = 40;
export const SEP = " · ";
export const EXIT = { OK: 0, ORCA_FAIL: 1, NO_COMMENT: 2, BAD_FORMAT: 3, ENV: 4 };

/**
 * 备注格式校验（纯函数，自测直接 import 它）。
 * 返回 { ok:true } 或 { ok:false, code, reason }——code 是机器可判的违规类别：
 *   empty / multiline / too-long / separator / form / baton / wait-empty
 */
export function validateComment(comment) {
  if (typeof comment !== "string" || comment.trim() === "") {
    return { ok: false, code: "empty", reason: "备注为空" };
  }
  // 40 字符上限的立法理由是「Orca 卡片一行显示得下」（件五 5.2）——换行直接破坏
  // 「一行」契约，且能让 ≤40 码点的串占两行，绕过长度闸的本意。拒的是全部产生
  // 垂直位移的字符：CR/LF/CRLF、LS(U+2028)/PS(U+2029)（ES 规范 LineTerminator，
  // JS 字符串渲染必断行）、NEL(U+0085)、VT(U+000B)/FF(U+000C)——合法备注语料里
  // 不存在这七个，误伤面为零。其余控制/零宽字符（不产生换行的）仍不拒：黑名单
  // 列不全，白名单（如拒 \p{Cf}）会误伤组合 emoji 的 ZWJ。
  if (/[\r\n\u2028\u2029\u0085\u000B\u000C]/.test(comment)) {
    return { ok: false, code: "multiline", reason: "备注必须单行——不许含换行" };
  }
  // 长度按码点数（中英文都算 1 字符），不是 UTF-16 单元数。
  const len = [...comment].length;
  if (len > MAX_LEN) {
    return { ok: false, code: "too-long", reason: `全串 ${len} 字符 > ${MAX_LEN}` };
  }
  const parts = comment.split(SEP);
  if (parts.length !== 3) {
    return {
      ok: false, code: "separator",
      reason: `要恰好三格、用「空格·空格」分隔，实得 ${parts.length} 格`,
    };
  }
  const [form, baton, wait] = parts;
  if (!FORMS.includes(form)) {
    return { ok: false, code: "form", reason: `编排形态「${form}」不在枚举 ${FORMS.join("/")}` };
  }
  if (!BATONS.includes(baton)) {
    return { ok: false, code: "baton", reason: `当前棒次「${baton}」不在枚举 ${BATONS.join("/")}` };
  }
  if (wait.trim() === "") {
    return { ok: false, code: "wait-empty", reason: "第三格空——无阻塞就写「无阻」" };
  }
  return { ok: true };
}

function usage() {
  process.stderr.write(
    '用法：node scripts/dao-worktree-create.mjs --comment "<形态> · <棒次> · <等什么>" [--dry-run] [orca 参数原样透传]\n' +
    `  编排形态：${FORMS.join(" / ")}\n` +
    `  当前棒次：${BATONS.join(" / ")}\n` +
    `  第三格自由文本，无阻塞写「无阻」；全串 ≤${MAX_LEN} 字符\n` +
    "退出码：0 成功 / 1 orca 失败 / 2 缺 --comment / 3 格式不合 / 4 环境错\n",
  );
}

function summary(exit, stage, extra = "") {
  console.log(`WORKTREE_CREATE_SUMMARY exit=${exit} stage=${stage}${extra ? " " + extra : ""}`);
  return exit;
}

function main(argv) {
  let comment = null;
  let dryRun = false;
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--comment") comment = argv[++i] ?? "";
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--help" || argv[i] === "-h") { usage(); return EXIT.ENV; }
    else passthrough.push(argv[i]);
  }

  if (comment === null || comment.trim() === "") {
    console.error("✗ 缺 --comment：建树必带一行备注，没有备注不建树（#360 拍板 5-A/B）");
    usage();
    return summary(EXIT.NO_COMMENT, "validate", "code=empty");
  }

  const v = validateComment(comment);
  if (!v.ok) {
    console.error(`✗ 备注格式不合（${v.code}）：${v.reason}`);
    console.error(`  给的是：「${comment}」`);
    usage();
    return summary(EXIT.BAD_FORMAT, "validate", `code=${v.code}`);
  }

  const orcaArgs = ["worktree", "create", ...passthrough, "--comment", comment];
  if (dryRun) {
    console.log(`✓ 备注合规。DRY-RUN，不真建树。将执行：orca ${orcaArgs.join(" ")}`);
    return summary(EXIT.OK, "dry-run");
  }

  // Windows 下 orca 是 .cmd 垫片，spawnSync 不带 shell 找不到裸名 ⇒ ENOENT 时补 .cmd 再试。
  let r = spawnSync("orca", orcaArgs, { stdio: "inherit", windowsHide: true });
  if (r.error && r.error.code === "ENOENT" && process.platform === "win32") {
    r = spawnSync("orca.cmd", orcaArgs, { stdio: "inherit", windowsHide: true });
  }
  if (r.error) {
    console.error(`✗ orca 起不来：${r.error.message}`);
    return summary(EXIT.ENV, "orca");
  }
  if (r.status !== 0) {
    console.error(`✗ orca worktree create 失败（exit ${r.status}）——备注是合规的，问题在 orca 侧`);
    return summary(EXIT.ORCA_FAIL, "orca", `orcaExit=${r.status}`);
  }
  return summary(EXIT.OK, "orca");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
