// 控制面闸生产挂载活检（dao-check ㉟，#1165）。
//
// 检查器自己读文件、自己 spawn 钩子，不 import 判定函数（自己查自己查不出错）。
//
// ① 仓内现役挂载面在：scripts/githooks/pre-push 指向 control-plane-pre-push.mjs
// ② land.mjs 真 push 前问 decideControlPlane
// ③ mirasim-ws-probe 写 control-plane.json（写腿）
// ④ 钩子行为：reachable=false 拦、true 放、没查成放
// 落点从未出现过：checkControlPlaneDropPoint → skip 不是绿
// 零样本（钩子文件不在）报没查成，不许记成绿。

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PRE_PUSH = ['scripts', 'githooks', 'pre-push'];
const PRE_PUSH_JS = ['scripts', 'lib', 'control-plane-pre-push.mjs'];
const LAND = ['scripts', 'land.mjs'];
const WS_PROBE = ['scripts', 'mirasim-ws-probe.mjs'];
const WRITE_LIB = ['scripts', 'lib', 'control-plane-write.mjs'];

function read(root, rel) {
  const file = join(root, ...rel);
  if (!existsSync(file)) return { file, exists: false, text: '' };
  return { file, exists: true, text: readFileSync(file, 'utf8') };
}

function runHook(script, envExtra = {}, cwd) {
  return spawnSync(process.execPath, [script], {
    windowsHide: true,
    encoding: 'utf8',
    input: '',
    timeout: 15000,
    cwd,
    env: { ...process.env, ...envExtra },
  });
}

/**
 * @returns {{green?: string, fail?: [string, string, string]}}
 */
export function checkControlPlaneProduction({ root } = {}) {
  if (!root) return { fail: ['没给仓库根', 'checkControlPlaneProduction 要 root', ''] };
  const problems = [];

  const hookSh = read(root, PRE_PUSH);
  if (!hookSh.exists) {
    return {
      fail: [
        '现役 git pre-push 不在',
        '恢复 scripts/githooks/pre-push；0 个挂载面 = 没查成',
        hookSh.file,
      ],
    };
  }
  if (!/control-plane-pre-push\.mjs/.test(hookSh.text)) {
    problems.push('scripts/githooks/pre-push 没指向 control-plane-pre-push.mjs');
  }

  const hookJs = read(root, PRE_PUSH_JS);
  if (!hookJs.exists) {
    return {
      fail: [
        'control-plane-pre-push.mjs 不在',
        '恢复 scripts/lib/control-plane-pre-push.mjs',
        hookJs.file,
      ],
    };
  }
  if (!/decideControlPlane/.test(hookJs.text)) {
    problems.push('pre-push 入口没问 decideControlPlane');
  }

  const land = read(root, LAND);
  if (!land.exists) {
    return {
      fail: [
        'land.mjs 不在',
        '收工命令是第二条现役推送腿',
        join(root, ...LAND),
      ],
    };
  }
  if (!/decideControlPlane/.test(land.text)) {
    problems.push('land.mjs 真 push 前没问 decideControlPlane');
  }

  const writeLib = read(root, WRITE_LIB);
  if (!writeLib.exists) {
    return {
      fail: [
        '写腿模块不在',
        '恢复 scripts/lib/control-plane-write.mjs',
        writeLib.file,
      ],
    };
  }
  if (!/control-plane\.json/.test(writeLib.text) || !/writeControlPlaneFile/.test(writeLib.text)) {
    problems.push('写腿模块没有 writeControlPlaneFile / control-plane.json');
  }

  const ws = read(root, WS_PROBE);
  if (!ws.exists) {
    return {
      fail: [
        'mirasim-ws-probe.mjs 不在',
        '写腿挂在这根已在跑的探针上',
        join(root, ...WS_PROBE),
      ],
    };
  }
  if (!/writeControlPlane/.test(ws.text) || !/controlPlaneDocFromProbe/.test(ws.text)) {
    problems.push('mirasim-ws-probe 没接到写腿（要调 controlPlaneDocFromProbe / writeControlPlane）');
  }

  const blocked = runHook(hookJs.file, { DAO_CONTROL_PLANE: 'false' }, root);
  if (blocked.status !== 1) {
    problems.push(`reachable=false 的 git pre-push 应 exit 1，实际 ${blocked.status}`);
  } else if (!/失控会话的对外写|控制面/.test(`${blocked.stderr || ''}${blocked.stdout || ''}`)) {
    problems.push('拦住了但没写清原因');
  }

  const allowed = runHook(hookJs.file, { DAO_CONTROL_PLANE: 'true' }, root);
  if (allowed.status !== 0) {
    problems.push(`reachable=true 应放行 exit 0，实际 ${allowed.status} ${String(allowed.stderr || '').slice(0, 80)}`);
  }

  const missing = runHook(hookJs.file, {
    DAO_CONTROL_PLANE: '',
    DAO_CONTROL_PLANE_FILE: join(root, '.no-such-control-plane.json'),
  }, root);
  if (missing.status !== 0) {
    problems.push(`落点不在应没查成放行，实际 ${missing.status}`);
  } else if (!/没查成/.test(`${missing.stderr || ''}${missing.stdout || ''}`)) {
    problems.push('落点不在放行了但没写「没查成」');
  }

  if (problems.length) {
    return {
      fail: [
        `控制面现役挂载面 ${problems.length} 处不对`,
        'git pre-push 与 land.mjs 必须问 decideControlPlane；写腿必须接到 mirasim-ws-probe；false 拦、true 放、没查成放',
        problems.slice(0, 6).join('；'),
      ],
    };
  }
  return {
    green: '控制面闸现役路径已挂（git pre-push / land.mjs / ws-probe 写腿），false 拦、true 放、没查成放',
  };
}

/**
 * 落点从未出现过 = 写腿没跑过。这是没查成，不许记成绿。
 * @returns {{green?: string, skip?: string, fail?: [string, string, string]}}
 */
export function checkControlPlaneDropPoint({
  env = process.env,
  home = homedir(),
  exists = existsSync,
} = {}) {
  const file = (env && env.DAO_CONTROL_PLANE_FILE)
    || join(home, '.dao', 'control-plane.json');
  if (!exists(file)) {
    return {
      skip: `控制面落点从未出现过（${file}）——写腿还没跑过，没查成不是绿`,
    };
  }
  return { green: `控制面落点在 ${file}` };
}
