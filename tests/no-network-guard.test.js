// tests/no-network-guard.test.js —— 测试期禁网闸的判别力
//
// 这条闸的来历：dispatch --dry-run 在测试里真的去连网关做派前探，一次 2.6s，
// dao.test.js 因此跑 57s，而**没有任何东西会报警**（2026-09-06 用户点破）。
//
// 本套要钉死两件事：
//   ① 判本机内/外的纯函数有判别力——外网判 false、回环与 unix socket 判 true
//   ② 闸真的会拦：起一个带 --import 的子进程去连外网，必须非零退出且报 no-network
//      （只断言纯函数不算数——那只证明「判据写对了」，不证明「装上了会拦」）

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isLocalTarget, targetOf } from './helpers/no-network.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = pathToFileURL(join(HERE, 'helpers', 'no-network.mjs')).href;

test('① 判本机内/外有判别力', () => {
  for (const local of ['127.0.0.1', '::1', 'localhost', '127.10.0.9', '::ffff:127.0.0.1', undefined, null]) {
    assert.equal(isLocalTarget(local), true, `${local} 应判本机`);
  }
  for (const remote of ['156.224.28.95', 'api.anthropic.com', 'relay.mirasim.ai', '8.8.8.8', 'github.com']) {
    assert.equal(isLocalTarget(remote), false, `${remote} 应判外网`);
  }
});

/**
 * 起一个子进程跑一小段代码，闸按 guard 决定装不装。
 * **不装时必须显式清掉 NODE_OPTIONS**：dao-check 正是用 `NODE_OPTIONS=--import <闸>` 装的闸，
 * 而它会继承给子进程——不清就永远装着，「不装闸」那组对照根本不成立
 * （2026-09-06 实咬：独立跑绿、进 dao-check 就红，差别只在这个环境变量）。
 */
function runWithGuard(code, { guard = true, log = null } = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  // 本套会**故意**连外网来自证闸有效。若沿用 dao-check 传下来的共享账本，
  // 这些故意违规就会记进去、被判成真违规——检查器的产出污染它自己的判据。
  // 所以一律改指本套自己的临时账（要断言时给 log，不要断言时丢进 tmp 黑洞）。
  env.DAO_NO_NETWORK_LOG = log || join(mkdtempSync(join(tmpdir(), 'nonet-')), 'ledger.ndjson');
  return spawnSync(
    process.execPath,
    guard ? ['--import', GUARD, '-e', code] : ['-e', code],
    { encoding: 'utf8', env, timeout: 20000 },
  );
}

test('② 故意违规：装了闸去连外网 → 当场拦下，且记进账', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'nonet-')), 'ledger.ndjson');
  const r = runWithGuard('require("net").connect(443, "156.224.28.95")', { log });
  const text = (r.stdout || '') + (r.stderr || '');
  assert.notEqual(r.status, 0, `连外网必须非零退出，实际 status=${r.status}\n${text}`);
  assert.match(text, /no-network/, `报错要点名是本闸拦的\n${text}`);
  // 记账必须验：调用方常把网络错 try/catch 吞掉，那时**只有账**能证明发生过违规。
  assert.ok(existsSync(log), '拦下了却没记账——吞错的调用方会让这次违规彻底消失');
  const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, '156.224.28.95');
});

test('②b 参数归一形态也要认（首版就漏在这）', () => {
  // net.connect(port, host) 门面会被 Node normalizeArgs 成 [options, cb] 再交给
  // Socket.prototype.connect——首版把数组当对象取 host 得 undefined，判成本机静默放行。
  assert.equal(targetOf([[{ host: '8.8.8.8', port: 443 }, null]]).host, '8.8.8.8');
  assert.equal(targetOf([{ host: '8.8.8.8', port: 443 }]).host, '8.8.8.8');
  assert.equal(targetOf([443, '8.8.8.8']).host, '8.8.8.8');
  assert.equal(targetOf([{ path: '/tmp/x.sock' }]).unix, true);
});

test('③ 判别力反面：同一段代码不装闸时不该被本闸拦', () => {
  // 不装闸时连不上是网络本身的事（超时/拒绝），但**绝不该**出现 no-network 字样——
  // 出现了就说明断言②命中的是别的原因，闸等于没验过。
  const r = runWithGuard('const s=require("net").connect(443,"156.224.28.95");s.on("error",()=>process.exit(0));s.setTimeout(300,()=>process.exit(0))', { guard: false });
  const text = (r.stdout || '') + (r.stderr || '');
  assert.doesNotMatch(text, /no-network/, `没装闸却报 no-network，说明②的证据不成立\n${text}`);
});

test('④ 本机内照常放行（闸不许误伤 localhost）', () => {
  const r = runWithGuard('const s=require("net").connect(1,"127.0.0.1");s.on("error",e=>{if(String(e.message).includes("no-network")){console.log("WRONGLY_BLOCKED");process.exit(3)}process.exit(0)})');
  const text = (r.stdout || '') + (r.stderr || '');
  assert.doesNotMatch(text, /WRONGLY_BLOCKED|no-network/, `回环被误拦\n${text}`);
});
