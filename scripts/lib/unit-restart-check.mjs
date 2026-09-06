// dao-check ㉜：常驻 systemd 单元必须 Restart=always（issue #1037）。
//
// 病：Restart=on-failure 遇到干净退出（status=0）systemd 撒手，运行时静悄悄躺死。
// 2026-09-06 实咬：orca-serve 当天崩三次，第三次 Deactivated successfully，orca 死了
// 5 分钟没人管，指挥官 fail-close 整条链停摆。根因已修（unit 改 always）；本闸挡住
// 下一个新增 unit 时顺手写 on-failure 的人——那种违规在干净退出之前和配对了的服务
// 长得一模一样，等察觉时已经是「整条链停了但没人知道为什么」。
//
// 仓规：察觉不到违反的规则不等出错，立规矩时就配自动检查。
//
// 判据只看仓里的模板（host/machine/systemd/*.service），不打机器。
// 机器与仓的一致性已由 server-check ⑳ 管，别重复造。
//
// 检查器自持解析，不 import 任何 unit 安装/生成脚本（自己查自己查不出错）。
// RestartPreventExitStatus= 允许存在且不影响判定——它是「这个退出码必须停下等人」
// 的正当豁免（orca-serve 的 exit 3 = 单实例锁占住 profile）。
//
// 三态必须分得开：
//   unscanned —— 没查成（没给清单 / 0 个 .service / 读失败）
//   red       —— 扫到了非 oneshot，但 Restart 不是 always（含缺省=no、on-failure 等）
//   ok        —— 扫了 N 个，0 个违规
// 「一个都没扫到」不许当绿。

const UNIT_DIR_REL = 'host/machine/systemd';

function stripComment(line) {
  // systemd 键值行：# 起头整行是注释；行内 # 不当注释（值里可能出现）。
  return String(line || '').replace(/\r$/, '');
}

function isCommentOrBlank(line) {
  const s = stripComment(line).trim();
  return s === '' || s.startsWith('#') || s.startsWith(';');
}

/**
 * 从 unit 正文抽 [Service] 节的 Type= / Restart=。
 * 自持：只认节头与键=值，不复用任何仓内 unit 解析器。
 * 同一键多次出现取最后一次（systemd 覆盖语义）。
 * 缺 Type= 按 systemd 默认 simple（即常驻，必须 Restart=always）。
 */
export function parseServiceKeys(text) {
  const lines = String(text || '').split(/\n/);
  let section = '';
  let type = null;
  let restart = null;
  for (const raw of lines) {
    const line = stripComment(raw);
    if (isCommentOrBlank(line)) continue;
    const sect = line.trim().match(/^\[([^\]]+)\]$/);
    if (sect) {
      section = sect[1];
      continue;
    }
    if (section !== 'Service') continue;
    const kv = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)=(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (key === 'Type') type = val;
    else if (key === 'Restart') restart = val;
  }
  return { type, restart };
}

/** 非 oneshot 且 Restart 不是 always → 违规。oneshot 不要求 Restart。 */
export function judgeUnitRestart({ name, text } = {}) {
  const file = String(name || '');
  const { type, restart } = parseServiceKeys(text);
  const effectiveType = type == null || type === '' ? 'simple' : type;
  const oneshot = effectiveType === 'oneshot';
  const always = restart === 'always';
  const ok = oneshot || always;
  return {
    file,
    type: effectiveType,
    typeDeclared: type != null,
    restart,
    oneshot,
    ok,
    why: ok
      ? (oneshot ? 'oneshot 不要求 Restart' : 'Restart=always')
      : (restart == null || restart === ''
        ? `非 oneshot（Type=${effectiveType}）缺 Restart=（systemd 默认 no）`
        : `非 oneshot（Type=${effectiveType}）Restart=${restart}，必须 always`),
  };
}

/**
 * 纯判官：给 {name, text}[]，出违规名单。
 * units 不是数组 / 长度为 0 / 条目读不出正文 → unscanned。
 */
export function inspectUnitRestart({ units } = {}) {
  if (!Array.isArray(units)) {
    return { ok: false, unscanned: true, error: '没给单元清单（没查成）', violations: [], scanned: 0, resident: 0 };
  }
  if (units.length === 0) {
    return { ok: false, unscanned: true, error: '扫到 0 个 .service（没查成，不是 0 个违规）', violations: [], scanned: 0, resident: 0 };
  }
  const judged = [];
  for (const u of units) {
    const name = u && u.name != null ? String(u.name) : '';
    if (!u || typeof u.text !== 'string') {
      return {
        ok: false,
        unscanned: true,
        error: `读 ${name || '(无名)'} 失败：没给正文（没查成）`,
        violations: [],
        scanned: judged.length,
        resident: judged.filter((j) => !j.oneshot).length,
      };
    }
    judged.push(judgeUnitRestart({ name, text: u.text }));
  }
  const violations = judged.filter((j) => !j.ok);
  const resident = judged.filter((j) => !j.oneshot).length;
  return {
    ok: violations.length === 0,
    unscanned: false,
    error: null,
    violations,
    scanned: judged.length,
    resident,
  };
}

function listServiceFiles(readdir, dirRel) {
  const names = readdir(dirRel);
  if (!Array.isArray(names)) return null;
  return names.filter((f) => typeof f === 'string' && f.endsWith('.service')).sort();
}

/**
 * 从目录读 *.service。探头由调用方注入，live 与夹具走同一条纯函数。
 * 目录不在 / 读不出 / 0 个 .service → unscanned。
 */
export function inspectUnitRestartDir({ dirRel = UNIT_DIR_REL, readdir, readFile } = {}) {
  if (typeof readdir !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 readdir/readFile 探头（没查成）', violations: [], scanned: 0, resident: 0 };
  }
  let names;
  try {
    names = listServiceFiles(readdir, dirRel);
  } catch (e) {
    return {
      ok: false,
      unscanned: true,
      error: `列目录失败：${String(e && e.message ? e.message : e).slice(0, 160)}`,
      violations: [],
      scanned: 0,
      resident: 0,
    };
  }
  if (names == null) {
    return { ok: false, unscanned: true, error: '列目录没给出名单（没查成）', violations: [], scanned: 0, resident: 0 };
  }
  if (names.length === 0) {
    return inspectUnitRestart({ units: [] });
  }
  const units = [];
  for (const name of names) {
    const rel = `${dirRel.replace(/\/+$/, '')}/${name}`;
    let text;
    try {
      text = readFile(rel);
    } catch (e) {
      return {
        ok: false,
        unscanned: true,
        error: `读 ${rel} 失败：${String(e && e.message ? e.message : e).slice(0, 160)}`,
        violations: [],
        scanned: 0,
        resident: 0,
      };
    }
    if (typeof text !== 'string') {
      return {
        ok: false,
        unscanned: true,
        error: `读 ${rel} 失败：没给正文（没查成）`,
        violations: [],
        scanned: 0,
        resident: 0,
      };
    }
    units.push({ name, text });
  }
  return inspectUnitRestart({ units });
}

/** 夹具判别力：red 必须拦 on-failure、ok 必须绿、empty 必须标没查成。 */
export function inspectUnitRestartFixtures({
  rootRel = 'tests/fixtures/unit-restart',
  exists,
  readdir,
  readFile,
} = {}) {
  if (typeof exists !== 'function' || typeof readdir !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 exists/readdir/readFile 探头（没查成）' };
  }
  if (!exists(rootRel)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${rootRel}` };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const dir = `${rootRel}/${kind}`;
    if (!exists(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const r = inspectUnitRestartDir({
      dirRel: dir,
      readdir,
      readFile,
    });
    if (kind === 'empty') {
      if (!r.unscanned) {
        problems.push(`empty/ 应没查成但判成 ok=${r.ok} unscanned=${r.unscanned} scanned=${r.scanned}`);
      } else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.unscanned || r.ok) {
        problems.push(`red/ 自称该红但判成 ok=${r.ok} unscanned=${r.unscanned}`);
      } else {
        const hit = (r.violations || []).some((v) => /on-failure/.test(v.why || '') || v.restart === 'on-failure');
        if (!hit) problems.push('red/ 没点出 Restart=on-failure');
        else kinds.red += 1;
      }
    } else if (kind === 'ok') {
      if (r.unscanned || !r.ok) {
        const names = (r.violations || []).map((v) => v.file).join('、');
        problems.push(`ok/ 自称该绿但判成 ok=${r.ok} unscanned=${r.unscanned}${names ? `：${names}` : ''}`);
      } else if (r.scanned === 0) {
        problems.push('ok/ 扫了 0 个——和 empty 分不开');
      } else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false,
      unscanned: true,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds,
      problems,
    };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}

export { UNIT_DIR_REL };
