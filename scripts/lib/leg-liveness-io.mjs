// scripts/lib/leg-liveness-io.mjs —— 把「这条腿最近跑得怎么样」从会话记录里读出来
//
// 判据全在 leg-liveness.mjs（纯函数）；这里只负责取样本，取不到就如实说没查成。
// 单独成文件是为了**这一层出事不许拖垮派工**：换厂凭证算不出来，最多是不换厂，
// 不该让 reviewer-create 整条挂掉（判例 memory `fixing-dispatch-tool-deadlocks`）。
//
// **为什么要跨两个目录取一条样本**（2026-09-15 实测，第一版栽在这里）：
//
//   · `~/.dao/execution/sessions/<key>.json` 有 `model`，但它的 `observedState`
//     判的是「这个会话对象结束了没有」——一个刚起 2 分钟、上游流断掉的审官
//     在这里照样记 `done`。拿它当存活样本，会把一条死透的腿判成活的（实测：
//     luna 最近两条 09:50/09:52 记的是 streaming/done，而同一时刻 mirasim 那边
//     18/23 全是 incomplete）。
//   · `~/.mirasim/sessions/<agent>/<id>/record.json` 有真结局 `runState` 和死因
//     `runDetail`（"stream disconnected before completion: …"），但**没有模型字段**。
//
// 所以 model 从 dao 侧取、结局从 mirasim 侧取，用 sessionKey（`<agent>:<uuid>`）对上。
// 这道 join 也正是 #1289「会话结束不留可判据的记录」缺的那一半：死因一直躺在隔壁文件里。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_DAO_SESSIONS_DIR = join(
  process.env.DAO_STATE_DIR || join(homedir(), '.dao'),
  'execution', 'sessions',
);
export const DEFAULT_MIRASIM_SESSIONS_DIR = join(
  process.env.MIRASIM_HOME || join(homedir(), '.mirasim'),
  'sessions',
);

/** 这条记录是不是这条腿的。模型 id 优先，退回 profileId 里带模型名的形态（codex-relay-<id>）。 */
export function recordIsLeg(rec, modelId) {
  const want = String(modelId || '').trim();
  if (!want || !rec || typeof rec !== 'object') return false;
  for (const k of ['model', 'requestedModel', 'actualModel']) {
    if (String(rec[k] || '').trim() === want) return true;
  }
  const profile = String(rec.profileId || '').trim();
  return profile !== '' && profile.endsWith(want);
}

/** `codex:02923a47-…` → `{ agent: 'codex', id: '02923a47-…' }`；形态不对回 null。 */
export function splitSessionKey(key) {
  const s = String(key || '').trim();
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  const agent = s.slice(0, i);
  const id = s.slice(i + 1);
  if (!/^[A-Za-z0-9_.-]+$/.test(agent) || !/^[A-Za-z0-9_.-]+$/.test(id)) return null;
  return { agent, id };
}

function readMirasimRecord(key, mirasimDir) {
  const parts = splitSessionKey(key);
  if (!parts) return null;
  try {
    return JSON.parse(readFileSync(join(mirasimDir, parts.agent, parts.id, 'record.json'), 'utf8'));
  } catch {
    return null;   // 会话被清了或还没落盘——这条不当样本，不当死
  }
}

/**
 * 读这条腿最近的会话样本。
 * 返回 `{ scanned, records, error }`；每条 record 是
 * `{ sessionKey, state, detail, at, source }`——`state` 一律取 mirasim 的真结局。
 *
 * **不抛**：调用方的下一步是派工，不是排障。
 * 一条 mirasim 记录都对不上时判**没查成**，不是「这条腿没死过」——
 * 两者分不开就是把「没查成」当成「查过没事」。
 */
export function readLegRecords(modelId, {
  daoDir = DEFAULT_DAO_SESSIONS_DIR,
  mirasimDir = DEFAULT_MIRASIM_SESSIONS_DIR,
  limit = 80,
} = {}) {
  let names;
  try {
    names = readdirSync(daoDir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    return { scanned: false, records: [], error: `会话目录读不到：${String((e && e.message) || e)}` };
  }
  const mine = [];
  for (const n of names) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(daoDir, n), 'utf8'));
    } catch {
      continue;   // 单条坏了就跳过，不让一个坏文件把整次取样判成没查成
    }
    if (recordIsLeg(rec, modelId)) mine.push(rec);
  }
  if (mine.length === 0) {
    return { scanned: false, records: [], error: `会话目录里没有 ${modelId} 的记录（没查成，不是「它没跑过」）` };
  }
  // 先按 dao 侧时间挑最近的一批，再去 mirasim 拿真结局——不然要读几百个 record.json。
  mine.sort((a, b) => (Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)));
  const records = [];
  for (const rec of mine.slice(0, limit)) {
    const key = rec.recordKey || rec.sessionKey;
    const m = readMirasimRecord(key, mirasimDir);
    if (!m) continue;
    records.push({
      sessionKey: String(key || ''),
      state: m.runState ?? null,
      detail: m.runDetail ?? null,
      at: Date.parse(String(m.updatedAt || m.createdAt || '')) || Number(rec.updatedAt || rec.createdAt) || null,
      source: 'mirasim-record',
    });
  }
  if (records.length === 0) {
    return {
      scanned: false, records: [],
      error: `${modelId} 的 ${mine.length} 条会话一条都没在 mirasim 侧对上 record.json（没查成）`,
    };
  }
  return { scanned: true, records, error: null };
}
