// tests/helpers/no-network.mjs —— 测试期禁止出网的闸（预加载模块）
//
// 为什么要它（2026-09-06 实咬，用户点破「一个文件占整条链 80% 时间」）：
// `dao.mjs dispatch --dry-run` 会真的去 connect 网关做派前探，一次等 ~2.6s。
// 测试里调了十几次，dao.test.js 因此跑 57s、全仓测试 80s。三个人先后看这个数，
// 都以为是「测试写得重」，没人想到是**单元测试在打真实外网**——因为没有任何东西会报警。
//
// 判据来自 Google 的测试分级（Software Engineering at Google, ch.11）：
// small test 单进程、不许 sleep、不许 I/O、不许任何阻塞调用，网络访问因此明令禁止；
// medium 才可以，且**只许打 localhost**。单元测试碰外网只有两条正当出路——
// 注入假实现留在 small，或诚实降级成 medium/large。悄悄允许真网络，产出的就是
// 又慢又飘又不可复现的测试套件（本仓这一针还受网关排队影响会飘，见 #853）。
//
// 怎么装：`NODE_OPTIONS=--import <本文件>`（dao-check 的 runOneSuite 里接线）。
// **NODE_OPTIONS 默认继承给子进程**，所以测试 spawn 出去的 `node scripts/dao.mjs`
// 同样被罩住——这正是要害：偷偷出网的往往不是测试自己，是它调起来的那个 CLI。
//
// 放行面（本机内的一律不拦，它们不慢也不飘）：
//   · IPv4/IPv6 回环、`localhost`
//   · unix domain socket（mirasim 回环 ws 等）
// 拦下时抛错，不静默改写返回值——静默降级会让「被拦了」和「探通了」看起来一样。

import net from 'node:net';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|0?\.0?\.0?\.0?)$/;
const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', '', undefined, null]);

/** 本机内 = 放行。判不出来的按「外网」处理（fail-close：宁可拦错，不可放过）。 */
export function isLocalTarget(host) {
  if (host == null) return true;              // unix socket / 无 host = 本机
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_NAMES.has(h)) return true;
  return LOOPBACK.test(h);
}

// 光抛错不够：调用方常把网络错误 try/catch 吞掉（本仓的派前探就是），
// 于是「闸拦住了」和「压根没连过」在外面看一模一样——只变快、不报警，等于半个闸。
// 所以每次拦下都往账上记一行，由 dao-check 读账判红（落点在仓外，不进自己扫描面）。
function record(host, port, via) {
  const log = process.env.DAO_NO_NETWORK_LOG;
  if (!log) return;
  try {
    appendFileSync(log, JSON.stringify({
      at: new Date().toISOString(), host: String(host), port: String(port), via,
      argv: process.argv.slice(1, 4).join(' '),
    }) + '\n');
  } catch { /* 记账失败不许拖垮被测进程；dao-check 侧另有「账读不到=没查成」的判据 */ }
}

function blocked(host, port, via) {
  record(host, port, via);
  const e = new Error(
    `[no-network] 测试期禁止连外网：${host}:${port}（经 ${via}）。\n`
    + '单元测试不许打真实网络——它慢、它飘、它不可复现（判据见本文件头 Google 测试分级）。\n'
    + '两条正当出路：① 注入假实现（本仓惯例：传 probe / sleep / orca 执行器）；\n'
    + '② 这条路径确实要连外网 ⇒ 它就不是单元测试，别放在 tests/ 里跑。\n'
    + '如果是 CLI 在背后偷偷出网（本闸的来历就是 dispatch --dry-run 打派前探），改 CLI 让它默认不探。',
  );
  e.code = 'ERR_TEST_NETWORK_BLOCKED';
  return e;
}

/**
 * 从 Socket.prototype.connect 的实参里取出 {host,port}。
 * **必须先解数组**：`net.connect(port, host)` 这类门面调用，Node 内部会把参数
 * normalizeArgs 成 `[options, cb]` 再调 `socket.connect(那个数组)`——
 * 2026-09-06 首版漏了这一形态，把数组当对象取 host 得 undefined 判成本机，闸静默放行，
 * 而自证测试正好把它抓了出来（这就是「上线前先造违规样本」存在的理由）。
 */
export function targetOf(args) {
  let a0 = args[0];
  if (Array.isArray(a0)) a0 = a0[0];
  if (a0 && typeof a0 === 'object') {
    if (a0.path) return { unix: true };
    return { host: a0.host, port: a0.port };
  }
  if (typeof a0 === 'number' || /^\d+$/.test(String(a0))) {
    return { port: a0, host: typeof args[1] === 'string' ? args[1] : undefined };
  }
  return { unix: true };  // 路径形态
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const t = targetOf(args);
  if (!t.unix && !isLocalTarget(t.host)) throw blocked(t.host, t.port, 'net.connect');
  return realConnect.apply(this, args);
};

// DNS 也要拦：解析本身就要出网问 resolver，而且「先解析后连」的库会在这里先卡住。
// 拦在这里报错更早、指向更准（连 IP 时 net 那层再兜一次）。
const realLookup = dns.lookup;
dns.lookup = function lookup(hostname, ...rest) {
  if (!isLocalTarget(hostname)) {
    const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
    const err = blocked(hostname, '-', 'dns.lookup');
    if (cb) return process.nextTick(() => cb(err));
    throw err;
  }
  return realLookup.call(this, hostname, ...rest);
};
if (dns.promises && dns.promises.lookup) {
  const realP = dns.promises.lookup;
  dns.promises.lookup = function lookupP(hostname, ...rest) {
    if (!isLocalTarget(hostname)) return Promise.reject(blocked(hostname, '-', 'dns.promises.lookup'));
    return realP.call(this, hostname, ...rest);
  };
}
