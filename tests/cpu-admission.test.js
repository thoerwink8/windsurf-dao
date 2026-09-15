// CPU 占用率判据（2026-09-10 实咬：loadavg 在 IO 型负载下把等模型回话的进程算成压力）。
// 判据全文与实证见 lib/admission.mjs 文件头注。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCpuBusy, admitCapacity, ADMISSION_DEFAULTS } from '../scripts/lib/admission.mjs';

const stat = (user, sys, idle, iowait = 0) => `cpu  ${user} 0 ${sys} ${idle} ${iowait} 0 0 0 0 0\ncpu0 ...\n`;

test('两帧差算占用率：一半时间在忙 → 0.5', () => {
  const r = parseCpuBusy(stat(100, 100, 800), stat(150, 150, 900));
  assert.equal(r.ok, true);
  assert.equal(r.busy, 0.5);
});

test('等 IO 的进程不算压力：idle+iowait 都算空闲（正是 loadavg 误判的那种负载）', () => {
  // 100 个 tick 里 90 个 iowait、10 个忙 → 占用 0.1，而不是 loadavg 眼里的「很忙」
  const r = parseCpuBusy(stat(0, 0, 0, 0), stat(5, 5, 0, 90));
  assert.equal(r.ok, true);
  assert.equal(Math.round(r.busy * 100) / 100, 0.1);
});

test('全忙 → 1；全闲 → 0', () => {
  assert.equal(parseCpuBusy(stat(0, 0, 100), stat(100, 100, 100)).busy, 1);
  assert.equal(parseCpuBusy(stat(0, 0, 100), stat(0, 0, 200)).busy, 0);
});

test('两帧没推进 → 没查成（同一次读的、或读盘失败），绝不当 0', () => {
  const same = stat(100, 100, 800);
  const r = parseCpuBusy(same, same);
  assert.equal(r.ok, false);
  assert.equal(r.unscanned, true);
  assert.match(r.error, /没有推进|没查成/);
});

test('空串 / 缺 cpu 行 / 字段不是数字 → 都是没查成，不是 0', () => {
  assert.equal(parseCpuBusy('', stat(1, 1, 1)).unscanned, true);
  assert.equal(parseCpuBusy(stat(1, 1, 1), 'MemTotal: 1 kB').unscanned, true);
  assert.equal(parseCpuBusy(stat(1, 1, 1), 'cpu  a b c d e').unscanned, true);
});

test('admitCapacity：CPU 占用到阈值 → 一张都不收，且 why 里带上 loadavg 趋势', () => {
  const r = admitCapacity({
    meminfoText: 'MemTotal: 12000000 kB\nMemAvailable: 9000000 kB',
    statBeforeText: stat(0, 0, 0), statAfterText: stat(90, 90, 20), // 90% 忙
    loadavgText: '0.6 0.6 0.6 1/100 1', nproc: 6, inFlight: 2, samples: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.slots, 0);
  assert.match(r.why, /CPU 占用率 90%/);
  assert.match(r.why, /loadavg 归一 0\.10/, 'loadavg 降级为趋势，要出现在 why 里供人对照');
});

test('admitCapacity：CPU 闲但 loadavg 高 → **照收**（这就是本次要修的那一格）', () => {
  const r = admitCapacity({
    meminfoText: 'MemTotal: 12000000 kB\nMemAvailable: 9000000 kB',
    statBeforeText: stat(0, 0, 0), statAfterText: stat(20, 20, 260), // 13% 忙
    loadavgText: '8.0 8.0 8.0 10/500 1', nproc: 6, // 归一 1.33，旧判据在这里会判「机器已满」
    inFlight: 10, samples: [],
  });
  assert.equal(r.ok, true);
  assert.ok(r.slots > 0, `CPU 闲就该收，实际 slots=${r.slots}（${r.why}）`);
});

test('admitCapacity：CPU 计数读不到 → fail-close，slots=0 且 ok:false', () => {
  const r = admitCapacity({
    meminfoText: 'MemTotal: 12000000 kB\nMemAvailable: 9000000 kB',
    statBeforeText: '', statAfterText: '', loadavgText: '1 1 1 1/100 1', nproc: 6, inFlight: 1, samples: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.slots, 0);
  assert.match(r.why, /没查成/);
});

test('阈值是可配的策略值，不是写死的数字', () => {
  assert.equal(ADMISSION_DEFAULTS.cpuThreshold, 0.85);
  const busy50 = {
    meminfoText: 'MemTotal: 12000000 kB\nMemAvailable: 9000000 kB',
    statBeforeText: stat(0, 0, 0), statAfterText: stat(50, 50, 100), // 50% 忙
    loadavgText: '1 1 1 1/100 1', nproc: 6, inFlight: 1, samples: [],
  };
  assert.equal(admitCapacity({ ...busy50, policy: { cpuThreshold: 0.85 } }).slots >= 0, true);
  assert.equal(admitCapacity({ ...busy50, policy: { cpuThreshold: 0.4 } }).slots, 0, '阈值降到 0.4 时 50% 忙就该收手');
});
